// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Control tab: panel, source, playback, volume, the remote, picture styles, apps, power and reboot.

/* ================= control ================= */
let volDragUntil = 0;
let volTimer = 0;

function initControl() {
  $$('[data-icon]').forEach(el => setIcon(el, el.dataset.icon));

  // Immediate pressed feedback and vibration for every key.
  document.addEventListener('pointerdown', e => {
    const k = e.target.closest('.key');
    if (!k) return;
    k.classList.add('pressed');
    const off = () => k.classList.remove('pressed');
    k.addEventListener('pointerup', off, { once: true });
    k.addEventListener('pointercancel', off, { once: true });
    k.addEventListener('pointerleave', off, { once: true });
  });

  $$('[data-key]').forEach(b => b.addEventListener('click', () => { buzz(); sendKey(b.dataset.key); }));

  $('#btnPower').addEventListener('click', () => {
    buzz();
    const on = S && S.tv.power === 'On';
    cmd('/api/power', { state: on ? 'Standby' : 'On' });
  });

  $('#volDown').addEventListener('click', () => { buzz(); cmd('/api/volume', { step: -1 }); });
  $('#volUp').addEventListener('click', () => { buzz(); cmd('/api/volume', { step: 1 }); });
  $('#btnMute').addEventListener('click', () => {
    buzz();
    cmd('/api/volume', { muted: !(S && S.tv.volume && S.tv.volume.muted) });
  });
  const slider = $('#volSlider');
  slider.addEventListener('input', () => {
    volDragUntil = Date.now() + 1200;
    paintVolume(Number(slider.value));
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      buzz();
      cmd('/api/volume', { current: Number(slider.value) }).then(() => { volDragUntil = Date.now() + 400; });
    }, 150);
  });

  $('#btnScreenOff').addEventListener('click', () => setScreen(true));
  $('#btnScreenOn').addEventListener('click', () => setScreen(false));
  $('#btnReboot').addEventListener('click', async () => {
    if (!confirm('Reboot the TV now? It will be unavailable for about a minute.')) return;
    if (await cmdSoft('/api/tv/reboot')) toast('Rebooting', false);
  });

  const pad = $('#numpad');
  for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
    const b = h('button', { class: 'key', 'data-key': 'Digit' + d, text: String(d) });
    b.addEventListener('click', () => { buzz(); sendKey('Digit' + d); });
    if (d === 0) pad.append(h('span'), b, h('span')); else pad.append(b);
  }

  document.addEventListener('keydown', onKeyboard);
}

function paintVolume(cur) {
  const slider = $('#volSlider');
  const min = Number(slider.min), max = Number(slider.max) || 1;
  slider.style.setProperty('--pct', clamp((cur - min) / (max - min), 0, 1) * 100 + '%');
  setText($('#volNum'), cur);
}

function renderControl() {
  const tv = S.tv;
  const on = tv.power === 'On';
  const pb = $('#btnPower');
  pb.setAttribute('aria-pressed', on);
  // The label says what a press does; the header pill already shows the state.
  setText($('#powerLabel'), tv.power ? (on ? 'Standby' : 'Turn on') : 'Power');
  const v = tv.volume;
  if (v) {
    const slider = $('#volSlider');
    slider.min = v.min ?? 0;
    slider.max = v.max ?? 60;
    if (Date.now() > volDragUntil) { slider.value = v.current; paintVolume(v.current); }
    $('#volNum').classList.toggle('muted-on', !!v.muted);
    const mb = $('#btnMute');
    mb.setAttribute('aria-pressed', !!v.muted);
    setText($('#muteLabel'), v.muted ? 'Muted' : 'Mute');
  }
}

