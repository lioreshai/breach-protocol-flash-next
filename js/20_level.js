'use strict';
/* ==================================================================
   20_level.js — procedural level generation, lights, occupancy
   ================================================================== */
const LEVELS = [
  {
    name: 'ARCHIVE SUBLEVEL', size: 26, rooms: 7, maxRoom: 9, wall: WT.BRICK, wall2: WT.STONE,
    floor: 'STONE', ceil: 'ROCK', amb: 0.19, lampCol: [255, 196, 120], fogCol: [17, 13, 10],
    lamps: 6, crates: 7, barrels: 7, spawn: { grunt: 5, hound: 3, brute: 0 }, pick: { health: 3, ammo: 4, armor: 1 }
  },
  {
    name: 'RING TRANSPORT', size: 32, rooms: 9, maxRoom: 10, wall: WT.TECH, wall2: WT.METAL,
    floor: 'METAL', ceil: 'PANEL', amb: 0.185, lampCol: [170, 226, 255], fogCol: [10, 14, 21],
    lamps: 8, crates: 8, barrels: 9, spawn: { grunt: 6, hound: 5, brute: 1 }, pick: { health: 4, ammo: 5, armor: 2 }
  },
  {
    name: 'ABATOIR CORE', size: 36, rooms: 11, maxRoom: 11, wall: WT.FLESH, wall2: WT.TECH2,
    floor: 'FLESH', ceil: 'SINEW', amb: 0.3, lampCol: [190, 255, 150], fogCol: [21, 8, 11],
    lamps: 9, crates: 9, barrels: 12, spawn: { grunt: 8, hound: 7, brute: 3 }, pick: { health: 5, ammo: 6, armor: 2 }
  }
];

let MAP = { w: 0, h: 0, cell: null, light: null, rooms: [] };
let MW = 0, MH = 0;
let LIGHTS = [], PROPS = [], PICKUPS = [], ENEMIES = [], PROJ = [], PARTS = [];
/* decals are stored per cell so the wall/floor loops can skip cells with none */
let DECALS = [], DECAL_GRID = [], DECAL_MASK = null;
let exitX = 0, exitY = 0, explored = null, bfsDist = null;   // read by an assertion in tools/smoke.js

const cellIdx = (x, y) => (y | 0) * MW + (x | 0);
/* Nearest cell without a wall, by breadth-first search from a starting point. */
function nearestOpen(x, y) {
  if (!isSolid(x, y)) return [x, y];
  const seen = new Uint8Array(MAP.cell.length), q = [(y | 0) * MW + (x | 0)];
  seen[q[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], cx = c % MW, cy = (c / MW) | 0;
    if (!isSolid(cx + 0.5, cy + 0.5)) return [cx + 0.5, cy + 0.5];
    for (const d of [1, -1, MW, -MW]) {
      const n = c + d;
      if (n < 0 || n >= seen.length || seen[n]) continue;
      seen[n] = 1; q.push(n);
    }
  }
  return [x, y];
}
const isSolid = (x, y) => {
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return true;
  return MAP.cell[iy * MW + ix] !== 0;
};
const cellLightAt = (x, y) => {
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return 0;
  return MAP.light[iy * MW + ix];
};
function blocked(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  if (d < 1e-4) return false;
  const st = 0.14, n = (d / st) | 0;
  for (let i = 1; i < n; i++) { const t = i * st / d; if (isSolid(ax + dx * t, ay + dy * t)) return true; }
  return false;
}
function los(ax, ay, bx, by) { return !blocked(ax, ay, bx, by); }

function pickWallTex(cfgL) { return Math.random() < 0.78 ? cfgL.wall : cfgL.wall2; }

/* Adds one light's contribution to the lightmap; a negative amount takes it back out.
   Static lights are splatted once at generation, transient ones re-splat their delta
   each frame as they fade, which keeps add/remove exactly reversible. */
