/* Headless smoke test: stub just enough DOM/canvas to run the game loop in node. */
const vm = require('vm'), fs = require('fs'), path = require('path');
const noop = () => {};
const W = 1280, H = 720;

let ctxDepth = 0;
function ctxStub() {
  const store = {};
  const rnd = (i) => ((i * 2654435761) >>> 24);
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'save') return () => { ctxDepth++; };
      if (k === 'restore') return () => { ctxDepth--; if (ctxDepth < 0) throw new Error('ctx.restore underflow (unbalanced canvas state)'); };
      if (k === 'getImageData') return (x, y, w, h) => {
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) { const v = rnd(i); d[i * 4] = v; d[i * 4 + 1] = v >> 1; d[i * 4 + 2] = 255 - v; d[i * 4 + 3] = (i % 7) ? 255 : 0; }
        return { data: d, width: w, height: h };
      };
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop: noop });
      if (k === 'measureText') return () => ({ width: 10 });
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function canvasStub() {
  const c = { width: 300, height: 150, style: {}, getContext: () => ctxStub(), addEventListener: noop, requestPointerLock: () => undefined };
  return c;
}
const elements = {};
function elStub(id) {
  const reg = {};
  const base = {
    id, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, textContent: '', onclick: null,
    style: {}, addEventListener: (t, f) => { (reg[t] = reg[t] || []).push(f); }, __fire: (t, ev) => { for (const f of (reg[t] || [])) f(ev); }
  };
  if (id === 'screen') Object.assign(base, canvasStub());
  elements[id] = base;
  return base;
}
const docListeners = {};
const listeners = {};
// The game's generator draws from Math.random, so an unseeded run builds a different level,
// lamp field and enemy set in every PROCESS - which made the raster gate measure luck rather
// than code: one commit measured 34.9 / 4.5 / 15.7 ms at load average 1.79, each run
// internally consistent. Clone Math into the sandbox with a seeded PRNG so scenes, and so
// timings, are reproducible. SEED=<n> varies the world on purpose.
// NB: Object.assign({}, Math) copies NOTHING - Math's own properties are non-enumerable per
// spec, which surfaced as "TypeError: Math.hypot is not a function" at asset boot. Chain to
// Math so every method still resolves, and shadow only random.
const SEED = (Number(process.env.SEED) || 12345) >>> 0;
let rs = SEED;
const sbMath = Object.create(Math);
sbMath.random = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
const sandbox = {
  console, Math: sbMath, Date, JSON, Uint32Array, Uint16Array, Uint8ClampedArray, Int16Array, Float32Array, Uint8Array, Object, Array, String, Number, Boolean, Error, isNaN, isFinite, parseInt, parseFloat, setTimeout, clearTimeout,
  document: {
    getElementById: elStub, createElement: () => canvasStub(),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    exitPointerLock: noop, pointerLockElement: null, hidden: false
  },
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: noop,
  requestAnimationFrame: f => { sandbox.__raf = f; return 1; },
  devicePixelRatio: 1, innerWidth: W, innerHeight: H,
  AudioContext: undefined, webkitAudioContext: undefined,
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctxVm = vm.createContext(sandbox);

const files = fs.readdirSync(path.join(__dirname, '..', 'js')).filter(f => f.endsWith('.js')).sort();
let ts = 0;
function frames(n) { try { for (let i = 0; i < n; i++) { ts += 16.7; sandbox.__raf(ts); if (ctxDepth !== 0) throw new Error('unbalanced ctx save/restore, depth=' + ctxDepth); } } catch (e) { console.log('FRAME FAIL: ' + e.stack.split('\n').slice(0, 5).join('\n')); process.exitCode = 1; } }
function step(label, code) {
  try { vm.runInContext(code, ctxVm, { filename: 'step' }); }
  catch (e) { console.log(`FAIL [${label}]: ${e.stack.split('\n').slice(0, 4).join('\n')}`); process.exitCode = 1; }
}
let failed = 0;
function expect(label, cond, detail) {
  if (cond) return;
  console.log(`ASSERT FAIL: ${label}${detail === undefined ? '' : ' -> ' + detail}`);
  failed++; process.exitCode = 1;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// this harness walks a fixed path through the game, so the combat stretches are run
// with the player pinned above death - dying properly is exercised in its own section below
function survive(n) { for (let i = 0; i < n; i++) { vm.runInContext('P.hp = Math.max(P.hp, 85)', ctxVm); frames(1); } }
const fire = (type, ev) => { for (const f of (listeners[type] || [])) f(ev); };
const fireDoc = (type, ev) => { for (const f of (docListeners[type] || [])) f(ev); };
const press = code => { fire('keydown', { code, preventDefault: noop, repeat: false }); fire('keyup', { code, preventDefault: noop }); };
const el = id => elements[id];
// a real click hits the canvas first, then bubbles to window - the harness must match
// that order or the pointer-lock path looks clean when it is not
const clickCanvas = () => { el('screen').__fire('mousedown', { button: 0 }); fire('mousedown', { button: 0 }); };
const release = () => fire('mouseup', { button: 0 });

(async () => {
  for (const f of files) {
    try { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctxVm, { filename: f }); }
    catch (e) { console.log(`LOAD FAIL ${f}: ${e.stack.split('\n').slice(0, 5).join('\n')}`); process.exit(1); }
  }
  console.log('boot ok · mode=', vm.runInContext('S.mode', ctxVm), 'buf=', vm.runInContext('[BW,BH]', ctxVm).join('x'));
  frames(30);
  const bufCheck = () => vm.runInContext(`(()=>{const s=new Set();for(let i=0;i<px.length;i+=997)s.add(px[i]);return s.size})()`, ctxVm);
  const wallCoverage = () => vm.runInContext(`(()=>{const y=(BH>>1)*BW;const s=new Set();let nonfog=0;
    for(let x=0;x<BW;x++){const c=px[y+x];s.add(c);if(c!==fogCol)nonfog++}return {rowColors:s.size,wallPx:nonfog,BW}})()`, ctxVm);
  const memMB = vm.runInContext(`(()=>{const seen=new Set();let b=0;const walk=o=>{if(!o||typeof o!=='object'||seen.has(o))return;seen.add(o);
    for(const k in o){const v=o[k];if(v instanceof Uint32Array)b+=v.byteLength;else if(v&&typeof v==='object')walk(v)}};
    walk(WALLS);walk(PROP);walk(ENEMY);
    // FLOORS/CEILS/DECAL and the rig cache were previously outside the gate, so the
    // "asset memory" number understated what the game actually holds.
    for (const g of [typeof FLOORS !== 'undefined' && FLOORS, typeof CEILS !== 'undefined' && CEILS,
      typeof DECAL !== 'undefined' && DECAL]) if (g) walk(g);
    if (typeof RIG !== 'undefined') b += RIG.stats().mb * 1048576;
    return b / 1048576})()`, ctxVm);
  console.log('asset shading tables:', memMB.toFixed(1), 'MB');
  expect('sprite tables stay in the tens of MB, not hundreds', memMB < 40, memMB.toFixed(1) + ' MB');

  step('title frames', 'null');
  console.log('title buffer colors:', bufCheck());
  expect('title screen renders more than fog', bufCheck() > 8);
  step('gen 0/1/2', 'for(let i=0;i<3;i++){genLevel(i)}');
  for (let li = 0; li < 3; li++) {
    const bad = vm.runInContext(`(()=>{let b=0;for(let g=0;g<60;g++){genLevel(${li});
      if(bfsDist[(exitY|0)*MW+(exitX|0)]<0)b++;
      for(const e of ENEMIES)if(bfsDist[(e.y|0)*MW+(e.x|0)]<0)b++;if(!enemiesLeft())b++}return b})()`, ctxVm);
    expect(`level ${li} always winnable (60 gens)`, bad === 0, `${bad} unreachable exit/spawn(s)`);
  }
  step('start', 'startGame(); S.locked=true');
  frames(20);
  step('walk+look', "keys['KeyW']=true; mouse.dx=6; mouse.dy=-3");
  vm.runInContext('const fogCol=(255<<24|(FOGC[2]<<16)|(FOGC[1]<<8)|FOGC[0])>>>0', ctxVm);
  console.log('play buffer colors:', bufCheck(), 'billboards:', vm.runInContext('drawCalls', ctxVm), 'center row:', JSON.stringify(wallCoverage()));
  {
    // One 120-frame sample was the whole verdict, and on this machine that sample
    // swings 5-18 ms for identical code, so the budget tripped on noise. Five batches,
    // judged on the median, with the worst batch printed rather than hidden.
    const samples = [];
    for (let b = 0; b < 5; b++) {
      const t0 = Date.now();
      vm.runInContext('for(let i=0;i<60;i++){renderWorld();renderOverlay()}', ctxVm);
      samples.push((Date.now() - t0) / 60);
    }
    samples.sort((a, b) => a - b);
    const med = samples[2];
    console.log('raster cost: median', med.toFixed(2), 'ms/frame, batches',
      samples.map(v => v.toFixed(1)).join('/'), 'at', vm.runInContext('[BW,BH]', ctxVm).join('x'));
    expect('raster fits a 60fps frame (median of 5)', med < 16, med.toFixed(2) + ' ms/frame');
  }
  frames(60);
  // put a target the player can actually shoot, then prove gunfire kills
  const lane = vm.runInContext(`(()=>{const r=MAP.rooms[0];
    for(let ry=r.y+1;ry<r.y+r.h-1;ry++)for(let rx=r.x+1;rx<r.x+r.w-1;rx++){
      if(isSolid(rx+0.5,ry+0.5))continue;
      for(let k=0;k<24;k++){const a=k*Math.PI/12,dx=Math.cos(a),dy=Math.sin(a),ex=rx+0.5+dx*2.6,ey=ry+0.5+dy*2.6;
        if(isSolid(ex,ey))continue;
        if(castRayDist(rx+0.5,ry+0.5,dx,dy,3.4).dist<3.4)continue;
        let solo=true;                                  // no third party may intercept the bullet
        for(const o of ENEMIES){if(o.state==='dead')continue;
          const ox=o.x-(rx+0.5),oy=o.y-(ry+0.5),pr=ox*dx+oy*dy;
          if(pr>0&&pr<12&&Math.abs(dx*oy-dy*ox)<0.8)solo=false}
        if(!solo)continue;
        P.x=rx+0.5;P.y=ry+0.5;P.vx=P.vy=0;P.pitch=0;P.ang=a;
        const e=makeEnemy('grunt',ex,ey);e.hp=1;e.maxhp=1;ENEMIES.push(e);return true}}
    return false})()`, ctxVm);
  expect('range setup found a firing lane', lane);
  const shotsBefore = vm.runInContext('P.shots', ctxVm), killsBefore = vm.runInContext('P.kills', ctxVm);
  step('pistol fire', 'mouse.down=true'); frames(25);
  expect('pistol fired', vm.runInContext('P.shots', ctxVm) > shotsBefore);
  expect('gunfire killed an enemy', vm.runInContext('P.kills', ctxVm) > killsBefore);
  step('stop fire', 'mouse.down=false; keys["KeyW"]=false'); frames(10);
  step('shotgun', 'switchWeapon(1); mouse.down=true'); frames(20);
  step('end shotgun', 'mouse.down=false'); frames(30);
  step('rifle ads', 'switchWeapon(2); mouse.rdown=true; mouse.down=true'); frames(60);
  step('end rifle', 'mouse.down=false; mouse.rdown=false'); frames(30);
  step('reload', 'reload()'); frames(160);
  step('grenade', 'throwGrenade()'); frames(140);
  step('jump', "keys['Space']=true"); frames(5); step('land', "keys['Space']=false"); frames(30);
  step('crouch', "keys['KeyC']=true"); frames(40); step('stand', "keys['KeyC']=false"); frames(10);
  step('sprint', "keys['ShiftLeft']=true; keys['KeyW']=true"); frames(50); step('idle', "keys['ShiftLeft']=false; keys['KeyW']=false"); frames(10);
  step('barrels', 'P.hp=100; for(const p of PROPS) if(p.kind==="barrel") hurtBarrel(p,40)'); frames(80);
  const lm0 = vm.runInContext('MAP.light[(P.y|0)*MW+(P.x|0)]', ctxVm);
  step('explode near', 'explode(P.x+2,P.y+1,0.5,3.2,70,30)');
  const lm1 = vm.runInContext('MAP.light[(P.y|0)*MW+(P.x|0)]', ctxVm);
  expect('blast lights the map', lm1 > lm0, `${lm0.toFixed(3)} -> ${lm1.toFixed(3)}`);
  frames(60);
  const lm2 = vm.runInContext('MAP.light[(P.y|0)*MW+(P.x|0)]', ctxVm);
  expect('blast light fully fades out', Math.abs(lm2 - lm0) < 0.01, `${lm0.toFixed(3)} -> ${lm2.toFixed(3)}`);
  // isolate the duck check: cooldown every hostile and drop every pickup, so the only
  // things that can happen are the orb hitting or still flying
  const orb = `PROJ.push({kind:'orb',x:P.x,y:P.y,z:0.9,vx:0,vy:0,vz:0,t:2,tex:PROP.orb[0],scale:0.42,dmg:9})`;
  const dodged = vm.runInContext(`(()=>{for(const e of ENEMIES){e.cd=999;e.atkT=0;e.alert=false;e.state='sleep'}
    PICKUPS.length=0;PROJ.length=0;P.vx=P.vy=0;P.z=0;P.air=false;P.hp=100;P.crouch=1;
    if(isSolid(P.x,P.y))return false;${orb};return true})()`, ctxVm);
  expect('duck setup placed the player in open space', dodged);
  expect('player survived the combat section', vm.runInContext('S.mode', ctxVm) === 'play', vm.runInContext('S.mode', ctxVm));
  frames(2);
  // a dodged orb is still in flight; a hit orb is consumed by the hit test
  expect('crouching dodges head-height fire', vm.runInContext('PROJ.length', ctxVm) === 1,
    'PROJ=' + vm.runInContext('PROJ.length', ctxVm) + ' hp=' + vm.runInContext('Math.round(P.hp)', ctxVm));
  vm.runInContext(`P.crouch=0;PROJ.length=0;${orb}`, ctxVm);
  frames(2);
  expect('standing takes the same hit', vm.runInContext('PROJ.length', ctxVm) === 0,
    'PROJ=' + vm.runInContext('PROJ.length', ctxVm) + ' hp=' + vm.runInContext('Math.round(P.hp)', ctxVm));
  step('aggro all', 'for(const e of ENEMIES) e.alert=true'); survive(240);
  step('damage', 'damagePlayer(25,1.1)'); frames(15);
  step('pickups', 'for(const k of PICKUPS) takePickup(k)'); frames(10);
  step('minimap off', "keys['KeyM']=true"); frames(5); step('minimap on', "keys['KeyM']=false"); frames(5);
  step('perf on', "keys['F3']=true"); frames(5); step('perf off', "keys['F3']=false"); frames(5);
  step('M via event', 'null'); press('KeyM'); press('KeyM'); press('F3'); press('F3'); frames(5);
  step('pitch holds', 'P.pitch=-40; mouse.dx=0; mouse.dy=0'); frames(40);
  expect('manual pitch is not auto-levelled', Math.abs(vm.runInContext('P.pitch', ctxVm) + 40) < 1, 'pitch=' + vm.runInContext('P.pitch', ctxVm));
  step('clear level 1', 'for(const e of ENEMIES) damageEnemy(e,99999,false,1,0)'); frames(20);
  step('to exit', 'P.x=exitX;P.y=exitY'); frames(5);
  step('level 2 loop', 'for(const e of ENEMIES) e.alert=true'); survive(120);
  step('clear level 2', 'for(const e of ENEMIES) damageEnemy(e,99999,true,1,0)'); frames(10);
  step('exit 2', 'P.x=exitX;P.y=exitY'); frames(5);
  step('level 3', 'for(const e of ENEMIES) e.alert=true; damagePlayer(10,0)'); survive(150);
  step('clear 3', 'for(const e of ENEMIES) damageEnemy(e,99999,false,1,0)'); frames(10);
  step('win', 'P.x=exitX;P.y=exitY'); frames(10);
  expect('run reached the win screen', vm.runInContext('S.mode', ctxVm) === 'win', vm.runInContext('S.mode', ctxVm));
  console.log('run stats:', JSON.stringify(vm.runInContext('({kills:P.kills,shots:P.shots,dmg:Math.round(P.dmg)})', ctxVm)));
  step('restart from win', 'null'); el('again2').onclick && el('again2').onclick(); frames(20);
  console.log('after redeploy mode=', vm.runInContext('S.mode', ctxVm), 'level=', vm.runInContext('S.level', ctxVm));
  step('death', 'P.hp=1; damagePlayer(80,0.4)'); frames(40);
  await sleep(1500); frames(5);
  console.log('after death mode=', vm.runInContext('S.mode', ctxVm));
  el('again').onclick && el('again').onclick(); frames(30);
  console.log('after retry mode=', vm.runInContext('S.mode', ctxVm), 'hp=', vm.runInContext('P.hp', ctxVm));
  step('unlock->pause', 'null'); vm.runInContext("document.pointerLockElement=null", ctxVm);
  fireDoc('pointerlockchange', {}); frames(5);
  console.log('after unlock mode=', vm.runInContext('S.mode', ctxVm));
  el('resume').onclick && el('resume').onclick(); frames(10);
  console.log('after resume mode=', vm.runInContext('S.mode', ctxVm));
  press('Escape'); frames(5);
  console.log('after esc mode=', vm.runInContext('S.mode', ctxVm));
  press('Enter'); frames(5);
  console.log('after enter mode=', vm.runInContext('S.mode', ctxVm));
  el('quit').onclick && el('quit').onclick(); frames(10);
  console.log('after quit mode=', vm.runInContext('S.mode', ctxVm));
  el('start').onclick && el('start').onclick(); frames(20);
  console.log('after start mode=', vm.runInContext('S.mode', ctxVm), 'level=', vm.runInContext('S.level', ctxVm));
  step('mouse on canvas', 'null');
  vm.runInContext('genLevel(0); S.mode="play"; S.locked=false; mouse.down=false; P.semiLock=false; P.fireT=0; P.mag[0]=12', ctxVm);
  const lockedShots = vm.runInContext('P.shots', ctxVm);
  clickCanvas(); frames(2);
  expect('the click that grabs the mouse does not fire', vm.runInContext('P.shots', ctxVm) === lockedShots && !vm.runInContext('mouse.down', ctxVm));
  vm.runInContext('S.locked=true', ctxVm); clickCanvas(); frames(2);
  expect('a locked click fires', vm.runInContext('P.shots', ctxVm) === lockedShots + 1, 'shots ' + lockedShots + ' -> ' + vm.runInContext('P.shots', ctxVm));
  release(); frames(5);
  const rep = vm.runInContext(`({mode:S.mode,level:S.level,kills:P.kills,shots:P.shots,hp:Math.round(P.hp),
    parts:PARTS.length,proj:PROJ.length,enemies:ENEMIES.length,left:enemiesLeft(),fps:S.fps,
    mapOk:(MAP.w===MW&&MAP.cell.length===MW*MH)})`, ctxVm);
  console.log('report', rep);
  console.log(`${failed} assertion(s) failed`);
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
})();
