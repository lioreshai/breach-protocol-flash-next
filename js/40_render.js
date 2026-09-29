'use strict';
/* ==================================================================
   40_render.js — software raycaster + 2D overlay/HUD
   One shading model everywhere: colour = albedo x RGB light + fog.
   Light comes from a coloured per-cell lightmap (so lamps pool on the
   floor), the wall pass adds face orientation, floors and ceilings are
   texture-mapped with mip selection, and bullet holes/blood are decals
   sampled in world space. Bloom, light glow and film grain run on top.
   ================================================================== */
let planeLen = cfg.plane, dirX = 1, dirY = 0, planeX = 0, planeY = cfg.plane;
let camX = 0, camY = 0, eyeZ = 0.5, horizon = 0, shakeX = 0, shakeY = 0;
let drawCalls = 0, pixFilled = 0, reSolveBad = 0, gndOffMap = 0;   // last two: ground re-solve counters, read by tools/view.js heights
let gndWalkEdge = 0;                                 // deferred pixels the ray march handed to the wall pass: a slab EDGE, no plane of its own
let bloomCv = null, bloomCtx = null, canFilter = false, grainCv = null, grainPat = null, grainSeed = 0;
let FARB = 22, AMB = 0.13, GQ = null;
let G_TRI = false, G_GRIT = 0;                                  // derived from QUAL.rast
/* #164: altitude reached the geometry and no pixels. A seam at the CREASE of every step the render
   ray crosses - the foot darkened, the far lip lifted - is the one cue that survives a dark room, so
   it is a MULTIPLY on composited pixels, not an additive term the AMB floor sinks. World-scaled, so
   it stays SEAMW metres wide at any depth, and narrow, so it is an edge and not a shade. */
let SEAM = 1, SEAMD = 0.62, SEAMU = 0.13, SEAMW = 0.16, SEAMC = 0.22;
/* The wall bilinear fetch is inlined at its one call site below rather than factored into a
   function that writes its result into a scratch array: a module-global typed-array out-param
   blocks V8 inlining and register allocation, and the same code inlined measured 21 -> 12 ms
   near a wall. It is inlined here and nowhere else, so the pass that keeps the registers is this
   one, and any new caller must inline it too rather than reach for a shared helper. */
// viewmodel spring state: sway lag, previous look angle, eject timing
const VM = { vy: 0, ang: 0, lag: 0, now: 0, t: 0 };

const QUAL = [
  { name: 'PERFORMANCE', res: 0.34, min: 170, max: 430, bloom: false, grade: false, grain: 0, far: 15, dmax: 8, glow: 0, scan: 0.5, vec: 0, rast: 0, rigH: 0 },
  { name: 'BALANCED', res: 0.47, min: 220, max: 760, bloom: true, grade: true, grain: 0.05, far: 22, dmax: 13, glow: 6, scan: 0.18, vec: 1, rast: 2, rigH: 300 },
  { name: 'ULTRA', res: 0.62, min: 260, max: 780, bloom: true, grade: true, grain: 0.04, far: 30, dmax: 19, glow: 9, scan: 0.1, vec: 1, rast: 4, rigH: 216 }
];

function resize() {
  DPR = Math.min(1.5, window.devicePixelRatio || 1);
  DW = Math.max(320, Math.round(innerWidth * DPR));
  DH = Math.max(200, Math.round(innerHeight * DPR));
  cv.width = DW; cv.height = DH;
  const q = QUAL[clamp(S.gfx | 0, 0, QUAL.length - 1)];
  GQ = q; FARB = q.far;
  G_TRI = q.rast >= 4; G_GRIT = q.rast >= 4 ? 0.85 : (q.rast >= 2 ? 0.5 : 0);
  BH = clamp(Math.round(DH * q.res), q.min, q.max);
  BW = Math.max(160, Math.round(BH * DW / DH));
  bufCv.width = BW; bufCv.height = BH;
  imgBuf = bufCtx.createImageData(BW, BH);
  px = new Uint32Array(imgBuf.data.buffer);
  // zbuf = camera-space perpendicular distance of the nearest occluding surface at that PIXEL
  // (Infinity = draws nothing over it). The ground pass covers every pixel, the wall pass
  // overwrites its face span; readers cull on a strictly-nearer surface.
  // Both halves of the frame carry a distance: the sentinel meant "no surface solved here", not
  // "this is a ceiling", and Infinity on a ceiling row is what let a body on the band above draw
  // through the slab (#163). Only a row with no plane to solve - the horizon row, where dz/0 is
  // Infinity - keeps the sentinel.
  zbuf = new Float32Array(BW * BH).fill(Infinity);
  ctx.imageSmoothingEnabled = q.res > 0.4;          // smooth upscale instead of chunky pixels
  ctx.imageSmoothingQuality = 'low';
  const scan = document.getElementById('scan');     // the CRT curtain is a look, not a given
  if (scan) scan.style.opacity = String(q.scan);
  const ql = document.getElementById('qual');
  if (ql) ql.textContent = q.name;
  if (q.bloom && !bloomCv) {
    bloomCv = document.createElement('canvas');
    bloomCtx = bloomCv.getContext('2d');
    canFilter = typeof bloomCtx.filter === 'string';
  }
  if (q.grain > 0 && !grainCv) buildGrain();
}

function buildGrain() {
  grainCv = document.createElement('canvas');
  grainCv.width = 96; grainCv.height = 96;
  const g = grainCv.getContext('2d');
  for (let i = 0; i < 1400; i++) {
    const v = (Math.random() * 255) | 0;
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.fillRect(Math.random() * 96 | 0, Math.random() * 96 | 0, 1, 1);
  }
  grainPat = ctx.createPattern(grainCv, 'repeat');
}

const visAt = d => 1 / (1 + d * d * 0.010) + 0.06 * Math.exp(-d * 0.06);
const fogAt = d => clamp(1 - visAt(d), 0, 1);
const clampi = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;

/* per-cell coloured light: intensity in MAP.light, normalised tint in MAP.lt */
function cellTint(idx) {
  const lt = MAP.lt;
  if (!lt || idx < 0 || idx * 3 + 2 >= lt.length) return TINT_WHITE;
  const k = idx * 3;
  return [lt[k] / 128, lt[k + 1] / 128, lt[k + 2] / 128];
}
const TINT_WHITE = [1, 1, 1];

function renderWorld() {
  const bobP = P.bob * 1.4 + P.kick * 0.4;
  const flash = S.flash;
  planeLen = cfg.plane * (1 - P.ads * 0.55);
  dirX = Math.cos(P.ang); dirY = Math.sin(P.ang);
  planeX = -dirY * planeLen; planeY = dirX * planeLen;
  camX = P.x; camY = P.y;
  // The eye belongs in the band the player is standing in. The [0.12, 1.4] this used to clamp
  // against predates absolute altitude - it guarded a P.z that could only be a crouch offset in
  // [0,1] - and as a bound on an absolute eye it is a ceiling on WHERE THE PLAYER MAY STAND:
  // above ~0.9 m the eye froze at 1.4 while the floor under their feet was higher than that, and
  // `okA = rawA < eyeZ` in the ground pass then rejects that floor and paints datum z=0 instead
  // (#103). Bounding by the band keeps the guard doing its job - the eye can never leave the room
  // it is in - at any altitude, and on a flat level (floorAt 0, ceilAt 1) it is the same interval.
  const pfl = floorAt(P.x, P.y);
  eyeZ = clamp(cfg.eye + P.z - P.crouch * 0.19, pfl + 0.12, ceilAt(P.x, P.y) - 0.06);
  AMB = MAP && MAP.amb !== undefined ? MAP.amb : 0.13;
  horizon = BH * 0.5 + aimPx() + bobP * (BH / 400) * 3 + shakeY;
  const fcR = FOGC[0], fcG = FOGC[1], fcB = FOGC[2];
  const fcol = pack(FOGC[0], FOGC[1], FOGC[2]);
  px.fill(fcol);

  castGround(flash, fcR, fcG, fcB);
  castWalls(flash, fcR, fcG, fcB);

  /* ---- sprites: props, pickups, projectiles, the portal ----
     Props, pickups, the orb and the portal are geometry now (#76), on the same `mesh:true` dispatch the
     enemies got in #72. Two conventions carry over unchanged: `scale` is TOTAL world height, and z is
     the FEET, resolved at DRAW time like an enemy's already was (below) - a prop that stores
     generation-time floorAt still sinks when a band changes under it, which is what M3 makes routine.
     What the billboard had and the mesh cannot keep is the texture: each prop was one painted Surf, so
     js/13_mesh.js authors parts for it. The grenade stays a billboard - no geometry is authored for it
     and MESH.draw now throws rather than answer with a grunt. The `glow` field the pickup entries
     carried is gone: drawBillboard never read it, glow comes from LIGHTS in drawLightGlow (#76). */
  const list = [];
  const PKKIND = { health: 'pickupHealth', ammo: 'pickupAmmo', armor: 'pickupArmor' };
  for (const p of PROPS) {
    if (p.dead && p.kind === 'barrel') continue;
    list.push({ mesh: true, kind: p.kind, x: p.x, y: p.y, z: floorAt(p.x, p.y), scale: p.scale, alpha: p.dead ? 0.35 : 1 });
  }
  for (const k of PICKUPS) {
    if (k.dead) continue;
    // the bob rides ON TOP of the floor, so a pickup on a raised band bobs there instead of at z 0.16
    list.push({ mesh: true, kind: PKKIND[k.type], x: k.x, y: k.y, z: floorAt(k.x, k.y) + 0.16 + Math.sin(k.bob) * 0.05, scale: 0.42, alpha: 1 });
  }
  for (const p of PROJ) {
    if (p.kind === 'orb') {
      list.push({ mesh: true, kind: 'orb', x: p.x, y: p.y, z: p.z - p.scale / 2, scale: p.scale, alpha: 1, emis: true });
    } else {
      list.push({ tex: p.tex, x: p.x, y: p.y, z: p.z - p.scale / 2, scale: p.scale, alpha: 1, self: true });
    }
  }
  /* Open, the portal is light-exempt, which is the billboard's self:true said as lighting, and it runs
     alpha-blended because a flat-shaded mesh has no gradient to fade with. Shut it is dimmed and lit by
     the room (the old dim:0.55). Both keep self-occlusion ON: the wall behind it is already painted and
     this list is sorted far to near, so writing depth cannot hide the room - it only makes the near
     jamb hide the far one, which is the whole point of a frame. */
  list.push({
    mesh: true, kind: 'portal', x: exitX, y: exitY, z: floorAt(exitX, exitY) + 0.02, scale: 1.5,
    alpha: S.exitOpen ? 0.85 : 0.42, emis: S.exitOpen, dim: S.exitOpen ? 0 : 0.55,
  });
  /* Bodies are geometry now (js/13_mesh.js, #39): the mesh carries the enemy's real position,
     heading and world height instead of a billboard's distance, an 8-way yaw bucket and the
     flat-world z: 0. enemyFrame still owns what the mesh cannot express - the corpse fade and
     the hit flash - and both reach MESH.draw as {alpha,flash}. The four pose signals below are the
     ones the billboard fed js/11_rig.js before #72, so a walking body cycles its gait and a dying
     one topples (#73). For a corpse the yaw carries dieAng because that is the direction it falls:
     the vertex set pitches the body toward its own front, so the yaw aims the topple and the die
     term is how far it has gone. atk is the same progress the shot is timed on in
     js/30_entities.js:417, so the arm is fully extended on the frame the round leaves the muzzle. */
  for (const e of ENEMIES) {
    const fr = enemyFrame(e);
    if (fr.alpha <= 0.02) continue;
    const heading = e.state === 'dead' && e.dieAng !== undefined ? e.dieAng : e.ang;
    const dying = e.state === 'dead';
    list.push({
      mesh: true, kind: e.kind, x: e.x, y: e.y, z: floorAt(e.x, e.y),
      yaw: TAU * 0.25 - heading,                      // body +z is its front: see js/13_mesh.js draw
      scale: e.scale, alpha: fr.alpha, flash: fr.flash ? 1 : 0, tint: e.tint,
      p: e.anim, mv: e.movingAmt || 0,
      atk: dying || e.atkT <= 0 ? 0 : 1 - clamp(e.atkT / e.type.wind, 0, 1),
      die: dying ? clamp(e.dieT / 0.55, 0, 1) : 0,
      dv: e.dv | 0,                                   // which death this enemy got at spawn (#82)
      body: 1,                                        // coverage stamp for tools/view.js contrast
    });
  }
  /* ground decals first: they lie on the floor and must not paint over feet */
  for (const b of list) { const dx = b.x - camX, dy = b.y - camY; b.d2 = dx * dx + dy * dy; }
  list.sort((a, b) => b.d2 - a.d2);
  if (COV) COV.fill(0);            // opt-in only: null in play, so this is one branch off the hot path
  for (const b of list) { if (b.mesh) MESH.draw(b); else drawBillboard(b); }

  /* The weapon last, and into the same buffer. It is the nearest thing in the frame, and drawing it
     here rather than composited over the finished picture is what makes it part of the picture: bloom,
     grade, grain and the vignette now reach it the way they reach the room it is held in. Its own
     header in this file states the seat, the depth decision and the two light terms. */
  drawViewModel();

  bufCtx.putImageData(imgBuf, 0, 0);
}

