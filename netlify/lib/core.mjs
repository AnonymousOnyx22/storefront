// slate order core: key issuance, blob store, email, stripe helpers.
// shared by every function under netlify/functions. keep it dependency free
// apart from @netlify/blobs (declared in storefront/package.json).

import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const TIERS = {
  // slate (hwid spoofer)
  day:     { label: '1 day',     price: 6.99,  days: 1,    resets: Infinity, product: 'slate' },
  week:    { label: '7 days',    price: 14.99, days: 7,    resets: Infinity, product: 'slate' },
  month:   { label: '30 days',   price: 29.99, days: 30,   resets: Infinity, product: 'slate' },
  quarter: { label: '90 days',   price: 59.99, days: 90,   resets: Infinity, product: 'slate' },
  life:    { label: 'permanent', price: 99.99, days: null, resets: Infinity, product: 'slate' },
  // basalt (rust external)
  'basalt-day':     { label: '1 day',     price: 9.99,  days: 1,    resets: Infinity, product: 'basalt' },
  'basalt-week':    { label: '7 days',    price: 24.99, days: 7,    resets: Infinity, product: 'basalt' },
  'basalt-month':   { label: '30 days',   price: 44.99, days: 30,   resets: Infinity, product: 'basalt' },
  'basalt-quarter': { label: '90 days',   price: 89.99, days: 90,   resets: Infinity, product: 'basalt' },
  'basalt-life':    { label: 'permanent', price: 149.99, days: null, resets: Infinity, product: 'basalt' },
  // retired: kept only so old records and admin history still resolve.
  once:    { label: 'one-time spoof', price: 12, days: null, resets: 0, retired: true, product: 'slate' },
};

const DAY = 864e5;
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// the functions runtime exposes a global `Netlify.env` that shadows process.env
// inside @netlify/blobs, and on this runtime that view does not carry the blob
// context, so getStore() cannot find its credentials. decode the context from
// process.env ourselves and hand it over.
function blobContext() {
  const raw = process.env.NETLIFY_BLOBS_CONTEXT;
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// netlify's v1 handler shim runs the function with NETLIFY_* stripped out of
// process.env, and the blob context is one of them. a v2 function (default
// export) keeps the full environment. this adapts a v1-style handler into a v2
// entry so the handlers stay plain objects and still get their credentials.
export const serve = handler => async request => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? '' : await request.text();
  const event = {
    httpMethod: method,
    path: url.pathname,
    rawUrl: request.url,
    rawQuery: url.search.replace(/^\?/, ''),
    queryStringParameters: Object.fromEntries(url.searchParams),
    multiValueQueryStringParameters: {},
    headers: Object.fromEntries(request.headers),
    body,
    isBase64Encoded: false,
  };
  const result = await handler(event);
  if (result instanceof Response) return result;
  const { statusCode = 200, headers = {}, body: out = '', isBase64Encoded = false } = result || {};
  const payload = isBase64Encoded ? Buffer.from(out, 'base64') : out;
  return new Response(payload, { status: statusCode, headers });
};

export const store = () => {
  const ctx = blobContext();
  if (!ctx?.siteID || !ctx?.token) return getStore('slate');
  return getStore({
    name: 'slate',
    siteID: ctx.siteID,
    token: ctx.token,
    ...(ctx.edgeURL ? { edgeURL: ctx.edgeURL } : {}),
    ...(ctx.uncachedEdgeURL ? { uncachedEdgeURL: ctx.uncachedEdgeURL } : {}),
  });
};

export function json(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(body),
  };
}

export function readBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

export const isEmail = s => typeof s === 'string' && /^\S+@\S+\.\S+$/.test(s);
export const normEmail = s => String(s || '').trim().toLowerCase();
export const normKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SLT/, '').slice(0, 16)
  .replace(/(.{4})(?=.)/g, '$1-').replace(/^/, 'SLT-');
export const isKey = s => /^SLT(-\w{4}){4}$/.test(s);
/* one canonical machine fingerprint for every path that stores one. the CLI
   (activate.mjs) and the web simulate-activation (account.mjs) must agree
   byte-for-byte or a bound account can never match the machine that binds it. */
export const normHwid = s => String(s || '').replace(/[^\w .:\-]/g, '').trim().toLowerCase().slice(0, 64);
/* the machine display name travels the same way as the fingerprint: same
   charset, same length cap, on both the CLI and the web path. */
