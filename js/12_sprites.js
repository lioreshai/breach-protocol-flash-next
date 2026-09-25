'use strict';
/* ==================================================================
   12_sprites.js — characters and props, shaded as simple 3D forms
   Limbs are lit as cylinders and heads/torsos as domes against a fixed
   key light, with specular, cool rim light and joint occlusion, so the
   silhouettes read as volume instead of flat cut-outs.
   ================================================================== */
const KEY = (() => { const v = [-0.42, -0.60, 0.68], n = 1 / Math.hypot(v[0], v[1], v[2]); return v.map(x => x * n); })();

/* light projected on a tube's (perpendicular, surface-normal) basis */
// shape() consumes the returned colour immediately, so one scratch array serves every
// pixel of every sprite - these closures used to allocate millions of them at boot.
const SH = [0, 0, 0, 1];
const pow22 = d => { const d2 = d * d, d4 = d2 * d2, d8 = d4 * d4; return d8 * d8 * d4 * d2; };
const pow26 = d => { const d2 = d * d, d4 = d2 * d2, d8 = d4 * d4; return d8 * d8 * d8 * d2; };
function cylShade(col, x1, y1, x2, y2, r1, r2, o) {
  o = o || {};
  const ax = x2 - x1, ay = y2 - y1, L = Math.hypot(ax, ay) || 1e-6;
  const px = -ay / L, py = ax / L, rmax = Math.max(r1, r2, 1);
  const lp = KEY[0] * px + KEY[1] * py, lz = KEY[2];
  const amb = o.amb === undefined ? 0.52 : o.amb, spec = o.spec === undefined ? 0.35 : o.spec;
  const rim = o.rim === undefined ? 0.32 : o.rim, ao = o.ao === undefined ? 0.30 : o.ao;
  return (X, Y, d) => {
    const along = ((X - x1) * ax + (Y - y1) * ay) / (L * L);
    let t = ((X - x1) * px + (Y - y1) * py) / rmax;
    t = clamp(t, -1, 1);
    const nz = Math.sqrt(Math.max(0, 1 - t * t));
    const dif = Math.max(0, t * lp + nz * lz);
    const edge = smoothstep(-2.4, 0.2, d);                       // 1 at the silhouette
    const occ = 1 - ao * (0.5 - Math.abs(along - 0.5) * 2) * 1.6;
    const k = (amb + (1 - amb) * Math.pow(dif, 0.9)) * occ * 1.35;
    const sp = (o.specPow ? Math.pow(dif, o.specPow) : pow22(dif)) * spec;
    const at = Math.abs(t), rm = at * at * at * rim;
    SH[0] = col[0] * k + 255 * sp + rim * 90 * rm; SH[1] = col[1] * k + 250 * sp + rim * 110 * rm;
    SH[2] = col[2] * k + 245 * sp + rim * 150 * rm; SH[3] = col[3];
    return SH;
  };
}
/* dome/ellipsoid shading */
function domeShade(col, cx, cy, rx, ry, o) {
  o = o || {};
  const amb = o.amb === undefined ? 0.56 : o.amb, spec = o.spec === undefined ? 0.45 : o.spec;
  const rim = o.rim === undefined ? 0.30 : o.rim, blur = o.blur === undefined ? 0.85 : o.blur;
  return (X, Y, d) => {
    let nx = (X - cx) / Math.max(0.6, rx), ny = (Y - cy) / Math.max(0.6, ry);
    const q = Math.min(1, nx * nx + ny * ny);
    const nz = Math.sqrt(Math.max(0, 1 - q));
    const dif = Math.max(0, nx * KEY[0] + ny * KEY[1] + nz * KEY[2]);
    const k = (amb + (1 - amb) * Math.pow(dif, blur)) * 1.35;
    const sp = (o.specPow ? Math.pow(dif, o.specPow) : pow26(dif)) * spec;
    const rm = q * q * q * rim;
    SH[0] = col[0] * k + 255 * sp + rim * 70 * rm; SH[1] = col[1] * k + 248 * sp + rim * 92 * rm;
    SH[2] = col[2] * k + 242 * sp + rim * 140 * rm; SH[3] = col[3];
    return SH;
  };
}
/* flat-ish plate with a bevelled edge (armour plates, plates of chitin) */
function plateShade(col, cx, cy, rx, ry, o) {
  o = o || {};
  return (X, Y, d) => {
    const e = smoothstep(-3.5, -0.2, d);                          // 1 right at the rim
    const top = clamp(1 - (Y - cy) / (ry * 2.4), 0.55, 1.25);
    const k = (o.amb === undefined ? 0.62 : o.amb) * top * (1 - e * 0.45) + e * (o.bevel === undefined ? 0.34 : o.bevel);
    return [col[0] * k, col[1] * k, col[2] * k, col[3]];
  };
}
function contactShadow(s, cx, cy, rx, alpha) {
  s.rgrad(cx, cy, rx, [[0, [0, 0, 0], alpha], [0.6, [0, 0, 0], alpha * 0.55], [1, [0, 0, 0], 0]]);
}
function skinGrain(s, n, box, cols, a) { s.grain(n, cols || [[0, 0, 0], [255, 255, 255]], a || 0.10, box); }
function scar(s, x, y, L, a, col) { s.line(x, y, x + L * 0.7, y + L, Math.max(1, L * 0.1), col || [30, 8, 10], a || 0.5); }
function clawSet(s, x, y, dir, spread, len, col) {
  for (let i = -1; i <= 1; i++) {
    const a = dir + i * spread, l = len * (1 - Math.abs(i) * 0.18);
    s.polygon([[x, y], [x + Math.cos(a) * l, y + Math.sin(a) * l], [x + Math.cos(a + 0.22) * l * 0.42, y + Math.sin(a + 0.22) * l * 0.42]],
      plateShade(col, x + Math.cos(a) * l * 0.5, y + Math.sin(a) * l * 0.5, l * 0.5, l * 0.25, { amb: 0.62, bevel: 0.4 }));
  }
}
function limb(s, x1, y1, x2, y2, r1, r2, col, o) {
  s.tube(x1, y1, x2, y2, r1, r2, cylShade(col, x1, y1, x2, y2, r1, r2, o));
}
function joint(s, x, y, r, col, o) { s.circle(x, y, r, domeShade(col, x, y, r, r, o)); }

