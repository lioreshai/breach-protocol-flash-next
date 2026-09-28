'use strict';
/* ==================================================================
   05_paint.js — tiny software rasteriser + noise/SDF kit
   Every texture and sprite in the game is painted with this, in plain JS,
   so the headless harness renders exactly what the browser does and boot
   costs less than thousands of 2D path calls. Surfaces are straight-alpha
   Uint32Array bitmaps in ABGR order (the layout ImageData uses on LE).
   ================================================================== */

function mulberry(seed) {
  let s = seed | 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const i0 = v => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
const pk = (r, g, b, a) => ((a << 24) | (i0(b) << 16) | (i0(g) << 8) | i0(r)) >>> 0;

/* ---------- tileable value noise ---------- */
const _nCache = new Map();
let _lk = -1, _lt = null;
function noiseTable(period, seed) {
  const key = period * 100003 + (seed & 1023);
  if (key === _lk) return _lt;                              // fbm hits the same table thousands of times in a row
  let t = _nCache.get(key);
  if (!t) {
    t = new Float32Array(period * period);
    const g = mulberry(seed * 7919 + period * 13);
    for (let i = 0; i < t.length; i++) t[i] = g();
    if (_nCache.size > 64) _nCache.clear();
    _nCache.set(key, t);
  }
  _lk = key; _lt = t;
  return t;
}
function vnoise(u, v, period, seed) {           // u,v in 0..1 tile units, wraps
  const t = noiseTable(period, seed), P = period;
  const x = u * P, y = v * P;
  const xi = x | 0, yi = y | 0;                                // u,v are always in [0,1)
  const x0 = xi >= P ? P - 1 : xi < 0 ? 0 : xi, x1 = x0 + 1 === P ? 0 : x0 + 1;
  const y0 = yi >= P ? P - 1 : yi < 0 ? 0 : yi, y1 = y0 + 1 === P ? 0 : y0 + 1;
  let xf = x - xi, yf = y - yi;
  const su = xf * xf * (3 - 2 * xf), sv = yf * yf * (3 - 2 * yf);
  const r0 = y0 * P, r1 = y1 * P;
  const a = t[r0 + x0], b = t[r0 + x1], c = t[r1 + x0], d = t[r1 + x1];
  const p = a + (b - a) * su, q = c + (d - c) * su;
  return p + (q - p) * sv;
}
function fbm(u, v, base, oct, gain, seed) {     // octave freqs stay integer -> still tileable
  let s = 0, amp = 1, norm = 0, f = base;
  for (let i = 0; i < oct; i++) { s += vnoise(u, v, f, seed + i * 131) * amp; norm += amp; amp *= gain; f *= 2; }
  return s / norm;
}
const ridge = (u, v, base, oct, seed) => 1 - Math.abs(fbm(u, v, base, oct, 0.55, seed) * 2 - 1);
const turb = (u, v, base, oct, seed) => fbm(u, v, base, oct, 0.6, seed) * 0.6 + ridge(u, v, base * 2, 2, seed + 7) * 0.4;

/* ---------- SDF kit ---------- */
const sdCircle = (x, y, r) => Math.hypot(x, y) - r;
const sdBox = (x, y, bx, by) => { const dx = Math.abs(x) - bx, dy = Math.abs(y) - by; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0); };
const sdRoundBox = (x, y, bx, by, r) => sdBox(x, y, Math.max(0, bx - r), Math.max(0, by - r)) - r;
const sdSeg = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
  let t = L > 0 ? (px * ex + py * ey) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ex * t, py - ey * t);
};
const sdEllipse = (x, y, rx, ry) => (Math.hypot(x / rx, y / ry) - 1) * Math.min(rx, ry);
const smin = (a, b, k) => { const h = clamp((b - a + k) / (2 * k), 0, 1); return Math.min(a, b) - k * h * (1 - h); };
const smax = (a, b, k) => { const h = clamp((a - b + k) / (2 * k), 0, 1); return Math.max(a, b) + k * h * (1 - h); };
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / ((e1 - e0) || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
function polyDist(pts, px, py) {                 // negative inside (ccw or cw, any convex/concave)
  let d = -1e9;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1], ddx = px - a[0], ddy = py - a[1], L = ex * ex + ey * ey;
    let t = L > 0 ? (ddx * ex + ddy * ey) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cross = ex * ddy - ey * ddx, q = Math.hypot(ddx - ex * t, ddy - ey * t);
    d = Math.max(d, cross >= 0 ? q : -q);
  }
  return d;
}
function rampColor(stops, t) {
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const a = stops[i], b = stops[i + 1] || a;
  const k = clamp((t - a[0]) / ((b[0] - a[0]) || 1e-6), 0, 1);
  const al = (a[2] === undefined ? 1 : a[2]) + (((b[2] === undefined ? 1 : b[2]) - (a[2] === undefined ? 1 : a[2]))) * k;
  return [a[1][0] + (b[1][0] - a[1][0]) * k, a[1][1] + (b[1][1] - a[1][1]) * k, a[1][2] + (b[1][2] - a[1][2]) * k, al];
}

