// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// Boot.

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pollState();
  if (activeTab === 'ambilight') ambLoop();
  if (activeTab === 'metrics') metricsLoop();
});
window.addEventListener('resize', () => { if (activeTab === 'ambilight') drawAmb(); });
document.addEventListener('themechange', () => { if (activeTab === 'ambilight') drawAmb(); });
$('#ambSwitch').addEventListener('click', ambToggle);

captureTokenFromUrl();
initControl();
initApps();
initHome();
initPicture();
initAudio();
initAdvanced();
initMqtt();
initServer();
initTabs();
pollState();