/* ------------------------------------------------------------------
   floor & ceiling: perspective-correct texture mapping, solved per CELL.
   A screen row used to be solved against one plane - the eye's own floor below
   the horizon, the eye's own ceiling above it - which stretched that plane over
   every column in the level. Each pixel is now solved against the plane of the
   cell its own ray lands in, so the room two doors away has its own floor
   altitude AND its own ceiling, and the ceiling is drawn here rather than left
   as a gap in the wall pass: floors-only would paint a phantom floor across the
   upper half of a tall room, which is the same lie told from the other side.

   The row keeps its old distance as a PREDICTOR, and a pixel whose cell sits at the eye's altitude
   is painted by the loop this pass always had, with the same loop-invariant mip, fog and light - one
   extra compare per pixel is all the feature costs there (smoke's raster median unchanged, and +0.8 ms
   of a 1202x676 stress frame). A pixel whose cell is NOT on that plane is queued and shaded after the
   row by groundPixel(), which is a second copy of the pixel body and the reason the first one's
   values are allowed to stay const. In a flat level nothing is ever queued, so `d` there is the
   expression this pass has always contained, bit for bit. What deliberately did NOT change,
   because the last attempt changed it and came out 4 points darker overall and 9
   on level 0:
   - light stays CELL-QUANTIZED for floors and ceilings alike (the wall pass samples
     it bilinear with a distance falloff - unifying the two is a shading change, and
     it is not free: bilinear+pulled light off a lamp pool is what shifted exposure),
   - fog stays fogAt(camera-space depth) with no z term, which is what the wall pass
     uses too, so ground and walls keep fading at the same rate,
   - the far band, the mip thresholds and the muzzle-flash term stay row-constants
     for every pixel that did not move.
   Planes come from AIR cells only: a solid column has no air, so its ceilAt is a fiction, and the
   void outside the map is today's flat ground. Both keep the row's plane, which means their pixels
   are not re-solved at all and the wall pass draws over them - reading a plane THROUGH a wall is how
   a room two cells out of sight gets painted across the middle of one, and solving a plane against a
   solid column once filled an entire frame with grey.
   ------------------------------------------------------------------ */
let RX = new Int32Array(0), RP = new Float64Array(0);   // columns of one row that needed re-solving

/* Ground mip selection: MIPAR is the anisotropy ratio the footprint may be stretched by before the
   choice stops rewarding it, and MIPAX is the A/B switch (0 = the 1-D selection this shipped with)
   that tools/view.js mip uses as its negative control. Both are read once per row, never per pixel. */
let MIPAX = 1, MIPAR = 4;

/* The mip for a ground pixel from the WORLD footprint of one pixel, given the two screen-axis
   deltas in world units: (ax0,ax1) is how far the sampled point moves along a row, (ay0,ay1) how
   far down a column. For a plane the row delta is plane*step*d, which is ALMOST constant in
   length across the frame, while the column delta is raydir*d/|p| and grows as 1/p^2 - so a floor
   seen obliquely covers a long thin strip of world, and selecting from one axis alone takes a mip
   far too small and streaks along the view direction (issue #19). The old form weighted the u
   component of the row delta at 1 and its v component at 0.001, so looking down a corridor axis,
   where planeX is 0, it read a footprint of 0 and held mip 0 over the whole floor.
   The larger axis wins, unless it is more than MIPAR times the other: a footprint elongated past
   that would buy a smaller mip than the well-sampled axis needs, blurring detail nothing occludes,
   because there is no anisotropic filter here to keep the fine axis sharp. Mip k is the level whose
   texel is at least one pixel wide, floor(log2(rho)) - the cascade below is that, in mip-0 texels
   per pixel. */
function mipSel(ax0, ax1, ay0, ay1, sc, tex) {
  const m = tex.mips, n = m.length;
  let k;
  if (!MIPAX) {                                             // the shipped 1-D term, control only
    const t = Math.abs(ax0 * sc) + Math.abs(ax1 * sc) * 0.001;
    k = t >= 0.5 ? (t >= 2 ? (t >= 4 ? 3 : 2) : 1) : 0;
  } else {
    const ws = m[0].w * sc;                                 // mip-0 texels per world unit
    const ax = Math.sqrt(ax0 * ax0 + ax1 * ax1) * ws;
    const ay = Math.sqrt(ay0 * ay0 + ay1 * ay1) * ws;
    const rho = ax >= ay ? ax : ay < ax * MIPAR ? ay : ax * MIPAR;
    k = rho >= 16 ? 4 : rho >= 8 ? 3 : rho >= 4 ? 2 : rho >= 2 ? 1 : 0;
  }
  return k < n ? k : n - 1;
}

/* Which plane's own CELL reaches the point this ray arrives at: march the ray from the eye cell and
   take the first surface honestly in the way - the plane of a cell the ray reaches while it is still
   INSIDE that cell, or the floor of a boundary whose slab closes over the ray's altitude. Altitude is
   a property of the ROW and not of the plane: the engine's d is a PARAMETER along (dir + plane*cam),
   whose length varies from 1 at the centre to sqrt(1+plane^2) at the corners, and z = eyeZ -+ d*absP/BH
   is exactly the same expression castGround solves - so the march, the row and the deferred body all
   count the same units and a crossing is a comparison rather than a solve. (Marching EUCLIDEAN
   distances instead - the obvious DDA - reads every boundary ~1.1x further away than the row counts it
   and repaints a low corridor's ceiling with the tall room behind it: measured 2106 CZBAND px in rows
   102..109, plane 2.00 at 7.57 -> 1.00 at 2.52, for a ray that clears the doorway before it rises.)
   This is the rule the per-cell solver was approximating: solving a plane across the whole ray answered
   a ceiling pixel at 10 m when the floor of the cell one boundary out stopped the same ray at 2.5, and
   a prop standing on that floor drew through the slab (#170). Returns `pl` when nothing nearer
   intervenes, so a caller that queued `pl` keeps the answer it had.
   The CEILING side of a closing is deliberately not answered with a plane: a ray that leaves its cell
   ABOVE the neighbour's ceiling has come to the edge of a slab, which is a face the wall pass owns,
   and painting the neighbour's ceiling plane back across that room is the phantom the CZBAND control
   in `view.js cull` exists to catch. Marches that end there are counted in gndWalkEdge, not guessed.
   A flat level answers on the eye's own cell at the row's own distance, which is the shipped
   arithmetic bit for bit, and the row only calls this when a plane differs or the grid has a step. */
function planeAlong(rx, ry, pl, isF, absP) {
  const N = MAP.w, cellArr = MAP.cell, fzs = MAP.fz, cp = MAP.ceilPlane;
  const ax = rx > 0 ? rx : -rx, ay = ry > 0 ? ry : -ry;
  const sgn = isF ? -1 : 1;                          // floors below the eye, ceilings above it
  const rise = sgn * absP / BH;                      // world altitude per unit of the ray's PARAMETER
  const invAbsP = BH / absP;
  const dzPl = (pl - eyeZ) * sgn;
  const cap = dzPl > 1e-9 && dzPl * invAbsP < FARB * 4 ? dzPl * invAbsP : FARB * 4;
  let cx = camX | 0, cy = camY | 0, tIn = 0, g = 0;
  const sx = rx > 0 ? 1 : -1, sy = ry > 0 ? 1 : -1;
  let tx = ax > 0 ? (rx > 0 ? cx + 1 - camX : camX - cx) / ax : 1e30;
  let ty = ay > 0 ? (ry > 0 ? cy + 1 - camY : camY - cy) / ay : 1e30;
  for (; g < 40; g++) {
    const tOut = tx < ty ? tx : ty;
    if (!(tOut < cap)) {                             // nothing between the eye and the point in question
      const ie = cy * N + cx;
      if (cx >= 0 && cy >= 0 && cx < N && cy < N && !cellArr[ie]) {
        const pe = isF ? fzs[ie] * ZQ : cp[ie];      // the march is standing in a cell whose own surface
        if ((pe - eyeZ) * sgn > 1e-9 && Math.abs(pe - pl) > ZQ * 0.5) gndWalkEdge++;   // is not the answer: a slab edge
      }
      break;
    }
    const i = cy * N + cx;
    // The void and a solid column have no plane of their own, and the caller's plane stands: a wall
    // there is drawn by the wall pass, which repaints this pixel and its depth either way.
    if (cx < 0 || cy < 0 || cx >= N || cy >= N || cellArr[i]) break;
    const pz = isF ? fzs[i] * ZQ : cp[i];            // this cell's own surface
    const tz = (pz - eyeZ) * sgn > 1e-9 ? (pz - eyeZ) * sgn * invAbsP : -1;
    if (tz >= tIn && tz <= tOut) { pl = pz; break; } // hit while still inside the cell that owns it
    /* The cell across the boundary the ray reaches first - ONLY that axis moves. Stepping both
       components (the obvious `cx+sx, cy+sy`) walks a diagonal that the ray never travels, so a
       straight-ahead ray reads the floor of the row above the corridor and the closing test below
       answers nothing (this is how the first version of #170 left 232 of 438 px leaking). */
    const stepX = tx < ty, nx = cx + (stepX ? sx : 0), ny = cy + (stepX ? 0 : sy);
    const fHere = fzs[i] * ZQ;
    const fThere = nx < 0 || ny < 0 || nx >= N || ny >= N ? 0 : fzs[ny * N + nx] * ZQ;
    const lo = fHere > fThere ? fHere : fThere;      // the bottom of the opening at that boundary
    if (eyeZ + tOut * rise < lo) {                   // the ray slips UNDER a floor, so it hits that floor
      const dlo = (lo - eyeZ) * sgn;                 // a floor at or beyond the candidate's own solve is
      if (dlo > 1e-9 && dlo * invAbsP < cap) { pl = lo; break; }   // the riser case, and the wall pass's
    }
    tIn = tOut; cx = nx; cy = ny;
    if (stepX) tx += 1 / ax; else ty += 1 / ay;
  }
  if (g >= 40) reSolveBad++;                         // a march that ran out of crossings: heights' row
  return pl;
}

