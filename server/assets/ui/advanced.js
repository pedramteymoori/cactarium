// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The System tab: timers, HDMI, the TV's name and its system information.

function initAdvanced() {
  $('#advNameForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#setName').value.trim();
    if (name) saveSettings({ name });
  });
}

function renderAdvancedName() {
  if (settings && document.activeElement !== $('#setName')) $('#setName').value = settings.name || '';
}

async function loadAdvanced() {
  loadSettings();
  if (S) renderTvSystem(S.tv.system);
  const cfg = await phiGuard(() => phi('RpcGeneralSrttingConfigRetrieve'), $('#advBusy'), $('#advErr'));
  const power = $('#adv-power'), hdmi = $('#adv-hdmi');
  power.textContent = '';
  hdmi.textContent = '';
  if (!cfg) return;

  // RpcGeneralSwitchOffTimerSet {index}: only index 0 (off) is known from the TV's own page (pages/base/shim.js:1659).
  const offBtn = h('button', { type: 'button', class: 'pill idle', text: cfg.switchOffTimer ? 'Turn off' : 'Off' });
  offBtn.disabled = !cfg.switchOffTimer;
  offBtn.addEventListener('click', async () => {
    const r = await phiGuard(() => phi('RpcGeneralSwitchOffTimerSet', { index: 0 }), $('#advBusy'), $('#advErr'));
    if (r !== undefined) loadAdvanced();
  });
  power.append(
    protRow('Switch-off timer', cfg.switchOffTimer ? 'The TV switches itself off after the time set on the TV (setting ' + cfg.switchOffTimer + '). Set a new time in the TV\'s own settings.' : 'Off. Set a time in the TV\'s own settings.', offBtn),
    fixedRow('No-signal timer', 'Switches the TV off after a while with no signal. Change it in the TV\'s own settings.', cfg.nosignalTimer ? 'Setting ' + cfg.nosignalTimer : 'Off'));

  // RpcGeneralEasyLinkRemoteControlSet {switch}, phi_page/pages/sources/hdmi.js:406.
  hdmi.append(
    toggleRow('EasyLink remote control', 'Lets the TV\'s remote control devices connected over HDMI-CEC.', !!cfg.easyLinkRC, async on => {
      const r = await phiGuard(() => phi('RpcGeneralEasyLinkRemoteControlSet', { switch: on ? 1 : 0 }), $('#advBusy'), $('#advErr'));
      return r !== undefined;
    }),
    fixedRow('Auto movie mode', 'Picks the Movie picture style for film content. Change it in the TV\'s own settings.', cfg.AutoMovieMode ? 'On' : 'Off'));
  for (const p of cfg.HDMIUltraHD || []) {
    hdmi.append(fixedRow('HDMI ' + (Number(p.index) + 1) + ' Ultra HD', 'HDMI Ultra HD mode of this port. Change it in the TV\'s own settings.', 'Mode ' + p.mode));
  }
}

function flatten(o, prefix = '', out = []) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (k.endsWith('_encrypted')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
  }
  return out;
}
let lastTvSys = '';
function renderTvSystem(sys) {
  const rows = flatten(sys);
  const sig = JSON.stringify(rows);
  if (sig === lastTvSys) return;
  lastTvSys = sig;
  const dl = $('#sysTv');
  dl.textContent = '';
  if (!rows.length) { dl.append(h('dt', { text: 'No data' }), h('dd')); return; }
  for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', { text: v }));
}