/* ---------- surface ---------- */
function Surf(w, h) { this.w = w; this.h = h; this.data = new Uint32Array(w * h); }
Surf.prototype.clear = function () { this.data.fill(0); return this; };

/* source-over single pixel */
Surf.prototype.dot = function (x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return this;
  const i = (y | 0) * this.w + (x | 0), d = this.data[i], da = d >>> 24;
  if (da === 0) { this.data[i] = pk(r, g, b, a * 255); return this; }
  const oA = a + da / 255 * (1 - a);
  this.data[i] = pk((r * a + (d & 255) * (da / 255) * (1 - a)) / oA,
    (g * a + (d >> 8 & 255) * (da / 255) * (1 - a)) / oA,
    (b * a + (d >> 16 & 255) * (da / 255) * (1 - a)) / oA, oA * 255);
  return this;
};
Surf.prototype.dotAdd = function (x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return this;
  const i = (y | 0) * this.w + (x | 0), d = this.data[i];
  this.data[i] = pk((d & 255) + r * a, (d >> 8 & 255) + g * a, (d >> 16 & 255) + b * a, Math.max(d >>> 24, a * 255));
  return this;
};

/* The one real primitive: fill the region fn(px,py)<=0, 1-pixel feathered edge.
   shade(px,py,d) -> [r,g,b,a?] , a===0 leaves the pixel untouched. */
