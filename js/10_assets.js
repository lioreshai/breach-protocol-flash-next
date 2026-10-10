'use strict';
/* ==================================================================
   10_assets.js — every material, sprite and decal is painted at boot.
   Materials are painted per texel: an authoring pass writes albedo + a
   height field, then the baker derives normals, cavity occlusion and a
   sheen from it, so brick grooves and panel bevels are lit geometry, not
   painted-on stripes. Texel alpha 253 marks an emissive pixel.
   ================================================================== */

function hash2(x, y) {                     // deterministic 0..1 for integer ids
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function blurTile(S, w, h, r) {
  const o = new Float32Array(S.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const xx = (x + i * r + w) % w, yy = (y + j * r + h) % h;
      const wt = i === 0 && j === 0 ? 3 : (i === 0 || j === 0 ? 2 : 1);
      s += S[yy * w + xx] * wt; n += wt;
    }
    o[y * w + x] = s / n;
  }
  return o;
}
const LKEY = (() => { const v = [-0.40, -0.52, 0.75], n = 1 / Math.hypot(v[0], v[1], v[2]); return [v[0] * n, v[1] * n, v[2] * n]; })();
const LHALF = (() => { const v = [LKEY[0], LKEY[1], LKEY[2] + 1], n = 1 / Math.hypot(v[0], v[1], v[2]); return [v[0] * n, v[1] * n, v[2] * n]; })();

function matTex(w, h, paint, opt) {
  opt = opt || {};
  const bump = opt.bump === undefined ? 1 : opt.bump;
  const amb = opt.amb === undefined ? 0.44 : opt.amb;
  const spec = opt.spec === undefined ? 0.10 : opt.spec;
  const specPow = opt.specPow || 26;
  const aoK = opt.ao === undefined ? 0.55 : opt.ao;
  const gr = opt.grain === undefined ? 9 : opt.grain;      // per-texel speckle amplitude
  const tint = opt.tint || [1, 1, 1];
  /* #416: one albedo scalar per material, applied to the PAINTED albedo and to nothing else - not the
     height field, not an emissive texel (an emissive texel is exempt from scene light and is a light
     source, not a surface). matTex has always taken its albedo as literal constants, which is how 19
     tiles came to span 3.8x in mean luma with nothing bounding one against another: two rooms under the
     same lamp read as glaring tile or murky panel depending which face the generator drew. The band is
     asserted by `node tools/view.js matband`; scaling albedo keeps every tile's own hue and structure and
     moves only what it is worth under a lamp. */
  const alb = opt.alb === undefined ? 1 : opt.alb;
  const N = w * h, Hm = new Float32Array(N), AL = new Uint8Array(N * 3), EM = new Uint8Array(N);
  const p = { u: 0, v: 0, h: 0.62, r: 128, g: 128, b: 128, e: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      p.u = (x + 0.5) / w; p.v = (y + 0.5) / h; p.h = 0.62; p.r = p.g = p.b = 128; p.e = 0;
      paint(p);
      if (alb !== 1 && p.e <= 0.5) { p.r *= alb; p.g *= alb; p.b *= alb; }
      // per-texel speckle: real surfaces are noisy at the sampling scale, and fbm cannot say so
      const hsh = hash2(x, y + (gr > 0 ? 0 : 0)) - 0.5;
      p.r += hsh * gr * 2; p.g += hsh * gr * 1.9; p.b += hsh * gr * 1.7;
      Hm[i] = p.h + hsh * gr * 0.0035; AL[i * 3] = p.r; AL[i * 3 + 1] = p.g; AL[i * 3 + 2] = p.b; EM[i] = p.e > 0.5 ? 1 : 0;
    }
  }
  const B1 = blurTile(Hm, w, h, 1), B2 = blurTile(B1, w, h, 2);
  const out = new Uint32Array(N), S = 3.1 * bump;
  const dbg = { albedoR: 0, sh: 0, cav: 0, outR: 0, spec: 0, hMin: 9, hMax: -9 };
  // the baked term must average 1.0 - it carries relief contrast, not exposure
  const norm = 0.5 + (1 - 0.5) * 0.6;
  for (let y = 0; y < h; y++) {
    const yu = ((y - 1) + h) % h, yd = ((y + 1)) % h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, xl = ((x - 1) + w) % w, xr = ((x + 1)) % w;
      let nx = -(Hm[i + 1 - (x === w - 1 ? w : 0)] - Hm[i - 1 + (x === 0 ? w : 0)]);
      nx = -(Hm[y * w + xr] - Hm[y * w + xl]) * S;
      const ny = -(B1[yd * w + x] - B1[yu * w + x]) * S;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; const nzy = inv;
      const dif = Math.max(0, nx * LKEY[0] + ny * LKEY[1] + nzy * LKEY[2]);
      const sh = (amb + (1 - amb) * Math.pow(dif, 1.06)) / (norm * (amb + (1 - amb) * 0.6)) * (amb + (1 - amb) * 0.6);
      let sp = 0;
      if (spec > 0) {
        const dh = Math.max(0, nx * LHALF[0] + ny * LHALF[1] + nzy * LHALF[2]);
        sp = spec * Math.pow(dh, specPow);
      }
      const cav = clamp(1 - (B2[i] - Hm[i]) * aoK * 4, 0.42, 1.10);
      const e = EM[i] ? clamp(p.e || 1, 0, 1) : 0;
      dbg.albedoR += AL[i * 3]; dbg.sh += sh; dbg.cav += cav; dbg.spec += sp;
      dbg.hMin = Math.min(dbg.hMin, Hm[i]); dbg.hMax = Math.max(dbg.hMax, Hm[i]);
      let r = AL[i * 3] * sh * cav + 255 * sp, g = AL[i * 3 + 1] * sh * cav + 255 * sp * 0.96, b = AL[i * 3 + 2] * sh * cav + 255 * sp * 0.9;
      if (EM[i]) { r = Math.max(r, AL[i * 3] * 1.25); g = Math.max(g, AL[i * 3 + 1] * 1.25); b = Math.max(b, AL[i * 3 + 2] * 1.25); }
      dbg.outR += r;
      out[i] = pk(r * tint[0], g * tint[1], b * tint[2], EM[i] ? 253 : 255);
    }
  }
  const t = { w, h, data: out };
  for (const k in dbg) dbg[k] = typeof dbg[k] === 'number' ? dbg[k] / N : dbg[k];
  t.dbg = dbg;
  t.mips = buildMips(w, h, out);
  t.tiles = true;
  return t;
}