function splatLight(L, amt) {
  const lm = MAP.light, lr = MAP.lR, lg = MAP.lG, lb = MAP.lB, lw = MAP.lw, N = MAP.w, R = Math.ceil(L.r);
  const c = L.col || [255, 205, 150];
  for (let y = Math.max(0, (L.y - R) | 0); y < Math.min(N, L.y + R); y++)
    for (let x = Math.max(0, (L.x - R) | 0); x < Math.min(N, L.x + R); x++) {
      const d = Math.hypot(x + 0.5 - L.x, y + 0.5 - L.y);
      if (d >= L.r) continue;
      const w = Math.pow(1 - d / L.r, 1.6), i = y * N + x;
      lm[i] += amt * w;
      const k = Math.abs(amt * w);
      lr[i] += c[0] / 255 * k; lg[i] += c[1] / 255 * k; lb[i] += c[2] / 255 * k; lw[i] += k;
    }
  MAP.tintDirty = true;
}
/* one smoothing pass so per-cell light reads as a pool, not a chessboard */
function blurLight() {
  const N = MAP.w, s = MAP.light, o = new Float32Array(s.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    let sum = s[i] * 3, n = 3;
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      if (!j && !k) continue;
      const yy = y + j, xx = x + k;
      if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
      sum += s[yy * N + xx] * (j === 0 || k === 0 ? 2 : 1); n += j === 0 || k === 0 ? 2 : 1;
    }
    o[i] = sum / n;
  }
  MAP.light = o;
}
function buildTint() {
  const N = MAP.w * MAP.w, lt = MAP.lt, lr = MAP.lR, lg = MAP.lG, lb = MAP.lB, lw = MAP.lw;
  for (let i = 0; i < N; i++) {
    const w = lw[i];
    if (w < 0.004) { lt[i * 3] = 128; lt[i * 3 + 1] = 128; lt[i * 3 + 2] = 128; continue; }
    lt[i * 3] = clamp(128 * (lr[i] / w) / 0.82, 24, 235) | 0;
    lt[i * 3 + 1] = clamp(128 * (lg[i] / w) / 0.82, 24, 235) | 0;
    lt[i * 3 + 2] = clamp(128 * (lb[i] / w) / 0.82, 24, 235) | 0;
  }
  MAP.tintDirty = false;
}

/* ---------------- decals ---------------- */
function decalGridInit() {
  const N = MAP.w;
  DECALS = []; DECAL_GRID = new Array(N * N); DECAL_MASK = new Uint8Array(N * N);
}
function addDecal(o) {
  const N = MAP.w, cx = clamp(o.x | 0, 0, N - 1), cy = clamp(o.y | 0, 0, N - 1), ci = cy * N + cx;
  o.cell = ci; o.life = o.life || 40; o.a = o.a === undefined ? 1 : o.a;
  // the floor sampler maps world offsets to texels with inv; without it every splat
  // sampled texel (0,0) - a transparent corner - so ground decals never drew
  if (o.inv === undefined) o.inv = 1 / (2 * (o.r || 0.1));
  DECALS.push(o);
  if (!DECAL_GRID[ci]) DECAL_GRID[ci] = [];
  DECAL_GRID[ci].push(o); DECAL_MASK[ci] = 1;
  while (DECALS.length > 180) removeDecal(DECALS[0]);
}
function removeDecal(o) {
  const i = DECALS.indexOf(o);
  if (i >= 0) DECALS.splice(i, 1);
  const g = DECAL_GRID[o.cell];
  if (g) { const j = g.indexOf(o); if (j >= 0) g.splice(j, 1); if (!g.length) { DECAL_GRID[o.cell] = null; DECAL_MASK[o.cell] = 0; } }
}
function updateDecals(dt) {
  for (let i = DECALS.length - 1; i >= 0; i--) {
    const d = DECALS[i];
    d.life -= dt;
    if (d.life < 6) d.a = d.a0 === undefined ? (d.a0 = d.a) * Math.max(0, d.life / 6) : d.a0 * Math.max(0, d.life / 6);
    if (d.life <= 0) removeDecal(d);
  }
}
/* a hole punched in a wall face, or a pool on the floor */
function addWallMark(x, y, z, side, kind) {
  if (side === undefined) return;
  addDecal({ x, y, z: clamp(z, 0.12, 0.88), r: 0.11 + Math.random() * 0.04, side: side + 1, tex: kind === 'scorch' ? DECAL.scorch : DECAL.bullet, a: 0.9 });
}
function addGroundSplat(x, y, r, kind) {
  const tex = kind === 'goo' ? DECAL.goo : kind === 'scorch' ? DECAL.scorch : kind === 'dust' ? DECAL.dust : DECAL.blood;
  if (kind === 'dust') { addDecal({ x: x + rnd(0.1, -0.1), y: y + rnd(0.1, -0.1), z: 0.01, r, tex, a: 0.3, life: 12 }); return; }
  addDecal({ x: x + rnd(0.14, -0.14), y: y + rnd(0.14, -0.14), z: 0.01, r, tex, a: kind === 'scorch' ? 0.85 : 0.8, life: 55 });
}

