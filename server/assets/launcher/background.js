/* Cactarium launcher background: none (black), a picture for the part of the
 * day, or an animated canvas, under a darkening layer.
 *
 * Ported from Glasshouse Home (server/assets/home.html: wallpaper, animated
 * background and darkening; MIT License, (c) 2026 Rory Gallagher). The
 * scenes are Glasshouse's. What differs, for this TV (Novatek NT72690, Opera
 * engine in PHI):
 *   - the config comes from GET /api/launcher/background (launcher.background),
 *     the pictures from /launcher/wallpaper?slot=;
 *   - the animation runs only while the launcher is on screen: the hook says
 *     so with {type:'hidden'}, 'shown' and hello.visible (see launcher.js),
 *     and the page's own visibility is honoured too;
 *   - 20 frames a second (Glasshouse's rate before webOS 9), and 10 where
 *     drawing a frame takes longer than 28 ms on average.
 *
 * Exposes window.cactariumBackground = { refresh, setVisible, tick }.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  // Strength is how far the picture shows through the black: lower at night.
  var WALL_SLOTS = [
    { key: 'night', from: 0, strength: 0.55 },
    { key: 'morning', from: 6, strength: 0.7 },
    { key: 'afternoon', from: 11, strength: 0.62 },
    { key: 'evening', from: 17, strength: 0.72 },
    { key: 'night', from: 21, strength: 0.65 }
  ];
  // The colour presets: a background (sky) and a light colour. Keep in step with the dashboard (ui/home.js BG_THEMES).
  var ANIM_THEMES = {
    night_blue: { sky: '#0a1f5c', light: '#4f8dff' },
    sunset: { sky: '#3a0f3d', light: '#ff8a4c' },
    emerald: { sky: '#04342e', light: '#3ee0b0' },
    ember: { sky: '#3a0808', light: '#ff5a3c' },
    silver: { sky: '#15181e', light: '#d8dee8' }
  };
  var cfg = { kind: 'none', pictures: 'landscape', animation: 'waves', colours: 'time',
    own_colours: { background: '#0a1f5c', light: '#4f8dff' }, darkening: 100, slots: {}, revision: '' };
  var visible = true;          // the hook's word; the page's own visibility is checked as well
  var wallShown = null, wallFront = 0;

  function wallSlot() {
    var h = new Date().getHours(), slot = WALL_SLOTS[0];
    for (var j = 0; j < WALL_SLOTS.length; j++) if (WALL_SLOTS[j].from <= h) slot = WALL_SLOTS[j];
    return slot;
  }

  var ANIM_W = 960, ANIM_H = 540;
  var FRAME_MS = 50, SLOW_FRAME_MS = 100, SLOW_DRAW_MS = 28;
  var ANIM_PALETTES = {
    morning:   { top: '#1e0e08', bottom: '#3a1a10', hues: ['#ff9a5a', '#ffc874', '#ff6f8e'] },
    afternoon: { top: '#04192e', bottom: '#0b3456', hues: ['#3fb4ff', '#7fe0ff', '#5a7dff'] },
    evening:   { top: '#120624', bottom: '#2a0f40', hues: ['#b25cff', '#ff6fb0', '#5d6bff'] },
    night:     { top: '#06102e', bottom: '#0e2160', hues: ['#4f7bff', '#8fa4ff', '#b48bff'] }
  };
  var ANIM_DIM = { morning: 0.9, afternoon: 1, evening: 0.75, night: 0.45 };
  var anim = { style: 'off', raf: 0, last: 0, t: 0, scene: null, ctx: null, still: false, frameMs: FRAME_MS, drawAvg: 0 };

  function rnd(a, b) { return a + Math.random() * (b - a); }

  // Colours as #rrggbb mixed: amount 0 is a, 1 is b.
  function mixColour(a, b, amount) {
    var out = '#';
    for (var i = 1; i < 7; i += 2) {
      var x = parseInt(a.substr(i, 2), 16), y = parseInt(b.substr(i, 2), 16);
      out += ('0' + Math.round(x + (y - x) * amount).toString(16)).slice(-2);
    }
    return out;
  }
  function rgba(hex, alpha) {
    return 'rgba(' + parseInt(hex.substr(1, 2), 16) + ',' + parseInt(hex.substr(3, 2), 16) + ',' +
      parseInt(hex.substr(5, 2), 16) + ',' + alpha + ')';
  }

  // The background and light colours chosen on the dashboard, or null to
  // follow the part of the day.
  function animColours() {
    if (cfg.colours === 'own') return { sky: cfg.own_colours.background, light: cfg.own_colours.light };
    return ANIM_THEMES[cfg.colours] || null;
  }

  var animPal = { key: '', pal: null };
  function animPalette() {
    var c = animColours();
    if (!c) return ANIM_PALETTES[wallSlot().key] || ANIM_PALETTES.night;
    var key = c.sky + c.light;
    if (animPal.key !== key) {
      animPal.key = key;
      animPal.pal = { top: mixColour(c.sky, '#000000', 0.55), bottom: c.sky,
                      hues: [c.light, mixColour(c.light, '#ffffff', 0.35), mixColour(c.light, c.sky, 0.35)] };
    }
    return animPal.pal;
  }

  // The gradient behind waves and particles is the canvas's own background,
  // set when it changes; each frame only clears the canvas over it.
  var animSky = '';
  function animBackdrop(ctx, top, bottom, over) {
    var sky = top + ',' + bottom + (over || '');
    if (sky !== animSky) {
      animSky = sky;
      $('anim').style.background = (over ? over + ',' : '') + 'linear-gradient(' + top + ',' + bottom + ')';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, ANIM_W, ANIM_H);
  }

  // A few soft bands of light swaying across the screen, each with a bright
  // thread along its edges, as on a games console's home screen. Each band is
  // worked out once a frame at a handful of points and drawn as one filled
  // shape and two lines, joined by curves, so it stays light for the TV.
  var WAVE_STEP = 80;
  var WAVES = {
    build: function () {
      var bands = [];
      for (var i = 0; i < 3; i++) {
        bands.push({ y: 0.3 + i * 0.13 + rnd(-0.03, 0.03), amp: rnd(30, 55), f1: rnd(0.0035, 0.006), f2: rnd(0.0015, 0.003),
                     s1: rnd(0.2, 0.32) * (i % 2 ? -1 : 1), s2: rnd(0.12, 0.2), ph: rnd(0, 6.28),
                     tilt: rnd(-0.22, 0.22), w: rnd(14, 30), hue: i % 3 });
      }
      return { bands: bands, top: [], bottom: [] };
    },
    // Joins the points with curves through their midpoints.
    curve: function (ctx, pts, from, move) {
      var i = from;
      if (move) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y);
      var step = from === 0 ? 1 : -1, last = from === 0 ? pts.length - 1 : 0;
      for (i = from; i !== last - step && i !== last; i += step) {
        var a = pts[i + step], b = pts[i + 2 * step] || a;
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      ctx.lineTo(pts[last].x, pts[last].y);
    },
    draw: function (ctx, s, t) {
      var pal = animPalette();
      animBackdrop(ctx, pal.top, pal.bottom);
      for (var i = 0; i < s.bands.length; i++) {
        var r = s.bands[i], top = s.top, bottom = s.bottom, n = 0;
        for (var x = -WAVE_STEP; x <= ANIM_W + WAVE_STEP; x += WAVE_STEP, n++) {
          var y = r.y * ANIM_H + (x / ANIM_W - 0.5) * r.tilt * ANIM_H +
            Math.sin(x * r.f1 + t * r.s1 + r.ph) * r.amp + Math.sin(x * r.f2 - t * r.s2 + r.ph * 1.7) * r.amp * 0.6;
          var w = r.w * (0.55 + 0.45 * Math.sin(x * 0.004 + t * 0.25 + r.ph));
          top[n] = { x: x, y: y - w };
          bottom[n] = { x: x, y: y + w };
        }
        top.length = bottom.length = n;
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = pal.hues[r.hue];
        ctx.beginPath();
        WAVES.curve(ctx, top, 0, true);
        WAVES.curve(ctx, bottom, n - 1, false);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = pal.hues[r.hue];
        ctx.lineWidth = 1.5;
        ctx.beginPath(); WAVES.curve(ctx, top, 0, true); ctx.stroke();
        ctx.globalAlpha = 0.22;
        ctx.beginPath(); WAVES.curve(ctx, bottom, 0, true); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  };

  // Soft lights of every size rising slowly and swaying, some twinkling.
  var PARTICLES = {
    sprite: function (colour) {
      var c = document.createElement('canvas');
      c.width = c.height = 64;
      var x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, colour);
      g.addColorStop(0.35, colour);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.globalAlpha = 1;
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      return c;
    },
    build: function () {
      var dots = [];
      for (var i = 0; i < 90; i++) {
        var r = Math.pow(Math.random(), 1.8) * 30 + 2;
        dots.push({ x: rnd(0, ANIM_W), y: rnd(0, ANIM_H), r: r, v: 5 + (1 - r / 32) * 12, sway: rnd(0.2, 0.6),
                    amp: rnd(6, 24), ph: rnd(0, 6.28), hue: i % 3, a: r > 16 ? rnd(0.3, 0.55) : rnd(0.6, 1), tw: rnd(0.3, 1.2) });
      }
      return { dots: dots, sprites: null, spriteKey: '' };
    },
    draw: function (ctx, s, t, dt) {
      var pal = animPalette(), key = pal.hues.join();
      if (s.spriteKey !== key) {
        s.sprites = pal.hues.map(PARTICLES.sprite);
        s.spriteKey = key;
      }
      animBackdrop(ctx, pal.top, pal.bottom);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < s.dots.length; i++) {
        var d = s.dots[i];
        d.y -= d.v * dt;
        if (d.y < -d.r * 2) { d.y = ANIM_H + d.r * 2; d.x = rnd(0, ANIM_W); }
        var x = d.x + Math.sin(t * d.sway + d.ph) * d.amp;
        ctx.globalAlpha = d.a * (0.65 + 0.35 * Math.sin(t * d.tw + d.ph));
        ctx.drawImage(s.sprites[d.hue], x - d.r, d.y - d.r, d.r * 2, d.r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // An aquarium through its side: light from the surface, fish at every
  // depth, waving weed and rising bubbles over a sandy floor.
  // The floor picture's height: the bed reaches at most 77 px above the bottom, a rock 17 px more.
  var AQUARIUM_FLOOR_H = 120;
  var FISH_COLOURS = ['#ff8a3d', '#ffd23f', '#4fc3ff', '#ff5e7e', '#9be15d', '#c18cff'];
  var AQUARIUM = {
    fish: function (onScreen) {
      var depth = Math.random(), size = 7 + depth * 16, dir = Math.random() < 0.5 ? 1 : -1;
      return { depth: depth, size: size, dir: dir, speed: (10 + depth * 26) * rnd(0.8, 1.2),
               y: rnd(0.12, 0.62) * ANIM_H, ph: rnd(0, 6.28),
               x: onScreen ? rnd(0, ANIM_W) : dir > 0 ? -size * 3 : ANIM_W + size * 3,
               colour: depth < 0.4 ? '#1d4a66' : FISH_COLOURS[Math.floor(Math.random() * FISH_COLOURS.length)] };
    },
    build: function () {
      var bed = [], x, i, fish = [], weeds = [], rays = [], rocks = [], vents = [];
      for (x = 0; x <= ANIM_W + 40; x += 40) bed.push({ x: x, y: ANIM_H - 62 + Math.sin(x * 0.01) * 10 + rnd(-5, 5) });
      for (i = 0; i < 11; i++) fish.push(AQUARIUM.fish(true));
      fish.sort(function (a, b) { return a.depth - b.depth; });
      for (i = 0; i < 10; i++) weeds.push({ x: rnd(0, ANIM_W), h: rnd(70, 180), segs: 8, ph: rnd(0, 6.28), w: rnd(3, 6),
                                            colour: ['#1f6b3a', '#2a8048', '#185a34'][i % 3] });
      for (i = 0; i < 6; i++) rays.push({ x: rnd(0.05, 0.95) * ANIM_W, w: rnd(30, 90), ph: rnd(0, 6.28), sp: rnd(0.05, 0.15) });
      for (i = 0; i < 6; i++) rocks.push({ x: rnd(0, ANIM_W), w: rnd(26, 70), h: rnd(14, 34) });
      for (i = 0; i < 3; i++) vents.push({ x: rnd(0.1, 0.9) * ANIM_W, next: rnd(0, 1) });
      return { bed: bed, fish: fish, weeds: weeds, rays: rays, rocks: rocks, vents: vents, bubbles: [], floor: null, rayFill: null, rayKey: '' };
    },
    floor: function (s) {
      var c = document.createElement('canvas'), top = ANIM_H - AQUARIUM_FLOOR_H, i;
      c.width = ANIM_W;
      c.height = AQUARIUM_FLOOR_H;
      var x = c.getContext('2d');
      x.translate(0, -top);
      var g = x.createLinearGradient(0, ANIM_H - 80, 0, ANIM_H);
      g.addColorStop(0, '#4a4030');
      g.addColorStop(1, '#1b1710');
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(0, ANIM_H);
      for (i = 0; i < s.bed.length; i++) x.lineTo(s.bed[i].x, s.bed[i].y);
      x.lineTo(ANIM_W + 40, ANIM_H);
      x.closePath();
      x.fill();
      x.fillStyle = '#1c2026';
      for (i = 0; i < s.rocks.length; i++) {
        var k = s.rocks[i], ky = AQUARIUM.bedAt(s, k.x);
        x.save();
        x.translate(k.x, ky + 4);
        x.scale(1, k.h / k.w);
        x.beginPath();
        x.arc(0, 0, k.w / 2, Math.PI, Math.PI * 2);
        x.fill();
        x.restore();
      }
      return c;
    },
    bedAt: function (s, x) {
      var i = Math.max(0, Math.min(s.bed.length - 2, Math.floor(x / 40))), a = s.bed[i], b = s.bed[i + 1];
      return a.y + (b.y - a.y) * ((x - a.x) / 40);
    },
    /*
     * A fish but its tail, drawn once into a picture of its own, as each was
     * four or five shapes a frame and the fish a fifth of the aquarium's
     * drawing on a B8 (webOS 4.4). Facing right, with its origin where the
     * body's centre is.
     */
    fishSprite: function (f) {
      var size = f.size, pad = 2, c = document.createElement('canvas');
      var ox = size + pad, oy = size * 0.72 + pad;
      c.width = Math.ceil(ox + size + pad);
      c.height = Math.ceil(oy + size * 0.48 + pad);
      var x = c.getContext('2d');
      x.translate(ox, oy);
      x.fillStyle = f.colour;
      // Fin on top.
      x.beginPath();
      x.moveTo(-size * 0.3, -size * 0.38);
      x.lineTo(size * 0.05, -size * 0.72);
      x.lineTo(size * 0.25, -size * 0.36);
      x.closePath();
      x.fill();
      // Body.
      x.save();
      x.scale(1, 0.48);
      x.beginPath();
      x.arc(0, 0, size, 0, Math.PI * 2);
      x.fill();
      if (f.depth >= 0.4) {
        x.globalAlpha = 0.22;
        x.fillStyle = '#ffffff';
        x.beginPath();
        x.arc(size * 0.1, -size * 0.35, size * 0.6, 0, Math.PI * 2);
        x.fill();
      }
      x.restore();
      if (f.depth >= 0.4) {
        x.globalAlpha = 1;
        x.fillStyle = '#0b1620';
        x.beginPath();
        x.arc(size * 0.55, -size * 0.08, size * 0.1, 0, Math.PI * 2);
        x.fill();
      }
      return { canvas: c, ox: ox, oy: oy };
    },
    drawFish: function (ctx, f, t) {
      var size = f.size, y = f.y + Math.sin(t * 0.6 + f.ph) * 6;
      if (!f.sprite) f.sprite = AQUARIUM.fishSprite(f);
      ctx.save();
      ctx.translate(f.x, y);
      ctx.scale(f.dir, 1);
      ctx.globalAlpha = f.depth < 0.4 ? 0.5 : 0.92;
      ctx.fillStyle = f.colour;
      // Tail, wagging.
      ctx.save();
      ctx.translate(-size * 0.85, 0);
      ctx.rotate(Math.sin(t * 7 + f.ph) * 0.35);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-size * 0.65, -size * 0.42);
      ctx.lineTo(-size * 0.65, size * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.drawImage(f.sprite.canvas, -f.sprite.ox, -f.sprite.oy);
      ctx.restore();
    },
    draw: function (ctx, s, t, dt) {
      // The water and the light through it: the chosen colours, or the
      // aquarium's own, dimmed with the part of the day.
      var c = animColours(), i, x, g;
      var dim = c ? 1 : ANIM_DIM[wallSlot().key] || 1;
      var water = c ? c.sky : '#0e5a80', deep = c ? mixColour(c.sky, '#000000', 0.8) : '#021624';
      var ray = c ? mixColour(c.light, '#ffffff', 0.4) : '#beebff';
      // The water darkening with depth is part of the canvas's own
      // background, drawn once rather than over the whole canvas each frame.
      animBackdrop(ctx, water, deep, 'linear-gradient(' + rgba(deep, 0) + ' 35%,' + rgba(deep, 0.8) + ')');
      // Light from the surface: one gradient for every ray, made when its colour changes.
      var rayKey = ray + (c ? 1 : 0);
      if (s.rayKey !== rayKey) {
        s.rayKey = rayKey;
        s.rayFill = ctx.createLinearGradient(0, 0, 0, ANIM_H * 0.85);
        s.rayFill.addColorStop(0, rgba(ray, c ? 0.14 : 0.10));
        s.rayFill.addColorStop(1, rgba(ray, 0));
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = s.rayFill;
      for (i = 0; i < s.rays.length; i++) {
        var r = s.rays[i], sway = Math.sin(t * r.sp + r.ph) * 40;
        ctx.beginPath();
        ctx.moveTo(r.x - r.w / 2, 0);
        ctx.lineTo(r.x + r.w / 2, 0);
        ctx.lineTo(r.x + sway + r.w * 1.6, ANIM_H * 0.85);
        ctx.lineTo(r.x + sway - r.w * 0.4, ANIM_H * 0.85);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // The surface, from just below it.
      ctx.fillStyle = rgba(ray, 0.08);
      ctx.fillRect(0, 0, ANIM_W, 12);
      ctx.strokeStyle = rgba(ray, 0.35);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (x = 0; x <= ANIM_W; x += 12) {
        var sy = 11 + Math.sin(x * 0.03 + t * 1.2) * 2.5 + Math.sin(x * 0.011 - t * 0.7) * 2;
        if (x === 0) ctx.moveTo(x, sy); else ctx.lineTo(x, sy);
      }
      ctx.stroke();
      // Fish far back, behind the weed.
      for (i = 0; i < s.fish.length; i++) if (s.fish[i].depth < 0.4) AQUARIUM.drawFish(ctx, s.fish[i], t);
      // The floor and its rocks never move: drawn once into a picture of their own.
      if (!s.floor) s.floor = AQUARIUM.floor(s);
      ctx.drawImage(s.floor, 0, ANIM_H - AQUARIUM_FLOOR_H);
      ctx.lineCap = 'round';
      for (i = 0; i < s.weeds.length; i++) {
        var w = s.weeds[i], by = AQUARIUM.bedAt(s, w.x);
        ctx.strokeStyle = w.colour;
        ctx.lineWidth = w.w;
        ctx.beginPath();
        ctx.moveTo(w.x, by);
        for (var sg = 1; sg <= w.segs; sg++) {
          ctx.lineTo(w.x + Math.sin(t * 0.9 + w.ph + sg * 0.45) * sg * 1.6, by - sg * (w.h / w.segs));
        }
        ctx.stroke();
      }
      // Bubbles from a few places on the floor.
      for (i = 0; i < s.vents.length; i++) {
        var v = s.vents[i];
        v.next -= dt;
        if (v.next <= 0) {
          v.next = rnd(0.4, 1.4);
          s.bubbles.push({ x: v.x + rnd(-4, 4), y: AQUARIUM.bedAt(s, v.x) - 5, r: rnd(1.2, 3.4), v: rnd(25, 45), ph: rnd(0, 6.28) });
        }
      }
      // Every bubble in one stroke: on a B8 (webOS 4.4) a stroke each cost
      // a sixth of the aquarium's drawing.
      ctx.strokeStyle = 'rgba(210,240,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = s.bubbles.length - 1; i >= 0; i--) {
        var b = s.bubbles[i];
        b.y -= b.v * dt;
        b.x += Math.sin(t * 3 + b.ph) * 0.3;
        if (b.y < 14) { s.bubbles.splice(i, 1); continue; }
        ctx.moveTo(b.x + b.r, b.y);
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      }
      ctx.stroke();
      // Fish swim on, and one that has left is followed by a new one.
      for (i = 0; i < s.fish.length; i++) {
        var f = s.fish[i];
        f.x += f.dir * f.speed * dt;
        if ((f.dir > 0 && f.x > ANIM_W + f.size * 3) || (f.dir < 0 && f.x < -f.size * 3)) s.fish[i] = AQUARIUM.fish(false);
      }
      s.fish.sort(function (a, c) { return a.depth - c.depth; });
      for (i = 0; i < s.fish.length; i++) if (s.fish[i].depth >= 0.4) AQUARIUM.drawFish(ctx, s.fish[i], t);
      ctx.globalAlpha = 1;
      if (dim < 1) {
        ctx.fillStyle = 'rgba(0,6,16,' + (1 - dim) + ')';
        ctx.fillRect(0, 0, ANIM_W, ANIM_H);
      }
    }
  };

  // Curtains of light hanging from the top, their lower edges swaying, as an
  // aurora does: each a wavy band filled with a gradient that fades away from
  // its edge, three fills a frame.
  var AURORA = {
    build: function () {
      var veils = [];
      for (var i = 0; i < 3; i++) {
        veils.push({ y: 0.32 + i * 0.1 + rnd(-0.03, 0.03), amp: rnd(30, 55), f1: rnd(0.003, 0.005), f2: rnd(0.006, 0.01),
                     s1: rnd(0.12, 0.22) * (i % 2 ? -1 : 1), s2: rnd(0.25, 0.4), ph: rnd(0, 6.28), depth: rnd(150, 230), hue: i % 3 });
      }
      return { veils: veils };
    },
    draw: function (ctx, s, t) {
      var pal = animPalette();
      animBackdrop(ctx, pal.top, pal.bottom);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < s.veils.length; i++) {
        var v = s.veils[i], base = v.y * ANIM_H, x;
        var g = ctx.createLinearGradient(0, base - v.depth, 0, base + v.amp);
        g.addColorStop(0, rgba(pal.hues[v.hue], 0));
        g.addColorStop(0.8, rgba(pal.hues[v.hue], 0.24));
        g.addColorStop(1, rgba(pal.hues[v.hue], 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-20, base - v.depth - v.amp);
        for (x = -20; x <= ANIM_W + 20; x += 30) {
          ctx.lineTo(x, base - v.depth + Math.sin(x * v.f2 - t * v.s2 + v.ph) * v.amp * 0.5);
        }
        for (x = ANIM_W + 20; x >= -20; x -= 30) {
          ctx.lineTo(x, base + Math.sin(x * v.f1 + t * v.s1 + v.ph) * v.amp + Math.sin(x * v.f2 + t * v.s2) * v.amp * 0.3);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // A few large, soft pools of colour drifting slowly and blending where they
  // meet. Each is one disc filled with a radial gradient, kept to its own circle.
  var GLOW = {
    build: function () {
      var blobs = [];
      for (var i = 0; i < 4; i++) {
        blobs.push({ r: rnd(220, 320), ax: rnd(0.15, 0.4), ay: rnd(0.12, 0.3), fx: rnd(0.03, 0.06), fy: rnd(0.025, 0.05),
                     cx: rnd(0.25, 0.75), cy: rnd(0.3, 0.7), ph: rnd(0, 6.28), hue: i % 3 });
      }
      return { blobs: blobs };
    },
    draw: function (ctx, s, t) {
      var pal = animPalette();
      animBackdrop(ctx, pal.top, pal.bottom);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < s.blobs.length; i++) {
        var b = s.blobs[i];
        var x = (b.cx + Math.sin(t * b.fx + b.ph) * b.ax) * ANIM_W, y = (b.cy + Math.cos(t * b.fy + b.ph * 1.3) * b.ay) * ANIM_H;
        var r = b.r * (0.9 + 0.1 * Math.sin(t * 0.2 + b.ph));
        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(pal.hues[b.hue], 0.4));
        g.addColorStop(1, rgba(pal.hues[b.hue], 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // Points of light drifting slowly, joined by fine lines while they are near
  // one another. The lines are drawn in a few batches by how near, rather
  // than one stroke each.
  var STARS_NEAR = 120, STARS_BANDS = 4;
  var STARS = {
    build: function () {
      var pts = [];
      for (var i = 0; i < 46; i++) {
        var a = rnd(0, 6.28), v = rnd(4, 11);
        pts.push({ x: rnd(0, ANIM_W), y: rnd(0, ANIM_H), vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: rnd(1, 2.4), ph: rnd(0, 6.28) });
      }
      return { pts: pts };
    },
    draw: function (ctx, s, t, dt) {
      var pal = animPalette(), pts = s.pts, n = pts.length, i, j, k;
      animBackdrop(ctx, pal.top, pal.bottom);
      for (i = 0; i < n; i++) {
        var p = pts[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < -20) p.x += ANIM_W + 40; else if (p.x > ANIM_W + 20) p.x -= ANIM_W + 40;
        if (p.y < -20) p.y += ANIM_H + 40; else if (p.y > ANIM_H + 20) p.y -= ANIM_H + 40;
      }
      ctx.strokeStyle = pal.hues[0];
      ctx.lineWidth = 1;
      for (k = 0; k < STARS_BANDS; k++) {
        var near = STARS_NEAR * (k + 1) / STARS_BANDS, far = STARS_NEAR * k / STARS_BANDS;
        ctx.globalAlpha = 0.42 * (1 - k / STARS_BANDS);
        ctx.beginPath();
        for (i = 0; i < n; i++) {
          for (j = i + 1; j < n; j++) {
            var dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d2 = dx * dx + dy * dy;
            if (d2 < near * near && d2 >= far * far) { ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); }
          }
        }
        ctx.stroke();
      }
      ctx.fillStyle = pal.hues[1];
      for (i = 0; i < n; i++) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 1.3 + pts[i].ph);
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, pts[i].r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  // A still surface where now and then a drop falls and spreads in thin
  // rings that fade, drawn flattened as water seen at a slant.
  var RIPPLE_LIFE = 5, RIPPLE_REACH = 190;
  var RIPPLES = {
    build: function () {
      return { drops: [], next: 0.3 };
    },
    draw: function (ctx, s, t, dt) {
      var pal = animPalette(), i, k;
      animBackdrop(ctx, pal.top, pal.bottom);
      s.next -= dt;
      if (s.next <= 0) {
        s.next = rnd(0.9, 2.2);
        s.drops.push({ x: rnd(0.08, 0.92) * ANIM_W, y: rnd(0.3, 0.9) * ANIM_H, age: 0, hue: Math.floor(rnd(0, 3)) });
      }
      ctx.lineWidth = 1.8;
      for (i = s.drops.length - 1; i >= 0; i--) {
        var d = s.drops[i];
        d.age += dt;
        if (d.age > RIPPLE_LIFE) { s.drops.splice(i, 1); continue; }
        ctx.strokeStyle = pal.hues[d.hue];
        // Three rings a moment apart, each growing and fading.
        for (k = 0; k < 3; k++) {
          var a = d.age - k * 0.45;
          if (a <= 0) continue;
          var life = a / RIPPLE_LIFE, r = RIPPLE_REACH * Math.sqrt(life);
          ctx.globalAlpha = 0.75 * (1 - life) * (1 - k * 0.25);
          ctx.beginPath();
          ctx.save();
          ctx.translate(d.x, d.y);
          ctx.scale(1, 0.38);
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.restore();
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  };

  var ANIM_SCENES = { waves: WAVES, particles: PARTICLES, aquarium: AQUARIUM, aurora: AURORA, glow: GLOW,
    constellations: STARS, ripples: RIPPLES };

  function animDraw(dt) {
    var scene = ANIM_SCENES[anim.style];
    if (scene && anim.ctx) scene.draw(anim.ctx, anim.scene, anim.t, dt);
  }

  function animFrame(now) {
    anim.raf = window.requestAnimationFrame(animFrame);
    // A few ms short of the interval, so a 60 Hz screen's frames are not skipped by rounding.
    if (anim.last && now - anim.last < anim.frameMs - 4) return;
    var dt = anim.last ? Math.min(0.1, (now - anim.last) / 1000) : anim.frameMs / 1000;
    anim.last = now;
    anim.t += dt;
    var t0 = window.performance && performance.now ? performance.now() : 0;
    animDraw(dt);
    if (t0) {
      anim.drawAvg = anim.drawAvg ? anim.drawAvg * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
      anim.frameMs = anim.drawAvg > SLOW_DRAW_MS ? SLOW_FRAME_MS : FRAME_MS;
    }
  }

  function animStop() {
    if (anim.raf) window.cancelAnimationFrame(anim.raf);
    anim.raf = 0;
    anim.last = 0;
  }

  function onScreen() { return visible && !document.hidden; }

  // Runs while the launcher is on screen; with reduced motion asked for, one still frame.
  function animRun() {
    if (anim.style === 'off' || anim.raf || !onScreen()) return;
    anim.still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (anim.still) { anim.t = 20; animDraw(0); return; }
    anim.raf = window.requestAnimationFrame(animFrame);
  }

  // Follows the config's choice; the pictures step aside while one runs.
  function syncAnim() {
    var want = cfg.kind === 'animated' && ANIM_SCENES[cfg.animation] ? cfg.animation : 'off';
    if (want === anim.style) return false;
    animStop();
    anim.style = want;
    var canvas = $('anim');
    if (want === 'off') {
      // Its pixels are given back too: a canvas keeps them while it has a size, even hidden.
      canvas.className = '';
      canvas.width = canvas.height = 0;
      canvas.style.background = '';
      animSky = '';
      anim.ctx = null;
      anim.scene = null;
      return true;
    }
    if (canvas.width !== ANIM_W) { canvas.width = ANIM_W; canvas.height = ANIM_H; }
    if (!anim.ctx) anim.ctx = canvas.getContext('2d');
    anim.scene = ANIM_SCENES[want].build();
    anim.t = 0;
    anim.drawAvg = 0;
    anim.frameMs = FRAME_MS;
    animSky = '';
    canvas.className = 'on';
    animRun();
    return true;
  }

  // The darkening, as a share of the scrim's own: 0 leaves the picture as it
  // is. The animations are dark already, so under one the scrim made for
  // photographs is eased to this share of it. With none, nothing is behind it.
  var ANIM_SCRIM = 0.42;
  function applyDarkening() {
    $('scrim').style.opacity = String(cfg.darkening / 100 * (cfg.kind === 'animated' ? ANIM_SCRIM : 1));
  }

  function clearLayers() {
    var layers = $('wall').querySelectorAll('.layer');
    for (var b = 0; b < layers.length; b++) { layers[b].style.opacity = 0; layers[b].style.backgroundImage = ''; }
    wallShown = null;
  }

  // The picture for the part of the day, cross-faded from the last one.
  function updateWall() {
    var slot = wallSlot();
    if (cfg.kind !== 'pictures' || !cfg.slots[slot.key]) { clearLayers(); return; }
    var revision = cfg.revision, id = slot.key + '@' + slot.strength + '@' + revision;
    if (id === wallShown) return;
    var layers = $('wall').querySelectorAll('.layer');
    var next = layers[1 - wallFront], prev = layers[wallFront];
    var src = '/launcher/wallpaper?slot=' + slot.key + '&v=' + encodeURIComponent(revision);
    var img = new Image();
    img.onload = function () {
      if (cfg.kind !== 'pictures' || cfg.revision !== revision || wallSlot().key !== slot.key) return;
      wallShown = id;
      next.style.backgroundImage = 'url(' + src + ')';
      next.style.opacity = slot.strength;
      prev.style.opacity = 0;
      wallFront = 1 - wallFront;
    };
    img.src = src;
  }

  function applyReducedMotion() {
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    document.documentElement.className = (reduced ? 'still ' : '') + (onScreen() ? '' : 'resting');
  }

  function apply() {
    syncAnim();
    applyDarkening();
    updateWall();
    applyReducedMotion();
    if (onScreen()) animRun(); else animStop();
  }

  function setVisible(on) {
    visible = on !== false;
    apply();
  }

  function valid(v, list, def) { return list.indexOf(v) >= 0 ? v : def; }

  // Reads the config; the launcher calls it at load and every time it is shown.
  function refresh() {
    try {
      fetch('/api/launcher/background', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!j || !j.ok) return;
        var oc = j.own_colours || {};
        cfg = {
          kind: valid(j.kind, ['none', 'pictures', 'animated'], 'none'),
          pictures: j.pictures, colours: valid(j.colours, ['time', 'night_blue', 'sunset', 'emerald', 'ember', 'silver', 'own'], 'time'),
          animation: j.animation,
          own_colours: { background: /^#[0-9a-f]{6}$/i.test(oc.background) ? oc.background : '#0a1f5c',
                         light: /^#[0-9a-f]{6}$/i.test(oc.light) ? oc.light : '#4f8dff' },
          darkening: typeof j.darkening === 'number' ? Math.max(0, Math.min(100, j.darkening)) : 100,
          slots: j.slots || {}, revision: j.revision || ''
        };
        animPal.key = '';
        apply();
      }).catch(function () {});
    } catch (e) { /* no fetch */ }
  }

  // Called with the clock: the part of the day changes the picture (cross-fade) and the palette.
  function tick() { if (cfg.kind === 'pictures') updateWall(); }

  document.addEventListener('visibilitychange', apply);
  window.cactariumBackground = { refresh: refresh, setVisible: setVisible, tick: tick };
})();
