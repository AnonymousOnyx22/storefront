// GET /download?key=SLT-XXXX-XXXX-XXXX-XXXX
// the link in the key email. a live, unrevoked, unexpired key gets a 302 to
// the artifact; anything else gets a plain page saying why.
//
// SLATE_DOWNLOAD_URL may contain {key} if the host wants per-key links
// (signed object storage, expiring url). otherwise it is a plain file url.
import { normKey, isKey, getOrderByKey, expiresAt, isRevoked, limited } from '../lib/core.mjs';

const page = (code, title, body) => ({
  statusCode: code,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>slate - ${title}</title>
<style>
  html{background:#000;color:#fff;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace}
  body{max-width:520px;margin:14vh auto;padding:0 20px}
  h1{font-size:16px;font-weight:500;margin:0 0 14px;letter-spacing:.02em}
  p{color:#8c8c8c;margin:0 0 10px}
  a{color:#fff}
  .box{border:1px solid #2a2a2a;padding:14px 16px;margin:18px 0}
</style>
<h1>${title}</h1>
<div class="box"><p>${body}</p></div>
<p><a href="/help.html#contact">open a ticket</a> &middot; <a href="/">slate</a></p>`,
});

const handle = async event => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return page(405, 'method not allowed', 'this link only works as a normal browser link.');
  }

  const q = event.queryStringParameters || {};
  const key = normKey(q.key);
  if (!isKey(key)) return page(400, 'that link is incomplete', 'the key in the link is not valid. copy the whole link from your order email.');
  if (await limited(`download:${key}`, 20, 3_600_000)) {
    return page(429, 'too many attempts', 'wait a few minutes and open the link from your email again.');
  }

  const target = process.env.SLATE_DOWNLOAD_URL;
  if (!target) return page(503, 'download not ready', 'this store has no artifact published yet. open a ticket and we will send it directly.');

  const acct = await getOrderByKey(key);
  if (!acct) return page(404, 'no key matches', 'that key is not in the order list. check the link in your email, or open a ticket with the address you bought with.');
  if (isRevoked(acct)) return page(403, 'this key was revoked', 'the key was refunded or withdrawn, so the download is closed too. open a ticket if you think that is wrong.');

  const exp = expiresAt(acct);
  if (exp != null && Date.now() > exp) {
    return page(403, 'this key has expired', `the ${acct.tier} key ended on ${new Date(exp).toISOString().slice(0, 10)}. buy a new one to get a fresh link.`);
  }

  return {
    statusCode: 302,
    headers: {
      location: String(target).replace('{key}', encodeURIComponent(key)),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
    body: '',
  };
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
