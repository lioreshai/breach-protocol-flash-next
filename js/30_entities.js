'use strict';
/* ==================================================================
   30_entities.js — weapons, player, enemies, projectiles, particles
   ================================================================== */
const WEAPONS = [
  { name: 'M9 SIDEARM', kind: 'pistol', dmg: 16, pellets: 1, spread: 0.012, rate: 0.15, mag: 12, reload: 0.95, cap: 150, auto: false, kick: 7, shake: 0.35 },
  { name: 'M870 BREACHER', kind: 'shotgun', dmg: 11, pellets: 8, spread: 0.075, rate: 0.72, mag: 6, reload: 1.75, cap: 66, auto: false, kick: 22, shake: 1.0 },
  { name: 'VK-36 AUTOGUN', kind: 'rifle', dmg: 9, pellets: 1, spread: 0.045, rate: 0.085, mag: 34, reload: 2.1, cap: 280, auto: true, kick: 8, shake: 0.45 }
];
const ETYPE = {
  grunt: { hp: 34, spd: 1.85, r: 0.42, scale: 1.02, melee: 11, reach: 1.35, proj: 8.6, projDmg: 9, cd: 1.5, wind: 0.34, sight: 15, score: 100, blood: '#8d1424', stride: 0.80, gait: 2 },
  hound: { hp: 24, spd: 3.25, r: 0.38, scale: 0.78, melee: 8, reach: 1.15, proj: 0, projDmg: 0, cd: 1.0, wind: 0.22, sight: 19, score: 80, blood: '#4c8a2a', stride: 1.05, gait: 4 },
  brute: { hp: 155, spd: 1.55, r: 0.60, scale: 1.52, melee: 24, reach: 1.75, proj: 7.5, projDmg: 17, cd: 2.2, wind: 0.5, sight: 17, score: 320, blood: '#6b2a9a', stride: 0.62, gait: 2 }
};
/* Which of a kind's deaths the next enemy gets (#82). Deliberately NOT a Math.random() draw, and
   the reason is measured rather than guessed: makeEnemy runs INSIDE genLevel, so one extra draw
   there advances the seed stream and rewrites every level for a given seed - as (Math.random() *
   MESH.DIEV) | 0 this turned view.js vert and view.js props red on DIFFERENT worlds (different
   exit distances, prop positions, a 4.07 landing impulse where main read 0.00) without touching a
   line of shading. A counter costs no draw, is reproducible under DEV.tick which never seeds RNG,
   and hands out the variants evenly through a firefight instead of rolling the same one twice. */
let dvNext = 0;
/* Per-enemy cosmetics (gait phase, tint, facing, fidget) come from a PRIVATE stream keyed to a
   spawn counter, not from Math.random. makeEnemy runs INSIDE genLevel, so its ten global draws made
   a level's enemy count part of its layout: constructing twelve enemies and throwing them away —
   no gameplay effect at all — moved a rendered level's mean from 66.4 to 70.2 and changed its hash
   (#90). Same xorshift the asset painter already uses (js/10_assets.js:519). */
let cosmeticSeed = 0x9e3779b9;
function makeEnemy(kind, x, y) {
  const t = ETYPE[kind];
  dvNext = (dvNext + 1) % MESH.DIEV;
  cosmeticSeed = (cosmeticSeed + 0x6d2b79f5) >>> 0;
  let cr = cosmeticSeed;
  const crnd = () => { cr ^= cr << 13; cr ^= cr >>> 17; cr ^= cr << 5; return (cr >>> 0) / 4294967296; };
  return {
    kind, type: t, x, y, vx: 0, vy: 0, r: t.r, scale: t.scale,
    hp: Math.round(t.hp * DIFFS[S.diff].hp), maxhp: Math.round(t.hp * DIFFS[S.diff].hp),
    state: 'sleep', anim: crnd() * 4, atkT: 0, cd: crnd() * 1.2, dieT: 0, flashT: 0, stagger: 0, loseT: 1.6,
    alert: false, lx: x, ly: y, stuck: 0, side: crnd() < 0.5 ? 1 : -1, sideT: 0, movingAmt: 0,
    dv: dvNext,                                       // which death this one gets (#82), fixed at spawn
    tint: [1 + (crnd() - 0.5) * 0.16, 1 + (crnd() - 0.5) * 0.14, 1 + (crnd() - 0.5) * 0.12],
    atkMode: 'melee', ph: crnd() * TAU,
    // locomotion state: velocity is persisted so motion has inertia, and facing turns
    ang: crnd() * TAU, svx: 0, svy: 0, lean: 0, stepPhase: crnd(), footC: 0,
    stgx: 0, stgy: 0, dieAng: 0, fidgetT: crnd() * 3
  };
}
const eyeH = () => cfg.eye + P.z - P.crouch * 0.19;
const playerTop = () => eyeH() + (0.5 - P.crouch * 0.18);
/* Vertical look offset in buffer pixels: the player's own pitch plus the transient
   recoil kick. Screen centre always corresponds to a ray of slope aimPx()/BH, so
   whatever sits under the crosshair is what the shot hits. */
const aimPx = () => P.pitch + P.recoil;
const focalPx = () => BH;                       // vertical focal: 1 world unit tall fills the buffer height
const pitchTan = () => aimPx() / BH;