Surf.prototype.shape = function (fn, shade, opt) {
  opt = opt || {};
  const aa = opt.aa === undefined ? 0.85 : opt.aa;
  const mode = opt.add ? 'add' : 'over';
  let x0, y0, x1, y1;
  if (opt.box) {                                   // caller supplies bounds, skips the probe scan
    x0 = Math.max(0, Math.floor(opt.box[0])); y0 = Math.max(0, Math.floor(opt.box[1]));
    x1 = Math.min(this.w - 1, Math.ceil(opt.box[2])); y1 = Math.min(this.h - 1, Math.ceil(opt.box[3]));
  } else {
    let X0 = 1e9, Y0 = 1e9, X1 = -1e9, Y1 = -1e9;
    const P = 64;
    for (let i = 0; i <= P; i++) {
      const px = i / P * this.w;
      for (let k = 0; k <= P; k++) {
        const py = k / P * this.h;
        if (fn(px, py) <= aa) { if (px < X0) X0 = px; if (px > X1) X1 = px; if (py < Y0) Y0 = py; if (py > Y1) Y1 = py; }
      }
    }
    if (X1 < X0) return this;
    x0 = Math.max(0, Math.floor(X0 - 1)); x1 = Math.min(this.w - 1, Math.ceil(X1 + 1));
    y0 = Math.max(0, Math.floor(Y0 - 1)); y1 = Math.min(this.h - 1, Math.ceil(Y1 + 1));
  }
  if (x1 < x0 || y1 < y0) return this;
  const D = this.data, W = this.w;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, d = fn(px, py);
      if (d > aa) continue;
      const cov = d < -aa ? 1 : 0.5 - d / (2 * aa);
      const c = shade(px, py, d);
      if (!c || c[3] === 0) continue;
      const a = c[3] === undefined ? cov : cov * c[3];
      if (a <= 0.002) continue;
      const i = y * W + x, dst = D[i];
      if (mode === 'add') {
        D[i] = pk((dst & 255) + c[0] * a, (dst >> 8 & 255) + c[1] * a, (dst >> 16 & 255) + c[2] * a, Math.max(dst >>> 24, a * 255));
        continue;
      }
      const da = dst >>> 24;
      if (da === 0 || a > 0.996) { D[i] = pk(c[0], c[1], c[2], Math.max(a * 255, da === 0 ? a * 255 : 255 * a)); if (a > 0.996) D[i] = pk(c[0], c[1], c[2], Math.max(255 * a, da)); continue; }
      const oA = a + da / 255 * (1 - a);
      D[i] = pk((c[0] * a + (dst & 255) * (da / 255) * (1 - a)) / oA,
        (c[1] * a + (dst >> 8 & 255) * (da / 255) * (1 - a)) / oA,
        (c[2] * a + (dst >> 16 & 255) * (da / 255) * (1 - a)) / oA, oA * 255);
    }
  }
  return this;
};
Surf.prototype.rect = function (x, y, w, h, col, a) {
  return this.shape((px, py) => Math.max(Math.abs(px - (x + w / 2)) - w / 2, Math.abs(py - (y + h / 2)) - h / 2),
    shadeFn(col, a), { box: [x, y, x + w, y + h] });
};
Surf.prototype.rrect = function (x, y, w, h, r, col, a) {
  const cx = x + w / 2, cy = y + h / 2;
  return this.shape((px, py) => sdRoundBox(px - cx, py - cy, w / 2, h / 2, r), shadeFn(col, a), { box: [x, y, x + w, y + h] });
};
Surf.prototype.ell = function (cx, cy, rx, ry, col, a, rot) {
  const c = Math.cos(-(rot || 0)), s = Math.sin(-(rot || 0));
  const R = Math.hypot(rx, ry) + 1;
  return this.shape((px, py) => {
    const dx = px - cx, dy = py - cy;
    return sdEllipse(dx * c - dy * s, dx * s + dy * c, Math.max(0.5, rx), Math.max(0.5, ry));
  }, shadeFn(col, a), { box: [cx - R, cy - R, cx + R, cy + R] });
};
Surf.prototype.circle = function (cx, cy, r, col, a) {
  return this.shape((px, py) => sdCircle(px - cx, py - cy, r), shadeFn(col, a), { box: [cx - r, cy - r, cx + r, cy + r] });
};
Surf.prototype.polygon = function (pts, col, a) {
  let mx = 1e9, my = 1e9, Mx = -1e9, My = -1e9;
  for (const p of pts) { if (p[0] < mx) mx = p[0]; if (p[0] > Mx) Mx = p[0]; if (p[1] < my) my = p[1]; if (p[1] > My) My = p[1]; }
  return this.shape((px, py) => polyDist(pts, px, py), shadeFn(col, a), { box: [mx, my, Mx, My] });
};
Surf.prototype.line = function (x1, y1, x2, y2, wd, col, a) {
  const r = wd / 2;
  return this.shape((px, py) => sdSeg(px, py, x1, y1, x2, y2) - r, shadeFn(col, a),
    { box: [Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r] });
};
Surf.prototype.tube = function (x1, y1, x2, y2, r1, r2, col, a) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1e-6, nx = -dy / L, ny = dx / L;
  const pts = [[x1 + nx * r1, y1 + ny * r1], [x2 + nx * r2, y2 + ny * r2], [x2 - nx * r2, y2 - ny * r2], [x1 - nx * r1, y1 - ny * r1]];
  const R = Math.max(r1, r2);
  return this.shape((px, py) => smin(polyDist(pts, px, py), Math.min(Math.hypot(px - x1, py - y1) - r1, Math.hypot(px - x2, py - y2) - r2), 2), shadeFn(col, a),
    { box: [Math.min(x1, x2) - R, Math.min(y1, y2) - R, Math.max(x1, x2) + R, Math.max(y1, y2) + R] });
};
Surf.prototype.rgrad = function (cx, cy, r, stops, add) {
  return this.shape((px, py) => sdCircle(px - cx, py - cy, r),
    (px, py) => rampColor(stops, Math.min(1, Math.hypot(px - cx, py - cy) / r)), { add: !!add, aa: 1.2, box: [cx - r, cy - r, cx + r, cy + r] });
};
Surf.prototype.lgrad = function (x, y, w, h, stops, ang) {
  const c = Math.cos(ang || 0), s = Math.sin(ang || 0), L = (Math.abs(w * c) + Math.abs(h * s)) || 1;
  const ox = x + w / 2, oy = y + h / 2;
  return this.shape((px, py) => Math.max(Math.abs(px - ox) - w / 2, Math.abs(py - oy) - h / 2),
    (px, py) => rampColor(stops, clamp(((px - ox) * c + (py - oy) * s) / L + 0.5, 0, 1)), { box: [x, y, x + w, y + h] });
};
/* per-pixel post passes */
Surf.prototype.mulRGB = function (mr, mg, mb) {
  for (let i = 0; i < this.data.length; i++) {
    const c = this.data[i];
    this.data[i] = pk((c & 255) * mr, (c >> 8 & 255) * mg, (c >> 16 & 255) * mb, c >>> 24);
  }
  return this;
};
Surf.prototype.lift = function (k, a) {          // sprites are albedo: they get lit again in the scene
  for (let i = 0; i < this.data.length; i++) {
    const c = this.data[i];
    this.data[i] = pk((c & 255) * k + a, (c >> 8 & 255) * k + a, (c >> 16 & 255) * k + a, c >>> 24);
  }
  return this;
};
Surf.prototype.groundAO = function (y0, k) {      // darken toward the feet
  for (let y = Math.max(0, y0 | 0); y < this.h; y++) {
    const m = 1 - k * Math.pow((y - y0) / Math.max(1, this.h - y0), 1.3);
    for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x, c = this.data[i];
      if ((c >>> 24) < 6) continue;
      this.data[i] = pk((c & 255) * m, (c >> 8 & 255) * m, (c >> 16 & 255) * m, c >>> 24);
    }
  }
  return this;
};
Surf.prototype.topLight = function (k) {          // brighten toward the crown
  for (let y = 0; y < this.h; y++) {
    const m = 1 + k * (1 - y / this.h);
    for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x, c = this.data[i];
      if ((c >>> 24) < 6) continue;
      this.data[i] = pk((c & 255) * m, (c >> 8 & 255) * m, (c >> 16 & 255) * m, c >>> 24);
    }
  }
  return this;
};
Surf.prototype.grain = function (n, cols, alpha, box) {
  const g = mulberry(n | 0), [ax, ay, bx, by] = box || [0, 0, this.w, this.h];
  const count = Math.max(4, n * ((bx - ax) * (by - ay)) / 3600);
  for (let i = 0; i < count; i++) {
    const x = ax + g() * (bx - ax), y = ay + g() * (by - ay), col = cols[(g() * cols.length) | 0];
    this.dot(x, y, col[0], col[1], col[2], alpha * (0.25 + g() * 0.75));
  }
  return this;
};
Surf.prototype.erode = function (cx, cy, radius, seed) {   // dissolve-out frames
  const g = mulberry(seed), r2 = radius * radius;
  for (let i = 0; i < this.data.length; i++) {
    const x = i % this.w, y = (i / this.w) | 0, dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy > r2) continue;
    const d = Math.sqrt(dx * dx + dy * dy) / radius;
    if (g() < d * d * 0.85 + 0.05) this.data[i] = 0;
  }
  return this;
};
function shadeFn(col, a) {
  if (typeof col === 'function') return col;
  return () => (a === undefined ? col : [col[0], col[1], col[2], a]);
}

