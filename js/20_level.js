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
    // #369: floorBias / ceilBias / ceilLead are the authored SURFACE VALUE ORDER - see js/40_render.js
    // :15. Walls already carry the highest value (the wall kernel multiplies its light by 1.05 and the
    // ground kernel does not), so what a level authors here is where the FLOOR and the CEILING sit under
    // them. Absent means 0 / the old 0.9 vault lead, which is every level that already reads right.
    // This level's ceiling is pushed down rather than re-materialised only in part: CEILS.SINEW got its
    // own albedo (js/10_assets.js:443) and ceilBias takes 0.12 off every ceiling row on top, which is
    // what puts the overhead band 23.4 below the wall it meets at `scene 2 1` (it was 5.0 below) and
    // 17-23 below at a second camera. Its first frame sits at the COMPOSITED band's upper anchor (75,
    // tools/ci/assert.js exposure, where main reads 74), which is the reason this is the level that
    // needed the bias and not only the texture: with -0.06 that frame measured 77.7 and went red.
    name: 'ABATOIR CORE', size: 36, rooms: 11, maxRoom: 11, wall: WT.FLESH, wall2: WT.TECH2,
    floor: 'FLESH', ceil: 'SINEW', amb: 0.3, lampCol: [190, 255, 150], fogCol: [21, 8, 11], ceilBias: -0.12,
    lamps: 16, crates: 9, barrels: 12, spawn: { grunt: 8, hound: 7, brute: 3 }, pick: { health: 5, ammo: 6, armor: 2 }
  },
  {
    // M6 (#16): the hand-authored two-storey level - `authored` means genLevel loads AUTHORED
    // instead of rolling rooms, so lamps/crates/barrels/pick/spawn are placed by the plan's marks.
    // #369: this level authors `lamps: 0`, so the light delivered to its walkable floors is near zero
    // while its 4 m vault clears the CEILHI threshold and picks up the vault lift - the brightest region
    // of the frame was its roof and its floors the darkest. The three numbers are authored to one rule:
    // a VAULT may not lead the floor it covers. The ceiling's base is amb + ceilBias + ceilLead and the
    // floor's is amb + floorBias, so the rule is ceilLead <= floorBias - ceilBias, and here that is
    // 0.12 <= 0.18 - (-0.04) = 0.22. The vault is still lifted off black; it just cannot out-light the
    // surface you stand on. At the seat the player spawns in, the order is wall 71.8, floor 47.2,
    // ceiling 37.7, where main read wall 65.8, floor 32.3, ceiling 68.6.
    // One caveat, so nobody "fixes" the finale: the rule authored here constrains the VAULT against the
    // FLOOR it covers, not the floor against the walls. At the finale seat (`view.js scene 3 0`) the lit
    // floor near the camera reads ABOVE the far wall faces (floor rows 87-90, wall faces 71-73, Rec.601
    // over screen rows - the ceiling band stays lowest in the frame), and it is left that way on purpose:
    // in a level whose idea is a walkable surface over your head, the last room reading floor-brightest is
    // the read we want. Walls lead floors at the spawn seat above. Say it here because the entry's rule
    // sentence does not cover it.
    // Height is already said by the riser seam and the minimap band cue (#164).
    name: 'THE STACK', size: 20, authored: true, wall: WT.STONE, wall2: WT.TECH,
    floor: 'STONE', ceil: 'ROCK', amb: 0.2, lampCol: [255, 196, 120], fogCol: [17, 13, 10],
    floorBias: 0.18, ceilBias: -0.04, ceilLead: 0.12,
    lamps: 0, crates: 0, barrels: 0, spawn: { grunt: 0, hound: 0, brute: 0 }, pick: {}
  }
];

let MAP = { w: 0, h: 0, cell: null, light: null, rooms: [] };
let MW = 0, MH = 0;
let LIGHTS = [], PROPS = [], PICKUPS = [], ENEMIES = [], PROJ = [], PARTS = [];
/* decals are stored per cell so the wall/floor loops can skip cells with none */
let DECALS = [], DECAL_GRID = [], DECAL_MASK = null;
let exitX = 0, exitY = 0, explored = null, bfsDist = null;   // read by an assertion in tools/smoke.js
/* #154: metres of clear ground the prop passes keep off the spawn seat. A `let` rather than a literal
   so a probe can A/B it the way it reassigns topUpEnabled and groundPixel (`SPAWN_CLEAR = 0` is the
   shipped behaviour, no clearance), and so smoke's spawn-clearance row can name what it moved.
   It is a RADIUS measured from the seat, which is the same number the row asserts. */
let SPAWN_CLEAR = 2;

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
const LHOVER = 0.78;                     // a lamp light's authored hover above its own floor (:845)
/* #213: a coverage TOP-UP source is scaled by the band it was placed to cover, because a 16-cell pit
   and a 300-cell floor otherwise receive identical sources - which is why standing inside a lit pit
   read DEV.lum 168 mean / 229 mid (a white box) while the big floor stayed under-lit. str is
   TOPUP_BASE * clamp(coveredCells / TOPUP_TARGET, TOPUP_MINF, 1), coveredCells being the count the
   placement score already computes. TARGET is the pit knob (cov/32 = 0.5 exactly for a 5x3 hole, so a
   pit gets a dim fill and a >=32-cell band keeps a full lamp); MINF only bites on bands under 16 cells,
   where a proportional source would be a dark cell with a lamp prop on it. The knobs live here and not
   behind an env var on purpose: a row gated on a knob a human must remember is the failure mode. */
const TOPUP_BASE = 1.05, TOPUP_TARGET = 32, TOPUP_MINF = 0.5;
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
  const cntF = new Int32Array(256);                   // their histogram: the band cue's datum (#164)
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = y * MW + x;
    if (!cell[i]) { const k = fz[i] + 128; cntF[k]++; if (!seenF[k]) { seenF[k] = 1; bands++; } }
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
  /* The band cue's datum: the floor most of the level's open columns sit on. Using the mode rather
     than the minimum means a flat level maps EVERY cell to index 0, which is the colour the minimap
     already used, so a flat minimap stays byte-identical and only a stepped level adds an ink. */
  let bQu = 0, bCnt = -1;
  for (let k = 0; k < 256; k++) if (cntF[k] > bCnt) { bCnt = cntF[k]; bQu = k - 128; }
  MAP.fzBase = bQu;
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
/* #259 closes the other half of that rule by ASKING the shot solver the same question instead of
   re-deriving it: bandExitT answers "where does this line leave the band it travels through", and an
   eye is a line. It had the ceiling of the band being flown AND, since #189, the ceiling of the column
   being entered; the loop below had only the floor-above-the-line test, so an eye at 0.55 on the datum
   that rises into a column whose own ceiling plane is 1.00 was walking through that column's slab
   unseen - the enemy saw a player the renderer refuses to draw and #189's table calls a [1.00, 1.00]
   opening. Sharing the solver is the point: two copies of a rule drift, and #189 opened with exactly
   that asymmetry (shots stopped, the eye did not). Flat it is inert, and structurally so: every column
   is floor 0 and ceiling 1.00, an eye lives at 0.55 on its own floor or on the band at 1.00, and a line
   between two points inside [floor, ceilAt] of every column it crosses never reaches a plane, so
   bandExitT returns kind 0 at maxT and the verdict is the loop's alone. An exit at t <= 1e-3 is IGNORED:
   that is an eye sitting above the ceiling of its own cell - a seat bug the spawn-altitude rows own -
   and blinding the AI for it would hide the bug rather than fix it. */