/* ---------------- particles ---------------- */
function addPart(x, y, z, vx, vy, vz, life, col, size, add) {
  if (PARTS.length > 700) PARTS.shift();
  PARTS.push({ x, y, z, vx, vy, vz, life, max: life, col, size, add: !!add });
}
function burstParts(x, y, z, n, spd, col, life, size, add, up) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, e = Math.random() * Math.PI * 0.5;
    const s = spd * (0.35 + Math.random() * 0.9);
    addPart(x, y, z, Math.cos(a) * s * Math.cos(e), Math.sin(a) * s * Math.cos(e), Math.sin(e) * s * (up || 0.8) + 0.6,
      life * (0.5 + Math.random()), col, size * (0.5 + Math.random()), add);
  }
}
function updateParts(dt) {
  for (let i = PARTS.length - 1; i >= 0; i--) {
    const p = PARTS[i];
    p.life -= dt; if (p.life <= 0) { PARTS.splice(i, 1); continue; }
    p.vz -= 6.2 * dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
    if (!isSolid(nx, p.y)) p.x = nx; else { p.vx *= -0.35; p.vy *= 0.4; }
    if (!isSolid(p.x, ny)) p.y = ny; else { p.vy *= -0.35; p.vx *= 0.4; }
    p.z += p.vz * dt;
    // #98: particles settled on the DATUM, so whatever a body shed on a raised band or in a pit slid
    // down to z = 0.02 - sparks pooling on a floor that is not there. floorAt is an index read and is
    // 0 on every level the generator makes, which leaves this arithmetic exactly as it was.
    const pfl = floorAt(p.x, p.y);
    if (p.z < pfl + 0.02) { p.z = pfl + 0.02; p.vz *= -0.28; p.vx *= 0.7; p.vy *= 0.7; }
  }
}

/* ---------------- ray query ---------------- */
function castRayDist(ox, oy, rx, ry, maxD) {
  let mx = ox | 0, my = oy | 0;
  const dx = Math.abs(1 / (rx || 1e-9)), dy = Math.abs(1 / (ry || 1e-9));
  let stepX, stepY, sdX, sdY;
  if (rx < 0) { stepX = -1; sdX = (ox - mx) * dx; } else { stepX = 1; sdX = (mx + 1 - ox) * dx; }
  if (ry < 0) { stepY = -1; sdY = (oy - my) * dy; } else { stepY = 1; sdY = (my + 1 - oy) * dy; }
  let side = 0, g = 0;
  while (g++ < 200) {
    if (sdX < sdY) { sdX += dx; mx += stepX; side = 0; } else { sdY += dy; my += stepY; side = 1; }
    if (mx < 0 || my < 0 || mx >= MW || my >= MH) return { dist: maxD, x: ox + rx * maxD, y: oy + ry * maxD, side, wall: false };
    if (MAP.cell[my * MW + mx] !== 0) {
      const d = (side === 0 ? sdX - dx : sdY - dy);
      const dd = Math.min(d, maxD);
      return { dist: dd, x: ox + rx * dd, y: oy + ry * dd, side, wall: true };
    }
  }
  return { dist: maxD, x: ox + rx * maxD, y: oy + ry * maxD, side: 0, wall: false };
}

/* analytic hitscan against cylinder-ish enemies */
function hitscan(ang, tanP, range) {
  const dx = Math.cos(ang), dy = Math.sin(ang), ox = P.x, oy = P.y, oz = eyeH();
  const wall = castRayDist(ox, oy, dx, dy, range);
  let bestT = wall.dist, best = null, hitObj = null;
  for (const e of ENEMIES) {
    if (e.state === 'dead') continue;
    const ex = e.x - ox, ey = e.y - oy, proj = ex * dx + ey * dy;
    if (proj < 0 || proj - e.r > bestT) continue;
    const perp = Math.abs(dx * ey - dy * ex);
    if (perp > e.r) continue;
    const th = proj - Math.sqrt(Math.max(0, e.r * e.r - perp * perp));
    if (th < 0.25) continue;
    const ez = floorAt(e.x, e.y);            // the body stands on its own band, not on absolute zero (#98)
    const hz = oz + tanP * th;
    if (hz < ez + 0.02 || hz > ez + e.scale) continue;
    if (th < bestT) { bestT = th; best = e; hitObj = { head: hz > ez + e.scale * 0.78, z: hz }; }
  }
  if (!best) {
    for (const p of PROPS) {
      if (p.kind !== 'barrel' || p.dead) continue;
      const ex = p.x - ox, ey = p.y - oy, proj = ex * dx + ey * dy;
      if (proj < 0.2 || proj - 0.4 > bestT) continue;
      const perp = Math.abs(dx * ey - dy * ex); if (perp > 0.4) continue;
      const th = proj - Math.sqrt(Math.max(0, 0.16 - perp * perp));
      if (th <= 0.2 || th >= bestT) continue;
      const hzb = oz + tanP * th;                       // this branch had no z test at all (#98)
      if (hzb < p.z || hzb > p.z + p.scale) continue;
      bestT = th; best = null; hitObj = { barrel: p, z: hzb };
    }
  }
  const hx = ox + dx * bestT, hy = oy + dy * bestT, hz = oz + tanP * bestT;
  return { t: bestT, x: hx, y: hy, z: hz, enemy: best, info: hitObj, wall: wall.wall, side: wall.side };
}

