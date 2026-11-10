// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Game tab: the game bar, and the HDMI game settings the TV reports.

async function loadGame() {
  const d = await phiGuard(async () => {
    const [bar, cfg] = await Promise.all([
      phi('RpcGameBarProfileConfigGet', { gameprofCfgIdx: 0 }),
      phi('RpcGeneralSrttingConfigRetrieve'),
    ]);
    return { bar: bar || {}, cfg: cfg || {} };
  }, $('#gameBusy'), $('#gameErr'));
  const host = $('#game-rows');
  host.textContent = '';
  if (!d) return;
  const onOff = v => (v ? 'On' : 'Off');
  host.append(h('div', { class: 'prot-table' },
    // RpcGameBarProfileConfigSet {gameprofCfgIdx: 0, GameprofCfgValue}, phi_page/lib/core.js:18453.
    toggleRow('Game bar', 'The Game bar over the picture while a game console is the source.', !!d.bar.GameprofCfgValue, async on => {
      const r = await phiGuard(() => phi('RpcGameBarProfileConfigSet', { gameprofCfgIdx: 0, GameprofCfgValue: on ? 1 : 0 }), $('#gameBusy'), $('#gameErr'));
      return r !== undefined;
    }),
    fixedRow('Auto game mode', 'Switches to the Game picture style when a console asks for it. Change it in the TV\'s own settings.', onOff(d.cfg.HDMIGameMode)),
    fixedRow('Variable refresh rate', 'HDMI VRR. Change it in the TV\'s own settings.', onOff(d.cfg.HDMIVRR))));
}
