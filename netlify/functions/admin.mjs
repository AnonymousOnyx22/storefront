// POST /admin  { action, ... }
// the seller dashboard. every call needs the x-admin-token header and a 6
// digit code in x-admin-otp. ADMIN_TOTP_SECRET is required: the console fails
// closed without it rather than silently dropping to a single factor.
//
// actions: login stats list get revoke unrevoke reset unbind setresets
//          extend retier resend note export release confirm pending
//
// nothing here is reachable from the storefront: admin.html is noindex and
// nothing links to it. the token is the only door.
import {
  TIERS, json, readBody, normEmail, getOrder, saveOrder, issueKey,
  sendKeyEmail, expiresAt, isRevoked, touch, listOrders, searchOrders,
  adminRow, adminTokenOk, totpOk, toCsv, limited, refOf, store,
  notifyRelease, takePending, markFulfilled, notify, siteUrl,
} from '../lib/core.mjs';

const DAY = 864e5;

const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { code: msg }); };

/* every ticket the support form has opened, newest first */
async function ticketRows() {
  const s = store();
  const out = [];
  let cursor;
  for (let guard = 0; guard < 40; guard++) {
    const page = await s.list({ prefix: 'ticket:', cursor });
    for (const b of page.blobs || []) {
      const t = await s.get(b.key, { type: 'json' });
      if (t) out.push(t);
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

function auth(event) {
  const h = event.headers || {};
  if (!process.env.ADMIN_TOKEN) return 'no_admin_token';
  if (!process.env.ADMIN_TOTP_SECRET) return 'no_otp_secret';
  if (!adminTokenOk(h)) return 'bad_token';
  if (!totpOk(process.env.ADMIN_TOTP_SECRET, h['x-admin-otp'] || h['X-Admin-Otp'])) return 'bad_otp';
  return null;
}

function stats(rows) {
  const now = Date.now();
  const live = rows.filter(r => !r.revoked && !(expiresAt(r) != null && now > expiresAt(r)));
  const byTier = {};
  for (const t of Object.keys(TIERS)) byTier[t] = rows.filter(r => r.tier === t).length;
  const revenue = rows.reduce((n, r) => n + Number(r.spent || 0), 0);
  return {
    orders: rows.length,
    live: live.length,
    revoked: rows.filter(r => r.revoked).length,
    bound: rows.filter(r => r.machine).length,
    revenue,
    byTier,
    last24: rows.filter(r => (r.created || 0) > now - DAY).length,
    last7: rows.filter(r => (r.created || 0) > now - 7 * DAY).length,
  };
}

async function load(email) {
  const acct = await getOrder(normEmail(email));
  need(acct, 'no_order');
  return acct;
}

const handle = async event => {
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, service: 'slate admin', auth: (process.env.ADMIN_TOKEN && process.env.ADMIN_TOTP_SECRET) ? 'configured' : 'missing' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const ip = (event.headers || {})['x-nf-client-connection-ip'] || 'unknown';
  if (await limited(`admin:${ip}`, 300)) return json(429, { error: 'rate_limited' });

  const bad = auth(event);
  if (bad) return json(bad === 'bad_otp' ? 401 : 403, { error: bad });

  const body = readBody(event);
  const action = String(body.action || '');

  try {
    if (action === 'login') {
      const rows = await listOrders();
      const tickets = await ticketRows();
      return json(200, {
        ok: true,
        stats: { ...stats(rows), ticketsOpen: tickets.filter(t => t.status !== 'closed').length },
      });
    }

    if (action === 'stats') {
      return json(200, { ok: true, stats: stats(await listOrders()) });
    }

    if (action === 'list') {
      const rows = searchOrders(await listOrders(), body.q);
      const per = Math.min(Math.max(Number(body.per) || 40, 1), 200);
      const page = Math.max(Number(body.page) || 1, 1);
      const slice = rows.slice((page - 1) * per, page * per);
      return json(200, {
        ok: true,
        total: rows.length,
        page, per,
        rows: slice.map(adminRow),
        stats: { ...stats(rows), ticketsOpen: (await ticketRows()).filter(t => t.status !== 'closed').length },
      });
    }

    if (action === 'export') {
      const rows = searchOrders(await listOrders(), body.q).map(adminRow);
      const csv = toCsv(rows, ['email', 'key', 'tier', 'created', 'started', 'expires', 'resets', 'revoked', 'spent', 'orders', 'note']);
      return json(200, { ok: true, csv, count: rows.length });
    }

    if (action === 'get') {
      const acct = await load(body.email);
      return json(200, { ok: true, row: adminRow(acct), ref: refOf(acct.email) });
    }

    if (action === 'revoke' || action === 'unrevoke') {
      const acct = await load(body.email);
      acct.revoked = action === 'revoke';
      acct.revokedAt = acct.revoked ? Date.now() : null;
      touch(acct, action, String(body.note || '').slice(0, 200) || null);
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'unbind') {
      const acct = await load(body.email);
      const was = acct.machine && acct.machine.name;
      acct.machine = null;
      touch(acct, 'unbind', was || null);
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'reset') {
      // free reset: unbind and put the tier's allowance back
      const acct = await load(body.email);
      const t = TIERS[acct.tier];
      acct.machine = null;
      acct.resets = t && t.resets === Infinity ? null : (t ? t.resets : acct.resets);
      touch(acct, 'reset+', String(body.note || 'support reset').slice(0, 200));
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'setresets') {
      const acct = await load(body.email);
      const n = body.n === null ? null : Math.max(0, Number(body.n) || 0);
      acct.resets = n;
      touch(acct, 'setresets', String(n));
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'extend') {
      const acct = await load(body.email);
      const days = Math.max(1, Math.min(Number(body.days) || 0, 3650));
      const t = TIERS[acct.tier];
      if (!t || t.days == null) return json(400, { error: 'tier_never_expires' });
      const base = Math.max(acct.started, Date.now());
      acct.started = base + days * DAY - t.days * DAY;
      touch(acct, 'extend', `+${days}d`);
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'retier') {
      const acct = await load(body.email);
      const t = TIERS[body.tier];
      need(t, 'bad_tier');
      acct.tier = body.tier;
      acct.resets = t.resets === Infinity ? null : t.resets;
      acct.started = Date.now();
      touch(acct, 'retier', t.label);
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'resend') {
      const acct = await load(body.email);
      const sent = await sendKeyEmail(acct);
      touch(acct, 'resend', sent.emailed ? 'sent' : `failed: ${sent.reason}`);
      await saveOrder(acct);
      return json(200, { ok: true, emailed: sent.emailed, reason: sent.reason || null });
    }

    if (action === 'note') {
      const acct = await load(body.email);
      acct.note = String(body.note || '').slice(0, 500) || null;
      touch(acct, 'note', acct.note);
      await saveOrder(acct);
      return json(200, { ok: true, row: adminRow(acct) });
    }

    if (action === 'issue') {
      // comp a key, for a refund-in-kind or a replacement
      const email = normEmail(body.email);
      const t = TIERS[body.tier];
      need(email && email.includes('@'), 'invalid_email');
      need(t, 'bad_tier');
      const acct = await issueKey(email, body.tier, await getOrder(email));
      touch(acct, 'comped', `by admin · ${t.label}`);
      await saveOrder(acct);
      const sent = await sendKeyEmail(acct);
      return json(200, { ok: true, row: adminRow(acct), emailed: sent.emailed });
    }

    if (action === 'tickets') {
      const rows = await ticketRows();
      const open = rows.filter(t => t.status !== 'closed');
      return json(200, { ok: true, total: rows.length, open: open.length, rows: rows.slice(0, 200) });
    }

    if (action === 'ticket-close' || action === 'ticket-open') {
      const id = String(body.id || '').toUpperCase();
      const rec = await store().get(`ticket:${id}`, { type: 'json' });
      need(rec, 'no_ticket');
      rec.status = action === 'ticket-open' ? 'open' : 'closed';
      rec.closedAt = rec.status === 'closed' ? Date.now() : null;
      await store().setJSON(`ticket:${id}`, rec);
      return json(200, { ok: true, ticket: rec });
    }

    if (action === 'confirm') {
      // confirm a manual payment (paypal f&f) and issue the key
      const ref = String(body.ref || '').trim();
      const provider = String(body.provider || 'paypal').trim();
      need(ref, 'ref_required');
      const pending = await takePending(provider, ref);
      need(pending, 'no_pending_order');
      const email = normEmail(pending.email);
      const tier = pending.tier;
      need(email && TIERS[tier], 'bad_pending_data');
      const existing = await getOrder(email);
      const acct = await issueKey(email, tier, existing);
      touch(acct, 'confirmed', `manual ${provider} · ${ref}`);
      await saveOrder(acct);
      await markFulfilled(provider, ref);
      const sent = await sendKeyEmail(acct);
      notify('SALE', [], 'sale', [
        { name: 'key', value: `\`${acct.key}\`` },
        { name: 'tier', value: TIERS[tier].label },
        { name: 'price', value: `$${TIERS[tier].price}` },
        { name: 'buyer', value: email },
        { name: 'provider', value: `${provider} (manual)` },
        { name: 'email', value: sent.emailed ? 'delivered' : `FAILED: ${sent.reason || 'unknown'}` },
      ]).catch(() => {});
      return json(200, { ok: true, row: adminRow(acct), emailed: sent.emailed });
    }

    if (action === 'pending') {
      // list pending manual payments awaiting confirmation
      const all = await store().list({ prefix: 'pay:paypal:' });
      const rows = [];
      for (const { key } of all.blobs) {
        const data = await store().get(key, { type: 'json' });
        if (data) rows.push({ ref: key.replace('pay:paypal:', ''), ...data });
      }
      return json(200, { ok: true, rows });
    }

    if (action === 'release') {
      const ver = String(body.version || '').slice(0, 40);
      const changes = Array.isArray(body.changes) ? body.changes.map(c => String(c).slice(0, 200)) : [];
      if (!ver) return json(400, { error: 'version_required' });
      const sent = await notifyRelease(ver, changes);
      return json(200, { ok: true, ...sent });
    }

    return json(400, { error: 'bad_action' });
  } catch (e) {
    if (e && e.code) return json(400, { error: e.code });
    console.error('slate admin:', e);
    return json(500, { error: 'server_error' });
  }
};

// v1 handler shim loses the blob context; serve() runs it as a v2 function.
import { serve } from '../lib/core.mjs';
export default serve(handle);
