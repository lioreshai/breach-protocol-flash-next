/* ==================================================================
   Procedural 3D character meshes + a software triangle rasterizer. DEV-only.

   Why this exists: js/11_rig.js draws characters as flat billboards whose
   "yaw" is one of 8 buckets, each a re-layout of the skeleton in 2D. This
   path builds the same proportions as volumetric geometry, so a body has
   sides, a real depth per pixel and - the part a billboard cannot do -
   self-occlusion: an arm behind a torso is hidden by the torso.

   Since #72 the enemy list IS the caller: js/40_render.js hands every enemy to MESH.draw with the
   four pose signals the billboard used to feed js/11_rig.js. DEV.mesh() is the second caller and
   draws extra bodies over a rendered frame, so the two paths can still be A/B'd against each other.

   Depth: the framebuffer's zbuf is one perpendicular distance per PIXEL
   (js/40_render.js:50), not per screen column as it was when this rasterizer
   was first written. Two consequences, both handled in tri():
   - the occlusion test is zbuf[y*BW+x] < z, the same strictly-nearer rule the
     billboard and particle paths use (js/40_render.js:690, :836), so a body
     clips against floors and ceilings the wall pass never wrote;
   - the rasterizer WRITES its own depth there, which is what makes a body
     occlude itself. Read-only depth gives painter's order instead, and the
     model emits torso boxes before arm tubes, so a far arm painted through a
     chest looked like a feature. Pass {self:false} to get that back as a
     negative control.
   The writes are transient: castGround fills every row of zbuf on the next
   frame (js/40_render.js:247,272,296), and DEV.mesh runs after renderWorld.
   ==================================================================*/
