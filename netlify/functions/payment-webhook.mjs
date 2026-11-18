// POST /payment-webhook
// one door for every processor. the provider is named by the `x-slate-provider`
// header, a ?p= query param, or inferred from the body. each signature is
// checked with that provider's own scheme before anything is issued.
import {
  TIERS, json, getOrder, issueKey, sendKeyEmail, takePending, normEmail, notify, siteUrl,
  alreadyFulfilled, markFulfilled,
} from '../lib/core.mjs';
import { providerById, available, PROVIDERS } from '../lib/payments.mjs';
import { searchMembers, assignRole } from '../lib/discord.mjs';

const PAID = {
  // 'confirmed' means the chain has confirmed the buyer's tx, not that funds
  // have reached our wallet yet - nowpayments' own guidance is to fulfil on
  // 'finished' only. 'partially_paid' is deliberately excluded too: an
  // underpaid invoice must not grant the full-price key.
  nowpayments: ['finished'],
  cryptomus: ['paid', 'paid_over'],
  payop: ['success', 'paid', '1', 1],
  paypal: ['CHECKOUT.ORDER.APPROVED'],
  hosted: ['paid', 'success', 'completed'],
};

function inferProvider(headers, q, raw) {
  const named = q.p || headers['x-slate-provider'];
  if (named) return providerById(String(named).toLowerCase());
  if (headers['stripe-signature']) return providerById('stripe');
  if (headers['x-nowpayments-sig']) return providerById('nowpayments');
  if (headers['signature']) return providerById('payop');
  if (headers['sign']) return providerById('cryptomus');
  if (headers['paypal-transmission-id']) return providerById('paypal');
  return available()[0] || null;
}


function paid(providerId, body) {
  if (providerId === 'stripe') {
    return body.type === 'checkout.session.completed'
      && (!body.data?.object?.payment_status || body.data.object.payment_status === 'paid');
  }
  if (providerId === 'paypal') {
    const eventType = body.event_type || '';
    return PAID.paypal.includes(eventType);
  }
  const status = body.payment_status || body.status;
  const ok = PAID[providerId] || ['paid', 'success', 'completed'];
  return ok.includes(status);
}

function refOf(providerId, body) {
  if (providerId === 'stripe') return body.data?.object?.id || null;
  if (providerId === 'payop') return body.order?.identifier || body.order?.id || body.identifier || null;
  if (providerId === 'paypal') {
    const units = body.resource?.purchase_units || [];
    return units[0]?.reference_id || null;
  }
  return body.order_id || body.orderId || body.order?.id || body.uuid || null;
}

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const headers = event.headers || {};
  const q = event.queryStringParameters || {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const provider = inferProvider(headers, q, raw);
  if (!provider) return json(400, { error: 'no_provider' });

  let valid = false;
  try { valid = Boolean(await provider.verify(raw, headers)); } catch (e) { valid = false; }
  if (!valid) {
    console.error('slate webhook: bad signature from', provider.id);
    return json(400, { error: 'bad_signature' });
  }

  let body;
  try { body = JSON.parse(raw); } catch (e) { return json(400, { error: 'bad_json' }); }

  // always answer 200 to a verified callback the processor may retry, even if we ignore it
  if (!paid(provider.id, body)) return json(200, { ok: true, ignored: 'not_paid' });

  // paypal: capture the approved order before issuing the key
  if (provider.id === 'paypal' && body.resource?.id) {
    try {
      const capture = await provider.capture(body.resource.id);
      if (capture.status !== 'COMPLETED') {
        console.error('slate webhook: paypal capture not completed', capture.status);
        return json(200, { ok: true, ignored: 'capture_incomplete', status: capture.status });
      }
    } catch (e) {
      console.error('slate webhook: paypal capture failed', e && e.message);
      return json(500, { error: 'capture_failed' });
    }
  }

  const ref = refOf(provider.id, body);
  const pending = ref ? await takePending(provider.id, ref) : null;

  // duplicate delivery: the pending record is one-shot. a null read on a
  // reference we have already fulfilled is a retry or a replay, not a first
  // sale, so answer 200 without re-issuing the key or re-clocking the licence.
  if (ref && !pending && await alreadyFulfilled(provider.id, ref)) {
    return json(200, { ok: true, ignored: 'duplicate', ref });
  }

  // stripe carries the buyer in metadata; the others only carry the reference
  const meta = body.data?.object?.metadata || {};
  const email = normEmail(pending?.email || meta.email);
  const tier = pending?.tier || meta.tier;

  if (!email || !TIERS[tier]) {
    console.error('slate webhook: no pending order for', provider.id, ref);
    return json(200, { ok: true, ignored: 'unknown_order', ref });
  }

  const existing = await getOrder(email);
  const acct = await issueKey(email, tier, existing);
  // stamp before the side effects so a retry after a lost response is a no-op.
  await markFulfilled(provider.id, ref);
  const sent = await sendKeyEmail(acct);
  if (!sent.emailed) console.error('slate: key email failed', sent.reason, acct.email);

  // try to assign verified buyer role if a discord username was provided at checkout
  const discordTag = pending?.discord || '';
  const verifiedRole = process.env.DISCORD_VERIFIED_ROLE_ID || '';
  let roleAssigned = false;
  if (discordTag && verifiedRole) {
    try {
      const members = await searchMembers(discordTag, 1);
      if (members && members.length && members[0].user) {
        await assignRole(members[0].user.id, verifiedRole);
        roleAssigned = true;
      }
    } catch (e) {
      console.error('slate: discord role assignment failed', e && e.message);
    }
  }

  /* a sale is worth a ping even when the email fails, because a failed email
     means the buyer needs to be reached by hand. */
  notify(`SALE`, [], 'sale', [
    { name: 'key', value: `\`${acct.key}\`` },
    { name: 'tier', value: TIERS[tier].label },
    { name: 'price', value: `$${TIERS[tier].price}` },
    { name: 'buyer', value: acct.email },
    { name: 'provider', value: provider.id },
    { name: 'email', value: sent.emailed ? 'delivered' : `FAILED: ${sent.reason || 'unknown'}` },
    ...(discordTag ? [{ name: 'discord', value: `${discordTag}${roleAssigned ? ' (role assigned)' : ' (not found in server)'}` }] : []),
    { name: 'admin', value: `[open console](${siteUrl()}/admin.html)`, inline: false },
  ]).catch(() => {});

  return json(200, { ok: true, issued: true, provider: provider.id, emailed: sent.emailed });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
