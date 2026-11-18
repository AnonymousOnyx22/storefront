// POST /account { email, key, action: "bind" | "reset", machine? }
// binding happens in the CLI in production; this endpoint is what the keys page
// calls for the simulate-activation and reset-hwid buttons.
import { json, readBody, isEmail, normEmail, normKey, isKey, getOrder, saveOrder, publicAccount, isRevoked, touch, limited, safeEq, normHwid, normMachineName } from '../lib/core.mjs';

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const body = readBody(event);
  const email = normEmail(body.email);
  const key = normKey(body.key);
  const action = body.action;

  if (!isEmail(email)) return json(400, { error: 'invalid_email' });
  if (!isKey(key)) return json(400, { error: 'invalid_key' });
  if (await limited(`account:${email}`, 20)) return json(429, { error: 'rate_limited' });

  const acct = await getOrder(email);
  if (!acct || !safeEq(acct.key, key)) return json(401, { error: 'no_order' });
  if (isRevoked(acct)) return json(403, { error: 'revoked' });

  if (action === 'bind') {
    // simulate-activation only works on a fresh, unbound account. a bound
    // account must spend a reset first, same as the real activate.mjs path -
    // otherwise anyone with the email+key could rebind for free forever.
    if (acct.machine) return json(409, { error: 'already_bound' });
    const m = body.machine || {};
    // the fingerprint must land in the same shape activate.mjs will compare
    // against, or the account is bound to a value the CLI can never match.
    const hwid = normHwid(m.hwid);
    if (hwid.length < 8) return json(400, { error: 'bad_hwid' });
    acct.machine = {
      name: normMachineName(m.name) || 'DESKTOP-UNKNOWN',
      hwid,
      at: Date.now(),
    };
    touch(acct, 'bind', 'web simulate-activation');
  } else if (action === 'reset') {
    if (!acct.machine) return json(400, { error: 'not_bound' });
    if (acct.resets !== null && acct.resets <= 0) return json(403, { error: 'no_resets' });
    acct.machine = null;
    if (acct.resets !== null) acct.resets -= 1;
    touch(acct, 'reset', 'customer self-serve');
  } else {
    return json(400, { error: 'bad_action' });
  }

  await saveOrder(acct);
  return json(200, { ok: true, account: publicAccount(acct) });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
