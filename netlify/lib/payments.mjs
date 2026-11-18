// slate payment providers. one registry, one shape, so checkout and the webhook
// never have to know which processor is behind the counter.
//
// every provider exports:
//   id, label, methods[]      shown on the checkout page
//   configured()              true when its env vars are present
//   create({ tier, email, origin })  -> { url, id }
//   verify(rawBody, headers)  -> boolean, or a parsed event
//
// the point of the registry is that swapping processors is an env change, not a
// code change. no sdk, no npm install, plain fetch.
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { TIERS } from './core.mjs';

/* every provider must key its pending order on the reference the processor will
   echo back in the callback, not on the processor's own invoice id. nowpayments
   echoes order_id, so the pending record has to be stored under order_id or the
   webhook finds nothing and the buyer pays for air. */
const newOrder = tier => `slate-${tier}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

const hexEq = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/* nowpayments signs a recursively key-sorted copy of the body. a top-level-only
   sort silently fails verification the moment an event carries a nested object,
   which means the buyer pays and never gets a key. sort all the way down. */
const sortDeep = v => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => {
      acc[k] = sortDeep(v[k]);
      return acc;
    }, {});
  }
  return v;
};

const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers, body });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* leave null */ }
  if (!r.ok) throw new Error(`${url} ${r.status}: ${text.slice(0, 240)}`);
  return data;
};

/* ---------------------------------------------------------------- stripe
   card + wallets. kept because the seam already existed. a spoofer will not
   get past their restricted-business review, so treat it as a fallback. */
const stripe = {
  id: 'stripe',
  label: 'card',
  methods: ['visa', 'mastercard', 'amex', 'apple pay', 'google pay'],
  // both required: a key with no webhook secret can take payment but can
  // never verify the callback, so it can never issue anything it sells.
  configured: () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
  async create({ tier, email, origin }) {
    const t = TIERS[tier];
    const p = new URLSearchParams();
    p.set('mode', 'payment');
    p.set('customer_email', email);
    p.set('success_url', `${origin}/checkout.html?paid=1`);
    p.set('cancel_url', `${origin}/checkout.html?cancel=1`);
    p.set('line_items[0][quantity]', '1');
    p.set('line_items[0][price_data][currency]', 'usd');
    p.set('line_items[0][price_data][unit_amount]', String(t.price * 100));
    p.set('line_items[0][price_data][product_data][name]', `slate ${t.label}`);
    p.set('line_items[0][price_data][product_data][description]', `slate ${t.label} · 1 PC · new hardware identity`);
    p.set('metadata[tier]', tier);
    p.set('metadata[email]', email);
    p.set('metadata[provider]', 'stripe');
    const data = await post('https://api.stripe.com/v1/checkout/sessions', p.toString(), {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    });
    if (!data || !data.url) throw new Error('stripe: no checkout url');
    return { url: data.url, id: data.id };
  },
  verify(rawBody, headers) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const header = headers['stripe-signature'];
    if (!secret || !header) return false;
    const parts = Object.fromEntries(header.split(',').map(x => x.split('=')));
    if (!parts.t || !parts.v1) return false;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
    return hexEq(createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex'), parts.v1);
  },
};

/* ------------------------------------------------------------ nowpayments
   crypto only. no approval, no chargebacks, settles to your wallet. */
const nowpayments = {
  id: 'nowpayments',
  label: 'crypto',
  methods: ['btc', 'eth', 'usdt', 'usdc', 'ltc', 'xmr', 'trx'],
  // both required: without the ipn secret the webhook can never verify a
  // callback, so an invoice could be created and paid but never fulfilled.
  configured: () => Boolean(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET),
  async create({ tier, email, origin }) {
    const t = TIERS[tier];
    const order = newOrder(tier);
    const data = await post('https://api.nowpayments.io/v1/invoice', JSON.stringify({
      price_amount: t.price,
      price_currency: 'usd',
      order_id: order,
      order_description: `slate ${t.label}`,
      ipn_callback_url: `${origin}/.netlify/functions/payment-webhook`,
      success_url: `${origin}/checkout.html?paid=1`,
      cancel_url: `${origin}/checkout.html?cancel=1`,
      customer_email: email,
    }), {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'content-type': 'application/json',
    });
    if (!data || !data.invoice_url) throw new Error('nowpayments: no invoice url');
    // id is OUR order string, because that is what the ipn echoes back as order_id
    return { url: data.invoice_url, id: order };
  },
  /* ipn: hmac-sha512 over the recursively key-sorted json body, hex, in x-nowpayments-sig */
  verify(rawBody, headers) {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    const sig = headers['x-nowpayments-sig'];
    if (!secret || !sig) return false;
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch (e) { return false; }
    const sorted = JSON.stringify(sortDeep(parsed));
    return hexEq(createHmac('sha512', secret).update(sorted).digest('hex'), sig);
  },
};

/* ------------------------------------------------------------------ payop
   high-risk aggregator: cards, local rails, crypto behind one invoice.
   this is the realistic route to visa and mastercard for this category. */
const payop = {
  id: 'payop',
  label: 'card or local',
  methods: ['visa', 'mastercard', 'paypal', 'crypto'],
  configured: () => Boolean(process.env.PAYOP_PUBLIC_KEY && process.env.PAYOP_SECRET),
  async create({ tier, email, origin }) {
    const t = TIERS[tier];
    const order = newOrder(tier);
    const data = await post('https://api.payop.com/v1/invoices/create', JSON.stringify({
      publicKey: process.env.PAYOP_PUBLIC_KEY,
      order: { id: order, amount: t.price, currency: 'USD', description: `slate ${t.label}` },
      payerEmail: email,
      language: 'en',
      resultUrl: `${origin}/checkout.html?paid=1`,
      failUrl: `${origin}/checkout.html?cancel=1`,
      serverCallbackUrl: `${origin}/.netlify/functions/payment-webhook`,
    }), { 'content-type': 'application/json' });
    const url = data && data.data && (data.data.redirectUrl || data.data.url);
    if (!url) throw new Error('payop: no invoice url');
    return { url, id: order };
  },
  /* payop signs the raw body with hmac-sha256 hex in the `signature` header */
  verify(rawBody, headers) {
    const secret = process.env.PAYOP_SECRET;
    const sig = headers['signature'] || headers['x-signature'];
    if (!secret || !sig) return false;
    return hexEq(createHmac('sha256', secret).update(rawBody).digest('hex'), sig);
  },
};

/* -------------------------------------------------------------- cryptomus
   crypto. sign = md5(base64(json) + api key). */
const cryptomus = {
  id: 'cryptomus',
  label: 'crypto',
  methods: ['btc', 'eth', 'usdt', 'trx', 'ltc'],
  configured: () => Boolean(process.env.CRYPTOMUS_MERCHANT && process.env.CRYPTOMUS_KEY),
  async create({ tier, email, origin }) {
    const t = TIERS[tier];
    const order = newOrder(tier);
    const body = JSON.stringify({
      amount: String(t.price),
      currency: 'USD',
      order_id: order,
      url_return: `${origin}/checkout.html?paid=1`,
      url_callback: `${origin}/.netlify/functions/payment-webhook`,
    });
    const sign = createHash('md5')
      .update(Buffer.from(body, 'utf8').toString('base64') + process.env.CRYPTOMUS_KEY)
      .digest('hex');
    const data = await post('https://api.cryptomus.com/v1/payment', body, {
      merchant: process.env.CRYPTOMUS_MERCHANT,
      sign,
      'content-type': 'application/json',
    });
    const url = data && data.result && data.result.url;
    if (!url) throw new Error('cryptomus: no payment url');
    return { url, id: order };
  },
  verify(rawBody, headers) {
    const key = process.env.CRYPTOMUS_KEY;
    const sig = headers['sign'];
    if (!key || !sig) return false;
    const want = createHash('md5')
      .update(Buffer.from(rawBody, 'utf8').toString('base64') + key)
      .digest('hex');
    return hexEq(want, sig);
  },
};

/* ------------------------------------------------------------------ paypal
   PayPal REST API (v2 Orders). buyer lands on paypal's hosted checkout,
   pays, paypal sends CHECKOUT.ORDER.APPROVED webhook, we capture and
   issue. three env vars: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID. */
let _paypalToken = null;
let _paypalTokenExp = 0;

async function paypalAuth() {
  if (_paypalToken && Date.now() < _paypalTokenExp) return _paypalToken;
  const sandbox = process.env.PAYPAL_SANDBOX === '1';
  const base = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${creds}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('paypal auth failed');
  _paypalToken = data.access_token;
  _paypalTokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return _paypalToken;
}

function paypalBase() {
  return process.env.PAYPAL_SANDBOX === '1'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

const paypal = {
  id: 'paypal',
  label: 'paypal',
  methods: ['paypal'],
  configured: () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET),
  async create({ tier, email, origin }) {
    const t = TIERS[tier];
    const order = newOrder(tier);
    const token = await paypalAuth();
    const data = await post(`${paypalBase()}/v2/checkout/orders`, JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order,
        description: `slate ${t.label}`,
        amount: { currency_code: 'USD', value: t.price.toFixed(2) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `${origin}/checkout.html?paid=1`,
            cancel_url: `${origin}/checkout.html?cancel=1`,
            user_action: 'PAY_NOW',
            brand_name: 'Slate',
          },
        },
      },
    }), {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
    const approve = data?.links?.find(l => l.rel === 'payer-action' || l.rel === 'approve');
    if (!approve?.href) throw new Error('paypal: no approval url');
    return { url: approve.href, id: order, paypalOrderId: data.id };
  },
  async verify(rawBody, headers) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return false;
    const token = await paypalAuth();
    const r = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'] || '',
        cert_url: headers['paypal-cert-url'] || '',
        transmission_id: headers['paypal-transmission-id'] || '',
        transmission_sig: headers['paypal-transmission-sig'] || '',
        transmission_time: headers['paypal-transmission-time'] || '',
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody),
      }),
    });
    const result = await r.json();
    return result.verification_status === 'SUCCESS';
  },
  async capture(paypalOrderId) {
    const token = await paypalAuth();
    const r = await fetch(`${paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return r.json();
  },
};