/* ---------------- firing ---------------- */
function tryFire() {
  if (S.mode !== 'play' || P.deadT > 0) return;
  const w = WEAPONS[P.weapon];
  if (P.fireT > 0 || P.reloadT > 0 || P.swapT > 0) return;
  if (P.mag[P.weapon] <= 0) { SND.shot('dry'); P.fireT = 0.28; if (P.reserve[P.weapon] > 0) reload(); return; }
  P.mag[P.weapon]--; P.fireT = w.rate; P.shots++;
  const adsReduce = 1 - P.ads * 0.55;
  const tanP = pitchTan();
  for (let i = 0; i < w.pellets; i++) {
    const sp = w.spread * adsReduce * (P.moving() ? 1.5 : 1) * (i ? 1 : 0.35);
    const ang = P.ang + (Math.random() - 0.5) * sp * 2;
    const tp = tanP + (Math.random() - 0.5) * sp * 1.4;
    const h = hitscan(ang, tp, 46);
    if (h.enemy) {
      const dm = w.dmg * (h.info.head ? 2.4 : 1);
      damageEnemy(h.enemy, dm, h.info.head, Math.cos(ang), Math.sin(ang));
      P.hits += (h.info.head ? 1 : 0.34);
    } else if (h.info && h.info.barrel) {
      hurtBarrel(h.info.barrel, w.dmg);
    } else {
      if (h.wall || h.t > 40) {
        burstParts(h.x, h.y, Math.max(0.05, h.z), 4, 1.4, '#ffd9a0', 0.25, 0.05, true, 0.6);
        // #120: no altitude window here. h.z is absolute (eyeH() + tanP*t), and the old h.z < 0.96 named
        // the face only while faces spanned 0..1; on a band it rejected every chest-height shot. addWallMark
        // now clamps into the face's own span, so any hit on that face leaves a mark.
        if (h.wall && h.t < 24) addWallMark(h.x, h.y, h.z, h.side);
      }
      else burstParts(h.x, h.y, 0.05, 3, 1.0, '#c9b48a', 0.3, 0.05, false, 0.4);
    }
  }
  SND.shot(w.kind);
  S.flash = Math.max(S.flash, w.kind === 'shotgun' ? 0.75 : 0.45); S.flashCol = [255, 190, 110]; S.muzzle = 1;
  S.shake += w.shake; P.kick = w.kick * (w.kind === 'shotgun' ? 1 : 0.6);
  P.recoil = Math.min(BH * 0.55, P.recoil + w.kick * 0.55 * (BH / 400));
  alertEnemies(P.x, P.y, w.kind === 'shotgun' ? 13 : 8.5, w.kind === 'shotgun' ? 1 : w.kind === 'pistol' ? 0.6 : 0.4);
}
function reload() {
  const w = WEAPONS[P.weapon];
  if (P.reloadT > 0 || P.mag[P.weapon] >= w.mag || P.reserve[P.weapon] <= 0) return;
  P.reloadT = w.reload; SND.reload(0);
  setTimeout(() => { if (P.reloadT > 0 && S.mode === 'play') SND.reload(1); }, Math.min(600, w.reload * 620));
}
function finishReload() {
  const w = WEAPONS[P.weapon], need = w.mag - P.mag[P.weapon], take = Math.min(need, P.reserve[P.weapon]);
  P.mag[P.weapon] += take; P.reserve[P.weapon] -= take;
}
function switchWeapon(i) {
  if (i === P.weapon || i < 0 || i >= WEAPONS.length || P.swapT > 0) return;
  P.weapon = i; P.swapT = 0.34; P.reloadT = 0; SND.ui(520);
}
function throwGrenade() {
  if (P.gren <= 0 || P.swapT > 0 || P.deadT > 0) return;
  P.gren--; P.swapT = 0.35; SND.reload(0);
  const dx = Math.cos(P.ang), dy = Math.sin(P.ang);
  PROJ.push({
    kind: 'gren', x: P.x + dx * 0.4, y: P.y + dy * 0.4, z: eyeH() - 0.1,
    vx: dx * 9.5, vy: dy * 9.5, vz: 2.6 + pitchTan() * 9, t: 1.7, tex: PROP.grenade, scale: 0.2
  });
}

