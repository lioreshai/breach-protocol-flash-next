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
  /* Where one body of the fan can go. The requested point first; then, BEFORE any shorter range,
     the points perpendicular to the ray at that same range (#93: backing off radially only moved a
     crowd along the ray, so a wall 1.5 m ahead folded every body into the camera's own cell and the
     HUD counted two hounds the frame drew as one); then the same two passes 0.5 m nearer, and so on
     down to 0.5 m. `used` is the set of cell indices this call has already taken, so n bodies land
     in n cells instead of n copies of one — which also separates the short-range case, where the
     0.16-rad fan is only 0.32 m wide at 2 m and two bodies share a cell with no wall anywhere.
     A candidate is refused unless the camera can actually reach it, asked two ways of the game's own
     code, because each sees what the other cannot: the wall DDA (ray, below) says no SOLID cell is in
     the way, and canEnter (js/20_level.js:215) says every CROSSING the straight line makes is
     walkable — a band one quantum up with no climb bit blocks the second way and draws no solid cell,
     so DDA alone would let a sidestep park a body in a sealed band. That is the same failure as the
     plane-read-through-a-wall trap in AGENTS.md: open, unused, and impossible to see or walk to.
     Stage 0 also demands an UNUSED cell and a spot inside the camera's own frustum (|perp| <=
     cfg.plane * along, the same screen-x test castWalls uses), because a fan that spreads a body 39
     deg off-axis at 1.5 m is "in front of the camera" in the return value only. Stage 1 drops those
     two demands and keeps open + reachable, which is the old rule; nearestOpen is the last resort and
     reports why:'rescue'. A crowd that has to fall through a stage is reported, not quietly absorbed. */
  const FANLAT = [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65];   // half-cell steps across the ray, + side first
  /* #321: a candidate must also keep BODY_SEP from every body already standing in the fan. The used-cell
     set is a CELL oracle - it made the crowd's cells distinct and left the metres unclaimed, because
     each body searches along ITS OWN ray and a body pushed sideways by a wall can land on the spot a
     neighbour's off-axis fan ray crosses. Measured on main with n = 3 at the four dealt seats: L0/L1/L3
     stand two bodies 0.32 m apart at 2 m (the ±0.16-rad fan is 0.32 m wide there, narrower than a body)
     and L2 0.29 m at 4 m, every pair in three DISTINCT cells; an 80-row sweep (4 levels x 5 grid-chosen
     poses x d {2, 4, 7.5, 12}) found 7 such rows, closest pair 0.13-0.41 m. Solving the fan step for the
     range instead - the other candidate fix - repaired 0 of those 7, because at 7.5 m the fan is already
     2.4 m wide and the collision is between a sidestep and a ray, not inside the fan. The radius is one
     lattice column (FANLAT[1]) so the keep-out and the sidestep ladder cannot disagree about the step.
     It gates both stages: stage 1 drops the cell and frustum demands, not the metres, so "crowded" can
     still mean a body that had to take a worse column but never one standing on another. */
  const BODY_SEP = FANLAT[1];
  function openAlong(a, d, used, keep) {
    const cx = Math.cos(a), sy = Math.sin(a), lx = -sy, ly = cx;
    const ax = Math.cos(P.ang), ay = Math.sin(P.ang);           // the camera's axis, for "in front of"
    const bsep2 = BODY_SEP * BODY_SEP;
    const clearOf = (x, y) => {
      for (let q = 0; keep && q < keep.length; q++) if (dist2(x, y, keep[q].x, keep[q].y) < bsep2) return false;
      return true;
    };
    const reach = (x, y) => {
      const dd = Math.hypot(x - P.x, y - P.y) || 1e-9, ux = (x - P.x) / dd, uy = (y - P.y) / dd;
      const w = ray(P.x, P.y, undefined, ux, uy, 0, dd);          // a solid cell in the line means no
      if (w.hit && w.dist < dd - 0.02) return false;
      const n = Math.max(1, Math.ceil(dd * 4));                   // crossings, sampled along the line
      let px = P.x, py = P.y;
      for (let i = 1; i <= n; i++) {
        const qx = P.x + (x - P.x) * i / n, qy = P.y + (y - P.y) * i / n;
        if (!canEnter(px, py, qx, qy)) return false;
        px = qx; py = qy;
      }
      return true;
    };
    // Radii: the requested one, then 0.5 m nearer, and the LAST one tried is always exactly 0.5 m —
    // a ladder of d - 0.5*k would stop at 0.7 for d = 3.2 and let the rescue put a body across the map.
    for (let stage = 0; stage < 2; stage++) {
      for (let k = 0; k < 64; k++) {
        const r = Math.max(d - 0.5 * k, 0.5);
        for (let j = 0; j < FANLAT.length; j++) {
          const x = P.x + cx * r + lx * FANLAT[j], y = P.y + sy * r + ly * FANLAT[j];
          if (isSolid(x, y)) continue;
          if (!clearOf(x, y)) continue;                          // metres, not cells: never on a neighbour
          if (stage === 0) {
            if (used && used.has((y | 0) * MW + (x | 0))) continue;
            const along = (x - P.x) * ax + (y - P.y) * ay;
            if (along <= 0 || Math.abs((y - P.y) * ax - (x - P.x) * ay) > cfg.plane * along * 0.98) continue;
          }
          if (!reach(x, y)) continue;
          const exact = stage === 0 && r === d && FANLAT[j] === 0;
          return { x: x, y: y, d: r, lat: FANLAT[j], exact: exact,
            why: stage ? 'crowded' : exact ? 'exact'
              : (FANLAT[j] === 0 ? 'short' : (r === d ? 'sidestep' : 'short+sidestep')) };
        }
        if (r === 0.5) break;
      }
    }
    const o = nearestOpen(P.x + cx * d, P.y + sy * d);
    return { x: o[0], y: o[1], d: Math.hypot(o[0] - P.x, o[1] - P.y), lat: 0, exact: false, why: 'rescue' };
  }
  /* Returns what it ACTUALLY did (#93): `dist` stays the realised range of each body (the field a
     console reader already used), and `placed` / `cells` / `collapsed` make a crowd's spread
     assertable instead of assumable — collapsed = bodies that ended up in another body's cell, so
     a fixture that wants n separate bodies asserts collapsed === 0 rather than counting the HUD. */
  function spawn(kind, n, dist) {
    const k = ETYPE[kind] ? kind : 'grunt', cnt = Math.max(1, (n === undefined ? 1 : n) | 0), d = dist === undefined ? 3 : +dist;
    const used = new Set(), keep = [], placed = [];
    for (let i = 0; i < cnt; i++) {
      const off = cnt === 1 ? 0 : (i % 2 ? 1 : -1) * 0.16 * Math.ceil(i / 2);
      const o = openAlong(P.ang + off, d, used, keep), e = makeEnemy(k, o.x, o.y);
      // makeEnemy scatters gait phase, tint and facing: pin them so two spawns agree
      e.anim = 0; e.stepPhase = 0; e.ph = 0; e.tint = [1, 1, 1]; e.state = 'sleep'; e.alert = false;
      // dv is pinned too, and to i rather than to 0: DEV.tick never seeds RNG, so a random variant
      // would be unreproducible, and a crowd that cycles the table is what lets the live page show
      // three different corpses from one call (the game rolls it at random instead)
      e.dv = i % MESH.DIEV;
      e.ang = Math.atan2(P.y - e.y, P.x - e.x);
      ENEMIES.push(e);
      used.add((e.y | 0) * MW + (e.x | 0));
      keep.push({ x: e.x, y: e.y });            // exact, not the 2-dp value the return rounds
      placed.push({ x: num(e.x, 2), y: num(e.y, 2), cell: [e.x | 0, e.y | 0],
        d: num(Math.hypot(e.x - P.x, e.y - P.y), 2), off: num(off, 3), lat: num(o.lat, 2),
        clamped: !o.exact, why: o.why });
    }
    const cells = new Set(placed.map(p => p.cell[1] * MW + p.cell[0]));
    // sep = closest two centres get, in metres. Distinct cells is the reachability claim; this is the
    // visual one — a body is ~0.5 m wide, so sep under that means the frame still shows one blob even
    // though every body stands in its own cell (the ±0.16-rad fan is only 0.32 m wide at 2 m).
    let sep = null;
    for (let i = 0; i < cnt; i++) for (let j = i + 1; j < cnt; j++) {
      const g = Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y);
      sep = sep === null ? g : Math.min(sep, g);
    }
    return {
      kind: k, made: cnt, n: cnt, wanted: num(d, 2), dist: placed.map(p => p.d),
      placed: placed, cells: cells.size, collapsed: cnt - cells.size, sep: sep === null ? null : num(sep, 2)
    };
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
    /* #19's three ground terms, switchable without editing the renderer - the issue's "each mechanism is
       switchable from the console". They are script-scope `let`s in js/40_render.js, and a top-level
       `let` lives in the global lexical environment every later script shares, so assigning the name
       here IS the switch; an explicit branch per term because you cannot assign to a binding by string.
       Each has a value that reproduces what shipped, so an A/B is one call and not a worktree:
         gndjit    2 = mirror every cell (shipped), 1 = mirror only wide cells, 0 = never
         gndlight  0 = one light value per cell (how it shipped), 1 = sampled at the pixel
         gndax     0 = one texel per pixel (shipped), 1 = a second tap along the footprint's long axis
         gndfilt   0 = one texel per pixel (shipped), 1 = the fetch lerps across the footprint's short
                   side - 3-11% of the ground streak metric (#19 take three), no more
         gndramp   0 = the deferred pixel's light ramp extrapolates away from the fallback cell, 1 = it
                   stops at the cell boundary. 0 is the far-field fan, with a light multiplier of up to 136
                   on a pixel whose ray landed 40 cells off the map (#19 take four); at 1 those pixels take
                   exactly what `main` delivers at the same pixel.
         gndoff   1 = a ground pixel whose ray landed OFF the level takes the light FIELD sampled at the
                   point it landed on, with taps outside the map reading 0 (#375); 0 = the light of the
                   cell the row's walk last reached, which paints the level's own outline as a bright
                   wedge in the far ceiling.
       gndfade  the share of a pixel's along-ray footprint its selected mip cannot carry, blended in from
                   one level coarser: w = GNDFA * (1 - 1/F) for a footprint of F texels of that level, and
                   0 where F <= 1, so the near field keeps mip 0. 1 = shipped (#19 take six); 0 = the
                   single-level fetch, which brings the fan back. A number between blends part of the
                   share, which is how the strength is swept.
       mip selection is already covered by DEV.ar, buffer scale by the tier keys. */
    if (name === 'gndjit') { GJIT = value === undefined ? 1 : value | 0; return { gndjit: GJIT, minPx: GJITPX }; }
    if (name === 'gndlight') { GLRP = value === undefined ? 1 : (value ? 1 : 0); return { gndlight: GLRP }; }
    if (name === 'gndax') { GNDAX = value === undefined ? 1 : (value ? 1 : 0); return { gndax: GNDAX, AXMIN: AXMIN }; }
    if (name === 'gndfilt') { GNDFT = value === undefined ? 1 : (value ? 1 : 0); return { gndfilt: GNDFT }; }
    if (name === 'gndramp') { GNDRO = value === undefined ? 1 : (value ? 1 : 0); return { gndramp: GNDRO }; }
    if (name === 'gndfar') { GNDFB = value === undefined ? 1 : (value ? 1 : 0); return { gndfar: GNDFB, far: GQ.far }; }
    if (name === 'gndoff') { GNDOF = value === undefined ? 1 : (value ? 1 : 0); return { gndoff: GNDOF }; }
    if (name === 'gndfade') {
      GNDFA = value === undefined ? 1 : +value;
      return { gndfade: GNDFA };
    }
    /* #407's A/B. 1 (shipped) = a body or prop takes MAP.light WHOLE at its own cell, exactly as a wall
       column and a ground pixel do; 0 = the pre-#407 second falloff (lm * exp(-distance * 0.14)) is back
       in BOTH copies - the mesh triangle shading and the billboard. One register, two read sites, so it
       cannot half-apply. */
    if (name === 'bodydist') { BODYDIST = value === undefined ? 1 : (value ? 1 : 0); return { bodydist: BODYDIST }; }
    /* #377: the highlight shoulder on the room's exposure term. 1 (shipped) = the delivered range ENDS
       at EXPOSE_TOP, so a lamp-lit deck keeps a gradient instead of clipping to white; 0 = the term is
       the black-point lift alone, which is what the > luma 224 rows were measured against before. Both
       halves of the term still run; only the `darken` fold is skipped. */
    if (name === 'shoulder') { SHOULDER = value === undefined ? 1 : (value ? 1 : 0); return { shoulder: SHOULDER, top: EXPOSE_TOP }; }
    /* #407 half two's A/B. 1 (shipped) = a body's shape ramp also SCALES the directionless lamp field,
       so the field reaches it at R0 + R1/2 of what the wall behind keeps; 0 = the same ramp centred on
       the field (mean 1 over its own domain) in the one mesh site that carries it. The gun keeps the
       shipped form either way - #376 owns that. See js/00_core.js. */
    if (name === 'bodyshade') { BODYSHADE = value === undefined ? 1 : (value ? 1 : 0); return { bodyshade: BODYSHADE }; }
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
      map: { w: MW, h: MH, exit: [num(exitX, 2), num(exitY, 2)] },
      /* #19's ground-shading state in one line, so an A/B claim can be read off the live page instead
         of off a worktree: which of the three mechanisms is on, and what mip policy is in force. */
      gnd: { jit: GJIT, jitMinPx: GJITPX, light: GLRP, ax: GNDAX, axMin: AXMIN, filt: GNDFT, ramp: GNDRO, far: GNDFB, fade: GNDFA, mipax: MIPAX, mipar: MIPAR }
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
      '  DEV.spawn(kind[, n, dist])      grunt|hound|brute, n in a fan dist metres in front of the camera, deterministic;',
      '                                  a blocked target steps SIDEWAYS before it steps nearer, and never reuses a cell.',
      '                                  returns {kind,n,wanted,dist[],placed[{x,y,cell,d,lat,clamped,why}],cells,collapsed,sep}',
      '                                  — cells = distinct cells occupied, collapsed = bodies sharing one (the frame will',
      '                                  show one of them), sep = closest two centres get (under ~0.5 m reads as one blob),',
      '                                  why: exact | sidestep | short | short+sidestep | crowded | rescue',
      '  DEV.clear()                     drop enemies, projectiles and particles; returns what it removed',
      '  DEV.set(name, value)            tier keys (res, bloom, grade, grain, far, glow, rigH, rast, dmax, scan, vec, min, max)',
      '                                  plus gfx (0..2 or a tier name), rim (bool; clears the pose cache), and the',
      '                                  three ground terms #19 made switchable: gndjit (2 mirror every cell /',
      '                                  1 mirror wide cells only / 0 never), gndlight (0 per cell / 1 per pixel),',
      '                                  gndax (0 point fetch / 1 filtered along the footprint), and',
      '                                  gndfilt (0 one texel per pixel / 1 lerp across the short side), and',
      '                                  gndramp (0 extrapolate the deferred light ramp off-map / 1 stop at the cell), and',
      '                                  gndfar (0 the deferred copy textures its far field / 1 it washes it like the row does), and',
      '                                  bodydist (1 a body or prop keeps the lamp field whole at its own cell, the shipped',
      '                                  #407 behaviour / 0 the second camera-distance falloff is back on BOTH the mesh and',
      '                                  the billboard copy, which is how a body 10 m away goes dark)',
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