function genLevel(li) {
  const cfgL = LEVELS[li];
  if (cfgL.fogCol) { FOGC[0] = cfgL.fogCol[0]; FOGC[1] = cfgL.fogCol[1]; FOGC[2] = cfgL.fogCol[2]; }
  for (let attempt = 0; attempt < 80; attempt++) {
    const N = cfgL.size, cell = new Uint8Array(N * N);
    for (let x = 0; x < N; x++) { cell[x] = pickWallTex(cfgL); cell[(N - 1) * N + x] = pickWallTex(cfgL); }
    for (let y = 0; y < N; y++) { cell[y * N] = pickWallTex(cfgL); cell[y * N + N - 1] = pickWallTex(cfgL); }
    const rooms = [];
    for (let i = 0; i < cfgL.rooms * 6 && rooms.length < cfgL.rooms; i++) {
      const rw = 5 + rndi(Math.max(1, cfgL.maxRoom - 4)), rh = 5 + rndi(Math.max(1, cfgL.maxRoom - 4));
      const rx = 1 + rndi(Math.max(1, N - rw - 2)), ry = 1 + rndi(Math.max(1, N - rh - 2));
      let ok = true;
      for (const r of rooms) {
        if (rx <= r.x + r.w + 1 && rx + rw >= r.x - 1 && ry <= r.y + r.h + 1 && ry + rh >= r.y - 1) { ok = false; break; }
      }
      if (!ok) continue;
      for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) cell[y * N + x] = 0;
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) });
    }
    if (rooms.length < 4) continue;

    const carveH = (x0, x1, y, wid) => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let k = 0; k < wid; k++) if (y + k > 0 && y + k < N - 1 && x > 0 && x < N - 1) cell[(y + k) * N + x] = 0;
    };
    const carveV = (y0, y1, x, wid) => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let k = 0; k < wid; k++) if (y > 0 && y < N - 1 && x + k > 0 && x + k < N - 1) cell[y * N + x + k] = 0;
    };
    const link = (a, b, wid) => {
      if (Math.random() < 0.5) { carveH(a.cx, b.cx, a.cy, wid); carveV(a.cy, b.cy, b.cx, wid); }
      else { carveV(a.cy, b.cy, a.cx, wid); carveH(a.cx, b.cx, b.cy, wid); }
    };
    for (let i = 1; i < rooms.length; i++) link(rooms[i - 1], rooms[i], li >= 1 ? 2 : 1);
    for (let i = 0; i < (rooms.length >> 1) + 1; i++) {
      const a = pick(rooms), b = pick(rooms);
      if (a !== b) link(a, b, 1);
    }
    // pillars & alcoves inside big rooms
    for (const r of rooms) {
      if (r.w >= 8 && r.h >= 8) {
        for (let y = r.y + 2; y < r.y + r.h - 2; y += 2)
          for (let x = r.x + 2; x < r.x + r.w - 2; x += 2)
            if (Math.random() < 0.42) cell[y * N + x] = pickWallTex(cfgL);
      }
    }

    // occupancy from room 0
    const dist = new Int16Array(N * N).fill(-1);
    const q = [rooms[0].cy * N + rooms[0].cx];
    dist[q[0]] = 0;
    for (let head = 0; head < q.length; head++) {
      const idx = q[head], x = idx % N, y = (idx / N) | 0, d = dist[idx];
      const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nb) {
        if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
        const ni = ny * N + nx;
        if (cell[ni] === 0 && dist[ni] < 0) { dist[ni] = d + 1; q.push(ni); }
      }
    }
    let reachable = 0, far = -1, farIdx = -1, total = 0;
    for (let i = 0; i < N * N; i++) if (dist[i] >= 0) { reachable++; total++; if (dist[i] > far) { far = dist[i]; farIdx = i; } }
    let openCells = 0; for (let i = 0; i < N * N; i++) if (cell[i] === 0) openCells++;
    if (reachable < openCells * 0.9) continue;              // too much of the map sealed off

    MAP = { w: N, h: N, cell, light: new Float32Array(N * N), rooms,
      lR: new Float32Array(N * N), lG: new Float32Array(N * N), lB: new Float32Array(N * N), lw: new Float32Array(N * N),
      lt: new Uint8Array(N * N * 3), amb: cfgL.amb === undefined ? 0.13 : cfgL.amb, tintDirty: true,
      floorTex: FLOORS[cfgL.floor] || FLOORS.CONCRETE, ceilTex: CEILS[cfgL.ceil] || CEILS.CONCRETE,
      floorTile: 1.15, ceilTile: 0.9 };
    MW = N; MH = N; decalGridInit();

    bfsDist = dist;
    explored = new Uint8Array(N * N); S.revealed = 0; bfsDist = new Int16Array(N * N);
    const px0 = rooms[0].cx + 0.5, py0 = rooms[0].cy + 0.5;
    exitX = (farIdx % N) + 0.5; exitY = ((farIdx / N) | 0) + 0.5;

    const freeCells = [];
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) if (cell[y * N + x] === 0) freeCells.push([x, y]);
    const takeNear = (minD, maxD) => {
      for (let tries = 0; tries < 200; tries++) {
        const c = freeCells[rndi(freeCells.length)], d = dist[c[1] * N + c[0]];
        if (d < 0) continue;
        if (d >= minD && (!maxD || d <= maxD)) {
          // require some openness (not a 1x1 pocket)
          let open = 0;
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!cell[(c[1] + oy) * N + (c[0] + ox)] && c[1] + oy > 0 && c[0] + ox > 0) open++;
          if (open >= 6) return c;
        }
      }
      return freeCells[rndi(freeCells.length)];
    };

    LIGHTS = []; PROPS = []; PICKUPS = []; PROJ = []; PARTS = []; ENEMIES = [];
    for (let i = 0; i < cfgL.lamps; i++) {
      const c = takeNear(1);
      LIGHTS.push({ x: c[0] + 0.5, y: c[1] + 0.5, r: 7.2 + Math.random() * 2.8, str: 1.05, col: cfgL.lampCol, stat: 1 });
      PROPS.push({ tex: PROP.lamp, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.95, z: 0.28, kind: 'lamp' });
    }
    LIGHTS.push({ x: exitX, y: exitY, r: 5.5, str: 0.75, col: [140, 225, 255], stat: 1 });
    for (let i = 0; i < cfgL.crates; i++) { const c = takeNear(2); PROPS.push({ tex: PROP.crate, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.72, z: 0.0, kind: 'crate' }); }
    for (let i = 0; i < cfgL.barrels; i++) {
      const c = takeNear(2);
      PROPS.push({ tex: PROP.barrel, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.86, z: 0.0, kind: 'barrel', hp: 26, dead: false });
    }
    for (const k in cfgL.pick) for (let i = 0; i < cfgL.pick[k]; i++) {
      const c = takeNear(2);
      PICKUPS.push({ type: k, x: c[0] + 0.5, y: c[1] + 0.5, bob: Math.random() * TAU, dead: false });
    }
    let si = 0;
    for (const kind in cfgL.spawn) {
      const n = Math.round(cfgL.spawn[kind] * DIFFS[S.diff].cnt);
      for (let i = 0; i < n; i++) {
        const c = takeNear(7 + (si % 4) * 2);
        let ex = c[0] + 0.5, ey = c[1] + 0.5;
        if (dist[c[1] * N + c[0]] < 0) { ex = rooms[1].cx + 0.5; ey = rooms[1].cy + 0.5; }   // never seal an enemy away
        ENEMIES.push(makeEnemy(kind, ex, ey));
        si++;
      }
    }
    // lightmap splat, then a smoothing pass and the per-cell tint
    for (const L of LIGHTS) splatLight(L, L.str);
    blurLight(); buildTint();
    // The scatter pass can drop a pillar on the room centre, and starting inside
    // geometry is unrecoverable - the collision probes would sample the player's own
    // cell - so walk out to the nearest open cell instead of spawning into a wall.
    const sp = nearestOpen(px0, py0);
    P.x = sp[0]; P.y = sp[1]; P.ang = 0.6; P.vx = P.vy = 0; P.z = 0;
    return true;
  }
  // extremely unlikely fallback: reuse a smaller successful layout
  const N = LEVELS[li].size;
  const cell = new Uint8Array(N * N).fill(0);
  for (let x = 0; x < N; x++) { cell[x] = cell[(N - 1) * N + x] = WT.TECH; }
  for (let y = 0; y < N; y++) { cell[y * N] = cell[y * N + N - 1] = WT.TECH; }
  MAP = { w: N, h: N, cell, light: new Float32Array(N * N).fill(0.7), rooms: [{ x: 1, y: 1, w: N - 2, h: N - 2, cx: N >> 1, cy: N >> 1 }],
    lR: new Float32Array(N * N).fill(0.6), lG: new Float32Array(N * N).fill(0.6), lB: new Float32Array(N * N).fill(0.6), lw: new Float32Array(N * N).fill(0.7),
    lt: new Uint8Array(N * N * 3).fill(128), amb: 0.14, tintDirty: false, floorTex: FLOORS.CONCRETE, ceilTex: CEILS.CONCRETE, floorTile: 1.15, ceilTile: 0.9 };
  MW = N; MH = N; decalGridInit(); explored = new Uint8Array(N * N); S.revealed = 0;
  LIGHTS = []; PROPS = []; PICKUPS = []; PROJ = []; PARTS = []; ENEMIES = [];
  exitX = N - 2.5; exitY = N - 2.5; P.x = 2.5; P.y = 2.5;
  for (const L of LIGHTS) splatLight(L, L.str);
  buildTint();
  return true;
}