function castGround(flash, fcR, fcG, fcB) {
  const hInt = Math.round(horizon);
  const stepBase = 2 / BW;
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light, fzs = MAP.fz, cp = MAP.ceilPlane;
  const floorTex = MAP.floorTex || FLOORS.CONCRETE, ceilTex = MAP.ceilTex || CEILS.CONCRETE;
  const tileF = MAP.floorTile || 1.15, tileC = MAP.ceilTile || 0.9;
  const dMasks = DECAL_MASK, dGrid = DECAL_GRID;
  const amb = AMB, fl = flash;
  const gndSteps = MAP.steps ? 1 : 0;                 // #170: 0 on every flat level, which is what keeps
  //                                      a flat frame free of any call to planeAlong and thus md5-clean
  /* Scratch for the columns of one row that had to be re-solved off the row's plane. Sized to a
     row because a row is all a frame can ever queue; in a flat level nothing is ever written. */
  if (RX.length < BW) { RX = new Int32Array(BW); RP = new Float64Array(BW); }
  for (let y = 0; y < BH; y++) {
    const p = y - hInt;
    // the one row with no distance to report: dz * BH / 0 is Infinity for every plane, because a
    // horizontal ray never reaches one, so this pixel genuinely has no surface in front of it
    if (p === 0) { px.fill(0xFF000000 | fcB << 16 | fcG << 8 | fcR, y * BW, y * BW + BW); zbuf.fill(Infinity, y * BW, y * BW + BW); continue; }
    const isF = p > 0, absP = p > 0 ? p : -p;
    /* planeA is the band the eye is in: floorAt below the horizon, ceilAt above it, and in
       the flat world exactly 0 and exactly 1 - which is what makes dRow the old d. It doubles
       as the predictor for every pixel of the row. A floor above the eye and a ceiling below
       it are not surfaces these rows can reach, so neither is allowed to be the predictor. */
    const cAx = camX | 0, cAy = camY | 0, cAir = cAx >= 0 && cAy >= 0 && cAx < N && cAy < N && !cellArr[cAy * N + cAx];
    const rawA = cAir ? (isF ? fzs[cAy * N + cAx] * ZQ : cp[cAy * N + cAx]) : eyeZ;   // no air of its own -> okA false -> sentinel
    const okA = isF ? rawA < eyeZ : rawA > eyeZ;
    const planeA = okA ? rawA : (isF ? Math.min(0, eyeZ - ZQ) : Math.max(1, eyeZ + ZQ));
    const dzA = isF ? eyeZ - planeA : planeA - eyeZ;
    const dRaw = dzA * BH / absP;
    const dfadeRow = 0.4 + 0.6 * Math.exp(-dRaw * 0.02);   // row-constant: was one exp per pixel per decal
    const dRow = dRaw > FARB * 4 ? FARB * 4 : dRaw;
    const fogRow = fogAt(dRow);
    const invRow = 1 - fogRow, fRRow = fcR * fogRow, fGRow = fcG * fogRow, fBRow = fcB * fogRow;
    const flashRow = fl * Math.exp(-dRow * 0.30);
    const baseRow = amb + flashRow * 0.9;
    let tex, sc;
    if (isF) { tex = floorTex; sc = 1 / tileF; } else { tex = ceilTex; sc = 1 / tileC; }
    if (dRow > FARB || !(tex && tex.mips)) {                     // far band: light-tinted fog, no texture
      const c0 = cellTint(cellIdx(camX, camY));
      const lit = MAP.light ? MAP.light[cellIdx(camX, camY)] : 0.4;
      px.fill(pack(clampi((18 * c0[0] + lit * 26 * c0[0]) * 1 + fRRow), clampi((18 * c0[1] + lit * 26 * c0[1]) + fGRow),
        clampi((18 * c0[2] + lit * 26 * c0[2]) + fBRow)), y * BW, y * BW + BW);
      zbuf.fill(dRaw, y * BW, y * BW + BW);                    // depth = the row's own solve, unclamped
      continue;
    }
    /* row ray span: column x has cam offset (x*stepBase-1) */
    const c0 = -1;
    let wx = camX + (dirX + planeX * c0) * dRow, wy = camY + (dirY + planeY * c0) * dRow;
    const wxs = planeX * stepBase * dRow, wys = planeY * stepBase * dRow;
    /* mip from the footprint of one pixel. The row delta is (wxs,wys); the column delta is the ray
       direction times d/|p|, evaluated at the frame CENTRE column - |ray| reaches sqrt(1+plane^2)
       = 1.23 at the corners, which is a third of a mip and stays inside the ratio clamp. */
    const cfRow = dRow / absP;
    const kRow = mipSel(wxs, wys, dirX * cfRow, dirY * cfRow, sc, tex);
    const mRow = tex.mips[Math.min(kRow, tex.mips.length - 1)];
    // ms is texels per world unit at THIS mip: the tile is tileF world units wide, so a
    // 128-texel tile must advance mw/tileF per unit. Dividing by the mip width instead
    // (sc * mw/tex.w) made every tile span ~147 world units, so all floor material was
    // magnified ~128x into a flat gradient and pxTex never exceeded 0.071 - the mip
    // chain, the grit, the plank and tile patterns were all unreachable by construction.
    const row = y * BW;
    /* One fill instead of one store per pixel: writing a loop-invariant inside the pixel loop cost
       +2.5 ms of a 1202x676 frame. dRaw is deliberately the distance BEFORE the FARB*4 shading
       clamp - occlusion wants the real distance, and the clamp only exists to stop a texel being
       dragged in from 300 m. The same number is the depth of BOTH halves: a ceiling row's plane is
       the slab the cell above stands on, so its solve is the distance to that slab and `occ < z`
       (#13_mesh.js:524) can finally hide a body standing on the band above (issue #163). Where the
       row has no plane of its own, planeA is the +-ZQ fallback and this is its distance, which is
       what the floor half has always written.
       Columns this row cannot solve are queued below and get their own depth in groundPixel(). */
    zbuf.fill(dRaw, row, row + BW);
    let pxi = wx | 0, pyi = wy | 0, cIdx = pyi * N + pxi, mir = 0;
    let inMap = pxi >= 0 && pyi >= 0 && pxi < N && pyi < N;
    let lt = inMap ? cellTint(cIdx) : TINT_WHITE, li = inMap && lm ? lm[cIdx] : 0;
    if (li > 1) li = 1;
    let lr = baseRow + li * lt[0], lg = baseRow + li * lt[1], lb = baseRow + li * lt[2];
    /* One cell-crossing test per pixel, as the pass has always had it. pxi/pyi is that walk and,
       when nothing is being re-solved, it is also the walk of the plane - the cell being shaded and
       the cell whose plane the row solved for only part company at a pixel that gets queued below,
       and those never write a pixel here. planeC is the plane of the cell the walk is standing in,
       or planeA when that column has no plane of its own or a plane these rows cannot reach. */
    let planeC = planeA;
    if (pxi >= 0 && pyi >= 0 && pxi < N && pyi < N && !cellArr[cIdx]) {
      const pl0 = isF ? fzs[cIdx] * ZQ : cp[cIdx];
      planeC = (isF ? pl0 < eyeZ : pl0 > eyeZ) ? pl0 : planeA;
      // the first column's ray is the row's left edge, dir - plane. Ceiling rows only, see below.
      if (!isF && planeC !== planeA) planeC = planeAlong(dirX - planeX, dirY - planeY, planeC, isF, absP);
    }
    /* Everything the pixel body reads is a const of this row, and that is not style: the day these
       became per-pixel `let`s, a 1202x676 frame cost 2.5 ms more for pixels nothing re-solves,
       because V8 can only keep a value in a register while nothing writes it inside the loop. So a
       pixel that needs its own distance, fog, mip and light is queued and shaded after the row by
       groundPixel(), and the flat case - every pixel of every level shipped - never touches one. */
    const dfade = dfadeRow, fog = fogRow, inv = invRow, fR = fRRow, fG = fGRow, fB = fBRow, base = baseRow;
    const mw = mRow.w, mh = mRow.h, ms = sc * mRow.w, td = mRow.data, mask = mw - 1, maskH = mh - 1;
    let nm = 0;
    for (let x = 0; x < BW; x++, wx += wxs, wy += wys) {
      const gx = wx | 0, gy = wy | 0;
      if (gx !== pxi || gy !== pyi) {                          // crossed into another cell
        pxi = gx; pyi = gy; cIdx = gy * N + gx;
        inMap = gx >= 0 && gy >= 0 && gx < N && gy < N;
        if (inMap) {
          lt = cellTint(cIdx); li = lm ? lm[cIdx] : 0.4;
          lr = base + li * lt[0]; lg = base + li * lt[1]; lb = base + li * lt[2];
          mir = (hash2(gx, gy) * 4) | 0;                        // per-cell mirror kills the tiling tell
        } else { gndOffMap++; lt = TINT_WHITE; li = 0; lr = lg = lb = base; }
        /* Only AIR columns have a floor and a ceiling: a solid column has no air, so its ceilAt is a
           fiction, and the void outside the map is today's flat ground - both mean "no plane of your
           own". Both axes are tested here even though inMap tested the index, because the index is
           one-dimensional and gx === -1 with gy > 0 is a valid index for a cell on the far side of
           the level: reading a plane THROUGH a wall is how a room two cells out of sight gets painted
           across the middle of one, and it once filled an entire frame with grey. */
        let pl = planeA;
        if (gx >= 0 && gy >= 0 && gx < N && gy < N && !cellArr[cIdx]) pl = isF ? fzs[cIdx] * ZQ : cp[cIdx];
        planeC = (isF ? pl < eyeZ : pl > eyeZ) ? pl : planeA;   // a floor above the eye and a ceiling
      }                                                        // below it reach nothing on these rows
      /* A plane is only honest if the cell carrying it reaches the point this column's ray arrives at,
         so ask the march, not the cell the row's WALK happened to enter: a raised floor one boundary
         out closes the ray under itself and the pixel belongs to the row, not to a solve ten metres
         away (#170). Guarded by the plane differing or a step in the grid, so a flat level never pays
         for it and never runs arithmetic the row did not already run.
         CEILING ROWS ONLY. The same walk on FLOOR rows is correct too and changes the picture: main's
         fixed point there ADOPTS a lower plane it finds further along the ray, so down a staircase a
         step-down lip paints the bottom floor's plane at 18 m where the honest hit is the first step's
         at 9.4 m. Walking that half moves 11,850 px of the `bands` probe's L0 walk-lip frame (5.8% of
         it) and drops its mean |dL| across the lip from 45.4 to 27.1 (want >= 30) - the lip's
         legibility is bought with the phantom. That half is a separate change with a look gate to
         re-base first; the #170 defect is entirely in the ceiling half (measured: 0 px of the leak is
         row-painted, and nodefer answers every one of the 438). */
      /* No march here: a 40-step DDA per cell crossing is the documented one-indirection cliff (it
         measured 38.2 ms against main's 9.2 on a flat frame). The row defers with the plane its own
         walk reached, and groundPixel() marches that pixel - which is where all 438/401/398 leaking
         pixels are (measured: 0 px row-painted), so the row copy needs no rule of its own. */
      if (planeC !== planeA) { RX[nm] = x; RP[nm] = planeC; nm++; continue; }
      let tx = (wx * ms) | 0, ty = (wy * ms) | 0;
      tx &= mask; ty &= maskH;
      if (mir & 1) tx = mask - tx;
      if (mir & 2) ty = maskH - ty;
      const c = td[ty * mw + tx];
      const i = row + x;
      if ((c >>> 24) === 253) { px[i] = 0xFF000000 | clampi((c >> 16 & 255) * inv + fB) << 16 | clampi((c >> 8 & 255) * inv + fG) << 8 | clampi((c & 255) * inv + fR); continue; }
      let r = (c & 255) * lr + fR, g = (c >> 8 & 255) * lg + fG, b = (c >> 16 & 255) * lb + fB;
      const dl = isF && inMap && dMasks ? dMasks[cIdx] : 0;
      if (dl !== 0) {                                          // blood/scorch in world space, floor only
        const gl = dGrid[cIdx];
        for (let q = 0; q < gl.length; q++) {
          const dc = gl[q], al = decalAlpha(dc, wx, wy, dfade);
          if (al <= 0.01) continue;
          const dt = dc.tex, du = (((wx - dc.x) * dc.inv + 0.5) * dt.w) | 0, dv = (((wy - dc.y) * dc.inv + 0.5) * dt.h) | 0;
          if (du < 0 || dv < 0 || du >= dt.w || dv >= dt.h) continue;
          const s = dt.data[dv * dt.w + du], sa = (s >>> 24) / 255 * al;
          if (sa < 0.01) continue;
          r += ((s & 255) - r) * sa; g += ((s >> 8 & 255) - g) * sa; b += ((s >> 16 & 255) - b) * sa;
        }
      }
      px[i] = 0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r);
    }
    /* second pass over the columns this row could not solve, in column order; each writes its own
       pixel so the order within the row cannot change the image, and the wall pass has not run yet */
    for (let q = 0; q < nm; q++) groundPixel(RX[q], RP[q], row, isF, absP, tex, sc, fcR, fcG, fcB, fl, amb, dRow);
  }
}

/* One pixel whose cell is not on the row's plane. The CEILING half asks which cell's slab reaches the
   point this column's ray arrives at - the same helper the row loop uses, so both copies of this pixel
   answer the same question the same way. That is where #170's leak lives: a pixel queued at a raised
   band's CEILING plane 10 m out was never offered the FLOOR one boundary out that stops the same ray at
   2.5, and the prop standing on that floor drew through it.
   The FLOOR half keeps the three-try fixed point below, verbatim from before #170. That iteration is an
   approximation of the same question: it settles a two-cycle between two planes by the quantum rule
   (measured: 33,656 of a frame's re-solves on `eyeUp`), and on floors it also ADOPTS a lower plane it
   finds further along the ray - down a staircase that paints the bottom floor's plane at 18 m where
   walking the ray answers the first step's plane at 9.4 m. Walking the floor half is more correct and
   moves 11,850 px of the `bands` probe's L0 walk-lip frame (5.8% of it), taking its mean |dL| across
   the lip from 45.4 to 27.1 (want >= 30) and its signed value from -11.2 to +7.0, because that lip's
   legibility is bought with the phantom. It needs its own change and its own look gate, not a quiet
   edit to that threshold.
   d is clamped to the row's reach before it is USED, exactly as the row clamps its
   own, so a plane two units up cannot drag a texel from 300 metres away.
   The shading below is the SECOND copy of the ground pixel body: it must change with the loop in
   castGround, not instead of it. The split is what lets that loop hold its mip, fog and light in
   registers - measured at 2.5 ms of a 1202x676 frame - and this function runs on no pixel of a
   flat level, which is why `scene` md5s and `heights` both have to stay green to trust either. */
