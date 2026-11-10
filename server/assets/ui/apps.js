// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Apps tab: the launcher's apps, each with a Launch button.

let launcherApps = [];

/* GET /api/launcher/apps -> [{code, name, url, app_type, resolution, icon}] */
async function fetchLauncherApps() {
  const r = await api('/api/launcher/apps');
  launcherApps = (r && r.apps) || [];
  return launcherApps;
}

/* Launch goes through the bridge's `launch` pseudo-method with the app item as params. */
async function launchApp(app, btn) {
  buzz();
  if (btn) btn.disabled = true;
  const r = await phiGuard(() => phi('launch', app), $('#appsBusy'), $('#appsErr'));
  if (btn) btn.disabled = false;
  if (r !== undefined) toast('Launching ' + app.name, false);
  else if ($('#appsBusy').hidden === false) toast('Not available while an app is open');
}

function initApps() {}

async function loadAppsTab() {
  const grid = $('#appsGrid');
  grid.setAttribute('aria-busy', 'true');
  let apps = [];
  try { apps = await fetchLauncherApps(); $('#appsErr').textContent = ''; } catch (e) { $('#appsErr').textContent = e.message; }
  grid.textContent = '';
  grid.setAttribute('aria-busy', 'false');
  $('#appsEmpty').hidden = apps.length > 0;
  for (const a of apps) {
    const btn = h('button', { class: 'key', type: 'button', text: 'Launch' });
    btn.addEventListener('click', () => launchApp(a, btn));
    grid.append(h('div', { class: 'app-card' },
      a.icon ? h('img', { src: a.icon, alt: '', loading: 'lazy' }) : h('div', { class: 'app-ico-ph' }),
      h('div', { class: 'nm', text: a.name, title: a.name }),
      btn));
  }
}
