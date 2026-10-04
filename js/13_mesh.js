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
     shrinking the outline breaks the walk (both rejected, #232). Fades out below TS_MINP px. */
  const TS_CYC = 10, TS_MINP = 3.5, TS_SLOPE = 9, TS_MAX = 26, TS_BMIN = 0.45;
  const TSC = [0.80, 1.00, 1.15];                   // slightly cool seams on warm armour
  let TAMP = 0, TK = 0, ST = null, TQ0 = 0, TQ1 = 0, TQ2 = 0;
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
    const sva = this.rg ? ax + az : 0, svb = this.rg ? bx + bz : 0;   // #232 authored, before the transform
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
      this.p.push(ax + cx * ra, ay + cy * ra, az + cz * ra, c[0], c[1], c[2]); this.e.push(this.em); this.s.push(sva);
    }
    for (let i = 0; i < n; i++) {
      const cx = u[0] * RN[i * 2] + v[0] * RN[i * 2 + 1], cy = u[1] * RN[i * 2] + v[1] * RN[i * 2 + 1], cz = u[2] * RN[i * 2] + v[2] * RN[i * 2 + 1];
      this.p.push(bx + cx * rb, by + cy * rb, bz + cz * rb, c[0], c[1], c[2]); this.e.push(this.em); this.s.push(svb);
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
    for (const q of faces) {
      const b0 = this.p.length / 6;
      for (const qv of q) { const p = this.pt(qv[0], qv[1], qv[2]); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); this.e.push(this.em); this.s.push(this.rg ? qv[0] + qv[2] : 0); }
      this.t.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    return this;
  };

  /* a bipyramid - an octahedron when the radii agree: 6 vertices and 8 triangles against a box's 24,
     and the only primitive here that reads as a bulb or an energy cell rather than a crate. Props are
     the reason it exists; no body uses it. */
  Builder.prototype.bip = function (cx, cy, cz, rx, ry, rz, c) {
    const eq = this.p.length / 6;
    const put = (x, y, z) => { const p = this.pt(x, y, z); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); this.e.push(this.em); };
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
      const RED = [142, 54, 36], RIM = [74, 30, 22], YEL = [214, 172, 32], MET = [196, 204, 214];
      b.tube(0, 0.03, 0, 0, 0.50, 0, 0.225, 0.245, RED);       // the staves, bulging at the bilge
      b.tube(0, 0.50, 0, 0, 0.93, 0, 0.245, 0.215, RED);
      b.tube(0, 0.27, 0, 0, 0.33, 0, 0.255, 0.255, RIM);       // the two hoops
      b.tube(0, 0.66, 0, 0, 0.72, 0, 0.25, 0.25, RIM);
      b.tube(0, 0.42, 0, 0, 0.55, 0, 0.25, 0.25, YEL);         // the hazard band
      b.tube(0, 0.90, 0, 0, 0.97, 0, 0.225, 0.20, RIM);        // the lid
      b.box(0, 0.95, 0.11, 0.045, 0.02, 0.045, MET);           // the bung on it
      return b;
    },
    crate(b) {
      const WOOD = [158, 112, 64], FRAME = [70, 48, 24];
      b.box(0, 0.44, 0, 0.36, 0.40, 0.36, WOOD);               // the body, 0.04 to 0.84
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
  const VW = {
    steel: [44, 49, 58], dark: [26, 31, 39], black: [15, 18, 24], blue: [36, 42, 51],
    wood: [58, 44, 30], wood2: [51, 38, 26],
    skin: [140, 106, 79], skinD: [93, 69, 47], glove: [59, 66, 78], gloveD: [34, 40, 52],
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
  function vArm(b, x, y, z, s, back) {
    const w = back ? -1 : 1;
    b.tube(x + w * 0.004 * s, y - 0.022 * s, z - 0.002 * s, x + w * 0.058 * s, y - 0.320 * s, z - 0.095 * s,
      0.0155 * s, 0.0260 * s, VW.sleeve);              // to an elbow below the frame
    return b;
  }

  /* A hand wrapped round a part, emitted AFTER the gun for the same reason the art drew its hands
     last: the fingers have to read as IN FRONT of the grip they hold. Palm, the fingers curled over
     the far side as one block with two creases, thumb, cuff. The art drew four separate fingers and a
     knuckle ridge; at this size a mesh reads as a fist with creases in it, and separate finger tubes
     poked out of the palm silhouette on both sides and looked like floating tabs (measured in the
     first frames of this conversion). `s` sizes the WHOLE hand - offsets as well as extents, because
     a hand whose palm shrank but whose fingers stayed put is a hand with its fingers on the table. */
  function vHand(b, x, y, z, s, back) {
    const w = back ? -1 : 1;
    b.box(x, y, z, 0.020 * s, 0.024 * s, 0.022 * s, VW.glove);
    b.box(x + w * 0.021 * s, y - 0.004 * s, z, 0.010 * s, 0.020 * s, 0.020 * s, VW.skin);
    b.box(x + w * 0.030 * s, y - 0.013 * s, z, 0.0035 * s, 0.0035 * s, 0.019 * s, VW.skinD);
    b.box(x + w * 0.030 * s, y + 0.007 * s, z, 0.0035 * s, 0.0035 * s, 0.019 * s, VW.skinD);
    b.tube(x + w * 0.017 * s, y + 0.012 * s, z + 0.012 * s, x - w * 0.002 * s, y + 0.024 * s, z + 0.018 * s,
      0.0070 * s, 0.0055 * s, VW.skin);              // the thumb, along the top of the grip
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
      vArm(b, 0.010, -0.056, 0.006, 1.0, false);
      vArm(b, -0.024, -0.070, 0.052, 0.92, true);
      b.box(0, 0.007, 0.088, 0.0185, 0.0135, 0.086, VW.steel);          // the slide
      b.box(0, 0.0235, 0.088, 0.008, 0.0035, 0.070, VW.black);          // the serrated rib on top
      b.tube(0, 0.004, MU - 0.024, 0, 0.004, MU, 0.0115, 0.0105, VW.dark); // the barrel crown
      b.box(0, 0.004, MU, 0.0125, 0.0125, 0.004, VW.black);             // the muzzle face
      b.box(0, -0.017, 0.062, 0.0165, 0.0105, 0.060, VW.blue);          // the frame under the slide
      b.tube(0, -0.022, 0.038, 0, -0.118, -0.012, 0.0205, 0.018, VW.blue);  // the grip, raked back
      b.box(0, -0.132, -0.015, 0.018, 0.006, 0.016, VW.black);          // the magazine base plate
      b.tube(0, -0.030, 0.010, 0, -0.058, -0.014, 0.0055, 0.005, VW.dark);  // trigger guard, front leg
      b.tube(0, -0.058, -0.014, 0, -0.030, -0.028, 0.005, 0.005, VW.dark);  // and its rear leg
      b.box(-0.0135, 0.026, 0.014, 0.0042, 0.0075, 0.0055, VW.black);   // rear sight, left ear
      b.box(0.0135, 0.026, 0.014, 0.0042, 0.0075, 0.0055, VW.black);    // and right ear
      b.box(0, 0.026, 0.178, 0.0035, 0.0085, 0.0045, VW.black);         // the front post
      b.box(0, -0.006, -0.004, 0.008, 0.011, 0.010, VW.steel);          // the hammer
      if (s.slideBack) b.box(0, 0.014, 0.088 - s.slideBack * 0.026, 0.019, 0.008, 0.050, VW.dark);
      vHand(b, 0.010, -0.056, 0.006, 1.0, false);
      vHand(b, -0.024, -0.070, 0.052, 0.92, true);
      if (s.mz > 0.004) vFlash(b, s.mz, MU);
      return b;
    },
    /* M870 BREACHER. The art's two parallel tubes (bore above, mag tube below) are the silhouette;
       the pump travels on the lower one, which is what `pump` does to the geometry below. */
    shotgun(b, s) {
      const MU = VMUZZLE.shotgun, pu = (s.pump || 0) * 0.034;
      vArm(b, 0.004, -0.064, -0.002, 1.02, false);
      vArm(b, -0.006, -0.070, 0.270 + pu, 1.0, true);   // the pump hand's arm travels with the pump
      b.box(0, 0.004, 0.086, 0.0215, 0.0185, 0.082, VW.steel);          // the receiver
      b.box(0, 0.0235, 0.086, 0.011, 0.0045, 0.070, VW.black);          // the top rib
      b.tube(0, 0.004, 0.164, 0, 0.004, MU, 0.0135, 0.012, VW.dark);     // the barrel
      b.tube(0, -0.024, 0.150, 0, -0.024, MU - 0.032, 0.0135, 0.0125, VW.blue); // the magazine tube
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
      vHand(b, 0.004, -0.064, -0.002, 1.02, false);
      vHand(b, -0.006, -0.070, 0.270 + pu, 1.0, true);
      if (s.mz > 0.004) vFlash(b, s.mz, MU);
      return b;
    },
    /* VK-36 AUTOGUN. Longest reach of the three, which is the art's own ranking (muzzle at -436
       design units against the shotgun's -404 and the pistol's -338). */
    rifle(b, s) {
      const MU = VMUZZLE.rifle;
      vArm(b, 0.008, -0.062, 0.004, 1.0, false);
      vArm(b, -0.008, -0.066, 0.236, 0.98, true);
      b.box(0, 0.005, 0.092, 0.0235, 0.0195, 0.086, VW.steel);          // the upper receiver
      b.box(0, 0.0265, 0.092, 0.0155, 0.0055, 0.078, VW.black);         // the dust cover
      b.box(0, -0.004, 0.238, 0.0245, 0.020, 0.056, VW.blue);           // the handguard
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
      b.tube(0, -0.028, -0.006, 0, -0.112, 0.014, 0.021, 0.0185, VW.blue);   // the grip
      b.tube(0, -0.030, -0.014, 0, -0.062, -0.190, 0.0225, 0.0265, VW.blue); // the stock
      b.box(0, -0.076, -0.196, 0.021, 0.016, 0.010, VW.black);          // the butt pad
      vHand(b, 0.008, -0.062, 0.004, 1.0, false);
      vHand(b, -0.008, -0.066, 0.236, 0.98, true);
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
  function weaponGeo(kind, st) {
    const g = VMGEO[kind];
    if (!g) throw new Error('MESH: no view model authored for weapon "' + kind + '"');
    const b = g(new Builder(), st || {});
    const p = new Float32Array(b.p), v = new Float32Array(b.p.length / 2);
    for (let i = 0; i < b.p.length / 6; i++) { v[i * 3] = b.p[i * 6]; v[i * 3 + 1] = b.p[i * 6 + 1]; v[i * 3 + 2] = b.p[i * 6 + 2]; }
    return { kind, p, v, t: new Uint16Array(b.t), em: Uint8Array.from(b.e), nV: b.p.length / 6, tris: b.t.length / 3 };
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
    b.tube(0, shTop - JOIN, 0, 0, s.head + q.bob - s.headR * 0.35 + JOIN, 0, s.headR * NECK_R0, s.headR * NECK_R1, dk);
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
    const q = { bob: 0, pitch: 0, topple: 0, leg: [], arm: [] };
    q.bob = dying ? -die * dr.sk : -mv * 0.016 * Math.abs(Math.sin(p * TAU));
    q.pitch = dying ? 0 : atk * 0.20;
    q.topple = dying ? die * dr.tp : 0;               // the rig's die pitch, now about the ground line
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
    for (let i = 3; i < b.p.length; i += 6) {
      b.p[i] = Math.min(255, b.p[i] * 1.35 + 6);
      b.p[i + 1] = Math.min(255, b.p[i + 1] * 1.35 + 6);
      b.p[i + 2] = Math.min(255, b.p[i + 2] * 1.35 + 6);
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

  function poseOf(m, o) {
    const ph = Math.floor(((((o.p || 0) % 1) + 1) % 1) * PB.ph);
    const mv = Math.min(PB.mv - 1, (clamp(o.mv || 0, 0, 0.999) * PB.mv) | 0);
    const ab = Math.min(PB.atk - 1, (clamp(o.atk || 0, 0, 0.999) * PB.atk) | 0);
    const db = Math.min(PB.die - 1, (clamp(o.die || 0, 0, 0.999) * PB.die) | 0);
    /* A corpse has no gait: once die > 0.01 joints() reads NONE of p, mv or atk, so for a dying
       body those three buckets are collapsed out of the key and the death variant goes in. That is
       exact rather than approximate - the vertices cannot depend on them - and it is what pays for
       DIEV: 5 buckets x 3 variants per kind replaces the 96 entries per phase that main keyed and
       built for one and the same corpse. */
    const dv = db > 0 ? ((o.dv | 0) % DIEV + DIEV) % DIEV : 0;
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
        if (TK && SOLID) {
          // the zero-mean seam: (1-w1-w2)*TQ0 + w1*TQ1 + w2*TQ2 is the body coord under the pixel
          let u = (1 - w1 - w2) * TQ0 + w1 * TQ1 + w2 * TQ2;
          u -= Math.floor(u);
          const kk = (u < 0.5 ? u * 4 - 1 : 3 - u * 4) * TK;
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
     A prebuilt model has no pose table, no death variant and no kind in SPEC. */
    const m = o.mdl || model(o.kind || 'grunt'), sc = o.scale || 1,
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
    /* The ramp a face's light rides. A body's sprites carried a curvature term, so 0.30+0.85*d is that
       path's own history and stays; a PROP's sprite had NO normal at all - drawBillboard's lr is
       AMB + 1.1*li*lt, flat - so borrowing the body's ramp darkened every prop face turned away from KEY
       by up to 3.7x, which is how a hazard-red drum came out the colour of dried mud. Measured at one
       camera, brightest tenth of the silhouette: barrel 99 -> 79, crate 101 -> 51. 0.75+0.42*d keeps the
       directionality a solid needs (a face along the key is still 1.5x one facing off it) and lands the
       average where the painted sheet was. */
    const pg = !MDL && PROPGEO[o.kind] !== undefined;
    R0 = MDL ? 0.55 : (pg ? 0.75 : 0.30); R1 = MDL ? 0.55 : (pg ? 0.42 : 0.85);
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
       Below TS_MINP px the term is off rather than aliased - that is the fade a mip chain is for a
       wall texture, and here it is two lines instead of a chain. */
    const TPR = BH * sc / (Math.max(NEAR, Math.abs(tYc)) * TS_CYC);
    TAMP = !ST || TPR <= TS_MINP ? 0 : Math.min(TS_MAX, TS_SLOPE * TPR * 0.25);
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
       or the room behind a door - would make the gun dim when it points at a wall. */
    const cc = o.cell === undefined ? cellIdx(o.x, o.y) : o.cell;
    const lt = cellTint(cc), lm = MAP.light;
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
      } else {
        const li = Math.min(1, (lm ? lm[cc] : 0.5) * Math.exp(-dc * 0.14) + 0.30 * visAt(dc));
        const sh = R0 + R1 * d;
        const fk = FL ? FL * 1.1 * Math.exp(-dc * 0.30) : 0;
        lr = (AMB + li * lt[0] * sh + fk * (FC[0] / 255)) * inv;
        lg = (AMB + li * lt[1] * sh + fk * (FC[1] / 255)) * inv;
        lb = (AMB + li * lt[2] * sh + fk * (FC[2] / 255)) * inv;
        if (DIM) { lr *= 1 - DIM; lg *= 1 - DIM; lb *= 1 - DIM; }   // the portal's shut-and-dimmed term
        if (TINT) { lr *= TINT[0]; lg *= TINT[1]; lb *= TINT[2]; }
        if (FLR > lr) lr = FLR;
        if (FLR > lg) lg = FLR;
        if (FLR > lb) lb = FLR;
      }
      const packed = PD[i0 * 6 + 3] << 16 | PD[i0 * 6 + 4] << 8 | PD[i0 * 6 + 5];
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
      if (TAMP) {
        const sa = ST[i0], sb = ST[i1], sz = ST[i2];
        if (sa !== 0 || sb !== 0 || sz !== 0) {
          const q = 1 - Math.min(1, vd / Math.max(1e-6, Math.hypot(evx, evy, evz)));
          TK = TAMP * (TS_BMIN + (1 - TS_BMIN) * q);
          TQ0 = sa * TS_CYC; TQ1 = sb * TS_CYC; TQ2 = sz * TS_CYC;
        } else TK = 0;
      } else TK = 0;
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
    stats: () => ({ tris, pxFilled, trisCulled, poseEntries: POSE.size, poseMB: +(poseBytes / 1048576).toFixed(2), poseMade, capMB: PCAP / 1048576 }),
    reset: () => { tris = 0; pxFilled = 0; trisCulled = 0; },
    setCache: v => { CACHE = !!v; POSE.clear(); poseBytes = 0; poseMade = 0; return CACHE; },
    trisFor: k => model(k || 'grunt').tris,
    // #78's readout: which kinds carry something, and how many sides the limbs get at the tier the page
    // is on. Both exist so a probe row can gate the detail instead of a screenshot describing it.
    heldKinds: () => Object.keys(SPEC).filter(k => SPEC[k].gun),
    limbSides: () => segLimbs(),
    foot: k => FOOT[k] || 0,
    vertsFor: k => model(k || 'grunt').nV,
    /* the view model's geometry: rebuilt per frame, never cached, and the numbers the probes need */
    weapon: (k, st) => weaponGeo(k, st),
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
    neckBand: k => { const s = SPEC[k] || SPEC.grunt; return [s.sh + s.headR * SHOULDER_LIFT, s.head - s.headR * 0.35, s.headR * HEAD_HW]; },
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
  };
})();