function groundPixel(x, pl, row, isF, absP, tex, sc, fcR, fcG, fcB, fl, amb, dP) {
  const N = MAP.w, cellArr = MAP.cell, lm = MAP.light, stepBase = 2 / BW;
  const cam = x * stepBase - 1, rx = dirX + planeX * cam, ry = dirY + planeY * cam;
  let dS;
  if (isF) {
    /* The FLOOR half keeps the shipped solver verbatim: three tries in which the cell the pixel lands
       in may replace the plane that queued it. It adopts a LOWER plane it finds further along the ray,
       which down a staircase paints the bottom floor's plane at 18 m where walking the ray says the
       first step's plane answered at 9.4 m - a phantom, and the reason the `bands` walk-lip row reads
       45.4 instead of 27.1. Fixing that half moves 11,850 px of that probe's L0 frame and needs its
       look gate re-based, so it is NOT folded into #170, which is entirely a ceiling-row defect. */
    let ax = (camX + rx * dP) | 0, ay = (camY + ry * dP) | 0, settled = false;
    for (let g = 0; g < 3; g++) {
      dS = (eyeZ - pl) * BH / absP;
      if (dS > FARB * 4) dS = FARB * 4;
      const qx = (camX + rx * dS) | 0, qy = (camY + ry * dS) | 0;
      const mx = (qx + ax) >> 1, my = (qy + ay) >> 1;
      // a plane may only come from a column within two cells on BOTH axes with no solid column between
      let plN = pl;
      if (qx >= 0 && qy >= 0 && qx < N && qy < N && Math.abs(qx - ax) <= 2 && Math.abs(qy - ay) <= 2 &&
        mx >= 0 && my >= 0 && mx < N && my < N && !cellArr[my * N + mx]) {
        const ii = qy * N + qx;
        if (!cellArr[ii]) {
          const t = MAP.fz[ii] * ZQ;
          if (t < eyeZ) plN = t;
        }
      }
      ax = qx; ay = qy;
      // planes are quantized to ZQ, so agreement within one quantum is convergence: a pixel on the seam between two cells whose planes differ by a quantum has no fixed point and alternates forever (measured: 33,656 of a frame's re-solves on eyeUp, all a 1 <-> 1.25 two-cycle); the plane it started from wins
      if (Math.abs(plN - pl) <= ZQ) { settled = true; break; }
      pl = plN;
    }
    // an exhausted loop used to leave dS from the PREVIOUS plane; the plane finally used now places the pixel
    if (!settled) {
      reSolveBad++;
      dS = (eyeZ - pl) * BH / absP;
      if (dS > FARB * 4) dS = FARB * 4;
    }
  } else {
    // the CEILING half walks the ray: which cell's slab reaches the point this column arrives at
    pl = planeAlong(rx, ry, pl, isF, absP);
    dS = (pl - eyeZ) * BH / absP;
    if (dS > FARB * 4) dS = FARB * 4;
  }
  /* This pixel's cell is NOT on the row's plane, so the row's depth is wrong for it: at the lip of a
     step the row says the distance to the plane the eye is in, while the colour painted here came
     from a plane one quantum (or two units) away. One store per deferred pixel, of the distance this
     function already solved - no re-solve, no call - which is what keeps a sunk stripe from
     occluding a sprite standing in it at the wrong depth. */
  zbuf[row + x] = dS;
  const cx = camX + rx * dS, cy = camY + ry * dS;
  let sx = cx | 0, sy = cy | 0;
  /* a re-solved pixel that leaves the map falls back to the predictor's cell (gx, gy) for light and
     mirror - the cell the row's own walk would have reached - so it shades like a flat pixel at that
     distance instead of wrapping to a cell on the far side of the level */
  if (sx < 0 || sy < 0 || sx >= N || sy >= N) {
    gndOffMap++;
    sx = (camX + rx * dP) | 0; sy = (camY + ry * dP) | 0;
  }
  const dfade = 0.4 + 0.6 * Math.exp(-dS * 0.02);
  const fog = fogAt(dS), inv = 1 - fog, fR = fcR * fog, fG = fcG * fog, fB = fcB * fog;
  const base = amb + fl * Math.exp(-dS * 0.30) * 0.9;
  /* the row's footprint test at this pixel's distance: the world step per column is
     plane*stepBase*d and per row is ray*d/|p|, so both scale with d and nothing else. Here the ray
     direction is this pixel's own, not the centre column's. */
  const cfS = dS / absP;
  const k = mipSel(planeX * stepBase * dS, planeY * stepBase * dS, rx * cfS, ry * cfS, sc, tex);
  const m = tex.mips[k];
  const mw = m.w, mh = m.h, ms = sc * m.w, td = m.data, mask = mw - 1, maskH = mh - 1;
  const inMap = sx >= 0 && sy >= 0 && sx < N && sy < N, cIdx = sy * N + sx;
  let lr, lg, lb, mir = 0;
  if (inMap) {
    const lt = cellTint(cIdx), li = lm ? lm[cIdx] : 0.4;   // no li>1 clamp here either, matching the
    lr = base + li * lt[0]; lg = base + li * lt[1]; lb = base + li * lt[2];   // loop's cell crossing
    mir = (hash2(sx, sy) * 4) | 0;
  } else { lr = lg = lb = base; }
  let tx = (cx * ms) | 0, ty = (cy * ms) | 0;
  tx &= mask; ty &= maskH;
  if (mir & 1) tx = mask - tx;
  if (mir & 2) ty = maskH - ty;
  const c = td[ty * mw + tx];
  const i = row + x;
  if ((c >>> 24) === 253) { px[i] = 0xFF000000 | clampi((c >> 16 & 255) * inv + fB) << 16 | clampi((c >> 8 & 255) * inv + fG) << 8 | clampi((c & 255) * inv + fR); return; }
  let r = (c & 255) * lr + fR, g = (c >> 8 & 255) * lg + fG, b = (c >> 16 & 255) * lb + fB;
  const dl = isF && inMap && DECAL_MASK ? DECAL_MASK[cIdx] : 0;
  if (dl !== 0) {
    const gl = DECAL_GRID[cIdx];
    for (let q = 0; q < gl.length; q++) {
      const dc = gl[q], al = decalAlpha(dc, cx, cy, dfade);
      if (al <= 0.01) continue;
      const dt = dc.tex, du = (((cx - dc.x) * dc.inv + 0.5) * dt.w) | 0, dv = (((cy - dc.y) * dc.inv + 0.5) * dt.h) | 0;
      if (du < 0 || dv < 0 || du >= dt.w || dv >= dt.h) continue;
      const s = dt.data[dv * dt.w + du], sa = (s >>> 24) / 255 * al;
      if (sa < 0.01) continue;
      r += ((s & 255) - r) * sa; g += ((s >> 8 & 255) - g) * sa; b += ((s >> 16 & 255) - b) * sa;
    }
  }
  px[i] = 0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r);
}
function decalAlpha(dc, wx, wy, dfade) {
  const dx = wx - dc.x, dy = wy - dc.y, r2 = dx * dx + dy * dy;
  if (r2 >= dc.r * dc.r) return 0;
  const t = 1 - r2 / (dc.r * dc.r);
  return dc.a * t * dfade;
}

/* Paint the seam of one step lip in one column. zA is the floor on the side of the lip the ray is
   standing on - the lower floor of a drawn riser, whose foot that is - and zB the floor beyond, t the
   perpendicular distance of the boundary. A floor below the eye always projects BELOW its own row,
   so the near surface owns every row under yc(zA) and the far surface every row above it: the band
   therefore always runs UPWARD from yc(zA), into the riser for a step up (which the wall pass draws
   at >=2 quanta and paints straight through at 1 quantum it walks over - the reason #164 could ship
   with the geometry right and the picture flat) and into the far floor for a step down. Capped to
   half the riser's projected height, so a 1 m face gets a seam at its foot, not a gradient.
   amp < 0 shades a crease, amp > 0 lifts a lip; a multiply either way, so the AMB floor that sinks an
   additive rim in a dark room cannot sink this. */
function seamCrease(x, t, zA, zB, amp) {
  if (!(t > 0.001)) return;
  const hp = BH / t, yA = horizon + (eyeZ - zA) * hp, yB = horizon + (eyeZ - zB) * hp;
  const bw = Math.min(Math.abs(yB - yA) * 0.5, hp * SEAMW);
  if (!(bw > 0.5)) return;
  const y0 = Math.floor(yA);
  for (let k = 0; k <= bw; k++) {
    const y = y0 - k;
    if (y < 0) break;
    if (y >= BH) continue;
    const i = y * BW + x, v = px[i];
    // the lip row itself carries an extra term: where the far surface is already darker than the
    // floor in front of it, a gradient alone passes THROUGH the floor's brightness and the lip
    // vanishes (measured on L1: mean |dL| 25 with the gradient, and the sign of the difference
    // changes across levels, so an unsigned threshold cannot be the whole gate)
    const kk = 1 + amp * (1 - k / bw) - (!k && amp < 0 ? SEAMC : 0);
    px[i] = (0xFF000000 | clampi((v >> 16 & 255) * kk) << 16 | clampi((v >> 8 & 255) * kk) << 8 | clampi((v & 255) * kk)) >>> 0;
  }
}

/* ------------------------------------------------------------------
   walls: DDA + coloured light + face shading + decals
   ------------------------------------------------------------------ */
