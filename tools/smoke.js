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
console.log('seed', SEED, process.env.SEED ? '(from SEED env)' : '(default)');
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

  // castWalls wraps the neighbour texel with `& (w - 1)` rather than comparing against the width,
  // which is the same answer only while every mip dimension is a power of two. buildMips clamps the
  // chain at 8, so one non-power-of-two base texture would carry a wrong wrap through every mip.
  const pow2Bad = vm.runInContext(`(()=>{const pot=n=>n>0&&(n&(n-1))===0;const b=[];
    const chk=(nm,t)=>{if(!t)return;const L=[{w:t.w,h:t.h}].concat(t.mips||[]);
      L.forEach((m,i)=>{if(!pot(m.w)||!pot(m.h))b.push(nm+' mip'+i+' '+m.w+'x'+m.h)})};
    for(let i=0;i<WALLS.length;i++)chk('WALLS['+i+']',WALLS[i]);return b})()`, ctxVm);
  const mipCount = vm.runInContext('(()=>{let n=0;for(let i=0;i<WALLS.length;i++){const t=WALLS[i];if(t)n+=1+(t.mips?t.mips.length:0)}return n})()', ctxVm);
  console.log('wall mip dimensions:', mipCount, 'checked,', pow2Bad.length, 'not a power of two');
  expect('wall mip dimensions are powers of two (the & mask wrap depends on it)',
    pow2Bad.length === 0, pow2Bad.slice(0, 4).join(', '));

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
  console.log('play buffer colors:', bufCheck(), 'sprites:', vm.runInContext('drawCalls', ctxVm), 'center row:', JSON.stringify(wallCoverage()));
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
    // The verdict used to be a bare number. SEED=777 measures 18.95 ms on code that reads
    // 3.3 ms at the default seed, so a red X could not be told apart from an unlucky world.
    // Name the scene that was timed, in the line AND in the failure detail.
    const sc = vm.runInContext('[S.level, LEVELS[S.level].name, P.x, P.y, P.z, MW, MH, MAP.rooms.length]', ctxVm);
    const scene = `SEED ${SEED} - L${sc[0]} ${sc[1]} - player ${sc[2].toFixed(1)},${sc[3].toFixed(1)} z ${sc[4].toFixed(2)}` +
      ` - grid ${sc[5]}x${sc[6]} - ${sc[7]} rooms - buffer ${vm.runInContext('[BW,BH]', ctxVm).join('x')}`;
    console.log('raster cost: median', med.toFixed(2), 'ms/frame, batches',
      samples.map(v => v.toFixed(1)).join('/'), '|', scene);
    expect('raster fits a 60fps frame (median of 5)', med < 16, med.toFixed(2) + ' ms/frame @ ' + scene);
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
  // -------------------------------------------------------------- VERT lane
  // Everything above this line judges a flat world: the run loop teleports x/y and leaves the
  // altitude alone, blast damage and the portal trigger measure 2D distance, and a projectile's
  // floor is a literal 0.02/0.08. VERT=1 runs the same harness against real bands so those four
  // claims ("shots pass through the catwalk enemy", "an explosion downstairs kills upstairs",
  // "the portal triggers from the floor below", "a grenade rolls along the floor") are asserted
  // where they can actually be wrong. A row whose defect is already filed reports instead of
  // failing, and re-reads its own measurement every run: the day the fix lands it becomes a
  // plain assert with no CI-list edit. STRICT=1 promotes every row now.
  if (process.env.VERT) {
    const V = code => vm.runInContext(code, ctxVm);
    // every snippet is an IIFE: a top-level `const` in one runInContext script is a lexical
    // binding on the context and the NEXT script then hits "already declared". Reads are wrapped
    // as expressions, setups as blocks - `(=>{P.kills})()` is a block body and yields undefined.
    const S1 = code => {
      const c = code.trim();
      if (c.startsWith('{') && /\breturn\b/.test(c)) return V('(()=>' + c + ')()');
      return V('(()=>(' + (c.startsWith('{') ? c.slice(1, -1) : c) + '))()');
    };
    let vknown = 0, vgate = 0;
    // print the measurement whether or not it gates: a lane that reports nothing on a pass cannot
    // be audited later. Two kinds of row, and the difference is not cosmetic -
    //   vrow      a gate. It fails the run. Used for behaviour that is correct today, so a
    //             REGRESSION (reverting #99, deleting gravity) is red, not a note.
    //   vknownRow correct behaviour asserted, but the defect is filed: red only under STRICT=1,
    //             and it becomes a plain passing gate the day the fix lands, with no CI edit.
    // A single row that both "reports" and "gates when broken" cannot fail at all, which a
    // control proved the moment #99's window was reverted and the run stayed green.
    const vrow = (label, ok, detail) => {
      console.log('  VERT ' + label.padEnd(56) + (ok ? 'ok   ' : 'FAIL ') + ' ' + detail);
      vgate++; expect('VERT ' + label, ok, detail);
    };
    const vknownRow = (label, ok, detail, issue) => {
      if (ok) { vrow(label, true, detail + ' (filed ' + issue + ', fixed)'); return; }
      vknown++;
      console.log('  VERT ' + label.padEnd(56) + 'KNOWN [' + issue + '] ' + detail);
      if (process.env.STRICT) expect('VERT ' + label, false, detail);
    };
    // a row that could not set up is a FAILURE, never a KNOWN: a row that silently skips is the
    // "check that cannot fail" this lane exists to catch
    const vsetup = (label, ok, detail) => { expect('VERT ' + label, ok, detail); return ok; };
    const vboot = () => {
      V('genLevel(0); startLevel(0,true); S.mode="play"; S.locked=true; S.exitOpen=false');
      V('window.__fzbak = MAP.fz.slice()');
      V("for(const e of ENEMIES){e.state='sleep';e.cd=999;e.alert=false} PROJ.length=0; PICKUPS.length=0");
    };
    const vpoke = (x, y, dq) => V('MAP.fz[' + (y * vm.runInContext('MW', ctxVm)) + ' + ' + x + '] += ' + dq + '; linkBoundaries()');
    const vrestore = () => V('MAP.fz.set(window.__fzbak); linkBoundaries()');
    // a cell with `len` metres of unobstructed line along +x and no third party in the corridor
    const vlane = len => S1(`{for(const r of MAP.rooms)
      for(let ry=r.y+1;ry<r.y+r.h-1;ry++)for(let rx=r.x+1;rx<r.x+r.w-1;rx++){
        if(isSolid(rx+0.5,ry+0.5))continue;
        if(castRayDist(rx+0.5,ry+0.5,1,0,${len}).dist<${len})continue;
        let solo=true;for(const o of ENEMIES){if(o.state==='dead')continue;
          const ox=o.x-(rx+0.5),oy=o.y-(ry+0.5);if(ox>0&&ox<14&&Math.abs(oy)<0.8)solo=false}
        if(!solo)continue;return [rx,ry]}
      return null}`);
    console.log('--- VERT lane: the same harness against real bands ---');

    // V1 - "shots pass through the catwalk enemy". js/30_entities.js:116-118 tests the ray's z
    // against the TARGET's own band, so a body standing 0.75 m up is out of reach of a level
    // shot; before #99 that window was absolute (0.02..e.scale) and the bullet passed through the
    // floor the enemy stands on and killed it. Both halves are asserted: no kill, and shots fired,
    // because a lane that never fired would satisfy "no kill" forever.
    vboot();
    {
      const ln = vlane(6);
      if (!vsetup('shot setup found a 6 m firing lane', !!ln, 'no clear corridor on this seed')) { }
      else {
        const ex = ln[0] + 4, ey = ln[1];
        vpoke(ex, ey, 3);                                    // +0.75 m pedestal under the enemy
        const k0 = S1('{P.kills}'), s0 = S1('{P.shots}');
        S1(`{ENEMIES.length=0;const e=makeEnemy('grunt',${ex}+0.5,${ey}+0.5);e.hp=1;e.maxhp=1;ENEMIES.push(e);
           P.x=${ln[0]}+0.5;P.y=${ln[1]}+0.5;P.vx=P.vy=P.vz=0;P.ang=0;P.pitch=0;P.crouch=0;P.fireT=0;P.mag[0]=8;
           P.z=floorAt(P.x,P.y);P.air=false;switchWeapon(0);return 0}`);
        V("mouse.down=true"); frames(30); V("mouse.down=false"); frames(5);
        const k1 = S1('{P.kills}'), ns = S1('{P.shots}') - s0;
        const win = S1(`{const e=ENEMIES[0],ez=floorAt(e.x,e.y);return [P.z+cfg.eye,ez+0.02,ez+e.scale,e.hp]}`);
        vrow('a level shot does not pass through a raised enemy floor', k1 === k0 && ns > 0,
          `${ns} shot(s), kills ${k0} -> ${k1}: ray z ${win[0].toFixed(2)} vs enemy window [${win[1].toFixed(2)}, ${win[2].toFixed(2)}], enemy hp ${win[3]}`);
        vrestore();
      }
    }

    // V2 - walking off a step, driven by real input rather than a written P.vx (the player update
    // recomputes velocity from keys, so a direct write just gets damped to nothing).
    vboot();
    {
      const ln = vlane(4);
      if (!vsetup('fall setup found a 4 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const px = ln[0], py = ln[1];
        vpoke(px, py, 4);                                    // player stands on a +1.0 m band
        S1(`{ENEMIES.length=0;P.x=${px}+0.5;P.y=${py}+0.5;P.ang=0;P.pitch=0;P.hp=100;P.crouch=0;
            P.z=floorAt(P.x,P.y);P.air=false;P.vx=P.vy=0;return 0}`);
        const hp0 = S1('{P.hp}'), x0 = S1('{P.x}');
        V("keys['KeyW']=true");
        let air = 0;
        for (let i = 0; i < 45; i++) { frames(1); air += S1('{P.air?1:0}'); }
        V("keys['KeyW']=false"); frames(10);
        const z = S1('{P.z}'), fl = S1('{floorAt(P.x,P.y)}'), d = S1('{P.x}') - x0, hp1 = S1('{P.hp}');
        vrow('walking off a step lands on the band below', air > 0 && Math.abs(z - fl) < 0.02 && hp1 >= hp0 && d > 0.8,
          `airborne ${air} frames, travelled ${d.toFixed(2)} m, P.z ${z.toFixed(3)} vs floorAt ${fl.toFixed(3)}, hp ${hp0} -> ${hp1}`);
        vrestore();
      }
    }

    // V3 - the portal trigger (js/30_entities.js:369) is dist2(P.x,P.y,exitX,exitY) < 0.55 with no
    // z term. The trigger radius is 0.55 and a cell is 1 m, so the only ground that is both inside
    // the radius and in a DIFFERENT column is the 5 cm sliver at a cell edge - which is exactly the
    // standing position that matters: at the lip of a portal a metre overhead.
    vboot();
    {
      const r = S1('{return [exitX,exitY,isSolid(exitX,exitY)]}');
      if (!vsetup('portal setup found an open exit cell', !r[2], 'exit cell solid on this seed')) { }
      else {
        const gx = Math.floor(r[0]), gy = Math.floor(r[1]);
        V('S.exitOpen=true');
        vpoke(gx - 1, gy, -4);                               // the column at the lip drops 1.0 m
        S1(`{P.x=exitX-0.52;P.y=exitY;P.vx=P.vy=P.vz=0;P.air=false;P.crouch=0;
            P.z=floorAt(P.x,P.y);return 0}`);
        const lv = S1('{S.level}'), pz = S1('{P.z}'), md = S1('{S.mode}');
        frames(4);
        vknownRow('the portal does not trigger from a band below', S1('{S.level}') === lv && S1('{S.mode}') === 'play',
          `player z ${pz.toFixed(2)}, portal floor ${S1('{floorAt(exitX,exitY)}').toFixed(2)}, 0.52 m away in xy: level ${lv} -> ${S1('{S.level}')}, mode ${md} -> ${S1('{S.mode}')}`, '#105');
        vrestore();
      }
    }

    // V4 - explode(x,y,z,...) spends its z argument on particles only: the falloff at
    // js/30_entities.js:235 is Math.hypot(dx,dy), so a blast on the lower band damages anything
    // within radius at ANY altitude.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('blast setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const ex = ln[0] + 2, ey = ln[1];
        vpoke(ex, ey, 8);                                    // enemy on a +2.0 m band: far enough
        // above the blast that a fix cannot clear it with a 1 m tolerance by luck - at +1.25 m the
        // separation measured 1.15 m and a 1.2 m tolerance let the damage through untouched
        const sep = S1('{floorAt(' + (ex + 0.5) + ',' + (ey + 0.5) + ')}');
        S1(`{ENEMIES.length=0;const e=makeEnemy('grunt',${ex}+0.5,${ey}+0.5);e.hp=100;ENEMIES.push(e);
            P.x=${ln[0]}+0.5;P.y=${ln[1]}+0.5;P.z=floorAt(P.x,P.y);P.air=false;P.hp=100;return 0}`);
        const hp0 = S1('{ENEMIES[0].hp}');
        S1(`{explode(${ln[0]}+0.5,${ln[1]}+0.5,floorAt(${ln[0]}+0.5,${ln[1]}+0.5)+0.1,3.2,90,0);return 0}`);
        frames(6);
        const hp1 = S1('{ENEMIES[0].hp}');
        vknownRow('a blast on the lower band spares the band above', hp1 >= hp0,
          `hp ${hp0} -> ${hp1}, 2.0 m away in xy, ${sep.toFixed(2)} m above the blast centre`, '#105');
        vrestore();
      }
    }

    // V7 - the other half of V4, and the reason it exists at all. A gate that only ever CLOSES also
    // satisfies "spares the band above", and that is not hypothetical: replacing banded() with
    // `false` - blasts damage nothing anywhere - leaves the flat lane GREEN, because the flat harness
    // calls explode at :205 and asserts only that it does not throw. So V4 alone would ship "blasts
    // do nothing". Same geometry, no poke: the body is on the blast's OWN band and must lose exactly
    // the 50.6 the falloff prescribes at 2.0 m with radius 3.2 and dmg 90.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('same-band blast setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const ex = ln[0] + 2, ey = ln[1];
        S1(`{ENEMIES.length=0;const e=makeEnemy('grunt',${ex}+0.5,${ey}+0.5);e.hp=100;ENEMIES.push(e);
            P.x=${ln[0]}+0.5;P.y=${ln[1]}+0.5;P.z=floorAt(P.x,P.y);P.air=false;P.hp=100;return 0}`);
        const hp0 = S1('{ENEMIES[0].hp}');
        S1(`{explode(${ln[0]}+0.5,${ln[1]}+0.5,floorAt(${ln[0]}+0.5,${ln[1]}+0.5)+0.1,3.2,90,0);return 0}`);
        frames(6);
        const hp1 = S1('{ENEMIES[0].hp}');
        const want = 90 * (1 - 2 / 3.2 * 0.7);
        vrow('a blast on its own band still damages a body on it', hp1 <= hp0 - want * 0.8,
          `hp ${hp0.toFixed(1)} -> ${hp1.toFixed(1)} at 2.00 m in xy on the same band; the falloff says`
          + ` -${want.toFixed(1)}, a gate that never opens reads ${hp1 === hp0 ? '0' : (hp0 - hp1).toFixed(1)}`);
      }
    }

    // V5 - a projectile's floor is a literal (js/30_entities.js:79 clamps z against 0.02, :532
    // against 0.08, never against the band), so an orb on a raised band sinks through the floor it
    // should pop on and keeps travelling under it. Spawned downrange, not at the player: the flat
    // harness spawns it on the player's own tile, which pops it against the player on frame 1 and
    // would leave this row judging a sentinel value.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('orb setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const px = ln[0], py = ln[1];
        for (let k = 0; k <= 2; k++) vpoke(px + k, py, 4);    // the corridor is a +1.0 m band
        const fl = S1(`{floorAt(${px}+1.5,${py}+0.5)}`);
        S1(`{ENEMIES.length=0;PROJ.length=0;P.x=${px}+0.5;P.y=${py}+0.5;P.z=floorAt(P.x,P.y);P.air=false;
            PROJ.push({kind:'orb',x:${px}+1.5,y:${py}+0.5,z:floorAt(${px}+1.5,${py}+0.5)+0.9,vx:0,vy:0,vz:-1.6,
              t:3,tex:PROP.orb[0],scale:0.42,dmg:9});return 0}`);
        let minz = 99, obs = 0, popped = 0;
        for (let i = 0; i < 60; i++) {
          frames(1);
          if (S1('{PROJ.length}')) { obs++; minz = Math.min(minz, S1('{PROJ[0].z}')); } else { popped = i + 1; break; }
        }
        vknownRow('an orb pops on its own band, not on the datum', obs > 3 && minz >= fl - 0.1,
          `band floor ${fl.toFixed(2)}, orb lowest z ${obs ? minz.toFixed(2) : 'never observed'} over ${obs} frame(s)` +
          (popped ? ', popped frame ' + popped : ', still flying at 60'), '#98');
        S1('{PROJ.length=0;return 0}'); vrestore();
      }
    }

    // V6 - pickups are the same xy-only proximity as the portal, at js/30_entities.js:366: hovering
    // a unit above a pickup took it. This one gates rather than reports, because the fix ships here.
    // Both halves are asserted - "not taken while hovering" is also satisfied by a lane that broke
    // pickups. vboot clears PICKUPS so this row places its own (same shape as 20_level.js:404), and
    // no floor is poked: the player HOVERS, so no VB_BLOCK and no #100 interaction helps the row.
    // P.hp is 60 because takePickup un-does a health pickup at full hp.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('pickup setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const kx = ln[0] + 1.5, ky = ln[1] + 0.5;
        const fl = S1(`{floorAt(${kx},${ky})}`);
        S1(`{PICKUPS.length=0;PICKUPS.push({type:'health',x:${kx},y:${ky},bob:0,dead:false});
            window.__pk=PICKUPS[0];P.x=${kx};P.y=${ky};P.z=${fl}+1;P.air=true;P.vz=0;P.hp=60;return 0}`);
        const fz = S1('{P.z}');
        frames(1);
        // S1 hands back the raw value, so this is a boolean: comparing it to the STRING 'true'
        // made both halves false, and the negative half vacuously true - a row that cannot fail.
        const high = !!S1('{window.__pk.dead}');
        S1(`{P.z=${fl};P.air=false;P.vz=0;return 0}`);
        frames(2);
        const low = !!S1('{window.__pk.dead}');
        vrow('a pickup is grabbed on its band, not from above', !high && low,
          `pickup floor ${fl.toFixed(2)}: taken with feet ${fz.toFixed(2)} (hovering 1.00 m up) = ${high},` +
          ` taken with feet ${fl.toFixed(2)} (standing) = ${low}${low ? '' : ' - the grab itself is broken'}`);
        S1('{PICKUPS.length=0;return 0}');
      }
    }

    // V8 - particles. js/30_entities.js:79 clamped a particle's z against the literal 0.02, so debris
    // shed on a raised band pooled on the DATUM - sparks lying on a floor that is not there. Asserted
    // as an invariant rather than a minimum, because debris drifts sideways into neighbouring columns
    // and a plain "lowest z in the band" would blame the drift: no particle may sit below the floor
    // of the cell it is standing in. That is the defect, stated where the fix cannot dodge it.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('particle setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        for (let k = 0; k <= 2; k++) vpoke(ln[0] + k, ln[1], 4);           // the run is a +1.0 m band
        const fl = S1(`{floorAt(${ln[0]}+1.5,${ln[1]}+0.5)}`);
        const n0 = S1(`{PARTS.length=0;P.x=${ln[0]}+0.5;P.y=${ln[1]}+0.5;P.z=floorAt(P.x,P.y);P.air=false;
            burstParts(${ln[0]}+1.5,${ln[1]}+0.5,floorAt(${ln[0]}+1.5,${ln[1]}+0.5)+0.5,26,1.4,'#ffd07a',1.6,0.08,false,0.35);
            return PARTS.length}`);
        let seen = 0, worst = 0, under = 0;
        for (let i = 0; i < 45; i++) {
          frames(1);
          if (!S1('{PARTS.length}')) break;
          seen++;
          const r = S1(`{let b=0,n=0;for(const q of PARTS){const f=floorAt(q.x,q.y); if(f>0.5&&q.z<f-0.05){n++;b=Math.max(b,f-q.z)}}
                        return [n,b]}`);
          under += r[0]; worst = Math.max(worst, r[1]);
        }
        vrow('no particle sits below the floor of its own cell', seen > 3 && under === 0,
          `band floor ${fl.toFixed(2)}, ${n0} particles burst at +0.50 over ${seen} frame(s): ` +
          `${under} particle-frame(s) below their cell floor, worst depth ${worst.toFixed(2)} m`);
        S1('{PARTS.length=0;return 0}'); vrestore();
      }
    }

    // V9 - the orb/player altitude window started at the DATUM (js/30_entities.js:558), so an orb
    // travelling along a floor a metre BELOW a player on a raised band damaged them at the legs.
    // The orb has to be in the LOW column and the player in the raised one, because the projectile
    // floor fix lifts an orb inside a raised column to that column's floor - which is correct, and
    // would have made a same-column version of this row pass for the wrong reason. Both halves are
    // asserted: an orb at the player's own altitude must still hit, or the row could be satisfied by
    // breaking hit detection outright. dd is asserted too: if tryMove slides the player clear of the
    // boundary the proximity test stops being the thing under test, so the row says so instead of
    // going quietly green.
    vboot();
    {
      const ln = vlane(3);
      if (!vsetup('orb window setup found a 3 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const cx = ln[0] + 1, cy = ln[1];
        vpoke(cx, cy, 4);                                                 // player on a +1.0 m band
        const fl = S1(`{floorAt(${cx}+0.5,${cy}+0.5)}`);
        const orbAt = (x, z) => S1(`{PROJ.length=0;PROJ.push({kind:'orb',x:${x},y:${cy}+0.5,z:${z},vx:0,vy:0,vz:0,
            t:3,tex:PROP.orb[0],scale:0.42,dmg:25});return PROJ[0].z}`);
        S1(`{ENEMIES.length=0;PROJ.length=0;P.x=${cx}+0.85;P.y=${cy}+0.5;P.z=floorAt(P.x,P.y);P.air=false;
            P.hp=100;P.deadT=0;P.crouch=0;return 0}`);
        // Mid-band, not at the datum: an orb lying at z 0.05 in the low column is INSIDE that
        // column's floor slab, so the projectile clamp lifts and pops it before the player test
        // would ever run - which would have made this half pass by destroying the projectile rather
        // than by refusing the hit. z 0.50 is legitimate flight for the low band and 0.50 m below
        // the player's feet.
        orbAt(cx + 1.05, 0.50);
        const hp0 = S1('{P.hp}');
        frames(2);
        const hp1 = S1('{P.hp}'), dd = S1('{Math.abs(P.x - ' + (cx + 1.05).toFixed(2) + ')}');
        S1(`{P.hp=100;return 0}`);
        orbAt(cx + 0.5, fl + 0.30);                                       // same band as the player
        const k0 = S1('{P.hp}');
        frames(2);
        const k1 = S1('{P.hp}');
        const ddWarn = dd < 0.45 ? '' : ' - OUTSIDE the 0.45 proximity test, the row is not testing what it claims';
        vrow('an orb below a raised player is not hit from below',
          dd < 0.45 && hp1 === hp0 && k1 < k0,
          `player floor ${fl.toFixed(2)} at x ${(cx + 0.85).toFixed(2)}, orb z 0.50 in the low column at ` +
          `x ${(cx + 1.05).toFixed(2)}: dd ${dd.toFixed(2)}${ddWarn}, hp ${hp0.toFixed(0)} -> ${hp1.toFixed(0)}; ` +
          `same-band orb at z ${(fl + 0.3).toFixed(2)}: hp ${k0.toFixed(0)} -> ${k1.toFixed(0)}`);
        S1('{PROJ.length=0;return 0}'); vrestore();
      }
    }

    // V10 - an enemy's orb was spawned at a BODY-RELATIVE number read as an absolute altitude
    // (js/30_entities.js:448, z: e.scale * 0.62 = 0.632 for a grunt) while its FLOOR is the band (#98,
    // :556), so on any band at or above ~0.55 m the shot was born under the floor the shooter stands on
    // and popOrb ran in the frame it was pushed: the enemy fires, nothing travels, and every gate stays
    // green because V5 hands `updateProjectiles` an orb with a correct z and never reaches this site.
    // Measured on the deployed build before the fix (#116): flat, an orb in 3 of 4 frames at z 0.638;
    // shooter's cell raised, 0 of 4 frames, +12 PARTS and +1 LIGHT - the signature of a pop on frame 1.
    // Driven through the AI's own decision rather than by writing atkMode, so the row dies if the
    // decision changes. Both directions are asserted: the flat control proves the lane CAN spawn an orb
    // (else "no orb on the band" would be satisfied by a broken lane), and the band half bounds z from
    // BELOW and ABOVE, so a shot fired at the ceiling fails as loudly as one fired at the feet. The
    // shelf is +0.75 rather than +1.0 because a 1.0 lip beside a 1.0-tall room has ceiling plane 1.0 and
    // floor 1.0 - a face of span 0, which is a grid fault that would blame the renderer (#100).
    vboot();
    {
      const ln = vlane(7);
      if (!vsetup('ranged shot setup found a 7 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const ex = ln[0] + 5, ey = ln[1];
        const fire = () => {
          S1(`{PROJ.length=0;LIGHTS.length=0;ENEMIES.length=0;
              const e=makeEnemy('grunt',${ex}+0.5,${ey}+0.5);e.state='chase';e.alert=true;e.cd=0;
              ENEMIES.push(e);P.x=${ln[0]}+0.5;P.y=${ey}+0.5;P.z=floorAt(P.x,P.y);P.air=false;
              P.hp=100;P.deadT=0;P.crouch=0;return 0}`);
          const sc = S1('{ENEMIES[0].scale}');
          let framesWith = 0, first = null;
          for (let i = 0; i < 90; i++) {
            frames(1);
            if (S1('{PROJ.length}')) { framesWith++; if (first === null) first = S1('{PROJ[0].z}'); }
          }
          const lights = S1('{LIGHTS.length}');
          S1('{PROJ.length=0;LIGHTS.length=0;return 0}');
          return { framesWith, first, lights, sc };
        };
        const flat = fire();
        for (let k = 0; k < 3; k++) vpoke(ex + k, ey, 3);      // a +0.75 m shelf under the shooter
        const fl = S1(`{floorAt(${ex}+0.5,${ey}+0.5)}`);
        const up = fire();
        const want = `(${(fl + 0.4).toFixed(2)}, ${(fl + up.sc).toFixed(2)})`;
        // "no orb on the band" has three causes and the detail must not blame the wrong one: the defect
        // this row exists for, a lane that cannot spawn an orb at all, and a lane that cannot fire.
        const bandZ = flat.first === null ? 'NOT REACHED - the lane spawned no orb on flat ground either'
          : up.first === null ? 'NONE - fired and popped in the frame it was spawned' : up.first.toFixed(3);
        vrow('an enemy on a band fires from its chest, not the datum',
          flat.first !== null && flat.framesWith > 2 && Math.abs(flat.first - 0.632) < 0.05 &&
          up.first !== null && up.framesWith > 2 && up.first > fl + 0.4 && up.first < fl + up.sc,
          `flat: ${flat.framesWith} frame(s) carrying an orb, first z ` +
          `${flat.first === null ? 'NONE' : flat.first.toFixed(3)} (want 0.632, parity) | band floor ` +
          `${fl.toFixed(2)}: ${up.framesWith} frame(s), first z ` +
          `${bandZ}` +
          `, want ${want} = above the feet, below the crown; orb pops lit ${up.lights}`);
        vrestore();
      }
    }

    // V11 - enemy sight was a 2D march over isSolid only (#118): a raised band is not solid, so an enemy
    // saw - and shot - straight through a slab of floor whose riser the wall pass paints and whose
    // boundary byte refuses to let it walk through. Measured on the deployed build before the fix: los()
    // true across a +1.0 m plateau in the middle of a 9 m run, floorAt at the midpoint 1.0, isSolid false.
    // The shelf goes BETWEEN the two bodies with both of them on the flat band, because that is the case
    // the old ray got wrong in both directions at once: player-on-the-shelf is genuinely visible over a
    // 0.75 m lip, and asserting THAT would have been a row about geometry rather than about the ray.
    // Both halves gate: the shelf must cost sight (the fix), and the same 9 m of flat floor must NOT
    // (else "this enemy never sees anyone" would satisfy the row - the failure V6 and V10 dodge the
    // same way). P.hp is in the detail because an alert enemy that cannot see still cannot hurt anyone,
    // and a row that only reads `alert` would pass on a lane where the shooting broke. Two terms came in
    // after #119 merged, because a parallel implementation of the same fix (pushed to
    // fix/sight-altitude-window-alt, since deleted) asserted both and this row did not. ALERT is counted
    // per FRAME rather than read at the end: on current main the two are equivalent, because updateEnemies
    // keeps alert STICKY (`if (see) e.alert = true`, cleared at js/30_entities.js:444 only past
    // sight*1.6, which an 8 m enemy never reaches), so one frame of sight already shows in the final flag -
    // no control can separate them today, and the count is here for the day that stickiness goes away,
    // when the final flag alone would start passing a sight that opens for a frame at a time. The other
    // term is load-bearing now: the slab's ability to STOP the enemy is read from canEnter, because a
    // riser that paints without setting VB_BLOCK (#100's invariant) would otherwise leave this row
    // asserting only that the sight ray was blind, in a game where the enemy can walk onto the plateau and
    // see from its far side.
    vboot();
    {
      const ln = vlane(9);
      if (!vsetup('sight setup found a 9 m clear run', !!ln, 'no clear corridor on this seed')) { }
      else {
        const ey = ln[1], ax = ln[0] + 0.5, bx = ln[0] + 8.5;
        const drive = () => {
          S1(`{ENEMIES.length=0;PROJ.length=0;PARTS.length=0;
              const e=makeEnemy('grunt',${ax},${ey}+0.5);e.state='idle';e.alert=false;e.cd=0;
              ENEMIES.push(e);P.x=${bx};P.y=${ey}+0.5;P.z=floorAt(P.x,P.y);P.air=false;
              P.hp=100;P.deadT=0;P.crouch=0;return 0}`);
          let shotFrames = 0, alertFrames = 0;
          for (let i = 0; i < 90; i++) {
            frames(1);
            const f = S1('{return [(PROJ.length?1:0),(ENEMIES.length&&ENEMIES[0].alert?1:0)]}');
            shotFrames += f[0]; alertFrames += f[1];
          }
          const r = S1('{return [ENEMIES[0].alert?1:0, ENEMIES[0].state, +P.hp.toFixed(1)]}');
          S1('{PROJ.length=0;ENEMIES.length=0;return 0}');
          return { shotFrames, alertFrames, alert: r[0], state: r[1], hp: r[2] };
        };
        const open = drive();                                    // 9 m of flat floor: it must see
        for (let k = 3; k <= 5; k++) vpoke(ln[0] + k, ey, 3);      // a +0.75 m plateau between them
        // The near edge of the plateau, read as the player would cross it: if that crossing is allowed,
        // the slab is a painting and not a barrier, and what this row is asserting about sight is a
        // different game from the one the plateau is in.
        const bar = S1(`{return [canEnter(${ln[0]}+2.5,${ey}+0.5,${ln[0]}+3.5,${ey}+0.5)?1:0, ` +
          `vbAt(${ln[0]}+2.5,${ey}+0.5,0)&VB_BLOCK?1:0]}`);
        const shelf = drive();
        const floorMid = S1(`{floorAt(${ln[0]}+4.5,${ey}+0.5)}`);
        vrow('a floor above the sight line costs an enemy its sight',
          open.alertFrames > 0 && open.shotFrames > 0 && shelf.alertFrames === 0 && shelf.shotFrames === 0 &&
          shelf.hp === 100 && bar[0] === 0,
          `flat run: alert on ${open.alertFrames}/90 frame(s), ${open.shotFrames} frame(s) carrying the enemy's `
          + `orb, hp ${open.hp} | plateau floor ${floorMid.toFixed(2)} between them: alert on `
          + `${shelf.alertFrames}/90 frame(s), ${shelf.shotFrames} frame(s), hp ${shelf.hp}; crossing the near `
          + `edge ${bar[0] ? 'ALLOWED' : 'refused'} (VB_BLOCK ${bar[1]})`
          + (bar[0] ? ' - NOT A BARRIER: the slab walks through, so sight here is not the same claim'
            : shelf.alertFrames === 0 && open.alertFrames === 0 ? ' - VACUOUS: the enemy sees nobody on flat ground either' : ''));
        vrestore();
      }
    }

    // V12 - a bullet hole wrote its altitude FACE-RELATIVELY while the renderer solved it as an absolute
    // world height (#120), and the write was gated on the flat world's window (h.z < 0.96). Measured on the
    // deployed build before the fix, one shooter, one wall 3.5 m away, level pitch: on the datum it left one
    // mark at z 0.500 (top +0.649 above that floor); with the same room raised +1.0 m it left ZERO - the
    // sparks flew at the true 2.500 and the hole simply was not punched, because eyeH 2.5 failed a window
    // written when every face spanned 0..1. Both directions gate: the raised band must leave a mark (the
    // defect), and the same shot on the datum must leave exactly one at the altitude it used to (so a
    // "punch a mark unconditionally" fix cannot satisfy the row). The shot is a click through tryFire, not
    // a call to addWallMark, so the row dies if the branch moves or the window comes back.
    vboot();
    {
      // The generator's walls are the one-cell perimeter ring on this seed (measured: 0 interior faces, 24
      // border ones, and 100 solid cells = 26*4-4), so the face being shot is the east wall of the arena.
      // x stops at MAP.w-2 so the wall cell itself is in bounds: floorAt/ceilAt answer 0 and 1 off-map, which
      // is right for a face the map never describes, and wrong to lean on here.
      const cands = S1(`{const a=[];for(let y=1;y<MAP.h-1;y++)for(let x=1;x<MAP.w-1;x++)
        if(!isSolid(x+0.5,y+0.5)&&isSolid(x+1.5,y+0.5))a.push(x+0.5,y+0.5);return a}`);
      const spot = cands.length ? [cands[0], cands[1]] : null;
      if (!vsetup('mark setup found a wall face to shoot', !!spot,
        `${cands.length} open cell(s) with a solid cell east of it`)) { }
      else {
        const cx = spot[0], cy = spot[1];
        const fire = () => {
          S1(`{DECALS.length=0;PARTS.length=0;ENEMIES.length=0;PROJ.length=0;
              P.x=${cx};P.y=${cy};P.z=floorAt(P.x,P.y);P.air=false;P.vx=P.vy=P.vz=0;P.ang=0;P.pitch=0;
              P.crouch=0;P.deadT=0;P.hp=100;P.fireT=0;P.reloadT=0;P.swapT=0;P.mag[0]=8;P.shots=0;
              switchWeapon(0);P.swapT=0;return 0}`);
          const hz = +S1(`{return +hitscan(0,0,46).z.toFixed(3)}`);
          V('mouse.down=true'); frames(1); V('mouse.down=false'); frames(1);
          const d = S1(`{return [DECALS.length, DECALS.length?+DECALS[0].z.toFixed(3):null,
              +floorAt(P.x,P.y).toFixed(3), +eyeH().toFixed(3), P.shots]}`);
          return { hz, n: d[0], z: d[1], floor: d[2], eye: d[3], shots: d[4] };
        };
        const flat = fire();
        vpoke(cx | 0, cy | 0, 3);                                 // the shooter's own cell +0.75 m
        const band = fire();
        const zTop = +S1(`{return +MAP.ceilPlane[(P.y|0)*MW+(P.x|0)].toFixed(3)}`);
        vrow('a bullet hole sits where the bullet hit it',
          flat.shots === 1 && flat.n === 1 && Math.abs(flat.z - flat.hz) <= 0.35 &&
          band.shots === 1 && band.n === 1 && Math.abs(band.z - band.hz) <= 0.35 &&
          band.z > band.floor + 0.2 && band.z < zTop,
          `flat: ${flat.n} mark(s) at z ${flat.z} for a hit at ${flat.hz} (floor ${flat.floor}, eye ` +
          `${flat.eye}, ${flat.shots} shot) | shooter's cell +0.75: floor ${band.floor}, face tops out at ` +
          `${zTop}: ${band.n} mark(s) at z ${band.z} for a hit at ${band.hz}, want above ` +
          `${(band.floor + 0.2).toFixed(2)} and below ${zTop}`
          + (flat.n === 0 ? ' - VACUOUS: the same shot leaves no mark on flat ground either' : ''));
        vrestore();
      }
    }

    // V13 - a shot's ray had NO altitude test of any kind (#125): walls came out of castRayDist, which is a 2D
    // march, so a ray pitched above its own ceiling kept travelling to the wall behind it and punched a hole
    // along that face's TOP EDGE. Measured on the deployed build, one shooter, one face: a ray reaching z 2.50
    // answered `wall true` at the face's own distance and stored one mark at z 0.856 = face top minus the decal
    // inset - a bullet hole along the top of a wall the bullet flew over. Note the planes are re-keyed per
    // SAMPLED cell, so this does NOT stop the legitimate upward shot at an enemy standing on a raised band
    // (view.js sight aims that shot, and stays green). Both directions gate: pitched past the ceiling the shot
    // must stop short of the face (no wall, t well under the face's distance, and the CLICK leaves no mark),
    // while the same gun level must still hit that face and mark it - so "stop every shot" and "never leave a
    // mark" both fail. The pitched sample uses tanP 1.2 rather than the minimum crossing slope because P.pitch
    // lerps back toward the aim pitch inside the tick that fires it: a barely-crossing pitch decays into a
    // legal wall hit and the row would report a defect that is only the decay (measured: tanP 0.4 requested,
    // z 0.692 at the wall = tanP ~0.05 fired).
    vboot();
    {
      const cands = S1(`{const a=[];for(let y=1;y<MAP.h-1;y++)for(let x=1;x<MAP.w-8;x++){
        if(isSolid(x+0.5,y+0.5)||isSolid(x+1.5,y+0.5))continue;
        const r=castRayDist(x+0.5,y+0.5,1,0,12);if(r.wall&&r.dist>2)a.push([x+0.5,y+0.5,+r.dist.toFixed(3)]);}
        return a.length?a.sort((p,q)=>q[2]-p[2])[0]:[]}`);
      const spot = cands && cands.length === 3 ? cands : null;
      if (!vsetup('shot setup found a long run to a wall face', !!spot,
        spot ? `longest east run ${spot[2]} m from (${spot[0]}, ${spot[1]})` : 'no open cell with a wall to the east')) { }
      else {
        const cx = spot[0], cy = spot[1];
        const fire = (tp, dy) => {
          S1(`{DECALS.length=0;PARTS.length=0;ENEMIES.length=0;PROJ.length=0;
              P.x=${cx};P.y=${cy};P.z=floorAt(P.x,P.y);P.air=false;P.vx=P.vy=P.vz=0;P.ang=0;P.pitch=0;
              P.crouch=0;P.deadT=0;P.hp=100;P.fireT=0;P.reloadT=0;P.swapT=0;P.mag[0]=8;P.shots=0;
              switchWeapon(0);P.swapT=0;return 0}`);
          const r = S1(`{const h=hitscan(0,${tp},46);return [+h.t.toFixed(3),h.wall?1:0,h.band?1:0,
              +h.z.toFixed(3),+ceilAt(P.x,P.y).toFixed(3),+eyeH().toFixed(3)]}`);
          // The pitch is aimed through the mouse-look delta, not by writing P.pitch: the look step owns that
          // field and rewrites it inside the tick that fires, so an assignment fires a LEVEL shot (measured:
          // P.pitch 0.880 requested, pitchTan 0.02 fired).
          V(`mouse.dy=${dy};mouse.down=true`); frames(1); V('mouse.down=false'); frames(1);
          const d = S1(`{return [DECALS.length,P.shots,+pitchTan().toFixed(3),+P.pitch.toFixed(3)]}`);
          return { t: r[0], wall: r[1], band: r[2], z: r[3], ceil: r[4], eye: r[5], n: d[0], shots: d[1], tp: d[2], pitch: d[3] };
        };
        const lvl = fire(0, 0), up = fire(1.2, -420);
        const okLvl = lvl.wall === 1 && lvl.n === 1 && lvl.shots === 1;
        const okUp = up.wall === 0 && up.band === 1 && up.t < lvl.t - 0.2 && up.n === 0 && up.shots === 1;
        vrow('a shot stops at the ceiling it is aimed at, not at the wall behind it', okLvl && okUp,
          `level: ${lvl.wall ? 'wall' : 'NO WALL'} at t ${lvl.t}, ${lvl.n} mark(s) over ${lvl.shots} shot ` +
          `(ceiling plane ${lvl.ceil}, eye ${lvl.eye}) | aimed up one click (look delta -420, ` +
          `pitchTan ${up.tp} at the trigger; a ray at tanP 1.20 would cross ${lvl.ceil} at t ` +
          `${((lvl.ceil - lvl.eye) / 1.2).toFixed(2)}); ${up.wall ? 'WALL' : 'no wall'} ` +
          `at t ${up.t}, band stop ${up.band}, z ${up.z}, ${up.n} mark(s) over ${up.shots} shot - want no wall, ` +
          `t < ${(lvl.t - 0.2).toFixed(2)}, 0 marks`
          + (lvl.wall === 0 || lvl.n === 0
            ? ' - VACUOUS: the level shot does not hit a wall either, so nothing here is being stopped' : ''));
      }
    }

    // V14 - the other way a shot leaves its band: stepping into a cell whose FLOOR is above the ray (#128). That
    // boundary is a drawn face - a riser - so the answer is a WALL HIT on it, with the mark on the riser rather
    // than on whatever stands behind the drop. Measured before the fix: a level shot at a step-up band reported
    // the far wall's face and marked THAT face, i.e. a bullet hole in a wall 4 m beyond the wall the bullet hit.
    // Both directions gate: low, the shot must stop on the boundary plane (t, side, and the mark's own x prove
    // which face took it); high, through the opening above the step, it must fly past the riser and die on its
    // own ceiling instead - so "stop whenever the floors differ" fails the second half, and "no floor test at
    // all" fails the first. The opening here is [max floor, min ceiling] = [0.75, 1.00], 25 cm of it.
    vboot();
    {
      const cands = S1(`{const a=[];for(let y=2;y<MAP.h-2;y++)for(let x=2;x<MAP.w-9;x++){
        let n=0;for(let k=0;k<8;k++)if(!isSolid(x+k,y+0.5))n++;
        if(n===8&&floorAt(x+0.5,y+0.5)===0)a.push([x+0.5,y+0.5]);}
        return a.length?a[0]:[]}`);
      const spot = cands && cands.length === 2 ? cands : null;
      if (!vsetup('riser setup found a flat 8-cell lane at floor 0', !!spot,
        spot ? `lane from (${spot[0]}, ${spot[1]})` : 'no flat lane to build a step into')) { }
      else {
        const px = spot[0], py = spot[1];
        S1(`{for(let k=2;k<=4;k++)MAP.fz[(${py|0})*MAP.w+((${px|0})+k)]+=3;linkBoundaries();
            return +floorAt(${px+2.5},${py}).toFixed(3)}`);
        const raised = +S1(`+floorAt(${px + 2.5},${py}).toFixed(3)`).toFixed(3);
        const open = +S1(`Math.min(ceilAt(${(px | 0) + 1}+0.5,${py}),ceilAt(${(px | 0) + 2}+0.5,${py}))`).toFixed(3);
        const fire = (tp, dy) => {
          S1(`{DECALS.length=0;PARTS.length=0;ENEMIES.length=0;PROJ.length=0;
              P.x=${px};P.y=${py};P.z=floorAt(P.x,P.y);P.air=false;P.vx=P.vy=P.vz=0;P.ang=0;P.pitch=0;
              P.crouch=0;P.deadT=0;P.hp=100;P.fireT=0;P.reloadT=0;P.swapT=0;P.mag[0]=8;P.shots=0;
              switchWeapon(0);P.swapT=0;return 0}`);
          const r = S1(`{const h=hitscan(0,${tp},46);return [+h.t.toFixed(3),h.wall?1:0,h.band?1:0,h.side,
              +h.z.toFixed(3),DECALS.length]}`);
          V(`mouse.dy=${dy};mouse.down=true`); frames(1); V('mouse.down=false'); frames(1);
          const d = S1(`{return [DECALS.length,DECALS.length?+DECALS[0].x.toFixed(3):-1,
              DECALS.length?+DECALS[0].z.toFixed(3):-1,P.shots,+pitchTan().toFixed(3)]}`);
          return { t: r[0], wall: r[1], band: r[2], side: r[3], z: r[4], n: d[0], mx: d[1], mz: d[2], shots: d[3], tp: d[4] };
        };
        // t is a DISTANCE and the plane is a COORDINATE: conflating them is how this row first failed on a
        // correct answer (t 1.5 vs x 4.0, 2.5 m apart because the shooter stands mid-cell).
        const plane = (px | 0) + 2, bndT = plane - px;
        const lo = fire(0, 0), hi = fire(0.25, -160);
        const okLo = lo.wall === 1 && Math.abs(lo.t - bndT) < 0.02 && lo.side === 0 && lo.n === 1 &&
          Math.abs(lo.mx - plane) < 0.02 && lo.mz >= raised;
        const okHi = hi.wall === 0 && hi.band === 1 && hi.t > bndT + 0.3 && hi.n === 0 && hi.shots === 1;
        vrow('a shot at a step-up band hits the riser, not the wall behind the drop', okLo && okHi,
          `step up ${raised} across the plane x ${plane.toFixed(1)} = t ${bndT.toFixed(2)} from the shot line ` +
          `(opening ${raised}..${open}, eye ${S1('+eyeH().toFixed(2)')}) | low (tanP 0): ` +
          `${lo.wall ? 'wall' : 'NO WALL'} at t ${lo.t} side ${lo.side}, ${lo.n} mark(s) at x ${lo.mx} z ` +
          `${lo.mz} over ${lo.shots} shot - want wall at t ${bndT.toFixed(2)}, one mark ON that plane ` +
          `(x ${plane.toFixed(1)}, z >= ${raised}) | pitched through the opening (tanP 0.25 asked, ` +
          `${hi.tp} at the trigger; ceiling would be reached at t ${((1 - 0.5) / 0.25).toFixed(2)}): ` +
          `${hi.wall ? 'WALL' : 'no wall'} at t ${hi.t} band ${hi.band}, ${hi.n} mark(s) - want no wall past t ` +
          `${(bndT + 0.3).toFixed(2)}, 0 marks`
          + (raised <= 0 ? ' - VACUOUS: the step is not raised, nothing here is a riser' : ''));
      }
    }

    // V15 - a shot aimed into the ground it is standing on (#131). Hitscan tested enemies, props and (since
    // #125/#128) the band a shot travels through, but it modelled NO ground at all, so a descending ray crossed
    // the plane under the shooter's feet and kept flying - to mark the wall 20 m away with a hole in mid-air.
    // Two halves in opposite directions, same arithmetic: on a flat lane the ray must cross its OWN floor plane
    // and stop there, leaving a splat in the cell it landed in; down a staircase it must keep descending into the
    // band below, because the plane is re-keyed per cell. So "stop whenever the ray descends" fails the second
    // half and "model no ground" fails the first. The staircase is not decoration: from an eye at 0.50 a line to
    // a chest 1.00 below at 4.00 out crosses the shooter's own floor 1.87 m ahead, INSIDE the shooter's cell, so
    // a 1-unit drop has no legal shot into it at all - which is what the first half asserts.
    vboot();
    {
      const cands = S1(`{const a=[];for(let y=2;y<MAP.h-2;y++)for(let x=2;x<MAP.w-9;x++){
        let n=0;for(let k=0;k<8;k++)if(!isSolid(x+k,y+0.5))n++;
        if(n===8&&floorAt(x+0.5,y+0.5)===0)a.push([x+0.5,y+0.5]);}
        return a.length?a[0]:[]}`);
      const spot = cands && cands.length === 2 ? cands : null;
      if (!vsetup('V15 setup found a flat 8-cell lane at floor 0', !!spot,
        spot ? `lane from (${spot[0]}, ${spot[1]})` : 'no flat lane to aim down along')) { }
      else {
        const px = spot[0], py = spot[1];
        const shot = (poke, dy) => {
          if (poke) S1(`{${poke}linkBoundaries();return 1}`);
          S1(`{DECALS.length=0;PARTS.length=0;ENEMIES.length=0;PROJ.length=0;
              P.x=${px};P.y=${py};P.z=floorAt(P.x,P.y);P.air=false;P.vx=P.vy=P.vz=0;P.ang=0;P.pitch=0;
              P.crouch=0;P.deadT=0;P.hp=100;P.fireT=0;P.reloadT=0;P.swapT=0;P.mag[0]=8;P.shots=0;
              switchWeapon(0);P.swapT=0;return 1}`);
          V(`mouse.dy=${dy};mouse.down=true`); frames(1); V('mouse.down=false'); frames(1);
          const tp = +S1('+pitchTan().toFixed(3)');
          const r = S1(`{const h=hitscan(0,${tp},46);const d=DECALS.length?DECALS[DECALS.length-1]:null;
            return [+h.t.toFixed(3),h.wall?1:0,h.band?1:0,h.floor?1:0,+h.z.toFixed(3),DECALS.length,
              d?+d.x.toFixed(3):-1,d?+d.z.toFixed(3):-1,+floorAt(d?d.x:${px},d?d.y:${py}).toFixed(3),P.shots,
              [1,2,3,4].map(k=>+floorAt(${px}+k,${py}).toFixed(2)).join(' ')]}`);
          return { t: r[0], wall: r[1], band: r[2], floor: r[3], z: r[4], n: r[5], mx: r[6], mz: r[7],
            mfz: r[8], shots: r[9], fzs: r[10], tp, eye: +S1('+eyeH().toFixed(3)') };
        };
        const flat = shot('', 136);
        const stair = shot(`for(let k=1;k<=4;k++)MAP.fz[${py | 0} * MAP.w + (${px | 0} + k)] -= k;`, 113);
        const restore = S1(`{for(let k=1;k<=4;k++)MAP.fz[${py | 0} * MAP.w + (${px | 0} + k)] += k;
          linkBoundaries();return +floorAt(${px + 2.5},${py}).toFixed(3)}`);
        // the expectation is computed from what the frame measured, not from a literal: eye and the slope the
        // look step actually produced, so a sensitivity change moves the want, not the verdict
        const tWant = (0 - flat.eye) / flat.tp;
        const okFlat = flat.floor === 1 && flat.wall === 0 && flat.band === 0 && flat.shots === 1 &&
          Math.abs(flat.t - tWant) < 0.06 && flat.n === 1 && Math.abs(flat.mz - (flat.mfz + 0.01)) < 0.03;
        // The staircase half cannot ask for wall === 0: the stairs run into a 1-unit RISE at their far end (the
        // poke stops at k=4), which is a face, so the honest claim is that the shot is not stopped at the plane
        // it stood on - it gets well past where the flat lane killed it - and the wall it finally meets is the
        // far end, not the shooter's feet. Control B (fl never re-keyed) dies here at the flat lane's own t.
        const okStair = stair.floor === 0 && stair.shots === 1 && stair.t > flat.t + 1.0;
        vrow('a shot aimed into the ground stops at the floor plane it crosses, and a staircase lets it through',
          okFlat && okStair,
          `flat lane: eye ${flat.eye} at (${px}, ${py}), tanP ${flat.tp} -> own floor plane (0.00) reached at t ` +
          `${tWant.toFixed(2)} | got ${flat.floor ? 'FLOOR' : 'no floor'} at t ${flat.t}${flat.wall ? ', WALL' : ''}` +
          ` band ${flat.band}, ${flat.n} splat(s) at x ${flat.mx} z ${flat.mz} in a cell whose floor is ` +
          `${flat.mfz} over ${flat.shots} shot - want a floor hit at t ${tWant.toFixed(2)} and one ground splat ` +
          `on that cell's plane, no wall mark anywhere | stairs (one quantum per cell: ${stair.fzs}), ` +
          `tanP ${stair.tp}: ${stair.floor ? 'STOPPED at its FIRST floor plane' : 'keeps descending'} at t ` +
          `${stair.t}${stair.wall ? ', meets the wall at the far end of the stairs' : ''} - want no floor stop and ` +
          `t past ${(flat.t + 1).toFixed(2)}, because the plane is re-keyed per cell and the stairs descend as ` +
          `fast as the ray does` +
          (Math.abs(flat.tp) < 0.05 ? ' - VACUOUS: the shot is not aimed down, nothing crosses a floor plane' : '') +
          (restore !== 0 ? ` - VACUOUS: the lane did not restore to floor 0 (reads ${restore})` : ''));
      }
    }

    // V16 and V17 gate the two rules that were FIXED and never ASSERTED: the exit changes level by a test
    // that includes a band (#105: an xy-only test let the level change from a cell whose floor was a unit
    // below), and a pickup has a 0.6 m vertical window (#109: xy proximity took it while the player hovered
    // above it). Risk #3 in AGENTS.md names this gap - nearly every other assert compares x and y. Both rows
    // are SELF-CONTROLLED: the same pose minus the altitude poke must give the opposite answer, so deleting
    // the band test turns the row red instead of quietly passing, the failure mode this lane keeps hitting.
    for (let li = 0; li < 3; li++) {                                // three levels, as at :139
      V('startLevel(' + li + ', true); S.mode = "playing";');
      // Every other row in this lane is a pure eval and the lane never advances a frame, so these two rows
      // call update() themselves at a fixed dt: DEV is not loaded in this harness and frames() left the
      // world un-advanced, which is how both controls first answered "nothing happened".
      const step = n => V('{ for (let i = 0; i < ' + n + '; i++) update(0.016); }');
      const pair = S1(`{
        for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 2; x++) {
          if (isSolid(x + 0.5, y + 0.5) || isSolid(x + 1.5, y + 0.5) || isSolid(x + 2.5, y + 0.5)) continue;
          if (MAP.fz[y * MW + x] !== MAP.fz[y * MW + x + 1]) continue;
          if (MAP.fz[y * MW + x] !== MAP.fz[y * MW + x + 2]) continue;
          return { x: x, y: y };
        }
        return null;
      }`);
      if (vsetup('V16 setup found three open cells side by side at one floor', !!pair,
        'no such triple on level ' + li + ' - the row cannot run')) {
        const ex = pair.x + 1.9, ey = pair.y + 0.5, px = pair.x + 2.3;
        const lv0 = S1('S.level');
        // the exit parked 0.1 m inside the boundary so a point one cell over is still inside its 0.74 m
        // radius; exitX/exitY are generator state and this pose is probe-only - the row gates the band rule,
        // not where the generator puts portals
        const pose = () => V('{ for (const e of ENEMIES) e.hp = 0; S.exitOpen = true; exitX = ' + ex +
          '; exitY = ' + ey + '; P.x = ' + px + '; P.y = ' + ey + '; P.z = floorAt(P.x, P.y); }');
        pose();
        vpoke(pair.x + 2, pair.y, 1);                                    // the cell under the player +0.25 m
        V('P.z = floorAt(P.x, P.y)');
        // the pose's own geometry is read BEFORE it is allowed to do anything: with the band term missing the
        // raised pose changes level, which reloads the level and moves the exit 30 m away, so a detail line
        // measured afterwards describes the aftermath rather than the pose
        const rFloor = +S1('floorAt(P.x, P.y)'), xFloor = +S1('floorAt(exitX, exitY)');
        const dmin = +S1('Math.sqrt(dist2(P.x, P.y, exitX, exitY))');
        step(20);
        const raised = S1('{ return S.level }'), raisedWin = S1('{ return S.mode === "win" }');
        vrestore(); pose(); V('P.z = floorAt(P.x, P.y)');                  // same pose, both floors flat
        const gate = S1('{ return { mode: S.mode, locked: !!S.locked, open: !!S.exitOpen, hp: Math.round(P.hp),'
          + ' band: floorAt(P.x, P.y) === floorAt(exitX, exitY), near: dist2(P.x, P.y, exitX, exitY) < 0.55 } }');
        step(20);
        // "advanced" is not always a level number: on the last level nextLevel() ends the run instead of
        // incrementing S.level, and #105's band test is the same line of code either way
        const flat = S1('{ return S.level }'), flatWin = S1('{ return S.mode === "win" }');
        const advRaised = raised !== lv0 || raisedWin, advFlat = flat !== lv0 || flatWin;
        vrow('L' + li + ' the exit needs its own band, not just its column (#105)',
          !advRaised && advFlat,
          dmin.toFixed(2) + ' m from the portal (radius 0.74) on floor ' + rFloor.toFixed(2) + ' while its'
          + ' floor is ' + xFloor.toFixed(2) + ': ' + (advRaised ? 'CHANGES LEVEL - the band test is gone'
          : 'level stays put (want stays)') + '; same pose with both floors flat: ' + (advFlat
            ? 'advances (want advances)'
            : 'DOES NOT advance, so the band test is not what stops the raised case either and this row'
            + ' proves nothing') + ' | gate terms: mode ' + gate.mode + ', locked ' + gate.locked + ', open '
          + gate.open + ', hp ' + gate.hp + ', same band ' + gate.band + ', within radius ' + gate.near
          + (flatWin ? ' | advancing here ends the run rather than moving level (last level)' : ''));
      V('startLevel(' + li + ', true); S.mode = "playing";');
      }

      const pk = S1('PICKUPS.length ? { x: PICKUPS[0].x, y: PICKUPS[0].y } : null');
      if (vsetup('V17 setup found a pickup to stand on', !!pk, 'level ' + li + ' generated none')) {
        V('window.__pkCopy = Object.assign({}, PICKUPS[0]); PICKUPS[0] && (window.__pkCopy.x = ' + pk.x +
          ', window.__pkCopy.y = ' + pk.y + ');');
        const hover = (dz, ticks) => {
          // takePickup marks k.dead rather than splicing, and REFUSES a pickup the player cannot use (health
          // at hp 100 sets dead back to false and returns), so the pose has to want the item: hurt, stripped
          // armour, empty reserves. Counting PICKUPS.length instead made this row fail on a build that was
          // behaving correctly, which is the VACUOUS shape in the other direction.
          V('{ PICKUPS.length = 0; const k = Object.assign({}, window.__pkCopy); k.dead = false;'
            + ' PICKUPS.push(k); P.x = ' + pk.x + '; P.y = ' + pk.y + '; P.hp = 50; P.armor = 0;'
            + ' for (let i = 0; i < P.reserve.length; i++) P.reserve[i] = 0;'
            + ' P.z = floorAt(P.x, P.y) + ' + dz + '; }');
          step(ticks);
          return S1('{ return PICKUPS.filter(k => !k.dead).length }');
        };
        const lo = hover(0.0, 6), mid = hover(0.5, 6), out = hover(0.9, 6);
        vrow('L' + li + ' a pickup is taken from the hover window and not from above it (#109)',
          lo === 0 && mid === 0 && out === 1,
          'on its floor ' + lo + ' left (want 0) | hovering 0.50 m over it ' + mid + ' left (want 0 - a jump'
          + ' peaks at 0.489 m so grabbing mid-air must keep working) | 0.90 m over it ' + out + ' left'
          + ' (want 1)' + (lo ? ' - VACUOUS: not even standing on it takes it' : ''));
        V('P.z = floorAt(P.x, P.y);');
      }
    }

    console.log('VERT lane: ' + vgate + ' gating row(s), ' + vknown + ' known-issue row(s)' +
      (vknown ? ' - STRICT=1 promotes them' : ''));
  }

  const rep = vm.runInContext(`({mode:S.mode,level:S.level,kills:P.kills,shots:P.shots,hp:Math.round(P.hp),
    parts:PARTS.length,proj:PROJ.length,enemies:ENEMIES.length,left:enemiesLeft(),fps:S.fps,
    mapOk:(MAP.w===MW&&MAP.cell.length===MW*MH)})`, ctxVm);
  console.log('report', rep);
  console.log(`${failed} assertion(s) failed`);
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
})();
