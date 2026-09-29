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
    lamps: 16, crates: 9, barrels: 12, spawn: { grunt: 8, hound: 7, brute: 3 }, pick: { health: 5, ammo: 6, armor: 2 }
  }
];

let MAP = { w: 0, h: 0, cell: null, light: null, rooms: [] };
let MW = 0, MH = 0;
let LIGHTS = [], PROPS = [], PICKUPS = [], ENEMIES = [], PROJ = [], PARTS = [];
/* decals are stored per cell so the wall/floor loops can skip cells with none */
let DECALS = [], DECAL_GRID = [], DECAL_MASK = null;
let exitX = 0, exitY = 0, explored = null, bfsDist = null;   // read by an assertion in tools/smoke.js

const cellIdx = (x, y) => (y | 0) * MW + (x | 0);

/* ================= the vertical grid =================
   One walkable band per column, altitudes quantised into ZQ steps:
     fz    floor altitude of the column, in quanta (0 = today's ground, -4 = a pit)
     cz    this column's own ceiling, in quanta above its own floor
     vb    the four boundary crossings, four bits per side in DIR order (16 bits per
           column) described from the point of view of LEAVING this cell that way
     feat  what the column is, for the minimap
   Everything is flat while fz is all zeros: cz is CZ_DEF, the one-unit room the
   raycaster hard-codes today, and vb holds only VB_BLOCK, on the boundaries isSolid
   already implies. Each formula below is written to collapse to the flat world's
   exactly - that is this milestone's backwards-compatibility test. */
const ZQ = 0.25;
const CZ_DEF = 4;                                        // 4 quanta = one unit of ceiling
const VB_BLOCK = 1, VB_RAMP = 2, VB_LADDER = 4, VB_THRU = 8;
const VB_KEEP = 0x6666;                    // VB_RAMP|VB_LADDER in each of the four side nibbles: the authored bits
const FEAT_NONE = 0, FEAT_STAIR = 1, FEAT_LADDER = 2, FEAT_PIT = 3, FEAT_RAIL = 4;
/* Leaving a cell in direction d steps by (DIRX[d], DIRY[d]); d ^ 2 is the way back in. */
const DIRX = [1, 0, -1, 0], DIRY = [0, 1, 0, -1];
/* Side order used by the breadth-first walks; +x, -x, +y, -y, as the old index
   arithmetic visited them, so nearestOpen still finds the same cell. */
const BFS_SIDES = [0, 2, 1, 3];

/* Floor altitude of a column in world units; the void outside the map is the ground. */
const floorAt = (x, y) => {
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return 0;
  return MAP.fz[iy * MW + ix] * ZQ;
};
/* The underside of whatever stands above: the tallest neighbouring floor, but never
   lower than one unit over this column's own. Flat, this is exactly 1. */
function ceilAt(x, y) {
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return 1;
  const i = iy * MW + ix, f = MAP.fz[i] * ZQ;
  let c = f + Math.max(ZQ, MAP.cz[i] * ZQ);
  for (let d = 0; d < 4; d++) {
    const nx = ix + DIRX[d], ny = iy + DIRY[d];
    if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
    const nf = MAP.fz[ny * MW + nx] * ZQ;
    if (nf > c) c = nf;
  }
  return c;
}
/* Bottom of the face that the solid column in direction d shows into the air of cell (x,y).
   A solid column is solid from its own floor upward, so the boundary plane starts being
   material at the higher of the two floors; its top is ceilAt(x,y) of the air side, where the
   ceiling pass takes over. Flat, that is the pair the raycaster hard-coded: 0 and 1. */
const faceZ0 = (x, y, d) => Math.max(floorAt(x, y), floorAt(x + DIRX[d], y + DIRY[d]));
/* Ceiling plane of every column in world units, derived from the grid wherever the grid is derived
   (linkBoundaries). The ground pass reads this instead of calling ceilAt at every cell crossing:
   identical numbers, but ~1300 calls once per level instead of ~5000 per frame inside the pixel
   loop, which was the difference between the flat world paying nothing for the per-cell solver and
   paying 5% of it. It is filled by CALLING ceilAt, so the formula exists once, and it hangs off the
   same hook as MAP.vb because a stamp that says "the grid moved" is one forgotten write away from
   drawing last frame's ceilings - which is why tools/view.js planes checks it against ceilAt. */
