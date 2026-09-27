/* ============================================================================
 * Rig: characters as jointed geometry, rasterized at the exact pixel size they
 * occupy so they stay crisp at any resolution or distance instead of being
 * scaled bitmaps. A rig is a set of oriented capsules and rounded boxes in body
 * space (fractions of body height, feet at 0), posed by a gait phase that
 * advances with distance travelled. The silhouette depends on the viewing angle,
 * so facing reads correctly instead of every enemy staring at the camera.
 *
 * Frames are cached by (kind, gait, yaw, action) with a byte cap and a
 * per-frame rasterization budget; over budget falls back to the nearest pose
 * already made rather than spilling into the frame time.
 * ==========================================================================*/
const RIG = (function () {


const COL = {
  grunt: { armor: '#3a4250', dark: '#232a35', cloth: '#4a5568', trim: '#ff8a3c', eye: '#ffd08a', skin: '#7d6a52', gun: '#1b1e24' },
  hound: { armor: '#41522f', dark: '#232c1a', cloth: '#5c7040', trim: '#aef27a', eye: '#d8ff9a', skin: '#4c5a38', gun: null },
  brute: { armor: '#43304f', dark: '#241a2c', cloth: '#5a4068', trim: '#b96bff', eye: '#e6b3ff', skin: '#6b4a7a', gun: '#241a2c' },
};
/* proportions in fractions of total body height; aspect = widest silhouette / height */
const SPEC = {
  grunt: { aspect: 0.62, hip: 0.50, sh: 0.815, head: 0.915, headR: 0.068, torso: 0.235, hipLat: 0.055, shLat: 0.098, thigh: 0.245, shin: 0.235, upper: 0.175, fore: 0.165, limb: 0.040, arm: 0.031, gun: '#1b1e24' },
  hound: { aspect: 1.02, hip: 0.50, sh: 0.72, head: 0.80, headR: 0.095, torso: 0.48, hipLat: 0.10, shLat: 0.13, thigh: 0.21, shin: 0.21, upper: 0.17, fore: 0.17, limb: 0.038, arm: 0.034, gun: null },
  brute: { aspect: 0.80, hip: 0.44, sh: 0.775, head: 0.855, headR: 0.080, torso: 0.33, hipLat: 0.075, shLat: 0.16, thigh: 0.205, shin: 0.20, upper: 0.20, fore: 0.18, limb: 0.052, arm: 0.046, gun: '#241a2c' },
};

/* ---------------- shaded primitives (Surf.shape with an analytic SDF) ------- */
let SC = null;                                     // {s, H} current raster context
const RIM_ON = 1.0;
let RIM = RIM_ON;                                  // DEV.set('rim', false) puts it at 0 for a live A/B
const RIM_BAND = 0.016;                            // ridge half-width = 1.6% of body height (was 3%)
const RIM_K = 3.0;                                  // exp falloff: ~5% of peak at the band edge
const RIM_T = 0.16;                                 // band cap as a fraction of LOCAL limb width
let RIMD = null;                                   // distance scratch, grown to the largest pose
let RIMTH = null;                                  // limb-width scratch, same lifetime
const SHRGB = [0, 0, 0];                            // shade closures must not allocate per pixel
const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const segSD = (ax, ay, bx, by, r) => (px, py) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-6;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px - (ax + dx * t), qy = py - (ay + dy * t);
  return Math.sqrt(qx * qx + qy * qy) - r;
};
const obbSD = (cx, cy, hx, hy, ang, r) => {
  const c = Math.cos(-ang), si = Math.sin(-ang);            // hoisted: this runs per pixel
  return (px, py) => {
    const dx = px - cx, dy = py - cy;
    const lx = Math.abs(dx * c - dy * si) - hx, ly = Math.abs(dx * si + dy * c) - hy;
    const ax = lx > 0 ? lx : 0, ay = ly > 0 ? ly : 0;
    return Math.sqrt(ax * ax + ay * ay) + Math.min(lx > ly ? lx : ly, 0) - r;
  };
};
const discSD = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) - r;