/* ---------------- damage ---------------- */
function damageEnemy(e, dmg, head, dx, dy) {
  if (e.state === 'dead') return;
  e.hp -= dmg; P.dmg += dmg; e.flashT = 0.09; e.alert = true;
  // stagger is a decaying shove along the shot direction, not just a slow-down flag
  e.stagger = 0.26; e.stgx = (dx || 0) * 2.2; e.stgy = (dy || 0) * 2.2;
  const c = head ? '#ff4a4a' : '#b81a2a';
  // #116: the spray's altitude is measured from the band the body stands on. It used to be
  // e.scale alone, which reads as an absolute z, so debris born at a chest 0.6 above the DATUM slid
  // up to the floor of a raised band - blood that sprays along the ground instead of through the air.
  burstParts(e.x, e.y, floorAt(e.x, e.y) + e.scale * (head ? 0.9 : 0.6), head ? 16 : 9, 2.4, c, 0.5, 0.075, false, 1.0);
  if (!isSolid(e.x, e.y)) addGroundSplat(e.x, e.y, 0.20 + Math.random() * 0.12, e.kind === 'hound' ? 'goo' : 'blood');
  if (head) S.headMark = 0.3;
  S.hitMark = 0.16;
  SND.flesh(0);
  if (e.hp <= 0) {
    e.state = 'dead'; e.dieT = 0; P.kills++; S.shake += 2;
    // a body falls the way it was hit, not the way it was walking
    e.dieAng = (dx || dy) ? Math.atan2(dy, dx) : e.ang + Math.random() * 0.8 - 0.4;
    e.vx += (dx || 0) * 1.5; e.vy += (dy || 0) * 1.5;
    killfeed((head ? 'HEADSHOT · ' : '') + e.kind.toUpperCase() + ' DOWN', head ? '#ffe27a' : '#ffcbb3');
    SND.gib(0);
    burstParts(e.x, e.y, floorAt(e.x, e.y) + e.scale * 0.5, 26, 3.4, e.type.blood, 0.9, 0.11, false, 1.2);
    if (!isSolid(e.x, e.y)) addGroundSplat(e.x, e.y, e.scale * 0.42, e.kind === 'hound' ? 'goo' : 'blood');
    if (Math.random() < 0.42 * DIFFS[S.diff].droprate)
      PICKUPS.push({ type: Math.random() < 0.55 ? 'ammo' : 'health', x: e.x, y: e.y, bob: 0, dead: false });
    if (ENEMIES.every(z => z.state === 'dead') && !S.exitOpen) openExit();
  } else if (Math.random() < 0.35) SND.growl(e.kind, 0);
}
function hurtBarrel(p, dmg) {
  if (p.dead) return;
  p.hp -= dmg;
  burstParts(p.x, p.y, 0.6, 5, 1.6, '#ffcf70', 0.3, 0.05, true, 0.7);
  if (p.hp <= 0) { p.dead = true; p.boom = 0.02; }
}
function explode(x, y, z, radius, dmg, ownDmg) {
  SND.explosion(0);
  S.shake += 9; S.flash = 1.0; S.flashCol = [255, 170, 70];
  burstParts(x, y, z, 46, 5.5, '#ffd07a', 0.75, 0.13, true, 1.3);
  burstParts(x, y, z, 22, 3.0, '#7a4a22', 1.1, 0.16, false, 1.0);
  // #105: the falloff was Math.hypot(dx,dy), so z was spent on particles only and a blast
  // downstairs spent full damage on anything within radius at ANY altitude (measured: hp 100 ->
  // 49.4 for a grunt 2.0 m away in xy and 2.00 m up, radius 3.2, dmg 90). What separates two
  // things in this world is a FLOOR, not a z, and both call sites pass an altitude that is not a
  // band - a grenade's mid-air p.z at :540, a literal 0.55 for a chained barrel at :564 - so
  // gating on |dz| would have quietly disarmed every airburst. Comparing the two columns' floors
  // leaves a flat level bit-identical (every floor is 0) and makes a slab over 2*ZQ stop the shock.
  const bf = floorAt(x, y);                                // the band the blast is in
  const banded = (fx, fy) => Math.abs(floorAt(fx, fy) - bf) <= 2 * ZQ;
  for (const e of ENEMIES) {
    if (e.state === 'dead') continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < radius && banded(e.x, e.y)) {
      if (!los(x, y, e.x, e.y) && d > 1.2) continue;
      damageEnemy(e, dmg * (1 - d / radius * 0.7), false, (e.x - x) / (d || 1), (e.y - y) / (d || 1));
      e.vx += (e.x - x) / (d || 1) * 4; e.vy += (e.y - y) / (d || 1) * 4;
    }
  }
  for (const p of PROPS) if (p.kind === 'barrel' && !p.dead && Math.hypot(p.x - x, p.y - y) < radius * 0.9 && banded(p.x, p.y)) { p.dead = true; p.boom = 0.12 + Math.random() * 0.16; }
  const pd = Math.hypot(P.x - x, P.y - y);
  if (pd < radius * 1.1 && ownDmg && banded(P.x, P.y)) {
    if (pd < 0.9 || los(x, y, P.x, P.y)) damagePlayer(ownDmg * (1 - pd / (radius * 1.1)), Math.atan2(y - P.y, x - P.x), true);
  }
  const flash = { x, y, r: 7, str: 1.2, fade: 0.45, col: [255, 172, 82] };
  flash.lit = flash.str; splatLight(flash, flash.str);
  LIGHTS.push(flash);
  if (!isSolid(x, y)) { addGroundSplat(x, y, 0.9, 'scorch'); addGroundSplat(x + rnd(0.6, -0.6), y + rnd(0.6, -0.6), 0.5, 'scorch'); }
}
function damagePlayer(dmg, srcAng, ignoreArmor) {
  if (P.deadT > 0 || S.mode !== 'play') return;
  let d = dmg * DIFFS[S.diff].dmg;
  if (!ignoreArmor && P.armor > 0) { const abs = Math.min(P.armor, d * 0.6); P.armor -= abs; d -= abs; }
  P.hp -= d; P.hurtT = 0.5; S.shake += Math.min(6, d * 0.5);
  S.flash = Math.max(S.flash, 0.4); S.flashCol = [255, 40, 30];
  SND.pain();
  if (srcAng !== undefined) { S.dmgDir = srcAng; S.dmgDirT = 0.9; }
  if (P.hp <= 0) {
    P.hp = 0; P.deadT = 0.001; SND.death();
  }
}
function openExit() {
  S.exitOpen = true;
  banner('ALL HOSTILES DOWN — REACH THE EXIT PORTAL', 4.0);
  SND.portal();
}

