// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Ambilight tab: power and style through the PHI bridge, the live LED preview from JointSpace.

/* ================= ambilight ================= */
/* Ambilight power and style are written through the PHI bridge: on 55PUS8450/12
   (TPN256E_V056.010.032.001) every JointSpace Ambilight write answers 503 and its
   reads can be stale. Style ids and labels follow PHI's own Ambilight style OSD
   (phi_page/ambiStyleOsd.js, lib/core.js:9382); 0 is Off. */
const AMB_STYLES = [
  [1, 'AI'], [2, 'Standard'], [3, 'Sports'], [4, 'Cinema'], [5, 'Game'], [6, 'Music'], [7, 'Fixed colour'], [8, 'Support your team'],
];
let ambPhi = null;          // RpcSetupAmbilightGetConfig result
let ambLive = null;
let ambTimer = 0;
let ambBusy = false;
let ambTopology = null;
let ambLastStyle = 2;       // what "On" restores

async function loadAmbilight() {
  try {
    const d = await api('/api/ambilight');
    ambTopology = d.topology || ambTopology;
  } catch (_) { /* the preview falls back to the LED counts it reads */ }
  const cfg = await phiGuard(() => phi('RpcSetupAmbilightGetConfig'), $('#ambBusy'), $('#ambErr'));
  if (cfg) {
    ambPhi = cfg;
    const st = Number(cfg.ambilightStyle) || 0;
    if (st > 0) ambLastStyle = st;
  }
  renderAmbPower();
  renderAmbStyles();
}

function ambStyleNow() { return ambPhi ? Number(ambPhi.ambilightStyle) || 0 : null; }

function renderAmbPower() {
  const sw = $('#ambSwitch');
  const st = ambStyleNow();
  sw.setAttribute('aria-checked', st === null ? false : st > 0);
  const name = (AMB_STYLES.find(x => x[0] === st) || [0, st === 0 ? 'Off' : ''])[1];
  setText($('#ambNow'), st === null ? '' : 'Now: ' + name);
  if (activeTab === 'ambilight' && $('#ambStyles').childElementCount) markStyles();
}

function renderAmbStyles() {
  const host = $('#ambStyles');
  host.textContent = '';
  host.append(h('div', { class: 'style-group' },
    h('div', { class: 'chips' }, AMB_STYLES.map(([id, label]) => h('button', {
      class: 'chip', type: 'button', 'data-style': id, 'aria-pressed': 'false', text: label,
      onclick: () => { buzz(); chooseStyle(id); },
    })))));
  const adv = (ambPhi && ambPhi.Advanced) || {};
  if (ambPhi && adv.ambilightBrightness !== undefined) {
    const num = h('span', { class: 'num', text: String(adv.ambilightBrightness) });
    const inp = h('input', { type: 'range', min: 0, max: 10, step: 1, value: adv.ambilightBrightness, 'aria-label': 'Brightness' });
    const paint = () => { inp.style.setProperty('--pct', inp.value * 10 + '%'); num.textContent = inp.value; };
    paint();
    let t = 0;
    inp.addEventListener('input', () => {
      paint(); clearTimeout(t);
      t = setTimeout(() => phiGuard(() => phi('RpcAmbilightBrightnessSet', { brightness: Number(inp.value) }), $('#ambBusy'), $('#ambErr')), 250);
    });
    host.append(h('div', { class: 'style-group' }, h('div', { class: 'lbl', text: 'Brightness' }), h('div', { class: 'rng', style: 'width:100%' }, inp, num)));
  }
  markStyles();
}

function markStyles() {
  const st = ambStyleNow();
  $$('#ambStyles .chip').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.style) === st));
}

/* RpcSetupAmbilightStyleSet {style, mode}: mode = style, except Music, which takes
   the current ambilightStyleFollowAudio (ambiStyleOsd.js, setAmbilightPersonalStyleMode). */