function castWalls(flash, fcR, fcG, fcB) {
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light, cp = MAP.ceilPlane;
  const fzs = MAP.fz, vbs = MAP.vb, doStep = MAP.steps ? 1 : 0;      // #100: 0 on every flat level
  MAP.riserStops = 0;                                            // asserted by view.js cull
  const stepBase = 2 / BW;
  const flR = S.flashCol[0] / 255, flG = S.flashCol[1] / 255, flB = S.flashCol[2] / 255;
  const flashK0 = flash;
  const dmax = GQ ? GQ.dmax : 13, dMask = DECAL_MASK, dGrid = DECAL_GRID;
  for (let x = 0; x < BW; x++) {
    const cam = x * stepBase - 1;
    const rdx = dirX + planeX * cam, rdy = dirY + planeY * cam;
    let mx = camX | 0, my = camY | 0;
    const ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9));
    let stepX, stepY, sdx, sdy, side = 0;
    if (rdx < 0) { stepX = -1; sdx = (camX - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - camX) * ddx; }
    if (rdy < 0) { stepY = -1; sdy = (camY - my) * ddy; } else { stepY = 1; sdy = (my + 1 - camY) * ddy; }
    let tv = 0, guard = 0, riser = 0, rz0 = 0, rz1 = 1, crk = 0, cT = 0, cA = 0, cB = 0;
    while (guard++ < 180) {
      let tX;
      if (sdx < sdy) { tX = sdx; sdx += ddx; mx += stepX; side = 0; } else { tX = sdy; sdy += ddy; my += stepY; side = 1; }
      if (mx < 0 || my < 0 || mx >= N || my >= N) { tv = 1; break; }
      tv = cellArr[my * N + mx];
      if (tv !== 0) break;
      /* #100: an air->air boundary with a step at it is a FACE. The height difference that makes
         canEnter refuse the move (js/20_level.js: `dq > 1` quantum, the same test that sets
         VB_BLOCK) used to be both intangible and invisible, because a face was only ever enumerated
         where the DDA stopped at a SOLID column and an air->air border never stops a ray at all:
         the step occluded nothing, so `zbuf` kept the far distance and geometry showed through it.
         Stopping here with the far cell as the "wall" cell makes the light, tint, mirroring and
         texture walk of this function correct unchanged. The SPAN is not: a solid column's face runs
         from the higher floor to the air side's ceiling, but an air->air boundary is the SIDE OF A
         FLOOR SLAB, so its face is the strip between the two floors, [min(floors), max(floors)].
         Two cases fall out of that and both are asserted by `view.js cull`: a one-unit step in a
         one-unit room collapses the far band to zero headroom and the strip fills the eye's whole
         band, so it reads as a wall and occludes everything (the bug #100 was filed for); and a pit
         gets the wall below its lip instead of a wall above it, so a body in the pit keeps showing
         its crown instead of vanishing. A riser is the exposed edge of a floor slab, so its material is
         the level's own floor material, chosen below - not a wall texture, and not a global concrete.
         Flat levels never reach this test - MAP.steps is 0 - so a flat frame stays bit-identical. */
      if (doStep) {
        const d = side === 0 ? (stepX > 0 ? 0 : 2) : (stepY > 0 ? 1 : 3);
        const pi = (my - (side === 1 ? stepY : 0)) * N + (mx - (side === 0 ? stepX : 0));
        const dq = fzs[my * N + mx] - fzs[pi];
        if ((dq > 1 || dq < -1) && !(vbs[pi] & ((VB_RAMP | VB_LADDER) << (d << 2)))) {
          const fhi = dq > 0 ? fzs[my * N + mx] : fzs[pi], flo = dq > 0 ? fzs[pi] : fzs[my * N + mx];
          riser = 1; rz0 = flo * ZQ; rz1 = fhi * ZQ; MAP.riserStops++; tv = WT.CONCRETE; break;
        }
        /* A one-quantum boundary is walkable, so it is not a face and the ray flies straight through
           it: remember the crossing and its two floors, and the seam below paints the riser the wall
           pass was not allowed to draw. A ramp or ladder link means there is no lip to paint. */
        if (dq && !crk && SEAM && !(vbs[pi] & ((VB_RAMP | VB_LADDER) << (d << 2)))) {
          crk = 1; cT = tX; cA = fzs[pi] * ZQ; cB = fzs[my * N + mx] * ZQ;
        }
      }
    }
    let perp = side === 0 ? sdx - ddx : sdy - ddy;
    if (!(perp > 0.0001)) perp = 0.0001;
    if (tv === 0 || perp > FARB * 3) { if (crk && !riser) seamCrease(x, cT, cA, cB, -SEAMD); continue; }
    /* A riser wears MAP.floorTex, the material this level already authors for its floors. It used to
       wear WTEX.CONCRETE, which is in NO level's palette: 136 texel-luminance against the 99 of level
       0's floor and the 89 of level 2's, so a banded level read ~+8 raster brighter than a flat one at
       an identical lightmap - riser faces are the whole of that delta (13.8% of level 0's pixels at
       mean 118.6, where the floor they cover reads 73.2). Dead on flat levels, so nothing shipped moves. */
    const tex = riser && MAP.floorTex ? MAP.floorTex : WALLS[(tv - 1) % WALLS.length];
    if (!tex) continue;
    let wallX = side === 0 ? camY + perp * rdy : camX + perp * rdx;
    wallX -= Math.floor(wallX);
    const fog = fogAt(perp), inv = 1 - fog, fR = fcR * fog, fG = fcG * fog, fB = fcB * fog;
    const hpx = BH / perp;                                    // screen px per world unit at this depth
    const spanPx = hpx;
    const mk = spanPx < tex.h * 0.6 ? (spanPx < tex.h * 0.3 ? (spanPx < tex.h * 0.15 ? 3 : 2) : 1) : 0;
    const m = tex.mips[Math.min(mk, tex.mips.length - 1)];
    /* Crossfade into the next mip instead of switching at a threshold, so the mip
     * boundary stops being a visible seam at grazing angles. */
    let m2 = null, wMix = 0;
    if (G_TRI && mk + 1 < tex.mips.length) {
      const lvl = Math.max(0, Math.log2(tex.h * 0.62 / Math.max(spanPx, 0.0001)));
      const fr = lvl - Math.floor(lvl);
      if (fr > 0.55) { m2 = tex.mips[Math.min(mk + 1, tex.mips.length - 1)]; wMix = (fr - 0.55) / 0.45 * 0.85; }
    }
    const grit = G_GRIT * Math.max(0, Math.min(1, 1.35 - perp * 0.11));
    const mw = m.w, mh = m.h, td = m.data, maskX = mw - 1, maskY = mh - 1;
    const mir = (hash2(mx, my) * 2) | 0;
    let u = wallX * mw;
    if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) u = mw - u;
    if (mir & 1) u = mw - u;
    /* u is constant down the column, so the horizontal texel pair and its weights are solved once
       per ray: that is the part a per-pixel fetch was recomputing. The neighbour wraps with &mask
       instead of comparing to the width, which is the same answer only while every mip width is a
       power of two (T2 = 128 halved to 8). The BASE index is left unmasked so an exact texel
       boundary still reads the texel it always read. */
    const ux = u | 0, fx = u - ux, rfx = 1 - fx, ux1 = (ux + 1) & maskX;
    let mw2 = 0, maskY2 = 0, td2 = null, s2 = 0, ux2 = 0, ux2b = 0, fx2 = 0, rfx2 = 0;
    if (m2) {
      s2 = m2.w / mw; mw2 = m2.w; maskY2 = m2.h - 1; td2 = m2.data;
      const u2 = u * s2; ux2 = u2 | 0; fx2 = u2 - ux2; rfx2 = 1 - fx2; ux2b = (ux2 + 1) & (mw2 - 1);
    }

    /* light on the face: lightmap in the wall cell + lightmap one step out along the normal */
    const nx = side === 0 ? -stepX : 0, ny = side === 1 ? -stepY : 0;
    const inIdx = my * N + mx;
    const lit = lm ? lm[inIdx] : 0.4;
    const litFront = lm ? cellLightAt(mx + 0.5 + nx * 0.6, my + 0.5 + ny * 0.6) : 0;
    const lt = cellTint(inIdx);
    const fall = Math.exp(-perp * 0.16);
    const fk = flashK0 * Math.exp(-perp * 0.30);
    let li = (Math.max(lit, litFront * 0.85) * fall + AMB) * (side === 1 ? 0.78 : 1);
    if (li > 1) li = 1;
    const lr = AMB + (li * lt[0] + fk * flR) * 1.05, lg = AMB + (li * lt[1] + fk * flG) * 1.05, lb = AMB + (li * lt[2] + fk * flB) * 1.05;

    /* The face's real span: it starts being material at the higher of the two floors and runs
       up to the ceiling plane of the air side, (ox,oy). Flat, z0 = 0 and z1 = 1, which makes
       y0/y1 the two expressions this function used to contain, bit for bit. */
    const ox = mx + nx, oy = my + ny;
    const fd = side === 0 ? (nx > 0 ? 0 : 2) : (ny > 0 ? 1 : 3);
    /* z1 is the ground pass's plane, read from the same derived array: two sources of truth made a
       forgotten linkBoundaries() a seam between the passes instead of a failure. Both axes tested
       before the index, and out of map keeps ceilAt's own answer for the void, which is 1. */
    const z0 = riser ? rz0 : faceZ0(ox, oy, fd), z1 = riser ? rz1 : (ox >= 0 && oy >= 0 && ox < N && oy < N ? cp[oy * N + ox] : 1), dz = z1 - z0;
    let y0 = horizon + (eyeZ - z1) * hpx, y1 = horizon + (eyeZ - z0) * hpx;
    const ds = Math.max(0, Math.ceil(y0)), de = Math.min(BH - 1, Math.floor(y1));
    if (!(dz > 0) || ds > de) continue;                    // no face here to draw
    const tstep = mh * dz / (y1 - y0);                     // tiles per world unit, not per face
    let ty = (ds - y0) * tstep, idx = ds * BW + x;
    if (ty >= mh) ty %= mh;                                // v wraps every world unit
    for (let y = ds; y <= de; y++, idx += BW) {
      zbuf[idx] = perp;
      const vy = ty; ty += tstep; if (ty >= mh) ty -= mh;
      const yv = vy | 0, fy = vy - yv, rfy = 1 - fy;
      const rw0 = yv * mw, rw1 = ((yv + 1) & maskY) * mw;
      const t0 = td[rw0 + ux], t1 = td[rw0 + ux1], t2 = td[rw1 + ux], t3 = td[rw1 + ux1];
      const w0 = rfx * rfy, w1 = fx * rfy, w2 = rfx * fy, w3 = fx * fy;
      let cr = (t0 & 255) * w0 + (t1 & 255) * w1 + (t2 & 255) * w2 + (t3 & 255) * w3;
      let cg = (t0 >> 8 & 255) * w0 + (t1 >> 8 & 255) * w1 + (t2 >> 8 & 255) * w2 + (t3 >> 8 & 255) * w3;
      let cb = (t0 >> 16 & 255) * w0 + (t1 >> 16 & 255) * w1 + (t2 >> 16 & 255) * w2 + (t3 >> 16 & 255) * w3;
      // #20: four tests, not a blend of the four. The alpha byte is a flag here (253 = this texel emits
      // light, 255 = ordinary opaque), so blending the corners turns a pixel that merely TOUCHES an
      // emissive texel into 254.x and the branch is missed at fractional coordinates in mip 0 - and now
      // that buildMips carries the flag, a blend is the only way a lit texel can still be missed.
      if ((t0 >>> 24) === 253 || (t1 >>> 24) === 253 || (t2 >>> 24) === 253 || (t3 >>> 24) === 253) {
        px[idx] = 0xFF000000 | clampi(cb * inv + fB) << 16 | clampi(cg * inv + fG) << 8 | clampi(cr * inv + fR);
        continue;
      }
      if (m2) {                                                 // crossfade into the next mip
        const v2 = vy * s2, y2 = v2 | 0, gy2 = v2 - y2, cy2 = 1 - gy2;
        const q0 = y2 * mw2, q1 = ((y2 + 1) & maskY2) * mw2;
        const e0 = td2[q0 + ux2], e1 = td2[q0 + ux2b], e2 = td2[q1 + ux2], e3 = td2[q1 + ux2b];
        const g0 = rfx2 * cy2, g1 = fx2 * cy2, g2 = rfx2 * gy2, g3 = fx2 * gy2;
        cr += (((e0 & 255) * g0 + (e1 & 255) * g1 + (e2 & 255) * g2 + (e3 & 255) * g3) - cr) * wMix;
        cg += (((e0 >> 8 & 255) * g0 + (e1 >> 8 & 255) * g1 + (e2 >> 8 & 255) * g2 + (e3 >> 8 & 255) * g3) - cg) * wMix;
        cb += (((e0 >> 16 & 255) * g0 + (e1 >> 16 & 255) * g1 + (e2 >> 16 & 255) * g2 + (e3 >> 16 & 255) * g3) - cb) * wMix;
      }
      let gk = 1;
      if (grit > 0) {                                          // relief from the screen-space field
        const h0 = DETAIL[(((y + 1) & 63) << 6) | ((x + 1) & 63)], h1 = DETAIL[((y & 63) << 6) | (x & 63)];   // table is 64x64; &31 used a quarter of it at a 32px period
        gk = Math.max(0.25, 1 + (h0 - h1) / 255 * 1.3 * grit);
      }
      px[idx] = 0xFF000000 | clampi(cb * lb * gk + fB) << 16 | clampi(cg * lg * gk + fG) << 8 | clampi(cr * lr * gk + fR);
    }
    pixFilled += (de - ds + 1);

    /* bullet holes / scorch on this face */
    if (perp < dmax && dMask && dMask[my * N + mx]) {
      const gl = dGrid[my * N + mx];
      const hx = camX + rdx * perp, hy = camY + rdy * perp;
      for (let q = 0; q < gl.length; q++) {
        const dc = gl[q];
        if (dc.side !== side + 1) continue;
        const along = side === 0 ? hy - dc.y : hx - dc.x;
        const u = Math.abs(along) / dc.r;
        if (u >= 1) continue;
        const zTop = dc.z + dc.r, zBot = dc.z - dc.r;
        const syTop = Math.max(ds, Math.ceil(horizon + (eyeZ - zTop) * hpx));
        const syBot = Math.min(de, Math.floor(horizon + (eyeZ - zBot) * hpx));
        const dt = dc.tex;
        for (let y = syTop; y <= syBot; y++) {
          const zw = eyeZ - ((y - horizon) / hpx);
          const v = (zw - (dc.z - dc.r)) / (dc.r * 2);
          const du = (along / (dc.r * 2) + 0.5) * dt.w, dv = v * dt.h;
          if (du < 0 || dv < 0 || du >= dt.w || dv >= dt.h) continue;
          const s = dt.data[(dv | 0) * dt.w + (du | 0)], sa = (s >>> 24) / 255 * dc.a * (1 - u * u * 0.5);
          if (sa < 0.02) continue;
          const i = y * BW + x, dst = px[i];
          px[i] = (0xFF000000 |
            (clampi((s & 255) * sa + (dst & 255) * (1 - sa))) |
            (clampi((s >> 8 & 255) * sa + (dst >> 8 & 255) * (1 - sa)) << 8) |
            (clampi((s >> 16 & 255) * sa + (dst >> 16 & 255) * (1 - sa)) << 16)) >>> 0;
        }
      }
    }
    if (riser && SEAM) { seamCrease(x, perp, rz0, rz1, -SEAMD); seamCrease(x, perp, rz1, rz0, SEAMU); }
    else if (crk) seamCrease(x, cT, cA, cB, -SEAMD);
  }
}

