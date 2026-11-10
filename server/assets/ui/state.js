// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// Live state: polling /api/state and the masthead and banners.

/* ================= state ================= */
let S = null;
let stateTimer = 0;

function applyState(s) {
  S = s;
  renderHeader();
  renderBanners();
  renderControl();
  renderAmbPower();
  if (activeTab === 'metrics') renderMetrics(s.stats);
  if (activeTab === 'advanced') renderTvSystem(s.tv.system);
  if (activeTab === 'audio') renderAudioVolume();
  if (activeTab === 'server') renderServer();
  if (activeTab === 'mqtt') renderMqttStatus();
}

async function pollState() {
  clearTimeout(stateTimer);
  if (!document.hidden) {
    try { applyState(await api('/api/state')); } catch (_) { /* banner handles it */ }
  }
  stateTimer = setTimeout(pollState, 3000);
}

function renderHeader() {
  const name = (S && S.name) || '';
  const model = (S && S.tv && S.tv.model) || '';
  // As Glasshouse: the model under the logo; the state over what is on screen
  // on the left, the volume on the right.
  setText($('#navTv'), model || name);
  setText($('#version'), S && S.version ? (/^\d/.test(S.version) ? 'v' : '') + S.version : '');
  document.title = name ? 'Cactarium \u00b7 ' + name : 'Cactarium';
  const dot = $('#hdrDot');
  let cls = '', txt = 'Connecting';
  const awake = !!S && !offline && S.tv.reachable;
  if (offline) { cls = 'bad'; txt = 'Offline'; }
  else if (S) {
    if (!S.tv.reachable) { cls = 'bad'; txt = 'Unreachable'; }
    else if (S.tv.power === 'On') { cls = 'on'; txt = 'On'; }
    else { cls = 'off'; txt = S.tv.power === 'Standby' ? 'Standby' : (S.tv.power || 'Unknown'); }
  }
  dot.className = 'dot ' + cls;
  setText($('#hdrText'), txt);

  // What is on screen, from the PHI bridge; absent while a web app has PHI frozen.
  const src = awake && S.tv.source && S.tv.source.label;
  // With nothing known about the screen, the headline is the TV's name, as in Glasshouse.
  setText($('#hdrSource'), src || name || '\u2014');
  // JointSpace's screenstate says "Off" while the picture is on, so it is not shown.
  const vol = awake && S.tv.volume && typeof S.tv.volume.current === 'number' && S.tv.volume.max > 0 ? S.tv.volume : null;
  $('#hdrVolume').hidden = !vol;
  setText($('#hdrVolume'), vol ? (vol.muted ? 'Muted' : 'Volume ' + vol.current) : '');
}

function renderBanners() {
  const tv = S && S.tv;
  $('#bannerTv').hidden = !(tv && !tv.reachable);
  setText($('#bannerTvErr'), tv && tv.error ? ' (' + tv.error + ')' : '');
  $('#bannerPair').hidden = !(tv && !tv.paired);
}