function buildCeilPlanes() {
  const cp = MAP.ceilPlane;
  for (let y = 0, i = 0; y < MH; y++) for (let x = 0; x < MW; x++, i++) cp[i] = ceilAt(x, y);
  return cp;
}
/* Which band of the column (x,y) an altitude belongs to. A column has one walkable band
   in this representation, so the answer is 0 inside it and -1 in the slabs and void
   around it - enough to make "is this upstairs from that" a real question by M4. */
function bandOf(x, y, z) {
  if (isSolid(x, y)) return -1;
  return (z >= floorAt(x, y) && z < ceilAt(x, y)) ? 0 : -1;
}
/* Flags of the crossing that leaves cell (x,y) in direction d. */
const vbAt = (x, y, d) => (MAP.vb[(y | 0) * MW + (x | 0)] >> ((d & 3) << 2)) & 15;
/* A ladder is either what a column IS or how a crossing is flagged, and only these two say so:
   the up/down controls move P.z here and nowhere else. */
function onLadder(x, y) {
  const i = (y | 0) * MW + (x | 0);
  if (!MAP.cell[i] && MAP.feat[i] === FEAT_LADDER) return true;
  const b = MAP.vb[i];
  for (let d = 0; d < 4; d++) if (b & (VB_LADDER << (d << 2))) return true;
  return false;
}
/* Derive every crossing from the grid: a wall blocks, and so does a step up taller than
   one quantum unless something ramps or ladders it. A drop is never a wall - you take it.
   Setting the flag here is what makes "blocking, walkable and drawn" one byte later. */
let LINK_STAMP = 0;                                       // monotonic across level rebuilds, so a
/* Reachability over open cells, shared by the occupancy gate and the `vert` probe. A boundary is
   crossable when the two floors are within one quantum, or when something lets you climb the step
   (see linkedClimb); on an all-flat grid the first test is always true and the second is never
   reached, which is what keeps this a no-op on a flat level. vbArr/featArr are optional so a probe
   that hands in a synthetic grid keeps the quantum-only rule it was written against. */
function bfsReach(cellArr, fzArr, N, start, vbArr, featArr) {
  const dist = new Int16Array(N * N).fill(-1);
  const q = [start];
  dist[start] = 0;
  for (let head = 0; head < q.length; head++) {
    const idx = q[head], x = idx % N, y = (idx / N) | 0, d = dist[idx];
    const nb = [[x + 1, y, 0], [x - 1, y, 2], [x, y + 1, 1], [x, y - 1, 3]];
    for (const [nx, ny, dd] of nb) {
      if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
      const ni = ny * N + nx;
      if (cellArr[ni] !== 0 || dist[ni] >= 0) continue;
      if (Math.abs(fzArr[ni] - fzArr[idx]) <= 1 || linkedClimb(vbArr, featArr, idx, ni, dd)) { dist[ni] = d + 1; q.push(ni); }
    }
  }
  return dist;
}
/* A crossing taller than one quantum still LINKS the two bands when something lets you climb it: a
   RAMP or LADDER nibble on either side - the pair linkBoundaries refuses to block - or a column that
   IS a ladder. Without this half the occupancy gate calls every banded layout unreachable and the
   generator ships its flat fallback box while the code looks correct (#152). */
function linkedClimb(vbArr, featArr, i, j, d) {
  if (featArr && (featArr[i] === FEAT_LADDER || featArr[j] === FEAT_LADDER)) return true;
  if (!vbArr) return false;
  return !!(vbArr[i] & (VB_RAMP | VB_LADDER) << (d << 2)) ||
    !!(vbArr[j] & (VB_RAMP | VB_LADDER) << ((d ^ 2) << 2));
}

