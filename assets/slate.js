/* slate: checkout -> emailed key -> account.
   Talks to /.netlify/functions/* when the site is deployed on Netlify.
   When those endpoints are missing (local static preview, file://, offline)
   it falls back to a browser-only demo so the flow still works end to end. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fast = () => reduce || document.documentElement.classList.contains('still');
const SPIN = ['|', '/', '-', '\\'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIERS = {
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
};
const DAY = 864e5;

/* ---------- storage (demo fallback only) ---------- */
const db = {
  get(k) { try { return JSON.parse(localStorage.getItem('slate:' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('slate:' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('slate:' + k); } catch (e) {} },
};
const accounts = () => db.get('accounts') || {};
const saveAccount = a => { const all = accounts(); all[a.email] = a; db.set('accounts', all); };
const findAccount = email => accounts()[email.toLowerCase()] || null;

/* ---------- api ---------- */
async function post(name, body) {
  let r;
  try {
    r = await fetch(`/.netlify/functions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { offline: true };
  }
  // 404/405/501 means the function is not deployed. Anything else is a real answer.
  if (r.status === 404 || r.status === 405 || r.status === 501) return { offline: true };
  let data = null;
  try { data = await r.json(); } catch (e) { return { offline: true }; }
  if (!data || typeof data !== 'object') return { offline: true };
  if (!r.ok) return { ok: false, error: data.error || `http ${r.status}` };
  return data;
}

/* ---------- helpers ---------- */
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function rand(n, set = ABC) {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map(x => set[x % set.length]).join('');
}
const newKey = () => ['SLT', rand(4), rand(4), rand(4), rand(4)].join('-');
const normKey = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SLT/, '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1-').replace(/^/, 'SLT-');
const maskKey = k => k.replace(/^(SLT-\w{4})-\w{4}-\w{4}-(\w{4})$/, '$1-••••-••••-$2');
const isEmail = s => /^\S+@\S+\.\S+$/.test(s);
const fmtDate = t => new Date(t).toISOString().slice(0, 10);
const expiresAt = a => TIERS[a.tier].days == null ? null : a.started + TIERS[a.tier].days * DAY;
const isExpired = a => { const e = expiresAt(a); return e != null && Date.now() > e; };
const resetsText = n => n === Infinity || n === null || n === undefined ? 'unlimited' : String(n);
const humanError = e => ({
  invalid_email: 'that email looks incomplete. the key goes there, so check it.',
  invalid_key: 'keys look like SLT-XXXX-XXXX-XXXX-XXXX.',
  no_order: 'no key matches that email. check the order email or use resend key.',
  no_payment: 'payment is not configured on this deploy. set a processor key or SLATE_DEMO=1.',
  subject_too_short: 'give the ticket a subject.',
  body_too_short: 'a few more words about what happened.',
  email_failed: 'the key was created but the email failed to send. use resend key, or contact support.',
  rate_limited: 'too many attempts. wait a minute and try again.',
}[e] || `error: ${e || 'something went wrong'}.`);

async function steps(box, list) {
  for (const s of list) {
    const line = document.createElement('div'); box.appendChild(line);
    for (let i = 0; i < (fast() ? 1 : 8); i++) { line.textContent = `${SPIN[i % 4]} ${s}`; await sleep(70); }
    line.textContent = `✓ ${s}`;
  }
}
function say(box, html) { box.insertAdjacentHTML('beforeend', `<div>${html}</div>`); }

/* ============ CHECKOUT ============ */
(function checkout() {
  const form = $('#buyForm'); if (!form) return;
  const status = $('#buyStatus'), submit = $('#buySubmit'), inbox = $('#inbox'), feats = $('#tierFeats');
  const tierToggle = $('#tierToggle');
  const params = new URLSearchParams(location.search);
  let product = 'slate';
  let tier = params.get('tier');
  if (tier && tier.startsWith('basalt-')) product = 'basalt';
  if (!TIERS[tier]) tier = product === 'basalt' ? 'basalt-month' : 'month';

  const SLATE_TIERS = ['day', 'week', 'month', 'quarter', 'life'];
  const BASALT_TIERS = ['basalt-day', 'basalt-week', 'basalt-month', 'basalt-quarter', 'basalt-life'];

  const HINT = {
    day:     'one day, unlimited spoofs. good for a single session or a test.',
    week:    'the 30 day key works out to $1.00 a day.',
    month:   '90 days drops it to $0.67 a day, and permanent never expires.',
    quarter: 'permanent is $99.99 once and you stop paying attention to this page.',
    life:    'nothing to renew, ever.',
    'basalt-day':     'one day of basalt. good to try it out.',
    'basalt-week':    '30 days works out to $1.50 a day.',
    'basalt-month':   '90 days drops it to $1.00 a day, and permanent never expires.',
    'basalt-quarter': 'permanent is $149.99 once and you stop paying attention to this page.',
    'basalt-life':    'nothing to renew, ever.',
  };
  const hint = $('#tierHint');

  function rebuildTiers() {
    const list = product === 'basalt' ? BASALT_TIERS : SLATE_TIERS;
    tierToggle.innerHTML = list.map(k => {
      const t = TIERS[k];
      return `<button type="button" data-tier="${k}" aria-pressed="false">${t.label} &middot; $${t.price}</button>`;
    }).join('');
    if (!TIERS[tier] || TIERS[tier].product !== product) tier = list[2];
    $$('[data-tier]', tierToggle).forEach(b => b.addEventListener('click', () => { tier = b.dataset.tier; paint(); }));
  }

  function paint() {
    const t = TIERS[tier];
    if (hint) hint.textContent = HINT[tier] || '';
    $$('[data-tier]', form).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tier === tier)));
    $$('[data-product]', form).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.product === product)));
    const feat = product === 'basalt'
      ? '1 machine · ESP, aimbot, movement · all updates · instant email'
      : '1 machine · unlimited spoofs · all updates · instant email';
    feats.textContent = feat;
    submit.textContent = `pay $${t.price} ->`;
  }

  $$('[data-product]', form).forEach(b => b.addEventListener('click', () => {
    product = b.dataset.product;
    rebuildTiers();
    paint();
  }));
  rebuildTiers();
  paint();

  /* payment methods: ask the backend which processors are live. on a static
     preview this 404s and the page keeps its demo copy. */
  const methods = $('#payMethods');
  let provider = null;
  fetch('/.netlify/functions/checkout')
    .then(r => r.json())
    .then(j => {
      if (!j || !j.live || !j.live.length) return;
      $$('.demo-note').forEach(n => n.remove());
      if (methods && j.methods && j.methods.length) {
        methods.innerHTML = j.methods.map(m => `<span class="badge">${esc(m)}</span>`).join('');
        methods.hidden = false;
      }
      provider = j.live[0];
    })
    .catch(() => {});

  function inboxFor(acct, email, local) {
    const exp = expiresAt(acct);
    const prod = (TIERS[acct.tier] && TIERS[acct.tier].product) || 'slate';
    const prodName = prod === 'basalt' ? 'basalt' : 'slate';
    inbox.innerHTML =
`<span class="d">from</span>     slate
<span class="d">to</span>       ${esc(email)}
<span class="d">subject</span>  your ${prodName} key

<span class="d">key</span>      ${acct.key}
<span class="d">tier</span>     ${TIERS[acct.tier].label}
<span class="d">expires</span>  ${exp ? fmtDate(exp) : 'never'}
<span class="d">resets</span>   ${resetsText(acct.resets)}

<span class="d">paste this into ${prodName} on the pc:</span>
  ${acct.key}

<span class="d">manage the key:</span>
  sign in at <a href="login.html?email=${encodeURIComponent(email)}">slate — my key</a> with this email and key.${local ? '\n\n<span class="d">// demo inbox. on a live deploy this email is sent by the checkout function and the key is never rendered here.</span>' : ''}`;
    $('#inboxBar').textContent = 'inbox · 1 new';
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#buyEmail').value.trim().toLowerCase();
    const discord = ($('#buyDiscord') || {}).value?.trim() || '';
    status.textContent = '';
    if (!isEmail(email)) { say(status, 'error: that email looks incomplete. the key goes there, so check it.'); return; }
    submit.disabled = true;

    // live path: Stripe session, or an issued key, both handled server side
    const payload = { tier, email, provider };
    if (discord) payload.discord = discord;
    const res = await post('checkout', payload);
    if (!res.offline) {
      submit.disabled = false;
      if (!res.ok) { say(status, humanError(res.error)); return; }
      if (res.url) { say(status, 'redirecting to payment...'); location.href = res.url; return; }
      if (res.key) { inboxFor(res.key, email, false); }
      say(status, `key sent to ${esc(email)}. <span class="d">account ready, sign in with the email and key.</span>`);
      return;
    }

    // demo path: no functions deployed, keep everything in this browser
    const prev = findAccount(email);
    // [real] POST /checkout -> payment provider -> webhook issues the key
    await steps(status, ['creating order', 'confirming payment', prev ? 'reusing your key' : 'generating key', 'emailing key', prev ? 'updating account' : 'creating account']);
    const t = TIERS[tier];
    const acct = prev
      ? { ...prev, tier, started: Date.now(), resets: t.resets === Infinity ? null : Math.max(t.resets, prev.resets ?? 0) }
      : { email, key: newKey(), tier, started: Date.now(), resets: t.resets === Infinity ? null : t.resets, machine: null, created: Date.now() };
    saveAccount(acct);
    say(status, `key sent to ${esc(email)}. <span class="d">account ready, sign in with the email and key.</span>`);
    submit.disabled = false;
    inboxFor(acct, email, true);
  });
})();

/* ============ KEYS (sign in + account) ============ */
(function keys() {
  const form = $('#keyForm'); if (!form) return;
  const status = $('#keyStatus'), submit = $('#keySubmit'), emailIn = $('#keyEmail'), keyIn = $('#keyIn');
  const keyRow = $('#keyRow'), authbox = $('#authbox'), acctBox = $('#acct'), head = $('#keysHead'), sub = $('#keysSub');
  const L = window.B3D && window.B3D.lock;
  const refresh = () => { if (reduce && L) L.settle(); };
  const pre = new URLSearchParams(location.search).get('email'); if (pre) emailIn.value = pre;

  // padlock: the key slides in as the license key is typed
  function sync() {
    if (!L || L.st.open) return;
    const on = form.contains(document.activeElement) || keyIn.value.length > 0;
    L.st.focus = on; L.st.keyOn = on;
    L.st.key = Math.min(1, keyIn.value.replace(/-/g, '').length / 19);
    refresh();
  }
  form.addEventListener('focusin', sync);
  form.addEventListener('focusout', () => setTimeout(sync, 0));
  keyIn.addEventListener('input', sync);
  keyIn.addEventListener('blur', () => { if (keyIn.value.replace(/[^a-z0-9]/gi, '').length >= 19) keyIn.value = normKey(keyIn.value); });
  const shake = () => { if (L) { L.st.jig = 1; L.st.focus = true; refresh(); } };
  function openLock() {
    if (!L) return;
    L.st.turnGoal = Math.PI / 2; L.st.open = true;
    setTimeout(() => { L.st.focus = false; L.st.vy = 0.3; }, fast() ? 0 : 900);
    refresh();
  }
  function closeLock() { if (L) { Object.assign(L.st, { open: false, turnGoal: 0, jig: 0, key: 0, keyOn: false, focus: false }); refresh(); } }

  let mode = 'signin';
  $$('#authbox .tabs button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    $$('#authbox .tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    keyRow.hidden = mode !== 'signin';
    submit.textContent = mode === 'signin' ? 'sign in' : 'resend key';
    status.textContent = '';
  }));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = emailIn.value.trim().toLowerCase();
    status.textContent = '';
    if (!isEmail(email)) { say(status, 'error: that email looks incomplete. use the one from checkout.'); shake(); return; }
    submit.disabled = true;

    if (mode === 'resend') {
      // [real] POST /resend; always the same answer so emails can't be probed
      const res = await post('resend', { email });
      if (res.offline) await steps(status, ['looking up orders', 'queueing email']);
      say(status, 'if an order exists for that email, the key is on its way.');
      submit.disabled = false; return;
    }

    const key = normKey(keyIn.value); keyIn.value = key;
    if (!/^SLT(-\w{4}){4}$/.test(key)) { say(status, 'error: keys look like SLT-XXXX-XXXX-XXXX-XXXX.'); shake(); submit.disabled = false; return; }

    const res = await post('signin', { email, key });
    if (!res.offline) {
      if (!res.ok) { say(status, humanError(res.error)); shake(); submit.disabled = false; return; }
      await steps(status, ['resolving account', 'checking key', 'opening session']);
      session = { email, key, remote: true, account: res.account };
      openLock();
      await sleep(fast() ? 0 : 500);
      submit.disabled = false;
      showAccount();
      return;
    }

    // demo path
    await steps(status, ['resolving account', 'checking key']);
    const acct = findAccount(email);
    if (!acct || acct.key !== key) {
      say(status, 'error: no key matches that email. check the order email or use resend key.');
      shake(); submit.disabled = false; return;
    }
    await steps(status, ['opening session']);
    session = { email, key, remote: false };
    db.set('session', email);
    openLock();
    await sleep(fast() ? 0 : 700);
    submit.disabled = false;
    showAccount();
  });

  /* ---------- account view ---------- */
  let reveal = false;
  let session = null;

  function current() {
    if (!session) return null;
    if (session.remote) return session.account;
    const email = db.get('session'); return email && findAccount(email);
  }

  function render() {
    const a = current();
    if (!a) return signOut();
    const t = TIERS[a.tier], exp = expiresAt(a), dead = isExpired(a);
    const left = exp ? Math.max(0, Math.ceil((exp - Date.now()) / DAY)) : null;
    const canReset = a.machine && !dead && (a.resets === null || a.resets === undefined || a.resets > 0);
    $('#acctBar').textContent = a.email;
    $('#acctBody').innerHTML = `
<dl class="kv">
  <dt>key</dt><dd><code id="acctKey">${reveal ? a.key : maskKey(a.key)}</code> <button class="copy" data-act="reveal">${reveal ? 'hide' : 'show'}</button><button class="copy" data-act="copy">copy</button></dd>
  <dt>tier</dt><dd>${t.label}</dd>
  <dt>status</dt><dd>${dead ? 'expired <span class="d">// the app stops working, your pc keeps its identity</span>' : 'active'}</dd>
  <dt>expires</dt><dd>${exp ? `${fmtDate(exp)} <span class="d">// ${left}d left</span>` : 'never'}</dd>
  <dt>machine</dt><dd>${a.machine ? `${esc(a.machine.name)} <span class="d">// id ${esc(a.machine.hwid)} · bound ${fmtDate(a.machine.at)}</span>` : '<span class="d">not bound yet. open slate on the pc and paste your key.</span>'}</dd>
  <dt>resets</dt><dd>${resetsText(a.resets)}${a.resets === 0 ? ' <span class="d">// upgrade for resets</span>' : ''}</dd>
  <dt>since</dt><dd>${fmtDate(a.created)}</dd>
</dl>
<div class="acct-actions">
  ${dead ? `<a class="btn" href="checkout.html?tier=${a.tier}">re-buy ${t.label} -&gt;</a>` : ''}
  ${a.machine ? `<button class="btn${dead ? ' ghost' : ''}" data-act="reset" ${canReset ? '' : 'disabled'}>move to another pc</button>` : `<button class="btn" data-act="bind">simulate activation</button>`}
  <button class="btn ghost" data-act="resend">resend key</button>
  <button class="btn ghost" data-act="out">sign out</button>
</div>
<div class="status" id="acctStatus" role="status" aria-live="polite"></div>`;
  }
  function showAccount() {
    authbox.hidden = true; acctBox.hidden = false;
    head.innerHTML = '<span class="p">$</span> my key';
    sub.textContent = 'Your key, the machine it is bound to, and the resets you have left.';
    render();
  }
  function signOut() {
    session = null; reveal = false;
    db.del('session');
    acctBox.hidden = true; authbox.hidden = false;
    head.innerHTML = '<span class="p">$</span> my key';
    sub.textContent = 'Sign in with the email you bought with and the key from your order. No password — those two things are your account.';
    keyIn.value = ''; status.textContent = ''; closeLock();
  }
  acctBox.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const a = current(); if (!a) return signOut();
    const out = $('#acctStatus');
    switch (b.dataset.act) {
      case 'reveal': reveal = !reveal; render(); break;
      case 'copy':
        navigator.clipboard && navigator.clipboard.writeText(a.key).catch(() => {});
        b.textContent = 'copied'; setTimeout(() => { b.textContent = 'copy'; }, 1400); break;
      case 'bind': {
        // [real] happens in the CLI; the site only reads it
        b.disabled = true; out.textContent = '';
        await steps(out, ['opening slate', 'reading this pc', 'binding key']);
        const machine = { name: 'DESKTOP-' + rand(6), hwid: rand(8, '0123456789abcdef'), at: Date.now() };
        if (session.remote) {
          const r = await post('account', { email: a.email, key: a.key, action: 'bind', machine });
          if (r.offline || !r.ok) { say(out, humanError(r.error)); b.disabled = false; return; }
          session.account = r.account;
        } else {
          a.machine = machine; saveAccount(a);
        }
        render(); say($('#acctStatus'), 'key bound to this machine.'); break;
      }
      case 'reset': {
        if (!confirm('move this key to another PC? it unbinds from this one and activates on the next PC you open slate on.')) return;
        b.disabled = true; out.textContent = '';
        await steps(out, ['unbinding this pc', 'freeing the key']);
        if (session.remote) {
          const r = await post('account', { email: a.email, key: a.key, action: 'reset' });
          if (r.offline || !r.ok) { say(out, humanError(r.error)); b.disabled = false; return; }
          session.account = r.account;
        } else {
          a.machine = null; if (a.resets !== null && a.resets !== undefined) a.resets--;
          saveAccount(a);
        }
        render(); say($('#acctStatus'), `reset spent. ${resetsText(current() && current().resets)} left.`); break;
      }
      case 'resend': {
        b.disabled = true; out.textContent = '';
        const r = await post('resend', { email: a.email });
        if (r.offline) await steps(out, ['queueing email']);
        say(out, `key re-sent to ${esc(a.email)}.`); b.disabled = false; break;
      }
      case 'out': signOut(); break;
    }
  });

  // resume a demo session on reload
  if (db.get('session') && findAccount(db.get('session'))) {
    session = { email: db.get('session'), key: findAccount(db.get('session')).key, remote: false };
    openLock(); showAccount();
  }
})();

/* ============ SUPPORT TICKET ============ */
(function tickets() {
  const form = $('#ticketForm'); if (!form) return;
  const status = $('#ticketStatus'), submit = $('#ticketSubmit'), bar = $('#ticketBar');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.textContent = '';
    const email = $('#tEmail').value.trim().toLowerCase();
    const key = $('#tKey').value.trim();
    const subject = $('#tSubject').value.trim();
    const body = $('#tBody').value.trim();

    if (!isEmail(email)) { say(status, 'error: that email looks incomplete. replies go there.'); return; }
    if (subject.length < 3) { say(status, 'error: give the ticket a subject.'); return; }
    if (body.length < 10) { say(status, 'error: a few more words about what happened.'); return; }

    submit.disabled = true;
    const res = await post('ticket', { email, key, subject, body });
    submit.disabled = false;

    if (res.offline) {
      say(status, `no ticket system on this copy. <span class="d">on the live site this opens a ticket and the reply goes to ${esc(email)}.</span>`);
      return;
    }
    if (!res.ok) { say(status, humanError(res.error)); return; }

    form.reset();
    bar.textContent = 'sent';
    say(status, `ticket <b>${esc(res.id)}</b> opened. reply goes to ${esc(email)}.`);
  });
})();
})();