/* ---------- shared material authoring helpers ---------- */
/* grime/dust gradient that does not repeat vertically inside a tile */
function dustMask(p, amt) {
  const n = fbm(p.u, p.v, 3, 4, 0.55, 91);
  return Math.pow(Math.max(0, n - 0.35), 1.7) * amt * 1.8;
}
function dust(p, amt, col) {
  const k = dustMask(p, amt);
  p.r += (col[0] - p.r) * k; p.g += (col[1] - p.g) * k; p.b += (col[2] - p.b) * k;
}
function grain(p, amt, seed, base) {
  const g = fbm(p.u, p.v, base || 16, 3, 0.6, seed) - 0.5;
  p.r += g * amt; p.g += g * amt * 0.96; p.b += g * amt * 0.92;
}
// Cracks are the near-flat centreline of the ridged field, and that field spends most of
// its area near its median - so take a narrow band around 0.5 and state coverage directly.
function crackMask(p, cover, base, seed) {
  const n = fbm(p.u, p.v, base, 4, 0.55, seed);
  const eps = 0.004 + cover * 0.09;
  return 1 - smoothstep(eps * 0.35, eps, Math.abs(n - 0.5));
}
// Same geometry, different name: veins are cracks that grew.
function veinMask(p, cover, base, seed) { return crackMask(p, cover, base, seed); }
function cracks(p, cover, wdt, base, seed, col) {
  const c = crackMask(p, cover, base, seed);
  if (c > 0) { const k = c * 0.85; p.r += (col[0] - p.r) * k; p.g += (col[1] - p.g) * k; p.b += (col[2] - p.b) * k; p.h -= c * 0.12; }
}
function rustMask(p, amt, seed) {
  const n = fbm(p.u, p.v, 4, 4, 0.55, seed);
  return smoothstep(0.78 - amt * 0.34, 0.98, n);
}
function rust(p, amt, seed) {
  const m = rustMask(p, amt, seed);
  if (m <= 0) return;
  const k = m * (0.55 + 0.45 * fbm(p.u, p.v, 12, 3, 0.6, seed + 5));
  p.r += (122 - p.r) * k; p.g += (62 - p.g) * k; p.b += (32 - p.b) * k;
  p.h -= k * 0.10;
}
function mossMask(p, amt, seed) {
  const n = fbm(p.u, p.v, 3, 4, 0.5, seed) * fbm(p.u, p.v, 9, 3, 0.5, seed + 3) * 3.1;
  return smoothstep(0.95 - amt * 0.6, 1.35, n) * 0.85;
}
function moss(p, amt, seed) {                       // patchy growth, not a green wall
  const k = mossMask(p, amt, seed);
  if (k <= 0) return;
  p.r += (44 - p.r) * k; p.g += (86 - p.g) * k; p.b += (40 - p.b) * k;
  p.h += k * 0.03;
}
/* brick/panel course field: returns {inside, edge, id} */
function courses(p, cols, rows, mortar, stagger) {
  const gy = p.v * rows, ry = Math.floor(gy), fy = gy - ry;
  const off = (ry & 1) ? 0.5 * (stagger === undefined ? 1 : stagger) : 0;
  const gx = (p.u + off) * cols, rx = Math.floor(gx), fx = gx - rx;
  const ex = Math.min(fx, 1 - fx) * cols, ey = Math.min(fy, 1 - fy) * rows;
  const d = Math.min(ex, ey);
  return { mortar: d < mortar, edge: smoothstep(mortar, mortar + 0.08, d), id: ry * 64 + rx, cx: (rx - off * cols / 1), cy: ry };
}

/* ============================ WALLS ============================ */
const WTEX = {};
const T2 = 128;
WTEX.BRICK = matTex(T2, T2, p => {
  const c = courses(p, 3, 8, 0.055, 1);
  if (c.mortar) {
    const n = fbm(p.u, p.v, 20, 3, 0.6, 31);
    p.h = 0.30 + n * 0.10;
    p.r = 158 + n * 44; p.g = 148 + n * 40; p.b = 134 + n * 36;
    return;
  }
  const jitter = hash2(c.id, 7) * 0.5 + hash2(c.id, 19) * 0.5;
  const base = [158 + jitter * 52, 92 + jitter * 30, 70 + jitter * 22];
  p.r = base[0]; p.g = base[1]; p.b = base[2];
  const n = fbm(p.u * 1, p.v * 1, 6, 4, 0.6, 12);
  const m = 0.72 + n * 0.6;
  p.r *= m; p.g *= m; p.b *= m;
  p.h = 0.66 + (n - 0.5) * 0.10;
  // chamfer toward the mortar line
  p.h += (c.edge - 1) * 0.10 * (1 - c.edge);
  grain(p, 26, 21, 24);
  dust(p, 0.18, [96, 88, 78]);
  cracks(p, 0.07, 0.10, 5, 44, [40, 26, 22]);
  moss(p, 0.20, 63);
}, { bump: 1.15, amb: 0.42, spec: 0.05, ao: 0.75, grain: 11 });

WTEX.STONE = matTex(T2, T2, p => {
  const c = courses(p, 2.6, 3.4, 0.05, 0.5);
  if (c.mortar) {
    const n = fbm(p.u, p.v, 22, 3, 0.6, 5);
    p.h = 0.26 + n * 0.1; p.r = 118 + n * 38; p.g = 118 + n * 36; p.b = 114 + n * 34;
    return;
  }
  const j = hash2(c.id, 3);
  const v = 0.62 + j * 0.5 + (fbm(p.u, p.v, 7, 4, 0.58, 17) - 0.5) * 0.5;
  p.r = 132 * v + 40; p.g = 136 * v + 40; p.b = 140 * v + 40;
  p.h = 0.68 + (fbm(p.u, p.v, 9, 4, 0.6, 3) - 0.5) * 0.16 + (c.edge - 1) * 0.07;
  grain(p, 8, 44, 26);
  // pitted rock
  const pit = smoothstep(0.60, 0.96, fbm(p.u, p.v, 18, 3, 0.6, 71));
  p.h -= pit * 0.09; p.r -= pit * 13; p.g -= pit * 13; p.b -= pit * 12;
  moss(p, 0.34, 12);
  cracks(p, 0.09, 0.12, 4, 88, [46, 48, 52]);
}, { bump: 1.25, amb: 0.42, spec: 0.045, ao: 0.8, grain: 6, alb: 0.89 });   // #416: grain fbm 30 -> 13, speckle 13 -> 6 and 0.89 albedo - the mossy rock tile measured 33.9 luma of mean step per 2 px, the second-busiest background in the table

WTEX.CONCRETE = matTex(T2, T2, p => {
  const formY = Math.abs(((p.v * 2) % 1) - 0.5) * 2;           // form panel seam banding
  const seam = 1 - smoothstep(0.0, 0.05, Math.abs(p.v * 2 % 1 - 0.5));
  const n = fbm(p.u, p.v, 6, 5, 0.55, 8);
  let v = 0.78 + n * 0.42;
  p.r = 130 * v; p.g = 130 * v; p.b = 132 * v;
  p.h = 0.66 + (n - 0.5) * 0.09 - seam * 0.16;
  // aggregate speckle
  const ag = fbm(p.u, p.v, 34, 2, 0.5, 55);
  if (ag > 0.72) { const k = (ag - 0.72) * 3; p.h += k * 0.06; p.r += 26 * k; p.g += 24 * k; p.b += 20 * k; }
  if (ag < 0.22) { const k = (0.22 - ag) * 2.4; p.h -= k * 0.05; p.r -= 20 * k; p.g -= 20 * k; p.b -= 18 * k; }
  // tie holes on the seam line
  const tx = (p.u * 2) % 1, ty = (p.v * 2 + 0.5) % 1;
  const th = sdCircle(tx - 0.5, ty - 0.5, 0.055);
  if (th < 0.02) { const k = smoothstep(0.02, -0.02, th); p.h -= k * 0.2; p.r -= k * 44; p.g -= k * 42; p.b -= k * 38; }
  dust(p, 0.30, [150, 146, 136]);
  cracks(p, 0.06, 0.09, 4, 23, [70, 70, 74]);
  // damp staining from the seam downward
  const st = smoothstep(0.0, 1, (p.v * 2 % 1)) * 0.5;
  const streak = fbm(p.u * 3, p.v * 0.4, 8, 3, 0.6, 77);
  const k2 = smoothstep(0.5, 0.9, streak) * 0.35;
  p.r -= k2 * 30; p.g -= k2 * 28; p.b -= k2 * 22;
}, { bump: 1.0, amb: 0.44, spec: 0.05, ao: 0.6, grain: 12, alb: 0.95 });

WTEX.TECH = matTex(T2, T2, p => {
  // 2x2 inset panels with bevels + a glowing conduit lane
  const gx = (p.u * 2) % 1, gy = (p.v * 2) % 1;
  const d = sdRoundBox(gx - 0.5, gy - 0.5, 0.46, 0.42, 0.06);
  const bevel = smoothstep(0.06, -0.02, d);
  const n = fbm(p.u * 6, p.v * 0.6, 8, 3, 0.55, 5);            // brushed, stretched
  let v = 0.8 + n * 0.4;
  const base = [94, 108, 128];
  p.r = base[0] * v; p.g = base[1] * v; p.b = base[2] * v;
  p.h = 0.6 + bevel * 0.16 + (n - 0.5) * 0.04;
  // seam between panels
  const seam = smoothstep(0.03, -0.03, Math.max(Math.abs(gx - 0.5) - 0.46, Math.abs(gy - 0.5) - 0.44));
  p.h -= seam * 0.22; p.r -= seam * 22; p.g -= seam * 20; p.b -= seam * 18;
  // rivets
  const rx = ((p.u * 2) % 1) * 0.8, ry = ((p.v * 2) % 1) * 0.78;
  for (const sx of [-0.4, 0.4]) for (const sy of [-0.36, 0.36]) {
    const dd = sdCircle(rx - 0.5 + sx, ry - 0.5 + sy, 0.028);
    if (dd < 0.01) { const k = smoothstep(0.01, -0.02, dd); p.h += k * 0.14; p.r += k * 40; p.g += k * 44; p.b += k * 50; }
  }
  // conduit lane across the middle of every panel
  const lane = Math.abs(gy - 0.80);
  if (lane < 0.035) {
    const k = 1 - lane / 0.035;
    p.r = 90 + k * 120; p.g = 210 + k * 45; p.b = 235 + k * 20; p.h = 0.5; p.e = k > 0.35 ? 1 : 0;
  }
  dust(p, 0.14, [110, 120, 130]);
  if (fbm(p.u, p.v, 3, 3, 0.5, 131) > 0.72) rust(p, 0.35, 108);
}, { bump: 1.1, amb: 0.40, spec: 0.30, specPow: 34, ao: 0.55, grain: 7 });

