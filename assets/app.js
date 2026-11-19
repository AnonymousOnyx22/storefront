(() => {
'use strict';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
};
try { if (localStorage.getItem('slate:invert') === '1') document.documentElement.classList.add('inverted'); } catch (e) {}
function toggleInvert() {
  const on = document.documentElement.classList.toggle('inverted');
  try { localStorage.setItem('slate:invert', on ? '1' : '0'); } catch (e) {}
  return on;
}

/* ============ stop / play animations ============ */
const still = () => document.documentElement.classList.contains('still');
function paintMotion() {
  $$('[data-motion]').forEach(b => {
    const s = still();
    b.setAttribute('aria-pressed', String(s));
    b.innerHTML = s ? '▶ <span class="lbl">play animations</span>' : '■ <span class="lbl">stop animations</span>';
    b.setAttribute('aria-label', s ? 'Play animations' : 'Stop animations');
  });
}
function setStill(on) {
  document.documentElement.classList.toggle('still', on);
  try { localStorage.setItem('slate:still', on ? '1' : '0'); } catch (e) {}
  paintMotion();
}
$$('[data-motion]').forEach(b => b.addEventListener('click', () => setStill(!still())));
paintMotion();

/* ============ scramble ============ */
const GLYPHS = '!<>/\\[]{}=+*^?#%@&$';
function scramble(el, dur = 600, set = GLYPHS) {
  if (reduce || still() || el._busy) return;
  const final = el._final || (el._final = el.textContent);
  el._busy = true;
  let start = performance.now(), prev = start;
  (function tick(n) {
    if (still()) { start += n - prev; prev = n; requestAnimationFrame(tick); return; }
    prev = n;
    const p = Math.min(1, (n - start) / dur);
    const cut = Math.floor(final.length * p);
    let s = '';
    for (let i = 0; i < final.length; i++) {
      const ch = final[i];
      s += (i < cut || ch === ' ' || ch === '\n') ? ch : set[(Math.random() * set.length) | 0];
    }
    el.textContent = s;
    if (p < 1) requestAnimationFrame(tick); else el._busy = false;
  })(start);
}

/* ============ ascii field background ============ */
(function field() {
  const cv = $('#field'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const RAMP = ' .,:;+*%#@';
  const LV = [0, 38, 46, 56, 68, 82, 98, 118, 140, 165];
  const GREYS = LV.map(v => `rgb(${v},${v},${v})`);
  const CW = 10, CH = 18;
  let W, H, cols, rows;
  const mouse = { x: -999, y: -999, tx: -999, ty: -999 };
  const ripples = [];
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '13px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'top';
    cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
  }
  let clock = 0, prev = 0, dirty = true;
  size(); addEventListener('resize', () => { size(); dirty = true; });
  document.fonts && document.fonts.ready.then(() => { size(); dirty = true; });
  addEventListener('pointermove', e => {
    if (still()) return;
    mouse.tx = e.clientX; mouse.ty = e.clientY;
    if (mouse.x < -900) { mouse.x = e.clientX; mouse.y = e.clientY; }
  });
  addEventListener('pointerdown', e => { if (!reduce && !still()) ripples.push({ x: e.clientX, y: e.clientY, t: clock }); });
  document.documentElement.addEventListener('pointerleave', () => { if (!still()) { mouse.tx = -999; mouse.ty = -999; } });
  let last = 0;
  function draw(real) {
    requestAnimationFrame(draw);
    if (real - last < 33) return;
    const S = still();
    const dt = Math.min(100, real - (prev || real)); prev = real; last = real;
    if (S && !dirty) return;
    if (!S) clock += dt;
    dirty = false;
    const now = clock;
    const t = reduce ? 0 : now;
    if (!S) { mouse.x += (mouse.tx - mouse.x) * 0.35; mouse.y += (mouse.ty - mouse.y) * 0.35; }
    ctx.clearRect(0, 0, W, H);
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].t > 2200) ripples.splice(i, 1);
    const buckets = GREYS.map(() => []);
    for (let r = 0; r < rows; r++) {
      const y = r * CH + CH / 2;
      for (let c = 0; c < cols; c++) {
        const x = c * CW + CW / 2;
        let v = (Math.sin(c * 0.09 + t * 0.0004) + Math.sin(r * 0.17 - t * 0.0003) + Math.sin((c + r) * 0.05 + t * 0.00025)) / 6 + 0.5;
        v = Math.max(0, v - 0.55) * 0.9;
        const dx = x - mouse.x, dy = y - mouse.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 220) { const m = 1 - d / 220; v += m * m * 0.95; }
        for (const rp of ripples) {
          const age = now - rp.t, rad = age * 0.45;
          const k = (Math.hypot(x - rp.x, y - rp.y) - rad) / 26;
          v += Math.exp(-k * k) * (1 - age / 2200) * 0.8;
        }
        const idx = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
        if (idx > 0) buckets[idx].push(c * CW, r * CH);
      }
    }
    for (let i = 1; i < buckets.length; i++) {
      const b = buckets[i]; if (!b.length) continue;
      ctx.fillStyle = GREYS[i]; const ch = RAMP[i];
      for (let j = 0; j < b.length; j += 2) ctx.fillText(ch, b[j], b[j + 1]);
    }
  }
  requestAnimationFrame(draw);
})();

/* ============ page transitions ============ */
const PAGES = {
  'index.html': '~/', 'guide.html': '~/install', 'help.html': '~/help', 'pricing.html': '~/pricing',
  'changelog.html': '~/updates', 'login.html': '~/my-key', 'checkout.html': '~/checkout',
  'privacy.html': '~/privacy', 'terms.html': '~/terms', '404.html': '~/lost',
  'games.html': '~/games', 'status.html': '~/status', 'reviews.html': '~/reviews',
};
const veil = document.createElement('div');
veil.className = 'veil'; veil.setAttribute('aria-hidden', 'true');
document.body.appendChild(veil);
const pageName = href => {
  const file = (new URL(href, location.href).pathname.split('/').pop() || 'index.html');
  return PAGES[file] || '~/' + file.replace('.html', '');
};
if (store.get('slate:nav') && !reduce && !still()) {
  store.del('slate:nav');
  veil.innerHTML = `<span><span class="d">$</span> cd ${pageName(location.href)} <span class="d">ok</span></span>`;
  veil.classList.add('enter');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    veil.classList.add('leave');
    veil.addEventListener('transitionend', () => veil.classList.remove('enter', 'leave'), { once: true });
  }));
}
addEventListener('pageshow', e => { if (e.persisted) veil.classList.remove('cover', 'enter', 'leave'); });

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
async function navigate(href) {
  const url = new URL(href, location.href);
  if (url.pathname === location.pathname && url.hash) { location.hash = url.hash; return; }
  if (reduce || still()) { location.href = href; return; }
  const target = `cd ${pageName(href)}`;
  veil.innerHTML = '<span><span class="d">$</span> <span class="vt"></span> <span class="vs d"></span></span>';
  veil.classList.add('cover');
  const vt = $('.vt', veil), vs = $('.vs', veil);
  let i = 0;
  const iv = setInterval(() => { vs.textContent = SPIN[i++ % SPIN.length]; }, 60);
  for (const ch of target) { vt.textContent += ch; await sleep(16); }
  await sleep(140);
  clearInterval(iv);
  store.set('slate:nav', '1');
  location.href = href;
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target === '_blank' || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || /^(mailto|tel|https?):/i.test(href)) return;
  e.preventDefault();
  closeMenu();
  navigate(href);
});