/* ----------------------------------------------------------------- hosted
   escape hatch: any processor that hands you a hosted checkout url template
   and signs callbacks with an hmac. set HOSTED_CHECKOUT_URL with {amount},
   {email}, {tier} and {order} placeholders. */
const hosted = {
  id: 'hosted',
  label: 'card',
  methods: ['visa', 'mastercard'],
  // both required: a checkout url with no webhook secret can take the buyer
  // to pay but can never verify the callback that would issue their key.
  configured: () => Boolean(process.env.HOSTED_CHECKOUT_URL && process.env.HOSTED_WEBHOOK_SECRET),
  async create({ tier, email }) {
    const t = TIERS[tier];
    const order = newOrder(tier);
    const url = process.env.HOSTED_CHECKOUT_URL
      .replace('{amount}', String(t.price))
      .replace('{email}', encodeURIComponent(email))
      .replace('{tier}', tier)
      .replace('{order}', order);
    return { url, id: order };
  },
  verify(rawBody, headers) {
    const secret = process.env.HOSTED_WEBHOOK_SECRET;
    const sig = headers['x-signature'];
    if (!secret || !sig) return false;
    return hexEq(createHmac('sha256', secret).update(rawBody).digest('hex'), sig);
  },
};

export const PROVIDERS = [paypal, payop, stripe, nowpayments, cryptomus, hosted];

export const providerById = id => PROVIDERS.find(p => p.id === id) || null;

export const available = () => PROVIDERS.filter(p => {
  try { return p.configured(); } catch (e) { return false; }
});

/* pick what checkout should use: the requested provider if it is live,
   otherwise the first one that is configured. */
export function chooseProvider(requested) {
  const live = available();
  if (requested) {
    const want = live.find(p => p.id === requested);
    if (want) return want;
  }
  return live[0] || null;
}

/* the method badges the checkout page shows, in the order people look for them */
export function methodList() {
  const order = ['paypal', 'visa', 'mastercard', 'amex', 'apple pay', 'google pay', 'btc', 'eth', 'usdt', 'usdc', 'ltc', 'xmr', 'trx'];
  const set = new Set();
  available().forEach(p => p.methods.forEach(m => set.add(m)));
  return order.filter(m => set.has(m)).concat([...set].filter(m => !order.includes(m)));
}