/* ---------------- shared body parts ---------------- */
function legPair(s, g, cfg) {
  const { hipY, legL, phase, w, h, col, col2, footCol, swingAmt, footW } = cfg;
  for (const sd of [-1, 1]) {
    const ph = phase + (sd < 0 ? 0 : Math.PI);
    const sw = Math.sin(ph) * swingAmt;
    const hx = g.x + sd * w * 0.11, kx = hx + sw * w * 0.10, ky = hipY + legL * 0.55;
    const fx = hx + sw * w * 0.17, fy = hipY + legL;
    limb(s, hx, hipY, kx, ky, w * 0.075, w * 0.058, col);
    limb(s, kx, ky, fx, fy, w * 0.056, w * 0.044, col2);
    joint(s, kx, ky, w * 0.058, col2, { amb: 0.3 });
    s.polygon([[fx - footW, fy], [fx + footW * 1.5, fy], [fx + footW * 1.6, fy + h * 0.012], [fx - footW, fy + h * 0.012]],
      plateShade(footCol, fx, fy, footW * 1.4, h * 0.02, { amb: 0.5 }));
    for (let t = 0; t < 3; t++) s.line(fx + footW * (0.4 + t * 0.4), fy + h * 0.004, fx + footW * (0.4 + t * 0.4), fy + h * 0.013, 1.6, [18, 6, 8], 0.6);
  }
}
function armPair(s, g, cfg) {
  const { shY, col, col2, clawCol, phase, w, h, reach, up } = cfg;
  for (const sd of [-1, 1]) {
    const ph = phase + (sd < 0 ? Math.PI : 0);
    const sx = g.x + sd * w * 0.17;
    const ex = sx + sd * w * 0.13 + sd * reach * w * 0.10, ey = shY + h * 0.17 - reach * h * 0.11 + Math.sin(ph) * h * 0.018;
    const hx = ex + sd * w * 0.07 + sd * reach * w * 0.10, hy = ey + h * 0.14 - reach * h * 0.11;
    limb(s, sx, shY, ex, ey, w * 0.062, w * 0.05, col);
    limb(s, ex, ey, hx, hy, w * 0.05, w * 0.042, col2);
    joint(s, ex, ey, w * 0.05, col2, { amb: 0.32 });
    joint(s, hx, hy, w * 0.046, col, { amb: 0.3 });
    clawSet(s, hx + sd * w * 0.02, hy, sd > 0 ? 0.35 : Math.PI - 0.35, 0.42, w * 0.10 + reach * w * 0.05, clawCol);
  }
}
function eyeGlow(s, x, y, r, col, hot) {
  s.circle(x, y, r * 1.9, (X, Y, d) => {
    const t = clamp(1 + d / (r * 1.9), 0, 1);
    return [col[0], col[1], col[2], (1 - t) * (1 - t) * 0.85];
  });
  s.ell(x, y, r, r * 0.72, domeShade(col, x, y - r * 0.2, r, r * 0.72, { amb: 0.95, spec: 1, rim: 0 }), 1);
  if (hot) s.ell(x + r * 0.15, y - r * 0.15, r * 0.4, r * 0.3, [255, 255, 240], 0.95);
}
function hornPair(s, cx, y, r, len, col) {
  for (const sd of [-1, 1]) {
    const bx = cx + sd * r * 0.72;
    s.polygon([[bx - r * 0.20, y], [bx + r * 0.22, y - r * 0.1],
    [bx + sd * len * 1.05, y - len * 0.95], [bx + sd * len * 0.35, y - len * 0.45]],
      plateShade(col, bx + sd * len * 0.5, y - len * 0.5, len * 0.6, len * 0.5, { amb: 0.6, bevel: 0.45 }));
  }
}