WTEX.TECH2 = matTex(T2, T2, p => {
  const gx = (p.u * 3) % 1, gy = (p.v * 3) % 1;
  const hx = Math.abs(gx - 0.5), hy = Math.abs(gy - 0.5);
  const cell = smoothstep(0.5, 0.44, Math.max(hx, hy) + Math.min(hx, hy) * 0.35);
  const n = fbm(p.u * 5, p.v * 0.8, 7, 3, 0.55, 21);
  let v = 0.78 + n * 0.4;
  p.r = 96 * v; p.g = 62 * v; p.b = 118 * v;
  p.h = 0.55 + cell * 0.16 + (n - 0.5) * 0.05;
  const seam = 1 - cell;
  p.h -= seam * 0.18;
  const vein = smoothstep(0.030, 0.0, Math.abs(gy - 0.5) - 0.0) * (1 - cell);
  if (vein > 0.1) { p.r = 255; p.g = 90 + 60 * n; p.b = 190; p.h = 0.52; p.e = 1; }
  dust(p, 0.20, [70, 52, 84]);
  grain(p, 16, 9, 20);
}, { bump: 1.0, amb: 0.40, spec: 0.26, specPow: 30, ao: 0.6, grain: 7, alb: 1.14 });   // #416: the darkest wall tile in the table at 82.3 mean luma, raised into band

WTEX.METAL = matTex(T2, T2, p => {
  const n = fbm(p.u * 8, p.v * 0.5, 9, 3, 0.55, 17);
  let v = 0.82 + n * 0.36;
  p.r = 104 * v; p.g = 110 * v; p.b = 120 * v;
  p.h = 0.62 + (n - 0.5) * 0.05;
  // hazard chevrons
  const ch = ((p.u + p.v) * 6) % 1;
  if (ch < 0.34) { const k = smoothstep(0.34, 0.30, ch); p.r += (166 - p.r) * k * 0.8; p.g += (132 - p.g) * k * 0.8; p.b += (34 - p.b) * k * 0.8; p.h += k * 0.03; }
  // diamond tread
  const tx = Math.abs(((p.u * 9) % 1) - 0.5) * 2, ty = Math.abs(((p.v * 9) % 1) - 0.5) * 2;
  const dia = 1 - smoothstep(0.35, 0.9, Math.min(Math.abs(tx - ty), Math.abs(tx + ty - 1) + 0.3));
  p.h += dia * 0.13;
  if (dia > 0.4) { p.r += 22; p.g += 24; p.b += 26; }
  const seam = smoothstep(0.02, -0.02, Math.abs(((p.v * 2) % 1) - 0.5) - 0.48);
  p.h -= seam * 0.2;
  const bx = ((p.u * 4) % 1) - 0.5, by = ((p.v * 4) % 1) - 0.5;
  const bolt = sdCircle(Math.abs(bx) - 0.34, Math.abs(by) - 0.34, 0.045);
  if (bolt < 0.01) { const k = smoothstep(0.01, -0.02, bolt); p.h += k * 0.16; p.r += k * 30; p.g += k * 32; p.b += k * 36; }
  rust(p, 0.55, 88);
  dust(p, 0.16, [120, 118, 112]);
}, { bump: 1.2, amb: 0.40, spec: 0.34, specPow: 40, ao: 0.5, grain: 8, alb: 0.86 });   // #416: brightest wall tile at 153.2 mean luma, pulled into band; spec 0.42 -> 0.34 so its highlight stops reaching white across 1% of the tile

WTEX.FLESH = matTex(T2, T2, p => {
  const n = fbm(p.u, p.v, 5, 4, 0.55, 3);
  const lump = fbm(p.u, p.v, 3, 3, 0.5, 41);
  let v = 0.7 + n * 0.55 + (lump - 0.5) * 0.35;
  p.r = 150 * v; p.g = 50 * v + 8; p.b = 62 * v + 10;
  p.h = 0.58 + (lump - 0.5) * 0.22 + (n - 0.5) * 0.08;
  // vein network - and the thickest cores carry their own light
  const vk = veinMask(p, 0.16, 4, 66);
  if (vk > 0) { p.r += (60 - p.r) * vk * 0.8; p.g += (14 - p.g) * vk * 0.8; p.b += (24 - p.b) * vk * 0.8; p.h += vk * 0.07; }
  if (vk > 0.9) { p.e = 1; p.r = 210; p.g = 60; p.b = 52; }
  // wet membrane sheen patches
  const wet = smoothstep(0.55, 0.9, fbm(p.u, p.v, 9, 3, 0.6, 12));
  p.r += wet * 30; p.g += wet * 12; p.b += wet * 18; p.h += wet * 0.04;
  // pale cartilage nodules
  const nod = smoothstep(0.80, 0.94, fbm(p.u, p.v, 12, 2, 0.5, 88));
  p.r += nod * 60; p.g += nod * 46; p.b += nod * 40; p.h += nod * 0.08;
}, { bump: 1.35, amb: 0.40, spec: 0.5, specPow: 22, ao: 0.7, grain: 9 });

/* #369: ABATOIR CORE's wall. WTEX.FLESH and FLOORS.FLESH are the SAME generator at two scales (same
   fbm seed 3, the same veinMask family), so the largest level in the campaign painted its deck and 78%
   of its wall faces with one pattern in one red - `surface`'s FAMILY row names it as a PRIMARY-face
   collision, and every step, ledge and pit lip in that level is an edge between two things that agree in
   both colour and texture. This is the wall's own meat: fibre BUNDLES running across the surface under
   broad folds, which is a different structure from the deck's lump-and-vein network at the same scale.
   Two deliberate choices, both measured:
   - the MEAN albedo is FLESH's (v averages 0.98 against FLESH's 0.975, and the base channels are the
     same thirds). The level sits under the composited upper anchor that `js/20_level.js` records, so a
     wall material that also moved the light would be an exposure re-record wearing a texture's clothes;
     wall and deck are separated by STRUCTURE, not by brightness, and the FAMILY rule is a material rule.
   - NO emissive vein cores. FLESH carries texels at 210,60,52 with p.e = 1, and an emissive texel is
     exempt from scene light, so a surface wearing them cannot be shaded by the level at all (the same
     finding that took the emissive threads out of CEILS.SINEW). A wall the level can shade down is the
     half of "walls carry the detail, the ceiling sits lowest" that has to stay reachable. */
WTEX.MUSCLE = matTex(T2, T2, p => {
  const fold = fbm(p.u, p.v, 2, 3, 0.55, 61);                 // broad folds the bundles hang in
  const fib = 0.50 + 0.24 * Math.sin((p.u * 11 + fold * 1.1) * Math.PI * 2);   // 11 bundles a tile, tileable; #416 took the swing from +-0.50 to +-0.24
  const grain = fbm(p.u, p.v, 24, 3, 0.5, 17);                // fine meat grain along the bundles
  let v = 0.98 + (fib - 0.5) * 0.24 + (fold - 0.5) * 0.30 + (grain - 0.5) * 0.10;
  p.r = 148 * v; p.g = 52 * v + 10; p.b = 66 * v + 12;
  p.h = 0.58 + (fib - 0.5) * 0.26 + (fold - 0.5) * 0.12 + (grain - 0.5) * 0.05;
  // the seam between two bundles reads cooler and wetter, so the striation survives flat lamp light
  const gap = smoothstep(0.22, 0.0, fib);
  p.r -= gap * 26; p.g -= gap * 4; p.b += gap * 6; p.h -= gap * 0.14;
  const wet = smoothstep(0.62, 0.94, fbm(p.u, p.v, 9, 3, 0.6, 12));
  p.r += wet * 26; p.g += wet * 11; p.b += wet * 16; p.h += wet * 0.04;
}, { bump: 1.5, amb: 0.40, spec: 0.46, specPow: 22, ao: 0.72, grain: 5, alb: 1.14 });   // #416: the busiest tile in the table at 35.6 luma of mean step per 2 px - ABATOIR's wall was the sharpest thing in front of a body standing on it

