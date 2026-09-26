/* Headless viewer: boots the game like smoke.js and writes PNGs so the procedural
   assets and the raycaster output can actually be looked at without a browser.

   node tools/view.js sheets            -> /tmp/fps_tex.png  (materials + sprites)
   node tools/view.js scene [lvl] [n]   -> /tmp/fps_scene.png (framebuffer, sector lvl, camera n)
*/
const vm = require('vm'), fs = require('fs'), path = require('path');
const { writePNG, toRGBA } = require('./png');
const noop = () => {};
const W = 1280, H = 720;
const MODE = process.argv[2] || 'scene';
const ASCII = process.env.ASCII === '1' || process.env.ASCII === '';
const LVL = +(process.argv[3] || 0);
const CAM = +(process.argv[4] || 0);
const OUT = process.env.OUT || (MODE === 'sheets' ? '/tmp/fps_tex.png' : MODE === 'rig' ? '/tmp/fps_rig.png' : '/tmp/fps_scene.png');

/* Browsers reject malformed colour strings and non-finite gradient geometry by
 * throwing. The stub has to do the same or the overlay code, which builds colour
 * strings at runtime, passes headlessly and throws on the first real frame. */
function validColor(c, where) {
  if (typeof c !== 'string') return;                     // gradients, patterns
  const ok = /^#[0-9a-fA-F]{3,8}$/.test(c) ||
    /^rgba?\(\s*[-+\d.]+\s*,\s*[-+\d.]+\s*,\s*[-+\d.]+\s*(,\s*[-+\d.]+\s*)?\)$/.test(c) ||
    /^(white|black|transparent|none)$/.test(c);
  if (!ok) throw new TypeError('failed to set ' + where + ': invalid colour "' + c + '"');
}
function finiteArgs(a, where) {
  for (const v of a) if (typeof v === 'number' && !isFinite(v)) throw new TypeError('failed to ' + where + ': non-finite argument');
}
/* Canvas path recorder: tracks the CTM so overlay geometry can be measured in
   device pixels. This is the only way to check the HUD and viewmodel headlessly,
   since nothing drawn with canvas paths can be read back as pixels. */