function onKeyboard(e) {
  if (activeTab !== 'control' || document.body.classList.contains('nav-open') || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#tokenDlg').open) return;
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const map = {
    ArrowUp: 'CursorUp', ArrowDown: 'CursorDown', ArrowLeft: 'CursorLeft', ArrowRight: 'CursorRight',
    Backspace: 'Back', Escape: 'Back', h: 'Home', H: 'Home',
  };
  let key = map[e.key];
  if (e.key === 'Enter') {
    if (t && t.closest && t.closest('button, summary, a')) return; // let the focused control activate itself
    key = 'Confirm';
  } else if (e.key === 'm' || e.key === 'M') {
    cmd('/api/volume', { muted: !(S && S.tv.volume && S.tv.volume.muted) }); e.preventDefault(); return;
  } else if (e.key === '+' || e.key === '=') {
    cmd('/api/volume', { step: 1 }); e.preventDefault(); return;
  } else if (e.key === '-' || e.key === '_') {
    cmd('/api/volume', { step: -1 }); e.preventDefault(); return;
  }
  if (key) { e.preventDefault(); sendKey(key); }
}

/* Panel: RpcScreenOff {switch}, phi_page/lib/core.js:15508. */
async function setScreen(off) {
  buzz();
  const r = await phiGuard(() => phi('RpcScreenOff', { switch: off ? 1 : 0 }), $('#screenBusy'));
  if (r !== undefined) pollState();
}

function startControl() {
  loadSources();
  loadCtlPictureModes();
  loadCtlApps();
}

/* Source: JointSpace refuses /6/sources on TitanOS (403), so the list and the
   switch go through the bridge, as the launcher's Inputs row does: "sources"
   answers {sources:[{typeId,name,sub,kind,connected,current}]}, "source" takes
   {typeId}. */
async function loadSources() {
  const host = $('#inputs'), note = $('#inputsNote');
  note.textContent = '';
  const src = await phiGuard(() => phi('sources'), null, note);
  host.textContent = '';
  const list = (src && src.sources) || [];
  if (!list.length && !note.textContent) note.textContent = src ? 'The TV does not list its sources.' : 'Not available while an app is open.';
  note.hidden = !note.textContent;
  for (const it of list) {
    const label = it.sub ? it.name + ' (' + it.sub + ')' : it.name;
    const b = h('button', { class: 'key', type: 'button', text: label, 'aria-pressed': !!it.current });
    if (it.connected === false) b.classList.add('idle');
    b.addEventListener('click', async () => {
      buzz();
      const r = await phiGuard(() => phi('source', { typeId: it.typeId }), null);
      if (r !== undefined) $$('#inputs button').forEach(x => x.setAttribute('aria-pressed', x === b));
    });
    host.append(b);
  }
}

/* Picture styles as quick presets (the Picture tab has the rest). */
async function loadCtlPictureModes() {
  const root = await phiGuard(() => loadPictureRoot(), $('#ctlPicBusy'));
  const host = $('#picmodes');
  host.textContent = '';
  if (!root) return;
  setText($('#ctlPicMode'), picLabel(root.currentMode.name));
  setText($('#ctlPicCur'), picLabel(root.currentMode.name));
  for (const m of root.modeScheme || []) {
    const b = h('button', { class: 'key', type: 'button', text: picLabel(m.name), 'aria-pressed': m.id === root.currentMode.id });
    b.addEventListener('click', async () => {
      buzz();
      const r = await phiGuard(() => phi('RpcPictureStyleSet', { mode: m.id }), $('#ctlPicBusy'));
      if (r !== undefined) loadCtlPictureModes();
    });
    host.append(b);
  }
}

async function loadCtlApps() {
  const apps = await fetchLauncherApps().catch(() => null);
  const host = $('#ctlApps');
  host.textContent = '';
  setText($('#ctlAppsCur'), apps ? String(apps.length) : '');
  for (const a of apps || []) {
    const b = h('button', { class: 'key', type: 'button', text: a.name, title: a.name });
    b.addEventListener('click', () => launchApp(a, b));
    host.append(b);
  }
}
