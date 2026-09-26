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
if (MODE === 'alt') {
  // Altitude cross-section - the vertical generalisation of "is this level sane". Flat levels
  // must report band 0 at 100%, no step faces and no mismatches; anything else means the flat
  // world has stopped being bit-identical. boundary is what the wall pass will draw: a face of
  // span <=0 there is a column the DDA stops at but nothing renders - the invisible wall that
  // freezes a raycast. step counts open-to-open crossings, where an unblocked step is the same
  // fault seen from the movement side.
  for (let li = 0; li < 3; li++) {
    const r = vm.runInContext(`(function(){
      startLevel(${li}, true);
      const N = MAP.w, cell = MAP.cell, fz = MAP.fz, vb = MAP.vb;
      let open = 0, nonFlat = 0, minF = 9e9, maxF = -9e9, faces = 0, faceUnblocked = 0, blockedFlat = [0,0,0,0];
      let bfaces = 0, badSpan = 0, minSpan = 9e9, maxSpan = 0;
      const bands = {};
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (cell[i]) continue;
        open++;
        const f = fz[i] * ZQ; bands[f] = (bands[f] || 0) + 1;
        if (fz[i] !== 0) nonFlat++;
        if (f < minF) minF = f; if (f > maxF) maxF = f;
        // Use the game's own direction arrays: an invented table reads the wrong nibble and
        // reports phantom invisible walls (it did, as 0,23,23,0 on a level with no height at all).
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRX[d], ny = y + DIRY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const j = ny * N + nx;
          if (cell[j]) {
            // the face the wall pass draws here, measured with the renderer's own pair
            const sp = ceilAt(x, y) - faceZ0(x, y, d);
            bfaces++;
            if (!(sp > 0)) badSpan++;
            else { if (sp < minSpan) minSpan = sp; if (sp > maxSpan) maxSpan = sp; }
            continue;
          }
          const dq = fz[j] - fz[i], blocked = (vb[i] >> (d << 2)) & 1;
          if (dq > 1) { faces++; if (!blocked) faceUnblocked++; }
          else if (blocked) blockedFlat[d]++;
        }
      }
      return { open, nonFlat, minF, maxF, faces, faceUnblocked, blockedFlat,
        bfaces, badSpan, minSpan, maxSpan, bands, bandsN: MAP.bands };
    })()`, ctxVm);
    const flat = r.nonFlat === 0 && r.faces === 0 && r.blockedFlat.every(v => v === 0) && r.badSpan === 0;
    console.log(`level ${li}  open ${r.open}  floors ${r.minF}..${r.maxF}  bands ${JSON.stringify(r.bands)}`);
    console.log(`         boundary ${r.bfaces} span ${r.bfaces ? r.minSpan + '..' + r.maxSpan : '-'} span<=0 ${r.badSpan}` +
      `  step faces ${r.faces} unblocked-step ${r.faceUnblocked}  blockedFlat byDir ${r.blockedFlat.join(',')}` +
      `  ${r.bfaces > 0 && r.badSpan === 0 ? 'FACES ok' : 'FACE FAIL'}  ${flat ? 'ALL FLAT ok' : 'NOT FLAT - check above'}`);
  }
}