/* ============ nav ============ */
const navWrap = $('.nav-wrap');
let lastY = scrollY;
function navScroll() {
  if (!navWrap) return;
  const y = scrollY;
  navWrap.classList.toggle('scrolled', y > 8);
  if (!reduce && !$('.mmenu.open')) navWrap.classList.toggle('hide', y > lastY && y > 240);
  lastY = y;
}
if (fine) $$('.links a, .side a').forEach(a => a.addEventListener('mouseenter', () => scramble(a, 320)));

const mmenu = $('.mmenu'), menuBtn = $('.menu-btn');
function openMenu() {
  if (!mmenu) return;
  mmenu.classList.add('open'); menuBtn.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  $('a', mmenu).focus({ preventScroll: true });
}
function closeMenu() {
  if (!mmenu || !mmenu.classList.contains('open')) return;
  mmenu.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}
menuBtn && menuBtn.addEventListener('click', openMenu);
mmenu && $('.close', mmenu).addEventListener('click', () => { closeMenu(); menuBtn.focus(); });

/* ============ command palette (instant toggle, zero animation on kbd) ============ */
const PAL_ITEMS = [
  { k: 'home', d: 'back to the start', go: 'index.html' },
  { k: 'products', d: 'everything we ship', go: 'products.html' },
  { k: 'basalt', d: 'rust external with esp and aimbot', go: 'basalt.html' },
  { k: 'demo', d: 'try the app at the top of the page', go: 'index.html#demo' },
  { k: 'what it does', d: 'everything it changes', go: 'index.html#what' },
  { k: 'games', d: 'supported games and anti-cheats', go: 'games.html' },
  { k: 'install', d: 'step by step setup guide', go: 'guide.html' },
  { k: 'help', d: 'activation, resets, refunds', go: 'help.html' },
  { k: 'pricing', d: 'tiers and what you get', go: 'pricing.html' },
  { k: 'buy', d: 'get a key by email', go: 'checkout.html' },
  { k: 'my key', d: 'sign in with your email and key', go: 'login.html' },
  { k: 'status', d: 'detection status and uptime', go: 'status.html' },
  { k: 'reviews', d: 'what buyers are saying', go: 'reviews.html' },
  { k: 'updates', d: 'what changed in each version', go: 'changelog.html' },
  { k: 'privacy', d: 'what we store and why', go: 'privacy.html' },
  { k: 'terms', d: 'the agreement, in plain words', go: 'terms.html' },
  { k: 'motion', d: 'stop or play animations', fn: () => setStill(!still()) },
  { k: 'invert', d: 'flip black and white', fn: toggleInvert },
  { k: 'top', d: 'scroll to the top', fn: () => scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }) },
];
const pal = document.createElement('div');
pal.className = 'pal';
pal.innerHTML = `<div class="pal-box" role="dialog" aria-modal="true" aria-label="Command palette">
  <div class="pal-in"><span class="d">$</span><input aria-label="Type a command" placeholder="type a page or command" autocomplete="off" spellcheck="false"></div>
  <ul role="listbox"></ul>
  <div class="pal-foot">up and down to move, enter to run, esc to close</div></div>`;
document.body.appendChild(pal);
const palIn = $('input', pal), palList = $('ul', pal);
let palSel = 0, palShown = [], palReturn = null;
function palRender() {
  const q = palIn.value.trim().toLowerCase().replace(/^cd\s+~?\/?/, '');
  palShown = PAL_ITEMS.filter(it => !q || it.k.includes(q) || it.d.includes(q));
  palSel = clamp(palSel, 0, Math.max(0, palShown.length - 1));
  palList.innerHTML = palShown.length
    ? palShown.map((it, i) => `<li role="option" aria-selected="${i === palSel}" class="${i === palSel ? 'sel' : ''}" data-i="${i}"><span>${it.k}</span><span class="d">${it.d}</span></li>`).join('')
    : `<li><span>command not found</span><span class="d">try install, my key, or pricing</span></li>`;
}
function palOpen() {
  palReturn = document.activeElement;
  pal.classList.add('open'); palIn.value = ''; palSel = 0; palRender();
  setTimeout(() => palIn.focus(), 10);
}
function palClose() { pal.classList.remove('open'); palReturn && palReturn.focus && palReturn.focus({ preventScroll: true }); }
function palRun(it) {
  if (!it) return;
  pal.classList.remove('open');
  if (it.go) navigate(it.go); else it.fn();
}
palIn.addEventListener('input', () => { palSel = 0; palRender(); });
palIn.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { palSel++; palRender(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palSel--; palRender(); e.preventDefault(); }
  else if (e.key === 'Enter') palRun(palShown[palSel]);
  else if (e.key === 'Escape') palClose();
});
palList.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); li && palRun(palShown[+li.dataset.i]); });
pal.addEventListener('click', e => { if (e.target === pal) palClose(); });
$$('[data-pal]').forEach(b => b.addEventListener('click', palOpen));
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); pal.classList.contains('open') ? palClose() : palOpen(); }
  else if (e.key === 'Escape') { if (pal.classList.contains('open')) palClose(); else closeMenu(); }
});

/* ============ keyboard hint (once) ============ */
try {
  if (!localStorage.getItem('slate:pal-seen')) {
    const hint = document.createElement('div');
    hint.className = 'pal-hint';
    hint.innerHTML = 'press <kbd>/</kbd> to jump anywhere';
    document.body.appendChild(hint);
    requestAnimationFrame(() => hint.classList.add('in'));
    const dismiss = () => { hint.classList.remove('in'); try { localStorage.setItem('slate:pal-seen', '1'); } catch(e) {} setTimeout(() => hint.remove(), 400); };
    hint.addEventListener('click', dismiss);
    setTimeout(dismiss, 6000);
  }
} catch(e) {}