/* ================================ ENEMIES ================================ */
const ENEMY_DIM = { grunt: { w: 104, h: 156 }, hound: { w: 150, h: 104 }, brute: { w: 140, h: 158 } };
const PAINT = {};

PAINT.grunt = (s, w, h, p) => {
  const die = p.die || 0, atk = p.atk || 0, sw = p.sw || 0, ph = p.ph || 0;
  const squash = 1 - die * 0.66, yb = die * h * 0.26;
  const bob = Math.sin(sw * 2) * h * 0.012 * (die ? 0.2 : 1);
  const g = { x: w * 0.5 };
  const hipY = h * 0.60 * squash + yb + bob, legL = h * 0.30 * squash;
  const SKIN = [166, 62, 68], SKIN2 = [132, 44, 52], DARK = [76, 22, 30], PLATE = [186, 92, 74], BONE = [222, 208, 176];
  contactShadow(s, g.x, h * 0.985, w * 0.34, die > 0 ? 0.12 : 0.34);
  legPair(s, g, { hipY, legL, phase: sw, w, h, col: SKIN2, col2: DARK, footCol: DARK, swingAmt: die ? 0.25 : 1, footW: w * 0.05 });
  const torsoY = h * 0.44 * squash + yb + bob;
  // pelvis + torso as stacked domes
  s.ell(g.x, torsoY + h * 0.07, w * 0.185, h * 0.075 * squash, domeShade(SKIN2, g.x, torsoY + h * 0.07, w * 0.185, h * 0.075, { amb: 0.34 }));
  s.ell(g.x, torsoY, w * 0.175, h * 0.145 * squash, domeShade(SKIN, g.x, torsoY, w * 0.175, h * 0.145 * squash, { amb: 0.32, spec: 0.30 }));
  // pectoral plates + rib ridges
  for (const sd of [-1, 1]) s.ell(g.x + sd * w * 0.062, torsoY - h * 0.035, w * 0.072, h * 0.048 * squash,
    plateShade(PLATE, g.x + sd * w * 0.062, torsoY - h * 0.045, w * 0.072, h * 0.05, { amb: 0.6 }), 1);
  for (let i = 0; i < 4; i++) {
    const yy = torsoY + h * 0.005 + i * h * 0.026 * squash;
    s.line(g.x - w * 0.075, yy, g.x + w * 0.075, yy + h * 0.006, Math.max(1.4, h * 0.012), [52, 14, 18], 0.5);
  }
  // sternum spikes
  for (let i = 0; i < 4; i++) {
    const px = g.x - w * 0.03 + i * w * 0.022;
    s.polygon([[px, torsoY - h * 0.02], [px + w * 0.010, torsoY - h * 0.065], [px + w * 0.02, torsoY - h * 0.02]], plateShade(BONE, px, torsoY - h * 0.04, w * 0.02, h * 0.03, { amb: 0.7, bevel: 0.5 }));
  }
  const shY = torsoY - h * 0.055;
  armPair(s, g, { shY, col: SKIN, col2: SKIN2, clawCol: BONE, phase: sw, w, h, reach: atk });
  // shoulder caps over the arms
  for (const sd of [-1, 1]) s.ell(g.x + sd * w * 0.165, shY - h * 0.01, w * 0.075, h * 0.055,
    plateShade([140, 52, 58], g.x + sd * w * 0.165, shY - h * 0.02, w * 0.075, h * 0.055, { amb: 0.55 }), 1);
  // neck + head
  const headY = torsoY - h * 0.185 * squash, hr = w * 0.13;
  limb(s, g.x, torsoY - h * 0.07, g.x, headY + hr * 0.6, w * 0.045, w * 0.05, DARK);
  s.ell(g.x, headY, hr, hr * 0.9, domeShade([150, 50, 58], g.x, headY, hr, hr * 0.9, { amb: 0.34, spec: 0.34 }));
  hornPair(s, g.x, headY - hr * 0.42, hr, hr * 1.15, BONE);
  // brow, jaw, teeth
  s.ell(g.x, headY - hr * 0.26, hr * 0.82, hr * 0.30, plateShade([118, 38, 44], g.x, headY - hr * 0.34, hr * 0.82, hr * 0.3, { amb: 0.55 }), 1);
  const mouth = hr * (0.16 + atk * 0.42);
  s.ell(g.x, headY + hr * 0.34, hr * 0.60, mouth, (X, Y, d) => [16 + Math.max(0, d) * 2, 4, 6, 1]);
  for (let i = -3; i <= 3; i++) {
    const tx = g.x + i * hr * 0.16;
    s.polygon([[tx, headY + hr * 0.34 - mouth * 0.7], [tx + hr * 0.06, headY + hr * 0.34 - mouth * 0.7], [tx + hr * 0.03, headY + hr * 0.34 + mouth * 0.15]], [236, 226, 198, 1]);
  }
  eyeGlow(s, g.x - hr * 0.42, headY - hr * 0.10, hr * 0.17, atk > 0.3 ? [255, 244, 190] : [255, 170, 40], true);
  eyeGlow(s, g.x + hr * 0.42, headY - hr * 0.10, hr * 0.17, atk > 0.3 ? [255, 244, 190] : [255, 170, 40], true);
  scar(s, g.x + w * 0.03, torsoY - h * 0.02, h * 0.05, 0.45);
  skinGrain(s, 26, [w * 0.25, torsoY - h * 0.1, w * 0.75, hipY + legL], [[0, 0, 0], [255, 210, 190]], 0.07);
  if (die > 0) s.erode(g.x, torsoY, die * w * 0.62, 1000 + (p.seed || 0));
};

