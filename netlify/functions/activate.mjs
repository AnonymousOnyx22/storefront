// POST /activate { key, hwid, machine, version }
// the app calls this on every launch. it is the only place a key becomes a
// bound machine, and the only place expiry and revocation are enforced before
// the spoofer runs.
//
// trust model: hwid is supplied by the client and is therefore spoofable.
// that is fine. this stops one key on ten PCs, not a determined reverse
// engineer. anything stronger needs a server-issued challenge, which is not
// worth the support load at this price.
import {
  json, readBody, normKey, isKey, getOrderByKey, saveOrder, expiresAt,
  isRevoked, touch, limited, normHwid, normMachineName,
} from '../lib/core.mjs';

const clean = (v, n) => String(v || '').replace(/[^\w .:\-]/g, '').trim().slice(0, n);

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const ip = (event.headers || {})['x-nf-client-connection-ip'] || 'unknown';
  if (await limited(`activate:ip:${ip}`, 60, 300_000)) return json(429, { error: 'rate_limited' });

  const body = readBody(event);
  const key = normKey(body.key);
  if (!isKey(key)) return json(400, { error: 'invalid_key' });
  if (await limited(`activate:key:${key}`, 30, 300_000)) return json(429, { error: 'rate_limited' });

  const hwid = normHwid(body.hwid);
  if (hwid.length < 8) return json(400, { error: 'bad_hwid' });

  const acct = await getOrderByKey(key);
  if (!acct) return json(404, { error: 'no_order' });
  if (isRevoked(acct)) return json(403, { error: 'revoked' });

  const exp = expiresAt(acct);
  if (exp != null && Date.now() > exp) return json(403, { error: 'expired', expires: exp });

  const bound = acct.machine;
  if (bound && bound.hwid && bound.hwid !== hwid) {
    /* one PC per key. the fix is a reset on the site, which spends a reset. */
    return json(409, {
      error: 'machine_mismatch',
      bound: { name: bound.name || 'another PC', at: bound.at || null },
      resets: acct.resets,
    });
  }

  if (!bound) {
    acct.machine = {
      name: normMachineName(body.machine) || 'DESKTOP-UNKNOWN',
      hwid,
      at: Date.now(),
    };
    touch(acct, 'activate', `${acct.machine.name} · v${clean(body.version, 12) || '?'}`);
    await saveOrder(acct);
  } else if (!bound.hwid) {
    /* bound before the app existed, or by the key page without a fingerprint.
       adopt this machine instead of handing out a free pass to every PC. */
    bound.hwid = hwid;
    bound.at = Date.now();
    bound.name = bound.name || normMachineName(body.machine) || 'DESKTOP-UNKNOWN';
    touch(acct, 'activate', `${bound.name} · fingerprint adopted`);
    await saveOrder(acct);
  }

  return json(200, {
    ok: true,
    tier: acct.tier,
    expires: exp,
    resets: acct.resets,
    machine: acct.machine.name,
    bound: true,
  });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