/* ---------------- player ---------------- */
P.moving = function () { return Math.hypot(this.vx, this.vy) > 0.35; };
function tryMove(o, dx, dy, rad) {
  // Inside geometry, the radius probes land on the mover's own cell and reject every
  // direction, which is a permanent lock - fall back to bare destination tests so a
  // mover that ends up embedded can always walk out of it.
  if (isSolid(o.x, o.y)) {
    if (canEnter(o.x, o.y, o.x + dx, o.y)) o.x += dx;
    if (canEnter(o.x, o.y, o.x, o.y + dy)) o.y += dy;
    return;
  }
  // axis-separated slide
  if (canEnter(o.x, o.y, o.x + dx + Math.sign(dx) * rad, o.y) && canEnter(o.x, o.y, o.x + dx + Math.sign(dx) * rad, o.y - rad * 0.7) && canEnter(o.x, o.y, o.x + dx + Math.sign(dx) * rad, o.y + rad * 0.7)) o.x += dx;
  if (canEnter(o.x, o.y, o.x, o.y + dy + Math.sign(dy) * rad) && canEnter(o.x, o.y, o.x - rad * 0.7, o.y + dy + Math.sign(dy) * rad) && canEnter(o.x, o.y, o.x + rad * 0.7, o.y + dy + Math.sign(dy) * rad)) o.y += dy;
}
function updatePlayer(dt) {
  const dead = P.deadT > 0;
  const f = dead ? 0 : 1;
  if (P.deadT > 0) {
    P.deadT += dt;
    // The death screen is driven by the simulation clock, not a wall-clock timer:
    // a setTimeout kept running through a pause, so resuming or starting a fresh run
    // from the menu let it fire later and drop pointer lock on a living player.
    if (P.deadT > 1.2 && S.mode === 'play') { P.deadT = 0; SND.fanfare(false); showDead(); }
  }
  // look
  if (!dead && (S.locked || mouse.down)) {
    const s = cfg.sens * (1 - P.ads * 0.45);
    P.ang += mouse.dx * s;
    P.pitch = clamp(P.pitch - mouse.dy * s * focalPx(), -BH * 0.62, BH * 0.62);
  }
  mouse.dx = 0; mouse.dy = 0;
  if (dead) { P.vx *= 0.9; P.vy *= 0.9; }
  else {
    let fw = 0, sd = 0;
    if (keys['KeyW'] || keys['ArrowUp']) fw += 1;
    if (keys['KeyS'] || keys['ArrowDown']) fw -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) sd += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) sd -= 1;
    P.crouch = lerp(P.crouch, (keys['KeyC'] || keys['ControlLeft']) ? 1 : 0, 1 - Math.pow(0.001, dt));
    const wantSprint = (keys['ShiftLeft'] || keys['ShiftRight']) && fw > 0 && P.crouch < 0.4;
    P.sprint = lerp(P.sprint, wantSprint ? 1 : 0, 1 - Math.pow(0.002, dt));
    const spd = (3.55 + 2.15 * P.sprint - 1.7 * P.crouch) * (1 - P.ads * 0.42);
    const len = Math.hypot(fw, sd) || 1;
    const ca = Math.cos(P.ang), sa = Math.sin(P.ang);
    const ax = (ca * fw - sa * sd) / len, ay = (sa * fw + ca * sd) / len;
    const tvx = ax * spd * (fw || sd ? 1 : 0), tvy = ay * spd * (fw || sd ? 1 : 0);
    const accel = fw || sd ? 14 : 11;
    P.vx += (tvx - P.vx) * Math.min(1, accel * dt);
    P.vy += (tvy - P.vy) * Math.min(1, accel * dt);
    // jump / gravity: P.z is an altitude, so what holds the player up is the column's floor
    const gz = floorAt(P.x, P.y);
    const climb = onLadder(P.x, P.y) ? ((keys['KeyE'] ? 1 : 0) - (keys['KeyQ'] ? 1 : 0)) : 0;
    if (climb) { P.air = false; P.vz = 0; P.z = clamp(P.z + climb * 1.6 * dt, gz, Math.max(gz, ceilAt(P.x, P.y) - cfg.eye)); }
    else {
      if ((keys['Space']) && !P.air && P.crouch < 0.4) { P.air = true; P.vz = 3.0; SND.step(); }
      // a floor more than a quantum below the feet is not support: the fall runs the jump's integration
      if (!P.air && gz < P.z - ZQ) { P.air = true; P.vz = 0; }
      if (P.air) {
        P.vz -= 9.2 * dt; P.z += P.vz * dt;
        if (P.z <= gz) {
          const imp = -P.vz;                                 // 5.25 m/s is the impact of a 1.5-unit drop at g=9.2; a jump lands at 3.0
          P.z = gz; P.vz = 0; P.air = false; S.shake += 1.2;
          if (imp > 5.25) damagePlayer((imp - 5.25) * 12);
        }
      }
      // auto-step and step-down: eased so a quantum of floor does not hitch the horizon, snapped when it converges
      else if (gz !== P.z) { const dz = gz - P.z; P.z += Math.abs(dz) < 1e-4 ? dz : dz * Math.min(1, 16 * dt); }
    }
  }
  const spdNow = Math.hypot(P.vx, P.vy);
  tryMove(P, P.vx * dt, P.vy * dt, 0.28);
  // view bob + footsteps
  P.bobPhase += spdNow * dt * 2.4;
  P.bob = Math.sin(P.bobPhase * 2) * (0.5 + 0.5 * P.sprint) * Math.min(1, spdNow / 3.4);
  P.stepT -= dt * spdNow;
  if (P.stepT <= 0 && spdNow > 0.6 && !P.air) { P.stepT = 1.55 - 0.35 * P.sprint; SND.step(); }
  // weapon timers
  P.fireT = Math.max(0, P.fireT - dt);
  P.swapT = Math.max(0, P.swapT - dt);
  P.hurtT = Math.max(0, P.hurtT - dt);
  P.kick *= Math.pow(0.0006, dt);
  P.recoil *= Math.pow(0.06, dt);                // shots climb, then settle - never the player's own aim
  if (P.recoil < 0.2) P.recoil = 0;
  if (P.reloadT > 0) { P.reloadT -= dt; if (P.reloadT <= 0) { P.reloadT = 0; finishReload(); } }
  const w = WEAPONS[P.weapon];
  P.ads = lerp(P.ads, (mouse.rdown && P.reloadT <= 0) ? 1 : 0, 1 - Math.pow(0.0005, dt));
  if (!dead && mouse.down && (w.auto || P.fireT === 0)) {
    if (w.auto) { if (P.fireT <= 0) tryFire(); }
    else if (!w.auto && !P.semiLock) { tryFire(); P.semiLock = true; }
  }
  if (!mouse.down) P.semiLock = false;
  if (dead) return;
  // pickups
  for (const k of PICKUPS) {
    if (k.dead) continue;
    // #109: xy proximity alone took a pickup while hovering above it. The window is 0.6 m rather
    // than a band because a jump peaks at 0.489 m (vz 3.0 against g 9.2, :325/:329) - jumping to
    // grab something still has to work - while feet a full unit above the pickup's floor do not.
    if (dist2(k.x, k.y, P.x, P.y) < 0.5 && Math.abs(P.z - floorAt(k.x, k.y)) < 0.6) takePickup(k);
  }
  // exit: the portal stands ON a band, so being in its column is not enough. It used to be an xy
  // test alone, which changed level from a cell whose floor was a unit below (#105).
  if (S.exitOpen && floorAt(P.x, P.y) === floorAt(exitX, exitY) && dist2(P.x, P.y, exitX, exitY) < 0.55) nextLevel();
  // explored map
  const px0 = P.x | 0, py0 = P.y | 0;
  for (let y = py0 - 7; y <= py0 + 7; y++) for (let x = px0 - 7; x <= px0 + 7; x++) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) continue;
    if ((x - px0) * (x - px0) + (y - py0) * (y - py0) <= 52) { const i = y * MW + x; if (!explored[i]) { explored[i] = 1; S.revealed++; } }
  }
}
function takePickup(k) {
  k.dead = true;
  if (k.type === 'health') {
    if (P.hp >= 100) { k.dead = false; return; }
    P.hp = Math.min(100, P.hp + 25); killfeed('+25 HEALTH', '#7ee08a');
  } else if (k.type === 'armor') {
    if (P.armor >= 100) { k.dead = false; return; }
    P.armor = Math.min(100, P.armor + 45); killfeed('+45 ARMOR', '#7ad0ff');
  } else {
    let got = false;
    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i], room = w.cap - P.reserve[i];
      const add = Math.ceil(w.cap * 0.16);
      if (room > 0) { P.reserve[i] += Math.min(room, add); got = true; }
    }
    if (!got) { k.dead = false; return; }          // full reserves: not consumed, no false report
    killfeed('AMMO RESUPPLY', '#ffd27a');
  }
  SND.pickup(k.type);
  burstParts(k.x, k.y, 0.5, 8, 1.4, k.type === 'armor' ? '#7ad0ff' : '#ffe0a0', 0.4, 0.06, true, 1);
}

