// POST /ticket { email, key?, subject, body }
// a support ticket that lands in the seller console instead of a mailbox.
// no email is sent anywhere: nothing about this path needs a domain, a DNS
// record or a provider account, which is the point.
import { randomBytes } from 'node:crypto';
import { json, readBody, isEmail, normEmail, normKey, isKey, store, limited, notify, siteUrl } from '../lib/core.mjs';

export const ticketId = () => randomBytes(4).toString('hex').toUpperCase();

const handle = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const ip = (event.headers || {})['x-nf-client-connection-ip'] || 'unknown';
  if (await limited(`ticket:ip:${ip}`, 6, 300_000)) return json(429, { error: 'rate_limited' });

  const body = readBody(event);
  const email = normEmail(body.email);
  const subject = String(body.subject || '').trim().slice(0, 120);
  const text = String(body.body || '').trim().slice(0, 4000);
  const key = body.key ? normKey(body.key) : '';

  if (!isEmail(email)) return json(400, { error: 'invalid_email' });
  if (subject.length < 3) return json(400, { error: 'subject_too_short' });
  if (text.length < 10) return json(400, { error: 'body_too_short' });
  if (key && !isKey(key)) return json(400, { error: 'invalid_key' });
  if (await limited(`ticket:${email}`, 4, 600_000)) return json(429, { error: 'rate_limited' });

  const id = ticketId();
  const rec = {
    id,
    email,
    key: key || null,
    subject,
    body: text,
    at: Date.now(),
    status: 'open',
  };

  try {
    await store().setJSON(`ticket:${id}`, rec);
  } catch (e) {
    console.error('slate ticket:', e);
    return json(500, { error: 'store_failed' });
  }

  /* the ticket is already safe in blobs. a dead webhook must never cost the
     buyer their submission, so this is fire and forget. */
  notify(`TICKET #${id.slice(-6)}`, [subject], 'warn', [
    { name: 'from', value: email },
    ...(rec.key ? [{ name: 'key', value: `\`${rec.key}\`` }] : []),
    { name: 'message', value: text.slice(0, 800), inline: false },
    { name: 'admin', value: `[open console](${siteUrl()}/admin.html)`, inline: false },
  ]).catch(() => {});

  return json(200, { ok: true, id });
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