if (MODE === 'vert') {
  /* M3 step 1: cell heights have to reach the occupancy gate. This calls bfsReach, the one BFS the
     generator uses, so it tests the function the gate runs rather than a copy that can drift. */
  let bad = 0;
  for (let li = 0; li < 3; li++) {
    const r = vm.runInContext(`(function(){
      const warns = []; const ow = console.warn; console.warn = function (m) { warns.push(String(m)); };
      startLevel(${li}, true);
      console.warn = ow;
      const N = MAP.w, start = MAP.rooms[0].cy * N + MAP.rooms[0].cx;
      const flatFz = new Int8Array(N * N);
      const flat = bfsReach(MAP.cell, flatFz, N, start);
      let rf = 0, mx = -1, mxIdx = -1;
      const exitIdx0 = ((exitY | 0) * N + (exitX | 0));
      for (let i = 0; i < N * N; i++) if (flat[i] >= 0) { rf++; if (flat[i] > mx) { mx = flat[i]; mxIdx = i; } }
      const stepFz = new Int8Array(N * N); for (let i = 0; i < N * N; i++) stepFz[i] = (i % 3) ? 1 : 0;
      const dStep = bfsReach(MAP.cell, stepFz, N, start);
      let rs = 0; for (let i = 0; i < N * N; i++) if (dStep[i] >= 0) rs++;
      const splitFz = new Int8Array(N * N);
      for (let y = 0; y < N; y++) for (let x = (N >> 1); x < N; x++) splitFz[y * N + x] = 2;
      const dSplit = bfsReach(MAP.cell, splitFz, N, start);
      let rb = 0, blocked = 0;
      for (let i = 0; i < N * N; i++) { if (dSplit[i] >= 0) rb++; if (flat[i] >= 0 && dSplit[i] < 0) blocked++; }
      const exitIdx = exitIdx0;
      MAP.fz = splitFz; linkBoundaries();
      return { N: N, exitAtFar: mxIdx === exitIdx0, exitDist: flat[exitIdx0], rfAtExit: mx, reachFlat: rf, reachStep: rs, reachSplit: rb, blocked: blocked,
        warns: warns.length, exitSealed: dSplit[exitIdx] < 0, stamp: MAP.linkStamp };
    })()`, ctxVm);
    const ok = r.exitAtFar && r.reachStep === r.reachFlat && r.reachSplit < r.reachFlat && r.blocked > 0 && r.warns === 0 && r.exitSealed;
    if (!ok) bad++;
    console.log(`level ${li}  N ${r.N}  exit is the far cell ${r.exitAtFar ? 'ok' : 'FAIL'} (d=${r.exitDist})` +
      `  one-step walkable ${r.reachStep === r.reachFlat ? 'ok' : 'FAIL ' + r.reachStep + '/' + r.reachFlat}` +
      `  split reaches ${r.reachSplit}/${r.reachFlat} blocked ${r.blocked} ${r.blocked > 0 && r.reachSplit < r.reachFlat ? 'REFUSES ok' : 'FAIL'}` +
      `  exit sealed ${r.exitSealed ? 'ok' : 'FAIL'}  FALLBACK warns ${r.warns} ${r.warns === 0 ? 'ok' : 'FALSE POSITIVE'}  ${ok ? 'ok' : 'FAIL'}`);
  }
  /* ---- M3 step 2: the player has to OBEY the grid. No shipped level has a height or a ladder
     yet (that is step 4), so no other gate can watch this code, and "it did not crash" is not a
     verdict. Every case pokes MAP.fz / MAP.vb / MAP.feat, relinks, then asks what the player
     DID - sampled per frame, because a teleport and a fall agree about the final position. */
  console.log('player behaviour');
  const VROW = (label, ok, detail) => {
    bad += ok ? 0 : 1;
    console.log('  ' + (label + ' ').padEnd(42, '.') + ' ' + (ok ? 'ok  ' : 'FAIL') + '  ' + detail);
  };
  const PRE = li => `S.mode='play';S.locked=false;S.diff=1;startLevel(${li},true);` +
    `for(const e of ENEMIES)e.state='sleep';for(const k in keys)delete keys[k];` +
    `P.vx=P.vy=P.vz=0;P.air=false;P.crouch=0;P.hp=100;P.armor=0;`;
  /* A lane is a straight run of open columns. With dy = 0 the only probe tryMove can reach is the
     one pointing down the run, so a lane is a corridor the assertion owns end to end. */
  const LANE = `(()=>{for(let y=1;y<MH-2;y++)for(let x=1;x<MW-6;x++){let n=0;` +
    `while(n<10&&x+n<MW-1&&!MAP.cell[y*MW+x+n])n++;if(n>=6)return{x:x,y:y,n:n};}return null})()`;
  /* A poke that leaves a face of span <= 0 is a grid fault and would blame the wrong code, so the
     legality of every config is reported before any FAIL below is allowed to point at the player. */
  const SPANS = `(()=>{let tot=0,bad=0;for(let i=0;i<MW*MH;i++){if(!MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;` +
    `for(let d=0;d<4;d++){const nx=x+DIRX[d],ny=y+DIRY[d];if(nx<0||ny<0||nx>=MW||ny>=MH||MAP.cell[ny*MW+nx])continue;` +
    `tot++;if(!(ceilAt(x,y)-faceZ0(x,y,d)>0))bad++;}}return{tot:tot,bad:bad}})()`;
  /* S.shake is in the sample because a support test that fires ON the floor self-cancels inside one
     frame (it lands before the sample) and is invisible to a post-update read - but the landing adds
     its impulse every frame, and an impulse that repeats while walking on flat ground is a bug. */
  const SAMPLE = `update(1/60);s.push([+P.x.toFixed(4),+P.z.toFixed(6),+floorAt(P.x,P.y).toFixed(4),P.air?1:0,+P.hp.toFixed(3),+S.shake.toFixed(4)])`;
  const RUN = (fr, key) => `(()=>{` + (key ? `keys['${key}']=1;` : '') + `const s=[];for(let i=0;i<${fr};i++){${SAMPLE};}return s})()`;
  const PLACE = (x, y, z) => `P.x=${x};P.y=${y};P.ang=0;P.vx=P.vy=P.vz=0;P.air=false;` +
    `P.z=${z === undefined ? 'floorAt(P.x,P.y)' : z};for(const k of ['KeyW','KeyA','KeyS','KeyE','KeyQ','Space','ShiftLeft'])delete keys[k];`;
  /* The flat case runs on every untouched level: it is what makes the md5 gate mean something,
     since a P.z that only tracks the floor by luck hashes just as well as one that does not. */
  for (let li = 0; li < run('LEVELS.length'); li++) {
    run(PRE(li));
    const x0 = run('P.x'), s = run(RUN(150, 'KeyW'));
    const sep = s.filter(r => r[1] !== r[2]).length, air = s.filter(r => r[3]).length;
    const adv = s[s.length - 1][0] - x0, z0 = s[0][1], shk = Math.max.apply(null, s.map(r => r[5]));
    VROW('L' + li + ' flat walk keeps P.z on the floor', !sep && !air && adv > 2 && shk < 0.05,
      `P.z off the floor ${sep}/150 frames, airborne ${air}, landing impulse peaked at ${shk.toFixed(2)}, ` +
      `travelled ${adv.toFixed(2)} units in 2.5 s` + (adv <= 2 ? ' VACUOUS - the player barely moved' : ''));
    const ze = run(RUN(40, 'KeyE')).pop()[1], zq = run(RUN(40, 'KeyQ')).pop()[1];
    VROW('L' + li + ' climb keys inert with no ladder', ze === z0 && zq === z0, `KeyE -> ${ze}, KeyQ -> ${zq}, floor ${s[0][2]}`);
  }
  let laneLi = -1, lane = null;
  for (let li = 0; li < run('LEVELS.length') && !lane; li++) { run(PRE(li)); lane = run(LANE); if (lane) laneLi = li; }
  if (!lane) VROW('a straight lane to walk down', false, 'NO-LANE in any level - every case below is vacuous');
  else {
    const CX = lane.x, CY = lane.y, N = lane.n, LIPX = CX + 3;
    /* Every config: a poke on the lane, then the same walk down it. The poke is a runtime height,
       not a generator change - step 4 owns the content - and linkBoundaries is what keeps
       ceilPlane and linkStamp honest about it (view.js planes is the gate for that). */
    const CFG = (body, poke) => PRE(laneLi) + `(()=>{${poke}})();linkBoundaries();` +
      PLACE(CX + 0.5, CY + 0.5) + body;
    console.log(`  lane level ${laneLi} cell ${CX},${CY} length ${N} - facing +x, the change 3 columns ahead`);
    /* Blocking, walkable and drawn must be ONE byte: a quantum of floor is a stair the player
       walks up unasked, two quanta is a wall it stops at, and both are the same flag test. */
    for (const [name, dq, want] of [['a 1-quantum lip', 1, 'over'], ['a 2-quantum lip', 2, 'stop']]) {
      run(CFG('', `for(let j=3;j<${N};j++)MAP.fz[${CY} * MW + ${CX} + j]+=${dq};`));
      const Z0 = run('P.z'), sp = run(SPANS), s = run(RUN(150, 'KeyW'));
      const zs = s.map(r => r[1]), crossed = s[s.length - 1][0] > LIPX + 0.2;
      const air = s.filter(r => r[3]).length;
      const mid = zs.filter(z => z > zs[0] + 1e-9 && z < Z0 + dq * 0.25 - 1e-9).length;
      const endZ = zs[zs.length - 1], wantZ = Z0 + (want === 'over' ? 0.25 : 0);
      const ok = sp.bad === 0 && air === 0 && endZ === wantZ && (want === 'over' ? crossed && mid > 0 : !crossed && mid === 0);
      VROW('auto-step over ' + name, ok,
        `faces ${sp.tot - sp.bad}/${sp.tot} legal, crossed ${crossed ? 'yes' : 'no'}, P.z ${zs[0]} -> ${endZ} (want ${wantZ}), ` +
        `rise spread over ${mid} intermediate frames, airborne ${air}`);
      if (want === 'over') {
        const path = [];
        for (const r of s) if (!path.length || r[1] !== path[path.length - 1]) path.push(r[1]);
        console.log('    P.z path ' + path.map(v => v.toFixed(4)).join(' -> '));
      }
    }
    /* A drop the collision path lets you walk off has to take FRAMES: the else branch used to snap
       P.z to the floor, which is the teleport this step exists to remove. */
    run(CFG('', `for(let j=3;j<${N};j++)MAP.fz[${CY} * MW + ${CX} + j]-=4;`));
    const spd = run(SPANS), s = run(RUN(120, 'KeyW'));
    const airAt = s.map((r, i) => r[3] ? i : -1).filter(i => i >= 0);
    let mono = true;
    for (let i = 1; i < s.length; i++) if (s[i][1] > s[i - 1][1] + 1e-12) mono = false;
    const uniq = new Set(s.map(r => r[1])).size, dmg = +(100 - s[s.length - 1][4]).toFixed(3);
    VROW('walking off a 1-unit ledge falls over frames', spd.bad === 0 && airAt.length >= 3 && mono && uniq >= 4 && dmg === 0,
      `airborne ${airAt.length} frames, monotonic ${mono ? 'yes' : 'no'}, ${uniq} distinct P.z, hp lost ${dmg}, ` +
      `lands on ${s[s.length - 1][2]} at P.z ${s[s.length - 1][1]}`);
    const from = airAt.length ? Math.max(0, airAt[0] - 1) : 0, to = airAt.length ? Math.min(s.length - 1, airAt[airAt.length - 1] + 1) : 0;
    console.log('    frame        x       P.z    floor  air');
    for (let i = from; i <= to; i++) if (i - from < 26 || i > to - 3)
      console.log('    ' + String(i).padStart(5) + ' ' + s[i][0].toFixed(3).padStart(9) + ' ' + s[i][1].toFixed(5).padStart(9) +
        ' ' + s[i][2].toFixed(2).padStart(7) + ' ' + (s[i][3] ? 'yes' : 'no').padStart(5));
    /* Landing costs health above the free-drop limit and nothing below it. Each drop is dug into
       the lane so the altitude lost is exact - k quanta - from a player at rest. */
    const rows = [];
    for (const k of [5, 8, 10, 13, 16]) {
      run(CFG('', `for(let j=1;j<${N};j++)MAP.fz[${CY} * MW + ${CX} + j]-=${k};`) + PLACE(CX + 2.5, CY + 0.5, 0));
      const sp = run(SPANS);
      const r = run('(()=>{let i=0;do{update(1/60);i++}while(P.air&&i<240);' +
        'return{i:i,hp:+P.hp.toFixed(3),z:P.z,gz:floorAt(P.x,P.y)}})()');
      rows.push({ h: k * 0.25, dmg: +(100 - r.hp).toFixed(3), fr: r.i, landed: r.z === r.gz, spans: sp.bad });
    }
    const over = rows.slice(1);
    const mono2 = over.every((r, i) => i === 0 || r.dmg > over[i - 1].dmg);
    VROW('fall damage free under 1.5 units, scaled over', rows[0].dmg === 0 && over.every(r => r.dmg > 0) && mono2 && rows.every(r => r.landed && !r.spans),
      rows.map(r => `${r.h.toFixed(2)}->${r.dmg.toFixed(1)}hp/${r.fr}f`).join('  ') + '   (drop -> hp lost / frames)');
    /* A ladder is the only thing that turns the up/down keys into altitude, so the same cell with
       the flag cleared is the control: identical grid, identical keys, no change in P.z. */
    const ladCase = (poke, key, fr) => {
      run(CFG('', poke) + PLACE(CX + 1.5, CY + 0.5));
      return run(RUN(fr, key)).pop()[1];
    };
    const Z0 = run(PRE(laneLi) + PLACE(CX + 1.5, CY + 0.5) + 'P.z'), ceil = run('ceilAt(P.x,P.y)');
    const up = ladCase(`MAP.feat[${CY} * MW + ${CX} + 1]=FEAT_LADDER;`, 'KeyE', 40);
    const plain = ladCase(`MAP.feat[${CY} * MW + ${CX} + 1]=FEAT_NONE;`, 'KeyE', 40);
    const vlad = ladCase(`MAP.vb[${CY} * MW + ${CX} + 1]|=(VB_LADDER<<0);`, 'KeyE', 40);
    const down = ladCase(`MAP.feat[${CY} * MW + ${CX} + 1]=FEAT_LADDER;`, 'KeyQ', 40);
    VROW('climb up on a FEAT_LADDER cell', up > Z0, `P.z ${Z0} -> ${up} in 0.67 s (ceiling plane ${ceil})`);
    VROW('the same cell without the flag does not climb', plain === Z0, `P.z ${Z0} -> ${plain}`);
    VROW('a VB_LADDER crossing climbs too', vlad > Z0, `P.z ${Z0} -> ${vlad}`);
    VROW('climbing down stops at the column floor', down === Z0, `P.z ${Z0} -> ${down}`);
  }
  /* The spawn invariant the ordering bug would break: at level start the feet are ON the floor. */
  for (let li = 0; li < run('LEVELS.length'); li++) {
    run(`S.mode='play';startLevel(${li},true);`);
    const r = run('({z:P.z,f:floorAt(P.x,P.y),air:P.air?1:0,solid:isSolid(P.x,P.y)?1:0})');
    VROW('L' + li + ' spawn sits on its floor', r.z === r.f && !r.air && !r.solid,
      `P.z ${r.z} vs floorAt ${r.f}, airborne ${r.air}, inside geometry ${r.solid}`);
  }
  if (bad) { console.log('vert: FAILED'); process.exit(1); }
  console.log('vert: all levels ok');
}

