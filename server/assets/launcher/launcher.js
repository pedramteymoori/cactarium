/* Cactarium launcher.
 *
 * Runs inside an iframe that /phi-hook.js puts over the TV's native UI. All
 * TV actions go through window.parent.postMessage (the hook calls PHI's own
 * functions). Opened on its own (no parent) it shows the fallback lists and
 * every bridge call fails, which is handy for a desktop browser.
 * Look and feel derived from Glasshouse Home (MIT License, (c) 2026 Rory Gallagher).
 *
 * Messages to the hook (all carry src:'cactarium-launcher'):
 *   {type:'ready'} {type:'alive'} {type:'close'} {type:'stock-home'}
 *   {id,type:'list-apps'} {id,type:'list-sources'} {id,type:'launch',app}
 *   {id,type:'local',fn:'media'|'simple_setup'|'alexa'}   a PHI page / function behind a catalog tile
 *   {id,type:'source',origname|typeId} {id,type:'open',what:'sources'}
 *   {type:'key',ev,keyCode,key,repeat}   a key this page did not use (Home, volume)
 *   {type:'backdrop-key',keyCode}        a key that reached us while a PHI page is on top
 *   {type:'diag',ev,data}
 * From the hook: {src:'cactarium-hook', type:'result',id,ok,data|error},
 *   {type:'hello'}, {type:'home'}, {type:'key',ev,keyCode} (forwarded key),
 *   {type:'backdrop',on}  a PHI page is (no longer) open on top of the launcher,
 *   {type:'shown',reason}  the (kept) page is on screen again.
 *   {type:'hidden'}  the hook put the page away (it stays loaded); the animated background stops.
 *   hello carries visible:bool, whether the page is on screen at that moment.
 *
 * The Apps row normally comes from GET /api/launcher/apps (launcher.apps in the
 * config: TitanOS catalog codes in order); list-apps is the fallback.
 *
 * list-apps  -> {apps:[{id,name,jumpName,type,url,icon(raw appIconURI),...}]}
 * list-sources -> {sources:[{typeId,origname,name,sub,kind,connected,current}]}
 */
