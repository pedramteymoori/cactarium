// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Home tab: the Home button's launcher, its apps row and its options.

let catalog = null; // [{code, name, icon, app_type}] from GET /api/titan/catalog

const launcherCfg = () => (settings && settings.launcher) || {};

async function loadHome() {
  await loadSettings();
  fetchLauncherApps().then(renderHomeApps).catch(() => {});
  if (!catalog) loadCatalog();
  loadWallpapers();
}

async function loadCatalog() {
  try {
    catalog = await api('/api/titan/catalog');
    if (!Array.isArray(catalog)) catalog = (catalog && catalog.apps) || [];
    setText($('#home-cat-note'), catalog.length + ' apps in the catalog.');
  } catch (e) {
    catalog = [];
    setText($('#home-cat-note'), 'The catalog is not available: ' + e.message);
  }
  fillAddList();
}

function renderHome() {
  if (!settings) return;
  const l = launcherCfg();
  const on = l.enabled !== false;
  $('#home-dot').className = 'ps-dot' + (on ? ' good' : '');
  setText($('#home-state'), on ? 'Cactarium launcher' : 'TitanOS Home');
  setText($('#home-state-desc'), on ? 'The Home button opens the Cactarium launcher.' : 'The Home button opens the stock TitanOS home.');
  $('#home-mode-titan').classList.toggle('on', !on);
  $('#home-mode-cactarium').classList.toggle('on', on);
  setPill($('#home-block'), !!l.block_titanos);
  if (document.activeElement !== $('#wxLat') && document.activeElement !== $('#wxLon')) {
    const wx = l.weather || {};
    $('#wxLat').value = wx.latitude == null ? '' : wx.latitude;
    $('#wxLon').value = wx.longitude == null ? '' : wx.longitude;
  }
  renderHomeApps();
  renderBackground();
}

function appName(code) {
  if (code === 'tv') return 'TV';
  const a = launcherApps.find(x => x.code === code) || (catalog || []).find(x => x.code === code);
  return a ? a.name : code;
}

function renderHomeApps() {
  const host = $('#home-apps');
  if (!host || !settings) return;
  const codes = launcherCfg().apps || [];
  host.textContent = '';
  if (!codes.length) host.append(h('div', { class: 'prot-row' }, h('div', { class: 'prot-main' }, h('div', { class: 'prot-desc', text: 'No apps picked: the launcher uses the TV\'s own app list.' }))));
  codes.forEach((code, i) => {
    const move = (label, to, aria) => {
      const b = h('button', { type: 'button', class: 'pill idle home-move', text: label, 'aria-label': aria });
      b.disabled = to < 0 || to >= codes.length;
      b.addEventListener('click', () => { const next = codes.slice(); next.splice(to, 0, next.splice(i, 1)[0]); saveApps(next); });
      return b;
    };
    const rm = h('button', { type: 'button', class: 'pill idle', text: 'Remove', style: 'min-width:0' });
    rm.addEventListener('click', () => saveApps(codes.filter((_, j) => j !== i)));
    host.append(h('div', { class: 'prot-row home-tile' },
      h('div', { class: 'prot-main' }, h('div', { class: 'prot-title' },
        code === 'tv' ? null : h('img', { class: 'app-ico', src: '/launcher/titan-icon?code=' + encodeURIComponent(code), alt: '', loading: 'lazy' }),
        h('span', { text: appName(code) }))),
      h('div', { class: 'prot-status' }, move('↑', i - 1, 'Move up'), move('↓', i + 1, 'Move down'), rm)));
  });
  fillAddList();
}

async function saveApps(apps) {
  $('#home-apps-err').textContent = '';
  if (!(await cmdSoft('/api/settings', { launcher: { apps } }))) return;
  await loadSettings();
  fetchLauncherApps().then(renderHomeApps).catch(() => {});
}