PAINT.hound = (s, w, h, p) => {
  const die = p.die || 0, atk = p.atk || 0, sw = p.sw || 0;
  const squash = 1 - die * 0.6, yb = die * h * 0.2;
  const bob = Math.sin(sw * 2) * h * 0.02 * (die ? 0.2 : 1);
  const g = { x: w * 0.5 }, by = h * 0.52 * squash + yb + bob;
  const SK = [92, 140, 68], SK2 = [64, 100, 50], BONE = [226, 236, 196], DARK = [34, 52, 30];
  contactShadow(s, g.x, h * 0.985, w * 0.4, die > 0 ? 0.12 : 0.32);
  // four legs, front pair driven off the rear pair
  for (const sd of [-1, 1]) for (let i = 0; i < 2; i++) {
    const ox = sd * w * (0.15 + i * 0.21), ph = sw + (sd < 0 ? 0 : Math.PI) + (i ? Math.PI * 0.5 : 0);
    const hx = g.x + ox, kx = hx + Math.sin(ph) * w * 0.05, ky = by + h * 0.16, fx = kx + Math.sin(ph) * w * 0.04, fy = by + h * 0.36 * squash;
    limb(s, hx, by, kx, ky, w * 0.035, w * 0.028, SK2);
    limb(s, kx, ky, fx, fy, w * 0.026, w * 0.02, DARK);
    s.polygon([[fx - w * 0.022, fy], [fx + w * 0.03, fy], [fx + w * 0.032, fy + h * 0.014], [fx - w * 0.024, fy + h * 0.014]], plateShade(DARK, fx, fy, w * 0.03, h * 0.02, { amb: 0.5 }));
  }
  // barrel + spine
  s.ell(g.x - w * 0.02, by, w * 0.27, h * 0.15 * squash, domeShade(SK, g.x - w * 0.02, by - h * 0.02, w * 0.27, h * 0.16 * squash, { amb: 0.34, spec: 0.3 }));
  s.ell(g.x + w * 0.13, by - h * 0.02, w * 0.14, h * 0.12 * squash, domeShade([106, 152, 78], g.x + w * 0.13, by - h * 0.04, w * 0.14, h * 0.13 * squash, { amb: 0.36 }));
  for (let i = -2; i <= 2; i++) {                                    // dorsal ridge
    const px = g.x + i * w * 0.085;
    s.polygon([[px, by - h * 0.135 * squash], [px + w * 0.014, by - h * 0.235 * squash], [px + w * 0.03, by - h * 0.125 * squash]],
      plateShade(BONE, px, by - h * 0.18, w * 0.03, h * 0.05, { amb: 0.66, bevel: 0.5 }));
  }
  skinGrain(s, 30, [w * 0.2, by - h * 0.16, w * 0.8, by + h * 0.16], [[0, 0, 0], [190, 230, 150]], 0.09);
  // tail
  const tx = g.x + w * 0.28, ty = by - h * 0.05 + Math.sin(sw * 1.5) * h * 0.05;
  limb(s, g.x + w * 0.21, by - h * 0.02, tx, ty, w * 0.022, w * 0.014, SK2);
  limb(s, tx, ty, tx + w * 0.07, ty - h * 0.10, w * 0.014, w * 0.008, BONE);
  // low head + snapping jaw
  const hx = g.x - w * 0.30, hy = by + h * 0.04 * squash;
  s.ell(hx, hy, w * 0.10, h * 0.085 * squash, domeShade([100, 146, 64], hx - w * 0.01, hy - h * 0.01, w * 0.10, h * 0.09 * squash, { amb: 0.34, spec: 0.34 }));
  const jaw = h * (0.03 + atk * 0.05);
  limb(s, hx - w * 0.02, hy + h * 0.02, hx - w * 0.17, hy + jaw + h * 0.02, w * 0.032, w * 0.022, SK2);
  s.ell(hx - w * 0.155, hy + h * (0.03 + atk * 0.035), w * 0.026, h * 0.022, [12, 18, 10], 1);
  for (let i = 0; i < 6; i++) {                                       // fangs top and bottom
    const fx = hx - w * (0.04 + i * 0.022);
    s.polygon([[fx, hy + h * 0.012], [fx - w * 0.006, hy + h * (0.055 + atk * 0.04)], [fx + w * 0.010, hy + h * 0.012]], [238, 244, 214, 1]);
    s.polygon([[fx - w * 0.004, hy + h * (0.03 + atk * 0.05)], [fx + w * 0.004, hy - h * 0.004], [fx + w * 0.012, hy + h * (0.03 + atk * 0.05)]], [226, 234, 200, 0.95]);
  }
  eyeGlow(s, hx + w * 0.022, hy - h * 0.032, w * 0.020, atk > 0.2 ? [240, 255, 240] : [186, 255, 90], true);
  for (const sd of [-1, 1]) hornPair(s, hx + w * 0.02, hy - h * 0.05, w * 0.05, w * 0.05, BONE);
  if (die > 0) s.erode(g.x, by, die * w * 0.55, 2000 + (p.seed || 0));
};

