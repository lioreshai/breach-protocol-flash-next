'use strict';
/* ==================================================================
   50_ui_input.js — menus, input, main loop
   ================================================================== */
const $ = id => document.getElementById(id);
const OVS = ['menu', 'pause', 'dead', 'win'];
function show(id) { OVS.forEach(m => $(m).classList.toggle('show', m === id)); }
function hideOv() { OVS.forEach(m => $(m).classList.remove('show')); }

function setDiff(i) {
  S.diff = i;
  ['d0', 'd1', 'd2'].forEach((id, k) => $(id).classList.toggle('on', k === i));
  $('dname').textContent = DIFFS[i].name;
  SND.ui(600 + i * 120);
}

function resetRun() {
  P.hp = 100; P.armor = 0; P.mag = [12, 6, 34]; P.reserve = [150, 66, 280]; P.gren = 4;
  P.weapon = 0; P.vx = P.vy = 0; P.pitch = 0; P.deadT = 0; P.reloadT = 0; P.fireT = 0; P.swapT = 0;
  P.ads = 0; P.crouch = 0; P.z = 0; P.vz = 0; P.air = false; P.hurtT = 0; P.kick = 0; P.recoil = 0;
  P.kills = P.shots = P.hits = P.dmg = 0;
  S.runT = 0; feed.length = 0; PARTS.length = 0; PROJ.length = 0;
  S.flash = 0; S.shake = 0; S.dmgDirT = 0;
}
function startLevel(i, fresh) {
  S.level = i;
  S.exitOpen = false; S.dmgDirT = 0; PARTS.length = 0; PROJ.length = 0;
  genLevel(i);
  P.deadT = 0; P.pitch = 0; P.recoil = 0;
  if (fresh) resetRun();
  banner('SECTOR ' + (i + 1) + ' · ' + LEVELS[i].name, 3.4);
  if (enemiesLeft() === 0) openExit();
}
function nextLevel() {
  if (S.level + 1 >= LEVELS.length) {
    S.mode = 'win'; document.exitPointerLock && document.exitPointerLock();
    $('winStat').textContent = statsText();
    show('win'); SND.fanfare(true); return;
  }
  startLevel(S.level + 1, false);
  P.hp = Math.min(100, P.hp + 15);
  SND.portal(); S.flash = 0.6; S.flashCol = [140, 230, 255];
}
function showDead() {
  S.mode = 'dead'; document.exitPointerLock && document.exitPointerLock();
  $('deadStat').textContent = statsText(); show('dead');
}
function statsText() {
  const acc = P.shots ? Math.round(P.hits / P.shots * 100) : 0;
  const mm = Math.floor(S.runT / 60), ss = Math.floor(S.runT % 60);
  return `TIME       ${mm}:${String(ss).padStart(2, '0')}\nKILLS      ${P.kills}\nDAMAGE     ${Math.round(P.dmg)}\nACCURACY   ${acc}%\nDIFFICULTY ${DIFFS[S.diff].name}`;
}
function startGame() {
  SND.init();
  resetRun(); startLevel(0, true);
  S.mode = 'play'; hideOv(); lockPointer();
}
function resume() { S.mode = 'play'; hideOv(); lockPointer(); }
function toMenu() {
  S.mode = 'title'; show('menu'); genLevel(0); S.exitOpen = false;
  PROJ.length = 0; PARTS.length = 0;
}
function lockPointer() {
  try { const p = cv.requestPointerLock && cv.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

/* ---------------- menus ---------------- */
$('start').onclick = startGame;
$('d0').onclick = () => setDiff(0); $('d1').onclick = () => setDiff(1); $('d2').onclick = () => setDiff(2);
$('resume').onclick = resume;
$('retry').onclick = () => { startLevel(S.level, false); resume(); };
$('quit').onclick = toMenu; $('quit2').onclick = toMenu;
$('again').onclick = () => { resetRun(); startLevel(S.level, false); resume(); };
$('again2').onclick = () => { resetRun(); startLevel(0, false); resume(); };
cv.addEventListener('mousedown', e => {
  // The click that grants pointer lock must not also pull the trigger.
  if (S.mode === 'play' && !S.locked) { lockPointer(); e.stopPropagation(); }
});
addEventListener('mousedown', e => {
  if (S.mode !== 'play' || !S.locked) return;
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) mouse.rdown = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; if (e.button === 2) mouse.rdown = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (S.mode === 'play' && (S.locked || mouse.down)) { mouse.dx += e.movementX || 0; mouse.dy += e.movementY || 0; }
});
addEventListener('wheel', e => { if (S.mode === 'play') switchWeapon((P.weapon + (e.deltaY > 0 ? 1 : WEAPONS.length - 1)) % WEAPONS.length); }, { passive: true });
document.addEventListener('pointerlockchange', () => {
  S.locked = document.pointerLockElement === cv;
  if (!S.locked && S.mode === 'play') { S.mode = 'pause'; show('pause'); mouse.down = false; }
});
addEventListener('blur', () => { if (S.mode === 'play') { S.mode = 'pause'; show('pause'); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.mode === 'play') { S.mode = 'pause'; show('pause'); } });

addEventListener('keydown', e => {
  const c = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3'].includes(c)) e.preventDefault();
  if (e.repeat) { keys[c] = true; return; }
  keys[c] = true;
  if (S.mode === 'title') { if (c === 'Enter' || c === 'Space') startGame(); return; }
  if (S.mode === 'dead' || S.mode === 'win') { if (c === 'Enter' || c === 'KeyR') { resetRun(); startLevel(S.level, false); resume(); } if (c === 'Escape') toMenu(); return; }
  if (S.mode === 'pause') { if (c === 'Escape' || c === 'Enter') resume(); if (c === 'KeyQ') toMenu(); return; }
  if (S.mode !== 'play') return;
  if (c === 'Escape') { S.mode = 'pause'; show('pause'); return; }
  if (c === 'KeyR') reload();
  else if (c === 'KeyG') throwGrenade();
  else if (c === 'Digit1') switchWeapon(0);
  else if (c === 'Digit2') switchWeapon(1);
  else if (c === 'Digit3') switchWeapon(2);
  else if (c === 'KeyM') S.showMap = !S.showMap;
  else if (c === 'KeyT') { S.sound = !S.sound; if (SND.musicGain) SND.musicGain.gain.value = S.sound ? 0.05 : 0; banner(S.sound ? 'AUDIO ON' : 'AUDIO MUTED', 1.2); }
  else if (c === 'F3') S.perf = !S.perf;
  else if (c === 'F4') { S.gfx = (S.gfx + 1) % QUAL.length; resize(); banner('QUALITY: ' + QUAL[S.gfx].name, 1.4); SND.ui(760); }
  else if (c === 'KeyB') { S.locked = false; document.exitPointerLock && document.exitPointerLock(); }
});
addEventListener('keyup', e => { keys[e.code] = false; });

/* ---------------- per-frame ---------------- */
function update(dt) {
  S.runT += dt;
  updatePlayer(dt);
  updateEnemies(dt);
  updateProjectiles(dt);
  updateProps(dt);
  updateParts(dt);
  updatePickups(dt);
  updateDecals(dt);
  updateLights();
  S.flash = Math.max(0, S.flash - dt * (P.fireT > 0 ? 6 : 9));
  S.muzzle = Math.max(0, S.muzzle - dt * 22);   // the gun's own light, separate from the damage flash
  S.shake *= Math.pow(0.0025, dt);
  if (S.shake < 0.02) S.shake = 0;
  S.hitMark = Math.max(0, S.hitMark - dt);
  S.headMark = Math.max(0, S.headMark - dt);
  S.bannerT = Math.max(0, S.bannerT - dt);
  S.dmgDirT = Math.max(0, S.dmgDirT - dt);
  for (let i = feed.length - 1; i >= 0; i--) { feed[i].t -= dt; if (feed[i].t <= 0) feed.splice(i, 1); }
  // alert from nearby gunfire handled in tryFire
  if (P.hp < 35 && !P.air) S.shake = Math.max(S.shake, 0.6 + 0.4 * Math.sin(S.t * 7));
  // music intensity
  if (SND.musicGain) {
    const left = enemiesLeft();
    const want = 0.03 + (left === 0 ? -0.01 : 0.02) + (P.hp < 40 ? 0.05 : 0) + Math.min(0.05, left * 0.004);
    SND.musicGain.gain.value = lerp(SND.musicGain.gain.value, S.sound ? want : 0, dt * 0.6);
  }
  // transient lights are faded in updateProps
}

let last = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  // The canvas cannot show a thrown error, so keep the loop alive on screen and
  // show it instead - a silent freeze is otherwise indistinguishable from a stall.
  try { frameInner(ts); S.err = null; }
  catch (e) {
    if (!S.err) S.err = String((e && e.message) || e) + ' @ ' + String((e && e.stack) || '').split(String.fromCharCode(10))[1];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(12,14,18,0.86)'; ctx.fillRect(0, 0, DW, 62);
    ctx.fillStyle = '#ff6a5a'; ctx.font = '600 15px monospace';
    ctx.fillText('ERROR (loop alive): ' + String((e && e.message) || e).slice(0, 120), 14, 24);
    ctx.fillStyle = '#aeb8c4'; ctx.font = '12px monospace';
    ctx.fillText(String((e && e.stack) || '').split(String.fromCharCode(10))[1] || '', 14, 46);
    // A throw before renderWorld() must not freeze the picture: the simulation
    // keeps stepping, so an unrendered frame reads as a hung game.
    try { renderWorld(); renderOverlay(); } catch (e2) {}
  }
}

