// GET /verify?key=SLT-XXXX-XXXX-XXXX-XXXX
// read only. the CLI calls this on activation and on a periodic re-check.
import { json, normKey, isKey, getOrderByKey, expiresAt, isRevoked, limited } from '../lib/core.mjs';

const handle = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const q = event.queryStringParameters || {};
  const key = normKey(q.key);
  if (!isKey(key)) return json(400, { error: 'invalid_key' });
  if (await limited(`verify:${key}`, 60)) return json(429, { error: 'rate_limited' });

  const acct = await getOrderByKey(key);
  if (!acct) return json(404, { valid: false, error: 'no_order' });

  if (isRevoked(acct)) return json(200, { valid: false, revoked: true, error: 'revoked' });

  const exp = expiresAt(acct);
  const expired = exp != null && Date.now() > exp;
  return json(200, {
    valid: !expired,
    expired,
    tier: acct.tier,
    expires: exp,
    resets: acct.resets,
    bound: Boolean(acct.machine),
  });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