WTEX.GRATE = matTex(T2, T2, p => {
  const gx = (p.u * 4) % 1, gy = (p.v * 4) % 1;
  const bar = Math.min(Math.abs(gx - 0.5), Math.abs(gy - 0.5));
  const solid = smoothstep(0.10, 0.16, bar);
  const n = fbm(p.u * 7, p.v * 0.7, 8, 3, 0.55, 29);
  let v = 0.8 + n * 0.4;
  p.r = 96 * v; p.g = 100 * v; p.b = 108 * v;
  p.h = 0.42 + solid * 0.24 + (n - 0.5) * 0.04;
  if (solid < 0.5) { p.r = 12; p.g = 13; p.b = 16; }         // see-through gap stays pitch dark
  const wear = smoothstep(0.45, 0.8, fbm(p.u, p.v, 4, 3, 0.6, 33));
  p.r += wear * 26; p.g += wear * 26; p.b += wear * 28;
  rust(p, 0.5, 61);
}, { bump: 1.1, amb: 0.44, spec: 0.34, specPow: 34, ao: 0.9, grain: 8, alb: 1.12 });   // #416: darkest tile in the table at 81.8 - the dark GAP texels stay at 12,13,16, so this lifts the bars, not the holes

/* #369: THE STACK's wall. Its deck is FLOORS.STONE and the level used to paint 78% of its wall faces
   with WTEX.STONE - the SAME masonry-and-mortor family at a different scale - so the edge between "the
   floor you are on" and "the face in front of you" joined two things that agree in colour and in
   texture, in a level whose whole idea is an edge you can fall off. The ruling on that collision is on
   the issue; this is the material that answers it. Two constraints, both measured:
   - the MEAN ALBEDO is WTEX.STONE's (r averages ~152 against its ~155). The first attempt at this change
     used WT.CONCRETE and moved the family without moving the picture: `surface`'s WALL row fell from
     26.6 luma of deck-vs-wall separation across 79% of the frame's width to 16.2 across 57%, because
     CONCRETE's 130-grey base is DARKER than the stone it replaced while the deck under this level's
     `floorBias: 0.18` did not move. A family rule paid for by giving up the luminance gap is a worse
     picture wearing a green row, so this is a different STRUCTURE at the brightness the level had.
   - the STRUCTURE is rectified ashlar: tall squarish blocks, incised narrow joints, a pour lift line
     across each course and tie holes at their quarter points. No mortar beds, no flagstone jitter, so
     at any distance the face reads as a wall the eye is looking AT rather than the floor carried upward.
   No emissive texels, for the same reason MUSCLE has none: an emissive texel is exempt from scene light,
   so a surface wearing them cannot be shaded by the level at all. */
WTEX.SLAB = matTex(T2, T2, p => {
  const by = p.v * 2, ry = Math.floor(by), fy = by - ry;              // 2 courses a tile: tall blocks
  const off = (ry & 1) ? 0.5 : 0;
  const bx = (p.u + off) * 3, rx = Math.floor(bx), fx = bx - rx;
  const ex = Math.min(fx, 1 - fx) * 3, ey = Math.min(fy, 1 - fy) * 2;
  const joint = 1 - smoothstep(0.03, 0.075, Math.min(ex, ey));        // incised, rectified, narrow
  const j = hash2(rx * 7 + ry * 13, 23);
  const n = fbm(p.u, p.v, 6, 4, 0.56, 41);
  let v = 0.80 + j * 0.20 + n * 0.34;                                 // mean albedo 145: WTEX.STONE's own
  p.r = 130 * v; p.g = 130 * v; p.b = 136 * v;
  p.h = 0.70 + (n - 0.5) * 0.10 + (j - 0.5) * 0.06;
  // the joint is a shadow line, not a colour: it drops the height and only darkens a little
  p.r -= joint * 36; p.g -= joint * 35; p.b -= joint * 32; p.h -= joint * 0.24;
  const lift = 1 - smoothstep(0.0, 0.025, Math.abs(fy - 0.5));        // form lift across each course
  p.r -= lift * 15; p.g -= lift * 15; p.b -= lift * 13; p.h -= lift * 0.09;
  const tie = smoothstep(0.03, -0.03, Math.min(sdCircle(fx - 0.25, fy - 0.5, 0.035),
                                                 sdCircle(fx - 0.75, fy - 0.5, 0.035)));
  p.r -= tie * 40; p.g -= tie * 38; p.b -= tie * 34; p.h -= tie * 0.22;
  const streak = fbm(p.u * 3, p.v * 0.4, 8, 3, 0.6, 77);              // damp runs from the joints down
  const st = smoothstep(0.55, 0.9, streak) * 0.30;
  p.r -= st * 20; p.g -= st * 22; p.b -= st * 14; p.h -= st * 0.05;
  grain(p, 20, 26, 30);
}, { bump: 1.15, amb: 0.44, spec: 0.06, specPow: 26, ao: 0.78, grain: 11, alb: 0.89 });   // #416: moves WITH WTEX.STONE's alb, so #369's "authored at the deck's own mean albedo" still holds

const WALLS = [];
const WT = {};
/* MUSCLE and SLAB are APPENDED, not inserted: WT's values are indices into WALLS, and a level's `wall`
   field is one of those numbers in every recorded frame, so a renumbering would move frames no change
   touched. */
['BRICK', 'TECH', 'STONE', 'METAL', 'FLESH', 'TECH2', 'CONCRETE', 'GRATE', 'MUSCLE', 'SLAB'].forEach((k, i) => { WALLS.push(WTEX[k]); WT[k] = i + 1; });

