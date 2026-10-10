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
/* #369: the authored SURFACE VALUE ORDER. Two row constants that sit in the same place AMB lives and
   apply to one surface class each - FLOORB on floor rows, CEILB on ceiling rows - so a level can say
   "walls brightest, floor mid, ceiling lowest" without touching a texture or a lightmap. Both are 0 on
   every level that does not author them, which is every flat level, so their arithmetic costs nothing
   and byte-matches there. See LEVELS floorBias/ceilBias in js/20_level.js. */
let FLOORB = 0, CEILB = 0, WALLB = 0, CEILLD = 0.9;
// samples across one row's fan used to find the light of a far-band row (#197): a row at FARB spans
// ~1.4*FARB world metres, so ONE cell would book a 30 m wide band to one lamp. Lookups per ROW.
const FARFAN = 8;
/* #21: the ground pass's light ceiling. The row-init lookup has always clamped `li` to 1, but the
   lookups reached AFTER a crossing - the cell crossing inside the row loop, the deferred/off-plane
   copy in groundPixel, and the far-band fan - did not, so a cell entered mid-row contributed the raw
   lightmap value, which splatLight accumulates without a ceiling (`lm[i] += amt * w`). Those pixels
   shaded past their lamp's ceiling while the pixels before the crossing did not, which is a seam, not
   a brightness choice: row init (:597), the wall pass (:1170) and the billboard term (:1330) all
   clamp, so ground was the odd one out. `LGCAP` is the ceiling
   and `LGCNT` the opt-in counter - both are read as a const of the pass (see the register rule in the
   row loop) and `LGCNT` is null in play, so shipping cost is the compare alone. `view.js NOCAP=1`
   raises LGCAP to Infinity to reproduce the unclamped behaviour and prove the row can fail.
   LGCNT is an Int32Array(LG_N*3) of families: slots 0.. count LOOKUPS at the site (a site that never
   ran means the pass was restructured, which is vacuity, not green), slots LG_N.. count the ones whose
   lightmap read above LG_CEIL (coverage), slots 2*LG_N.. count the ones still above LG_CEIL when they
   reached the shade - the defect itself, read off what the pass delivered. A run with LGCAP raised to
   Infinity makes the second and third families equal, so a leak count cannot pass by being empty. */
let LGCAP = 1;
let LGCNT = null;                          // Int32Array(LG_N*3) or null; armed by tools/view.js only
const LG_CEIL = 1;                          // the invariant's ceiling: what row init clamps to
const LG_ROW = 0, LG_DEF = 1, LG_FAR = 2, LG_N = 3;
/* #375: two more families, OFF-MAP LIGHT, and they are the same instrument for both copies of the
   ground pixel body. Slots LG_OFFMAP / LG_ROWOFF count the ground pixels whose ray LANDED OFF THE
   LEVEL (run count - a site that ran nothing is vacuity, not green); slots LG_OFFMAX / LG_ROWOFFMAX
   hold, scaled by 1000, the LARGEST light above the ambient base that any of those pixels DELIVERED,
   counted only where every bilinear tap is off the map (see offMapClear). The invariant is the one
   #375's fix is made of: a pixel the level has no lamp for takes ambient, so that maximum is 0.
   It is not 0 on the behaviour before the fix, which handed every off-map pixel the light of the cell
   the row's walk last reached, at any distance. Scaled to an int because LGCNT is an Int32Array. */
const LG_OFFMAP = 9, LG_OFFMAX = 10, LG_ROWOFF = 11, LG_ROWOFFMAX = 12, LG_OFFCEIL = 13, LG_OFFCMAX = 14, LG_NTOT = 15;
let G_TRI = false, G_GRIT = 0;                                  // derived from QUAL.rast
/* #164: altitude reached the geometry and no pixels. A seam at the CREASE of every step the render
   ray crosses - the foot darkened, the far lip lifted - is the one cue that survives a dark room, so
   it is a MULTIPLY on composited pixels, not an additive term the AMB floor sinks. World-scaled, so
   it stays SEAMW metres wide at any depth, and narrow, so it is an edge and not a shade. */
let SEAM = 1, SEAMD = 0.62, SEAMU = 0.13, SEAMW = 0.16, SEAMC = 0.22;
/* #385: the crease's ABSOLUTE half, and it is AUTHORED content, not a global.

   A multiply is scale-invariant: `kk` takes 84% off a lip row whether the deck it sits on reads 37
   luma or 77, so in luminance the edge is 6 units on one and 13 on the other. That is why THE STACK's
   down-step into its pit is quiet while every generated level's lip reads: the authored level authors
   `lamps: 0` (js/20_level.js), so the deck this lip is scored on is the darkest in the game. Deepening
   SEAMD globally was measured and declined - it hardens the three lips that already read and re-keys
   their recorded frames to buy one authored row (issue #385). What a dark room needs is an edge in
   LUMAS, not another fraction.

   `stepEdge` is that: a per-level absolute subtraction in luma units, applied to the same rows the
   multiply already touches (so the band's WIDTH and its locality are unchanged), and faded by the
   luminance of the DECK the eye stands on at that lip - read off the composited floor pixel just under
   the band, not off the crease row itself, because the crease row is dark by construction on every lip
   and would switch this term on everywhere. Above `SEAMK` deck luma the fade is 0 and the pixel is the
   byte it always was; a level that authors nothing gets 0 and moves nothing.

   The fade keys on the deck and not on the crease pixel on purpose, and `bands`' L3 walk lip (deck 77,
   same level, same renderer, authored value live) is the control that proves it: that lip is byte-for-byte
   what it was while the dark one three cells away is not. */
let SEAMA = 0;
/* #413: which cells have a fitting hung over them, read once a frame alongside the other per-level
   surface terms. null whenever the level was built with the fittings suppressed (LAMPS=off), which is
   what keeps that counterfactual byte-identical - the ceiling pass pays one null test and stops. */
let CF_FIX = null;
const SEAMK = 0.45;                             // deck LIGHT at which the absolute term has faded out
/* #178: contact shadow. A rim ADDS to the body, and the rig raster is multiplied by scene light at
   composite, so an additive rim is weakest in the dark rooms that need separation most - AMB 0.19
   floors it. This SUBTRACTS from the world a body occludes instead: a short radial falloff on the
   floor of the body's own BAND, and a band on any face inside the same contact disc. A MULTIPLY on
   lit pixels (the seam's mechanism at seamCrease), so it darkens whatever is there instead of
   competing with a light constant. It paints pixels and NEVER writes zbuf - a shadow is not an
   occluder (#163/#170).

   #18's retune: the first version was a DISC of e.r + 0.30 m plus a band up the whole height of the
   body, and on the coverage-rule oracle that reads as a separation COST, not a cue - a darkened wall
   behind a dark body lowers edge dL (cam 0 50 -> 46, cam 2 29 -> 25) and every darkened world pixel is
   counted as leak. So the term is now a PATCH at the contact line: the radius is pulled 10 cm INSIDE
   the body's own collision radius (so the patch cannot darken a world pixel outside the footprint the
   silhouette already occupies), the falloff exponent is raised so the VISIBLE edge sits at 0.89 R
   rather than 0.95 R (D*t^F falls under 1/255 at t = (1/(255*D))^(1/F) = 0.2106, so the edge is at
   sqrt(1-t) R = 0.888 R: R = 0.32 m for a grunt, visible to 0.28 m, inside its 0.42 m footprint), and
   the face term is confined to a band as tall as the patch
   is wide, zero above it, instead of keeping 75% of the term to the crown.
   SHADOW_R is metres added to a body's collision radius to get the patch radius (negative = the patch
   stops inside the footprint);
   SHADOW_ZT is how far a floor pixel's plane may be from the body's feet plane and still take the
   term (bands are quantized, so this is a band test, not a soft falloff - it is what stops the patch
   painting a floor the body is not standing on, across a lip or a pit edge);
   SHADOW_F is the falloff exponent in t = 1-(d/R)^2, 1 being a flat-topped disc and 3 a tight core;
   SHADOW_ZF is how much of the term is left at the TOP of that contact band on a face (above it,
   nothing). */
let SHADOW = 1, SHADOW_D = 0.42, SHADOW_R = -0.10, SHADOW_ZT = 0.02, SHADOW_F = 3,
    SHADOW_ZF = 0.25, SHADOW_FAR = 18;
/* #371 item 3: the same term, on a PROP. A crate's lower edge used to be as bright as its upper edge,
   because nothing said where the crate meets the floor. This is not a new mechanism - it registers the
   prop in the SAME grid #178 built, so both ground copies and the wall loop darkening happens once per
   pixel for a body AND a prop, and a prop that leaves the frame's radius costs the loop nothing.
   The radius differs from a body's on purpose. SHADOW_R pulls a BODY's patch inside its own collision
   radius because a body's collision radius is a circle the silhouette always covers; a prop's footprint
   (`MESH.foot`) is the radius to the CORNER of a box, so a patch pulled inside it would sit under the
   crate's inscribed circle and be hidden by the crate itself at eye height. SHADOW_PR is measured in
   the other direction: the crate's authored box is 0.375*0.72 = 0.19 m to its FACE against 0.27 m to
   its corner, so +0.04 puts the visible edge of the patch a few centimetres outside the face, which is
   where a contact zone actually is, while staying well inside the footprint the prop already occludes.
   SHADOW_PROP 0 is the A/B the `props` probe's patch row runs against - one assignment, no rebuild. */
let SHADOW_PROP = 1, SHADOW_PR = 0.04;
/* The wall bilinear fetch is inlined at its one call site below rather than factored into a
   function that writes its result into a scratch array: a module-global typed-array out-param
   blocks V8 inlining and register allocation, and the same code inlined measured 21 -> 12 ms
   near a wall. It is inlined here and nowhere else, so the pass that keeps the registers is this
   one, and any new caller must inline it too rather than reach for a shared helper. */
// viewmodel spring state: sway lag, previous look angle, eject timing
const VM = { vy: 0, ang: 0, lag: 0, now: 0, t: 0 };

/* ---- the room's exposure term (#377) ------------------------------------------
   The bloom pass this branch replaces was doing two jobs: it was a glow, which the bright pass now
   does properly, and it was an EXPOSURE, which nothing else in the pipeline does. With the veil gone
   the composited medians fall to 48.7 / 54.0 / 47.8 / 60.3 against the documented 60-100 window
   (measured on main with the composite call disabled, so it is the room and not the pass), which is
   a frame you cannot see into: at a median of 49 a hostile standing in a lit doorway is a rumour
   until it shoots. This is the light the pass was supplying, put back as one term on the room.

   The term is a SHOULDered BLACK-POINT LIFT: below luma EXPOSE_T it is v' = v*(1 - A/T) + A - a
   black-point lift that moves shadows far more than highlights, the exact opposite of the
   clipped-contrast pass it replaces, which added the same +107 to a lamp core and to the floor under it
   - and at or above EXPOSE_T it is the identity. At A = 22, T = 200 a pixel at 40 gains 19, a pixel at
   150 gains 6, and a pixel at 200 or above gains nothing at all. What it costs, stated: on the lifted
   range it gives up A/T = 11% of the contrast slope, a tenth of what the removed pass was taking off
   the top, and it is flat above 200, so the top of the range stops compressing instead of compressing.

   One constant for all four levels - no per-level table, because applied to the measured pass-off
   medians it predicts 66 / 71 / 65 / 77, all inside the window - and it is weighted toward dark pixels,
   which is where the darkest dealt layouts (#149's tail) actually are. It is NOT a lamp-coverage fix
   and does not close #199.

   Three properties this term must keep, because of how this repo has been bitten:
   - it is TWO COMPOSITED FILLS (`multiply` by flat 255-A, then `lighter` with flat A), so it is the
     same picture on a browser with no `ctx.filter`. A filter-only path would give that browser a game
     two stops darker than every other one - the `canFilter` defect the bright pass just removed.
   - it is a CONSTANT. No per-frame statistic, nothing derived from the frame's own mean: a
     frame-adaptive exposure pumps as the player walks between rooms and breaks the seeded determinism
     every probe in the roster depends on.
   - it is applied to the ROOM, after the grade composite and before the bright pass, the lamp glow,
     the particles and the HUD (renderOverlay). drawBloom reads the raster buffer, not the display
     canvas, so a lift here can never push a floor over the bright pass's knee. That ordering is what
     makes it safe, and it stops being safe if the term moves below the raster.
   DEV.set('expose', 0) is the A/B: the term off, everything else identical. */