function linkBoundaries() {                               // read before one cannot look fresh
  const cell = MAP.cell, fz = MAP.fz;
  let steps = 0;            // does ANY column boundary in this level have a step at it? (#100)
  const seenF = new Uint8Array(256); let bands = 0;   // distinct floor quanta over open columns (#152)
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = y * MW + x;
    if (!cell[i]) { const k = fz[i] + 128; if (!seenF[k]) { seenF[k] = 1; bands++; } }
    let bits = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRX[d], ny = y + DIRY[d];
      if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
      const n = ny * MW + nx;
      if (cell[i] || cell[n]) { bits |= VB_BLOCK << (d << 2); continue; }
      const dq = fz[n] - fz[i];
      if (dq > 1 || dq < -1) steps = 1;                   // a riser exists to draw, up or down (#100)
      if (dq > 1 && !(MAP.vb[i] & (VB_RAMP | VB_LADDER) << (d << 2))) bits |= VB_BLOCK << (d << 2);
    }
    // blocking is derived from the grid, so a relink must be able to REMOVE it: OR-ing leaves a
    // wall behind when a boundary is lowered or flattened. The authored bits survive via VB_KEEP.
    MAP.vb[i] = (MAP.vb[i] & VB_KEEP) | bits;
  }
  // The wall pass asks this once per frame instead of testing every ray against the height grid:
  // every level the generator makes is flat, so the riser branch is never even reached there, which
  // is what keeps a flat frame bit-identical (#100). A grid with a step in it must come through this
  // function to be visible at all, so `view.js planes` asserts the flag tracks the grid.
  MAP.steps = steps;
  MAP.bands = bands;
  buildCeilPlanes();                                      // ceilings are derived from the same grid
  MAP.linkStamp = ++LINK_STAMP;                           // a relink that never ran is then assertable
}
/* Which side of its own cell a mover at (fx,fy) crosses to reach (tx,ty); -1 when the
   two are the same column, or only touch at a corner that the other probes already see. */
const sideFrom = (fx, fy, tx, ty) => {
  const dx = (tx | 0) - (fx | 0), dy = (ty | 0) - (fy | 0);
  if (dx === 1 && !dy) return 0;
  if (dy === 1 && !dx) return 1;
  if (dx === -1 && !dy) return 2;
  if (dy === -1 && !dx) return 3;
  return -1;
};
/* The one movement test, and the only one: an open column reached through a crossing
   that is not blocked. Height lives in the flag rather than in a second comparison here,
   so while the grid is flat this is exactly !isSolid(tx, ty). A mover standing inside
   geometry answers to openness alone - the flags of a wall say every way out is blocked,
   and taking them at face value is a permanent lock. */
function canEnter(fx, fy, tx, ty) {
  if (isSolid(tx, ty)) return false;
  if (isSolid(fx, fy)) return true;
  const d = sideFrom(fx, fy, tx, ty);
  return d < 0 || !(vbAt(fx, fy, d) & VB_BLOCK);
}

/* Nearest cell with a walkable floor, by breadth-first search from a starting point:
   four-neighbour, over exactly the crossings the player is allowed to make, so a sealed
   band can never be mistaken for a way out. */
