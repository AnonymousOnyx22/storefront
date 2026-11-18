// POST /checkout { tier, email, provider? }
// GET  /checkout                      -> which processors are live and what they take
//
// the processor is picked by env, not by code. wire any one of payop (cards +
// local rails), nowpayments or cryptomus (crypto), stripe, or the generic
// HOSTED_CHECKOUT_URL template, and checkout starts using it.
import {
  TIERS, json, readBody, isEmail, normEmail, getOrder, issueKey,
  sendKeyEmail, originOf, limited, putPending,
} from '../lib/core.mjs';
import { available, chooseProvider, methodList } from '../lib/payments.mjs';

const handle = async event => {
  if (event.httpMethod === 'GET') {
    return json(200, {
      ok: true,
      live: available().map(p => p.id),
      methods: methodList(),
    });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const body = readBody(event);
  const tier = body.tier;
  const email = normEmail(body.email);
  const discord = String(body.discord || '').trim().slice(0, 80) || '';

  if (!TIERS[tier] || TIERS[tier].retired) return json(400, { error: 'bad_tier' });
  if (!isEmail(email)) return json(400, { error: 'invalid_email' });
  if (await limited(`checkout:${email}`)) return json(429, { error: 'rate_limited' });

  const provider = chooseProvider(body.provider);

  if (provider) {
    try {
      const session = await provider.create({ tier, email, origin: originOf(event) });
      const pending = { email, tier };
      if (discord) pending.discord = discord;
      if (session.paypalOrderId) pending.paypalOrderId = session.paypalOrderId;
      await putPending(provider.id, session.id, pending);

      return json(200, { ok: true, url: session.url, provider: provider.id, ref: session.id });
    } catch (e) {
      console.error('slate checkout:', provider.id, e && e.message);
      return json(502, { error: 'payment_failed', provider: provider.id, detail: String(e && e.message || e) });
    }
  }

  // nothing wired up: refuse, unless this is an explicit test deploy
  if (process.env.SLATE_DEMO !== '1') return json(503, { error: 'no_payment' });

  const existing = await getOrder(email);
  const acct = await issueKey(email, tier, existing);
  const sent = await sendKeyEmail(acct);
  return json(200, {
    ok: true,
    demo: true,
    emailed: sent.emailed,
    key: sent.emailed ? undefined : acct.key,
  });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