const EXPOSE_A = 22;             // the black point: added luma at v = 0, and 0 at v = EXPOSE_T
const EXPOSE_T = 200;            // the shoulder: at or above this luma the term is the identity
const QUAL = [
  { name: 'PERFORMANCE', res: 0.34, min: 170, max: 430, bloom: false, grade: false, grain: 0, far: 15, dmax: 8, glow: 0, scan: 0.5, vec: 0, rast: 0, rigH: 0, expose: EXPOSE_A },
  { name: 'BALANCED', res: 0.47, min: 220, max: 760, bloom: true, grade: true, grain: 0.05, far: 22, dmax: 13, glow: 6, scan: 0.18, vec: 1, rast: 2, rigH: 300, expose: EXPOSE_A },
  { name: 'ULTRA', res: 0.62, min: 260, max: 780, bloom: true, grade: true, grain: 0.04, far: 30, dmax: 19, glow: 9, scan: 0.1, vec: 1, rast: 4, rigH: 216, expose: EXPOSE_A }
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

/* #299 candidate (c): a LIT CEILING SURFACE, no lightmap change. A ceiling plane that solves more
   than CEILHI above the eye is a vault - there is no floor lamp within reach of it, because the
   lightmap is one value per column taken at the column's FLOOR band (splatLight's band term), and a
   4-unit ceiling is 3.5 units above it. The term is a per-ROW and per-(row,plane) constant added to
   the ground pass's `base`, i.e. the same place AMB and the muzzle flash live: it scales the ceiling
   TEXEL (so it cannot blow a white texel any harder than a lamp does) and it is exactly 0 while the
   plane is within CEILHI of the eye, which is every pixel of a one-unit level - so flatparity's
   PARITY/LOCK senses stay byte-identical. Both copies of the pixel body get it: castGround's row
   (dzA, the plane the row paints) and gndBuild (pl, the plane the deferred pixel paints), so a pixel
   does not depend on which path painted it. Above CEILHI the term grows linearly with the height
   above that threshold and saturates at CEILGM. With THESE constants it is exactly 0 in the CZ_TALL
   rooms feature 1 authors: CZ_TALL = 12 quanta is the tallest own-ceiling main has, so a seat under one
   solves plane 3.00 at dzA 2.50 - at most 2.88, since eyeZ is never below floorAt + 0.12 (js/40_render.js
   :156) - and both are under CEILHI. The 0.14 once quoted here was the rejected CEILHI 1.0 tuning's
   number at that same dzA, not this pair's. CZ_SPAWN_TALL = 16 over the spawn room (plane 4.00, dzA 3.50
   -> 0.70) is the first column that clears the threshold from the floor under it, and the key is still
   the PLANE and not a room test: the term can reach main's own bytes at the DEFERRED site, where a
   CZ_TALL column the raised band also lifted has plane 4.00 and a datum eye solves it at 3.50 - measured
   over 8 seeds x 3 levels in 1 pose of 24 (SEED 3 L0: 67 of 189 deferred ceiling runs; the other 23
   frames byte-identical with the term zeroed). */
/* #369: this cap is the most a VAULT may LEAD the floor under it by. It used to be a flat +0.9 with no
   reference to anything, and on THE STACK (amb 0.2, `lamps: 0`, a floor band the lamps do not cover) it
   put a vault's base at 1.10 against the floor's 0.20 - the roof became the brightest large surface in
   a level whose whole idea is a walkway above your head, and the walkable floor the darkest thing in the
   frame. The term is still exactly 0 within CEILHI of the eye, so every flat frame is unchanged, and
   CEILG/CEILHI are unchanged: a vault is still lifted off black, it just cannot out-light the surface
   you stand on.
   WHAT #380 LEFT OPEN, AND WHAT THIS IS. It made the cap a per-level EXCEPTION: a level that authored
   `ceilLead` got it and every other level kept the flat +0.9. Measured on main that is not enough -
   ABATOIR CORE authors a `ceilBias` (-0.12, js/20_level.js:30) and no `ceilLead`, so the +0.70 its
   CZ_SPAWN_TALL spawn room picks up (plane 4.00 at eye ~3.50, js/20_level.js:525) cancelled that -0.12
   twice over: at `view.js surface` cam3 the ceiling band reads 66.3 against a deck of 47.4, the same
   inversion #369 was filed for, in the largest level in the campaign, at the seat the player arrives in.
   So the cap is now a rule the renderer derives from the order a level states, not a number only one
   level chose to write: a level that authors a surface order (either bias, or an explicit lead) gets
   the lift capped where that order ends,

     AMB + CEILB + lift <= AMB + FLOORB   =>   lift <= max(0, FLOORB - CEILB)

   and a level that authors NEITHER keeps the flat 0.9 exactly as before - inventing a bound for a level
   that chose no order would be a shading change dressed as an invariant, and it would move the bytes of
   the two levels that are the census's control. An authored `ceilLead` still wins outright, which is
   what lets `surface`'s CONTROL block reproduce the pre-#369 build by writing CEILGM itself. ABATOIR
   needs no new number: -0.12 is already the cap, 0 - (-0.12). Height is said by the riser seam and the
   minimap band cue (#164), not by light. */
const CEILHI = 3.0, CEILG = 1.4, CEILGM = 0.9;
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

/* What mesh each pickup type draws as (#76, and #361 for the fourth row). This is the ONLY place a
   pickup `type` becomes geometry, so it is every type the economy can put on the floor: `takePickup`
   (js/30_entities.js) and the kill-drop table own the types, and a type missing HERE is not an
   invisible box - `draw` used to answer an undefined kind with a grunt, and now throws. It sits at file
   scope rather than inside renderWorld so tools/smoke.js can assert the coverage instead of trusting a
   list of types kept by hand next to the one kept here. */
const PKKIND = { health: 'pickupHealth', ammo: 'pickupAmmo', armor: 'pickupArmor', gren: 'pickupGren' };

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
  FLOORB = MAP ? MAP.floorBias || 0 : 0;
  CEILB = MAP ? MAP.ceilBias || 0 : 0;
  CF_FIX = MAP ? MAP.ceilFix || null : null;          // #413 ceiling fitting plates
  WALLB = MAP ? MAP.wallBias || 0 : 0;
  SEAMA = MAP ? MAP.stepEdge || 0 : 0;        // #385: an authored absolute crease, 0 on every level that authors none
  /* #369: the vault's ceiling. An authored `ceilLead` is the level's own word and wins; otherwise a
     level that authored a floor/ceiling order is capped by that order (see CEILGM), and a level that
     authored nothing keeps the flat CEILGM so its bytes do not move. */
  CEILLD = !MAP ? CEILGM : MAP.ceilLead !== undefined ? MAP.ceilLead
    : FLOORB !== 0 || CEILB !== 0 ? Math.min(CEILGM, Math.max(0, FLOORB - CEILB)) : CEILGM;
  horizon = BH * 0.5 + aimPx() + bobP * (BH / 400) * 3 + shakeY;
  const fcR = FOGC[0], fcG = FOGC[1], fcB = FOGC[2];
  const fcol = pack(FOGC[0], FOGC[1], FOGC[2]);
  px.fill(fcol);

  /* #178: bodies register their contact disc before the world is drawn, so both ground copies and the
     wall loop can darken the world they occlude for the price of one indexed read per pixel. Rebuilt
     every frame - a body moves, a band moves - and allocated with the level. */
  buildShadowGrid();

  castGround(flash, fcR, fcG, fcB);
  castWalls(flash, fcR, fcG, fcB);

  /* ---- sprites: props, pickups, projectiles, the portal ----
     Props, pickups, the orb and the portal are geometry now (#76), on the same `mesh:true` dispatch the
     enemies got in #72. Two conventions carry over unchanged: `scale` is TOTAL world height, and z is
     the FEET, resolved at DRAW time like an enemy's already was (below) - a prop that stores
     generation-time floorAt still sinks when a band changes under it, which is what M3 makes routine.
     What the billboard had and the mesh cannot keep is the texture: each prop was one painted Surf, so
     js/13_mesh.js authors parts for it. The GRENADE YOU THREW stays a billboard - it is a PROJ, not a
     pickup, and no geometry is authored for it - but a grenade BOX on the floor is geometry, which is
     PKKIND's `gren` row (#361). The `glow` field the pickup entries
     carried is gone: drawBillboard never read it, glow comes from LIGHTS in drawLightGlow (#76). */
  const list = [];
  for (const p of PROPS) {
    if (p.dead && p.kind === 'barrel') continue;
    /* A prop the EYE is inside paints the whole frame with its own mesh magnified to the near plane:
       measured at a camera on a barrel's cell centre (props sit at cell centres and `tryMove` gives
       props no collision), 95.8 % of the above-horizon pixels belonged to a prop at 0.00 m and `zbuf`
       read 0.142 there against the geography's 0.997 - a bright frame that looks like a wall while
       every ray finds open ground (#212). The mesh's 0.12 m near plane is not the guard: a face 14 cm
       away is past it. Cull by footprint, not distance - a crate 3 m out is a real occluder. The
       gameplay half (props are not collision, so a player can stand in one) is a movement change and
       is called out in the PR instead of riding along in a render fix. */
    const pf = MESH.foot(p.kind) * (p.scale || 1);
    if (pf > 0 && Math.abs(p.x - camX) < pf && Math.abs(p.y - camY) < pf) continue;
    /* #371: the orientation the generator chose. It rides the entry rather than being derived here so
       that what a probe or the console reads back (PROPS[i].yaw) is what the frame drew, and so a
       save/restore of the entries carries the pose with them. `propYaw` consumes no draw from the
       world's stream (js/20_level.js), which is why adding it moved no other prop, lamp or enemy. */
    list.push({ mesh: true, kind: p.kind, x: p.x, y: p.y, z: floorAt(p.x, p.y), scale: p.scale, alpha: p.dead ? 0.35 : 1, yaw: p.yaw || 0 });
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

/* #19, TAKE TWO: three terms of the ground pass were FUNCTIONS OF THE CELL, and a cell boundary seen
   in perspective is a straight line to the vanishing point - so anything that STEPS at a boundary draws
   a fan of radial spokes over the largest area of the frame, while walls, props and bodies, which have
   no such step, stay clean. Mip SELECTION is not one of them: `mip AR=8/16` moves ceiling streak by one
   point and the picture not at all (issue #19), so mipSel/MIPAX/MIPAR are untouched here.
   Each term is a switch with a value that reproduces what shipped, so an A/B is one assignment in the
   running page (`DEV.set('gndjit', 2)`) and not a worktree:

     GJIT   the per-cell texture-coordinate jitter that "kills the tiling tell". A MIRROR FLIP is a
            DISCONTINUITY OF SCALE - flipping u makes the pattern run backwards inside that cell - so
            every boundary the row walks into folds the pattern, and the fold projects to a spoke. It is
            now DISTANCE-GATED rather than per-cell: the mirror stays where a cell is GJITPX px
            wide or wider, where a fold reads as the edge of a panel (what it was put in for), and is
            dropped where a cell is a handful of px, where the fold IS the spoke and the tile is too
            small to tell anyway. A per-cell PHASE OFFSET was tried first and is the wrong instrument:
            an offset of a repeating tile is still a seam at every boundary and buys no variety, so it
            drew its own, finer fan. 2 = the mirror on every cell as it shipped (the A/B control),
            1 = distance-gated, 0 = never mirrored (the tiling tell comes back, which is what makes
            1 a mechanism rather than a no-op).
     GLRP   the ground's light. The wall pass has always sampled the lightmap at the point its ray
            hits; the ground read ONE cell value per pixel, so the lightmap's own 1 m grid showed up as
            a second family of radial steps - 20 m out a cell is a handful of pixels. The pixel now
            walks its cell's own ramp (see buildLightRamp). 0 = the per-cell value as it shipped
            (bit-identical: the shipped statement stays, the ramp terms are multiplied by zero), 1 = on.
     GNDAX  the fetch. A pixel whose footprint is eight texels long along the view direction took ONE
            texel from it, so every texel was magnified into a wedge narrowing at the vanishing point -
            the spokes on the half of the frame seen most edge-on, which is the CEILING. 1 adds a second
            tap HALF a footprint to each side of the point it already took; 0 = the single tap as it
            shipped. One extra texel load, and only on the rows that are actually undersampled.
     GNDFB  the FAR ANSWER, and the one #19 take five adds. Past FARB the row loop stops fetching and
            fills the row with the material's mip mean; the DEFERRED copy had no such branch and textured
            every pixel out to FARB*4, and on a stepped level its pixels ARE the far field. A pixel whose
            footprint runs hundreds of texels down its own ray cannot average that with three taps, so it
            drew one texel as a strip along the pixel-to-VP line - the fan. 1 gives that copy the answer
            the row already gives at the same distance, taken from the pixel's own solve; 0 = the
            textured far field as it shipped, which is the A/B and brings the wedge's comb back. Not a
            blur: it changes no pixel the row loop would still fetch, and past FARB it is CHEAPER (no mip
            select, no mirror hash, no texel load, no decal).

   All of them are read once per row (the last one once per deferred pixel), never per pixel of a row, and
   none of them adds a THIRD copy of the ground pixel body: a switch shows up as a zero slope, a zero
   offset or one fewer load, not as a new loop. */
let GJIT = 1, GLRP = 1, GNDAX = 1, AXMIN = 1.5, GLC = null, GNDFT = 1, GNDRO = 1, GNDFB = 1, GNDOF = 1;
/* #19 take six - THE GRADED BLEND, and the strength of it. The five takes above change WHERE a pixel
   reads and HOW the texel is fetched; none of them changes WHAT AREA GETS AVERAGED, which is the only
   term issue #19's band table says is still unaccounted for. A pixel's strip on the plane runs about one
   footprint along the ray, and the axial pair spans that strip with TWO taps about one texel apart - so
   for a pixel whose footprint in texels of the level it selected is F, the selected level carries 1 of
   those F and cannot carry the other F-1. The blend hands that share to the next coarser level:

     f = max footprint along either screen axis, in texels of the SELECTED mip
     w = GNDFA * (1 - 1/f)  for f > 1, and 0 for f <= 1.

   So a well-sampled pixel (f <= 1, which is every pixel under the player's feet) blends NOTHING and
   keeps mip 0 - this is not the uniform deep-mip arm, which emptied mip 0 and pushed the chain-end
   census from 44 of 284 to 103. Mip SELECTION is untouched: `view.js mip` reads its histogram out of
   mipSel, so the histogram and the chain-end census cannot move here, and what moves is the fetch.
   Cost is one texel load and three lerps, and only on the pixels whose footprint is already long enough
   that the axial pair is running. 0 = the single-level fetch as it shipped, so `DEV.set('gndfade', 0)`
   is the A/B and the wedge comes back. GNDFA is a MULTIPLIER so an A/B can also sweep the strength.
   The coarser tap contributes COLOUR only: it does not set the 253 flag, because a coarse texel's alpha
   describes an AREA, not this pixel's footprint, and deeper mips go uniformly 253 (#124) - letting it
   decide would take whole bands light-exempt, which is a relight, not a filter. */
let GNDFA = 1;
const GJITPX = 48;      // GJIT 1 keeps the mirror only where a cell is this many px wide or wider

/* #19, TAKE THREE - THE FETCH. The two terms above are not what combs a plane, and neither is the mip
   choice. On the row loop's own pixels - the NEAR and MID field - what combs it is that the pass takes
   ONE texel per pixel. A row walks its plane by (wxs,wys) per column, which on a plane of this world is a
   FRACTION of a texel: measured on a ceiling row at the level-0 cam1 seat, the texel index does not change
   at all along most of the row. So the pixel is smaller than the texel it reads, the tile is magnified,
   and every texel of the material is drawn as a hard-edged strip whose long direction is the line from the
   pixel to the vanishing point - the material's own grit becomes a radial comb, floor and ceiling alike,
   at every distance. Walls, props and bodies never wear it because they are fetched with texBil(), which
   has always interpolated. The fix is that interpolation ACROSS the footprint's short side, and it costs
   ONE extra texel load and one lerp; a full bilinear costs three loads and four mults a channel for
   little more than this buys, and most of what it adds is blur. Which axis to lerp is decided per ROW from
   the row's own deltas (the long side is the column delta, so the axis the walk crosses texel boundaries
   along is the one with the larger component), and the deferred copy decides it from its pixel's OWN
   footprint, exactly as the axial pair already does.
   Measured against this same tree with GNDFT 0 (`view.js mip`): ceiling streak 42 -> 38, 52 -> 48,
   84 -> 75, 27 -> 26 and floor 64 -> 58, 92 -> 87, 104 -> 93, 74 -> 66, with the `detail` column held well
   above its mush control - smoothing, not blur. GNDFT 0 = one texel per pixel as this shipped, 1 = the
   lerp, so the A/B is one DEV.set call and the frame visibly changes.

   Two things this does NOT reach, both named rather than cropped. The FAR field is not painted by this
   loop at all: 18,704 pixels of the level-0 cam1 frame go through groundPixel(), 53-64% of every row of
   the bright ceiling wedge, and take four (there) is what fixed that half. And one control that got run
   here is a trap worth naming: swapping the ceiling for a flat grey texture collapses the far-band
   gradient from 13 to 4 - while also lifting that band's mean luminance from 85 to 123, where it clips.
   A render difference can see geometry, never the shading inside it; at a grey that does not clip the same
   swap leaves the far band at -61%, and the term that is left there is the light, not the texel. */

/* The lightmap as a plane each PIXEL walks (#19). Stored per cell as
     value(fx,fy) = V + A*fx + B*fy + D*fx*fy  per channel,
   with V the cell's own colour light (clamped intensity x tint - the product both pixel bodies already
   multiply the texel by), A the slope to the cell to the RIGHT, B the slope to the cell BELOW, D the
   cross term (diagonal - right - below + own). This is not an approximation of a bilinear: it IS the
   bilinear of the four cells around the point, written so a pixel can ADVANCE it, and `cellLightAt`
   (js/20_level.js:254) is the same map sampled at a point that the WALL pass has always used - the
   ground was the only pass that quantized to one cell value, which is why walls never wore the fan.
   The cross term is not a refinement. Drop it and three bad things happen at once, all of them measured
   on the first version of this pass: the patch stops being a CONVEX combination (past fx+fy = 1 a cell
   brighter than both neighbours extrapolates its far corner BELOW zero, which is not dark, it is
   negative light, and it clamps to black fill - `heights`' pit config read 3.13% of the frame that way);
   it becomes DISCONTINUOUS across the fy = 1 edge, and a discontinuity in perspective is a spoke, which
   is the defect this is here to remove; and it DOUBLE-COUNTS the two taps it knows - a dark cell with a
   lamp to its right and below rendered (Vright+Vbelow)/2 over its whole area instead of the four-tap
   mean, which is what put the frame at mean 57.7 with 0.63% blown pixels where main reads 52.4 / 0.00%.
   Along a row the patch is quadratic, so a pixel carries TWO increments (the slope, and the slope's own
   slope) and the whole thing still costs two adds a channel - the reason this is affordable in the
   hottest loop in the game. A tap outside the map is 0, which is exactly what the shipped path gives an
   off-map column: white tint, light 0. The #21 light ceiling is applied PER CELL here, so it stays a
   property of the grid rather than of which path painted the pixel, and because every tap is clamped and
   the four weights sum to 1, a bilinear cannot deliver above it either. */
function buildLightRamp() {
  const N = MAP.w, NN = N * N, lm = MAP.light, lt = MAP.lt, n3 = N * 3, lgc = LGCAP;
  if (!GLC || GLC.length < NN * 12) GLC = new Float64Array(NN * 12);
  const hasL = !!lm && !!lt && NN * 3 <= lt.length;
  for (let y = 0; y < N; y++) {
    const r0 = y * N, hasD = y + 1 < N;
    for (let x = 0; x < N; x++) {
      const i = r0 + x, k = i * 12;
      let vr = 0, vg = 0, vb = 0, ur = 0, ug = 0, ub = 0, wr = 0, wg = 0, wb = 0, dr = 0, dg = 0, db = 0;
      if (hasL) {
        const i3 = i * 3, a = lm[i] > lgc ? lgc : lm[i];
        vr = a * lt[i3] / 128; vg = a * lt[i3 + 1] / 128; vb = a * lt[i3 + 2] / 128;
        if (x + 1 < N) {                            // BOTH axes tested before an index is used: an
          const j3 = i3 + 3, b = lm[i + 1] > lgc ? lgc : lm[i + 1];   // index is one number and an x of
          ur = b * lt[j3] / 128; ug = b * lt[j3 + 1] / 128; ub = b * lt[j3 + 2] / 128;   // -1 is a valid
        }                                          // one for somewhere else in the level (AGENTS.md)
        if (hasD) {
          const j3 = i3 + n3, c = lm[i + N] > lgc ? lgc : lm[i + N];
          wr = c * lt[j3] / 128; wg = c * lt[j3 + 1] / 128; wb = c * lt[j3 + 2] / 128;
          if (x + 1 < N) {                          // the DIAGONAL tap. Without this one the patch is a
            const j32 = j3 + 3, e = lm[i + N + 1] > lgc ? lgc : lm[i + N + 1];   // plane, not a bilinear,
            dr = e * lt[j32] / 128; dg = e * lt[j32 + 1] / 128; db = e * lt[j32 + 2] / 128;  // and a plane
          }                                         // is what drew the spokes in the first place.
        }
      }
      GLC[k] = vr; GLC[k + 1] = vg; GLC[k + 2] = vb;         // V. The pixel bodies take this from their
      GLC[k + 3] = ur - vr; GLC[k + 4] = ug - vg; GLC[k + 5] = ub - vb;   // own shipped `li * tint` and
      GLC[k + 6] = wr - vr; GLC[k + 7] = wg - vg; GLC[k + 8] = wb - vb;   // read only the SLOPES, so V
      GLC[k + 9] = dr - ur - wr + vr; GLC[k + 10] = dg - ug - wg + vg;    // stays exactly what #21
      GLC[k + 11] = db - ub - wb + vb;                                     // clamped at the site.
    }
  }
}

/* #375: does this landing point have NO light tap left? The ground light field is a bilinear whose
   taps are the four cells around the lattice point, and a tap off the map reads 0, so a pixel still
   has a tap while EITHER axis has an in-map cell adjacent to it: cx in (-1, N+1) and cy in (-1, N+1).
   Once either axis is a whole cell clear of the level every tap is off the map and the field is
   exactly 0 - which is the assertion `heights` reads out of LG_OFFMAX / LG_ROWOFFMAX. Both axes are
   tested on their own because a cell index is one number (AGENTS.md). Called only on off-map pixels,
   never on the in-map path, so the shipped cost is the branch that skips it. */
function offMapClear(cx, cy, N) {
  return cx <= -1 || cx >= N + 1 || cy <= -1 || cy >= N + 1;
}

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

/* THE MARCH'S PLANE INVENTORY - what the march costs and why much of it is free.
   A planeAlong answer is always STRICTLY NEARER THAN THE CALLER'S OWN SOLVE: both branches require the
   candidate to be on the far side of the eye AND to solve nearer than `cap`, and `cap` is at most the
   distance at which the caller's plane solves. Both branches also answer a plane the GRID HAS at a cell -
   a floor (`fzs*ZQ`), a boundary's floor, or a ceiling plane (`ceilAt`) - so which altitudes exist at all
   is a property of the LEVEL, not of the ray, and there are only a handful of them.
   So collect them once per frame that marches at all (one O(1) step per cell) and keep the two that
   matter as SCALARS against the frame's eye altitude: the lowest altitude above the eye and the highest
   one below it. Because distance grows monotonically as the candidate moves away from the eye, the FIRST
   candidate on the far side is the only one whose reach decides the answer - so the test is that
   candidate's own predicate, three flops, no loop and no call: if the nearest altitude on this side of
   the eye does not solve inside `cap`, no altitude does, and the walk would run to its cap (up to 40
   crossings on a far row) and hand back the caller's `pl`. Skipping it is therefore not "probably fine":
   it removes no answer, only a walk that could not produce one. The rows #170 exists for - a slab's floor
   between the eye and its own ceiling plane, the 971 px of the L3 stack - hold such an altitude, so they
   still march. Altitudes outside the indexed range disable the test rather than skip on a guess, and a
   plane exactly at `cap` solves no nearer, which is the same answer the branches' comparison gives. */
/* MARCH-SKIP KILL SWITCH — `topUpEnabled`'s idiom (js/20_level.js:1079): a name a probe can reassign
   from outside, so the same process can time the march with the skip and without it. `let`, not `const`,
   for exactly that; `tools/smoke.js`'s pooled raster row flips it batch by batch to A/B the two arms on
   one layout in one context (#170). OFF the skip is a no-op and `planeAlong` walks as it did before this
   file changed; ON is the shipped path. The two arms are pixel-identical — the skip removes a walk that
   cannot answer, it does not change an answer (see buildPlaneInv) — and `view.js flatparity`'s records
   hold with the switch either way, which is what makes the paired timing a measurement of time. */
let marchSkipEnabled = true;
const PV_W = 128;                                    // plane/ZQ indices [-64 .. 63] = altitudes -16 .. 15.75 m
const PV_FLAG = new Uint8Array(PV_W), PV_VAL = new Float64Array(PV_W);
let PV_N = 0, gPVSer = -1, gPVFz = null, gPVCp = null, gPVWide = 0;
let gPVEye = NaN, gPVAbove = Infinity, gPVCbelow = -Infinity;
function buildPlaneInv() {
  const fzs = MAP.fz, cp = MAP.ceilPlane, n = fzs && cp ? fzs.length : 0;
  PV_FLAG.fill(0); gPVWide = cp && fzs ? 0 : 1;
  for (let i = 0; i < n; i++) {
    let v = fzs[i] * 4;                              // floors: fz * ZQ, and 4*ZQ is exactly 1
    if (v >= -64 && v <= 63 && v === (v | 0)) PV_FLAG[v + 64] = 1; else gPVWide = 1;
    v = cp[i] * 4;                                   // ceilAt; a solid column's floor counts too
    if (v >= -64 && v <= 63 && v === (v | 0)) PV_FLAG[v + 64] = 1; else gPVWide = 1;
  }
  PV_N = 0;
  for (let k = -64; k <= 63; k++) if (PV_FLAG[k + 64]) PV_VAL[PV_N++] = k * ZQ;
  gPVSer = gSer; gPVFz = fzs; gPVCp = cp; gPVEye = NaN;      // the split is rebuilt on the first march
}
/* The two altitudes the test needs, as of this eye altitude: ascending values, so two short scans, and
   only when the eye moved - which is once per frame, renderWorld having set eyeZ once. */
function splitPlaneInv() {
  gPVAbove = Infinity; gPVCbelow = -Infinity;
  for (let i = 0; i < PV_N; i++) if (PV_VAL[i] > eyeZ) { gPVAbove = PV_VAL[i]; break; }
  for (let i = PV_N - 1; i >= 0; i--) if (PV_VAL[i] < eyeZ) { gPVCbelow = PV_VAL[i]; break; }
  gPVEye = eyeZ;
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
  /* the plane-inventory skip, see buildPlaneInv: the nearest altitude this level has on this side of the
     eye does not solve inside this ray's reach, so no altitude does and the walk has no answer to find */
  if (marchSkipEnabled && dzPl > 1e-9) {
    if (gPVSer !== gSer || gPVFz !== fzs || gPVCp !== cp) buildPlaneInv();
    if (gPVEye !== eyeZ) splitPlaneInv();
    if (!gPVWide) {
      const plQ = (isF ? gPVCbelow : gPVAbove);      // nearest altitude this level has on this side
      const dpQ = (plQ - eyeZ) * sgn;
      if (!(dpQ > 1e-9 && dpQ * invAbsP < cap)) return pl;
    }
  }
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

/* One linked list per cell, in typed arrays grown with the level and reused every frame: no allocation
   per frame, and a pixel whose cell holds no body costs one read. A body enters every cell its contact
   disc touches (at most 9), so the ring of floor AND the face behind it both find it. SH_Z is the FEET
   - floorAt at the body's own cell - so the band test a floor pixel applies is a comparison against it
   and a body on the band above cannot darken the band you are on (#152 makes that reachable). */
const SH_CAP = 96;
let SH_HEAD = null, SH_NEXT = new Int32Array(SH_CAP), SH_N = 0;
const SH_X = new Float64Array(SH_CAP), SH_Y = new Float64Array(SH_CAP), SH_Z = new Float64Array(SH_CAP);
const SH_I = new Float64Array(SH_CAP), SH_H = new Float64Array(SH_CAP);
function buildShadowGrid() {
  const N = MAP.w, nn = N * N;
  if (!SH_HEAD || SH_HEAD.length !== nn) SH_HEAD = new Int32Array(nn);
  const head = SH_HEAD; head.fill(-1);
  SH_N = 0;
  if (!SHADOW) return;
  const far2 = SHADOW_FAR * SHADOW_FAR;
  for (let q = 0; q < ENEMIES.length && SH_N < SH_CAP; q++) {
    const e = ENEMIES[q];
    // a corpse that has finished fading draws no body, so it grounds no shadow either
    if (e.state === 'dead' && e.dieT > 3.8) continue;
    const ex = e.x - camX, ey = e.y - camY;
    if (ex * ex + ey * ey > far2) continue;
    const n = SH_N, r = SHADOW_R + e.r, fz = floorAt(e.x, e.y);
    SH_X[n] = e.x; SH_Y[n] = e.y; SH_Z[n] = fz; SH_I[n] = 1 / (r * r); SH_H[n] = r;
    const x0 = (e.x - r) | 0, x1 = (e.x + r) | 0, y0 = (e.y - r) | 0, y1 = (e.y + r) | 0;
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= N) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= N) continue;
        SH_NEXT[n] = head[cy * N + cx]; head[cy * N + cx] = n;
      }
    }
    SH_N++;
  }
  /* #371: props join the same grid. Static per level, so the distance cull is what makes this cheap -
     a level's ~30 props cost one hypot-free dot each, and only the few near the eye reach the cells. */
  if (SHADOW_PROP) {
    for (let q = 0; q < PROPS.length && SH_N < SH_CAP; q++) {
      const p = PROPS[q];
      if (p.dead && p.kind === 'barrel') continue;      // drawn as rubble, grounds no patch either
      const px = p.x - camX, py = p.y - camY;
      if (px * px + py * py > far2) continue;
      const n = SH_N, r = MESH.foot(p.kind) * (p.scale || 1) + SHADOW_PR;
      if (r <= 0) continue;                             // a kind with no authored footprint grounds nothing
      SH_X[n] = p.x; SH_Y[n] = p.y; SH_Z[n] = floorAt(p.x, p.y); SH_I[n] = 1 / (r * r); SH_H[n] = r;
      const x0 = (p.x - r) | 0, x1 = (p.x + r) | 0, y0 = (p.y - r) | 0, y1 = (p.y + r) | 0;
      for (let cy = y0; cy <= y1; cy++) {
        if (cy < 0 || cy >= N) continue;
        for (let cx = x0; cx <= x1; cx++) {
          if (cx < 0 || cx >= N) continue;
          SH_NEXT[n] = head[cy * N + cx]; head[cy * N + cx] = n;
        }
      }
      SH_N++;
    }
  }
}

