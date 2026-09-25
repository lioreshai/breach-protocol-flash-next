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
let drawCalls = 0, pixFilled = 0;
let bloomCv = null, bloomCtx = null, canFilter = false, grainCv = null, grainPat = null, grainSeed = 0;
let FARB = 22, AMB = 0.13, GQ = null, rigTexH = 200;

const QUAL = [
  { name: 'PERFORMANCE', res: 0.34, min: 170, max: 430, bloom: false, grade: false, grain: 0, far: 15, dmax: 8, glow: 0, scan: 0.5, vec: 0, rast: 0, rigH: 0 },
  { name: 'BALANCED', res: 0.47, min: 220, max: 560, bloom: true, grade: true, grain: 0.05, far: 22, dmax: 13, glow: 6, scan: 0.18, vec: 1, rast: 2, rigH: 132 },
  { name: 'ULTRA', res: 0.62, min: 260, max: 780, bloom: true, grade: true, grain: 0.04, far: 30, dmax: 19, glow: 9, scan: 0.1, vec: 1, rast: 4, rigH: 216 }
];

function resize() {
  DPR = Math.min(1.5, window.devicePixelRatio || 1);
  DW = Math.max(320, Math.round(innerWidth * DPR));
  DH = Math.max(200, Math.round(innerHeight * DPR));
  cv.width = DW; cv.height = DH;
  const q = QUAL[clamp(S.gfx | 0, 0, QUAL.length - 1)];
  GQ = q; FARB = q.far;
  BH = clamp(Math.round(DH * q.res), q.min, q.max);
  BW = Math.max(160, Math.round(BH * DW / DH));
  bufCv.width = BW; bufCv.height = BH;
  imgBuf = bufCtx.createImageData(BW, BH);
  px = new Uint32Array(imgBuf.data.buffer);
  zbuf = new Float32Array(BW);
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

function renderWorld() {
  const bobP = P.bob * 1.4 + P.kick * 0.4;
  const flash = S.flash;
  planeLen = cfg.plane * (1 - P.ads * 0.55);
  dirX = Math.cos(P.ang); dirY = Math.sin(P.ang);
  planeX = -dirY * planeLen; planeY = dirX * planeLen;
  camX = P.x; camY = P.y;
  eyeZ = clamp(cfg.eye + P.z - P.crouch * 0.19, 0.12, 1.4);
  AMB = MAP && MAP.amb !== undefined ? MAP.amb : 0.13;
  horizon = BH * 0.5 + aimPx() + bobP * (BH / 400) * 3 + shakeY;
  const fcR = FOGC[0], fcG = FOGC[1], fcB = FOGC[2];
  const fcol = pack(FOGC[0], FOGC[1], FOGC[2]);
  px.fill(fcol);

  castGround(flash, fcR, fcG, fcB);
  castWalls(flash, fcR, fcG, fcB);
  const qv = GQ || QUAL[1];
  // One texture per pose, authored at a fixed density and filtered at draw time.
  // Authoring to the buffer height would cost 20 ms per pose for detail nothing sees:
  // an enemy at 6 m is 60 px tall, so the preset size plus bilinear magnify is the trade.
  rigTexH = qv.rigH;
  RIG.beginFrame(qv.vec ? qv.rast : 0);

  /* ---- billboards ---- */
  const list = [];
  for (const p of PROPS) {
    if (p.dead && p.kind === 'barrel') continue;
    list.push({ tex: p.tex, x: p.x, y: p.y, z: p.z, scale: p.scale, alpha: p.dead ? 0.35 : 1, kind: p.kind });
  }
  for (const k of PICKUPS) {
    if (k.dead) continue;
    const tex = k.type === 'health' ? PROP.health : k.type === 'armor' ? PROP.armor : PROP.ammo;
    list.push({ tex, x: k.x, y: k.y, z: 0.16 + Math.sin(k.bob) * 0.05, scale: 0.42, alpha: 1, glow: k.type === 'armor' ? 0.25 : 0 });
  }
  for (const p of PROJ) {
    const tex = p.kind === 'orb' ? PROP.orb[(S.t * 14 | 0) % 4] : p.tex;
    list.push({ tex, x: p.x, y: p.y, z: p.z - p.scale / 2, scale: p.scale, alpha: 1, self: true });
  }
  list.push({
    tex: PROP.portal[(S.t * 12 | 0) % 8], x: exitX, y: exitY, z: 0.02, scale: 1.5,
    alpha: S.exitOpen ? 1 : 0.42, self: S.exitOpen, dim: S.exitOpen ? 0 : 0.55
  });
  for (const e of ENEMIES) {
    const fr = enemyFrame(e);
    if (fr.alpha <= 0.02) continue;
    let rig = null;
    if (qv.vec) {
      let yaw = e.ang - P.ang - Math.PI;
      while (yaw > Math.PI) yaw -= TAU; while (yaw < -Math.PI) yaw += TAU;
      rig = { hpx: rigTexH, kind: e.kind, p: e.anim, mv: e.movingAmt || 0, atk: e.atkT > 0 ? 1 - clamp(e.atkT / e.type.wind, 0, 1) : 0, die: e.state === 'dead' ? clamp(e.dieT / 0.55, 0, 1) : 0, yaw, lean: e.lean || 0, pulse: e.ph };
    }
    list.push({ tex: fr.tex, rig, x: e.x, y: e.y, z: 0, scale: e.scale, alpha: fr.alpha, flash: fr.flash, tint: e.tint });
  }
  /* ground decals first: they lie on the floor and must not paint over feet */
  for (const b of list) { const dx = b.x - camX, dy = b.y - camY; b.d2 = dx * dx + dy * dy; }
  list.sort((a, b) => b.d2 - a.d2);
  for (const b of list) drawBillboard(b);

  bufCtx.putImageData(imgBuf, 0, 0);
}

/* ------------------------------------------------------------------
   floor & ceiling: perspective-correct texture mapping.
   One division per row, integer stepping per pixel, mip chosen from the
   world footprint, light sampled from the cell the pixel lands in.
   ------------------------------------------------------------------ */
function castGround(flash, fcR, fcG, fcB) {
  const hInt = Math.round(horizon);
  const stepBase = 2 / BW;
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light;
  const floorTex = MAP.floorTex || FLOORS.CONCRETE, ceilTex = MAP.ceilTex || CEILS.CONCRETE;
  const tileF = MAP.floorTile || 1.15, tileC = MAP.ceilTile || 2.2;
  const dMasks = DECAL_MASK, dGrid = DECAL_GRID;
  const amb = AMB, fl = flash;
  for (let y = 0; y < BH; y++) {
    const p = y - hInt;
    if (p === 0) { px.fill(0xFF000000 | fcB << 16 | fcG << 8 | fcR, y * BW, y * BW + BW); continue; }
    const isF = p > 0;
    let d = (isF ? eyeZ : 1 - eyeZ) * BH / Math.abs(p);
    if (d > FARB * 4) d = FARB * 4;
    const fog = fogAt(d);
    const inv = 1 - fog, fR = fcR * fog, fG = fcG * fog, fB = fcB * fog;
    const flashK = fl * Math.exp(-d * 0.30);
    const base = amb + flashK * 0.9;
    let tex, TW, TH, mips, NM, sc;
    if (isF) { tex = floorTex; sc = 1 / tileF; } else { tex = ceilTex; sc = 1 / tileC; }
    if (d > FARB || !(tex && tex.mips)) {                     // far band: light-tinted fog, no texture
      const c0 = cellTint(cellIdx(camX, camY));
      const lit = MAP.light ? MAP.light[cellIdx(camX, camY)] : 0.4;
      px.fill(pack(clampi((18 * c0[0] + lit * 26 * c0[0]) * 1 + fR), clampi((18 * c0[1] + lit * 26 * c0[1]) + fG),
        clampi((18 * c0[2] + lit * 26 * c0[2]) + fB)), y * BW, y * BW + BW);
      continue;
    }
    /* row ray span: column x has cam offset (x*stepBase-1) */
    const c0 = -1;
    let wx = camX + (dirX + planeX * c0) * d, wy = camY + (dirY + planeY * c0) * d;
    const wxs = planeX * stepBase * d, wys = planeY * stepBase * d;
    /* mip from the world footprint of a pixel */
    const pxTex = Math.abs(wxs * sc) + Math.abs(wys * sc) * 0.001;
    const k = pxTex >= 0.5 ? (pxTex >= 2 ? (pxTex >= 4 ? 3 : 2) : 1) : 0;
    const m = tex.mips[Math.min(k, tex.mips.length - 1)];
    const mw = m.w, mh = m.h, ms = sc * (mw / tex.w), td = m.data, mask = mw - 1, maskH = mh - 1;
    const row = y * BW;
    const NN = N * N;
    let pxi = wx | 0, pyi = wy | 0, cIdx = pyi * N + pxi, mir = 0, inMap = cIdx >= 0 && cIdx < NN;
    let lt = inMap ? cellTint(cIdx) : TINT_WHITE, li = inMap && lm ? lm[cIdx] : 0;
    if (li > 1) li = 1;
    let lr = base + li * lt[0], lg = base + li * lt[1], lb = base + li * lt[2];
    for (let x = 0; x < BW; x++, wx += wxs, wy += wys) {
      const gx = wx | 0, gy = wy | 0;
      if (gx !== pxi || gy !== pyi) {                          // crossed into another cell
        pxi = gx; pyi = gy; cIdx = gy * N + gx;
        inMap = cIdx >= 0 && cIdx < NN;
        if (inMap) {
          lt = cellTint(cIdx); li = lm ? lm[cIdx] : 0.4;
          lr = base + li * lt[0]; lg = base + li * lt[1]; lb = base + li * lt[2];
          mir = (hash2(gx, gy) * 4) | 0;                        // per-cell mirror kills the tiling tell
        } else { lt = TINT_WHITE; li = 0; lr = lg = lb = base; }
      }
      let tx = (wx * ms) | 0, ty = (wy * ms) | 0;
      tx &= mask; ty &= maskH;
      if (mir & 1) tx = mask - tx;
      if (mir & 2) ty = maskH - ty;
      const c = td[ty * mw + tx];
      const i = row + x;
      if ((c >>> 24) === 253) { px[i] = 0xFF000000 | clampi((c >> 16 & 255) * inv + fB) << 16 | clampi((c >> 8 & 255) * inv + fG) << 8 | clampi((c & 255) * inv + fR); continue; }
      let r = (c & 255) * lr + fR, g = (c >> 8 & 255) * lg + fG, b = (c >> 16 & 255) * lb + fB;
      const dl = inMap && dMasks ? dMasks[cIdx] : 0;
      if (dl !== 0) {                                          // blood/scorch in world space
        const gl = dGrid[cIdx];
        for (let q = 0; q < gl.length; q++) {
          const dc = gl[q], al = decalAlpha(dc, wx, wy, d);
          if (al <= 0.01) continue;
          const dt = dc.tex, du = (((wx - dc.x) * dc.inv + 0.5) * dt.w) | 0, dv = (((wy - dc.y) * dc.inv + 0.5) * dt.h) | 0;
          if (du < 0 || dv < 0 || du >= dt.w || dv >= dt.h) continue;
          const s = dt.data[dv * dt.w + du], sa = (s >>> 24) / 255 * al;
          if (sa < 0.01) continue;
          r += ((s & 255) - r) * sa; g += ((s >> 8 & 255) - g) * sa; b += ((s >> 16 & 255) - b) * sa;
        }
      }
      px[i] = 0xFF000000 | clampi(b) << 16 | clampi(g) << 8 | clampi(r);
    }
  }
}
function decalAlpha(dc, wx, wy, d) {
  const dx = wx - dc.x, dy = wy - dc.y, r2 = dx * dx + dy * dy;
  if (r2 >= dc.r * dc.r) return 0;
  const t = 1 - r2 / (dc.r * dc.r);
  return dc.a * t * (0.4 + 0.6 * Math.exp(-d * 0.02));
}

/* ------------------------------------------------------------------
   walls: DDA + coloured light + face shading + decals
   ------------------------------------------------------------------ */
function castWalls(flash, fcR, fcG, fcB) {
  const cellArr = MAP.cell, N = MAP.w, lm = MAP.light;
  const stepBase = 2 / BW;
  const flR = S.flashCol[0] / 255, flG = S.flashCol[1] / 255, flB = S.flashCol[2] / 255;
  const flashK0 = flash;
  const dmax = GQ ? GQ.dmax : 13, dMask = DECAL_MASK, dGrid = DECAL_GRID;
  for (let x = 0; x < BW; x++) {
    const cam = x * stepBase - 1;
    const rdx = dirX + planeX * cam, rdy = dirY + planeY * cam;
    let mx = camX | 0, my = camY | 0;
    const ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9));
    let stepX, stepY, sdx, sdy, side = 0;
    if (rdx < 0) { stepX = -1; sdx = (camX - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - camX) * ddx; }
    if (rdy < 0) { stepY = -1; sdy = (camY - my) * ddy; } else { stepY = 1; sdy = (my + 1 - camY) * ddy; }
    let tv = 0, guard = 0;
    while (guard++ < 180) {
      if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
      if (mx < 0 || my < 0 || mx >= N || my >= N) { tv = 1; break; }
      tv = cellArr[my * N + mx];
      if (tv !== 0) break;
    }
    let perp = side === 0 ? sdx - ddx : sdy - ddy;
    if (!(perp > 0.0001)) perp = 0.0001;
    zbuf[x] = perp;
    if (tv === 0 || perp > FARB * 3) continue;
    const tex = WALLS[(tv - 1) % WALLS.length];
    if (!tex) continue;
    let wallX = side === 0 ? camY + perp * rdy : camX + perp * rdx;
    wallX -= Math.floor(wallX);
    const fog = fogAt(perp), inv = 1 - fog, fR = fcR * fog, fG = fcG * fog, fB = fcB * fog;
    const hpx = BH / perp;                                    // screen px per world unit at this depth
    const spanPx = hpx;
    const mk = spanPx < tex.h * 0.6 ? (spanPx < tex.h * 0.3 ? (spanPx < tex.h * 0.15 ? 3 : 2) : 1) : 0;
    const m = tex.mips[Math.min(mk, tex.mips.length - 1)];
    const mw = m.w, mh = m.h, td = m.data, mask = mw - 1;
    const mir = (hash2(mx, my) * 2) | 0;
    let tx = (wallX * mw) | 0; tx &= mask;
    if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) tx = mask - tx;
    if (mir & 1) tx = mask - tx;

    /* light on the face: lightmap in the wall cell + lightmap one step out along the normal */
    const nx = side === 0 ? -stepX : 0, ny = side === 1 ? -stepY : 0;
    const inIdx = my * N + mx;
    const lit = lm ? lm[inIdx] : 0.4;
    const litFront = lm ? cellLightAt(mx + 0.5 + nx * 0.6, my + 0.5 + ny * 0.6) : 0;
    const lt = cellTint(inIdx);
    const fall = Math.exp(-perp * 0.16);
    const fk = flashK0 * Math.exp(-perp * 0.30);
    let li = (Math.max(lit, litFront * 0.85) * fall + AMB) * (side === 1 ? 0.78 : 1);
    if (li > 1) li = 1;
    const lr = AMB + (li * lt[0] + fk * flR) * 1.05, lg = AMB + (li * lt[1] + fk * flG) * 1.05, lb = AMB + (li * lt[2] + fk * flB) * 1.05;

    let y0 = horizon + (eyeZ - 1) * hpx, y1 = horizon + eyeZ * hpx;
    const ds = Math.max(0, Math.ceil(y0)), de = Math.min(BH - 1, Math.floor(y1));
    const tstep = mh / (y1 - y0);
    let ty = (ds - y0) * tstep, idx = ds * BW + x;
    for (let y = ds; y <= de; y++, idx += BW) {
      const ti = ((ty | 0) & (mh - 1)) * mw + tx; ty += tstep;
      const c = td[ti];
      if ((c >>> 24) === 253) {                                // emissive strip: ignores scene light
        px[idx] = 0xFF000000 | clampi((c >> 16 & 255) * inv + fB) << 16 | clampi((c >> 8 & 255) * inv + fG) << 8 | clampi((c & 255) * inv + fR);
        continue;
      }
      px[idx] = 0xFF000000 | clampi((c >> 16 & 255) * lb + fB) << 16 | clampi((c >> 8 & 255) * lg + fG) << 8 | clampi((c & 255) * lr + fR);
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
  // rigs rasterize at the size they occupy, so a body is geometric at any distance
  const tex = o.rig ? RIG.frame(o.rig.kind, { hpx: o.rig.hpx, p: o.rig.p, mv: o.rig.mv, atk: o.rig.atk, die: o.rig.die, yaw: o.rig.yaw, lean: o.rig.lean, pulse: o.rig.pulse }) : o.tex;
  const wPx = hPx * (tex.w / tex.h);
  const screenX = (BW * 0.5) * (1 + tX / tY);
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
  const li = Math.min(1, (MAP.light ? MAP.light[idx0] : 0.5) * Math.exp(-tY * 0.14) + 0.30 * visAt(tY));
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
  // a rig texture is authored denser than the quad it lands in; decimating it with a
  // point sample is what made distant enemies shimmer, so filter when texels outnumber pixels
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
      if (zbuf[x] <= tY) continue;
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
function drawBloom(q) {
  const bw = Math.max(24, (BW / 3) | 0), bh = Math.max(16, (BH / 3) | 0);
  if (bloomCv.width !== bw || bloomCv.height !== bh) { bloomCv.width = bw; bloomCv.height = bh; }
  bloomCtx.save();
  bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
  if (canFilter) bloomCtx.filter = 'brightness(1.5) contrast(2.1) saturate(1.25)';
  bloomCtx.globalCompositeOperation = 'source-over';
  bloomCtx.globalAlpha = 1;
  bloomCtx.clearRect(0, 0, bw, bh);
  bloomCtx.drawImage(bufCv, 0, 0, bw, bh);
  bloomCtx.filter = 'none';
  bloomCtx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.42;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bloomCv, 0, 0, DW, DH);
  ctx.restore();
}
function drawLightGlow(q) {
  if (!q.glow) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  let n = 0;
  for (const L of LIGHTS) {
    if (n++ > q.glow) break;
    const d = Math.hypot(L.x - camX, L.y - camY);
    if (d > 20 || d < 0.35) continue;
    if (!los(camX, camY, L.x, L.y)) continue;
    const s = project(L.x, L.y, 0.55);
    if (!s) continue;
    const rad = Math.max(10, (BH / s.d) * 0.55 * (DW / BH));
    const k = clamp((L.str || 0.8) * (1 - d / 22), 0, 1) * 0.5;
    const c = L.col || [255, 200, 130];
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad);
    g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${k * 0.7})`);
    g.addColorStop(0.45, `rgba(${c[0] * 0.8 | 0},${c[1] * 0.7 | 0},${c[2] * 0.55 | 0},${k * 0.22})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(s.x - rad, s.y - rad, rad * 2, rad * 2);
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
  if (q.bloom && bloomCv) drawBloom(q);
  drawLightGlow(q);
  const U = DH / 900;
  const cx = DW / 2 + shakeX * 0.5, cy = DH / 2 + shakeY * 0.5;

  /* particles */
  ctx.globalCompositeOperation = 'lighter';
  for (const p of PARTS) {
    const s = project(p.x, p.y, p.z);
    if (!s || s.d > 34) continue;
    const col = BW * (s.x / DW) | 0;
    if (col < 0 || col >= BW || zbuf[col] < s.d - 0.35) continue;
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
  drawViewModel(U);

  /* damage vignette + low hp */
  const hurt = clamp(P.hurtT / 0.5, 0, 1);
  const lowhp = P.hp < 40 ? (1 - P.hp / 40) * (0.35 + 0.25 * Math.sin(S.t * 6)) : 0;
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
    ctx.fillText(`FPS ${S.fps}  buf ${BW}x${BH}  ${q.name}  billboards ${drawCalls}  decals ${DECALS.length}  parts ${PARTS.length}  enemies ${ENEMIES.length}`, 12, DH - 12);
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

/* ---------------- weapon viewmodel ---------------- */
function drawViewModel(U) {
  const w = WEAPONS[P.weapon];
  const bobX = Math.sin(P.bobPhase) * (10 + 8 * P.sprint) * U * (P.moving() ? 1 : 0.15);
  const bobY = Math.abs(Math.cos(P.bobPhase)) * (8 + 8 * P.sprint) * U * (P.moving() ? 1 : 0.15);
  const kick = P.kick * 1.1 * U;
  const rl = P.reloadT > 0 ? Math.sin(clamp(1 - P.reloadT / Math.max(0.01, w.reload), 0, 1) * Math.PI) : 0;
  const swap = P.swapT > 0 ? P.swapT / 0.34 : 0;
  const crouch = P.crouch * 12 * U;
  const ads = P.ads;
  let ox = DW * (0.5 + 0.16 * (1 - ads)) + bobX * (1 - ads);
  let oy = DH + 10 * U + bobY + kick + rl * 60 * U + swap * 260 * U + crouch - ads * DH * 0.055;
  const sc = (DH / 900) * (1 - ads * 0.06);
  ctx.save();
  ctx.translate(ox, oy); ctx.scale(sc, sc);
  const g1 = '#2b323c', g2 = '#171c24', glove = '#3a4250', glove2 = '#232a35';
  const metal = (x, y, wd, ht, col) => { ctx.fillStyle = col || g1; ctx.fillRect(x, y, wd, ht); };
  const rrect = (x, y, wd, ht, r, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + wd, y, x + wd, y + ht, r); ctx.arcTo(x + wd, y + ht, x, y + ht, r); ctx.arcTo(x, y + ht, x, y, r); ctx.arcTo(x, y, x + wd, y, r); ctx.fill(); };
  const hand = (x, y, s) => { rrect(x, y, 46 * s, 34 * s, 8 * s, glove); rrect(x, y, 46 * s, 10 * s, 5 * s, glove2); };

  if (w.kind === 'pistol') {
    rrect(-40, -230, 46, 150, 8, g2);            // barrel
    rrect(-58, -110, 120, 44, 8, g1);            // slide
    rrect(-40, -66, 60, 76, 10, g2);             // grip
    metal(-30, -215, 26, 10, '#0f1319');
    hand(-34, -60, 1);
    if (S.flash > 0.1) { ctx.globalAlpha = clamp(S.flash, 0, 1); ctx.fillStyle = '#ffe9a8'; ctx.beginPath(); ctx.arc(-16, -236, 34 + 26 * S.flash, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  } else if (w.kind === 'shotgun') {
    rrect(-26, -330, 44, 250, 6, '#12161c');     // barrel
    rrect(-30, -300, 52, 200, 6, '#1c222b');
    rrect(-70, -150, 150, 60, 10, g1);           // receiver
    rrect(-46, -90, 74, 100, 12, '#4a2f1c');     // grip
    rrect(-56, -140, 40, 120, 8, '#3b2617');     // pump
    hand(-52, -140, 1.05); hand(-20, -70, 1.1);
    metal(-20, -334, 30, 12, '#0a0d11');
    if (S.flash > 0.1) { ctx.globalAlpha = clamp(S.flash, 0, 1); ctx.fillStyle = '#ffd68f'; ctx.beginPath(); ctx.arc(-4, -344, 46 + 40 * S.flash, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  } else {
    rrect(-20, -360, 34, 260, 5, '#12161c');     // barrel
    rrect(-56, -190, 130, 70, 10, g1);           // body
    rrect(-30, -120, 56, 110, 8, g2);            // grip
    rrect(-16, -250, 26, 120, 6, '#20262f');     // mag ahead
    rrect(-64, -160, 30, 60, 6, '#0f1319');      // stock
    for (let i = 0; i < 3; i++) rrect(-52 + i * 30, -200, 18, 26, 4, '#d9a94a');
    hand(-40, -110, 1.05); hand(-6, -60, 1.05);
    if (S.flash > 0.1) { ctx.globalAlpha = clamp(S.flash, 0, 1); ctx.fillStyle = '#ffdf9a'; ctx.beginPath(); ctx.arc(-2, -368, 34 + 30 * S.flash, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  }
  // support arm/shape cues
  ctx.restore();
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
      mmCtx.fillStyle = MAP.cell[y * MW + x] !== 0 ? 'rgba(126,156,192,.5)' : 'rgba(28,48,70,.9)';
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
    ctx.fillStyle = k.type === 'health' ? '#5ce07a' : k.type === 'armor' ? '#4ab0ff' : '#ffcf6a';
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
