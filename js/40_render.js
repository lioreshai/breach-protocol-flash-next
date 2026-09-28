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
let bloomCv = null, bloomCtx = null, canFilter = false, grainCv = null, grainPat = null, grainSeed = 0;
let FARB = 22, AMB = 0.13, GQ = null;
let G_TRI = false, G_GRIT = 0;                                  // derived from QUAL.rast
/* The wall bilinear fetch is inlined at its one call site below rather than factored into a
   function that writes its result into a scratch array: a module-global typed-array out-param
   blocks V8 inlining and register allocation, and the same code inlined measured 21 -> 12 ms
   near a wall. It is inlined here and nowhere else, so the pass that keeps the registers is this
   one, and any new caller must inline it too rather than reach for a shared helper. */
// viewmodel spring state: sway lag, previous look angle, eject timing
const VM = { vx: 0, vy: 0, ang: 0, pitch: 0, t: 0 };

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
  // Ceiling rows keep the sentinel: their plane solve ignores walls, and rigs/portal quads are
  // authored taller than the one-unit room, so clipping on it would repaint today's picture.
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
    });
  }
  /* ground decals first: they lie on the floor and must not paint over feet */
  for (const b of list) { const dx = b.x - camX, dy = b.y - camY; b.d2 = dx * dx + dy * dy; }
  list.sort((a, b) => b.d2 - a.d2);
  for (const b of list) { if (b.mesh) MESH.draw(b); else drawBillboard(b); }

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