/* ============================ FLOORS / CEILINGS ============================ */
const FLOORS = {}, CEILS = {};
FLOORS.CONCRETE = matTex(T2, T2, p => {
  const jx = Math.abs(((p.u * 2) % 1) - 0.5) * 2, jy = Math.abs(((p.v * 2) % 1) - 0.5) * 2;
  const grout = smoothstep(0.94, 1, Math.max(jx, jy));
  const n = fbm(p.u, p.v, 6, 5, 0.55, 11);
  let v = 0.76 + n * 0.45;
  p.r = 96 * v; p.g = 96 * v; p.b = 100 * v;
  p.h = 0.6 - grout * 0.2 + (n - 0.5) * 0.07;
  const ag = fbm(p.u, p.v, 30, 2, 0.5, 3);
  p.h += (ag - 0.5) * 0.05; p.r += (ag - 0.5) * 26; p.g += (ag - 0.5) * 24; p.b += (ag - 0.5) * 20;
  dust(p, 0.22, [120, 116, 108]);
  cracks(p, 0.05, 0.08, 4, 51, [56, 56, 60]);
}, { bump: 0.9, amb: 0.5, spec: 0.14, specPow: 18, ao: 0.5, grain: 11 });
FLOORS.TILE = matTex(T2, T2, p => {
  const gx = (p.u * 4) % 1, gy = (p.v * 4) % 1;
  const d = Math.max(Math.abs(gx - 0.5) - 0.46, Math.abs(gy - 0.5) - 0.46);
  const grout = smoothstep(-0.01, 0.03, d);
  const id = ((p.v * 4) | 0) * 8 + ((p.u * 4) | 0);
  const j = hash2(id, 5);
  const n = fbm(p.u, p.v, 10, 3, 0.6, 19);
  let base = 150 + j * 40;
  p.r = base * 0.92; p.g = base * 0.94; p.b = base * 0.9;
  p.r += (n - 0.5) * 22; p.g += (n - 0.5) * 22; p.b += (n - 0.5) * 24;
  p.h = 0.66 - grout * 0.24;
  // chipped corners
  const cx = Math.abs(gx - 0.5) - 0.44, cy = Math.abs(gy - 0.5) - 0.44;
  const chip = smoothstep(0.5, 0.9, Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) * 3.6 + hash2(id, 9) * 0.4);
  p.h -= chip * 0.12; p.r -= chip * 30; p.g -= chip * 28; p.b -= chip * 22;
  dust(p, 0.26, [104, 100, 92]);
}, { bump: 0.85, amb: 0.48, spec: 0.34, specPow: 44, ao: 0.7, grain: 7, alb: 0.81 });   // #416: the glaring near-white tile of the issue's first sentence - brightest tile in the game at 166.7 mean luma
FLOORS.METAL = matTex(T2, T2, p => {
  const n = fbm(p.u * 7, p.v * 0.7, 9, 3, 0.55, 23);
  let v = 0.82 + n * 0.4;
  p.r = 78 * v; p.g = 84 * v; p.b = 94 * v;
  p.h = 0.6 + (n - 0.5) * 0.05;
  // anti-slip raised diamond rows
  const tx = Math.abs(((p.u * 6) % 1) - 0.5) * 2, ty = Math.abs(((p.v * 6) % 1) - 0.5) * 2;
  const dia = 1 - smoothstep(0.30, 0.95, Math.abs(tx - ty));
  p.h += dia * 0.22; p.r += dia * 30; p.g += dia * 32; p.b += dia * 34;
  const seam = smoothstep(0.025, -0.02, Math.abs(((p.v * 1) % 1) - 0.5) - 0.485);
  p.h -= seam * 0.24;
  for (const sx of [-0.26, 0.26]) {
    const b = sdCircle((p.u % 1) - 0.5 + sx, ((p.v * 1) % 1) - 0.5, 0.032);
    if (b < 0.012) { const k = smoothstep(0.012, -0.02, b); p.h += k * 0.16; p.r += k * 34; p.g += k * 36; p.b += k * 40; }
  }
  rust(p, 0.42, 73);
  dust(p, 0.14, [110, 112, 116]);
}, { bump: 1.2, amb: 0.46, spec: 0.30, specPow: 46, ao: 0.55, grain: 8, alb: 0.95 });   // #416: spec 0.44 -> 0.30 - this deck's own 1%-clipping highlight measured 249 luma, i.e. 1% of the floor read as a mirror
FLOORS.STONE = matTex(T2, T2, p => {
  // irregular flagstones from a jittered grid
  const s = 3, gx = p.u * s, gy = p.v * s;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  let bx = ix + 0.5 + (hash2(ix, iy) - 0.5) * 0.5, by = iy + 0.5 + (hash2(iy, ix + 9) - 0.5) * 0.5;
  let best = 1e9, bid = 0;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const jx = ix + ox, jy = iy + oy;
    const cx = jx + 0.5 + (hash2(jx, jy) - 0.5) * 0.5, cy = jy + 0.5 + (hash2(jy, jx + 9) - 0.5) * 0.5;
    const dd = (gx - cx) * (gx - cx) + (gy - cy) * (gy - cy);
    if (dd < best) { best = dd; bid = jy * 32 + jx; bx = cx; by = cy; }
  }
  const r = Math.sqrt(best);
  const edge = smoothstep(0.34, 0.46, r * 1.0);
  const j = hash2(bid, 4), n = fbm(p.u, p.v, 8, 4, 0.58, 27);
  let v = 0.6 + j * 0.45 + (n - 0.5) * 0.4;
  p.r = 88 * v + 18; p.g = 90 * v + 18; p.b = 86 * v + 18;
  p.h = 0.64 - edge * 0.2 + (n - 0.5) * 0.12;
  moss(p, 0.4, 15);
  dust(p, 0.2, [92, 90, 84]);
}, { bump: 1.1, amb: 0.5, spec: 0.08, specPow: 20, ao: 0.8, grain: 12, alb: 1.05 });
FLOORS.FLESH = matTex(T2, T2, p => {
  const n = fbm(p.u, p.v, 5, 4, 0.55, 3);
  let v = 0.66 + n * 0.6;
  p.r = 92 * v + 12; p.g = 28 * v + 6; p.b = 38 * v + 8;
  p.h = 0.58 + (n - 0.5) * 0.16;
  const vk = veinMask(p, 0.18, 5, 44);
  p.r += (200 - p.r) * vk * 0.35; p.g += (60 - p.g) * vk * 0.5; p.b += (70 - p.b) * vk * 0.5; p.h += vk * 0.1;
  if (vk > 0.9) { p.e = 1; p.r = 208; p.g = 74; p.b = 66; }
  const pool = smoothstep(0.62, 0.86, fbm(p.u, p.v, 3, 3, 0.6, 92));
  p.r -= pool * 26; p.g -= pool * 12; p.b -= pool * 6; p.h -= pool * 0.05;
}, { bump: 1.3, amb: 0.42, spec: 0.55, specPow: 20, ao: 0.7, grain: 9, alb: 1.08 });   // #416: darkest floor at 88.6; the emissive vein cores at 208,74,66 are NOT scaled - alb skips emissive texels

CEILS.CONCRETE = matTex(T2, T2, p => {
  const sx = (p.u * 2) % 1, sy = (p.v * 2) % 1;
  const seam = Math.max(Math.abs(sx - 0.5) - 0.46, Math.abs(sy - 0.5) - 0.46);
  const sk = smoothstep(-0.015, 0.02, seam);
  const n = fbm(p.u * 7, p.v * 7, 5, 4, 0.55, 61);
  let v = 0.46 + n * 0.3;
  p.r = 78 * v; p.g = 79 * v; p.b = 86 * v;                      // cooler and darker than any floor, so overhead reads as overhead
  p.h = 0.6 - sk * 0.22 + (n - 0.5) * 0.08;
  const pit = smoothstep(0.74, 0.9, fbm(p.u * 26, p.v * 26, 3, 2, 0.5, 23));
  p.h -= pit * 0.1; p.r -= pit * 12; p.g -= pit * 11; p.b -= pit * 9;
  const soot = smoothstep(0.55, 0.95, fbm(p.u * 1.6, p.v * 1.6, 4, 3, 0.6, 13));
  p.r -= soot * 20; p.g -= soot * 19; p.b -= soot * 15;
  cracks(p, 0.05, 0.08, 3, 27, [24, 24, 28]);
}, { bump: 1.1, amb: 0.42, spec: 0.03, ao: 0.8, grain: 8 });
CEILS.PANEL = matTex(T2, T2, p => {
  const gx = (p.u * 4) % 1, gy = (p.v * 4) % 1;
  const d = Math.max(Math.abs(gx - 0.5) - 0.46, Math.abs(gy - 0.5) - 0.46);
  const seam = smoothstep(-0.02, 0.03, d);
  const n = fbm(p.u * 14, p.v * 3, 6, 3, 0.55, 71);
  let v = 0.44 + n * 0.3;
  p.r = 58 * v; p.g = 66 * v; p.b = 80 * v;
  p.h = 0.56 - seam * 0.22 + (n - 0.5) * 0.03;
  if (Math.hypot(((gx * 2) % 1) - 0.5, ((gy * 2) % 1) - 0.5) < 0.09) { p.h += 0.08; p.r += 14; p.g += 14; p.b += 14; }
  const vent = Math.abs(gy - 0.5) < 0.32 && Math.abs(gx - 0.5) < 0.22 && ((p.v * 4) | 0) % 3 === 0;
  if (vent) { const s = Math.sin(gy * 60) * 0.5 + 0.5; p.h -= s * 0.2; p.r -= s * 20; p.g -= s * 20; p.b -= s * 18; }
  dust(p, 0.12, [62, 66, 74]);
}, { bump: 1.1, amb: 0.44, spec: 0.14, specPow: 26, ao: 0.75, grain: 6 });
CEILS.ROCK = matTex(T2, T2, p => {
  const strata = Math.sin(p.v * 12 + turb(p.u * 2, p.v * 2, 3, 3, 51) * 2.2) * 0.5 + 0.5;
  const n = turb(p.u * 7, p.v * 7, 4, 4, 57);
  let v = 0.36 + n * 0.42 + strata * 0.14;
  p.r = 70 * v; p.g = 68 * v; p.b = 70 * v;                       // desaturated: the warm browns belong to the floor
  p.h = 0.44 + n * 0.3 + strata * 0.1;
  const knob = smoothstep(0.72, 0.95, fbm(p.u * 9, p.v * 9, 4, 3, 0.55, 19));
  p.h += knob * 0.2; p.r += knob * 10; p.g += knob * 10; p.b += knob * 12;
  const wet = smoothstep(0.72, 0.94, fbm(p.u * 5, p.v * 5, 3, 3, 0.6, 33));
  p.r += wet * 10; p.g += wet * 11; p.b += wet * 14;
  moss(p, 0.1, 71);                                               // seam moss, not floor moss
}, { bump: 1.6, amb: 0.4, spec: 0.07, ao: 0.9, grain: 10 });
CEILS.SINEW = matTex(64, 64, p => {
  /* #369: this used to be FLOORS.FLESH at a different scale - 104/40/50 albedo with EMISSIVE veins at
     180,96,60 - so ABATOIR CORE, the largest level in the campaign, put its floor, its walls and its
     ceiling on one red (one rendered frame, whole screen-row bands: ceiling 67.1, far wall 72.1, near
     floor 68.1 mean Rec.601 luminance) and every step, ledge and pit lip in it was an edge between two
     things of the same colour. It now states the rule the other three ceilings already state in their own
     comments - a desaturated, cooler albedo than any floor, so overhead reads as overhead - and its veins
     are RECESSES in the hide rather than the emissive threads the floor owns (an emissive texel is exempt
     from scene light, which is why a ceiling carrying them could not be shaded down at all). The emissive
     removal plus a desaturated albedo, with the level's own ceilBias on top (js/20_level.js:22), takes
     that ceiling band from 67.1 to 48.7 at the same seat, against a wall band that does not move: the
     5.0-point gap the issue measured becomes 23.4, and 17.3 at a second camera. The remaining
     ordering (floorBias / ceilBias / ceilLead) is authored per level and applied in js/40_render.js. */
  const n = fbm(p.u, p.v, 4, 4, 0.55, 5);
  let v = 0.46 + n * 0.5;
  p.r = 92 * v; p.g = 74 * v; p.b = 90 * v;
  p.h = 0.5 + (n - 0.5) * 0.2;
  const vk = veinMask(p, 0.18, 3, 23);
  p.r += (42 - p.r) * vk * 0.55; p.g += (38 - p.g) * vk * 0.55; p.b += (46 - p.b) * vk * 0.55;
  p.h -= vk * 0.1;
}, { bump: 1.3, amb: 0.42, spec: 0.16, specPow: 18, ao: 0.8, grain: 9 });