PAINT.brute = (s, w, h, p) => {
  const die = p.die || 0, atk = p.atk || 0, sw = p.sw || 0, ph = p.ph || 0;
  const squash = 1 - die * 0.55, yb = die * h * 0.26;
  const bob = Math.sin(sw * 2) * h * 0.010 * (die ? 0.2 : 1);
  const g = { x: w * 0.5 };
  const SK = [92, 78, 128], SK2 = [70, 58, 100], ARM = [114, 98, 156], DARK = [46, 36, 66], BONE = [150, 138, 190];
  const hipY = h * 0.655 * squash + yb + bob;
  contactShadow(s, g.x, h * 0.985, w * 0.40, die > 0 ? 0.12 : 0.38);
  legPair(s, g, { hipY, legL: h * 0.30 * squash, phase: sw, w, h, col: SK2, col2: DARK, footCol: DARK, swingAmt: die ? 0.2 : 1, footW: w * 0.062 });
  const ty = h * 0.42 * squash + yb + bob;
  s.ell(g.x, ty + h * 0.075, w * 0.24, h * 0.09 * squash, domeShade(SK2, g.x, ty + h * 0.075, w * 0.24, h * 0.09, { amb: 0.34 }));
  s.ell(g.x, ty - h * 0.01, w * 0.285, h * 0.145 * squash, domeShade(SK, g.x, ty - h * 0.02, w * 0.285, h * 0.15 * squash, { amb: 0.32, spec: 0.26 }));
  // pauldron plates
  for (const sd of [-1, 1]) {
    s.ell(g.x + sd * w * 0.245, ty - h * 0.055, w * 0.105, h * 0.095 * squash,
      plateShade(ARM, g.x + sd * w * 0.245, ty - h * 0.075, w * 0.105, h * 0.10, { amb: 0.6, bevel: 0.34 }), 1);
    for (let i = 0; i < 3; i++) s.line(g.x + sd * w * (0.19 + i * 0.045), ty - h * 0.10, g.x + sd * w * (0.20 + i * 0.045), ty + h * 0.02, Math.max(1.5, w * 0.012), [22, 16, 36], 0.55);
  }
  // glowing core
  const gl = 0.55 + 0.45 * Math.sin(ph * 4 + atk * 3);
  s.ell(g.x, ty + h * 0.035, w * 0.085, h * 0.065 * squash, (X, Y, d) => {
    const t = clamp(1 + d / (w * 0.085), 0, 1);
    return [150 + 90 * gl, 60 + 90 * gl, 230, 0.55 + 0.4 * t * gl];
  });
  s.rgrad(g.x, ty + h * 0.035, w * 0.20, [[0, [255, 220, 255], 0.5 * gl], [0.4, [170, 80, 255], 0.25 * gl], [1, [90, 30, 180], 0]], true);
  s.ell(g.x, ty + h * 0.035, w * 0.042, h * 0.034 * squash, [255, 240, 255], 1);
  // spine spikes
  for (let i = 0; i < 6; i++) {
    const px = g.x - w * 0.19 + i * w * 0.076;
    s.polygon([[px, ty - h * 0.10], [px + w * 0.018, ty - h * 0.175], [px + w * 0.04, ty - h * 0.09]], plateShade(BONE, px, ty - h * 0.13, w * 0.04, h * 0.04, { amb: 0.65, bevel: 0.5 }));
  }
  const sy = ty - h * 0.06;
  armPair(s, g, { shY: sy, col: SK, col2: SK2, clawCol: BONE, phase: sw, w, h, reach: atk });
  for (const sd of [-1, 1]) limb(s, g.x + sd * w * 0.25, sy, g.x + sd * w * 0.30, sy + h * 0.16, w * 0.055, w * 0.05, SK2);
  const hy = ty - h * 0.16 * squash;
  limb(s, g.x, ty - h * 0.09, g.x, hy + h * 0.03, w * 0.05, w * 0.055, DARK);
  s.ell(g.x, hy, w * 0.085, h * 0.06 * squash, domeShade(SK2, g.x, hy, w * 0.085, h * 0.062, { amb: 0.34, spec: 0.3 }));
  s.ell(g.x, hy + h * 0.018, w * 0.05, h * 0.022, [10, 8, 18], 1);
  for (let i = -2; i <= 2; i++) s.line(g.x + i * w * 0.02, hy + h * 0.006, g.x + i * w * 0.02, hy + h * 0.03, Math.max(1, w * 0.008), [220, 214, 240], 0.8);
  for (const sd of [-1, 1]) eyeGlow(s, g.x + sd * w * 0.033, hy - h * 0.012, w * 0.017, atk > 0.3 ? [255, 255, 255] : [200, 140, 255], true);
  skinGrain(s, 34, [w * 0.2, ty - h * 0.12, w * 0.8, ty + h * 0.12], [[0, 0, 0], [190, 170, 235]], 0.07);
  if (die > 0) s.erode(g.x, ty, die * w * 0.6, 3000 + (p.seed || 0));
};