export const normMachineName = s => String(s || '').replace(/[^\w .:\-]/g, '').trim().slice(0, 32);

function newKey() {
  const b = randomBytes(16);
  let body = '';
  for (let i = 0; i < 16; i++) body += ABC[b[i] % ABC.length];
  return ['SLT', body.slice(0, 4), body.slice(4, 8), body.slice(8, 12), body.slice(12, 16)].join('-');
}

export const orderId = email => `order:${email}`;
export const keyId = key => `key:${key}`;

/* the site's own origin, for links that go inside email. netlify sets URL,
   but SLATE_SITE_URL wins so a custom domain is never at the mercy of a
   deploy preview url. */
export const siteUrl = () =>
  (process.env.SLATE_SITE_URL || process.env.URL || 'https://useslate.net').replace(/\/$/, '');

/* gated download: the link in the key email resolves a key to the artifact.
   the key never appears in a public url, and revocation kills the link too. */
export const downloadUrl = key =>
  `${siteUrl()}/.netlify/functions/download?key=${encodeURIComponent(key)}`;

/* ---------- optional out-of-band notifications ----------
   one webhook per feed, all optional, no bot and no gateway:
     DISCORD_WEBHOOK_SALES    #sales    a key was issued
     DISCORD_WEBHOOK_TICKETS  #tickets  a buyer opened a ticket
   DISCORD_WEBHOOK_URL is the fallback for both, so one webhook still works. */
export const webhookFor = level => {
  if (level === 'sale') return process.env.DISCORD_WEBHOOK_SALES || process.env.DISCORD_WEBHOOK_URL || '';
  if (level === 'release') return process.env.DISCORD_WEBHOOK_CHANGELOG || process.env.DISCORD_WEBHOOK_URL || '';
  return process.env.DISCORD_WEBHOOK_TICKETS || process.env.DISCORD_WEBHOOK_URL || '';
};

export async function notify(title, lines = [], level = 'info', fields = []) {
  const hook = webhookFor(level);
  if (!hook) return { sent: false, reason: 'no discord webhook set' };
  const color = level === 'sale' ? 0xffffff : level === 'warn' ? 0xc0464f : 0x8c8c8c;
  const embed = {
    title: String(title).slice(0, 240),
    color,
    timestamp: new Date().toISOString(),
  };
  if (fields.length) {
    embed.fields = fields.slice(0, 25).map(f => ({
      name: String(f.name).slice(0, 256),
      value: String(f.value).slice(0, 1024),
      inline: f.inline !== false,
    }));
  }
  const desc = lines.filter(Boolean).map(l => String(l).slice(0, 900)).join('\n').slice(0, 3800);
  if (desc) embed.description = desc;
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'slate', embeds: [embed] }),
    });
    return { sent: r.ok, reason: r.ok ? null : `discord ${r.status}` };
  } catch (e) {
    return { sent: false, reason: String((e && e.message) || e) };
  }
}

export async function notifyRelease(version, changes = []) {
  const lines = changes.map(c => `\`${c.startsWith('+') || c.startsWith('-') ? c : '+ ' + c}\``);
  return notify(`v${version}`, lines, 'release');
}

/* pending payments: the checkout function writes one when it hands the buyer to
   a processor, the webhook reads it back to learn who paid for what. keyed by
   the order reference the processor echoes, so no email ever rides in a url. */
export const payId = (provider, ref) => `pay:${provider}:${ref}`;

export async function putPending(provider, ref, data) {
  await store().setJSON(payId(provider, ref), { ...data, at: Date.now() }, { consistency: 'strong' });
}

export async function takePending(provider, ref) {
  const id = payId(provider, ref);
  try {
    const rec = await store().get(id, { type: 'json', consistency: 'strong' });
    if (rec) await store().delete(id);
    return rec;
  } catch (e) { return null; }
}

/* fulfillment is one-shot per processor reference. the pending record is
   consumed on the first callback; a retried or replayed delivery (same
   signature, pending already gone) must be recognised as a duplicate and must
   not re-issue, re-clock the licence, or double-count the sale. */
export const fulfilledId = (provider, ref) => `fulfilled:${provider}:${ref}`;

export async function alreadyFulfilled(provider, ref) {
  if (!ref) return false;
  try {
    const seen = await store().get(fulfilledId(provider, ref), { consistency: 'strong' });
    return Boolean(seen);
  } catch (e) { return false; }
}