/* ---------------- enemy AI ---------------- */
function alertEnemies(x, y, r, report) {
  for (const e of ENEMIES) {
    if (e.state === 'dead' || e.alert) continue;
    // `report` is the wake probability for a shot fired here. It used to be multiplied
    // by 3, and the only call site passed 0.35 - i.e. 1.05, so every sleeping enemy in
    // radius woke on every shot and the parameter was decoration.
    if (Math.hypot(e.x - x, e.y - y) < r && (!report || Math.random() < report)) { e.alert = true; e.state = 'chase'; if (Math.random() < 0.5) SND.growl(e.kind, panOf(e)); }
  }
}
function panOf(e) {
  const a = Math.atan2(e.y - P.y, e.x - P.x) - P.ang;
  return Math.sin(a);
}
function updateEnemies(dt) {
  for (const e of ENEMIES) {
    e.ph += dt;
    if (e.flashT > 0) e.flashT -= dt;
    if (e.stagger > 0) e.stagger -= dt;
    if (e.state === 'dead') { e.dieT += dt; e.vx *= 0.8; e.vy *= 0.8; tryMove(e, e.vx * dt, e.vy * dt, e.r * 0.6); continue; }
    const dx = P.x - e.x, dy = P.y - e.y, d = Math.hypot(dx, dy) || 1e-4;
    // #118: the ray is the enemy's EYE to the player's, not a line drawn on the floor plan - see losZ.
    // The muzzle altitude is the same convention the orb spawn uses (#117).
    const see = d < e.type.sight && losZ(e.x, e.y, floorAt(e.x, e.y) + e.scale * 0.62, P.x, P.y, eyeH()) && P.deadT === 0;
    if (see) { e.alert = true; e.lx = P.x; e.ly = P.y; e.loseT = 1.6; }
    else if (e.alert) { e.loseT -= dt; if (e.loseT <= 0 && d > e.type.sight * 1.6) e.alert = false; }
    if (e.alert && e.state === 'sleep') { e.state = 'chase'; SND.growl(e.kind, panOf(e)); }
    e.cd -= dt;
    if (e.atkT > 0) {
      e.atkT -= dt;
      if (e.atkT <= 0) {
        const t = e.type;
        if (e.atkMode === 'range') {
          const sp = t.proj, a = Math.atan2(P.y - e.y, P.x - e.x);
          // #116: the body's height is a HEIGHT ABOVE ITS FEET, the same way the hitscan window reads
          // it (ez + 0.02 .. ez + scale, above) and the same way the draw list does. On its own it is an
          // absolute z of 0.63 for a grunt, and the orb's floor is the band (#98), so on any band at or
          // above that the shot was born under its own floor and popOrb ran in the frame it was pushed.
          PROJ.push({ kind: 'orb', x: e.x, y: e.y, z: floorAt(e.x, e.y) + e.scale * 0.62, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 0.35, t: 4.5, tex: PROP.orb[0], scale: 0.42, dmg: t.projDmg, src: e });
          SND.enemyShot(panOf(e));
        } else {
          const dd = Math.hypot(P.x - e.x, P.y - e.y);
          if (dd < t.reach * 1.25 && los(e.x, e.y, P.x, P.y)) damagePlayer(t.melee, Math.atan2(e.y - P.y, e.x - P.x));
        }
        e.cd = t.cd * (0.75 + Math.random() * 0.6);
      }
      // winding up and driving through the swing shifts the whole body forward
      const pr = 1 - clamp(e.atkT / e.type.wind, 0, 1);
      e.lean = damp(e.lean, -0.07 + 0.30 * Math.sin(Math.PI * pr), 9, dt);
      e.stepPhase += dt * 0.22;
      e.movingAmt = 0.12;
      if (pr > 0.5 && e.atkMode === 'melee' && d > e.type.reach * 0.6) {
        tryMove(e, (dx / d) * e.type.spd * 0.55 * dt, (dy / d) * e.type.spd * 0.55 * dt, e.r * 0.72);
        e.svx = damp(e.svx, (dx / d) * e.type.spd * 0.55, 8, dt);
        e.svy = damp(e.svy, (dy / d) * e.type.spd * 0.55, 8, dt);
      }
      continue;
    }
    // movement
    let tx = e.alert ? (see ? P.x : e.lx) : e.x, ty = e.alert ? (see ? P.y : e.ly) : e.y;
    let speed = e.type.spd * (1 + S.level * 0.05) * (e.stagger > 0 ? 0.35 : 1);
    let mvx = 0, mvy = 0;
    if (e.alert) {
      const tdx = tx - e.x, tdy = ty - e.y, td = Math.hypot(tdx, tdy) || 1e-4;
      mvx = tdx / td; mvy = tdy / td;
      const wantStop = see ? Math.max(0.9, e.type.reach * 0.72) : 0.15;
      if (td < wantStop && see) { mvx = -mvx * 0.2; mvy = -mvy * 0.2; }
      else if (td < 0.4) { const nx2 = -mvy, ny2 = mvx; mvx = nx2; mvy = ny2; }   // orbit instead of piling up
      // attack decision
      if (e.cd <= 0 && see && !e.atkT) {
        const canRange = e.type.proj > 0 && d > 2.4 && d < 13;
        if (d < e.type.reach || (canRange && Math.random() < 0.6)) {
          e.atkT = e.type.wind; e.atkMode = (d < e.type.reach ? 'melee' : 'range');
          if (e.atkMode === 'melee' || Math.random() < 0.6) SND.growl(e.kind, panOf(e));
        } else if (canRange) { e.atkT = e.type.wind * 1.2; e.atkMode = 'range'; }
      }
    } else {
      e.stepPhase += dt * 0.06;                 // breathing weight shift, not a slowed walk
      // idle bodies glance around instead of locking to one heading
      e.fidgetT = (e.fidgetT || 0) - dt;
      if (e.fidgetT <= 0) {
        e.fidgetT = 2.2 + Math.random() * 4;
        e.fidgetTo = e.ang + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 1.3);
      }
      turnTo(e, e.fidgetTo, 1.0, dt);
      e.lean = damp(e.lean, Math.sin(e.ph * 0.7) * 0.02, 3, dt);
    }
    // separation
    for (const o of ENEMIES) {
      if (o === e || o.state === 'dead') continue;
      const sx = e.x - o.x, sy = e.y - o.y, sd = sx * sx + sy * sy, rr = (e.r + o.r) * 0.9;
      if (sd < rr * rr && sd > 1e-6) { const l = Math.sqrt(sd); mvx += (sx / l) * 0.9; mvy += (sy / l) * 0.9; }
    }
    const ml = Math.hypot(mvx, mvy);
    if (ml > 1e-4) { mvx /= ml; mvy /= ml; }
    // side-step when blocked
    e.sideT -= dt;
    const px2 = e.x + mvx * (e.r + 0.22), py2 = e.y + mvy * (e.r + 0.22);
    if (isSolid(px2, py2)) {
      e.stuck += dt;
      if (e.sideT <= 0) { e.side = Math.random() < 0.5 ? 1 : -1; e.sideT = 0.5 + Math.random() * 0.5; }
      const nx = -mvy * e.side, ny = mvx * e.side;
      mvx = mvx * 0.35 + nx; mvy = mvy * 0.35 + ny;
    } else e.stuck = 0;
    const before = { x: e.x, y: e.y };
    // velocity is a damped state now, so starts and stops ramp instead of snapping
    const acc = e.kind === 'hound' ? 9.5 : e.kind === 'brute' ? 4.2 : 6.5;
    e.svx = damp(e.svx, mvx * speed, acc, dt);
    e.svy = damp(e.svy, mvy * speed, acc, dt);
    const stag = e.stagger > 0 ? e.stagger / 0.26 : 0;              // shot shove, decaying
    if (stag > 0) { e.svx += e.stgx * stag * stag; e.svy += e.stgy * stag * stag; }
    tryMove(e, (e.svx + e.vx) * dt, (e.svy + e.vy) * dt, e.r * 0.72);
    e.vx *= Math.pow(0.02, dt); e.vy *= Math.pow(0.02, dt);
    const moved = Math.hypot(e.x - before.x, e.y - before.y);
    const spd = moved / (dt + 1e-6);
    e.movingAmt = Math.min(1, spd / (e.type.spd + 1e-6));
    // gait phase advances with distance travelled, so a planted foot stays planted
    const gait = e.type.gait, wasFoot = (e.stepPhase * gait) | 0;
    e.stepPhase += moved / e.type.stride;
    if ((e.stepPhase * gait) | 0 !== wasFoot && spd > 0.35) footfall(e, spd);
    e.anim = e.stepPhase;
    // facing turns at a species-specific rate; lean follows the turn error
    let turnErr = 0;
    if (spd > 0.25) {
      const want = Math.atan2(mvy, mvx);
      turnErr = turnTo(e, want, (e.kind === 'hound' ? 7.5 : e.kind === 'brute' ? 3.4 : 5.2), dt);
    }
    e.lean = damp(e.lean, clamp(turnErr * 0.55, -0.2, 0.2) * Math.min(1, spd / e.type.spd) + stag * 0.14, 7, dt);
  }
}