const MESH = (function () {

  // proportions in fractions of total body height - kept in sync by the assert below
  /* How a body dies (#82). `die` is DIEV rows per kind, and the row IS the death: topple angle,
     the fall direction as a yaw term (see draw - it is free, so a sideways corpse costs no extra
     vertex set), per-limb hip swing / knee bend / shoulder raise, and how far it sinks. Row 0 of
     every kind is the pose that shipped before variants existed, down to the number, so a corpse
     that rolls 0 dies exactly the way it used to and every contrast number measured against it
     still means what it said. The rows differ per kind on purpose: a hound's legs go out stiff,
     a brute's mass takes it down off-axis, and a grunt crumples the way it always did.
     Limb arrays are indexed the way the leg/arm loop is: [0] = -side (the body's right), [1] =
     +side. sw is the hip swing from straight down (+ forward), bd the knee bend off that, aa the
     shoulder raise (+ forward and up) and sa the forearm relative to it. */
  const SPEC = {
    grunt: {
      aspect: 0.62, hip: 0.50, sh: 0.815, head: 0.915, headR: 0.068, torso: 0.235, hipLat: 0.055, shLat: 0.098, thigh: 0.245, shin: 0.235, upper: 0.175, fore: 0.165, limb: 0.040, arm: 0.031,
      gun: { len: 0.34, cal: 0.016, mag: 0.055 },   // #78: held by the right hand, laid forward along the aim
      die: [
        { tp: 1.35, yw: 0.0, sw: [0.45, -0.45], bd: [0.85, 0.85], aa: [0.50, 0.50], sa: [-0.20, -0.20], sk: 0.02 },
        { tp: 1.20, yw: TAU * 0.25, sw: [0.80, -0.15], bd: [0.40, 1.15], aa: [1.15, 0.20], sa: [-0.30, -0.55], sk: 0.03 },
        { tp: 1.55, yw: 0.30, sw: [0.10, 0.35], bd: [1.30, 1.05], aa: [0.10, 0.25], sa: [-0.45, -0.40], sk: 0.05 },
      ],
    },
    hound: {
      aspect: 1.02, hip: 0.50, sh: 0.72, head: 0.80, headR: 0.095, torso: 0.48, hipLat: 0.10, shLat: 0.13, thigh: 0.21, shin: 0.21, upper: 0.17, fore: 0.17, limb: 0.038, arm: 0.034,
      die: [
        { tp: 1.35, yw: 0.0, sw: [0.45, -0.45], bd: [0.85, 0.85], aa: [0.50, 0.50], sa: [-0.20, -0.20], sk: 0.02 },
        { tp: 1.45, yw: -TAU * 0.25, sw: [0.70, -0.70], bd: [0.20, 0.25], aa: [0.85, -0.30], sa: [-0.15, -0.60], sk: 0.02 },
        { tp: 1.25, yw: 0.60, sw: [0.85, -0.25], bd: [0.35, 1.00], aa: [0.65, 0.10], sa: [-0.55, -0.25], sk: 0.04 },
      ],
    },
    brute: {
      aspect: 0.80, hip: 0.44, sh: 0.775, head: 0.855, headR: 0.080, torso: 0.33, hipLat: 0.075, shLat: 0.16, thigh: 0.205, shin: 0.20, upper: 0.20, fore: 0.18, limb: 0.052, arm: 0.046,
      gun: { len: 0.46, cal: 0.024, mag: 0.075 },    // a brute's weapon is a slab; the hound authors none
      die: [
        { tp: 1.35, yw: 0.0, sw: [0.45, -0.45], bd: [0.85, 0.85], aa: [0.50, 0.50], sa: [-0.20, -0.20], sk: 0.02 },
        { tp: -1.15, yw: 0.0, sw: [0.20, -0.20], bd: [0.30, 0.30], aa: [1.00, 0.90], sa: [0.35, 0.30], sk: 0.03 },
        { tp: 1.30, yw: -TAU * 0.25, sw: [0.55, -0.10], bd: [1.10, 0.45], aa: [0.20, 0.75], sa: [-0.50, -0.15], sk: 0.06 },
      ],
    },
  };
  // js/11_rig.js COL: SKIN=armor, DARK=dark, CLOTH=cloth, decoded to numbers
  const SKIN = { grunt: [58, 66, 80], hound: [65, 82, 47], brute: [67, 48, 79] };
  const DARK = { grunt: [35, 42, 53], hound: [35, 44, 26], brute: [36, 26, 44] };
  const CLOTH = { grunt: [74, 85, 104], hound: [92, 112, 64], brute: [90, 64, 104] };

  const NS = 6;                                    // tube sides; 6 keeps <=260 tris/enemy
  const RC = new Float32Array(NS * 2);
  for (let i = 0; i < NS; i++) { const a = i * Math.PI * 2 / NS; RC[i * 2] = Math.cos(a); RC[i * 2 + 1] = Math.sin(a); }
  const GUNM = [30, 34, 42], GUNM2 = [46, 52, 62];   // gunmetal: darker than every SKIN above, so a held
  //                                                  object reads as an object, not as another limb
  /* The view model's tint register (#376): identity, so the cell's hue multiplies out of the weapon's
     light while its INTENSITY terms stay live. js/40_render.js calls the same thing TINT_WHITE and uses
     it for geometry drawn outside any map; it is not imported here because a draw() that reads a global
     from a later-loaded file for its OWN constant is a tie no reader can see from this file. */
  const TINT_NEUTRAL = [1, 1, 1];

  /* #611 the body's counter-pigment against the cast it stands in (see BODYHUE in js/00_core.js).
     BH_K is how much of the room's hue is taken back out of the body's paint: 1 cancels the cast to
     first order, 0 is the fixed-albedo form the separation rows are seen failing. BH_LO/BH_HI bound
     the multiplier so a strongly tinted cell cannot take a channel of a dark palette to nothing; the
     clamp is what makes the row's mean move by a tenth rather than by a third in the worst deal. */
  const BH_K = 1.0, BH_LO = 0.62, BH_HI = 1.45;

  /* #78: one subdivision knob for every part was the spike's last leftover - a thigh and a visor got
     the same 6-sided prism, so the silhouette faceted exactly where it is widest while the small parts
     were already over-tessellated. `ns` is a per-CALL register on the Builder, the same shape as `em`
     and the region register below, and rings are built once per side count rather than once per call
     (emit builds a pose, not a frame, but it must not allocate either). The limb count reads `S.gfx`,
     which is the index the renderer's own tier table is addressed by (`QUAL[clamp(S.gfx…)]`,
     js/40_render.js:91) - that is what "the geometry budget has no hook" was asking for: the top tier
     spends the extra sides, the lower tiers cost exactly what they cost today. */
  const NS_HI = 8;
  const RINGS = { 6: RC };
  function ring(n) {
    let r = RINGS[n];
    if (!r) {
      r = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { const a = i * Math.PI * 2 / n; r[i * 2] = Math.cos(a); r[i * 2 + 1] = Math.sin(a); }
      RINGS[n] = r;
    }
    return r;
  }
  const segLimbs = () => (S && (S.gfx | 0) >= 2 ? NS_HI : NS);

  /* How far a part reaches INTO the part it joins, in fractions of body height (#74). Parts that
     butt exactly leave a seam that opens at oblique yaw, because each box's silhouette edge is
     solved on its own; an overlap makes the junction one silhouette at every angle. */
  const JOIN = 0.02;

  /* How far the torso box's TOP face is lifted above the shoulder line, in fractions of headR (#80).
     The neck gap this tube used to fill was `head - 0.35*headR - sh` of flat DARK: 7.5% of a grunt's
     body height, and in a dim cell that band renders the same luminance as the wall behind it, so the
     geometry was stitched and the head still floated - a shading problem wearing a geometry fix, since
     the light-independent mechanism is a contact shadow (#18), not a rim (#33 floored one at AMB 0.19).
     Lifting the shoulders' top face into the bottom of the gap changes which face the eye gets there:
     a box top is flat-shaded against the key light (`sh = R0 + R1*N.KEY`, below) and carries the #232
     structure term, so it reads at any ambient, while a tube's side never can. The band left to the
     tube becomes 5.9% of a grunt's height and the shoulder plane carries the head's weight. */
  const SHOULDER_LIFT = 0.25;

  /* The neck tube's own radii, in fractions of headR (base, then crown). They are named because
     tools/view.js #80 has to know where the tube ENDS laterally: at the shoulder line the arm tubes
     start on the body's side, so a band window without a plan filter measures shoulders and calls the
     neck as wide as the torso. */
  const NECK_R0 = 0.62, NECK_R1 = 0.54;

  /* A headR fraction alone answers to the head, not to the torso the tube must not look like a gap beside
     (#80): the tube's share of its own torso BOX is 0.62*headR/(1.05*shLat) = 41% on a grunt, 43% on a
     hound and 29.5% on a brute - the mesh comment above calls 22% "a gap between two parts" and 36-41% "the
     part's own base", so brute sits alone below the regime its own file describes, because its shLat is 1.6x
     a grunt's while its headR is only 1.18x. The floor below leaves grunt and hound EXACTLY as they are
     (0.42*0.098 < 0.62*0.068 and 0.42*0.13 < 0.62*0.095, so their headR term still wins and their geometry
     is byte-identical) and takes brute to 40% - the same share of its torso a grunt has. The taper rides
     with the base. Proportioned this way, not in pixels: the painted band row measures the HEAD's envelope,
     because the head box is emitted after the tube and stamps the rows the probe samples (#80's rows print
     both numbers side by side so the difference stays visible). */
  const NECK_R_SHLAT = 0.42;
  const neckR = s => Math.max(s.headR * NECK_R0, s.shLat * NECK_R_SHLAT);

  /* The head box's half-width in fractions of headR - named for two reasons: it is the head's own
     silhouette width, and it is the LATERAL WINDOW tools/view.js #80 measures the neck band inside.
     The pixels between the head's underside and the shoulders' top face are the tube, the head box's
     underside seen from below and the torso box's top face, all of them inside the head's width; the
     arm tubes that also rise into those rows (their caps reach sh + arm, i.e. 0.847 on a grunt against
     a shoulder plane of 0.832) start at shLat, further out than the head is wide on every kind - grunt
     inner edge 0.068 m against a 0.060 m window, hound 0.0745 against 0.064, brute 0.236 against 0.104,
     in metres at the shipped scales. That is what keeps the row's mean from being the ARMS' SKIN
     colour while the neck itself goes unmeasured. */
  const HEAD_HW = 0.86;

  // boot-time drift detector: these three numbers must match js/11_rig.js SPEC
  const SRC = { hip: 0.50, torso: 0.235, limb: 0.040 };
  if (SPEC.grunt.hip !== SRC.hip || SPEC.grunt.torso !== SRC.torso || SPEC.grunt.limb !== SRC.limb)
    console.warn('MESH SPEC drifted from js/11_rig.js SPEC');

  /* ---- death variants (#82) -------------------------------------------------
     Until now the ONLY thing that made two corpses differ was which leg the loop happened to
     visit first (`sw = -0.45 * side`, js/13_mesh.js:201 on main - the discriminator was the loop
     index, not the enemy), so a firefight left twenty identical silhouettes behind. A kind now
     authors DIEV rows above and the variant is rolled AT SPAWN into e.dv, never at death: a
     death-time roll cannot be reproduced under DEV.tick, which never seeds RNG, so the live page
     could not be checked. Row 0 is the old pose, so nothing about the shipped picture changes. */
  const DIEV = 3;
  for (const k in SPEC) if (!SPEC[k].die || SPEC[k].die.length !== DIEV)
    console.warn('MESH SPEC.' + k + '.die must author exactly ' + DIEV + ' death variants');

  /* scratch, all hoisted: a triangle per call, no allocation in the draw loop
     (js/40_render.js pays for exactly this lesson - an out-param in a module
     global blocked inlining there; here the arrays are the hot path's own) */
  const MAXV = 1024;
  const VX = new Float32Array(MAXV), VY = new Float32Array(MAXV), VZ = new Float32Array(MAXV);
  // camera-space verts of the triangle being rasterized, then its clipped fan
  const CX = new Float32Array(3), CY = new Float32Array(3), CZ = new Float32Array(3);
  const OX = new Float32Array(4), OY = new Float32Array(4), OZ = new Float32Array(4);
  const SX = new Float32Array(4), SY = new Float32Array(4), IZ = new Float32Array(4);
  const cam = { x: 0, y: 0, dirX: 0, dirY: 0, planeX: 0, planeY: 0, invDet: 1, tx: 0, ty: 0, tz: 0 };

  let tris = 0, pxFilled = 0, trisCulled = 0, SELF = true;
  let BODY = false;                                   // o.body: a character, not a prop (COV stamp)
  let ALPHA = 1, FLASH = 0, TINT = null;               // per-draw terms the enemy list carries
  let EMIS = false, DIM = 0, EM = null;                // the light-exempt registers: entry-wide, per-vertex
  let PKN = 0;                                         // #371: is THIS triangle a lit prop face? see pkneeling
  /* Two terms only a view model needs, and both are A/B-able from tools/view.js because they are
     module registers rather than baked arithmetic:
     FLR  - a floor on the LIGHT MULTIPLIER, not an additive. The 2-D art multiplied its albedo by
            `0.5 + 0.5*cellLi + mz*1.5`, so its dark-room value was 0.5 of albedo; this path's
            multiplier is `AMB + li*lt*sh`, which at AMB 0.19 and a dark cell lands near 0.19 - 2.6x
            darker than the art ever was. 0.5 reproduces the art's floor AND keeps its 2:1 ratio
            between a dark cell and a lit one, which is what keeps row (d) able to darken at all.
     RIMK - the ADDITIVE half, in output space (`+ RIMC*rim`, never `*rim`): adding light to an albedo
            that averages 30..58 is the only thing that moves silhouette contrast (AGENTS, #17). The
            shape is the grazing-angle term `1 - |N.V|`, which needs no normal map and no gradient -
            the face normal and the vector to the eye are already computed two lines up. */
  let FLR = 0, RIMK = 0;
  const RIMC = [150, 176, 208];                       // a cool sky rim on warm metal
  /* #232 TORSO STRUCTURE. The shipped body is flat-shaded per TRIANGLE, so a grunt's chest is one
     box of ~26 px at 6 m carrying one luminance: its within-surface gradient measured 2.7 on the
     composited frame against 2.2-3.0 for the room behind it, and the material table's 6.3-6.7 is
     texel-space on art (#72) that the mesh no longer draws. A flat face cannot be given structure by
     a per-VERTEX value (tri() writes one packed colour per triangle), so this is a per-PIXEL term.
     Three rules, each because something else failed:
     - it is a ZERO-MEAN triangle wave, so it moves the gradient without moving the mean;
     - the constant is the SLOPE in luminance per screen pixel, not the amplitude: amplitude =
       SLOPE * projectedPeriod / 4, which is what a mip chain does for a wall texture and keeps the
       term from BOILING as the body turns (a fixed-amplitude seam at pixel period changes every
       pixel by slope*motion each frame - the failure mode that got the leg specular rejected);
     - the period is a fraction of AUTHORED BODY HEIGHT (TS_CYC seams per body unit), never pixels,
       so it does not thin out as poses get sharper, exactly as AGENTS.md says of the rim band. The
       mesh has no silhouette distance field to band on, so the band here is the grazing term
       `1 - |N.V|` - the same angle-correct stand-in RIMK uses above - floored by TS_BMIN so the
       face square to the eye, which is most of the chest, still reads.
     Legs and silhouette are untouched on purpose: a specular that rode the gait read as noise and
     shrinking the outline breaks the walk (both rejected, #232).
     #416 THE FADE WAS A CLIFF, AND THE CLIFF FELL INSIDE COMBAT RANGE. `TPR <= TS_MINP ? 0` spends the
     term at ONE projected period, and the two bodies that matter at 10 m land on opposite sides of it.
     Measured at a30bb45 by instrumenting the line below and running `node tools/view.js contrast`: a
     BRUTE at 10 m projects a 5.14 px seam period and keeps slope 9 (amplitude 11.56), while a GRUNT at
     the same 10 m projects 3.45 px - nineteen hundredths of a pixel under the gate - and lost ALL of
     it. His own surface then delivered 1.40 luma of slope per screen px against a deck behind him
     delivering 4.05, which is #457's ARCHIVE SUBLEVEL busyness row: the paint behind him was the
     sharpest thing in the frame. Nothing in the world got busier to cause that - the same row read the
     surface behind an ARCHIVE body at 2.47 luma/px on 2026-10-10 and 4.05 here, and what moved it is
     #19 giving the DECK its area detail back at range. The body was still fading out on an authored
     round number, so the two curves crossed at the range the game is played at.
       Aliasing is what the fade is for, and aliasing starts at the SAMPLE limit, near two pixels per
     cycle, not at 3.5. So a body that projects under the gate steps to ONE COARSER LEVEL of the same
     pattern (TCYC: half the seam density, so the period doubles back above the gate) instead of losing
     the term. The amplitude law is unchanged, so what stays constant across the step is the one thing
     the eye reads - luma per screen pixel - and a body walking through the boundary changes which
     seams it wears, not how bright it is. ONE step only: a second would put 2.5 seams across the 17 px
     silhouette of a body at 20 m, which is a stripe and not structure. The step is discrete because
     that is this engine's own convention: mip selection picks a level, it does not blend two (AGENTS,
     #19). Near the eye TPR is over 30 px, so level 0 runs with #232's arithmetic untouched and the
     recorded torso gradient still reads 2.52 / 2.17 / 2.52; everything that moves is a body far enough
     to have had no surface at all. */
  const TS_CYC = 10, TS_MINP = 3.5, TS_LMAX = 2, TS_SLOPE = 9, TS_MAX = 26, TS_BMIN = 0.45;
  const TSC = [0.80, 1.00, 1.15];                   // slightly cool seams on warm armour
  /* 1/TSC, for the clip bound in `tri`: the excursion a channel can carry is its distance to the byte
     limit DIVIDED by its own multiplier, so the two tables cannot drift apart. TSC[2] is unused by the
     seam blend (green and blue share TSC[1]), so its reciprocal is carried for symmetry only. */
  const TSCR = [1 / TSC[0], 1 / TSC[1], 1 / TSC[1]];
  /* #533 PROPS WERE BEING FED ZEROS. The law above is the mesh's only surface term and it is set
     entirely by one number: the vertex register `this.s`, which `Builder.box` and `Builder.tube`
     fill with the authored x+z ONLY while `rg` is set, and `rg` was set for a body's torso and
     nowhere else. Every prop vertex therefore pushed 0, every prop triangle hit the `TK = 0`
     branch below, and a crate was three flat values across five thousand pixels (`props` at
     dfc7586: CRATE 3 face levels over 4771 px, BARREL 5 over 5221) while the deck under it carried a
     generated 64x64 texture with a mip chain.
       PS_SLOPE is the one number a prop needs that a body does not. TS_SLOPE 9 is armour's: it is
     9 luminance per screen pixel of a torso whose mean sits near 100, and a crate in a dim cell
     means 48 (`props`' own (E) control), so the same slope is a 45 luma peak-to-peak seam on a
     surface that is itself 48 - a zebra, not grain, and it would have walked straight through the
     #371 brightness contract. Props get the SAME law with a slope scaled to their own mean: the
     amplitude is still `SLOPE * projectedPeriod / 4`, so what stays constant as the player walks
     past is luma-per-pixel and never amplitude (the #232 rejection of a fixed-amplitude term), and
     past TS_MINP the same one-step coarsening applies. PS_MAX is the near-field ceiling, well under
     TS_MAX 26 because the surface it lands on is darker.
       The register itself needs no new term: a prop's authored geometry is in units of its OWN
     height and `scale` is that height in metres, so the projected period of a 1/TS_CYC slice is
     `BH*sc/(dist*TS_CYC)` exactly as for a body, and both the wave and its fade are already
     written against that quantity. */
  const PS_SLOPE = 4.1, PS_MAX = 14, PS_CYC = 25 / 3;
  /* #562 THE HANDS WERE BEING FED ZEROS TOO, and their own number is a PERIOD, not a slope. The law is
     unchanged - amplitude = SLOPE * projectedPeriod / 4, one coarsening past TS_MINP - but the rig's
     geometry is authored in METRES at scale 1, so TS_CYC's 10 seams per unit would put a period of 0.1 m
     across a hand that is 0.09 m across: a full triangle wave on a fist, which is the zebra #533 refused
     for a crate, bought back at 0.3 m from the eye. VS_CYC 4 puts the period at 0.25 m - a LITTLE OVER
     twice the mass it is shading - so what the eye gets across a fist is one monotone ramp: a lit side and
     a shaded side, which is the whole of the issue's second acceptance clause. VS_MAX is the near-field
     ceiling, under WS_MAX 12 because the fist has no machined seam to carry and 12 luma across a 60 px
     hand is an edge, not a surface. Nothing here is a threshold: bodies and props read the same three
     numbers they read before, and the branch is on the geometry's own authoring unit, not on a band.
       WHY THE FISTS KEEP THEIR OWN THREE AND DO NOT JOIN WS_* (#587/#594): the gun's metal and the hands
     are TWO OBJECT CLASSES INSIDE ONE DRAW - one `MDL`, one `TCYC` - and the two want counts 25x apart. A
     10 mm seam projects to ~20 px, so across a fist that is 60 px wide it runs three periods over the mass
     this note wants to ramp ONCE; TAKE FOUR's ring gate exists to keep exactly that off the rig's pipes,
     and it is paid for there by the pipe's own arc, which a hand does not have. So the law is keyed on the
     region a part was authored under (`wg` for the metal, `rg` for the hand) and not on `!!MDL`; see the
     draw site and `HD`. */
  const VS_SLOPE = 3.4, VS_MAX = 9, VS_CYC = 4;
  /* PS_HCYC is the height weight of a prop's structure coord (#533 take two), and it is NOT 1.
     The WOOD body of a crate spans 0.80 authored units in y and 0.72 in x and z (PROPGEO.crate half
     extents 0.36 / 0.40 / 0.36), and the zero-mean construction above only works if a face spans a
     WHOLE number of wave periods on EVERY axis it varies on: at weight 1 the y span is
     0.80 * 25/3 = 6.667 periods, so a third of a period is left unpaired at the top and bottom edge
     and the crate's mean moves - the exact failure #371 forbids, bought back through the second axis.
     0.9 makes both counts whole at BOTH levels of the coarsening: y spans 6.0 periods at TCYC and
     3.0 at TCYC/2 (x and z stay at 6 and 3), so the wave is still paired pixel-for-pixel on the
     vertical axis exactly as it already was on the horizontal one. It also says the grain runs at
     about 48 deg rather than 45, which is not a defect: a plank's grain is not diagonal by
     construction, and the number is the arithmetic above, not a look. */
  const PS_HCYC = 0.9;
  /* #587 THE VIEW MODEL WAS THE LAST OBJECT WITH NO SURFACE. `b.rg` was switched on at three sites in
     this file - drum staves (#533), crate planks (#533), body torso (#232) - and never once in a weapon
     builder, so every weapon vertex left `wBuild` with structure coord 0, every weapon triangle took the
     `TK = 0` branch of `tri`, and the gun painted one value per face: the rifle's 308 triangles at hip
     spread 14,430 pixels, about 47 px each, and each of those was FLAT. The gun is in the bottom-right of
     every frame, so it was the most persistent flat surface in the game.
       WS_CYC is the weapon's seam density and it is stated in METRES because that is the unit the rig is
     authored in (a box here is `0.0235, 0.0195` of a metre, not a fraction of the object's own height as
     a body or a crate is): 100 seams per metre = one seam every 10 mm of gun, which is the width of a
     machined milling pass. The projected-period law is unchanged - `BH*sc/(dist*CYC)` - and it reads
     correctly for the rig because the rig's `scale` is 1 and its geometry is in metres, so the quantity
     the law produces is the pixel period of a 10 mm seam at the gun's own distance (~0.245 m at the hip,
     ~0.190 m shouldered).
       The zero-mean construction is a PER-PART snap rather than a chosen constant, and it has to be, for
     the reason #533 take two hit with PS_HCYC: a wave whose span across a face is 3.18 periods leaves
     0.18 of a period UNPAIRED and the part gains light for being detailed. Bodies and props get away with
     one global cycle count because their parts are all a fraction of one authored height; the rig has
     sixty boxes whose half extents are unrelated numbers, so no single constant can make every face whole.
     `wSnap` therefore scales each axis of each emitted part to the nearest EVEN period count (even, so
     the #416 coarse level still lands on whole periods), and gives an axis whose span is under 1.5 periods
     NO wave at all rather than an oversampled one - the same rule `af` already applies to a tube's axis.
     A part that snaps to zero on all three axes has all-zero coords and takes the existing flat branch,
     which is why the hands, the sleeve and the muzzle flash stay exactly as they are. */
  const WS_CYC = 100, WS_SLOPE = 4.0, WS_MAX = 12;
  const wSnap = h => { const per = 2 * h * WS_CYC; return per < 1.5 ? 0 : 2 * Math.round(per / 2) / per; };
  /* PS_CYC is 1/0.12 seams per authored unit, and the number is chosen, not tuned: a crate face is
     0.72 authored units wide (PROPGEO.crate half extents 0.36), and 0.72 * 25/3 = 6 SEAMS EXACTLY.
     That is what makes the wave's mean exactly 0 on every face instead of nearly 0. The wave is
     sampled as u = frac(coord * TCYC) along a line, so a face whose u-span is a whole number of
     periods integrates to zero; a face whose span is 7.2 periods (TS_CYC 10 on a 0.72-wide face)
     leaves a fifth of a period unpaired and the crate's mean goes UP - measured with PS_CYC = 10,
     the `props` (E) control's lit mean went 48 -> 50 on a crate that means 48, which #371 forbids.
     The coarser level under TS_MINP divides the count by TS_LMAX = 2 and 6/2 = 3 is still whole, so
     the same argument holds at range. PS_SLOPE/PS_MAX are armour's 9/26 scaled to a surface that
     means 48 rather than 100; the LAW - amplitude from the pixel's own projected period - is the
     body's and is not re-derived here. */
  let TAMP = 0, TK = 0, ST = null, TQ0 = 0, TQ1 = 0, TQ2 = 0, TCYC = 10;
  /* #562: HD is the rig's per-vertex HAND marker (wBuild) - the second structure law inside one view-model
     draw. It defaults to an EMPTY array rather than null because the triangle loop reads it on every mesh
     in the game: an empty read is `undefined`, which is falsy, so a body or a prop takes its own constants
     without the loop carrying a null test that only one caller ever needs. */
  const NOHD = new Uint8Array(0);
  let HD = NOHD, TAMPH = 0, TCYH = 10;
  /* o.near swaps the DEPTH array rather than adding a branch to the pixel loop. The swap makes the
     same `if (occ < z) continue` compare the draw against ITSELF instead of against the frame: the
     world's distances are never consulted, so nothing in the room can cull the view model, and the
     writes land in scratch so the frame's depth is exactly what it was - the view model cannot punch
     a hole in the foreground after it is drawn. Self-occlusion still has to be real: the gun is 60
     boxes and tubes whose faces overlap in screen space, and painter's order cannot order them (the
     art got away with a fixed order because it drew the forearms behind the receiver by hand). So
     the scratch is a depth buffer, and the region the PREVIOUS frame's view model wrote is cleared
     before the next one draws - outside that rectangle the scratch is already +Infinity, which makes
     the clear exact (induction: every pixel ever written was inside the rectangle cleared last
     frame) and costs a strip of the frame rather than a fill of it. */
  let ZFAR = null, ZSAVE = null, VMASK = false;
  let srx0 = 0, srx1 = -1, sry0 = 0, sry1 = -1;      // the rectangle the last view-model draw wrote
  let R0 = 0.30, R1 = 0.85;                            // the Lambert ramp, per kind - see draw()
  let CR = 0, CG = 0, CB = 0;                       // shaded colour of the current triangle
  /* #371: the prop paint's CLIP bound. PROPGEO's numbers are authored albedo, and the prop lift below
     multiplies them by 1.35 ("sprites are albedo: they get lit again", js/05_paint.js) - so the crate's
     WOOD enters the shading with red at 175 where green is 125 and blue 73. The face ramp then
     multiplies the room's light by `R0 + R1*d` with R1 0.68, while a wall column pays NO shape ramp at
     all (js/40_render.js:1043), so a prop face turned into the key is lit up to 1.28x what the same
     light does to the wall behind it - and 175 x that is past 255 at the pack line under this comment.
     Once a channel is pinned the face CANNOT answer the lamp: at the level-3 seat (`node tools/view.js
     scene 3 0`, the crate's lit flank, 7,371 px) 75.6% of it sat at red 255 with its green still at 192,
     while the wall behind it pinned 0 of 49,051. That is the "bright card with a hairline down the
     middle" the issue is about, and it is a CLIP, not a lighting choice - which is why the fix is a
     ceiling on the prop's own shading and not a dim of the room (#377's frame-wide shoulder folds
     highlights AFTER the raster, and it cannot reach a channel already pinned here).
     One fold, monotone, applied to a lit PROP triangle and to nothing else: not to an emissive part (a
     lamp's aperture is a light source and the `props` LAMPCORE census reads it), not to a body, not to
     the view model. Below PKNU it is the identity to the byte, so a prop in a dim cell is untouched;
     above it every channel approaches 255 without reaching it, so a lit face keeps a gradient. The
     frame-wide rule this copies is #377's; the reason it is paid here is that #377's own note says it
     cannot un-clip a pixel that arrived clipped. */
  const PKNU = 227, PKD = 28;                         // fold from 227; 227+28 = 255 is the asymptote
  const pkneeling = v => v <= PKNU ? v : PKNU + PKD * (v - PKNU) / ((v - PKNU) + PKD);

  /* ---- geometry emit: tubes and boxes into a flat vertex/index list ----
     Every vertex leaves through the builder's current transform: a rotation about the body's
     lateral axis plus a translation. That is what lets a pose LEAN a torso and TOPPLE a corpse
     without the emit code knowing either is happening, and it is resolved once per pose bucket,
     never per frame. */
  const PT = [0, 0, 0];
  function Builder() {
    this.p = [];                                    // x,y,z,r,g,b
    this.t = [];                                    // i0,i1,i2
    this.e = [];                                    // 1 where the part makes its own light
    this.s = [];                                    // #232 authored structure coord per vertex, 0 = none
    this.rg = 0;                                    // region register: 1 while a torso part emits
    /* #533 take two HEIGHT WEIGHT of the structure coordinate, and it is a SECOND register on purpose.
       The coord was `x + z`, so on a face whose normal is x or z the coord is CONSTANT across the whole
       face: a crate's side carried a wave in one screen direction and nothing in the other, which reads
       as corrugation, not grain (measured across one level-0 frame: crate dL/dx 0.41 against the deck's
       0.71, dL/dy 0.15 against the deck's 1.69). A body cannot simply take the y term - its torso coord
       is the same `x + z` and every body pixel in the gate is recorded against it - so the weight is
       per-EMIT, lives beside `rg`, and is 0 for every body and the view model, which leaves their
       vertex streams byte-identical. Props set it to PS_HCYC, and the `props` (G) row is the one that
       can see either axis missing. */
    this.rgY = 0;
    /* #587 WEAPON STRUCTURE. A THIRD register, again so nothing already shipped moves: while `wg` is set
       the coord is authored in metres with a per-axis factor from `wSnap`, so a part's wave spans a whole
       even number of periods on every axis and the part's mean cannot move. Bodies and props leave it 0
       and their vertex streams are byte-identical. */
    this.wg = 0;
    /* #562 the VERTEX SPANS that the HAND region covers, as [start, end) pairs, and it is a list of ranges
       rather than another per-vertex register so that nothing a body or a prop builds changes: `vHand`
       brackets each region it emits and `wBuild` is the only reader, which turns it into one byte per vertex
       for the rig's geometry and no array at all anywhere else. It is the rig's SECOND structure law (the
       fists, VS_*), and the draw site needs it because one `MDL` draws the gun's metal and the fists in one
       pass. */
    this.hs = [];
    this.ca = 1; this.sa = 0;                       // rotation about x, positive tips the up axis forward
    this.cx = 0; this.cy = 0; this.cz = 0;
    this.em = 0;                                    // set around an emit to mark the part emissive
  }
  const B = { cross: (ax, ay, az, bx, by, bz) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx] };

  /* which part was emitted last, per vertex: 0 = it reflects the room, 1 = it makes its own light.
     The billboard marks an emissive TEXEL by writing alpha byte 253 (js/10_assets.js:81) and the
     raster routes those pixels around the light term entirely (js/40_render.js:703). A mesh has no
     texture and no alpha channel to hide a marker in, so the exemption is a vertex flag instead - and
     it must be per PART, not per entry, because a lamp is a metal post with a bulb in it. */
  Builder.prototype.em = 0;
  Builder.prototype.ns = 0;                          // tube sides for the NEXT tube; 0 = the shipped NS

  /* compose "rotate by ang about the pivot (py,pz)" into the current transform:
     R2(R1 p + c1) = R(a1+a2) p + (R2 c1 + c2), so one angle and one vector carry the whole chain */
  Builder.prototype.tip = function (ang, py, pz) {
    if (!ang) return this;
    const ca = Math.cos(ang), sa = Math.sin(ang), y = this.cy, z = this.cz;
    this.cy = ca * y - sa * z + py - (ca * py - sa * pz);
    this.cz = sa * y + ca * z + pz - (sa * py + ca * pz);
    const k = Math.atan2(this.sa * ca + this.ca * sa, this.ca * ca - this.sa * sa);
    this.ca = Math.cos(k); this.sa = Math.sin(k);
    return this;
  };
  Builder.prototype.pt = function (x, y, z) {
    const ca = this.ca, sa = this.sa;
    PT[0] = x + this.cx; PT[1] = y * ca - z * sa + this.cy; PT[2] = y * sa + z * ca + this.cz;
    return PT;
  };

  /* tapered tube from a to b (body space, y up, +z forward), radii ra->rb, colour c */
  Builder.prototype.tube = function (ax, ay, az, bx, by, bz, ra, rb, c) {
    const pa = this.pt(ax, ay, az);
    const p0x = pa[0], p0y = pa[1], p0z = pa[2];            // pt shares one scratch array
    const pb = this.pt(bx, by, bz);
    let dx = pb[0] - p0x, dy = pb[1] - p0y, dz = pb[2] - p0z;
    /* #232 authored, before the transform. For a TUBE the axis endpoints are not enough: a barrel's
       staves run along y at x=z=0, so `ax+az` is 0 for the whole part and the ring would carry one
       value around the circumference - a drum with no staves. #533 adds the ring vertex's own offset
       to it, which is what makes a tube's structure vary AROUND it. It is added inside `this.rg`, so
       with the register clear - every body tube, since rg is only ever set for a torso BOX - both
       terms are 0 and the vertex stream is byte-identical to what it was. */
    /* #232 authored, before the transform. For a TUBE the axis endpoints are not enough: a barrel's
       staves run along y at x=z=0, so `ax+az` is 0 for the whole part and the ring would carry one
       value around the circumference - a drum with no staves. #533 take one added the ring vertex's
       own linear offset to it, which varied the wave AROUND a tube but left two of a hexagon's six
       faces with a CONSTANT coord: a face lying in the x+z = const plane carries no horizontal wave
       at all, which is the whole of why `props` read the barrel's x axis at 0.50 dL/px against the
       crate's 1.50 on the same amplitude law, and why raising its depth bought a 4.5-luma drop in the
       authored frame mean instead of grain (flatparity LOCK L3, #371).
       #533 TAKE THREE puts the ring's PHASE on the coordinate instead of its linear position, and
       snaps both counts so a face spans a WHOLE number of periods at either level of the #416
       coarsening - the zero-mean half the depth needed and did not have:
       - going round: a ring's circumference is not a whole number of 1/PS_CYC slices, so the count is
         snapped to a multiple of the ring's own face count times TS_LMAX. The coord RINGS UP over the
         first half and back down over the second rather than running monotonically: an angle would
         jump by a whole ring across the closing face and paint a reversed, oversampled wave on one
         face of every barrel (aliasing, #19). The ramp is continuous, its slope reverses only at the
         far shoulder, where the grazing term already takes the amplitude down;
       - going up: the axis term is scaled by `af` to the nearest EVEN period count, so the same face
         is paired at TCYC and at TCYC/TS_LMAX instead of leaving a fifth of a period unpaired at the
         top and bottom edge. A part too short to carry two periods gets no axial wave at all rather
         than an oversampled one.
       With `rg` clear - every body tube, since rg is only ever set for a torso BOX, and the view model
       - both terms stay 0 and the vertex stream is byte-identical to what it was. */
    let sva = 0, svb = 0, RING = 0, half = (this.ns || NS) / 2;   // the ring ramp's face count, same value `rg` sets below
    if (this.wg) {
      /* #587 the rig's tubes: the AXIAL term only, and that is a limitation stated rather than a gap
         overlooked. A tube's ring term puts one wave across every face of the prism, and the gun's tubes
         are 10-25 mm across, which projects to 15-30 screen px at the rig's own seat - six faces into
         that is a 2-5 px period, under TS_MINP, i.e. the #19 radial-spoke failure written on the object
         that sits in front of the camera for the whole game. The projected period is a DRAW-time quantity
         (it turns on BH and on the player's distance) and this geometry is cached across resolution
         changes, so a build-time ring count cannot be made to obey the gate. The axial term is safe: a
         10 mm step along a tube projects to ~9-12 px at the rig's depths, and it reads as machined rings
         on a barrel and as checkering on a grip. Rings on the rig's cylinders are the stated remaining
         work on #587. Centred on the part's own midpoint for the same reason a box is centred.
           TAKE TWO IS A BUG FIX, NOT A TUNE. #588 computed this term and the two ring pushes below emitted
         `this.rg ? … : 0` - they tested only `rg`, which the rig never sets - so on the view model the
         whole block was a DEAD STORE and the sentence above was false of the shipped build: the rig's
         barrels, magazine tubes, stocks, grips and trigger guards left the builder with coord 0 and took
         the flat `TK = 0` branch exactly as they did before #588. Both pushes now test `wg` too.
           WHAT IT PUTS ON SCREEN, measured in ONE tree by deleting the rig's tube geometry outright
         (`if (this.wg) return this;` before the ring loop) and reading `viewmodel`'s own paint count: at
         the HIP a pistol's tubes contribute 0 of its 10,357 px (258 tris vs 234 - submitted, and every one
         of their pixels LOST TO A DEPTH TEST against geometry emitted before them), and SHOULDered they
         contribute 6,127 of 51,308. So this term reaches the screen when the gun is shouldered and not at
         the hip, which is also why every recorded frame - all of them hip frames - holds its byte, and why
         the surface the hip shows is still the box parts #588 wired in.
           THE EARLIER SENTENCE GOT THE MECHANISM BACKWARDS, and it cost a pass, so it is corrected here
         rather than left to mislead the next reader. It said the hip pixels were "repainted by a part
         emitted later, because the rig deliberately writes no depth". The rig DOES write depth: `near`
         swaps `zbuf` for its own scratch array above (see the `o.near` block in `draw`), and the view
         model's call site passes no `self` key, so SELF is true and a rig part is tested against the rig
         parts emitted BEFORE it. Order decides which triangle is tested first, not which one wins; the
         depth decides the pixel. The control is on #587 at this same head: walking the rig's triangle list
         in reverse on a pistol hip frame is BYTE-IDENTICAL (0 px of 1202x676) - an emit-order change
         cannot be the lever. Measured here by the delete-the-tubes A/B (`JSDIR=` against a tree carrying
         `if (this.wg) return this;`) at 19af99e: deleting the pistol's tubes changes NO pixel at all -
         `viewmodel` reads the same 9,987 hip px and a whole `scene 0 0` frame comes back byte for byte -
         so the tubes lose to geometry in front of them. What is nearer at the hip is the slide/frame boxes and
         the two fists: the bore is 0.245 m out with the muzzle pointing AWAY, so anything slung under or
         ahead of the receiver is behind the box that carries it. Per weapon at hip, round-part px of the
         rig's own painted pixels measured the same way on this machine at 19af99e - pistol 0 of 9,987,
         shotgun 429 of 11,259, rifle 190 of 13,786 - so two of the three guns already have some tube on
         screen and the pistol has none. Making those parts read while carried is a geometry change to the
         carried poses in `weaponGeo` (silhouette and proportion), which #587's product decision now
         authorizes with the references it moves re-recorded; it is not a shading term and not an ordering
         fix. The hip tubes being depth-occluded wholesale is #587's stated remaining work alongside the
         ring term. */
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz2 = (az + bz) * 0.5;
      const fx = wSnap((bx - ax) * 0.5), fy = wSnap((by - ay) * 0.5), fz = wSnap((bz - az) * 0.5);
      sva = (ax - mx) * fx + (ay - my) * fy + (az - mz2) * fz;
      svb = (bx - mx) * fx + (by - my) * fy + (bz - mz2) * fz;
      /* TAKE FOUR PUTS THE RING BACK ON THE RIG'S FAT PIPES, and gates it the way `af` already gates the
         axis term instead of the way `rg` does. The paragraph above was right that a build-time ring count
         cannot obey a draw-time gate, and it drew the wrong conclusion: the gate is not on the tube's
         DIAMETER, which is what it measured (10-25 mm across, "2-5 px"), but on the wave's OWN period, and
         the count is free to choose that. A face of an ns-sided prism spans an arc of 2*pi*ra/ns; the ring
         count is snapped so each face carries a whole, EVEN number of 1/WS_CYC periods of coordinate, so
         the projected period is that arc's projection and not the diameter divided by six, and the evenness
         keeps it whole at BOTH levels of the #416 coarsening exactly as `af` does for the axis. One wave
         across a face is also what a hexagonal barrel reads as at this art scale - a few discrete steps of
         facet, not stripes.
           The same `af` rule then decides which tubes get one: a face that cannot carry two 10 mm slices of
         arc gets NO ring at all rather than an oversampled one, because the amplitude law is the DRAW's -
         TAMP comes from the axial seam's projected period and is shared by both terms, so a ring denser
         than 10 mm would spend that amplitude at twice the luma per pixel, which is the zebra #533 measured
         on the crate and what the note above was really afraid of. Measured off the shipped geometry at
         NS = 6, that floor is radius 14.3 mm: the pistol's barrel crown (11.5), the shotgun's barrel and
         magazine tube (13.5) and the trigger guards (5) stay AXIAL-only - machined rings along a thin
         barrel - and the pistol's grip (20.5), the shotgun's pump (22.5), grip (20.5) and stock (24.5-28.5)
         and the rifle's grip (21) and stock (22.5-26.5) take one wave around them, which are the wood and
         polymer parts a flat value currently paints as one slab. A thin tube gaining its ring term later
         would need the amplitude split per term; that is the remaining risk, stated here rather than hidden.
         Zero-mean by construction the way #533 requires: the ramp rises over the first half of the ring and
         falls over the second, and every FACE spans whole periods, so no face - not just no part - is left
         with an unpaired fraction to gain light from. Geometry is untouched: vertex positions, counts and
         colours are byte-identical, so this reaches a frame only through `tri`'s existing seam term. */
      const nr = this.ns || NS, arp = (ra * Math.PI * 2 * WS_CYC) / nr;   // 10 mm slices across ONE face
      const kp = arp < 1.5 ? 0 : 2 * Math.round(arp / 2);                 // whole, EVEN periods per face
      RING = kp * half / WS_CYC;                                          // coord ramp over the half ring, metres
    } else if (this.rg) {
      const nr = this.ns || NS; half = nr / 2;
      RING = Math.max(nr, Math.round(ra * Math.PI * PS_CYC / nr) * nr) / PS_CYC;    // periods round the ring, in authored units
      const per = Math.abs(bx - ax + (by - ay) * this.rgY + bz - az) * PS_CYC;      // periods the axis term spans
      const af = per < 1.5 ? 0 : Math.max(2, 2 * Math.round(per / 2)) / per;
      sva = ax + az + ay * this.rgY * af; svb = bx + bz + by * this.rgY * af;
    }
    ax = p0x; ay = p0y; az = p0z; bx = pb[0]; by = pb[1]; bz = pb[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    dx /= L; dy /= L; dz /= L;
    // two orthogonals to the axis; pick the ref axis furthest from it for stability
    const ref = Math.abs(dy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = B.cross(dx, dy, dz, ref[0], ref[1], ref[2]);
    const UL = Math.hypot(u[0], u[1], u[2]) || 1e-6; u = [u[0] / UL, u[1] / UL, u[2] / UL];
    const v = B.cross(dx, dy, dz, u[0], u[1], u[2]);
    const base = this.p.length / 6;
    const n = this.ns || NS, RN = ring(n);           // #78: per-part subdivision, ring cached per count
    for (let i = 0; i < n; i++) {
      const cx = u[0] * RN[i * 2] + v[0] * RN[i * 2 + 1], cy = u[1] * RN[i * 2] + v[1] * RN[i * 2 + 1], cz = u[2] * RN[i * 2] + v[2] * RN[i * 2 + 1];
      this.p.push(ax + cx * ra, ay + cy * ra, az + cz * ra, c[0], c[1], c[2]); this.e.push(this.em);
      this.s.push(this.rg || this.wg ? sva + RING * (i <= half ? i / half : 2 - i / half) : 0);
    }
    for (let i = 0; i < n; i++) {
      const cx = u[0] * RN[i * 2] + v[0] * RN[i * 2 + 1], cy = u[1] * RN[i * 2] + v[1] * RN[i * 2 + 1], cz = u[2] * RN[i * 2] + v[2] * RN[i * 2 + 1];
      this.p.push(bx + cx * rb, by + cy * rb, bz + cz * rb, c[0], c[1], c[2]); this.e.push(this.em);
      this.s.push(this.rg || this.wg ? svb + RING * (i <= half ? i / half : 2 - i / half) : 0);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.t.push(base + i, base + n + i, base + n + j, base + i, base + n + j, base + j);
    }
    return this;
  };

  /* axis-aligned box centred at c with half extents h */
  Builder.prototype.box = function (cx, cy, cz, hx, hy, hz, c) {
    const faces = [
      [[cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz + hz], [cx - hx, cy - hy, cz + hz]],
      [[cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz - hz]],
      [[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz]],
      [[cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]],
      [[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz]],
      [[cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy - hy, cz + hz]],
    ];
    /* the three factors are a property of the PART, not of the face: hoisted out of the six-face loop so
       a 35-box rebuild calls wSnap 3 times per box instead of 18 (#587) */
    const fx = this.wg ? wSnap(hx) : 1, fy = this.wg ? wSnap(hy) : this.rgY, fz = this.wg ? wSnap(hz) : 1;
    for (const q of faces) {
      const b0 = this.p.length / 6;
      for (const qv of q) { const p = this.pt(qv[0], qv[1], qv[2]); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); this.e.push(this.em); this.s.push(this.wg ? (qv[0] - cx) * fx + (qv[1] - cy) * fy + (qv[2] - cz) * fz : this.rg ? qv[0] + qv[1] * this.rgY + qv[2] : 0); }
      this.t.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    return this;
  };

  /* a bipyramid - an octahedron when the radii agree: 6 vertices and 8 triangles against a box's 24,
     and the only primitive here that reads as a bulb or an energy cell rather than a crate. Props are
     the reason it exists; no body uses it. */
  Builder.prototype.bip = function (cx, cy, cz, rx, ry, rz, c) {
    const eq = this.p.length / 6;
    /* #587: this push is load-bearing even with `wg` clear. `b.s` is indexed by VERTEX, so a primitive
       that emits vertices without emitting coords silently shifts every coord that comes after it. The
       muzzle flash is two bips at the END of each weapon builder, so the shift was invisible there - but
       the pistol's slide-back box and the shotgun's shell follow their own bips in some states, and a
       shifted coord is a wave with the wrong phase, which is not a thing any row would see as flat. */
    const put = (x, y, z) => { const p = this.pt(x, y, z); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); this.e.push(this.em); this.s.push(this.wg ? (x - cx) * wSnap(rx) + (y - cy) * wSnap(ry) + (z - cz) * wSnap(rz) : 0); };
    put(cx + rx, cy, cz); put(cx, cy, cz + rz); put(cx - rx, cy, cz); put(cx, cy, cz - rz);
    const top = this.p.length / 6; put(cx, cy + ry, cz);
    const bot = this.p.length / 6; put(cx, cy - ry, cz);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.t.push(eq + i, eq + j, top, eq + i, bot, eq + j);
    }
    return this;
  };

  /* ---- props: authored geometry, and static --------------------------------------
     js/12_sprites.js:306-410 paints each prop as ONE flat Surf with rrect/ell/polygon and a closure
     shade fn, so there is no part list to port - the parts below are new. Three rules they keep:
     - the y range is the prop's TOTAL height, because draw() puts a vertex at o.z + by*sc exactly as
       the quad centres at o.z + scale*0.5 (js/40_render.js:635), so `scale` ports 1:1;
     - the colours are ALBEDO, not the pre-lit values the sprite closures returned. The barrel's cyl()
       multiplied 142,54,36 by 0.30+0.8*dif; here 142,54,36 is the albedo and 0.30+0.85*d is the same
       Lambert term the bodies already use, so a barrel in the same light reads the same;
     - a part that makes its own light is wrapped in b.em = 1, the mesh's only equivalent of the
       billboard's alpha-byte-253 branch. The orb and the portal are exempt end to end because the
       billboard drew them self:true (js/40_render.js:119,:120); the lamp's bulb is exempt and its post
       is not, which is what the sprite's rgrad-over-rrect split meant.
     Proportions are measured off the sprites' own layouts (a 64x92 barrel quad puts its lid at 0.14 of
     h from the top, so the lid ring is at y 0.93 here; the lamp's fixture sits at h*0.20 from the top,
     so y 0.80) and each footprint is that quad's width, so nothing changes size by becoming a solid.
     Static means cheap here: no phase buckets, so each of these is rasterized from ONE vertex table
     that never rebuilds, which is the claim COST=1 in the props probe measures. */
  /* the three pickups are one shape with three paints; see the rows below for why the type is not a
     tint. Body fractions: the case fills 0.26..0.74 of its own height, because the DRAW ENTRY already
     lifts z by the 0.16 bob the billboard used, so the sprite's visible centre lands where it was. */
  function pickParts(shell, band, plate) {
    return b => {
      b.box(0, 0.50, 0, 0.30, 0.24, 0.30, shell);
      b.box(0, 0.30, 0, 0.315, 0.05, 0.315, band);
      b.box(0, 0.56, 0.285, 0.12, 0.12, 0.03, plate);
      b.box(0, 0.56, -0.285, 0.12, 0.12, 0.03, plate);
      return b;
    };
  }

  const PROPGEO = {
    /* Each kind also carries its authored footprint radius in FOOT below - the draw loop needs it to
       tell "in front of the prop" from "inside the prop" (#212). */
    barrel(b) {
      const RED = [120, 46, 30], RIM = [74, 30, 22], YEL = [160, 128, 24], MET = [150, 156, 164];
      b.rg = 1; b.rgY = PS_HCYC;                      // #533: the staves are the surface; the hoops stay flat
      b.tube(0, 0.03, 0, 0, 0.50, 0, 0.225, 0.245, RED);       // the staves, bulging at the bilge
      b.tube(0, 0.50, 0, 0, 0.93, 0, 0.245, 0.215, RED);
      b.rg = 0; b.rgY = 0;
      b.tube(0, 0.27, 0, 0, 0.33, 0, 0.255, 0.255, RIM);       // the two hoops
      b.tube(0, 0.66, 0, 0, 0.72, 0, 0.25, 0.25, RIM);
      b.tube(0, 0.42, 0, 0, 0.55, 0, 0.25, 0.25, YEL);         // the hazard band
      b.tube(0, 0.90, 0, 0, 0.97, 0, 0.225, 0.20, RIM);        // the lid
      b.box(0, 0.95, 0.11, 0.045, 0.02, 0.045, MET);           // the bung on it
      return b;
    },
    crate(b) {
      /* #371: the WOOD is 0.79x what it was ([158,112,64]) and that cut is the albedo half of paying for
         the wider face ramp - R1 0.42 -> 0.68 lifts the top face along with the lit side, and "no prop is
         the brightest large region in its frame other than a lamp's core" is half of the issue. The ramp
         holds the MEAN by construction (see the `R0 / R1` line in draw); this takes back what the top face gained,
         so a crate stops measuring 2.4x the wall behind it while still reading as the nearest solid thing
         in the frame. FRAME is untouched: it is already darker than the floor it stands on. */
      const WOOD = [78, 55, 31], FRAME = [70, 48, 24];
      b.rg = 1; b.rgY = PS_HCYC;                      // #533: the planks are the surface; the frame stays flat
      b.box(0, 0.44, 0, 0.36, 0.40, 0.36, WOOD);               // the body, 0.04 to 0.84
      b.rg = 0; b.rgY = 0;
      b.box(0, 0.85, 0, 0.375, 0.025, 0.375, FRAME);           // lid
      b.box(0, 0.05, 0, 0.375, 0.025, 0.375, FRAME);           // skid base
      b.box(0, 0.44, 0, 0.375, 0.055, 0.375, FRAME);           // one band, all four faces at once
      return b;
    },
    lamp(b) {
      const POST = [44, 50, 60], BASE = [62, 70, 82], SHADE = [40, 46, 54];
      b.box(0, 0.03, 0, 0.17, 0.03, 0.17, BASE);               // the foot
      b.tube(0, 0.05, 0, 0, 0.66, 0, 0.05, 0.035, POST);       // the post
      b.tube(0, 0.70, 0, 0, 0.84, 0, 0.17, 0.06, SHADE);       // the fixture, mouth down
      b.em = 1;
      // the aperture sits UNDER the cone's mouth and narrower than it. A puck of the same radius as the
      // cone at that height pokes through it, and a hexagonal puck seen edge-on is a plank: the first two
      // cuts of this looked like a yellow wing, then like a shelf, for exactly that reason.
      b.tube(0, 0.68, 0, 0, 0.71, 0, 0.135, 0.135, [255, 176, 84]);
      b.tube(0, 0.69, 0, 0, 0.705, 0, 0.08, 0.08, [255, 226, 166]);
      b.em = 0;
      return b;
    },
    /* Three rows, not one row plus a tint. The billboard had three painted sheets - white case with a
       red cross, olive tin with brass rounds, blue plate - and a mesh has no picture to carry that, so
       the identity moves into the albedo. TINT would not do it: it multiplies the LIGHT (it is an
       enemy's individual jitter), so a red plate under an armor-blue tint goes dark instead of blue. */
    pickupHealth: pickParts([228, 234, 242], [136, 148, 166], [214, 44, 36]),
    pickupAmmo: pickParts([124, 138, 86], [64, 74, 44], [212, 168, 74]),
    pickupArmor: pickParts([54, 124, 168], [180, 240, 255], [110, 220, 255]),
    /* #361's fourth row, and it is a ROW rather than a tint for the reason just stated: PKKIND
       (js/40_render.js) maps a pickup's `type` onto one of these names, so a kind missing here is not
       a grey box, it is whatever `draw` falls back to - which until now was a grunt. The plate carries
       the HUD's own grenade colour (#c8e05a, the killfeed text and the minimap dot) so the box on the
       floor and the `GL` counter in the corner say the same thing; the shell is a step darker and
       greener than the ammo tin so the two do not read as one pickup across a room. */
    pickupGren: pickParts([96, 122, 70], [46, 60, 34], [206, 232, 92]),
    orb(b) {
      b.em = 1;
      b.bip(0, 0.50, 0, 0.42, 0.50, 0.42, [150, 255, 90]);    // the shell, filling the quad's height
      b.bip(0, 0.50, 0, 0.20, 0.24, 0.20, [244, 255, 224]);   // the core the sprite circles
      b.em = 0;
      return b;
    },
    /* the billboard is a radial-gradient oval whose alpha fades to nothing, so it never hid the room
       behind it. A flat-shaded mesh has no gradient, so the surround becomes a real frame and the glow
       a thin membrane, alpha-blended: the room behind is already painted and this list is sorted far to
       near, so writing depth costs nothing and buys the one thing a quad cannot do, the near jamb
       hiding the far one. The gate is SQUARE in plan and the membrane a CROSS, because nothing in the
       level data says which way a portal faces - the entry is exitX,exitY and nothing else - and a flat
       panel lying along one world axis shrinks to a sliver when the corridor runs along the other. That
       is what the first cut did: seen end-on it was 208 px of frame with almost no glow in it. */
    portal(b) {
      const MET = [56, 62, 76], GLOW = [150, 236, 255], CORE = [240, 255, 255];
      for (const s of [1, -1]) {
        b.tube(0.30 * s, 0.0, 0, 0.30 * s, 0.88, 0, 0.04, 0.032, MET);
        b.tube(0.0, 0.0, 0.30 * s, 0.0, 0.88, 0.30 * s, 0.04, 0.032, MET);
      }
      b.box(0, 0.92, 0, 0.36, 0.05, 0.36, MET);
      b.box(0, 0.04, 0, 0.36, 0.04, 0.36, MET);
      b.em = 1;
      b.box(0, 0.46, 0, 0.32, 0.42, 0.03, GLOW);
      b.box(0, 0.46, 0, 0.03, 0.42, 0.32, GLOW);
      b.bip(0, 0.52, 0, 0.15, 0.24, 0.15, CORE);
      b.em = 0;
      return b;
    },
  };

  /* PROPGEO is TWO tables wearing one name: the props, and the two sprites that were converted to mesh
     in #76 because the Builder was already there (orb, portal). Anything that asks "is this a prop?" by
   testing PROPGEO gets those two as well - which is exactly how #371's steeper face ramp reached the
     exit frame. Measured by variant against `bands`: with the pair selected by table, the SEAM=1 frame
     moves at L1 and L3 and holds, byte for byte, at L0 and L2, while the SEAM=1-vs-SEAM=0 pixel count is
     identical on all four. That probe's pose clears PROPS, ENEMIES, PROJ and PARTS before it renders, so
     the only object the table can name in that frame is the portal - and which levels move is which of
     them has the SHUT portal in frame (`dim 0.55`, lit by the room, so the ramp shows; open, it is
     `emis` and no ramp applies to it at all). The orb never moves: it is `emis` in both states.
     So the ramp below is keyed on the prop kinds, not on the table. A portal frame is not a crate and the
     issue never asks for its jambs to carry a lit side. */
  const PROPKIND = { barrel: 1, crate: 1, lamp: 1 };

  /* ---- the weapon in the player's hands (#...) ---------------------------------
     The three view models were 2-D canvas path art in js/40_render.js. They are geometry here, on the
     same Builder the bodies and props use, so their pixels come out of the same perspective projection
     as everything else in the frame - which is the whole point: a gun drawn with canvas paths has no
     depth, cannot be lit by the room, and stays glued to the display buffer when the camera turns.

     THREE CONVENTIONS, and each one is load-bearing for a probe row:
     - METRES, and `scale` is 1: the world's meshes are authored in body fractions (a grunt is 1 unit
       tall and `scale` sizes him), which would make a 0.42 m barrel a number like 0.42 of a grunt.
       A view model's seat is stated in metres against the eye (js/40_render.js), so the geometry is too.
     - the BORE is the +z axis at y = 0, and the origin is the top of the grip. That is what lets
       js/40_render.js rotate the rig by atan(pitchTan()) about x and have the barrel point along the
       firing ray: the muzzle of a rig with no extra pitch is then ON the ray `hitscan` marches
       (js/30_entities.js:108), not merely near it. Parts hang BELOW y=0 (grip, magazine, stock) the
       way they hang below the bore on a real gun, so the sight line sits above the bore by ~0.03 m.
     - parts that MOVE on reload are placed by the `st` argument, not by a pose table. The art did the
       same thing (`slideBack`, `magOut`, `pump`, `shellIn` translated boxes), the view model is one
       mesh per frame against a 2-4 pose budget, and a bucket table for a continuous ejector travel
       would quantise it. So the vertex set is rebuilt per frame and cached not at all: see the
       `VMCOST=1` lane in tools/view.js for what that rebuild costs.
     The albedos are the art's own hex values, unmodified: `lit()` used to multiply them by
     `0.5 + 0.5*cellLi + mz*1.5`, and this path multiplies them by the scene light instead, whose value
     at cellLi 1 is ~0.94 - so a gun in a LIT room is the same colour it always was, and the dark-room
     floor is js/40_render.js's job (VMFLOOR), not a re-tune here.
     The flash is emissive geometry: the art drew it with 'lighter' into the display buffer, and a mesh
     has no additive blend, so it is a solid bright solid instead and the glow comes from the frame's
     own bloom plus the screen-space muzzle light in renderOverlay, both of which already exist. */
  /* #499 SPLIT THE FAMILY. The rig shipped four cold metals - `steel`/`blue`/`dark`/`black`, all
     within 20 luminance and all with b > r - so the slide's side, top and front were three neighbours
     of one hue and a 8,040-px silhouette read as one slab. Two things had to enter the palette:
     - `poly`: a WARM lower material. Every gun now has a cool upper (the slide/receiver, `steel`)
       over a warm lower (`poly`), which is the actual construction of the real objects and is the
       only term here that survives at 8,000 px: the edge between them is geometry, not shading.
     - `seam`: the parting line between those two volumes, authored as a thin part rather than as a
       shading trick, because VMFLOOR/VMRIM can only move the LEVEL of a face, never draw an edge.
     The metals themselves are untouched: js/40_render.js's light is one value per column and
     `lit()` still multiplies the authored albedo by the scene light unchanged. */
  const VW = {
    steel: [44, 49, 58], dark: [26, 31, 39], black: [15, 18, 24], blue: [36, 42, 51],
    poly: [66, 52, 40], polyD: [46, 36, 28], seam: [9, 11, 16],
    wood: [58, 44, 30], wood2: [51, 38, 26],
    /* #562 THE FISTS STOP WEARING THE CRATE'S PAINT. The hands were `skin [140,106,79]` and a crate's
       body enters the shading at 175/125/73 (the #371 WOOD note above PROPGEO): one hue family, the hands
       a little lighter and grayer, so in a lit room the two tan rectangles in the frame were the crate and
       the hand mass and the shootable one was the one you cannot take cover behind. The albedo is now a
       WORN, DARK, NEUTRAL leather: the delivered spread r-b goes from 61 to 22 and the mean comes down by
       about a fifth, which is the separation the issue asks for ("darker and cooler") while keeping the
       faint warmth that says it is a body rather than a fourth metal on the rig. #499's warmth clause is
       now carried by the form ramp below, not by the albedo: a fist that has a lit side and a shaded side
       needs a bright pixel to be warm in, and it no longer needs to be the colour of scenery to be seen. */
    skin: [104, 88, 82], skinD: [70, 60, 58], glove: [59, 66, 78], gloveD: [34, 40, 52],
    sleeve: [29, 34, 43], sleeveD: [19, 23, 30],
    brass: [216, 176, 74], shell: [184, 65, 44], hot: [255, 244, 210], ember: [255, 190, 96],
  };

  /* The FOREARM, and it is emitted BEFORE the gun parts, which is the art's own draw order: "a
     forearm, drawn BEHIND the gun so the hand can wrap the grip over it" (the deleted `arm()`).
     Sequence still matters even though the view model now has a depth test of its own: the sleeve is
     the biggest triangle in the draw and crosses the receiver in screen space, and a rig that has to
     win that contest on depth alone is a rig whose parts are ordered by luck. The elbow stays IN
     FRONT of the near plane (js/13_mesh.js NEAR = 0.12) and far below the eye: an elbow behind the
     near plane is clipped away and the arm vanishes out of the frame, which is what the first cut
     did, and an elbow only 0.15 m below the eye bulges across the picture instead of leaving it. */
  /* #562 TAKE TWO: the LIMB, and it now carries the wrist as well as the forearm.
     Two authored facts changed here, and both are the issue's remaining clause ("no rectangular
     silhouette spanning the corner").
     (a) The fist used to end in a 32 x 28 x 40 mm BOX (the cuff, `gloveD`). It was the last flat cap in
         the silhouette: a face straight at the lens at one depth, ~200 px of it in the corner of every
         frame, which is the reading the issue is about. The cuff box is gone; what comes out of the bottom
         edge of the picture is a wrist tube that meets a forearm tube, so the outline runs fist -> wrist
         -> forearm with no rectangle in it.
     (b) The arm takes the SAME ADS ramp the hands take (`vHandScale`). #499 authored that ramp for the
         fists and left the sleeve rigid, which was invisible while the sleeve was a thin tube behind the
         gun and is not invisible once the wrist is drawn on it: a hand that shrinks toward the grip while
         its own wrist stays put is a hand with a gap where the wrist should be.
     It is emitted BEFORE the gun parts (the art's own draw order: "a forearm, drawn BEHIND the gun so the
     hand can wrap the grip over it") and it is NOT inside the hand's structure region, which keeps
     `setHands(false)`'s A/B measuring the fists rather than a different arithmetic (#562's note at
     `wBuild`): the cuff and sleeve are cloth, painted cold, and the fists keep the ramp.
     The elbow stays IN FRONT of the near plane (NEAR = 0.12) and far below the eye: an elbow behind the
     near plane is clipped away and the arm vanishes out of the frame, which is what the first cut did, and
     an elbow only 0.15 m below the eye bulges across the picture instead of leaving it. */
  function vArm(b, x, y, z, s, back, st) {
    const w = back ? -1 : 1;
    s *= vHandScale(st);
    b.tube(x - w * 0.006 * s, y - 0.038 * s, z + 0.004 * s, x + w * 0.010 * s, y - 0.072 * s, z - 0.020 * s,
      0.0128 * s, 0.0150 * s, VW.gloveD);              // the wrist, out of the fist and down
    b.tube(x + w * 0.010 * s, y - 0.072 * s, z - 0.020 * s, x + w * 0.062 * s, y - 0.330 * s, z - 0.095 * s,
      0.0150 * s, 0.0265 * s, VW.sleeve);              // to an elbow below the frame
    return b;
  }

  /* A hand wrapped round a part, emitted AFTER the gun for the same reason the art drew its hands
     last: the fingers have to read as IN FRONT of the grip they hold. Palm, the fingers curled over
     the far side as one block with two creases, thumb, cuff. The art drew four separate fingers and a
     knuckle ridge; at this size a mesh reads as a fist with creases in it, and separate finger tubes
     poked out of the palm silhouette on both sides and looked like floating tabs (measured in the
     first frames of this conversion). `s` sizes the WHOLE hand - offsets as well as extents, because
     a hand whose palm shrank but whose fingers stayed put is a hand with its fingers on the table. */
  /* #499 WHERE THE FIST IS, AND WHAT IT IS PAINTED WITH. Two measurements are load-bearing here.
     (a) VERTICALITY. The rasteriser maps a point to `horizon + BH * drop / depth`, so the frame's
         lower edge at the gun's own 0.25 m of reach is 0.125 m BELOW THE EYE - not 0.171 m, which is
         where the fist sat: the grip top is VMSIT.d = 0.115 m down and the fist was authored a further
         0.056 m below that. The fist was not clipped, not culled and not occluded - it was AUTHORIED
         OFF THE BOTTOM EDGE OF THE PICTURE, which is why RING TRANSPORT's lower-right quadrant measured
         0 warm pixels of 130,080 while the rig painted 8,040. The hands now sit at 0.030-0.044 m below
         the grip top, which puts the mass of the fist at rows 0.85-1.00 of the frame and the wrist
         still heading out through the bottom edge, which is what an arm at hip does.
     (b) WARMTH. The palm was `glove` - a cold grey - and only the fingers were skin, so a fist that
         DID reach a frame would have added grey, not warmth. The palm, the back of the hand and the
         curled fingers are now `skin`/`skinD` (140/106/79, spread 61) and only the cuff stays cold.
     The knuckle ridge is one box, not four fingers: separate finger tubes poked out of the palm
     silhouette on both sides and read as floating tabs (measured in the first cut of this conversion).
     `s` sizes the WHOLE hand - offsets as well as extents. */
  /* Probe-only arm (#499): `MESH.setHands(false)` emits the GUN only, with no hand geometry at all. The
     shape is the `setWRaw` one - inert in play, armed by the probe that needs it - and the row that needs
     it is `view.js`'s sway-travel row, which must average the painted lateral travel over the weapon's own
     parts. The fists are now the largest mass inside that row's near-pivot window, so a row that averages
     over every painted pixel measures MASK COMPOSITION rather than the projection; the arm lets the same
     frame be measured twice, with and without the hands, instead of widening the row's band. */
  /* #499 THE HANDS' SCALE WHEN THE GUN IS ON THE SIGHT LINE. Hip to ADS is one rigid transform, but the
     fists' PAINTED pixels do not grow as the gun's do: at hip the lower hand is still clipped by the
     bottom edge of the picture and at ADS the whole rig sits inside the frame, so the hands' share of the
     rig's own pixels went from 23.0% at hip to 31.7% at ADS on the pistol (11.9 -> 21.3 shotgun, 10.2 ->
     17.0 rifle) - in the pose a player aims with, the largest mass on screen was a flat-shaded hand rather
     than the thing being aimed at. `VMADS` is the authored fix, and it is a SIZE, not a seat: the hands
     close on the eye by the perspective alone, so they are authored to come in proportionally with the
     gun's own ADS scale rather than sitting rigid while the gun grows past them. `s` scales the hand's
     OFFSETS as well as its extents (see above), so the hand shrinks TOWARD the part it is wrapped round -
     it stays on the grip it holds, it does not detach and shrink in place.
     THE RAMP IS EXACTLY 1.0 AT ads = 0, which is what makes this an ADS-only change: every hip frame this
     repo owns - every recorded reference in flatparity, exposure and bands - builds the same bytes it
     built before, and those three probes re-run green with no reference touched. Because the geometry now
     READS `ads`, `ads` is in the pose key too (WQK/wState/wKey): #186's rule is that a key must contain
     every term the geometry reads, and a rig that shrank the hands without keying the shrink would serve a
     hip geometry to an ADS frame depending on which of the two was built first. */
  const VMADS = 0.62;                               // hand size at FULL ADS, relative to its hip size
  const vHandScale = st => 1 - (1 - VMADS) * clamp(st && st.ads ? st.ads : 0, 0, 1);
  function vHand(b, x, y, z, s, back, st) {
    if (!VHANDS) return b;
    s *= vHandScale(st);
    const w = back ? -1 : 1;
    /* #562: the hand IS the region, in the same sense a torso is (#232) and a crate's staves are (#533).
       The coord is the authored x+z in METRES and VS_CYC decides how fast it ramps; see that note. It is set
       for the HAND ONLY, and #587 made that load-bearing twice over: the gun's metal is emitted under `wg`
       with its own law, so a region register left set past the fist would put the hand's metre-wide ramp on
       every part that follows it in emit order (the same trap #232 names for a torso followed by a leg) AND
       answer the slide with the wrong cycle count. The wrist tube is inside the register on purpose: a sleeve
       that ramps with the fist is what makes the two read as one limb. `hs` brackets the region for the draw
       site, which cannot tell a fist from a slide out of `MDL` alone. */
    b.rg = 1; b.hs.push(b.p.length / 6);
    // The fist is a TAPERED TUBE along the hand's own long axis, not a slab: six flat boxes stacked on
    // each other have one silhouette and it is a rectangle, which is the reading the issue is about. A
    // cone reads as a wrapped mass, its silhouette is a trapezoid with rounded sides, and its far end is
    // narrower than its near end, which is what a hand curled round a grip looks like from behind.
    b.tube(x - w * 0.002 * s, y - 0.026 * s, z, x + w * 0.001 * s, y + 0.022 * s, z - 0.004 * s,
      0.0145 * s, 0.0185 * s, VW.skin);              // the fist itself, knuckle end widest
    b.box(x + w * 0.004 * s, y + 0.028 * s, z - 0.024 * s, 0.015 * s, 0.005 * s, 0.017 * s, VW.skinD);
    /* #562 TAKE TWO: the BACK OF THE HAND is a tube, not a plate. The plate was 13 mm thick and 48 mm
       square - a flat, right-angled face straight at the lens, ~200 px of it in the corner of every
       frame, and a flat face at one depth is exactly the reading the issue is about: at the same light it
       is indistinguishable from the side of a crate. A tapered tube across the same span keeps the hand's
       mass, keeps the two crease boxes reading as knuckle gaps, and puts a rounded terminator on the
       outline where the plate had two 90-degree corners. Its own area is SMALLER than the plate's (25 x 56
       mm of silhouette against 48 x 48) because #562's acceptance says frame cost must not rise: the rig is
       already inside the raster budget, so a silhouette change has to be bought with pixels, not added to
       them. */
    b.tube(x - w * 0.017 * s, y - 0.018 * s, z - 0.001 * s, x - w * 0.017 * s, y + 0.015 * s, z - 0.004 * s,
      0.0105 * s, 0.0125 * s, VW.skin);              // the back of the hand, wrist end narrowest
    b.box(x - w * 0.025 * s, y - 0.013 * s, z, 0.0035 * s, 0.0035 * s, 0.022 * s, VW.skinD);
    b.box(x - w * 0.025 * s, y + 0.009 * s, z, 0.0035 * s, 0.0035 * s, 0.022 * s, VW.skinD);
    b.tube(x + w * 0.011 * s, y + 0.020 * s, z + 0.010 * s, x - w * 0.006 * s, y + 0.030 * s, z + 0.020 * s,
      0.0070 * s, 0.0055 * s, VW.skin);              // the thumb, along the top of the grip
    b.hs.push(b.p.length / 6);
    b.rg = 0;
    return b;
  }

  /* Where each bore ENDS, in the same metres as the geometry. The rig needs this number to put the
     muzzle on the firing ray and the flash geometry needs it to grow out of the barrel, so it lives
     beside the geometry and both read it - the assert at the bottom of this file catches a drift. */
  const VMUZZLE = { pistol: 0.196, shotgun: 0.404, rifle: 0.452 };

  /* The muzzle flash, emitted AT the bore's end: a cone along +z plus a core. Emissive, so the room
     cannot dim it, and sized by S.muzzle - the art drew a `lighter` cone 150 units long and a 58-unit
     kernel. Grows ALONG the bore, never across it, because the flash used to be emitted along +x, 90
     deg off the bore, and tools/view.js has a row that would not survive that regressing. It is part
     of the gun's own vertex set rather than a second draw so the view model stays the 1 pose/frame
     the mesh budget is written against, and because a part that makes its own light is already
     expressible per-vertex (`em`) without needing a second alpha register. */
  function vFlash(b, mz, z) {
    const k = Math.max(0.05, mz || 0);
    b.em = 1;
    b.tube(0, 0, z + 0.004, 0, 0, z + 0.020 + 0.135 * k, 0.016 * k + 0.006, 0.004, VW.hot);
    b.bip(0, 0, z + 0.012 + 0.030 * k, 0.030 * k + 0.008, 0.030 * k + 0.008, 0.046 * k + 0.012, VW.ember);
    b.bip(0, 0, z + 0.014 + 0.026 * k, 0.016 * k + 0.005, 0.016 * k + 0.005, 0.026 * k + 0.008, VW.hot);
    b.em = 0;
    return b;
  }

  const VMGEO = {
    /* M9 SIDEARM. The art drew the slide as an 80x80-unit square with the barrel stub on top of it;
       here the slide is 0.175 m of rectangular tube and the grip rakes back on its own axis. */
    pistol(b, s) {
      const MU = VMUZZLE.pistol;
      vArm(b, 0.016, -0.026, 0.024, 1.0, false, s);
      vArm(b, -0.026, -0.040, 0.048, 0.96, true, s);
      b.wg = 1;                                        // #587 the metal gets the surface; the sleeve above and the fists below do not
      b.box(0, 0.007, 0.088, 0.0185, 0.0135, 0.086, VW.steel);          // the slide
      b.box(0, 0.0235, 0.088, 0.008, 0.0035, 0.070, VW.black);          // the serrated rib on top
      b.tube(0, 0.004, MU - 0.024, 0, 0.004, MU, 0.0115, 0.0105, VW.dark); // the barrel crown
      b.box(0, 0.004, MU, 0.0125, 0.0125, 0.004, VW.black);             // the muzzle face
      b.box(0, -0.0075, 0.086, 0.0175, 0.0022, 0.082, VW.seam);         // the slide/frame parting line
      b.box(0, -0.017, 0.062, 0.0165, 0.0105, 0.060, VW.poly);          // the frame under the slide
      b.tube(0, -0.022, 0.038, 0, -0.118, -0.012, 0.0205, 0.018, VW.poly);  // the grip, raked back
      b.box(0, -0.132, -0.015, 0.018, 0.006, 0.016, VW.black);          // the magazine base plate
      b.tube(0, -0.030, 0.010, 0, -0.058, -0.014, 0.0055, 0.005, VW.dark);  // trigger guard, front leg
      b.tube(0, -0.058, -0.014, 0, -0.030, -0.028, 0.005, 0.005, VW.dark);  // and its rear leg
      b.box(-0.0135, 0.026, 0.014, 0.0042, 0.0075, 0.0055, VW.black);   // rear sight, left ear
      b.box(0.0135, 0.026, 0.014, 0.0042, 0.0075, 0.0055, VW.black);    // and right ear
      b.box(0, 0.026, 0.178, 0.0035, 0.0085, 0.0045, VW.black);         // the front post
      b.box(0, -0.006, -0.004, 0.008, 0.011, 0.010, VW.steel);          // the hammer
      if (s.slideBack) b.box(0, 0.014, 0.088 - s.slideBack * 0.026, 0.019, 0.008, 0.050, VW.dark);
      b.wg = 0;
      vHand(b, 0.016, -0.026, 0.024, 1.0, false, s);
      vHand(b, -0.026, -0.040, 0.048, 0.96, true, s);
      if (s.mz > 0.004) vFlash(b, s.mz, MU);
      return b;
    },
    /* M870 BREACHER. The art's two parallel tubes (bore above, mag tube below) are the silhouette;
       the pump travels on the lower one, which is what `pump` does to the geometry below. */
    shotgun(b, s) {
      const MU = VMUZZLE.shotgun, pu = (s.pump || 0) * 0.034;
      vArm(b, 0.014, -0.034, 0.000, 1.02, false, s);
      vArm(b, -0.010, -0.040, 0.266 + pu, 1.0, true, s);   // the pump hand's arm travels with the pump
      b.wg = 1;                                        // #587 the metal gets the surface; the sleeve above and the fists below do not
      b.box(0, 0.004, 0.086, 0.0215, 0.0185, 0.082, VW.steel);          // the receiver
      b.box(0, 0.0235, 0.086, 0.011, 0.0045, 0.070, VW.black);          // the top rib
      b.box(0, -0.0155, 0.086, 0.0205, 0.0022, 0.078, VW.seam);         // receiver / fore-end parting line
      b.tube(0, 0.004, 0.164, 0, 0.004, MU, 0.0135, 0.012, VW.dark);     // the barrel
      b.tube(0, -0.024, 0.150, 0, -0.024, MU - 0.032, 0.0135, 0.0125, VW.poly); // the magazine tube
      b.box(0, 0.004, MU, 0.0155, 0.0155, 0.005, VW.black);             // the muzzle ring
      b.tube(0, -0.024, 0.238 + pu, 0, -0.024, 0.300 + pu, 0.0225, 0.0215, VW.wood);  // the pump, travels
      b.tube(0, -0.030, -0.004, 0, -0.086, -0.190, 0.0245, 0.0285, VW.wood2); // the stock
      b.box(0, -0.104, -0.186, 0.023, 0.011, 0.014, VW.black);          // the recoil pad
      b.tube(0, -0.020, 0.016, 0, -0.118, -0.026, 0.0205, 0.018, VW.wood2);  // the pistol grip
      b.box(0.0205, 0.008, 0.050, 0.004, 0.010, 0.020, VW.black);       // the ejection port
      if (s.shellIn) {
        b.tube(0.040, -0.092, 0.052, 0.056, -0.084, 0.058, 0.0105, 0.010, VW.shell);
        b.tube(0.056, -0.084, 0.058, 0.062, -0.081, 0.060, 0.0105, 0.010, VW.brass);
      }
      b.wg = 0;
      vHand(b, 0.014, -0.034, 0.000, 1.02, false, s);
      vHand(b, -0.010, -0.040, 0.266 + pu, 1.0, true, s);
      if (s.mz > 0.004) vFlash(b, s.mz, MU);
      return b;
    },
    /* VK-36 AUTOGUN. Longest reach of the three, which is the art's own ranking (muzzle at -436
       design units against the shotgun's -404 and the pistol's -338). */
    rifle(b, s) {
      const MU = VMUZZLE.rifle;
      vArm(b, 0.014, -0.030, 0.012, 1.0, false, s);
      vArm(b, -0.014, -0.038, 0.234, 0.98, true, s);
      b.wg = 1;                                        // #587 the metal gets the surface; the sleeve above and the fists below do not
      b.box(0, 0.005, 0.092, 0.0235, 0.0195, 0.086, VW.steel);          // the upper receiver
      b.box(0, 0.0265, 0.092, 0.0155, 0.0055, 0.078, VW.black);         // the dust cover
      b.box(0, 0.005, 0.150, 0.0225, 0.0022, 0.030, VW.seam);           // the upper / handguard parting line
      b.box(0, -0.004, 0.238, 0.0245, 0.020, 0.056, VW.poly);            // the handguard
      b.tube(0, 0.004, 0.292, 0, 0.004, MU - 0.034, 0.0125, 0.0115, VW.dark); // the barrel
      b.tube(0, 0.004, MU - 0.034, 0, 0.004, MU, 0.016, 0.0145, VW.black);    // the flash hider
      b.box(0, 0.0215, MU - 0.054, 0.0075, 0.0125, 0.0085, VW.dark);    // the gas block
      b.box(0, 0.0365, MU - 0.054, 0.004, 0.0085, 0.005, VW.black);     // the front post
      b.box(-0.014, 0.0335, 0.030, 0.0045, 0.0085, 0.006, VW.black);    // rear sight, left ear
      b.box(0.014, 0.0335, 0.030, 0.0045, 0.0085, 0.006, VW.black);     // rear sight, right ear
      b.box(0, -0.006, 0.116, 0.0175, 0.0125, 0.031, VW.dark);          // the magwell
      if (s.magOut > 0.02) {
        b.box(0, -0.088 + s.magOut * 0.10, 0.118 + s.magOut * 0.02, 0.0165, 0.052, 0.028, VW.blue);
      } else {
        b.box(0, -0.086, 0.118, 0.0165, 0.052, 0.028, VW.blue);         // the magazine
        b.box(0, -0.142, 0.118, 0.0175, 0.006, 0.029, VW.black);        // its floorplate
      }
      b.box(0, 0.020, -0.004 - (s.slideBack || 0) * 0.022, 0.0125, 0.0075, 0.017, VW.dark); // charging handle
      b.tube(0, -0.028, -0.006, 0, -0.112, 0.014, 0.021, 0.0185, VW.poly);    // the grip
      b.tube(0, -0.030, -0.014, 0, -0.062, -0.190, 0.0225, 0.0265, VW.poly);  // the stock
      b.box(0, -0.076, -0.196, 0.021, 0.016, 0.010, VW.black);          // the butt pad
      b.wg = 0;
      vHand(b, 0.014, -0.030, 0.012, 1.0, false, s);
      vHand(b, -0.014, -0.038, 0.234, 0.98, true, s);
      if (s.slideBack) b.box(-0.030 - s.slideBack * 0.020, 0.012, 0.020, 0.005, 0.006, 0.010, VW.brass);
      if (s.mz > 0.004) vFlash(b, s.mz, MU);
      return b;
    },
  };

  /* Build one weapon's vertex set. No MODELS entry and no pose table on purpose: the parts above
     move continuously (ejector travel, pump travel, a shell sliding in), the view model is one mesh
     per frame, and the rebuild is ~0.05 ms of arithmetic against a rasterizer that costs more than
     that for a body at 3 m. The flash is emitted into the SAME builder with `b.em = 1` rather than
     into a second one, so the view model is one draw and its emissive parts carry the light exemption
     per vertex (EM) instead of needing a second set of shading registers. */
  /* ---- #186: the weapon's geometry, cached on QUANTIZED travel -------------------------------
     The issue's own reason for skipping a cache is correct as stated: ejector, pump and magazine travel
     continuously (`mz, magOut, slideBack, pump, shellIn` are 0..1 envelopes - js/40_render.js:1824-1836), so
     a key over the travel itself misses every frame and a miss costs the build it was meant to skip. That is
     the documented cliff - cull before the fetch, and cost the work the cache avoids - and the way off it is
     the one the body poses already use (PB buckets, js/13_mesh.js:749): key on the travel QUANTIZED, and make
     the quantum small enough that the part cannot be seen to jump.
     WQK sizes each term by itself: the row measured 4.17 mm at 1/16 for magOut (0.10 m of travel, the largest
     in the rig, magOut at :559) against a 4 mm floor while every other part sat under it, so the magazine
     alone went to 1/32 and the rest stayed at 1/16 - the bound sets the quantum, and the row measures it rather
     than arithmetic, because these terms move a box's DIMENSIONS
     exact and quantized geometry across each envelope and reports the largest vertex displacement it finds.
     `wq(0) === 0` exactly, so an at-rest rig - every hashed frame this repo owns - builds the same numbers it
     did before this cache existed, and parity is a fact of the key rather than a hope. */
  /* `ads` is a term of the pose the geometry reads (#499: it sets the hands' size), so it is in the key
     with the rest. Its quantum is the hand's own: at 1/8 of the ADS ramp the hand moves by half a quantum
     of a size term, under a millimetre of a 0.06 m hand, and the `quantum price` row measures it rather
     than taking that on faith. */
  const WQK = { mz: 16, magOut: 32, slideBack: 16, pump: 16, shellIn: 16, ads: 8 };   // steps in each term's own travel
  const WPCAP = 64;                                   // entries; eviction is the rig cache's, evict before build
  const WEPO = new Map(); let wBytes = 0; const wStat = [0, 0];   // [misses, hits]
  /* Probe-only teeth arm (#186): when set, every fetch builds and counts a MISS, which is what a key over the
     raw travel does. view.js's viewmodel block arms it for one row so the failure the issue named - "the key
     would be wrong" - is driven through the SHIPPED reload timeline instead of being simulated beside it. The
     shape is the COV/GLOWREC one: inert in play, armed by the probe that needs it. */
  let WRAW = false;
  let VHANDS = true;                                // probe-only (#499): false emits the gun without its hands
  const wq = (n, x) => x > 0 ? Math.round(x * n) / n : 0;   // 0 stays exactly 0, not 1/WQK
  /* The state a key's geometry is BUILT at, so one key maps to exactly one geometry. Building from the
     frame that happened to land in the bucket first makes presence a matter of luck: parts are authored as
     `if (s.slideBack)` / `if (s.shellIn)` / `if (s.mz > 0.004)`, so a frame in the last breath of a reload
     (slideBack still > 0, still under half a quantum) would build the REST key with a brass casing in it,
     and every frame at rest after it would be served that casing. The quantum is already what decides the
     key, so it decides the geometry too - which is also what makes the quantum-price row a statement about
     the shipped path rather than about scheduling. `wq(0) === 0`, so an at-rest build is unchanged. */
  function wState(s) {
    s = s || {};
    return { mz: wq(WQK.mz, s.mz || 0), magOut: wq(WQK.magOut, s.magOut || 0), slideBack: wq(WQK.slideBack, s.slideBack || 0),
      pump: wq(WQK.pump, s.pump || 0), shellIn: wq(WQK.shellIn, s.shellIn || 0), ads: wq(WQK.ads, s.ads || 0) };
  }
  function wKey(k, s) {
    return k + '|' + wq(WQK.mz, s.mz) + '|' + wq(WQK.magOut, s.magOut) + '|' + wq(WQK.slideBack, s.slideBack) +
      '|' + wq(WQK.pump, s.pump) + '|' + wq(WQK.shellIn, s.shellIn) + '|' + wq(WQK.ads, s.ads || 0);
  }
  function wBuild(kind, st) {
    const b = VMGEO[kind](new Builder(), st || {});
    const p = new Float32Array(b.p), v = new Float32Array(b.p.length / 2);
    for (let i = 0; i < b.p.length / 6; i++) { v[i * 3] = b.p[i * 6]; v[i * 3 + 1] = b.p[i * 6 + 1]; v[i * 3 + 2] = b.p[i * 6 + 2]; }
    /* #587: the coord array goes in beside `em` with the SAME shape the bodies and props already hand
       `tri`. A plain JS array here would give the site `ST[i0]` a third map (null, Float32Array, Array)
       where it currently handles two, and this geometry is rebuilt on every reload miss.
       #562 took that array onto the rig for the HANDS, which is what made `ST = m.st || null` non-null for
       every rig (it was null before, so the hands were flat-shaded by construction rather than by choice),
       and it is why `geo.st` is a per-vertex Float32Array exactly like `model()`'s (js/13_mesh.js mdl.st).
         A rig now carries TWO structure laws in one geometry - the gun's metal under WS_* (#587) and the
       fists under VS_* (#562) - so it also carries which one each vertex was authored under: `vHand` notes
       the vertex span of every hand region in `b.hs` (the same span in which it sets the region register
       `rg`) and it becomes one byte per vertex HERE rather than in the builder, so a body or a prop builds
       exactly what it built before. `tri` never reads it; the draw site does, once per triangle, to choose
       which class's constants that triangle's law uses - see the note at VS_CYC. Both arrays are counted in
       byteLength because the rig cache's eviction is byteLength-sized. */
    const hd = b.hs.length ? new Uint8Array(b.p.length / 6) : null;
    if (hd) for (let i = 0; i < b.hs.length; i += 2) hd.fill(1, b.hs[i], b.hs[i + 1]);
    const geo = { kind, p, v, t: new Uint16Array(b.t), em: Uint8Array.from(b.e), st: Float32Array.from(b.s), hd, nV: b.p.length / 6, tris: b.t.length / 3 };
    geo.byteLength = p.byteLength + v.byteLength + geo.t.byteLength + geo.em.byteLength + geo.st.byteLength + (hd ? hd.byteLength : 0);
    return geo;
  }
  function weaponGeo(kind, st) {
    if (!VMGEO[kind]) throw new Error('MESH: no view model authored for weapon "' + kind + '"');
    if (WRAW) { wStat[0]++; return wBuild(kind, st); }        // probe arm: never serves, never stores
    const qk = wKey(kind, st || {});
    const hit = WEPO.get(qk);
    if (hit !== undefined) { WEPO.delete(qk); WEPO.set(qk, hit); wStat[1]++; return hit; }
    if (WEPO.size >= WPCAP) { const k0 = WEPO.keys().next().value; const g0 = WEPO.get(k0); WEPO.delete(k0); wBytes -= g0.byteLength; }
    wStat[0]++;
    const geo = wBuild(kind, wState(st));
    WEPO.set(qk, geo); wBytes += geo.byteLength;
    return geo;
  }

  /* boot-time drift detector for the view models, same shape as SPEC/SRC higher up: VMUZZLE is the
     number js/40_render.js puts the muzzle on the firing ray with, so a barrel built to a different
     length would move the DRAWN muzzle off the ray while every hitscan number stayed right. */
  for (const k in VMUZZLE) {
    let mx = -1e9;
    const bb = VMGEO[k](new Builder(), { mz: 0 });
    for (let i = 0; i < bb.p.length; i += 6) if (bb.p[i + 2] > mx) mx = bb.p[i + 2];
    if (Math.abs(mx - VMUZZLE[k]) > 0.008)      // 0.008 = the thickness of a muzzle plate
      console.warn('MESH view model ' + k + ' geometry ends at z ' + mx.toFixed(3) + ' but VMUZZLE says ' + VMUZZLE[k]);
  }

  /* ---- one body from one pose -------------------------------------------------
     One skeleton for every kind - hound and brute have always been proportional variations of the
     grunt here, so a single gait function drives all three and SPEC supplies the lengths. The
     VERTEX ORDER this function produces is what lets a cached pose share the rest model's colour
     and index arrays: every call runs the same emits in the same order, only the numbers differ. */
  function emit(kind, q) {
    const s = SPEC[kind], sk = SKIN[kind], dk = DARK[kind], cl = CLOTH[kind];
    const b = new Builder(), hipY = s.hip + q.bob, shY = s.sh + q.bob;
    const seg = segLimbs();                            // #78: limb sides at the tier the page is on
    const shTop = shY + s.headR * SHOULDER_LIFT;      // the torso box's top face, #80 - see above
    b.tip(q.topple, 0.02, 0);                        // a corpse turns about its CONTACT LINE, at the feet
    for (let i = 0; i < 2; i++) {
      const L = q.leg[i], hx = (i ? 1 : -1) * s.hipLat;
      b.ns = seg;                                      // #78: thighs and shins are the widest tubes on the body
      // leg: hip -> knee -> foot, swung by the gait (these were straight: "animation plugs in here")
      b.tube(hx, hipY, 0, L.kx, L.ky, L.kz, s.limb, s.limb * 0.86, cl);
      b.tube(L.kx, L.ky, L.kz, L.fx, L.fy, L.fz, s.limb * 0.86, s.limb * 0.7, cl);
      b.ns = 0;
      b.box(L.fx, Math.max(0.03, L.fy + 0.01), L.fz + 0.04, s.limb * 1.1, 0.03, s.limb * 1.8, dk);
    }
    b.tip(q.pitch, hipY, 0);                         // the wind-up tips everything above the hip
    b.rg = 1;                                        // #232: the torso is the region that gets structure
    b.box(0, (hipY + shTop) * 0.5, 0, s.shLat * 1.05, (shTop - hipY) * 0.5, s.torso * 0.42, sk);
    b.rg = 0;
    b.box(0, hipY + 0.02, 0, s.hipLat * 1.3, 0.045, s.torso * 0.34, dk);
    /* The neck. The torso box's top face now sits SHOULDER_LIFT*headR above the shoulder line and the
       head box starts above it, so the band this tube has to fill is shorter than the gap between the
       two authored heights. It still spans that band plus JOIN into each end, so the junction is solid
       at any yaw - a prism silhouette is convex and the body axis is inside the prism, so that column
       is covered by construction (#74 - 9 rows of daylight on a grunt at 2.4 m before that was true).
       The radius is wider than the one that shipped (0.62/0.54 headR against 0.52/0.46) for the same
       reason: a column 22% of the torso's width reads as a gap between two parts, and one 36-41% of it
       reads as the part's own base. Emitted between the two boxes it stitches, and the emit ORDER is
       the pose table's vertex order, so it stays here rather than moving with the head. */
    b.tube(0, shTop - JOIN, 0, 0, s.head + q.bob - s.headR * 0.35 + JOIN, 0, neckR(s), neckR(s) * (NECK_R1 / NECK_R0), dk);
    b.box(0, s.head + q.bob + s.headR * 0.6, 0, s.headR * HEAD_HW, s.headR * 0.95, s.headR * 0.80, dk);
    b.box(0, s.head + q.bob + s.headR * 0.7, s.headR * 0.72, s.headR * 0.62, s.headR * 0.30, s.headR * 0.22, [255, 208, 138]);
    for (let i = 0; i < 2; i++) {
      const A = q.arm[i], ax = (i ? 1 : -1) * s.shLat;
      b.ns = seg;                                      // #78: the limbs are where 6 sides show
      b.tube(ax, shY, 0, A.ex, A.ey, A.ez, s.arm, s.arm * 0.86, sk);
      b.tube(A.ex, A.ey, A.ez, A.hx, A.hy, A.hz, s.arm * 0.86, s.arm * 0.7, sk);
      b.ns = 0;
    }
    /* #78: a held object. An enemy that goes through the whole attack bucket with nothing in its hands
       reads as a mannequin, and the wind-up had no object to move. The weapon is placed AT the right
       hand and laid FORWARD, so it inherits the gait, the wind-up, the topple and the death pose from
       `joints()` for free - the hand is where the animation puts it, and a gun that ignored those
       numbers would float beside the body instead of being aimed by it. Its muzzle pitch comes from the
       arm's own ELEVATION (hand above elbow ⇒ muzzle up), not from the forearm direction, which at rest
       points at the floor: the ready slope is -0.10 (about 6° down) and it swings with the arm. Four
       parts on 4-sided tubes: a gun is a slab, not a limb, and extra sides would be spent on the wrong
       silhouette. The hound authors no `gun` row and must come out carrying nothing - that absence is
       the control the rig row reads. */
    if (s.gun) {
      const A = q.arm[0], gl = s.gun.len, cal = s.gun.cal;
      /* PORT ARMS, not aim-down-sight. The first cut laid the barrel along the body's +z, and the
         composited frame at cam0 showed why that is wrong: the enemy was facing the camera, the rifle
         pointed at it, and a 1.6 cm calibre projected to a two-pixel dot - a body that carries something
         which cannot be seen carries nothing. A held object has to have screen-space extent at EVERY yaw,
         so the weapon is canted across the body: 0.78 across, 0.55 forward, lightly down. Held in the
         right hand at x = -shLat*1.1, that reaches past the far edge of the torso (grunt 0.26 of reach
         against 0.10 half-width) so the silhouette gains an edge on BOTH sides, in plan view as well as
         in profile. The arm's elevation still rides on it, but as a small term: the hand is where the
         animation puts it, and the muzzle pitch must not swallow the cant. */
      const el = Math.max(-1, Math.min(1, (A.hy - A.ey) / s.fore));
      let gy = -0.06 + 0.22 * (el + 1), gx = 0.78, gz = 0.55;
      /* A corpse must not be able to hold its own top edge up. `anim`'s topple rows found this at once:
         silhouette top moved 8 px of a 272 px body where main moves it 88..91, and the row wants 15% of
         the body's rise - so the corpse stopped reading as collapsed even though 89% of its pixels moved.
         The cause is that a held rigid object EXTENDS the silhouette envelope, and a death row that
         raises the shoulder (`aa 1.15` in variant 1) puts the hand high. Two things to get right here,
         both learned by getting them wrong: body space is **y-UP** (the prop barrels step 0 -> 0.5 in the
         second coordinate; SPEC hip 0.50 < sh 0.815), so "down the body" is -y, and a version of this
         that used +y stood the rifle on end at that raised hand and pinned the top exactly as badly as
         the port cant did. And the guard reads `q.dying`, NOT `q.topple`: a variant can die by yaw and
         sink with `tp = 0`, and a guard on the topple angle silently skips exactly those rows.
         Laid down the body it still hangs from the hand and turns with `tip(topple)`, but no longer
         reaches above the envelope the body draws by itself. */
      if (q.dying) { gx = 0; gy = -1; gz = 0.15; }
      const gL = Math.hypot(gx, gy, gz) || 1e-6; gx /= gL; gy /= gL; gz /= gL;
      const hx = A.hx, hy = A.hy, hz = A.hz;
      b.ns = 4;
      b.tube(hx - gx * gl * 0.30, hy - gy * gl * 0.30, hz - gz * gl * 0.30, hx, hy, hz, cal * 1.15, cal * 0.95, dk);
      b.tube(hx, hy, hz, hx + gx * gl * 0.62, hy + gy * gl * 0.62, hz + gz * gl * 0.62, cal, cal * 0.92, GUNM);
      b.tube(hx + gx * gl * 0.62, hy + gy * gl * 0.62, hz + gz * gl * 0.62,
        hx + gx * gl, hy + gy * gl, hz + gz * gl, cal * 0.60, cal * 0.48, GUNM2);   // barrel: the longest edge
      b.box(hx + gx * gl * 0.30, hy + gy * gl * 0.30 - s.gun.mag * 0.55, hz + gz * gl * 0.30,
        cal * 0.8, s.gun.mag * 0.5, cal * 0.8, dk);    // magazine, hung under the receiver
      b.ns = 0;
    }
    return b;
  }

  /* ---- the gait itself ------------------------------------------------------
     Magnitudes are the billboard's (rigBiped in js/11_rig.js), so a body reads like the sprite it
     replaced. Two things are deliberate:
     - at mv = atk = die = 0 the chains collapse onto the straight stance #72 shipped, so the idle
       picture - and every contrast number measured against it - is unchanged;
     - `lean` is NOT an input. The rig passed it to the raster but left it out of its own cache key
       (js/11_rig.js:213), so a cached pose answered with whichever lean it happened to be authored
       with. The mesh authors pitch from atk and die instead, where the bucket means what it says. */
  function joints(kind, p, mv, atk, die, dv) {
    const s = SPEC[kind], dying = die > 0.01, dr = dying ? dieRow(kind, dv) : null;
    const q = { bob: 0, pitch: 0, topple: 0, dying: 0, leg: [], arm: [] };
    q.bob = dying ? -die * dr.sk : -mv * 0.016 * Math.abs(Math.sin(p * TAU));
    q.pitch = dying ? 0 : atk * 0.20;
    q.topple = dying ? die * dr.tp : 0;               // the rig's die pitch, now about the ground line
    q.dying = dying ? 1 : 0;                          // a part that must lie down with the body reads THIS, not `topple`
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1, a2 = p * TAU + (i ? Math.PI : 0);
      const sw = dying ? dr.sw[i] : Math.sin(a2) * (0.06 + 0.30 * mv);
      const lift = dying ? 0 : 0.05 * mv * Math.max(0, Math.sin(a2 + 0.6));
      const bend = dying ? dr.bd[i] : 0.02 + 0.6 * mv * Math.max(0, Math.sin(a2 + 1.05));
      const kx = side * s.hipLat * 0.8, ky = s.hip + q.bob - s.thigh * Math.cos(sw) + lift;
      const kz = s.thigh * Math.sin(sw) + 0.01, sa2 = sw - bend;
      q.leg.push({ kx, ky, kz, fx: kx, fy: ky - s.shin * Math.cos(sa2), fz: kz + s.shin * Math.sin(sa2) });
      const aa = dying ? dr.aa[i] : Math.sin(a2 + Math.PI) * (0.05 + 0.26 * mv) + atk * 1.15;
      const ax = side * s.shLat, ay = s.sh + q.bob;
      const ey = ay - s.upper * Math.cos(aa), ez = s.upper * Math.sin(aa) + 0.02;
      const sa3 = aa + (dying ? dr.sa[i] : 0.24 - 0.18 * atk);
      q.arm.push({ ex: ax * 1.05, ey, ez, hx: ax * 1.1, hy: ey - s.fore * Math.cos(sa3), hz: ez + s.fore * Math.sin(sa3) });
    }
    return q;
  }

  /* ---- per-kind rest model: topology, colours and the vertex count everything else keys on ---- */
  const MODELS = {};
  /* a prop's static geometry, or a body from its pose. The pose is computed ONLY for a body: joints()
     reads SPEC, and SPEC has no prop rows - a prop never has a phase bucket to begin with. */
  /* the variant's row, or the shipped pose. A prop has no SPEC row at all and never topples, so
     for it the default is not a fallback but the answer: no angle, no fall direction. */
  function dieRow(kind, dv) {
    const t = SPEC[kind] && SPEC[kind].die;
    return t ? t[((dv | 0) % DIEV + DIEV) % DIEV] : SPEC.grunt.die[0];
  }

  function geoFor(kind, p, mv, atk, die, dv) {
    if (!PROPGEO[kind]) return emit(kind, joints(kind, p, mv, atk, die, dv));
    const b = PROPGEO[kind](new Builder());
    /* propTex puts every prop sprite through Surf.lift(1.35, 6) - "sprites are albedo: they get lit
       again in the scene" (js/05_paint.js:220) - so the numbers in PROPGEO are not yet the albedo the
       billboard handed the raster. Applying the same transform is what makes a mesh prop the same COLOUR
       as the sheet it replaced: without it a crate's brightest pixels measured 62 against the sprite's
       101 at the same camera. Bodies never went through a lift, so they are untouched. */
    /* #371: the prop VALUE band, and the second half of what the prop paint owes. PROPGEO's numbers were
       the last paint in the game sitting outside the albedo band #438 gave the seventeen wall, floor and
       ceiling tiles (the `alb` knob, js/10_assets.js:46): a crate measured about +27 luma over its own
       deck away from the arrival cameras, which is the "bright card in a dim room" tell this issue opened
       with, and it was authored, not lit - the prop is louder than the room because its albedo is.
       One scalar, one shape, same exemptions as the tiles: it multiplies the PAINTED albedo and nothing
       else. Not the 1.35 lift above (that is the billboard's re-light, and it is what makes a mesh prop
       the same colour as the sheet it replaced), not a light value, and not an emissive part - a vertex
       flagged `em` is a LIGHT SOURCE (the lamp's aperture, read by the `props` LAMPCORE census), and the
       guard below is PER VERTEX for exactly that reason. Pickups are out too - they are readability, not
       set dressing, and no row here charges them for being loud.
       #371's ruling on the LAMP, which is what this table now says: a lamp's bulb may outshine the room;
       its painted post, foot and shade may not. The earlier reading of that ruling kept the whole lamp out
       of PROPBAND, which conflated the aperture with the metal - and it is the metal that was being
       charged: at ABATOIR's 2,2 seat the fixture's own prop mean measured 134 luma against a deck of 98
       (+36.2) on albedo authored at 44-62, six of the eight props over the +25 bar across the four sectors
       were lamps 2-12 m out, and two A/B renders say the number is neither the bulb nor the additive glow:
       painting the aperture the shade's grey moves the charged figure not at all, and returning from
       `drawLightGlow` moves it not at all. So the lamp joins the band and its `em` vertices do not: the
       aperture keeps the bytes the LAMPCORE census reads, and the fixture reads as dark metal standing in
       the light it casts instead of the brightest solid in its part of the frame.
       #371's SECOND ruling on the lamp, which is why the table is no longer one scalar: banding the
       fixture at the crate's 0.88 took six of the eight props over the bar across the four sectors out
       and left one lamp standing in its own pool - ARCHIVE SUBLEVEL 11.5,22.5, read 7.07 m out of seat
       4,21, at +26.5 against the deck inside its own footprint (prop 89 / deck 62). Measured at that
       seat before the change: post median 83.3, the lit top edge of its base plate 128.2, the deck at
       its own foot 54-58. The fixture is metal IN a light pool, so the band that makes a crate right in
       the middle of a room leaves it over the bar by itself; the value it needs is its own, and it is
       0.80 - the one-literal A/B at that seat puts the post at 76.8 and the plate's top edge at 117.2,
       keeps the aperture's bytes identical (the guard below is unchanged, and it is what makes that
       structural rather than a claim), and takes ARCHIVE from 2 props over to 1. The order it leaves is
       post < plate < aperture (77 < 117 < 172), so a lamp still reads as a lamp and not as a dark stick.
       Crate and barrel stay at PROP_ALB: this is not a cheaper lamp paint, it is the one prop kind whose
       own pool is the brightest floor in its room. */
    const PROP_ALB = 0.88, PROP_ALB_LAMP = 0.80;
    const PROPBAND = { crate: PROP_ALB, barrel: PROP_ALB, lamp: PROP_ALB_LAMP };
    const band = PROPBAND[kind];
    for (let i = 3, v = 0; i < b.p.length; i += 6, v++) {
      const k = band && !b.e[v] ? band : 1;         // emissive vertices keep their authored bytes
      b.p[i] = Math.min(255, b.p[i] * k * 1.35 + 6);
      b.p[i + 1] = Math.min(255, b.p[i + 1] * k * 1.35 + 6);
      b.p[i + 2] = Math.min(255, b.p[i + 2] * k * 1.35 + 6);
    }
    return b;
  }
  function model(kind) {
    /* #78: the key carries the limb side count, because that is now part of what a model IS. Keying on
       kind alone would hand back the 6-sided rest model after the graphics tier changes - the same shape
       as #186's lesson, that a cache key must contain every term the geometry reads. */
    const mk = kind + '#' + segLimbs();
    if (MODELS[mk]) return MODELS[mk];
    /* NO fallback. This used to read SPEC[kind] || SPEC.grunt, so a kind nobody authored answered with
       a grunt - a prop converted by mistake would have shipped as a small grey soldier, which is the
       failure #76 asks to make loud. A missing row is a bug in the caller, so it throws. */
    if (!SPEC[kind] && !PROPGEO[kind]) throw new Error('MESH: no geometry authored for kind "' + kind + '"');
    const b = geoFor(kind, 0, 0, 0, 0, 0);
    const mdl = { kind, seg: segLimbs(), p: new Float32Array(b.p), t: new Uint16Array(b.t), em: Uint8Array.from(b.e), st: Float32Array.from(b.s), nV: b.p.length / 6, tris: b.t.length / 3 };
    MODELS[mk] = mdl;
    return mdl;
  }

  /* ---- pose table: one vertex set per phase bucket ---------------------------
     The amortization the rig had (js/11_rig.js BUCKETS + its LRU pose cache), moved from textures
     to vertices: 8 gait phases x 3 move levels x 4 attack per kind, plus 5 death buckets x DIEV
     variants per kind, built on first sight and LRU-evicted under a byte cap, so a moving enemy
     costs a Map hit and an array read instead of a vertex rebuild. Buckets are ENDPOINTS except
     the gait phase, which is periodic: bucket i is phase i/8, and mv/atk/die run 0..1 so the last
     bucket is a full stride, a full extension and a flat corpse. `MESH.setCache(false)` turns the
     table off, which is the rebuild-per-frame half of the cost A/B (#73 acceptance). */
  const PB = { ph: 8, mv: 3, atk: 4, die: 6 };
  const POSE = new Map();
  const PCAP = 4 << 20;
  let poseBytes = 0, poseMade = 0, CACHE = true;

  function buildPose(m, p, mv, atk, die, dv) {
    const b = geoFor(m.kind, p, mv, atk, die, dv);
    const n = m.nV, v = new Float32Array(n * 3);
    if (b.p.length !== m.p.length) console.warn('MESH pose vertex count drifted from the rest model: ' + m.kind);
    for (let i = 0; i < n; i++) {
      v[i * 3] = b.p[i * 6]; v[i * 3 + 1] = b.p[i * 6 + 1]; v[i * 3 + 2] = b.p[i * 6 + 2];
    }
    return v;
  }

  /* The bucket quantization on its own, so `MESH.poseBucket` can name the entry a draw is about to
     use. One rule lives here and poseOf reads it: an Anim row that computed its own bucket from
     o.p would be a second rule, and a pose table whose phase term is pinned (the #274 sabotage)
     would leave the row green while every body in the game stood still. */
  function bucketOf(o) {
    const ph = Math.floor(((((o.p || 0) % 1) + 1) % 1) * PB.ph);
    const mv = Math.min(PB.mv - 1, (clamp(o.mv || 0, 0, 0.999) * PB.mv) | 0);
    const ab = Math.min(PB.atk - 1, (clamp(o.atk || 0, 0, 0.999) * PB.atk) | 0);
    const db = Math.min(PB.die - 1, (clamp(o.die || 0, 0, 0.999) * PB.die) | 0);
    /* A corpse has no gait: once die > 0.01 joints() reads NONE of p, mv or atk, so for a dying
       body those three buckets are collapsed out of the key and the death variant goes in. That is
       exact rather than approximate - the vertices cannot depend on them - and it is what pays for
       DIEV: 5 buckets x 3 variants per kind replaces the 96 entries per phase that main keyed and
       built for one and the same corpse. */
    return { ph, mv, ab, db, dv: db > 0 ? ((o.dv | 0) % DIEV + DIEV) % DIEV : 0 };
  }

  function poseOf(m, o) {
    const b = bucketOf(o);
    const ph = b.ph, mv = b.mv, ab = b.ab, db = b.db, dv = b.dv;
    if (!CACHE) return buildPose(m, ph / PB.ph, mv / (PB.mv - 1), ab / (PB.atk - 1), db / (PB.die - 1), dv);
    const key = db > 0 ? m.kind + '#' + m.seg + '|d' + dv + '|' + db
      : m.kind + '#' + m.seg + '|' + ph + '|' + mv + '|' + ab;
    const hit = POSE.get(key);
    if (hit !== undefined) { POSE.delete(key); POSE.set(key, hit); return hit; }
    // evict before building, the rig's lesson: a cache that can only shrink on an insert stalls
    while (poseBytes > PCAP && POSE.size > 8) {
      const old = POSE.entries().next().value;
      POSE.delete(old[0]); poseBytes -= old[1].byteLength;
    }
    const v = buildPose(m, ph / PB.ph, mv / (PB.mv - 1), ab / (PB.atk - 1), db / (PB.die - 1), dv);
    POSE.set(key, v); poseBytes += v.byteLength; poseMade++;
    return v;
  }

  /* ---- triangle rasterizer: flat shading, per-pixel 1/z, near-plane clip ---- */
  const NEAR = 0.12;

  /* Rasterize CX/CY/CZ (camera space, metres) with colour CR,CG,CB.
     Coverage rule is the spike's - barycentric w>=0 on both tested edges, so a
     shared edge is claimed by both triangles and the mesh is watertight. */
  function tri() {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const inside = CY[i] >= NEAR;
      if (inside) { OX[n] = CX[i]; OY[n] = CY[i]; OZ[n] = CZ[i]; n++; }
      if (inside !== (CY[j] >= NEAR)) {
        const t = (NEAR - CY[i]) / (CY[j] - CY[i]);
        OX[n] = CX[i] + (CX[j] - CX[i]) * t; OY[n] = NEAR; OZ[n] = CZ[i] + (CZ[j] - CZ[i]) * t; n++;
      }
    }
    if (n < 3) return;
    const hw = BW * 0.5, hor = horizon;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < n; i++) {
      const izi = 1 / OY[i];
      const X = hw * (1 + OX[i] * izi), Y = hor + (BH * (eyeZ - OZ[i])) * izi;
      SX[i] = X; SY[i] = Y; IZ[i] = izi;
      if (X < minx) minx = X; if (X > maxx) maxx = X;
      if (Y < miny) miny = Y; if (Y > maxy) maxy = Y;
    }
    const x0 = Math.max(0, Math.ceil(minx)), x1 = Math.min(BW - 1, Math.floor(maxx));
    const y0 = Math.max(0, Math.ceil(miny)), y1 = Math.min(BH - 1, Math.floor(maxy));
    if (x1 < x0 || y1 < y0) return;
    if (VMASK) {                                      // view model only: four compares per triangle
      if (x0 < srx0) srx0 = x0; if (x1 > srx1) srx1 = x1;
      if (y0 < sry0) sry0 = y0; if (y1 > sry1) sry1 = y1;
    }
    const COL = (255 << 24 | CB << 16 | CG << 8 | CR) >>> 0;
    const A = ALPHA, IA = 1 - A, SOLID = A >= 1;      // hoisted: the blend is a corpse's, not the rule
    /* #533 THE WAVE MAY NOT CLIP, OR IT IS NOT ZERO-MEAN ANY MORE. The seam is symmetric about the
       face's own colour, so its mean is that colour ONLY while every pixel of it stays inside the
       byte: `clampi(C + kk*m)` throws away the part of the NEGATIVE half that falls below 0 and keeps
       the whole positive half, which is a brightness term, not a surface term. That is the mechanism
       behind the `props` CRATE control moving 48 -> 50 when props were given structure (#533 review),
       and it is a property of the DEPTH of the wave against the darkness of the face, not of the
       slope: a crate in a dim cell whose blue lands at 8 cannot carry a +-11 wave in blue. So the
       excursion is capped by the triangle's own distance to the byte floor and ceiling, per channel -
       the wave gets SHALLOWER where the surface is too dark to carry it and keeps its full depth
       everywhere it already fit. PS_SLOPE, the amplitude law and the range fade are untouched: this
       is not the amplitude being turned down, it is the term being kept zero-mean where it would
       otherwise have rectified. Cost is six multiplies and two mins per TRIANGLE, none per pixel. */
    let tkc = TK;
    if (tkc) {
      const flo = Math.min(CR * TSCR[0], CG * TSCR[1], CB * TSCR[1]);
      const cei = Math.min((255 - CR) * TSCR[0], (255 - CG) * TSCR[1], (255 - CB) * TSCR[1]);
      if (flo < tkc) tkc = flo;
      if (cei < tkc) tkc = cei;
    }
    /* Coverage mask: hoisted so the global is read once per TRIANGLE, not per pixel, and when COV
       is null (play) CW is null and the only cost in the loop is a predictable branch. The stamp is
       LAST-WRITER-WINS because the list is sorted far to near: a crate drawn over a body stamps 0
       and the body stops being silhouette, which is what the eye sees. */
    const CW = COV, CTAG = BODY ? 1 : 0;
    const e0x = SX[1] - SX[0], e0y = SY[1] - SY[0], e1x = SX[2] - SX[0], e1y = SY[2] - SY[0];
    const det = e0x * e1y - e1x * e0y;
    if (det > -1e-9 && det < 1e-9) return;                      // degenerate in screen space
    const idet = 1 / det;
    const i0x = SX[0], i0y = SY[0], iz0 = IZ[0], iz1 = IZ[1], iz2 = IZ[2];
    for (let y = y0; y <= y1; y++) {
      const vy = y + 0.5 - i0y;
      let x = x0, row = y * BW;
      for (; x <= x1; x++) {
        const vx = x + 0.5 - i0x;
        const w1 = (vx * e1y - e1x * vy) * idet;                // barycentric vs edge 1
        if (w1 < 0 || w1 > 1) continue;
        const w2 = (e0x * vy - vx * e0y) * idet;                // barycentric vs edge 2
        if (w2 < 0 || w1 + w2 > 1) continue;
        const z = 1 / ((1 - w1 - w2) * iz0 + w1 * iz1 + w2 * iz2);
        const off = row + x, occ = zbuf[off];
        // strictly-nearer occluder culls, equal depth draws - the billboard rule
        if (occ < z) continue;
        // writing the winner is the whole point: without it these triangles are
        // painted in emit order, and a torso emitted before an arm loses to it
        if (SELF && z < occ) zbuf[off] = z;
        if (CW) CW[off] = CTAG;
        if (SURF) SURF[off] = 0;          // #546: a face, a prop, a body or the view model owns this pixel
        if (TK && SOLID) {
          // the zero-mean seam: (1-w1-w2)*TQ0 + w1*TQ1 + w2*TQ2 is the body coord under the pixel
          let u = (1 - w1 - w2) * TQ0 + w1 * TQ1 + w2 * TQ2;
          u -= Math.floor(u);
          const kk = (u < 0.5 ? u * 4 - 1 : 3 - u * 4) * tkc;
          px[off] = (0xFF000000 | clampi(CB + kk * TSC[1]) << 16 | clampi(CG + kk * TSC[1]) << 8 |
            clampi(CR + kk * TSC[0])) >>> 0;
        }
        else if (SOLID) px[off] = COL;
        else {
          const dst = px[off];
          px[off] = (0xFF000000 | clampi(CB * A + (dst >> 16 & 255) * IA) << 16 |
            clampi(CG * A + (dst >> 8 & 255) * IA) << 8 | clampi(CR * A + (dst & 255) * IA)) >>> 0;
        }
        pxFilled++;
      }
    }
    tris++;
  }

  /* world -> camera for one point: tx across the plane, ty along the view dir */
  function toCam(wx, wy, wz, o) {
    const dx = wx - o.x, dy = wy - o.y, invDet = o.invDet;
    o.tx = invDet * (o.dirY * dx - o.dirX * dy);
    o.ty = invDet * (-o.planeY * dx + o.planeX * dy);
    o.tz = wz;
  }

  /* draw one mesh. opts: {kind,x,y,z,yaw,scale,self,alpha,flash,tint, p,mv,atk,die,dv}
     alpha < 1 blends (the corpse fade); flash is the hit term folded into the flat colour the
     way the billboard did it; tint is that enemy's per-individual colour jitter. p/mv/atk/die are
     the gait phase, the move amount, the attack progress and the death progress - the same four
     signals the billboard fed js/11_rig.js - and they select a cached vertex set, not a rebuild.
     dv is the death variant rolled at spawn (#82): it picks WHICH death pose that is, and one of
     its terms is added to the yaw rather than to the vertex set. */
  /* Footprint radius per authored prop kind, in NORMALISED units (before `scale`): the barrel's
     staves reach 0.255, the crate's frame 0.375, the lamp's shade 0.17. It lives beside the geometry
     it measures because a footprint guessed in the caller is a second source of truth that drifts
     the day the art changes; `MESH.foot` is the only reader (#212). */
  const FOOT = { barrel: 0.255, crate: 0.375, lamp: 0.17 };

  function draw(o) {
    /* A view model brings its own vertex set (`mdl`): its parts travel continuously - ejector, pump,
     a shell sliding in - so the caller rebuilds it per frame instead of bucketing it (weaponGeo).
     A prebuilt model has no pose table, no death variant and no kind in SPEC - and it never evaluates
     the right-hand side below, so removing the fallback there costs the view models nothing.
     There is NO `|| 'grunt'` on this line: `model` already throws on a kind nobody authored, but an
     ABSENT kind used to reach here and be answered with a standing soldier. #361 added a `gren` kill
     drop before PKKIND had a row for it, so `kind` arrived undefined and a grenade box drew as a
     0.42 grunt - the exact failure #76 asks to make loud, arriving silently because the default sat
     one line before the check that could see it. */
    const m = o.mdl || model(o.kind), sc = o.scale || 1,
      MDL = o.mdl || null, ROT = o.rot || null;      // rot: a 3x3 row-major world rotation
    /* The variant's FALL DIRECTION rides in the yaw, which is free: the yaw is applied to the
       cached verts below and is not in the key, so "topples onto its own side" is the same vertex
       set turned a quarter turn rather than a third of the table again (that lever is why the
       cache grows by 10 sets and not 3x). Only a body that is actually in a death bucket gets
       one - a live enemy's heading must never move because of a corpse field. */
    const yaw = (o.die || 0) >= 1 / PB.die ? (o.yaw || 0) + dieRow(o.kind || 'grunt', o.dv).yw : (o.yaw || 0);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    SELF = o.self === undefined ? true : !!o.self;
    BODY = !!o.body;               // a character's draw: what COV stamps, see js/00_core.js
    /* A view model draws into a SCRATCH depth buffer instead of the frame's: it is nearer than
       everything the world can put there, so its own test must be against its own parts only (the
       header in js/40_render.js explains the direction of the swap). It is also not a body, so the
       line above has to stay ABOVE this one: COV gets stamped per pixel below, and BODY is the
       module global it reads - a draw that swapped depth but left BODY set by the previous (enemy)
       draw would paint the gun into the coverage mask and tools/view.js contrast would measure it. */
    if (o.near) {
      if (!ZFAR || ZFAR.length !== zbuf.length) { ZFAR = new Float32Array(zbuf.length).fill(Infinity); srx1 = -1; }
      for (let y = sry0; y <= sry1; y++) ZFAR.fill(Infinity, y * BW + srx0, y * BW + srx1 + 1);
      srx0 = 1e9; srx1 = -1e9; sry0 = 1e9; sry1 = -1e9;
      VMASK = true;
      ZSAVE = zbuf; zbuf = ZFAR;
    }
    /* EMIS is the entry-wide form of the exemption and EM the per-part one; either is enough to put a
       triangle's pixels on the billboard's light-free path. The billboard reaches it through a texel
       whose alpha byte is 253 or through o.self (js/40_render.js:703), and a mesh has neither, so
       without these the orb, the portal and a lamp's bulb would be multiplied by scene light - which
       is darkest in exactly the rooms where they are the only light source (js/40_render.js:703, and
       #33 for the same floor under AMB). */
    EMIS = !!o.emis; DIM = o.dim || 0; EM = m.em;
    ST = m.st || null;                              // #232 per-vertex torso coord; props and the gun have none
    HD = m.hd || NOHD;                              // #562 which of a rig's TWO structure laws authored this vertex
    /* The ramp a face's light rides. THREE cases read it, all of them at the one `sh` below, and a PROP
       is not one of them:
         a BODY            0.30 + 0.85*d - its sprites carried a curvature term, so that is the path's
                           own history and it stays (#407 prices it against the body's own field);
         the VIEW MODEL    0.55 + 0.55*d, and MDL is only ever the gun (40_render.js:3852) - #376;
         PROPGEO-not-prop  0.75 + 0.42*d, i.e. the two sprites #76 converted to mesh because the Builder
                           was already there - the ORB and the PORTAL. Only the SHUT portal ever shows
                           the ramp: open it is `emis` and no ramp applies to it at all, shut it is
                           `dim` 0.55 and lit by the room, which is the case the PROPKIND note above
                           found moving at L1 and L3 and holding byte for byte at L0 and L2.
       A PROP READS NOTHING HERE. `lw` at the bottom of this block answers `pr` with the form term `aw`,
       so both prop arms of the two lines below were evaluated and then dropped on the floor: #561 set
       the prop constant from 0.60 to 1.40 - a 2.3x swing on what this comment used to call the shaded
       side of a prop face - and `node tools/view.js props` came back byte-identical apart from the tree
       banner, same face census, same control, same turn. Since a prop is `pg` as well, a prop now lands
       on PROPGEO's 0.75/0.42 arm and that value is dead arithmetic discarded by `lw`; the day a change
       routes a prop through `sh` instead of `aw` is the day those two numbers start painting crates, and
       `props`' (Y) face row is where it would show.
       What #371 actually changed on a prop is PROP_R1/PROP_DMEAN below, and the arithmetic that comment
       used to carry here belongs with them: a prop's sprite had NO normal at all (drawBillboard's lr is
       AMB + 1.1*li*lt, flat), so borrowing the body's ramp darkened every face turned away from KEY by
       up to 3.7x - a hazard-red drum came out the colour of dried mud, barrel 99 -> 79 and crate 101 ->
       51 at the brightest tenth of the silhouette - and the flattened 0.75 + 0.42*d that replaced it
       kept the average where the painted sheet was and paid with the thing a ramp is FOR. #371's
       diagnosis still stands and is the reason `aw` exists: d is `max(0, N·KEY)` with N flipped toward
       the eye (above), so a face that looks at the camera but away from the key answers d = 0 exactly,
       R0 = 0.75 was not a floor under the shaded side but the SHADED SIDE, and with KEY's x and y
       magnitudes near equal two square-to-the-grid faces could not be told apart by any light in the
       game at any yaw. That is the 18-luminance crate. */
    const pg = !MDL && PROPGEO[o.kind] !== undefined;
    const pr = pg && PROPKIND[o.kind] === 1;         // a prop, not merely something built by PROPGEO
    R0 = MDL ? 0.55 : (pg ? 0.75 : 0.30);
    R1 = MDL ? 0.55 : (pg ? 0.42 : 0.85);
    /* #371: the prop form term's own two constants, and the ONLY knobs a prop's face value answers to -
       the ramp pair above is not one of them (see the note there for what a prop does not read).
       PROP_DMEAN is the mean of d = max(0, N*KEY) over a
       box's THREE face families (two vertical families at |KEY_xy| = 0.732 and the top at KEY_z = 0.68),
       the same 0.567 #373 used to hold its ramp's mean; centring on it makes the form term average
       exactly 1 over a box, so the prop's average light is the shipped light and only the SPREAD moved.
       PROP_R1 is that spread: the shipped ramp gave a face pair about 1.23x and delivered 1.18x because
       the ambient outside it is a floor both faces share; 1.1 on the whole light is the issue's "at
       least 35 luminance where the shipped build gives 18". */
    const PROP_R1 = 1.3, PROP_DMEAN = 0.45;
    /* #371 THIS INCREMENT: the SAME centring per prop KIND, because `d` averages differently for the one
       kind whose side is curved. Measured, not derived: every PIXEL a prop delivers in a four-sector
       sector sweep at 031a70f (only pixels that pass the depth test, so an occluded far wall of a tube
       counts for nothing), accumulated as sum(d)/count per kind -
         crate  961,417 px  mean d 0.2863      barrel  497,427 px  mean d 0.3502      lamp 496,561 px  0.4399
       A tube always shows some face to the key - its visible normals sweep a half-circle, so the max(0,..)
       clamp never bites across a whole silhouette the way it does on a box's two flat families - and at
       the shipped centring the drum therefore collects MORE light per pixel than the crate beside it:
       mean aw = 1 + PROP_R1*(mean d - centring) is 0.870 on a barrel against 0.787 on a crate, +10.6 %.
       Both props are in the same light. That is why every prop still over the +25 bar is a barrel.
       PROP_DMEAN_K shifts a kind by the measured DIFFERENCE from the box's own mean, which is the only
       form of this that is a measurement and not a tune: 0.45 + (0.3502 - 0.2863) = 0.5139 puts every
       kind's form term back on the mean the box's centring already holds, so the drum keeps its colour
       and its albedo, no light value moves, and the crate and lamp rows come out byte-identical because
       their centring does not appear in this table. It is NOT the tube's own mean: centring on 0.3502
       would make the barrel's form term average exactly 1, which is +15 % LIGHT on every drum in the game
       (measured: the same sweep with that value puts 4 props over the bar instead of 2), and the shipped
       0.45 is not any kind's mean either - it is above all three, which is what keeps a prop's delivered
       mean where the painted billboard sheet landed (`exposure`'s four seeded medians). The difference is
       what is owed; the absolute is what the mean-hold control pins. A barrel keeps its lit side and its
       shaded side by construction: this moves the term's average, not PROP_R1's slope. */
    const PROP_DMEAN_K = { barrel: 0.5139 };
    /* The centring a prop is actually shaded with: one lookup per DRAW, not per triangle. A kind with no
       row above keeps PROP_DMEAN, so a crate and a lamp run byte-identical arithmetic - that is the scope
       control the issue asks for, and it is structural: the only way a box reaches this table is by a row
       appearing in it. Declared HERE, after the constants, because `const` has a temporal dead zone and
       this runs per draw: the first prop frame of the boot reads it before its own declaration otherwise. */
    const pdm = pr && PROP_DMEAN_K[o.kind] !== undefined ? PROP_DMEAN_K[o.kind] : PROP_DMEAN;
    /* #371: what a PROP pays for the visibility FILL. `li` below adds 0.30 * visAt(dc) on top of the
       baked lamp field, and that add is a READABILITY term, not a light: it exists so a hostile does not
       arrive as a black cut-out in a dark cell at engagement range (#407 kept it for exactly that, and
       took the double distance falloff out around it). No WORLD surface carries it - a wall column and a
       ground pixel read `li = lm[cIdx]` flat (js/40_render.js:921, :1037, :1485) - so a prop, which shares
       the mesh's lighting branch with bodies, was receiving a fill the room it stands in never got.
       That is the whole drift this increment measured. Against #491's head (25aec13) the prop means at the
       seven offending seats moved by -4..+10 luma while the DECKS under them fell 14-40 luma (#369's tile
       repaint, #518's floor walk): the room came down, the crate stayed put, and the gap went from 1 seat
       over the +25 bar to 7. In a dim cell the fill is not a rounding error - visAt is 0.647 at 8 m, so
       0.19 of light that the floor under the same crate does not receive.
       PROP_FILL is that share, taken back for props only. Bodies keep 0.30: the term is why an enemy is
       legible in a corner, and this issue's own criterion is that the ENEMY is the brightest moving thing
       in its part of the frame, so paying for the prop's band out of the enemy's readability would trade
       the defect for a worse one. Distance is still carried for props by the fog wash (`+ FOGC*fog`
       below), the field's own splat falloff and the haze, exactly as for every other surface - nothing
       here dims a prop that is standing in its room's light, because `Math.min(1, ...)` already saturates
       that case. Set it to 0.30 and the sweep goes back to 7 seats over the bar: that is the falsifier.
       ONE read site - every placed prop is `mesh: true` (js/40_render.js:537), so the billboard copy at
       :3135 carries no prop, and pickups/orbs/PORTAL are not PROPKIND and keep the shipped 0.30. */
    const PROP_FILL = 0;
    FLR = MDL ? (o.floor || 0) : 0; RIMK = MDL ? (o.rim || 0) : 0;
    ALPHA = o.alpha === undefined ? 1 : o.alpha;
    FLASH = o.flash ? 1 : 0;
    TINT = o.tint || null;
    const PD = m.p, T = m.t, nV = Math.min(m.nV, MAXV);
    if (nV !== m.nV) console.warn('MESH: ' + m.kind + ' has ' + m.nV + ' verts, over MAXV ' + MAXV + ' - it will be drawn truncated');
    cam.x = camX; cam.y = camY; cam.dirX = dirX; cam.dirY = dirY; cam.planeX = planeX; cam.planeY = planeY;
    cam.invDet = 1 / (planeX * dirY - dirX * planeY);
    /* Cull before rasterizing. A body costs its whole triangle list whether or not it can be
       seen, and the two tests the billboard path already runs - behind the camera, off the
       buffer - are two world-space dots. The box is 1.6x the projected height against a body
       no wider than 1.02x it (SPEC.aspect), so it can keep an off-screen body and cannot drop
       an on-screen one. */
    const ex = o.x - camX, ey = o.y - camY;
    const tYc = cam.invDet * (-planeY * ex + planeX * ey);
    if (tYc < -sc) return;
    if (tYc > 0.12) {
      const tXc = cam.invDet * (dirY * ex - dirX * ey);
      const wide = (BH / tYc) * sc * 1.6, sx = (BW * 0.5) * (1 + tXc / tYc);
      if (sx + wide * 0.5 < 0 || sx - wide * 0.5 > BW) return;
    }
    /* The pose comes AFTER the cull, for the reason AGENTS.md already states about rigs: work done
       for a body nobody sees is not free. A corpse topples about the contact line its own yaw points
       along, which is why dieAng still rides in `yaw` here - direction is the yaw's job, progress is
       the vertex set's (js/40_render.js). The variant's yw is added to that same yaw above, so a
       corpse that falls sideways aims along dieAng turned a quarter turn. */
    const PP = MDL ? MDL.v : poseOf(m, o);
    /* The seam PERIOD in pixels is what sets the amplitude: TS_CYC seams per body unit, projected.
       Under the gate the draw steps to one coarser level of the same pattern instead of switching the
       term off (#416 - the block at TS_CYC carries the measurement). The law is the same on both
       levels: what is held constant is the SLOPE, never the amplitude. */
    /* #587 the rig is the third object class on this law, and it needs its OWN cycle count because its
       geometry is authored in metres rather than in fractions of its own height: for the gun `sc` is 1 and
       `tYc` is the rig's own anchor distance (~0.245 m at the hip, 0.190 m shouldered), so the same
       expression returns the projected pixel period of a WS_CYC seam without any change of form.
         #562 AND A RIG IS TWO CLASSES, NOT ONE. One `MDL`, one draw, the gun's metal AND the fists, and
       `!!MDL` cannot tell them apart: this branch's `vs` and main's `vm` were the SAME predicate, so a
       textual merge hands one geometry whichever law the leftmost ternary carries - the slide would have
       read the fist's 4 seams per metre and the fist a machined 100. The key that does separate them is
       already per vertex - the region register the part was emitted under, which `wBuild` carries as
       `m.hd` - so each class reads ONE law, the two blocks here being the same expression with each class's
       own three constants, and `tri` gains no path. */
    const vm = !!MDL;                                    // the view model, and MDL is only ever the rig
    const TCY = vm ? WS_CYC : (pr ? PS_CYC : TS_CYC);
    let TPR = BH * sc / (Math.max(NEAR, Math.abs(tYc)) * TCY);
    if (!ST) TPR = 0;                                     // no torso coords on this mesh: no term
    else if (TPR < TS_MINP) { TPR *= 2; TCYC = TCY / TS_LMAX; } else TCYC = TCY;
    /* #533: a prop keeps the LAW and brings its own SLOPE. TS_SLOPE 9 belongs to armour that means
       near 100; a crate in a dim cell means 48 and the same slope is a 45-luma peak-to-peak seam on
       it. The projected period is the same quantity for both - a prop's authored geometry is in
       units of its own height and `scale` is that height in metres - so only the slope and the
       near-field ceiling differ, and what the eye holds constant across a walk past, luma per screen
       pixel, is unchanged in kind. */
    TAMP = TPR <= TS_MINP ? 0 : Math.min(vm ? WS_MAX : pr ? PS_MAX : TS_MAX, (vm ? WS_SLOPE : pr ? PS_SLOPE : TS_SLOPE) * TPR * 0.25);
    /* #562 THE FISTS, the second class in this same draw, and the two lines above with VS_* in place of
       WS_*: their own projected period, the same one coarsening past TS_MINP, their own near-field ceiling.
       Nothing here is a second law - it is the law, read at the other class's constants, and it is computed
       per DRAW and not per triangle. A rig built by the probe's `setHands(false)` arm has no hand region and
       so leaves TAMPH 0, which is what makes that A/B measure the fists rather than a different arithmetic;
       bodies and props never have a hand region either, and cost one register test in the triangle loop. */
    if (HD !== NOHD) {
      let HPR = BH * sc / (Math.max(NEAR, Math.abs(tYc)) * VS_CYC);
      if (HPR < TS_MINP) { HPR *= 2; TCYH = VS_CYC / TS_LMAX; } else TCYH = VS_CYC;
      TAMPH = HPR <= TS_MINP ? 0 : Math.min(VS_MAX, VS_SLOPE * HPR * 0.25);
    } else TAMPH = 0;
    if (ROT) {
      // yaw+pitch+roll as one matrix, so a rig can point its bore along the firing ray.
      // The yaw-only branch below is untouched: this is the extra path a view model takes,
      // and a body never builds a matrix.
      for (let i = 0; i < nV; i++) {
        const bx = PP[i * 3], by = PP[i * 3 + 1], bz = PP[i * 3 + 2];
        VX[i] = o.x + (ROT[0] * bx + ROT[1] * by + ROT[2] * bz) * sc;
        VY[i] = o.y + (ROT[3] * bx + ROT[4] * by + ROT[5] * bz) * sc;
        VZ[i] = o.z + (ROT[6] * bx + ROT[7] * by + ROT[8] * bz) * sc;
      }
    } else
      for (let i = 0; i < nV; i++) {
        const bx = PP[i * 3], by = PP[i * 3 + 1], bz = PP[i * 3 + 2];
        VX[i] = o.x + (bx * cyw + bz * syw) * sc;
        VY[i] = o.y + (-bx * syw + bz * cyw) * sc;
        VZ[i] = o.z + by * sc;
      }
    /* The light cell is the PLAYER's cell, not the anchor's: a muzzle 0.15 m ahead of the eye is
       over the boundary into whatever is in front, and taking the light of that - a wall column,
       or the room behind a door - would make the gun dim when it points at a wall.
       The cell's HUE is a different term and the view model must not read it (#376). A room's tint is
       the colour of that room's lamps, and multiplying it into every weapon pixel meant the rifle you
       are carrying changed substance in a doorway - warm rust in one sector, blue in the next, green in
       a third, at pixel coordinates no geometry moved between. The gun is the one object in the frame
       the player never stops looking at, and it is not in the room the way a barrel is: it is bolted to
       the eye. So a view-model draw keeps every INTENSITY term of the cell's light - MAP.light, the
       distance falloff, KEY's Lambert, the muzzle's own wash, so walking up to a lamp and firing still
       change how bright it is - and drops only the hue, which is what #76 already decided for the
       world's props and bodies: they are lit by their own room, and they are allowed to look like it.
       The cell lookup and the falloff above stay exactly as they were; deleting `cell:` from the
       call site would have traded one defect for the dim-the-gun-when-you-aim-at-a-wall one. */
    const cc = o.cell === undefined ? cellIdx(o.x, o.y) : o.cell;
    const lt = o.near ? TINT_NEUTRAL : cellTint(cc), lm = MAP.light;
    /* #611 WHERE the body's paint sits in hue, decided once per DRAW from the cast falling on it.
       A body's delivered colour is its palette x the room's lamp tint, so a fixed albedo separates in
       the rooms whose hue is far from the kind's and disappears in the ones whose hue is close - the
       sector roll, not the art, decides whether the player can see the enemy. The palette stays put;
       what changes is the multiplier the cast puts on it. `lt` is that tint normalised about 1, so the
       zero-mean push `K*(mean - lt)` cancels the cast to first order at K = 1, and the three multipliers
       sum to 3 by construction at any K - which is a statement about the FRAME mean, not about his own
       pixels: Rec.601 weighs green at 0.587, so removing a green cast lifts the luma of the body pixels
       it touched (ABATOIR dealt cam0 40.4 -> 46.0, cam2 43.8 -> 51.1). A frame mean is unchanged; he is
       a shade brighter AND a different colour, and the value step was already there from the light path. It is ALBEDO - it goes with the texel, so the
       BODYPAINT arm of tools/view.js contrast turns it off along with the palette and still measures
       paint against shading unchanged; a body wearing the background's colour is not wearing a pigment
       he does not own. Bodies only: the gun is #376's and a prop's paint is #371's, and neither is the
       thing a player has to find in under a second. */
    let bhr = 1, bhg = 1, bhb = 1;
    if (BODYHUE && BODY && !MDL && !pr) {
      const bm = (lt[0] + lt[1] + lt[2]) * 0.3333333;
      if (bm > 0.125) {
        const bk = BH_K / bm;
        bhr = 1 + bk * (bm - lt[0]); bhg = 1 + bk * (bm - lt[1]); bhb = 1 + bk * (bm - lt[2]);
        if (bhr < BH_LO) bhr = BH_LO; else if (bhr > BH_HI) bhr = BH_HI;
        if (bhg < BH_LO) bhg = BH_LO; else if (bhg > BH_HI) bhg = BH_HI;
        if (bhb < BH_LO) bhb = BH_LO; else if (bhb > BH_HI) bhb = BH_HI;
      }
    }
    const FL = S.flash, FC = S.flashCol;                // the muzzle's own light, the billboard's term
    for (let k = 0, K = T.length; k < K; k += 3) {
      const i0 = T[k], i1 = T[k + 1], i2 = T[k + 2];
      // face normal in world space (flat shading), then Lambert against KEY
      const ex1 = VX[i1] - VX[i0], ey1 = VY[i1] - VY[i0], ez1 = VZ[i1] - VZ[i0];
      const ex2 = VX[i2] - VX[i0], ey2 = VY[i2] - VY[i0], ez2 = VZ[i2] - VZ[i0];
      let nx = ey1 * ez2 - ez1 * ey2, ny = ez1 * ex2 - ex1 * ez2, nz = ex1 * ey2 - ey1 * ex2;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) { trisCulled++; continue; }
      nx /= nl; ny /= nl; nz /= nl;
      // two-sided: the tubes are open at the ends, so their far walls must shade
      // rather than vanish - depth ordering, not backface culling, hides them
      const evx = camX - VX[i0], evy = camY - VY[i0], evz = eyeZ - VZ[i0];
      let vd = nx * evx + ny * evy + nz * evz;
      if (vd < 0) { nx = -nx; ny = -ny; nz = -nz; vd = -vd; }
      let d = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
      if (d < 0) d = 0;
      toCam(VX[i0], VY[i0], VZ[i0], cam); CX[0] = cam.tx; CY[0] = cam.ty; CZ[0] = cam.tz;
      toCam(VX[i1], VY[i1], VZ[i1], cam); CX[1] = cam.tx; CY[1] = cam.ty; CZ[1] = cam.tz;
      toCam(VX[i2], VY[i2], VZ[i2], cam); CX[2] = cam.tx; CY[2] = cam.ty; CZ[2] = cam.tz;
      if (CY[0] < NEAR && CY[1] < NEAR && CY[2] < NEAR) { trisCulled++; continue; }
      const dc = (CY[0] + CY[1] + CY[2]) / 3;
      const fog = fogAt(dc), inv = 1 - fog;
      let lr, lg, lb;
      if (EMIS || EM[i0]) {
        // light-exempt: albedo and fog and nothing else, which is what js/40_render.js:703 does for a
        // texel whose alpha byte is 253 or a sprite drawn self:true - no AMB, no scene light, no ramp,
        // no tint and no dim, because all of those are terms of the light the pixel is exempt from
        lr = inv; lg = inv; lb = inv;
        PKN = 0;                                     // a light source is not a surface: no bound on it
      } else {
        /* #407: the lamp field is taken WHOLE at the body's own cell. `MAP.light` is a baked LAMP
           field - splatLight (js/20_level.js) spreads every lamp over a disc of its radius, so a cell's
           value already carries the lamp's falloff out to that cell. Multiplying it by exp(-camera
           distance) booked a SECOND falloff, cell -> eye, that no other surface pays: a wall column and
           a floor pixel read `li = lm[cIdx]` with no distance term at all (js/40_render.js:921, :1037,
           :1485), so a body 10 m inside a lit room kept 25% of the room's light while the wall two
           metres behind it kept 100%, and the hostile in front of that wall arrived as a black cut-out.
           Distance is not unpaid here - it is carried by the HAZE, which this same block already pays
           (`fog = fogAt(dc)`, `inv = 1 - fog`, the FOGC add below), exactly as #197/#375/#385 settled it
           for every other surface. The `0.30 * visAt(dc)` term stays: it is the body's own FILL, and it
           fades with visibility in step with the haze rather than attenuating the field twice.
           BODYDIST 0 puts the second falloff back in this copy AND in the billboard copy - the A/B the
           distance rows in tools/view.js contrast are meant to be seen failing. */
        const li = Math.min(1, (lm ? lm[cc] : 0.5) * (BODYDIST ? 1 : Math.exp(-dc * 0.14)) +
          (pr ? PROP_FILL : 0.30) * visAt(dc));
        /* #407 half four: the haze is ADDED to a world pixel, never multiplied over its light - the row
           loop (:1349), a wall face (:2183) and a billboard (:2397) all end at `texel*light + FOGC*fog`,
           and `* inv` is left on light-EXEMPT texels only. This branch was the one place a LIT surface
           got scaled by `inv` as well, so a body paid the wash twice: 0.647 of its light left at 8 m and
           0.304 at 16 m, which is the 37-44 luma the distance rows have been calling the light path.
           BODYHAZE 1 puts that second charge back in this single read site (the billboard never had it),
           and js/00_core.js carries the register so a live page and the probe arm one value. */
        const hz = BODYHAZE ? inv : 1;
        /* #407 half two, priced by tools/view.js contrast's distance rows. `li` is a DIRECTIONLESS baked
           field and a ground pixel takes it flat (js/40_render.js:1043 `lr = baseRow + li*lt`, no N*L),
           but multiplying it by R0 + R1*d makes the shape ramp also a SCALE on that field: its mean over
           d is R0 + R1/2 = 0.725 for the enemy pair, so a body in its own lit cell kept under three
           quarters of the light the wall behind it keeps, and a face turned off the key kept R0 alone.
           BODYSHADE 0 centres the SAME ramp on the field instead of on zero - `1 + R1*(d - 0.5)`, mean 1
           over the ramp's own domain - so form keeps its full spread and the field arrives whole in the
           average. The VIEW MODEL keeps the shipped form either way: #376 owns the gun's shading, and
           the pair below is not the gun's history. There is no billboard copy of this term - the sprite
           path has no N*L at all (js/40_render.js:2291) - so unlike BODYDIST one read site is enough. */
        const sh = MDL || BODYSHADE ? R0 + R1 * d : 1 + R1 * (d - 0.5);
        const fk = FL ? FL * 1.1 * Math.exp(-dc * 0.30) : 0;
        /* #371: on a PROP the form term scales the WHOLE light, ambient included, and it is centred on
           one so the mean is held by construction instead of by re-pairing R0 against R1.
           Why outside the ramp: the shipped line adds `AMB` and then multiplies only the lamp field by
           `R0 + R1*d`, so a prop's delivered face ratio is (AMB + li*sh1)/(AMB + li*sh2), not sh1/sh2 -
           the ambient is a floor BOTH faces share and it cannot be pushed into shadow by any ramp. That
           is the residual the last two passes measured on the level-0 crate (1.23x claimed by the ramp,
           1.18x delivered, 16.5 luma) and why widening R1 with the mean re-paired moved two lumas.
           The WORLD already solves this differently, and in the direction this takes: a wall face's
           light is `(max(lit,litFront*.85)*fall + AMB + WALLB) * (side === 1 ? 0.78 : 1)`
           (js/40_render.js:2372) - the orientation multiplies the ambient too, which is exactly why two
           wall orientations read apart in a pitch-dark cell and two prop faces cannot. A prop now pays
           the same tax, centred: `aw = 1 + PROP_R1*(d - PROP_DMEAN)`. PROP_DMEAN is the mean of d over
           the faces a box actually PUTS ON SCREEN - the two vertical families weighted by their pixels
           and the top by its much smaller share - which is 0.45, measured, not #373's 0.567, which was
           the mean over the three face FAMILIES unweighted. Centring there makes the term average 1
           over what the eye receives, so no albedo is taken back and the hazard drum keeps its value:
           `exposure`'s four seeded medians (74 / 69 / 67 / 92) are UNCHANGED in the same run, which is
           the mean-hold control, and the first cut at 0.567 showed why it matters - it sat 0.7-1.2 luma
           under those medians and under three of the four spawn seats, a dimming, not a re-light.
           PROP_R1 is the spread: 1.1 takes the crate's two visible faces from rel 0.70 to rel 1.27 and
           the barrel's from 0.80 to 1.23 in the `props` probe's own face rows.
           The muzzle flash stays OUTSIDE the form term on purpose: it is a light AT the eye, so every
           face of a solid receives it equally and an orientation term on it would darken the flank that
           geometry happens not to favour. Bodies and the view model keep the shipped line untouched -
           #407 prices the body's ramp against its own field and #376 owns the gun. */
        const aw = pr ? 1 + PROP_R1 * (d - pdm) : 1;
        const lw = pr ? aw : sh;
        lr = (AMB * aw + li * lt[0] * lw + fk * (FC[0] / 255)) * hz;
        lg = (AMB * aw + li * lt[1] * lw + fk * (FC[1] / 255)) * hz;
        lb = (AMB * aw + li * lt[2] * lw + fk * (FC[2] / 255)) * hz;
        if (DIM) { lr *= 1 - DIM; lg *= 1 - DIM; lb *= 1 - DIM; }   // the portal's shut-and-dimmed term
        /* #371: the fold is a bound on the PRODUCT (albedo x light), not on the light, so it rides where
           the product is finished and the light-exempt branch has already been taken round. PKN is a
           module register for the same reason CR is: tri() reads registers, not the argument list. */
        PKN = pr ? 1 : 0;
        if (TINT) { lr *= TINT[0]; lg *= TINT[1]; lb *= TINT[2]; }
        if (FLR > lr) lr = FLR;
        if (FLR > lg) lg = FLR;
        if (FLR > lb) lb = FLR;
      }
      /* #407 half three: the PAINT arm. BODYPAINT = 0 replaces this texel with BPAINT_RGB and NOTHING
         else - lr/lg/lb above, the haze and the fog colour below stay exactly as shipped - so a render
         of the SAME coverage pixels with the background's own delivered colour as the albedo says in
         luma how much of a distance row's residual is paint and how much is the light path. The VIEW
         MODEL keeps its texel either way (#376 owns the gun); emissive pixels are already light-exempt
         and take no albedo. tools/view.js contrast's distance rows are the only caller. */
      let packed = PD[i0 * 6 + 3] << 16 | PD[i0 * 6 + 4] << 8 | PD[i0 * 6 + 5];
      if (!BODYPAINT && !MDL) packed = BPAINT_RGB;
      else if (bhr !== 1 || bhg !== 1 || bhb !== 1) {
        /* #611: the counter-pigment, on the albedo and before the light ever touches it. Clamped to
           the texel's own 0..255 so a saturated room cannot push a channel out of the buffer. */
        const par = (packed >> 16 & 255) * bhr, pag = (packed >> 8 & 255) * bhg, pab = (packed & 255) * bhb;
        packed = (par > 255 ? 255 : par | 0) << 16 | (pag > 255 ? 255 : pag | 0) << 8 | (pab > 255 ? 255 : pab | 0);
      }
      let r = (packed >> 16 & 255) * lr + FOGC[0] * fog;
      let g = (packed >> 8 & 255) * lg + FOGC[1] * fog;
      let b = (packed & 255) * lb + FOGC[2] * fog;
      if (RIMK) {
        // grazing faces take the rim: |N.V| -> 0 is by definition a face seen edge-on, which is the
        // silhouette of a convex part, so the band is angle-correct without a distance field
        const q = RIMK * (1 - Math.min(1, vd / Math.max(1e-6, Math.hypot(evx, evy, evz))));
        r += RIMC[0] * q; g += RIMC[1] * q; b += RIMC[2] * q;
      }
      /* Per triangle: the torso's own coord set, gated by the grazing band. TK is a module register
         like CR, so it MUST be zeroed on every triangle that is not torso geometry - a stale TK would
         paint the seam onto the leg that follows the chest in emit order. */
      /* Per triangle: the torso's own coord set, gated by the grazing band. TK is a module register
         like CR, so it MUST be zeroed on every triangle that is not torso geometry - a stale TK would
         paint the seam onto the leg that follows the chest in emit order. A rig's triangles are TWO
         classes (#562 + #587), so which class's constants apply is read per vertex off `HD` - the region
         the part was authored under - and nothing else about this block changes: same term, same gate,
         same registers. */
      if (TAMP || TAMPH) {
        const sa = ST[i0], sb = ST[i1], sz = ST[i2];
        const hh = HD[i0], amp = hh ? TAMPH : TAMP;
        if (amp && (sa !== 0 || sb !== 0 || sz !== 0)) {
          const q = 1 - Math.min(1, vd / Math.max(1e-6, Math.hypot(evx, evy, evz)));
          TK = amp * (TS_BMIN + (1 - TS_BMIN) * q);
          const tcy = hh ? TCYH : TCYC;
          TQ0 = sa * tcy; TQ1 = sb * tcy; TQ2 = sz * tcy;
        } else TK = 0;
      } else TK = 0;
      if (PKN) { r = pkneeling(r); g = pkneeling(g); b = pkneeling(b); }
      CR = r > 255 ? 255 : r | 0; CG = g > 255 ? 255 : g | 0; CB = b > 255 ? 255 : b | 0;
      // the hit flash the billboard applied per pixel is per triangle here: a flat-shaded face has
      // one colour, so the same 0.72 pull toward white after fog lands in the three registers
      if (FLASH) { CR = (CR + (250 - CR) * 0.72) | 0; CG = (CG + (242 - CG) * 0.72) | 0; CB = (CB + (236 - CB) * 0.72) | 0; }
      tri();
    }
    if (ZSAVE) { zbuf = ZSAVE; ZSAVE = null; VMASK = false; }
  }

  return {
    draw,
    stats: () => ({ tris, pxFilled, trisCulled, poseEntries: POSE.size, poseMB: +(poseBytes / 1048576).toFixed(2), poseMade, capMB: PCAP / 1048576,
      wGeo: WEPO.size, wMiss: wStat[0], wHit: wStat[1], wMB: +(wBytes / 1048576).toFixed(3), wQ: WQK, wCap: WPCAP }),
    reset: () => { tris = 0; pxFilled = 0; trisCulled = 0; },
    setCache: v => { CACHE = !!v; POSE.clear(); poseBytes = 0; poseMade = 0; return CACHE; },
    setWRaw: v => { WRAW = !!v; return WRAW; },          // probe-only (#186): make the key serve nothing
    setHands: v => { VHANDS = !!v; WEPO.clear(); wBytes = 0; return VHANDS; },   // probe-only (#499): emit the gun without its hands. THE CACHE GOES WITH THE SWITCH: geometry is keyed by pose alone, so a toggle that left WEPO filled would serve the OTHER arm's vertices and the A/B would measure nothing.
    trisFor: k => model(k || 'grunt').tris,
    // #78's readout: which kinds carry something, and how many sides the limbs get at the tier the page
    // is on. Both exist so a probe row can gate the detail instead of a screenshot describing it.
    heldKinds: () => Object.keys(SPEC).filter(k => SPEC[k].gun),
    limbSides: () => segLimbs(),
    foot: k => FOOT[k] || 0,
    vertsFor: k => model(k || 'grunt').nV,
    /* the view model's geometry: rebuilt per frame, never cached, and the numbers the probes need */
    weapon: (k, st) => weaponGeo(k, st),
    /* #186: the state the key's geometry is built at. The key and the build are the same function of the
       pose, and view.js's identity row asserts that from the outside against `weaponRaw`. */
    wQuant: st => wState(st),
    /* probe-only (#186): the builder with NO quantum applied, so a probe can measure the displacement the
       quantum is paid with instead of taking the arithmetic on faith. Nothing in the draw path calls this. */
    weaponRaw: (k, st) => { const b = VMGEO[k](new Builder(), st || {}); return { p: b.p, nV: b.p.length / 6 }; },
    muzzleFor: k => VMUZZLE[k],
    maxVerts: MAXV,
    /* the rest model's own extent in body space: its height span and its radius in plan. This is what
       lets a height claim about `scale` test the CONVENTION instead of the art, because a solid does not
       project to BH*span/t at its centre - its near edge is nearer than its centre, which is a thing a
       flat quad never had to say. Throws on an unauthored kind, like everything else here. */
    /* The band a body leaves to the neck, in fractions of body height, plus the tube's widest radius:
       [torso top face, head box bottom face, radius]. These are the numbers emit() builds the tube
       between, published so tools/view.js #80 measures the band the geometry paints instead of
       re-deriving its own. The third number is the window's half-width: the head box's own half-width,
       which contains the tube, the head's underside and the shoulders' top face but not the arms. */
    neckBand: k => { const s = SPEC[k] || SPEC.grunt; return [s.sh + s.headR * SHOULDER_LIFT, s.head - s.headR * 0.35, s.headR * HEAD_HW, neckR(s)]; },   // [bandLo, bandHi, plan window, AUTHORED tube half-width] - the 4th lets a probe measure the tube the mesh wrote rather than the envelope that paints over it (#80)
    spanFor: k => {
      const m = model(k);
      if (!m.span) {
        let y0 = 1e9, y1 = -1e9, r = 0;
        for (let i = 0; i < m.nV; i++) {
          const x = m.p[i * 6], y = m.p[i * 6 + 1], z = m.p[i * 6 + 2];
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          const d = Math.hypot(x, z); if (d > r) r = d;
        }
        m.span = { y0: y0, y1: y1, r: r };
      }
      return m.span;
    },
    PB,
    SPEC,
    DIEV,
    /* The pose the DRAW would produce, for tools/view.js `anim` (#274): the same bucketOf + poseOf
       the draw site goes through, so a row that reads this measures the vertex set an enemy is
       actually rasterized from - not a re-derivation of it. poseVerts returns a copy (a caller that
       wrote to it would otherwise poison the table); poseBucket returns {ph,mv,atk,die,dv}, the
       bucket indices that entry is keyed by. Both take the same options object as draw(). */
    poseVerts: o => poseOf(model(o.kind || 'grunt'), o).slice(),
    poseBucket: o => { const b = bucketOf(o); return { ph: b.ph, mv: b.mv, atk: b.ab, die: b.db, dv: b.dv }; },
  };
})();