if (MODE === 'planes') {
  // What alt reports as "flat" is the FLOOR grid. The ground pass solves each pixel against the
  // plane of the cell it lands in - floor below the horizon, MAP.ceilPlane above it - so a
  // ceiling that is not exactly 1 in a "flat" level makes segments break and moves pixels. This is
  // the probe that says so: planes per level, floor and ceiling separately. ceilPlane is DERIVED
  // (linkBoundaries fills it from ceilAt), so the same loop checks it is not stale: a write to
  // MAP.fz or MAP.cz that skips linkBoundaries would render last frame's ceilings, silently.
  let staleAll = 0;
  for (let li = 0; li < 3; li++) {
    const r = vm.runInContext(`(function(){
      startLevel(${li}, true);
      const N = MAP.w; let fmin = 9e9, fmax = -9e9, cmin = 9e9, cmax = -9e9, open = 0, cnot1 = 0, stale = 0;
      const cv = {};
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        if (MAP.cell[y * N + x]) continue;
        open++;
        const f = floorAt(x + 0.5, y + 0.5), c = ceilAt(x + 0.5, y + 0.5);
        if (MAP.ceilPlane[y * N + x] !== c) stale++;             // derived array vs the formula
        if (f < fmin) fmin = f; if (f > fmax) fmax = f;
        if (c < cmin) cmin = c; if (c > cmax) cmax = c;
        if (c !== 1) cnot1++;
        cv[c.toFixed(4)] = (cv[c.toFixed(4)] || 0) + 1;
      }
      return { open, fmin, fmax, cmin, cmax, cnot1, stale, cv };
    })()`, ctxVm);
    console.log(`level ${li}  open ${r.open}  floors ${r.fmin}..${r.fmax}  ceilings ${r.cmin}..${r.cmax}  ceil!=1 ${r.cnot1}` +
      `  ceilPlane stale ${r.stale} ${r.stale ? 'STALE-DERIVED' : 'DERIVED ok'}  ${JSON.stringify(r.cv)}`);
    staleAll += r.stale;
  }
  /* Both passes read ceilPlane now, so a grid write that skips linkBoundaries() is no longer a seam
     nobody compares - linkStamp moves only inside linkBoundaries(), so a write that leaves it where
     it was is the forgotten call. Write one floor with no relink and require all four facts: the grid
     moved, the stamp did not, the derived array disagrees with the formula, and a relink fixes both. */
  const yn = v => (v ? 1 : 0);
  const st = vm.runInContext(`(function(){
    startLevel(0, true);
    const N = MAP.w, k = MAP.cell.length;
    let i = -1; for (let j = 0; j < k; j++) if (!MAP.cell[j]) { i = j; break; }
    if (i < 0) return { skip: 'NO-OPEN-CELL' };
    const ix = i % N, iy = (i / N) | 0;
    const f0 = MAP.fz[i], a0 = MAP.ceilPlane[i], s0 = MAP.linkStamp | 0;
    MAP.fz[i] = f0 + 1;                                   // a band write with NO linkBoundaries()
    const s1 = MAP.linkStamp | 0, a1 = MAP.ceilPlane[i];
    linkBoundaries();
    const s2 = MAP.linkStamp | 0;
    return { cell: i, gridMoved: MAP.fz[i] !== f0, arrayUntouched: a1 === a0, stampMovedStale: s1 !== s0,
      staleAgrees: a1 === ceilAt(ix, iy), stampMovedRelink: s2 !== s1, freshAgrees: MAP.ceilPlane[i] === ceilAt(ix, iy) };
  })()`, ctxVm);
  const stOk = !st.skip && st.gridMoved && st.arrayUntouched && !st.stampMovedStale &&
    !st.staleAgrees && st.stampMovedRelink && st.freshAgrees;
  console.log(`relink stamp  ${st.skip || 'cell ' + st.cell}  grid moved ${yn(st.gridMoved)}  forgot relink: stamp moved ${yn(st.stampMovedStale)}` +
    ` array!=ceilAt ${yn(!st.staleAgrees)}  relinked: stamp moved ${yn(st.stampMovedRelink)} array==ceilAt ${yn(st.freshAgrees)}` +
    `  ${st.skip ? st.skip : stOk ? 'STALE-DETECT ok' : 'STALE-DETECT FAIL'}`);
  process.exit(staleAll || !stOk ? 1 : 0);  // a derived array that disagrees with its formula is a verdict, not a footnote
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
if (MODE === 'heights') {
  /* The ground pass solves each pixel against the plane of the cell its own ray lands in, and
     every shipped level is flat, so no other gate can watch that code run. This probe builds the
     heights at runtime and asks which HALF of the frame moved: a floor row must not react to a
     ceiling and a ceiling row must not react to a floor, which is only true if the solver reads
     the plane per cell instead of one plane per row. It also fails the way M2 has failed before -
     solving a plane against a SOLID column gives a floor plane below the eye, the pass paints
     nothing and the frame comes out grey (mean 33 where the flat render reads 79) - so every
     config reports its mean, its black ratio, and the boundary spans the wall pass will draw.
     The heights are pokes to MAP.fz/cz, not generator changes: M2 is a renderer milestone and the
     shipped grid stays flat until M3 gives the bands links, which is why `alt` must stay green. */
  const CAMSET = `(()=>{
    const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
    const c=cs[((cs.length*0.31)|0)%cs.length];
    let best=0,bd=-1;
    for(let k=0;k<48;k++){const a=k*Math.PI/24;const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;if(d>bd){bd=d;best=a;}}
    P.x=c[0]+.5;P.y=c[1]+.5;P.ang=best;P.pitch=BH*0.02;P.z=floorAt(P.x,P.y);
    for(const e of ENEMIES)e.state='sleep';
    return {x:P.x,y:P.y,d:bd};
  })()`;
  /* A wall column must reach down to the lowest band it bounds, or the face it shows has span <= 0:
     that is a grid fault (AGENTS.md), so every poke that moves a floor runs this after it and the
     faces column below is what proves the config is legal before any FAIL gets blamed on the pass. */
  const CARRY = `;(()=>{for(let k=0;k<2;k++)for(let i=0;i<MW*MH;i++){if(!MAP.cell[i])continue;let m=MAP.fz[i];
    for(let d=0;d<4;d++){const x=i%MW,y=(i/MW)|0,nx=x+DIRX[d],ny=y+DIRY[d];
      if(nx<0||ny<0||nx>=MW||ny>=MH)continue;const n=ny*MW+nx;
      if(!MAP.cell[n]&&MAP.fz[n]<m)m=MAP.fz[n];}MAP.fz[i]=m;}})()`;
  /* Floor decals in the frame, so a re-solved pixel has to run the decal blend. The deferred pass in
     castGround is a SECOND copy of the ground pixel body (its comment says why), and the first
     version of that split crashed in the decal branch alone - at 4x resolution, where the stress
     probe runs - because every other frame in every probe has no decal on the floor at all. */
  const SPLAT = `;(()=>{let s=987654;const rr=(a,b)=>{s=(s*1103515245+12345)&0x7fffffff;return b+(a-b)*(s/0x7fffffff);};for(let k=0;k<60;k++)addGroundSplat(P.x+rr(8,-8),P.y+rr(8,-8),0.5+rr(0,0.4),'blood');for(let k=0;k<12;k++)addGroundSplat(P.x+rr(6,-6),P.y+rr(6,-6),0.9+rr(0,0.4),'scorch')})()`;
  // a camera a cell from the western border looking OUT of the map: CAMSET's longest-ray yaw points the solver away from the border, which makes every out-of-map branch unreachable for every gate
  const LOOKOUT = `;(()=>{let by=1;for(let y=1;y<MH-1;y++)if(!isSolid(1.5,y+.5)){by=y;break;}` +
    `P.x=1.5;P.y=by+.5;P.ang=Math.PI;P.pitch=BH*0.02;P.z=floorAt(P.x,P.y);for(const e of ENEMIES)e.state='sleep';})()`;
  /* Depth agreement (PR #44): occlusion is one value per PIXEL now, and the pixels the ground pass
     queues are exactly the ones where the ROW's distance is the WRONG distance - at the lip of a step
     the colour comes from another plane while the row's fill left its own. So "every ground pixel
     writes the distance it computed" can only be checked where the deferred path runs, which is
     nowhere a shipped level goes. This records which pixels the renderer itself decided to defer, by
     wrapping groundPixel around the ground-only repaint below and restoring it immediately (the
     determinism replay must not run through a wrapper, and no timing is asserted here). */
  run('var ZD={a:[],set:new Uint8Array(0),n:0};');
  const ZRESET = '(()=>{if(ZD.set.length<BW*BH)ZD.set=new Uint8Array(BW*BH);else ZD.set.fill(0);'
    + 'ZD.a.length=0;ZD.n=0})()';
  const ZON = `(()=>{if(!globalThis.__gpO){globalThis.__gpO=groundPixel;const O=groundPixel;groundPixel=` +
    `function(x,pl,row){ZD.set[row+x]=1;if((ZD.n++&31)===0&&ZD.a.length<12288)ZD.a.push(x,row,pl);` +
    `return O.apply(this,arguments)}}})()`;
  const ZOFF = '(()=>{if(globalThis.__gpO){groundPixel=globalThis.__gpO;globalThis.__gpO=null}})()';
  /* Per config: what to poke, and which half of the frame has to move. 'still' is the assertion that
     a floor row and a ceiling row are solved against DIFFERENT planes; 'move' is the one that says
     the solver reads the grid at all. A floor poke CAN legitimately move a ceiling - ceilAt takes
     the tallest neighbouring floor - which is why stepUp and eyeUp are 'any' up there, while pit and
     stripes, whose sunk bands put their own ceiling at or below the eye and so fall back to the
     row's plane, are 'still'. */
  const cfgs = [
    ['flat', '', 'any', 'any'],
    // every wall in the level gets a 3-unit ceiling: the upper half must move, the floor must not
    ['tallRoom', 'for(let i=0;i<MW*MH;i++)if(!MAP.cell[i])MAP.cz[i]=12', 'still', 'move'],
    // the floor drops a metre beyond 3 m, WALL COLUMNS WITH IT: a sunken band whose bounding wall
    // stops at the higher floor has a face of span 0, which is a grid fault, not a renderer one,
    // and the faces line below is what proves the config is legal before it blames the pass
    ['pit', '(()=>{for(let i=0;i<MW*MH;i++){const x=i%MW,y=(i/MW)|0;if(Math.hypot(x+0.5-P.x,y+0.5-P.y)>3)MAP.fz[i]-=4;}})()' + CARRY, 'move', 'still', false, false, true],
    // every other 4-column band is a metre down, walls included: maximum plane churn per row while
    // every boundary keeps a face of positive span, and ceilAt of a sunk band lands below the eye
    ['stripes', 'for(let i=0;i<MW*MH;i++)if(((i%MW)>>2)&1)MAP.fz[i]-=4' + CARRY + SPLAT, 'move', 'still', true, true, true],
    // the border-facing camera: rays that LEAVE the level, so the out-of-map fallbacks run at all.
    // It queues NO deferred pixel though, and that is the rule rather than a gap: a column outside the
    // map has no plane of its own, so those pixels keep the row's predictor (wantDepth stays false).
    ['border', 'for(let i=0;i<MW*MH;i++)if(((i%MW)>>2)&1)MAP.fz[i]-=4' + CARRY + LOOKOUT, 'move', 'any', false, true, false],
    // a platform 0.25 up beyond 2 m: the case with no riser to draw, must not show far geometry
    ['stepUp', '(()=>{for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;const d=Math.hypot(x+0.5-P.x,y+0.5-P.y);if(d>2&&d<=7)MAP.fz[i]+=1;}})()', 'move', 'any', false, false, true],
    // the eye stands on the raised band, so the row predictor comes from floorAt, not from eyeZ
    ['eyeUp', '(()=>{for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;if(Math.hypot(x+0.5-P.x,y+0.5-P.y)<=1.5)MAP.fz[i]+=1;}P.z=floorAt(P.x,P.y)})()', 'move', 'any', false, false, true]
  ];
  let bad = 0;
  for (let li = 0; li < run('LEVELS.length'); li++) {
    let ref = null, refF = null, flatMean = 0;
    console.log(`level ${li}`);
    for (const [name, poke, wantFloor, wantCeil, wantDecals, wantOutMap, wantDepth] of cfgs) {
      seedRng(4242 + li * 31);
      run(`S.mode='play';S.locked=false;startLevel(${li},true);`);
      const cam = run(CAMSET);
      let geo = null, dcov = 0;
      if (poke) {
        run(poke + ';linkBoundaries();');
        dcov = run('(()=>{let m=0;for(let c=0;c<DECAL_MASK.length;c++)if(DECAL_MASK[c])m++;return m})()');
        geo = run(`(()=>{let n=0,bad=0,mn=9e9,mx=-9e9;for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++){const i=y*MW+x;if(MAP.cell[i])continue;for(let d=0;d<4;d++){const nx=x+DIRX[d],ny=y+DIRY[d];if(nx<0||ny<0||nx>=MW||ny>=MH)continue;if(MAP.cell[ny*MW+nx]){const sp=ceilAt(x,y)-faceZ0(x,y,d);n++;if(!(sp>0))bad++;else{if(sp<mn)mn=sp;if(sp>mx)mx=sp;}}}}return{n,bad,mn,mx}})()`);
      }
      /* Two reads of every frame. The composited one carries the brightness and black-fill checks;
         the second repaints every pixel with the ground pass alone, because the wall pass
         legitimately redraws rows the moment a face's z span changes (a taller ceiling retiles the
         wall it caps, including the rows below the eye line) and counting that as the floor solver
         having moved would blame the wrong pass. */
      run('renderWorld()');
      const BW = run('BW'), BH = run('BH'), hInt = run('Math.round(horizon)'), n = BW * BH;
      const full = new Uint32Array(run('px'));
      run(ZRESET + ';' + ZON);
      run('px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));reSolveBad=0;gndOffMap=0;castGround(S.flash,FOGC[0],FOGC[1],FOGC[2]);');
      run(ZOFF);
      const cur = new Uint32Array(run('px'));
      const reS = run('({bad:reSolveBad,off:gndOffMap})');   // this ground pass only, not the renderWorld before it
      let sum = 0, dark = 0, lo = 0, hi = 0, loDiff = 0, hiDiff = 0, fullDiff = 0;
      for (let i = 0; i < n; i++) {
        const c = full[i], L = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
        sum += L; if (L < 2) dark++;
        if (refF && refF[i] !== c) fullDiff++;
      }
      for (let y = 0; y < BH; y++) {
        const lower = y > hInt, row = y * BW;
        for (let x = 0; x < BW; x++) {
          const i = row + x;
          if (lower) lo++; else hi++;
          if (ref && ref[i] !== cur[i]) { if (lower) loDiff++; else hiDiff++; }
        }
      }
      const mean = sum / n, loP = ref ? 100 * loDiff / lo : 0, hiP = ref ? 100 * hiDiff / hi : 0;
      /* Depth agreement. For a sampled deferred pixel the STORED value is turned back into the plane
         it implies (d = dz*BH/|p| inverted), and that plane has to be either the plane the pixel was
         queued with or the plane of the cell the pixel landed in - which is the settle condition the
         solver promises, so it is a check rather than a second solver. A pixel left at the ROW's
         distance implies the row's plane, which differs from its own by at least one quantum, so it
         cannot pass. Dozens of samples per config, no ceilAt/floorAt, no per-pixel scan. */
      const zc = new Float32Array(run('zbuf')), zset = run('ZD.set');
      const st = run('({BW,BH,hz:Math.round(horizon),camX,camY,dirX,dirY,planeX,planeY,eyeZ,ZQ,FARB,'
        + 'N:MAP.w,n:ZD.n,rec:ZD.a.length})');
      const ZA = run('ZD.a'), fzs = new Float64Array(run('MAP.fz')),
        cpl = new Float64Array(run('MAP.ceilPlane')), cel = new Uint8Array(run('MAP.cell'));
      const eX = st.camX | 0, eY = st.camY | 0, eAir = eX >= 0 && eY >= 0 && eX < st.N && eY < st.N && !cel[eY * st.N + eX];
      /* the row's predictor plane, per half of the frame - the same four lines castGround runs */
      const pA = [0, 1].map(ai => {
        const raw = eAir ? (ai ? cpl[eY * st.N + eX] : fzs[eY * st.N + eX] * st.ZQ) : st.eyeZ;
        const ok = ai ? raw > st.eyeZ : raw < st.eyeZ;
        return ok ? raw : (ai ? Math.max(1, st.eyeZ + st.ZQ) : Math.min(0, st.eyeZ - st.ZQ));
      });
      let dTot = 0, dBad = 0, dStale = 0, dCeilS = 0, dWhy = '';
      const rec = st.rec / 3, stepS = Math.max(1, Math.ceil(rec / 48));
      for (let s = 0; s < rec; s += stepS) {
        const x = ZA[s * 3], row = ZA[s * 3 + 1], pl = ZA[s * 3 + 2];
        const p = row / st.BW - st.hz, isF = p > 0, ai = isF ? 0 : 1, absP = isF ? p : -p;
        const got = zc[row + x];
        dTot++; if (!isF) dCeilS++;
        if (!isFinite(got) || !(got > 0)) { dBad++; if (!dWhy) dWhy = 'store ' + got; continue; }
        const dRow = (isF ? st.eyeZ - pA[ai] : pA[ai] - st.eyeZ) * st.BH / absP;
        if (Math.abs(got - dRow) <= Math.max(1e-5, dRow * 1e-6)) {
          dStale++; if (!dWhy) dWhy = `keeps the row's ${dRow.toFixed(2)} at plane ${pl.toFixed(2)}`; continue;
        }
        const cf = x * (2 / st.BW) - 1, rx = st.dirX + st.planeX * cf, ry = st.dirY + st.planeY * cf;
        const implied = isF ? st.eyeZ - got * absP / st.BH : st.eyeZ + got * absP / st.BH;
        const qx = (st.camX + rx * got) | 0, qy = (st.camY + ry * got) | 0;
        let ref2 = pl;                                            // the plane it was queued with
        if (qx >= 0 && qy >= 0 && qx < st.N && qy < st.N && !cel[qy * st.N + qx])
          ref2 = isF ? fzs[qy * st.N + qx] * st.ZQ : cpl[qy * st.N + qx];
        if (Math.abs(implied - ref2) > st.ZQ + 1e-3 && Math.abs(implied - pl) > st.ZQ + 1e-3) {
          dBad++; if (!dWhy) dWhy = `implies z=${implied.toFixed(2)}, the plane there is ${ref2.toFixed(2)}`;
        }
      }
      /* Structure rather than sampling: every pixel the row painted itself must carry the row's own
         distance - the far band included, since that branch fills the row with the same number - and a
         pixel the row did NOT queue must still hold the sentinel in a ceiling row, which is the #45
         carve-out. Deferred pixels are excluded here and covered by the samples above, so this cannot
         double-count a pixel the solver legitimately moved. */
      let hzBad = 0, rowBad = 0, rowTot = 0, farRows = 0, farBad = 0, ceilBad = 0, ceilTot = 0;
      if (st.hz >= 0 && st.hz < st.BH) for (let x = 0; x < st.BW; x++) if (zc[st.hz * st.BW + x] !== Infinity) hzBad++;
      const tolRel = 1e-6;
      for (let y = 0; y < st.BH; y++) {
        const p = y - st.hz;
        if (!p) continue;
        const isF = p > 0, ai = isF ? 0 : 1, absP = isF ? p : -p;
        const dR = (isF ? st.eyeZ - pA[ai] : pA[ai] - st.eyeZ) * st.BH / absP;
        const far = isF && dR > st.FARB;
        if (far && y > st.hz) farRows++;
        for (const fx of [0.13, 0.37, 0.61, 0.87]) {
          const i = y * st.BW + ((st.BW * fx) | 0);
          if (zset[i]) continue;                                   // deferred: the samples cover it
          if (isF) {
            rowTot++;
            if (Math.abs(zc[i] - dR) > Math.max(1e-5, dR * tolRel)) { rowBad++; if (far) farBad++; }
          } else { ceilTot++; if (zc[i] !== Infinity) ceilBad++; }
        }
      }
      let fail = '';
      /* The absolute band only catches the frame that went grey or blew out. The regression this
         repo paid for was 9 points of level-0 exposure, which sits comfortably inside that band, so
         a poked frame is also judged against the flat frame of the same level: moving planes alone
         moves very little (|delta| <= 6 measured over three levels x five configs), and a shading
         change that drags a whole room further than that is the thing being guarded here. */
      if (!(mean >= 40 && mean <= 150)) fail += ' MEAN-OUT-OF-BAND';
      // NO relative exposure check here, on purpose: tallRoom moves a ceiling five times further
      // away, which is 12 points of fog on level 2 and CORRECT. Exposure parity against origin/main
      // is gated by `view.js exposure` on the shipped flat levels, and cross-talk between the two
      // planes is asserted far sharper below - floor rows or ceiling rows pixel-for-pixel unchanged
      // when only the other plane moved. Loosening the halves to chase a mean would trade a real
      // assertion for a weaker one.
      if (100 * dark / n > 1.5) fail += ' BLACK-FILL';
      if (geo && geo.bad) fail += ' FACE-SPAN-FAULT';
      if (poke && fullDiff < n * 0.002) fail += ' NO-EFFECT';
      if (wantFloor === 'still' && loP > 0.2) fail += ' FLOOR-MOVED-WRONGLY';
      if (wantFloor === 'move' && loP < 2) fail += ' FLOOR-IGNORED';
      if (wantCeil === 'still' && hiP > 0.2) fail += ' CEILING-MOVED-WRONGLY';
      // and its mirror: solving a plane against a SOLID column drifts ~20% of the ceiling rows here,
      // which is the grey-frame bug in embryo
      if (wantCeil === 'move' && hiP < 2) fail += ' CEILING-IGNORED';
      // the deferred pixel body's decal blend has to run somewhere, or its copy of the blend is untested
      if (wantDecals && !dcov) fail += ' NO-DECAL-COVERAGE';
      // a re-solve that ran out of tries places the pixel on a plane its own cell contradicts
      if (reS.bad) fail += ' RE-SOLVE-NOT-CONVERGED';
      // the deferred columns are the only pixels whose depth the row's fill cannot be trusted for, so
      // a config that claims to poke them has to actually queue some, or the depth check above is vacuous
      if (wantDepth && !st.n) fail += ' NO-DEFERRED-COVERAGE';
      if (dStale) fail += ' DEFERRED-STALE-DEPTH';
      if (dBad) fail += ' DEPTH-DISAGREES';
      if (hzBad) fail += ' HORIZON-DEPTH';
      if (rowBad) fail += ' ROW-DEPTH';
      if (ceilBad) fail += ' CEILING-SENTINEL';
      // and the out-of-map fallbacks have to be executed by the config that claims to cover them
      if (wantOutMap && !reS.off) fail += ' NO-OUTMAP-COVERAGE';
      if (fail) bad++;
      console.log(`  ${pad(name, 9)} mean ${pad(mean.toFixed(1), 5)}` +
        (poke ? ` (${mean - flatMean >= 0 ? '+' : ''}${(mean - flatMean).toFixed(1)})` : '          ') +
        `  black ${(100 * dark / n).toFixed(2)}%` +
        `  moved floor ${loP.toFixed(2)}%  ceiling ${hiP.toFixed(2)}%` +
        (geo ? `  faces ${geo.n} span ${geo.n ? geo.mn + '..' + geo.mx : '-'} bad ${geo.bad}` : '') +
        (wantDecals ? `  decal cells ${dcov}` : '') +
        `  re-solves bad ${reS.bad} off-map ${reS.off}` +
        `  eye ${cam.x.toFixed(1)},${cam.y.toFixed(1)} sight ${cam.d.toFixed(1)}m  ${fail ? 'FAIL' + fail : 'ok'}`);
      console.log(`  ${pad('depth', 9)} ${dTot}/${st.n} deferred sampled, ` +
        `${dStale ? dStale + ' STALE (row distance)' : dBad ? dBad + ' disagree' : 'all agree'}` +
        `${dCeilS ? `, ${dCeilS} in ceiling rows (store their own depth: #45)` : ''}` +
        `  rows ${rowTot} ok${rowBad ? ' ' + rowBad + ' BAD' : ''} (far band ${farRows}${farBad ? ' bad ' + farBad : ''})` +
        `  horizon ${hzBad ? 'BROKEN' : 'sentinel ok'}  ceiling ${ceilBad ? ceilBad + '/' + ceilTot + ' NOT sentinel' : ceilTot + ' sentinel'}` +
        `${dWhy ? '  ' + dWhy : ''}`);
      // determinism now runs on EVERY config and on the ground-only repaint: it used to sit under `if (!poke)`, i.e. on `flat` alone - the one config whose RX/RP queue is provably empty, so the deferred pixel body had no coverage while this printed ok
      seedRng(4242 + li * 31);
      run(`S.mode='play';S.locked=false;startLevel(${li},true);`);
      run(CAMSET);
      if (poke) run(poke + ';linkBoundaries();');
      run('renderWorld();px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));castGround(S.flash,FOGC[0],FOGC[1],FOGC[2]);');
      const again = new Uint32Array(run('px'));
      let rms = 0;
      for (let i = 0; i < n; i++) if (again[i] !== cur[i]) rms++;
      /* the GROUND pixels of the replay, not the composited frame: the portal cycles on S.t and
         pickups bob on their own phase, so a replayed level is not supposed to be identical up
         there, and a diff measured on the composite would be a lie about determinism. */
      if (rms) { bad++; console.log(`  replay    ${rms} ground pixels differ from the same seed: the pass is not deterministic FAIL`); }
      if (!poke) { ref = cur; refF = full; flatMean = mean; }   // every poked frame is judged against the FLAT one
    }
  }
  console.log(bad ? `heights: ${bad} config(s) FAILED` : 'heights: all configs ok');
  process.exit(bad ? 1 : 0);
}

if (MODE === 'contrast') {
  // Do the characters separate from the room they are standing in? Rendering the world twice,
  // once with ENEMIES emptied, makes the difference EXACTLY the enemy silhouette - no projection
  // math, no depth test guesswork, no dependence on how drawBillboard picks pixels. What matters
  // for readability is the CONTRAST ALONG THAT SILHOUETTE'S EDGE, not the average over the body:
  // a dark enemy on a dark wall is invisible even when its interior is perfectly shaded.
  run('S.mode="play"; S.locked=false;');
  for (let cam = 0; cam < 3; cam++) {
    run(`startLevel(${LVL}, true); S.mode='play';`);
    run(`(()=>{
      const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
      const c=cs.length?cs[((cs.length*0.31+${cam})|0)%cs.length]:[P.x|0,P.y|0];
      P.x=c[0]+.5;P.y=c[1]+.5;P.pitch=0;P.z=floorAt(P.x,P.y);
      // cam 0 looks down the longest sight line, cam 1 looks AT the nearest enemy, cam 2 parks
      // the nearest enemy 3.5 m in front of the lens: the first measures specks on the horizon,
      // the last measures the silhouette at the size a player actually has to read it, and with
      // only ~0.2% of pixels covered an average is easily dominated by one lucky wall.
      if (${cam} === 1 && ENEMIES.length) {
        let be=null,bd=1e9;
        for(const e of ENEMIES){if(e.state==='dead')continue;const d=Math.hypot(e.x-c[0]-.5,e.y-c[1]-.5);if(d<bd){bd=d;be=e;}}
        if(be)P.ang=Math.atan2(be.y-P.y,be.x-P.x);
      } else {
        let best=0,bd=-1;
        for(let k=0;k<48;k++){const a=k*Math.PI/24;
          const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;
          if(d>bd){bd=d;best=a;}}
        P.ang=best;
      }
      if (${cam} === 2 && ENEMIES.length) {
        const fw = castRayDist(P.x, P.y, Math.cos(P.ang), Math.sin(P.ang), 8).dist;
        const d = Math.min(3.5, Math.max(1.2, fw * 0.7));
        const e = ENEMIES.find(e => e.state !== 'dead') || ENEMIES[0];
        e.x = P.x + Math.cos(P.ang) * d; e.y = P.y + Math.sin(P.ang) * d;
        e.z = floorAt(e.x, e.y); e.ang = P.ang + Math.PI; e.movingAmt = 0;
      }
      for(const e of ENEMIES)e.state='sleep';
    })()`);
    run('S.t = 3.5; renderWorld()');
    const A = new Uint32Array(run('px'));
    run('ENEMIES.length = 0; renderWorld()');
    const B = new Uint32Array(run('px'));
    const W = run('BW'), H = run('BH');
    const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);
    const cov = new Uint8Array(W * H);
    let cover = 0, dsum = 0, csum = 0, lost = 0, edge = 0, en = 0, ez = 0;
    for (let i = 0; i < W * H; i++) {
      const d = Math.abs(lum(A, i) - lum(B, i));
      if (d > 4 || (A[i] >>> 24) - (B[i] >>> 24) !== 0) { cov[i] = 1; cover++; dsum += d; ez++; }
    }
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!cov[i] || (cov[i - 1] && cov[i + 1] && cov[i - W] && cov[i + W])) continue;
      // silhouette boundary pixel: compare the two renders where the enemy is NOT
      const j = cov[i - 1] ? i + 1 : cov[i + 1] ? i - 1 : cov[i - W] ? i + W : i - 1;
      const dA = Math.abs(lum(A, i) - lum(B, j)), dB = Math.abs(lum(A, j) - lum(A, i));
      const d = Math.max(dA, dB);
      edge += d; en++;
      const dl = Math.abs(lum(A, i) - lum(B, j));
      if (dl < 10) lost++;
      csum += (Math.abs((A[i] & 255) - (B[j] & 255)) + Math.abs((A[i] >> 8 & 255) - (B[j] >> 8 & 255)) + Math.abs((A[i] >> 16 & 255) - (B[j] >> 16 & 255))) / 3;
    }
    const pct = (100 * cover / (W * H)).toFixed(1);
    const body = ez ? (dsum / ez).toFixed(0) : '0';
    const ed = en ? (edge / en).toFixed(0) : '0';
    console.log('cam ' + cam + '  cover ' + pct + '%  body dL ' + body + '  edge dL ' + ed +
      '  edge dRGB ' + (en ? (csum / en).toFixed(0) : '0') + '  lost ' + (en ? (100 * lost / en).toFixed(0) : '0') +
      '%' + (en === 0 ? '  NO ENEMY IN FRAME' : +ed < 24 ? '   WEAK - silhouettes merge into the room' : '   READS'));
  }
}