/* ---------------- projectiles & pickups ---------------- */
function updateProjectiles(dt) {
  for (let i = PROJ.length - 1; i >= 0; i--) {
    const p = PROJ[i];
    p.t -= dt;
    p.vz -= (p.kind === 'gren' ? 6.4 : 0.9) * dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
    if (isSolid(nx, ny)) {
      if (p.kind === 'gren') { p.vx *= -0.45; p.vy *= -0.45; p.vz += 1.2; burstParts(p.x, p.y, p.z, 3, 1.2, '#ffd08a', 0.2, 0.04, true, 0.6); }
      else { popOrb(p); PROJ.splice(i, 1); continue; }
    } else { p.x = nx; p.y = ny; }
    p.z += p.vz * dt;
    // #98: an orb's floor was the literal 0.08, so on a raised band it sank through the floor it
    // should pop on and went on travelling underneath it - the VERT lane's last reporting row. The
    // grenade bounce keeps its own arithmetic; only the plane it lands on moved.
    const pfl = floorAt(p.x, p.y) + 0.08;
    if (p.z < pfl) { p.z = pfl; if (p.kind === 'gren') { p.vz *= -0.42; p.vx *= 0.72; p.vy *= 0.72; if (Math.abs(p.vz) < 0.4) p.vz = 0; } else { popOrb(p); PROJ.splice(i, 1); continue; } }
    if (p.kind === 'gren') {
      p.trail = (p.trail || 0) + dt;
      if (p.trail > 0.03) { p.trail = 0; addPart(p.x, p.y, p.z, rnd(0.3), rnd(0.3), 0.2, 0.5, '#ffdd88', 0.05, true); }
      if (p.t <= 0) { explode(p.x, p.y, p.z, 3.4, 95, 42); PROJ.splice(i, 1); continue; }
    } else {
      addPart(p.x, p.y, p.z, rnd(0.4), rnd(0.4), 0, 0.22, '#9cff6a', 0.06, true);
      // hit player?
      const dd = Math.hypot(P.x - p.x, P.y - p.y);
      // #98: the lower bound was the DATUM, so an orb rolling along a floor a metre BELOW a player on
      // a raised band registered as a hit at their legs. The window is the body now: feet plus a
      // crouch allowance up to playerTop(), which already carries P.z.
      const inZ = p.z > P.z + (P.crouch ? 0.16 : 0.02) && p.z < playerTop();
      if (dd < 0.45 && inZ && P.deadT === 0) {
        damagePlayer(p.dmg, Math.atan2(p.y - P.y, p.x - P.x));
        burstParts(p.x, p.y, p.z, 12, 2.2, '#b6ff7a', 0.4, 0.08, true, 1);
        SND.enemyShot(0); PROJ.splice(i, 1); continue;
      }
      if (p.t <= 0) { PROJ.splice(i, 1); continue; }
    }
  }
}
function popOrb(p) {
  burstParts(p.x, p.y, p.z, 8, 1.8, '#a8ff7a', 0.3, 0.07, true, 0.8);
  const L = { x: p.x, y: p.y, r: 3.2, str: 0.5, fade: 0.2, col: [150, 255, 110] };
  L.lit = L.str; splatLight(L, L.str); LIGHTS.push(L);
}
function updateProps(dt) {
  for (const p of PROPS) {
    if (p.boom !== undefined && p.boom > 0) {
      p.boom -= dt;
      if (p.boom <= 0) { p.boom = undefined; explode(p.x, p.y, 0.55, 3.2, 88, 40); }
    }
  }
  // transient lights re-splat their delta as they fade, then drop out
  for (let i = LIGHTS.length - 1; i >= 0; i--) {
    const L = LIGHTS[i];
    if (L.fade === undefined) continue;
    L.str = Math.max(0, L.str - dt * 3);
    L.fade -= dt;
    splatLight(L, L.str - L.lit);
    L.lit = L.str;
    MAP.tintDirty = true;
    if (L.fade <= 0) LIGHTS.splice(i, 1);
  }
}
function updatePickups(dt) { for (const k of PICKUPS) k.bob += dt * 2.4; }
function updateLights() { if (MAP.tintDirty) buildTint(); }