/* billboards: same shading, plus a vertical light ramp so feet sit in shadow */
function drawBillboard(o) {
  const dx = o.x - camX, dy = o.y - camY;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const tX = invDet * (dirY * dx - dirX * dy);
  const tY = invDet * (-planeY * dx + planeX * dy);
  if (tY < 0.12) return;
  let hPx = (BH / tY) * o.scale;
  if (hPx < 0.6) return;
  const screenX = (BW * 0.5) * (1 + tX / tY);
  // Cull before rasterizing, not after: a sprite whose quad lands off the buffer is not worth a
  // texture walk. Bodies are never wider than ~1.2x their height, so the box is conservative -
  // it can keep an off-screen sprite, never drop an on-screen one.
  const wide = hPx * 1.2;
  if (screenX + wide * 0.5 < 0 || screenX - wide * 0.5 > BW) return;
  const tex = o.tex;
  const wPx = hPx * (tex.w / tex.h);
  if (screenX + wPx * 0.5 < 0 || screenX - wPx * 0.5 > BW) return;
  const cy = horizon + (BH / tY) * (eyeZ - (o.z + o.scale * 0.5));
  const y0 = Math.ceil(cy - hPx * 0.5), y1 = Math.floor(cy + hPx * 0.5);
  const x0 = Math.ceil(screenX - wPx * 0.5), x1 = Math.floor(screenX + wPx * 0.5);
  const y0c = Math.max(0, y0), y1c = Math.min(BH - 1, y1);
  const x0c = Math.max(0, x0), x1c = Math.min(BW - 1, x1);
  if (y1c < y0c || x1c < x0c) return;
  const fog = fogAt(tY), inv = 1 - fog;
  const fR = FOGC[0] * fog, fG = FOGC[1] * fog, fB = FOGC[2] * fog;
  const idx0 = cellIdx(o.x, o.y);
  const li = Math.min(1, (MAP.light ? MAP.light[idx0] : 0.5) * Math.exp(-tY * 0.14) + 0.30 * visAt(tY));
  const lt = cellTint(idx0);
  const fk = S.flash * Math.exp(-tY * 0.30);
  let lr = AMB + (li * lt[0] + fk * (S.flashCol[0] / 255)) * 1.1;
  let lg = AMB + (li * lt[1] + fk * (S.flashCol[1] / 255)) * 1.1;
  let lb = AMB + (li * lt[2] + fk * (S.flashCol[2] / 255)) * 1.1;
  if (o.dim) { lr *= 1 - o.dim; lg *= 1 - o.dim; lb *= 1 - o.dim; }
  if (o.tint) { lr *= o.tint[0]; lg *= o.tint[1]; lb *= o.tint[2]; }
  let alpha = clamp(o.alpha === undefined ? 1 : o.alpha, 0, 1);
  const selfLit = !!o.self;
  const sxStep = tex.w / wPx, syStep = tex.h / hPx;
  // a texture can be authored denser than the quad it lands in; decimating it with a point
  // sample is what made distant enemies shimmer, so filter when texels outnumber pixels
  const filt = wPx < tex.w * 0.98;
  const flashAdd = o.flash ? 1 : 0;
  drawCalls++;
  const rowBase = (y0c - (cy - hPx * 0.5)) * syStep;
  for (let y = y0c; y <= y1c; y++) {
    const fyt = rowBase + (y - y0c) * syStep;
    const ty = fyt | 0;
    if (ty < 0 || ty >= tex.h) continue;
    /* light ramps down toward the feet and up toward the crown of the head */
    const ramp = selfLit ? 1 : 0.72 + 0.34 * (1 - (ty + (fyt - ty)) / tex.h);
    const rlr = lr * ramp, rlg = lg * ramp, rlb = lb * ramp;
    const rowOff = ty * tex.w;
    const tyf = fyt - ty, row2 = (ty + 1 < tex.h ? ty + 1 : ty) * tex.w;
    const wy1 = 1 - tyf;
    const yoff = y * BW;
    let xf = (x0c - (screenX - wPx * 0.5)) * sxStep;
    for (let x = x0c; x <= x1c; x++, xf += sxStep) {
      // strictly-nearer occluder culls; equal depth draws, which keeps a sprite's own
      // floor-contact row from being clipped by the floor it stands on
      if (zbuf[yoff + x] < tY) continue;
      let src, r2, g2, b2, a2;
      if (filt) {
        let tx = xf | 0;
        if (tx < 0) tx = 0; else if (tx >= tex.w) tx = tex.w - 1;
        const txf = xf - tx, tx2 = tx + 1 < tex.w ? tx + 1 : tx;
        const s00 = tex.data[rowOff + tx], s01 = tex.data[rowOff + tx2];
        const s10 = tex.data[row2 + tx], s11 = tex.data[row2 + tx2];
        const a00 = s00 >>> 24, a01 = s01 >>> 24, a10 = s10 >>> 24, a11 = s11 >>> 24;
        const wa = a00 * wy1 * (1 - txf) + a01 * wy1 * txf + a10 * tyf * (1 - txf) + a11 * tyf * txf;
        if (wa < 8) continue;
        r2 = ((s00 & 255) * a00 * wy1 * (1 - txf) + (s01 & 255) * a01 * wy1 * txf +
          (s10 & 255) * a10 * tyf * (1 - txf) + (s11 & 255) * a11 * tyf * txf) / wa;
        g2 = ((s00 >> 8 & 255) * a00 * wy1 * (1 - txf) + (s01 >> 8 & 255) * a01 * wy1 * txf +
          (s10 >> 8 & 255) * a10 * tyf * (1 - txf) + (s11 >> 8 & 255) * a11 * tyf * txf) / wa;
        b2 = ((s00 >> 16 & 255) * a00 * wy1 * (1 - txf) + (s01 >> 16 & 255) * a01 * wy1 * txf +
          (s10 >> 16 & 255) * a10 * tyf * (1 - txf) + (s11 >> 16 & 255) * a11 * tyf * txf) / wa;
        a2 = wa / 255; src = s00;
      } else {
        let tx = xf | 0;
        if (tx >= tex.w) tx = tex.w - 1;
        src = tex.data[rowOff + tx];
        r2 = src & 255; g2 = src >> 8 & 255; b2 = src >> 16 & 255; a2 = (src >>> 24) / 255;
      }
      if (a2 < 0.016) continue;
      const i = yoff + x, dst = px[i];
      let r, g, b;
      if (selfLit || (src >>> 24) === 253) { r = r2 * inv + fR; g = g2 * inv + fG; b = b2 * inv + fB; }
      else { r = r2 * rlr + fR; g = g2 * rlg + fG; b = b2 * rlb + fB; }
      if (flashAdd) { r += (250 - r) * 0.72; g += (242 - g) * 0.72; b += (236 - b) * 0.72; }
      const A = a2 * alpha;
      // coverage: a billboard is never a character (bodies are meshes since #72), so it stamps 0
      // and erases the body it painted over. One branch, and COV is null in play.
      if (COV) COV[i] = 0;
      if (A > 0.99) { px[i] = (0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r)) >>> 0; continue; }
      const IA = 1 - A;
      px[i] = (0xFF000000 | clampi(r * A + (dst & 255) * IA) | (clampi(g * A + (dst >> 8 & 255) * IA) << 8) |
        (clampi(b * A + (dst >> 16 & 255) * IA) << 16)) >>> 0;
    }
  }
}

/* ------------------------------------------------------------------
   post FX: bloom from the bright pass, lamp glow, film grain
   ------------------------------------------------------------------ */
function drawBloom(q) {
  const bw = Math.max(24, (BW / 3) | 0), bh = Math.max(16, (BH / 3) | 0);
  if (bloomCv.width !== bw || bloomCv.height !== bh) { bloomCv.width = bw; bloomCv.height = bh; }
  bloomCtx.save();
  bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
  if (canFilter) bloomCtx.filter = 'brightness(1.5) contrast(2.1) saturate(1.25)';
  bloomCtx.globalCompositeOperation = 'source-over';
  bloomCtx.globalAlpha = 1;
  bloomCtx.clearRect(0, 0, bw, bh);
  bloomCtx.drawImage(bufCv, 0, 0, bw, bh);
  bloomCtx.filter = 'none';
  bloomCtx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.42;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bloomCv, 0, 0, DW, DH);
  ctx.restore();
}
function drawLightGlow(q) {
  if (!q.glow) return;
  // Budget by lamps actually DRAWN, not by list index. The old `if (n++ > q.glow) break`
  // counted lamps it then skipped for being out of range or behind the camera, so on a
  // lamp-rich level the budget was spent on the first entries of LIGHTS and the lamps the
  // player could see never glowed at all. Nearest-first also spends it where it covers
  // the most screen, and keeps the los() raycasts bounded to what filling the budget needs.
  const cand = [];
  const mrg = DW * 0.25 + 1;                                  // rad is clamped to DW*0.25 on BOTH axes
  for (const L of LIGHTS) {
    const d = Math.hypot(L.x - camX, L.y - camY);
    if (d > 20 || d < 0.35) continue;
    const s = project(L.x, L.y, L.z !== undefined ? L.z : 0.55);   // the light's own altitude; 0.55 is the old hardcoded mid-room float
    if (!s || s.x < -mrg || s.x > DW + mrg || s.y < -mrg || s.y > DH + mrg) continue;
    cand.push([d, L, s]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  let n = 0;
  for (const c of cand) {
    if (n >= q.glow) break;
    const d = c[0], L = c[1], s = c[2];
    if (!los(camX, camY, L.x, L.y)) continue;
    const rad = Math.min(Math.max(10, (BH / s.d) * 0.55 * (DW / BH)), DW * 0.25);   // clamped: unclamped, a lamp at 1 m was a near-full-screen additive fill per lamp per frame
    const k = clamp((L.str || 0.8) * (1 - d / 22), 0, 1) * 0.5;
    const col = L.col || [255, 200, 130];
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad);
    g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${k * 0.7})`);
    g.addColorStop(0.45, `rgba(${col[0] * 0.8 | 0},${col[1] * 0.7 | 0},${col[2] * 0.55 | 0},${k * 0.22})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    // Intersect the fill with the viewport: an additive disc half off-screen used to pay
    // for its hidden half, and the gradient is positioned in canvas space either way.
    const rx = Math.max(0, s.x - rad), ry = Math.max(0, s.y - rad);
    const rw = Math.min(DW, s.x + rad) - rx, rh = Math.min(DH, s.y + rad) - ry;
    if (rw > 0 && rh > 0) ctx.fillRect(rx, ry, rw, rh);
    n++;
  }
  ctx.restore();
}
function drawGrain(q) {
  if (!q.grain || !grainPat) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = q.grain;
  grainSeed = (grainSeed + 1) % 7;
  ctx.translate(-(grainSeed * 13) % 96, -(grainSeed * 29) % 96);
  ctx.fillStyle = grainPat;
  ctx.fillRect(0, 0, DW + 96, DH + 96);
  ctx.restore();
}

/* project a world point to display pixels (for overlay drawing) */
/* project a world point to display pixels (for overlay drawing) */
function project(x, y, z) {
  const dx = x - camX, dy = y - camY;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const tX = invDet * (dirY * dx - dirX * dy), tY = invDet * (-planeY * dx + planeX * dy);
  if (tY < 0.12) return null;
  const sx = (BW * 0.5) * (1 + tX / tY);
  const sy = horizon + (BH / tY) * (eyeZ - z);
  return { x: sx * (DW / BW), y: sy * (DH / BH), d: tY };
}

/* =================== overlay =================== */
function renderOverlay() {
  const q = GQ || QUAL[1];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (q.grade && canFilter) ctx.filter = 'contrast(1.06) saturate(1.12) brightness(1.02)';
  ctx.drawImage(bufCv, 0, 0, DW, DH);
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  if (q.bloom && bloomCv) drawBloom(q);
  drawLightGlow(q);
  const U = DH / 900;
  const cx = DW / 2 + shakeX * 0.5, cy = DH / 2 + shakeY * 0.5;

  /* particles */
  ctx.globalCompositeOperation = 'lighter';
  for (const p of PARTS) {
    const s = project(p.x, p.y, p.z);
    if (!s || s.d > 34) continue;
    const col = BW * (s.x / DW) | 0, prow = clamp(BH * (s.y / DH) | 0, 0, BH - 1);
    if (col < 0 || col >= BW || zbuf[prow * BW + col] < s.d - 0.35) continue;
    const life = p.life / p.max;
    const r = Math.max(1, (p.size * BH / s.d) * (DW / BH) * (0.6 + 0.9 * life));
    ctx.globalAlpha = Math.min(1, life * 1.3) * (p.add ? 0.85 : 0.75);
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 1.6);
    g.addColorStop(0, p.col);
    g.addColorStop(p.add ? 0.5 : 1, p.add ? p.col : 'rgba(0,0,0,0)');
    if (p.add) g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.6, 0, TAU); ctx.fill();
    if (r < 2.2) { ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.fill(); }
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  /* exit marker when open */
  if (S.exitOpen && S.mode === 'play') {
    const s = project(exitX, exitY, 1.15);
    if (s) {
      ctx.globalAlpha = 0.5 + 0.35 * Math.sin(S.t * 5);
      ctx.fillStyle = '#7ff0ff'; ctx.font = `700 ${14 * U}px ui-monospace,monospace`; ctx.textAlign = 'center';
      ctx.fillText('▼ EXIT', clamp(s.x, 40 * U, DW - 40 * U), clamp(s.y, 30 * U, DH - 30 * U));
      ctx.globalAlpha = 1;
    }
  }

  /* muzzle flash light */
  if (S.flash > 0.02) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, DH * 0.85);
    const c = S.flashCol;
    g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${0.20 * S.flash})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, DW, DH);
  }

  if (S.mode === 'title') {
    ctx.fillStyle = 'rgba(4,6,12,.42)'; ctx.fillRect(0, 0, DW, DH);
    ctx.restore();
    return;
  }
  if (P.deadT > 0) {
    ctx.fillStyle = `rgba(90,0,0,${Math.min(0.6, P.deadT * 0.35)})`; ctx.fillRect(0, 0, DW, DH);
  }
  /* damage vignette + low hp */
  const hurt = clamp(P.hurtT / 0.5, 0, 1);
  const lowhp = P.hp < LOW_HP ? (1 - P.hp / LOW_HP) * (0.35 + 0.25 * Math.sin(S.t * 6)) : 0;
  if (hurt > 0.01 || lowhp > 0.01 || P.deadT > 0) {
    const g = ctx.createRadialGradient(DW / 2, DH / 2, DH * 0.25, DW / 2, DH / 2, DH * 0.78);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(190,0,0,${clamp(0.25 * hurt + 0.4 * lowhp + (P.deadT > 0 ? 0.35 : 0), 0, 0.8)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, DW, DH);
  }
  /* ambient vignette */
  const vg = ctx.createRadialGradient(DW / 2, DH / 2, DH * 0.35, DW / 2, DH / 2, DH * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, DW, DH);

  if (P.deadT === 0) drawCrosshair(U, cx, cy);
  drawDamageDirs(U);
  drawGrain(q);
  drawHUD(U);
  if (S.showMap) drawMinimap(U);
  drawFeed(U);
  if (S.bannerT > 0) {
    ctx.globalAlpha = clamp(S.bannerT, 0, 1);
    ctx.textAlign = 'center';
    ctx.font = `800 ${20 * U}px "Segoe UI",system-ui`;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(DW / 2 - 330 * U, DH * 0.15 - 20 * U, 660 * U, 34 * U);
    ctx.fillStyle = '#ffe3c8'; ctx.fillText(S.banner, DW / 2, DH * 0.15 + 5 * U);
    ctx.globalAlpha = 1;
  }
  if (S.perf) {
    ctx.textAlign = 'left'; ctx.font = `600 ${11 * U}px ui-monospace,monospace`; ctx.fillStyle = '#7fe8a0';
    ctx.fillText(`FPS ${S.fps}  buf ${BW}x${BH}  ${q.name}  sprites ${drawCalls}  decals ${DECALS.length}  parts ${PARTS.length}  enemies ${ENEMIES.length}`, 12, DH - 12);
  }
  ctx.restore();
}