function losZ(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  if (d < 1e-4) return true;
  const ex = bandExitT(ax, ay, dx / d, dy / d, az, (bz - az) / d, d);
  if (ex.kind !== 0 && ex.t > 1e-3) return false;
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
   inside a cell), not the sample distance, so a riser mark lands on the plane instead of 14 cm inside the cell.
   #189 adds the other half of that first sentence: the CEILING of the column being ENTERED, not only the ceiling
   the ray started under. One test was half a rule, and it read the generator's tall rooms as free line of fire: a
   ray inside a TALL ROOM's air (ceiling 2.00, which #181's TALL ROOM feature authors) crossed into a one-unit
   corridor at 1.107 without re-keying and without a riser, so it flew inside that corridor's ROOF and hit a body
   standing on the band beyond it (measured on main: hit at 5.58 m, hz 1.867, from a seat whose eye sees a ceiling
   plane at 1.00, and cull's own row says a prop one band up is hidden). Flat, the two tests are the SAME plane -
   every column is floor 0 and ceiling 1 - and the sample test above runs first, so a flat level answers with the
   identical kind and the identical solved t: this term is inert on the backwards-compat gate. */
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
      else if (nfl >= fl) {                                 // #189: the entered column's OWN ceiling is below the
                                                             // ray and that column is not BELOW the band being flown,
                                                             // so the space at this altitude is not a hole in the
                                                             // floor the ray is over - it is that column's slab.
                                                             // A same-floor boundary draws no face (dz = 0), and the
                                                             // ceiling pass paints the plane, which is exactly what
                                                             // the eye refuses to see through: the shot stops on the
                                                             // boundary line, with no wall verdict and no mark, the
                                                             // same way the ceiling of its own band stops it.
        out.kind = 1;
        if (ix !== pxi) out.t = dx !== 0 ? ((dx > 0 ? ix : ix + 1) - ax) / dx : t;
        else out.t = dy !== 0 ? ((dy > 0 ? iy : iy + 1) - ay) / dy : t;
        if (!(out.t > 0)) out.t = t;
        return out;
      }
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

/* #152 put bands in the grid; #181 is about what that grid then contains. Raising `rooms>>1`
   scattered room interiors one unit up leaves a histogram that is 78% datum, off-datum cells too
   scattered to stand ON, and MAP.cz at one unit in every column - multi-storey in MAP.fz, a crawlway
   on screen. So this authors three named FEATURES per level instead of a scatter, each a shape the
   probes already know how to read - and in THIS order, which #282 had to fix: the tall-air feature
   used to run last and disqualified any room a floor feature had already stepped, so a deal could
   author no volume at all. Being first also means the ceiling feature and the floor features write
   different fields of the grid, which is why adding volume cannot move the occupancy gate.

     TALL ROOM    the largest rooms get CZ_TALL quanta of their own, which is the only way a column
                  can be looked UP in, and the mouths into them get it too: an open doorway draws no
                  face at all, so its lintel IS the ceiling you see through it, and a one-unit lintel
                  would hide a three-unit room from the corridor you entered it from.
     RAISED SIDE  every open cell on one side of the map sits a unit above the datum, so the altitude
                  difference is legible from the rooms that touch it. Room 0's cells stay down (the
                  spawn), and each stranded part of the side gets its own stair or ladder.
     SUNKEN ROOM  the room furthest from spawn drops a unit, with the bases of the walls around it
                  carried down with it - the cheapest "down there" a player can see. Its own cells take
                  their ceiling back to one unit, so a pit that lands in a room feature 1 made tall is
                  still a hole under a lip and not a shaft.

   Three rules this pass is written against, all of them already paid for:
   - NO draw from Math.random anywhere in here. The scatter pass downstream takes its places from
     that stream, and #90/#96 learned that a generator whose draw count moves makes every downstream
     measurement incomparable with the previous build. Every choice below is a property of the layout:
     a side ranked by area, a BFS distance, a scan order.
   - Every write is logged and reverted WHOLE when it costs a reachable cell its reach, so generation
     can never be the reason the occupancy gate fails (#152's rule, kept).
   - A SUNKEN cell's surrounding wall must have its base carried down with it, or that face spans from
     z0 = max(floor) = the datum to z1 = ceilAt(air) = the datum: span 0, a column the DDA stops at
     that draws nothing (the generator-fault family of #120). Raising needs no such carry - a raised
     cell's wall face already starts at the raised floor.
   Writes the grid only: genLevel calls linkBoundaries(), which derives the blocking bits (masked by
   VB_KEEP, so the authored ladder nibbles survive a relink) and the ceiling planes from it. */
const BAND_UP = 4;                                          // one unit above the datum, in quanta
const BAND_DOWN = -BAND_UP;                                 // one unit below it
const CZ_TALL = 12;                                         // three units of headroom; the gate is 2
const CZ_SPAWN_TALL = 16;                                   // 4 units: the rung the #15 M4 shape ladder
//   measured to fit the 16 ms raster gate at the arrival seat (+0.9 ms paired, N=8); CZ_TALL's 3 units
//   over the same cells cost +2.7 and do not, and 2 units cost +5.1 - see feature 1's note.
const LINK_STEPS = 40;                                      // link-or-give-back rounds per band, per pass
const STAIR_CELLS = 4;                                      // cells a 1-unit climb needs: 3 steps + 1
/* How many rooms get tall air on a map that does not need more: at least TWO, so a deal is never one
   filter term away from authoring no volume at all (the old rule was `rooms.length >= 8 ? 2 : 1` and
   rooms.length runs 4..7 on this generator, so every deal in the game had a single candidate). */
const TALL_WANT_MIN = 2;
const PIT_W = 5, PIT_H = 4, PIT_MIN = 6;                    // sunken cells: see feature 2's budget note
/* #284's rect pass. LOWER bound: the coverage top-up below serves a band only from MIN_BAND = 8
   reachable cells, and a hole it refuses to put a lamp on is a DARK pit floor - which is alt's "a pit
   reads lit, not blown" row, FAILed at 1 of 229 cells on the first version of this code, where a 3x2
   rect was legal. UPPER bound: feature 2's note prices a sunken block at ~+5 ms of a 16 ms frame, so a
   hole that exists only because a bigger one was impossible stays small - the deal keeps the DOWN and
   does not buy the frame cost of a full-size pit on top of it. */
const PIT_RECT_MIN = 8, PIT_RECT_MAX = 12;
const DIG_BUDGET = 12;                                // linkBand calls the #284 rect hunt may spend

function authorVolume(cell, N, rooms, fz, vb, feat, cz) {
  const open = (x, y) => x > 0 && y > 0 && x < N - 1 && y < N - 1 && cell[y * N + x] === 0;
  const roomAt = (x, y) => {
    for (const r of rooms) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    return null;
  };
  const spawnR = rooms[0], start = spawnR.cy * N + spawnR.cx;
  const inSpawn = (x, y) => x >= spawnR.x && x < spawnR.x + spawnR.w && y >= spawnR.y && y < spawnR.y + spawnR.h;
  const reach = () => bfsReach(cell, fz, N, start, vb, feat);
  const lost = (d0, d) => { let n = 0; for (let i = 0; i < N * N; i++) if (d0[i] >= 0 && d[i] < 0) n++; return n; };

  // The undo log is a stack with checkpoints: a feature is made of attempts, and an attempt that
  // does not help must rewind without taking the band write with it.
  const log = [];
  const mark = i => { log.push([i, fz[i], feat[i], vb[i], cz[i]]); return i; };
  const cut = () => log.length;
  const rewind = n => { while (log.length > n) { const u = log.pop(); fz[u[0]] = u[1]; feat[u[0]] = u[2]; vb[u[0]] = u[3]; cz[u[0]] = u[4]; } };
  const keeps = d0 => lost(d0, reach()) === 0;

  /* tools/smoke.js V14/V15 aim a shot down the FIRST straight 8-cell run whose first cell answers
     floorAt 0 - their own scan, their own pick - and both pokes are RELATIVE (three quanta up, one
     quantum down per cell), so that lane has to stay on the datum eight cells deep or the row
     measures a staircase it did not build. Reserve exactly those cells here rather than discovering
     it in the VERT lane: the reservation costs a band eight cells, not a level its volume. */
  const flat = new Uint8Array(N * N);
  for (let y = 2, got = false; y < N - 2 && !got; y++) for (let x = 2; x < N - 9 && !got; x++) {
    let n = 0;
    for (let k = 0; k < 8; k++) if (open(x + k, y)) n++;
    if (n !== 8 || fz[y * N + x] !== 0) continue;
    for (let k = 0; k < 8; k++) flat[y * N + x + k] = 1;
    got = true;
  }

  /* Crossings of a selected region with a cell that is still on the datum, in scan order: each one is
     a mouth a link can be authored at. `sel` is authoritative - a mouth whose region side was never
     raised is not a link into the band. */
  const mouthsOf = sel => {
    const out = [];
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      if (!sel[i] || cell[i] || fz[i] === 0) continue;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRX[d], ny = y + DIRY[d];
        if (!open(nx, ny)) continue;
        const j = ny * N + nx;
        if (sel[j] || fz[j] !== 0 || flat[j]) continue;
        out.push([i, d]);
      }
    }
    return out;
  };
  /* Author one link at mouth (mi, direction md), `band` quanta being the region's floor. The four
     cells going away from the region must be open and on the datum; the first three become the steps
     (each one quantum from the last, so the auto-step in js/30_entities.js:376 is the only lift in
     the level and the fourth cell is the flat landing the row solver needs) and the fourth stays
     put. A run shorter than that takes a ladder instead: a shaft tall enough that the climb tops out
     above the band, flagged on BOTH nibbles of the crossing - the pair linkBoundaries refuses to
     block and the pair linkedClimb reads, so a nibble on one side alone is a climb you can fall into
     but not out of. */
  const linkAt = (sel, band, mi, md, ladder) => {
    const mx = mi % N, my = (mi / N) | 0, line = [];
    for (let k = 1; k <= STAIR_CELLS; k++) {
      const x = mx + DIRX[md] * k, y = my + DIRY[md] * k;
      if (!open(x, y) || sel[y * N + x] || fz[y * N + x] !== 0 || flat[y * N + x]) break;
      line.push(y * N + x);
    }
    const up = band > 0 ? 1 : -1;
    if (line.length >= STAIR_CELLS) {
      for (let k = 0; k < STAIR_CELLS - 1; k++) { const i = mark(line[k]); fz[i] = band - up * (k + 1); feat[i] = FEAT_STAIR; }
      return true;
    }
    if (!line.length || !ladder) return false;
    const i = mark(line[0]);
    feat[i] = FEAT_LADDER; cz[i] = Math.max(cz[i], Math.abs(band) + 2);   // never take tall air back down
    vb[i] |= VB_LADDER << ((md ^ 2) << 2);
    vb[mi] |= VB_LADDER << (md << 2);
    return true;
  };
  /* Links, only where the band strands something. The anchor for choosing a mouth is the first
     stranded cell in scan order, so the stair goes where a player is already walking; the pass order
     is stair-then-ladder for the reason #152 states - alt's staircase row and smoke V19 must be a
     property of the layout, not of candidate order. A link that does not reduce the stranded count
     is rewound, which is what stops six stairs being authored where one does the job. */
  const linkBand = (sel, band, d0, ladder) => {
    for (let pass = 0; pass < (ladder ? 2 : 1); pass++) {
      for (let step = 0; step < LINK_STEPS; step++) {
        const d = reach();
        let want = -1;
        for (let i = 0; i < N * N; i++) if (d0[i] >= 0 && d[i] < 0) { want = i; break; }
        if (want < 0) return true;
        const wx = want % N, wy = (want / N) | 0;
        const mouths = mouthsOf(sel).sort((a, b) => {
          const da = Math.abs(a[0] % N - wx) + Math.abs(((a[0] / N) | 0) - wy);
          const db = Math.abs(b[0] % N - wx) + Math.abs(((b[0] / N) | 0) - wy);
          return da - db || a[0] - b[0] || a[1] - b[1];
        });
        let moved = false;
        for (const m of mouths) {
          const cp = cut();
          if (!linkAt(sel, band, m[0], m[1], ladder && pass === 1) || !keeps(d0)) { rewind(cp); continue; }
          if (lost(d0, reach()) === lost(d0, d)) { rewind(cp); continue; }
          moved = true; break;
        }
        if (!moved) {
          /* This pocket of the band takes no link - a mouth whose run is 3 cells, a component that
             touches the datum only through a diagonal. Hand the pocket back to the datum and keep
             the rest of the band: losing one corner's altitude is a smaller lie than losing the
             feature, and a cell that goes back to the datum cannot strand anything, since that is
             where it already is. */
          const d2 = reach();
          let gave = 0;
          for (let i = 0; i < N * N; i++) {
            if (!sel[i] || d0[i] < 0 || d2[i] >= 0) continue;
            sel[i] = 0; mark(i); fz[i] = 0; feat[i] = FEAT_NONE; gave++;
          }
          if (!gave) return false;
        }
      }
    }
    return lost(d0, reach()) === 0;
  };

  const d0 = reach();
  const authored = [];

  /* ---- feature 1: rooms you can stand up in ------------------------------
     FIRST, before any floor has been stepped - and that ordering is the #282 fix. TALL ROOM used to run
     LAST and required the WHOLE room to sit on one floor; the raised band and the pit had already
     stepped floors through these rooms by then, so the binding term of the candidate filter was
     uniformity, not size, and a deal could find no candidate at all. Measured on 17e83ba across SEED
     1..12 x 3 levels (tools/view.js volume, BOOT=1): 33 deals authored volume and 3 authored NONE -
     SEED 2 levels 0 and 2, SEED 7 level 2 - with big rooms in the maps that authored nothing (SEED 7 L0
     dims 9x5,7x6,6x6,5x5), and `keeps(d0)` true on every deal that chose a room, so the filter, not the
     occupancy gate, was what came back empty. `SEED=7 node tools/view.js alt` prints
     "0 open column(s) ... tallest 1.00" and exits 1 on exactly that deal.
     Run first, every room is uniform by construction, so the filter cannot come back empty, and the tall
     air lands on WHOLE rooms instead of on whatever uniform sliver a staircase left behind. The
     uniformity test stays as a guard (tall air across two bands would make the mouth rule below author a
     half-open doorway), but it no longer chooses the rooms.

     MORE THAN ONE CANDIDATE, because one shot at one room is one way to author nothing: the two largest
     rooms, three on a map of eight or more (TALL_WANT_MIN), where the rule was `rooms.length >= 8 ? 2 : 1`
     and rooms.length runs 4..7 - so every deal in the game had exactly one candidate.

     AND NOT ROOM 0 - measured, not assumed (#282's second half is therefore NOT closed here). The
     arrival row aims one quantum under the target's own ceiling plane, so the ray must climb over the
     ceiling of whatever room the seat stands in: with a flat spawn room it crosses that 1-unit plane
     about a fifth of the way to the target and dies there, which is why the recorded baseline is
     0 of 86/45/100 columns seen from the seat (nearest cast stopping on a CEILING 7..12 m away).
     Giving the spawn room tall air does move that row to green on every deal - and costs the frame more
     than the raster budget has left. Measured with tools/smoke.js' own batches (SEED 12345, L0, spawn
     pose, 601x338, load average ~2.4), median ms/frame against 12.30 for this commit's parent:
       spawn room tall, 2 cells of tall mouth            20.5 ms   (+8.2)  arrival 0 blind deals
       spawn room tall, mouths only, CZ_TALL 8 (2 units)  23.4 ms  (+11.1) arrival 0 blind deals
       tall air hugging the spawn room, 6 cells of run    21.3 ms   (+9.0)  arrival 2 blind deals
       one doorway's run of 6 tall corridor cells         18.3 ms   (+6.0)  arrival 25 blind deals
       EVERY open cell at two units (no boundary at all)  17.4 ms   (+5.1)  the floor this costs
     so the +5 ms is the ceiling distance itself and the rest is the tall/flat boundary feeding the
     deferred pixel body (the same mechanism as the sunken block's +42 ms note above); 16 ms is the
     gate. The shapes that buy arrival were tried and are not in this file. What IS here - the ordering,
     the pillar fix, two candidates instead of one - authors volume in every deal for no frame cost at
     all (12.35 ms), and the row that asks for arrival stays a reported debt until the ground pass can
     afford a taller ceiling: see tools/view.js volume's arrival row and alt's krow. */
  const tallWant = rooms.length >= 8 ? 3 : TALL_WANT_MIN;
  /* The room's ONE floor, or null if it does not have one. Two ways a room is not one room: a floor
     feature stepped part of it (a straddling room is two bands at once, and the mouth rule below would
     author a half-open doorway), and a pillar inside it - which is NOT a reason to refuse the room its
     ceiling, because the wall pass paints the pillar under the tall air like any other column. The old
     filter answered `!open(x,y)` with "not a candidate", and pillars only ever appear in rooms of 8x8
     or more, so that term is why the spawn room still had a one-unit ceiling on ~30% of deals: the
     arrival row stayed at 0 while the volume row went green. */
  const roomFloor = r => {
    let f = null;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (cell[y * N + x]) continue;                        // a pillar in a room is still in that room
      const q = fz[y * N + x];
      if (f === null) f = q; else if (q !== f) return null;
    }
    return f;
  };
  const tallRooms = [];
  for (const r of rooms.filter(r => r !== spawnR && r.w >= 5 && r.h >= 5 && roomFloor(r) !== null)
                       .sort((a, b) => b.w * b.h - a.w * a.h || a.cx - b.cx || a.cy - b.cy).slice(0, tallWant)) {
    tallRooms.push([r, roomFloor(r)]);
  }
  for (const [r, f] of tallRooms) {
    const cp = cut();
    const set = i => { mark(i); cz[i] = CZ_TALL; };
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!cell[y * N + x]) set(y * N + x);
    for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (!open(x, y) || fz[y * N + x] !== f || roomAt(x, y) !== null) continue;   // corridor cells only
      const i = y * N + x;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRX[d], ny = y + DIRY[d];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        if (!cell[j] && fz[j] === f && roomAt(nx, ny) === r) { if (cz[i] !== CZ_TALL) set(i); break; }
      }
    }
    if (keeps(d0)) authored.push('tallRoom'); else rewind(cp);
  }

  /* ---- the SPAWN ROOM's own ceiling: volume the seat can look up into on arrival --------
     Feature 1 deliberately skips room 0, and that exclusion is why `volume`'s arrival row is blind on
     every deal: from a seat under a one-unit ceiling the ray to any tall column crosses that plane a
     fifth of the way out and dies on it (control's own nearest blocked cast stops on a CEILING 8 m
     away). Giving the spawn room its own air is therefore the smallest shape that answers the row -
     and the shape ladder priced its two axes at the arrival seat, paired A/B/A against these bytes:
     the number of tall CELLS barely moves the frame (12 cells +3.1 ms, the whole 54-cell room +2.7),
     the ceiling's HEIGHT moves it the other way (2 units +5.1, 3 units +2.7, 4 units +0.9, 6 units
     -0.7, with the march counter falling in the same order 609 -> 460 -> 270 -> 46). So this authors
     CZ_SPAWN_TALL over the room's OWN cells: tall mouths measured worse (+8.2 for two cells of tall
     mouth in feature 1's table) for no arrival gain, and a smaller disc than the room buys nothing at
     CZ_TALL while costing more boundary. roomFloor's #283 rule is the same test here: a pillar is not
     a second band, but a spawn room a floor feature stepped keeps its one-unit ceiling rather than
     authoring a half-open room. `bfsReach` reads fz/vb/feat and never cz, so this cannot cost the
     occupancy gate a cell, and it writes no floor, so the flat 8-cell lane V14/V15 aim down is
     untouched. */
  {
    const cp = cut();
    const f = roomFloor(spawnR);
    if (f !== null) {
      for (let y = spawnR.y; y < spawnR.y + spawnR.h; y++) for (let x = spawnR.x; x < spawnR.x + spawnR.w; x++) {
        const i = y * N + x;
        if (!cell[i] && cz[i] < CZ_SPAWN_TALL) { mark(i); cz[i] = CZ_SPAWN_TALL; }
      }
      if (keeps(d0)) authored.push('spawnAtrium'); else rewind(cp);
    }
  }

  /* ---- feature 2: a QUADRANT or SIDE of the level stands a unit up --------
     Eight candidate regions - the four quadrants first, then the four half-planes. A quadrant goes
     first because it leaves three quarters flat for the pit, the tall rooms, the exit and the flat
     lane the VERT lane aims its gun down, and its seam is no longer than a half-plane's: two
     half-lines against one full one. Ranked within each group by the cells it owns, so the plateau is
     the bigger piece of the floorplan and the altitude difference is legible from the rooms that touch
     it. Room 0's cells never join the region: the spawn has to stay on the datum. */
  const N2 = N >> 1;
  const rects = [];
  for (const q of [[0, 0], [1, 0], [0, 1], [1, 1]]) rects.push({
    tag: 'q' + (q[0] + q[1] * 2), quad: 1, x0: q[0] ? N2 : 1, x1: q[0] ? N - 2 : N2 - 1,
    y0: q[1] ? N2 : 1, y1: q[1] ? N - 2 : N2 - 1 });
  for (const h of [[1, 0], [0, 0], [0, 1], [1, 1]]) rects.push({
    tag: 'h' + (h[0] + h[1] * 2), quad: 0, x0: h[0] ? N2 : 1, x1: N - 2, y0: h[1] ? N2 : 1, y1: N - 2 });
  const ranked = rects.map(r => {
    let n = 0;
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      const i = y * N + x;
      if (!cell[i] && fz[i] === 0 && !flat[i] && !inSpawn(x, y)) n++;
    }
    return { r, n };
  }).sort((a, b) => b.r.quad - a.r.quad || b.n - a.n || a.r.tag.localeCompare(b.r.tag));
  for (const cand of ranked) {
    if (cand.n < 8) continue;                       // fewer than 8 cells is not a band, it is a corner
    const cp = cut(), sel = new Uint8Array(N * N);
    for (let y = cand.r.y0; y <= cand.r.y1; y++) for (let x = cand.r.x0; x <= cand.r.x1; x++) {
      const i = y * N + x;
      if (cell[i] || fz[i] !== 0 || flat[i] || inSpawn(x, y)) continue;
      sel[i] = 1; mark(i); fz[i] = BAND_UP;
    }
    // No wall write here on purpose: a wall between the band and the datum must stay at the datum,
    // or the face it shows the flat side starts above that side's ceiling plane and draws nothing.
    // Bases are carried down once, at the end, where both directions of the fault are one rule.
    const ok = linkBand(sel, BAND_UP, d0, true);
    if (ok) { authored.push('raisedSide:' + cand.r.tag); break; }
    rewind(cp);
  }

  /* ---- feature 3: a sunken block in the room furthest from spawn ---------
     The RASTER BUDGET caps this shape, and that is a measured fact rather than a taste: a cell below
     the eye disagrees with the row's plane in BOTH halves (its floor is under the eye, and its ceiling
     is the lip's floor plane under the row's ceiling), so every pixel of it goes through the deferred
     copy in castGround. A whole room sunk that way measured +42 ms of a 16 ms frame at 26,106 deferred
     pixels of 194,123; the same level with the sunken block removed measured +5. So the pit is a
     BLOCK with a lip around it, not a whole room: you stand in the room and look DOWN into a hole,
     which is the cue the row is about, and the frame stays inside the budget it is gated on. */
  /* The hole's own legality, for both passes below: a `bw x bh` RECT at (bx,by) whose RING (the rect
     expanded by one cell) is open too. Every cell of hole and ring must be on the datum, out of the
     reserved flat lane and out of the spawn room, the ring must belong to the host room (so the lip is
     the floor of a room and not a corridor's), and at least one hole cell must already be walkable in
     d0 - a hole in a pocket the spawn can never reach is decoration, and it would let linkBand report
     success with nothing linked, because nothing was stranded. That is the whole geometric contract a
     pit has: the room-level test the first pass uses asks for it of an ENTIRE room, which is more than
     the feature needs and is why a deal can reach this line and author nothing. */
  const holeOK = (room, bx, by, bw, bh) => {
    let seen = false;
    for (let y = by - 1; y <= by + bh; y++) for (let x = bx - 1; x <= bx + bw; x++) {
      if (!open(x, y)) return false;
      const i = y * N + x;
      if (fz[i] !== 0 || flat[i] || inSpawn(x, y)) return false;
      if ((x === bx - 1 || x === bx + bw || y === by - 1 || y === by + bh) && roomAt(x, y) !== room) return false;
      if (!seen && x >= bx && x < bx + bw && y >= by && y < by + bh && d0[i] >= 0) seen = true;
    }
    return seen;
  };
  /* A hole needs a way out on foot: linkBand only ever links a cell that was reachable in d0 and is not
     now, and its stair wants four datum cells in a straight line from the mouth. Asking that of the
     rect before writing it costs a few hundred compares and keeps linkBand - which re-runs bfsReach
     per round - off the inside of a position scan. */
  const stairNear = (bx, by, bw, bh) => {
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) for (let d = 0; d < 4; d++) {
      let n = 0;
      for (let k = 1; k <= STAIR_CELLS; k++) {
        const px = x + DIRX[d] * k, py = y + DIRY[d] * k;
        if (!open(px, py)) break;
        const j = py * N + px;
        if (fz[j] !== 0 || flat[j] || (px >= bx && px < bx + bw && py >= by && py < by + bh)) break;
        n++;
      }
      if (n >= STAIR_CELLS) return true;
    }
    return false;
  };
  /* Cut it, link it, and hand the whole rectangle back if the link does not hold. */
  const dig = (bx, by, bw, bh, tag) => {
    const cp = cut(), sel = new Uint8Array(N * N);
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
      const i = y * N + x;
      // cz goes BACK to one unit on the hole's own cells: a pit's ceiling is the lip's floor plane, and
      // under the 3-unit air feature 1 may have authored in this room the hole would stop reading as a
      // hole under a lip and become a shaft. The lip keeps its tall air, so the cue stays "stand in a
      // room, look DOWN" - and the pit still gets any room the distance ranking offered it, which is
      // why this is a write here rather than a term in the candidate filter above.
      sel[i] = 1; mark(i); fz[i] = BAND_DOWN; feat[i] = FEAT_PIT; cz[i] = CZ_DEF;
    }
    // Stairs only, no ladder fallback: dropping into a pit is free (a drop is never a wall), so the
    // only way out is the climb, and a flagged crossing is a link the occupancy gate can see and the
    // player may not be able to use. A pit that will not take a stair is not authored at all.
    if (linkBand(sel, BAND_DOWN, d0, false)) { authored.push(tag); return true; }
    rewind(cp);
    return false;
  };
  const sunkRooms = rooms.slice(1).filter(r => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (!open(x, y) || fz[y * N + x] !== 0 || flat[y * N + x]) return false;
    }
    return r.w >= 4 && r.h >= 4;
  }).sort((a, b) => {
    const da = d0[a.cy * N + a.cx], db = d0[b.cy * N + b.cx];
    return (db < 0 ? -1 : db) - (da < 0 ? -1 : da) || b.w * b.h - a.w * a.h || a.cx - b.cx || a.cy - b.cy;
  });
  let pitted = false;
  for (const room of sunkRooms.slice(0, 4)) {
    const bw = Math.min(room.w - 2, PIT_W), bh = Math.min(room.h - 2, PIT_H);
    if (bw * bh < PIT_MIN) continue;                 // no room for a hole with a lip around it
    const bx = room.x + ((room.w - bw) >> 1), by = room.y + ((room.h - bh) >> 1);
    if (dig(bx, by, bw, bh, 'sunkenRoom')) { pitted = true; break; }
  }

  /* ---- feature 3b: when no ROOM qualified, look for a HOLE -------------------------------
     #284: on some deals every candidate the pass above will accept is disqualified before the geometry
     is looked at, and the level ships with its only off-datum floor ABOVE the seat - nothing to climb
     down into, while every band/link/reach row stays green. The pass above asks a ROOM to be uniform,
     and three ordinary things break that term, all three measured on an unmodified tree (the deals are
     the ones tools/view.js volume's DOWN row fails; room cells counted over AIR cells only):
       a PILLAR in a room of 8x8 or more      SEED 5 L1's 9x10 room, entirely on the datum, refused for
                                             2 pillar cells - the term #283 removed from the tall-air
                                             filter for exactly this reason, still live here;
       the RAISED BAND stepping part of it    SEED 3 L0 room 1: 26 of its 81 cells at floor 1.00;
       the V15 FLAT LANE crossing it          SEED 3 L0 room 2 (3 of its cells) and SEED 4 L0 room 3 (4).
     None of the three is a reason a hole cannot be cut THERE: a pit needs a rect of datum cells with a
     ring of datum cells around it, not a whole room of them. So when the room pass authored nothing,
     scan positions: the same rooms, ranked the same way by how far the centre sits from spawn (with
     centres bfsReach cannot reach ranked LAST rather than first, because a hole you cannot walk to is
     not a DOWN), then the sizes PIT_RECT_MIN..PIT_RECT_MAX cells with no side thinner than 2 - a 1-cell
     strip is a slot, not a block with a lip - cheapest first, and within a size the positions by
     distance from the room centre, so the centred placement the room pass already used stays the first
     thing tried and a deal that had a pit keeps the pit it had.

     WHY THIS CANNOT MOVE A DEAL THAT ALREADY HAD A DOWN: the loop is behind `if (!pitted)`, it draws NO
     randomness, and on a deal where the room pass succeeded the grid is not touched again. The CI deal
     (SEED 12345) pits on all three levels in the first pass, so every recorded reference - flatparity's
     spawn-frame md5s included - is computed on the same grid it always was. */
  if (!pitted) {
    const sizes = [];
    for (let bw = PIT_W; bw >= 2; bw--) for (let bh = PIT_H; bh >= 2; bh--) {
      const a = bw * bh;
      if (a >= PIT_RECT_MIN && a <= PIT_RECT_MAX) sizes.push([bw, bh, a]);
    }
    // cheapest legal hole first (a and bw tie-break deterministically), so the first hole the scan
    // finds is also the smallest one that could have served the level
    sizes.sort((x, y) => x[2] - y[2] || y[0] - x[0] || x[1] - y[1]);
    const hosts = rooms.slice(1).map(r => ({ r, d: d0[r.cy * N + r.cx] })).sort((a, b) =>
      (a.d < 0 ? 1e6 : a.d) - (b.d < 0 ? 1e6 : b.d) || b.r.w * b.r.h - a.r.w * a.r.h || a.r.cx - b.r.cx || a.r.cy - b.r.cy);
    let digs = 0;
    for (const h of hosts) {
      const room = h.r;
      if (room.w < 4 || room.h < 4) continue;         // the room pass's own floor, kept
      for (const [bw, bh] of sizes) {
        if (bw > room.w - 2 || bh > room.h - 2 || digs > DIG_BUDGET) continue;
        const xs = [], ys = [];
        for (let x = room.x + 1; x + bw <= room.x + room.w - 1; x++) xs.push(x);
        for (let y = room.y + 1; y + bh <= room.y + room.h - 1; y++) ys.push(y);
        if (!xs.length || !ys.length) continue;
        const mx = room.x + ((room.w - bw) >> 1), my = room.y + ((room.h - bh) >> 1);
        const spots = [];
        for (const bx of xs) for (const by of ys) spots.push([bx, by, Math.abs(bx - mx) + Math.abs(by - my)]);
        spots.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
        for (const s of spots) {
          if (!stairNear(s[0], s[1], bw, bh) || !holeOK(room, s[0], s[1], bw, bh)) continue;
          /* A scan is a couple of hundred compares; a DIG is a linkBand, which re-runs bfsReach per
             round. The cap therefore binds on digs, and a cap on the scans instead is what left the
             first legal rect of the deal that opened #284 unexamined: the four sizes larger than it
             cost 48 positions and the budget died on cells that were never candidates. */
          if (++digs > DIG_BUDGET) break;
          if (dig(s[0], s[1], bw, bh, 'sunkenRect')) { pitted = true; break; }
        }
      }
      if (pitted || digs > DIG_BUDGET) break;
    }
  }

  /* Carry the base of every solid column down to the lowest band it bounds. A face spans
     z0 = max(floorA, floorB) to z1 = ceilAt(the AIR side), so a wall whose own floor is at or above
     the ceiling plane of the band it encloses is a column the DDA stops at that draws nothing - a
     generator fault, not a rendering one, and the sunken room's walls hit it exactly: floor 0 against
     a pit whose ceiling is the datum plane, span 0. Down only, never up - the wall between a raised
     band and the datum belongs to the datum, and raising it would move that fault to the flat side,
     which is where the spawn, the exit and the probes live. */
  for (let i = 0; i < N * N; i++) {
    if (!cell[i]) continue;
    const x = i % N, y = (i / N) | 0;
    let lo = fz[i];
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRX[d], ny = y + DIRY[d];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      if (cell[j]) continue;
      const cap = fz[j] + cz[j] - 1;                      // one quantum under that band's ceiling
      if (cap < lo) lo = cap;
    }
    if (lo !== fz[i]) { mark(i); fz[i] = lo; }
  }
  return authored;
}


