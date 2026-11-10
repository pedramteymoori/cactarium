// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The theme toggle: auto, dark or light (behaviour copied from Glasshouse's ui/theme.js).

(function initTheme() {
  const html = document.documentElement;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  // Browsers without prefers-color-scheme report the query as "not all"; they get dark.
  const mqSupported = mq.media !== 'not all';
  const urlTheme = new URLSearchParams(location.search).get('theme');
  let stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) { /* private window */ }
  let setting = urlTheme || stored || 'auto';
  if (setting !== 'auto' && setting !== 'dark' && setting !== 'light') setting = 'auto';
  const themeName = s => s === 'light' ? 'Light' : s === 'dark' ? 'Dark' : 'Auto';

  function resolved() {
    if (setting !== 'auto') return setting;
    if (!mqSupported) return 'dark';
    return mq.matches ? 'dark' : 'light';
  }

  function apply() {
    const mode = resolved();
    if (mode === 'light') html.setAttribute('data-theme', 'light');
    else html.removeAttribute('data-theme');
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = setting === 'auto' ? '◐' : (mode === 'light' ? '☀' : '☾');
      const label = 'Theme: ' + themeName(setting) + ' (click for ' + themeName(nextSetting()) + ')';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
    document.querySelectorAll('[data-theme-set]').forEach(b => {
      const on = b.dataset.themeSet === setting;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.content = mode === 'light' ? '#f5f5f5' : '#000000';
    html.style.colorScheme = mode;
    document.dispatchEvent(new CustomEvent('themechange', { detail: mode }));
  }

  function nextSetting() {
    const order = ['auto', 'dark', 'light'];
    return order[(order.indexOf(setting) + 1) % order.length];
  }

  apply();

  function onMediaChange() { if (setting === 'auto') apply(); }
  if (mq.addEventListener) mq.addEventListener('change', onMediaChange);
  else if (mq.addListener) mq.addListener(onMediaChange);

  document.addEventListener('click', function(e) {
    const btn = e.target.closest('#theme-toggle, [data-theme-set]');
    if (!btn) return;
    e.preventDefault();
    setting = btn.dataset.themeSet || nextSetting();
    try { localStorage.setItem('theme', setting); } catch (err) { /* private window */ }
    apply();
  });
})();
