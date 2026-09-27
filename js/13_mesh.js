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

  /* How far a part reaches INTO the part it joins, in fractions of body height (#74). Parts that
     butt exactly leave a seam that opens at oblique yaw, because each box's silhouette edge is
     solved on its own; an overlap makes the junction one silhouette at every angle. */
  const JOIN = 0.02;

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
  let ALPHA = 1, FLASH = 0, TINT = null;               // per-draw terms the enemy list carries
  let EMIS = false, DIM = 0, EM = null;                // the light-exempt registers: entry-wide, per-vertex
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
    ax = p0x; ay = p0y; az = p0z; bx = pb[0]; by = pb[1]; bz = pb[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    dx /= L; dy /= L; dz /= L;
    // two orthogonals to the axis; pick the ref axis furthest from it for stability
    const ref = Math.abs(dy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = B.cross(dx, dy, dz, ref[0], ref[1], ref[2]);
    const UL = Math.hypot(u[0], u[1], u[2]) || 1e-6; u = [u[0] / UL, u[1] / UL, u[2] / UL];
    const v = B.cross(dx, dy, dz, u[0], u[1], u[2]);
    const base = this.p.length / 6;
    for (let i = 0; i < NS; i++) {
      const cx = u[0] * RC[i * 2] + v[0] * RC[i * 2 + 1], cy = u[1] * RC[i * 2] + v[1] * RC[i * 2 + 1], cz = u[2] * RC[i * 2] + v[2] * RC[i * 2 + 1];
      this.p.push(ax + cx * ra, ay + cy * ra, az + cz * ra, c[0], c[1], c[2]); this.e.push(this.em);
    }
    for (let i = 0; i < NS; i++) {
      const cx = u[0] * RC[i * 2] + v[0] * RC[i * 2 + 1], cy = u[1] * RC[i * 2] + v[1] * RC[i * 2 + 1], cz = u[2] * RC[i * 2] + v[2] * RC[i * 2 + 1];
      this.p.push(bx + cx * rb, by + cy * rb, bz + cz * rb, c[0], c[1], c[2]); this.e.push(this.em);
    }
    for (let i = 0; i < NS; i++) {
      const j = (i + 1) % NS;
      this.t.push(base + i, base + NS + i, base + NS + j, base + i, base + NS + j, base + j);
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
      for (const qv of q) { const p = this.pt(qv[0], qv[1], qv[2]); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); this.e.push(this.em); }
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

  /* ---- one body from one pose -------------------------------------------------
     One skeleton for every kind - hound and brute have always been proportional variations of the
     grunt here, so a single gait function drives all three and SPEC supplies the lengths. The
     VERTEX ORDER this function produces is what lets a cached pose share the rest model's colour
     and index arrays: every call runs the same emits in the same order, only the numbers differ. */
  function emit(kind, q) {
    const s = SPEC[kind], sk = SKIN[kind], dk = DARK[kind], cl = CLOTH[kind];
    const b = new Builder(), hipY = s.hip + q.bob, shY = s.sh + q.bob;
    b.tip(q.topple, 0.02, 0);                        // a corpse turns about its CONTACT LINE, at the feet
    for (let i = 0; i < 2; i++) {
      const L = q.leg[i], hx = (i ? 1 : -1) * s.hipLat;
      // leg: hip -> knee -> foot, swung by the gait (these were straight: "animation plugs in here")
      b.tube(hx, hipY, 0, L.kx, L.ky, L.kz, s.limb, s.limb * 0.86, cl);
      b.tube(L.kx, L.ky, L.kz, L.fx, L.fy, L.fz, s.limb * 0.86, s.limb * 0.7, cl);
      b.box(L.fx, Math.max(0.03, L.fy + 0.01), L.fz + 0.04, s.limb * 1.1, 0.03, s.limb * 1.8, dk);
    }
    b.tip(q.pitch, hipY, 0);                         // the wind-up tips everything above the hip
    b.box(0, (hipY + shY) * 0.5, 0, s.shLat * 1.05, (shY - hipY) * 0.5, s.torso * 0.42, sk);
    b.box(0, hipY + 0.02, 0, s.hipLat * 1.3, 0.045, s.torso * 0.34, dk);
    /* The neck. The torso box ends at the shoulder line and the head box starts above it, and what
       sat between them was the level behind: 9 rows of daylight on a grunt at 2.4 m (#74). This
       spans the whole gap plus JOIN into each end, so the junction is solid at any yaw - a prism
       silhouette is convex and the body axis is inside the prism, so that column is covered by
       construction. Emitted between the two boxes it stitches, and the emit ORDER is the pose
       table's vertex order, so it stays here rather than moving with the head. */
    b.tube(0, shY - JOIN, 0, 0, s.head + q.bob - s.headR * 0.35 + JOIN, 0, s.headR * 0.52, s.headR * 0.46, dk);
    b.box(0, s.head + q.bob + s.headR * 0.6, 0, s.headR * 0.86, s.headR * 0.95, s.headR * 0.80, dk);
    b.box(0, s.head + q.bob + s.headR * 0.7, s.headR * 0.72, s.headR * 0.62, s.headR * 0.30, s.headR * 0.22, [255, 208, 138]);
    for (let i = 0; i < 2; i++) {
      const A = q.arm[i], ax = (i ? 1 : -1) * s.shLat;
      b.tube(ax, shY, 0, A.ex, A.ey, A.ez, s.arm, s.arm * 0.86, sk);
      b.tube(A.ex, A.ey, A.ez, A.hx, A.hy, A.hz, s.arm * 0.86, s.arm * 0.7, sk);
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
    if (MODELS[kind]) return MODELS[kind];
    /* NO fallback. This used to read SPEC[kind] || SPEC.grunt, so a kind nobody authored answered with
       a grunt - a prop converted by mistake would have shipped as a small grey soldier, which is the
       failure #76 asks to make loud. A missing row is a bug in the caller, so it throws. */
    if (!SPEC[kind] && !PROPGEO[kind]) throw new Error('MESH: no geometry authored for kind "' + kind + '"');
    const b = geoFor(kind, 0, 0, 0, 0, 0);
    const mdl = { kind, p: new Float32Array(b.p), t: new Uint16Array(b.t), em: Uint8Array.from(b.e), nV: b.p.length / 6, tris: b.t.length / 3 };
    MODELS[kind] = mdl;
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
    const key = db > 0 ? m.kind + '|d' + dv + '|' + db
      : m.kind + '|' + ph + '|' + mv + '|' + ab;
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
    const COL = (255 << 24 | CB << 16 | CG << 8 | CR) >>> 0;
    const A = ALPHA, IA = 1 - A, SOLID = A >= 1;      // hoisted: the blend is a corpse's, not the rule
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
        if (SOLID) px[off] = COL;
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
  function draw(o) {
    const m = model(o.kind || 'grunt'), sc = o.scale || 1;
    /* The variant's FALL DIRECTION rides in the yaw, which is free: the yaw is applied to the
       cached verts below and is not in the key, so "topples onto its own side" is the same vertex
       set turned a quarter turn rather than a third of the table again (that lever is why the
       cache grows by 10 sets and not 3x). Only a body that is actually in a death bucket gets
       one - a live enemy's heading must never move because of a corpse field. */
    const yaw = (o.die || 0) >= 1 / PB.die ? (o.yaw || 0) + dieRow(o.kind || 'grunt', o.dv).yw : (o.yaw || 0);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    SELF = o.self === undefined ? true : !!o.self;
    /* EMIS is the entry-wide form of the exemption and EM the per-part one; either is enough to put a
       triangle's pixels on the billboard's light-free path. The billboard reaches it through a texel
       whose alpha byte is 253 or through o.self (js/40_render.js:703), and a mesh has neither, so
       without these the orb, the portal and a lamp's bulb would be multiplied by scene light - which
       is darkest in exactly the rooms where they are the only light source (js/40_render.js:703, and
       #33 for the same floor under AMB). */
    EMIS = !!o.emis; DIM = o.dim || 0; EM = m.em;
    /* The ramp a face's light rides. A body's sprites carried a curvature term, so 0.30+0.85*d is that
       path's own history and stays; a PROP's sprite had NO normal at all - drawBillboard's lr is
       AMB + 1.1*li*lt, flat - so borrowing the body's ramp darkened every prop face turned away from KEY
       by up to 3.7x, which is how a hazard-red drum came out the colour of dried mud. Measured at one
       camera, brightest tenth of the silhouette: barrel 99 -> 79, crate 101 -> 51. 0.75+0.42*d keeps the
       directionality a solid needs (a face along the key is still 1.5x one facing off it) and lands the
       average where the painted sheet was. */
    const pg = PROPGEO[o.kind] !== undefined;
    R0 = pg ? 0.75 : 0.30; R1 = pg ? 0.42 : 0.85;
    ALPHA = o.alpha === undefined ? 1 : o.alpha;
    FLASH = o.flash ? 1 : 0;
    TINT = o.tint || null;
    const PD = m.p, T = m.t, nV = Math.min(m.nV, MAXV);    cam.x = camX; cam.y = camY; cam.dirX = dirX; cam.dirY = dirY; cam.planeX = planeX; cam.planeY = planeY;
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
    const PP = poseOf(m, o);
    for (let i = 0; i < nV; i++) {
      const bx = PP[i * 3], by = PP[i * 3 + 1], bz = PP[i * 3 + 2];
      VX[i] = o.x + (bx * cyw + bz * syw) * sc;
      VY[i] = o.y + (-bx * syw + bz * cyw) * sc;
      VZ[i] = o.z + by * sc;
    }
    const lt = cellTint(cellIdx(o.x, o.y)), lm = MAP.light;
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
      if (nx * (camX - VX[i0]) + ny * (camY - VY[i0]) + nz * (eyeZ - VZ[i0]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
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
        const li = Math.min(1, (lm ? lm[cellIdx(o.x, o.y)] : 0.5) * Math.exp(-dc * 0.14) + 0.30 * visAt(dc));
        const sh = R0 + R1 * d;
        const fk = FL ? FL * 1.1 * Math.exp(-dc * 0.30) : 0;
        lr = (AMB + li * lt[0] * sh + fk * (FC[0] / 255)) * inv;
        lg = (AMB + li * lt[1] * sh + fk * (FC[1] / 255)) * inv;
        lb = (AMB + li * lt[2] * sh + fk * (FC[2] / 255)) * inv;
        if (DIM) { lr *= 1 - DIM; lg *= 1 - DIM; lb *= 1 - DIM; }   // the portal's shut-and-dimmed term
        if (TINT) { lr *= TINT[0]; lg *= TINT[1]; lb *= TINT[2]; }
      }
      const packed = PD[i0 * 6 + 3] << 16 | PD[i0 * 6 + 4] << 8 | PD[i0 * 6 + 5];
      let r = (packed >> 16 & 255) * lr + FOGC[0] * fog; CR = r > 255 ? 255 : r | 0;
      let g = (packed >> 8 & 255) * lg + FOGC[1] * fog; CG = g > 255 ? 255 : g | 0;
      let b = (packed & 255) * lb + FOGC[2] * fog; CB = b > 255 ? 255 : b | 0;
      // the hit flash the billboard applied per pixel is per triangle here: a flat-shaded face has
      // one colour, so the same 0.72 pull toward white after fog lands in the three registers
      if (FLASH) { CR = (CR + (250 - CR) * 0.72) | 0; CG = (CG + (242 - CG) * 0.72) | 0; CB = (CB + (236 - CB) * 0.72) | 0; }
      tri();
    }
  }

  return {
    draw,
    stats: () => ({ tris, pxFilled, trisCulled, poseEntries: POSE.size, poseMB: +(poseBytes / 1048576).toFixed(2), poseMade, capMB: PCAP / 1048576 }),
    reset: () => { tris = 0; pxFilled = 0; trisCulled = 0; },
    setCache: v => { CACHE = !!v; POSE.clear(); poseBytes = 0; poseMade = 0; return CACHE; },
    trisFor: k => model(k || 'grunt').tris,
    vertsFor: k => model(k || 'grunt').nV,
    /* the rest model's own extent in body space: its height span and its radius in plan. This is what
       lets a height claim about `scale` test the CONVENTION instead of the art, because a solid does not
       project to BH*span/t at its centre - its near edge is nearer than its centre, which is a thing a
       flat quad never had to say. Throws on an unauthored kind, like everything else here. */
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
