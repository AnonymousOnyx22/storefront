#!/usr/bin/env node
// slate go-live preflight.
//
//   node scripts/preflight.mjs            read the env, report what is missing
//   node scripts/preflight.mjs --live     also validate keys against their apis
//   node scripts/preflight.mjs --json     machine readable, for a deploy hook
//
// reads storefront/.env.local then storefront/.env, then process.env. later
// wins. never prints a secret, only whether it is present and shaped right.
//
// exit 0 = a sale can complete end to end
// exit 1 = something on the critical path is missing
// exit 2 = the env is fine but a live key check failed

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STOREFRONT = resolve(HERE, '..', 'storefront');

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const JSON_OUT = args.has('--json');

// --------------------------------------------------------------- env load

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = {};
const sources = [];
for (const name of ['.env.local', '.env']) {
  const path = resolve(STOREFRONT, name);
  if (!existsSync(path)) continue;
  Object.assign(env, parseEnv(readFileSync(path, 'utf8')));
  sources.push(name);
}
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && v !== '') env[k] = v;
}

const get = k => (env[k] || '').trim();
const has = k => get(k).length > 0;

// --------------------------------------------------------------- checks

const rows = [];
const add = (group, name, state, note = '') => rows.push({ group, name, state, note });

const PLACEHOLDER = /your-domain|example\.com|strata\.sh\/?$|changeme|xxx/i;
const masked = v => (v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 3)}…${v.slice(-2)} (${v.length})`);

// ---- payments: at least one complete provider --------------------------
const PROVIDERS = [
  {
    id: 'nowpayments',
    label: 'crypto, no approval, no chargebacks',
    vars: ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET'],
  },
  {
    id: 'cryptomus',
    label: 'crypto, backup',
    vars: ['CRYPTOMUS_MERCHANT', 'CRYPTOMUS_KEY'],
  },
  {
    id: 'payop',
    label: 'cards + local rails (needs approval)',
    vars: ['PAYOP_PUBLIC_KEY', 'PAYOP_SECRET'],
  },
  {
    id: 'stripe',
    label: 'cards (will not pass review)',
    vars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  },
  {
    id: 'hosted',
    label: 'any hosted checkout with hmac callbacks',
    vars: ['HOSTED_CHECKOUT_URL', 'HOSTED_WEBHOOK_SECRET'],
  },
];

const live = PROVIDERS.filter(p => p.vars.every(has));
for (const p of PROVIDERS) {
  const missing = p.vars.filter(v => !has(v));
  // one live provider is all a sale needs, so the individual rows are
  // informational. only the aggregate below is a blocker.
  if (!missing.length) add('payments', p.id, 'OK', p.label);
  else add('payments', p.id, 'off', `missing ${missing.join(', ')}`);
}
add('payments', 'any provider live', live.length ? 'OK' : 'MISSING',
  live.length ? live.map(p => p.id).join(', ') : 'checkout will return no_provider');

// ---- email: key delivery ----------------------------------------------
add('email', 'RESEND_API_KEY', has('RESEND_API_KEY') ? 'OK' : 'MISSING',
  has('RESEND_API_KEY') ? masked(get('RESEND_API_KEY')) : 'buyers get a key in the console only, no email');
const from = get('SLATE_FROM');
add('email', 'SLATE_FROM', from && !PLACEHOLDER.test(from) ? 'OK' : 'MISSING',
  from ? (PLACEHOLDER.test(from) ? 'still a placeholder' : from) : 'no sender address');

// ---- delivery: the gated download -------------------------------------
const dl = get('SLATE_DOWNLOAD_URL');
add('delivery', 'SLATE_DOWNLOAD_URL', dl ? 'OK' : 'MISSING',
  dl ? dl : 'the download link in every key email answers 503');

const site = get('SLATE_SITE_URL');
add('delivery', 'SLATE_SITE_URL',
  site && !PLACEHOLDER.test(site) ? 'OK' : 'MISSING',
  site ? (PLACEHOLDER.test(site) ? 'still a placeholder' : site) : 'email links fall back to netlify URL');

// ---- seller console ----------------------------------------------------
const token = get('ADMIN_TOKEN');
add('console', 'ADMIN_TOKEN',
  token.length >= 24 ? 'OK' : token ? 'WEAK' : 'MISSING',
  token ? (token.length >= 24 ? masked(token) : `${token.length} chars, use 32+`) : 'admin.html refuses every call');
add('console', 'ADMIN_TOTP_SECRET', has('ADMIN_TOTP_SECRET') ? 'OK' : 'MISSING',
  has('ADMIN_TOTP_SECRET') ? 'second factor on' : 'required; admin.html refuses every call without it');

// ---- optional ----------------------------------------------------------
const hooks = ['DISCORD_WEBHOOK_SALES', 'DISCORD_WEBHOOK_TICKETS'].filter(has);
add('optional', 'discord feeds',
  hooks.length ? 'OK' : has('DISCORD_WEBHOOK_URL') ? 'OK' : 'off',
  hooks.length ? hooks.map(h => h.replace('DISCORD_WEBHOOK_', '').toLowerCase()).join(' + ')
    : has('DISCORD_WEBHOOK_URL') ? 'single webhook, both feeds' : 'no notifications, the console is the only signal');

// ---- safety ------------------------------------------------------------
add('safety', 'SLATE_DEMO', get('SLATE_DEMO') === '1' ? 'DANGER' : 'OK',
  get('SLATE_DEMO') === '1' ? 'free keys are being issued — turn this off' : 'off');

// --------------------------------------------------------------- live

const liveResults = [];
async function probe(name, fn) {
  if (!LIVE) return;
  try {
    const note = await fn();
    liveResults.push({ name, ok: true, note: note || 'reachable' });
  } catch (e) {
    liveResults.push({ name, ok: false, note: String((e && e.message) || e).slice(0, 160) });
  }
}

const timeout = ms => ({ signal: AbortSignal.timeout(ms) });

await probe('nowpayments', async () => {
  if (!has('NOWPAYMENTS_API_KEY')) throw new Error('no key');
  const r = await fetch('https://api.nowpayments.io/v1/status', {
    headers: { 'x-api-key': get('NOWPAYMENTS_API_KEY') }, ...timeout(8000),
  });
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  if (j.message && /invalid/i.test(j.message)) throw new Error('api key rejected');
  return 'api key accepted';
});

await probe('resend', async () => {
  if (!has('RESEND_API_KEY')) throw new Error('no key');
  const r = await fetch('https://api.resend.com/domains', {
    headers: { authorization: `Bearer ${get('RESEND_API_KEY')}` }, ...timeout(8000),
  });
  if (r.status === 401) throw new Error('api key rejected');
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  const verified = (j.data || []).filter(d => d.status === 'verified').map(d => d.name);
  if (!verified.length) throw new Error('no verified domain — add spf/dkim first');
  return `verified: ${verified.join(', ')}`;
});

await probe('stripe', async () => {
  if (!has('STRIPE_SECRET_KEY')) throw new Error('no key');
  const r = await fetch('https://api.stripe.com/v1/balance', {
    headers: { authorization: `Bearer ${get('STRIPE_SECRET_KEY')}` }, ...timeout(8000),
  });
  if (r.status === 401) throw new Error('secret key rejected');
  if (!r.ok) throw new Error(`status ${r.status}`);
  return 'secret key accepted';
});

await probe('discord webhook', async () => {
  const hook = get('DISCORD_WEBHOOK_SALES') || get('DISCORD_WEBHOOK_TICKETS') || get('DISCORD_WEBHOOK_URL');
  if (!hook) throw new Error('not set');
  // GET returns the webhook object; it does not post a message.
  const r = await fetch(hook, timeout(8000));
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  return `hooked to #${j.channel_id || 'channel'}`;
});