/* ---------------- crosshair ---------------- */
function drawCrosshair(U, cx, cy) {
  const w = WEAPONS[P.weapon];
  const spread = (w.spread * (1 - P.ads * 0.55)) * 900 + 6 + Math.min(14, Math.hypot(P.vx, P.vy) * 3);
  const gap = clamp(spread, 5, 34) * U, len = 7 * U, th = Math.max(1, 2 * U);
  ctx.strokeStyle = S.hitMark > 0 ? '#ff7b5a' : (P.mag[P.weapon] === 0 ? '#ff4a4a' : 'rgba(230,245,255,.85)');
  ctx.lineWidth = th; ctx.lineCap = 'round';
  for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + ax * gap, cy + ay * gap); ctx.lineTo(cx + ax * (gap + len), cy + ay * (gap + len));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(cx - th / 2, cy - th / 2, th, th);
  if (S.hitMark > 0) {
    const k = S.hitMark / 0.16, s2 = (10 + (1 - k) * 8) * U;
    ctx.strokeStyle = S.headMark > 0 ? '#ffe06a' : '#ff6a4a'; ctx.lineWidth = 2.4 * U;
    for (const [ax, ay] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      ctx.beginPath(); ctx.moveTo(cx + ax * s2 * 0.4, cy + ay * s2 * 0.4); ctx.lineTo(cx + ax * s2, cy + ay * s2); ctx.stroke();
    }
  }
}
function drawDamageDirs(U) {
  if (!S.dmgDirT || S.dmgDirT <= 0) return;
  const a = S.dmgDir - P.ang + Math.PI, k = clamp(S.dmgDirT / 0.9, 0, 1);
  ctx.save(); ctx.translate(DW / 2, DH / 2 + shakeY * 0.3); ctx.rotate(a);
  ctx.globalAlpha = k * 0.9; ctx.strokeStyle = '#ff3b2a'; ctx.lineWidth = 5 * U; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, DH * 0.22, -0.32, 0.32); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(DH * 0.22, -8 * U); ctx.lineTo(DH * 0.22 + 10 * U, 0); ctx.lineTo(DH * 0.22, 8 * U); ctx.stroke();
  ctx.restore(); ctx.globalAlpha = 1;
}

/* ---------------- weapon viewmodel ----------------
   The gun is GEOMETRY: js/13_mesh.js authors it in metres and rasterizes it into the same buffer as
   the world, with the same projection, the same depth array and the same scene light every body uses.
   It used to be ~200 lines of canvas paths composited into the DISPLAY buffer after bloom, which is
   not the same thing at all: those pixels had no depth, could not be occluded or lit, did not
   foreshorten, and could not be placed in the world the shots travel through.

   SEAT, IN METRES. The rig is one anchor plus one rotation, both derived from the player, so the gun
   is rigid in the view and yet lives in the world the raycaster walks:
     anchor = (P.x, P.y, eyeZ) + M * L,   M = [gun's right | gun's up | bore],
     L = (right offset + bobX, -(drop + bobY + crouch + swap), -recoil travel)
   M's yaw is P.ang TRAILED BY VM.lag (see the look-lag note below: a turn swings the rig about the
   eye, it does not slide it), its pitch is the shot's own, and its third column is the UNIT FIRING
   RAY: (cos rigAng*cos p, sin rigAng*cos p, sin p) with tan p = pitchTan() = aimPx()/BH, which is the
   direction `hitscan` marches (js/30_entities.js:109 uses dx=cos(ang), dy=sin(ang), oz=eyeH(), slope
   tanP). The barrel therefore points where the shot goes, at every pitch and every yaw, and the
   muzzle's perpendicular distance from the shot ray is hypot(Lx, Ly) by construction - row (c) in
   tools/view.js measures it, and reports the one place the two disagree: the shot leaves the eye at
   eyeH() while the picture - and so this rig - is drawn from the CLAMPED eye height (js/40_render.js
   clamps eyeZ into the cell's habitable band), so a shot fired inside a crawlspace leaves from a
   different height than the gun that appears to fire it. That predates this pass and is not fixed here.
   Pitch enters this rig ONCE, as its rotation: the renderer draws pitch as a shift of `horizon`, not
   as a rotation of the projection, and a bore rotated by atan(pitchTan()) lands back on screen centre
   through that shift exactly - which is the property that makes the crosshair mean the muzzle points
   at it, and the property a px-per-pitch sway term would break.

   THE PX-TO-METRES CONVERSION, because the bob and recoil terms below are the art's own numbers and
   re-tuning them would change how the gun MOVES: js/13_mesh.js projects Y = horizon + BH*(eyeZ-z)/ty
   into a buffer upscaled by DH/BH, so a vertical offset of d device px at forward distance t is
   d*t/DH metres, and a lateral one is 2*d*planeLen*t/DW: the device-px part (BW/DW of it is in the
   raster) comes from the canvas, and the metres-per-plane-unit part is PLANELEN, because the horizontal
   field is the camera plane while the vertical field is 2 metres at unit depth. Omitting planeLen was
   the bug this line now documents: it painted 1/planeLen = 1.35x the art's travel at hip and made the
   amount track the field of view (3.1x in ADS, where planeLen is 0.324) instead of the projection.
   Both are evaluated at the gun's mean reach (VMSIT.t), which is exact for a term
   that translates the whole rig and approximate for its rotation.

   DEPTH - THE DECISION: ALWAYS NEAREST, implemented by drawing against a swapped depth array
   (js/13_mesh.js `o.near`) rather than by writing a nearer band. Arithmetic: the gun occupies 0.12 m -
   the rasterizer's own near-plane clip, which is where the forearms run out - to 0.86 m (a full-length
   muzzle flash), while the nearest surface the world can put there is a wall face the player is
   standing inside - perp distance ~0 - which the wall pass writes into zbuf as ~0, and the occlusion
   rule is the rasterizer's `if (occ < z) continue`. Against that value a test would cull the gun
   whenever the player hugs a corner, and against zbuf's other sentinel - 0 in columns where no wall
   was hit, which already silently culls billboards - a test would punch holes in the sky. Neither is a
   foreground object the gun must respect, and the art this replaced composited over everything, so
   "always nearest" is also the parity choice. Writing a *nearer* band instead would additionally make
   every later sprite/particle test fail against the gun, which is wrong in particular for the
   particles renderOverlay draws after this buffer is composited.

   It cannot punch a hole in legitimate foreground because the swap is DIRECTIONAL: the frame's zbuf is
   neither read nor written while the view model draws, so the frame's depth is exactly what it was and
   only these pixels' TEST is disabled. The scratch is not an all-Infinity void either - it is a real
   depth buffer for the gun's own 60 parts, cleared over the rectangle the previous frame's rig wrote.
   Self-occlusion has to stay on: the gun is boxes and open tubes whose faces overlap in screen space,
   and a draw that orders them by emit order is a draw whose correctness depends on which part happened
   to be authored first (the art's fixed order only worked because a vector painter cannot put the far
   wall of a barrel in front of the near one). What the gun legitimately covers is anything closer than
   the muzzle - a grunt's face pressed against the bore, which is what it should hide.

   LIGHT: the multiply is the world's own (AMB + li*lt*sh) at the PLAYER's cell, so a dark room darkens
   the gun, and two readability terms are applied because a mesh has no painted gradient to lean on -
   VMFLOOR floors the MULTIPLIER at 0.5, which is the 2-D art's own dark-room value (`0.5 + 0.5*cellLi`),
   and VMRIM adds `RIMC*(1-|N.V|)` in OUTPUT space, never as a multiplier: the albedo averages 30..58,
   so multiplying it cannot brighten anything (AGENTS, #17). Both are module globals so the probe can
   A/B them to numbers; both are measured in row (d). */
const VMSIT = {
  f: 0.245, r: 0.105, d: 0.115,      // hip: the grip top, metres forward / right / BELOW the eye
  af: 0.190, ar: 0.016, ad: 0.034,   // shouldered: on the centre line, and the SIGHT line at eye height
  t: 0.30,                           // the reach the device-px terms above are converted at
};
let VMFLOOR = 0.5, VMRIM = 0.08;     // the two readability terms - see row (d)
const VMROT = new Float32Array(9);
/* The rig's world anchor, published for the probes the way VM's sway state already is: row (c) puts
   the muzzle on the firing ray from here plus VMROT's third column and MESH.muzzleFor(kind), so the
   claim about the barrel is arithmetic over numbers the frame actually used, not a re-derivation. */
const VMPOS = new Float32Array(3);

function drawViewModel() {
  const w = WEAPONS[P.weapon], ads = P.ads, k = P.kick;
  const dt = Math.min(0.05, Math.max(0.0005, (VM.now = performance.now(), (VM.now - (VM.t || performance.now())) / 1000)));
  VM.t = VM.now;
  // look-rate sway: the gun lags the camera instead of being welded to it
  let dAng = P.ang - (VM.ang !== undefined ? VM.ang : P.ang);
  while (dAng > Math.PI) dAng -= TAU; while (dAng < -Math.PI) dAng += TAU;
  VM.ang = P.ang;
  const aim = 1 - ads * 0.8;
  /* Look lag, in the rig's OWN unit. The art kept this as a screen-space slide (`VM.vx`, device px,
     added to the anchor) because a canvas-path gun has no heading to lag - and the same term applied
     to a world-seated rig is not the same physics: a px slide does not depend on where the geometry
     is, so it cannot be checked against the projection at all. Here a turn trails the gun's HEADING
     behind the camera's by VM.lag radians, which rotates the whole rig about the eye and therefore
     moves each part by its own perspective amount - row (b) in tools/view.js measures that against
     the projection and fails a build whose gun is welded to the display buffer. At the art's own
     ceiling (a 6 rad/s whip) the trail is 0.05 rad = 3 deg, which displaces the muzzle by ~45 device
     px: the same order the art's 10 px slide had at the grip, larger at the barrel because the
     barrel is further away. The gun no longer slides sideways when you turn; it swings.
     PITCH IS NOT A SWAY TERM. The art also damped a pitch-RATE term into VM.vy to stop a screen-space
     gun from staying put while the picture slid past it; that compensation is the reason it existed,
     and a rig that carries the pitch in its own rotation is already doing the same job exactly. Left
     in, it was a pitch measurement in the wrong unit - device px of look-delta - smuggled into metres
     of world offset, so looking up fast made the gun SINK IN THE WORLD. What survives is the vertical
     VELOCITY term: the body's own rise and fall, which the rig cannot know from its seat. */
  VM.lag = damp(VM.lag || 0, clamp(-dAng / dt, -6, 6) * 0.0083 * aim, 9, dt);
  VM.vy = damp(VM.vy || 0, (P.vz || 0) * 4 * (DH / 900) * aim, 8, dt);
  const mv = P.moving() ? 1 : 0, sp = P.sprint ? 1 : 0;
  const bobX = Math.sin(P.bobPhase) * (9 + 9 * sp) * (DH / 900) * mv * aim;
  const bobY = Math.abs(Math.cos(P.bobPhase)) * (7 + 9 * sp) * (DH / 900) * mv * aim - (P.air ? 6 * (DH / 900) : 0);
  const rl = P.reloadT > 0 ? clamp(1 - P.reloadT / w.reload, 0, 1) : P.reloadT > -0.01 ? 1 : 0;
  const swap = P.swapT > 0 ? P.swapT / 0.34 : 0;
  const mz = Math.max(0, S.muzzle || 0);
  const MPPY = VMSIT.t / DH, MPPX = 2 * planeLen * VMSIT.t / DW;   // see the header: metres per device pixel

  // reload choreography: magazine out, replacement in, action cycled - the art's own staging, and
  // every term below is now a TRANSFORM of the rig rather than a translation of a screen anchor
  let magOut = 0, slideBack = 0, shellIn = 0, pump = 0, rlDrop = 0, rlRoll = 0;
  if (rl > 0 && rl < 1) {
    const t = rl;
    if (w.kind === 'shotgun') {
      shellIn = t < 0.45 ? Math.sin(t / 0.45 * Math.PI) : 0;
      pump = t > 0.45 && t < 0.8 ? Math.sin((t - 0.45) / 0.35 * Math.PI) : 0;
      slideBack = t > 0.8 ? Math.sin((t - 0.8) / 0.2 * Math.PI) * 0.5 : 0;
    } else if (w.kind === 'rifle') {
      magOut = t < 0.34 ? Math.sin(t / 0.34 * Math.PI) : 0;
      slideBack = t > 0.72 ? Math.sin((t - 0.72) / 0.28 * Math.PI) : 0;
    } else {
      magOut = t < 0.42 ? Math.sin(t / 0.42 * Math.PI) : 0;
      slideBack = t > 0.66 ? Math.sin((t - 0.66) / 0.34 * Math.PI) : 0;
    }
    rlDrop = (magOut * 26 + shellIn * 44 + pump * 16) * (DH / 900);
    rlRoll = magOut * 0.05 - shellIn * 0.03;
  } else if (P.reloadT > 0) { rlDrop = 34 * (DH / 900); }

  // the rotation: yaw from P.ang trailed by the look lag, pitch from the shot's own slope, roll from
  // the swing and the walk
  const p = Math.atan(pitchTan());
  const rigAng = P.ang + VM.lag;
  const roll = -(VM.lag * 0.07 + (P.moving() ? Math.sin(P.bobPhase) * 0.012 * (0.4 + 0.6 * sp) : 0) + k * 0.0011 + rlRoll);
  const ca = Math.cos(rigAng), sa = Math.sin(rigAng), cp = Math.cos(p), sp2 = Math.sin(p), cr = Math.cos(roll), sr = Math.sin(roll);
  // columns: the player's right, the gun's up, the bore = the unit firing ray (see the header)
  const rx = -sa, ry = ca, rz = 0, ux = -ca * sp2, uy = -sa * sp2, uz = cp, bx = ca * cp, by = sa * cp, bz = sp2;
  const X0 = rx * cr + ux * sr, X1 = ry * cr + uy * sr, X2 = rz * cr + uz * sr;
  const Y0 = -rx * sr + ux * cr, Y1 = -ry * sr + uy * cr, Y2 = -rz * sr + uz * cr;
  VMROT[0] = X0; VMROT[1] = Y0; VMROT[2] = bx;
  VMROT[3] = X1; VMROT[4] = Y1; VMROT[5] = by;
  VMROT[6] = X2; VMROT[7] = Y2; VMROT[8] = bz;

  // the local anchor, in the gun's own frame: metres right / up / forward of the eye
  const Lx = VMSIT.r + (VMSIT.ar - VMSIT.r) * ads + bobX * MPPX * (1 - ads * 0.6);
  const Ly = -(VMSIT.d + (VMSIT.ad - VMSIT.d) * ads) - (bobY + VM.vy + k * 1.5 * (DH / 900) + swap * 300 * (DH / 900) +
    P.crouch * 13 * (DH / 900) - ads * DH * 0.05 + rlDrop) * MPPY;
  const Lz = VMSIT.f + (VMSIT.af - VMSIT.f) * ads - k * 0.0016;      // recoil travels the gun straight back
  const ax = P.x + X0 * Lx + Y0 * Ly + bx * Lz;
  const ay = P.y + X1 * Lx + Y1 * Ly + by * Lz;
  const az = eyeZ + X2 * Lx + Y2 * Ly + bz * Lz;
  VMPOS[0] = ax; VMPOS[1] = ay; VMPOS[2] = az;

  MESH.draw({
    mdl: MESH.weapon(w.kind, { mz, magOut, slideBack, pump, shellIn }),
    x: ax, y: ay, z: az, rot: VMROT,
    near: true,                       // the depth decision, stated in the header
    body: 0,                          // NOT a body: COV must stay 0 under the gun (#183) - contrast
                                      // measures bodies, and this paints over them
    cell: cellIdx(P.x, P.y),          // the room you are IN, not the wall the muzzle points at
    floor: VMFLOOR, rim: VMRIM,
  });
}