function nearestOpen(x, y) {
  if (!isSolid(x, y)) return [x, y];
  const seen = new Uint8Array(MAP.cell.length), q = [(y | 0) * MW + (x | 0)];
  seen[q[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], cx = c % MW, cy = (c / MW) | 0;
    if (!isSolid(cx + 0.5, cy + 0.5)) return [cx + 0.5, cy + 0.5];
    for (const d of BFS_SIDES) {
      const nx = cx + DIRX[d], ny = cy + DIRY[d];
      if (nx < 0 || ny < 0 || nx >= MW || ny >= MH || seen[ny * MW + nx]) continue;
      // Inside geometry the search is only looking for the nearest floor, so it may step
      // through walls - a corner cell has no other way out. Once it is on open ground it
      // takes the crossings the player does, so a sealed band cannot answer as a rescue.
      if (!MAP.cell[c] && !canEnter(cx + 0.5, cy + 0.5, nx + 0.5, ny + 0.5)) continue;
      seen[ny * MW + nx] = 1; q.push(ny * MW + nx);
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
/* A raised band is not SOLID, so the march above walks straight through a slab of floor whose riser the
   wall pass paints and whose boundary byte makes it impassable: an enemy behind a platform saw through
   it and shot the player across it (#118, measured on the deployed build - los() true across a +1.0 m
   plateau in the middle of a 9 m run, floorAt at the midpoint 1.0). The decision belongs to the sight
   LINE's own altitude: a sample whose floor is above the line is a ceiling from that end of the ray,
   and one below it is ground you look over. On a generated (flat) level every floor is 0 and every eye
   is above it, so the second test never fires and this answers exactly what los answers. */
function losZ(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  if (d < 1e-4) return true;
  const st = 0.14, n = (d / st) | 0;
  for (let i = 1; i < n; i++) {
    const t = i * st / d, sx = ax + dx * t, sy = ay + dy * t;
    if (isSolid(sx, sy)) return false;
    // 1e-3 because a floor level with the line is the floor the eye stands on, not a wall in front of it
    if (floorAt(sx, sy) > az + (bz - az) * t + 1e-3) return false;
  }
  return true;
}

/* #125: how far along a shot's ray it stays inside the band it is travelling through. A wall has no altitude
   test - castRayDist is a 2D march - so before this a ray pitched past its own ceiling kept travelling and
   punched a hole along the TOP EDGE of whatever wall was behind it (measured on the deployed build: hit z
   2.50 against a face spanning 0.00..1.00, one mark stored at 0.856, which is the face top minus the decal
   inset). The planes are re-keyed at every SAMPLED cell rather than fixed at the origin, because through a
   ramp or stair opening the ceiling genuinely changes midway - a solver that used the origin's ceiling would
   also stop the legitimate upward shot at an enemy standing on a raised band, which is the shot view.js
   sight aims. Inside a solid cell the answer is the caller's own wall distance: ceilAt of a wall cell answers
   floor+0.25 (a fiction - a solid column has no air), so comparing against it would stop the shot mid-wall and
   un-mark every hit. Returns maxT when the ray never leaves its band. Only the CEILING term is here; see the
   floor note in the loop - the riser case is a wall hit and needs its own pass (#125 deferred half). */
/* Where a shot's ray leaves the band it travels through (#125 ceiling, #128 riser, #131 floor). Returns
   {t, kind, side}: kind 0 = stays in its band for maxT; kind 1 = rose through the CEILING plane of the cell it
   is in, which is not a face, so the caller stops the shot there with no wall verdict and no mark; kind 2 =
   stepped BELOW the floor of the cell it entered, which is a RISER - a drawn face - so the caller reports a wall
   hit at t on boundary `side` and the mark belongs to the riser rather than to whatever stands behind the drop;
   kind 3 = descended through the FLOOR plane of the cell it is in (#131), also not a face, so the caller stops
   the shot at the ground with a splat rather than letting it fly through the slab it is standing on. Both planes
   are re-keyed per SAMPLED cell, so a shot travelling through a ramp or an atrium opening is stopped neither by
   the ceiling it started under nor by a step it flies over, and a shot aimed down at a PIT re-keys to the pit's
   lower floor at the lip and keeps flying into the pit band - which is the behaviour view.js sight's band -1
   rows have asserted since before this term existed. A solid cell returns maxT, because ceilAt there is
   floor + 0.25 - a fiction, a solid column has no air - and comparing against it stops the shot mid-wall.
   t is solved exactly at the crossing (the cell boundary is an integer line, the ceiling plane is constant
   inside a cell), not the sample distance, so a riser mark lands on the plane instead of 14 cm inside the cell. */
function bandExitT(ax, ay, dx, dy, az, tanP, maxT) {
  const out = { t: maxT, kind: 0, side: 0 };
  if (!(maxT > 0)) return out;
  const st = 0.14, n = (maxT / st) | 0;                      // losZ's resolution: a 1-unit band cannot be crossed unseen
  let pxi = ax | 0, pyi = ay | 0;
  let cz = ceilAt(ax, ay), fl = floorAt(ax, ay);             // the GOVERNING band: the one the ray is inside
  for (let i = 1; i <= n; i++) {
    const t = i * st, x = ax + dx * t, y = ay + dy * t;
    if (isSolid(x, y)) return out;                           // the caller's own wall governs (see header)
    const z = az + tanP * t;
    if (z >= cz) {                                           // rose out of the band it is travelling in
      out.kind = 1;
      out.t = tanP > 0 ? (cz - az) / tanP : t;
      return out;
    }
    /* #131: the same solver's other wall it cannot see. The floor plane of the GOVERNING band is what the ray
       stands on, so a descending ray crosses it INSIDE one cell and a boundary test can never notice - that is
       how a shot aimed at the ground kept flying through the slab and marked the wall 20 m away. Solved exactly
       rather than on the sample, and only when the ray starts ABOVE that plane: a ray already below its own
       floor (a seat bug, see the spawn-altitude rows) keeps the old unmodelled flight instead of dying at the
       first sample 0.14 m from the muzzle. */
    if (z <= fl && tanP < 0 && az > fl) {
      out.kind = 3;
      out.t = (fl - az) / tanP;
      return out;
    }
    const ix = x | 0, iy = y | 0;
    if (ix !== pxi || iy !== pyi) {
      const nfl = floorAt(x, y), ncz = ceilAt(x, y);
      if (z < nfl && z >= fl) {          // a band whose floor is above a ray that is STILL IN its own band: a riser.
                                                             // The second term is load-bearing: a shot pitched down has
                                                             // already left its band through its own floor plane,
                                                             // and hitscan models no ground at all, so that ray
                                                             // keeps flying - and reaches an enemy standing in a
                                                             // pit below - instead of inventing a slab it cannot see.
        out.kind = 2;
        if (ix !== pxi) { out.side = 0; out.t = dx !== 0 ? ((dx > 0 ? ix : ix + 1) - ax) / dx : t; }
        else { out.side = 1; out.t = dy !== 0 ? ((dy > 0 ? iy : iy + 1) - ay) / dy : t; }
        if (!(out.t > 0)) out.t = t;
        return out;
      }
      if (ncz > z) { cz = ncz; fl = nfl; }                   // the ray steps INTO that band: re-key the planes
    }                                                        // else the band lies wholly below the ray - a hole in
                                                             // the floor it is flying over - so the governing
                                                             // ceiling stays, and the shot keeps descending
                                                             // until it enters that band for real
    pxi = ix; pyi = iy;
  }
  return out;
}

/* Why the three cases above are the whole rule, learned the hard way in #128. The naive form - test the planes
   of whatever cell the sample lands in - is wrong twice, and both wrongnesses were measured:
   - a cell LOWER than the shooter (a pit, or a poke of -1 unit) has a derived ceiling equal to the surrounding
     floor plane, which is ABOVE the ray as it descends: a state test sees "z >= ceilAt" and stops the shot at
     the boundary. But the ray is not through a ceiling, it is passing OVER a hole, and the ceiling that governs
     it is the one it is still inside (measured: view.js sight's band -1 rows turned into `MISS t 1.8 into wall`).
   - a cell whose floor is above the ray is not a plane crossing either, it is an EDGE: the boundary itself is
     the face, which is why the stop distance is solved from the integer boundary line, not from the sample.
   A floor crossing inside one cell (walking a shot down through its own floor plane) is unreachable by a shot
   from eye height in a level cell, so the governing planes only ever change at a boundary - and `fl` is kept
   for that reason, not because anything reads it here. */

function pickWallTex(cfgL) { return Math.random() < 0.78 ? cfgL.wall : cfgL.wall2; }

/* M3's generation half (#152): a layout is a floor plan until something has altitude. Raises `want`
   room interiors by one unit (BAND_UP quanta) and links each to the datum band with a stair run of
   1-quantum steps along a corridor mouth, or with a ladder column when the mouth is shorter than the
   four cells the run needs. Room 0 holds the spawn and is never raised. Every draw is the seeded
   RNG, and a candidate that costs any reachable cell its reach is reverted here, so a band can never
   be the reason an attempt fails the occupancy gate. Writes the grid only: linkBoundaries derives
   the blocking bits and the ceiling planes from it afterwards. */
const BAND_UP = 4;                                          // one unit above the datum, in quanta
function authorHeights(cell, N, rooms, fz, vb, feat, cz, want) {
  const owner = (x, y) => {
    for (const r of rooms) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    return null;
  };
  const open = (x, y) => x > 0 && y > 0 && x < N - 1 && y < N - 1 && cell[y * N + x] === 0;
  const start = rooms[0].cy * N + rooms[0].cx;
  let base = bfsReach(cell, fz, N, start, vb, feat), made = 0;
  const cand = rooms.slice(1), done = new Uint8Array(cand.length);
  // NO draw from Math.random anywhere in here: the scatter pass below (lamps, crates, barrels,
  // pickups, enemies) takes its places from that stream, and #90/#96 learned that a generator draw
  // count which moves makes every downstream measurement incomparable with the previous build. The
  // mouth is chosen by a coordinate hash instead - different room, different mouth, same seed.
  // Pass 0 raises only rooms that fit a STAIR of 1-quantum steps; pass 1 tops the count up with
  // ladders. That preference is what makes ">=1 climbable staircase" (alt's exit gate, smoke V18) a
  // property of any layout that HAS a stair-capable room instead of a property of candidate order.
  for (let pass = 0; pass < 2 && made < want; pass++) for (let at = 0; at < cand.length && made < want; at++) {
    if (done[at]) continue;
    const r = cand[at];
    const mouths = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (!open(x, y) || (x > r.x && x < r.x + r.w - 1 && y > r.y && y < r.y + r.h - 1)) continue;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRX[d], ny = y + DIRY[d];
        if (open(nx, ny) && !owner(nx, ny)) mouths.push([x, y, d]);
      }
    }
    if (!mouths.length) continue;
    const mo = mouths[(made * 7 + r.cx + r.cy * 3) % mouths.length], mx = mo[0], my = mo[1], md = mo[2];
    // the run of corridor cells that leaves the mouth: the stair writes the first three and the
    // fourth has to stay on the datum, or the last step is a wall instead of a step
    const line = [];
    for (let k = 1; k <= 4; k++) {
      const x = mx + DIRX[md] * k, y = my + DIRY[md] * k;
      if (!open(x, y) || owner(x, y)) break;
      line.push([x, y]);
    }
    const stair = line.length >= 4;
    if (!stair && pass === 0) continue;
    const undo = [];
    const mark = (x, y) => { const i = y * N + x; undo.push([i, fz[i], feat[i], vb[i], cz[i]]); return i; };
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (open(x, y)) fz[mark(x, y)] = BAND_UP;
    }
    if (stair) {
      for (let k = 0; k < 3; k++) {
        const i = mark(line[k][0], line[k][1]);
        fz[i] = BAND_UP - 1 - k; feat[i] = FEAT_STAIR;
      }
    } else {
      // a ladder where a stair will not fit: a shaft BAND_UP+2 quanta over its own floor, because the
      // climb tops out at ceilAt - cfg.eye and has to reach the band above, flagged on the crossing
      // that the grid alone would block
      const i = mark(line[0][0], line[0][1]);
      feat[i] = FEAT_LADDER; cz[i] = BAND_UP + 2;
      vb[i] |= VB_LADDER << (md << 2);
      vb[my * N + mx] |= VB_LADDER << ((md ^ 2) << 2);
    }
    const chk = bfsReach(cell, fz, N, start, vb, feat);
    let loss = 0;
    for (let i = 0; i < N * N; i++) if (base[i] >= 0 && chk[i] < 0) loss++;
    if (loss) {
      for (let k = undo.length - 1; k >= 0; k--) {
        const u = undo[k];
        fz[u[0]] = u[1]; feat[u[0]] = u[2]; vb[u[0]] = u[3]; cz[u[0]] = u[4];
      }
      continue;
    }
    base = chk; done[at] = 1; made++;
  }
  return made;
}


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
/* A hole punched in a wall face carries ABSOLUTE altitude (#120). The old clamp to [0.12, 0.88] meant
   "the middle of the face" only while every face spanned 0..1; the renderer solves dc.z as a world height
   (js/40_render.js: syTop = horizon + (eyeZ - (dc.z + dc.r)) * hpx), so above the datum the hole was
   painted into the floor slab of a room whose floor was higher than 0.88 - and the caller's h.z < 0.96
   window, testing an absolute altitude against the same flat window, usually dropped the mark first.
   A face spans from the higher of the two floors to the ceiling plane of the AIR side, so that is the
   window now, inset by the mark's own radius so a disc cannot hang over a band it was not punched in.
   The hit point lies on the boundary, so the face is the pair of cells sharing the integer line it hit;
   isSolid reads an off-map cell as solid, so the map edge resolves to the cell that exists. */