function fillAddList() {
  const sel = $('#home-add-sel');
  if (!sel) return;
  const have = new Set(launcherCfg().apps || []);
  const q = $('#home-add-q').value.trim().toLowerCase();
  sel.textContent = '';
  const list = [{ code: 'tv', name: 'TV input' }].concat(catalog || []).filter(a => !have.has(a.code) && (!q || a.name.toLowerCase().includes(q)));
  for (const a of list.slice(0, 300)) sel.append(h('option', { value: a.code, text: a.name }));
  $('#home-add-btn').disabled = !list.length;
}

function initHome() {
  initBackground();
  $('#home-mode-titan').addEventListener('click', () => saveSettings({ launcher: { enabled: false } }));
  $('#home-mode-cactarium').addEventListener('click', () => saveSettings({ launcher: { enabled: true } }));
  $('#home-block').addEventListener('click', () => saveSettings({ launcher: { block_titanos: !launcherCfg().block_titanos } }));
  $('#home-add-q').addEventListener('input', fillAddList);
  $('#home-add-btn').addEventListener('click', () => {
    const code = $('#home-add-sel').value;
    if (code) saveApps([...(launcherCfg().apps || []), code]);
  });
  $('#home-weather-form').addEventListener('submit', e => {
    e.preventDefault();
    const lat = $('#wxLat').value.trim(), lon = $('#wxLon').value.trim();
    const weather = !lat && !lon ? { clear: true } : { latitude: lat === '' ? null : Number(lat), longitude: lon === '' ? null : Number(lon) };
    saveSettings({ launcher: { weather } });
  });
}


/* ================= Background =================
   Ported from Glasshouse's Home tab (MIT, Copyright (c) 2026 Rory Gallagher):
   None, Pictures (a set, or the owner's own for each time of day), Animated,
   and the darkening. Saved as launcher.background (POST /api/settings); the
   pictures have their own routes under /api/launcher/wallpapers. */

let wallpapers = null;         // GET /api/launcher/wallpapers
let wallBusy = '';             // 'upload:<slot>' or 'set:<name>' while this page waits on the server
let wallDarkDragging = false;

const bgCfg = () => (launcherCfg().background) || {};
const WALL_SLOTS = [
  { key: 'morning', name: 'Morning', from: 6, to: 11, sample: [8, 30] },
  { key: 'afternoon', name: 'Afternoon', from: 11, to: 17, sample: [14, 0] },
  { key: 'evening', name: 'Evening', from: 17, to: 21, sample: [19, 30] },
  { key: 'night', name: 'Night', from: 21, to: 6, sample: [23, 10] },
];
const BG_KINDS = [['none', 'None'], ['pictures', 'Pictures'], ['animated', 'Animated']];
const WALL_SETS = [['landscape', 'Landscape'], ['abstract', 'Abstract'], ['own', 'Your own']];
const BG_ANIMS = [['waves', 'Light waves'], ['particles', 'Particles'], ['aquarium', 'Aquarium'], ['aurora', 'Aurora'],
  ['glow', 'Glow'], ['constellations', 'Constellations'], ['ripples', 'Ripples']];
// The colour presets, as the launcher draws them (launcher.js ANIM_THEMES).
const BG_THEMES = [
  { id: 'time', name: 'Time of day' },
  { id: 'night_blue', name: 'Night blue', sky: '#0a1f5c', light: '#4f8dff' },
  { id: 'sunset', name: 'Sunset', sky: '#3a0f3d', light: '#ff8a4c' },
  { id: 'emerald', name: 'Emerald', sky: '#04342e', light: '#3ee0b0' },
  { id: 'ember', name: 'Ember', sky: '#3a0808', light: '#ff5a3c' },
  { id: 'silver', name: 'Silver', sky: '#15181e', light: '#d8dee8' },
];

async function loadWallpapers() {
  try { wallpapers = await api('/api/launcher/wallpapers'); } catch (e) { wallpapers = null; }
  renderBackground();
}

async function saveBackground(patch) {
  if (!(await saveSettings({ launcher: { background: patch } }))) return false;
  await loadWallpapers();
  return true;
}