/* ============================ decals ============================ */
const DECAL = {};
function decalTex(size, fn) {
  const s = new Surf(size * 2, size * 2);
  fn(s, size * 2);
  const d = surfDown(s, 2), t = { w: d.w, h: d.h, data: d.data };
  t.mips = buildMips(t.w, t.h, t.data);
  return t;
}
DECAL.bullet = decalTex(24, (s, n) => {
  const c = n / 2;
  s.circle(c, c, n * 0.26, (x, y, d) => {
    const t = clamp(1 + d / (n * 0.26), 0, 1);
    return [14, 12, 12, 0.55 + 0.45 * (1 - t)];
  });
  s.rgrad(c, c, n * 0.44, [[0, [30, 28, 26], 0.0], [0.62, [24, 22, 20], 0.35], [0.86, [150, 146, 138], 0.5], [1, [120, 118, 112], 0]]);
  for (let i = 0; i < 9; i++) {                                     // radial cracks
    const a = hash2(i, 3) * TAU, L = n * (0.18 + hash2(i, 9) * 0.2);
    s.line(c + Math.cos(a) * n * 0.1, c + Math.sin(a) * n * 0.1, c + Math.cos(a) * L, c + Math.sin(a) * L, 1.6, [22, 20, 18], 0.5);
  }
});
DECAL.scorch = decalTex(48, (s, n) => {
  const c = n / 2;
  s.circle(c, c, n * 0.48, (x, y, d) => {
    const t = clamp(1 + d / (n * 0.48), 0, 1);
    const wob = fbm(x / n, y / n, 6, 3, 0.6, 5) * 0.35;
    return [12, 11, 10, Math.pow(Math.max(0, t + wob - 0.1), 1.3) * 0.85];
  });
  s.circle(c, c, n * 0.2, (x, y, d) => [6, 5, 5, Math.pow(clamp(1 + d / (n * 0.2), 0, 1), 0.7) * 0.95]);
});
DECAL.blood = decalTex(48, (s, n) => {
  const c = n / 2;
  s.circle(c, c, n * 0.4, (x, y, d) => {
    const t = clamp(1 + d / (n * 0.4), 0, 1);
    const wob = fbm(x / n, y / n, 5, 3, 0.62, 9) * 0.42;
    const a = Math.pow(Math.max(0, t * 0.9 + wob - 0.12), 1.15);
    return [72 - 24 * (1 - t), 12 + 8 * t, 14, a * 0.92];
  });
  for (let i = 0; i < 12; i++) {                                    // flung droplets
    const a = hash2(i, 11) * TAU, L = n * (0.3 + hash2(i, 17) * 0.22), r = n * (0.012 + hash2(i, 23) * 0.03);
    s.circle(c + Math.cos(a) * L, c + Math.sin(a) * L * 0.85, r, [58 + hash2(i, 5) * 26, 10, 14, 0.8]);
  }
});
DECAL.goo = decalTex(48, (s, n) => {
  const c = n / 2;
  s.circle(c, c, n * 0.42, (x, y, d) => {
    const t = clamp(1 + d / (n * 0.42), 0, 1);
    const wob = fbm(x / n, y / n, 5, 3, 0.6, 21) * 0.4;
    return [46, 92 + 40 * t, 30, Math.pow(Math.max(0, t * 0.92 + wob - 0.12), 1.1) * 0.85];
  });
  s.rgrad(c, c, n * 0.3, [[0, [130, 210, 90], 0.35], [1, [60, 120, 40], 0]], true);
});
DECAL.dust = decalTex(32, (s, n) => {
  const c = n / 2;
  s.circle(c, c, n * 0.45, (x, y, d) => {
    const t = clamp(1 + d / (n * 0.45), 0, 1);
    return [150, 140, 120, Math.pow(t, 1.6) * 0.3 * (0.4 + fbm(x / n, y / n, 7, 2, 0.6, 3) * 1.2)];
  });
});

/* ============================ wall fixtures (#400) ============================
   Things MOUNTED ON A WALL. A wall in this game used to be one material, floor to ceiling, for as
   far as the eye reached, and the generator's whole vocabulary of props stood on the floor at cell
   centres - so a room could only ever be identified by its colour. These four patches are painted
   at boot like every other material and placed by the generator (js/20_level.js placeWallFixtures)
   on geometry the wall pass already draws.
   They are ALBEDO + alpha, not light: the wall pass multiplies them by the face's own per-column
   light and fog (js/40_render.js, the fixture block), so a fixture in an unlit corner is dark and
   one under a lamp is bright. That is why their mid-tones sit close to the walls they hang on -
   these are decoration, and the exposure gate must not move because of them. */
const WFIX = {};
function fixTex(w, h, fn) {
  const s = new Surf(w, h);
  fn(s, w, h);
  const t = { w, h, data: s.data };
  t.mips = buildMips(t.w, t.h, t.data);
  return t;
}
/* speckle + a top-to-bottom grime wash, shared by all four: a fixture that is cleaner than the wall
   it is bolted to reads as a sticker. BOTH passes are multiply-only and alpha-preserving, and that is
   a measurement rather than a style rule. `lgrad` composites SOURCE-OVER, so the first draft's white
   stops (0.72 -> 1.0 alpha) laid a white sheet across the lower 55 % of every fixture: THE STACK's
   composited median went 89 -> 121.3 with no lamp in the level to compete with, and its own walls
   went with it (#403 review). And because a source-over pass writes ALPHA wherever it lands, a PIPE
   run - whose painter clears the sheet and paints only two conduits - came out of the wash with
   0 % transparent pixels, i.e. a translucent grey slab with pipes drawn on it.
   So the wash rides RGB only, and darkens TOWARD THE FLOOR, which is texture v = 0 here: the wall
   pass solves zv = (z - zB) / (zT - zB) (js/40_render.js, the fixture block), so texel row 0 is the
   bottom of the face. The silhouette the painter drew is restored afterwards, so speckle and wash
   together add no coverage a fixture did not ask for. */