function addWallMark(x, y, z, side, kind) {
  if (side === undefined) return;
  const r = 0.11 + Math.random() * 0.04;
  const b = Math.round(side ? y : x);
  const c1 = side ? [x | 0, b - 1] : [b - 1, y | 0];
  const c2 = side ? [x | 0, b] : [b, y | 0];
  const air = isSolid(c1[0] + 0.5, c1[1] + 0.5) ? c2 : c1;
  const wall = air === c1 ? c2 : c1;
  const z0 = Math.max(floorAt(air[0] + 0.5, air[1] + 0.5), floorAt(wall[0] + 0.5, wall[1] + 0.5));
  /* Two open cells (a riser between bands) bound the face from BOTH sides, and the mark must stay inside the
     opening [max floor, min ceiling] - ceilAt of whichever cell happened to be non-solid would let a mark float
     up into the higher band's ceiling. A solid side is skipped: its ceilAt is the fiction (floor + 0.25), which
     is why this is a min over air cells only and not a general rule. */
  const bothAir = !isSolid(c1[0] + 0.5, c1[1] + 0.5) && !isSolid(c2[0] + 0.5, c2[1] + 0.5);
  const z1 = bothAir ? Math.min(ceilAt(c1[0] + 0.5, c1[1] + 0.5), ceilAt(c2[0] + 0.5, c2[1] + 0.5))
    : ceilAt(air[0] + 0.5, air[1] + 0.5);
  addDecal({ x, y, z: clamp(z, z0 + r, Math.max(z0 + r, z1 - r)), r, side: side + 1,
    tex: kind === 'scorch' ? DECAL.scorch : DECAL.bullet, a: 0.9 });
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

    /* occupancy from room 0. fzTry is the grid the BFS actually walks, and it is the same array
       MAP.fz becomes below, so a band written before this point cannot be invisible to the gate. */
    const fzTry = new Int8Array(N * N), czTry = new Uint8Array(N * N).fill(CZ_DEF);
    const vbTry = new Uint16Array(N * N), featTry = new Uint8Array(N * N);
    authorHeights(cell, N, rooms, fzTry, vbTry, featTry, czTry, cfgL.rooms >> 1);
    const dist = bfsReach(cell, fzTry, N, rooms[0].cy * N + rooms[0].cx, vbTry, featTry);
    let reachable = 0, far = -1, farIdx = -1, total = 0;
    // the exit stays on the datum band: a portal at the top of a staircase you cannot see from the
    // spawn is a navigation defect, and room 0's own cells are all band 0, so this always has a answer
    for (let i = 0; i < N * N; i++) if (dist[i] >= 0) { reachable++; total++; if (dist[i] > far && fzTry[i] === 0) { far = dist[i]; farIdx = i; } }
    let openCells = 0; for (let i = 0; i < N * N; i++) if (cell[i] === 0) openCells++;
    if (reachable < openCells * 0.9) continue;              // too much of the map sealed off

    MAP = { w: N, h: N, cell, light: new Float32Array(N * N), rooms,
      lR: new Float32Array(N * N), lG: new Float32Array(N * N), lB: new Float32Array(N * N), lw: new Float32Array(N * N),
      lt: new Uint8Array(N * N * 3), amb: cfgL.amb === undefined ? 0.13 : cfgL.amb, tintDirty: true,
      floorTex: FLOORS[cfgL.floor] || FLOORS.CONCRETE, ceilTex: CEILS[cfgL.ceil] || CEILS.CONCRETE,
      floorTile: 1.15, ceilTile: 0.9,
      fz: fzTry, cz: czTry,
      vb: vbTry, feat: featTry,
      ceilPlane: new Float64Array(N * N) };
    MW = N; MH = N; linkBoundaries(); decalGridInit();

    bfsDist = dist;
    explored = new Uint8Array(N * N); S.revealed = 0;
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
      LIGHTS.push({ x: c[0] + 0.5, y: c[1] + 0.5, z: floorAt(c[0] + 0.5, c[1] + 0.5) + 0.78, r: 7.2 + Math.random() * 2.8, str: 1.05, col: cfgL.lampCol, stat: 1 });
      PROPS.push({ tex: PROP.lamp, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.95, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'lamp' });
    }
    LIGHTS.push({ x: exitX, y: exitY, r: 5.5, str: 0.75, col: [140, 225, 255], stat: 1 });
    for (let i = 0; i < cfgL.crates; i++) { const c = takeNear(2); PROPS.push({ tex: PROP.crate, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.72, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'crate' }); }
    for (let i = 0; i < cfgL.barrels; i++) {
      const c = takeNear(2);
      PROPS.push({ tex: PROP.barrel, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.86, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'barrel', hp: 26, dead: false });
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
    P.x = sp[0]; P.y = sp[1]; P.ang = 0.6; P.vx = P.vy = 0; P.z = floorAt(sp[0], sp[1]);
    return true;
  }
  // extremely unlikely fallback: reuse a smaller successful layout
  console.warn('genLevel FALLBACK: every attempt for level ' + li + ' failed the occupancy gate - shipping a flat lit box with no enemies');
  const N = LEVELS[li].size;
  const cell = new Uint8Array(N * N).fill(0);
  for (let x = 0; x < N; x++) { cell[x] = cell[(N - 1) * N + x] = WT.TECH; }
  for (let y = 0; y < N; y++) { cell[y * N] = cell[y * N + N - 1] = WT.TECH; }
  MAP = { w: N, h: N, cell, light: new Float32Array(N * N).fill(0.7), rooms: [{ x: 1, y: 1, w: N - 2, h: N - 2, cx: N >> 1, cy: N >> 1 }],
    lR: new Float32Array(N * N).fill(0.6), lG: new Float32Array(N * N).fill(0.6), lB: new Float32Array(N * N).fill(0.6), lw: new Float32Array(N * N).fill(0.7),
    lt: new Uint8Array(N * N * 3).fill(128), amb: 0.14, tintDirty: false, floorTex: FLOORS.CONCRETE, ceilTex: CEILS.CONCRETE, floorTile: 1.15, ceilTile: 0.9,
    fz: new Int8Array(N * N), cz: new Uint8Array(N * N).fill(CZ_DEF),
    vb: new Uint16Array(N * N), feat: new Uint8Array(N * N), ceilPlane: new Float64Array(N * N) };
  MW = N; MH = N; linkBoundaries(); decalGridInit(); explored = new Uint8Array(N * N); S.revealed = 0;
  LIGHTS = []; PROPS = []; PICKUPS = []; PROJ = []; PARTS = []; ENEMIES = [];
  exitX = N - 2.5; exitY = N - 2.5; P.x = 2.5; P.y = 2.5; P.z = floorAt(P.x, P.y);
  buildTint();
  return true;
}
