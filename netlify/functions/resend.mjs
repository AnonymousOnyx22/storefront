// POST /resend { email }
// always the same answer, so the endpoint cannot be used to probe for orders.
import { json, readBody, isEmail, normEmail, getOrder, sendKeyEmail, limited } from '../lib/core.mjs';

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const email = normEmail(readBody(event).email);
  if (!isEmail(email)) return json(400, { error: 'invalid_email' });
  if (await limited(`resend:${email}`, 4, 120_000)) return json(429, { error: 'rate_limited' });

  const acct = await getOrder(email);
  if (acct) await sendKeyEmail(acct);

  return json(200, { ok: true, message: 'if an order exists for that address, the key is on its way.' });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