function fixAge(s, w, h) {
  const D = s.data, A = new Uint8Array(D.length);
  for (let i = 0; i < D.length; i++) A[i] = D[i] >>> 24;
  s.grain(2.2, [[150, 152, 158], [42, 43, 47], [96, 84, 62]], 0.16);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const k = t < 0.55 ? 0.88 + (t / 0.55) * 0.12 : 1 - ((t - 0.55) / 0.45) * 0.12;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c = D[i];
      D[i] = pk((c & 255) * k, (c >> 8 & 255) * k, (c >> 16 & 255) * k, A[i]);
    }
  }
}

/* A DOOR FRAME for the reveal faces at a doorway: stiles with bolt heads, a lintel and a kick plate
   around a MIDDLE THAT IS NOT PAINTED AT ALL, so the mouth you walk through keeps the sector's own
   wall material and the frame reads as a frame (#403 review: an opaque plate across 94 % of the face
   replaced the brick instead of decorating it). v = 0 is the floor, so the kick plate is at the bottom
   and the lintel at the top - the first draft had both the other way round, because v runs from the
   face's low edge up. */
WFIX.DOOR = fixTex(64, 96, (s, w, h) => {
  s.rect(0, 0, w, h, [106, 110, 118], 1);                                 // frame plate, mid steel
  s.lgrad(0, 0, w, h, [[0, [140, 144, 152], 1], [0.5, [110, 114, 122], 1], [1, [84, 88, 96], 1]], 0);
  for (let y = h * 0.14 | 0; y < h * 0.80; y++)                           // punch the opening out
    for (let x = w * 0.20 | 0; x < w * 0.80; x++) s.data[y * w + x] = 0;
  for (const jx of [w * 0.10, w * 0.90]) {                                // jamb stiles
    s.rect(jx - w * 0.07, 0, w * 0.14, h, [118, 122, 130], 1);
    for (let k = 0; k < 6; k++) s.circle(jx, h * (0.08 + k * 0.168), 1.9, [122, 124, 130], 0.9);
  }
  s.rect(0, h * 0.02, w, h * 0.13, [94, 98, 106], 1);                      // kick plate, floor side
  s.rect(0, h * 0.15, w, h * 0.02, [168, 150, 62], 0.85);                 // one hazard line
  for (let k = 0; k < 8; k++) s.rect(k * w / 8, h * 0.15, w / 16, h * 0.02, [40, 38, 20], 0.8);
  s.rect(0, h * 0.86, w, h * 0.05, [36, 37, 42], 1);                      // lintel shadow, ceiling side
  fixAge(s, w, h);
});

/* A PIPE RUN: two conduits with saddle brackets and one valve wheel, dark enough to sit under a
   wall light without lifting the frame's exposure. */
WFIX.PIPE = fixTex(64, 64, (s, w, h) => {
  s.clear();
  const yA = h * 0.42, yB = h * 0.62;
  for (const y of [yA, yB]) {
    s.rect(0, y - h * 0.055, w, h * 0.11, [118, 122, 130], 1);
    s.lgrad(0, y - h * 0.055, w, h * 0.11, [[0, [46, 47, 52], 1], [0.3, [124, 128, 136], 1], [1, [40, 41, 46], 1]], Math.PI / 2);
  }
  for (let k = 0; k < 3; k++) {                                          // saddle brackets
    const bx = w * (0.12 + k * 0.38);
    s.rect(bx - w * 0.035, yA - h * 0.085, w * 0.07, (yB - yA) + h * 0.17, [102, 106, 114], 1);
    s.rect(bx - w * 0.05, yA - h * 0.09, w * 0.1, h * 0.03, [74, 76, 82], 1);
    s.rect(bx - w * 0.05, yB + h * 0.06, w * 0.1, h * 0.03, [74, 76, 82], 1);
  }
  const vx = w * 0.68;
  s.circle(vx, (yA + yB) / 2, h * 0.13, [96, 62, 48], 1);                 // valve wheel, rusted
  s.circle(vx, (yA + yB) / 2, h * 0.055, [58, 58, 64], 1);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + 0.35;
    s.line(vx, (yA + yB) / 2, vx + Math.cos(a) * h * 0.12, (yA + yB) / 2 + Math.sin(a) * h * 0.12, 2.6, [112, 74, 58], 1);
  }
  s.rect(vx - w * 0.02, yB - h * 0.02, w * 0.04, h * 0.1, [70, 72, 78], 1);
  fixAge(s, w, h);
});

/* A HAZARD BAND: chevron stripe between two seams, with rust bleeding out of the seams. Reads as
   "this is a service run" from across a room. */
WFIX.STRIPE = fixTex(64, 48, (s, w, h) => {
  s.rect(0, 0, w, h, [108, 112, 120], 1);
  const by = h * 0.30, bh = h * 0.40;
  s.rect(0, by, w, bh, [150, 134, 56], 1);
  for (let k = -1; k < 10; k++) {
    const x0 = k * w / 9;
    s.polygon([[x0, by], [x0 + w / 18, by], [x0 + w / 9, by + bh], [x0 + w / 18, by + bh]], [34, 33, 36], 1);
  }
  s.rect(0, by - h * 0.03, w, h * 0.03, [40, 41, 45], 1);
  s.rect(0, by + bh, w, h * 0.03, [40, 41, 45], 1);
  for (let k = 0; k < 5; k++) {                                          // panel seams + rust runs
    const sx = w * (0.06 + k * 0.23);
    s.rect(sx, 0, 1.4, h, [38, 39, 43], 0.9);
    s.rect(sx - 2, by * 0.4, 5, by * 0.55, [96, 58, 38], 0.4);
  }
  fixAge(s, w, h);
});

/* A VENT: a louvered grille in a bolted frame, the darkest thing on the wall - it puts a real
   black hole in an otherwise unbroken sheet, which is what makes a wall read as built. */
WFIX.VENT = fixTex(64, 48, (s, w, h) => {
  s.rect(0, 0, w, h, [110, 114, 122], 1);
  s.rect(w * 0.07, h * 0.09, w * 0.86, h * 0.82, [38, 40, 46], 1);
  for (let k = 0; k < 7; k++) {
    const ly = h * (0.12 + k * 0.112);
    s.rect(w * 0.07, ly, w * 0.86, h * 0.055, [104, 108, 116], 1);
    s.rect(w * 0.07, ly + h * 0.055, w * 0.86, h * 0.018, [44, 46, 52], 1);
  }
  for (const bx of [w * 0.035, w * 0.965]) for (const by of [h * 0.14, h * 0.86]) s.circle(bx, by, 2.1, [126, 128, 134], 0.9);
  s.rect(0, 0, w, h * 0.03, [48, 50, 55], 0.8);
  fixAge(s, w, h);
});

/* #400 take three: PURPOSE fixtures. DOOR/PIPE/STRIPE/VENT say "industrial", but a player can walk
   into a room and learn only its COLOUR from the walls. These three name what a room is FOR: a RACK
   is storage, a TANK holds fluid, a BOARD over a doorway points somewhere. They are albedo + alpha
   like the other four, painted at boot and placed by the generator's per-room pass; the wall pass
   lights them with the face's own light (js/40_render.js, the fixture block), so none of them is a
   brighter square. All three keep their silhouette mostly OPEN - shelf gaps, wall showing beside a
   tank, a board that is small on a big face - because a fixture that covers its whole face is a
   repaint of the wall, and the exposure gate is the proof that it is not. */
