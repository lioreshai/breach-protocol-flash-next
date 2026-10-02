'use strict';
/* ==================================================================
   90_dev.js — opt-in console surface: drive and inspect the running game.
   Loads last, so every game global exists. With no dev=1 in the URL this file
   returns on the first line: no globals, no wrappers, no behaviour change.
   ================================================================== */
(function () {
  const URLQ = typeof location !== 'undefined' ? location.search + ' ' + location.hash : '';
  if (!/[?&]dev=1/.test(URLQ)) return;

  /* ?dev=1&seed=<int> makes a live boot reproducible, so a frame on the DEPLOYED build can be named
     and re-run instead of merely described (#166). The level is drawn from Math.random — js/20_level.js
     :898, :911, :962, :1077 and pickWallTex at :401 — so two loads of one URL used to be two levels;
     measured in a real browser on the unseeded page: layout 2016015967 vs 34562729, spawn seats
     (16.5, 10.5) vs (9.5, 5.5). The generator installed here is mulberry (js/05_paint.js:10), not a
     second one: it is a top-level function declaration in an earlier classic script, so it is a global
     by the time this file runs (index.html loads 05 before 90), and its recurrence is bit-for-bit the
     one tools/view.js's seedRng installs (:301) and tools/ci/assert.js patches into the page (:186) —
     same int32 state for the same seed, so the harness's dice and the page's are the same dice.
     No seed parameter leaves Math.random alone, and a player without ?dev=1 never reaches this line.
     One page load is one deal: a second DEV.boot() keeps drawing from the advanced stream rather than
     re-cutting it, so a frame is reproduced by reloading the URL, not by booting twice. */
  const SEEDQ = /[?&#]seed=(-?\d+)/.exec(URLQ);
  // the uint32 the generator holds, which is what DEV.seed reports: ?seed=-5 and ?seed=4294967291 deal the same level
  const SEED = SEEDQ ? (Math.trunc(+SEEDQ[1]) >>> 0) : null;
  if (SEED !== null) Math.random = mulberry(SEED);

  const STEP = 1000 / 60;                    // the fixed step DEV.tick() advances by
  const HIST = new Float64Array(300);        // frame cost history, filled by the wrapper below
  let at = 0, TS = performance.now(), FROZEN = false, T0 = 0;
  const _update = update, _inner = frameInner;

  /* These are top-level function declarations, so they are properties of the global object
     and the loop reads them by that lookup every frame: wrapping them here gates the
     simulation and samples frame cost without touching 50_ui_input.js at all. */
  window.update = function (dt) { if (!FROZEN) _update(dt); };
  window.frameInner = function (ts) {
    const t0 = performance.now();
    /* Frozen, pin the simulation clock so two shots of the same frame cannot disagree about an
       animated sprite frame. Handing the loop equal timestamps makes its own dt the literal
       0.016 it falls back on, so S.t lands on one fixed value instead of drifting by vsync. */
    if (FROZEN) { last = ts; S.t = T0; }
    _inner(ts);
    HIST[at++ % HIST.length] = performance.now() - t0;
  };

  function wrapA(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
  function quant(f) {
    const n = Math.min(at, HIST.length);
    if (!n) return 0;
    const s = Array.prototype.slice.call(HIST.subarray(0, n)).sort((a, b) => a - b);
    return +s[Math.min(n - 1, Math.floor(f * n))].toFixed(2);
  }
  // Held keys are what turns a camera probe into a walk: a probe that spins P.ang while
  // W is still down walks the player into the void, where the grid is undefined and DDA
  // never hits. Anything that re-poses the camera drops them and the inertia with them.
  function still() { for (const k in keys) delete keys[k]; P.vx = P.vy = P.vz = 0; P.air = false; }
  function tier() { return QUAL[clamp(S.gfx | 0, 0, QUAL.length - 1)]; }
  const num = (v, d) => +(+v).toFixed(d);

  function boot() {
    startGame();                             // the deploy button's own path, minus the click
    return { mode: S.mode, level: S.level, locked: S.locked, enemies: ENEMIES.length };
  }
  function cam(x, y, z, ang, pitch) {
    let nx = +x, ny = +y, snapped = false;
    if (!isFinite(nx) || !isFinite(ny)) throw new Error('DEV.cam(x, y, z, ang, pitch): x and y must be numbers');
    if (isSolid(nx, ny)) { const o = nearestOpen(nx, ny); snapped = true; nx = o[0]; ny = o[1]; }
    still();
    P.x = nx; P.y = ny;
    const gz = floorAt(nx, ny);
    P.z = z === undefined || !isFinite(+z) ? gz : Math.max(gz, +z);
    if (ang !== undefined) P.ang = wrapA(+ang);
    if (pitch !== undefined) P.pitch = clamp(+pitch, -BH * 0.62, BH * 0.62);
    return { x: num(P.x, 3), y: num(P.y, 3), z: num(P.z, 3), ang: num(P.ang, 4), pitch: num(P.pitch, 1), snapped: snapped };
  }
  function look(dAng, dPitch) {
    P.ang = wrapA(P.ang + (+dAng || 0));
    if (dPitch !== undefined) P.pitch = clamp(P.pitch + (+dPitch || 0), -BH * 0.62, BH * 0.62);
    return { ang: num(P.ang, 4), pitch: num(P.pitch, 1) };
  }
  function nearestEnemy() {
    let best = null, bd = Infinity;
    for (const e of ENEMIES) {
      if (e.state === 'dead') continue;
      const d = dist2(e.x, e.y, P.x, P.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  function face(t) {
    const e = (t && typeof t.x === 'number') ? t : nearestEnemy();
    if (!e) return { ok: false, why: 'no living enemy in the level' };
    P.ang = Math.atan2(e.y - P.y, e.x - P.x);
    return { ok: true, kind: e.kind, ang: num(P.ang, 4), dist: num(Math.sqrt(dist2(e.x, e.y, P.x, P.y)), 2) };
  }
  function freeze(on) {
    FROZEN = on === undefined ? true : !!on;
    if (FROZEN) { still(); T0 = S.t; }
    return FROZEN;
  }
  function tick(n) {
    const cnt = Math.max(0, (n === undefined ? 1 : n) | 0);
    let t = TS;
    for (let i = 0; i < cnt; i++) { last = t; t += STEP; window.frameInner(t); }
    TS = t;
    return { frames: cnt, frozen: FROZEN, mode: S.mode };
  }
  // Walk back along the ray before giving up, so "in front of the camera" survives a wall
  // at the requested range; nearestOpen is the last resort and can land somewhere else.
  function openAlong(a, d) {
    const cx = Math.cos(a), sy = Math.sin(a);
    for (let t = d; t >= 0.4; t -= 0.25) {
      const x = P.x + cx * t, y = P.y + sy * t;
      if (!isSolid(x, y)) return [x, y];
    }
    return nearestOpen(P.x + cx * d, P.y + sy * d);
  }
  function spawn(kind, n, dist) {
    const k = ETYPE[kind] ? kind : 'grunt', cnt = Math.max(1, (n === undefined ? 1 : n) | 0), d = dist === undefined ? 3 : +dist;
    for (let i = 0; i < cnt; i++) {
      const off = cnt === 1 ? 0 : (i % 2 ? 1 : -1) * 0.16 * Math.ceil(i / 2);
      const o = openAlong(P.ang + off, d), e = makeEnemy(k, o[0], o[1]);
      // makeEnemy scatters gait phase, tint and facing: pin them so two spawns agree
      e.anim = 0; e.stepPhase = 0; e.ph = 0; e.tint = [1, 1, 1]; e.state = 'sleep'; e.alert = false;
      // dv is pinned too, and to i rather than to 0: DEV.tick never seeds RNG, so a random variant
      // would be unreproducible, and a crowd that cycles the table is what lets the live page show
      // three different corpses from one call (the game rolls it at random instead)
      e.dv = i % MESH.DIEV;
      e.ang = Math.atan2(P.y - e.y, P.x - e.x);
      ENEMIES.push(e);
    }
    return { kind: k, made: cnt, dist: ENEMIES.slice(-cnt).map(e => num(Math.hypot(e.x - P.x, e.y - P.y), 2)) };
  }
  function clear() {
    const r = { enemies: ENEMIES.length, proj: PROJ.length, parts: PARTS.length };
    ENEMIES.length = 0; PROJ.length = 0; PARTS.length = 0;
    return r;
  }
  // Keys the QUAL table knows about, plus the ones that live in a renderer global instead of a tier.
  const RESIZED = { res: 1, bloom: 1, grain: 1, scan: 1 };
  function set(name, value) {
    if (name === 'rim') { RIG.setRim(value === undefined ? true : !!value); return { rim: RIG.rim, note: 'pose cache cleared' };
    }
    if (name === 'shadow') { SHADOW = (value === undefined ? true : !!value) ? 1 : 0; return { shadow: SHADOW > 0 }; }
    if (name === 'gfx') {
      const i = typeof value === 'string' ? QUAL.findIndex(q => q.name.toLowerCase() === String(value).toLowerCase()) : clamp(value | 0, 0, QUAL.length - 1);
      if (i < 0) throw new Error('DEV.set("gfx", …) wants 0..' + (QUAL.length - 1) + ' or ' + QUAL.map(q => q.name).join('|'));
      S.gfx = i; resize();
      return { tier: QUAL[i].name, buf: [BW, BH] };
    }
    const q = tier();
    if (!(name in q)) throw new Error('DEV.set: unknown "' + name + '" — tier keys: ' + Object.keys(q).join(', ') + ', plus rim, shadow');
    q[name] = value;
    if (RESIZED[name]) resize();
    return { name: name, value: q[name], tier: q.name, buf: [BW, BH], frozen: FROZEN };
  }
  function stats() {
    const r = RIG.stats();
    return {
      ms: { n: Math.min(at, HIST.length), med: quant(0.5), p95: quant(0.95), last: at ? +HIST[(at - 1) % HIST.length].toFixed(2) : 0 },
      fps: S.fps, buf: [BW, BH], drawCalls: drawCalls, poses: r.poses, rig: r,
      enemies: ENEMIES.length, alive: enemiesLeft(), tier: (GQ || tier()).name, gfx: S.gfx, mode: S.mode, frozen: FROZEN
    };
  }
  function state() {
    return {
      mode: S.mode, level: S.level, levelName: LEVELS[S.level].name, runT: num(S.runT, 2), t: num(S.t, 2), fps: S.fps,
      // #166: seed = the uint32 pinning this deal, null when the URL named none; layout = DEV.layoutSig()
      seed: SEED, layout: (MAP.cell && MAP.fz) ? layoutSig() : null,
      p: {
        x: num(P.x, 3), y: num(P.y, 3), z: num(P.z, 3), floor: num(floorAt(P.x, P.y), 3), ang: num(P.ang, 4),
        pitch: num(P.pitch, 1), hp: num(P.hp, 1), armor: num(P.armor, 1), weapon: WEAPONS[P.weapon].name, weaponIdx: P.weapon,
        mag: P.mag.slice(), reserve: P.reserve.slice(), gren: P.gren, crouch: num(P.crouch, 2), ads: num(P.ads, 2), dying: P.deadT > 0
      },
      enemies: ENEMIES.slice(0, 48).map(e => ({
        kind: e.kind, x: num(e.x, 2), y: num(e.y, 2), hp: Math.round(e.hp), state: e.state, alert: !!e.alert,
        d: num(Math.hypot(e.x - P.x, e.y - P.y), 2), yaw: num(wrapA(e.ang - P.ang), 2)
      })),
      counts: { enemies: ENEMIES.length, alive: enemiesLeft(), parts: PARTS.length, proj: PROJ.length, decals: DECALS.length, props: PROPS.length, pickups: PICKUPS.length, lights: LIGHTS.length },
      flags: { locked: !!S.locked, sound: !!S.sound, audioBroken: !!S.audioBroken, exitOpen: !!S.exitOpen, perf: !!S.perf, showMap: !!S.showMap, gfx: S.gfx, err: S.err || null },
      map: { w: MW, h: MH, exit: [num(exitX, 2), num(exitY, 2)] }
    };
  }
  /* The wall DDA from castWalls, run for one caller-supplied ray instead of every column:
     distance here is metres travelled, and `through` says whether the ray's altitude at the
     face is inside the span that actually gets drawn (z0..z1 of the air side). */
  function ray(x, y, z, dx, dy, dz, maxD) {
    const ox = +x, oy = +y, oz = z === undefined ? floorAt(ox, oy) + cfg.eye : +z;
    const vx = +dx || 0, vy = +dy || 0, vz = +dz || 0;
    const hd = Math.hypot(vx, vy) || 1e-9, lim = maxD === undefined ? 40 : +maxD;
    const rx = vx / hd, ry = vy / hd, rise = vz / hd;
    const ddx = Math.abs(1 / (rx || 1e-9)), ddy = Math.abs(1 / (ry || 1e-9));
    let mx = ox | 0, my = oy | 0, side = 0, guard = 0, d = 0, mat = 0, stepX, stepY, sdx, sdy;
    if (rx < 0) { stepX = -1; sdx = (ox - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - ox) * ddx; }
    if (ry < 0) { stepY = -1; sdy = (oy - my) * ddy; } else { stepY = 1; sdy = (my + 1 - oy) * ddy; }
    while (guard++ < 256) {
      if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
      d = side === 0 ? sdx - ddx : sdy - ddy;
      if (d > lim || mx < 0 || my < 0 || mx >= MW || my >= MH) break;
      mat = MAP.cell[my * MW + mx];
      if (mat) break;
    }
    if (!mat) return { hit: false, inside: isSolid(ox, oy), range: num(Math.min(d, lim), 3) };
    const nx = side === 0 ? -stepX : 0, ny = side === 1 ? -stepY : 0;
    const fd = side === 0 ? (nx > 0 ? 0 : 2) : (ny > 0 ? 1 : 3);
    const z0 = faceZ0(mx + nx, my + ny, fd), z1 = ceilAt(mx + nx, my + ny), zh = oz + d * rise;
    return {
      hit: true, inside: isSolid(ox, oy), dist: num(d, 3), x: num(ox + rx * d, 3), y: num(oy + ry * d, 3), z: num(zh, 3),
      cell: [mx, my], mat: mat, side: side === 0 ? 'x' : 'y', normal: [nx, ny], face: [num(z0, 2), num(z1, 2)],
      through: zh >= z0 && zh < z1
    };
  }
  /* DEV.mesh: draw N procedural volumetric bodies into the real framebuffer over a
     rendered world frame and return the cost (js/13_mesh.js). Since #69 B2 the enemy list calls
     MESH.draw too, so this draws EXTRA bodies on top of the level's own - clear them with
     DEV.clear() for a clean cost figure. self:false reproduces the original spike's read-only
     depth test - mesh-vs-world occlusion kept, self-occlusion lost to painter's order - as a
     negative control for the depth write. */
  function mesh(o) {
    o = o || {};
    const kind = ETYPE[o.kind] ? o.kind : 'grunt', cnt = Math.max(1, (o.n === undefined ? 1 : o.n) | 0);
    const d = o.d === undefined ? 3 : +o.d, span = o.span === undefined ? 1.1 : +o.span;
    const sc = o.scale === undefined ? ETYPE[kind].scale : +o.scale;
    const self = o.self === undefined ? true : !!o.self;
    if (S.mode !== 'play') DEV.boot();
    renderWorld();
    MESH.reset();
    const t0 = performance.now();
    for (let i = 0; i < cnt; i++) {
      const f = cnt === 1 ? 0 : (i / (cnt - 1) - 0.5) * span;
      const mx = P.x + Math.cos(P.ang) * d + Math.cos(P.ang + Math.PI / 2) * f;
      const my = P.y + Math.sin(P.ang) * d + Math.sin(P.ang + Math.PI / 2) * f;
      MESH.draw({
        kind, x: mx, y: my, z: o.z === undefined ? floorAt(mx, my) : +o.z,
        yaw: o.yaw === undefined ? Math.atan2(P.x - mx, P.y - my) : +o.yaw, scale: sc, self,
      });
    }
    const s = MESH.stats();
    return {
      ms: +(performance.now() - t0).toFixed(3), tris: s.tris, pxFilled: s.pxFilled, trisCulled: s.trisCulled,
      n: cnt, dist: num(d, 2), kind, self, scale: num(sc, 3), trisEach: MESH.trisFor(kind), vertsEach: MESH.vertsFor(kind), buf: BW + 'x' + BH,
    };
  }
  /* DEV.lum: Rec.709 luma of the COMPOSITED frame — cv, the display canvas after bloom, grade,
     grain and the HUD overlay — not the raster `px` that tools/view.js exposure averages (#85).
     mean is every stride'd pixel of the whole frame; mid is the same sample restricted to the
     centre half in x and y. They are different windows and are never substitutes for each other.
     Throws when it cannot measure, so a reader can never mistake "no canvas pixels" for "black". */
  function lum(o) {
    o = o || {};
    const stride = Math.max(1, (o.stride === undefined ? 4 : o.stride) | 0);
    const w = cv.width, h = cv.height;
    if (!w || !h) throw new Error('DEV.lum: display canvas is ' + w + 'x' + h + ' — the page has not resized');
    const d = ctx.getImageData(0, 0, w, h).data;
    const x0 = (w * 0.25) | 0, x1 = (w * 0.75) | 0, y0 = (h * 0.25) | 0, y1 = (h * 0.75) | 0;
    let aS = 0, aN = 0, mS = 0, mN = 0;
    for (let y = 0; y < h; y += stride) {
      const my = y >= y0 && y < y1;
      for (let x = 0; x < w; x += stride) {
        const i = ((y * w) + x) << 2;
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        aS += L; aN++;
        if (my && x >= x0 && x < x1) { mS += L; mN++; }
      }
    }
    if (!aN || !isFinite(aS)) throw new Error('DEV.lum: sampled ' + aN + ' pixel(s) of a ' + w + 'x' + h + ' canvas at stride ' + stride);
    return { mean: +(aS / aN).toFixed(2), mid: mN ? +(mS / mN).toFixed(2) : null, midN: mN, n: aN, stride: stride, buf: w + 'x' + h };
  }
  /* The identity check #166 was filed with, folded over the two arrays that say WHICH level this is:
     MAP.fz (the altitude grid) then MAP.cell (the floorplan). FNV-1a, the fold tools/view.js:3707 uses,
     so a number off the live page and a number off a probe are the same kind of number. Same fold on
     two boots ⇒ same level. Throws when there is no level rather than returning a number that would
     compare equal to another "nothing here". */
  function layoutSig() {
    if (!MAP.cell || !MAP.fz) throw new Error('DEV.layoutSig: no level generated yet — call DEV.boot() first');
    let h = 2166136261;
    for (let i = 0; i < MAP.fz.length; i++) h = Math.imul(h ^ MAP.fz[i], 16777619);
    for (let i = 0; i < MAP.cell.length; i++) h = Math.imul(h ^ MAP.cell[i], 16777619);
    return h >>> 0;
  }
  function tiers() { return QUAL.map((q, i) => ({ i: i, name: q.name, res: q.res, bloom: q.bloom, grade: q.grade, grain: q.grain, rigH: q.rigH, far: q.far, active: i === S.gfx })); }
  function help() {
    console.log([
      'DEV — this build is running with ?dev=1. Every method is safe to call any time.',
      '  DEV.on                         true: this page is instrumented',
      '  DEV.boot()                     start the run through the deploy button\'s own path; no click, no pointer lock',
      '  DEV.cam(x, y[, z, ang, pitch])  park camera+player. ang is P.ang (radians, +x is 0); pitch is P.pitch (buffer px).',
      '                                 a solid x,y is snapped to nearestOpen and reported as snapped:true; z clamps up to the floor',
      '  DEV.look(dAng[, dPitch])        rotate only — never feeds mouse.dx, so the player cannot drift into the void',
      '  DEV.face([enemy])               face the nearest living enemy, or one from DEV.nearestEnemy()/DEV.state().enemies',
      '  DEV.nearestEnemy()              nearest living enemy object, or null',
      '  DEV.freeze([bool])              stop update() and pin the clock; rendering continues, so two shots of a frame match',
      '  DEV.tick([n])                   run exactly n update+render frames at dt=1/60 with no vsync (returns {frames})',
      '  DEV.spawn(kind[, n, dist])      grunt|hound|brute, n in a fan dist metres in front of the camera, deterministic',
      '  DEV.clear()                     drop enemies, projectiles and particles; returns what it removed',
      '  DEV.set(name, value)            tier keys (res, bloom, grade, grain, far, glow, rigH, rast, dmax, scan, vec, min, max)',
      '                                  plus gfx (0..2 or a tier name) and rim (bool; clears the pose cache)',
      '  DEV.tiers()                     the QUAL table as it now stands, including any overrides set() made',
      '  DEV.layoutSig()                  FNV-1a over MAP.fz then MAP.cell — the level\'s identity (#166).',
      '                                  Two boots of one ?dev=1&seed=<n> URL must agree; with no seed they must not.',
      '  DEV.lum([{stride}])             composited frame luma {mean, mid}: cv after bloom/grade/grain/HUD,',
      '                                  mean over the whole frame, mid over the centre half-window — two',
      '                                  windows that are not interchangeable, and neither is view.js raster',
      '  DEV.stats()                     frame ms {n,med,p95,last}, fps, buf, drawCalls, poses this frame, RIG.stats(), enemies, tier',
      '  DEV.state()                     JSON-safe snapshot: player (ang is the heading), level, enemies, counts, S flags',
      '  DEV.ray(x, y[, z], dx, dy, dz[, maxD])',
      '                          the wall DDA for one ray: {hit, dist, x, y, z, cell, mat, side, normal, face, through}',
      '  DEV.mesh({n,d,kind,yaw,scale,span,z,self})',
      '                          renderWorld(), then draw n procedural volumetric bodies d metres along the view',
      '                          (js/13_mesh.js) and return {ms,tris,pxFilled}. self:false drops the depth WRITE,',
      '                          which is what makes a body occlude itself — the negative control for that claim.',
      '',
      '  examples: DEV.cam(4.5, 4.5, undefined, 0.6); DEV.freeze(true); DEV.tick(30)',
      '            DEV.spawn("brute", 1, 2); JSON.stringify(DEV.stats())',
      '            DEV.ray(P.x, P.y, 0.5, Math.cos(P.ang), Math.sin(P.ang), 0)   // is that wall there?',
      '',
      '  freeze stops update(); in title mode the attract camera still orbits (frameInner drives that) — DEV.boot() first.',
      '  while frozen S.fps runs on the pinned clock, so DEV.stats().ms is the number to believe.'
    ].join('\n'));
  }

  const DEV = {
    on: true, help: help, boot: boot, cam: cam, look: look, face: face, nearestEnemy: nearestEnemy, freeze: freeze,
    tick: tick, spawn: spawn, clear: clear, set: set, tiers: tiers, stats: stats, state: state, ray: ray, mesh: mesh,
    lum: lum, layoutSig: layoutSig, seed: SEED,
    get ground() { return { reSolveBad: reSolveBad, gndOffMap: gndOffMap, walkEdge: gndWalkEdge }; }   // ground re-solve counters, see tools/view.js heights
  };
  window.DEV = DEV;
  if (S.mode === 'title' && !/[?&]boot=0/.test(URLQ)) DEV.boot();
  // the boot-time marker a harness greps the deployed bytes for: this line is code, so it cannot be a comment
  if (SEED !== null) console.log('[DEV] seed ' + SEED + ' (mulberry) — DEV.state().layout identifies this level');
  console.log('[DEV] dev mode on — DEV.help()');
})();