await probe('download url', async () => {
  if (!dl) throw new Error('not set');
  const url = dl.replace('{key}', 'SLT-TEST-TEST-TEST-TEST');
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow', ...timeout(10000) });
  if (!r.ok) throw new Error(`status ${r.status}`);
  const len = r.headers.get('content-length');
  return len ? `${Math.round(Number(len) / 1048576)} MB` : 'reachable';
});

// --------------------------------------------------------------- report

const CRITICAL = new Set(['MISSING', 'WEAK', 'DANGER']);
const bad = rows.filter(r => CRITICAL.has(r.state));

if (JSON_OUT) {
  console.log(JSON.stringify({ sources, rows, live: liveResults, ok: !bad.length }, null, 2));
} else {
  const C = { OK: '\x1b[32m', off: '\x1b[90m', MISSING: '\x1b[31m', WEAK: '\x1b[33m', DANGER: '\x1b[35m', reset: '\x1b[0m', dim: '\x1b[90m' };
  console.log('');
  console.log('  slate preflight' + (LIVE ? '  (live)' : ''));
  console.log('  ' + '─'.repeat(66));
  if (sources.length) console.log(`  ${C.dim}read ${sources.join(', ')} + process.env${C.reset}`);
  else console.log(`  ${C.dim}no env file found in storefront/${C.reset}`);

  let group = '';
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      console.log('');
      console.log(`  ${C.dim}${group}${C.reset}`);
    }
    const tag = `${C[r.state] || ''}${r.state.padEnd(8)}${C.reset}`;
    const name = r.name.padEnd(22);
    console.log(`    ${tag} ${name} ${C.dim}${r.note}${C.reset}`);
  }

  if (LIVE) {
    console.log('');
    console.log(`  ${C.dim}live checks${C.reset}`);
    for (const r of liveResults) {
      const tag = r.ok ? `${C.OK}OK      ${C.reset}` : `${C.MISSING}FAIL    ${C.reset}`;
      console.log(`    ${tag} ${r.name.padEnd(22)} ${C.dim}${r.note}${C.reset}`);
    }
  }

  console.log('');
  console.log('  ' + '─'.repeat(66));
  if (bad.length) {
    console.log(`  ${C.MISSING}${bad.length} blocker${bad.length === 1 ? '' : 's'}${C.reset}: ${bad.map(r => r.name).join(', ')}`);
  } else {
    console.log(`  ${C.OK}clear to sell${C.reset}: a buyer can pay, get a key, and download.`);
  }
  console.log('');
}

const liveFailed = LIVE && liveResults.some(r => !r.ok);
process.exit(bad.length ? 1 : liveFailed ? 2 : 0);