/* paint closure: body shading only - vertical ramp plus a yaw ramp.
   The rim used to be added here, from the signed distance shape() passes as `d`. That distance is
   to the *primitive's own* boundary, so every capsule, box and disc rimmed itself - including the
   boundaries buried inside the body where parts overlap, which is what a live close-up showed as
   pale rounded rectangles around the torso, head and each leg. The rim now happens once, over the
   finished silhouette, in rimSil(). SC.* is read at closure-build time rather than per pixel. */
function bodyPaint(col, k) {
  const C = rgb(col), kk = k === undefined ? 1 : k;
  const hh = 1 / SC.s.h, iw = 1 / SC.s.w, sy = SC.sy;
  return (px, py) => {
    const u = py * hh, v = px * iw;
    const side = clamp((0.5 - v) * 1.15 * sy, -0.32, 0.32);
    const base = clamp((0.60 + 0.55 * (1 - u) + side) * kk, 0.18, 1.6);
    SHRGB[0] = C[0] * base;
    SHRGB[1] = C[1] * base;
    SHRGB[2] = C[2] * base;
    return SHRGB;
  };
}

/* Silhouette rim. Two chamfer sweeps give every covered texel its octile distance to the nearest
   partially covered texel - that is, to the edge of the body as drawn - and the same smoothstep
   band as before is then added as light. Cost is ~4 linear passes over the pose box instead of a
   second raster of every part, and a seam between two overlapping parts sits far from any
   partially covered texel, so it stops glowing while the outline keeps its light.
   ADDITIVE, not multiplied: the albedos are dark (armour averages 35,59,68), so a multiplied rim
   left measured edge contrast unmoved. It is scaled by scene light at composite time like
   everything else, so it cannot glow in a room that is dark. */
function rimSil(s, hpx) {
  if (RIM <= 0) return;
  const D = s.data, W = s.w, H = s.h, N = W * H, band = Math.max(1.5, hpx * RIM_BAND);
  if (!RIMD || RIMD.length < N) RIMD = new Float32Array(N);
  const dd = RIMD, INF = 1e6, DIAG = 1.4142;
  for (let i = 0; i < N; i++) dd[i] = (D[i] >>> 24) < 255 ? 0 : INF;
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let x = 0; x < W; x++) {
      const i = r + x;
      let v = dd[i];
      if (x > 0) { const t = dd[i - 1] + 1; if (t < v) v = t; }
      if (y > 0) {
        const u = i - W, t = dd[u] + 1;
        if (t < v) v = t;
        if (x > 0) { const q = dd[u - 1] + DIAG; if (q < v) v = q; }
        if (x + 1 < W) { const q = dd[u + 1] + DIAG; if (q < v) v = q; }
      }
      dd[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    const r = y * W;
    for (let x = W - 1; x >= 0; x--) {
      const i = r + x;
      let v = dd[i];
      if (x + 1 < W) { const t = dd[i + 1] + 1; if (t < v) v = t; }
      if (y + 1 < H) {
        const u = i + W, t = dd[u] + 1;
        if (t < v) v = t;
        if (x > 0) { const q = dd[u - 1] + DIAG; if (q < v) v = q; }
        if (x + 1 < W) { const q = dd[u + 1] + DIAG; if (q < v) v = q; }
      }
      dd[i] = v;
    }
  }
  /* A band scaled from body height alone lights a whole leg: at a 600 px body the
   * band is 9.6 px and a leg is ~30 px wide, so its interior sits inside one band
   * and glows. Cap the band by the width of the covered run the pixel sits in.
   * Horizontal runs only: that measures legs and hanging arms exactly, and costs
   * one row-major pass - a vertical term needs a second pass and the frame budget
   * will not pay for it (measured +1 ms). */
  if (!RIMTH || RIMTH.length < N) RIMTH = new Float32Array(N);
  const th = RIMTH, invBand = 1 / band;
  for (let y = 0; y < H; y++) {
    const r = y * W;
    let x = 0;
    while (x < W) {
      while (x < W && (D[r + x] >>> 24) === 0) x++;
      let q = x;
      while (q < W && (D[r + q] >>> 24) !== 0) q++;
      const w = q - x;
      for (let k = x; k < q; k++) th[r + k] = w;
      x = q + 1;
    }
  }
  for (let i = 0; i < N; i++) {
    const a = D[i] >>> 24;
    if (a === 0) continue;
    const cap = th[i] * RIM_T;
    const t = cap >= band ? dd[i] * invBand : dd[i] / (cap < 1 ? 1 : cap);
    if (t >= 1) continue;
    const rim = Math.exp(-RIM_K * t) * RIM, p = D[i];
    D[i] = pk((p & 255) + 150 * rim, (p >> 8 & 255) + 188 * rim, (p >> 16 & 255) + 238 * rim, a);
  }
}
function flatPaint(rgbArr, g) {
  return (px, py) => {
    const m = g ? g(1 - py / SC.s.h) : 1;
    SHRGB[0] = rgbArr[0] * m; SHRGB[1] = rgbArr[1] * m; SHRGB[2] = rgbArr[2] * m;
    return SHRGB;
  };
}
function seg(ax, ay, bx, by, r, paint) {
  const s = SC.s;
  s.shape(segSD(ax, ay, bx, by, r), paint, { box: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r] });
}
/* everything below works in body space: x lateral and y height as fractions of
   body height, sizes likewise. tilt rotates an upright box, +tips its top forward */