/* ---------------- HUD ---------------- */
function drawHUD(U) {
  const pad = 22 * U, baseY = DH - pad;
  ctx.textBaseline = 'alphabetic';
  /* health / armor */
  const bw = 250 * U, bh = 16 * U;
  const hpw = clamp(P.hp / 100, 0, 1);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 10 * U;
  ctx.fillStyle = 'rgba(6,10,16,.72)'; ctx.fillRect(pad - 6 * U, baseY - bh * 3.3, bw + 12 * U, bh * 3.3 + 12 * U);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(pad, baseY - bh * 2.2, bw, bh);
  ctx.fillStyle = hpw > 0.6 ? '#4fd06a' : hpw > 0.3 ? '#e0b23c' : '#e0452f';
  ctx.fillRect(pad, baseY - bh * 2.2, bw * hpw, bh);
  ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(pad, baseY - bh * 1.05, bw, bh * 0.7);
  ctx.fillStyle = '#3ea0ff'; ctx.fillRect(pad, baseY - bh * 1.05, bw * clamp(P.armor / 100, 0, 1), bh * 0.7);
  ctx.font = `800 ${34 * U}px "Segoe UI",system-ui`; ctx.textAlign = 'left';
  ctx.fillStyle = hpw < 0.3 ? '#ff8a6a' : '#e9f2fb';
  ctx.fillText(String(Math.max(0, Math.ceil(P.hp))).padStart(3, '0'), pad, baseY - bh * 2.55);
  ctx.font = `600 ${11 * U}px ui-monospace,monospace`; ctx.fillStyle = '#8fa6bf';
  ctx.fillText('VITALS', pad + 96 * U, baseY - bh * 2.7);
  ctx.fillText('ARMOR ' + Math.round(P.armor), pad + 96 * U, baseY - bh * 1.35);

  /* ammo */
  const w = WEAPONS[P.weapon];
  ctx.textAlign = 'right';
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 10 * U;
  ctx.fillStyle = 'rgba(6,10,16,.72)'; ctx.fillRect(DW - pad - 240 * U, baseY - bh * 3.3, 240 * U, bh * 3.3 + 12 * U);
  ctx.restore();
  const magPct = P.mag[P.weapon] / w.mag;
  ctx.font = `800 ${40 * U}px ui-monospace,Menlo,monospace`;
  ctx.fillStyle = P.mag[P.weapon] === 0 ? '#ff5a4a' : (magPct < 0.34 ? '#ffbe6a' : '#eaf3fd');
  ctx.fillText(String(P.mag[P.weapon]).padStart(2, '0'), DW - pad - 74 * U, baseY - bh * 0.35);
  ctx.font = `700 ${20 * U}px ui-monospace,monospace`; ctx.fillStyle = '#8fa6bf';
  ctx.fillText('/' + P.reserve[P.weapon], DW - pad, baseY - bh * 0.35);
  ctx.font = `700 ${12 * U}px ui-monospace,monospace`; ctx.fillStyle = '#ff9a5a';
  ctx.fillText(w.name, DW - pad, baseY - bh * 2.6);
  ctx.fillStyle = '#7f93ac';
  ctx.fillText('GL ' + P.gren + '   ' + (P.reloadT > 0 ? 'RELOADING' : (P.mag[P.weapon] ? 'READY' : 'PRESS R')), DW - pad, baseY - bh * 1.6);
  if (P.reloadT > 0) {
    const pr = 1 - P.reloadT / w.reload;
    ctx.fillStyle = 'rgba(255,160,80,.85)'; ctx.fillRect(DW - pad - 240 * U, baseY - bh * 1.45, 240 * U * pr, 3 * U);
  }
  /* weapon slots */
  ctx.textAlign = 'right';
  for (let i = 0; i < WEAPONS.length; i++) {
    const on = i === P.weapon;
    const y = baseY - bh * (3.9 + (WEAPONS.length - 1 - i) * 0.85);
    ctx.font = `700 ${12 * U}px ui-monospace,monospace`;
    ctx.fillStyle = on ? '#ffd9b0' : 'rgba(150,170,195,.55)';
    ctx.fillText((i + 1) + '  ' + WEAPONS[i].name + (on ? '  ' + P.mag[i] + '/' + P.reserve[i] : ''), DW - pad, y);
  }

  /* objective */
  const left = enemiesLeft();
  ctx.textAlign = 'center';
  ctx.font = `700 ${13 * U}px ui-monospace,monospace`;
  ctx.fillStyle = 'rgba(150,175,205,.9)';
  const obj = S.exitOpen ? 'EXIT PORTAL ONLINE — GET THERE' : 'ELIMINATE HOSTILES';
  ctx.fillText(obj, DW / 2, pad + 16 * U);
  ctx.font = `800 ${26 * U}px ui-monospace,monospace`;
  ctx.fillStyle = S.exitOpen ? '#7ff0ff' : (left < 4 ? '#ffb04a' : '#ffdcc0');
  ctx.fillText(S.exitOpen ? LEVELS[S.level].name : left + ' LEFT', DW / 2, pad + 44 * U);
  if (S.exitOpen) {
    // compass arrow toward exit
    const a = Math.atan2(exitY - P.y, exitX - P.x) - P.ang;
    ctx.save(); ctx.translate(DW / 2, pad + 74 * U); ctx.rotate(a); ctx.translate(-22 * U, 0);
    ctx.fillStyle = '#7ff0ff'; ctx.beginPath(); ctx.moveTo(22 * U, 0); ctx.lineTo(4 * U, -8 * U); ctx.lineTo(8 * U, 0); ctx.lineTo(4 * U, 8 * U); ctx.closePath(); ctx.fill();
    ctx.restore();
    const d = Math.hypot(exitX - P.x, exitY - P.y);
    ctx.fillStyle = 'rgba(127,240,255,.8)'; ctx.font = `700 ${11 * U}px ui-monospace,monospace`;
    ctx.fillText(d.toFixed(1) + 'm', DW / 2 + 46 * U, pad + 78 * U);
  }
  ctx.textAlign = 'left';
  ctx.font = `600 ${11 * U}px ui-monospace,monospace`; ctx.fillStyle = 'rgba(120,145,175,.75)';
  const mm = Math.floor(S.runT / 60), ss = Math.floor(S.runT % 60);
  ctx.fillText(`${LEVELS[S.level].name}  ·  T+${mm}:${String(ss).padStart(2, '0')}  ·  ACC ${P.shots ? Math.round(P.hits / P.shots * 100) : 0}%`, pad, pad + 14 * U);
}

function drawFeed(U) {
  ctx.textAlign = 'right';
  const y0 = DH * 0.31;
  for (let i = 0; i < feed.length; i++) {
    const f = feed[i];
    ctx.globalAlpha = clamp(f.t / 0.6, 0, 1);
    ctx.font = `700 ${12 * U}px ui-monospace,monospace`;
    ctx.fillStyle = 'rgba(4,8,14,.5)'; ctx.fillRect(DW - 20 * U - 230 * U, y0 + i * 18 * U, 230 * U, 15 * U);
    ctx.fillStyle = f.col; ctx.fillText(f.text, DW - 26 * U, y0 + 12 * U + i * 18 * U);
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

let mmLayer = null, mmCtx = null, mmKey = '', mmRevealed = -1, mmBuild = -1;
/* Minimap band cue (#164): an air cell's ink carries which floor it is on, relative to the level's
   modal band (MAP.fzBase). Index 0 is the colour this function used before the cue existed, so a flat
   level maps every cell there and paints exactly what it painted then; only a stepped level adds ink,
   and a staircase reads as a run of cells going lighter while a pit reads as warming away from you. */
const MMBAND = ['rgba(120,74,46,.9)', 'rgba(110,69,45,.9)', 'rgba(99,64,44,.9)', 'rgba(86,60,44,.9)',
  'rgba(28,48,70,.9)',
  'rgba(52,96,120,.9)', 'rgba(68,122,148,.9)', 'rgba(86,148,174,.9)', 'rgba(108,178,204,.9)'];
function drawMinimap(U) {
  const size = Math.min(DW * 0.2, DH * 0.24), pad = 18 * U;
  const x0 = DW - size - pad, y0 = pad + 6 * U, s = size / Math.max(MW, MH);
  const key = MW + 'x' + MH + '|' + (size | 0);
  if (!mmLayer) { mmLayer = document.createElement('canvas'); mmCtx = mmLayer.getContext('2d'); }
  if (key !== mmKey || S.revealed < mmRevealed || (S.revealed !== mmRevealed && S.t - mmBuild > 0.25) || mmLayer.width !== (size | 0)) {
    mmLayer.width = size | 0; mmLayer.height = size | 0;
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.fillStyle = 'rgba(5,9,15,.92)'; mmCtx.fillRect(0, 0, size, size);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      if (!explored[y * MW + x]) continue;
      const ci = y * MW + x;
      mmCtx.fillStyle = MAP.cell[ci] !== 0 ? 'rgba(126,156,192,.5)'
        : MMBAND[4 + Math.max(-4, Math.min(4, (MAP.fz[ci] | 0) - (MAP.fzBase | 0)))];
      mmCtx.fillRect(x * s, y * s, s + 0.75, s + 0.75);
    }
    mmKey = key; mmRevealed = S.revealed; mmBuild = S.t;
  }
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(4,7,12,.72)'; ctx.fillRect(x0 - 4 * U, y0 - 4 * U, size + 8 * U, size + 8 * U);
  ctx.drawImage(mmLayer, x0, y0, size, size);
  ctx.strokeStyle = 'rgba(120,150,180,.35)'; ctx.lineWidth = 1; ctx.strokeRect(x0 - 4 * U, y0 - 4 * U, size + 8 * U, size + 8 * U);
  // pickups
  for (const k of PICKUPS) {
    if (k.dead || !explored[(k.y | 0) * MW + (k.x | 0)]) continue;
    ctx.fillStyle = k.type === 'health' ? '#5ce07a' : k.type === 'armor' ? '#4ab0ff' : '#ffcf6a';
    ctx.fillRect(x0 + k.x * s - 1.5 * U, y0 + k.y * s - 1.5 * U, 3 * U, 3 * U);
  }
  // enemies (visible / close)
  for (const e of ENEMIES) {
    if (e.state === 'dead') continue;
    const d = Math.hypot(e.x - P.x, e.y - P.y);
    if (d > 14 || !los(e.x, e.y, P.x, P.y)) continue;
    ctx.fillStyle = e.alert ? '#ff5a3c' : 'rgba(255,110,70,.55)';
    ctx.beginPath(); ctx.arc(x0 + e.x * s, y0 + e.y * s, Math.max(1.6, s * 0.5), 0, TAU); ctx.fill();
  }
  // exit
  ctx.fillStyle = S.exitOpen ? '#7ff0ff' : 'rgba(120,140,160,.6)';
  ctx.beginPath(); ctx.arc(x0 + exitX * s, y0 + exitY * s, Math.max(2, s * 0.7), 0, TAU); ctx.fill();
  // player
  ctx.save();
  ctx.translate(x0 + P.x * s, y0 + P.y * s); ctx.rotate(P.ang);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(s * 1.4, 0); ctx.lineTo(-s * 0.8, -s * 0.8); ctx.lineTo(-s * 0.4, 0); ctx.lineTo(-s * 0.8, s * 0.8); ctx.fill();
  ctx.restore();
  ctx.textAlign = 'left'; ctx.font = `600 ${10 * U}px ui-monospace,monospace`; ctx.fillStyle = 'rgba(140,170,200,.7)';
  ctx.fillText('M · MAP', x0, y0 + size + 14 * U);
  ctx.restore();
}