const VR = { on: false, pts: [], fills: 0, depth: 0, badDepth: 0, nan: 0, m: [1, 0, 0, 1, 0, 0], stack: [] };
const vmul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function vrec(x, y) {
  if (!VR.on) return;
  const m = VR.m, X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
  if (!isFinite(X) || !isFinite(Y)) { VR.nan++; return; }
  VR.pts.push(X, Y);
}
function vhook(k, args) {
  if (!VR.on) return;
  const m = VR.m;
  if (k === 'save') { VR.stack.push(m.slice()); VR.depth++; if (VR.depth > VR.maxD) VR.maxD = VR.depth; }
  else if (k === 'restore') { VR.m = VR.stack.pop() || [1, 0, 0, 1, 0, 0]; VR.depth--; if (VR.depth < 0) VR.badDepth++; }
  else if (k === 'translate') { VR.m = vmul(m, [1, 0, 0, 1, args[0], args[1]]); }
  else if (k === 'scale') { VR.m = vmul(m, [args[0], 0, 0, args[1], 0, 0]); }
  else if (k === 'rotate') { const c = Math.cos(args[0]), s2 = Math.sin(args[0]); VR.m = vmul(m, [c, s2, -s2, c, 0, 0]); }
  else if (k === 'setTransform') { VR.m = args.slice(0, 6); }
  else if (k === 'moveTo' || k === 'lineTo') { vrec(args[0], args[1]); }
  else if (k === 'arcTo') { vrec(args[0], args[1]); vrec(args[2], args[3]); }
  else if (k === 'arc') { vrec(args[0] - args[2], args[1] - args[2]); vrec(args[0] + args[2], args[1] + args[2]); }
  else if (k === 'rect') { vrec(args[0], args[1]); vrec(args[0] + args[2], args[1] + args[3]); }
  else if (k === 'fillRect') { vrec(args[0], args[1]); vrec(args[0] + args[2], args[1] + args[3]); VR.fills++; }
  else if (k === 'fill' || k === 'stroke') { VR.fills++; }
}
function ctxStub() {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'getImageData') return () => { throw new Error('canvas getImageData is not available headless - assets must be painted by js/05_paint.js'); };
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'createLinearGradient' || k === 'createLinearGradientX') return (...a) => { finiteArgs(a, 'createLinearGradient'); return { addColorStop: (o, c) => { if (!isFinite(o) || o < 0 || o > 1) throw new TypeError('addColorStop: bad offset ' + o); validColor(c, 'addColorStop'); } }; };
      if (k === 'createRadialGradient') return (...a) => { finiteArgs(a, 'createRadialGradient'); return { addColorStop: (o, c) => { if (!isFinite(o) || o < 0 || o > 1) throw new TypeError('addColorStop: bad offset ' + o); validColor(c, 'addColorStop'); } }; };
      if (k === 'createPattern') return () => ({});
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'maxD') return VR.maxD || 0;
      return (...a) => { vhook(k, a); };
    },
    set(t, k, v) {
      if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') validColor(v, String(k));
      if ((k === 'lineWidth' || k === 'globalAlpha') && !(typeof v !== 'number' || isFinite(v))) throw new TypeError('failed to set ' + k + ': non-finite');
      if (k === 'globalAlpha' && typeof v === 'number' && (v < 0 || v > 1)) throw new TypeError('globalAlpha out of range: ' + v);
      t[k] = v; return true;
    }
  });
}
function canvasStub() {
  return { width: 300, height: 150, style: {}, getContext: () => ctxStub(), addEventListener: noop, requestPointerLock: () => undefined };
}
const elements = {};
function elStub(id) {
  const reg = {};
  const base = {
    id, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, textContent: '', onclick: null, style: {},
    addEventListener: (t, f) => { (reg[t] = reg[t] || []).push(f); }, __fire: (t, ev) => { for (const f of (reg[t] || [])) f(ev); }
  };
  if (id === 'screen') Object.assign(base, canvasStub());
  elements[id] = base;
  return base;
}
// Same defect smoke.js had: the generator draws from Math.random, so an unseeded probe renders
// a DIFFERENT LEVEL every run - which quietly invalidated before/after visual comparisons (two
// PNGs described as "same camera, one change" were different worlds). Object.assign cannot
// clone Math (its own properties are non-enumerable per spec); chain and shadow random.
const SEED = (Number(process.env.SEED) || 12345) >>> 0;
let rs = SEED;
const sbMath = Object.create(Math);
sbMath.random = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
const sandbox = {
  console, Math: sbMath, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, isFinite, parseInt, parseFloat,
  setTimeout, clearTimeout, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray,
  document: {
    getElementById: elStub, createElement: () => canvasStub(), addEventListener: noop,
    exitPointerLock: noop, pointerLockElement: null, hidden: false
  },
  addEventListener: noop, removeEventListener: noop, requestAnimationFrame: noop,
  devicePixelRatio: 1, innerWidth: W, innerHeight: H, AudioContext: undefined, webkitAudioContext: undefined,
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
// levels lay themselves out with Math.random, so measurements need a seeded one
function seedRng(seed) {
  run(`(()=>{let a=${seed | 0}>>>0;Math.random=()=>{a=(a+0x6D2B79F5)>>>0;` +
    `let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};})()`);
}
const ctxVm = vm.createContext(sandbox);
const run = code => vm.runInContext(code, ctxVm, { filename: 'view' });
for (const f of fs.readdirSync(path.join(__dirname, '..', 'js')).filter(f => f.endsWith('.js')).sort()) {
  try { run(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8')); }
  catch (e) { console.log('LOAD FAIL ' + f + ': ' + e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }
}
function newTex(t) { return { w: t.w, h: t.h, data: new Uint32Array(t.data), dbg: t.dbg }; }
function dump(label, u32, w, h, scale) {
  const rgba = toRGBA(u32);
  if (ASCII) { console.log(label + '\n' + ascii(u32, w, h)); return; }
  console.log(label + ' -> ' + writePNG(OUT, w, h, rgba, scale) + '  (' + OUT + ')');
}
const RAMP = ' .:-=+*#%@';
function ascii(u32, w, h) {
  const cols = 118, rows = Math.round(cols * h / w / 2.05);
  let out = '';
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const x0 = (x * w / cols) | 0, y0 = (y * h / rows) | 0, x1 = Math.max(x0 + 1, ((x + 1) * w / cols) | 0), y1 = Math.max(y0 + 1, ((y + 1) * h / rows) | 0);
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
        const c = u32[yy * w + xx];
        s += 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255); n++;
      }
      const L = n ? s / n : 0;
      line += RAMP[clamp((Math.pow(L / 255, 0.62) * (RAMP.length - 1)) | 0, 0, RAMP.length - 1)];
    }
    out += line + '\n';
  }
  return out;
}
function stats(label, u32, w, h) {
  let lum = 0, dark = 0, clip = 0, n = 0; const hist = new Array(8).fill(0);
  for (let i = 0; i < u32.length; i++) {
    const c = u32[i], L = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
    lum += L; n++; if (L < 6) dark++; if ((c & 255) > 253 && (c >> 8 & 255) > 253) clip++;
    hist[Math.min(7, (L / 32) | 0)]++;
  }
  console.log(`  ${label}: mean ${(lum / n).toFixed(1)}  black ${(100 * dark / n).toFixed(1)}%  blown ${(100 * clip / n).toFixed(2)}%  hist ${hist.map(v => (100 * v / n).toFixed(0)).join(',')}`);
}

