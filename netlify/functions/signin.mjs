// POST /signin { email, key } -> account
// the key is the password. no sessions, no cookies, nothing to steal server side.
import { json, readBody, isEmail, normEmail, normKey, isKey, getOrder, publicAccount, isRevoked, limited, safeEq } from '../lib/core.mjs';

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const body = readBody(event);
  const email = normEmail(body.email);
  const key = normKey(body.key);

  if (!isEmail(email)) return json(400, { error: 'invalid_email' });
  if (!isKey(key)) return json(400, { error: 'invalid_key' });
  if (await limited(`signin:${email}`)) return json(429, { error: 'rate_limited' });

  const acct = await getOrder(email);
  if (!acct || !safeEq(acct.key, key)) return json(401, { error: 'no_order' });
  if (isRevoked(acct)) return json(403, { error: 'revoked' });

  return json(200, { ok: true, account: publicAccount(acct) });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