/* Adds one light's contribution to the lightmap; a negative amount takes it back out.
   Static lights are splatted once at generation, transient ones re-splat their delta
   each frame as they fade, which keeps add/remove exactly reversible. */
function splatLight(L, amt) {
  const lm = MAP.light, lr = MAP.lR, lg = MAP.lG, lb = MAP.lB, lw = MAP.lw, N = MAP.w, R = Math.ceil(L.r);
  const c = L.col || [255, 205, 150];
  /* A light that carries no z emits from the FLOOR of the cell it emits in: a muzzle flash,
     an explosion, an orb pop happens at its owner's feet, so the band of the owner's feet is
     the band of the light. The transient call sites (js/30_entities.js:286, :631) carry no z
     on purpose and rely on this documented default (#203).
     The band a light belongs to is its source's FLOOR, not its emitter height: an authored lamp
     hangs LHOVER above the floor it stands on, so the floor is recovered by taking the hover back
     off, and a z-less source is already standing on its floor. */
  const lf = L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER;
  for (let y = Math.max(0, (L.y - R) | 0); y < Math.min(N, L.y + R); y++)
    for (let x = Math.max(0, (L.x - R) | 0); x < Math.min(N, L.x + R); x++) {
      const d = Math.hypot(x + 0.5 - L.x, y + 0.5 - L.y);
      if (d >= L.r) continue;
      /* Band term: the 2-D disc lights the columns whose FLOOR is within one quantum of the
         source's own floor, at full strength, and adds nothing at all past that. #203 put
         |L.z - floorAt(col)| <= LHOVER + ZQ here, which closed the DOWNWARD half of the bleed - a
         datum lamp stopped brightening a pit floor a unit below it - but in floor terms that reach
         is fd in [-1.81, +0.25], so the UPWARD half survived: a column 7 quanta above a lamp was
         lit at full weight while the column one quantum below it was dark. Measured on 2c5a94f
         over 12 rolls per level, 74/92/98 cells per roll take direct light from a lamp whose floor
         is >= 1.00 m BELOW them (mean 0.21-0.27 of a delivered 0.55-0.68) against 0.0-1.0 cells
         per roll reaching down. The reach is now symmetric, so it is |fd| <= ZQ: the source's own
         band and one quantum either way, nothing beyond. On a flat level fd = 0, the test is the
         literal 1, and every flat frame reproduces bit for bit. This same function runs the delta
         un-splat, so the kernel is identical for add and remove and a fading transient leaves no
         permanent light (smoke's "blast light fully fades out", unchanged). */
      const wv = Math.abs(lf - floorAt(x + 0.5, y + 0.5)) <= ZQ + 1e-9 ? 1 : 0;
      const w = Math.pow(1 - d / L.r, 1.6) * wv, i = y * N + x;
      lm[i] += amt * w;
      const k = Math.abs(amt * w);
      lr[i] += c[0] / 255 * k; lg[i] += c[1] / 255 * k; lb[i] += c[2] / 255 * k; lw[i] += k;
    }
  MAP.tintDirty = true;
}
/* one smoothing pass so per-cell light reads as a pool, not a chessboard.
   #206: the pass gains the band term the splat kernel has had since #203/#208 — a neighbour
   carries light only if its floor is within one quantum of the cell's own, the same predicate
   `Math.abs(lf - floorAt(col)) <= ZQ` restated on the grid. Without it this kernel was the leak:
   the splat delivers NOTHING across a band (measured on df919c3, 12 rolls per level: 0/0/0 cells
   at delivered light >= 0.05 are direct-lit with no in-band source in the disc), yet 37/49/75
   cells in the same roll set held delivered light >= 0.05 no lamp on their band can reach, and
   every one of them was light this kernel carried across a riser. Gated, the same census counts
   19/10/16 (staircase hops only), and the cells whose only light was that tail are now honestly
   dark — `alt`'s dark-open census moved 253/1087/874 -> 344/1194/1055 with the reclassification.
   The lightmap stays ONE VALUE
   PER COLUMN — the kernel is band-aware, the array is not — so a fading transient still re-splats
   its delta into the array the blur produced and the un-splat stays exact (smoke's "blast light
   fully fades out" is untouched: blurLight runs at generation only, never on a transient frame).
   Light crossing a boundary the feet can step (one quantum) still flows — a staircase lights its
   own flight one cell per hop — and a slab blocks light exactly as far as it blocks walking.
   The gated neighbour enters the average as a ZERO with its weight kept in n — the same treatment
   the kernel already gives a solid column, which sits in n at light ~0. Skipping it from sum AND
   denominator instead (renormalise over same-band samples) was tried and measured: it leaves the
   L2 face lip within noise of this form (lU 30.84 vs 30.67, lD 12.44 vs 11.99 — the lip's 4.5-point
   drop against main's 43% is the deleted tail either way, not a denominator artifact) and buys
   brighter pool edges beside slabs, which is a second behaviour change nobody asked for. Deleting
   the tail is not free at the lip either: `bands`' #203 legibility row read 43% on main and lands
   at 39% here (lU 33.10 -> 30.67 — the floor in front of the step was wearing the far band's tail;
   lD 12.03 -> 11.99, the riser untouched), so that row's debt floor moved one notch under the new
   worst with the numbers on its face, exactly as #203 moved it under the old one.
   On a flat level every quantum is equal, every neighbour contributes at its original weight in
   its original order, and the pass is BIT-IDENTICAL to the old one: that collapse is what keeps
   flatparity's two FLAT senses (LOCK, PARITY) where they are, and they hash these frames. */