/* ---------- mip chain + AA downsample ---------- */
function buildMips(w, h, data) {
  const mips = [{ w, h, data }];
  let cw = w, ch = h, cd = data;
  while (cw > 8 || ch > 8) {
    const nw = Math.max(8, cw >> 1), nh = Math.max(8, ch >> 1), out = new Uint32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, aSum = 0, em = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const c = cd[Math.min(ch - 1, y * 2 + j) * cw + Math.min(cw - 1, x * 2 + i)], al = c >>> 24;
        if (!al) continue;
        if (al === 253) em = 1;
        r += (c & 255) * al; g += (c >> 8 & 255) * al; b += (c >> 16 & 255) * al; aSum += al;
      }
      /* #20: this alpha is not a coverage value - 253 is the FLAG the emissive painter sets, and the
         renderer matches it exactly (ground row loop, groundPixel, castWalls' bilinear decode). Averaging
         it manufactures 254 wherever a 253 meets a 255 (i0 truncates: (253+255+255+255)/4 = 254.5 -> 254),
         a byte no read site recognises, so an emissive area stopped being emissive as soon as it was far
         enough to filter: measured on the deployed build, 84% of FLOORS.FLESH's emissive texels lost the
         branch by mip 1 and every emissive texel of WALLS[1] by mip 2. Carry the flag instead of the
         number - an emissive texel anywhere in the 2x2 keeps the area self-lit, which spreads a glow by
         half a texel per level rather than deleting it. */
      out[y * nw + x] = aSum === 0 ? 0 : pk(r / aSum, g / aSum, b / aSum, em ? 253 : aSum / 4);
    }
    mips.push({ w: nw, h: nh, data: out });
    cw = nw; ch = nh; cd = out;
  }
  return mips;
}
function texFromSurf(s, mip) {
  const t = { w: s.w, h: s.h, data: s.data };
  t.mips = mip === false ? null : buildMips(t.w, t.h, t.data);
  return t;
}
/* supersampled render -> straight-alpha downsample (this is where edges get AA) */
function surfDown(s, f) {
  const w = Math.max(1, Math.round(s.w / f)), h = Math.max(1, Math.round(s.h / f)), out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let pr = 0, pg = 0, pb = 0, pa = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const c = s.data[(y * f + j) * s.w + x * f + i], a = (c >>> 24) / 255;
      pr += (c & 255) * a; pg += (c >> 8 & 255) * a; pb += (c >> 16 & 255) * a; pa += a;
    }
    const n = f * f;
    if (pa === 0) { out[y * w + x] = 0; continue; }
    out[y * w + x] = pk(pr / pa, pg / pa, pb / pa, pa / n * 255);
  }
  return new Surf(w, h).set(out);
}
Surf.prototype.set = function (data) { this.data = data; return this; };