function box(cx, cy, w, h, tilt, r, paint) {
  // Exact rotated-AABB extents. The old box used (|w|+|h|)/2 on BOTH axes - the half-diagonal
  // sum, so a 0.5x0.7 torso scanned a 1.2x1.2 square, several times the pixels the SDF can fill.
  // The +1.5 is NOT slack for rounding: shape() anti-aliases with aa=0.85, so coverage extends
  // past the SDF's zero. Without the margin the sheet changed bytes - a clipped AA fringe, a
  // quality loss wearing a perf win's clothes. With it, the rig sheet is md5-identical.
  const H = SC.H, c = Math.abs(Math.cos(tilt)), si = Math.abs(Math.sin(tilt));
  const hw = Math.abs(w) * 0.5, hh = Math.abs(h) * 0.5, rr = Math.abs(r);
  const ex = (c * hw + si * hh + rr) * H + 1.5, ey = (si * hw + c * hh + rr) * H + 1.5;
  SC.s.shape(obbSD(SC.px(cx), SC.py(cy), hw * H, hh * H, tilt, r * H), paint,
    { box: [SC.px(cx) - ex, SC.py(cy) - ey, SC.px(cx) + ex, SC.py(cy) + ey] });
}
function disc(cx, cy, r, paint) {
  const H = SC.H, x = SC.px(cx), y = SC.py(cy), rr = r * H;
  SC.s.shape(discSD(x, y, rr), paint, { box: [x - rr, y - rr, x + rr, y + rr] });
}
/* straight run between two body points (snouts, barrels) */
function segB(x1, y1, x2, y2, r, paint) {
  const H = SC.H, ax = SC.px(x1), ay = SC.py(y1), bx = SC.px(x2), by = SC.py(y2), rr = Math.max(0.6, r * H);
  seg(ax, ay, bx, by, rr, paint);
}

/* a limb: joint at (x,y) body coords, screen angle, length, radius; returns the far joint */
function limb(x, y, ang, len, r, paint) {
  const bx = x + Math.cos(ang) * len, by = y - Math.sin(ang) * len;
  segB(x, y, bx, by, r, paint);
  return [bx, by];
}

/* ---------------- cache ---------------- */
cache = new Map(); recent = {}; bytes = 0; made = 0; budget = 0; poses = 0;
CAP = 9 * 1048576;
const BUCKETS = { ph: 8, yaw: 8, mv: 3, atk: 4, die: 6 };
function beginFrame(b) { budget = b; poses = 0; }
function clear() { cache.clear(); for (const k in recent) delete recent[k]; bytes = 0; }
function stats() { return { entries: cache.size, mb: +(bytes / 1048576).toFixed(2), made: made, poses: poses }; }

