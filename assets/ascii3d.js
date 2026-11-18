/* Tiny ASCII 3D engine: point sampled surfaces, z buffer, lambert shading.
   Used for the login padlock, with a key that follows your password. */
(() => {
'use strict';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const RAMP = '.,:;=+*#%@';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LIGHT = (() => { const v = [-0.45, 0.55, -0.7]; const m = Math.hypot(...v); return v.map(x => x / m); })();
const B3D = window.B3D = {};

const ptr = { x: 0, y: 0 };
addEventListener('pointermove', e => { ptr.x = e.clientX / innerWidth - 0.5; ptr.y = e.clientY / innerHeight - 0.5; });

function renderer(el, o) {
  const cols = o.cols, rows = o.rows, ASP = 1.67;
  const K = o.K || cols * 1.6, D = o.dist || 4.5;
  const zb = new Float32Array(cols * rows), lb = new Int8Array(cols * rows);
  const st = Object.assign({ rx: -0.3, ry: 0.4, spin: 0.02, vy: 0.02, tx: 0, ty: 0, drag: null, t: 0 }, o.state || {});
  let cY = 1, sY = 0, cX = 1, sX = 0;
  function emit(x, y, z, nx, ny, nz, k) {
    const x1 = x * cY + z * sY, z1 = -x * sY + z * cY;
    const y1 = y * cX - z1 * sX, z2 = y * sX + z1 * cX + D;
    if (z2 < 0.2) return;
    const ooz = 1 / z2;
    const xp = (cols / 2 + K * ooz * x1) | 0, yp = (rows / 2 - K * ooz * y1 / ASP) | 0;
    if (xp < 0 || xp >= cols || yp < 0 || yp >= rows) return;
    const i = yp * cols + xp;
    if (ooz <= zb[i]) return;
    zb[i] = ooz;
    const nx1 = nx * cY + nz * sY, nz1 = -nx * sY + nz * cY;
    const ny1 = ny * cX - nz1 * sX, nz2 = ny * sX + nz1 * cX;
    const L = (nx1 * LIGHT[0] + ny1 * LIGHT[1] + nz2 * LIGHT[2]) * (k == null ? 1 : k);
    lb[i] = clamp(Math.floor((L * 0.85 + 0.15) * 9.99), 0, 9);
  }
  function draw() {
    zb.fill(0); lb.fill(-1);
    const ry = st.ry + st.ty, rx = st.rx + st.tx;
    cY = Math.cos(ry); sY = Math.sin(ry); cX = Math.cos(rx); sX = Math.sin(rx);
    o.sample(emit, st);
    let s = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) { const v = lb[r * cols + c]; s += v < 0 ? ' ' : RAMP[v]; }
      s += '\n';
    }
    el.textContent = s;
  }
  let visible = false, last = 0;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(el);
  function step(dt) {
    const still = document.documentElement.classList.contains('still');
    // paused: spin and tilt hold exactly where they are and resume from there.
    // o.tick still runs so the key and shackle answer the form while paused.
    if (!still) {
      st.t += dt;
      if (!st.drag) { st.ry += st.vy; st.vy += (st.spin - st.vy) * 0.04; }
      st.tx += (ptr.y * 0.4 - st.tx) * 0.08; st.ty += (ptr.x * 0.5 - st.ty) * 0.08;
    }
    o.tick && o.tick(st, dt);
  }
  function loop(now) {
    requestAnimationFrame(loop);
    if (!visible || now - last < 33) return;
    const dt = Math.min(64, now - last); last = now;
    step(dt); draw();
  }
  el.addEventListener('pointerdown', e => { st.drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (!st.drag) return;
    const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
    st.ry += dx * 0.012; st.vy = dx * 0.012; st.rx = clamp(st.rx + dy * 0.01, -1.4, 1.4);
    st.drag = { x: e.clientX, y: e.clientY };
    if (reduce) draw();
  });
  const end = () => { st.drag = null; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  if (reduce) { st.spin = 0; st.vy = 0; } else requestAnimationFrame(loop);
  draw();
  // reduced motion: settle state instantly so changes still show
  const settle = () => { for (let i = 0; i < 80; i++) step(33); draw(); };
  return { st, draw, settle };
}

function box(emit, x0, x1, y0, y1, z0, z1, s, k, hole) {
  for (let x = x0; x <= x1 + 1e-6; x += s) for (let y = y0; y <= y1 + 1e-6; y += s) {
    if (!hole || !hole(x, y)) { emit(x, y, z0, 0, 0, -1, k); emit(x, y, z1, 0, 0, 1, k); }
  }
  for (let x = x0; x <= x1 + 1e-6; x += s) for (let z = z0; z <= z1 + 1e-6; z += s) { emit(x, y1, z, 0, 1, 0, k); emit(x, y0, z, 0, -1, 0, k); }
  for (let y = y0; y <= y1 + 1e-6; y += s) for (let z = z0; z <= z1 + 1e-6; z += s) { emit(x0, y, z, -1, 0, 0, k); emit(x1, y, z, 1, 0, 0, k); }
}

/* ---------- padlock + key ----------
   state: open (bool), key (0..1 insertion), keyOn (bool), turn (radians), focus (bool), jig (0..1) */
const lock = {
  cols: 74, rows: 40, K: 68,
  state: { lift: 0, swing: 0, rx: -0.28, kp: 0, key: 0, keyOn: false, kvis: 0, turn: 0, turnGoal: 0, jig: 0 },
  sample(emit, st) {
    const oy = -0.5, KY = -0.2; // oy recentres the whole lock (shackle included) in the frame
    const hole = (x, y) => (x * x + (y - KY) * (y - KY) < 0.035) || (Math.abs(x) < 0.075 && y < KY && y > -0.78);
    box((x, y, z, nx, ny, nz, k) => emit(x, y + oy, z, nx, ny, nz, k), -1, 1, -1.1, 0.45, -0.42, 0.42, 0.032, 0.95, hole);
    // inner walls of the keyhole give it depth
    for (let z = -0.42; z <= 0.1; z += 0.04) {
      for (let a = 0; a < TAU; a += 0.22) emit(Math.cos(a) * 0.187, KY + Math.sin(a) * 0.187 + oy, z, -Math.cos(a), -Math.sin(a), 0, 0.45);
      for (let y = -0.78; y < KY; y += 0.04) { emit(-0.075, y + oy, z, 1, 0, 0, 0.45); emit(0.075, y + oy, z, -1, 0, 0, 0.45); }
    }
    // shackle: half torus on two legs, lifts then swings around the left leg
    const R = 0.62, r = 0.12, lift = st.lift * 0.5, cyy = 0.95 + lift;
    const cs = Math.cos(st.swing), sn = Math.sin(st.swing);
    const sh = (x, y, z, nx, ny, nz) => {
      const px = x + R;
      emit(px * cs + z * sn - R, y + oy, -px * sn + z * cs, nx * cs + nz * sn, ny, -nx * sn + nz * cs);
    };
    for (let a = 0; a <= Math.PI + 1e-6; a += 0.045) {
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let p = 0; p < TAU; p += 0.3) {
        const nx = ca * Math.cos(p), ny = sa * Math.cos(p), nz = Math.sin(p);
        sh(R * ca + r * nx, cyy + R * sa + r * ny, r * nz, nx, ny, nz);
      }
    }
    for (const sx of [-R, R]) for (let y = 0.1 + lift; y <= cyy; y += 0.045) for (let p = 0; p < TAU; p += 0.3) {
      sh(sx + r * Math.cos(p), y, r * Math.sin(p), Math.cos(p), 0, Math.sin(p));
    }
    // key: blade along z into the keyhole, bow in the blade plane, turns around its shaft
    if (st.kvis < 0.02) return;
    const tip = -1.15 + st.kp * 1.4 - (1 - st.kvis) * 1.2;
    const ang = st.turn + Math.sin(st.t * 0.045) * 0.35 * st.jig;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ke = (x, y, z, nx, ny, nz, k) => emit(x * ca - y * sa, x * sa + y * ca + KY + oy, z, nx * ca - ny * sa, nx * sa + ny * ca, nz, k);
    const len = 0.95, S = 0.025, KK = 1.15;
    box(ke, -0.035, 0.035, -0.06, 0.07, tip - len, tip, S, KK);
    box(ke, -0.035, 0.035, -0.3, -0.06, tip - 0.32, tip - 0.18, S, KK);
    box(ke, -0.035, 0.035, -0.24, -0.06, tip - 0.62, tip - 0.46, S, KK);
    box(ke, -0.035, 0.035, -0.28, -0.06, tip - 0.14, tip - 0.06, S, KK);
    const BR = 0.3, br = 0.07, bz = tip - len - BR + 0.04;
    for (let a = 0; a < TAU; a += 0.06) {
      const c = Math.cos(a), s = Math.sin(a);
      for (let p = 0; p < TAU; p += 0.4) {
        const ny = c * Math.cos(p), nz = s * Math.cos(p), nx = Math.sin(p);
        ke(br * nx, BR * c + br * ny, bz + BR * s + br * nz, nx, ny, nz, KK);
      }
    }
  },
  tick(st) {
    if (st.focus && !st.open) {
      // turn to a three quarter view so you can watch the key go in
      st.spin = 0; st.vy *= 0.8;
      const tgt = Math.round((st.ry + 0.6) / TAU) * TAU - 0.6;
      st.ry += (tgt - st.ry) * 0.12;
    } else st.spin = 0.02;
    st.kvis += ((st.keyOn ? 1 : 0) - st.kvis) * 0.15;
    st.kp += (st.key - st.kp) * 0.18;
    st.turn += (st.turnGoal - st.turn) * 0.16;
    st.jig *= 0.93;
    const open = st.open && st.turn > 1.3;
    st.lift += ((open ? 1 : 0) - st.lift) * 0.14;
    st.swing += ((open && st.lift > 0.85 ? -1.5 : 0) - st.swing) * 0.1;
  },
};

const OBJECTS = { lock };
document.querySelectorAll('pre[data-obj]').forEach(el => {
  const def = OBJECTS[el.dataset.obj]; if (!def) return;
  B3D[el.dataset.obj] = renderer(el, def);
});

})();