export async function markFulfilled(provider, ref) {
  if (!ref) return;
  try {
    await store().set(fulfilledId(provider, ref), String(Date.now()), { consistency: 'strong' });
  } catch (e) { /* best effort: a missed marker only re-opens the retry window */ }
}

// strong reads: a buyer can activate or open their download link within seconds
// of paying, and the default eventual reads will occasionally miss the write.
export async function getOrder(email) {
  try { return await store().get(orderId(email), { type: 'json', consistency: 'strong' }); } catch (e) { return null; }
}

export async function getOrderByKey(key) {
  try {
    const email = await store().get(keyId(key), { type: 'text', consistency: 'strong' });
    if (!email) return null;
    return await getOrder(email);
  } catch (e) { return null; }
}

/* create a fresh order, or reactivate the existing key slot on a re-buy */
export async function issueKey(email, tier, existing = null) {
  const t = TIERS[tier];
  if (!t || t.retired) throw new Error('bad_tier');
  let acct;
  if (existing) {
    acct = {
      ...existing,
      tier,
      started: Date.now(),
      resets: t.resets === Infinity ? null : Math.max(t.resets, existing.resets ?? 0),
      machine: existing.machine || null,
      spent: Number(existing.spent || 0) + t.price,
      orders: Number(existing.orders || 0) + 1,
    };
    touch(acct, 'repurchase', `${t.label} · $${t.price}`);
  } else {
    acct = {
      email,
      key: newKey(),
      tier,
      started: Date.now(),
      resets: t.resets === Infinity ? null : t.resets,
      machine: null,
      created: Date.now(),
      revoked: false,
      spent: t.price,
      orders: 1,
      history: [{ at: Date.now(), what: 'purchase', note: `${t.label} · $${t.price}` }],
    };
  }
  await store().setJSON(orderId(email), acct, { consistency: 'strong' });
  await store().set(keyId(acct.key), email, { consistency: 'strong' });
  return acct;
}

export async function saveOrder(acct) {
  await store().setJSON(orderId(acct.email), acct, { consistency: 'strong' });
  await store().set(keyId(acct.key), acct.email, { consistency: 'strong' });
  return acct;
}

export function expiresAt(acct) {
  const t = TIERS[acct.tier];
  return t && t.days != null ? acct.started + t.days * DAY : null;
}

/* strip internals before an account leaves the server */
export function publicAccount(acct) {
  return {
    email: acct.email,
    key: acct.key,
    tier: acct.tier,
    started: acct.started,
    created: acct.created,
    resets: acct.resets === Infinity ? null : acct.resets,
    machine: acct.machine || null,
    expires: expiresAt(acct),
  };
}

/* ---------- revocation and support history ---------- */
export const isRevoked = acct => Boolean(acct && acct.revoked);

/* every admin action lands here, so a support thread can be reconstructed later */
export function touch(acct, what, note) {
  acct.history = Array.isArray(acct.history) ? acct.history : [];
  acct.history.unshift({ at: Date.now(), what, note: note || null });
  acct.history = acct.history.slice(0, 50);
  return acct;
}