const pad = (v, n) => (String(v).length >= n ? String(v) : String(v) + ' '.repeat(n - String(v).length));
function texAscii(tex, cols) {
  const rows = Math.max(6, Math.round(cols * tex.h / tex.w / 2));
  const RAMP = ' .:-=+*#%@';
  let out = '';
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const i = (((y + 0.5) * tex.h / rows) | 0) * tex.w + (((x + 0.5) * tex.w / cols) | 0);
      const c = tex.data[i];
      if ((c >>> 24) < 40) { line += ' '; continue; }
      const L = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
      line += RAMP[Math.max(0, Math.min(9, (Math.pow(L / 255, 0.6) * 9) | 0))];
    }
    out += line + '\n';
  }
  return out;
}
function texStats(label, tex) {
  const d = tex.data, n = d.length;
  let sum = 0, sum2 = 0, solid = 0, emis = 0, grad = 0, gn = 0, clip = 0;
  let lr = 0, lg = 0, lbb = 0;
  for (let i = 0; i < n; i++) {
    const c = d[i], a = c >>> 24, r = c & 255, g = c >> 8 & 255, b = c >> 16 & 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += L; sum2 += L * L; if (a > 8) solid++; if (a === 253) emis++;
    if (r > 252 && g > 252 && b > 252) clip++;
    lr += r; lg += g; lbb += b;
    if (a > 8) {
      const x = i % tex.w;
      if (x < tex.w - 1 && d[i + 1] >>> 24 > 8) { grad += Math.abs(L - (0.2126 * (d[i + 1] & 255) + 0.7152 * (d[i + 1] >> 8 & 255) + 0.0722 * (d[i + 1] >> 16 & 255))); gn++; }
    }
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const dbg = tex.dbg ? '   |  albedoR ' + tex.dbg.albedoR.toFixed(0) + ' xsh ' + tex.dbg.sh.toFixed(3) +
    ' xcav ' + tex.dbg.cav.toFixed(3) + ' +spec ' + tex.dbg.spec.toFixed(3) +
    ' => outR ' + tex.dbg.outR.toFixed(0) + '  h' + tex.dbg.hMin.toFixed(2) + '-' + tex.dbg.hMax.toFixed(2) : '';
  console.log('  ' + pad(label, 14) + ' ' + tex.w + 'x' + tex.h +
    ' mean ' + pad(mean.toFixed(0), 3) + ' sd ' + pad(sd.toFixed(0), 3) +
    ' grad ' + pad((gn ? grad / gn : 0).toFixed(1), 4) + ' solid ' + pad((100 * solid / n).toFixed(0), 3) + '%' +
    ' emis ' + emis + ' avgRGB ' + ((lr / n) | 0) + ',' + ((lg / n) | 0) + ',' + ((lbb / n) | 0) +
    ' blown ' + (100 * clip / n).toFixed(2) + '%' + dbg);
}
if (MODE === 'exposure') {
  // average over levels x seeds: single runs swing +-20 just from lamp placement
  const N = run('LEVELS.length'), reps = +(process.env.REPS || 3);
  const buckets = new Array(8).fill(0);
  let grand = 0, gpix = 0, gclip = 0, gdark = 0;
  for (let lv = 0; lv < N; lv++) {
    let sum = 0, n = 0;
    const hist = new Array(8).fill(0);
    for (let r = 0; r < reps; r++) {
      seedRng(1000 + lv * 97 + r * 13);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      // average over yaws: looking down the longest corridor over-weights fog
      for (let w = 0; w < 6; w++) {
        run(`(()=>{const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
          const c=cs[((cs.length*0.31+${r})|0)%cs.length];
          P.x=c[0]+.5;P.y=c[1]+.5;P.ang=${w}*Math.PI/3+0.13;P.pitch=BH*0.02;
          for(const e of ENEMIES)e.state='sleep';})()`);
        run('renderWorld()');
        const BW = run('BW'), BH = run('BH'), d = new Uint32Array(run('px')), m = d.length;
        for (let i = 0; i < m; i++) {
          const c = d[i], L = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
          sum += L; hist[Math.min(7, (L / 32) | 0)]++; if (L > 250) gclip++; if (L < 24) gdark++;
        }
        n += m; gpix += m;
      }
    }
    for (let b = 0; b < 8; b++) buckets[b] += hist[b];
    grand += sum;
    console.log('  level ' + lv + '  mean ' + pad((sum / n).toFixed(0), 3) + '  buckets ' +
      hist.map(v => (100 * v / n).toFixed(0)).join(','));
  }
  console.log('  ALL       mean ' + pad((grand / gpix).toFixed(0), 3) + '  buckets ' +
    buckets.map(v => (100 * v / gpix).toFixed(0)).join(',') +
    '   <24: ' + (100 * gdark / gpix).toFixed(0) + '%  blown ' + (100 * gclip / gpix).toFixed(2) + '%');
}
if (MODE === 'viewmodel') {
  run('S.mode="play"; S.locked=false; startLevel(0, true);');
  const DW = run('DW'), DH = run('DH');
  const states = [
    ['hip', ''], ['ads', 'P.ads=1'], ['recoil', 'P.kick=WEAPONS[P.weapon].kick;S.muzzle=1'],
    ['reload', 'P.reloadT=WEAPONS[P.weapon].reload*0.5'], ['reload-mid', 'P.reloadT=WEAPONS[P.weapon].reload*0.2'],
    ['swap', 'P.swapT=0.3'], ['sprint', 'P.sprint=1;P.bobPhase=1.2;keys.KeyW=1'], ['airborne', 'P.air=true;P.vz=3'],
  ];
  let bad = 0;
  for (let wi = 0; wi < run('WEAPONS.length'); wi++) {
    for (const [name, setup] of states) {
      run(`P.weapon=${wi}; P.ads=0; P.kick=0; P.reloadT=0; P.swapT=0; P.sprint=0; P.air=false; P.vz=0; P.bobPhase=0; S.muzzle=0; ${setup}`);
      VR.on = true; VR.pts = []; VR.fills = 0; VR.nan = 0; VR.maxD = 0; VR.badDepth = 0;
      const err = run(`(()=>{try{drawViewModel(DH/900);return null}catch(e){return String(e.message)}})()`);
      VR.on = false;
      const q = VR.pts; let X0 = 1e9, X1 = -1e9, Y0 = 1e9, Y1 = -1e9;
      for (let i = 0; i < q.length; i += 2) { X0 = Math.min(X0, q[i]); X1 = Math.max(X1, q[i]); Y0 = Math.min(Y0, q[i + 1]); Y1 = Math.max(Y1, q[i + 1]); }
      const frac = [X0 / DW, X1 / DW, Y0 / DH, Y1 / DH];
      const problems = [];
      if (err) problems.push('threw ' + err);
      if (VR.nan) problems.push(VR.nan + ' non-finite points');
      if (VR.depth !== 0 || VR.badDepth) problems.push('save/restore unbalanced (depth ' + VR.depth + ')');
      if (VR.fills < 8) problems.push('only ' + VR.fills + ' fills - geometry missing');
      if (X1 < 0 || X0 > DW || Y0 > DH) problems.push('entirely off screen');
      const tag = (run('WEAPONS')[' ' + wi] || WEAPONSNAME(wi));
      console.log(('w' + wi + ' ' + name).padEnd(16), 'paths ' + String(VR.fills).padStart(3),
        'bbox x ' + frac[0].toFixed(2) + '-' + frac[1].toFixed(2), ' y ' + frac[2].toFixed(2) + '-' + frac[3].toFixed(2),
        problems.length ? '<< ' + problems.join(', ') : '');
      bad += problems.length ? 1 : 0;
    }
  }
  function WEAPONSNAME(i) { return run('WEAPONS.map(w=>w.kind)')[i]; }
  console.log(bad ? bad + ' viewmodel states with problems' : 'viewmodel: all states draw on screen, balanced, no NaN');
}
if (MODE === 'play') {
  // Exercises the loop the browser actually runs: update() -> renderWorld -> renderOverlay.
  // Everything else here calls renderWorld directly, which is why a throw inside update()
  // would pass every other probe and still freeze the screen.
  const report = (label, code) => {
    const r = run(`(()=>{try{${code};return null}catch(e){return String((e && e.stack) || e).split(String.fromCharCode(10)).slice(0,3).join(' | ')}})()`);
    console.log(label.padEnd(22), r ? 'THREW ' + r : 'clean');
    return r;
  };
  let bad = 0;
  run('S.mode="title"');
  bad += report('title x60 frames', 'for(let i=0;i<60;i++) frame(16.7*i)') ? 1 : 0;
  const NW = run('WEAPONS.length');
  for (let L = 0; L < run('LEVELS.length'); L++) {
    run(`S.mode="play"; startLevel(${L}, true); S.locked=true; P.ads=0; keys.KeyW=1;`);
    bad += report(`L${L} update x600`, 'for(let i=0;i<600;i++) update(1/60)') ? 1 : 0;
    bad += report(`L${L} frame x120`, 'for(let i=0;i<120;i++) frame(1000+i*16.7)') ? 1 : 0;
    // Velocity without displacement was the reported freeze: a mover whose position sits
    // in a solid cell fails its own radius probes and can never move. Measure travel.
    const trav = run(`(()=>{const x0=P.x,y0=P.y;for(let a=0;a<16;a++){P.ang+=TAU/16;if(!isSolid(P.x+Math.cos(P.ang)*0.6,P.y+Math.sin(P.ang)*0.6))break}keys.KeyW=1;for(let i=0;i<45;i++)frame(${L * 1e5}+i*16.7);keys.KeyW=0;return [Math.hypot(P.x-x0,P.y-y0),isSolid(P.x,P.y)?1:0]})()`);
    console.log(('  L' + L + ' walk').padEnd(20), trav[0] > 1 ? trav[0].toFixed(2) + ' units in 0.75 s'
      : 'BLOCKED after ' + trav[0].toFixed(3) + ' units' + (trav[1] ? ' - embedded in geometry' : '') + ' << this is the freeze');
    if (!(trav[0] > 1)) bad++;
    for (let wi = 0; wi < NW; wi++) {
      run(`P.weapon=${wi}; P.reloadT=WEAPONS[${wi}].reload*0.5;`);
      bad += report(`L${L} w${wi} reload`, 'for(let i=0;i<90;i++) frame(2000+i*16.7)') ? 1 : 0;
      run(`P.reloadT=0; P.kick=WEAPONS[${wi}].kick; tryFire();`);
      bad += report(`L${L} w${wi} fired`, 'for(let i=0;i<60;i++) frame(3000+i*16.7)') ? 1 : 0;
    }
    run('keys.KeyW=1; keys.ShiftLeft=1;');   // sprint needs forward pressure, not just Shift
    bad += report(`L${L} sprint`, 'for(let i=0;i<200;i++) frame(4000+i*16.7)') ? 1 : 0;
    run('keys.ShiftLeft=0; keys.ShiftRight=0; for(let i=0;i<40;i++){ENEMIES.forEach(e=>{if(e.state==="alive")damageEnemy(e,40,false,1,0)});frame(5000+i*16.7)}');
    bad += report(`L${L} combat`, 'for(let i=0;i<40;i++) frame(6000+i*16.7)') ? 1 : 0;
    bad += report(`L${L} portal+swap`, 'S.mode="play"; P.x=exitX; P.y=exitY; nextLevel(); for(let i=0;i<90;i++) frame(7000+i*16.7)') ? 1 : 0;
  }
  console.log(bad ? bad + ' loop states threw' : 'gameplay loop: every state ran clean');
}
if (MODE === 'decal') {
  // ground decals used to sample texel (0,0) and vanish; this counts what actually reaches the floor
  run('S.mode="play"; S.locked=false; startLevel(0, true);');
  run(`(()=>{const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
    const c=cs[((cs.length*0.31)|0)%cs.length];let best=0,bd=-1;
    for(let k=0;k<48;k++){const a=k*Math.PI/24;const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;if(d>bd){bd=d;best=a;}}
    P.x=c[0]+.5;P.y=c[1]+.5;P.ang=best;P.pitch=BH*0.1;for(const e of ENEMIES)e.state='sleep';})()`);
  const sample = () => {
    run('renderWorld()');
    const BW = run('BW'), BH = run('BH'), d = new Uint32Array(run('px')), red = [];
    let n = 0;
    for (let y = (BH * 0.55) | 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const c = d[y * BW + x], r = c & 255, g = c >> 8 & 255, b = c >> 16 & 255;
      if (r > g + 14 && r > b + 10 && r > 24) n++;
    }
    return n;
  };
  const before = sample();
  run(`(()=>{const c=P.x+Math.cos(P.ang),s=P.y+Math.sin(P.ang);
    for(let q=1;q<=5;q++) addGroundSplat(P.x+Math.cos(P.ang)*q*0.7, P.y+Math.sin(P.ang)*q*0.7, 0.42, 'blood');})()`);
  const after = sample(), nDec = run('DECALS.length');
  console.log('floor pixels with blood chroma: before ' + before + '  after ' + after +
    '  (decals in world: ' + nDec + ')');
}
if (MODE === 'diag') {
  run('');
  const h = t => { const a = new Array(8).fill(0); for (let i = 0; i < t.data.length; i++) a[Math.min(7, ((t.data[i] & 255) / 32) | 0)]++; return a.map(v => (100 * v / t.data.length).toFixed(1)).join(' '); };
  console.log('red-channel histograms (0-31 32-63 ... 224-255):');
  const walls = run('WALLS');
  walls.forEach((t, i) => console.log('  W' + (i + 1) + ' ' + h(t)));
  console.log('hash2(3,7)=', run('hash2(3,7)'), ' hash2(11,90)=', run('hash2(11,90)'));
  console.log('fbm(.3,.7,6,4,.6,12)=', run('fbm(0.3,0.7,6,4,0.6,12)'));
  console.log('pk(NaN)=', run('pk(NaN,10,10,255)'), 'pk(165.7)=', run('pk(165.7,10,10,255)'));
  const p = { u: 0.5, v: 0.5, h: 0.62, r: 128, g: 128, b: 128, e: 0 };
  console.log('courses(0.5,0.5)=', JSON.stringify(run('courses({u:0.5,v:0.5}, 8, 4, 0.055, 1)')));
  console.log('courses(0.31,0.44)=', JSON.stringify(run('courses({u:0.31,v:0.44}, 8, 4, 0.055, 1)')));
  console.log('helper coverage over 1536 random points (fraction of surface affected):');
  const masks = [
    ['cracks cover 0.05', 'crackMask({u:Q[0],v:Q[1]},0.05,4,118)'],
    ['cracks cover 0.07', 'crackMask({u:Q[0],v:Q[1]},0.07,5,44)'],
    ['cracks cover 0.09', 'crackMask({u:Q[0],v:Q[1]},0.09,4,88)'],
    ['moss 0.20 s63', 'mossMask({u:Q[0],v:Q[1]},0.20,63)'],
    ['moss 0.34 s87', 'mossMask({u:Q[0],v:Q[1]},0.34,87)'],
    ['rust 0.30 s71', 'rustMask({u:Q[0],v:Q[1]},0.30,71)'],
    ['rust 0.55 s31', 'rustMask({u:Q[0],v:Q[1]},0.55,31)'],
    ['dust 0.18', 'dustMask({u:Q[0],v:Q[1]},0.18)'],
    ['dust 0.26', 'dustMask({u:Q[0],v:Q[1]},0.26)'],
    ['dust 0.34', 'dustMask({u:Q[0],v:Q[1]},0.34)'],
  ];
  for (const [label, expr] of masks) {
    let sum = 0, mx = 0;
    for (let i = 0; i < 48; i++) {
      const Q = [Math.random(), Math.random()];
      run('globalThis.Q = [' + Q[0] + ',' + Q[1] + ']');
      const v = run(expr);
      sum += v; mx = Math.max(mx, v);
    }
    console.log('  ' + pad(label, 20) + ' mean ' + (100 * sum / 48).toFixed(1) + '%  max ' + (100 * mx).toFixed(0) + '%');
  }
  console.log('chain at (0.5,0.5):');
  console.log(run(`(()=>{const q={u:0.5,v:0.5,h:0.6,r:165,g:95,b:72,e:0};const o=[];
    grain(q,26,21,24);o.push('grain '+q.r.toFixed(0));dust(q,0.18,[96,88,78]);o.push('dust '+q.r.toFixed(0));
    cracks(q,0.74,0.10,5,44,[40,26,22]);o.push('cracks '+q.r.toFixed(0));moss(q,0.20,63);o.push('moss '+q.r.toFixed(0)+' h'+q.h.toFixed(2));
    return o.join(' | ')})()`));
}
if (MODE === 'stats') {
  console.log('--- materials ---');
  run('');
  const mats = run('WALLS.map((t,i)=>["W"+(i+1),t]).concat(Object.entries(FLOORS).map(([k,t])=>["F"+k,t]),Object.entries(CEILS).map(([k,t])=>["C"+k,t]));');
  const only = process.env.ONLY;
  for (const [n, t] of mats) { texStats(n, newTex(t)); if (only && n === only) console.log(texAscii(newTex(t), 76)); }
  console.log('--- sprites ---');
  const sp = run('[].concat(...Object.entries(ENEMY).map(([k,F])=>F.walk.map((t,i)=>[k+i,t])), Object.entries(PROP).map(([k,v])=>[k,Array.isArray(v)?v[0]:v]), Object.entries(DECAL).map(([k,t])=>["d"+k,t]))');
  const only2 = process.env.ONLY;
  for (const [n, t] of sp) { texStats(n, newTex(t)); if (only2 && (n.indexOf(only2) === 0 || n === only2)) console.log(texAscii(newTex(t), 60)); }
} else if (MODE === 'rig') {
  // pose sheet + silhouette sanity for the vector rigs
  run('S.mode="play"; startLevel(0, true); RIG.beginFrame(1e6);');
  const kinds = ['grunt', 'hound', 'brute'], PH = 6, YAW = 6, HH = 150;
  const W = 150 * 2, cells = [];
  for (const k of kinds) for (let y = 0; y < YAW; y++) for (let p = 0; p < PH; p++) cells.push({ k, y, p });
  const cols = PH, rows = kinds.length * YAW, cw = 170, chh = 175;
  const width = cols * cw + 8, height = rows * chh + 8;
  const sheet = new Uint32Array(width * height), bgc = 0xFF000000 | (0x2a << 16) | (0x26 << 8) | 0x22;
  sheet.fill(bgc);
  const rep = [];
  for (const c of cells) {
    const yaw = (c.y + 0.5) / YAW * Math.PI * 2 - Math.PI, ph = (c.p + 0.5) / PH;
    const t = Date.now();
    const tex = run(`RIG.raster(${JSON.stringify(c.k)}, ${HH}, {p:${ph.toFixed(4)}, yaw:${yaw.toFixed(4)}, mv:${(c.p % 3) / 2}, atk:0, die:0, lean:0, pulse:${(ph * 6.28).toFixed(3)}})`);
    const ms = Date.now() - t;
    if (ASCII && c.y === 1 && (c.p === 1 || c.p === 3)) console.log(c.k + ' yaw' + c.y + ' ph' + c.p + '\n' + texAscii(tex, 46));
    const d = tex.data, runsRow = []; let n = 0, runs = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, sr = 0, sg = 0, sb = 0, comY = 0;
    for (let y = 0; y < tex.h; y++) for (let x = 0; x < tex.w; x++) {
      const c2 = d[y * tex.w + x]; if ((c2 >>> 24) < 12) continue;
      n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sr += c2 & 255; sg += c2 >> 8 & 255; sb += c2 >> 16 & 255; comY += y;
      if (y > tex.h * 0.62) {                                   // separate blobs on a row = separate limbs
        const prev = x > 0 ? (d[y * tex.w + x - 1] >>> 24) : 0; if ( prev < 12) runsRow[y] = (runsRow[y] || 0) + 1;
      }
    }
    for (let y = 0; y < tex.h; y++) runs += runsRow[y] || 0;
    const gx = 8 + (c.p % cols) * cw + 4, gy = 8 + (((kinds.indexOf(c.k) * YAW) + c.y) * chh) + 4;
    const ox = gx + Math.round((cw - 8 - tex.w) / 2), oy = gy + (chh - 8 - tex.h);
    for (let y = 0; y < tex.h; y++) for (let x = 0; x < tex.w; x++) {
      const c2 = d[y * tex.w + x], a = c2 >>> 24; if (a === 0) continue;
      const o = (oy + y) * width + ox + x;
      if (a > 250) { sheet[o] = 0xFF000000 | (c2 & 0xFFFFFF); continue; }
      const dst = sheet[o], IA = 255 - a;
      sheet[o] = 0xFF000000 | ((c2 & 255) * a + (dst & 255) * IA >> 8) | (((c2 >> 8 & 255) * a + (dst >> 8 & 255) * IA >> 8) << 8) | (((c2 >> 16 & 255) * a + (dst >> 16 & 255) * IA >> 8) << 16);
    }
    rep.push({ k: c.k, y: c.y, p: c.p, ms, cov: n / (tex.w * tex.h), runs: runs / (tex.h * 0.38), w: tex.w, h: tex.h, bb: (maxX - minX + 1) / tex.h, top: minY / tex.h, bot: (maxY + 1) / tex.h, com: comY / n / tex.h, rgb: [sr / n | 0, sg / n | 0, sb / n | 0] });
  }
  writePNG(OUT, width, height, toRGBA(sheet));
  const bad = [];
  for (const r of rep) {
    if (r.cov < 0.02) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' coverage ' + (r.cov * 100).toFixed(1) + '% empty');
    if (r.cov > 0.45) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' coverage ' + (r.cov * 100).toFixed(1) + '% blob');
    if (r.bot < 0.9) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' feet floating (bbox bottom ' + r.bot.toFixed(2) + ')');
    if (r.top > 0.25) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' crown low (top ' + r.top.toFixed(2) + ')');
    if (r.runs < 1.55) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' lower body is one mass (runs/row ' + r.runs.toFixed(2) + ')');
    if (r.bb > 1.5) bad.push(r.k + ' yaw' + r.y + ' ph' + r.p + ' silhouette too wide ' + r.bb.toFixed(2));
  }
  for (const k of kinds) {
    const rs = rep.filter(r => r.k === k);
    const com = rs.map(r => r.com);
    console.log(k.padEnd(6), 'coverage ' + (rs.reduce((a, r) => a + r.cov, 0) / rs.length * 100).toFixed(1) + '%',
      'bboxW/H ' + Math.min(...rs.map(r => r.bb)).toFixed(2) + '-' + Math.max(...rs.map(r => r.bb)).toFixed(2),
      'bob ' + (Math.max(...com) - Math.min(...com)).toFixed(3), 'limbs/row ' + (rs.reduce((a, r) => a + r.runs, 0) / rs.length).toFixed(2), 'rgb ' + rs[0].rgb.join(','),
      'raster ' + (rs.reduce((a, r) => a + r.ms, 0) / rs.length).toFixed(1) + 'ms/frame');
  }
  console.log(bad.length ? 'RIG PROBLEMS:\n  ' + bad.join('\n  ') : 'rig silhouettes: all ' + rep.length + ' poses sane');
  console.log('cache', JSON.stringify(run('RIG.stats()')), '->', OUT);
} else if (MODE === 'sheets') {
  // contact sheet: each material tiled 2x2 (tileability), each sprite frame at native size
  const spec = run(`(()=>{
    const rows=[];
    const packRow=(list)=>rows.push(list);
    const mats=[];
    for(const w of WALLS) mats.push({n:'W'+(WALLS.indexOf(w)+1),t:w});
    for(const k in FLOORS) mats.push({n:'F'+k,t:FLOORS[k]});
    for(const k in CEILS) mats.push({n:'C'+k,t:CEILS[k]});
    const spr=[];
    for(const k in ENEMY) for(const st of ['walk','atk','die']) ENEMY[k][st].forEach((t,i)=>spr.push({n:k+'.'+st+i,t}));
    for(const k in PROP) { const v=PROP[k]; if(Array.isArray(v)) v.forEach((t,i)=>spr.push({n:k+i,t})); else spr.push({n:k,t:v}); }
    for(const k in DECAL) spr.push({n:'d'+k,t:DECAL[k]});
    return {mats,spr}})()`);
  const S2 = 128, GAP = 4, cols = 4;
  const mRows = Math.ceil(spec.mats.length / cols);
  const sCols = 10, sCell = 96;
  const sRows = Math.ceil(spec.spr.length / sCols);
  const width = cols * (S2 * 2 + GAP) + GAP;
  const height = mRows * (S2 * 2 + GAP) + GAP + sRows * (sCell + GAP) + GAP;
  const sheet = new Uint32Array(width * height);
  const bg = (0x22 << 16) | (0x1c << 8) | 0x18, bl = 0xFF000000 >>> 0;
  for (let i = 0; i < sheet.length; i++) sheet[i] = bl | bg;
  const blit = (tex, dx, dy, dw, dh, tintOff) => {
    const d = tex.data, tw = tex.w, th = tex.h;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      let tx = x * tw / dw | 0, ty = y * th / dh | 0;
      if (dw > tw) tx = (x * tw / dw | 0) % tw, ty = (y * th / dh | 0) % th;
      const c = d[ty * tw + tx], a = c >>> 24;
      const o = (dy + y) * width + dx + x;
      if (a === 0) continue;
      if (a === 255 || a === 253) { sheet[o] = 0xFF000000 | (c & 0xFFFFFF); continue; }
      const dst = sheet[o], A = a, IA = 255 - a;
      sheet[o] = 0xFF000000 | (((((c & 255) * A + (dst & 255) * IA) >> 8) & 255)) |
        (((((c >> 8 & 255) * A + (dst >> 8 & 255) * IA) >> 8) & 255) << 8) |
        (((((c >> 16 & 255) * A + (dst >> 16 & 255) * IA) >> 8) & 255) << 16);
    }
  };
  spec.mats.forEach((m, i) => {
    const cx = GAP + (i % cols) * (S2 * 2 + GAP), cy = GAP + ((i / cols) | 0) * (S2 * 2 + GAP);
    for (let q = 0; q < 4; q++) blit(m.t, cx + (q % 2) * S2, cy + ((q / 2) | 0) * S2, S2, S2);
  });
  const y0 = mRows * (S2 * 2 + GAP) + GAP;
  spec.spr.forEach((s, i) => {
    const cx = GAP + (i % sCols) * sCell, cy = y0 + ((i / sCols) | 0) * (sCell + GAP);
    const sc = Math.min(sCell / s.t.w, sCell / s.t.h);
    blit(s.t, cx + (sCell - s.t.w * sc) / 2 | 0, cy + (sCell - s.t.h * sc) | 0, Math.max(1, s.t.w * sc | 0), Math.max(1, s.t.h * sc | 0));
  });
  dump('sheets', sheet, width, height, 1);
} else {
  run('S.mode="play"; S.locked=false;');
  run(`startLevel(${LVL}, true); S.mode='play';`);
  // point the camera at something with depth: nearest open cell looking down a corridor
  run(`(()=>{
    const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
    const c=cs.length?cs[((cs.length*0.31+${CAM})|0)%cs.length]:[P.x|0,P.y|0];
    let best=${CAM}*0.7, bd=-1;                 // deterministic: look down the longest sight line
    for(let k=0;k<48;k++){const a=k*Math.PI/24;
      const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;
      if(d>bd){bd=d;best=a;}}
    P.x=c[0]+.5;P.y=c[1]+.5;P.ang=best;P.pitch=BH*0.02;
    for(const e of ENEMIES){e.state='sleep';e.anim=0.3+((e.x*3)%1);}
    if(ENEMIES.length){                          // park a live enemy in frame: that is what needs judging
      const e=ENEMIES[0];let bx=P.x,by=P.y;
      for(let s=1;s<=6;s++){const nx=P.x+Math.cos(best)*s,ny=P.y+Math.sin(best)*s;if(isSolid(nx,ny))break;bx=nx;by=ny;}
      e.x=bx;e.y=by;e.state='idle';e.anim=0.37;}
  })()`);
  run('renderWorld()');
  const BW = run('BW'), BH = run('BH'), buf = new Uint32Array(run('px'));
  stats('frame', buf, BW, BH);
  dump(`scene L${LVL} cam${CAM}`, buf, BW, BH, 2);
  if (process.env.WARM) {
    // warm the rig cache the way play does: walk, turn, and watch the budget hold
    const t0 = Date.now();
    const ms = run(`(()=>{const t=[];for(let f=0;f<180;f++){P.ang+=0.05;updatePlayer(1/60);updateEnemies(1/60);const t0=Date.now();renderWorld();t.push(Date.now()-t0);}return t})()`);
    const sum = ms.reduce((a, b) => a + b, 0);
    console.log('180 frames of play: raster avg ' + (sum / ms.length).toFixed(2) + 'ms, worst ' + Math.max(...ms) + 'ms, wall ' + (Date.now() - t0) + 'ms');
    console.log('rig cache', JSON.stringify(run('RIG.stats()')));
  }
}