function castGround(flash, fcR, fcG, fcB) {
  const hInt = Math.round(horizon);
  const stepBase = 2 / BW;
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light, fzs = MAP.fz, cp = MAP.ceilPlane;
  const floorTex = MAP.floorTex || FLOORS.CONCRETE, ceilTex = MAP.ceilTex || CEILS.CONCRETE;
  const tileF = MAP.floorTile || 1.15, tileC = MAP.ceilTile || 0.9;
  const dMasks = DECAL_MASK, dGrid = DECAL_GRID;
  const amb = AMB, fl = flash;
  /* Scratch for the columns of one row that had to be re-solved off the row's plane. Sized to a
     row because a row is all a frame can ever queue; in a flat level nothing is ever written. */
  if (RX.length < BW) { RX = new Int32Array(BW); RP = new Float64Array(BW); }
  for (let y = 0; y < BH; y++) {
    const p = y - hInt;
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
      zbuf.fill(isF ? dRaw : Infinity, y * BW, y * BW + BW);   // depth = the row's own solve, unclamped
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
       dragged in from 300 m. Ceiling rows keep the Infinity sentinel on purpose (issue #45).
       Columns this row cannot solve are queued below and get their own depth in groundPixel(). */
    zbuf.fill(isF ? dRaw : Infinity, row, row + BW);
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

/* One pixel whose cell is not on the row's plane. d comes from that plane through the same
   expression the row uses with the plane swapped in, the position comes from d, and the cell the
   position lands in has to agree with the plane that produced it: three tries settle every pixel
   that can be settled. The lip of a step can oscillate - both answers are defensible there - and
   the plane it started from wins, so an unsolvable pixel never reveals a room behind the wall you
   are looking at. d is clamped to the row's reach before it is USED, exactly as the row clamps its
   own, so a plane two units up cannot drag a texel from 300 metres away.
   The shading below is the SECOND copy of the ground pixel body: it must change with the loop in
   castGround, not instead of it. The split is what lets that loop hold its mip, fog and light in
   registers - measured at 2.5 ms of a 1202x676 frame - and this function runs on no pixel of a
   flat level, which is why `scene` md5s and `heights` both have to stay green to trust either. */
function groundPixel(x, pl, row, isF, absP, tex, sc, fcR, fcG, fcB, fl, amb, dP) {
  const N = MAP.w, cellArr = MAP.cell, lm = MAP.light, stepBase = 2 / BW;
  const cam = x * stepBase - 1, rx = dirX + planeX * cam, ry = dirY + planeY * cam;
  let dS = 0, ax = (camX + rx * dP) | 0, ay = (camY + ry * dP) | 0, settled = false;
  for (let g = 0; g < 3; g++) {
    const dz = isF ? eyeZ - pl : pl - eyeZ;
    dS = dz * BH / absP;
    if (dS > FARB * 4) dS = FARB * 4;
    const qx = (camX + rx * dS) | 0, qy = (camY + ry * dS) | 0;
    const mx = (qx + ax) >> 1, my = (qy + ay) >> 1;
    // a plane may only come from a column within two cells on BOTH axes with no solid column between
    let plN = pl;
    if (qx >= 0 && qy >= 0 && qx < N && qy < N && Math.abs(qx - ax) <= 2 && Math.abs(qy - ay) <= 2 &&
      mx >= 0 && my >= 0 && mx < N && my < N && !cellArr[my * N + mx]) {
      const ii = qy * N + qx;
      if (!cellArr[ii]) {
        const t = isF ? MAP.fz[ii] * ZQ : MAP.ceilPlane[ii];
        if (isF ? t < eyeZ : t > eyeZ) plN = t;
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
    const dz = isF ? eyeZ - pl : pl - eyeZ;
    dS = dz * BH / absP;
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

/* ------------------------------------------------------------------
   walls: DDA + coloured light + face shading + decals
   ------------------------------------------------------------------ */
function castWalls(flash, fcR, fcG, fcB) {
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light, cp = MAP.ceilPlane;
  const fzs = MAP.fz, vbs = MAP.vb, doStep = MAP.steps ? 1 : 0;      // #100: 0 on every flat level
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
    let tv = 0, guard = 0, riser = 0, rz0 = 0, rz1 = 1;
    while (guard++ < 180) {
      if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
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
         its crown instead of vanishing. `tv` is the material of a riser: the exposed edge of a
         floor, so it wears the concrete of the floor family rather than the room's wall. Flat levels
         never reach this test - MAP.steps is 0 - so a flat frame stays bit-identical. */
      if (doStep) {
        const d = side === 0 ? (stepX > 0 ? 0 : 2) : (stepY > 0 ? 1 : 3);
        const pi = (my - (side === 1 ? stepY : 0)) * N + (mx - (side === 0 ? stepX : 0));
        const dq = fzs[my * N + mx] - fzs[pi];
        if ((dq > 1 || dq < -1) && !(vbs[pi] & ((VB_RAMP | VB_LADDER) << (d << 2)))) {
          const fhi = dq > 0 ? fzs[my * N + mx] : fzs[pi], flo = dq > 0 ? fzs[pi] : fzs[my * N + mx];
          riser = 1; rz0 = flo * ZQ; rz1 = fhi * ZQ; tv = WT.CONCRETE; break;
        }
      }
    }
    let perp = side === 0 ? sdx - ddx : sdy - ddy;
    if (!(perp > 0.0001)) perp = 0.0001;
    if (tv === 0 || perp > FARB * 3) continue;
    const tex = WALLS[(tv - 1) % WALLS.length];
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
      if ((((t0 >>> 24) * w0 + (t1 >>> 24) * w1 + (t2 >>> 24) * w2 + (t3 >>> 24) * w3) | 0) === 253) {
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
  drawViewModel(U);

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

/* ---------------- weapon viewmodel ---------------- */
function drawViewModel(U) {
  const w = WEAPONS[P.weapon], ads = P.ads, k = P.kick;
  const dt = Math.min(0.05, Math.max(0.0005, (VM.now = performance.now(), (VM.now - (VM.t || performance.now())) / 1000)));
  VM.t = VM.now;
  // look-rate sway: the gun lags the camera instead of being welded to it
  let dAng = P.ang - (VM.ang !== undefined ? VM.ang : P.ang);
  while (dAng > Math.PI) dAng -= TAU; while (dAng < -Math.PI) dAng += TAU;
  VM.ang = P.ang;
  const aim = 1 - ads * 0.8;
  VM.vx = damp(VM.vx || 0, clamp(-dAng / dt, -6, 6) * 2.2 * U * aim, 9, dt);
  VM.vy = damp(VM.vy || 0, clamp(-(P.pitch - (VM.pitch || P.pitch)) / dt, -3000, 3000) * U * 0.010 * aim + (P.vz || 0) * 4 * U * aim, 8, dt);
  VM.pitch = P.pitch;
  const mv = P.moving() ? 1 : 0, sp = P.sprint ? 1 : 0;
  const bobX = Math.sin(P.bobPhase) * (9 + 9 * sp) * U * mv * aim;
  const bobY = Math.abs(Math.cos(P.bobPhase)) * (7 + 9 * sp) * U * mv * aim - (P.air ? 6 * U : 0);
  const rl = P.reloadT > 0 ? clamp(1 - P.reloadT / w.reload, 0, 1) : P.reloadT > -0.01 ? 1 : 0;
  const swap = P.swapT > 0 ? P.swapT / 0.34 : 0;
  const cellLi = MAP && MAP.light ? Math.min(1, MAP.light[cellIdx(P.x, P.y)] || 0) : 0;
  const mz = Math.max(0, S.muzzle || 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // the weapon is held close: a foreshortened receiver spans a third of the view,
  // not the 8% a 1:1 design-space authoring pass produces
  const SC9 = DH / 900, sc = SC9 * 1.5 * (1 - ads * 0.06);
  // anchor: hip pose vs shouldered pose, then the reload / swap choreography on top
  let ox = DW * (0.5 + 0.155 * (1 - ads)) + (VM.vx + bobX) * (1 - ads * 0.6);
  let oy = DH + 6 * SC9 + bobY + VM.vy + k * 1.5 * SC9 + swap * 300 * SC9 + P.crouch * 13 * SC9 - ads * DH * 0.05;
  let tilt = (VM.vx * 0.00035 + (P.moving() ? Math.sin(P.bobPhase) * 0.012 * (0.4 + 0.6 * sp) : 0) - ads * 0.0) * (1 - ads);
  // reload choreography: magazine out, replacement in, action cycled, all per weapon family
  let rlStage = 0, magOut = 0, slideBack = 0, shellIn = 0, pump = 0;
  if (rl > 0 && rl < 1) {
    rlStage = rl;
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
    oy += (magOut * 26 + shellIn * 44 + pump * 16) * SC9;
    tilt += magOut * 0.05 - shellIn * 0.03;
  } else if (P.reloadT > 0) { oy += 34 * SC9; }
  ctx.translate(ox, oy);
  ctx.scale(sc, sc);
  ctx.rotate(tilt + k * 0.0011);

  // everything below is authored in a 900-unit design space, +y down, origin at the muzzle base
  const grd = (x0, y0, x1, y1, stops) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    return g;
  };
  const lit = (base, up) => {
    const m = 0.5 + 0.5 * cellLi + mz * 1.5;
    const c = [parseInt(base.slice(1, 3), 16), parseInt(base.slice(3, 5), 16), parseInt(base.slice(5, 7), 16)];
    return '#' + c.map(v => {
      const t2 = Math.max(0, Math.min(255, Math.round(v * m + (up ? 26 * up : 0))));
      return (t2 < 16 ? '0' : '') + t2.toString(16);
    }).join('');
  };
  const rrect = (x, y, ww, hh, r) => {
    const rr = Math.min(r, Math.abs(ww) / 2, Math.abs(hh) / 2);
    ctx.beginPath(); ctx.moveTo(x + rr, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, rr); ctx.arcTo(x + ww, y + hh, x, y + hh, rr);
    ctx.arcTo(x, y + hh, x, y, rr); ctx.arcTo(x, y, x + ww, y, rr); ctx.closePath(); ctx.fill();
  };
  const metal = (x, y, ww, hh, r, col, ang) => {
    ctx.save(); ctx.translate(x, y); if (ang) ctx.rotate(ang);
    ctx.fillStyle = grd(0, -hh * 0.5, 0, hh * 0.5, [[0, lit(col, 1)], [0.42, lit(col, 0.35)], [0.62, lit('#0e1116')], [1, lit('#05070a')]]);
    rrect(0, -hh * 0.5, ww, hh, r);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.05 + 0.13 * mz + 0.05 * cellLi) + ')';
    rrect(ww * 0.06, -hh * 0.44, ww * 0.88, hh * 0.16, hh * 0.08);
    ctx.restore();
  };
  // a hand: palm, four fingers curled round the grip, thumb, knuckle ridge, cuff
  const hand = (x, y, s, back, gripAng) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(gripAng || 0); ctx.scale(s, s);
    const skin = lit('#8c6a4f'), skinD = lit('#5d452f'), glove = lit('#3b424e'), gloveD = lit('#222834');
    ctx.fillStyle = grd(-26, -20, 26, 26, [[0, glove], [0.7, gloveD], [1, lit('#171c26')]]);
    rrect(back ? 6 : -34, 16, 30, 40, 9);                            // cuff
    ctx.fillStyle = grd(-24, -22, 24, 24, [[0, skin], [0.55, skinD], [1, lit('#3a2b1e')]]);
    rrect(back ? -4 : -30, -14, 34, 34, 11);                          // palm/back of hand
    ctx.fillStyle = grd(0, -20, 0, 22, [[0, skin], [1, skinD]]);
    for (let f = 0; f < 4; f++) {                                     // fingers wrapping the grip
      const fy = -10 + f * 8.2, curl = 0.55 + 0.16 * f + slideBack * 0.25;
      ctx.save(); ctx.translate(back ? -2 : 26, fy); ctx.rotate(back ? curl : -curl);
      rrect(back ? -16 : 0, -3.6, 17, 7.4, 3.4);
      ctx.restore();
    }
    ctx.save(); ctx.translate(back ? 20 : -20, -6); ctx.rotate(back ? -0.85 : 0.85);   // thumb
    ctx.fillStyle = grd(0, -5, 0, 6, [[0, skin], [1, skinD]]);
    rrect(0, -4.6, 16, 9, 4); ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    for (let f = 0; f < 4; f++) rrect((back ? -6 : 24) - 4, -12 + f * 8.2, 9, 2.2, 1);   // knuckle shade
    ctx.restore();
  };
  // a forearm, drawn BEHIND the gun so the hand can wrap the grip over it. The anchor sits
  // just below the bottom edge, so local y > 0 is already off screen: running the sleeve to
  // y = 340 puts the elbow a few hundred device pixels past the edge, which is what makes the
  // hand read as belonging to a body instead of floating next to the weapon.
  const arm = (x, y, s, side, ang) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang || 0); ctx.scale(s, s);
    const ex = side * 52, ey = 340;
    ctx.fillStyle = grd(-34, 0, 34, 0, [[0, lit('#1d222b')], [0.45, lit('#363e4a')], [1, lit('#171b23')]]);
    ctx.beginPath();
    ctx.moveTo(-16, -8); ctx.lineTo(16, -8);
    ctx.quadraticCurveTo(ex * 0.4 + 18, ey * 0.45, ex + 22, ey);
    ctx.lineTo(ex - 30, ey);
    ctx.quadraticCurveTo(ex * 0.4 - 18, ey * 0.45, -16, -8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = grd(0, -12, 0, 14, [[0, lit('#48525f')], [1, lit('#242a34')]]);   // cuff
    rrect(-18, -14, 36, 24, 9);
    ctx.restore();
  };

  // ---- weapon families ------------------------------------------------------------
  // One convention for all three, because they used to disagree: the bore runs up the
  // screen (-y) toward the vanishing point, +x is lateral, origin at the rear of the grip.
  // The pistol drew its barrel as a HORIZONTAL bar while the rifle and shotgun drew theirs
  // vertically, and the flash was emitted along +x - so the muzzle blast came out of the
  // side of the gun, 90 deg off the bore. Families now differ by silhouette and nothing else.
  const K = w.kind;
  let muzzleX = 2, muzzleY = -330;
  if (K === 'shotgun') {
    muzzleX = -1; muzzleY = -404;
    arm(-56, -322, 1.0, -1, -0.08);
    arm(10, -212, 1.06, 1, 0.04);
    metal(-34, -232, 84, 46, 8, '#2c313a');                              // receiver
    metal(-16, -398, 30, 172, 5, '#242a33');                             // barrel
    metal(14, -386, 20, 154, 4, '#1c2129');                              // mag tube, under the bore
    metal(-12 + pump * 30, -330, 30, 42, 7, '#3a2c1e');                  // pump, travels on reload
    ctx.fillStyle = lit('#0e1217'); rrect(-13, -396, 24, 150, 3);        // rib along the top
    metal(-30, -186, 48, 82, 11, '#33261a', 0.10);                       // stock
    metal(-24, -262, 34, 15, 3, '#15191f');                              // ejection port
    ctx.fillStyle = '#0a0d11'; rrect(-13, -406, 26, 11, 4);              // muzzle ring
    if (magOut || shellIn) {                                            // shell in the hand
      ctx.save(); ctx.translate(-52 + shellIn * 16, -208 + shellIn * 30); ctx.rotate(0.2);
      ctx.fillStyle = grd(0, -8, 0, 8, [[0, lit('#b8412c')], [1, lit('#6d2115')]]); rrect(0, -7, 20, 14, 5);
      ctx.fillStyle = lit('#d8b04a'); rrect(15, -6.4, 6, 12.8, 2); ctx.restore();
    }
    hand(-56 - pump * 6, -322, 1.04, false, -0.16 + pump * 0.10);
    hand(6, -212 - magOut * 6, 1.08, true, 0.10 + slideBack * 0.05);
    if (slideBack) { ctx.fillStyle = lit('#cfae55'); rrect(-16 - slideBack * 26, -262 - slideBack * 22, 9, 7, 2); }
  } else if (K === 'rifle') {
    muzzleX = 1; muzzleY = -436;
    arm(-44, -312, 0.98, -1, -0.06);
    arm(10, -216, 1.04, 1, 0.05);
    metal(-30, -266, 92, 36, 6, '#262c35');                              // upper receiver
    metal(-8, -430, 20, 170, 4, '#1a1f27');                              // barrel
    metal(-5, -434, 14, 14, 3, '#0f1218');                               // flash hider
    metal(-26, -312, 44, 46, 5, '#1d222a', 0);                           // handguard
    metal(-30 + slideBack * 20, -246, 30, 22, 3, '#161b22');              // charging handle
    if (!magOut) metal(-14, -230, 26, 64, 4, '#1b2028', 0.04);            // magazine
    else { ctx.save(); ctx.translate(-14 - magOut * 10, -214 + magOut * 70); ctx.rotate(0.04);
      ctx.fillStyle = lit('#1b2028'); rrect(0, 0, 26, 60, 4); ctx.restore(); }
    metal(-40, -196, 52, 80, 12, '#20252e', 0.13);                       // stock
    metal(-7, -288, 14, 14, 2, '#10141a');                               // rear sight
    metal(-2, -400, 8, 26, 2, '#10141a');                                // front post
    hand(-44 - pump * 4, -312, 1.0, false, -0.30);
    hand(6, -216 - magOut * 4, 1.06, true, 0.12 + slideBack * 0.06);
    if (slideBack) { ctx.fillStyle = lit('#cfae55'); rrect(-4 - slideBack * 30, -272 - slideBack * 26, 8, 7, 2); }
  } else {
    muzzleX = 1; muzzleY = -338;
    arm(-36, -288, 0.94, -1, -0.05);
    arm(6, -222, 1.04, 1, 0.03);
    metal(-26, -312, 56, 80, 8, '#2b323c');                               // slide, foreshortened
    metal(-26 + slideBack * 22, -312, 56, 15, 4, '#20262f');              // serration band
    metal(-5, -332, 16, 26, 4, '#171c24');                                // barrel crown
    metal(-22, -238, 42, 88, 11, '#232935', 0.17);                        // grip, raked back
    if (!magOut) metal(-18, -232, 24, 66, 3, '#1a1f28', 0.06);            // magazine in the grip
    else { ctx.save(); ctx.translate(-18, -176 + magOut * 84); ctx.rotate(-0.05);
      ctx.fillStyle = lit('#1a1f28'); rrect(0, 0, 20, 44, 3); ctx.restore(); }
    ctx.fillStyle = '#0a0d11'; rrect(-9, -338, 22, 10, 3);                // muzzle face
    metal(-30, -256, 16, 20, 3, '#161b23');                               // trigger guard
    hand(-2, -226 - magOut * 8, 1.06, true, 0.06 + slideBack * 0.04);
    hand(-36 - (P.reloadT > 0 && magOut ? 18 : 0), -288 - magOut * 26, 0.92, false, -0.36 - magOut * 0.2);
    if (slideBack) { ctx.fillStyle = lit('#cfae55'); rrect(-18 - slideBack * 30, -300 - slideBack * 20, 8, 7, 2); }
  }

  // ---- muzzle flash: additive cone + kernel at the muzzle, driven by S.muzzle ----
  if (mz > 0.004) {
    const mx = muzzleX, my = muzzleY;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, mz);
    ctx.fillStyle = grd(mx, my, mx, my - 150 * mz, [[0, 'rgba(255,250,235,0.95)'], [1, 'rgba(255,170,60,0)']]);
    ctx.beginPath();
    ctx.moveTo(mx - 26 * mz, my); ctx.lineTo(mx - 5 * mz, my - 150 * mz);
    ctx.lineTo(mx + 5 * mz, my - 150 * mz); ctx.lineTo(mx + 26 * mz, my);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = grd(mx - 60 * mz, my - 60 * mz, mx + 60 * mz, my + 60 * mz, [[0, 'rgba(255,250,235,1)'], [0.45, 'rgba(255,214,120,0.55)'], [1, 'rgba(255,150,40,0)']]);
    ctx.beginPath(); ctx.arc(mx, my, 58 * mz, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,236,170,0.75)';                        // star, so the blast has edges
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + mz * 0.7, r = (i === 0 ? 150 : 78) * mz;
      ctx.save(); ctx.translate(mx, my); ctx.rotate(a - Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(-7 * mz, 0); ctx.lineTo(0, -r); ctx.lineTo(7 * mz, 0);
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.restore();
  }
  // ---- sight picture in ADS: the rear sight brackets the front post on screen centre
  if (ads > 0.02) {
    const a = ads * ads;
    ctx.save(); ctx.globalAlpha = a * 0.9;
    const sy = (DH * 0.5 - oy) / sc, sx = (DW * 0.5 - ox) / sc;
    ctx.strokeStyle = 'rgba(12,15,20,0.9)'; ctx.lineWidth = 3 * (1 + ads);
    ctx.beginPath(); ctx.rect(sx - 16, sy + 4, 32, 16); ctx.stroke();
    ctx.fillStyle = 'rgba(230,240,255,' + (0.10 * a) + ')'; ctx.fillRect(sx - 1, sy - 26, 2, 30);
    ctx.restore();
  }
  ctx.restore();
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
      mmCtx.fillStyle = MAP.cell[y * MW + x] !== 0 ? 'rgba(126,156,192,.5)' : 'rgba(28,48,70,.9)';
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