/* ---------- admin: listing every order ---------- */
export async function listOrders() {
  const s = store();
  const out = [];
  let cursor;
  for (let guard = 0; guard < 40; guard++) {
    const page = await s.list({ prefix: 'order:', cursor });
    for (const b of page.blobs || []) {
      const email = b.key.slice('order:'.length);
      const acct = await s.get(b.key, { type: 'json' });
      if (acct) out.push(acct);
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}

export function searchOrders(rows, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return rows;
  return rows.filter(r =>
    String(r.email || '').includes(s) ||
    String(r.key || '').toLowerCase().includes(s) ||
    String(r.tier || '').includes(s) ||
    String((r.machine && r.machine.name) || '').toLowerCase().includes(s));
}

export function adminRow(acct) {
  return {
    email: acct.email,
    key: acct.key,
    tier: acct.tier,
    created: acct.created || acct.started || 0,
    started: acct.started || 0,
    expires: expiresAt(acct),
    resets: acct.resets === Infinity ? null : acct.resets,
    machine: acct.machine || null,
    revoked: Boolean(acct.revoked),
    revokedAt: acct.revokedAt || null,
    note: acct.note || null,
    history: acct.history || [],
    spent: Number(acct.spent || 0),
    orders: Number(acct.orders || 0),
  };
}

/* ---------- admin auth: bearer token + totp ---------- */
export function safeEq(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminTokenOk(headers = {}) {
  const want = process.env.ADMIN_TOKEN;
  if (!want) return false;
  const got = headers['x-admin-token'] || headers['X-Admin-Token'] || '';
  return got.length > 0 && safeEq(got, want);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/* rfc 6238 totp, 6 digits, 30s step. accepts one step of drift either way */
export function totpNow(secret, at = Date.now()) {
  const key = b32decode(secret);
  const step = Math.floor(at / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const mac = createHmac('sha1', key).update(buf).digest();
  const off = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1e6;
  return String(n).padStart(6, '0');
}

export function totpOk(secret, code) {
  if (!secret) return true;
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  const now = Date.now();
  return [-30000, 0, 30000].some(d => safeEq(totpNow(secret, now + d), c));
}

/* a stable, non-reversible id for a support ticket reference */
export const refOf = email => createHash('sha256').update(String(email)).digest('hex').slice(0, 8);

/* ---------- csv ---------- */
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows, cols) =>
  [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');

/* ---------- email ----------
   one template, two callers: the first key (payment-webhook, admin issue)
   and every resend (admin resend, the /resend self-serve endpoint). table
   layout, inline styles only - this has to survive outlook's word engine,
   not just a modern mail client. */
export function keyEmail(acct) {
  const t = TIERS[acct.tier];
  const prod = t.product || 'slate';
  const exp = expiresAt(acct);
  const expTxt = exp ? new Date(exp).toISOString().slice(0, 10) : 'never';
  const resets = acct.resets === null || acct.resets === Infinity ? 'unlimited' : String(acct.resets);
  const dl = downloadUrl(acct.key);
  const login = `${siteUrl()}/login.html`;
  const help = `${siteUrl()}/help.html#contact`;

  const isBasalt = prod === 'basalt';
  const prodName = isBasalt ? 'basalt' : 'slate';

  const text = isBasalt
? `your basalt key

key       ${acct.key}
tier      ${t.label}
expires   ${expTxt}
resets    ${resets}

set up:
  1. download basalt   ${dl}
  2. run basalt.exe as administrator
  3. paste the key above when prompted
  4. open Rust, press INSERT to open the menu

manage your key:
  ${login}
  sign in with this email and the key above. no password.

if the download link ever stops working, your key was refunded or
revoked. open a ticket: ${help}

basalt is by slate. windows 10 and 11, 64-bit.
`
: `your slate key

key       ${acct.key}
tier      ${t.label}
expires   ${expTxt}
resets    ${resets}

set up:
  1. download slate   ${dl}
  2. run the installer and allow it
  3. paste the key above when the app asks
  4. press SPOOF MY PC, then restart

manage your key, resets, and the PC it is bound to:
  ${login}
  sign in with this email and the key above. no password.

if the download link ever stops working, your key was refunded or
revoked. open a ticket: ${help}

slate is by slate. windows 10 and 11, 64-bit, uefi.
`;

  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
  // monochrome only - no color anywhere. matches the storefront and the cli
  // (brutal.py's "stark black-and-white... high-contrast inverted badges"),
  // not a one-off palette for this email.
  const row = (k, v) =>
    `<tr><td style="padding:5px 0;color:#7a7a7a;font:13px ${mono};">${k}</td>` +
    `<td style="padding:5px 0;color:#fff;font:13px ${mono};text-align:right;">${v}</td></tr>`;
  const step = (n, label) =>
    `<tr><td valign="top" style="padding:4px 0;width:22px;color:#fff;font:13px ${mono};font-weight:700;">[${n}]</td>` +
    `<td style="padding:4px 0;color:#d6d6d6;font:13px/1.5 ${mono};">${label}</td></tr>`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding:0 2px 20px;">
          <span style="color:#7a7a7a;font:12px ${mono};letter-spacing:.14em;text-transform:uppercase;">${prodName}</span>
        </td></tr>

        <tr><td style="border:1px solid #fff;background:#000;">
          <!-- terminal chrome bar, same pattern as the storefront's .term-bar -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #fff;">
            <tr>
              <td style="padding:9px 14px;color:#fff;font:12px ${mono};">~/${prodName}</td>
              <td align="right" style="padding:9px 14px;color:#7a7a7a;font:12px ${mono};">new key</td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:24px 26px 22px;">
              <p style="margin:0 0 20px;color:#fff;font:14px/1.6 ${mono};">
                <span style="color:#7a7a7a;">$</span> your key is below. keep this email &mdash; it's how you sign in later.
              </p>

              <!-- the key, rendered as an inverted terminal badge: white fill, black text -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                <tr><td align="center" style="padding:3px 0 8px;">
                  <span style="display:block;color:#7a7a7a;font:11px ${mono};letter-spacing:.16em;text-transform:uppercase;">license key</span>
                </td></tr>
                <tr><td align="center" style="padding:0 0 4px;">
                  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#fff;padding:12px 18px;">
                    <span style="display:inline-block;color:#000;font:20px ${mono};font-weight:700;letter-spacing:.08em;">${acct.key}</span>
                  </td></tr></table>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #262626;border-bottom:1px solid #262626;">
                ${row('tier', t.label)}
                ${row('expires', expTxt)}
                ${row('resets', resets)}
              </table>

              <p style="margin:0 0 10px;color:#7a7a7a;font:11px ${mono};letter-spacing:.1em;text-transform:uppercase;">set up</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 26px;">
                ${isBasalt
                  ? `${step(1, 'download basalt')}
                ${step(2, 'run basalt.exe as administrator')}
                ${step(3, 'paste the key above when prompted')}
                ${step(4, 'open Rust, press INSERT to open the menu')}`
                  : `${step(1, 'download slate')}
                ${step(2, 'run the installer and allow it')}
                ${step(3, 'paste the key above when the app asks')}
                ${step(4, 'press SPOOF MY PC, then restart')}`}
              </table>

              <!-- inverted button, same white-fill/black-text treatment as the key badge -->
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr><td style="background:#fff;">
                  <a href="${dl}" style="display:inline-block;padding:13px 24px;color:#000;font:13px ${mono};font-weight:700;letter-spacing:.03em;text-decoration:none;">
                    [ DOWNLOAD ${prodName.toUpperCase()} &rarr; ]
                  </a>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:20px 2px 0;color:#6e6e6e;font:12px/1.7 ${mono};">
          manage your key, resets, and the PC it's bound to on the
          <a href="${login}" style="color:#9a9a9a;">my key</a> page &mdash; sign in with this email and the key above, no password.<br><br>
          if the download link above ever stops working, this key was refunded or revoked.
          <a href="${help}" style="color:#9a9a9a;">open a ticket</a> if that looks wrong.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: `your ${prodName} key`, text, html };
}

export async function sendKeyEmail(acct) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { emailed: false, reason: 'RESEND_API_KEY not set' };
  const from = process.env.SLATE_FROM || 'slate <keys@useslate.net>';
  const { subject, text, html } = keyEmail(acct);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [acct.email], subject, text, html }),
    });
    if (!r.ok) return { emailed: false, reason: `resend ${r.status}: ${(await r.text()).slice(0, 300)}` };
    return { emailed: true };
  } catch (e) {
    return { emailed: false, reason: String(e && e.message || e) };
  }
}