function frameInner(ts) {
  const dt = Math.min(0.05, Math.max(0.001, (ts - last) / 1000 || 0.016));
  last = ts;
  S.dt = dt; S.t += dt;
  S.frames++; S.fpsT += dt;
  if (S.fpsT > 0.5) { S.fps = Math.round(S.frames / S.fpsT); S.frames = 0; S.fpsT = 0; }
  drawCalls = 0;
  if (S.mode === 'play') update(dt);
  else if (S.mode === 'title') {
    P.ang += dt * 0.09; P.bobPhase += dt * 1.2;
    P.pitch = Math.sin(S.t * 0.4) * BH * 0.04;
    for (const e of ENEMIES) e.anim += dt * 0.25;
    updateParts(dt);
    S.flash *= Math.pow(0.1, dt * 4);
  } else if (S.mode === 'pause') { for (const e of ENEMIES) e.anim += 0; }
  // shake offsets
  if (S.shake > 0.01) { const k = S.shake * DH * 0.0045; shakeX = (Math.random() - 0.5) * k; shakeY = (Math.random() - 0.5) * k; }
  else { shakeX = 0; shakeY = 0; }
  renderWorld();
  renderOverlay();
}

/* ---------------- boot ---------------- */
resize();
addEventListener('resize', () => { resize(); });
setDiff(1);
genLevel(0);
S.mode = 'title';
banner('', 0);
requestAnimationFrame(frame);
