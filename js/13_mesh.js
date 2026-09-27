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
  const SPEC = {
    grunt: { aspect: 0.62, hip: 0.50, sh: 0.815, head: 0.915, headR: 0.068, torso: 0.235, hipLat: 0.055, shLat: 0.098, thigh: 0.245, shin: 0.235, upper: 0.175, fore: 0.165, limb: 0.040, arm: 0.031 },
    hound: { aspect: 1.02, hip: 0.50, sh: 0.72, head: 0.80, headR: 0.095, torso: 0.48, hipLat: 0.10, shLat: 0.13, thigh: 0.21, shin: 0.21, upper: 0.17, fore: 0.17, limb: 0.038, arm: 0.034 },
    brute: { aspect: 0.80, hip: 0.44, sh: 0.775, head: 0.855, headR: 0.080, torso: 0.33, hipLat: 0.075, shLat: 0.16, thigh: 0.205, shin: 0.20, upper: 0.20, fore: 0.18, limb: 0.052, arm: 0.046 },
  };
  // js/11_rig.js COL: SKIN=armor, DARK=dark, CLOTH=cloth, decoded to numbers
  const SKIN = { grunt: [58, 66, 80], hound: [65, 82, 47], brute: [67, 48, 79] };
  const DARK = { grunt: [35, 42, 53], hound: [35, 44, 26], brute: [36, 26, 44] };
  const CLOTH = { grunt: [74, 85, 104], hound: [92, 112, 64], brute: [90, 64, 104] };

  const NS = 6;                                    // tube sides; 6 keeps <=260 tris/enemy
  const RC = new Float32Array(NS * 2);
  for (let i = 0; i < NS; i++) { const a = i * Math.PI * 2 / NS; RC[i * 2] = Math.cos(a); RC[i * 2 + 1] = Math.sin(a); }

  // boot-time drift detector: these three numbers must match js/11_rig.js SPEC
  const SRC = { hip: 0.50, torso: 0.235, limb: 0.040 };
  if (SPEC.grunt.hip !== SRC.hip || SPEC.grunt.torso !== SRC.torso || SPEC.grunt.limb !== SRC.limb)
    console.warn('MESH SPEC drifted from js/11_rig.js SPEC');

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
    this.ca = 1; this.sa = 0;                       // rotation about x, positive tips the up axis forward
    this.cx = 0; this.cy = 0; this.cz = 0;
  }
  const B = { cross: (ax, ay, az, bx, by, bz) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx] };

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
      this.p.push(ax + cx * ra, ay + cy * ra, az + cz * ra, c[0], c[1], c[2]);
    }
    for (let i = 0; i < NS; i++) {
      const cx = u[0] * RC[i * 2] + v[0] * RC[i * 2 + 1], cy = u[1] * RC[i * 2] + v[1] * RC[i * 2 + 1], cz = u[2] * RC[i * 2] + v[2] * RC[i * 2 + 1];
      this.p.push(bx + cx * rb, by + cy * rb, bz + cz * rb, c[0], c[1], c[2]);
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
      for (const qv of q) { const p = this.pt(qv[0], qv[1], qv[2]); this.p.push(p[0], p[1], p[2], c[0], c[1], c[2]); }
      this.t.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    return this;
  };

  /* ---- one body from one pose -------------------------------------------------
     One skeleton for every kind - hound and brute have always been proportional variations of the
     grunt here, so a single gait function drives all three and SPEC supplies the lengths. The
     VERTEX ORDER this function produces is what lets a cached pose share the rest model's colour
     and index arrays: every call runs the same emits in the same order, only the numbers differ. */
  function emit(kind, q) {
    const s = SPEC[kind] || SPEC.grunt, sk = SKIN[kind] || SKIN.grunt, dk = DARK[kind] || DARK.grunt, cl = CLOTH[kind] || CLOTH.grunt;
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
  function joints(kind, p, mv, atk, die) {
    const s = SPEC[kind] || SPEC.grunt, dying = die > 0.01;
    const q = { bob: 0, pitch: 0, topple: 0, leg: [], arm: [] };
    q.bob = dying ? -die * 0.02 : -mv * 0.016 * Math.abs(Math.sin(p * TAU));
    q.pitch = dying ? 0 : atk * 0.20;
    q.topple = dying ? die * 1.35 : 0;                // the rig's die pitch, now about the ground line
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1, a2 = p * TAU + (i ? Math.PI : 0);
      const sw = dying ? -0.45 * side : Math.sin(a2) * (0.06 + 0.30 * mv);
      const lift = dying ? 0 : 0.05 * mv * Math.max(0, Math.sin(a2 + 0.6));
      const bend = dying ? 0.85 : 0.02 + 0.6 * mv * Math.max(0, Math.sin(a2 + 1.05));
      const kx = side * s.hipLat * 0.8, ky = s.hip + q.bob - s.thigh * Math.cos(sw) + lift;
      const kz = s.thigh * Math.sin(sw) + 0.01, sa2 = sw - bend;
      q.leg.push({ kx, ky, kz, fx: kx, fy: ky - s.shin * Math.cos(sa2), fz: kz + s.shin * Math.sin(sa2) });
      const aa = dying ? 0.5 : Math.sin(a2 + Math.PI) * (0.05 + 0.26 * mv) + atk * 1.15;
      const ax = side * s.shLat, ay = s.sh + q.bob;
      const ey = ay - s.upper * Math.cos(aa), ez = s.upper * Math.sin(aa) + 0.02;
      const sa3 = aa + (dying ? -0.2 : 0.24 - 0.18 * atk);
      q.arm.push({ ex: ax * 1.05, ey, ez, hx: ax * 1.1, hy: ey - s.fore * Math.cos(sa3), hz: ez + s.fore * Math.sin(sa3) });
    }
    return q;
  }

  /* ---- per-kind rest model: topology, colours and the vertex count everything else keys on ---- */
  const MODELS = {};
  function model(kind) {
    if (MODELS[kind]) return MODELS[kind];
    const b = emit(kind, joints(kind, 0, 0, 0, 0));
    const mdl = { kind, p: new Float32Array(b.p), t: new Uint16Array(b.t), nV: b.p.length / 6, tris: b.t.length / 3 };
    MODELS[kind] = mdl;
    return mdl;
  }

  /* ---- pose table: one vertex set per phase bucket ---------------------------
     The amortization the rig had (js/11_rig.js BUCKETS + its LRU pose cache), moved from textures
     to vertices: 8 gait phases x 3 move levels x 4 attack x 6 death per kind, built on first sight
     and LRU-evicted under a byte cap, so a moving enemy costs a Map hit and an array read instead
     of a vertex rebuild. Buckets are ENDPOINTS except the gait phase, which is periodic: bucket i
     is phase i/8, and mv/atk/die run 0..1 so the last bucket is a full stride, a full extension
     and a flat corpse. `MESH.setCache(false)` turns the table off, which is the rebuild-per-frame
     half of the cost A/B (#73 acceptance). */
  const PB = { ph: 8, mv: 3, atk: 4, die: 6 };
  const POSE = new Map();
  const PCAP = 4 << 20;
  let poseBytes = 0, poseMade = 0, CACHE = true;

  function buildPose(m, p, mv, atk, die) {
    const b = emit(m.kind, joints(m.kind, p, mv, atk, die));
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
    if (!CACHE) return buildPose(m, ph / PB.ph, mv / (PB.mv - 1), ab / (PB.atk - 1), db / (PB.die - 1));
    const key = m.kind + '|' + ph + '|' + mv + '|' + ab + '|' + db;
    const hit = POSE.get(key);
    if (hit !== undefined) { POSE.delete(key); POSE.set(key, hit); return hit; }
    // evict before building, the rig's lesson: a cache that can only shrink on an insert stalls
    while (poseBytes > PCAP && POSE.size > 8) {
      const old = POSE.entries().next().value;
      POSE.delete(old[0]); poseBytes -= old[1].byteLength;
    }
    const v = buildPose(m, ph / PB.ph, mv / (PB.mv - 1), ab / (PB.atk - 1), db / (PB.die - 1));
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

  /* draw one mesh. opts: {kind,x,y,z,yaw,scale,self,alpha,flash,tint, p,mv,atk,die}
     alpha < 1 blends (the corpse fade); flash is the hit term folded into the flat colour the
     way the billboard did it; tint is that enemy's per-individual colour jitter. p/mv/atk/die are
     the gait phase, the move amount, the attack progress and the death progress - the same four
     signals the billboard fed js/11_rig.js - and they select a cached vertex set, not a rebuild. */
  function draw(o) {
    const m = model(o.kind || 'grunt'), sc = o.scale || 1, cyw = Math.cos(o.yaw || 0), syw = Math.sin(o.yaw || 0);
    SELF = o.self === undefined ? true : !!o.self;
    ALPHA = o.alpha === undefined ? 1 : o.alpha;
    FLASH = o.flash ? 1 : 0;
    TINT = o.tint || null;
    const PD = m.p, T = m.t, nV = Math.min(m.nV, MAXV);
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
       the vertex set's (js/40_render.js). */
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
      const li = Math.min(1, (lm ? lm[cellIdx(o.x, o.y)] : 0.5) * Math.exp(-dc * 0.14) + 0.30 * visAt(dc));
      const fog = fogAt(dc), inv = 1 - fog;
      const sh = 0.30 + 0.85 * d;
      const fk = FL ? FL * 1.1 * Math.exp(-dc * 0.30) : 0;
      let lr = (AMB + li * lt[0] * sh + fk * (FC[0] / 255)) * inv;
      let lg = (AMB + li * lt[1] * sh + fk * (FC[1] / 255)) * inv;
      let lb = (AMB + li * lt[2] * sh + fk * (FC[2] / 255)) * inv;
      if (TINT) { lr *= TINT[0]; lg *= TINT[1]; lb *= TINT[2]; }
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
    stats: () => ({ tris, pxFilled, trisCulled, poseEntries: POSE.size, poseMB: +(poseBytes / 1048576).toFixed(2), poseMade }),
    reset: () => { tris = 0; pxFilled = 0; trisCulled = 0; },
    setCache: v => { CACHE = !!v; POSE.clear(); poseBytes = 0; poseMade = 0; return CACHE; },
    trisFor: k => model(k || 'grunt').tris,
    vertsFor: k => model(k || 'grunt').nV,
    PB,
    SPEC,
  };
})();