function wallTime(hr, m) { return String(hr % 24).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0'); }

function wallNowSlot() {
  const hr = new Date().getHours();
  return WALL_SLOTS.find(w => w.from < w.to ? hr >= w.from && hr < w.to : hr >= w.from || hr < w.to).key;
}

function wallUrl(key) {
  return '/launcher/wallpaper?slot=' + key + '&v=' + encodeURIComponent((wallpapers && wallpapers.revision) || '');
}

function renderBackground() {
  if (!$('#home-bg-kind') || !settings) return;
  const bg = bgCfg(), kind = bg.kind || 'none';
  const idle = !wallBusy && !(wallpapers && wallpapers.busy);
  const kindBox = $('#home-bg-kind');
  kindBox.textContent = '';
  for (const [k, label] of BG_KINDS) {
    const b = h('button', { type: 'button', class: k === kind ? 'on' : '', 'aria-pressed': String(k === kind), text: label });
    b.disabled = !idle;
    b.addEventListener('click', () => chooseBackgroundKind(k));
    kindBox.append(b);
  }
  $('#home-bg-pictures').hidden = kind !== 'pictures';
  $('#home-bg-animated').hidden = kind !== 'animated';
  $('#home-dark').hidden = kind === 'none';
  if (kind === 'pictures') renderWallpapers(bg);
  if (kind === 'animated') renderAnimated(bg);
  if (!wallDarkDragging) showWallDarkening(typeof bg.darkening === 'number' ? bg.darkening : 100);
}

function chooseBackgroundKind(kind) {
  const bg = bgCfg();
  if (kind === (bg.kind || 'none') || wallBusy) return;
  const have = bg.pictures === 'own' || (wallpapers && wallpapers.sets && wallpapers.sets[bg.pictures]);
  if (kind === 'pictures' && !have) return chooseWallSet(bg.pictures || 'landscape');
  saveBackground({ kind });
}

/* A set is downloaded to the TV the first time it is chosen; the other is removed. */
async function chooseWallSet(name) {
  if (wallBusy || (wallpapers && wallpapers.busy)) return;
  const bg = bgCfg();
  if (name === 'own') return saveBackground({ kind: 'pictures', pictures: 'own' });
  if (bg.kind === 'pictures' && bg.pictures === name && wallpapers && wallpapers.sets && wallpapers.sets[name]) return;
  const note = $('#home-wall-note');
  note.textContent = '';
  wallBusy = 'set:' + name;
  renderBackground();
  try { await api('/api/launcher/wallpapers/set', { method: 'POST', body: { set: name } }); }
  catch (e) { note.textContent = e.message; }
  finally {
    wallBusy = '';
    await loadSettings();
    await loadWallpapers();
  }
}

function renderWallpapers(bg) {
  const walls = wallpapers || {};
  const has = walls.slots || {};
  const choice = bg.pictures || 'landscape';
  const own = choice === 'own';
  const busy = !!wallBusy || !!walls.busy;
  const getting = /^set:/.test(wallBusy) ? wallBusy.slice(4) : '';
  const now = wallNowSlot();

  const choiceBox = $('#home-wall-choice');
  choiceBox.textContent = '';
  for (const [name, label] of WALL_SETS) {
    const b = h('button', { type: 'button', class: name === choice ? 'on' : '', 'aria-pressed': String(name === choice),
      text: name === getting ? 'Downloading…' : label });
    b.disabled = busy;
    b.addEventListener('click', () => chooseWallSet(name));
    choiceBox.append(b);
  }
  $('#home-wall-help').hidden = !own;
  $('#home-wall-clear').hidden = !own;
  $('#home-wall-clear').disabled = busy || !(walls.own && Object.values(walls.own).some(Boolean));

  const parts = [['night', 0, 6], ['morning', 6, 11], ['afternoon', 11, 17], ['evening', 17, 21], ['night', 21, 24]];
  const d = new Date();
  const at = (d.getHours() + d.getMinutes() / 60) / 24 * 100;
  const day = $('#home-wall-day');
  day.textContent = '';
  const bar = h('div', { class: 'wall-day-bar' });
  for (const [key, from, to] of parts) {
    const name = WALL_SLOTS.find(w => w.key === key).name;
    const b = h('button', { type: 'button', class: 'wall-day-part' + (has[key] ? ' has' : '') + (key === now ? ' now' : ''), 'data-slot': key,
      title: name, 'aria-label': name,
      style: 'flex:' + (to - from) + (has[key] ? ";background-image:url('" + wallUrl(key) + "')" : '') });
    b.disabled = busy || !own;
    if (own) b.addEventListener('click', () => wallChoose(key)); else b.tabIndex = -1;
    bar.append(b);
  }
  bar.append(h('span', { class: 'wall-day-needle', style: 'left:' + at.toFixed(2) + '%' }, h('b', { text: 'Now' })));
  day.append(bar, h('div', { class: 'wall-day-scale' }, [0, 6, 12, 18, 24].map(hr => h('span', { style: 'left:' + hr / 24 * 100 + '%', text: wallTime(hr, 0) }))));

  const box = $('#home-walls');
  box.textContent = '';
  for (const w of WALL_SLOTS) {
    const key = w.key, set = !!has[key];
    const sending = wallBusy === 'upload:' + key || !!getting;
    const screen = h('button', { type: 'button', class: 'wall-screen', 'aria-label': 'Choose a picture for ' + w.name,
      style: set ? "background-image:url('" + wallUrl(key) + "')" : false },
      h('span', { class: 'wall-clock', text: wallTime(w.sample[0], w.sample[1]) }),
      h('span', { class: 'wall-row', text: 'Apps' }), h('i'),
      set || !own ? null : h('span', { class: 'wall-add', text: 'Add a picture' }),
      key === now ? h('span', { class: 'wall-badge', text: 'Now' }) : null,
      sending ? h('span', { class: 'wall-sending', text: getting ? 'Downloading…' : 'Uploading…' }) : null);
    screen.disabled = busy || !own;
    if (own) screen.addEventListener('click', () => wallChoose(key)); else screen.tabIndex = -1;
    const actions = h('div', { class: 'wall-actions' });
    if (set && own) {
      const replace = h('button', { type: 'button', class: 'wall-link', text: 'Replace' });
      const remove = h('button', { type: 'button', class: 'wall-link', text: 'Remove' });
      replace.disabled = remove.disabled = busy;
      replace.addEventListener('click', () => wallChoose(key));
      remove.addEventListener('click', () => wallRemove({ slot: key }));
      actions.append(replace, remove);
    }
    box.append(h('div', { class: 'wall-card' + (set ? ' has' : '') + (key === now ? ' now' : '') + (own ? '' : ' fixed'), 'data-slot': key },
      screen,
      h('div', { class: 'wall-meta' }, h('span', { class: 'wall-name', text: w.name }), h('span', { class: 'wall-hours', text: wallTime(w.from, 0) + ' – ' + wallTime(w.to, 0) })),
      actions));
  }
  // An image dropped on a time of day, or on its part of the strip, is its picture.
  $$('#home-walls .wall-screen, #home-wall-day .wall-day-part').forEach(el => {
    const slot = el.closest('[data-slot]').dataset.slot;
    el.addEventListener('dragover', e => { if (busy || !own) return; e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file && !busy && own) uploadWallpaper(slot, file);
    });
  });
}

