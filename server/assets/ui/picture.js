// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Picture tab: the TV's picture style and its basic settings, through the PHI bridge.

/* English names for the picture style ids PHI reports (the TV's own settings UI shows these). */
const PIC_LABELS = {
  MAIN_PIC_PERSONAL: 'Personal', MAIN_CRYSTAL_CLEAR: 'Crystal clear', MAIN_HOME_CINEMA: 'Home cinema',
  MISC_ECO: 'Eco', MAIN_PIC_MOVIE: 'Movie', MAIN_PIC_GAME: 'Game', MAIN_PIC_VIVID: 'Vivid',
  MAIN_PIC_NATURAL: 'Natural', MAIN_PIC_STANDARD: 'Standard', MISC_FILMMAKER: 'Filmmaker mode',
  MAIN_CALMAN: 'Calman', MAIN_HOME_CINEMA_DOLBY_VISION_BRIGHT: 'Dolby Vision bright',
  MAIN_MOVIE_DOLBY_VISION_DARK: 'Dolby Vision dark',
};
function picLabel(name) {
  if (PIC_LABELS[name]) return PIC_LABELS[name];
  const t = String(name || '').replace(/^(MAIN|MISC|PIC)_/, '').replace(/^PIC_/, '').replace(/_/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '--';
}

/* RpcPictureGroupPictureRootGet -> {currentMode:{id,name}, modeScheme:[{id,name}]} */
async function loadPictureRoot() {
  const r = await phi('RpcPictureGroupPictureRootGet');
  const root = r && r.groupPictureRootData;
  if (!root || !root.currentMode) throw new Error('The TV did not report its picture style');
  return root;
}

let picLoading = false;

async function loadPicture() {
  if (picLoading) return;
  picLoading = true;
  const busy = $('#picBusy'), err = $('#picErr');
  const data = await phiGuard(async () => {
    const [root, contrast, colour, sharp, format] = await Promise.all([
      loadPictureRoot(),
      phi('RpcPictureGroupContrastGet'), phi('RpcPictureGroupColorGet'), phi('RpcPictureGroupSharpnessGet'),
      phi('RpcPictureFormatGet'),
    ]);
    return {
      root, contrast: (contrast && contrast.groupContrastData) || {}, colour: (colour && colour.groupColorData) || {},
      sharp: (sharp && sharp.groupSharpnessData) || {}, format: (format && format.format) || {},
    };
  }, busy, err);
  picLoading = false;
  $('#pic-now').hidden = !data;
  if (!data) { $('#pic-groups').textContent = ''; return; }
  renderPicture(data);
}

function renderPicture(d) {
  setText($('#pic-mode'), picLabel(d.root.currentMode.name));
  const sel = $('#pic-mode-sel');
  sel.textContent = '';
  for (const m of d.root.modeScheme || []) sel.append(h('option', { value: m.id, text: picLabel(m.name) }));
  sel.value = String(d.root.currentMode.id);

  const again = () => setTimeout(loadPicture, 300);
  // Each setter is the one the TV's own settings UI calls (phi_page/lib/core.js:26486-26560).
  const set = (method, params) => async v => {
    const r = await phiGuard(() => phi(method, { [params]: v }), $('#picBusy'), $('#picErr'));
    if (r === undefined) again();
    return r !== undefined;
  };
  const g = $('#pic-groups');
  g.textContent = '';
  g.append(
    h('div', { class: 'pic-sec' },
      h('div', { class: 'pv-sec', text: 'Picture' }),
      h('div', { class: 'prot-table' },
        rangeRow('Contrast', 'The backlight contrast of this picture style.', d.contrast.backlightContrast ?? 0, 0, 100, set('RpcPictureConstrastSet', 'constrast')),
        rangeRow('Brightness', 'The black level of this picture style.', d.contrast.blackLevel ?? 0, 0, 100, set('RpcPictureBrightnessSet', 'brightness')),
        rangeRow('Colour', 'Colour saturation.', d.colour.saturation ?? 0, 0, 100, set('RpcPictureColourSet', 'colour')),
        rangeRow('Sharpness', 'Edge enhancement.', d.sharp.sharpness ?? 0, 0, 10, set('RpcPictureSharpnessSet', 'sharpness')),
        toggleRow('Ambient light sensor', 'Adjusts the picture to the light in the room.', !!d.contrast.lightSensor,
          on => set('RpcPictureLightSensorSet', 'sensor')(on ? 1 : 0)),
        fixedRow('Picture format', 'How the picture fills the screen. Change it with the remote\'s Format key.',
          (d.format.currentAspectRatio && d.format.currentAspectRatio.name) || '--'))));
}


function initPicture() {
  $('#pic-mode-sel').addEventListener('change', async e => {
    const r = await phiGuard(() => phi('RpcPictureStyleSet', { mode: Number(e.target.value) }), $('#picBusy'), $('#picErr'));
    if (r !== undefined) setTimeout(loadPicture, 300); else loadPicture();
  });
}