/* ---------------- helpers ---------------- */
/* shortest-path turn toward a heading, capped at rate rad/s; returns the signed error */
function turnTo(e, want, rate, dt) {
  let d = want - e.ang;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  const step = clamp(d, -rate * dt, rate * dt);
  e.ang += step;
  if (e.ang > Math.PI) e.ang -= TAU; else if (e.ang < -Math.PI) e.ang += TAU;
  return d;
}
/* one foot reaching the ground: sound, dust, scuff particles */
function footfall(e, spd) {
  const d = Math.hypot(e.x - P.x, e.y - P.y);
  if (d < 15 && !P.deadT) {
    const w = e.kind === 'brute' ? 1.7 : e.kind === 'hound' ? 0.5 : 1;
    SND.burst(0.05, e.kind === 'hound' ? 520 : e.kind === 'brute' ? 210 : 340, 150, 1.1,
      0.05 * w / (1 + d * 0.22), 'lowpass', panOf(e) * 0.6);
  }
  if (++e.footC % 2 === 0 && spd > 0.9) {
    addGroundSplat(e.x, e.y, e.kind === 'hound' ? 0.1 : e.kind === 'brute' ? 0.2 : 0.14, 'dust');
    if (spd > 2.2) addPart(e.x, e.y, 0.04, rnd(0.24) - 0.12, rnd(0.24) - 0.12, 0.14, 0.5, '#9a8f7e', 0.045, false);
  }
}
function enemiesLeft() { let n = 0; for (const e of ENEMIES) if (e.state !== 'dead') n++; return n; }
function enemyFrame(e) {
  const F = ENEMY[e.kind];
  if (e.state === 'dead') {
    const i = clamp((e.dieT / 0.5 * F.die.length) | 0, 0, F.die.length - 1);
    return { tex: F.die[i], alpha: e.dieT > 2.4 ? Math.max(0, 1 - (e.dieT - 2.4) / 1.4) : 1, flash: false };
  }
  if (e.atkT > 0) {
    const pr = 1 - clamp(e.atkT / e.type.wind, 0, 1);
    return { tex: F.atk[clamp((pr * F.atk.length) | 0, 0, F.atk.length - 1)], alpha: 1, flash: e.flashT > 0 };
  }
  const i = ((e.anim % 1) * F.walk.length) | 0;
  return { tex: F.walk[clamp(i, 0, F.walk.length - 1)], alpha: 1, flash: e.flashT > 0 };
}
