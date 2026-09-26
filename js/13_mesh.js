/* ==================================================================
   Procedural 3D character meshes + a software triangle rasterizer.

   Why this exists: js/11_rig.js draws characters as flat billboards whose
   "yaw" is one of 8 buckets, each a re-layout of the skeleton in 2D. This
   path builds the same proportions as volumetric geometry, so a body has
   sides, self-shadowing and a real depth per pixel.

   Nothing here is wired into ENEMIES yet: DEV.mesh() is the only caller, so
   the billboard path is untouched and can be A/B'd against this one.
   ==================================================================*/
const MESH = (function () {

  // proportions in fractions of total body height - kept in sync by the assert below
  const SPEC = {
    grunt: { aspect: 0.62, hip: 0.50, sh: 0.815, head: 0.915, headR: 0.068, torso: 0.235, hipLat: 0.055, shLat: 0.098, thigh: 0.245, shin: 0.235, upper: 0.175, fore: 0.165, limb: 0.040, arm: 0.031 },
    hound: { aspect: 1.02, hip: 0.50, sh: 0.72, head: 0.80, headR: 0.095, torso: 0.48, hipLat: 0.10, shLat: 0.13, thigh: 0.21, shin: 0.21, upper: 0.17, fore: 0.17, limb: 0.038, arm: 0.034 },
    brute: { aspect: 0.80, hip: 0.44, sh: 0.775, head: 0.855, headR: 0.080, torso: 0.33, hipLat: 0.075, shLat: 0.16, thigh: 0.205, shin: 0.20, upper: 0.20, fore: 0.18, limb: 0.052, arm: 0.046 },
  };
  const SKIN = { grunt: [58, 66, 80], hound: [65, 82, 47], brute: [67, 48, 79] };
  const DARK = { grunt: [35, 42, 53], hound: [35, 44, 26], brute: [36, 26, 44] };
  const CLOTH = { grunt: [74, 85, 104], hound: [92, 112, 64], brute: [90, 64, 104] };

  const NS = 6;                                    // tube sides; 6 keeps <=260 tris/enemy
  const RC = new Float32Array(NS * 2);
  for (let i = 0; i < NS; i++) { const a = i * Math.PI * 2 / NS; RC[i * 2] = Math.cos(a); RC[i * 2 + 1] = Math.sin(a); }

  // boot-time drift detector: these three numbers must match js/11_rig.js SPEC
  const SRC = { hip: 0.50, torso: 0.235, limb: 0.040 };
  if (SPEC.grunt.hip !== SRC.hip || SPEC.grunt.torso !== SRC.torso || SPEC.grunt.limb !== SRC.limb)
    console.warn('MESH SPEC drifted from js/11_rig.js:19');

  /* scratch: camera-space verts (tX,tY,z) and world verts, per triangle */
  const TX = new Float32Array(32), TY = new Float32Array(32), TZ = new Float32Array(32);
  const sx = new Float32Array(8), sy = new Float32Array(8), iz = new Float32Array(8);
  // per-mesh vertex scratch, sized for the widest model (no per-frame allocation)
  const MAXV = 1024;
  const VX = new Float32Array(MAXV), VY = new Float32Array(MAXV), VZ = new Float32Array(MAXV), VC = new Float32Array(MAXV);
  const cam = { x: 0, y: 0, dirX: 0, dirY: 0, planeX: 0, planeY: 0, invDet: 1, tx: 0, ty: 0, tz: 0 };

  let tris = 0, pxFilled = 0;

  /* ---- geometry emit: tubes and boxes into a flat vertex/index list ---- */
  function Builder() {
    this.p = [];                                    // x,y,z,r,g,b
    this.t = [];                                    // i0,i1,i2
  }
  const B = { cross: (ax, ay, az, bx, by, bz) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx] };

  /* tapered tube from a to b (body space, y up), radii ra->rb, colour c */
  Builder.prototype.tube = function (ax, ay, az, bx, by, bz, ra, rb, c) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
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
      for (const qv of q) this.p.push(qv[0], qv[1], qv[2], c[0], c[1], c[2]);
      this.t.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    return this;
  };

  /* ---- per-kind model: a biped built from the SPEC fractions ---- */
  const MODELS = {};
  function model(kind) {
    if (MODELS[kind]) return MODELS[kind];
    const s = SPEC[kind] || SPEC.grunt, sk = SKIN[kind] || SKIN.grunt, dk = DARK[kind] || DARK.grunt, cl = CLOTH[kind] || CLOTH.grunt;
    const b = new Builder();
    const hipY = s.hip, shY = s.sh, bodyZ = 0;
    // torso: a slab from hip to shoulder, wider at the shoulders
    b.box(0, (hipY + shY) * 0.5, bodyZ, s.shLat * 1.05, (shY - hipY) * 0.5, s.torso * 0.42, sk);
    b.box(0, hipY + 0.02, bodyZ, s.hipLat * 1.3, 0.045, s.torso * 0.34, dk);
    // head + a visor plate so the front is readable
    b.box(0, s.head + s.headR * 0.6, bodyZ, s.headR * 0.86, s.headR * 0.95, s.headR * 0.80, dk);
    b.box(0, s.head + s.headR * 0.7, bodyZ + s.headR * 0.72, s.headR * 0.62, s.headR * 0.30, s.headR * 0.22, [255, 208, 138]);
    for (const side of [-1, 1]) {
      // leg: hip -> knee -> foot, straight for the spike (animation plugs in here)
      const hx = side * s.hipLat, kx = side * s.hipLat * 0.8;
      b.tube(hx, hipY, 0, kx, hipY - s.thigh, 0.01, s.limb, s.limb * 0.86, cl);
      b.tube(kx, hipY - s.thigh, 0.01, kx, Math.max(0.02, hipY - s.thigh - s.shin), 0.02, s.limb * 0.86, s.limb * 0.7, cl);
      b.box(kx, 0.03, 0.06, s.limb * 1.1, 0.03, s.limb * 1.8, dk);
      // arm: shoulder -> elbow -> hand
      const ax = side * s.shLat;
      b.tube(ax, shY, 0, ax * 1.05, shY - s.upper, 0.02, s.arm, s.arm * 0.86, sk);
      b.tube(ax * 1.05, shY - s.upper, 0.02, ax * 1.1, shY - s.upper - s.fore, 0.06, s.arm * 0.86, s.arm * 0.7, sk);
    }
    const mdl = { kind, p: new Float32Array(b.p), t: new Uint16Array(b.t), nV: b.p.length / 6, tris: b.t.length / 3 };
    MODELS[kind] = mdl;
    return mdl;
  }

  /* ---- triangle rasterizer: flat shading, per-pixel 1/z, near-plane clip ---- */
  const NEAR = 0.12;

  function tri(c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z, col) {
    // camera-space verts live in TX/TY/TZ; clip against TY >= NEAR first
    let n = 0;
    const px = [c0x, c1x, c2x], py = [c0y, c1y, c2y], pz = [c0z, c1z, c2z];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const inside = py[i] >= NEAR;
      if (inside) { TX[n] = px[i]; TY[n] = py[i]; TZ[n] = pz[i]; n++; }
      if (inside !== (py[j] >= NEAR)) {
        const t = (NEAR - py[i]) / (py[j] - py[i]);
        TX[n] = px[i] + (px[j] - px[i]) * t; TY[n] = NEAR; TZ[n] = pz[i] + (pz[j] - pz[i]) * t; n++;
      }
    }
    if (n < 3) return;
    const hw = BW * 0.5, hor = horizon;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < n; i++) {
      const izi = 1 / TY[i];
      const X = hw * (1 + TX[i] * izi), Y = hor + (BH * (eyeZ - TZ[i])) * izi;
      sx[i] = X; sy[i] = Y; iz[i] = izi;
      if (X < minx) minx = X; if (X > maxx) maxx = X;
      if (Y < miny) miny = Y; if (Y > maxy) maxy = Y;
    }
    const x0 = Math.max(0, Math.ceil(minx)), x1 = Math.min(BW - 1, Math.floor(maxx));
    const y0 = Math.max(0, Math.ceil(miny)), y1 = Math.min(BH - 1, Math.floor(maxy));
    if (x1 < x0 || y1 < y0) return;
    const e0x = sx[1] - sx[0], e0y = sy[1] - sy[0], e1x = sx[2] - sx[0], e1y = sy[2] - sy[0];
    const det = e0x * e1y - e1x * e0y;
    if (det > -1e-9 && det < 1e-9) return;                      // degenerate in screen space
    const idet = 1 / det, c0 = col[0], c1 = col[1], c2 = col[2];
    for (let y = y0; y <= y1; y++) {
      const vy = y + 0.5 - sy[0];
      let x = x0, row = y * BW;
      for (; x <= x1; x++) {
        const vx = x + 0.5 - sx[0];
        const w1 = (vx * e1y - e1x * vy) * idet;                // barycentric vs edge 1
        if (w1 < 0 || w1 > 1) continue;
        const w2 = (e0x * vy - vx * e0y) * idet;                // barycentric vs edge 2
        if (w2 < 0 || w1 + w2 > 1) continue;
        const w0 = 1 - w1 - w2;
        const z = 1 / (w0 * iz[0] + w1 * iz[1] + w2 * iz[2]);
        // zbuf holds ONE perpendicular distance per column (js/40_render.js:54,
        // written at :439, read at :603), so this compares a per-pixel depth to a
        // per-column wall - no ground or ceiling depth exists to test against yet.
        if (z >= zbuf[x]) continue;
        px[row + x] = (255 << 24 | c2 << 16 | c1 << 8 | c0) >>> 0;
        pxFilled++;
      }
    }
    tris++;
  }

  /* world -> camera for one point: tX across the plane, tY along the view dir */
  function toCam(wx, wy, wz, o) {
    const dx = wx - o.x, dy = wy - o.y;
    const invDet = o.invDet;
    o.tx = invDet * (o.dirY * dx - o.dirX * dy);
    o.ty = invDet * (-o.planeY * dx + o.planeX * dy);
    o.tz = wz;
  }

  /* draw one mesh. opts: {kind,x,y,z,yaw,scale} */
  function draw(o) {
    const m = model(o.kind || 'grunt'), sc = o.scale || 1, cyw = Math.cos(o.yaw || 0), syw = Math.sin(o.yaw || 0);
    const P = m.p, T = m.t, nV = Math.min(m.nV, MAXV);
    cam.x = camX; cam.y = camY; cam.dirX = dirX; cam.dirY = dirY; cam.planeX = planeX; cam.planeY = planeY;
    cam.invDet = 1 / (planeX * dirY - dirX * planeY);
    for (let i = 0; i < nV; i++) {
      const bx = P[i * 6], by = P[i * 6 + 1], bz = P[i * 6 + 2];
      VX[i] = o.x + (bx * cyw + bz * syw) * sc;
      VY[i] = o.y + (-bx * syw + bz * cyw) * sc;
      VZ[i] = o.z + by * sc;
      VC[i] = (P[i * 6 + 3] << 16 | P[i * 6 + 4] << 8 | P[i * 6 + 5]);
    }
    const idx = T;
    const lt = cellTint(cellIdx(o.x, o.y));
    for (let k = 0; k < idx.length; k += 3) {
      const i0 = idx[k], i1 = idx[k + 1], i2 = idx[k + 2];
      // face normal in world space (flat shading), then Lambert against KEY
      const ex1 = VX[i1] - VX[i0], ey1 = VY[i1] - VY[i0], ez1 = VZ[i1] - VZ[i0];
      const ex2 = VX[i2] - VX[i0], ey2 = VY[i2] - VY[i0], ez2 = VZ[i2] - VZ[i0];
      let nx = ey1 * ez2 - ez1 * ey2, ny = ez1 * ex2 - ex1 * ez2, nz = ex1 * ey2 - ey1 * ex2;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) continue;
      nx /= nl; ny /= nl; nz /= nl;
      // two-sided: face the viewer, since the tubes are open at the ends
      if (nx * (camX - VX[i0]) + ny * (camY - VY[i0]) + nz * (eyeZ - VZ[i0]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
      let d = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
      if (d < 0) d = 0;
      toCam(VX[i0], VY[i0], VZ[i0], cam); const a0x = cam.tx, a0y = cam.ty, a0z = cam.tz;
      toCam(VX[i1], VY[i1], VZ[i1], cam); const a1x = cam.tx, a1y = cam.ty, a1z = cam.tz;
      toCam(VX[i2], VY[i2], VZ[i2], cam); const a2x = cam.tx, a2y = cam.ty, a2z = cam.tz;
      if (a0y < NEAR && a1y < NEAR && a2y < NEAR) continue;
      const dc = (a0y + a1y + a2y) / 3;
      const li = Math.min(1, (MAP.light ? MAP.light[cellIdx(o.x, o.y)] : 0.5) * Math.exp(-dc * 0.14) + 0.30 * visAt(dc));
      const fog = fogAt(dc), inv = 1 - fog;
      const sh = 0.30 + 0.85 * d;
      const lr = (AMB + li * lt[0] * sh) * inv, lg = (AMB + li * lt[1] * sh) * inv, lb = (AMB + li * lt[2] * sh) * inv;
      const packed = VC[i0];
      const R = Math.min(255, ((packed >> 16 & 255) * lr + FOGC[0] * fog) | 0);
      const G = Math.min(255, ((packed >> 8 & 255) * lg + FOGC[1] * fog) | 0);
      const Bc = Math.min(255, ((packed & 255) * lb + FOGC[2] * fog) | 0);
      tri(a0x, a0y, a0z, a1x, a1y, a1z, a2x, a2y, a2z, [R, G, Bc]);
    }
  }

  return {
    draw,
    stats: () => ({ tris, pxFilled }),
    reset: () => { tris = 0; pxFilled = 0; },
    trisFor: k => model(k || 'grunt').tris,
    SPEC,
  };
})();