/* ---------- rate limit, shared across every function instance ----------
   netlify functions are serverless: a burst of traffic can land on several
   cold instances, each with its own memory, so an in-process Map only ever
   throttled one instance at a time - the other instances had no idea a
   limit existed. backing it with the blob store makes the limit real across
   the whole site, at the cost of two blob round trips per check.

   read-then-write, not atomic: a handful of truly simultaneous requests can
   slip past the edge of the count. that is fine for abuse mitigation and
   nothing financial leans on it - the payment amount and tier always come
   from the server's own records (see issueKey/checkout.mjs), never from
   anything this limiter gates.

   fails open: if the store is unreachable, let the request through rather
   than lock out a paying buyer over blob-store trouble. */
export async function limited(key, max = 12, windowMs = 60_000) {
  const id = `rl:${key}`;
  const now = Date.now();
  let rec = null;
  try {
    rec = await store().get(id, { type: 'json' });
  } catch (e) {
    return false;
  }
  if (!rec || typeof rec.t !== 'number' || now - rec.t > windowMs) {
    try { await store().setJSON(id, { n: 1, t: now }); } catch (e) {}
    return false;
  }
  const n = Number(rec.n || 0) + 1;
  try { await store().setJSON(id, { n, t: rec.t }); } catch (e) {}
  return n > max;
}

export function originOf(event) {
  if (process.env.URL) return process.env.URL.replace(/\/$/, '');
  const h = event.headers || {};
  const host = h.host || h['x-forwarded-host'];
  const proto = h['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : 'https://useslate.net';
}
