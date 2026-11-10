// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Audio tab: volume (JointSpace) and the TV's sound settings (PHI bridge).

let audVolTimer = 0, audVolDragUntil = 0;

function initAudio() {
  $('#audVolDown').addEventListener('click', () => { buzz(); cmd('/api/volume', { step: -1 }); });
  $('#audVolUp').addEventListener('click', () => { buzz(); cmd('/api/volume', { step: 1 }); });
  $('#audMute').addEventListener('click', () => { buzz(); cmd('/api/volume', { muted: !(S && S.tv.volume && S.tv.volume.muted) }); });
  const slider = $('#audVolSlider');
  slider.addEventListener('input', () => {
    audVolDragUntil = Date.now() + 1200;
    paintAudioVolume(Number(slider.value));
    clearTimeout(audVolTimer);
    audVolTimer = setTimeout(() => {
      cmd('/api/volume', { current: Number(slider.value) }).then(() => { audVolDragUntil = Date.now() + 400; });
    }, 150);
  });
}

function paintAudioVolume(cur) {
  const slider = $('#audVolSlider');
  const min = Number(slider.min), max = Number(slider.max) || 1;
  slider.style.setProperty('--pct', clamp((cur - min) / (max - min), 0, 1) * 100 + '%');
  setText($('#audVolNum'), cur);
}

function renderAudioVolume() {
  const v = S && S.tv.volume;
  if (!v) return;
  const slider = $('#audVolSlider');
  slider.min = v.min ?? 0;
  slider.max = v.max ?? 60;
  if (Date.now() > audVolDragUntil) { slider.value = v.current; paintAudioVolume(v.current); }
  $('#audVolNum').classList.toggle('muted-on', !!v.muted);
  $('#audMute').setAttribute('aria-pressed', !!v.muted);
  setText($('#audMuteLabel'), v.muted ? 'Muted' : 'Mute');
}

async function loadAudio() {
  renderAudioVolume();
  const d = await phiGuard(() => phi('RpcSoundRetrieve'), $('#audBusy'), $('#audErr'));
  const host = $('#audio-settings');
  host.textContent = '';
  if (!d) return;
  // Each setter is the one the TV's own settings UI calls (phi_page/lib/core.js:21274-21850).
  const set = (method, key) => async v => {
    const r = await phiGuard(() => phi(method, { [key]: v }), $('#audBusy'), $('#audErr'));
    if (r === undefined) setTimeout(loadAudio, 300);
    return r !== undefined;
  };
  const styles = (d.modeScheme || []).map(m => [String(m.id), m.mode]);
  const rows = [];
  if (styles.length) rows.push(selectRow('Sound style', 'The TV\'s sound preset.', styles, d.style, v => set('RpcSoundStyleSet', 'style')(Number(v))));
  rows.push(
    toggleRow('Clear dialogue', 'Makes speech easier to hear.', !!d.clearDialogue, on => set('RpcSoundClearDialogueSet', 'switch')(on ? 1 : 0)),
    toggleRow('Dolby Atmos', 'Spatial sound, where the content carries it.', !!d.dolbyAtmos, on => set('RpcSoundDolbyAtmosSet', 'mode')(on ? 1 : 0)),
    toggleRow('AI equalizer', 'Tunes the sound to what is playing.', !!d.AIEQSwitch, on => set('RpcSoundAiequalzerSet', 'switch')(on ? 1 : 0)));
  host.append(h('div', { class: 'prot-table' }, rows));
}