/* t^SHADOW_F at a world point on a FLOOR, 0 outside every disc in the cell. Bands are compared by the
   quantum: a body one slab up answers nothing at any distance, which is the rule `heights` and `cull`
   gate. Returns the fraction to remove from the lit pixel, before the caller multiplies. */
function shadowFloor(wx, wy, plane, k) {
  for (; k >= 0; k = SH_NEXT[k]) {
    const dz = plane - SH_Z[k];
    if (dz > SHADOW_ZT || dz < -SHADOW_ZT) continue;
    const dx = wx - SH_X[k], dy = wy - SH_Y[k];
    const t = 1 - (dx * dx + dy * dy) * SH_I[k];
    if (t <= 0) continue;
    return (SHADOW_F === 2 ? t * t : Math.pow(t, SHADOW_F)) * SHADOW_D;
  }
  return 0;
}

/* The average of one mip, split the way the PIXEL shades it: emissive texels carry their own value and
   no light, lit texels are a colour the light multiplies. Computed once per mip and cached on it, and
   SHARED by the two far answers of the ground pass - castGround's row fill and groundPixel's deferred
   far band (#19) - because a material's mean is one fact and two copies of it would drift the same way
   the light ramp drifted when it lived twice. The split is not refinement: without it a material that is
   mostly emissive at the coarsest mip (level 2's floor: 52 of 64 texels) overstates the band by +28. */
function texAvg(mm) {
  if (mm.meanNE) return mm;
  let sr = 0, sg = 0, sb = 0, er = 0, eg = 0, eb = 0, nLit = 0, nEm = 0;
  for (let i = 0; i < mm.data.length; i++) {
    const v = mm.data[i];
    if ((v >>> 24) === 253) { er += v & 255; eg += (v >> 8) & 255; eb += (v >> 16) & 255; nEm++; }
    else { sr += v & 255; sg += v >> 8 & 255; sb += v >> 16 & 255; nLit++; }
  }
  const n = mm.data.length || 1;
  mm.meanNE = nLit ? [sr / nLit, sg / nLit, sb / nLit] : [sr / n, sg / n, sb / n];
  mm.meanEM = nEm ? [er / nEm, eg / nEm, eb / nEm] : mm.meanNE;
  mm.emFrac = nEm / n;
  return mm;
}