frame = (kind, o) => {
  const ph = Math.floor((((o.p % 1) + 1) % 1) * BUCKETS.ph);
  const yb = Math.floor((((o.yaw % TAU) + TAU + Math.PI) / TAU) * BUCKETS.yaw) % BUCKETS.yaw;
  const mb = Math.min(BUCKETS.mv - 1, (clamp(o.mv || 0, 0, 0.999) * BUCKETS.mv) | 0);
  const ab = Math.min(BUCKETS.atk - 1, (clamp(o.atk || 0, 0, 0.999) * BUCKETS.atk) | 0);
  const db = Math.min(BUCKETS.die - 1, (clamp(o.die || 0, 0, 0.999) * BUCKETS.die) | 0);
  // Coarse size class belongs in the key: poses are authored at the height they occupy,
  // so an entry is only valid for the band it was made in. A size-unkeyed cache made
  // 132-px bodies answer for 431-px closeups.
  const sc = o.hpx >= 170 ? 2 : (o.hpx >= 80 ? 1 : 0);
  // yaw is NOT in the key (#69 B2, from #39): a body rendered as geometry is valid at any yaw, so
  // the bucket is an authoring parameter only - the pose still renders at its bucket centre, and
  // keying 8 yaws multiplied every other bucket for a texture that cannot turn in the round.
  const key = kind + '|' + ph + '|' + mb + '|' + ab + '|' + db + '|' + sc;
  let ent = cache.get(key);
  if (ent) { cache.delete(key); cache.set(key, ent); return ent.tex; }
  // Evict *before* deciding to give up. Eviction used to live only after an insertion,
  // so once bytes passed CAP the cache could neither shrink nor make another pose: every
  // enemy stayed permanently on the nearest stale pose and the made counter froze.
  while (bytes > CAP && cache.size > 4) {
    const oldest = cache.entries().next().value;
    cache.delete(oldest[0]); bytes -= oldest[1].tex.data.byteLength;
  }
  if (!budget) {
    ent = nearest(kind, ph, yb, mb, ab, db);
    if (ent) return ent.tex;
  }
  budget--;
  const hpx = Math.max(14, Math.ceil(clamp(o.hpx, 24, 700) / 4) * 4);
  const tex = raster(kind, hpx, {
    p: (ph + 0.5) / BUCKETS.ph, yaw: ((yb + 0.5) / BUCKETS.yaw) * TAU - Math.PI,
    mv: mb / (BUCKETS.mv - 1), atk: (ab + 0.5) / BUCKETS.atk, die: (db + 0.5) / BUCKETS.die,
    lean: clamp(o.lean || 0, -0.22, 0.22), pulse: o.pulse || 0,
  });
  ent = { tex, ph, yb, mb, ab, db };
  cache.set(key, ent); bytes += tex.data.byteLength; made++; poses++;
  (recent[kind] || (recent[kind] = [])).push(ent);
  if (recent[kind].length > 40) recent[kind].shift();
  return tex;
};
nearest = (kind, ph, yb, mb, ab, db) => {
  const list = recent[kind];
  if (!list || !list.length) return null;
  let best = null, bd = 1e9;
  for (const e of list) {
    const dp = Math.min(Math.abs(e.ph - ph), BUCKETS.ph - Math.abs(e.ph - ph));
    const dy = Math.min(Math.abs(e.yb - yb), BUCKETS.yaw - Math.abs(e.yb - yb));
    const d = dp + dy * 2.4 + Math.abs(e.mb - mb) * 3 + Math.abs(e.ab - ab) * 4 + Math.abs(e.db - db) * 3;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
};

/* ---------------- rasterize one posed frame ---------------- */
raster = (kind, hpx, pose) => {
  const sp = SPEC[kind], sy = Math.sin(pose.yaw), cyaw = Math.cos(pose.yaw);
  const wpx = Math.max(10, Math.round(hpx * sp.aspect * (kind === 'hound' ? 1 : Math.max(0.6, 0.7 + 0.3 * Math.abs(cyaw)))));
  const s = new Surf(wpx, hpx);
  SC = { s, H: hpx, sy, px: x => s.w * 0.5 + x * hpx, py: y => hpx * (1 - y) };
  const C = COL[kind];
  if (kind === 'hound') rigHound(pose, C, sp); else rigBiped(pose, C, sp);
  rimSil(s, hpx);
  SC = null;
  return { w: s.w, h: s.h, data: s.data };
};

function rigBiped(pose, C, sp) {
  const H = SC.H, X = SC.px, Y = SC.py;
  const sy = SC.sy, cy = Math.cos(pose.yaw);
  const atk = pose.die > 0.01 ? 0 : pose.atk;
  const bob = -pose.mv * 0.014 * Math.abs(Math.sin(pose.p * TAU)) - pose.die * 0.10;
  const pitch = pose.lean + atk * 0.18 + pose.die * 1.35;
  const legP = bodyPaint(C.armor), darkP = bodyPaint(C.dark), clothP = bodyPaint(C.cloth), skinP = bodyPaint(C.skin);
  const wide = 0.52 + 0.48 * Math.abs(cy);
  for (let i = 0; i < 2; i++) {                          // legs, opposite phase
    const side = i ? 1 : -1, a2 = pose.p * TAU + (i ? Math.PI : 0);
    const sw = pose.die > 0.01 ? -0.45 * side : Math.sin(a2) * (0.22 + 0.30 * pose.mv);
    const lift = pose.die > 0.01 ? 0 : 0.055 * pose.mv * Math.max(0, Math.sin(a2 + 0.6));
    const bend = pose.die > 0.01 ? 0.85 : 0.15 + 0.8 * Math.max(0, Math.sin(a2 + 1.05));
    const jx = side * sp.hipLat * cy, jy = sp.hip + bob;
    const ta = Math.PI / 2 - sw * (0.55 + 0.45 * Math.abs(sy)) - pitch * 0.3;
    const knee = limb(jx, jy - lift * 0.4, ta, sp.thigh, sp.limb * (i ? 0.9 : 1), i ? darkP : legP);
    const sa = ta + bend, foot = limb(knee[0], knee[1] + lift * 0.4, sa, sp.shin, sp.limb * 0.8 * (i ? 0.9 : 1), i ? darkP : legP);
    box(foot[0] + 0.03 * Math.abs(sy), foot[1] - 0.014, 0.075 + 0.035 * Math.abs(sy), 0.032, 0, 0.012, darkP);
  }
  // torso
  box(0, (sp.hip + sp.sh) * 0.5 + bob + Math.sin(pitch) * 0.02, sp.torso * wide, (sp.sh - sp.hip) * 1.06, pitch, 0.05, legP);
  box(Math.sin(pitch) * (sp.sh - sp.hip) * 0.55, sp.sh - 0.03 + bob, sp.torso * 0.7 * wide, 0.045, pitch, 0.018, clothP);
  if (sp === SPEC.grunt) {
    const gx = Math.sin(pitch) * (sp.sh - sp.hip) * 0.5, gy = (sp.hip + sp.sh) * 0.5 + bob;
    box(gx, gy, 0.038, 0.10, pitch, 0.012, flatPaint(rgb(C.trim), u => 0.7 + 0.5 * u));
  }
  const shX = Math.sin(pitch) * (sp.sh - sp.hip), shY = sp.hip + Math.cos(pitch) * (sp.sh - sp.hip) + bob;
  // head
  const hx = shX + sy * 0.012, hy = shY + (sp.head - sp.sh);
  // Head. This was a skin disc of r with a dark disc of 0.74r on top: a light rim around a dark
  // blob, which at any useful pose height reads as a hollow ring - no jaw, no facing direction.
  // Now a helmet dome (these are armoured troops), a jaw box under it, and a visor band that
  // carries the eye across the front so the direction the head faces is legible.
  limb(hx, hy - 0.028, Math.PI / 2, 0.055, 0.052, darkP);
  box(hx - 0.004 * sy, hy + 0.008, sp.headR * (1.50 + 0.50 * Math.abs(sy)), sp.headR * 1.40, 0, sp.headR * 0.42, bodyPaint(C.armor));
  box(hx + 0.014 * sy, hy - 0.030, sp.headR * (1.00 + 0.40 * Math.abs(sy)), sp.headR * 0.44, 0, sp.headR * 0.16, darkP);
  if (cy > -0.3) {
    box(hx + 0.024 * sy, hy + 0.006, sp.headR * (0.42 + 0.46 * Math.abs(sy)) + sp.headR * 0.30 * Math.abs(cy), sp.headR * 0.28, 0, sp.headR * 0.06, flatPaint(rgb(C.eye), u => 0.85 + 0.35 * u));
  }
  // arms + weapon; the near arm draws last so it crosses the body
  const order = sy >= 0 ? [1, 0] : [0, 1];
  for (let n = 0; n < 2; n++) {
    const i = order[n], side = i ? 1 : -1;
    const sxp = shX + side * sp.shLat * cy * 0.9;
    const reach = atk > 0 ? 0.5 + 0.95 * Math.sin(Math.PI * clamp(atk, 0, 1)) : 0.72;
    const a1 = Math.PI / 2 - (0.22 + 0.62 * reach) * (0.35 + 0.65 * Math.abs(sy)) - side * 0.26 * cy;
    const elb = limb(sxp, shY, a1, sp.upper, sp.arm * (i ? 0.92 : 1), i ? darkP : clothP);
    const a2 = a1 + 0.55 - 0.95 * reach;
    const hand = limb(elb[0], elb[1], a2, sp.fore, sp.arm * 0.8, i ? darkP : clothP);
    const hbx = hand[0], hby = hand[1];
    disc(hbx, hby, sp.arm * 0.85, skinP);
    if (n === 1 && sp.gun && cy > -0.45) {
      const ga = Math.PI / 2 - 1.55 - sy * 0.45 - atk * 0.3;
      limb(hbx, hby, ga, 0.30, 0.021, bodyPaint(sp.gun, 0.95));
      box(hbx + Math.cos(ga) * 0.14, hby - Math.sin(ga) * 0.14 - 0.035, 0.05, 0.10, ga - Math.PI / 2, 0.012, bodyPaint(sp.gun, 0.7));
    }
  }
  if (sp === SPEC.brute) {                            // shoulder plates + breathing core
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      box(shX + side * sp.shLat * cy * 0.95, shY + 0.025, 0.135, 0.085, side * 0.2 + pose.lean, 0.03, bodyPaint(C.armor, 1.2));
    }
    const g = 0.55 + 0.45 * Math.sin(pose.pulse);
    const cxx = shX + sy * 0.02, cyy = shY - 0.06 + bob;
    SHRGB[0] = 185 * g; SHRGB[1] = 107 * g; SHRGB[2] = 255 * g;
    disc(cxx, cyy, 0.05, () => SHRGB);
    SHRGB[0] = 255 * g; SHRGB[1] = 225 * g; SHRGB[2] = 255 * g;
    disc(cxx, cyy, 0.027, () => SHRGB);
  }
}

