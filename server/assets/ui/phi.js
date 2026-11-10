// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The bridge to the TV's own settings UI (PHI): POST /api/tv/phi {method, params}.

/* PHI is frozen while a web app runs, so the server answers 504; the tabs then
   show a quiet "not available while an app is open" note instead of an error. */
class PhiBusy extends Error {}

async function phi(method, params) {
  try {
    const r = await api('/api/tv/phi', { method: 'POST', body: { method, params: params || {} } });
    return r && 'result' in r ? r.result : r;
  } catch (e) {
    if (e.status === 504) throw new PhiBusy(e.message);
    throw e;
  }
}

/* Runs fn(), and shows the busy note (instead of an error) when PHI is frozen.
   Returns undefined on failure; errMsg is where other errors are written. */
async function phiGuard(fn, busyEl, errEl) {
  try {
    const r = await fn();
    if (busyEl) busyEl.hidden = true;
    if (errEl) errEl.textContent = '';
    return r;
  } catch (e) {
    if (e instanceof PhiBusy) { if (busyEl) busyEl.hidden = false; }
    else if (errEl) errEl.textContent = e.message;
    else toast(e.message);
    return undefined;
  }
}

/* A button that stays a button and reads its state: Glasshouse's on/off pill. */
function setPill(btn, on, labels) {
  const l = labels || ['On', 'Off'];
  btn.textContent = on ? l[0] : l[1];
  btn.classList.toggle('good', !!on);
  btn.classList.toggle('idle', !on);
}

/* One Glasshouse row: title, description and a control on the right. */
function protRow(title, desc, control, extra) {
  return h('div', { class: 'prot-row' + (extra ? ' ' + extra : '') },
    h('div', { class: 'prot-main' }, h('div', { class: 'prot-title', text: title }), desc ? h('div', { class: 'prot-desc', text: desc }) : null),
    h('div', { class: 'prot-status' }, control));
}

/* A row whose control is an on/off pill; flip(next) is called on press and returns true when it took. */
function toggleRow(title, desc, on, flip) {
  const b = h('button', { type: 'button', class: 'pill idle' });
  setPill(b, on);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { if (await flip(!on)) { on = !on; setPill(b, on); } } finally { b.disabled = false; }
  });
  return protRow(title, desc, b);
}

function rangeRow(title, desc, value, min, max, commit) {
  const num = h('span', { class: 'num', text: String(value) });
  const inp = h('input', { type: 'range', min, max, step: 1, value, 'aria-label': title });
  const paint = () => { inp.style.setProperty('--pct', clamp((inp.value - min) / (max - min || 1), 0, 1) * 100 + '%'); num.textContent = inp.value; };
  paint();
  let t = 0;
  inp.addEventListener('input', () => { paint(); clearTimeout(t); t = setTimeout(() => commit(Number(inp.value)), 250); });
  return protRow(title, desc, h('div', { class: 'rng' }, inp, num));
}

function selectRow(title, desc, options, current, commit) {
  const sel = h('select', { class: 'pill-sel', 'aria-label': title });
  for (const [v, label] of options) sel.append(h('option', { value: v, text: label }));
  sel.value = String(current);
  sel.addEventListener('change', () => commit(sel.value));
  return protRow(title, desc, sel);
}

/* A read-only value, drawn with the dashed edge Glasshouse uses for what cannot be pressed. */
function fixedRow(title, desc, text) {
  return protRow(title, desc, h('button', { type: 'button', class: 'pill idle fixed', disabled: true, text }), 'na');
}