let wallSlotPicking = null;
function wallChoose(key) {
  if (wallBusy) return;
  wallSlotPicking = key;
  const input = $('#home-wall-file');
  input.value = '';
  input.click();
}

/* The browser scales the picture to fit 1920 x 1080 and saves it as a JPEG; the server checks it again. */
async function uploadWallpaper(slot, file) {
  if (!file || wallBusy) return;
  const note = $('#home-wall-note');
  wallBusy = 'upload:' + slot;
  note.textContent = '';
  renderBackground();
  let url;
  try {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) throw new Error('Choose a JPEG, PNG or WebP image up to 25 MB.');
    url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('The image could not be opened.'));
      img.src = url;
    });
    const scale = Math.min(1, 1920 / img.naturalWidth, 1080 / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob || blob.size > 5 * 1024 * 1024) throw new Error('The prepared image is too large. Choose a smaller image.');
    const headers = { 'Content-Type': 'image/jpeg' };
    const tk = store.get(TOKEN_KEY);
    if (tk) headers['X-Cactarium-Token'] = tk;
    const res = await fetch('/api/launcher/wallpapers/upload?slot=' + slot, { method: 'POST', headers, body: blob });
    let r = null;
    try { r = await res.json(); } catch (_) { /* empty body */ }
    if (res.status === 401) { askToken(); throw new Error('Access token required'); }
    if (!res.ok) throw new Error((r && r.error) || 'The image could not be uploaded.');
    note.textContent = 'Image uploaded. The launcher shows it the next time it opens.';
  } catch (e) { note.textContent = e.message; }
  finally {
    if (url) URL.revokeObjectURL(url);
    wallBusy = '';
    await loadSettings();
    await loadWallpapers();
  }
}