function castGround(flash, fcR, fcG, fcB) {
  gSer++;                                  // invalidates the deferred-pixel constant memo
  const hInt = Math.round(horizon);
  const stepBase = 2 / BW;
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light, fzs = MAP.fz, cp = MAP.ceilPlane;
  const floorTex = MAP.floorTex || FLOORS.CONCRETE, ceilTex = MAP.ceilTex || CEILS.CONCRETE;
  const tileF = MAP.floorTile || 1.15, tileC = MAP.ceilTile || 0.9;
  const dMasks = DECAL_MASK, dGrid = DECAL_GRID;
  const shm = SHADOW ? SH_HEAD : null;                     // #178, hoisted so the pixel loop reads a local
  const lgc = LGCAP, cnt = LGCNT;                     // #21, consts of the pass for the same reason
  const amb = AMB, fl = flash;
  if (GLRP) buildLightRamp();       // #19: nine floats a cell, once a frame - this is the only write
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
    const baseRow = amb + flashRow * 0.9 + (isF ? FLOORB : CEILB) +
      (isF || dzA <= CEILHI ? 0 : Math.min(CEILLD, CEILG * (dzA - CEILHI)));
    let tex, sc;
    if (isF) { tex = floorTex; sc = 1 / tileF; } else { tex = ceilTex; sc = 1 / tileC; }
    if (dRow > FARB || !(tex && tex.mips)) {                     // far band: light-tinted fog, no texture
      /* #197: SOURCE. The light and tint of this wash come from the cells the row's own plane solve
         LANDS IN, not from the cell the camera stands in. Both used to be cellIdx(camX, camY), which
         made the far half of the frame the camera's lamp luck: stand in a lit cell and every far row
         glowed, stand in a dark one and a lit room 30 m away went black - measured on the deployed
         build as a frame mean of 22.7 with 63.6% of pixels under 24 where the camera column's lightmap
         value alone predicted the fill. Sampled FARFAN times across the row's fan at the row's own
         solve distance and averaged: ONE LOOKUP PER SAMPLE, on the row, never per pixel, because a row
         at FARB spans ~1.4*FARB metres and one cell would book all of it to one lamp. A sample that
         leaves the map gets what the textured path gives an off-map column (white tint, light 0) - the
         grey the same ray paints one metre inside FARB - and indices are guarded on BOTH axes, since
         an index is one number and gx === -1 is a valid index for the far side of the level.
       * MAGNITUDE. The old (18 + light * 26) was a texture mean in disguise: this band is what the
         textured row would have averaged, and that row averages to texelMean * (base + light * tint),
         so 18 ~ texelMean * AMB and 26 ~ texelMean. Measured 2026-09-30 against the row ADJACENT to
         the band (same frame, same columns, ~1 m apart in distance, ground pass alone, 12 poses x 4
         yaws per level) the mean step was 18.9 on main, 8.8 with only the source fixed at (18, 26),
         and NO pair of literals closes it - its optimum is (19,26) on one level's floors and (70,7)
         on another's ceilings, because the floor materials' mip4 mean measures 89..131 and the
         ceilings' 44..79, so one pair is wrong by that ratio. Taking the mean from the mip the band
         stands in instead of guessing it gives 4.9 mean step and <= 8.9 on every level and half.
         Emissive texels are averaged with their OWN rule (light-exempt, times 1 - fog), which is how
         the pixel body shades them: without the split a material that is mostly emissive at the
         coarsest mip (level 2's floor: 52 of 64 texels) overstates the band by +28, which is the
         bright haze this row used to be instead of the room behind it. */
      const lta = MAP.lt, inv128 = 1 / 128, fstep = 2 / FARFAN, fcam = -1 + fstep * 0.5;
      const mm = tex && tex.mips ? tex.mips[tex.mips.length - 1] : tex;
      texAvg(mm);
      const dcN = mm.meanNE, dcE = mm.meanEM, wEm = mm.emFrac, wLit = (1 - mm.emFrac) * (1 / FARFAN);
      let ar = wEm * dcE[0] * invRow, ag = wEm * dcE[1] * invRow, ab = wEm * dcE[2] * invRow;
      for (let s = 0; s < FARFAN; s++) {
        const cm = fcam + fstep * s;
        const sx = (camX + (dirX + planeX * cm) * dRaw) | 0, sy = (camY + (dirY + planeY * cm) * dRaw) | 0;
        const inMap = !!lta && sx >= 0 && sy >= 0 && sx < N && sy < N;
        const ci = inMap ? sy * N + sx : 0;
        let li = inMap && lm ? lm[ci] : 0;                    // off-map -> light 0
        if (cnt) { cnt[LG_FAR]++; if (li > LG_CEIL) cnt[LG_FAR + LG_N]++; }   // site run / lookup above 1.0
        if (li > lgc) li = lgc;                                      // #21, these cells are not the camera's
        if (cnt && li > LG_CEIL) cnt[LG_FAR + 2 * LG_N]++;              // delivered above 1.0 = the defect
        ar += wLit * dcN[0] * (baseRow + li * (inMap ? lta[ci * 3] * inv128 : 1));
        ag += wLit * dcN[1] * (baseRow + li * (inMap ? lta[ci * 3 + 1] * inv128 : 1));
        ab += wLit * dcN[2] * (baseRow + li * (inMap ? lta[ci * 3 + 2] * inv128 : 1));
      }
      /* DEPTH of the far band, ceiling rows of a stepped grid: the fill's COLOUR says "everything past
         FARB", and on a flat level that is true of every column of the row. It is not true under a
         multi-quantum riser, where the row's own ceiling plane is 10-28 m out while a slab one band up
         closes the same rays at 1-4 m - and `occ < z` in js/13_mesh.js:524 then lets a prop standing on
         that slab draw through it (measured #170: 312 of the 971 leaking px of the L3 stack are these
         rows, and no per-pixel rule can reach them, because this branch never runs one). Ask the march
         once per row on the row's own centre ray - the same row-constant answer the fill is built from,
         so the fill stays a fill - and take the nearer solve. The wash itself stays: this row is about
         depth, and repainting these rows textured is the far-band look change the `bands`/`exposure`
         gates have not been re-based for. gndSteps is 0 on every flat level, so no flat frame runs it. */
      let dBand = dRaw;
      px.fill(pack(clampi(ar + fRRow), clampi(ag + fGRow), clampi(ab + fBRow)), y * BW, y * BW + BW);
      zbuf.fill(dBand, y * BW, y * BW + BW);              // depth = the row's own solve, unclamped
      if (!isF && gndSteps) {
        /* A whole-row fill cannot carry a per-ray answer, and the slab that closes these rays covers only
           part of the fan - one answer for the row is either too near at the edges (hides props an edge
           ray sees) or too far in the middle (the leak). So sweep the row in GOCCS-column slices, ask the
           march once per slice on that slice's own ray, and pull that slice nearer. Colour stays the wash:
           #170 is an occlusion defect, and the cost is rows x BW/GOCCS marches per frame - measured
           against the raster budget in the commit, not assumed. A slice whose ray says "nothing nearer"
           keeps the fill above, so this can hide no more than the ray in the middle of it honestly sees,
           and every column of the row still carries a depth (the fill runs first). */
        const GOCCS = 8;
        for (let x = 0; x < BW; x += GOCCS) {
          const cam0 = (x + (GOCCS >> 1)) * stepBase - 1;
          const plS = planeAlong(dirX + planeX * cam0, dirY + planeY * cam0, planeA, isF, absP);
          const dzS = plS - eyeZ;
          if (plS === planeA || dzS <= 1e-9) continue;
          const dS = dzS * BH / absP;
          if (dS >= dRaw) continue;
          zbuf.fill(dS, y * BW + x, y * BW + Math.min(x + GOCCS, BW));
        }
      }
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
    /* mirOn: does THIS row mirror at all? A 1 m cell at distance d is BH/d px across, so the test is one
       divide per row: wide enough that a fold reads as a panel edge -> keep the shipped mirror; a cell
       only a handful of px wide -> the fold is the spoke, and there is no repetition left to tell.
       GJIT 2 answers 1 without looking (the shipped behaviour, the A/B control); 0 answers 0. */
    const mirOn = GJIT === 2 ? 1 : (GJIT === 1 && BH / dRow >= GJITPX ? 1 : 0);
    let pxi = wx | 0, pyi = wy | 0, cIdx = pyi * N + pxi, mir = 0,
      ldr = 0, ldg = 0, ldb = 0, lhr = 0, lhg = 0, lhb = 0;
    let inMap = pxi >= 0 && pyi >= 0 && pxi < N && pyi < N;
    let lt = inMap ? cellTint(cIdx) : TINT_WHITE, li = inMap && lm ? lm[cIdx] : 0;
    if (li > 1) li = 1;
    let lr = baseRow + li * lt[0], lg = baseRow + li * lt[1], lb = baseRow + li * lt[2];
    /* The row's FIRST pixel is seeded here because the crossing branch below cannot see it. These are
       the same expressions that branch runs and they must move with it, exactly as the pixel body in
       castGround and the one in groundPixel() must move together. */
    if (inMap) {
      if (GLRP) {
        const k12 = cIdx * 12, fx = (wx - pxi) * GLRP, fy = (wy - pyi) * GLRP;
        lr += (GLC[k12 + 3] + GLC[k12 + 9] * fy) * fx + GLC[k12 + 6] * fy;
        lg += (GLC[k12 + 4] + GLC[k12 + 10] * fy) * fx + GLC[k12 + 7] * fy;
        lb += (GLC[k12 + 5] + GLC[k12 + 11] * fy) * fx + GLC[k12 + 8] * fy;
        ldr = (GLC[k12 + 3] * wxs + GLC[k12 + 6] * wys + GLC[k12 + 9] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
        ldg = (GLC[k12 + 4] * wxs + GLC[k12 + 7] * wys + GLC[k12 + 10] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
        ldb = (GLC[k12 + 5] * wxs + GLC[k12 + 8] * wys + GLC[k12 + 11] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
        lhr = 2 * GLC[k12 + 9] * wxs * wys * GLRP; lhg = 2 * GLC[k12 + 10] * wxs * wys * GLRP;
        lhb = 2 * GLC[k12 + 11] * wxs * wys * GLRP;
      }
      if (mirOn) mir = (hash2(pxi, pyi) * 4) | 0;
    }
    /* One cell-crossing test per pixel, as the pass has always had it. pxi/pyi is that walk and,
       when nothing is being re-solved, it is also the walk of the plane - the cell being shaded and
       the cell whose plane the row solved for only part company at a pixel that gets queued below,
       and those never write a pixel here. planeC is the plane of the cell the walk is standing in,
       or planeA when that column has no plane of its own or a plane these rows cannot reach. */
    let planeC = planeA;
    /* #170, the row path's own occluder (the rule and its evidence are on the march below): the run of
       columns about to be painted carries occluder depth occD for [-occX0 .. this crossing]. Row scope,
       because the flush after the pixel loop has to see it. */
    let occX0 = 0, occD = -1;
    if (pxi >= 0 && pyi >= 0 && pxi < N && pyi < N && !cellArr[cIdx]) {
      const pl0 = isF ? fzs[cIdx] * ZQ : cp[cIdx];
      planeC = (isF ? pl0 < eyeZ : pl0 > eyeZ) ? pl0 : planeA;
      // the first column's ray is the row's left edge, dir - plane. Ceiling rows only, see below.
      if (!isF && planeC !== planeA) planeC = planeAlong(dirX - planeX, dirY - planeY, planeC, isF, absP);
      /* #170, the row path's own occluder. The march above answers the pixel the row will PAINT
         DIFFERENTLY; it never runs when the walk's cell carries the row's own plane, and that is exactly
         where the leak lives: on a multi-quantum stack the row's ceiling plane can be 10-28 m out while
         a slab one band up closes the same rays at 1-4 m (measured: 971 px of L3 silhouette, 0 of them
         deferred, and the march asked on each pixel's OWN ray answered 1.00 on all 971). So ask the march
         for the DEPTH of the run the row is about to paint, and write the nearer solve into zbuf - the
         colour of the run stays the row's, because #170 is an occlusion defect and repainting these rows
         is the ceiling look change the CZBAND/`bands` gates have not been re-based for. gndSteps is
         MAP.steps, which is 1 only where a boundary differs by more than one quantum: a flat level (and
         a level of pure single-quantum steps, where the slab's underside IS the eye's own ceiling plane)
         runs no line of this and stays bit for bit what it was. */
      if (!isF && gndSteps && planeC === planeA) {
        const plO = planeAlong(dirX - planeX, dirY - planeY, planeA, isF, absP);
        const dzO = plO - eyeZ;
        if (plO !== planeA && dzO > 1e-9) { const dO = dzO * BH / absP; if (dO < dRaw) occD = dO; }
      }
    }
    /* Everything the pixel body reads is a const of this row, and that is not style: the day these
       became per-pixel `let`s, a 1202x676 frame cost 2.5 ms more for pixels nothing re-solves,
       because V8 can only keep a value in a register while nothing writes it inside the loop. So a
       pixel that needs its own distance, fog, mip and light is queued and shaded after the row by
       groundPixel(), and the flat case - every pixel of every level shipped - never touches one. */
    const dfade = dfadeRow, fog = fogRow, inv = invRow, fR = fRRow, fG = fGRow, fB = fBRow, base = baseRow;
    const mw = mRow.w, mh = mRow.h, ms = sc * mRow.w, td = mRow.data, mask = mw - 1, maskH = mh - 1;
    /* Which texture axis the ROW walks, in texels: ms scales both terms equally, so comparing the world
       deltas compares the texel deltas. The fetch lerps along this one (#19 take three). */
    const ftV = Math.abs(wys) >= Math.abs(wxs) ? 1 : 0;
    /* #19: the axial fetch's tap offset - HALF THE FOOTPRINT, along whichever axis of this pixel's
       footprint is the long one, and the fetch takes one tap on EITHER side of the point it already
       sampled. That geometry matters more than the filter itself: the pixel's strip on the plane runs
       from d(row-0.5) to d(row+0.5), i.e. about half a footprint each side of the point the row solved,
       so a pair at +-colT/2 is the box over the strip the pixel actually covers (its response is
       cos(pi*f*colT), which nulls exactly at the aliasing frequency the undersampled fetch creates),
       while a tap at ONE footprint - which is what the first version here did - estimates a mean
       centred half a footprint PAST the sample point and its response has a null at half that frequency,
       so it blurred detail and left the streak. The row loop already loads one texel a pixel, so the
       filter costs one more load, and only on the rows whose footprint is genuinely long.
       In world units the row delta is (wxs,wys) per column and the column delta is the ray times cfRow,
       so in TEXELS of this row's mip they are rowT and colT; colT > AXMIN means a pixel covers more
       world than one texel along its long axis and a single tap magnifies that texel into a radial
       wedge. The column axis is the long one on every row that was measured (the ratio reaches ~50 near
       the horizon), and the column ray is LINEAR in x - cam advances by stepBase per pixel, so rx
       advances by planeX*stepBase - which is why the offset can ride the same update clause as wx and
       cost two adds per pixel instead of a ray build. The row-long branch leaves the offset constant,
       which the loop already handles.
       GATE ON THE MAGNITUDE, OFFSET BY THE SIGNED VALUE: cfRow is negative when the column delta points
       back along the ray, and a squared comparison would read a long negative footprint as a short one
       and silently drop the filter the geometry is asking for. The offset keeps the sign; the pair is
       +-ox either way, so the filter stays symmetric whichever way that ray points. */
    const colT = cfRow * ms * 0.5, colA = colT < 0 ? -colT : colT, rowT2 = (wxs * wxs + wys * wys) * ms * ms;
    let axOn = 0, ox = 0, oy = 0, oxs = 0, oys = 0;
    if (GNDAX) {
      if (colA * colA * 4 >= rowT2) {
        if (colA * 2 > AXMIN) { axOn = 1; ox = (dirX - planeX) * colT; oy = (dirY - planeY) * colT; oxs = planeX * stepBase * colT; oys = planeY * stepBase * colT; }
      } else {
        const rowT = Math.sqrt(rowT2);
        if (rowT > AXMIN) { axOn = 1; ox = wxs * ms * 0.5; oy = wys * ms * 0.5; }
      }
      ox |= 0; oy |= 0;
    }
    /* #19 take six, the ROW copy: F is a row constant here, because the row's mip, its texel scale and
       its column delta all are - so the blend is graded per ROW in this copy and per PIXEL in the other
       one, which is the same grading at the resolution each copy resolves its mip at. */
    let ftd = null, fW = 0, fmw = 0, fmx = 0, fmy = 0, fms = 0;
    if (GNDFA && kRow + 1 < tex.mips.length) {
      const fLong = colA * colA * 4 >= rowT2 ? colA * 2 : Math.sqrt(rowT2);
      if (fLong > 1) {
        const mu = tex.mips[kRow + 1];
        ftd = mu.data; fmw = mu.w; fmx = mu.w - 1; fmy = mu.h - 1; fms = sc * mu.w;
        fW = GNDFA * (1 - 1 / fLong);
      }
    }
    let nm = 0;
    for (let x = 0; x < BW; x++, wx += wxs, wy += wys, lr += ldr, lg += ldg, lb += ldb,
      ldr += lhr, ldg += lhg, ldb += lhb, ox += oxs, oy += oys) {
      /* The bilinear is a CONVEX combination of four non-negative taps, so it cannot fall below the
         row's own base - EXCEPT where fx or fy is negative, which is the map's own left/top edge:
         gx = wx|0 truncates toward zero, so a wx of -0.5 indexes cell 0 (inMap TRUE, so this is the
         shipped light cell) with fx = -0.5, and the patch then extrapolates away from a bright cell at
         x = 0 into negative light - which is not dark, it is black fill. Three compares against the
         row's own floor; `heights`' pit config is the case that fills 3.13% of a frame with it. */
      if (lr < base) lr = base;
      if (lg < base) lg = base;
      if (lb < base) lb = base;
      const gx = wx | 0, gy = wy | 0;
      if (gx !== pxi || gy !== pyi) {                          // crossed into another cell
        pxi = gx; pyi = gy; cIdx = gy * N + gx;
        inMap = gx >= 0 && gy >= 0 && gx < N && gy < N;
        if (inMap) {
          lt = cellTint(cIdx); li = lm ? lm[cIdx] : 0.4;
          // #21: the row's own pixels are clamped at row init; a crossing re-lookup must clamp too,
          // or the same lamp renders twice at two different ceilings inside one row.
          if (cnt) { cnt[LG_ROW]++; if (li > LG_CEIL) cnt[LG_ROW + LG_N]++; }   // site run / lookup above 1.0
          if (li > lgc) li = lgc;                                    // #21, the clamp this issue is about
          if (cnt && li > LG_CEIL) cnt[LG_ROW + 2 * LG_N]++;              // delivered above 1.0 = the defect
          lr = base + li * lt[0]; lg = base + li * lt[1]; lb = base + li * lt[2];
          /* #19: the cell's own value above stays EXACTLY the shipped one - buildLightRamp clamps per
             cell with the same LGCAP, so the ramp's V and this `li * tint` agree and all that is added is
             the in-cell ramp (zero at fx = fy = 0, and zero outright when GLRP is 0). The census just ran
             on the lookup this site performs, which is what keeps #21's rows about this pass rather than
             about the ramp that now carries its answer. */
          if (GLRP) {
            const k12 = cIdx * 12, fx = (wx - gx) * GLRP, fy = (wy - gy) * GLRP;
            lr += (GLC[k12 + 3] + GLC[k12 + 9] * fy) * fx + GLC[k12 + 6] * fy;
            lg += (GLC[k12 + 4] + GLC[k12 + 10] * fy) * fx + GLC[k12 + 7] * fy;
            lb += (GLC[k12 + 5] + GLC[k12 + 11] * fy) * fx + GLC[k12 + 8] * fy;
            ldr = (GLC[k12 + 3] * wxs + GLC[k12 + 6] * wys + GLC[k12 + 9] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
            ldg = (GLC[k12 + 4] * wxs + GLC[k12 + 7] * wys + GLC[k12 + 10] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
            ldb = (GLC[k12 + 5] * wxs + GLC[k12 + 8] * wys + GLC[k12 + 11] * (wxs * fy + wys * fx + wxs * wys)) * GLRP;
            lhr = 2 * GLC[k12 + 9] * wxs * wys * GLRP; lhg = 2 * GLC[k12 + 10] * wxs * wys * GLRP;
            lhb = 2 * GLC[k12 + 11] * wxs * wys * GLRP;
          } else ldr = ldg = ldb = lhr = lhg = lhb = 0;
          /* per-cell PHASE offset of the same tile, amplitude faded with the cell's on-screen width, in
             place of the per-cell MIRROR: a flip reverses the pattern inside the cell, so every boundary
             folds it, and a fold in perspective is a spoke (#19). GJIT 2 keeps the mirror for the A/B. */
          mir = mirOn ? (hash2(gx, gy) * 4) | 0 : 0;    // per-cell mirror, dropped in the far field
        } else {
          gndOffMap++; lt = TINT_WHITE; li = 0; lr = lg = lb = base; ldr = ldg = ldb = lhr = lhg = lhb = 0; mir = 0;
          /* #375 census, ROW COPY. Read at the crossing, once, not per pixel: this branch zeroes the
             light AND its three deltas, so every pixel until the next crossing keeps exactly this value
             - which makes the site representative of the run of off-map pixels it starts, and that run
             is what the wedge would be. The limitation is stated, not glossed: a future edit that left
             this site at ambient and put light back in the DELTAS would not move the counter (the row's
             ramp terms are covered by mip's gradient rows and by #21's census). */
          if (cnt && !inMap && offMapClear(wx, wy, N)) {
            cnt[LG_ROWOFF]++;
            const om = Math.max(lr, lg, lb) - base;
            const oi = om > 0 ? (om * 1000 + 0.5) | 0 : 0;
            if (oi > cnt[LG_ROWOFFMAX]) cnt[LG_ROWOFFMAX] = oi;
          }
        }
        /* Only AIR columns have a floor and a ceiling: a solid column has no air, so its ceilAt is a
           fiction, and the void outside the map is today's flat ground - both mean "no plane of your
           own". Both axes are tested here even though inMap tested the index, because the index is
           one-dimensional and gx === -1 with gy > 0 is a valid index for a cell on the far side of
           the level: reading a plane THROUGH a wall is how a room two cells out of sight gets painted
           across the middle of one, and it once filled an entire frame with grey. */
        let pl = planeA;
        if (gx >= 0 && gy >= 0 && gx < N && gy < N && !cellArr[cIdx]) pl = isF ? fzs[cIdx] * ZQ : cp[cIdx];
        /* A FLOOR above the eye used to be refused here exactly like a ceiling below it, which threw away
           the one fact the pixel carries: the cell it landed in is AIR and its floor is OVER its head, so
           the ray has walked INTO that column's slab and the row's own plane does not reach it (#192).
           Refusing let the pixel be painted by the row at the row's distance, which is the far floor behind
           the deck: a deck was see-through in exactly the cases where the raise is not CZ_DEF, because when
           the raise equals the ceiling height the slab's underside is the eye's own ceiling plane and the
           CEILING half answers it honestly through ceilAt. Queue the pixel with the deck's own plane and
           let the deferred copy answer the crossing it slipped under - groundPixel's `t < eyeZ` refusal
           still cannot solve a plane above the eye (d goes negative), and does not have to: the honest
           distance is the slab's SIDE, the same number the wall pass writes for that boundary's face, so
           the two passes now agree instead of disagreeing by the depth of the deck. A flat level's floor is
           never above the eye, so no flat pixel is queued and the flat row stays bit-identical. */
        planeC = (isF ? (pl < eyeZ || (gx >= 0 && gy >= 0 && gx < N && gy < N && !cellArr[cIdx] && pl >= eyeZ))
          : pl > eyeZ) ? pl : planeA;                          // a ceiling below the eye reaches nothing
        /* ONE MARCH PER (ROW, CELL), on the ray of the column that crossed into the cell, instead of one
           per queued pixel of the run (#170's mechanism, #15's arrival half). This is the row loop's own
           predictor applied to the deferred half: the answer is a property of the CELL SEQUENCE the ray
           walks, and a run's rays differ only by the fan of the frustum. Measured per pixel, both answers
           computed in one process from the same state: they agree on 100% of the queued ceiling pixels of
           25 configs (queue nonempty in 20, up to 74,833 px in a frame, runs up to 314 columns), and the
           compare is seen to fire - against the UNMARCHED cell plane it reads 100%, and a deliberate
           0.05 rad (30-column) ray swap reads 1.03% on the far-ceiling poke, so the predictor is stable at
           a column step and not at thirty of them. CEILING ROWS ONLY, for the reason the block above
           states: the FLOOR half's fixed point ADOPTS a lower plane further along the ray, so walking that
           half is a look change with its own gate. Cells come from the march's own DDA, the quantum test
           is an exit and not a convergence proof, and both axes are bounds-tested inside planeAlong; this
           changes how often the march runs, not what it does.
           What it is worth and what it costs, measured on GROUND-PASS dumps because the wall pass repaints
           rows and a composited md5 cannot see this half: 156 marches a frame at the Lv1 SEED 12345 spawn
           seat instead of 4,571 (642 against 51,938 at the flatparity DEALT camera), 1.5 ms of a 15 ms
           frame and 22 ms of an 85 ms one. zbuf is BIT-IDENTICAL on all 48 configs measured - arrivals on
           three levels x two seeds, the three DEALT seats, turn sweeps and the poked stepped bands - so no
           occlusion test can flip, and the mover silhouette and MESH's drawn-pixel count are identical on
           the 36 configs that draw one; cull/heights/bands/planes/sight and the PARITY/LOCK/DEALT and
           CZBAND locks print the same text either side. On the two DEALT-seat frames 264 and 696 ceiling
           ground pixels (rows 54..59) do change colour by up to 7.1 luminance: their march answers the
           ROW's plane, so they stop going through the deferred body at all, and the two copies of the
           pixel body pick slightly different mips at the same distance. Every one of those pixels is
           repainted by the wall pass, so the composited frame is identical in all 48 configs. */
        if (!isF && (planeC !== planeA)) {
          const cam0 = x * stepBase - 1;
          planeC = planeAlong(dirX + planeX * cam0, dirY + planeY * cam0, planeC, isF, absP);
        }
        /* The run that just ENDED carried the occluder decided at its own crossing: give its columns the
           nearer depth, then decide the new run's on this column's ray (one march per (row, cell), the
           same coalescing and the same fan claim the block above documents). Queued columns are skipped
           here - groundPixel() writes their depth after the row, from the plane the row marched for them,
           so depth stays a property of the geometry rather than of which path painted the pixel. */
        if (!isF && gndSteps) {
          if (occD >= 0) zbuf.fill(occD, row + occX0, row + x);
          occD = -1; occX0 = x;
          if (planeC === planeA) {
            const cam0 = x * stepBase - 1;
            const plO = planeAlong(dirX + planeX * cam0, dirY + planeY * cam0, planeA, isF, absP);
            const dzO = plO - eyeZ;
            if (plO !== planeA && dzO > 1e-9) { const dO = dzO * BH / absP; if (dO < dRaw) occD = dO; }
          }
        }
      }
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
      const ux = wx * ms, uy = wy * ms;
      let tx = ux | 0, ty = uy | 0, ufx = ux - tx, ufy = uy - ty;
      /* floor, not truncate: |0 rounds toward zero, so a coordinate in (-1,0) would index texel 0 with a
         NEGATIVE fraction and the lerp would extrapolate outside the tile it is reading. The point is in
         the texel below, and that is the pair the lerp takes. */
      if (ufx < 0) { tx--; ufx++; }
      if (ufy < 0) { ty--; ufy++; }
      tx &= mask; ty &= maskH;
      /* A mirror flips the pattern, so the texel the walk enters NEXT is the one at the LOWER index: same
         mask-as-mirror the point fetch does, one texel earlier, with the fraction read backwards. At
         ufraction 0 this is bit for bit the texel that shipped. */
      if (mir & 1) { tx = (mask - tx - 1) & mask; ufx = 1 - ufx; }
      if (mir & 2) { ty = (maskH - ty - 1) & maskH; ufy = 1 - ufy; }
      const c = td[ty * mw + tx];
      const i = row + x;
      let cr = c & 255, cg = c >> 8 & 255, cb = c >> 16 & 255, em = c >>> 24;
      if (GNDFT) {                              // the filtered half: one texel across the sub-texel side
        const c1 = ftV ? td[((ty + 1) & maskH) * mw + tx] : td[ty * mw + ((tx + 1) & mask)];
        const wf = ftV ? ufy : ufx;
        cr += ((c1 & 255) - cr) * wf;
        cg += ((c1 >> 8 & 255) - cg) * wf;
        cb += ((c1 >> 16 & 255) - cb) * wf;
        if ((c1 >>> 24) === 253) em = 253;      // 253 is a FLAG, not a coverage value (#20)
      }
      if (axOn) {                                // the anisotropic HALF of anisotropic filtering: one
        const oxi = (ox + 0.5) | 0, oyi = (oy + 0.5) | 0;    // tap on each side of the point, so the
        const c1 = td[((ty - oyi) & maskH) * mw + ((tx - oxi) & mask)];   // pair is the box over the
        const c2 = td[((ty + oyi) & maskH) * mw + ((tx + oxi) & mask)];   // strip this pixel covers
        cr = cr * 0.5 + (c1 & 255) * 0.25 + (c2 & 255) * 0.25;
        cg = cg * 0.5 + (c1 >> 8 & 255) * 0.25 + (c2 >> 8 & 255) * 0.25;
        cb = cb * 0.5 + (c1 >> 16 & 255) * 0.25 + (c2 >> 16 & 255) * 0.25;
        /* 253 is a FLAG, not a coverage value (#20), so a mean of alpha bytes is not it and the pixel
           would silently lose its light-exempt path - which on level 2's ceiling, where mip 4 is 52 of
           64 texels flagged, is most of the far field. A footprint that touches an emissive texel
           emits, exactly as the wall pass decides it for a bilinear quartet (js/40_render.js:1568). */
        if ((c1 >>> 24) === 253 || (c2 >>> 24) === 253) em = 253;
      }
      if (fW > 0) {                          // #19 take six: the share of this pixel's footprint its
        const vx = wx * fms, vy = wy * fms;  // own level cannot carry, from one level coarser
        let t2 = vx | 0, t3 = vy | 0;
        if (vx < 0) t2--;
        if (vy < 0) t3--;                    // floor, not truncate - the same guard as the point fetch
        t2 &= fmx; t3 &= fmy;
        if (mir & 1) t2 = (fmx - t2 - 1) & fmx;
        if (mir & 2) t3 = (fmy - t3 - 1) & fmy;
        const c3 = ftd[t3 * fmw + t2];
        cr += ((c3 & 255) - cr) * fW;
        cg += ((c3 >> 8 & 255) - cg) * fW;
        cb += ((c3 >> 16 & 255) - cb) * fW;
      }
      if (em === 253) { px[i] = 0xFF000000 | clampi(cb * inv + fB) << 16 | clampi(cg * inv + fG) << 8 | clampi(cr * inv + fR); continue; }
      let r = cr * lr + fR, g = cg * lg + fG, b = cb * lb + fB;
      /* #413: a FITTING on the ceiling of this cell, ceiling rows only. One byte per cell decides it,
         so the cost on the 99 % of cells with no fitting overhead is that read. The plate is shaded by
         THIS column's light and fog - the same terms the sheet behind it used a line above - and the
         source it houses is what put that light here, so the object and its pool always agree. */
      if (!isF && inMap && CF_FIX !== null && CF_FIX[cIdx] !== 0 && ceilFixAt(wx, wy)) {
        r += (CF_R * lr + fR - r) * CF_A; g += (CF_G * lg + fG - g) * CF_A; b += (CF_B * lb + fB - b) * CF_A;
      }
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
      /* #178 contact shadow: the world the body occludes, darkened. Floor rows only, and only on the
         band the body stands on. Both axes are tested before the index, because cIdx is one number and
         gx === -1 with gy > 0 is a valid index into a cell on the far side of the level. A MULTIPLY on
         the lit pixel, so the AMB floor that sinks an additive rim cannot sink this; no zbuf write. */
      if (shm && isF && inMap) {
        const sk = shm[cIdx];
        if (sk >= 0) { const kk = 1 - shadowFloor(wx, wy, planeC, sk); r *= kk; g *= kk; b *= kk; }
      }
      px[i] = 0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r);
    }
    /* second pass over the columns this row could not solve, in column order; each writes its own
       pixel so the order within the row cannot change the image, and the wall pass has not run yet */
    if (occD >= 0) zbuf.fill(occD, row + occX0, row + BW);   // the last run of the row, #170
    /* #prototype: a ceiling run of contiguous columns shares one plane, so it takes ONE call. Floors keep one call per column because their plane is solved per column. */
    for (let q = 0; q < nm; ) {
      const x0 = RX[q], plq = RP[q];
      let e = q + 1;
      if (!isF) while (e < nm && RP[e] === plq && RX[e] === RX[e - 1] + 1) e++;
      groundPixel(x0, RX[e - 1] + 1, plq, row, isF, absP, tex, sc, fcR, fcG, fcB, fl, amb, dRow, planeA);
      q = e;
    }
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
/* A deferred pixel's shading constants are a function of (ROW, PLANE) and nothing else: the engine's d
   is a PARAMETER along (dir + plane*cam), so d = |plane - eyeZ| * BH / |p| is the same number for every
   column of a row that shares a plane - and the decal fade, the fog, the flash term and the world step
   per column follow from that one number. Solving them per call is what made the deferred copy the hot
   loop once a generated level carried a second plane over part of the frame (measured on the raised
   quadrant: 26,106 deferred px of 203k, 12.9% of the frame, 57 ms/frame against 13 ms for the same
   geometry painted by the row loop). So the constants are built once per (row, plane) and rebuilt only
   when a pixel's honest plane differs from the one its run was queued with - which is also the rule the
   floor half's fixed point already reached after one try on 94% of its pixels. A flat level never gets
   here at all, so this path cannot move a pixel of one. */
let gSer = 0, gMSer = -1, gMRow = -1, gMPl = 0, gMDS = 0, gMDfa = 0, gMFog = 0, gMInv = 0, gMFR = 0,
  gMFG = 0, gMFB = 0, gMBase = 0, gMCx0 = 0, gMCy0 = 0, gMCxs = 0, gMCys = 0,
  gMCf = 0, gMAx = 0, gMWs = 0, gMAn = 1, gMAr = 4, gMN = 0, gMDist = -1, gMMirOn = 0,
  gMFar = 0, gMWnR = 0, gMWnG = 0, gMWnB = 0, gMWErr = 0, gMWEg = 0, gMWEm = 0, gMLift = 0,
  gLSer = -1, gLSX = 0, gLSY = 0, gML0 = 0, gML1 = 0, gML2 = 0, gMMir = 0,
  gMA0 = 0, gMA1 = 0, gMA2 = 0, gMB0 = 0, gMB1 = 0, gMB2 = 0, gMD0 = 0, gMD1 = 0, gMD2 = 0;

function gndBuild(row, isF, absP, pl, tex, sc, fcR, fcG, fcB, fl, amb, dOv) {
  /* dOv >= 0 replaces the PLANE SOLVE with a distance the caller already knows - the only caller that
     passes it is the under-a-slab case below, where the surface stopping the ray is a crossing rather
     than a plane and the plane it was queued with has no solve. The memo carries it (gMDist) because a
     run of pixels can share a plane and differ in where they slip under: keying on the plane alone would
     hand one column's fog and mip to the next. */
  const dS = dOv >= 0 ? dOv : (isF ? eyeZ - pl : pl - eyeZ) * BH / absP;
  const dc = dS > FARB * 4 ? FARB * 4 : dS;
  const fog = fogAt(dc);
  gMSer = gSer; gMRow = row; gMPl = pl; gMDS = dc; gMDist = dOv === undefined ? -1 : dOv;
  gMDfa = 0.4 + 0.6 * Math.exp(-dc * 0.02);
  gMFog = fog; gMInv = 1 - fog; gMFR = fcR * fog; gMFG = fcG * fog; gMFB = fcB * fog;
  gMLift = !isF && pl - eyeZ > CEILHI ? Math.min(CEILLD, CEILG * (pl - eyeZ - CEILHI)) : 0;
  gMBase = amb + fl * Math.exp(-dc * 0.30) * 0.9 + (isF ? FLOORB : CEILB) + gMLift;
  /* the sampled point is LINEAR in the column: camX + (dirX + planeX*(x*stepBase-1))*dS, so a pixel
     of this run needs two multiplies, not a ray build. Same algebra the row uses for its own wx/wys. */
  const sb = 2 / BW;
  gMCxs = sb * planeX * dc; gMCys = sb * planeY * dc;
  gMCx0 = camX + (dirX - planeX) * dc; gMCy0 = camY + (dirY - planeY) * dc;
  /* mip selection, per (row, plane): mipSel's ROW axis is the same number for every column of the run,
     and only its column axis moves - by |ray|, which is what the pixel's own cam offset says. Same
     expressions and the same evaluation order as the call, so the chosen level is the same texel-for-
     texel; the anisotropy switch stays honoured because `view.js mip` A/Bs it as a control. */
  const ax0 = planeX * sb * dc, ax1 = planeY * sb * dc, ws = tex.mips[0].w * sc;
  gMAx = Math.sqrt(ax0 * ax0 + ax1 * ax1) * ws; gMCf = dc / absP; gMN = tex.mips.length;
  gMAn = MIPAX; gMAr = MIPAR; gMWs = ws;
  /* #19: the mirror gate again from THIS run's own distance - a deferred pixel is a different plane and
     so a different distance - same test, same constant, one divide. */
  gMMirOn = GJIT === 2 ? 1 : (GJIT === 1 && BH / dc >= GJITPX ? 1 : 0);
  /* #19 take five - THE FAR ANSWER. Past FARB the ROW loop stops fetching: it fills the row with the
     material's own mip mean, tinted by the row's light and fog, because a row out there spans more
     world than the mip chain holds (the chain ends at 8x8; the census in issue #19 measured a far
     ceiling pixel whose ideal mip was 11). The DEFERRED copy had no such branch - it textured every
     pixel out to FARB*4, and its pixels are the far field of a stepped level (18,704 of the level-0
     cam1 frame, 53-64% of every row of the bright ceiling wedge). One fetch per pixel of a footprint
     that long is a single texel stretched into a strip whose long axis is the pixel-to-VP line: the
     fan of spokes, and the reason forcing that copy's texel to flat grey is the control that makes the
     spokes go away. So the far field now answers the SAME QUESTION the same way in both copies of this
     body: same threshold (the pixel's own solve against FARB, not the row's), same mip mean, same
     emissive split, that pixel's own light. It is not a blur - nothing is averaged that the row loop
     would still fetch, and past FARB it is CHEAPER than the path it replaces (no mip select, no
     mirror hash, three texel loads become none). GNDFB 0 puts the textured far field back, which is
     the A/B: `DEV.set('gndfar', 0)` brings the wedge's comb back in the running page. */
  if (GNDFB && dc > FARB) {
    const mm = tex.mips ? tex.mips[gMN - 1] : tex;
    texAvg(mm);
    const wLit = 1 - mm.emFrac, wEm = mm.emFrac * gMInv;
    gMFar = 1;
    gMWnR = mm.meanNE[0] * wLit; gMWnG = mm.meanNE[1] * wLit; gMWnB = mm.meanNE[2] * wLit;
    gMWErr = mm.meanEM[0] * wEm; gMWEg = mm.meanEM[1] * wEm; gMWEm = mm.meanEM[2] * wEm;
  } else gMFar = 0;
}

/* Where a DESCENDING ray goes under a slab, as the crossing's own distance along (dir + plane*cam) - or
   -1 when nothing closes over it. A FLOOR at or above the eye cannot be solved by a floor row (the engine's
   d = (eyeZ - plane) * BH / |p| is negative there), so the honest answer for a pixel whose ray walked into
   such a column is not a plane at all: it is the boundary the ray slipped under, which is also the distance
   the wall pass writes for that boundary's riser face (#192), so the two passes hold one depth. Marched
   rather than solved because a DESCENDING ray meets a slab SIDE before it meets any plane. One axis per
   crossing, for the reason planeAlong states: stepping both walks a diagonal the ray never travels. A
   column's side and the void are answered -1 - the wall pass paints a column either way, and the void is
   today's flat ground. Runs from groundPixel's floor half only, on the pixels whose cell floor is at or
   above the eye: the row loop must never call this (a march per cell crossing is the documented cliff). */
function slabT(rx, ry, absP) {
  const N = MAP.w, cellArr = MAP.cell, fzs = MAP.fz, rise = absP / BH;
  const ax = rx > 0 ? rx : -rx, ay = ry > 0 ? ry : -ry;
  const sx = rx > 0 ? 1 : -1, sy = ry > 0 ? 1 : -1;
  let cx = camX | 0, cy = camY | 0, g = 0;
  let tx = ax > 0 ? (rx > 0 ? cx + 1 - camX : camX - cx) / ax : 1e30;
  let ty = ay > 0 ? (ry > 0 ? cy + 1 - camY : camY - cy) / ay : 1e30;
  for (; g < 40; g++) {
    const tOut = tx < ty ? tx : ty;
    if (!(tOut < FARB * 4)) return -1;                        // nothing closes over it inside reach
    const stepX = tx < ty, nx = cx + (stepX ? sx : 0), ny = cy + (stepX ? 0 : sy);
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) return -1;    // the void is not a slab
    const j = ny * N + nx;
    if (cellArr[j]) return -1;                                // a column: the wall pass owns this pixel
    if (fzs[j] * ZQ >= eyeZ) return tOut;                     // under that column's floor: its side stops us
    const i = cy * N + cx;                     // the floor of the cell being left stops the ray first, and
    if (cx >= 0 && cy >= 0 && cx < N && cy < N && !cellArr[i]) {  // then the crossing behind it is a solve,
      const fl = fzs[i] * ZQ;                                  // not a slab: the row's answer was honest
      if (fl < eyeZ && (eyeZ - fl) / rise <= tOut) return -1;
    }
    cx = nx; cy = ny;
    if (stepX) tx += 1 / ax; else ty += 1 / ay;
  }
  return -1;
}

function groundPixel(x0, x1, pl, row, isF, absP, tex, sc, fcR, fcG, fcB, fl, amb, dP, plA) {
  const N = MAP.w, cellArr = MAP.cell, lm = MAP.light, fzs = MAP.fz, stepBase = 2 / BW;
  const shm = SHADOW ? SH_HEAD : null;                      // #178, second copy of the ground pixel body
  const lgc = LGCAP, cnt = LGCNT;                     // #21, second copy of the light ceiling too
  /* RUN LOOP (#prototype): one call per run of columns that share (row, plane); x1 is exclusive. */
  for (let x = x0; x < x1; x++) {
  const cam = x * stepBase - 1, rx = dirX + planeX * cam, ry = dirY + planeY * cam;
  // the cell this pixel's ray reaches at the ROW's distance: the shipped out-of-map fallback cell and
  // the anchor the floor half's settle test measures its two-cell proximity against
  const ax = (camX + rx * dP) | 0, ay = (camY + ry * dP) | 0;
  let dOv = -1;                                    // >= 0 when a crossing, not a plane, places the pixel
  if (isF) {
    /* The FLOOR half keeps the shipped solver's SHAPE - the plane the pixel was queued with may be
       replaced by the floor of the cell the pixel lands in, once per try, quantum apart = settled -
       but runs the arithmetic only, with no shading in the loop, and the plane it lands on is what the
       (row, plane) constants are built from. That is the same answer the three-try loop left in dS:
       d is always the final plane's solve, whether the loop broke, settled or ran out. It adopts a
       LOWER plane it finds further along the ray, which down a staircase paints the bottom floor's
       plane at 18 m where walking the ray says the first step's plane answered at 9.4 m - a phantom,
       and the reason the `bands` walk-lip row reads 45.4 instead of 27.1; walking the floor half needs
       its own change and its own look gate, not a quiet edit to that threshold. */
    let cur = pl, aq = ax, aqq = ay, settled = false;
    for (let g = 0; g < 3; g++) {
      const d0 = (eyeZ - cur) * BH / absP, dc = d0 > FARB * 4 ? FARB * 4 : d0;
      const qx = (camX + rx * dc) | 0, qy = (camY + ry * dc) | 0;
      const mx = (qx + aq) >> 1, my = (qy + aqq) >> 1;
      // a plane may only come from a column within two cells on BOTH axes with no solid column between
      let plN = cur;
      if (qx >= 0 && qy >= 0 && qx < N && qy < N && Math.abs(qx - aq) <= 2 && Math.abs(qy - aqq) <= 2 &&
        mx >= 0 && my >= 0 && mx < N && my < N && !cellArr[my * N + mx]) {
        const ii = qy * N + qx;
        if (!cellArr[ii]) { const t = fzs[ii] * ZQ; if (t < eyeZ) plN = t; }
      }
      aq = qx; aqq = qy;
      // planes are quantized to ZQ, so agreement within one quantum is convergence: a pixel on the
      // seam between two cells whose planes differ by a quantum has no fixed point and alternates
      // forever (measured: 33,656 of a frame's re-solves on eyeUp, all a 1 <-> 1.25 two-cycle)
      if (Math.abs(plN - cur) <= ZQ) { settled = true; break; }
      cur = plN;
    }
    // an exhausted loop used to leave dS from the PREVIOUS plane; the plane finally used places the
    // pixel, so it is counted here and solved like every other one
    if (!settled) reSolveBad++;
    pl = cur;
    /* #192, the deck faces: `t < eyeZ` above refuses a floor that is at or above the eye, so a pixel
       queued from under a deck leaves this loop with the deck's own plane in `pl` and no solve for it.
       What stops a descending ray there is the slab's SIDE at the boundary it slipped under, so ask the
       march for that crossing and build the pixel from its distance. When the march says nothing closes
       over the ray - the pixel's cell was only the row's WALK and a floor in front stopped the ray first -
       the honest answer is the band the eye is in, so the pixel falls back to the predictor rather than to
       a plane it cannot solve. Costs one march per queued pixel of this one case and nothing anywhere
       else: a flat level never queues a pixel, and a below-the-eye pixel never reaches this line. */
    if (pl >= eyeZ) {
      const st = slabT(rx, ry, absP);
      if (st >= 0) { dOv = st; }
      else { pl = plA; dOv = -1; }
    }
  } else if (pl === plA && MAP.steps) {
    /* The CEILING half needs no march here: the ROW marched this pixel's cell once, at the column that
       crossed into it, and queued the plane that answer produced (#15's per-cell decision). Keeping a
       march in this copy is what made the deferred path cost one 40-step DDA per pixel of a run - the
       same cliff the row loop's own comment refuses. The FLOOR half keeps its fixed point and its
       under-a-slab march per pixel: those are a different question (which plane places this pixel), and
       walking the floor half is a look change the bands gate has not been re-based for.
       EXCEPT, precisely, when the queued plane IS the row's predictor: then no march produced it, this
       copy inherited the row's guess, and the row's guess is what #170 measured wrong (its own occluder
       block answers that question for the pixels the row paints; it cannot reach the ones queued here).
       The queue condition is `planeC !== planeA`, so no shipped frame ever arrives in this branch - one
       compare per deferred pixel, no march, no picture - and `cull`'s deferred-copy control, which forces
       every re-solvable column through here, is what makes the agreement between the two copies of this
       body a row rather than a claim. A future split that queues what the row used to paint therefore
       still hides the prop, because the rule lives in both copies and not in which path ran. */
    const plO = planeAlong(rx, ry, plA, false, absP);
    const dzO = plO - eyeZ;
    if (plO !== plA && dzO > 1e-9) {
      const dO = dzO * BH / absP;
      if (dO < (pl - eyeZ) * BH / absP) dOv = dO;   // the slab's solve places this pixel, not the row's plane
    }
  }
  if (gMRow !== row || gMPl !== pl || gMDist !== dOv || gMSer !== gSer)
    gndBuild(row, isF, absP, pl, tex, sc, fcR, fcG, fcB, fl, amb, dOv);
  const dS = gMDS;
  /* This pixel's cell is NOT on the row's plane, so the row's depth is wrong for it: at the lip of a
     step the row says the distance to the plane the eye is in, while the colour painted here came from
     a plane one quantum (or two units) away - the distance this pixel's plane solves to. */
  zbuf[row + x] = dS;
  const cx = gMCx0 + x * gMCxs, cy = gMCy0 + x * gMCys;
  let sx = cx | 0, sy = cy | 0;
  /* a re-solved pixel that leaves the map falls back to the predictor's cell - the cell the row's own
     walk would have reached - so it shades like a flat pixel at that distance instead of wrapping to a
     cell on the far side of the level. `own` records that the fallback FIRED, which the ramp below
     needs: (cx - sx) stops being a fraction the moment sx is somebody else's cell.
     #19: this is where the far field's fan lived. Measured at the level-0 cam1 seat on THIS tree, with
     the per-pixel light on: 18,704 deferred pixels in one frame, EVERY one of them with |fx| > 1 and the
     worst at 68.37 - a pixel whose ray landed at world (62.2, 44.2) of a 26x26 map fell back to the camera's
     own cell (22, 15) and then interpolated that cell's slopes 40 cells in x and 29 in y. The delivered
     light multiplier reached 136 (11,117 of those pixels sat outside [0.2, 1.5]), so the ceiling
     past the map edge is not shaded, it is multiplied into clipping, and its level sets are straight
     world-aligned lines - which in perspective is a fan of spokes meeting at the vanishing point, brightest
     exactly where the lamp pool is brightest. `main` cannot show this term because its deferred copy has
     no ramp at all (`lr = gMBase + gML0`), so the runaway is take two's regression, not the shipped look.
     The rule the row copy already obeys is restated here: the ramp is an interpolation INSIDE the cell whose
     light it reads, so when the pixel has no cell of its own its fraction is 0 and it takes that cell's
     value whole - which is bit for bit what `main` delivers at the same pixel. GNDRO 0 puts the
     extrapolation back, so the A/B is one DEV.set call and the blown wedge comes back visibly. */
  const own = sx >= 0 && sy >= 0 && sx < N && sy < N;
  if (!own) { gndOffMap++; sx = ax; sy = ay; }
  const inMap = sx >= 0 && sy >= 0 && sx < N && sy < N, cIdx = sy * N + sx;
  let lr, lg, lb, mir;
  /* Light and jitter are functions of the CELL, not of the pixel: the row loop recomputes them at a
     crossing for exactly that reason, and here they are the same three loads plus one hash pair per cell
     change instead of per pixel. Keyed by the frame serial too, because the lightmap fades between
     frames. #19: BOTH were cell-CONSTANT here - one light value and one mirror flip per cell - and that
     is what drew the fan of spokes; see the same two terms in castGround's row. The six ramp SLOPES are
     memoised as scalars rather than read out of GLC per pixel: this copy already costs a march, and nine
     random reads into a 100 KB array per deferred pixel is not the way to spend them. */
  if (gLSer !== gSer || sx !== gLSX || sy !== gLSY) {
    gLSer = gSer; gLSX = sx; gLSY = sy;
    gML0 = gML1 = gML2 = 0; gMA0 = gMA1 = gMA2 = gMB0 = gMB1 = gMB2 = gMD0 = gMD1 = gMD2 = 0; gMMir = 0;
    const lta = MAP.lt, kk = cIdx * 3;
    if (inMap && lta && cIdx >= 0 && kk + 2 < lta.length) {
      /* #21: this is the SECOND copy of the ground pixel body, so it carries the same `li > LGCAP`
         ceiling the row loop's crossing carries. Without it light is a property of WHICH PATH painted
         the pixel, and `heights` is the probe that paints pixels through both. buildLightRamp applies
         the same ceiling per cell, so the ramp this site adds is smooth across a clamped lamp too. */
      let li = lm ? lm[cIdx] : 0.4;
      if (cnt) { cnt[LG_DEF]++; if (li > LG_CEIL) cnt[LG_DEF + LG_N]++; }   // site run / lookup above 1.0
      if (li > lgc) li = lgc;
      if (cnt && li > LG_CEIL) cnt[LG_DEF + 2 * LG_N]++;              // delivered above 1.0 = the defect
      gML0 = li * lta[kk] / 128; gML1 = li * lta[kk + 1] / 128; gML2 = li * lta[kk + 2] / 128;
      if (GLRP) {                                // GLC is null until a frame has run with GLRP on
        const k12 = cIdx * 12;                   // it covers every in-map cell: built from MAP.w
        gMA0 = GLC[k12 + 3]; gMA1 = GLC[k12 + 4]; gMA2 = GLC[k12 + 5];
        gMB0 = GLC[k12 + 6]; gMB1 = GLC[k12 + 7]; gMB2 = GLC[k12 + 8];
        gMD0 = GLC[k12 + 9]; gMD1 = GLC[k12 + 10]; gMD2 = GLC[k12 + 11];
      }
      if (gMMirOn) gMMir = (hash2(sx, sy) * 4) | 0;        // the same gate as the row loop's mirOn
    }
  }
  /* The same patch the row loop walks, and the same floor on it: the four weights sum to 1 and every
     tap is >= 0, so the only way below the ambient base is a NEGATIVE fx or fy - cx can sit in (-1,0)
     and still index cell 0, which is in-map, and the patch then extrapolates off the map's own edge.
     `own` closes the OTHER way out of the patch, the one that reaches 136 rather than below zero: a
     pixel that fell back to the predictor has an (cx - sx) of whole cells, not a fraction (#19). */
  const fx = (own || !GNDRO) ? (cx - sx) * GLRP : 0, fy = (own || !GNDRO) ? (cy - sy) * GLRP : 0;   // GNDRO 0 reproduces the extrapolation for the A/B
  const vr = gMBase + gML0 + (gMA0 + gMD0 * fy) * fx + gMB0 * fy,
    vg = gMBase + gML1 + (gMA1 + gMD1 * fy) * fx + gMB1 * fy,
    vb = gMBase + gML2 + (gMA2 + gMD2 * fy) * fx + gMB2 * fy;
  lr = vr < gMBase ? gMBase : vr; lg = vg < gMBase ? gMBase : vg; lb = vb < gMBase ? gMBase : vb;
  mir = gMMir;
  /* #375: A PIXEL WITH NO CELL STILL HAS A PLACE, and light belongs to the place, not to whichever cell
     the row happened to walk last. `!own` means the ray left the level and met the plane in empty space.
     What it took there was the light of the ANCHOR cell - the cell the row's walk reached at the row's own
     distance - at full strength, with no ramp and no falloff: one lamp then lights the entire off-map half
     of the ceiling plane, and the set of rays that land off-map is bounded by the map's own side edges,
     which along an axis are straight lines through the vanishing point. So the level's footprint is drawn
     on the ceiling as a bright trapezoid with a one-pixel straight edge at any distance - measured at the
     level-0 cam1 seat as the brightest large region of the frame (both arms in one process: frame mean
     52.7 with GNDOF off, 50.6 with it on, 18,035 px differing and every one of them in buffer rows
     109..161; the issue's own control, zeroing this copy's light, removes the outline the same way).
     The fix is not a new rule: it is the SAME field the row loop walks. buildLightRamp's patch is a
     bilinear whose taps are cell light vectors and read 0 off the map, so the field is already 0 by the
     time a ray crosses the boundary lattice line, and the last in-map column already ramps down to it.
     The deferred copy only has to EVALUATE that field at the point it landed on instead of borrowing a
     cell it never reached: the four lattice taps around (cx, cy), out-of-map taps 0, weights a convex
     combination - which is also why this cannot exceed the LGCAP ceiling #21 counts above, since it is a
     weighted mean of taps that are each already clamped. Math.floor, not |0: a lattice point at -1 is
     OFF the map and truncation toward zero would call it cell 0 and extrapolate away from it (#19).
     GNDOF 0 = the anchor's light as this shipped, so the wedge comes back for the A/B with one DEV.set.
     BOTH HALVES (#385). This was the ceiling half only for one increment: applied to the FLOOR half the
     same rule dims the far floor on the authored level - the L3 step-lip pair in `bands` falls from mean
     |dL| 63.4 to 25.2 and the far floor it measures against from 57 to 38 in frame luminance - and that
     step is #203's depth cue, so the halves were left different while the value question was open. It is
     answered: past a level's own footprint there is no floor to walk on, so that pixel belongs to the
     depth cue and not to the room, and a lamp 40 m back has no business lighting it. The step-lip contrast
     is re-baselined from this build rather than held up by the artefact (`bands`' L3 lip rows and the
     CHANGELOG carry the moved numbers). Do not re-light the far floor to recover a contrast figure. */
  if (!own && GNDOF) {
    const lta = MAP.lt;
    /* #375's SECOND charge, found after #392 shipped and the wedge stayed. gMLift is the tall-ceiling
       bounce term (CEILG above CEILHI); it is a property of a PLANE, so a pixel whose ray left the level
       paid it at full strength for a ceiling it never reached, at any distance. Measured at the level-0
       cam1 seat on main 91e07d4 (instrumented JSDIR variant, one frame): 13,444 off-map deferred ceiling
       pixels, mean base 0.866 at a mean plane of 3.97 and a mean distance of 38.5 m, against 0.190 for
       the row copy's own far fill - a flat, textureless trapezoid at 57.0 mean luminance where the
       ceiling overhead reads 40.5 - and DELIVERED LIGHT EQUALS BASE there to the last bit, which is why
       #392's fix could not reach it and why its census still prints 0.0000: the lamp taps are zero, the
       LIFT is not. A ceiling that is not there cannot bounce light at you, for the same reason a lamp
       that is not there cannot light you, so this term now rides the same tap coverage the lamp taps
       already ride: whole on the boundary lattice line, where it is continuous with the in-map side -
       which is what removes the STEP, and never a hole: the term it pays instead is the row's own.
       Both lift terms are ZERO for a FLOOR pixel - `gMLift` is built `!isF && …` (js/40_render.js:1318)
       and `liftRow` needs `plA - eyeZ > CEILHI`, which a floor plane below the eye cannot satisfy - so
       the clause widening this to the floor half (#385) does not change what the floor half pays here:
       it is still exactly `gMBase`, which is what `heights`' offmap row gates at 0.0000.
       GNDOF 0 puts the whole charge back, wedge included, for the A/B. The ROW copy needs no clause: its
       lift is computed from dzA, a per-ROW constant, so it is the same value on both sides of the level's
       edge and cannot draw the footprint's outline - the 0.866/0.190 above is the whole difference. */
    /* WHICH lift an off-map pixel may claim: the one the ROW's own plane carries, which is exactly what
       the row copy pays these same rays (dzA, a per-ROW constant). Zero here would be a hole - measured:
       base 0.130 against the row copy's 0.190 and a frame that reads a dark trapezoid instead of a bright
       one, an edge in the other direction rather than no edge. The plane this pixel's ray never reached
       pays nothing; the space the camera is standing in pays its own, at any distance, which is also what
       makes the two copies agree on the same pixel. */
    const liftRow = plA - eyeZ > CEILHI ? Math.min(CEILLD, CEILG * (plA - eyeZ - CEILHI)) : 0;
    lr = lg = lb = gMBase - gMLift + liftRow;
    if (lta) {
      const gx = Math.floor(cx), gy = Math.floor(cy), ux = cx - gx, uy = cy - gy;
      for (let q = 0; q < 4; q++) {
        const ix = gx + (q & 1), iy = gy + (q >> 1);
        if (ix < 0 || iy < 0 || ix >= N || iy >= N) continue;      // a tap off the map reads 0
        const w = (q & 1 ? ux : 1 - ux) * (q >> 1 ? uy : 1 - uy);
        if (w <= 0) continue;
        const j = iy * N + ix, j3 = j * 3;
        if (j3 + 2 >= lta.length) continue;
        let li = lm ? lm[j] : 0.4;
        if (li > lgc) li = lgc;
        lr += w * li * lta[j3] / 128; lg += w * li * lta[j3 + 1] / 128; lb += w * li * lta[j3 + 2] / 128;
      }
    }
  }
  /* #375 census, DEFERRED COPY - deliberately OUTSIDE the GNDOF gate above, so the A/B that puts the
     wedge back makes this row go RED instead of measuring the fixed arithmetic either way. Both halves
     are counted and maxed SEPARATELY (#385): the fix is one term for both, but the two halves land on
     different geometry and only this split shows a build that fixes one and not the other.
     No LIFT sub-figure lives here. One did, and it was VACUOUS: measured on the arm with the light
     charge restored it printed 0.0000 on all four levels while that same arm moves cull's L0 lane and
     flatparity's L3 dealt frame to the byte - at these cameras `pl` and `plA` carry the same lift, so
     the difference it counted is 0 by geometry whether or not the term is fixed. Whatever counts this
     term must run where the two lifts differ, which is cull's poked ceiling-step camera or flatparity's
     L3 dealt seat - i.e. the two LOCK rows above are the falsifiable half, and a green census here
     proves nothing about it. What this census DOES count - the lamp field, both halves - is falsifiable
     here, and the same `GNDOF = 0` arm prints FAIL OFFMAP-LIGHT-FLOOR on all four levels. */
  if (cnt && !own && offMapClear(cx, cy, N)) {
    cnt[isF ? LG_OFFMAP : LG_OFFCEIL]++;
    const om = Math.max(lr, lg, lb) - gMBase;
    const oi = om > 0 ? (om * 1000 + 0.5) | 0 : 0;
    const sl = isF ? LG_OFFMAX : LG_OFFCMAX;
    if (oi > cnt[sl]) cnt[sl] = oi;
  }
  /* #19 take five: past FARB this pixel's own solve puts it in the band the ROW loop fills with the
     material's mean, so it is filled the same way here - see the gate in gndBuild. Everything below
     this line is the FETCH, and a far pixel runs none of it: no mip select, no mirror hash, no texel
     load, no decal, no contact shadow (a row-wide fill carries none of those either). The colour is
     that pixel's own light times the mean, plus the wash's emissive share, which takes no light and
     keeps only the fog term, exactly as an emissive texel does one screen nearer in either copy. */
  if (gMFar) {
    px[row + x] = 0xFF000000 | clampi(gMWnB * lb + gMWEm + gMFB) << 16 |
      clampi(gMWnG * lg + gMWEg + gMFG) << 8 | clampi(gMWnR * lr + gMWErr + gMFR);
    continue;
  }
  /* The mip SELECTION is here rather than with the other per-pixel setup because the band above must
     be able to skip it: it reads the pixel's own footprint and nothing else, so moving it costs the
     pixels it still answers exactly what it cost them before. */
  let k;
  if (gMAn) {
    const cfS = gMCf, qx = rx * cfS, qy = ry * cfS;
    const ay = Math.sqrt(qx * qx + qy * qy) * gMWs;
    const rho = gMAx >= ay ? gMAx : ay < gMAx * gMAr ? ay : gMAx * gMAr;
    k = rho >= 16 ? 4 : rho >= 8 ? 3 : rho >= 4 ? 2 : rho >= 2 ? 1 : 0;
    if (k >= gMN) k = gMN - 1;
  } else k = mipSel(planeX * stepBase * dS, planeY * stepBase * dS, rx * (dS / absP), ry * (dS / absP), sc, tex);
  const m = tex.mips[k];
  const mw = m.w, mh = m.h, ms = sc * m.w, td = m.data, mask = mw - 1, maskH = mh - 1;
  /* #19 take six, the DEFERRED copy: this pixel's own mip, so its own F. Same rule, same arithmetic,
     second copy - AGENTS.md counts the duplication as the price of the row loop's registers. */
  let ftd = null, fW = 0, fmw = 0, fmx = 0, fmy = 0, fms = 0;
  if (GNDFA && k + 1 < gMN) {
    const colT = gMCf * ms * 0.5, colA = colT < 0 ? -colT : colT, rowT2 = (gMCxs * gMCxs + gMCys * gMCys) * ms * ms;
    const fLong = colA * colA * 4 >= rowT2 ? colA * 2 : Math.sqrt(rowT2);
    if (fLong > 1) {
      const mu = tex.mips[k + 1];
      ftd = mu.data; fmw = mu.w; fmx = mu.w - 1; fmy = mu.h - 1; fms = sc * mu.w;
      fW = GNDFA * (1 - 1 / fLong);
    }
  }
  /* The same two-sample fetch as the row loop, from this pixel's OWN footprint: its row delta is
     (gMCxs,gMCys) world units per column and its column delta is its own ray times gMCf, so the long
     axis in texels of THIS pixel's mip is whichever of the two is longer. No square root on the common
     path - which axis is longer is decided on squared lengths, and the row-long branch, the one the
     measurements never took, is where the root lives. One rule, two copies of the arithmetic, exactly
     like every other term in these two bodies (AGENTS.md). */
  let axOn = 0, ox = 0, oy = 0;
  if (GNDAX) {
    const colT = gMCf * ms * 0.5, colA = colT < 0 ? -colT : colT, rowT2 = (gMCxs * gMCxs + gMCys * gMCys) * ms * ms;
    if (colA * colA * 4 >= rowT2) { if (colA * 2 > AXMIN) { axOn = 1; ox = rx * colT; oy = ry * colT; } }
    else { const rowT = Math.sqrt(rowT2); if (rowT > AXMIN) { axOn = 1; ox = gMCxs * ms * 0.5; oy = gMCys * ms * 0.5; } }
    ox = (ox + 0.5) | 0; oy = (oy + 0.5) | 0;
  }
  const uxp = cx * ms, uyp = cy * ms;
  let tx = uxp | 0, ty = uyp | 0, ufx = uxp - tx, ufy = uyp - ty;
  if (ufx < 0) { tx--; ufx++; }                 // floor, not truncate - same guard as the row copy
  if (ufy < 0) { ty--; ufy++; }
  tx &= mask; ty &= maskH;
  if (mir & 1) { tx = (mask - tx - 1) & mask; ufx = 1 - ufx; }
  if (mir & 2) { ty = (maskH - ty - 1) & maskH; ufy = 1 - ufy; }
  const c = td[ty * mw + tx];
  const i = row + x;
  let cr = c & 255, cg = c >> 8 & 255, cb = c >> 16 & 255, em = c >>> 24;
  if (GNDFT) {                                 // the same lerp as the row copy, across THIS pixel's
    const c0 = Math.abs(gMCys) >= Math.abs(gMCxs) ? 1 : 0;    // short side, decided from its own footprint
    const c1 = c0 ? td[((ty + 1) & maskH) * mw + tx] : td[ty * mw + ((tx + 1) & mask)];
    const wf = c0 ? ufy : ufx;
    cr += ((c1 & 255) - cr) * wf;
    cg += ((c1 >> 8 & 255) - cg) * wf;
    cb += ((c1 >> 16 & 255) - cb) * wf;
    if ((c1 >>> 24) === 253) em = 253;         // the FLAG rule, same as the row copy
  }
  if (axOn) {                                  // the same symmetric pair as the row copy, from this
    const c1 = td[((ty - oy) & maskH) * mw + ((tx - ox) & mask)];    // pixel's OWN footprint, which is
    const c2 = td[((ty + oy) & maskH) * mw + ((tx + ox) & mask)];    // what the march above just solved
    cr = cr * 0.5 + (c1 & 255) * 0.25 + (c2 & 255) * 0.25;
    cg = cg * 0.5 + (c1 >> 8 & 255) * 0.25 + (c2 >> 8 & 255) * 0.25;
    cb = cb * 0.5 + (c1 >> 16 & 255) * 0.25 + (c2 >> 16 & 255) * 0.25;
    if ((c1 >>> 24) === 253 || (c2 >>> 24) === 253) em = 253;    // the FLAG rule, same as the row copy
  }
  if (fW > 0) {                          // the same graded blend, from this pixel's OWN mip and F
    const vx = cx * fms, vy = cy * fms;
    let t2 = vx | 0, t3 = vy | 0;
    if (vx < 0) t2--;
    if (vy < 0) t3--;
    t2 &= fmx; t3 &= fmy;
    if (mir & 1) t2 = (fmx - t2 - 1) & fmx;
    if (mir & 2) t3 = (fmy - t3 - 1) & fmy;
    const c3 = ftd[t3 * fmw + t2];
    cr += ((c3 & 255) - cr) * fW;
    cg += ((c3 >> 8 & 255) - cg) * fW;
    cb += ((c3 >> 16 & 255) - cb) * fW;   // colour only: see the flag rule at the switch declaration
  }
  if (em === 253) { px[i] = 0xFF000000 | clampi(cb * gMInv + gMFB) << 16 | clampi(cg * gMInv + gMFG) << 8 | clampi(cr * gMInv + gMFR); continue; }
  let r = cr * lr + gMFR, g = cg * lg + gMFG, b = cb * lb + gMFB;
  /* #413 ceiling fitting, DEFERRED COPY - same one byte, same helper, same two lines. A plate that
     drew in the row loop and not here would alias at every band boundary the column re-solves. */
  if (!isF && inMap && CF_FIX !== null && CF_FIX[cIdx] !== 0 && ceilFixAt(cx, cy)) {
    r += (CF_R * lr + gMFR - r) * CF_A; g += (CF_G * lg + gMFG - g) * CF_A; b += (CF_B * lb + gMFB - b) * CF_A;
  }
  const dl = isF && inMap && DECAL_MASK ? DECAL_MASK[cIdx] : 0;
  if (dl !== 0) {
    const gl = DECAL_GRID[cIdx];
    for (let q = 0; q < gl.length; q++) {
      const dc = gl[q], al = decalAlpha(dc, cx, cy, gMDfa);
      if (al <= 0.01) continue;
      const dt = dc.tex, du = (((cx - dc.x) * dc.inv + 0.5) * dt.w) | 0, dv = (((cy - dc.y) * dc.inv + 0.5) * dt.h) | 0;
      if (du < 0 || dv < 0 || du >= dt.w || dv >= dt.h) continue;
      const s = dt.data[dv * dt.w + du], sa = (s >>> 24) / 255 * al;
      if (sa < 0.01) continue;
      r += ((s & 255) - r) * sa; g += ((s >> 8 & 255) - g) * sa; b += ((s >> 16 & 255) - b) * sa;
    }
  }
  /* #178 contact shadow, the DEFERRED copy: same term, same band rule, same plane the ROW copy passes.
     The branch passed `eyeZ - d*absP/BH`, the inverse of the row's plane solve; that expression no
     longer round-trips here, because dS is now the memo's CLAMPED distance (FARB*4) and the under-a-slab
     case carries a crossing's t rather than a plane solve. `pl` is the plane this pixel is painted on -
     the same grid value planeC holds on a row-painted pixel - so the two copies of this body answer
     identically at the same world point, which is what `heights`' deferred-pixel rows depend on. */
  if (shm && isF && inMap) {
    const sk = shm[cIdx];
    if (sk >= 0) {
      const kk = 1 - shadowFloor(cx, cy, pl, sk);
      r *= kk; g *= kk; b *= kk;
    }
  }
  px[i] = 0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r);
  }
}

function decalAlpha(dc, wx, wy, dfade) {
  const dx = wx - dc.x, dy = wy - dc.y, r2 = dx * dx + dy * dy;
  if (r2 >= dc.r * dc.r) return 0;
  const t = 1 - r2 / (dc.r * dc.r);
  return dc.a * t * dfade;
}

/* #413: the FITTING itself, drawn on the ceiling plane. One byte per cell (MAP.ceilFix, authored by
   placeCeilFixtures) says whether this cell has a source hung over it; the plate is one painted
   texture (js/10_assets.js CFIX.STRIP) addressed in WORLD metres off the cell CENTRE, so a fitting is
   the same size in every room and does not ride the ceiling material's tiling at all. Like the wall
   fixtures (#400) it is ALBEDO and nothing more: this function returns the plate's colour and coverage
   and the CALLER multiplies by that column's own light and fog, which is the only reason a fitting in a
   room with no lamp in it is not a bright square. It is also why a fitting reads bright where it works:
   the source it is the housing for is the brightest light splat on that very column.
   The two ground copies call this ONE function - AGENTS.md counts the duplicated pixel body as a trap,
   and a plate that only appeared in the row-loop copy would be a seam between the deferred and the
   rasterized picture. Sets CF_A to 0 when this pixel is off the plate. */
const CF_PLATE = 1.0;                     // one CELL of ceiling is the fitting: frame at the cell edge,
                                          // diffuser inside it. At 0.68 the plate was 25 px of picture at
                                          // 8 m and read as a bright dot; a flush fitting has to own its
                                          // cell to look like the cause of the pool under it.
let CF_R = 0, CF_G = 0, CF_B = 0, CF_A = 0;
function ceilFixAt(wx, wy) {
  CF_A = 0;
  const t = CFIX.STRIP, uv = t.w / CF_PLATE;
  const u = (wx - Math.floor(wx) - 0.5) * uv + t.w * 0.5;
  const v = (wy - Math.floor(wy) - 0.5) * uv + t.h * 0.5;
  if (u < 0 || v < 0 || u >= t.w || v >= t.h) return 0;
  const s = t.data[((v | 0) * t.w + (u | 0)) >>> 0];
  const a = (s >>> 24) / 255;
  if (a < 0.02) return 0;
  CF_R = s & 255; CF_G = s >> 8 & 255; CF_B = s >> 16 & 255; CF_A = a;
  return 1;
}

/* Paint the seam of one step lip in one column. zA is the floor on the side of the lip the ray is
   standing on and zB the floor beyond, t the perpendicular distance of the boundary; dir is the
   direction the band runs from its anchor row, -1 up the screen and +1 down it. A floor below the eye
   always projects BELOW its own row, so the surface the eye stands on owns every row under yc(zA) -
   but WHICH rows the drawn face occupies depends on which side of the step the eye is on: for a step
   UP the face runs from yc(zA) upward (dir -1), and for a step DOWN the wall pass paints the slab side
   from yc(zA) DOWNWARD (dir +1), because yc(zA) is then the face's top edge, not its foot. Keying the
   band on the lower floor instead of on the eye's own side put the crease on the far side of the face
   whenever the player stood on the high side, so the visible lip carried no edge at all - measured on
   the lips a level offers: 57/77/59% contrast across an UP lip against 17/17/29% across a DOWN one,
   with the band reaching the lip row on 100% of up columns and 0% of down columns (#195). With dir
   derived this way the up case is bit-identical to what it was. Capped to
   half the riser's projected height, so a 1 m face gets a seam at its foot, not a gradient.
   amp < 0 shades a crease, amp > 0 lifts a lip; a multiply either way, so the AMB floor that sinks an
   additive rim in a dark room cannot sink this. */
function seamCrease(x, t, zA, zB, amp, dir, deckLit) {
  if (!(t > 0.001)) return;
  const hp = BH / t, yA = horizon + (eyeZ - zA) * hp, yB = horizon + (eyeZ - zB) * hp;
  const bw = Math.min(Math.abs(yB - yA) * 0.5, hp * SEAMW);
  if (!(bw > 0.5)) return;
  // the anchor row is the face's own edge row on this side: floor() coming up from below, ceil()
  // coming down from above - the same pair castWalls uses for de and ds
  const y0 = dir > 0 ? Math.ceil(yA) : Math.floor(yA);
  /* #385: how much ABSOLUTE edge this lip gets, from the deck the eye is standing on. Rows under the
     lip's own row are that floor either way the step goes, so read one just clear of the band; a row
     that lands off-screen contributes nothing. */
  let ab = 0;
  if (SEAMA > 0 && amp < 0 && deckLit < SEAMK) {
    ab = SEAMA * (1 - deckLit / SEAMK);
    if (ab > SEAMA) ab = SEAMA;
  }
  for (let k = 0; k <= bw; k++) {
    const y = y0 + dir * k;
    if (y < 0) { if (dir < 0) break; continue; }
    if (y >= BH) { if (dir > 0) break; continue; }
    const i = y * BW + x, v = px[i];
    // the lip row itself carries an extra term: where the far surface is already darker than the
    // floor in front of it, a gradient alone passes THROUGH the floor's brightness and the lip
    // vanishes (measured on L1: mean |dL| 25 with the gradient, and the sign of the difference
    // changes across levels, so an unsigned threshold cannot be the whole gate)
    const kk = 1 + amp * (1 - k / bw) - (!k && amp < 0 ? SEAMC : 0);
    const d = ab * (1 - k / bw);
    px[i] = (0xFF000000 | clampi((v >> 16 & 255) * kk - d) << 16 | clampi((v >> 8 & 255) * kk - d) << 8 | clampi((v & 255) * kk - d)) >>> 0;
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
  const mMask = DECOR_MASK, mGrid = DECOR_GRID;        // #400 authored wall decor; one byte test per column
  const shm = SHADOW ? SH_HEAD : null;                      // #178 contact shadow
  for (let x = 0; x < BW; x++) {
    const cam = x * stepBase - 1;
    const rdx = dirX + planeX * cam, rdy = dirY + planeY * cam;
    let mx = camX | 0, my = camY | 0;
    const ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9));
    let stepX, stepY, sdx, sdy, side = 0;
    if (rdx < 0) { stepX = -1; sdx = (camX - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - camX) * ddx; }
    if (rdy < 0) { stepY = -1; sdy = (camY - my) * ddy; } else { stepY = 1; sdy = (my + 1 - camY) * ddy; }
    let tv = 0, guard = 0, riser = 0, rz0 = 0, rz1 = 1, rze = 0, rzf = 1;
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
         its crown instead of vanishing. A riser is the exposed edge of a floor slab, so it wears a
         WALL material (#192): a lip that wears the floor texture is a brighter patch of the same
         texture, which is what `view.js bands` printed about generated content while the generator
         started authoring staircases.
         THE THRESHOLD IS ANY HEIGHT DIFFERENCE, not "a step too tall to climb" (#192). The generator
         authors every stair tread exactly one quantum from the last (js/20_level.js:459), so the old
         `|dq| > 1` test - copied from the VB_BLOCK rule that decides what `canEnter` refuses - drew
         no geometry at all along a flight: the tread boundaries were intangible, unpainted and, worse,
         unrecorded in `zbuf`, so a staircase was a hole in the depth buffer with a seam multiply
         painted over it. Blocking and drawing are different questions and only one of them is here:
         the byte that stops a ray stays `dq > 1` (js/20_level.js:162), so a one-quantum crossing is
         still walkable and still auto-stepped - the player walks up a face he can now also see.
         A ramp or a ladder link is the exception that must keep flying through: the crossing is a
         slope or a shaft, not a lip, and `view.js cull`'s ramp row is the only thing that exercises
         that clause. Flat levels never reach this test - MAP.steps is 0 - so a flat frame stays
         bit-identical. */
      if (doStep) {
        const d = side === 0 ? (stepX > 0 ? 0 : 2) : (stepY > 0 ? 1 : 3);
        /* The cell the ray came from, with BOTH axes tested before the index is used. `qy * N + qx`
           is a valid index when qy === -1 and qx > 0, and the cell it addresses is on the far side of
           the level: the first crossing of a ray that starts in a border cell read THAT column's floor
           as its neighbour's, which is the same fault `AGENTS.md` records twice for the light path.
           Out of the map there is no neighbouring column, so dq is 0 - no face, no crease. */
        const qx = mx - (side === 0 ? stepX : 0), qy = my - (side === 1 ? stepY : 0);
        const dq = qx >= 0 && qy >= 0 && qx < N && qy < N ? fzs[my * N + mx] - fzs[qy * N + qx] : 0;
        const pi = qy * N + qx;
        if (dq && !(vbs[pi] & ((VB_RAMP | VB_LADDER) << (d << 2)))) {
          const fhi = dq > 0 ? fzs[my * N + mx] : fzs[pi], flo = dq > 0 ? fzs[pi] : fzs[my * N + mx];
          riser = 1; rz0 = flo * ZQ; rz1 = fhi * ZQ; MAP.riserStops++; tv = WT.CONCRETE;
          /* rze/rzf are the same two floors sorted by WHICH SIDE THE RAY CAME FROM rather than by
             height - the crease belongs at the lip the player is standing at, and on a step down
             that is the higher of the two (#195). rz0/rz1 keep sorting by height: the face's span
             and its texture do not care which side the eye is on. */
          rze = (dq > 0 ? flo : fhi) * ZQ; rzf = (dq > 0 ? fhi : flo) * ZQ; break;
        }
      }
    }
    let perp = side === 0 ? sdx - ddx : sdy - ddy;
    if (!(perp > 0.0001)) perp = 0.0001;
    if (tv === 0 || perp > FARB * 3) continue;
    /* A riser is a VERTICAL face, so it wears the same lookup every other face wears (#192). It wore
       MAP.floorTex on the argument that WTEX.CONCRETE is in no level's palette and read ~+8 raster
       brighter than a flat level at an identical lightmap - true, and bought with the wrong thing: a
       lip in the floor's own texture is a brighter patch of the same texture, which is exactly what
       `view.js bands` reported about generated content once the generator authored stairs (#192's
       "stairs/pits/decks render as voids": the geometry was there, the MATERIAL said floor). The
       brightness question is a palette question, answered below by the face's own shading, not by
       painting walls with floor. Dead on flat levels, so nothing shipped moves. */
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
    let li = (Math.max(lit, litFront * 0.85) * fall + AMB + (riser ? 0 : WALLB)) * (side === 1 ? 0.78 : 1);
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
    /* #178 contact shadow on a face. A face has ONE world x,y for its whole span, so the planar part of
       the term is per COLUMN (two subs, two muls, one indexed read) and only the altitude term is per
       pixel; shA/shB bound the body's own span from its feet up. Darkens the surface's LIGHT, not the
       fog, and writes no zbuf. */
    let shK = 0, shA = 0, shB = 1;
    if (shm) {
      const fhx = camX + rdx * perp, fhy = camY + rdy * perp;
      const fcx = fhx | 0, fcy = fhy | 0;
      if (fcx >= 0 && fcy >= 0 && fcx < N && fcy < N) {
        for (let k = shm[fcy * N + fcx]; k >= 0; k = SH_NEXT[k]) {
          const dx = fhx - SH_X[k], dy = fhy - SH_Y[k];
          const t = 1 - (dx * dx + dy * dy) * SH_I[k];
          if (t <= 0) continue;
          const tt = (SHADOW_F === 2 ? t * t : Math.pow(t, SHADOW_F)) * SHADOW_D;
          if (tt > shK) { shK = tt; shA = SH_Z[k]; shB = SH_Z[k] + SH_H[k]; }
        }
      }
    }
    const shS = shK > 0 ? 1 / Math.max(0.2, shB - shA) : 0, shZs = perp / BH;
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
      /* the body's contact band on this face: full at the feet, SHADOW_ZF of it at the TOP of the band,
         nothing above it. The band is as tall as the patch is wide (#18: a contact zone is isotropic in
         world units, and a band that ran up the body's whole span was a wash over the wall that cost
         edge dL and bought no grounding) and it falls off quadratically, so the visible part hugs the
         floor line. */
      let shM = 1;
      if (shK > 0) {
        const vv = (eyeZ - (y - horizon) * shZs - shA) * shS;
        if (vv < 1) {
          const w = 1 - (vv > 0 ? vv : 0);
          shM = 1 - shK * (SHADOW_ZF + (1 - SHADOW_ZF) * w * w);
        }
      }
      px[idx] = 0xFF000000 | clampi(cb * lb * gk * shM + fB) << 16 | clampi(cg * lg * gk * shM + fG) << 8 | clampi(cr * lr * gk * shM + fR);
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
    /* #400: AUTHORED wall decor, painted with THIS FACE'S OWN LIGHT. That modulation is the whole
       point of the block: the transient blit above composites the splat's RGB straight over the wall,
       which is right for a bullet hole in soot and wrong for a thing standing in the room - it would
       sit at full brightness in a corridor no lamp reaches, and the issue's "not a brighter square"
       criterion is exactly that failure. So a fixture's albedo goes through lr/lg/lb and picks up the
       same fog add the body rows used, and the fixture is clipped to the face's drawn span [ds, de],
       so nothing here can paint the slab above a riser or the ceiling band. It is NOT on the transient
       decal list: those fade (life defaults to 40) and the list evicts at 180 entries. */
    /* #400 take two: a fixture is a BOX that STANDS OFF the face, not a rectangle on it. Coplanar
       art has one silhouette term - the face's own foreshortening, cos(theta) - so 30 degrees off the
       wall normal a door frame is already a third of its front-on width and along a corridor it is
       nothing at all, which is the review's "still reads as bare once you are not facing it square".
       A box has a second term: its FLANK, whose width goes as dep*sin(theta) and does not collapse.
       So the pass solves the ray against the box, not the face. `d` is the distance along the ray from
       the face plane back to the box's front plane (dep / the ray's normal component), so the front
       plane's own depth is perp - d and its along-coordinate is `along - ra*d` - that shift IS the
       parallax, and where it carries the ray past the box's edge the surface the ray meets is the
       flank at the depth tS where the along-coordinate crosses that edge. Both surfaces are drawn at
       their OWN depth (BH/t, not BH/perp), which is what makes the thing sit in the room instead of on
       the wall. The flank keeps the fixture's own material, dimmed, and both go through this face's lr
       /lg/lb and the same fog add, so a fixture in an unlit corner stays dark: this is geometry and
       albedo, never a light. Clipping to [ds,de] is unchanged - a box may not paint the slab above a
       riser or the ceiling band any more than a decal could. */
    if (mMask && mMask[my * N + mx]) {
      const ml = mGrid[my * N + mx];
      const wx = camX + rdx * perp, wy = camY + rdy * perp;
      const rn = side === 0 ? rdx : rdy;        // this ray's component along the face normal
      const ra = side === 0 ? rdy : rdx;        // ... and along the face
      const an = Math.abs(rn);
      for (let q = 0; q < ml.length; q++) {
        const mo = ml[q];
        if (mo.side !== side + 1) continue;
        const hw = mo.hw, along = side === 0 ? wy - mo.y : wx - mo.x;
        let u, tM, dim = 1;
        if (mo.dep > 0 && an > 1e-4) {
          const d = mo.dep / an, tN = perp - d;
          if (!(tN > 0.12)) continue;                  // edge-on, or the eye is inside the box
          const aN = along - ra * d;
          if (aN > -hw && aN < hw) { u = aN / (hw * 2) + 0.5; tM = tN; }
          else {
            if (Math.abs(ra) < 1e-6) continue;          // dead-on: no flank is ever turned this way
            const left = aN < -hw;
            const tS = perp + ((left ? -hw : hw) - along) / ra;
            if (!(tS > tN && tS < perp)) continue;      // both ends past the same edge: no flank
            u = left ? 0.03 : 0.97;                     // the material AT that edge, not across it
            tM = tS; dim = 0.62;                        // a face turned 90 deg from the wall
          }
        } else {
          u = along / (hw * 2) + 0.5;
          if (!(u >= 0 && u < 1)) continue;
          tM = perp;
        }
        const hpxM = BH / tM;
        const zT = mo.z + mo.hh, zB = mo.z - mo.hh;
        const syTop = Math.max(ds, Math.ceil(horizon + (eyeZ - zT) * hpxM));
        const syBot = Math.min(de, Math.floor(horizon + (eyeZ - zB) * hpxM));
        const dt = mo.tex, mwx = dt.w, ih = 1 / (zT - zB);
        for (let y = syTop; y <= syBot; y++) {
          const zv = (eyeZ - ((y - horizon) / hpxM) - zB) * ih;
          if (!(zv >= 0 && zv < 1)) continue;
          const s = dt.data[(zv * dt.h | 0) * mwx + (u * mwx | 0)], sa = (s >>> 24) / 255;
          if (sa < 0.02) continue;
          const i = y * BW + x, dst = px[i], ia = 1 - sa;
          px[i] = (0xFF000000 |
            (clampi(((s >> 16 & 255) * lb * dim + fB) * sa + (dst >> 16 & 255) * ia) << 16) |
            (clampi(((s >> 8 & 255) * lg * dim + fG) * sa + (dst >> 8 & 255) * ia) << 8) |
            clampi(((s & 255) * lr * dim + fR) * sa + (dst & 255) * ia)) >>> 0;
        }
      }
    }
    /* The riser's own creases, then this column's nearer 1-quantum crease - not INSTEAD OF it. As an
       `else if` the far seam evicted the near one, and on a level that authors volume a riser sits
       down some column behind almost every stair tread: measured on 60 of 60 walk-lip columns of L0
       and L2, where the seam moved not one pixel of the lip the player is standing at (issue #181's
       bands row read `foot drop 0.0 px-lum, band 0.0 px of a 24 px riser` for exactly this). Painted
       after so the nearer lip wins any row the two bands share. */
    if (riser && SEAM) {
      /* A drawn slab side has a junction at EACH of its two screen edges, and before #195 only the
         lower floor's got one: for a step DOWN that is the edge the eye does NOT stand at, so the
         visible lip carried no edge at all (up lips 57/77/59% contrast, down lips 17/17/29%). The
         lower floor's crease stays exactly where it was, because for a step UP it is the same row. */
      const seamLit = li - AMB;                  // the deck's own LIGHT, fog and ambient out (#385)
      seamCrease(x, perp, rze, rzf, -SEAMD, rzf > rze ? -1 : 1, seamLit);
      if (rze !== rz0) seamCrease(x, perp, rz0, rz1, -SEAMD, -1, seamLit);
      seamCrease(x, perp, rz1, rz0, SEAMU, -1, seamLit);
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
  // #407: the SECOND copy of the body light lookup - the two-copies rule in AGENTS.md. It must read
  // the same BODYDIST as js/13_mesh.js:1212, and it does: BODYDIST is one global in js/00_core.js, so
  // switching the term in a live page changes sprites and meshes together. See that file and the mesh
  // copy for why the field is taken whole at the sprite's own cell (a billboard is a body seen from
  // farther off than most meshes, so this copy is where the defect showed worst).
  const li = Math.min(1, (MAP.light ? MAP.light[idx0] : 0.5) * (BODYDIST ? 1 : Math.exp(-tY * 0.14)) + 0.30 * visAt(tY));
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
/* ---- the bright pass (#377) ------------------------------------------------
   What shipped before this was not a bright pass. It filtered the WHOLE finished raster with
   `brightness(1.5) contrast(2.1) saturate(1.25)` and composited it back with 'lighter' at 0.42.
   Composed per pixel that is `min(255, 3.15v - 140) * 0.42`: zero below v = 45, and from v = 124 up
   it is the SAME +107 on every pixel because the filter output has clipped to white. A lit metal
   deck sits at v 130-170, so it received the identical +107 a lamp core receives - which is the
   white sheet of #377 (measured on the deployed build: RING TRANSPORT's frame mean 83.8 -> 107.9,
   12.0% of delivered pixels above luma 224), and `saturate(1.25)` rewrote the palette on the way
   (mean channel spread 53 -> 87 on ABATOIR CORE). The `canFilter === false` path skipped the curve
   entirely and composited the frame back at 0.42 with no shape at all - a flat 42 % lift.

   This is a real threshold. For every 3x3 block of the raster: take the block's luma, keep only the
   energy ABOVE BLOOM_KNEE on a curve that eases in (d squared over BLOOM_CURVE), cap it at BLOOM_CAP,
   and re-apply it to the block's own RGB as a gain so the highlight keeps its hue and only loses its
   level. Everything at or below the knee composites as literal zero, so a floor, a wall or a crate at
   mid grey is untouched and the pass's total added energy is bounded by BLOOM_MIX * BLOOM_CAP per
   pixel - a constant nobody can exceed by authoring a brighter room. There is no `filter` and no `saturate` anywhere in it,
   so the no-ctx.filter browser gets the same picture instead of the flat 42 % lift.

   The knee is a RASTER luma, not a delivered one: the source is bufCv, before the grade filter
   renderOverlay applies on the way to the display canvas. With contrast(1.06) brightness(1.02) that
   is within about 4 luma units of the delivered value at these levels.

   3x3 because the buffer is exactly BW/3 x BH/3: one non-overlapping block per output pixel, so this
   is a box downsample (the blur the old pass got from the bilinear upscale alone), and it is what
   stops a single bright stud from blooming as a hard sparkly dot. 22 k pixels x 9 reads per frame at
   BALANCED - the whole pass costs well under a millisecond and no GPU readback. */
const BLOOM_KNEE = 140;        // luma (0-255) where the pass starts: below this it adds exactly zero
const BLOOM_CURVE = 128;       // highlight = d*d / this, so it eases in and only a real core gets much
const BLOOM_CAP = 18;          // and never more than this, so the pass cannot run away on a bright room
const BLOOM_MIX = 0.55;        // composited alpha: added luma per pixel <= BLOOM_MIX * BLOOM_CAP = 9.9
/* BLOOM_HEAD is the pass's other bound, and the one the cap alone could not give (#377's last row).
   The curve above PLATEAUS: `add` reaches BLOOM_CAP at luma 188 and stays there, so a lamp-lit wall at
   200 and a lamp core at 250 receive the identical +9.9. A pixel already at the top of the range cannot
   show any more light, so energy put there is not light, it is FLATTENING - it is how THE STACK's lamp
   seat arrived at 2.19 % of its frame above the clipping line against the gate's 2 %, with 1.85 % of
   that already there with the pass switched off (main's #413 overhead fittings moved that floor).

   THE CEILING IS THE CLIPPING LINE, NOT 255. A delivered pixel stops carrying a LEVEL at BLOOM_CLIP, not
   at 255 - above the line the frame carries white, and white has no gradient left to put a highlight in.
   BLOOM_CLIP is the same luma the exposure shoulder is deliberately cut under ("200, under the 224 the
   gate measures", applyExposure above) and the line #377 counts, so the two post terms now agree on where
   the showable range ends. Energy is bounded by the distance to THAT line.

   THE SLOPE IS DERIVED, NOT TUNED. The ease-in reaches BLOOM_CAP at BLOOM_TOP = KNEE + sqrt(CAP*CURVE) =
   188, so BLOOM_HEAD = CAP / (BLOOM_CLIP - BLOOM_TOP) = 0.5 puts the headroom line through the cap at
   exactly that luma. The pass has no flat region: energy climbs the curve, falls in a straight line to
   zero at the clip line, and stays zero above it. Nothing at or below 188 changes by one luma - which is
   why every recorded peak and every raster reference still reads as it did.

   AND IT BOUNDS THE DESTINATION, NOT JUST THE SOURCE. The block's value is a 3x3 MAX, so a pixel at
   delivered luma v always sits in a block with L >= v, and the energy that pixel can receive is at most
   MIX * HEAD * (CLIP - v) - zero at the line itself. The pass therefore cannot lift a pixel ACROSS the
   clipping line any more, which is what the old bound let it do: at v = 220 the distance-to-white term
   allowed +5.3 delivered luma (220 -> 225.3, a new clipped pixel); this one allows +1.1. */
const BLOOM_CLIP = 224;   // the luma above which the frame carries white instead of a level
const BLOOM_TOP = BLOOM_KNEE + Math.sqrt(BLOOM_CAP * BLOOM_CURVE);   // 188: where the curve reaches the cap
const BLOOM_HEAD = BLOOM_CAP / (BLOOM_CLIP - BLOOM_TOP);
let bloomImg = null;

function drawBloom(q) {
  const bw = Math.max(24, (BW / 3) | 0), bh = Math.max(16, (BH / 3) | 0);
  if (bloomCv.width !== bw || bloomCv.height !== bh) { bloomCv.width = bw; bloomCv.height = bh; bloomImg = null; }
  if (!bloomImg) bloomImg = bloomCtx.createImageData(bw, bh);
  const d = bloomImg.data;
  // The knee and the cap are applied to a 9-pixel SUM, so scale both by 9 once instead of dividing
  // the sum in the inner loop.
  const xs = BW / bw, ys = BH / bh, ylim = Math.max(0, BH - 3), xlim = Math.max(0, BW - 3);
  let o = 0;
  for (let y = 0; y < bh; y++) {
    const y0 = Math.min((y * ys) | 0, ylim);
    for (let x = 0; x < bw; x++, o += 4) {
      const x0 = Math.min((x * xs) | 0, xlim);
      /* The block's BRIGHTEST channel values, not its average. Averaging 9 px washes the highlight
         out of the very things this pass is for: a lamp core or a lit stud is a handful of raster
         pixels, and inside a 3x3 block of 60-luma floor its AVERAGE never crosses the knee, so the
         first version of this pass measured +0.05 mean at a lamp seat and bloomed nothing. Per-channel
         max is a dilation, one compare per channel instead of a luma per sample, and the bilinear
         upscale below is what turns it back into a soft halo. It costs a little whiteness (the three
         maxima can come from different pixels) and nothing else: the energy is still capped. */
      let mR = 0, mG = 0, mB = 0;
      for (let j = 0; j < 3; j++) {
        let idx = (y0 + j) * BW + x0;
        for (let i = 0; i < 3; i++, idx++) {
          const c = px[idx], cr = c & 255, cg = c >> 8 & 255, cb = c >> 16 & 255;
          if (cr > mR) mR = cr;
          if (cg > mG) mG = cg;
          if (cb > mB) mB = cb;
        }
      }
      d[o + 3] = 255;
      const L = 0.2126 * mR + 0.7152 * mG + 0.0722 * mB;
      if (L <= BLOOM_KNEE) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; continue; }
      const over = L - BLOOM_KNEE;                 // (not `d` - that is the buffer above)
      let add = over * over / BLOOM_CURVE;         // eases in: knee+30 gets 7, knee+60 is at the cap
      if (add > BLOOM_CAP) add = BLOOM_CAP;
      /* and the headroom bound: energy at or above the clipping line is only flattening (#377).
         One multiply and one min above the existing curve - no second buffer, no readback. */
      const room = BLOOM_HEAD * (BLOOM_CLIP - L);
      if (room <= 0) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; continue; }
      if (add > room) add = room;
      const k = add / L;                           // hue-preserving gain: the written pixel has luma `add`
      d[o] = mR * k; d[o + 1] = mG * k; d[o + 2] = mB * k;
    }
  }
  /* putImageData writes the buffer raw - no composite, no alpha, no filter - which is the point: the
     pass's shape is entirely in the bytes above, on every browser, filter support or not. */
  bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
  bloomCtx.putImageData(bloomImg, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = BLOOM_MIX;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bloomCv, 0, 0, DW, DH);
  ctx.restore();
}
/* ---- applying the exposure term (#377) ------------------------------------------
   Two parts, and the second one is the whole reason this is not three lines of fillRect.

   (1) A lifted COPY of the room at raster size: `multiply` by flat g, then `lighter` with flat A -
       affine, so the copy is exactly v*g/255 + A with g = 255 - 255*A/EXPOSE_T.
   (2) `lighten` that copy onto the frame. `lighten` is a per-channel MAX, so what the player gets is
       v' = max(v, v*g/255 + A): the lift BELOW luma EXPOSE_T and the untouched pixel above it. The
       two branches meet exactly at EXPOSE_T, so the curve is continuous - a shoulder, not a step.

   Why the max and not just the affine pair: an affine lift is v' > v EVERYWHERE, so it moves the top
   of the range too, and any A that buys the median pushes the pixels just under the clipping line over
   it - the band that newly crosses luma 224 is 31A/(255-A) wide, so at A = 22 it is ~2.9 luma wide. On
   the L3 lamp seat that band is a lamp-lit wall with a flat value in it, and the affine version measured
   3.79% of the delivered frame above 224 against the bloom gate's 2% bound - the exposure row buying its
   median by re-clipping the highlights the bright pass just un-clipped, which is exactly the failure
   #377 says means the term is wrong and the bound is right. With the max, every pixel at or above
   EXPOSE_T (200, under the 224 the gate measures) is BIT-IDENTICAL to the frame without the term, so the
   term cannot add clipping at all; and because a max can only choose the original, it cannot darken one
   either. Both bounds are structural rather than measured.

   The copy is made from bufCv at raster size and upscaled bilinearly into the max, which costs one
   downsample blit, two small flat fills and one upscale blit - no per-pixel loop and no GPU readback.
   It is the pre-grade raster, within a few luma of the delivered value at these levels, so the shoulder
   lands a few units below 200 on the graded frame; that direction is the safe one, since being under
   EXPOSE_T means being lifted, never being clipped.
   DEV.set('expose', 0) skips this whole function - the A/B the exposure rows are measured with. */
let liftCv = null, liftCtx = null;
function drawExposure(A) {
  const T = EXPOSE_T;
  if (!liftCv) { liftCv = document.createElement('canvas'); liftCtx = liftCv.getContext('2d', { alpha: false }); }
  if (liftCv.width !== BW || liftCv.height !== BH) { liftCv.width = BW; liftCv.height = BH; }
  const g = 255 - Math.round(255 * A / T);            // so v*g/255 + A crosses v at exactly v = T
  liftCtx.setTransform(1, 0, 0, 1, 0, 0);
  liftCtx.globalCompositeOperation = 'source-over';
  liftCtx.drawImage(bufCv, 0, 0, BW, BH);
  liftCtx.globalCompositeOperation = 'multiply';
  liftCtx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
  liftCtx.fillRect(0, 0, BW, BH);
  liftCtx.globalCompositeOperation = 'lighter';
  liftCtx.fillStyle = 'rgb(' + A + ',' + A + ',' + A + ')';
  liftCtx.fillRect(0, 0, BW, BH);
  ctx.globalCompositeOperation = 'lighten';
  ctx.drawImage(liftCv, 0, 0, BW, BH, 0, 0, DW, DH);
  ctx.globalCompositeOperation = 'source-over';
}

/* ---- the glow's band gate (#221) ---------------------------------
   The disc a lamp draws is a SCREEN-space object, and until #221 it covered whatever pixels it
   landed on: a lamp standing on the datum painted additive light into the pixels of a pit a unit
   below it (level 2 roll 9: composited mean 183.8, centre-half 245.0, immovable by every lamp-intensity
   knob in the game), because splatLight's band term is a LIGHTMAP term and the glow is composited,
   never splatted - MAP.light never moved and neither did the picture.

   The gate is splatLight's own term, `|sourceFloor - floorAt(surfaceCell)| <= ZQ`, evaluated on the
   surface the pixel lands on instead of on a cell of the lightmap. Two shipped facts make that
   readable per pixel: `zbuf` has been a DISTANCE in every pixel since #163 (the only surviving
   Infinity is the horizon row, where dz * BH / 0 is arithmetic), and project() above is invertible -
   the surface a pixel shows sits `zbuf` metres along the ray `dir + plane * (2x/BW - 1)` from the
   eye, so backing that distance off by a few centimetres gives the AIR cell the ray came through,
   whose floor is the band the pixel belongs to. Not the camera's cell and not P.z: keyed on the
   camera's band, a player standing at a pit lip looking down at a lamp that is genuinely below them
   loses that lamp's glow from every pixel it lights, which is the wrong version this file refuses -
   cull's lip rows and alt's glow row are the controls that say so.

   On a flat level every open cell is at floor 0 and every source floor is 0, so the term is the
   literal true, no run is dropped, the fill is the one clipped rect it always was, and flatparity's
   PARITY triple does not move a byte. Everything that decides a sample is hoisted out of the pixel
   loop - the row's own (by - horizon) / BH and its row base, one multiply per sample, no
   transcendental and no ceilAt/floorAt call inside it (floorAt walks four neighbours and cost 5 % of
   the flat frame once already, from a cell crossing). */
let GLOWREC = null;                                  // opt-in glow recorder for tools/view.js alt, null in play
const GR = [];                                  // rect list handed to the fill loop, reused per lamp

/* Accepted runs of one screen row, merged down into as few rects as the geometry allows. A row whose
   runs match the row above it extends that rect instead of adding one, so a disc whose surface is one
   band costs one fillRect - the same call the flat world has always made - and only a disc that
   straddles a lip pays for the split. */
function glowBandRects(rx, ry, rw, rh, lf) {
  GR.length = 0;
  const ys = BH / DH, xs = BW / DW, x1 = rx + rw, y1 = ry + rh, N = MAP.w;
  const cell = MAP.cell, fz = MAP.fz, lo = lf - ZQ - 1e-9, hi = lf + ZQ + 1e-9;
  const st = Math.max(2, (rw / 32) | 0);        // one sample per this many device px along x
  const vs = Math.max(1, (rh / 64) | 0);        // ... and down y
  let prev = null;                              // previous row's runs, to merge a run of rows into one rect
  for (let Y = ry; Y < y1; Y += vs) {
    const by = (Y * ys) | 0;
    if (by < 0 || by >= BH) continue;
    const h = Math.min(vs, y1 - Y), base = by * BW;
    const runs = [];
    let rs = -1, re = 0;
    for (let X = rx; X <= x1; X += st) {
      const xe = Math.min(x1, X + st);          // this sample stands for [X, xe)
      let bx = (X * xs) | 0;
      if (bx < 0) bx = 0; else if (bx >= BW) bx = BW - 1;
      const dz = zbuf[base + bx];
      let ok = dz === Infinity;                 // the horizon row keeps the glow it always had
      if (!ok) {
        const cc = bx * 2 / BW - 1;
        for (let bk = 0; bk < 4 && !ok; bk++) {
          const rr = dz - (bk === 0 ? 0.05 : bk === 1 ? 0.2 : bk === 2 ? 0.5 : 1.2);
          const mx = (camX + rr * (dirX + planeX * cc)) | 0, my = (camY + rr * (dirY + planeY * cc)) | 0;
          if (mx < 0 || my < 0 || mx >= N || my >= N) continue;     // both axes, always
          const jj = my * N + mx;
          if (cell[jj]) continue;                                   // inside a wall: back up into the air
          const cf = fz[jj] * ZQ;
          ok = cf >= lo && cf <= hi;
        }
      }
      if (ok) { if (rs < 0) rs = X; re = xe; }
      else if (rs >= 0) { runs.push(rs, re); rs = -1; }
    }
    if (rs >= 0) runs.push(rs, re);
    let same = prev !== null && prev.length === runs.length;
    for (let i = 0; same && i < runs.length; i++) if (prev[i] !== runs[i]) same = false;
    if (same) for (let i = 0; i < runs.length / 2; i++) GR[GR.length - runs.length / 2 * 5 + i * 5 + 3] += h;
    else { for (let i = 0; i < runs.length; i += 2) GR.push(runs[i], Y, runs[i + 1] - runs[i], h, 1); }
    prev = runs;
  }
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
    if (rw > 0 && rh > 0) {
      /* The source's own band, once per lamp, from the ONE derivation (js/20_level.js `lightBand`):
         a lamp's hover comes off, a z-less source is already on its floor, and a ceiling fitting
         (#413) states its floor explicitly. This call site used to restate the first two rules only,
         so a fitting hung under a slab got its glow rects cut to a band four quanta above the room -
         the glow the player was supposed to see ON the ceiling landed in the slab and vanished. */
      const lf = lightBand(L);
      glowBandRects(rx, ry, rw, rh, lf);
      for (let i = 0; i < GR.length; i += 5) {
        if (GR[i + 2] <= 0 || GR[i + 3] <= 0) continue;
        ctx.globalAlpha = GR[i + 4];
        ctx.fillRect(GR[i], GR[i + 1], GR[i + 2], GR[i + 3]);
      }
      ctx.globalAlpha = 1;
      if (GLOWREC) GLOWREC.push({ x: s.x, y: s.y, rad: rad, k: k, d: d, lx: L.x, ly: L.y, lz: L.z,
        lf: lf, str: L.str || 0.8, col: col, rects: GR.slice() });
    }
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
  /* The exposure term, on the room and before anything else composites onto it - see EXPOSE_A. Two
     flat fills: `multiply` by (255-A)/255 is the gain, `lighter` with flat A is the offset, and the
     composed curve is v*(1-A/255)+A exactly. No `filter`, so the no-ctx.filter browser gets this
     picture rather than a game two stops darker. */
  if (q.expose > 0) drawExposure(q.expose | 0);
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
    ctx.fillStyle = k.type === 'health' ? '#5ce07a' : k.type === 'armor' ? '#4ab0ff' : k.type === 'gren' ? '#c8e05a' : '#ffcf6a';
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
