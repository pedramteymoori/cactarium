/* Cactarium Home-button hook.
 *
 * Loaded by ONE line added to the TV's native UI ("PHI"):
 *   .../webui/PHI/page/index.html  ->  <script src="http://localhost:8090/phi-hook.js" async></script>
 * What it does: docs/launcher.md.
 *
 * Contract: this file must never break PHI. Everything is wrapped in
 * try/catch, nothing here is required by PHI, and every capability is probed
 * at the moment of use. If something is missing the hook does nothing and the
 * stock Home behaviour runs.
 */
(function () {
  'use strict';
  var VERSION = 'phi-hook/0.38';
  try {
    if (window.__cactariumPhiHook) return;      // double include (ui/page + PHI/page)
    if (window.top !== window) return;          // only the top PHI document
    window.__cactariumPhiHook = VERSION;

    /* ---------- config ---------- */
    var BASE = 'http://localhost:8090';
    try {
      var cs = document.currentScript;
      if (cs && cs.src) { var m = /^(https?:\/\/[^\/]+)/.exec(cs.src); if (m) BASE = m[1]; }
    } catch (e) { /* keep default */ }
    var ALLOWED_ORIGINS = [BASE, 'http://localhost:8090', 'http://127.0.0.1:8090'];
    // Double-Home escape. The IR remote can deliver repeated keydowns (170-320 ms
    // apart, e.repeat unset) while the key is held, so a second keydown alone is
    // not a second press. A real double press is: keydown, keyup, NEW keydown,
    // all within DOUBLE_HOME_MS of the first keydown. A keydown closer than
    // REPEAT_MS to the previous one with no keyup between is a repeat. If keyups
    // for Home are never delivered (st.upSeen stays false for the whole
    // session) we fall back to timing only: ignore < FALLBACK_REPEAT_MS after the
    // previous keydown, and count a second one in FALLBACK_REPEAT_MS..FALLBACK_DOUBLE_MS.
    var DOUBLE_HOME_MS = 800;
    var REPEAT_MS = 400;
    var MIN_DOUBLE_GAP_MS = 120;     // no human double-taps faster than this
    var FALLBACK_REPEAT_MS = 450;
    // Measured on the TV (55PUS8450 remote): neither a hold nor a quick
    // double tap delivers a keyup between the presses, and both deliver the
    // second keydown ~480-500 ms after the first. A hold then keeps repeating
    // every ~105 ms; a double tap stops. So a second keydown with no keyup is
    // a double tap when no further keydown follows within SETTLE_MS.
    var SETTLE_MS = 250;
    var FALLBACK_DOUBLE_MS = 900;
    var READY_TIMEOUT_MS = 3500;     // launcher iframe must say "ready" by then
    var ALIVE_TIMEOUT_MS = 9000;     // launcher heartbeat (every 2s) must keep coming
    var Z = 90000000;                // PHI windows grow from 1; volume bar is 1e8

    var st = {
      enabled: false, layer: 'state', enabledAt: 0,
      visible: false, box: null, frame: null, ready: false,
      lastHome: 0, firstDown: 0, lastDown: 0, upSinceFirst: false, upSeen: false, ignoredLogged: 0, rawLogged: false, srcLogged: false,
      swallowKeyup: false, quietUntil: 0,
      lastAlive: 0, readyTimer: 0, aliveTimer: 0, focusTimer: 0,
      prev: null, selfUiHide: false, diagCount: 0, seenKeys: {}, seenCount: 0,
      backdrop: false, bdWin: null, bdTimer: 0,
      debugTimer: 0,
      anchor: null              // layer "page": the PHI window (blankpage) that stands for us in Scheduler's stack
    };

    /* ---------- helpers ---------- */
    function noop() {}
    function fn(name) { try { return typeof window[name] === 'function' ? window[name] : null; } catch (e) { return null; } }
    function safe(f, d) { try { return f(); } catch (e) { return d; } }
    function now() { return Date.now(); }
    function errStr(e) { return String((e && (e.message || e.stack)) || e); }
    function sched() { return safe(function () { return window.Scheduler || window.S || null; }, null); }
    function pages() { return safe(function () { return window.Pages || null; }, null); }
    function getShim() {
      var S = sched(), P = pages();
      if (!S || !P) return null;
      return safe(function () { return S.getWindow(-1).getPageByPath(P.shim); }, null) ||
             safe(function () { return S.getWindowByPath('/base/shim').getPageByPath(P.shim); }, null);
    }

    /* ---------- diagnostics: POST text/plain no-cors to /api/home/diag ---------- */
    function diag(ev, data) {
      try {
        if (st.diagCount++ > 400) return;
        var body = JSON.stringify({ src: 'phi-hook', v: VERSION, ev: ev, t: now(), data: data === undefined ? null : data });
        if (typeof fetch === 'function') {
          fetch(BASE + '/api/home/diag', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: body })
            .then(noop, noop);
        } else {
          var x = new XMLHttpRequest();
          x.open('POST', BASE + '/api/home/diag', true);
          x.setRequestHeader('Content-Type', 'text/plain');
          x.send(body);
        }
      } catch (e) { /* diagnostics must never throw */ }
    }

    /* ---------- debug channel (launcher.debug; see server/launcher_debug.go) ---------- */
    // Runs snippets queued from a shell on the TV, so PHI's state can be
    // inspected without a reboot per experiment. Off unless the config says so.
    function setDebug(on) {
      if (on === !!st.debugTimer) return;
      if (!on) { clearInterval(st.debugTimer); st.debugTimer = 0; diag('debug', { on: false }); return; }
      st.debugTimer = setInterval(pollDebug, 1000);
      diag('debug', { on: true });
    }
    function pollDebug() {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', BASE + '/api/launcher/debug?_=' + now(), true);
        x.timeout = 2000;
        x.onload = function () {
          if (x.status !== 200) return;
          var j, out = { ok: true };
          try {
            j = JSON.parse(x.responseText); out.id = j.id;
            var f = new Function('st', 'S', 'P', 'diag', 'activeWin', 'winPath', j.js);
            var v = f(st, sched(), pages(), diag, activeWin, winPath);
            out.value = safe(function () { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }, String(v));
          } catch (e) { out.ok = false; out.err = errStr(e); }
          diag('debug-result', out);
        };
        x.send();
      } catch (e) { /* ignore */ }
    }

    /* ---------- kill switch: GET /api/launcher/enabled ---------- */
    function refreshEnabled(cb) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', BASE + '/api/launcher/enabled?_=' + now(), true);
        x.timeout = 2000;
        x.onload = function () {
          try {
            var j = JSON.parse(x.responseText);
            st.enabled = x.status === 200 && j && j.enabled === true;
            st.layer = j && j.layer === 'state' ? 'state' : 'page';
            setDebug(!!(j && j.debug));
            st.enabledAt = now();
          } catch (e) { st.enabled = false; }
          if (cb) cb(st.enabled);
        };
        x.onerror = x.ontimeout = function () { st.enabled = false; if (cb) cb(false); };
        x.send();
      } catch (e) { st.enabled = false; }
    }

    /* ---------- layering ---------- */
    // PHI draws into a transparent body. Native code decides whether that
    // layer is shown and who owns key focus; PHI tells it through
    // RpcUiSetState/RpcUiReportState (win-manager.js:987-1013), which
    // Scheduler.onopen (win-manager.js:6240-6256) calls whenever a page is
    // opened. We make the same calls for our overlay, and on close we ask
    // Scheduler.onopen to recompute them from the real window stack.
    function bringFront() {
      var P = pages(), S = sched(), info = { layer: st.layer };
      st.prev = {
        uiShow: safe(function () { return document.__uiShow__; }, undefined),
        webui: safe(function () { return typeof window.getWebuiShowHide === 'function' ? window.getWebuiShowHide() : undefined; }, undefined),
        top: safe(function () { var a = S.getActived(); return a && a.app && a.app.path; }, null),
        src: safe(function () { return S.sourceTypeId; }, null)
      };
      info.prev = st.prev;
      if (st.layer === 'page' && S && P && P.blankpage) {
        // Put a real, opaque-to-PHI window on Scheduler's stack for us. PHI then
        // keeps its layer shown and, when a page opened over us closes, goes
        // back to this window instead of handing the screen to the app below
        // (which made the app/TitanOS launcher flash, seen on the TV).
        try {
          S.open(P.blankpage); st.anchor = activeWin(); info.page = 'opened blankpage'; info.anchor = winPath(st.anchor);
          // blankpage paints itself solid black (blankpage.js onShow) and PHI
          // raises it when it gets focus back, before we come back on top:
          // a black flash. It only has to exist on the stack, not be seen.
          if (st.anchor && st.anchor.el) st.anchor.el.style.visibility = 'hidden';
          // The remote's menu keys (Quick menu, Settings, Sources, Guide) run
          // S.clear() before opening their page (shim.js:4328), which keeps
          // only normal and resident windows, so blankpage was dropped and
          // closing the menu went back to the app. Resident windows survive
          // clear() and are not popped by Scheduler.open either.
          if (st.anchor) st.anchor.resident = true;
        } catch (e) { info.pageErr = errStr(e); }
      } else {
        try { if (fn('uiShow')) window.uiShow(); info.uiShow = !!fn('uiShow'); } catch (e) { info.uiShowErr = errStr(e); }
        var p = { params: { menuState: 1, menuType: 0 } };
        try { if (fn('RpcUiReportState')) Promise.resolve(window.RpcUiReportState({ params: { menuState: 1, menuType: 0 } })).then(noop, noop); } catch (e) { info.reportErr = errStr(e); }
        try { if (fn('RpcUiSetState')) Promise.resolve(window.RpcUiSetState(p)).then(noop, noop); info.setState = !!fn('RpcUiSetState'); } catch (e) { info.setStateErr = errStr(e); }
        try { if (fn('RpcSetOverlay')) Promise.resolve(window.RpcSetOverlay({ params: { state: 1 } })).then(noop, noop); } catch (e) { info.overlayErr = errStr(e); }
      }
      diag('front', info);
    }

    // silent: something else (an app, the stock launcher) is taking the screen
    // now, so drop our window without making PHI hand focus back to the old app.
    function restoreLayering(silent) {
      var S = sched(), P = pages(), info = { layer: st.layer, silent: !!silent };
      try {
        if (st.layer === 'page' && S && P && P.blankpage) {
          if (st.anchor && st.anchor.el) st.anchor.el.style.visibility = '';
          if (st.anchor) st.anchor.resident = false;
          if (!silent && S.isPage(P.blankpage)) S.close(); else S.silentClose(P.blankpage);
          info.page = 'closed blankpage';
          st.anchor = null;
        } else {
          if (st.prev && st.prev.uiShow === false && fn('uiHide')) { st.selfUiHide = true; try { window.uiHide(); } finally { st.selfUiHide = false; } info.uiHide = true; }
          var a = S && S.getActived && S.getActived();
          if (a && S.onopen) {
            S.onopen(a); info.onopen = a.app && a.app.path;
            try { if (!a.isProxy()) a.pageFocus(); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { info.err = errStr(e); }
      diag('restore', info);
    }

    // If PHI/native hides the UI while we are up (e.g. an app just started),
    // our overlay would be on screen with no layer under it: drop it.
    function wrapUiHide() {
      try {
        var orig = window.uiHide;
        if (typeof orig !== 'function' || orig.__cactarium) return;
        var w = function () {
          try {
            if (st.visible && !st.selfUiHide) {
              // TitanOS start-up runs uiHide ~2 s after a wake (seen on the TV).
              // In that window, with the launcher in front and no key from the
              // user, it is not an app the user started: keep the launcher and
              // take the layer back. Outside it (an app, a cast) we give way.
              var inWake = st.wakeAt && now() - st.wakeAt < 15000;
              var userAsked = st.userKeyAt && now() - st.userKeyAt < 1500;
              if (inWake && !st.backdrop && !userAsked) {
                var r = orig.apply(this, arguments);
                try {
                  restoreLayering(true);
                  bringFront();
                  if (fn('uiShow')) window.uiShow();
                  st.box.style.zIndex = String(Z);
                  focusFrame();
                  diag('uihide-kept', {});
                } catch (x) { diag('uihide-kept-error', { err: errStr(x) }); }
                return r;
              }
              hide({ restore: false, reason: 'uiHide' });
              if (inWake && st.wakeTries < 3) scheduleWakeShow(2000);
            }
          } catch (e) { /* ignore */ }
          return orig.apply(this, arguments);
        };
        w.__cactarium = true;
        window.uiHide = w;
      } catch (e) { /* ignore */ }
    }

    /* ---------- overlay ---------- */
    function postToFrame(msg) {
      try {
        if (st.frame && st.frame.contentWindow) { msg.src = 'cactarium-hook'; st.frame.contentWindow.postMessage(msg, BASE); }
      } catch (e) { /* ignore */ }
    }

    function focusFrame() {
      try { if (st.frame) { st.frame.focus(); if (st.frame.contentWindow) st.frame.contentWindow.focus(); } } catch (e) { /* ignore */ }
    }

    // The launcher page is loaded once and kept (hidden) between shows: a
    // fresh iframe took ~1 s to draw, which left the TitanOS launcher on
    // screen after a wake-up (seen on the TV). A frame that stopped sending
    // "alive" is thrown away and loaded again.
    function ensureFrame() {
      var body = document.body;
      if (!body) throw new Error('no body');
      if (st.box && st.box.parentNode && st.ready && now() - st.lastAlive > ALIVE_TIMEOUT_MS && now() - st.lastTick < 1500) {
        diag('frame-stale', { since: now() - st.lastAlive });
        try { st.box.parentNode.removeChild(st.box); } catch (e) { /* ignore */ }
        st.box = st.frame = null; st.ready = false;
      }
      if (st.box && st.box.parentNode) return;
      var box = document.createElement('div');
      box.id = 'cactarium-launcher';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;width:100%;height:100%;z-index:' + Z +
        ';background:#000;margin:0;padding:0;border:0;opacity:1;display:block;visibility:hidden;';
      box.style.zIndex = '-1';   // hidden, but laid out at full size (display:none loaded it at 0x0)
      var fr = document.createElement('iframe');
      fr.id = 'cactarium-launcher-frame';
      fr.style.cssText = 'border:0;margin:0;padding:0;width:100%;height:100%;display:block;background:#000;';
      fr.setAttribute('tabindex', '0');
      fr.setAttribute('allowtransparency', 'false');
      fr.onload = function () { diag('frame-load', {}); if (st.visible) focusFrame(); };
      fr.src = BASE + '/launcher?hook=' + encodeURIComponent(VERSION) + '&_=' + now();
      box.appendChild(fr);
      body.appendChild(box);
      st.box = box; st.frame = fr; st.ready = false; st.lastAlive = now();
    }
    function preload() {
      try { if (st.enabled && !st.visible) ensureFrame(); } catch (e) { /* ignore */ }
    }

    function show(reason) {
      st.appOut = 0;
      if (st.visible) return;
      hookScheduler();          // in case Scheduler did not exist yet when the hook loaded
      ensureFrame();
      bringFront();
      st.box.style.zIndex = String(Z);
      st.box.style.visibility = 'visible';
      st.visible = true; st.lastAlive = now();
      if (st.ready) postToFrame({ type: 'shown', reason: reason });   // refresh lists, clear leftovers
      focusFrame();
      clearTimeout(st.readyTimer);
      if (!st.ready) st.readyTimer = setTimeout(function () {
        if (st.visible && !st.ready) { diag('ready-timeout', {}); stockHome('ready-timeout'); }
      }, READY_TIMEOUT_MS);
      st.aliveCheckAt = now();
      st.aliveTimer = setInterval(function () {
        var t = now();
        // after a suspend this can run before the wake tick: a gap here means
        // we were frozen too, not that the launcher hung (it went to TitanOS)
        if (t - st.aliveCheckAt > 5000) st.lastAlive = t;
        st.aliveCheckAt = t;
        if (st.visible && !st.backdrop && st.ready && t - st.lastAlive > ALIVE_TIMEOUT_MS) { diag('alive-timeout', {}); stockHome('alive-timeout'); }
      }, 2000);
      startFocusTimer();
      diag('show', { reason: reason });
      muteOverSource();
    }

    // Over a channel or an input, PHI's own offline launcher silences the TV
    // with the system mute (not the user's mute) while it is shown and lifts it
    // when it hides (launcher.js onShow/onHide: RpcSoundSysMute {mute, type: 1}).
    // Leaving the source instead, as the TitanOS launcher does, broke the
    // streaming channels (source 26): switched back within seconds they stayed
    // on "can't connect to the server" (seen on the TV).
    function sysMute(on) {
      if (!fn('RpcSoundSysMute')) return;
      Promise.resolve(window.RpcSoundSysMute({ params: { mute: on ? 1 : 0, type: 1 } })).then(noop, function (e) {
        diag('sysmute-error', { on: on, err: errStr(e) });
      });
    }
    function muteOverSource() {
      var src = st.prev && st.prev.src;
      if (typeof src !== 'number' || src === SOURCE_ENUM.SmartTV || src === SOURCE_ENUM.INTERNET) return;
      st.sysMuted = true;
      sysMute(true);
      diag('sysmute', { on: true, src: src });
    }

    function startFocusTimer() {
      clearInterval(st.focusTimer);
      st.focusTimer = setInterval(function () {
        try { if (st.visible && !st.backdrop && document.activeElement !== st.frame) focusFrame(); } catch (e) { /* ignore */ }
      }, 700);
    }

    /* ---------- backdrop ---------- */
    // PHI's Settings is a side panel on a transparent page, so whatever is
    // under PHI (the TitanOS launcher app) showed through it (seen on the TV).
    // PHI pages are "virtual-window" divs in this same body, stacked by
    // z-index (win-manager.js:5139-5160). While such a page is open we keep
    // our launcher on screen just below it and let every key go to PHI. When
    // PHI comes back to the window that was on top before Home, the page was
    // closed: we take over again. Starting an app calls uiHide, which drops us.
    function activeWin() { return safe(function () { return sched().getActived(); }, null); }
    function winPath(a) { return safe(function () { return a.app.path; }, null); }
    function enterBackdrop(what) {
      if (!st.visible) return;
      var a = activeWin(), z = parseInt(safe(function () { return a.el.style.zIndex; }, ''), 10);
      if (st.backdrop) {        // another PHI page on top of the one we are under
        if (a && a !== st.anchor && a !== st.bdWin) { st.bdWin = a; st.box.style.zIndex = z > 1 ? String(z - 1) : '1'; focusPhi(a); diag('backdrop-follow', { path: winPath(a), z: z }); }
        return;
      }
      if (!a || a === st.anchor || winPath(a) === (st.prev && st.prev.top)) {
        diag('backdrop-skip', { what: what, path: winPath(a) });   // PHI did not open a page on top
        hide({ restore: false, reason: 'open:' + what });
        return;
      }
      st.backdrop = true; st.bdWin = a;
      clearInterval(st.focusTimer);
      st.box.style.zIndex = z > 1 ? String(z - 1) : '1';
      // Keys follow DOM focus: if the iframe keeps it, Back closed our
      // launcher instead of the PHI page (seen on the TV).
      postToFrame({ type: 'backdrop', on: true });
      focusPhi(a);
      diag('backdrop', { what: what, path: winPath(a), z: z, focus: safe(function () { return document.activeElement && (document.activeElement.id || document.activeElement.tagName); }, null) });
      clearInterval(st.bdTimer);
      st.bdTimer = setInterval(watchBackdrop, 300);
    }
    function focusPhi(a) {
      try { if (st.frame) st.frame.blur(); } catch (e) { /* ignore */ }
      try { window.focus(); } catch (e) { /* ignore */ }
      try { if (a && a.pageFocus) a.pageFocus(); } catch (e) { diag('page-focus-error', { err: errStr(e) }); }
    }
    function watchBackdrop() {
      if (!st.visible || !st.backdrop) { clearInterval(st.bdTimer); return; }
      var a = activeWin();
      if (a === st.bdWin) return;
      var p = winPath(a);
      if (!a || a === st.anchor || p === (st.prev && st.prev.top)) { resumeFromBackdrop('page-closed:' + p); return; }
      // PHI moved to another page of its own (a dialog, a sub page): stay under it.
      var z = parseInt(safe(function () { return a.el.style.zIndex; }, ''), 10);
      st.bdWin = a; st.box.style.zIndex = z > 1 ? String(z - 1) : '1';
      diag('backdrop-follow', { path: p, z: z });
    }
    function resumeFromBackdrop(reason) {
      clearInterval(st.bdTimer);
      st.backdrop = false; st.bdWin = null;
      if (!st.visible) return;
      st.box.style.zIndex = String(Z);
      postToFrame({ type: 'backdrop', on: false });
      st.lastAlive = now();
      // layer "page": PHI already went back to our window and showed its layer
      // itself; only if that window is gone do we put a new one up.
      if (st.layer !== 'page' || !st.anchor || activeWin() !== st.anchor) bringFront();
      focusFrame();
      startFocusTimer();
      diag('resume', { reason: reason });
    }
    function closeBackdropPage() {
      var a = st.bdWin, P = pages(), S = sched();
      try { if (P && P.all && S.silentClose) S.silentClose(P.all); } catch (e) { diag('close-page-error', { err: errStr(e) }); }
      try { if (a && activeWin() === a && a.close) a.close(); } catch (e) { diag('close-win-error', { err: errStr(e) }); }
      resumeFromBackdrop('home');
    }

    function hide(o) {
      o = o || {};
      if (!st.visible) return;
      st.visible = false; st.hiding = true;
      if (st.sysMuted) { st.sysMuted = false; sysMute(false); }
      st.backdrop = false; st.bdWin = null; clearInterval(st.bdTimer);
      clearTimeout(st.readyTimer); clearInterval(st.aliveTimer); clearInterval(st.focusTimer);
      try { if (st.frame) st.frame.blur(); if (st.box) { st.box.style.visibility = 'hidden'; st.box.style.zIndex = '-1'; } } catch (e) { /* ignore */ }
      postToFrame({ type: 'backdrop', on: false });
      postToFrame({ type: 'hidden' });   // the launcher stops its animated background
      st.quietUntil = now() + 250;
      if (o.restore !== false) restoreLayering(false);
      else if (st.layer === 'page' && st.anchor) restoreLayering(true);   // never leave our window on PHI's stack
      st.anchor = null; st.hiding = false;
      diag('hide', { restore: o.restore !== false, reason: o.reason || null });
    }

    /* ---------- stock behaviour ---------- */
    // Same end result as the stock Home key: shim.checkAndStartLauncher
    // (shim.js:6960) -> launcher page launchAppByRC("saphilauncher") or
    // RpcAppsWakeup(saphilauncher) (shim.js:7003-7040).
    function stockHome(reason) {
      st.leftSrc = null;   // something else takes the screen: no return to the old source
      var how = 'none';
      hide({ restore: false, reason: 'stock:' + reason });
      var fake = {
        type: 'keydown', keyCode: window.VK_HOME || 'VK_HOME', __cactarium: true,
        preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop
      };
      try {
        var shim = getShim();
        if (shim && typeof shim.checkAndStartLauncher === 'function') { shim.checkAndStartLauncher(fake); how = 'shim.checkAndStartLauncher'; }
      } catch (e) { diag('stock-error', { how: 'shim', err: errStr(e) }); how = 'none'; }
      if (how === 'none') {
        try {
          var S = sched();
          if (S && typeof S.openLauncher === 'function') { S.openLauncher(false); how = 'Scheduler.openLauncher'; }
        } catch (e) { diag('stock-error', { how: 'openLauncher', err: errStr(e) }); }
      }
      diag('stock', { reason: reason, how: how });
      return how;
    }

    /* ---------- Home handling ---------- */
    function isHome(e) {
      var k = e && e.keyCode;
      return k === 'VK_HOME' || (typeof window.VK_HOME !== 'undefined' && k === window.VK_HOME);
    }

    // Classify one Home event. Returns 'up', 'repeat', 'double' or 'press'.
    // Pure bookkeeping on st; the caller decides what to do about it.
    function classifyHome(type, repeat, source) {
      var t = now();
      if (type === 'keyup') {
        st.upSeen = true; st.upSinceFirst = true;
        return 'up';
      }
      var sinceLast = t - st.lastDown, sinceFirst = st.firstDown ? t - st.firstDown : -1;
      st.lastDown = t;       // a held key keeps pushing this forward, so it stays a repeat
      var why = null, double = false;
      if (!repeat && !st.upSinceFirst && st.firstDown > 0 && sinceLast === sinceFirst &&
          sinceFirst >= MIN_DOUBLE_GAP_MS && sinceFirst <= DOUBLE_HOME_MS) {
        return 'maybe-double';   // second keydown, no keyup: hold or double tap, decided after SETTLE_MS
      }
      if (repeat) why = 'e.repeat';
      else if (st.upSeen) {
        if (!st.upSinceFirst && sinceLast < REPEAT_MS) why = 'no keyup, ' + sinceLast + 'ms';
        else double = st.firstDown > 0 && st.upSinceFirst && sinceFirst >= MIN_DOUBLE_GAP_MS && sinceFirst <= DOUBLE_HOME_MS;
      } else {
        if (sinceLast < FALLBACK_REPEAT_MS) why = 'timing only, ' + sinceLast + 'ms';
        else double = st.firstDown > 0 && sinceFirst >= FALLBACK_REPEAT_MS && sinceFirst <= FALLBACK_DOUBLE_MS;
      }
      if (why) {
        if (st.ignoredLogged++ < 25) diag('home-repeat-ignored', { source: source, why: why, upSeen: st.upSeen, sinceLast: sinceLast, sinceFirst: sinceFirst });
        return 'repeat';
      }
      if (double) { st.firstDown = 0; st.upSinceFirst = false; return 'double'; }
      st.firstDown = t; st.upSinceFirst = false;
      return 'press';
    }

    function settleDouble() {
      var at = st.lastDown;
      clearTimeout(st.settleTimer);
      st.settleTimer = setTimeout(function () {
        if (st.lastDown !== at) return;          // more keydowns came: the key is being held
        st.firstDown = 0; st.upSinceFirst = false;
        diag('home', { source: 'settled', double: true, visible: st.visible });
        stockHome('double-home');
      }, SETTLE_MS);
    }

    function onHome(source, kind) {
      diag('home', { source: source, enabled: st.enabled, visible: st.visible, double: kind === 'double', upSeen: st.upSeen, layer: st.layer });
      if (kind === 'double') return 'stock';
      if (!sched() || !pages()) { diag('home-pass', { why: 'PHI not ready' }); return 'pass'; }
      if (!st.enabled) { diag('home-pass', { why: 'disabled or unreachable' }); refreshEnabled(); return 'pass'; }
      refreshEnabled();   // keep the kill switch fresh for the next press
      if (st.visible && st.backdrop) { closeBackdropPage(); return 'swallow'; }
      if (st.visible) { postToFrame({ type: 'home' }); return 'swallow'; }
      if (leaveSourceThenShow()) return 'swallow';
      try { show('home'); } catch (e) { diag('show-error', { err: errStr(e) }); hide({ restore: true }); return 'pass'; }
      return 'swallow';
    }

    // TitanOS's Home leaves a channel or input for the Smart TV source the way
    // PHI does it (RpcSourceSwitch, then Scheduler.exit with the new type), which
    // stops the stream instead of playing it on under the launcher. Only flipping
    // the source left the streaming channels (26) unable to restart (seen on the
    // TV). The launcher goes up once PHI has exited, or an exit while it is up
    // would be kept out (systemExit). Back returns through returnToSource.
    var STREAMING_TV = 26;
    function leaveSourceThenShow() {
      var S = sched(), src = safe(function () { return S.sourceTypeId; }, null);
      if (typeof src !== 'number' || src === SOURCE_ENUM.SmartTV || src === SOURCE_ENUM.INTERNET || !fn('RpcSourceSwitch')) return false;
      var smart = SOURCE_ENUM.SmartTV;
      st.leftChannel = null;
      var channel = HDMI_TYPE.indexOf(src) >= 0 || !fn('RpcChannelGet') ? Promise.resolve(null)
        : Promise.resolve(window.RpcChannelGet({ params: {} })).then(function (c) {
          if (c && typeof c.channelNumber === 'number') st.leftChannel = { channelNumber: c.channelNumber, channelIndex: c.channelIndex };
        }, noop);
      channel.then(function () {
        safe(function () { S.releaseMMResource(); });
        return window.RpcSourceSwitch({ params: { type: smart } });
      }).then(function () {
        try { S.exit({ type: smart, exitAlexa: true }); } catch (e) { diag('exit-error', { err: errStr(e) }); }
        st.leftSrc = src;
        diag('left-source', { from: src, now: safe(function () { return S.sourceTypeId; }, null) });
      }, function (e) {
        diag('left-source-error', { from: src, err: errStr(e) });
      }).then(function () {
        try { show('home'); } catch (e) { diag('show-error', { err: errStr(e) }); hide({ restore: true }); }
      });
      return true;
    }
    // Channels, the streaming ones included, come back through loadLocalUI('tv'),
    // what Watch TV in the TitanOS and offline launchers calls; an HDMI input
    // is switched back directly.
    // Watch TV puts the streaming channels (DVB-I) back on screen but their
    // player stays on "can't connect to the server" until a channel is tuned
    // (CH+ restarted it, seen on the TV). So tune the channel Home left.
    var RETUNE_DELAY_MS = 1500;
    function retuneLeftChannel() {
      var ch = st.leftChannel;
      st.leftChannel = null;
      if (!ch || !fn('RpcChannelSet')) return;
      setTimeout(function () {
        Promise.resolve(window.RpcChannelSet({ params: ch })).then(function (r) {
          diag('retune', { channel: ch, res: r, src: safe(function () { return sched().sourceTypeId; }, null) });
        }, function (e) { diag('retune-error', { channel: ch, err: errStr(e) }); });
      }, RETUNE_DELAY_MS);
    }
    function returnToSource() {
      var src = st.leftSrc;
      st.leftSrc = null;
      if (typeof src !== 'number') return false;
      try {
        if (HDMI_TYPE.indexOf(src) >= 0) {
          doSource({ typeId: src }).then(function () { diag('return-source', { to: src, how: 'switch' }); },
            function (e) { diag('return-source-error', { to: src, err: errStr(e) }); });
          return true;
        }
        var how = src === STREAMING_TV || TUNER_TYPES.indexOf(src) >= 0 ? 'tv' : 'lastsource';
        need('loadLocalUI')(how);
        diag('return-source', { to: src, how: how, channel: st.leftChannel });
        retuneLeftChannel();
        return true;
      } catch (e) { diag('return-source-error', { to: src, err: errStr(e) }); return false; }
    }

    function swallow(e) {
      try { e.preventDefault(); } catch (x) { /* ignore */ }
      try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); else e.stopPropagation(); } catch (x) { /* ignore */ }
    }

    // Capturing listener on window: it runs before PHI's own capture listener
    // on document.body (win-manager.js:5672 dispatchKey) and before the shim's
    // VK_HOME case (shim.js:4241). Keys PHI never sees can not misroute.
    function onKey(e) {
      try {
        if (!e || e.__cactarium) return;
        if (e.type === 'keydown' && !isHome(e)) st.userKeyAt = now();
        var k = e.keyCode, id = e.type + ':' + k + ':' + (e.key || '');
        if (st.seenCount < 80 && !st.seenKeys[id]) {
          st.seenKeys[id] = 1; st.seenCount++;
          diag('key-seen', { type: e.type, keyCode: k, kt: typeof k, key: e.key || null, code: e.code || null, home: isHome(e) });
        }
        if (isHome(e)) {
          if (e.type !== 'keydown' && e.type !== 'keyup') return;
          var kind = classifyHome(e.type, !!e.repeat, 'window-capture');
          if (kind === 'up') { if (st.swallowKeyup) { st.swallowKeyup = false; swallow(e); } return; }
          if (kind === 'maybe-double') { swallow(e); settleDouble(); return; }
          if (kind === 'repeat') {
            // Never let a repeat reach PHI's stock Home while we own the key.
            if (st.visible || (st.enabled && now() - st.firstDown < 1500)) swallow(e);   // backdrop too: Home is ours
            return;
          }
          var r = onHome('window-capture', kind);
          if (r === 'stock') {
            if (!st.visible) return;      // overlay not up: let this Home through, PHI runs the stock path itself
            stockHome('double-home');     // overlay up: close it and run the stock path ourselves
            st.swallowKeyup = true; swallow(e);
            return;
          }
          if (r === 'swallow') { st.swallowKeyup = true; swallow(e); }
          return;
        }
        if (typeof k === 'number' && ((st.visible && !st.backdrop) || now() < st.quietUntil)) {
          // Numeric (D-pad, OK, Back, digits) keys that reach PHI's document
          // while we are up were not delivered to the iframe: forward them.
          swallow(e);
          if (st.visible) postToFrame({ type: 'key', ev: e.type, keyCode: k, key: e.key || null });
        }
      } catch (x) { diag('onKey-error', { err: errStr(x) }); }
    }

    /* ---------- bridge: iframe -> PHI ---------- */
    var SOURCE_ENUM = { ATV: 0, AV: 1, HDMI1: 2, HDMI2: 3, HDMI3: 4, SatelliteDTV: 5, AirDTV: 6, CableDTV: 7, USB: 8,
      SmartTV: 9, YPBPR: 10, HDMI4: 11, SCART: 12, VGA: 13, INTERNET: 14, DLNA: 15, MIRACAST: 16, Airplay: 30 };
    // launcher.js:259-284 (C): app name or id prefix -> the name RpcAppsWakeup wants.
    var JUMP = { 4823: 'YouTube', YouTube: 'YouTube', 5048: 'Netflix', Netflix: 'Netflix', 5446: 'AmazonViedo',
      'Prime Video': 'AmazonViedo', 5443: 'OpenInternet', 'Internet browser': 'OpenInternet', 3059: 'appGallery',
      'App Gallery': 'appGallery', 3983: 'Rakuten', 'Rakuten TV': 'Rakuten', 'Freeview Explore': 'FVP EXPLORE' };

    function need(name) { var f = fn(name); if (!f) throw new Error(name + ' missing'); return f; }

    function packApps(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i] || {}, id = String(s.appId || ''), name = s.appName || '';
        var icon = typeof s.appIconURI === 'string' ? s.appIconURI : '';   // raw; the launcher maps it (see launcher.js iconUrl)
        out.push({
          id: id, name: name,
          jumpName: JUMP[name] || JUMP[id.split('_')[0]] || name,
          type: s.appType, url: s.appLaunchName || '', rated: !!s.appRated,
          removable: !!s.canRemove, order: s.appOrder || '',
          icon: icon
        });
      }
      return out;
    }

    // Wakeup params as launcher.js builds them: startApps (1672-1683) ->
    // openApp (1396-1450) -> curOpenApp {appId, appName, option, apptype, uri}.
    function wakeupParams(app) {
      app = app || {};
      var name = String(app.jumpName || app.name || app.preset || '');
      var low = name.toLowerCase();
      var native = { netflix: 'Netflix', youtube: 'YouTube', 'prime video': 'AmazonViedo', amazonviedo: 'AmazonViedo',
        'disney+': 'Disney+', disney: 'Disney+' };
      if (!app.id && native[low]) {      // "Native SDK" RC path: launchAppByRC (1545-1560)
        return { appId: '', appName: native[low], option: 1, apptype: 0, uri: '' };
      }
      if (low === 'internet browser' || low === 'openinternet') {   // itemEnter 786-795
        return { appId: '5443_52874', appName: 'OpenInternet', option: 0, apptype: 0, uri: 'OpenInternet' };
      }
      if (!name) throw new Error('app has no name');
      var type = Number(app.type || 0);
      return {
        appId: app.id || '', appName: name,
        option: name === 'FVP EXPLORE' ? 1 : (app.url ? (app.option === undefined ? 1 : app.option) : 0),
        apptype: type, uri: app.url || ''
      };
    }

    // A TitanOS catalog web app opens through the browser's loadApp(url, name,
    // type, resolution), as TitanOS's own launcher does. RpcAppsWakeup with the
    // same URL is accepted (result 0) but libnettvp looks the app up by name,
    // finds nothing and brings up the cloud launcher instead (55PUS8450/12,
    // TPN256E_V056.010.032.001).
    function canLoadApp(app) {
      return !!(app && app.url && app.appType && typeof window.loadApp === 'function');
    }

    function doLoadApp(app) {
      var name = String(app.name || '');
      var ok = window.loadApp(String(app.url), name, String(app.appType), String(app.resolution || '720p'));
      var data = { loadApp: String(ok), url: String(app.url), appType: String(app.appType), resolution: String(app.resolution || '720p') };
      if (ok === false) {
        var err = new Error('loadApp refused');
        err.data = data;
        throw err;
      }
      hide({ restore: false, reason: 'launched' });
      var S = sched();
      try { if (S && S.exit) S.exit({ type: 14, exitAlexa: true }); } catch (e) { data.exitErr = errStr(e); }
      st.appOut = now();
      return Promise.resolve(data);
    }

    function doLaunch(app) {
      st.leftSrc = null;   // something else takes the screen: no return to the old source
      if (canLoadApp(app)) return doLoadApp(app);
      var params = wakeupParams(app);
      return Promise.resolve(need('RpcAppsWakeup')({ params: params })).then(function (res) {
        var code = typeof res === 'number' ? res : (res && typeof res.result === 'number' ? res.result : 0);
        var data = { code: code, params: params, raw: safe(function () { return JSON.parse(JSON.stringify(res)); }, null) };
        if (code === 0) {
          // appsWakeupHandle (launcher.js:1486-1500): S.exit({type: INTERNET, exitAlexa: true})
          hide({ restore: false, reason: 'launched' });
          var S = sched();
          try { if (S && S.exit) S.exit({ type: params.appName === 'saphilauncher' ? 9 : 14, exitAlexa: true }); } catch (e) { data.exitErr = errStr(e); }
          return data;
        }
        var err = new Error('Wakeup result ' + code);
        err.data = data;
        throw err;
      });
    }

    function doSource(a) {
      a = a || {};
      st.leftSrc = null;   // something else takes the screen: no return to the old source
      var id = a.typeId;
      if (id === undefined || id === null) id = SOURCE_ENUM[String(a.origname || a.name || '').replace(/\s/g, '')];
      if (typeof id !== 'number') throw new Error('unknown source');
      var S = sched();
      var cur = safe(function () { return S.sourceTypeId; }, -1);
      safe(function () { S.releaseMMResource(); });
      // launcher.js:1745-1775 switchSourceForce -> sourceSwitch
      var pre = (cur === 9 || cur === 14) && fn('RpcSystemAppExit') ? Promise.resolve(window.RpcSystemAppExit()).then(noop, noop) : Promise.resolve();
      return pre.then(function () {
        return need('RpcSourceSwitch')({ params: { type: id } });
      }).then(function () {
        hide({ restore: false, reason: 'source' });
        try { S.exit({ type: id, osd: true, shouldCul: id === 5 || id === 6 || id === 7 }); } catch (e) { diag('exit-error', { err: errStr(e) }); }
        return { type: id, from: cur };
      });
    }

    // Sources. RpcSystemIhsGet {key:"source"} returns {source:[...]} with, per
    // sources_list.js:983-1010 / 1055-1100, items shaped
    //   {realid:5..8 (HDMI1..4), showid, showname, PAtype?}
    // (showname is the CEC/device-given name; PAtype marks a CEC device behind
    // the port). It does NOT list the plain inputs: those are PHI's static list
    // (lib/core.js:27180+, origname "HDMI 1".. with disabled:true until the port
    // has a device). Connection comes from RpcSourceGetHDMI5vStatus {portID:n}
    // -> {portIndex, HDMI5vStatus:1|0} (sources_list.js:342, 995). Type ids for
    // RpcSourceSwitch are the enum at core.js:12218 (HDMI1=2 .. HDMI4=11).
    var HDMI_TYPE = [2, 3, 4, 11];
    var TUNER_TYPES = [0, 5, 6, 7, 18, 19];
    function listSources() {
      var ihsP = Promise.resolve(need('RpcSystemIhsGet')({ params: { key: 'source' } })).then(null, function (e) { return { error: errStr(e) }; });
      var five = [];
      for (var n = 1; n <= 4; n++) {
        five.push(fn('RpcSourceGetHDMI5vStatus')
          ? Promise.resolve(window.RpcSourceGetHDMI5vStatus({ params: { portID: n } })).then(null, function () { return null; })
          : Promise.resolve(null));
      }
      return Promise.all([ihsP, Promise.all(five)]).then(function (res) {
        var ihs = res[0], st5 = res[1], l = (ihs && ihs.source) || [];
        var S = sched(), cur = safe(function () { return S.sourceTypeId; }, null);
        var out = [{ typeId: TUNER_TYPES.indexOf(cur) >= 0 ? cur : 6, origname: 'TV', name: 'TV', sub: 'Watch TV', kind: 'tv', connected: null, current: TUNER_TYPES.indexOf(cur) >= 0 }];
        for (var p = 0; p < 4; p++) {
          var real = 5 + p, named = null, cec = false;
          for (var i = 0; i < l.length; i++) {
            var it = l[i] || {};
            if (it.realid === real) {
              if (it.showname && !named) named = String(it.showname);
              if (it.PAtype !== undefined) cec = true;
            }
          }
          var s5 = st5[p], conn = s5 && typeof s5.HDMI5vStatus === 'number' ? s5.HDMI5vStatus === 1 : null;
          if (conn === null && (named || cec)) conn = true;
          var label = 'HDMI ' + (p + 1);
          out.push({ typeId: HDMI_TYPE[p], origname: label, name: named || label, sub: named && named !== label ? label : '', kind: 'hdmi', port: p + 1,
            connected: conn, current: cur === HDMI_TYPE[p] });
        }
        if (!st.srcLogged) { st.srcLogged = true; diag('sources-raw', { ihs: safe(function () { return JSON.parse(JSON.stringify(ihs)); }, null), five: st5, cur: cur }); }
        return { sources: out, current: cur };
      });
    }

    // Launcher tiles that open one of PHI's own pages (TitanOS catalog entries
    // "localfunction:media|simple_setup|alexa"). The page is opened exactly as
    // the Sources tile does it (see 'open' below): sticky over our blankpage,
    // then the launcher steps below it.
    function openPhiPage(page, params, what) {
      return new Promise(function (resolve) {
        var S = sched();
        if (!S) throw new Error('Scheduler missing');
        if (!page) throw new Error('page for ' + what + ' missing');
        clearInterval(st.focusTimer);
        // Scheduler.open hides and pops the active window when it is a dialog and
        // the new one is not sticky; blankpage (our window) is a dialog, so Back
        // fell through to the app, which flashed (seen on the TV). Passing type 2
        // (sticky) as the third argument pops nothing, and closing the page goes
        // back to blankpage.
        var anchored = st.layer === 'page' && st.anchor && activeWin() === st.anchor;
        S.open(page, params, anchored ? { type: 2 } : null);   // hookScheduler does the same
        setTimeout(function () { if (!st.backdrop) enterBackdrop(what); }, 300);
        resolve({ opened: what });
      });
    }

    function doLocal(name) {
      st.leftSrc = null;   // something else takes the screen: no return to the old source
      var S = sched(), P = pages();
      switch (name) {
        case 'media':
          // launcher.js itemEnter MEDIA: leave a running app first
          if (!S || !P) throw new Error('Scheduler missing');
          var go = function () { return openPhiPage(P.mediaHome, { mediatype: 0, mediapath: 'root' }, 'media'); };
          if ((S.sourceTypeId === 9 || S.sourceTypeId === 14) && fn('RpcSystemAppExit')) {
            return Promise.resolve(window.RpcSystemAppExit()).then(noop, noop).then(go);
          }
          return go();
        case 'simple_setup':
          if (!P) throw new Error('Pages missing');
          return openPhiPage(P.simplesetup, { window_type: 0, src: 'file:////mtd_apexe/board/msimplesetup/lSimpleSetupUI/index.html', requestId: 0 }, 'simple_setup');
        case 'alexa':
          return Promise.resolve(need('RpcAlexaInformSetupStateGet')()).then(function (t) {
            t = t || {};
            if (t.MicBtnTapped) return t.status != 0 ? need('RpcAlexaActive')() : need('RpcAlexaMicButtonTapped')();
            return need('RpcAlexaActive')();
          }).then(function () { return { opened: 'alexa' }; });
        default: throw new Error('unknown local function ' + name);
      }
    }

    function handle(type, msg) {
      switch (type) {
        case 'local': return doLocal(msg.fn);
        case 'list-apps':
          // launcher.js:974: setup.system.all.app.get {uitype:1,start:0,count:N}
          return Promise.resolve(need('RpcSystemAllAppGet')({ params: { uitype: 1, start: 0, count: 999 } })).then(function (r) {
            var l = (r && r.appList) || [];
            if (!st.rawLogged) {      // once per boot: every field of the first 3 entries, to verify icon fields on the TV
              st.rawLogged = true;
              diag('apps-raw', { n: l.length, keys: l[0] ? Object.keys(l[0]) : [], sample: safe(function () { return JSON.parse(JSON.stringify(l.slice(0, 3))); }, null) });
            }
            return { apps: packApps(l), count: r && r.appCount };
          });
        case 'list-sources': return listSources();
        case 'launch': return doLaunch(msg.app);
        case 'source': return doSource(msg);
        case 'open':
          return new Promise(function (resolve) {
            var S = sched(), P = pages();
            if (!S || !P) throw new Error('Scheduler missing');
            // Open PHI's page first and drop our overlay a moment later:
            // hiding first briefly showed the app underneath (seen on the TV).
            var opened;
            clearInterval(st.focusTimer);   // don't pull focus back from PHI's new page
            if (msg.what === 'sources') { S.openSourcePage(); opened = 'sources_list'; }
            else throw new Error('unknown target ' + msg.what);
            // Sources is a panel on a transparent page: keep the launcher under it.
            setTimeout(function () { if (!st.backdrop) enterBackdrop(msg.what); }, 300);   // fallback: hookScheduler normally did it already
            resolve({ opened: opened });
          });
        case 'stock-home': return Promise.resolve({ how: stockHome('launcher-tile') });
        case 'close':
          if (st.leftSrc != null) { hide({ restore: false, reason: 'launcher-close' }); returnToSource(); }
          else hide({ restore: true, reason: 'launcher-close' });
          return Promise.resolve({});
        case 'backdrop-key':
          // a key still reached the launcher while a PHI page is on top: give focus back to PHI
          if (st.backdrop) { focusPhi(st.bdWin); diag('backdrop-refocus', { keyCode: msg.keyCode }); }
          return Promise.resolve({});
        default: throw new Error('unknown message type ' + type);
      }
    }

    function onMessage(ev) {
      try {
        var d = ev.data;
        if (!d || typeof d !== 'object' || d.src !== 'cactarium-launcher') return;
        if (ALLOWED_ORIGINS.indexOf(ev.origin) < 0) return;
        if (!st.frame || ev.source !== st.frame.contentWindow) return;
        var type = d.type;
        if (type === 'alive') { st.lastAlive = now(); return; }
        if (type === 'ready') {
          st.ready = true; st.lastAlive = now(); if (st.visible) focusFrame();   // may be a preload
          diag('ready', { frameKeys: d.info || null });
          postToFrame({ type: 'hello', v: VERSION, caps: capabilities(), visible: !!st.visible });
          return;
        }
        if (type === 'key') {            // key the launcher did not use (Home, volume, ...)
          if (d.ev === 'keydown' && !isHome({ keyCode: d.keyCode })) st.userKeyAt = now();
          if (isHome({ keyCode: d.keyCode })) {
            if (d.ev !== 'keydown' && d.ev !== 'keyup') return;
            var kind = classifyHome(d.ev, !!d.repeat, 'iframe');
            if (kind === 'up' || kind === 'repeat') return;
            if (kind === 'maybe-double') { settleDouble(); return; }
            var r = onHome('iframe', kind);
            if (r === 'stock') stockHome('double-home-iframe');
          } else if (d.ev === 'keydown' && typeof d.keyCode === 'string') {
            var S = sched();
            try { if (S && S.dispatch) S.dispatch({ type: 'keydown', keyCode: d.keyCode }); } catch (e) { diag('forward-error', { err: errStr(e) }); }
            diag('forward-key', { keyCode: d.keyCode });
          }
          return;
        }
        if (type === 'diag') { diag('launcher:' + (d.ev || '?'), d.data); return; }
        var id = d.id;
        var t0 = now();
        var done = function (ok, payload) {
          diag('bridge', { type: type, ok: ok, ms: now() - t0, payload: ok ? undefined : payload && payload.error, detail: payload && payload.detail, opened: payload && payload.opened });
          try { ev.source.postMessage(ok ? { src: 'cactarium-hook', type: 'result', id: id, ok: true, data: payload } :
            { src: 'cactarium-hook', type: 'result', id: id, ok: false, error: payload.error, data: payload.detail }, ev.origin); } catch (e) { /* frame gone */ }
        };
        var p;
        try { p = handle(type, d); } catch (e) { done(false, { error: errStr(e) }); return; }
        Promise.resolve(p).then(function (r) { done(true, r); }, function (e) { done(false, { error: errStr(e), detail: e && e.data }); });
      } catch (e) { diag('onMessage-error', { err: errStr(e) }); }
    }

    function capabilities() {
      var names = ['RpcAppsWakeup', 'RpcSystemAllAppGet', 'RpcSystemIhsGet', 'RpcSourceSwitch', 'RpcSystemAppExit'];
      var c = {};
      for (var i = 0; i < names.length; i++) c[names[i]] = !!fn(names[i]);
      c.scheduler = !!sched();
      return c;
    }


    /* ---------- dashboard bridge (server/lib/routes/phi_bridge.go) ---------- */
    // The native JSON-RPC socket refuses the server, so the dashboard reaches
    // PHI's Rpc* functions through here: long-poll GET /api/tv/phi/next for one
    // job, run it, POST the outcome as text/plain no-cors to /api/tv/phi/result.
    // The server holds an allowlist; this side re-checks the name shape and that
    // the function exists. Frozen while a web app runs (PHI's JS does not run).
    var BRIDGE_NAME = /^Rpc[A-Za-z0-9]+$/;
    function bridgeReply(id, ok, payload) {
      try {
        var o = { id: id, ok: ok };
        if (ok) o.result = payload === undefined ? null : payload; else o.error = payload;
        var body;
        try { body = JSON.stringify(o); } catch (e) { body = JSON.stringify({ id: id, ok: false, error: 'result is not JSON' }); }
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/api/tv/phi/result', true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } catch (e) { /* the server times the request out */ }
    }
    // A launcher item as GET /api/launcher/apps returns it ({code,name,url,app_type,
    // resolution}) becomes what doLaunch takes; the same mapping launcher.js catalogItem
    // makes. An object without "code" is taken as a ready hook app.
    var BRIDGE_NATIVE_CODE = { youtube: 'YouTube', disney: 'Disney+' };
    var BRIDGE_NATIVE_URL = { 'localfunction:gotonetflix': 'Netflix', 'localfunction:gotoaiv': 'Prime Video', 'localfunction:gotoopeninternet': 'Internet browser' };
    var BRIDGE_LOCAL_FN = { 'localfunction:simple_setup': 'simple_setup', 'localfunction:alexa': 'alexa', 'localfunction:media': 'media' };
    function bridgeLaunch(item) {
      item = item || {};
      if (item.code === undefined) return doLaunch(item);
      var url = item.url || '', name = item.name || item.code;
      if (item.code === 'tv') return doSource({ typeId: 6, origname: 'TV' });
      if (BRIDGE_NATIVE_CODE[item.code]) return doLaunch({ name: BRIDGE_NATIVE_CODE[item.code] });
      if (BRIDGE_NATIVE_URL[url]) return doLaunch({ name: BRIDGE_NATIVE_URL[url] });
      if (BRIDGE_LOCAL_FN[url]) return Promise.resolve(doLocal(BRIDGE_LOCAL_FN[url]));
      if (/^https?:\/\//i.test(url)) return doLaunch({ name: name, url: url, appType: item.app_type || 'NetTV', resolution: item.resolution || '' });
      throw new Error('app ' + item.code + ' is not supported here');
    }
    function bridgeRun(job) {
      var id = job.id, method = String(job.method || '');
      var finished = false;
      var done = function (ok, v) { if (finished) return; finished = true; bridgeReply(id, ok, v); };
      try {
        if (method === 'launch') {
          // loadApp freezes this page, so answer once the launch is under way
          // rather than wait for a promise that may never settle.
          var timer = setTimeout(function () { done(true, {}); }, 1500);
          Promise.resolve(bridgeLaunch(job.params)).then(function (r) { clearTimeout(timer); done(true, r === undefined ? {} : r); },
            function (e) { clearTimeout(timer); done(false, errStr(e)); });
          return;
        }
        // The inputs, as the launcher's Inputs row lists and switches them.
        if (method === 'sources' || method === 'source') {
          Promise.resolve(method === 'sources' ? listSources() : doSource({ typeId: (job.params || {}).typeId }))
            .then(function (r) { done(true, r); }, function (e) { done(false, errStr(e)); });
          return;
        }
        if (!BRIDGE_NAME.test(method)) throw new Error('bad method name');
        var f = fn(method);
        if (!f) throw new Error(method + ' missing');
        // RpcRestartTV is called bare, as PHI's own dialog does (dialog.js:1844).
        var p = method === 'RpcRestartTV' && job.params == null ? f.call(window) : f.call(window, { params: job.params || {} });
        Promise.resolve(p).then(function (r) { done(true, r); }, function (e) { done(false, errStr(e)); });
      } catch (e) { done(false, errStr(e)); }
    }
    function bridgePoll() {
      if (st.bridgeBusy) return;
      st.bridgeBusy = true;
      var again = function (ms) { st.bridgeBusy = false; setTimeout(bridgePoll, ms); };
      try {
        var x = new XMLHttpRequest();
        x.open('GET', BASE + '/api/tv/phi/next?_=' + now(), true);
        x.timeout = 32000;   // the server holds a poll up to ~25 s
        x.onload = function () {
          if (x.status === 200) {
            try { bridgeRun(JSON.parse(x.responseText)); } catch (e) { diag('bridge-error', { err: errStr(e) }); }
            again(0);
          } else again(x.status === 204 ? 100 : 3000);
        };
        x.onerror = x.ontimeout = function () { again(3000); };
        x.send();
      } catch (e) { again(3000); }
    }

    /* ---------- boot ---------- */
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('message', onMessage, false);
    wrapUiHide();
    refreshEnabled(function () { wrapUiHide(); });
    setInterval(function () { refreshEnabled(); }, 20000);
    bridgePoll();

    /* ---------- Scheduler hooks ---------- */
    // Every PHI page, whether a launcher tile or a remote key (Quick menu,
    // Settings, Sources) opened it, goes through Scheduler.open. While the
    // launcher is up:
    // - a page opened over our blankpage is opened as sticky: Scheduler.open
    //   (win-manager.js:5404-5413) pops a dialog-type window (blankpage is
    //   one) when the next window is not sticky, and then closing that page
    //   fell through to the app (traced on the TV);
    // - right after it opens we step below it (backdrop); right after the
    //   stack is back on blankpage we come up again. No polling delay.
    function hookScheduler() {
      var S = sched(), P = pages();
      if (!S || !P || S.__cactariumHooked) return;
      S.__cactariumHooked = true;
      var open = S.open, pop = S.pop, exit = S.exit, exitTo = S.exitTo;
      // An exit while the launcher is in front, with no PHI page of the
      // user's on top, does not come from the user: the launcher's own
      // actions hide it before they exit, and PHI's menus put us in backdrop.
      // TitanOS start-up after a wake runs several (exitTo /sources/third-app
      // at +2 s, exit at +6 s, exitTo at +9 s, seen on the TV); each one hid
      // the launcher. Keep it up instead and take the layer back afterwards.
      // Power off is the exception (the launcher is put back after it anyway).
      function systemExit(fn, self, args, name) {
        var standby = !!(window.isGoingStandby || window.powerOffProcess);
        // a remote key just before (an input button, a channel number) means the user asked for it
        var userAsked = st.userKeyAt && now() - st.userKeyAt < 1500;
        var keep = st.visible && !st.backdrop && !standby && !userAsked;
        if (!keep) {
          try { if (st.visible) hide({ restore: false, reason: 'phi-' + name }); } catch (x) { /* ignore */ }
          return fn.apply(self, args);
        }
        var r;
        st.inSystemExit = true;   // S.open/S.pop hooks stand still while PHI rebuilds its stack
        try { r = fn.apply(self, args); } finally { st.inSystemExit = false; }
        if (!st.visible) { diag('exit-kept-lost', { via: name }); return r; }   // something hid us meanwhile (uiHide)
        try {
          // exit cleared the stack and told the native side the app is in front
          restoreLayering(true);
          bringFront();
          st.box.style.zIndex = String(Z);
          focusFrame();
          diag('exit-kept', { via: name, path: typeof args[0] === 'string' ? args[0] : null, stack: safe(function () { return S.stack.map(function (w) { return w.app.path; }); }, null) });
        } catch (x) { diag('exit-kept-error', { err: errStr(x) }); }
        return r;
      }
      // S.exit/exitTo leave PHI's menus for a source or app (picking an input
      // in Sources, "Watch TV"...). A resident blankpage would survive them,
      // so step aside first.
      S.exit = function () {
        var r = systemExit(exit, this, arguments, 'exit');
        // Power off also goes through S.exit. Put the launcher back up right
        // after, so the TV wakes with it already drawn instead of showing the
        // TitanOS launcher until we notice the wake-up (1-2 s, seen on the TV).
        try {
          var going = { isGoingStandby: !!window.isGoingStandby, powerOffProcess: !!window.powerOffProcess };
          if (going.isGoingStandby || going.powerOffProcess) {
            diag('standby', going);
            st.standbyAt = now();   // the tick below watches for the wake-up
            st.wakeAt = now(); st.wakeTries = 0;
            scheduleWakeShow(600);
          }
        } catch (x) { /* ignore */ }
        return r;
      };
      if (typeof exitTo === 'function') S.exitTo = function (e) {
        var r = systemExit(exitTo, this, arguments, 'exitTo');
        // TitanOS's own start-up after a wake runs exitTo ~2 s in (seen on
        // the TV) and took the screen back: come back up once it is done.
        try {
          if (st.wakeAt && now() - st.wakeAt < 15000) {
            diag('wake-exitTo', { path: e, tries: st.wakeTries });
            if (st.wakeTries < 10) scheduleWakeShow(1200);
          }
        } catch (x) { /* ignore */ }
        return r;
      };
      // App/source windows (third-app, tv, hdmi: PROXY_PAGES, win-config.js:648)
      // are not pages over us; exit/exitTo reopen them while rebuilding.
      function isProxyPath(e) {
        return safe(function () { return (window.PROXY_PAGES || []).indexOf(e) >= 0; }, false) || /^\/sources\//.test(String(e));
      }
      S.open = function (e, t, a) {
        if (st.inSystemExit || isProxyPath(e)) return open.call(this, e, t, a);
        var forced = false;
        try {
          if (st.visible && st.layer === 'page' && st.anchor && e !== P.blankpage && this.getActived() === st.anchor) {
            var b = {}; if (a) for (var k in a) b[k] = a[k];
            b.type = 2; a = b; forced = true;      // G.sticky
          }
        } catch (x) { /* never break PHI */ }
        var r = open.call(this, e, t, a);
        try {
          if (st.visible && st.layer === 'page' && st.anchor && e !== P.blankpage && activeWin() !== st.anchor) {
            diag('phi-open', { path: e, forced: forced, stack: safe(function () { return S.stack.map(function (w) { return w.app.path; }); }, null) });
            enterBackdrop(e);
          }
        } catch (x) { /* ignore */ }
        return r;
      };
      S.pop = function (w) {
        var r = pop.apply(this, arguments);
        if (st.inSystemExit) return r;
        try {
          if (st.visible && st.backdrop && st.anchor && activeWin() === st.anchor) resumeFromBackdrop('stack back on blankpage');
          else if (st.visible && w && w === st.anchor && !st.hiding) diag('anchor-popped', { stack: safe(function () { return S.stack.map(function (x) { return x.app.path; }); }, null) });
        } catch (x) { /* ignore */ }
        return r;
      };
    }

    var S0 = sched(), P0 = pages();
    hookScheduler();

    /* ---------- power-on ---------- */
    // Standby is suspend-to-RAM ("PM: suspend exit" in dmesg; uptime does not
    // advance): this page and its timers freeze, the wall clock does not. A
    // tick (every 0.5 s) that finds a big gap is a wake-up. On wake, and after a cold boot
    // (this load), show the launcher where TitanOS would be shown: when the
    // TV is on the Smart TV source with no PHI page open. On HDMI or a channel
    // the TV resumes there, so we stay out.
    var WAKE_GAP_MS = 15000;
    st.lastTick = now(); st.wakeTries = 0;
    function scheduleWakeShow(ms) {
      clearTimeout(st.wakeTimer);
      st.wakeTimer = setTimeout(tryWakeShow, ms);
    }
    function tryWakeShow() {
      var S = sched(), P = pages();
      st.wakeTries++;
      var top = safe(function () { return activeWin(); }, null), src = safe(function () { return S.sourceTypeId; }, null);
      var info = { tries: st.wakeTries, src: src, top: winPath(top), visible: st.visible, enabled: st.enabled };
      if (st.visible || !st.enabled || !S || !P) { diag('wake-skip', info); return; }
      if (src !== 9) {         // power-off goes through the tuner source (26); it may switch back a moment after the wake
        if (st.wakeTries < 8) scheduleWakeShow(1000);
        info.why = 'not on the Smart TV source'; diag('wake-skip', info); return;
      }
      if (top && top === st.anchor && !st.visible) {   // our window left behind without the launcher: clean up
        diag('wake-stale-anchor', info);
        restoreLayering(true);
        top = safe(function () { return activeWin(); }, null);
      }
      var proxy = safe(function () { return top.isProxy(); }, false);
      if (!proxy) {           // a PHI page (a power-on dialog...) is up: wait for it
        if (st.wakeTries < 10) scheduleWakeShow(1000);
        info.why = 'PHI page open'; diag('wake-wait', info); return;
      }
      try { show('wake'); diag('wake-show', info); } catch (e) { info.err = errStr(e); diag('wake-error', info); }
    }
    // A loadApp app runs in the browser's main window and this page freezes
    // until it exits (Back): there is no exit event, only the clock gap and a
    // focus event on return. The TV then falls back to the tuner source (26)
    // or a blank window, so bring the launcher up, as TitanOS's own launcher
    // comes back after its apps (seen on the TV with Red Bull TV).
    var APP_BACK_SETTLE_MS = 1500;
    function onAppBack(how, gap) {
      if (!st.appOut) return;
      st.appOut = 0;
      diag('app-back', { how: how, gap: gap, src: safe(function () { return sched().sourceTypeId; }, null) });
      setTimeout(function () {
        if (st.visible || !st.enabled) return;
        try { show('app-back'); } catch (e) { diag('app-back-error', { err: errStr(e) }); }
      }, APP_BACK_SETTLE_MS);
    }
    window.addEventListener('focus', function () {
      if (st.appOut && now() - st.appOut > 2000) onAppBack('focus', 0);
    });
    function onWake(reason, gap) {
      st.wakeAt = now(); st.wakeTries = 0;
      diag('wake', { reason: reason, gap: gap, src: safe(function () { return sched().sourceTypeId; }, null) });
      scheduleWakeShow(0);    // st.enabled is from the last refresh (every 20 s); no round trip first
      refreshEnabled();
    }
    // After a power-off we saw (st.standbyAt), the wake-up is either the
    // flag PHI clears on power-on (shim.fastbootRemind sets isGoingStandby
    // false) or any clock jump: a 10 s standby gave a gap below WAKE_GAP_MS
    // and was missed (seen on the TV).
    setInterval(function () {
      var t = now(), gap = t - st.lastTick;
      st.lastTick = t;
      if (gap > 3000) st.lastAlive = t;   // the launcher was frozen with us, not hung
      if (gap > 3000 && st.appOut) onAppBack('resume', gap);
      if (st.standbyAt) {
        // The flag might clear before the TV actually sleeps, so it does not
        // end the watch; only a clock jump (the real resume) or 10 min does.
        var cleared = !window.isGoingStandby && !window.powerOffProcess;
        if (gap > 3000) { st.standbyAt = 0; st.flagWake = false; onWake('resume', gap); }
        else if (cleared && !st.flagWake && t - st.standbyAt > 1500) { st.flagWake = true; onWake('standby-flag-cleared', gap); }
        else if (t - st.standbyAt > 600000) { st.standbyAt = 0; st.flagWake = false; }
      } else if (gap > WAKE_GAP_MS) onWake('resume', gap);
    }, 500);
    setTimeout(function () { onWake('boot', 0); }, 3000);
    refreshEnabled(function () { preload(); });
    diag('load', {
      href: String(location.href), ua: navigator.userAgent, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
      phiVersion: safe(function () { return document.getElementById('version').textContent; }, null),
      globals: {
        Scheduler: !!S0, Pages: !!P0, launcher: !!(P0 && P0.launcher), blankpage: !!(P0 && P0.blankpage), shim: !!(P0 && P0.shim),
        sources_list: !!(P0 && P0.sources_list), all: !!(P0 && P0.all),
        uiShow: !!fn('uiShow'), uiHide: !!fn('uiHide'), getWebuiShowHide: !!fn('getWebuiShowHide'),
        RpcUiSetState: !!fn('RpcUiSetState'), RpcUiReportState: !!fn('RpcUiReportState'), RpcSetOverlay: !!fn('RpcSetOverlay'),
        omi_platform: safe(function () { return typeof window.omi_platform; }, null),
        VK_HOME: safe(function () { return window.VK_HOME; }, null),
        useLauncher: safe(function () { return window._useLauncher_; }, null),
        homeMapping: safe(function () { return JSON.stringify(window.SysKeyMapping[window.VK_HOME]); }, null),
        caps: capabilities(),
        shimFound: !!getShim(),
        shimHasCheckAndStart: safe(function () { return typeof getShim().checkAndStartLauncher; }, null),
        shimHasOpenSettingPage: safe(function () { return typeof getShim().openSettingPage; }, null),
        stack: safe(function () { return S0.stack.map(function (w) { return w.app.path; }); }, null),
        sourceTypeId: safe(function () { return S0.sourceTypeId; }, null),
        uiShowFlag: safe(function () { return document.__uiShow__; }, null),
        webuiShown: safe(function () { return window.getWebuiShowHide(); }, null)
      }
    });
  } catch (e) {
    try { if (typeof fetch === 'function') fetch('http://localhost:8090/api/home/diag', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ src: 'phi-hook', ev: 'init-error', err: String(e && e.message || e) }) }); } catch (x) { /* nothing */ }
  }
})();