async function wallRemove(body) {
  if (wallBusy) return;
  $('#home-wall-note').textContent = '';
  try { await api('/api/launcher/wallpapers/remove', { method: 'POST', body }); }
  catch (e) { $('#home-wall-note').textContent = e.message; }
  await loadWallpapers();
}

function renderAnimated(bg) {
  const anim = bg.animation || 'waves', colours = bg.colours || 'time';
  const scenes = $('#home-anim-scenes');
  scenes.textContent = '';
  for (const [k, label] of BG_ANIMS) {
    const b = h('button', { type: 'button', class: k === anim ? 'on' : '', 'aria-pressed': String(k === anim), text: label });
    b.addEventListener('click', () => { if (k !== anim) saveBackground({ animation: k }); });
    scenes.append(b);
  }
  const own = bg.own_colours || { background: '#0a1f5c', light: '#4f8dff' };
  const box = $('#home-anim-themes');
  box.textContent = '';
  for (const th of BG_THEMES.concat([{ id: 'own', name: 'Your own', sky: own.background, light: own.light }])) {
    const line = th.light || '#7fb4ff';
    const sample = th.sky ? 'background:linear-gradient(#000,' + th.sky + ')' : 'background:linear-gradient(90deg,#3a1a10,#0b3456 35%,#2a0f40 70%,#0a1a4a)';
    const b = h('button', { type: 'button', class: 'home-look' + (colours === th.id ? ' picked' : ''), 'aria-pressed': String(colours === th.id) },
      h('span', { class: 'home-look-screen', style: sample }, h('span', { class: 'home-anim-band', style: 'background:' + line + ';color:' + line })),
      h('span', { class: 'home-look-name', text: th.name }));
    b.addEventListener('click', () => { if (colours !== th.id) saveBackground({ colours: th.id }); });
    box.append(b);
  }
  const sky = $('#home-anim-sky'), light = $('#home-anim-light');
  if (document.activeElement !== sky) sky.value = own.background;
  if (document.activeElement !== light) light.value = own.light;
}

function showWallDarkening(v) {
  const slider = $('#home-dark-slider');
  slider.value = v;
  slider.style.setProperty('--pct', v + '%');
  setText($('#home-dark-lbl'), v === 0 ? 'Off' : v + '%');
}

function initBackground() {
  $('#home-wall-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file && wallSlotPicking) uploadWallpaper(wallSlotPicking, file);
  });
  $('#home-wall-clear').addEventListener('click', () => wallRemove({ all: true }));
  const custom = () => saveBackground({ colours: 'own', own_colours: { background: $('#home-anim-sky').value, light: $('#home-anim-light').value } });
  $('#home-anim-sky').addEventListener('change', custom);
  $('#home-anim-light').addEventListener('change', custom);
  const slider = $('#home-dark-slider');
  slider.addEventListener('input', () => { wallDarkDragging = true; showWallDarkening(Number(slider.value)); });
  // Saved on release, not on every step of the drag.
  slider.addEventListener('change', async () => {
    await saveBackground({ darkening: Number(slider.value) });
    wallDarkDragging = false;
    renderBackground();
  });
}