function blurLight() {
  const N = MAP.w, s = MAP.light, fz = MAP.fz, o = new Float32Array(s.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, b = fz[i];
    let sum = s[i] * 3, n = 3;
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      if (!j && !k) continue;
      const yy = y + j, xx = x + k;
      if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
      const jj = yy * N + xx, q = j === 0 || k === 0 ? 2 : 1;
      sum += Math.abs(fz[jj] - b) > 1 ? 0 : s[jj] * q;   // one quantum = the splat kernel's own band reach
      n += q;
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
   A face against a SOLID column spans from the higher of the two floors to the ceiling plane of the AIR
   side; a face between two OPEN cells is the side of a floor slab and spans [min floor, max floor]. Those
   are the two windows below, each inset by the mark's own radius so a disc cannot hang over a band it was
   not punched in. The hit point lies on the boundary, so the face is the pair of cells sharing the integer
   line it hit; isSolid reads an off-map cell as solid, so the map edge resolves to the cell that exists. */
function addWallMark(x, y, z, side, kind) {
  if (side === undefined) return;
  const r = 0.11 + Math.random() * 0.04;
  const b = Math.round(side ? y : x);
  const c1 = side ? [x | 0, b - 1] : [b - 1, y | 0];
  const c2 = side ? [x | 0, b] : [b, y | 0];
  const air = isSolid(c1[0] + 0.5, c1[1] + 0.5) ? c2 : c1;
  const wall = air === c1 ? c2 : c1;
  const fAir = floorAt(air[0] + 0.5, air[1] + 0.5), fWall = floorAt(wall[0] + 0.5, wall[1] + 0.5);
  /* The air->air case had the WRONG rule until #15's last item, and the reason it was invisible is
     arithmetic: ceilAt of the LOWER cell is floor + max(1 unit, the slabs above) = the UPPER cell's floor,
     so "min of the two ceilings" equals max floor exactly, the window [max floor, min ceiling] has zero
     height on every riser, and clamp pinned every mark to maxFloor + r - above the strip the wall pass
     paints (js/40_render.js:864 draws an air->air boundary as the slab side [min, max], #100 and #192,
     gated by `cull`'s step rows). A shot reaches this line: hitscan reports a riser as a wall hit
     (js/30_entities.js:149, `wall: riser || ...`, `side: riser ? bx.side : wall.side`), so a bullet hole
     in a step has been drawn above the step, on the band's own wall, not on the riser. A strip thinner
     than the disc is CENTRED rather than pinned to its bottom edge - a one-quantum tread is 0.25 m and
     the disc is 0.22-0.30 m, so no centre-free position exists inside it. */
  const bothAir = !isSolid(c1[0] + 0.5, c1[1] + 0.5) && !isSolid(c2[0] + 0.5, c2[1] + 0.5);
  const z0 = bothAir ? Math.min(fAir, fWall) : Math.max(fAir, fWall);
  const z1 = bothAir ? Math.max(fAir, fWall) : ceilAt(air[0] + 0.5, air[1] + 0.5);
  const zLo = z0 + r, zHi = z1 - r;
  addDecal({ x, y, z: zHi >= zLo ? clamp(z, zLo, zHi) : (z0 + z1) * 0.5, r, side: side + 1,
    tex: kind === 'scorch' ? DECAL.scorch : DECAL.bullet, a: 0.9 });
}
function addGroundSplat(x, y, r, kind) {
  const tex = kind === 'goo' ? DECAL.goo : kind === 'scorch' ? DECAL.scorch : kind === 'dust' ? DECAL.dust : DECAL.blood;
  if (kind === 'dust') { addDecal({ x: x + rnd(0.1, -0.1), y: y + rnd(0.1, -0.1), z: 0.01, r, tex, a: 0.3, life: 12 }); return; }
  addDecal({ x: x + rnd(0.14, -0.14), y: y + rnd(0.14, -0.14), z: 0.01, r, tex, a: kind === 'scorch' ? 0.85 : 0.8, life: 55 });
}

/* Whether the coverage top-up may author lamps at all (#204). The shipped answer is yes, always; the
   ONE reason it exists is tools/view.js's LAMPS=off knob, which runs the generator with the top-up
   suppressed so the flat-parity triple can mean what it claims (see flatparity's header). It is a
   function rather than a constant so the probe can reassign the global - the same handle style the
   probes already use on groundPixel and castGround - and it is read ONCE per level, at author time,
   so the suppression removes lamps from the record rather than deleting them after the world was
   built around them. Nothing else in the generator consults it. */
function topUpEnabled() { return true; }

/* ---- M6: the hand-authored level (#16) -------------------------------------------------
   Everything in this file above is a generator: it rolls rooms and hopes altitude falls out. This
   is the opposite - a plan written cell by cell whose single job is to read, from the seat the
   player spawns in, as a building with two walkable storeys. Being multi-storey in MAP.fz was never
   the same thing as being perceivable: a staircase is ~2.6% of a generated floorplan and no column
   is authored hollow, so the levels still read as crawlways. Authoring a level by hand also removes
   the excuse: a regression in how a level reads can no longer be blamed on the seed stream.

   Three layers of equal-length rows, because a cell carries three independent facts:
     geo  '#' wall  '.' open  'P' spawn seat  'E' exit pad  'L' lamp  'B' barrel  'C' crate
          'A' ammo  'H' health  'g' grunt  'h' hound  'b' brute
     alt  one digit, q = MAP.fz + 4, so '4' is the datum, '8' is one unit up and '0' would be a -4
          pit floor. No negatives, nothing to reinterpret.
     feat '.' none  'S' stair tread (FEAT_STAIR: the cell the minimap draws and findability counts)
          'P' pit cell (FEAT_PIT)  'T' tall air - this cell's OWN ceiling is CZ_AUTH_TALL quanta
          rather than CZ_DEF, which is what makes a storey read as a room and not a crawlway.
   A lamp is placed where the SEAT cannot see it, not merely where the room needs light: the seat is
   (1,2) at P.ang 0.6, and the camera plane 0.72 puts the frame edge atan(0.72) = 0.624 rad to either
   side of the heading, so the lens covers bearings -0.02..1.22 from that cell. A lamp with line of
   sight inside that wedge composites as an emissive billboard 4 m away: bloom took the centre-half of
   the first frame to 181 and the composited spawn median to 120, against a band whose upper anchor is
   the dimmest lamp-in-the-lens, 79.4 (#304). In geo the datum lamp therefore sits at (2,9), not at
   (4,5) on the axis: same band, so the same band-scaled strength and the same 6-yaw median (those rolls
   are unchanged), but bearing 1.43 from the seat, 0.21 rad past the frame edge - out of frame. The two
   lamps whose bearing is nearly on the axis, (12,9) on the stair tread and (15,12) on the upper band,
   are already hidden by the wall cell (9,7) the axis ray stops at, and the pit lamp at (2,16) is
   0.9 rad off axis.
   Altitude is deliberately NOT derived from neighbours here. If the plan and a derivation could
   disagree, the probe would end up testing the derivation instead of the level. The plan is one
   storey up plus the datum: two bands joined by a four-tread stair, no pit, because a pit needs a
   flagged climb to be reachable by bfsReach and this increment is about volume you can SEE. */
const CZ_AUTH_TALL = 16;                              // four units, the constant #300 gives the spawn room
const AUTHORED = {
  size: 20,
  rects: [{ x: 1, y: 1, w: 8, h: 18, cx: 5, cy: 9 }, { x: 13, y: 1, w: 6, h: 18, cx: 16, cy: 9 }],
  geo: [
    "####" + "####" + "####" + "####" + "####",   //  0
    "#..." + "...." + ".###" + "#..." + "...#",   //  1
    "#P.." + "...." + ".###" + "#..." + "...#",   //  2
    "#..." + "...." + ".###" + "#.B." + "...#",   //  3
    "#..." + "...." + ".###" + "#..." + "...#",   //  4
    "#..." + "...." + ".###" + "#..." + "...#",   //  5
    "#.A." + "...." + ".###" + "#..." + "...#",   //  6
    "#..." + "...." + ".###" + "#..." + "g..#",   //  7
    "#..." + "...." + ".###" + "#..." + "...#",   //  8
    "#.L." + "...." + "...." + ".L.." + "...#",   //  9   // #318: this lamp x12 -> x13, out of the doorway (see PROP COLLISION note in tools/view.js)
    "#..." + "...." + ".###" + "#..." + "...#",   // 10
    "#..." + "...." + ".###" + "#..." + "C..#",   // 11
    "#.L." + "...." + ".###" + "#..L" + "...#",   // 12
    "#..." + "...." + ".###" + "#..." + "...#",   // 13
    "#..." + "L.B." + ".###" + "#..." + "...#",   // 14
    "#..." + "...." + ".###" + "#..." + "...#",   // 15
    "#.L." + "...g" + ".###" + "#..." + "...#",   // 16
    "#..." + "...." + ".###" + "#..." + ".h.#",   // 17
    "#..." + "...." + "E###" + "#..." + "b..#",   // 18
    "####" + "####" + "####" + "####" + "####",   // 19
  ],
  alt: [
    "4444" + "4444" + "4444" + "4444" + "4444",   //  0
    "4444" + "4444" + "4444" + "4888" + "8884",   //  1
    "4444" + "4444" + "4444" + "4888" + "8884",   //  2
    "4444" + "4444" + "4444" + "4888" + "8884",   //  3
    "4444" + "4444" + "4444" + "4888" + "8884",   //  4
    "4444" + "4444" + "4444" + "4888" + "8884",   //  5
    "4444" + "4444" + "4444" + "4888" + "8884",   //  6
    "4444" + "4444" + "4444" + "4888" + "8884",   //  7
    "4444" + "4444" + "4444" + "4888" + "8884",   //  8
    "4444" + "4444" + "4456" + "7888" + "8884",   //  9
    "4444" + "4444" + "4444" + "4888" + "8884",   // 10
    "4444" + "4444" + "4444" + "4888" + "8884",   // 11
    "4444" + "4444" + "4444" + "4888" + "8884",   // 12
    "0333" + "4444" + "4444" + "4888" + "8884",   // 13
    "0222" + "4444" + "4444" + "4888" + "8884",   // 14
    "0111" + "4444" + "4444" + "4888" + "8884",   // 15
    "0000" + "0000" + "4444" + "4888" + "8884",   // 16
    "0000" + "0000" + "4444" + "4888" + "8884",   // 17
    "4444" + "4444" + "4444" + "4888" + "8884",   // 18
    "4444" + "4444" + "4444" + "4444" + "4444",   // 19
  ],
  feat: [
    "...." + "...." + "...." + "...." + "....",   //  0
    "...." + "...." + "...." + ".TTT" + "TTT.",   //  1
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  2
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  3
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  4
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  5
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  6
    "..TT" + "TTTT" + "...." + ".TTT" + "TTT.",   //  7
    ".TTT" + "...." + "...." + ".TTT" + "TTT.",   //  8
    ".TTT" + "...." + "..SS" + "STTT" + "TTT.",   //  9
    ".TTT" + "...." + "...." + ".TTT" + "TTT.",   // 10
    ".TTT" + "...." + "...." + ".TTT" + "TTT.",   // 11
    ".TTT" + "...." + "...." + ".TTT" + "TTT.",   // 12
    ".SSS" + "TTTT" + "...." + ".TTT" + "TTT.",   // 13
    ".SSS" + "TTTT" + "...." + ".TTT" + "TTT.",   // 14
    ".SSS" + "TTTT" + "...." + ".TTT" + "TTT.",   // 15
    ".PPP" + "PPP." + "...." + ".TTT" + "TTT.",   // 16
    ".PPP" + "PPP." + "...." + ".TTT" + "TTT.",   // 17
    "...." + "...." + "...." + ".TTT" + "TTT.",   // 18
    "...." + "...." + "...." + "...." + "....",   // 19
  ]
};

/* #354: one source of truth for barrel hit points. The authored plan parser used to push barrels with no
   hp at all, so hurtBarrel's `p.hp -= dmg` produced NaN, `NaN <= 0` is never true, and THE STACK's barrels
   absorbed shots and splash forever while index.html promises "Barrels are not your friends." */
const BARREL_HP = 26;

function buildAuthored(li) {
  const authSeats = {};   // #355: the plan's own enemy seats per kind, so difficulty can scale the count
  const cfgL = LEVELS[li], A = AUTHORED, N = A.size;
  const bad = m => { console.warn('AUTHORED REJECTED (level ' + li + '): ' + m); return false; };
  for (const pair of [['geo', A.geo], ['alt', A.alt], ['feat', A.feat]]) {
    if (pair[1].length !== N) return bad(pair[0] + ' has ' + pair[1].length + ' rows, size says ' + N);
    for (let y = 0; y < N; y++) if (pair[1][y].length !== N)
      return bad(pair[0] + ' row ' + y + ' is ' + pair[1][y].length + ' chars, not ' + N);
  }
  const cell = new Uint8Array(N * N), fz = new Int8Array(N * N),
    cz = new Uint8Array(N * N).fill(CZ_DEF), feat = new Uint8Array(N * N);
  const spots = [];
  let sx = -1, sy = -1, ex = -1, ey = -1, openCells = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, g = A.geo[y][x], q = A.alt[y][x].charCodeAt(0) - 48, f = A.feat[y][x];
    if (q < 0 || q > 9) return bad('alt row ' + y + ' col ' + x + ' is not a digit 0..9');
    if (y === 0 || y === N - 1 || x === 0 || x === N - 1) {
      if (g !== '#') return bad('the border must be wall, found ' + JSON.stringify(g) + ' at ' + x + ',' + y);
      // The border ring is a wall column like any other. Where the plan carries it down to a pit
      // band, its base has to go down too, or the face between it and the pit spans [0.00..0.00]:
      // a column the DDA stops at that paints nothing (the #120 fault family, authored rather dealt).
      cell[i] = pickWallTex(cfgL); fz[i] = q - 4; continue;
    }
    // A solid column's floor comes from the plan too: "solid from its floor up" means its base
    // must reach the lowest band it bounds, or the face it shows spans to the air side's ceiling
    // plane and has zero height - the #120 generator-fault family, authored rather than dealt.
    if (g === '#') { cell[i] = pickWallTex(cfgL); fz[i] = q - 4; continue; }
    cell[i] = 0; openCells++; fz[i] = q - 4;
    if (f === 'T') cz[i] = CZ_AUTH_TALL;
    else if (f === 'P') feat[i] = FEAT_PIT;
    else if (f === 'S') feat[i] = FEAT_STAIR;
    if (g === 'P') { sx = x; sy = y; }
    else if (g === 'E') { ex = x; ey = y; }
    else if (g !== '.') spots.push([x, y, g]);
  }
  if (sx < 0) return bad('the plan has no spawn seat');
  if (ex < 0) return bad('the plan has no exit pad');
  MAP = {
    w: N, h: N, cell, light: new Float32Array(N * N), rooms: A.rects,
    lR: new Float32Array(N * N).fill(0.6), lG: new Float32Array(N * N).fill(0.6),
    lB: new Float32Array(N * N).fill(0.6), lw: new Float32Array(N * N),
    lt: new Uint8Array(N * N * 3).fill(128), amb: cfgL.amb, tintDirty: false,
    floorBias: cfgL.floorBias || 0, ceilBias: cfgL.ceilBias || 0, ceilLead: cfgL.ceilLead,
    floorTex: FLOORS[cfgL.floor], ceilTex: CEILS[cfgL.ceil],
    fz, cz, vb: new Uint16Array(N * N), feat, ceilPlane: new Float64Array(N * N)
  };
  // the same finalisation every path through this file ends with: the derived arrays are derived,
  // never authored, and anything that wrote MAP.fz/MAP.cz without this would ship last frame's ceilings
  MW = N; MH = N; linkBoundaries(); decalGridInit(); explored = new Uint8Array(N * N); S.revealed = 0;
  LIGHTS = []; PROPS = []; PICKUPS = []; PROJ = []; PARTS = []; ENEMIES = [];
  for (const s of spots) {
    const px = s[0] + 0.5, py = s[1] + 0.5, fl = floorAt(px, py);
    if (s[2] === 'L') {
      /* #213's band rule, now applied to AUTHORED lamps as well as the generator's top-up: strength by
         the number of open columns in the lamp's OWN band. Before this an authored lamp was a fixed
         str 1 / r 7.2 source, so the 15-cell pit and the 300-cell datum floor received identical light -
         the exact asymmetry #213 recorded as a white box in a hole (DEV.lum 168 mean / 229 mid) while the
         big floor stayed under-lit. A pit lamp therefore lands on cov/TARGET = 15/32 = 0.47, clamped to
         TOPUP_MINF = 0.5, which is what a generated pit of that size already gets; the flood is over
         columns at the same fz and runs once per lamp at build on a 20x20 grid. */
      const f0 = fz[(s[1] | 0) * N + (s[0] | 0)];
      let cov = 0;
      { const seen = new Uint8Array(N * N), st = [(s[1] | 0) * N + (s[0] | 0)];
        seen[st[0]] = 1;
        while (st.length) { const c = st.pop(); cov++; const cx = c % N, cy = (c / N) | 0;
          for (let d = 0; d < 4; d++) { const nx = cx + DIRX[d], ny = cy + DIRY[d]; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            const ni = ny * N + nx; if (seen[ni] || fz[ni] !== f0 || cell[ni]) continue;
            seen[ni] = 1; st.push(ni); } } }
      const lstr = Math.max(TOPUP_MINF, Math.min(1, cov / TOPUP_TARGET));
      LIGHTS.push({ x: px, y: py, z: fl + LHOVER, r: 7.2, str: lstr, col: cfgL.lampCol, stat: 1 });
      PROPS.push({ tex: PROP.lamp, x: px, y: py, scale: 0.95, z: fl, kind: 'lamp' });
    } else if (s[2] === 'B') PROPS.push({ tex: PROP.barrel, x: px, y: py, scale: 0.86, z: fl, kind: 'barrel', hp: BARREL_HP, dead: false });
    else if (s[2] === 'C') PROPS.push({ tex: PROP.crate, x: px, y: py, scale: 1, z: fl, kind: 'crate' });
    else if (s[2] === 'A' || s[2] === 'H') PICKUPS.push({ type: s[2] === 'A' ? 'ammo' : 'health', x: px, y: py, bob: 0, dead: false });
    else if (s[2] === 'g' || s[2] === 'h' || s[2] === 'b') {
      const ak = s[2] === 'g' ? 'grunt' : s[2] === 'h' ? 'hound' : 'brute';
      ENEMIES.push(makeEnemy(ak, px, py));
      (authSeats[ak] = authSeats[ak] || []).push([px, py]);
    }
  }
  /* #355: DIFFS[S.diff].cnt reached only the generator's placement loop, so the authored finale shipped an
     identical 2 grunt + 1 hound + 1 brute on Recruit and on Nightmare. hp and incoming damage DO scale
     (makeEnemy reads DIFFS.hp at js/30_entities.js:37, damagePlayer reads DIFFS.dmg at :294), so the last
     level was the one place difficulty had no say in how many bodies stood up. Marine (cnt 1.0) asks for
     exactly the authored count, so the shipped default is unchanged here, and a plan's body is a designed
     beat, so rounding can never remove the last one of a kind.
     An extra gets a cell NO OTHER BODY OWNS - the guard DEV.tick's openAlong already keeps for spawned
     crowds, whose originating failure (#93) was a HUD counting two bodies the frame drew as one. The plan
     marks four enemy squares and Nightmare wants a fifth body, so the pool is: any authored seat a lower
     count has vacated, then the nearest free open square an authored seat REACHES - cell by cell through
     canEnter, the one movement test, so the extra is reachable by construction and not by hope. The first
     version of this cycled the plan's seats and put the added grunt in the hound's own square: 0.000 m
     apart, and the separation term at js/30_entities.js:596 is skipped when two centres coincide
     (sd > 1e-6), so the pair stayed overlapped while idle and one body's pixels just changed species.
     makeEnemy draws from the level's own xorshift, so this count shifts that stream - harmless on an
     authored map, where every seat comes from the plan and no layout roll follows it. */
  { const cnt = DIFFS[S.diff].cnt, all = [], used = new Set(), cellOf = (x, y) => ((y | 0) * N + (x | 0));
    for (const k in authSeats) for (const s of authSeats[k]) { all.push(s); used.add(cellOf(s[0], s[1])); }
    // every crossing of an L-path between two squares, one cell at a time - a two-cell straight hop would
    // test only its end square, and canEnter is a CROSSING test, not a ray
    const reaches = (ax, ay, bx, by) => {
      const walk = (st, dx, dy) => {                       // one axis, one cell per canEnter
        if (!dx && !dy) return true;
        while (dx ? st.x !== bx : st.y !== by) {
          if (!canEnter(st.x + 0.5, st.y + 0.5, st.x + dx + 0.5, st.y + dy + 0.5)) return false;
          st.x += dx; st.y += dy;
        }
        return true;
      };
      const legs = (xfirst) => {                           // x-then-y, or y-then-x: either way round counts
        const st = { x: ax, y: ay }, xs = Math.sign(bx - ax), ys = Math.sign(by - ay);
        const l1 = xfirst ? [xs, 0] : [0, ys], l2 = xfirst ? [0, ys] : [xs, 0];
        return walk(st, l1[0], l1[1]) && walk(st, l2[0], l2[1]);
      };
      return legs(true) || legs(false);
    };
    const freeSeat = () => {
      for (const s of all) if (!used.has(cellOf(s[0], s[1]))) return [s[0], s[1]];   // a seat a lower count vacated
      for (let r = 1; r <= 2; r++)            // Manhattan rings: nearest first, and every leg of a path is one step
        for (const s of all) { const cx = s[0] | 0, cy = s[1] | 0;
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) + Math.abs(dy) !== r) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
            const i = ny * N + nx;
            if (cell[i] || used.has(i) || (nx === sx && ny === sy)) continue;   // open, unowned, never the spawn square
            if (reaches(cx, cy, nx, ny)) return [nx + 0.5, ny + 0.5];
          }
        }
      return null;
    };
    // DROP first, so a square a lower count vacates is on the table for the kinds below it
    for (const k in authSeats) {
      const seats = authSeats[k], want = Math.max(1, Math.round(seats.length * cnt));
      for (let i = seats.length - 1; i >= want; i--) {
        const s = seats[i]; used.delete(cellOf(s[0], s[1]));
        for (let j = ENEMIES.length - 1; j >= 0; j--) if (ENEMIES[j].kind === k && Math.hypot(ENEMIES[j].x - s[0], ENEMIES[j].y - s[1]) < 0.01) { ENEMIES.splice(j, 1); break; }
      }
    }
    for (const k in authSeats) {
      const seats = authSeats[k], want = Math.max(1, Math.round(seats.length * cnt));
      for (let i = seats.length; i < want; i++) {
        const s = freeSeat();
        if (!s) break;                        // no free reachable square: keep the authored beat rather than overlap it
        ENEMIES.push(makeEnemy(k, s[0], s[1])); used.add(cellOf(s[0], s[1]));
      }
    }
  }
  // The exit pad is a static, Z-LESS light in the generator path (:1352); an authored level that
  // skips it ships a pad with no glow and leaves alt's wrong-band census with no population at all.
  // It has to be pushed BEFORE the splat loop below to be baked into MAP.light like the lamps.
  LIGHTS.push({ x: ex + 0.5, y: ey + 0.5, r: 5.5, str: 0.75, col: [140, 225, 255], stat: 1 });
  for (const L of LIGHTS) splatLight(L, L.str);
  exitX = ex + 0.5; exitY = ey + 0.5;
  const sp = nearestOpen(sx + 0.5, sy + 0.5);          // never spawn inside geometry: the collision
  P.x = sp[0]; P.y = sp[1]; P.ang = 0.6; P.vx = P.vy = 0; P.z = floorAt(sp[0], sp[1]);  // probes read P
  buildTint();
  return true;
}
function genLevel(li) {
  const cfgL = LEVELS[li];
  /* An authored plan is data, so it is validated rather than hoped for: if the layers disagree the
     loader says so loudly and the generator's own path still ships a playable level, and `alt`'s
     rows on this level then fail because a generated box has no authored bands in it. Silently
     falling back and reporting the fallback as the authored level is the trap this comment is for. */
  if (cfgL.authored) {
    if (buildAuthored(li)) return true;
    console.warn('genLevel: authored plan for level ' + li + ' was rejected, generating instead');
  }
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
    authorVolume(cell, N, rooms, fzTry, vbTry, featTry, czTry);
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
      floorBias: cfgL.floorBias || 0, ceilBias: cfgL.ceilBias || 0, ceilLead: cfgL.ceilLead,
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
    /* #154: the seat, taken HERE rather than at the spawn line below - nearestOpen reads no RNG and
       touches no grid, so this costs the draw stream nothing, and it is the only way the prop passes
       can subtract the cell the player will actually stand in. The defect was that the prop pool and
       the seat were chosen by passes that do not know about each other (#149's shape), so a deal could
       hand the player a crate at arm's length (measured on main, 12 seeded rolls x 3 levels: 6 of 36
       deals had a prop under 2.00 m, min 1.00 m, and on two of those it sat in the spawn heading's
       cone with the wall behind it open at 10-12 m).
       WHERE the clearance sits is the whole design. It is NOT a rejected candidate inside takeNear: a
       `continue` there costs one more rndi draw, and #96's rule is that a pass which spends extra draws
       re-rolls every world built downstream of the same SEED. That is not hypothetical - the first
       version of this change did exactly that and moved a level whose props were ALREADY clear: at the
       props probe's ambient stream (SEED 12345, level 0, nearest prop 2.00 m) generation consumed 1424
       draws and seated the player at 19.5,6.5 on main against 343 draws at 11.5,8.5 on that branch,
       because one rejected lamp candidate shifted every draw after it - and three rows of
       `view.js props` went red for a level the clearance had no business touching. So the draw still
       picks the cell exactly as it always did (takeNear is untouched below) and a pick inside the disc
       is walked OUT of it by clearSpot, which draws nothing and rolls no dice: the level downstream of
       a prop that had to move stays bit-for-bit the level main built, and the only thing that changes
       is the prop's own square metre.
       The predicate is the same shape as inSpawn one level up - a rule over candidate cells, consulted
       by the passes that opt in. Lamps, crates and barrels opt in; pickups and enemies do not: a
       pickup floats and blocks nothing, and enemies already keep takeNear(7+) metres. */
    const seat = nearestOpen(px0, py0);
    const seatClear = (x, y) => dist2(x + 0.5, y + 0.5, seat[0], seat[1]) >= SPAWN_CLEAR * SPAWN_CLEAR;
    // deterministic and RNG-free: the nearest open reachable cell outside the disc, Chebyshev rings
    // first, scan order within a ring. Three rings is 48 cells; nothing moves when none qualifies.
    const clearSpot = c => {
      if (!(SPAWN_CLEAR > 0) || seatClear(c[0], c[1])) return c;
      for (let r = 1; r <= 3; r++)
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = c[0] + dx, ny = c[1] + dy;
          if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
          const i = ny * N + nx;
          if (cell[i] || dist[i] < 0 || !seatClear(nx, ny)) continue;
          return [nx, ny];
        }
      return c;
    };
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
      const c = clearSpot(takeNear(1));      // #154: a lamp is a prop - it draws, and FOOT.lamp blocks.
      // one clearSpot call feeds the LIGHTS entry and the PROPS entry below, so light and prop disagree
      // with each other on no deal;
      LIGHTS.push({ x: c[0] + 0.5, y: c[1] + 0.5, z: floorAt(c[0] + 0.5, c[1] + 0.5) + LHOVER, r: 7.2 + Math.random() * 2.8, str: 1.05, col: cfgL.lampCol, stat: 1 });
      PROPS.push({ tex: PROP.lamp, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.95, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'lamp' });
    }
    /* The pad light deliberately carries NO z: it is drawn as a glow AT the floor, so it
       emits from the floor of its own cell - the documented splatLight default, the same
       rule the transients use (#203). Its band is thereby defined (the exit is datum-pinned),
       which was the issue with "undefined rather than zero"; an authored hover offset would
       tax the pools under the stair and pit cells around the exit, and the L2 lip rows of
       bands measured that cost (pad at floorAt+0.55 or +0.78 puts the L2 face-lip contrast
       46% -> 43% against the 45% floor - the pool a floor glow casts across its lip is
       load-bearing legibility, not bleed). */
    LIGHTS.push({ x: exitX, y: exitY, r: 5.5, str: 0.75, col: [140, 225, 255], stat: 1 });
    /* #204's coverage half, with the target corrected from "bands that hold no lamp" to "bands that
       are not covered", because #208's kernel makes the difference matter: a lamp now lights the band
       it STANDS on, so a raised band the budget happened to reach with one lamp keeps main's coverage
       of nothing while the datum light it used to borrow stops arriving - that is the whole of why the
       kernel term alone spends level 0's face-lip row. A band is served when a source standing ON it
       lights its cells, and "lights" is the kernel's own test (|srcFloor - bandFloor| <= ZQ), so
       coverage is measured by running the shipped splatLight for that band's sources onto a scratch
       lightmap and reading what arrives, rather than by restating the disc here and drifting from it.
       The pre-blur direct term is the right thing to author against: delivered MAP.light is post-blur,
       and blurLight carries light across a lip, so counting it would let a datum lamp stand in for a
       pit lamp - which is #209's complaint about the exit pad's z-less reach, stated as a placement
       rule. A band under MIN_BAND reachable interior cells is decoration rather than a place a player
       can be lost in, and that floor is also a budget guard. OWN_MIN is 0.25 rather than the 0.05 the
       dark-cell counters use, and that gap is the finding: at 0.05 a band counts as covered when a
       lamp's disc merely reaches its edge at 5% strength, which is 0/0/0 dark pit cells and a level 0
       face lip that still reads 43% (main 61, the kernel term alone 43), while 0.25 asks for a floor
       that is actually LIT and the lip comes back to 54% - the row stops being a debt row. The cost is
       measured, not assumed: MAX_ADD binds on all three levels (10/12/19-20 lamps against main's
       7/9/17, i.e. +3.0 per level where #207's lampless-band rule spent +0.9), so the rule wants more
       lamps than it is allowed and the guard is load-bearing. Draws come from a PRIVATE LCG and no grid
       is written - one global draw here would re-roll the world under every probe seed (#96), and
       MAP.fz is smoke's V15 flat lane. */
    if (topUpEnabled()) {                                // LAMPS=off in tools/view.js runs the kernel without this
      const MIN_BAND = 8, PER_BAND = 2, MAX_ADD = 3, OWN_MIN = 0.25, COV_TARGET = 0.75;
      /* #149: the guarantee this pass owes the player, and the two rules that make it real.
         SPACING  LAMPGAP cells from every source standing on the same quantum, the exit pad included.
                  2 cells is > hypot(1,1), so the diagonal neighbour fails too: two lamps in touching
                  cells are one pool of light paid for twice while the place neither one landed in stays
                  dark. Measured on main over 12 seeded deals x 3 levels, the minimum same-band lamp-to-
                  lamp distance a deal can deal is 1.00 m (two budget draws in adjacent cells).
         RESERVE  a band with NO source standing in it is served before any band gets a second lamp.
                  The loop this replaces could spend all three adds on the datum floor (PER_BAND is 2)
                  while a 20-cell room stayed dark, which is the "18 of 24 rolls carry an unlit room" of
                  the issue body, restated in the unit the coverage test actually uses.
         SEAT     the cell whose disc DELIVERS the most light that nothing delivers today, scored by
                  running the shipped kernel (below), with the cheapest test first and no dice - a dark
                  deal must stop being a dice accident, and #320 showed the score has to be the band's
                  OWN cells or a stair tread wins the seat from the room it borders.
         The budget loop above this block is untouched: its seats are drawn from the world's own stream,
         so moving them would re-roll props and enemies under every probe seed (#96) and move the
         LAMPS=off record flatparity's PARITY sense hashes. Nothing here draws from that stream. */
      const LAMPGAP = 2;
      const SEAT_ANG = 0.6, LENS_HALF = 0.66, LENS_R = 8, SEAT_FLOOR = 4;   // :1489's heading, #304's cone
      let ps = ((li * 7919 + rooms.length * 104729 + ((exitX * 1000) | 0) * 13 + 12345) >>> 0) || 1;
      const prnd = () => { ps = (Math.imul(ps, 1664525) + 1013904223) >>> 0; return ps / 4294967296; };
      // the source's own FLOOR - the same recovery splatLight makes, restated here only to pick a band
      const srcFloor = L => (L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER);
      const OPENAT = (cx, cy) => {
        let n = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!cell[(cy + oy) * N + (cx + ox)] && cy + oy > 0 && cx + ox > 0) n++;
        return n;
      };
      /* Reachable open interior cells grouped by PLACE-BAND: (room rect or LANE) x floor quantum.
         The quantum alone is the unit the KERNEL lights in, but it is not the unit a player reads as one
         place: a datum corridor and a datum room are the same quantum and different places, and a lamp
         whose disc merely CLIPS one cell of a room's floor counts as covering that quantum while the room
         stays dark - the definition gap this issue argued in prose for three attempts (#149's census
         correction). Naming the place is what turns "the quantum is covered" into "no room is dark", and
         it is the same grouping tools/view.js exposure's coverage census measures, so the promise and the
         row cannot drift apart. LANE = the cells that are in no room rect, and on a generated level that
         is 55-71% of the floor, which is why the lane is a band and not a remainder. */
      const roomAt = (x, y) => {
        for (let k = 0; k < rooms.length; k++) { const r = rooms[k];
          if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return k; }
        return -1;
      };
      const BANDS = []; const bOf = new Int16Array(N * N).fill(-1);
      for (let i = 0; i < N * N; i++) {
        if (cell[i] || dist[i] < 0) continue;
        const x = i % N, y = (i / N) | 0;
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        const ri = roomAt(x, y), q = fzTry[i];
        let id = -1;
        for (let k = 0; k < BANDS.length; k++) if (BANDS[k].ri === ri && BANDS[k].q === q) { id = k; break; }
        if (id < 0) { id = BANDS.length; BANDS.push({ ri: ri, q: q, cells: [] }); }
        BANDS[id].cells.push(i); bOf[i] = id;
      }
      const bandOrder = BANDS.map((b, k) => k).sort((a, b) =>
        BANDS[b].cells.length - BANDS[a].cells.length || a - b);      // biggest place first (the datum)
      const taken = new Set();
      for (const L of LIGHTS) taken.add(((L.y | 0) * N) + (L.x | 0));
      /* How many sources STAND IN each place-band - the strict definition of served, the one this
         guarantee is written against. A source on the same quantum whose disc merely reaches the band is
         TOUCH and does not count here; that asymmetry is the finding, not an oversight. */
      const standIn = () => {
        const s = new Int32Array(BANDS.length);
        for (const L of LIGHTS) { const i = ((L.y | 0) * N) + (L.x | 0); if (bOf[i] >= 0) s[bOf[i]]++; }
        return s;
      };
      const spaced = (i, q) => {
        const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
        for (const L of LIGHTS) {
          if (Math.abs(srcFloor(L) - q * ZQ) > ZQ + 1e-9) continue;
          if (Math.hypot(L.x - x, L.y - y) < LAMPGAP) return false;
        }
        return true;
      };
      /* A bulb inside the first frame's lens is not a light source in that frame, it is the sun in the
         player's eye: the composited spawn median lands past the 35-75 band whose upper anchor is the
         dimmest lamp-1-m-in-the-lens render (tools/ci/assert.js's SPAWN block, #304). The utility likes
         the middle of the spawn room, which is where the player wakes, so the seat test asks. Two clauses,
         because a bulb that is NOT in the cone still lifts the frame by lighting the walls inside it: a
         seat 5 m off the axis with a clear sight of the room took level 2's spawn mean 64 -> 85 (raster),
         above the band's 75, without ever being in the cone. So there is also a distance floor - #319's
         gap, applied here because a reserve pass that reaches into the spawn room makes it every pass.
         A cell behind a wall is not in the lens - it is dark on both sides - hence the los test. */
      const inLens = (i) => {
        const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
        const dx = x - px0, dy = y - py0, d = Math.hypot(dx, dy);
        if (d < SEAT_FLOOR) return true;                          // the seat's own room, however far off axis
        if (d > LENS_R) return false;
        let e = Math.atan2(dy, dx) - SEAT_ANG;
        while (e > Math.PI) e -= TAU;
        while (e < -Math.PI) e += TAU;
        return Math.abs(e) < LENS_HALF && los(px0, py0, x, y);
      };
      const seatOK = i => !taken.has(i) && dist[i] >= 2 && OPENAT(i % N, (i / N) | 0) >= 3;
      /* What the sources standing on band b deliver to b's own cells, through the shipped kernel, on a
         scratch lightmap put back exactly as found. It is all zeros at this point and the real splat
         runs below, so this leaves no residue behind - the arrays are swapped out rather than cleared. */
      const SC = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N),
        new Float32Array(N * N), new Float32Array(N * N)];
      const SC2 = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N),
        new Float32Array(N * N), new Float32Array(N * N)];
      /* Direct light per QUANTUM from the sources standing on that quantum, through the shipped kernel,
         on a scratch map swapped out and back exactly as found (the arrays are the game's, and leaving
         one of them swapped would light the world from a choice that was never made). Cached per
         placement - qOwn is rebuilt when LIGHTS grows, so a band's dark share costs one splat per source
         per added lamp instead of one per candidate. */
      let qOwn = null;
      const ownMaps = () => {
        if (qOwn) return qOwn;
        const m = new Map(), keep = [MAP.light, MAP.lR, MAP.lG, MAP.lB, MAP.lw];
        for (const bd of BANDS) {
          if (m.has(bd.q)) continue;
          for (const a of SC) a.fill(0);
          MAP.light = SC[0]; MAP.lR = SC[1]; MAP.lG = SC[2]; MAP.lB = SC[3]; MAP.lw = SC[4];
          for (const L of LIGHTS) if (Math.abs(srcFloor(L) - bd.q * ZQ) <= ZQ + 1e-9) splatLight(L, L.str);
          m.set(bd.q, MAP.light.slice());
          MAP.light = keep[0]; MAP.lR = keep[1]; MAP.lG = keep[2]; MAP.lB = keep[3]; MAP.lw = keep[4];
        }
        qOwn = m;
        return m;
      };
      const darkShare = bd => { const v = ownMaps().get(bd.q); let d = 0;
        for (const i of bd.cells) if (v[i] < OWN_MIN) d++; return d / bd.cells.length; };
      /* The cells a seat on a quantum can reach = the union of the place-bands standing on that quantum,
         concatenated in BANDS order so a band's own slice is contiguous (bd.off .. bd.off+bd.len) and one
         pass over the quantum can report both "how many dark cells did this lamp light" and "how many are
         left in the place the lamp stands in". */
      const qCells = new Map();
      for (const bd of BANDS) {
        let a = qCells.get(bd.q); if (!a) qCells.set(bd.q, a = []);
        bd.off = a.length;
        for (const i of bd.cells) a.push(i);
        bd.len = bd.cells.length;
      }
      /* What one lamp on cell i would DO: FIXED counts the cells on this quantum that are dark today and
         lit afterwards, AFTER counts the ones still dark in the place the seat stands in. The light each
         cell receives is the shipped kernel run for that seat, not a restatement of the disc (#204's
         rule), and the objective is PLACES FINISHED rather than LIGHT DELIVERED: a seat that empties a
         band's dark list buys the guarantee, a seat that nibbles 15% off a 500-cell lane buys a slightly
         brighter lane. Summing gains is the right rule for a brightness budget and the wrong one for a
         coverage promise, which is why this replaced #204's `score = cells covered * 16 + openness`. */
      const evalSeat = (i, bd, r) => {
        const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
        for (const a of SC2) a.fill(0);
        const keep = [MAP.light, MAP.lR, MAP.lG, MAP.lB, MAP.lw];
        MAP.light = SC2[0]; MAP.lR = SC2[1]; MAP.lG = SC2[2]; MAP.lB = SC2[3]; MAP.lw = SC2[4];
        splatLight({ x: x, y: y, z: floorAt(x, y) + LHOVER, r: r, str: TOPUP_BASE, col: cfgL.lampCol, stat: 1 }, 1);
        const lm = MAP.light, v = ownMaps().get(bd.q), cells = qCells.get(bd.q);
        let fixed = 0, inBd = 0, after = 0;
        for (let k = 0; k < cells.length; k++) {
          const a = v[cells[k]];
          if (a >= OWN_MIN) continue;                     // already lit: this seat buys nothing here
          const lit = a + lm[cells[k]] >= OWN_MIN;
          if (lit) fixed++;
          if (k >= bd.off && k < bd.off + bd.len) { inBd += lit ? 1 : 0; if (!lit) after++; }
        }
        MAP.light = keep[0]; MAP.lR = keep[1]; MAP.lG = keep[2]; MAP.lB = keep[3]; MAP.lw = keep[4];
        return { fixed: fixed, inBd: inBd, after: after };
      };
      /* The seat scan for one band: cheapest test first (a cell that is not seatable, sits within LAMPGAP
         of a source on this quantum, or is inside the first frame's lens costs three comparisons and no
         kernel run), determinism over cleverness (cell order breaks ties, no dice are drawn), and a stride
         on a band too big to scan whole - one disc is 15 cells across, so a stride of 4 over a contiguous
         lane cannot step over a place a whole disc would have lit. The lens is preferred, not required: a
         band whose only seat is in the frame gets a lamp rather than a dark room. */
      const bestSeat = (bd, r, lensOK, finishFirst) => {
        let bi = -1, be = null, bo = -1;
        const stride = bd.cells.length > 240 ? 4 : 1;
        for (let k = 0; k < bd.cells.length; k += stride) {
          const i = bd.cells[k];
          if (!seatOK(i) || !spaced(i, bd.q)) continue;
          if (lensOK && inLens(i)) continue;
          const e = evalSeat(i, bd, r), op = OPENAT(i % N, (i / N) | 0);
          const under = e.after * 4 <= bd.len ? 1 : 0;      // this seat finishes the place
          const sv = (finishFirst ? under * 1e6 : 0) + e.fixed;   // a RESERVE seat finishes the place first;
          if (!be || sv > be.sv || (sv === be.sv && op > bo)) { be = { under: under, fixed: e.fixed, after: e.after, sv: sv }; bo = op; bi = i; }
        }
        return bi < 0 ? null : { i: bi, e: be };
      };
      const perBand = new Map();
      for (let added = 0; added < MAX_ADD; added++) {
        const r = 7.2 + prnd() * 2.8;
        const stand = standIn();
        /* RESERVE BEFORE SPREAD, twice over: a place with NO source standing in it is served before any
           place gets a second lamp (PER_BAND then applies to the remainder), and within that the seat is
           taken from the place this one lamp can FINISH. The loop this replaces ranked the bands by dark
           share alone and asked 400 dice for a seat in the worst one, so three adds could all land on the
           datum floor - the median goes up, a room stays dark, and that is precisely the tail the median
           was introduced to hide (#87). Deterministic from here on, so a dark deal stops being a dice
           accident: the same seed always gets the same lamps. */
        let wb = -1, bs = -1, bfix = -1, bseat = -1, bds = -1;
        for (let reserve = 0; reserve < 2 && wb < 0; reserve++) {
          for (const id of bandOrder) {
            const bd = BANDS[id];
            if (bd.cells.length < MIN_BAND || (perBand.get(id) || 0) >= PER_BAND) continue;
            const ds = darkShare(bd);
            if (ds <= 1 - COV_TARGET) continue;                // a band needs >25% of its cells unserved
            if (reserve === 0 && (stand[id] > 0 || ds <= 0.9)) continue;   // nothing in it AND nothing on it
            let s = bestSeat(bd, r, true, reserve === 0);
            if (!s) s = bestSeat(bd, r, false, reserve === 0);
            if (!s) continue;
            /* The place that is darkest wins the slot, not the place a lamp helps most: ranked by dark
               share, an all-dark pit floor outranks a brightening corridor, and a greedy on FIXED cells
               starves exactly the small holes it is hardest to seat (measured: ranking by FIXED left
               4/9/6 all-dark bands over 12 deals x 3 levels where ranking by need left 1/0/0). The SEAT
               inside that place is then chosen to finish it. */
            /* Two objectives, one per pass, because the two passes answer different questions.
               RESERVE: a place with NO source standing in it AND more than half its floor dark wins the
               slot outright. Ranked by cells fixed instead, an all-dark 15-cell pit loses to a corridor
               and starves - measured 4/9/6 all-dark bands over 12 deals x 3 levels where ranking by need
               left 0/0/0; ranked by need at ANY dark share, the 25%-dark corridor outbids the half-dark
               hole and alt's dark-open-cell census grows (measured 555 dark cells on level 0 against the
               356 this row caps at). The SEAT inside that place is the one that finishes it.
               SPREAD (no place is left with nothing): the seat that FINISHES a place, else the one that
               lights the most dark cells - the density term #149's last comment identified as the only
               lever left once ordering is exhausted. */
            const sc = reserve === 0 ? ds * 1e6 + s.e.fixed : s.e.fixed;
            if (sc > bs || (sc === bs && s.e.fixed > bfix)) { bs = sc; bfix = s.e.fixed; wb = id; bseat = s; }
          }
        }
        if (wb < 0) break;
        const bd = BANDS[wb], best = bseat.i;
        let bcov = 0;
        {
          const v = ownMaps().get(bd.q);
          for (const j of bd.cells) if (v[j] < OWN_MIN &&
            Math.hypot((j % N) - (best % N), ((j / N) | 0) - ((best / N) | 0)) < r) bcov++;
        }
        taken.add(best);
        qOwn = null;                                          // the new source changes every band's own light
        perBand.set(wb, (perBand.get(wb) || 0) + 1);
        // #154: the coverage top-up drops a lamp too. Its draws come from the private LCG, so the
        // global stream is untouched either way, but the seat's clearance is a PLACEMENT rule, and a
        // lamp is FOOT.lamp wide to a player who walks into it: nudge the chosen cell, keep the
        // coverage score and intensity that selected it.
        const bq = clearSpot([best % N, (best / N) | 0]);
        const bx = bq[0], by = bq[1];
        taken.add(by * N + bx);           // the cell the lamp STANDS in is the one that must stay unique
        const tsc = Math.min(1, Math.max(TOPUP_MINF, (bcov || 1) / TOPUP_TARGET));   // 0 coverage keeps a full lamp: a dim source that covers nothing would only darken the band
        LIGHTS.push({ x: bx + 0.5, y: by + 0.5, z: floorAt(bx + 0.5, by + 0.5) + LHOVER, r, str: TOPUP_BASE * tsc, col: cfgL.lampCol, stat: 1 });
        PROPS.push({ tex: PROP.lamp, x: bx + 0.5, y: by + 0.5, scale: 0.95, z: floorAt(bx + 0.5, by + 0.5), kind: 'lamp' });
      }
    }
    for (let i = 0; i < cfgL.crates; i++) { const c = clearSpot(takeNear(2)); PROPS.push({ tex: PROP.crate, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.72, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'crate' }); }
    for (let i = 0; i < cfgL.barrels; i++) {
      const c = clearSpot(takeNear(2));
      PROPS.push({ tex: PROP.barrel, x: c[0] + 0.5, y: c[1] + 0.5, scale: 0.86, z: floorAt(c[0] + 0.5, c[1] + 0.5), kind: 'barrel', hp: BARREL_HP, dead: false });
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
    const sp = seat;                    // #154: the same nearestOpen the prop passes subtracted
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