if (MODE === 'viewmodel') {
  run('S.mode="play"; S.locked=false; startLevel(0, true);');
  const DW = run('DW'), DH = run('DH');
  const states = [
    ['hip', ''], ['ads', 'P.ads=1'], ['recoil', 'P.kick=WEAPONS[P.weapon].kick;S.muzzle=1'],
    ['reload', 'P.reloadT=WEAPONS[P.weapon].reload*0.5'], ['reload-mid', 'P.reloadT=WEAPONS[P.weapon].reload*0.2'],
    ['swap', 'P.swapT=0.3'], ['sprint', 'P.sprint=1;P.bobPhase=1.2;keys.KeyW=1'], ['airborne', 'P.air=true;P.vz=3'],
  ];
  let bad = 0, hip = null, flashNote = '';
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
      // The flash must leave along the BORE, not across it. Comparing the hip bbox (muzzle 0)
      // with the recoil bbox (muzzle 1) isolates the flash geometry with no game-side hook: the
      // muzzle used to be emitted along +x, so a flash that grew wider than it grew up is a bug.
      if (name === 'hip') hip = frac;
      if (name === 'recoil') {
        const up = hip[2] - frac[2], right = frac[1] - hip[1];
        if (up < right) problems.push('flash grows sideways, not along the bore (up ' + up.toFixed(2) + ' DH, right ' + right.toFixed(2) + ' DW)');
        flashNote = 'flash up ' + up.toFixed(2) + ' DH / right ' + right.toFixed(2) + ' DW';
      }
      console.log(('w' + wi + ' ' + name).padEnd(16), 'paths ' + String(VR.fills).padStart(3),
        'bbox x ' + frac[0].toFixed(2) + '-' + frac[1].toFixed(2), ' y ' + frac[2].toFixed(2) + '-' + frac[3].toFixed(2),
        flashNote ? '| ' + flashNote : '',
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
  const kinds = (process.env.KIND || 'grunt,hound,brute').split(',').filter(s => s), PH = 6, YAW = 6, HH = 150;
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