const ENEMY = {};
function buildEnemy(kind) {
  const dim = ENEMY_DIM[kind], F = { walk: [], atk: [], die: [] };
  let frame = 0;
  const mk = (list, n, fill) => {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / n : 0;
      const s = new Surf(dim.w, dim.h);
      fill(s, t, frame++);
      s.lift(1.55, 8);
      const tex = texFromSurf(s);
      tex.sprite = true;
      list.push(tex);
    }
  };
  mk(F.walk, 8, (s, t) => PAINT[kind](s, dim.w, dim.h, { sw: t * TAU }));
  mk(F.atk, 4, (s, t) => PAINT[kind](s, dim.w, dim.h, { sw: 0, atk: Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5), ph: 0 }));
  mk(F.die, 6, (s, t, seed) => PAINT[kind](s, dim.w, dim.h, { die: t, sw: 0, seed }));
  F.idle = F.walk;
  ENEMY[kind] = F;
}
['grunt', 'hound', 'brute'].forEach(buildEnemy);

/* ============================ props & pickups ============================ */
const PROP = {};
function propTex(w, h, fn) {
  const s = new Surf(w, h);
  fn(s, w, h);
  s.lift(1.35, 6);
  const t = texFromSurf(s);
  t.sprite = true;
  return t;
}
PROP.health = propTex(56, 56, (s, w, h) => {
  contactShadow(s, w / 2, h * 0.9, w * 0.32, 0.4);
  s.rrect(w * 0.16, h * 0.30, w * 0.68, h * 0.52, 3, domeShade([228, 234, 242], w * 0.4, h * 0.36, w * 0.4, h * 0.42, { amb: 0.42, spec: 0.5 }));
  s.rrect(w * 0.16, h * 0.66, w * 0.68, h * 0.16, 2, [136, 148, 166, 1]);
  s.rgrad(w * 0.36, h * 0.40, w * 0.2, [[0, [255, 255, 255], 0.3], [1, [255, 255, 255], 0]], true);
  s.rect(w * 0.43, h * 0.40, w * 0.14, h * 0.30, domeShade([214, 44, 36], w * 0.5, h * 0.42, w * 0.22, h * 0.3, { amb: 0.55, spec: 0.2 }));
  s.rect(w * 0.33, h * 0.50, w * 0.34, h * 0.11, domeShade([214, 44, 36], w * 0.5, h * 0.42, w * 0.3, h * 0.3, { amb: 0.55, spec: 0.2 }));
  s.line(w * 0.17, h * 0.31, w * 0.83, h * 0.31, 1.6, [255, 255, 255], 0.35);
  skinGrain(s, 8, [w * 0.16, h * 0.3, w * 0.84, h * 0.82], [[0, 0, 0], [255, 255, 255]], 0.1);
});
PROP.ammo = propTex(56, 56, (s, w, h) => {
  contactShadow(s, w / 2, h * 0.88, w * 0.32, 0.4);
  s.rrect(w * 0.14, h * 0.42, w * 0.72, h * 0.40, 3, domeShade([124, 138, 86], w * 0.38, h * 0.46, w * 0.44, h * 0.42, { amb: 0.42, spec: 0.25 }));
  s.rrect(w * 0.14, h * 0.42, w * 0.72, h * 0.09, 2, [64, 74, 44, 1]);
  for (let i = 0; i < 5; i++) {
    const x = w * 0.21 + i * w * 0.13;
    s.rrect(x, h * 0.52, w * 0.07, h * 0.22, 1.5, domeShade([212, 168, 74], x, h * 0.54, w * 0.09, h * 0.24, { amb: 0.45, spec: 0.8, specPow: 30 }));
    s.ell(x + w * 0.035, h * 0.53, w * 0.032, h * 0.028, [240, 216, 150, 1]);
  }
  s.line(w * 0.2, h * 0.47, w * 0.8, h * 0.47, 2, [26, 30, 18], 0.6);
  skinGrain(s, 10, [w * 0.14, h * 0.42, w * 0.86, h * 0.82], [[0, 0, 0], [210, 220, 180]], 0.12);
});
PROP.armor = propTex(56, 56, (s, w, h) => {
  contactShadow(s, w / 2, h * 0.9, w * 0.30, 0.4);
  s.rrect(w * 0.22, h * 0.30, w * 0.56, h * 0.50, 6, domeShade([54, 124, 168], w * 0.42, h * 0.36, w * 0.34, h * 0.48, { amb: 0.4, spec: 0.5 }));
  s.polygon([[w * 0.34, h * 0.38], [w * 0.66, h * 0.38], [w * 0.5, h * 0.70]],
    (X, Y, d) => { const t = clamp((Y - h * 0.38) / (h * 0.32), 0, 1); return [90 + 60 * t, 220 - 40 * t, 255, 0.9]; });
  s.rgrad(w * 0.5, h * 0.5, w * 0.3, [[0, [220, 255, 255], 0.45], [1, [120, 220, 255], 0]], true);
  s.line(w * 0.23, h * 0.31, w * 0.77, h * 0.31, 2, [180, 240, 255], 0.5);
});
PROP.barrel = propTex(64, 92, (s, w, h) => {
  contactShadow(s, w / 2, h * 0.965, w * 0.36, 0.45);
  // cylinder: horizontal curvature baked into the shade function
  const cyl = (X, Y, d) => {
    const t = clamp((X - w * 0.5) / (w * 0.34), -1, 1), nz = Math.sqrt(Math.max(0, 1 - t * t));
    const dif = Math.max(0, t * KEY[0] + nz * KEY[2]);
    const k = 0.30 + 0.8 * dif, sp = Math.pow(dif, 26) * 0.5;
    return [142 * k + 255 * sp, 54 * k + 240 * sp, 36 * k + 230 * sp, 1];
  };
  s.rrect(w * 0.16, h * 0.14, w * 0.68, h * 0.78, 4, cyl);
  s.ell(w * 0.5, h * 0.145, w * 0.34, h * 0.028, domeShade([120, 46, 34], w * 0.44, h * 0.13, w * 0.34, h * 0.05, { amb: 0.5 }));
  for (const yy of [h * 0.30, h * 0.70]) s.rect(w * 0.155, yy, w * 0.69, h * 0.045, (X, Y, d) => cyl(X, Y - h * 0.06, d));
  s.rect(w * 0.16, h * 0.42, w * 0.68, h * 0.13, (X, Y, d) => {
    const c = cyl(X, Y, d), ch = Math.abs(((X - w * 0.16) / (w * 0.115) + (Y / h * 1.2)) % 1) < 0.5 ? 1 : 0;
    return ch ? [214 * (c[0] / 142), 172 * (c[1] / 54), 32 * (c[2] / 36 + 0.4), 1] : c;
  });
  s.circle(w * 0.5, h * 0.24, w * 0.075, domeShade([196, 204, 214], w * 0.47, h * 0.22, w * 0.075, w * 0.075, { amb: 0.5, spec: 0.8 }));
  rustBlob(s, w, h);
  skinGrain(s, 16, [w * 0.16, h * 0.14, w * 0.84, h * 0.92], [[0, 0, 0], [255, 190, 150]], 0.12);
});
function rustBlob(s, w, h) {
  for (let i = 0; i < 5; i++) {
    const x = w * (0.18 + hash2(i, 5) * 0.64), y = h * (0.2 + hash2(i, 9) * 0.68), r = w * (0.05 + hash2(i, 13) * 0.09);
    s.circle(x, y, r, (X, Y, d) => { const t = clamp(1 + d / r, 0, 1); return [122 - 20 * (1 - t), 62, 32, Math.pow(t, 0.8) * 0.55]; });
  }
}
PROP.crate = propTex(64, 64, (s, w, h) => {
  contactShadow(s, w / 2, h * 0.94, w * 0.36, 0.42);
  s.rrect(w * 0.14, h * 0.26, w * 0.72, h * 0.64, 2, domeShade([150, 108, 62], w * 0.36, h * 0.34, w * 0.5, h * 0.6, { amb: 0.42, spec: 0.12, blur: 1.2 }));
  for (let i = 0; i < 4; i++) {                                     // planks with grain
    const y = h * (0.28 + i * 0.155);
    s.rect(w * 0.15, y, w * 0.70, h * 0.135, (X, Y, d) => {
      const n = vnoise((X / w) * 8, (Y / h) * 2, 16, 12);
      const k = 0.82 + n * 0.42;
      return [158 * k, 112 * k, 64 * k, 1];
    });
    s.line(w * 0.15, y + h * 0.135, w * 0.85, y + h * 0.135, 1.6, [42, 28, 14], 0.7);
  }
  s.polygon([[w * 0.14, h * 0.26], [w * 0.86, h * 0.26], [w * 0.86, h * 0.9]], [70, 48, 24, 0.28]);
  for (const [x, y] of [[0.19, 0.31], [0.81, 0.31], [0.19, 0.85], [0.81, 0.85]])
    s.circle(w * x, h * y, w * 0.026, domeShade([150, 156, 166], w * (x - 0.01), h * (y - 0.01), w * 0.026, w * 0.026, { amb: 0.5, spec: 0.8 }));
  s.rrect(w * 0.14, h * 0.26, w * 0.72, h * 0.64, 2, (X, Y, d) => [0, 0, 0, smoothstep(-3, -0.5, d) * 0.5]);
});
PROP.lamp = propTex(56, 92, (s, w, h) => {
  s.rrect(w * 0.44, h * 0.34, w * 0.12, h * 0.58, 2, domeShade([44, 50, 60], w * 0.44, h * 0.4, w * 0.12, h * 0.55, { amb: 0.5, spec: 0.3 }));
  s.rrect(w * 0.32, h * 0.90, w * 0.36, h * 0.06, 2, domeShade([62, 70, 82], w * 0.42, h * 0.9, w * 0.3, h * 0.06, { amb: 0.55 }));
  s.ell(w * 0.5, h * 0.20, w * 0.20, h * 0.035, [40, 46, 54, 1]);
  s.rgrad(w * 0.5, h * 0.26, w * 0.46, [[0, [255, 244, 214], 0.95], [0.30, [255, 196, 110], 0.55], [0.7, [255, 150, 50], 0.18], [1, [255, 120, 30], 0]], true);
  s.ell(w * 0.5, h * 0.26, w * 0.11, h * 0.028, [255, 252, 238, 1]);
  s.rgrad(w * 0.5, h * 0.34, w * 0.3, [[0, [255, 190, 90], 0.25], [1, [255, 140, 40], 0]], true);
});
PROP.grenade = propTex(28, 32, (s, w, h) => {
  s.ell(w * 0.5, h * 0.58, w * 0.28, h * 0.30, domeShade([78, 90, 70], w * 0.44, h * 0.5, w * 0.28, h * 0.3, { amb: 0.4, spec: 0.3 }));
  s.rrect(w * 0.42, h * 0.18, w * 0.18, h * 0.14, 1.5, domeShade([148, 156, 150], w * 0.46, h * 0.2, w * 0.12, h * 0.1, { amb: 0.5, spec: 0.7 }));
  s.line(w * 0.56, h * 0.2, w * 0.7, h * 0.14, 2, [180, 186, 180], 0.9);
});
PROP.orb = [];
for (let i = 0; i < 4; i++) PROP.orb.push(propTex(44, 44, (s, w, h) => {
  const a = i / 4 * TAU, r = w * (0.13 + 0.02 * Math.cos(a * 2));
  s.rgrad(w / 2, h / 2, w * 0.48, [[0, [240, 255, 220], 0.95], [0.3, [150, 255, 90], 0.6], [0.7, [70, 210, 60], 0.22], [1, [30, 150, 30], 0]], true);
  s.circle(w / 2 + Math.cos(a) * w * 0.05, h / 2 + Math.sin(a) * h * 0.05, r, [244, 255, 224, 1]);
  for (let k = 0; k < 3; k++) s.line(w / 2 + Math.cos(a + k * 2.1) * w * 0.1, h / 2 + Math.sin(a + k * 2.1) * h * 0.1,
    w / 2 + Math.cos(a + k * 2.1) * w * 0.34, h / 2 + Math.sin(a + k * 2.1) * h * 0.34, 1.6, [200, 255, 140], 0.5);
}));
PROP.portal = [];
for (let i = 0; i < 8; i++) PROP.portal.push(propTex(84, 140, (s, w, h) => {
  const ph = i / 8 * TAU;
  s.rgrad(w / 2, h / 2, w * 0.5, [[0, [236, 255, 255], 0.95], [0.35, [90, 225, 255], 0.55], [0.75, [30, 150, 220], 0.2], [1, [10, 90, 170], 0]], true);
  for (let k = 0; k < 10; k++) {
    const a = ph + k / 10 * TAU, rr = 0.16 + 0.3 * ((k % 4) / 3);
    s.rgrad(w / 2 + Math.cos(a) * w * rr * 0.4, h / 2 + Math.sin(a) * h * rr * 0.4, w * (0.10 - (k % 4) * 0.015),
      [[0, [190, 255, 255], 0.5], [1, [80, 200, 255], 0]], true);
  }
  s.ell(w / 2, h / 2, w * 0.07, h * 0.17, [250, 255, 255, 0.92]);
}));