async function setAmbStyle(style) {
  const mode = style === 6 ? Number((ambPhi && ambPhi.ambilightStyleFollowAudio) || 0) : style;
  const r = await phiGuard(() => phi('RpcSetupAmbilightStyleSet', { style, mode }), $('#ambBusy'), $('#ambErr'));
  if (r === undefined) return false;
  if (ambPhi) ambPhi.ambilightStyle = style;
  if (style > 0) ambLastStyle = style;
  renderAmbPower();
  return true;
}

function chooseStyle(style) { return setAmbStyle(style); }

function ambToggle() {
  buzz();
  return setAmbStyle(ambStyleNow() > 0 ? 0 : ambLastStyle);
}

function startAmb() {
  loadAmbilight();
  drawAmb();
  ambLoop();
}
function stopAmb() { clearTimeout(ambTimer); ambTimer = 0; }

async function ambLoop() {
  clearTimeout(ambTimer);
  if (activeTab !== 'ambilight') return;
  if (!document.hidden && !ambBusy) {
    ambBusy = true;
    try { ambLive = await api('/api/ambilight/live'); } catch (_) { ambLive = null; }
    ambBusy = false;
    drawAmb();
  }
  ambTimer = setTimeout(ambLoop, 500);
}

/* LED order assumed clockwise from the bottom-left: left runs bottom to top,
   top left to right, right top to bottom, bottom right to left. */
function ledColour(layer, side, i, n) {
  const side_ = layer && layer[side];
  if (!side_) return null;
  const px = side_[i] ?? side_[String(i)] ?? (Array.isArray(side_) ? side_[i] : null);
  return px && typeof px === 'object' ? px : null;
}

function drawAmb() {
  const cv = $('#ambCanvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--bg').trim() || '#000';
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const layer = ambLive && (ambLive.layer1 || ambLive.layer_1);
  const topo = ambTopology || {};
  const count = side => {
    const t = Number(topo[side]);
    if (!isNaN(t) && topo[side] != null) return t;
    return layer && layer[side] ? Object.keys(layer[side]).length : 0;
  };
  const m = Math.min(W * 0.1, H * 0.16);
  const sx = m, sy = m, sw = W - 2 * m, sh = H - 2 * m;
  const leds = [];
  const nl = count('left'), nt = count('top'), nr = count('right'), nb = count('bottom');
  for (let i = 0; i < nl; i++) leds.push(['left', i, sx - m * 0.45, sy + sh - (i + 0.5) * sh / nl]);
  for (let i = 0; i < nt; i++) leds.push(['top', i, sx + (i + 0.5) * sw / nt, sy - m * 0.45]);
  for (let i = 0; i < nr; i++) leds.push(['right', i, sx + sw + m * 0.45, sy + (i + 0.5) * sh / nr]);
  for (let i = 0; i < nb; i++) leds.push(['bottom', i, sx + sw - (i + 0.5) * sw / nb, sy + sh + m * 0.45]);
  const pts = leds.map(([side, i, x, y]) => {
    const c = ledColour(layer, side, i);
    return { x, y, c: c ? `${c.r | 0},${c.g | 0},${c.b | 0}` : null };
  });
  // soft glow, then the screen over it, then the LED dots
  for (const p of pts) {
    if (!p.c) continue;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, m * 1.9);
    g.addColorStop(0, `rgba(${p.c},${light ? 0.55 : 0.6})`);
    g.addColorStop(1, `rgba(${p.c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.x - m * 2, p.y - m * 2, m * 4, m * 4);
  }
  ctx.fillStyle = bg;
  roundRect(ctx, sx, sy, sw, sh, 6); ctx.fill();
  ctx.strokeStyle = light ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.3)';
  ctx.lineWidth = 1.5; roundRect(ctx, sx, sy, sw, sh, 6); ctx.stroke();
  const r = clamp(m * 0.16, 2.5, 6);
  for (const p of pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832);
    ctx.fillStyle = p.c ? `rgb(${p.c})` : (light ? 'rgba(0,0,0,.15)' : 'rgba(255,255,255,.14)');
    ctx.fill();
  }
}
function roundRect(ctx, x, y, w, h_, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h_, r); ctx.arcTo(x + w, y + h_, x, y + h_, r);
  ctx.arcTo(x, y + h_, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