function rigHound(pose, C, sp) {
  const H = SC.H, X = SC.px, Y = SC.py, sy = SC.sy;
  const cy = Math.cos(pose.yaw);
  const bodyP = bodyPaint(C.armor), darkP = bodyPaint(C.dark), ridgeP = bodyPaint(C.trim);
  const bob = -pose.mv * 0.012 * Math.abs(Math.sin(pose.p * TAU * 2)) - pose.die * 0.06;
  const pitch = pose.lean + pose.die * 1.05 + pose.atk * 0.3;
  const cyy = sp.hip + bob;
  for (let i = 0; i < 4; i++) {                          // diagonal-couplet gait
    const front = i < 2 ? 1 : -1, side = i % 2 ? 1 : -1;
    const a2 = pose.p * TAU + (front > 0 ? 0 : Math.PI) + (side > 0 ? Math.PI * 0.5 : 0);
    const sw = pose.die > 0.01 ? 0.15 * side : Math.sin(a2) * (0.22 + 0.34 * pose.mv);   // was 0.30+0.42: at that splay the animal read as a stool
    // Front legs straight, hind legs hocked: four identical limbs is a big part of the stool look.
    const bend = (front > 0 ? 0.12 : 0.50) + (front > 0 ? 0.20 : 0.60) * Math.max(0, Math.sin(a2 + 1.1));
    const jx = front * 0.19 * Math.abs(sy) + side * 0.05 * cy, jy = cyy + (front > 0 ? 0.005 : -0.055);   // start under the belly, not at its corners
    const a1 = Math.PI / 2 - sw * (0.5 + 0.5 * Math.abs(sy)) + front * sy * 0.22;
    const knee = limb(jx, jy, a1, sp.thigh, sp.limb * 1.5 * (side > 0 ? 1 : 0.9), side > 0 ? bodyP : darkP);
    const a3 = a1 + bend * (front > 0 ? -1 : 1);
    const pastern = limb(knee[0], knee[1], a3, sp.shin, sp.limb * 1.3 * (side > 0 ? 0.95 : 0.86), side > 0 ? bodyP : darkP);
    // A paw that plants: a tapered limb ending in nothing reads as a stick at any distance.
    box(pastern[0] + 0.022 * front * Math.abs(sy), pastern[1] - 0.013, 0.062, 0.028, 0, 0.011, side > 0 ? darkP : bodyPaint(C.dark, 0.8));
  }
  // Tail drawn BEFORE the body, not last: the signed sy that puts the head forward puts the tail
  // base behind, but at head-on yaws the segment still lands inside the body silhouette, so drawn
  // last it read as a dark bar across the chest - and as a fifth leg when it reached the floor.
  // pi + 0.72 sweeps it back and UP; the old pi/2 + 0.85 hung it straight down the haunch.
  const tA = Math.PI + 0.72 - Math.sin(pose.p * TAU) * 0.28 - pitch;
  const t1 = limb(-0.135 * sy, cyy + 0.055, tA, 0.105, 0.028, darkP);
  limb(t1[0], t1[1], tA - 0.30 + Math.sin(pose.p * TAU * 2) * 0.22, 0.085, 0.018, darkP);
  // Chest, haunch and a low belly bar instead of one rounded box: a single box with big corner
  // radius is a table top, and the animal needs a withers, a waist and a tuck-up.
  const ws = 0.45 + 0.55 * Math.abs(sy);
  box(0.115 * sy, cyy + 0.030, sp.torso * 0.40 * ws, 0.225, pitch, 0.070, bodyP);
  box(-0.125 * sy, cyy - 0.010, sp.torso * 0.40 * ws, 0.190, pitch, 0.065, bodyP);
  box(0, cyy - 0.050, sp.torso * 0.62 * ws, 0.075, pitch, 0.035, bodyP);
  box(Math.sin(pitch) * 0.02, cyy + 0.100, sp.torso * 0.50 * ws, 0.026, pitch, 0.011, ridgeP);
  // Neck runs UP and forward. limb() computes by = y - sin(ang)*len with +y up, so "down" is
  // pi/2 and "up" is -pi/2: the old angle (pi/2 - pitch - 0.45) pointed the neck DOWN into the
  // chest, which is why the head only appeared as a nub at some yaws.
  const nk = limb(0.115 * sy, cyy + 0.085, -Math.PI / 2 + 0.68 - pitch, 0.130, 0.048 * ws + 0.016, bodyP);
  const hx = nk[0] + 0.020 * sy, hy = nk[1] + 0.006;
  box(hx, hy, 0.075 * ws + 0.026, 0.070, pitch - 0.12, 0.024, bodyP);
  box(hx + 0.058 * sy, hy - 0.020, 0.070 * Math.max(0.30, Math.abs(sy)) + 0.012 * Math.abs(cy), 0.040, pitch - 0.06, 0.016, bodyPaint(C.skin));
  box(hx - 0.026 * sy, hy + 0.048, 0.024 * ws + 0.010, 0.052, pitch + 0.30, 0.009, darkP);
  if (cy > -0.4) {
    box(hx + 0.030 * sy, hy + 0.002, 0.018 * (0.3 + 0.7 * Math.abs(cy)), 0.013, 0, 0, flatPaint(rgb(C.eye), u => 0.85 + 0.35 * u));
  }
}
  return { frame, beginFrame, clear, stats, raster: (k, h, p) => raster(k, h, p), setRim: on => { RIM = on ? RIM_ON : 0; clear(); }, get rim() { return RIM > 0; }, get bytes() { return bytes; } };
})();
