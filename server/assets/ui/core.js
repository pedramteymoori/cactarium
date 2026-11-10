// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// Helpers, icons, toasts, storage, the token and the API wrapper.

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  power: 'M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0',
  up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6',
  back: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  home: 'M4 11l8-7 8 7M6 10v10h12V10',
  options: 'M5 7h14M5 12h14M5 17h14',
  source: 'M14 4h6v16h-6M4 12h11M11 8l4 4-4 4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  volume: 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7',
  mute: 'M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6',
  play: 'M8 5v14l11-7z', stop: 'M6 6h12v12H6z',
  rew: 'M11 7l-7 5 7 5zM20 7l-7 5 7 5z', ff: 'M13 7l7 5-7 5zM4 7l7 5-7 5z',
  next: 'M6 6l9 6-9 6zM18 6v12', prev: 'M18 6l-9 6 9 6zM6 6v12',
  playpause: 'M5 5v14l8-7zM16 5v14M20 5v14',
};

function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.appendChild(p);
  return svg;
}
function setIcon(host, name) {
  const old = host.querySelector(':scope > svg');
  if (old) old.remove();
  host.prepend(icon(name));
}

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
const setText = (el, t) => { if (el && el.textContent !== String(t)) el.textContent = t; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const buzz = () => { try { navigator.vibrate && navigator.vibrate(10); } catch (_) { /* ignore */ } };

function toast(msg, isErr = true) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), text: msg });
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
};

function humanBytes(b) {
  b = Number(b) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}
function humanUptime(sec) {
  sec = Math.floor(Number(sec) || 0);
  const d = Math.floor(sec / 86400), hr = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return d + 'd ' + hr + 'h';
  if (hr) return hr + 'h ' + m + 'm';
  return m + 'm';
}

/* ================= token + api ================= */
const TOKEN_KEY = 'cactarium.token';
let offline = false;

function captureTokenFromUrl() {
  const u = new URL(location.href);
  const t = u.searchParams.get('token');
  if (t) {
    store.set(TOKEN_KEY, t);
    u.searchParams.delete('token');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
}

function askToken() {
  const dlg = $('#tokenDlg');
  if (dlg.open) return;
  $('#tokenInput').value = '';
  dlg.showModal();
}

async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const headers = {};
  const tk = store.get(TOKEN_KEY);
  if (tk) headers['X-Cactarium-Token'] = tk;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, cache: 'no-store', body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (_) {
    setOffline(true);
    throw new Error('Cannot reach Cactarium');
  }
  setOffline(false);
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (res.status === 401) { askToken(); throw new Error('Access token required'); }
  if (!res.ok || (data && typeof data.error === 'string' && data.error)) {
    const err = new Error((data && data.error) || res.statusText || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Fire a command; the response is the fresh state. */
async function cmd(path, body) {
  try {
    const s = await api(path, { method: 'POST', body });
    if (s && s.tv) applyState(s);
    return s;
  } catch (e) { toast(e.message); return null; }
}
const sendKey = key => cmd('/api/key', { key });

function setOffline(v) {
  if (offline === v) return;
  offline = v;
  $('#bannerOffline').hidden = !v;
  if (v) renderHeader();
}
