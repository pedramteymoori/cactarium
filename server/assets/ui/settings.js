// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The saved settings (GET and POST /api/settings), shared by the Home, System, MQTT and Server tabs.

let settings = null;

/* Loads the settings and tells the tab that is open to redraw. */
async function loadSettings() {
  try {
    settings = await api('/api/settings');
    if (typeof onSettingsLoaded === 'function') onSettingsLoaded();
  } catch (e) { toast(e.message); }
  return settings;
}

/* POST /api/settings with a patch; true on success, then reloads. */
async function saveSettings(patch, quiet) {
  if (!(await cmdSoft('/api/settings', patch))) return false;
  if (!quiet) toast('Saved', false);
  await loadSettings();
  return true;
}

/* POST that returns true on success; state bodies are applied when present. */
async function cmdSoft(path, body) {
  try {
    const r = await api(path, { method: 'POST', body: body || {} });
    if (r && r.tv) applyState(r);
    return true;
  } catch (e) { toast(e.message); return false; }
}

function onSettingsLoaded() {
  if (activeTab === 'home') renderHome();
  if (activeTab === 'advanced') renderAdvancedName();
  if (activeTab === 'mqtt') renderMqtt();
  if (activeTab === 'server') renderServer();
}