(function () {
  'use strict';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13 };
  var BACK_CODES = [8, 27, 461, 10009];
  var inFrame = window.parent && window.parent !== window;
  var STORE_KEY = 'cactarium.launcher.focus.v1';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode, quota */ } }

  /* ---------- stage scaling ---------- */
  var stage = $('stage');
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = Math.max(0, (window.innerWidth - 1920 * s) / 2) + 'px';
    stage.style.top = Math.max(0, (window.innerHeight - 1080 * s) / 2) + 'px';
  }
  window.addEventListener('resize', fit);
  fit();

  /* ---------- clock (drifts a few px every few minutes against burn-in) ---------- */
  var DRIFT = [[0, 0], [10, 5], [-6, 12], [12, -4], [-10, -8], [4, 14], [-12, 4]];
  function tick() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    $('clock').textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    try {
      $('date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
    } catch (e) { $('date').textContent = d.toDateString(); }
    var p = DRIFT[Math.floor(d.getTime() / 240000) % DRIFT.length];   // every 4 minutes
    $('now').style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
    if (window.cactariumBackground) window.cactariumBackground.tick();   // the part of the day may have changed
  }
  tick();
  setInterval(tick, 10000);

  /* ---------- background (background.js) ---------- */
  var bg = window.cactariumBackground;
  // Standalone (a desktop browser) there is no hook to say it is hidden: the page's own visibility rules.
  if (bg) { if (inFrame) bg.setVisible(false); bg.refresh(); }

  /* ---------- weather badge (server caches Open-Meteo; hidden if not configured) ---------- */
  function loadWeather() {
    try {
      fetch('/api/launcher/weather', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var w = j && j.ok && j.weather;
        var b = $('weather');
        if (!w) { b.className = 'none'; return; }
        $('wxTemp').textContent = w.temp + '\u00b0';
        $('wxLine').textContent = w.label || '';
        b.className = '';
      }).catch(function () {});
    } catch (e) { /* no fetch */ }
  }
  loadWeather();
  setInterval(loadWeather, 30 * 60000);

  /* ---------- bridge ---------- */
  var seq = 0, pending = {};
  function post(msg) {
    if (!inFrame) return false;
    msg.src = 'cactarium-launcher';
    try { window.parent.postMessage(msg, '*'); return true; } catch (e) { return false; }
  }
  function call(type, extra, timeout) {
    return new Promise(function (resolve, reject) {
      if (!inFrame) { reject(new Error('no bridge (standalone)')); return; }
      var id = ++seq, msg = { id: id, type: type };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      var t = setTimeout(function () { delete pending[id]; reject(new Error('timeout')); }, timeout || 5000);
      pending[id] = { resolve: resolve, reject: reject, t: t };
      post(msg);
    });
  }
  function diag(ev, data) { post({ type: 'diag', ev: ev, data: data }); }

  /* ---------- icons ---------- */
  // appIconURI as PHI treats it (pages/main/launcher.js convertAppIcon): http(s)
  // as is; "/..." an absolute file path; otherwise a bundled asset name. The
  // iframe cannot load file://, so everything but http(s) goes through
  // /launcher/icon (the server resolves names against PHI's assets/launcher/images).
  var NAME_ICON = {            // launcher.js:241-259 (k), used when the TV gives no usable icon
    'YouTube': 'youtube.png', 'Netflix': 'netflix.png', 'Prime Video': 'prime.png', 'BBC iPlayer': 'bbc.png',
    'Channel 4': 'channel4.png', 'My5': 'my5.png', 'ITVX': 'itvx.png', 'Freeview Explore': 'freeviewplay-explore.png',
    'Amazon Alexa': 'AVS.png', 'Google Assistant': 'GA.svg', 'Simple Setup': 'SSU-153x153-W.jpg',
    'Disney+': 'disneyplus_500x500.png', 'Playfi': 'tv_launcher_play_fi.png', 'Internet browser': 'icon_70_Internet_Browser.svg',
    // PHI draws this one with a CSS class; the same file is in its bundle (launcher.js:133-136)
    'Aurora': 'icon_429_Aurora.svg',
    'TitanOS home': '/launcher/home.svg'
  };
  function iconUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    if (/^https?:\/\//i.test(raw) || raw.indexOf('/launcher/') === 0) return raw;
    return '/launcher/icon?src=' + encodeURIComponent(raw);
  }
  // Built-in apps whose appIconURI is a wide banner in assets/ihs/images/apps
  // (banner_<id>.png); the square glyphs PHI's quick menu uses read better.
  var ID_ICON = {
    'aurora': 'assets/quickmenu/icon_429_Aurora.svg',
    'sunrise_alarm': 'assets/quickmenu/icon_427_Sunrise_Alarm.svg',
    'demo_me': 'assets/quickmenu/icon_83_Demo_Mode.svg'
  };
  function iconCandidates(it) {
    var out = [];
    [ID_ICON[it.id], it.icon, NAME_ICON[it.title]].forEach(function (raw) {
      var u = iconUrl(raw);
      if (u && out.indexOf(u) < 0) out.push(u);
    });
    return out;
  }

  /* ---------- data ---------- */
  var FALLBACK_APPS = [
    { name: 'Netflix', preset: 'netflix' },
    { name: 'YouTube', preset: 'youtube' },
    { name: 'Prime Video', preset: 'prime video' },
    { name: 'Disney+', preset: 'disney+' },
    { name: 'Internet browser', preset: 'internet browser' }
  ];
  var apps = FALLBACK_APPS.map(function (a) { return { kind: 'app', key: 'a:' + a.name, title: a.name, app: a }; });
  var tail = [
    { kind: 'stock', key: 't:stock', title: 'TitanOS home', stock: true }
  ];
  // Cactarium's own TV app (/tvapp), always the first app. Not a catalog entry.
  var CACTARIUM_TILE = { kind: 'tvapp', key: 't:cactarium', title: 'Cactarium', icon: '/launcher/cactarium.svg' };
  var SOURCES_TILE = { kind: 'sources', key: 't:sources', title: 'Sources', sub: 'All TV sources' };
  var inputs = [
    { kind: 'source', key: 's:6', id: '6', title: 'TV', sub: '', typeId: 6, origname: 'TV' },
    { kind: 'source', key: 's:2', id: '2', title: 'HDMI 1', sub: '', typeId: 2, origname: 'HDMI 1' },
    { kind: 'source', key: 's:3', id: '3', title: 'HDMI 2', sub: '', typeId: 3, origname: 'HDMI 2' },
    { kind: 'source', key: 's:4', id: '4', title: 'HDMI 3', sub: '', typeId: 4, origname: 'HDMI 3' },
    { kind: 'source', key: 's:11', id: '11', title: 'HDMI 4', sub: '', typeId: 11, origname: 'HDMI 4' }
  ];
  var catalogList = null;     // GET /api/launcher/apps; when set it is the Apps row (items are rebuilt in build())
  var rows = [];              // [{id,title,note,items,col,el,track,tiles,shift}]
  var cur = 0;

  function appItems(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.name) continue;
      out.push({ kind: 'app', key: 'a:' + (a.id || a.name), id: a.id || '', title: a.name, icon: a.icon, app: a });
    }
    return out;
  }

  function sourceItems(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s.typeId !== 'number') continue;
      var sub = s.sub || '';
      out.push({ kind: 'source', key: 's:' + s.typeId, id: String(s.typeId), title: s.name || s.origname, sub: sub,
        typeId: s.typeId, origname: s.origname, connected: s.connected, current: !!s.current, hdmi: s.kind === 'hdmi' });
    }
    return out;
  }

  // Catalog apps (GET /api/launcher/apps). TitanOS gives a launch URL; the hook
  // wants either {name,url} for a web app or a bare native name (no id).
  var NATIVE_URL = { 'localfunction:gotonetflix': 'Netflix', 'localfunction:gotoaiv': 'Prime Video', 'localfunction:gotoopeninternet': 'Internet browser' };
  var NATIVE_CODE = { youtube: 'YouTube', disney: 'Disney+' };
  var LOCAL_FN = { 'localfunction:simple_setup': 'simple_setup', 'localfunction:alexa': 'alexa', 'localfunction:media': 'media' };
  function catalogItem(a) {
    var code = a.code, url = a.url || '', it = { kind: 'app', key: 'a:' + code, id: code, title: a.name || code, icon: '/launcher/titan-icon?code=' + encodeURIComponent(code) };
    if (NATIVE_CODE[code]) it.app = { name: NATIVE_CODE[code] };
    else if (NATIVE_URL[url]) it.app = { name: NATIVE_URL[url] };
    else if (/^https?:\/\//i.test(url)) it.app = { name: it.title, url: url, appType: a.app_type || 'NetTV', resolution: a.resolution || '' };
    else if (LOCAL_FN[url]) { it.kind = 'local'; it.fn = LOCAL_FN[url]; }
    else it.unsupported = url;
    return it;
  }
  function catalogItems(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.code) continue;
      if (a.code === 'tv') continue;   // TitanOS lists the TV source as an app; it is the Inputs row's first tile here
      out.push(catalogItem(a));
    }
    return out;
  }

  /* ---------- focus memory (per row + last row), localStorage in this iframe ---------- */
  var mem = { row: '', keys: {} };
  var moved = false;          // until the user moves, rebuilds keep the remembered focus
  try { var m0 = JSON.parse(lsGet(STORE_KEY) || 'null'); if (m0 && typeof m0 === 'object') { mem.row = String(m0.row || ''); mem.keys = m0.keys || {}; } } catch (e) { /* ignore */ }
  function remember() {
    rows.forEach(function (r) { var it = r.items[r.col]; if (it) mem.keys[r.id] = it.key; });
    if (rows[cur]) mem.row = rows[cur].id;
    lsSet(STORE_KEY, JSON.stringify(mem));
  }

  function build() {
    if (rows.length && moved) remember();
    if (catalogList) { apps = catalogItems(catalogList); apps.live = true; }
    var host = $('rowsIn');
    host.innerHTML = '';
    var defs = [];
    defs.push({ id: 'apps', title: 'Apps', note: apps.live ? apps.length + (apps.length === 1 ? ' app' : ' apps') : 'built-in list', items: [CACTARIUM_TILE].concat(apps, tail) });
    var hdmi = 0, known = false;
    inputs.forEach(function (s) { if (s.hdmi && typeof s.connected === 'boolean') { known = true; if (s.connected) hdmi++; } });
    defs.push({ id: 'inputs', title: 'Inputs', note: known ? (hdmi ? 'Devices on ' + hdmi + ' HDMI input' + (hdmi === 1 ? '' : 's') : 'No devices on HDMI') : '', items: inputs.concat([SOURCES_TILE]) });
    rows = defs;
    var curId = mem.row;
    cur = 0;
    rows.forEach(function (r, ri) {
      r.col = 0; r.shift = 0;
      var want = mem.keys[r.id];
      for (var i = 0; i < r.items.length; i++) if (r.items[i].key === want || r.items[i].key.replace(/^r:/, '') === want) { r.col = i; break; }
      if (r.id === curId) cur = ri;
      r.el = el('section', 'row');
      var h = el('h2', null, r.title);
      if (r.note) h.appendChild(el('small', null, r.note));
      var wrap = el('div', 'wrap');
      r.wrap = wrap;
      r.track = el('div', 'track');
      r.tiles = r.items.map(function (it) {
        var t = tile(it);
        r.track.appendChild(t);
        return t;
      });
      wrap.appendChild(r.track);
      r.el.appendChild(h); r.el.appendChild(wrap);
      host.appendChild(r.el);
    });
    paint(true);
  }

  function tile(it) {
    var isSrc = (it.kind === 'source' && it.key.indexOf('a:') !== 0 && it.key.indexOf('r:a:') !== 0) || it.kind === 'sources';   // the TV tile in the Apps row is a plain app tile
    var t = el('div', 'tile ' + (isSrc ? 'src' : 'app'));
    if (it.stock) t.className += ' stock';
    if (isSrc) {
      if (it.kind === 'source' && it.connected === true) t.className += ' live';
      else if (it.kind === 'source' && it.connected === false && !it.current) t.className += ' idle';
      if (it.current) t.className += ' cur';
      var head = el('div', 'dhead');
      head.appendChild(el('div', 'nm', it.title));
      head.appendChild(el('div', 'path', it.sub || ''));
      t.appendChild(head);
      var st = it.current ? 'Current' : it.connected === true ? 'Connected' : it.connected === false ? 'Nothing connected' : '';
      t.appendChild(el('div', 'st', st || '\u00a0'));
    } else {
      var ic = el('div', 'ic');
      var cands = iconCandidates(it);
      if (cands.length) {
        var img = new Image(), n = 0;
        img.decoding = 'async';
        img.onerror = function () {
          n++;
          if (n < cands.length) { img.src = cands[n]; return; }
          if (img.parentNode) ic.removeChild(img);
          ic.textContent = mono(it.title);
          diag('icon-miss', { title: it.title, id: it.id || '', icon: it.icon || '' });
        };
        img.src = cands[0];
        ic.appendChild(img);
      } else {
        ic.textContent = mono(it.title);
        diag('icon-miss', { title: it.title, id: it.id || '', icon: '' });
      }
      t.appendChild(ic);
      t.appendChild(el('div', 'nm', it.title));
    }
    return t;
  }
  function mono(s) { if (s === 'TV') return s; return (String(s).replace(/[^A-Za-z0-9]/g, '').charAt(0) || '?').toUpperCase(); }

  function paint(instant) {
    var rin = $('rowsIn');
    if (instant) { rin.style.transition = 'none'; }
    rows.forEach(function (r, ri) {
      r.el.className = 'row' + (ri === cur ? ' on' : '');
      r.tiles.forEach(function (t, ci) {
        var f = ri === cur && ci === r.col;
        var base = t.className.replace(/ ?focus/g, '');
        t.className = f ? base + ' focus' : base;
      });
      // long rows: keep the focused tile inside [~0, 1780] by shifting the track
      var t = r.tiles[r.col];
      if (t) {
        var x = t.offsetLeft, w = t.offsetWidth;
        var vis = r.wrap.clientWidth - 44;
        if (x + w - r.shift > vis) r.shift = x + w - vis;
        if (x - r.shift < 0) r.shift = x;
        if (r.col === 0) r.shift = 0;
      }
      if (instant) r.track.style.transition = 'none';
      r.track.style.transform = 'translateX(' + (-r.shift) + 'px)';
    });
    if (instant) {
      void stage.offsetWidth;             // flush, then re-enable the transitions
      $('rows').style.transition = '';
      rows.forEach(function (r) { r.track.style.transition = ''; });
    }
    // vertical: centre the rows in the area, or scroll to keep the focused row in view
    var area = $('rows'), areaH = area.clientHeight, contentH = rin.offsetHeight, y;
    if (contentH <= areaH) y = Math.round((areaH - contentH) / 2);
    else y = -Math.min(rows[cur].el.offsetTop, contentH - areaH);
    rin.style.transform = 'translateY(' + y + 'px)';
    area.className = contentH > areaH ? 'scrolled' : '';
    if (instant) { void stage.offsetWidth; rin.style.transition = ''; }
  }

  /* ---------- actions ---------- */
  var busy = false, toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.className = 'on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 4000);
  }
  function setBusy(on, text) {
    busy = on;
    $('busy').className = on ? 'on' : '';
    if (text) $('busyText').textContent = text;
  }
  function fail(e, what) {
    setBusy(false);
    var m = (e && e.message) || String(e);
    toast(what + ': ' + m + (m.indexOf('Wakeup result') === 0 ? ' - try TitanOS home' : ''));
    diag('action-failed', { what: what, err: m });
  }

  function activate(it) {
    if (busy || !it) return;
    diag('activate', { kind: it.kind, title: it.title });
    if (it.kind === 'app' && !it.app) {
      diag('launch-unsupported', { code: it.id, url: it.unsupported || '' });
      toast(it.title + ' is not supported here');
    } else if (it.kind === 'local') {
      call('local', { fn: it.fn }, 8000).then(function () {}, function (e) { fail(e, 'Could not open ' + it.title); });
    } else if (it.kind === 'app') {
      setBusy(true, 'Opening ' + it.title);
      call('launch', { app: it.app }, 8000).then(function () {
        // the hook removes this page on success; if we are still here, recover
        setTimeout(function () { setBusy(false); }, 1500);
      }, function (e) { fail(e, 'Could not open ' + it.title); });
    } else if (it.kind === 'source') {
      setBusy(true, 'Switching to ' + it.title);
      call('source', { origname: it.origname, typeId: it.typeId }, 8000).then(function () {
        setTimeout(function () { setBusy(false); }, 1500);
      }, function (e) { fail(e, 'Could not switch'); });
    } else if (it.kind === 'sources') {
      call('open', { what: 'sources' }).catch(function (e) { fail(e, 'Sources'); });
    } else if (it.kind === 'tvapp') {
      // Same iframe, another page: the hook keeps the frame, /tvapp keeps its
      // heartbeat and goes back to /launcher on Back or Home. replace() keeps
      // Back from stacking history entries.
      if (moved) remember();
      window.location.replace('/tvapp');
    } else if (it.stock) {
      post({ type: 'stock-home' });
    }
  }

  function close() { if (moved) remember(); if (!post({ type: 'close' })) toast('Back (standalone page)'); }

  /* ---------- keys ---------- */
  function move(dr, dc) {
    moved = true;
    if (dr) {
      var n = cur + dr;
      if (n >= 0 && n < rows.length) cur = n;
    } else {
      var r = rows[cur], c = r.col + dc;
      if (c >= 0 && c < r.items.length) r.col = c;
    }
    paint();
    remember();
  }

  var backdrop = false;        // a PHI page (Sources) is open on top of us
  function onKey(e) {
    var k = e.keyCode;
    if (backdrop) {             // its keys are not ours; the hook moves focus back to PHI
      if (e.type === 'keydown') post({ type: 'backdrop-key', keyCode: k });
      return;
    }
    if (typeof k === 'string') {                 // TitanOS special keys (VK_HOME, VK_VOLUME_UP, ...)
      if (k === 'VK_BACK') { e.preventDefault(); if (e.type === 'keydown') close(); return; }
      post({ type: 'key', ev: e.type, keyCode: k, key: e.key || null, repeat: !!e.repeat });
      return;
    }
    var used = true;
    if (e.type === 'keydown') {
      if (busy) { e.preventDefault(); return; }
      if (k === KEY.LEFT) move(0, -1);
      else if (k === KEY.RIGHT) move(0, 1);
      else if (k === KEY.UP) move(-1, 0);
      else if (k === KEY.DOWN) move(1, 0);
      else if (k === KEY.ENTER) { if (!e.repeat) activate(rows[cur].items[rows[cur].col]); }
      else if (BACK_CODES.indexOf(k) >= 0) { if (!e.repeat) close(); }
      else used = false;
    } else {
      used = [KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN, KEY.ENTER].concat(BACK_CODES).indexOf(k) >= 0;
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  /* ---------- messages from the hook ---------- */
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.src !== 'cactarium-hook') return;
    if (inFrame && ev.source !== window.parent) return;
    if (d.type === 'result') {
      var p = pending[d.id];
      if (!p) return;
      clearTimeout(p.t); delete pending[d.id];
      if (d.ok) p.resolve(d.data); else {
        var err = new Error(d.error || 'failed'); err.data = d.data; p.reject(err);
      }
    } else if (d.type === 'hello') {
      diag('hello', { caps: d.caps });
      // The page is preloaded hidden: only an animated background that is on screen runs.
      if (bg) { bg.setVisible(d.visible !== false); bg.refresh(); }
      load();
    } else if (d.type === 'home') {
      moved = true; cur = 0; rows.forEach(function (r) { r.col = 0; r.shift = 0; }); paint(); remember();
    } else if (d.type === 'shown') {          // the hook keeps this page loaded between shows
      setBusy(false); backdrop = false;
      if (bg) { bg.setVisible(true); bg.refresh(); }
      loaded = false; load();
    } else if (d.type === 'hidden') {         // the hook put this page away; stop drawing
      if (bg) bg.setVisible(false);
    } else if (d.type === 'backdrop') {
      backdrop = !!d.on;
    } else if (d.type === 'key') {                // forwarded from PHI's document
      var fake = { type: d.ev, keyCode: d.keyCode, key: d.key, repeat: false, preventDefault: function () {}, stopPropagation: function () {} };
      onKey(fake);
    }
  });

  /* ---------- data load ---------- */
  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    loadCatalogApps().then(function (ok) { if (!ok) loadPhiApps(); });
    call('list-sources', {}, 6000).then(function (r) {
      var out = sourceItems((r && r.sources) || []);
      if (out.length) {
        inputs = out; inputs.live = true;
        diag('sources', { n: out.length });
        build();
      }
    }).catch(function (e) { diag('list-sources-failed', { err: String(e && e.message || e) }); });
  }

  // The configured favourites; resolves true when they replaced the row.
  function loadCatalogApps() {
    return new Promise(function (resolve) {
      try {
        fetch('/api/launcher/apps', { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (j) {
          if (j && j.apps && j.apps.length) {
            catalogList = j.apps;
            diag('apps', { n: j.apps.length, source: 'catalog', missing: j.missing || [] });
            build();
            resolve(true);
          } else resolve(false);
        }).catch(function (e) { diag('catalog-apps-failed', { err: String(e && e.message || e) }); resolve(false); });
      } catch (e) { resolve(false); }
    });
  }

  // PHI's own app list: the fallback when no favourites are configured.
  function loadPhiApps() {
    call('list-apps', {}, 6000).then(function (r) {
      if (r && r.apps && r.apps.length) {
        var seen = {};
        var list = r.apps.filter(function (a) { var k = a.id || a.name; if (seen[k]) return false; seen[k] = 1; return a.type !== 1 || a.name; });
        apps = appItems(list); apps.live = true;
        diag('apps', { n: apps.length });
        build();
      }
    }).catch(function (e) { diag('list-apps-failed', { err: String(e && e.message || e) }); });
  }

  /* ---------- boot ---------- */
  build();
  window.focus();
  post({ type: 'ready', info: { w: window.innerWidth, h: window.innerHeight } });
  setInterval(function () { post({ type: 'alive' }); }, 2000);
  // If the hook's hello never arrives (older hook), still try the lists.
  setTimeout(load, 1500);
})();