/* ============ reveals ============ */
const io = new IntersectionObserver(entries => {
  let stagger = 0;
  entries.forEach(e => {
    const el = e.target;
    if (e.isIntersecting && e.intersectionRatio >= 0.12) {
      if (el.classList.contains('in') || el._pending) return;
      el._pending = setTimeout(() => {
        el._pending = null;
        el.classList.add('in');
        if (el.hasAttribute('data-scramble')) scramble(el, 500);
      }, stagger++ * 55);
    } else if (!e.isIntersecting) {
      clearTimeout(el._pending); el._pending = null;
      el.classList.remove('in');
    }
  });
}, { threshold: [0, 0.12], rootMargin: '0px 0px -6% 0px' });
$$('[data-reveal],[data-type],[data-rise]').forEach(el => io.observe(el));
$$('[data-load-scramble]').forEach(el => scramble(el, +el.dataset.loadScramble || 900, '░▒▓█╔╗╚╝═║'));

/* ============ scroll driven bits ============ */
const prog = $('#progress');
const commits = $$('.commit');
let ticking = false;
function onScroll() {
  ticking = false;
  navScroll();
  const sh = document.documentElement.scrollHeight - innerHeight;
  const sp = sh > 0 ? clamp(scrollY / sh, 0, 1) : 0;
  if (prog) {
    const n = 20, f = Math.round(sp * n);
    prog.textContent = `[${'#'.repeat(f)}${'·'.repeat(n - f)}] ${String(Math.round(sp * 100)).padStart(3)}%`;
  }
  if (reduce) return;
  commits.forEach(c => {
    const r = c.getBoundingClientRect();
    const g = clamp((innerHeight * 0.75 - r.top) / r.height, 0, 1);
    c.style.setProperty('--grow', g.toFixed(3));
  });
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener('resize', onScroll);
onScroll();

/* ============ HOME: logo reacts to cursor ============ */
(function logoHover() {
  const logo = $('#logo'); if (!logo || reduce || !fine) return;
  let grid = null;
  function build() {
    const lines = (logo._final || logo.textContent).split('\n');
    logo.textContent = '';
    grid = lines.map((line, r) => {
      const row = [...line].map(ch => { const s = document.createElement('span'); s.textContent = ch; s._o = ch; return s; });
      row.forEach(s => logo.appendChild(s));
      if (r < lines.length - 1) logo.appendChild(document.createTextNode('\n'));
      return row;
    });
  }
  const SH = ['▓', '▒', '░', '·'];
  let dirty = [];
  setTimeout(build, 1200);
  logo.addEventListener('pointermove', e => {
    if (!grid || !grid[0] || !grid[0][1]) return;
    const a = grid[0][0].getBoundingClientRect(), b = grid[0][1].getBoundingClientRect();
    const cw = b.left - a.left || a.width;
    const rh = grid[1][0].getBoundingClientRect().top - a.top || a.height;
    const mc = (e.clientX - a.left) / cw - 0.5, mr = (e.clientY - a.top) / rh - 0.5;
    dirty.forEach(s => s.textContent = s._o); dirty = [];
    for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
      const d = Math.hypot((c - mc) * 0.5, r - mr);
      if (d < 2.4 && grid[r][c]._o !== ' ') {
        const s = grid[r][c]; s.textContent = SH[Math.min(3, Math.floor(d))]; dirty.push(s);
      }
    }
  });
  logo.addEventListener('pointerleave', () => { dirty.forEach(s => s.textContent = s._o); dirty = []; });
})();

/* ============ HOME: ticker ============ */
(function ticker() {
  const el = $('#idCount'); if (!el) return;
  // seed from the number in the markup so the page never jumps to a different figure
  let n = parseInt(el.textContent.replace(/\D/g, ''), 10) || 1478;
  const fmt = v => v.toLocaleString('en-US');
  el.textContent = fmt(n);
  if (reduce) return;
  // a cumulative total creeps. one every minute and a half, not four a second.
  setInterval(() => { if (still()) return; n += 1; el.textContent = fmt(n); }, 92_000);
})();

