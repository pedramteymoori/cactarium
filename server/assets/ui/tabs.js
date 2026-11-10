// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The tabs: a sidebar on a wide screen, a drawer on a narrow one.

// Same ids as Glasshouse's tabs, in its order; Ambilight is Cactarium's own.
const TABS = ['control', 'metrics', 'apps', 'home', 'picture', 'audio', 'game', 'ambilight', 'advanced', 'mqtt', 'server'];
let activeTab = null;

function showTab(name, fromHash) {
  if (!TABS.includes(name)) name = 'control';
  activeTab = name;
  for (const t of TABS) {
    const sel = t === name;
    const b = $('#tab-' + t);
    b.setAttribute('aria-selected', sel);
    b.tabIndex = sel ? 0 : -1;
    $('#panel-' + t).hidden = !sel;
  }
  showNavCurrent();
  closeNav();
  store.set('cactarium.tab', name);
  if (!fromHash && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  stopAmb(); stopMetrics();
  if (name === 'control') startControl();
  if (name === 'metrics') startMetrics();
  if (name === 'apps') loadAppsTab();
  if (name === 'home') loadHome();
  if (name === 'picture') loadPicture();
  if (name === 'audio') loadAudio();
  if (name === 'game') loadGame();
  if (name === 'ambilight') startAmb();
  if (name === 'advanced') loadAdvanced();
  if (name === 'mqtt' || name === 'server') loadSettings();
}

function showNavCurrent() {
  const sel = document.querySelector('#tabs button[aria-selected="true"] span');
  const cur = document.getElementById('nav-current');
  if (sel && cur) cur.textContent = sel.textContent;
}

function navIsDrawer() {
  const bar = document.querySelector('.nav-bar');
  return !!bar && getComputedStyle(bar).display !== 'none';
}

function openNav() {
  const nav = document.getElementById('sidenav');
  if (!nav || !navIsDrawer()) return;
  nav.classList.add('open');
  document.getElementById('nav-backdrop').hidden = false;
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'true');
  document.body.classList.add('nav-open');
  const sel = nav.querySelector('button[aria-selected="true"]') || nav.querySelector('.tabs button');
  if (sel) sel.focus();
}

function closeNav() {
  const nav = document.getElementById('sidenav');
  if (!nav || !nav.classList.contains('open')) return;
  nav.classList.remove('open');
  document.getElementById('nav-backdrop').hidden = true;
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('nav-open');
  document.getElementById('nav-toggle').focus();
}

// Whether a wide screen lists the tabs down the left, kept per browser.
function setSidebar(mode) {
  const hide = mode === 'hide';
  closeNav();
  document.documentElement.classList.toggle('nav-hidden', hide);
  store.set('sidebar', hide ? 'hide' : 'show');
  $$('[data-sidebar-set]').forEach(b => {
    const on = b.dataset.sidebarSet === (hide ? 'hide' : 'show');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function initTabs() {
  $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('.tabs').addEventListener('keydown', e => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = TABS.indexOf(activeTab);
    const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const n = (i + (fwd ? 1 : TABS.length - 1)) % TABS.length;
    e.preventDefault();
    if (navIsDrawer()) $('#tab-' + TABS[n]).focus();
    else { showTab(TABS[n]); $('#tab-' + TABS[n]).focus(); }
  });
  $$('[data-goto]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.goto); }));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1), true));

  $('#nav-toggle').addEventListener('click', openNav);
  $('#nav-close').addEventListener('click', closeNav);
  $('#nav-backdrop').addEventListener('click', closeNav);
  $$('[data-sidebar-set]').forEach(b => b.addEventListener('click', () => setSidebar(b.dataset.sidebarSet)));
  setSidebar(store.get('sidebar') === 'hide' ? 'hide' : 'show');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
  // Widened past the drawer while it was open: the sidebar is simply there.
  window.addEventListener('resize', () => { if (!navIsDrawer()) closeNav(); });

  // /?tab=picture or /#picture
  const fromQuery = new URLSearchParams(location.search).get('tab');
  const initial = fromQuery || location.hash.slice(1) || store.get('cactarium.tab') || 'control';
  showTab(initial, !fromQuery && !!location.hash);
}
