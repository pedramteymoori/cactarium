/* The Cactarium TV app: the dashboard on the TV itself, driven by the remote.
 *
 * Ported from Glasshouse's TV app, server/assets/dashboard.html (MIT License,
 * (c) 2026 Rory Gallagher): the same tab bar, rows, explainer column, value
 * cycling on OK, adjust bars, confirms, toasts, D-pad and Back behaviour, with
 * Cactarium's data and settings instead of LG's.
 *
 * It runs in the launcher's iframe (the launcher navigates its own frame here),
 * so it keeps the launcher's side of the bridge to phi-hook.js: a heartbeat,
 * the keys it does not use (Home, volume) passed up, and Back and Home going
 * back to /launcher.
 *
 * Every tab reads and writes the routes the web dashboard uses (server/assets/
 * ui/*.js), with the same PHI bridge methods and parameters. The page is served
 * to the TV itself only, with the access token in a <meta> tag when one is set
 * (server/lib/routes/tvapp.go), and sends it as X-Cactarium-Token like the web
 * dashboard. The token is never part of a QR code.
 */
(function () {
  'use strict';
  var inFrame = window.parent && window.parent !== window;
  var BACK_CODES = [8, 27, 461, 10009];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function has(v) { return v !== null && v !== undefined && v !== ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------- the launcher bridge ---------- */
  function post(msg) {
    if (!inFrame) return;
    msg.src = 'cactarium-launcher';
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* no parent */ }
  }
  function backToLauncher() { window.location.replace('/launcher'); }

  /* ---------- the server ---------- */
  var TOKEN = '';
  try {
    var meta = document.querySelector('meta[name="cactarium-token"]');
    if (meta) TOKEN = meta.getAttribute('content') || '';
  } catch (e) { /* no token */ }

  // Resolves to the parsed body; rejects with an Error whose .status is the HTTP
  // status (0 when the server did not answer).
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (TOKEN) headers['X-Cactarium-Token'] = TOKEN;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }).then(function (res) {
      return res.text().then(function (text) {
        var d = null;
        try { d = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (res.status === 401) { var a = new Error('The access token was not accepted.'); a.status = 401; throw a; }
        if (!res.ok || (d && typeof d.error === 'string' && d.error)) {
          var err = new Error((d && d.error) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return d;
      });
    }, function () { var e = new Error('The Cactarium server on this TV did not respond.'); e.status = 0; throw e; });
  }
  function send(path, body) { return api(path, { method: 'POST', body: body === undefined ? {} : body }); }

  /* The TV's own settings UI, through POST /api/tv/phi. PHI is frozen while a web
     app runs and the server answers 504, which is "not available", not a failure. */
  var BUSY = { busy: true };
  function phi(method, params) {
    return send('/api/tv/phi', { method: method, params: params || {} }).then(function (r) {
      return r && 'result' in r ? r.result : r;
    }, function (e) { if (e.status === 504) e.busy = true; throw e; });
  }
  var NOT_NOW = 'Not available while an app is open';

  // Where a phone reaches the dashboard: only the server knows it (this page is
  // served from localhost). Asked for at start and every minute.
  var lan = { url: '' };
  function readLan() {
    api('/api/tvapp').then(function (d) {
      lan = (d && d.dashboard) || { url: '' };
      renderHint();
    }, function () { /* the QR is simply not offered */ });
  }
  function webUrl(path) { return lan.url ? lan.url.replace(/\/$/, '') + (path === true ? '/' : path) : ''; }

  /* ---------- formatting ---------- */
  function fmtKB(kb) {
    if (!kb) return '—';
    if (kb >= 1048576) return (kb / 1048576).toFixed(1) + ' GB';
    return Math.round(kb / 1024) + ' MB';
  }
  function fmtBytes(b) { return fmtKB(b / 1024); }
  function fmtRate(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    return Math.round(bps / 1024) + ' KB/s';
  }
  function fmtUptime(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d > 0 ? d + 'd ' + h + 'h' : h + 'h ' + m + 'm';
  }
  function onOff(v) { return v ? 'On' : 'Off'; }

  /* ---------- row builders ---------- */
  function head(label) { return { label: label, head: true }; }
  function row(label, value, o) {
    var r = { label: label, value: value };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  }
  function extend(r, o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
  // A reading with a QR code to scan for the browser dashboard's page for it.
  function web(path, text) { return { web: path, scan: text || 'Scan to open it on your phone.' }; }

  /* A switch: OK flips it. set(next) returns the request's promise. */
  function toggle(label, on, hint, set, o) {
    o = o || {};
    return extend(row(label, on ? (o.onWord || 'On') : (o.offWord || 'Off'), {
      cls: on ? 'on' : 'off', act: true, on: !!on,
      press: on ? 'Press OK to switch off' : 'Press OK to switch on', hint: hint,
      run: function () { return changing(set(!on), on ? 'Switched off' : 'Switched on', o); }
    }), o.row || {});
  }
  /* A choice: OK steps to the next. nextLabel names it. */
  function choice(label, shown, nextLabel, hint, set, o) {
    o = o || {};
    return extend(row(label, shown, {
      cls: o.cls || 'act', act: true, press: 'Press OK for ' + nextLabel, hint: hint,
      run: function () { return changing(set(), '', o); }
    }), o.row || {});
  }
  /* A number or level set with a bar: OK starts adjusting, Left and Right change it. */
  function slider(label, cur, min, max, hint, commit, o) {
    o = o || {};
    var fmt = o.fmt || String;
    return {
      label: label, value: fmt(cur), cls: 'act', act: true, adj: true, cur: cur, min: min, max: max, step: o.step || 1,
      fmt: fmt, commit: commit, press: 'Press OK to adjust', hint: hint
    };
  }
  function opens(label, value, key, hint, o) {
    return extend(row(label, value, { cls: 'act opens', act: true, press: 'Press OK to open', hint: hint,
      run: function () { openList(key); } }), o || {});
  }
  function note(label, hint) { return row(label, '', { hint: hint }); }
  function busyRow() { return row(NOT_NOW, '', { hint: 'The TV’s settings page is frozen while an app runs. These rows come back when the app is closed.' }); }

  /* ---------- the tabs ---------- */
  var data = {};              // the last data each tab read
  var caches = {};            // data a list reads once (the TitanOS catalog)

  /* Metrics: what the TV and the server report about themselves. */
  function powerClass(p) { return p === 'On' ? 'good' : p ? 'note' : ''; }

  function metricsRows(d) {
    var s = d.stats || {}, tv = d.tv || {}, sys = tv.system || {}, r = [];
    var load = [];
    (s.temps || []).forEach(function (t) {
      load.push(row('Temperature' + ((s.temps.length > 1 && t.name) ? ' ' + t.name : ''), t.c.toFixed(0) + ' °C', {
        hint: 'A sensor the TV exposes (' + (t.name || 'unnamed') + '). It climbs with video decoding and CPU workload.' }));
    });
    if (has(s.cpu_percent) && (s.cpu_cores || []).length) load.push(row('CPU load', Math.round(s.cpu_percent) + '%', {
      hint: 'Across all cores. Brief peaks while an app opens are normal; a sustained high figure with nothing playing is not.' }));
    if ((s.cpu_cores || []).length) load.push(row('Per-core load', s.cpu_cores.map(function (c) { return Math.round(c) + '%'; }).join('  '), {
      hint: 'One figure per core. An even spread is healthy; one core pinned while the rest idle points at a stuck process.' }));
    if (s.load && (s.load[0] || s.load[1] || s.load[2])) load.push(row('Load average', s.load.map(function (v) { return v.toFixed(2); }).join('  '), {
      hint: 'Runnable tasks over the last 1, 5 and 15 minutes. Around the core count or below is fine.' }));
    if (load.length) r = r.concat([head('Load')], load);

    var mem = [];
    if (s.mem_total_kb) mem.push(row('Memory free', fmtKB(s.mem_avail_kb) + ' of ' + fmtKB(s.mem_total_kb), {
      hint: 'Memory the TV can hand out without closing anything. TitanOS keeps apps loaded, so it is expected to be lowish.' }));
    if (s.swap_total_kb) mem.push(row('Swap free', fmtKB(s.swap_free_kb) + ' of ' + fmtKB(s.swap_total_kb), {
      hint: 'Swap space the TV has left. Heavy use costs speed.' }));
    (s.storage || []).forEach(function (dk) {
      if (dk.total_b) mem.push(row('Storage ' + dk.path, fmtBytes(dk.free_b) + ' of ' + fmtBytes(dk.total_b), {
        hint: 'Free space on the volume mounted at ' + dk.path + '.' }));
    });
    if (s.flash) mem.push(row('Flash wear', (s.flash.wear || '—').replace('-', '–'), {
      cls: s.flash.eol === 'Urgent' ? 'bad' : s.flash.eol === 'Warning' ? 'hold' : s.flash.eol === 'Normal' ? 'good' : 'note',
      hint: 'How much of the built-in storage’s life has been used, as the chip itself reports it' + (s.flash.eol ? ' (' + s.flash.eol + ')' : '') + '. It rises very slowly and cannot be reset.' }));
    if (mem.length) r = r.concat([head('Memory and storage')], mem);

    var net = [];
    (s.net || []).forEach(function (n) {
      net.push(row(n.name, '↓ ' + fmtRate(n.rx_rate) + '  ↑ ' + fmtRate(n.tx_rate), {
        hint: 'Traffic on ' + n.name + ' right now: received and sent, per second.' }));
    });
    if (s.wifi) net.push(row('Wi-Fi', Math.round(s.wifi.quality) + '%', {
      sub: has(s.wifi.level_dbm) ? Math.round(s.wifi.level_dbm) + ' dBm on ' + s.wifi.iface : '',
      hint: 'Signal quality of the Wi-Fi link, as the driver reports it.' }));
    var addrs = [s.hostname].concat(s.addresses || []).filter(Boolean);
    if (addrs.length) net.push(row('Address', addrs[0], { sub: addrs.slice(1), hint: 'The TV’s name and addresses on the home network.' }));
    if (net.length) r = r.concat([head('Network')], net);

    var ports = (tv.inputs || []).filter(function (i) { return i.kind === 'hdmi'; });
    if (ports.length) {
      r.push(head('HDMI ports'));
      ports.forEach(function (i) {
        var empty = i.connected === false;
        r.push(row('HDMI ' + i.port, i.current ? 'Active' : empty ? 'Empty' : i.connected ? 'Idle' : 'Unknown', {
          cls: i.current ? 'good' : 'note', sub: !empty && i.name !== i.label && i.label ? i.name + ' (' + i.label + ')' : (!empty ? i.name : ''),
          hint: 'Whether something is plugged into this HDMI port, and the input the TV is showing.' }));
      });
    }

    r.push(head('Processes'));
    r.push(opens('Memory by process', 'Open', 'procMem', 'The biggest processes on the TV by the memory they hold.'));
    r.push(opens('CPU by process', 'Open', 'procCpu', 'The busiest processes over a one-second sample, read again every three seconds while the list is open.'));

    var me = [];
    if (s.uptime_sec) me.push(row('Uptime', fmtUptime(s.uptime_sec), { hint: 'Since the TV last booted.' }));
    if (s.procs) me.push(row('Processes', String(s.procs), { hint: 'Running processes on the TV.' }));
    if (s.self && s.self.rss_kb) me.push(row('Cactarium memory', fmtKB(s.self.rss_kb), {
      hint: 'What the Cactarium server itself holds in RAM. It is capped at 48 MiB.' }));
    if (me.length) r = r.concat([head('Cactarium')], me);

    r.push(head('This TV'));
    r.push(row('TV', tv.reachable ? 'Reachable' : 'Not reachable', { cls: tv.reachable ? 'good' : 'bad',
      hint: tv.reachable ? 'Cactarium reaches the TV’s own JointSpace API.' : 'Cactarium cannot reach the TV’s JointSpace API.',
      warn: tv.reachable ? '' : tv.error || '' }));
    r.push(row('Pairing', tv.paired ? 'Paired' : 'Not paired', { cls: tv.paired ? 'good' : 'hold',
      hint: tv.paired ? 'Cactarium may press keys and change settings through JointSpace.' : 'Without pairing the dashboard can read little and control nothing. Pair from the web dashboard’s Server tab.',
      web: tv.paired ? undefined : '/?tab=server', scan: 'Scan to open it on your phone.' }));
    if (tv.reachable) {
      if (tv.power) r.push(row('Power', tv.power, { cls: powerClass(tv.power), hint: 'The TV’s power state.' }));
      if (tv.source && tv.source.label) r.push(row('On screen', tv.source.label, { hint: 'What the TV is showing, from its own UI page.' }));
    }
    [['Name', 'name'], ['Model', 'model'], ['Software', 'softwareversion'], ['Country', 'country']].forEach(function (p) {
      var v = p[1] === 'model' ? (tv.model || sys.model) : sys[p[1]];
      if (typeof v === 'string' && v) r.push(row(p[0], v, { hint: 'As the TV reports it.' }));
    });
    return r;
  }

  /* The two process lists open from Metrics and read for themselves while open. */
  function procRows(back, title, list, valueOf, none) {
    var r = [backRow(back)];
    if (!list) return r.concat([head(title), row('Loading…', '')]);
    if (list.error) return r.concat([head(title), row('Could not read the list', '', { hint: list.error })]);
    r.push(head(title));
    if (!list.top.length) r.push(row(none, ''));
    list.top.forEach(function (p) { r.push(row(p.name, valueOf(p), { sub: 'pid ' + p.pid, hint: 'Process ' + p.name + ', pid ' + p.pid + '.' })); });
    return r;
  }
  function procMemRows(d, l) {
    var head2 = l && !l.error ? plural(l.count, 'process', 'processes') + ' · ' + Math.round(l.total_mb).toLocaleString() + ' MB resident' : 'Memory by process';
    return procRows('Metrics', head2, l, function (p) { return p.mb.toFixed(1) + ' MB'; }, 'Nothing listed');
  }
  function procCpuRows(d, l) {
    return procRows('Metrics', l && !l.error ? l.busy.toFixed(1) + '% busy' : 'CPU by process', l,
      function (p) { return p.pct.toFixed(1) + '%'; }, 'Nothing used any CPU over the sample');
  }
  function loadProc(path) {
    return function () {
      return api(path).then(function (d) {
        if (!d || !d.ok) return { error: (d && d.error) || 'failed' };
        return d;
      }, function (e) { return { error: e.message }; });
    };
  }

  /* Apps: the launcher's apps, each launched with OK, and the TV's inputs. */
  function appsRows(d) {
    var r = [head('Apps')];
    (d.apps || []).forEach(function (a) {
      r.push(row(a.name, 'Launch', { cls: 'act', act: true, press: 'Press OK to launch it',
        hint: 'Opens ' + a.name + ', as the launcher does.',
        run: function () { return launch(a); } }));
    });
    if (!(d.apps || []).length) r.push(note('No apps picked', 'The launcher uses the TV’s own app list. Pick apps on the Home tab.'));
    r.push(head('Inputs'));
    if (d.inputs === BUSY) r.push(busyRow());
    else if (!d.inputs.length) r.push(note('The TV does not list its inputs', ''));
    d.inputs !== BUSY && d.inputs.forEach(function (it) {
      var label = it.sub ? it.name + ' (' + it.sub + ')' : it.name;
      r.push(row(label, it.current ? 'Now' : it.connected === false ? 'Empty' : 'Switch', {
        cls: it.current ? 'on' : 'act', act: !it.current, press: 'Press OK to switch to it',
        hint: it.connected === false ? 'Nothing is plugged into this input.' : 'Switches the TV to this input.',
        run: function () { return changing(phi('source', { typeId: it.typeId }), 'Switched to ' + it.name, { delay: 600 }); } }));
    });
    return r;
  }
  function launch(a) {
    return changing(phi('launch', a), 'Launching ' + a.name, { quiet: true, after: function () {} });
  }

  /* Game: the Game bar, and the HDMI game settings the TV reports. */
  function gameRows(d) {
    if (d.bar === BUSY || d.cfg === BUSY) return [busyRow()];
    var r = [head('Game')];
    r.push(toggle('Game bar', !!d.bar.GameprofCfgValue, 'The Game bar over the picture while a game console is the source.', function (on) {
      return phi('RpcGameBarProfileConfigSet', { gameprofCfgIdx: 0, GameprofCfgValue: on ? 1 : 0 });
    }));
    r.push(row('Auto game mode', onOff(d.cfg.HDMIGameMode), { cls: d.cfg.HDMIGameMode ? 'on' : 'off',
      hint: 'Switches to the Game picture style when a console asks for it. Change it in the TV’s own settings.' }));
    r.push(row('Variable refresh rate', onOff(d.cfg.HDMIVRR), { cls: d.cfg.HDMIVRR ? 'on' : 'off',
      hint: 'HDMI VRR. Change it in the TV’s own settings.' }));
    return r;
  }

  /* Picture: the picture style, then its basic settings. */
  var PIC_LABELS = {
    MAIN_PIC_PERSONAL: 'Personal', MAIN_CRYSTAL_CLEAR: 'Crystal clear', MAIN_HOME_CINEMA: 'Home cinema',
    MISC_ECO: 'Eco', MAIN_PIC_MOVIE: 'Movie', MAIN_PIC_GAME: 'Game', MAIN_PIC_VIVID: 'Vivid',
    MAIN_PIC_NATURAL: 'Natural', MAIN_PIC_STANDARD: 'Standard', MISC_FILMMAKER: 'Filmmaker mode',
    MAIN_CALMAN: 'Calman', MAIN_HOME_CINEMA_DOLBY_VISION_BRIGHT: 'Dolby Vision bright',
    MAIN_MOVIE_DOLBY_VISION_DARK: 'Dolby Vision dark'
  };
  function picLabel(name) {
    if (PIC_LABELS[name]) return PIC_LABELS[name];
    var t = String(name || '').replace(/^(MAIN|MISC|PIC)_/, '').replace(/^PIC_/, '').replace(/_/g, ' ').toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '--';
  }
  function loadPicture() {
    return Promise.all([phi('RpcPictureGroupPictureRootGet'), phi('RpcPictureGroupContrastGet'), phi('RpcPictureGroupColorGet'),
      phi('RpcPictureGroupSharpnessGet'), phi('RpcPictureFormatGet')]).then(function (a) {
      var root = a[0] && a[0].groupPictureRootData;
      if (!root || !root.currentMode) throw new Error('The TV did not report its picture style');
      return { root: root, contrast: (a[1] && a[1].groupContrastData) || {}, colour: (a[2] && a[2].groupColorData) || {},
        sharp: (a[3] && a[3].groupSharpnessData) || {}, format: (a[4] && a[4].format) || {} };
    });
  }
  function nextOf(list, isCurrent) {
    var at = 0;
    for (var i = 0; i < list.length; i++) if (isCurrent(list[i])) at = i;
    return list[(at + 1) % list.length];
  }
  function pictureRows(d) {
    var r = [head('Picture style')];
    var modes = d.root.modeScheme || [], cur = d.root.currentMode;
    if (modes.length > 1) {
      var next = nextOf(modes, function (m) { return m.id === cur.id; });
      r.push(choice('Picture style', picLabel(cur.name), picLabel(next.name), 'The TV’s picture preset. The settings below belong to it.', function () {
        return phi('RpcPictureStyleSet', { mode: next.id });
      }, { delay: 300 }));
    } else r.push(row('Picture style', picLabel(cur.name), { hint: 'The TV’s picture preset.' }));
    r.push(head('Picture'));
    function set(method, key) { return function (v) { var p = {}; p[key] = v; return phi(method, p); }; }
    r.push(slider('Contrast', d.contrast.backlightContrast || 0, 0, 100, 'The backlight contrast of this picture style.', set('RpcPictureConstrastSet', 'constrast')));
    r.push(slider('Brightness', d.contrast.blackLevel || 0, 0, 100, 'The black level of this picture style.', set('RpcPictureBrightnessSet', 'brightness')));
    r.push(slider('Colour', d.colour.saturation || 0, 0, 100, 'Colour saturation.', set('RpcPictureColourSet', 'colour')));
    r.push(slider('Sharpness', d.sharp.sharpness || 0, 0, 10, 'Edge enhancement.', set('RpcPictureSharpnessSet', 'sharpness')));
    r.push(toggle('Ambient light sensor', !!d.contrast.lightSensor, 'Adjusts the picture to the light in the room.', function (on) {
      return phi('RpcPictureLightSensorSet', { sensor: on ? 1 : 0 });
    }, { delay: 300 }));
    r.push(row('Picture format', (d.format.currentAspectRatio && d.format.currentAspectRatio.name) || '--', {
      hint: 'How the picture fills the screen. Change it with the remote’s Format key.' }));
    return r;
  }

  /* Audio: the volume (JointSpace) and the TV's sound settings (PHI). */
  function audioRows(d) {
    var r = [head('Volume')], v = d.volume;
    if (v && has(v.current)) {
      r.push(slider('Volume', v.current, has(v.min) ? v.min : 0, v.max || 60, 'The TV’s volume.', function (x) {
        return send('/api/volume', { current: x });
      }));
      r.push(toggle('Mute', !!v.muted, 'Silences the TV without changing its volume.', function (on) {
        return send('/api/volume', { muted: on });
      }, { onWord: 'Muted', offWord: 'Off', delay: 0 }));
    } else r.push(note('Volume unavailable', 'The TV did not report its volume. It may be off or not paired.'));
    r.push(head('Sound'));
    var s = d.sound;
    if (s === BUSY) { r.push(busyRow()); return r; }
    var styles = s.modeScheme || [];
    if (styles.length > 1) {
      var next = nextOf(styles, function (m) { return m.id === s.style; });
      var curName = (styles.filter(function (m) { return m.id === s.style; })[0] || {}).mode;
      r.push(choice('Sound style', curName || String(s.style), next.mode, 'The TV’s sound preset.', function () {
        return phi('RpcSoundStyleSet', { style: Number(next.id) });
      }, { delay: 300 }));
    }
    r.push(toggle('Clear dialogue', !!s.clearDialogue, 'Makes speech easier to hear.', function (on) { return phi('RpcSoundClearDialogueSet', { switch: on ? 1 : 0 }); }, { delay: 300 }));
    r.push(toggle('Dolby Atmos', !!s.dolbyAtmos, 'Spatial sound, where the content carries it.', function (on) { return phi('RpcSoundDolbyAtmosSet', { mode: on ? 1 : 0 }); }, { delay: 300 }));
    r.push(toggle('AI equalizer', !!s.AIEQSwitch, 'Tunes the sound to what is playing.', function (on) { return phi('RpcSoundAiequalzerSet', { switch: on ? 1 : 0 }); }, { delay: 300 }));
    return r;
  }

  /* Ambilight: power and style through PHI, as the web dashboard does (JointSpace
     writes answer 503 on 55PUS8450/12). 0 is Off. The live LED preview is left
     to the web dashboard. */
  var AMB_STYLES = [[1, 'AI'], [2, 'Standard'], [3, 'Sports'], [4, 'Cinema'], [5, 'Game'], [6, 'Music'], [7, 'Fixed colour'], [8, 'Support your team']];
  var ambLast = 2;            // what "On" restores
  function ambName(id) { for (var i = 0; i < AMB_STYLES.length; i++) if (AMB_STYLES[i][0] === id) return AMB_STYLES[i][1]; return id ? String(id) : 'Off'; }
  // RpcSetupAmbilightStyleSet {style, mode}: mode = style, except Music, which takes ambilightStyleFollowAudio.
  function setAmbStyle(cfg, style) {
    var mode = style === 6 ? Number(cfg.ambilightStyleFollowAudio || 0) : style;
    if (style > 0) ambLast = style;
    return phi('RpcSetupAmbilightStyleSet', { style: style, mode: mode });
  }
  function ambilightRows(cfg) {
    if (cfg === BUSY) return [busyRow()];
    var now = Number(cfg.ambilightStyle) || 0;
    if (now > 0) ambLast = now;
    var r = [head('Ambilight')];
    r.push(toggle('Ambilight', now > 0, 'The lamps behind the TV.', function (on) { return setAmbStyle(cfg, on ? ambLast : 0); }, { delay: 300 }));
    var pool = AMB_STYLES, at = -1;
    pool.forEach(function (s, i) { if (s[0] === now) at = i; });
    var next = pool[(at + 1) % pool.length];
    r.push(choice('Style', ambName(now), next[1], 'What the lamps do. Fixed colour and Support your team keep the colours set on the TV.', function () {
      return setAmbStyle(cfg, next[0]);
    }, { delay: 300 }));
    var adv = cfg.Advanced || {};
    if (adv.ambilightBrightness !== undefined) {
      r.push(slider('Brightness', adv.ambilightBrightness, 0, 10, 'How bright the lamps are.', function (v) {
        return phi('RpcAmbilightBrightnessSet', { brightness: v });
      }));
    }
    return r;
  }

  /* Home: the launcher, its apps row, the TitanOS block and the background. */
  var BG_KINDS = ['none', 'pictures', 'animated'];
  var BG_NAMES = { none: 'None', pictures: 'Pictures', animated: 'Animated' };
  var BG_PICTURES = ['landscape', 'abstract', 'own'];
  var PICTURE_NAMES = { landscape: 'Landscape', abstract: 'Abstract', own: 'Your own' };
  var BG_ANIMS = [['waves', 'Light waves'], ['particles', 'Particles'], ['aquarium', 'Aquarium'], ['aurora', 'Aurora'],
    ['glow', 'Glow'], ['constellations', 'Constellations'], ['ripples', 'Ripples']];
  var BG_COLOURS = [['time', 'Time of day'], ['night_blue', 'Night blue'], ['sunset', 'Sunset'], ['emerald', 'Emerald'],
    ['ember', 'Ember'], ['silver', 'Silver'], ['own', 'Your own']];

  function launcherOf(d) { return (d.settings && d.settings.launcher) || {}; }
  // The background as saved, with the defaults for anything not there yet.
  function backgroundOf(d) {
    var b = launcherOf(d).background || {};
    return { kind: BG_KINDS.indexOf(b.kind) >= 0 ? b.kind : 'none', pictures: BG_PICTURES.indexOf(b.pictures) >= 0 ? b.pictures : 'landscape',
      animation: b.animation || 'waves', colours: b.colours || 'time', own_colours: b.own_colours,
      darkening: typeof b.darkening === 'number' ? b.darkening : 100 };
  }
  function saveLauncher(patch, o) { return changing(send('/api/settings', { launcher: patch }), '', extend({ delay: 0 }, o || {})); }
  function saveBackground(b, patch) {
    var n = {};
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) n[k] = b[k];
    for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) n[p] = patch[p];
    return saveLauncher({ background: n });
  }
  function codeName(d, code) {
    if (code === 'tv') return 'TV';
    var a = (d.apps || []).filter(function (x) { return x.code === code; })[0] ||
      ((caches.catalog || []).filter(function (x) { return x.code === code; })[0]);
    return a ? a.name : code;
  }

  function homeRows(d) {
    var l = launcherOf(d), on = l.enabled !== false, r = [head('Home')];
    r.push(toggle('Cactarium launcher', on, on ? 'The Home button opens the Cactarium launcher.' : 'The Home button opens the stock TitanOS home.',
      function (next) { return send('/api/settings', { launcher: { enabled: next } }); }, { delay: 0 }));
    r.push(toggle('Block the TitanOS home', !!l.block_titanos,
      'Keeps the TV from loading app.titanos.tv, the TitanOS cloud home screen, so only the Cactarium launcher shows. Applies when the launcher is on.',
      function (next) { return send('/api/settings', { launcher: { block_titanos: next } }); }, { delay: 0, onWord: 'Blocked', offWord: 'Not blocked' }));
    if (!on) return r;

    var codes = l.apps || [];
    var names = codes.map(function (c) { return codeName(d, c); });
    r.push(head('Apps row'));
    r.push(opens('Apps row', codes.length ? plural(codes.length, 'app', 'apps') : 'TV’s own list', 'homeApps',
      'Which apps the launcher shows and in what order. With none picked it uses the TV’s own app list.',
      { peek: names.slice(0, PEEK_MAX), peekMore: Math.max(0, names.length - PEEK_MAX) }));

    var w = l.weather || {}, placed = has(w.latitude) && has(w.longitude) && (w.latitude || w.longitude);
    r.push(row('Weather', placed ? 'On' : 'Not set', extend({ cls: placed ? 'good' : 'note',
      hint: 'The launcher shows the weather for a place. The place is entered on the web dashboard’s Home tab, where it can be typed.' }, web('/?tab=home'))));

    var b = backgroundOf(d);
    r.push(head('Background'));
    // One choice of three, then only its own rows: None is no picture or animation, Pictures a picture set or the owner's own, and Animated one of the scenes.
    var kindNext = BG_KINDS[(BG_KINDS.indexOf(b.kind) + 1) % 3];
    r.push(choice('Background', BG_NAMES[b.kind], BG_NAMES[kindNext],
      'What is behind the launcher: nothing, pictures that change with the part of the day, or a moving background.',
      function () { return saveBackground(b, { kind: kindNext }); }, { cls: 'act' }));
    if (b.kind === 'pictures') {
      var picNext = BG_PICTURES[(BG_PICTURES.indexOf(b.pictures) + 1) % BG_PICTURES.length];
      r.push(choice('Pictures', PICTURE_NAMES[b.pictures], PICTURE_NAMES[picNext],
        'Landscape and Abstract are the launcher’s own pictures. Your own pictures are added on the web dashboard’s Home tab.',
        function () { return saveBackground(b, { pictures: picNext }); }, b.pictures === 'own' ? { row: web('/?tab=home') } : {}));
    }
    if (b.kind === 'animated') {
      var animAt = 0, i;
      for (i = 0; i < BG_ANIMS.length; i++) if (BG_ANIMS[i][0] === b.animation) animAt = i;
      var animNext = BG_ANIMS[(animAt + 1) % BG_ANIMS.length];
      r.push(choice('Animation', BG_ANIMS[animAt][1], animNext[1], 'Light that moves slowly behind the launcher. It stops whenever the launcher is not on screen.',
        function () { return saveBackground(b, { animation: animNext[0] }); }, { cls: 'on' }));
      var colAt = 0;
      for (i = 0; i < BG_COLOURS.length; i++) if (BG_COLOURS[i][0] === b.colours) colAt = i;
      var colNext = BG_COLOURS[(colAt + 1) % BG_COLOURS.length];
      r.push(choice('Background colours', BG_COLOURS[colAt][1], colNext[1], 'Colours of one’s own are picked on the web dashboard’s Home tab.',
        function () { return saveBackground(b, { colours: colNext[0] }); }, { cls: 'on', row: b.colours === 'own' ? web('/?tab=home') : {} }));
    }
    // OK steps down from full to off; the web dashboard's slider sets any step.
    var dark = b.darkening, darkNext = dark > 75 ? 75 : dark > 50 ? 50 : dark > 25 ? 25 : dark > 0 ? 0 : 100;
    function darkName(v) { return v === 0 ? 'Off' : v + '%'; }
    r.push(choice('Darkening', darkName(dark), darkName(darkNext),
      'How much the background is darkened behind the clock and the apps, to keep them easy to read. Off shows the picture as it is.',
      function () { return saveBackground(b, { darkening: darkNext }); }));
    return r;
  }

  // The apps row, in order: OK moves an app up one place, as Glasshouse's row order does.
  function homeAppsRows(d) {
    var l = launcherOf(d), codes = l.apps || [], r = [backRow('Home')];
    r.push(head('Apps row'));
    r.push(opens('Add or remove apps', 'Choose', 'homeAdd', 'The TV input and the TitanOS catalog’s apps, each in the row or not.'));
    r.push(head(codes.length ? plural(codes.length, 'app', 'apps') + ' in the row' : 'None picked'));
    if (!codes.length) r.push(note('The TV’s own list is used', 'No apps are picked, so the launcher uses the TV’s own app list. Add some above.'));
    codes.forEach(function (code, i) {
      r.push(row(codeName(d, code), (i + 1) + ' of ' + codes.length, {
        cls: 'act', act: i > 0, press: i > 0 ? 'Press OK to move it up' : 'First in the row',
        hint: 'The order of the apps in the launcher. A press of OK moves it up one place.',
        run: function () { var n = codes.slice(); n.splice(i - 1, 0, n.splice(i, 1)[0]); return saveLauncher({ apps: n }); } }));
    });
    return r;
  }
  function homeAddRows(d) {
    var l = launcherOf(d), codes = l.apps || [], r = [backRow('Apps row')];
    var cat = caches.catalog;
    if (!cat) return r.concat([head('Apps'), row('Loading…', '')]);
    function entry(code, name) {
      var inRow = codes.indexOf(code) >= 0;
      return toggle(name, inRow, inRow ? 'In the launcher’s apps row. OK takes it out.' : 'Not in the launcher’s apps row. OK adds it at the end.', function (next) {
        return saveLauncher({ apps: next ? codes.concat([code]) : codes.filter(function (c) { return c !== code; }) });
      }, { onWord: 'In the row', offWord: 'Not in the row', quiet: true });
    }
    r.push(head('Apps'));
    r.push(entry('tv', 'TV input'));
    var list = cat.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var inRow = list.filter(function (a) { return codes.indexOf(a.code) >= 0; }), rest = list.filter(function (a) { return codes.indexOf(a.code) < 0; });
    inRow.concat(rest).slice(0, 300).forEach(function (a) { r.push(entry(a.code, a.name)); });
    return r;
  }

  /* System: power and standby, timers, HDMI, and this server. */
  function flatten(o, prefix, out) {
    Object.keys(o || {}).forEach(function (k) {
      var key = prefix ? prefix + '.' + k : k, v = o[k];
      if (/_encrypted$/.test(k)) return;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
    });
    return out;
  }
  function sysInfoRows(d) {
    var r = [backRow('System'), head('System information')];
    var list = flatten((d.state.tv || {}).system, '', []);
    if (!list.length) r.push(note('No data', 'The TV has not reported its system information.'));
    list.forEach(function (p) { r.push(row(p[0], p[1], { hint: 'As the TV reports it.' })); });
    return r;
  }

  function systemRows(d) {
    var st = d.state || {}, tv = st.tv || {}, set = d.settings || {}, cfg = d.cfg, r = [];
    r.push(head('Timers'));
    if (cfg === BUSY) r.push(busyRow());
    else {
      r.push(row('Switch-off timer', cfg.switchOffTimer ? 'Turn off' : 'Off', extend({ cls: cfg.switchOffTimer ? 'act' : '',
        hint: cfg.switchOffTimer ? 'The TV switches itself off after the time set on the TV (setting ' + cfg.switchOffTimer + '). OK turns it off. Set a new time in the TV’s own settings.'
          : 'Off. Set a time in the TV’s own settings.' },
        cfg.switchOffTimer ? { act: true, press: 'Press OK to turn it off', run: function () { return changing(phi('RpcGeneralSwitchOffTimerSet', { index: 0 }), 'Switch-off timer off', { delay: 300 }); } } : {})));
      r.push(row('No-signal timer', cfg.nosignalTimer ? 'Setting ' + cfg.nosignalTimer : 'Off',
        { hint: 'Switches the TV off after a while with no signal. Change it in the TV’s own settings.' }));
      r.push(head('HDMI'));
      r.push(toggle('EasyLink remote control', !!cfg.easyLinkRC, 'Lets the TV’s remote control devices connected over HDMI-CEC.', function (on) {
        return phi('RpcGeneralEasyLinkRemoteControlSet', { switch: on ? 1 : 0 });
      }, { delay: 300 }));
      r.push(row('Auto movie mode', onOff(cfg.AutoMovieMode), { cls: cfg.AutoMovieMode ? 'on' : 'off',
        hint: 'Picks the Movie picture style for film content. Change it in the TV’s own settings.' }));
      (cfg.HDMIUltraHD || []).forEach(function (p) {
        r.push(row('HDMI ' + (Number(p.index) + 1) + ' Ultra HD', 'Mode ' + p.mode, { hint: 'HDMI Ultra HD mode of this port. Change it in the TV’s own settings.' }));
      });
    }

    r.push(head('This TV'));
    r.push(row('TV name', set.name || tv.name || '—', extend({ hint: 'The name Cactarium shows and sends to Home Assistant. It is changed on the web dashboard’s System tab, where it can be typed.' }, web('/?tab=advanced'))));
    r.push(opens('System information', 'Open', 'sysInfo', 'Everything the TV reports about itself.'));

    r.push(head('This dashboard'));
    if (lan.url) {
      r.push(row('Address', lan.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), extend({
        hint: 'Where the web dashboard is, for a browser on a phone or computer on your home network.' }, web('/'))));
    } else {
      r.push(row('Address', 'None', { cls: 'hold', hint: 'The server is not listening on a network address a phone can reach, or the TV has none.' }));
    }
    r.push(row('Access token', set.token_set ? 'Required' : 'Not set', { cls: set.token_set ? 'good' : 'hold',
      hint: set.token_set ? 'The web dashboard asks for the access token in config.json. The code does not include it.'
        : 'No password: anyone on your home network can use the web dashboard.' }));
    if (st.version) r.push(row('Version', st.version, { hint: 'The Cactarium server running on this TV.' }));

    var mq = st.mqtt || {}, mqm = set.mqtt || {};
    var haValue = !mq.enabled ? 'Not set up' : mq.connected ? 'Connected' : mq.error ? 'Not connecting' : 'Connecting';
    r.push(head('Home Assistant (MQTT)'));
    r.push(row('Home Assistant', haValue, extend({ cls: mq.connected ? 'good' : mq.enabled ? 'hold' : 'note',
      hint: mq.connected ? 'Connected through your MQTT broker. The TV reports its state and takes commands, so it can join your automations.'
        : mq.enabled ? 'The broker’s details are saved, but the TV cannot connect to it yet.'
        : 'Connects this TV to Home Assistant through an MQTT broker. The broker’s details are entered on the web dashboard’s MQTT tab.',
      warn: mq.enabled && !mq.connected ? mq.error || '' : '' }, web('/?tab=mqtt'))));
    if (mqm.host) r.push(row('Broker', mqm.host + (mqm.port ? ':' + mqm.port : ''), { hint: 'The MQTT broker Cactarium connects to.' }));

    // Last, away from the row the tab opens on, so a stray OK lands nowhere near them.
    r.push(head('Power'));
    r.push(confirmRow('Power off', '', 'Press OK, then again, to put the TV in standby',
      'The same as the power button on the remote: the TV goes to standby.', function () {
        return send('/api/power', { state: 'Standby' });
      }, 'Standing by…'));
    r.push(row('Screen off', '', { cls: 'act', act: true, press: 'Press OK to switch the screen off',
      hint: 'The picture goes dark and the TV keeps running.',
      run: function () { return changing(phi('RpcScreenOff', { switch: 1 }), '', { delay: 0 }); } }));
    r.push(row('Screen on', '', { cls: 'act', act: true, press: 'Press OK to switch the screen on',
      hint: 'Brings the picture back after Screen off.',
      run: function () { return changing(phi('RpcScreenOff', { switch: 0 }), '', { delay: 0 }); } }));
    r.push(confirmRow('Reboot', '', 'Press OK, then again, to reboot',
      'A full restart of the TV. It is unavailable for about a minute.', function () {
        return send('/api/tv/reboot');
      }, 'Rebooting…'));
    return r;
  }
  // A row that takes a second OK within five seconds.
  function confirmRow(label, value, again, hint, fn, doing) {
    var r = row(label, value, { cls: 'act', act: true, press: again, hint: hint });
    r.run = function () {
      if (confirmFirst(r, again)) return;
      return changing(fn(), doing, { delay: 0 });
    };
    return r;
  }

  var PEEK_MAX = 6;           // names the hint panel lists for a row before "and n more"

  /* The tabs, in Glasshouse's order less what is LG's, with Ambilight after Audio.
     Each loads what it shows, polls at the interval Glasshouse uses for the
     same sort of data, and builds its rows from that. */
  function soft(p) { return p.catch(function (e) { if (e.busy) return BUSY; throw e; }); }
  var TABS = [
    { key: 'metrics', label: 'Metrics', poll: 5000, build: metricsRows, load: function () { return api('/api/state'); } },
    { key: 'apps', label: 'Apps', build: appsRows, load: function () {
      return Promise.all([api('/api/launcher/apps'), soft(phi('sources'))]).then(function (a) {
        return { apps: (a[0] && a[0].apps) || [], inputs: a[1] === BUSY ? BUSY : (a[1] && a[1].sources) || [] };
      });
    } },
    { key: 'game', label: 'Game', build: gameRows, load: function () {
      return Promise.all([soft(phi('RpcGameBarProfileConfigGet', { gameprofCfgIdx: 0 })), soft(phi('RpcGeneralSrttingConfigRetrieve'))]).then(function (a) {
        return { bar: a[0] === BUSY ? BUSY : a[0] || {}, cfg: a[1] === BUSY ? BUSY : a[1] || {} };
      });
    } },
    { key: 'picture', label: 'Picture', poll: 5000, build: pictureRows, load: loadPicture },
    { key: 'audio', label: 'Audio', poll: 8000, build: audioRows, load: function () {
      return Promise.all([api('/api/state'), soft(phi('RpcSoundRetrieve'))]).then(function (a) {
        return { volume: a[0] && a[0].tv && a[0].tv.volume, sound: a[1] };
      });
    } },
    { key: 'ambilight', label: 'Ambilight', poll: 8000, build: ambilightRows, load: function () { return soft(phi('RpcSetupAmbilightGetConfig')); } },
    { key: 'home', label: 'Home', build: homeRows, load: function () {
      return Promise.all([api('/api/settings'), api('/api/launcher/apps').catch(function () { return { apps: [] }; })]).then(function (a) {
        return { settings: a[0], apps: (a[1] && a[1].apps) || [] };
      });
    } },
    { key: 'system', label: 'System', poll: 8000, build: systemRows, load: function () {
      return Promise.all([soft(phi('RpcGeneralSrttingConfigRetrieve')), api('/api/state'), api('/api/settings')]).then(function (a) {
        return { cfg: a[0], state: a[1], settings: a[2] };
      });
    } }
  ];

  /* Lists opened from a row. Each has its own back row first; Back and Left go up
     one. A list may read for itself (own), once or on an interval. */
  var SUBS = {
    procMem: { tab: 'metrics', own: loadProc('/api/processes'), poll: 5000, build: procMemRows },
    procCpu: { tab: 'metrics', own: loadProc('/api/cpu'), poll: 3000, build: procCpuRows },
    homeApps: { tab: 'home', build: homeAppsRows },
    homeAdd: { tab: 'home', parent: 'homeApps', build: homeAddRows, once: function () {
      if (caches.catalog) return Promise.resolve();
      return api('/api/titan/catalog').then(function (c) { caches.catalog = Array.isArray(c) ? c : (c && c.apps) || []; },
        function () { caches.catalog = []; });
    } },
    sysInfo: { tab: 'system', build: function (d) { return sysInfoRows(d); } }
  };
  function backRow(label) {
    return { label: '‹ ' + label, value: '', act: true, press: 'Press OK or Back to return', hint: 'Back to ' + label + '.', run: function () { backOut(); } };
  }

  /* ---------- state ---------- */
  var tab = 0, sel = 0, rows = [], sub = null, subFrom = 0, subSel = {}, subData = {};
  var busy = false, timer = null, subTimer = null, flashTimer = null, loading = false, failure = null, gen = 0;
  var ROW_VH = 7.6, TALL_VH = 10.2, HEAD_VH = 5.4;
  var STATUS_OF = { on: 'good', good: 'good', warn: 'hold', hold: 'hold', bad: 'bad', off: 'note', note: 'note' };

  function T() { return TABS[tab]; }
  function buildRows() {
    var d = data[T().key];
    if (!d) return [];
    if (sub) return SUBS[sub].build(d, subData[sub]) || [];
    return T().build(d) || [];
  }

  /* ---------- rendering ---------- */
  function subLines(r) { return r && r.sub ? [].concat(r.sub) : []; }
  function rowHeight(r) { return (r && r.head ? HEAD_VH : subLines(r).length > 1 ? TALL_VH : ROW_VH) * window.innerHeight / 100; }
  // A row that cannot be pressed but reports a coloured state is a read-out, so it
  // takes the status label rather than the coloured value the switches use.
  function valClass(r) {
    if (!r.cls) return '';
    if (!r.act && STATUS_OF[r.cls]) return ' st ' + STATUS_OF[r.cls];
    return ' ' + r.cls;
  }

  function showMessage(title, detail) {
    $('rows').innerHTML = '';
    var m = $('msg');
    m.style.display = 'block';
    m.innerHTML = esc(title) + (detail ? '<div class="msg-detail">' + esc(detail) + '</div>' : '');
    $('hint').className = '';
  }

  function adjustHtml(r) {
    var span = r.max - r.min || 1, at = (r.cur - r.min) / span * 100;
    var from = r.min < 0 && r.max > 0 ? (0 - r.min) / span * 100 : 0;
    return esc(r.value) + '<span class="bar"><i style="left:' + Math.min(from, at) + '%;width:' + Math.abs(at - from) + '%"></i>' +
      '<b style="left:' + at + '%"></b></span>';
  }

  function rowHtml(r, i) {
    if (r.head) return '<div class="row head"><span class="lbl">' + esc(r.label) + '</span></div>';
    return '<div class="row' + (i === sel ? ' sel' : '') + (r === adjusting ? ' adj' : '') + (r.act ? ' doable' : '') +
      (subLines(r).length > 1 ? ' tall' : '') + '" data-i="' + i + '">' +
      '<span class="lbl">' + esc(r.label) + '</span>' +
      '<span class="val' + valClass(r) + '">' + (r === adjusting ? adjustHtml(r) : esc(r.value)) +
      subLines(r).map(function (line) { return '<span class="sub">' + esc(line) + '</span>'; }).join('') + '</span></div>';
  }

  function render() {
    var box = $('rows');
    if (!rows.length) {
      var d = data[T().key];
      if (failure) {
        if (failure.busy) showMessage(NOT_NOW, 'The TV’s settings page is frozen while an app runs. This comes back when the app is closed.');
        else showMessage('Could not read the TV server', failure.message + (lan.url ? ' Use the web dashboard instead: ' + lan.url : ''));
      } else if (!d) showMessage('Loading…', '');
      else showMessage('Nothing to show here', '');
      return;
    }
    $('msg').style.display = 'none';
    box.innerHTML = rows.map(rowHtml).join('');
    position();
    renderHint();
  }

  function renderHint() {
    var el = $('hint'), r = rows[sel];
    if (!r || r.head) { el.className = ''; return; }
    $('hintTitle').textContent = r.label;
    $('hintBody').textContent = (r.hint || '') + (renderQr(r) && r.scan ? ' ' + r.scan : '');
    var peek = $('hintPeek'), names = r.peek || [];
    peek.innerHTML = names.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('') +
      (r.peekMore ? '<span class="peek-more">and ' + r.peekMore + ' more</span>' : '');
    peek.className = 'h-peek' + (names.length ? ' on' : '');
    var warn = $('hintWarn');
    warn.textContent = r.warn || '';
    warn.className = 'h-warn' + (r.warn ? ' on' : '');
    var act = $('hintAct');
    act.textContent = r === adjusting ? 'Left and Right to change, Up and Down for big steps, OK when done'
      : r.act ? (r.press || 'Press OK to change') : 'View only';
    act.className = 'h-act' + (r.act ? '' : ' ro');
    el.className = 'on';
  }

  // A row marked `web` can only be changed in a browser, so it offers a code to
  // scan rather than an address to type on a remote. The code carries the
  // address only, never the access token.
  function renderQr(r) {
    var box = $('hintQr'), url = r.web ? webUrl(r.web) : '';
    if (!url || typeof qrDraw !== 'function' || !qrDraw($('hintQrSvg'), url)) { box.className = 'h-qr'; return false; }
    $('hintUrl').textContent = url.replace(/^https?:\/\//, '');
    box.className = 'h-qr on';
    return true;
  }

  // Headings are not landing places, so the offset is summed from real row
  // heights. The list is anchored to the top and starts scrolling once the
  // selection passes the middle.
  function position() {
    var list = $('list');
    if (!list.clientHeight) list.style.height = $('main').clientHeight + 'px';
    var off = 0, total = 0, i;
    for (i = 0; i < rows.length; i++) {
      if (i < sel) off += rowHeight(rows[i]);
      total += rowHeight(rows[i]);
    }
    var y = list.clientHeight / 2 - rowHeight(rows[sel]) / 2 - off;
    var floor = Math.min(0, list.clientHeight - total);
    if (y > 0) y = 0;
    if (y < floor) y = floor;
    $('rows').style.transform = 'translateY(' + y + 'px)';
    $('moreUp').className = 'more' + (y < 0 ? ' on' : '');
    $('moreDown').className = 'more' + (y > floor ? ' on' : '');
  }

  // Moving the selection changes two classes and the offset: redrawing a list of
  // hundreds of rows per key press stutters on the TV's browser.
  function select(i) {
    var kids = $('rows').children;
    if (kids[sel]) kids[sel].className = kids[sel].className.replace(' sel', '');
    sel = i;
    if (kids[sel]) kids[sel].className += ' sel';
    position();
    renderHint();
  }

  function firstSel() { for (var i = 0; i < rows.length; i++) if (!rows[i].head) return i; return 0; }
  function lastSel() { for (var i = rows.length - 1; i >= 0; i--) if (!rows[i].head) return i; return 0; }
  function nextRow(i) {
    do { i++; } while (i < rows.length && rows[i].head);
    return i < rows.length ? i : firstSel();
  }

  function move(d) {
    if (adjusting || !rows.length) return;
    var i = sel;
    do { i += d; } while (i >= 0 && i < rows.length && rows[i].head);
    if (i < 0 || i >= rows.length) return;
    select(i);
  }

  // Channel Up and Down (or Page Up and Down): six selectable rows at a time.
  function page(d) {
    if (adjusting || !rows.length) return;
    var target = sel;
    for (var n = 0; n < 6; n++) {
      var next = target;
      do { next += d; } while (next >= 0 && next < rows.length && rows[next].head);
      if (next < 0 || next >= rows.length) break;
      target = next;
    }
    if (target === sel) target = d < 0 ? firstSel() : lastSel();
    if (target !== sel && rows[target] && !rows[target].head) select(target);
  }

  function renderTabs() {
    var bar = $('tabs');
    bar.innerHTML = TABS.map(function (t, i) {
      return '<div class="tab' + (i === tab ? ' on' : '') + '" data-label="' + esc(t.label) + '" data-i="' + i + '">' + esc(t.label) + '</div>';
    }).join('');
    // More tabs than fit across the screen: scroll the bar to keep the selected
    // one in view, and fade whichever edge has tabs hidden beyond it.
    var on = bar.children[tab];
    var left = on.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
    if (left < bar.scrollLeft) bar.scrollLeft = left;
    else if (left + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + on.offsetWidth - bar.clientWidth;
    bar.className = (bar.scrollLeft > 0 ? 'clip-l ' : '') + (bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1 ? 'clip-r' : '');
  }

  // Shown briefly after an action, long enough to read a sentence of advice.
  function flash(text) {
    var el = $('flash');
    el.textContent = text;
    el.className = 'on';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.className = ''; }, Math.max(2400, String(text).length * 55));
  }

  /* ---------- data ---------- */
  function fetchTab(keepSel) {
    var section = T(), key = section.key, view = sub, mine = gen;
    if (loading || document.hidden) return;
    if (view && SUBS[view].own) return;      // that list reads for itself
    loading = true;
    section.load().then(function (d) {
      loading = false;
      if (mine !== gen || sub !== view) return;           // the user moved on while this was in flight
      if (adjusting || adjustInFlight || busy) return;    // a setting is being changed
      failure = null;
      data[key] = d;
      rows = buildRows();
      if (!keepSel || sel >= rows.length || (rows[sel] && rows[sel].head)) sel = firstSel();
      render();
    }, function (e) {
      loading = false;
      if (mine !== gen || sub !== view) return;
      if (rows.length && !e.busy) return;                 // keep the last good rows on screen
      failure = e;
      data[key] = undefined;
      rows = [];
      render();
    });
  }

  function startTimer() {
    stopTimer();
    if (T().poll) timer = setInterval(function () { fetchTab(true); }, T().poll);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function stopSubTimer() { if (subTimer) { clearInterval(subTimer); subTimer = null; } }

  function openTab(i) {
    if (i < 0 || i >= TABS.length) return;
    if (adjusting) endAdjust();
    stopTimer();
    stopSubTimer();
    gen++;
    loading = false;
    tab = i;
    sub = null;
    sel = 0;
    failure = null;
    rows = [];
    renderTabs();
    if (data[T().key]) { rows = buildRows(); sel = firstSel(); }
    render();
    fetchTab(!!data[T().key]);
    startTimer();
  }

  /* ---------- lists opened from a row ---------- */
  function openList(key) {
    var s = SUBS[key];
    if (!sub) subFrom = sel; else subSel[sub] = sel;
    var back = sub && SUBS[sub].parent === undefined && SUBS[key].parent === sub ? false : (sub && s.parent === sub);
    stopSubTimer();
    sub = key;
    rows = buildRows();
    sel = subSel[key] !== undefined && subSel[key] < rows.length && !back ? subSel[key] : nextRow(firstSel());
    render();
    if (s.once) s.once().then(function () { if (sub === key) refreshSub(true); });
    if (s.own) {
      var go = function () {
        if (sub !== key) return;
        s.own().then(function (l) { if (sub !== key) return; subData[key] = l; refreshSub(true); });
      };
      subData[key] = null;
      go();
      subTimer = setInterval(go, s.poll || 5000);
    }
  }
  function refreshSub(keep) {
    if (adjusting || busy) return;
    rows = buildRows();
    if (!keep || sel >= rows.length || (rows[sel] && rows[sel].head)) sel = nextRow(firstSel());
    render();
  }
  function closeSub() {
    stopSubTimer();
    sub = null;
    rows = buildRows();
    sel = subFrom < rows.length && !rows[subFrom].head ? subFrom : firstSel();
    render();
  }
  function backOut() {
    if (sub && SUBS[sub].parent) return openList(SUBS[sub].parent);
    closeSub();
  }

  /* ---------- actions ---------- */
  /* Runs a request, then reads the tab again (after `delay` ms for PHI, which
     answers before a setting has taken). A refusal shows what the TV said. */
  function changing(p, note, o) {
    o = o || {};
    busy = true;
    var r = rows[sel];
    if (r && !r.head && !r.confirming && !o.quiet) { r.value = '…'; render(); }
    return p.then(function () {
      busy = false;
      if (note) flash(note);
      if (o.after) o.after();
      else setTimeout(function () { fetchTab(true); }, o.delay === undefined ? 300 : o.delay);
    }, function (e) {
      busy = false;
      flash(e.busy ? NOT_NOW : (e.message || 'That did not work'));
      fetchTab(true);
    });
  }

  // The row asks again before it acts, and forgets after five seconds.
  function confirmFirst(r, again) {
    if (r.confirming) { r.confirming = false; return false; }
    r.confirming = true;
    r.origValue = r.value;
    r.origPress = r.press;
    r.value = 'Confirm?';
    r.press = again;
    flash(again);
    render();
    setTimeout(function () {
      if (r.confirming) { r.confirming = false; r.value = r.origValue; r.press = r.origPress; render(); }
    }, 5000);
    return true;
  }

  function activate() {
    if (busy || !rows.length) return;
    var r = rows[sel];
    if (!r || !r.act) return;
    if (r.adj) return startAdjust();
    if (r.run) r.run(r);
  }

  /* Adjusting a setting, as LG's own menu does and Glasshouse's TV app after it:
     OK on its row starts, and the row shows a bar. Left and Right step by 1,
     faster the longer a key is held; Up and Down jump a tenth of the range; OK
     or Back finish. Outside it Left and Right always switch tabs, so a press can
     never land on another tab mid-change. The value goes to the TV as it
     changes, at most one request at a time, the last value always sent; polls
     leave the rows alone until the final value has gone. */
  var adjusting = null, adjustPending = [], adjustInFlight = false, adjustHeld = 0, adjustLastKey = 0;

  function startAdjust() {
    adjusting = rows[sel];
    if (adjusting.adjustSent === undefined) adjusting.adjustSent = adjusting.cur;
    adjustHeld = 0;
    render();
  }
  function endAdjust() {
    if (!adjusting) return;
    var r = adjusting;
    adjusting = null;
    render();
    pushAdjust(r);
  }
  // A held key repeats every 50-100 ms; after half a second held, steps grow to
  // a twentieth of the range, so 0 to 100 takes about two seconds.
  function adjustStep(dir, big) {
    var r = adjusting, range = r.max - r.min, now = Date.now();
    adjustHeld = now - adjustLastKey < 250 ? adjustHeld + 1 : 0;
    adjustLastKey = now;
    var unit = r.step || 1;
    var step = big ? Math.max(unit, Math.round(range / 10 / unit) * unit) : adjustHeld > 6 ? Math.max(unit, Math.round(range / 20 / unit) * unit) : unit;
    var next = Math.max(r.min, Math.min(r.max, r.cur + dir * step));
    if (next === r.cur) return;
    r.cur = next;
    r.value = r.fmt(next);
    drawAdjust();
    pushAdjust(r);
  }
  // Only the adjusted row is redrawn.
  function drawAdjust() {
    var el = $('rows').children[sel];
    if (!el || !adjusting) return render();
    el.querySelector('.val').innerHTML = adjustHtml(adjusting);
  }
  function pushAdjust(r) {
    if (r.cur !== r.adjustSent && adjustPending.indexOf(r) === -1) adjustPending.push(r);
    if (adjustInFlight) return;
    r = adjustPending.shift();
    if (!r) { if (!adjusting) fetchTab(true); return; }
    if (r.cur === r.adjustSent) return pushAdjust(r);
    adjustInFlight = true;
    var value = r.cur;
    r.commit(value).then(function () {
      adjustInFlight = false;
      r.adjustSent = value;
      pushAdjust(r);
    }, function (e) {
      adjustInFlight = false;
      // A refused value is not retried: the row is put right by the next read.
      r.adjustSent = r.cur;
      flash(e.busy ? NOT_NOW : (e.message || 'That did not work'));
      pushAdjust(r);
    });
  }

  /* ---------- clock ---------- */
  function tick() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    $('clock').textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* ---------- keys ---------- */
  function onKey(e) {
    var k = e.keyCode;
    if (typeof k === 'string') {      // TitanOS special keys (VK_HOME, VK_VOLUME_UP, ...): Back is ours, the rest go up
      if (k === 'VK_BACK') { e.preventDefault(); if (e.type === 'keydown') leave(); return; }
      post({ type: 'key', ev: e.type, keyCode: k, key: e.key || null, repeat: !!e.repeat });
      return;
    }
    var paging = [33, 34, 402, 403];
    var used = [37, 38, 39, 40, 13].concat(BACK_CODES, paging).indexOf(k) >= 0;
    if (e.type === 'keydown' && used) {
      if (adjusting) {
        // While a setting is being adjusted, every key belongs to it.
        if (k === 37) adjustStep(-1);
        else if (k === 39) adjustStep(1);
        else if (k === 38) adjustStep(1, true);
        else if (k === 40) adjustStep(-1, true);
        else if (k === 13 || BACK_CODES.indexOf(k) >= 0) endAdjust();
      }
      // Inside a list opened from a row, Left goes back up to it rather than to
      // another tab, and Right has nowhere to go.
      else if (k === 37) { if (sub) backOut(); else openTab(tab - 1); }
      else if (k === 39) { if (!sub) openTab(tab + 1); }
      else if (k === 38) move(-1);
      else if (k === 40) move(1);
      else if (k === 33 || k === 402) page(-1);
      else if (k === 34 || k === 403) page(1);
      else if (k === 13) { if (!e.repeat) activate(); }
      else if (BACK_CODES.indexOf(k) >= 0) { if (!e.repeat) leave(); }
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }
  // Back goes up one list, and out of the app from the top.
  function leave() { if (sub) backOut(); else backToLauncher(); }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  // A pointer (a mouse while testing): click a tab, a row, or a selected row again to act on it.
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-i'))) t = t.parentNode;
    if (!t || !t.getAttribute) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    if (t.className.indexOf('tab') >= 0) return openTab(i);
    if (adjusting) return endAdjust();
    if (!rows[i] || rows[i].head) return;
    if (sel === i && rows[i].act) activate(); else select(i);
  });

  // The Magic Remote's wheel (and a mouse wheel) moves a row per notch.
  document.addEventListener('wheel', function (e) {
    if (e.deltaY) move(e.deltaY > 0 ? 1 : -1);
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('resize', function () { if (rows.length) position(); });

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.src !== 'cactarium-hook') return;
    if (inFrame && ev.source !== window.parent) return;
    if (d.type === 'home' || d.type === 'shown') backToLauncher();   // Home, or the screen came back: the launcher is home
    else if (d.type === 'key') onKey({ type: d.ev, keyCode: d.keyCode, key: d.key, repeat: false, preventDefault: function () {}, stopPropagation: function () {} });
  });

  /* ---------- boot ---------- */
  var initTab = 0, want = (location.search.match(/[?&]tab=([^&]+)/) || [])[1];
  if (want) for (var ti = 0; ti < TABS.length; ti++) if (TABS[ti].key === decodeURIComponent(want).toLowerCase()) initTab = ti;
  tick();
  setInterval(tick, 10000);
  readLan();
  setInterval(readLan, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) fetchTab(true); });
  openTab(initTab);
  window.focus();
  // The hook drops a launcher frame that stops sending its heartbeat, and
  // takes this page for it; "ready" is not repeated, the hook already has it.
  post({ type: 'alive' });
  setInterval(function () { post({ type: 'alive' }); }, 2000);
})();