/* ============ HOME: interactive app demo ============ */
(function cliHudDemo() {
  const root = $('#cliHud'); if (!root) return;

  const PROFILES = [
    { name: 'GHOST-01', maker: 'ASUS ROG',      disk: 'Samsung 990 PRO 2TB',   net: 'Intel Ethernet',     region: 'United States' },
    { name: 'GHOST-02', maker: 'MSI MEG',       disk: 'WD Black SN850X 2TB',   net: 'Realtek 2.5G',       region: 'Germany' },
    { name: 'GHOST-03', maker: 'Gigabyte AORUS', disk: 'Seagate FireCuda 530', net: 'Qualcomm Wi-Fi 6E',  region: 'Netherlands' },
  ];

  let pIdx = 0;
  let spoofed = true;
  let activeIdx = 0;
  let view = 'menu'; // 'menu' | 'spoof' | 'applied' | 'clean' | 'status' | 'help'

  const MENU_ITEMS = [
    { num: '1', label: 'SPOOF MY PC',      desc: 'apply a fresh hardware identity',        go: 'spoof' },
    { num: '2', label: 'RESTORE ORIGINAL', desc: 'put your real ids back',                go: 'clean' },
    { num: '3', label: 'CHECK STATUS',     desc: 'see what has changed',                  go: 'status' },
    { num: '4', label: 'HELP & SETUP',     desc: 'guides, activation and support',        go: 'help' },
  ];

  const LOGO_ASCII =
`█████  █       ███   █████  █████
█      █      █   █    █    █    
█████  █      █████    █    ███  
    █  █      █   █    █    █    
█████  █████  █   █    █    █████`;

  const PILLS = ['SYSTEM', 'DISK', 'NETWORK', 'BOOT', 'FILES'];

  function pillsHtml() {
    return PILLS.map((n, i) => {
      const ok = spoofed || i === 0;
      return `<span class="hud-pill ${ok ? 'ok' : ''}">[${ok ? '+' : 'x'} ${n}]</span>`;
    }).join('');
  }

  function render() {
    const p = PROFILES[pIdx];
    const matched = spoofed ? 12 : 0;
    const bannerClass = spoofed ? 'spoofed' : 'unspoofed';
    const bannerTxt = spoofed
      ? `[+] PROTECTED — ${matched}/12 identifiers changed`
      : `[!] NOT SPOOFED — 0/12 identifiers changed`;

    let bodyHtml = '';
    if (view === 'menu') {
      bodyHtml = `
        <pre class="hud-ascii-logo" aria-hidden="true">${LOGO_ASCII}</pre>
        <div class="hud-banner ${bannerClass}">${bannerTxt}</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-menu" role="menu" aria-label="Actions">
          ${MENU_ITEMS.map((it, i) => `
            <button type="button" class="hud-btn ${i === activeIdx ? 'active' : ''}" data-idx="${i}" data-go="${it.go}">
              <span class="num">[${it.num}]</span>
              <span class="lbl">${it.label}</span>
              <span class="dsc">${it.desc}</span>
              <span class="arr">${i === activeIdx ? '&lt;&lt;' : '▸'}</span>
            </button>
          `).join('')}
        </div>
      `;
    } else if (view === 'spoof') {
      bodyHtml = `
        <div class="hud-banner ${bannerClass}">IDENTITY READY — ${p.name}</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-subpage">
          <div class="hud-box">
            <div class="hud-box-title">// the machine you will present</div>
            <pre><b>NAME      </b> ${p.name}
<b>DEVICE    </b> ${p.maker}
<b>DISK      </b> ${p.disk}
<b>NETWORK   </b> ${p.net}
<b>REGION    </b> ${p.region}</pre>
          </div>
          <div class="hud-box">
            <div class="hud-box-title">// applying it changes</div>
            <pre><b>[+] system</b>   name, serial and machine id
<b>[+] disk</b>     drive serial and volume id
<b>[+] network</b>  hardware address
<b>[+] boot</b>     boot signature
<b>[+] files</b>    old setup traces cleared

Board, disk and network are generated together,
so they read as one real machine.</pre>
          </div>
          <div class="hud-sub-actions">
            <button type="button" class="primary" data-sub="apply">[1] &gt;&gt; APPLY THIS IDENTITY &lt;&lt;</button>
            <button type="button" data-sub="reroll">[2] &lt;&lt; GENERATE A DIFFERENT ONE</button>
            <button type="button" data-sub="menu">[3] &lt;&lt; BACK TO MENU</button>
          </div>
        </div>
      `;
    } else if (view === 'applied') {
      bodyHtml = `
        <div class="hud-banner spoofed">SPOOFED — ${p.name}</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-subpage">
          <div class="hud-box">
            <div class="hud-box-title">// what changed</div>
            <pre><b>[+] system</b>      new name, serial and machine id
<b>[+] disk</b>        new drive serial and volume id
<b>[+] network</b>     new hardware address
<b>[+] boot</b>        new boot signature
<b>[+] files</b>       old setup traces cleared
<b>[+] profile</b>     ${p.maker} / ${p.disk}</pre>
          </div>
          <div class="hud-box">
            <div class="hud-box-title">// next step</div>
            <pre><b>RESTART YOUR PC</b>

Everything is saved. One restart locks the new
identity in and clears the last of the old one.

Takes about a minute. Nothing else to do.</pre>
          </div>
          <div class="hud-sub-actions">
            <button type="button" class="primary" data-sub="status">[1] &gt;&gt; CHECK STATUS &lt;&lt;</button>
            <button type="button" data-sub="menu">[2] &lt;&lt; BACK TO MENU</button>
          </div>
        </div>
      `;
    } else if (view === 'clean') {
      bodyHtml = `
        <div class="hud-banner unspoofed">RESTORE ORIGINAL</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-subpage">
          <div class="hud-box">
            <div class="hud-box-title">// your real details are back</div>
            <pre><b>[+] system</b>      original restored
<b>[+] disk</b>        original restored
<b>[+] network</b>     original restored
<b>[+] boot</b>        original restored
<b>[+] files</b>       nothing left behind

<b>STATE: NOT SPOOFED</b></pre>
          </div>
          <div class="hud-box">
            <div class="hud-box-title">// note</div>
            <pre>Restoring uses the copy slate saved before your
first spoof. It works even months later.

You can spoof again at any time.</pre>
          </div>
          <div class="hud-sub-actions">
            <button type="button" class="primary" data-sub="spoof">[1] &gt;&gt; SPOOF AGAIN &lt;&lt;</button>
            <button type="button" data-sub="menu">[2] &lt;&lt; BACK TO MENU</button>
          </div>
        </div>
      `;
    } else if (view === 'status') {
      bodyHtml = `
        <div class="hud-banner ${bannerClass}">CHECK STATUS — ${p.name}</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-subpage">
          <div class="hud-box">
            <div class="hud-box-title">// summary</div>
            <pre><b>VERDICT   </b> ${spoofed ? 'PROTECTED — 12 of 12 changed' : 'NOT SPOOFED — 0 of 12 changed'}
<b>PROFILE   </b> ${p.name}
<b>APPLIED   </b> ${spoofed ? 'today, 2 minutes ago' : 'never'}
<b>RESTART   </b> ${spoofed ? 'done' : 'not needed'}</pre>
          </div>
          <div class="hud-box">
            <div class="hud-box-title">// identifiers</div>
            <pre><b>WHAT                    STATE</b>
system name and serial  ${spoofed ? '[OK]' : '[--]'}
disk serial             ${spoofed ? '[OK]' : '[--]'}
network address         ${spoofed ? '[OK]' : '[--]'}
boot signature          ${spoofed ? '[OK]' : '[--]'}
old setup traces        ${spoofed ? '[OK]' : '[--]'}</pre>
          </div>
          <div class="hud-sub-actions">
            <button type="button" class="primary" data-sub="spoof">[1] &gt;&gt; SPOOF AGAIN &lt;&lt;</button>
            <button type="button" data-sub="menu">[2] &lt;&lt; BACK TO MENU</button>
          </div>
        </div>
      `;
    } else if (view === 'help') {
      bodyHtml = `
        <div class="hud-banner ${bannerClass}">HELP &amp; SETUP</div>
        <div class="hud-pills">${pillsHtml()}</div>
        <div class="hud-subpage">
          <div class="hud-box">
            <div class="hud-box-title">// first time here</div>
            <pre>1. buy a key — it arrives by email
2. run the installer
3. paste your key once
4. press SPOOF MY PC
5. restart</pre>
          </div>
          <div class="hud-box">
            <div class="hud-box-title">// where to go</div>
            <pre><a href="guide.html">install guide</a>       step by step, with pictures
<a href="help.html">help &amp; faq</a>          activation, resets, refunds
<a href="login.html">my key</a>             your account and resets
<a href="pricing.html">pricing</a>            which tier fits</pre>
          </div>
          <div class="hud-sub-actions">
            <button type="button" class="primary" data-sub="menu">[1] &lt;&lt; BACK TO MENU</button>
          </div>
        </div>
      `;
    }

    root.innerHTML = `
      <div class="hud-chrome">
        <span><strong>slate</strong> · app window</span>
        <span>version 1.2.0 · windows</span>
      </div>
      <div class="hud-inner">
        ${bodyHtml}
        <div class="hud-foot">
          <span>PROFILE: <b>${p.name}</b></span>
          <span>LICENCE: <b>${spoofed ? 'ACTIVE' : 'ACTIVE'}</b></span>
          <span>MODE: <b>PERMANENT</b></span>
        </div>
        <div class="hud-hint">CLICK ANY ROW · PRESS 1 TO 4 · ESC TO GO BACK</div>
      </div>
    `;
  }

  function trigger(action) {
    if (action === 'spoof') {
      view = 'spoof';
    } else if (action === 'apply') {
      spoofed = true;
      view = 'applied';
    } else if (action === 'reroll') {
      pIdx = (pIdx + 1) % PROFILES.length;
      view = 'spoof';
    } else if (action === 'clean') {
      spoofed = false;
      view = 'clean';
    } else if (action === 'status') {
      view = 'status';
    } else if (action === 'help') {
      view = 'help';
    } else {
      view = 'menu';
    }
    render();
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('.hud-btn');
    if (b) {
      activeIdx = +b.dataset.idx;
      trigger(b.dataset.go);
      return;
    }
    const sub = e.target.closest('[data-sub]');
    if (sub) {
      trigger(sub.dataset.sub);
    }
  });

  root.addEventListener('pointermove', e => {
    const b = e.target.closest('.hud-btn');
    if (b && +b.dataset.idx !== activeIdx) {
      activeIdx = +b.dataset.idx;
      $$('.hud-btn', root).forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    }
  });

  let hudVisible = false;
  new IntersectionObserver(es => { hudVisible = es[0].isIntersecting; }).observe(root);
  document.addEventListener('keydown', e => {
    if (!hudVisible || pal.classList.contains('open')) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (view === 'menu' && /^[1-9]$/.test(e.key)) {
      const idx = +e.key - 1;
      if (idx >= MENU_ITEMS.length) return;
      e.preventDefault();
      activeIdx = idx;
      trigger(MENU_ITEMS[idx].go);
    } else if (view !== 'menu') {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        trigger('menu');
      } else if (/^[1-9]$/.test(e.key)) {
        const b = $$('[data-sub]', root)[+e.key - 1];
        if (!b) return;
        e.preventDefault();
        trigger(b.dataset.sub);
      }
    }
  });

  render();
})();