WFIX.RACK = fixTex(64, 64, (s, w, h) => {
  s.clear();
  for (const sx of [w * 0.04, w * 0.96])                       // two uprights, floor to near the top
    s.rect(sx - w * 0.05, h * 0.02, w * 0.10, h * 0.96, [104, 108, 116], 1);
  for (let k = 0; k < 3; k++) {
    const sy = h * (0.16 + k * 0.30);                           // shelf plate + its shadow line
    s.rect(0, sy, w, h * 0.05, [116, 120, 128], 1);
    s.rect(0, sy + h * 0.05, w, h * 0.02, [44, 45, 50], 0.9);
    for (let i = 0; i < 3; i++) {                               // what is standing on this shelf
      const cx = w * (0.20 + i * 0.30), hh = h * (0.10 + ((k + i) % 3) * 0.026);
      if ((k * 3 + i) % 4 === 3) {                              // a drum, on one shelf in three
        s.rect(cx - w * 0.075, sy - hh, w * 0.15, hh, [92, 96, 104], 1);
        s.rect(cx - w * 0.075, sy - hh * 0.62, w * 0.15, hh * 0.14, [150, 134, 56], 0.85);
      } else {                                                 // a crate, stencilled on one face
        s.rect(cx - w * 0.09, sy - hh, w * 0.18, hh, [110, 100, 84], 1);
        s.rect(cx - w * 0.09, sy - hh, w * 0.18, h * 0.012, [72, 66, 56], 0.9);
        s.rect(cx - w * 0.03, sy - hh * 0.7, w * 0.06, hh * 0.34, [150, 148, 152], 0.55);
      }
    }
  }
  s.rect(0, h * 0.94, w, h * 0.06, [86, 90, 98], 1);            // sill the uprights are bolted to
  fixAge(s, w, h);
});

/* A TANK: a vessel end-on, with a label band, a sight glass and the two stub pipes that make it a
   thing plumbed into the room rather than a panel bolted to it. */
WFIX.TANK = fixTex(64, 64, (s, w, h) => {
  s.clear();
  const x0 = w * 0.16, bw = w * 0.68;
  s.rrect(x0, h * 0.06, bw, h * 0.86, w * 0.10, [112, 116, 124], 1);
  s.lgrad(x0, 0, bw, h, [[0, [52, 54, 60], 1], [0.34, [126, 130, 138], 1], [0.72, [96, 100, 108], 1], [1, [46, 48, 54], 1]], 0);
  for (const by of [h * 0.20, h * 0.62])                        // hoop bands, and the rivets on them
    for (let x = x0; x < x0 + bw; x += 3) s.dot(x, by, 96, 100, 108, 0.8);
  s.rect(x0 + bw * 0.12, h * 0.34, bw * 0.76, h * 0.13, [58, 60, 66], 1);   // label plate
  for (let i = 0; i < 3; i++)                                   // stencilled marks, unreadable but
    s.rect(x0 + bw * (0.2 + i * 0.22), h * 0.375, bw * 0.12, h * 0.05, [178, 172, 160], 0.7);
  s.rect(x0 + bw * 0.72, h * 0.30, bw * 0.14, h * 0.40, [36, 44, 46], 1);   // sight glass
  s.rect(x0 + bw * 0.72, h * 0.52, bw * 0.14, h * 0.18, [86, 132, 122], 0.8);
  for (const px of [x0 + bw * 0.18, x0 + bw * 0.6])             // the two stubs it is plumbed in by
    s.rect(px - w * 0.03, h * 0.92, w * 0.06, h * 0.08, [98, 102, 110], 1);
  s.circle(x0 + bw * 0.5, h * 0.15, w * 0.05, [70, 72, 78], 1);             // manway cover
  fixAge(s, w, h);
});

/* A BOARD over the doorway: an arrow and a stencilled strip in a lit frame. It sits high on the face
   (FIX_SPAN puts it above the mouth), which is where a sign that means "this way to X" goes. */
WFIX.BOARD = fixTex(64, 40, (s, w, h) => {
  s.clear();
  s.rect(0, h * 0.10, w, h * 0.80, [98, 102, 110], 1);                        // plate
  s.lgrad(0, h * 0.10, w, h * 0.80, [[0, [130, 134, 142], 1], [1, [70, 73, 80], 1]], 0);
  s.rect(0, h * 0.10, w, h * 0.06, [56, 58, 64], 1);                          // top rail
  s.rect(w * 0.06, h * 0.26, w * 0.30, h * 0.44, [36, 38, 44], 1);            // sign field
  s.polygon([[w * 0.09, h * 0.48], [w * 0.22, h * 0.48], [w * 0.22, h * 0.36],
             [w * 0.31, h * 0.52], [w * 0.22, h * 0.68], [w * 0.22, h * 0.56],
             [w * 0.09, h * 0.56]], [196, 188, 150], 0.9);                    // the arrow
  for (let i = 0; i < 4; i++)                                                 // the words under it
    s.rect(w * (0.42 + i * 0.13), h * 0.44, w * 0.09, h * 0.10, [168, 164, 154], 0.65);
  for (const bx of [w * 0.03, w * 0.97]) for (const by of [h * 0.2, h * 0.8])
    s.circle(bx, by, 1.8, [126, 128, 134], 0.9);
  fixAge(s, w, h);
});

/* ============================ ceiling fittings (#413) ============================
   The plate you see when you look UP. #437 hung a light source on the ceiling over each room, which
   gave the sheet a pool of light and nothing to look at: the brightest thing in the frame had no
   cause in it. This is that cause - a surface-mounted strip light, painted at boot like every other
   material and placed by the generator wherever placeCeilFixtures hangs a source
   (js/20_level.js:MAP.ceilFix marks the cell). It is ALBEDO + alpha, exactly like the wall fixtures
   above (#400): the ceiling pass multiplies it by the column's own light and fog, so a fitting in an
   unlit bay is dim and one over a walkway is bright, and the plate never becomes a second lightmap.
   Its diffuser is a warm near-white rather than a blown-out white because the same pass still has to
   keep the ceiling band under the deck band (`view.js surface` ORDER) - the plate is about a metre
   across in a 40%-of-frame surface, so it reads as an object without lifting the band. */
const CFIX = {};
CFIX.STRIP = fixTex(48, 48, (s, w, h) => {
  s.clear();
  const c = w * 0.5;
  s.rrect(w * 0.05, h * 0.05, w * 0.90, h * 0.90, w * 0.10, [78, 82, 92], 1);      // housing tray
  s.rrect(w * 0.10, h * 0.10, w * 0.80, h * 0.80, w * 0.07, [42, 44, 50], 1);      // recessed rim
  s.rrect(w * 0.15, h * 0.15, w * 0.70, h * 0.70, w * 0.05, [212, 196, 162], 1);   // diffuser panel
  s.rgrad(c, c, w * 0.30, [[0, [244, 232, 204], 1], [1, [206, 188, 152], 0]], 0);  // hot at the tube
  for (const by of [h * 0.115, h * 0.885])                                         // the two tubes
    s.rect(w * 0.17, by - h * 0.028, w * 0.66, h * 0.056, [250, 242, 220], 0.85);
  for (const bx of [w * 0.09, w * 0.91]) for (const by of [h * 0.09, h * 0.91])     // corner bolts
    s.circle(bx, by, 1.9, [132, 134, 140], 0.9);
  s.rect(w * 0.05, h * 0.05, w * 0.90, h * 0.05, [58, 60, 66], 0.7);               // cast shade, one side
  fixAge(s, w, h);
});

/* Screen-space detail field: a smooth value-noise height map plus fine speckle,
 * sampled by pixel coordinates so material grain keeps constant on-screen size
 * instead of collapsing into the base texture's own frequency. */
const DETAIL = (() => {
  const S = 64, h = new Uint8Array(S * S), g = new Uint8Array(S * S);
  let r = 0x51ed270b;
  const rnd = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return (r >>> 0) / 4294967296; };
  for (let i = 0; i < S * S; i++) g[i] = (rnd() * 255) | 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 0;
    for (let o = 0; o < 4; o++) {
      const w = [[1, 0], [-1, 0], [0, 1], [0, -1]][o];
      a += g[((y + w[1] + S) & (S - 1)) * S + ((x + w[0] + S) & (S - 1))];
    }
    h[y * S + x] = a >> 2;
  }
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = Math.max(0, Math.min(255, h[i] * 0.72 + g[i] * 0.28)) | 0;
  return out;
})();