/* ============ DOCS: scroll spy ============ */
(function spy() {
  const sideLinks = $$('.side a'); if (!sideLinks.length) return;
  const map = new Map(sideLinks.map(a => [a.getAttribute('href').slice(1), a]));
  const spyIO = new IntersectionObserver(es => {
    es.forEach(e => {
      if (e.isIntersecting) {
        sideLinks.forEach(a => a.classList.remove('on'));
        const a = map.get(e.target.id); a && a.classList.add('on');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  $$('.doc [id]').forEach(s => spyIO.observe(s));
})();

/* ============ PRICING: calculator ============ */
(function calc() {
  const seats = $('#seats'); if (!seats) return;
  const out = $('#calcOut'), total = $('#total'), bar = $('#bar');
  let plan = 'month', yearly = false, shown = 0, raf;
  const PRICE = { day: 6.99, week: 14.99, month: 29.99, quarter: 59.99, life: 99.99 };
  const LABEL = { day: '1 day', week: '7 days', month: '30 days', quarter: '90 days', life: 'permanent' };
  $$('[data-plan]').forEach(b => b.addEventListener('click', () => {
    plan = b.dataset.plan; $$('[data-plan]').forEach(x => x.setAttribute('aria-pressed', x === b)); update();
  }));
  $$('[data-bill]').forEach(b => b.addEventListener('click', () => {
    yearly = b.dataset.bill === 'bulk'; $$('[data-bill]').forEach(x => x.setAttribute('aria-pressed', x === b)); update();
  }));
  seats.addEventListener('input', update);
  function update() {
    const n = +seats.value;
    const disc = (yearly || n >= 5) ? 0.8 : 1;
    const cost = n * PRICE[plan] * disc;
    const filled = Math.round(n / 25 * 25);
    bar.textContent = `[${'█'.repeat(filled)}${'░'.repeat(25 - filled)}] ${String(n).padStart(2)} ${n === 1 ? 'machine' : 'machines'}`;
    out.textContent =
`tier        ${LABEL[plan]}
machines    ${n}
discount    ${disc < 1 ? '20% volume applied' : 'standard single key'}
per key     $${(PRICE[plan] * disc).toFixed(2)}`;
    const target = cost;
    cancelAnimationFrame(raf);
    if (reduce) { shown = target; total.textContent = '$' + Math.round(shown); return; }
    const from = shown, t0 = performance.now();
    (function tick(now) {
      const p = clamp((now - t0) / 400, 0, 1), e = 1 - Math.pow(1 - p, 4);
      shown = from + (target - from) * e;
      total.textContent = '$' + Math.round(shown);
      if (p < 1) raf = requestAnimationFrame(tick);
    })(t0);
  }
  update();
})();

/* ============ top bar: live online count ============ */
(function online() {
  const el = $('#onlineCount'); if (!el) return;
  const fmt = v => v.toLocaleString('en-US');

  // the count comes from the discord server, proxied through /.netlify/functions/widget
  // so the browser never talks to discord directly. one pull a minute, and a
  // failed pull leaves the last real figure on screen rather than inventing one.
  let live = false;
  const pull = async () => {
    try {
      const r = await fetch('/.netlify/functions/widget', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (typeof j.online !== 'number') return;
      live = true;
      el.textContent = fmt(j.online);
    } catch (e) { /* offline, blocked, or local file: keep what is on screen */ }
  };

  pull();
  setInterval(pull, 60_000);

  // only drift when the real source has never answered, e.g. previewing the
  // html off disk. a counter that moves while real data exists is a lie.
  let n = parseInt(el.textContent.replace(/\D/g, ''), 10) || 24;
  setInterval(() => {
    if (live || still()) return;
    n = clamp(n + (Math.random() < .5 ? -1 : 1), 23, 26);
    el.textContent = fmt(n);
  }, 165_000);
})();

/* ============ PRODUCT: buy box tier switch ============ */
(function buybox() {
  const pick = $$('.tierpick a[data-t]'); if (!pick.length) return;
  const price = $('.bb-price'), sub = $('.bb-sub'), cta = $('.bb-actions .btn');
  const T = {
    day:     { p: '$6.99',  s: '1 day · 1 PC · unlimited spoofs' },
    week:    { p: '$14.99', s: '7 days · 1 PC · unlimited spoofs' },
    month:   { p: '$29.99', s: '30 days · 1 PC · unlimited spoofs' },
    quarter: { p: '$59.99', s: '90 days · 1 PC · unlimited spoofs' },
    life:    { p: '$99.99', s: 'permanent · 1 PC · unlimited spoofs' },
  };
  function set(t) {
    if (!T[t]) t = 'month';
    pick.forEach(a => a.classList.toggle('on', a.dataset.t === t));
    if (price) price.textContent = T[t].p;
    if (sub) sub.textContent = T[t].s;
    if (cta) cta.setAttribute('href', 'checkout.html?tier=' + t);
    try { history.replaceState(null, '', '?tier=' + t); } catch (e) {}
  }
  pick.forEach(a => a.addEventListener('click', e => { e.preventDefault(); set(a.dataset.t); }));
  set(new URLSearchParams(location.search).get('tier') || 'month');
})();

/* ============ 404 glitch ============ */
(function glitch() {
  const el = $('#big404'); if (!el || reduce) return;
  const orig = el.textContent; const lines = orig.split('\n');
  const where = $('#where'); where && (where.textContent = location.pathname.split('/').pop() || '/');
  setInterval(() => {
    if (still()) return;
    const k = (Math.random() * lines.length) | 0, shift = 1 + ((Math.random() * 4) | 0);
    const copy = lines.slice(); copy[k] = ' '.repeat(shift) + copy[k].replace(/█/g, () => Math.random() < 0.3 ? '▒' : '█');
    el.textContent = copy.join('\n');
    setTimeout(() => el.textContent = orig, 110);
  }, 1300);
})();

/* ============ GUIDE: can this PC run slate ============ */
(function pcCheck() {
  const btn = $('#pcCheck'); if (!btn) return;
  const out = $('#pcOut'), verdict = $('#pcVerdict'), bar = $('#pcBar'), live = $('#pcLive');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* every probe is guarded: a blocked api degrades to "not detected" and the
     run keeps going. nothing here leaves the browser. */
  async function entropy() {
    const uad = navigator.userAgentData;
    if (!uad || !uad.getHighEntropyValues) return {};
    try {
      return await uad.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'wow64']);
    } catch (e) { return {}; }
  }

  function gpuName() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      let r = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
      r = r.replace(/^ANGLE\s*\(/i, '').replace(/\)\s*$/, '');
      const parts = r.split(',').map(p => p.trim()).filter(Boolean);
      let best = parts.find(p => /geforce|radeon|arc\b|graphics|uhd|iris|vega|apple|mali|adreno/i.test(p))
        || parts[1] || parts[0] || '';
      best = best
        .replace(/\s*\((?:0x)?[0-9A-F]{4,}\).*$/i, '')
        .replace(/\s+(?:Direct3D|D3D|OpenGL|Vulkan|vs_\d+_\d+|ps_\d+_\d+).*$/i, '')
        .replace(/\s+/g, ' ').trim();
      return best.slice(0, 44);
    } catch (e) { return ''; }
  }

  function osName(uad, ua, he) {
    const plat = (uad && uad.platform) || '';
    const pv = parseFloat(he.platformVersion || '');
    if (/windows/i.test(plat) || /Windows NT/i.test(ua)) {
      if (pv >= 13) return { v: 'windows 11', ok: true };
      if (pv >= 1) return { v: 'windows 10', ok: true };
      return { v: 'windows 10 / 11', ok: true };
    }
    if (/mac/i.test(plat) || /Mac OS X/i.test(ua)) return { v: 'macos', ok: false };
    if (/android/i.test(plat) || /Android/i.test(ua)) return { v: 'android', ok: false };
    if (/ios/i.test(plat) || /iPhone|iPad|iPod/i.test(ua)) return { v: 'ios', ok: false };
    if (/chrome os|cros/i.test(plat) || /CrOS/i.test(ua)) return { v: 'chromeos', ok: false };
    if (/linux/i.test(plat) || /Linux/i.test(ua)) return { v: 'linux', ok: false };
    return { v: 'not detected', ok: false };
  }

  function archName(he, ua) {
    const arch = String(he.architecture || '').toLowerCase();
    const bits = String(he.bitness || '');
    const arm = arch === 'arm' || /arm64|aarch64/i.test(ua);
    /* windows on arm is 64-bit and still cannot run slate: arm never passes */
    if (bits === '64' || /Win64|x64|WOW64/i.test(ua)) return { v: arm ? 'arm64' : '64-bit x64', ok: !arm, bits: 64 };
    if (bits === '32' || /Win32/i.test(ua)) return { v: '32-bit', ok: false, bits: 32 };
    if (arm) return { v: 'arm64', ok: false, bits: 64 };
    return { v: 'not detected', ok: false, bits: 0 };
  }

  function detect() {
    const ua = navigator.userAgent || '';
    const uad = navigator.userAgentData;
    const mobile = (uad && typeof uad.mobile === 'boolean')
      ? uad.mobile : /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const cores = navigator.hardwareConcurrency || 0;
    const mem = navigator.deviceMemory || 0;
    const gpu = gpuName();
    const sw = screen.width || 0, sh = screen.height || 0;
    return entropy().then(he => {
      const os = osName(uad, ua, he);
      const arch = archName(he, ua);
      const rows = [
        { k: 'operating system', v: os.v, ok: os.ok },
        { k: 'architecture', v: arch.v, ok: arch.ok && !mobile },
        { k: 'processor', v: cores ? cores + ' threads' : 'not detected', ok: cores >= 2 },
        { k: 'memory', v: mem ? (mem >= 8 ? '8 GB or more' : mem + ' GB') : 'not detected', ok: mem >= 2 },
        { k: 'graphics', v: gpu || 'not detected', ok: Boolean(gpu) },
        /* a small screen is not a reason to say no: shown, not scored */
        { k: 'display', v: sw ? sw + ' \u00d7 ' + sh : 'not detected', ok: null },
        { k: 'firmware mode', v: 'installer confirms', ok: null },
      ];
      return { rows, mobile };
    });
  }

  function paintRow(r, i) {
    const cls = r.ok === null ? 'note' : (r.ok ? 'ok' : 'no');
    return `<div class="pc-row ${cls}${reduce ? ' in' : ''}" data-i="${i}">
      <span class="pc-mark"></span><span class="pc-k">${esc(r.k)}</span>
      <span class="pc-v">${esc(r.v)}</span></div>`;
  }

  function step(text, pct) {
    if (live) live.textContent = text;
    if (bar) bar.firstElementChild.style.width = pct + '%';
  }

  function finish(rows, pass, reason, mobile, secs) {
    verdict.className = 'pc-verdict' + (pass ? ' ok' : '');
    verdict.innerHTML = pass
      ? `<b>YES</b> \u2014 this PC can run slate.
         <span class="pc-sub">All requirement checks passed in ${secs}s. UEFI boot and administrator rights are confirmed by the installer itself, in about a second. Nothing was read outside this tab.</span>
         <div class="pc-cta">
           <a class="btn" href="pricing.html">see pricing &rarr;</a>
           <a class="btn ghost" href="checkout.html?tier=day">start with 1 day \u00b7 $6.99</a>
         </div>`
      : `<b>NO</b> \u2014 this PC cannot run slate.
         <span class="pc-sub">${reason}${mobile
           ? ' You are on a phone or tablet \u2014 open this page on the Windows PC you play on and run the check again.'
           : ''}</span>
         <div class="pc-cta"><a class="btn ghost" href="help.html#contact">ask a question</a></div>`;
    if (reduce) { verdict.classList.add('in'); return; }
    requestAnimationFrame(() => verdict.classList.add('in'));
  }

  btn.addEventListener('click', async () => {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = 'checking';
    verdict.className = 'pc-verdict';
    verdict.innerHTML = '<span class="pc-sub">reading this browser\u2026</span>';
    out.innerHTML = '';
    if (bar) { bar.hidden = false; bar.firstElementChild.style.width = '0%'; }
    step('starting', 4);

    const t0 = performance.now();
    const { rows, mobile } = await detect();

    /* paint one row at a time so the scan reads like a scan, not a wall */
    for (let i = 0; i < rows.length; i++) {
      step('checking ' + rows[i].k, Math.round(((i + 1) / rows.length) * 92));
      out.insertAdjacentHTML('beforeend', paintRow(rows[i], i));
      if (!reduce) {
        const el = out.lastElementChild;
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
        await sleep(120 + (i === rows.length - 1 ? 120 : 0));
      }
    }

    const failing = rows.filter(r => r.ok === false);
    const pass = failing.length === 0;
    const reason = failing.length === 1
      ? `This PC fails the ${failing[0].k} check. slate needs Windows 10 or 11 on a 64-bit x64 desktop PC.`
      : `This PC fails ${failing.length} checks: ${failing.map(r => r.k).join(', ')}. slate needs Windows 10 or 11 on a 64-bit x64 desktop PC.`;

    step(pass ? 'ready' : 'done', 100);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    finish(rows, pass, reason, mobile, secs);

    if (live) live.textContent = pass ? `${secs}s \u00b7 all clear` : `${secs}s \u00b7 see below`;

    btn.dataset.busy = '0';
    btn.disabled = false;
    btn.textContent = 'check again';
  });
})();

/* ============ BASALT INTERACTIVE MENU DEMO ============ */
(function basaltMenuDemo() {
  const root = $('#basaltHud'); if (!root) return;

  const CATS = [
    { name: 'visuals',  subs: ['player visuals', 'npc visuals'] },
    { name: 'combat',   subs: ['aimbot', 'weapons'] },
    { name: 'movement', subs: ['movement'] },
    { name: 'misc',     subs: ['utility', 'environment'] },
    { name: 'config',   subs: ['interface', 'crosshair'] },
  ];

  const PAGES = {
    'visuals:player visuals': [
      { box: 'PLAYER ESP', rows: [
        { t: 'x', l: 'Player ESP', on: true },
        { t: 'x', l: 'Names', on: true },
        { t: 'x', l: 'Distance', on: true },
        { t: 'x', l: 'Skeleton', on: false },
        { t: 'x', l: 'Box', d: '2d bounding box', on: true },
        { t: 'x', l: 'Status flags', d: 'wounded / safe / mounted', on: false },
      ]},
      { box: 'FILTERS', rows: [
        { t: 'x', l: 'Teammate ESP', on: true },
        { t: 'x', l: 'Enemy ESP', on: true },
        { t: 'x', l: 'Wounded players', on: false },
        { t: 'x', l: 'Safezone players', on: false },
        { t: 'x', l: 'Dead players', on: false },
        { t: 'x', l: 'Sleepers', on: true },
      ]},
      { box: 'STYLE', rows: [
        { t: 's', l: 'Render distance', v: '320 m' },
      ]},
    ],
    'visuals:npc visuals': [
      { box: 'NPC ESP', rows: [
        { t: 'x', l: 'NPC ESP', on: false },
        { t: 'x', l: 'Names', on: true },
        { t: 'x', l: 'Distance', on: true },
        { t: 'x', l: 'Box', on: true },
        { t: 'x', l: 'Skeleton', on: false },
      ]},
      { box: 'STYLE', rows: [
        { t: 's', l: 'Render distance', v: '250 m' },
      ]},
    ],
    'combat:aimbot': [
      { box: 'AIMBOT & COMBAT', rows: [
        { t: 'x', l: 'Aimbot', d: 'move the view to target', on: true },
        { t: 'x', l: 'Silent aim', d: 'rewrite shot direction', on: true },
        { t: 'o', l: 'Target bone', v: 'head', opts: 'head chest leg foot pelvis any' },
        { t: 'x', l: 'Nearest bone', d: 'closest bone to crosshair', on: false },
        { t: 's', l: 'Aim smoothing', v: '4.0' },
        { t: 's', l: 'Silent hit chance', v: '80%' },
        { t: 'x', l: 'Visibility check', d: 'require line of sight', on: true },
        { t: 's', l: 'Aim FOV', v: '120 px' },
        { t: 'x', l: 'Dynamic FOV', d: 'scale cone with distance', on: false },
        { t: 's', l: 'Max aim distance', v: '300 m' },
      ]},
      { box: 'TARGET FILTERS', rows: [
        { t: 'x', l: 'Wounded players', on: false },
        { t: 'x', l: 'Scientists', on: false },
        { t: 'x', l: 'Sleepers', on: false },
        { t: 'x', l: 'Teammates', on: false },
        { t: 'x', l: 'Safezone players', on: false },
        { t: 'x', l: 'Helicopter aimbot', on: false },
      ]},
      { box: 'DISPLAY', rows: [
        { t: 'x', l: 'FOV circle', d: 'draw the cone in game', on: true },
        { t: 'x', l: 'Target line', d: 'line to locked target', on: false },
      ]},
    ],
    'combat:weapons': [
      { box: 'RECOIL', rows: [
        { t: 'x', l: 'Recoil control', on: true },
      ]},
      { box: 'SPREAD', rows: [
        { t: 'x', l: 'Spread control', on: true },
        { t: 's', l: 'Weapon spread', v: '0.00' },
        { t: 'x', l: 'No shotgun spread', on: true },
      ]},
      { box: 'BEHAVIOUR', rows: [
        { t: 'x', l: 'Fast bullets', d: 'instant projectile speed', on: false },
        { t: 'x', l: 'Force automatic', d: 'full-auto on any weapon', on: false },
        { t: 'x', l: 'Instant Eoka', d: 'skip the strike', on: false },
        { t: 's', l: 'Eoka success chance', v: '100%' },
      ]},
    ],
    'movement:movement': [
      { box: 'MOVEMENT', rows: [
        { t: 'x', l: 'Spiderman', d: 'climb any surface', on: false },
        { t: 'x', l: 'Speed hack', on: true },
        { t: 's', l: 'Speed multiplier', v: '1.60x' },
        { t: 'x', l: 'No jump cooldown', d: 'no landing delay', on: false },
        { t: 'x', l: 'Noclip', d: 'fly through geometry', on: false },
        { t: 'x', l: 'Admin + no jump cooldown', d: 'admin flag, no delay', on: false },
        { t: 'x', l: 'Omni sprint', d: 'sprint in any direction', on: true },
        { t: 'x', l: 'Air control', d: 'steer while airborne', on: false },
      ]},
      { box: 'PHYSICS', rows: [
        { t: 'x', l: 'Gravity control', on: false },
        { t: 's', l: 'Gravity scale', v: '0.50x' },
        { t: 'x', l: 'Jump height', on: false },
        { t: 's', l: 'Jump multiplier', v: '1.40x' },
        { t: 'x', l: 'No fall damage', on: false },
      ]},
    ],
    'misc:utility': [
      { box: 'UTILITY', rows: [
        { t: 'x', l: 'Instant loot', d: 'skip the loot animation', on: false },
        { t: 'x', l: 'Instant revive', on: false },
        { t: 'x', l: 'Ignore collision', on: false },
        { t: 'x', l: 'Remove layers', d: 'strip wearables / gear', on: false },
      ]},
      { box: 'BATTLE INDICATOR', rows: [
        { t: 'x', l: 'Battle mode indicator', on: true },
        { t: 'x', l: 'Enemy proximity alerts', on: true },
      ]},
    ],
    'misc:environment': [
      { box: 'ENVIRONMENT', rows: [
        { t: 'x', l: 'Bright night', d: 'no darkness', on: true },
        { t: 's', l: 'Time changer', v: '12.0 h' },
        { t: 'x', l: 'Custom day sky', on: false },
        { t: 'x', l: 'Custom night sky', on: false },
        { t: 'x', l: 'Custom stars', on: false },
        { t: 's', l: 'Star brightness', v: '60%' },
      ]},
    ],
    'config:interface': [
      { box: 'INTERFACE', rows: [
        { t: 'x', l: 'Watermark', on: false },
      ]},
      { box: 'WORLD DISTANCE COLOURS', rows: [
        { t: 's', l: 'Far', v: '#8C8C8C' },
        { t: 's', l: 'Mid', v: '#C8C8C8' },
        { t: 's', l: 'Near', v: '#FFFFFF' },
      ]},
      { box: 'CONFIG', rows: [
        { t: 'btn', l: 'save config' },
        { t: 'btn', l: 'load config' },
      ]},
    ],
    'config:crosshair': [
      { box: 'CROSSHAIR', rows: [
        { t: 'x', l: 'Custom crosshair', on: true },
        { t: 'o', l: 'Style', v: 'cross', opts: 'dot cross circle t' },
        { t: 'x', l: 'Rainbow', on: false },
        { t: 's', l: 'Size', v: '8 px' },
      ]},
    ],
  };

  let cat = 0, sub = 0;

  function rowHtml(r) {
    if (r.t === 'x') {
      const cls = r.on ? 'on' : '';
      const desc = r.d ? `<span class="d bv-desc">${r.d}</span>` : '';
      return `<div class="bv-row"><span class="bv-check ${cls}"></span><span>${r.l}</span>${desc}</div>`;
    }
    if (r.t === 'o') {
      const opts = r.opts.split(' ');
      const btns = opts.map(o =>
        `<span class="bv-sel${o === r.v ? ' bv-sel-on' : ''}">${o}</span>`
      ).join('');
      return `<div class="bv-row"><span class="d bv-lbl">${r.l}</span><span class="bv-sel-row">${btns}</span></div>`;
    }
    if (r.t === 'btn') {
      return `<div class="bv-row"><span class="bv-btn">${r.l}</span></div>`;
    }
    return `<div class="bv-row"><span class="d bv-lbl">${r.l}</span><b>${r.v}</b></div>`;
  }

  function render() {
    const c = CATS[cat];
    const subName = c.subs[sub] || c.subs[0];
    const key = `${c.name}:${subName}`;
    const boxes = PAGES[key] || [];

    const sideHtml = CATS.map((ct, i) => {
      const active = i === cat;
      return `<div class="bv-side-item${active ? ' bv-side-active' : ''}" data-cat="${i}">
        <span>${ct.name}</span><span class="d">${i + 1}</span>
      </div>`;
    }).join('');

    const subHtml = c.subs.length > 1 ? c.subs.map((s, i) =>
      `<span class="bv-tab${i === sub ? ' bv-tab-active' : ''}" data-sub="${i}">${s}</span>`
    ).join('') : `<span class="bv-tab bv-tab-active">${c.subs[0]}</span>`;

    let contentHtml = '';
    boxes.forEach(b => {
      contentHtml += `<div class="bv-box-wrap">`;
      contentHtml += `<div class="bv-box-head">${b.box}</div>`;
      b.rows.forEach(r => { contentHtml += rowHtml(r); });
      contentHtml += `</div>`;
    });

    root.innerHTML = `
      <div class="hud-chrome">
        <span>strata/<strong>basalt</strong></span>
        <span class="bv-attached">[attached]</span>
      </div>
      <div class="bv-layout">
        <div class="bv-sidebar">${sideHtml}</div>
        <div class="bv-main">
          <div class="bv-tabs bv-subtabs">${subHtml}</div>
          <div class="bv-content">${contentHtml}</div>
        </div>
      </div>
      <div class="bv-stat">
        <span>INSERT menu &middot; 1-5 categories &middot; END close</span>
        <span>entities <b>47</b> &middot; <b>144</b> fps</span>
      </div>
    `;
  }

  root.addEventListener('click', e => {
    const ci = e.target.closest('[data-cat]');
    if (ci) { cat = +ci.dataset.cat; sub = 0; render(); return; }
    const si = e.target.closest('[data-sub]');
    if (si) { sub = +si.dataset.sub; render(); return; }
    const check = e.target.closest('.bv-check');
    if (check) { check.classList.toggle('on'); }
  });

  render();
})();
})();
