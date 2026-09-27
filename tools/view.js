/* Headless viewer: boots the game like smoke.js and writes PNGs so the procedural
   assets and the raycaster output can actually be looked at without a browser.

   node tools/view.js sheets            -> /tmp/fps_tex.png  (materials + sprites)
   node tools/view.js scene [lvl] [n]   -> /tmp/fps_scene.png (framebuffer, sector lvl, camera n)
   node tools/view.js mip             streak metric for the ground mip selection (#19): one line
                              per level, plus the 1-D and mush controls it is judged against
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
  /* ---- M3 step 3: a level START has to seat the feet on the grid the level ended up with.
     genLevel derives P.z from the grid inside itself, so the fresh path self-heals; the paths that
     do not run resetRun (nextLevel, retry, again) only ever get whatever genLevel happened to
     write before its last poke at the grid, and vertical state (P.air / P.vz) is never re-seated at
     all. So every entry path is asserted, and the raised band is authored the way step 4 will
     author it - MAP.fz written at the end of generation, then linkBoundaries(), which is what keeps
     ceilPlane honest about the poke (view.js planes is the gate for that). */
  console.log('spawn altitude');
  run(`(()=>{ if (globalThis.__genReal) return;
    globalThis.__genReal = genLevel; globalThis.__spawnBand = 0; globalThis.__spawnPlateau = 0;
    genLevel = function (li) {
      const r = globalThis.__genReal(li), dq = globalThis.__spawnBand;
      if (dq) {
        // Two pokes, both legal by construction on any geometry, because a poke that makes a face
        // span 0 blames the renderer instead of the code under test (view.js vert's SPANS rule).
        // A BLOCK of +-2 columns rises at most 2 quanta: a one-unit room then keeps a face of 0.5.
        // Anything taller raises the WHOLE grid, so every face keeps the span it already had.
        if (globalThis.__spawnPlateau) { for (let i = 0; i < MW * MH; i++) MAP.fz[i] += dq; }
        else {
          const sx = P.x | 0, sy = P.y | 0;
          for (let y = Math.max(0, sy - 2); y <= Math.min(MH - 1, sy + 2); y++)
            for (let x = Math.max(0, sx - 2); x <= Math.min(MW - 1, sx + 2); x++) MAP.fz[y * MW + x] += dq;
        }
        linkBoundaries();
      }
      return r;
    }; })()`);
  /* A level entry, performed the way the game performs it: PRE's startLevel puts the player on the
     flat grid, then the band is raised and the level is started again through the path under test. */
  const ENTER = (li, fresh, dq, vz, plateau) => `S.mode='play';S.locked=false;S.diff=1;globalThis.__spawnBand=0;` +
    `globalThis.__spawnPlateau=0;startLevel(${li},true);P.hp=100;globalThis.__spawnBand=${dq};` +
    `globalThis.__spawnPlateau=${plateau};` +
    (vz ? `P.air=true;P.vz=${vz};` : '') + `startLevel(${li},${fresh ? 'true' : 'false'});` +
    `for(const e of ENEMIES)e.state='sleep';for(const k in keys)delete keys[k];P.crouch=0;`;
  const PEEK = `({z:P.z,f:floorAt(P.x,P.y),air:P.air?1:0,vz:+P.vz.toFixed(4),` +
    `q:MAP.fz[((P.y|0)*MW+(P.x|0))],solid:isSolid(P.x,P.y)?1:0,` +
    `below:(P.z<floorAt(P.x,P.y)-1e-9)?1:0,cap:+((cfg.eye+P.z)-clamp(cfg.eye+P.z,0.12,1.4)).toFixed(4)})`;
  /* The consequence, not just the number: 60 frames of standing still. Feet below the column's own
     floor means the step-up eases the camera out of the slab, and a carried-over vz runs the fall
     integration against a floor that was never left, which costs health for a fall that never did. */
  const SETTLE = `(()=>{const s=[];for(let i=0;i<60;i++){update(1/60);` +
    `s.push([+P.z.toFixed(6),+floorAt(P.x,P.y).toFixed(4),P.air?1:0]);}return` +
    `{off:s.filter(r=>Math.abs(r[0]-r[1])>1e-9).length,air:s.filter(r=>r[2]).length,hp:+P.hp.toFixed(3)}})()`;
  const LEGAL = `(()=>{let tot=0,bad=0;for(let i=0;i<MW*MH;i++){if(!MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;` +
    `for(let d=0;d<4;d++){const nx=x+DIRX[d],ny=y+DIRY[d];if(nx<0||ny<0||nx>=MW||ny>=MH||MAP.cell[ny*MW+nx])continue;` +
    `tot++;if(!(ceilAt(x,y)-faceZ0(x,y,d)>0))bad++;}}return{tot:tot,bad:bad}})()`;
  const spawnRow = (label, li, fresh, dq, vz, plateau) => {
    run(ENTER(li, fresh, dq, vz, plateau || 0));
    const r = run(PEEK), st = run(SETTLE), lg = run(LEGAL);
    const ok = r.z === r.f && !r.below && !r.air && r.vz === 0 && !r.solid && !lg.bad &&
      !st.off && !st.air && st.hp === 100;
    VROW(label, ok, `P.z ${r.z} vs floorAt ${r.f} (spawn column ${r.q} quanta), feet below the floor ` +
      `${r.below ? 'YES' : 'no'}, airborne ${r.air}, vz ${r.vz}, in geometry ${r.solid} | faces ` +
      `${lg.tot - lg.bad}/${lg.tot} legal | then ${st.off}/60 frames off the floor, airborne ${st.air}, ` +
      `hp ${st.hp}` + (r.cap ? ` | render eye capped ${r.cap} below the grid` : ''));
  };
  for (let li = 0; li < run('LEVELS.length'); li++) {
    spawnRow('L' + li + ' spawn on flat ground (new game)', li, true, 0, 0);
    spawnRow('L' + li + ' spawn on flat ground (level change)', li, false, 0, 0);
    spawnRow('L' + li + ' entering a level airborne', li, false, 0, -7);
    spawnRow('L' + li + ' spawn on a +1-quantum band (level change)', li, false, 1, 0);
    spawnRow('L' + li + ' spawn on a +2-quantum band (new game)', li, true, 2, 0);
    spawnRow('L' + li + ' spawn on a +2-quantum band (level change)', li, false, 2, 0);
    spawnRow('L' + li + ' spawn on a +4-quantum plateau (level change)', li, false, 4, 0, 1);
  }
  run(`if(globalThis.__genReal){genLevel=globalThis.__genReal;globalThis.__genReal=null;globalThis.__spawnBand=0;}`);
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

  /* The same claim one level down: MAP.vb must be a pure function of MAP.fz as well as of the walls.
     Raise a boundary and put it back and no blocker may remain - a relink that can only ADD blocking
     leaves an invisible wall wherever a grid was ever revised - while an authored ladder bit must
     survive the relink that clears the derived ones, since that is what makes it authored. */
  const idem = vm.runInContext(`(function(){
    startLevel(0, true);
    const N = MAP.w, k = MAP.cell.length, v0 = MAP.vb.slice(), fz0 = MAP.fz.slice();
    let sx = -1, sy = -1;
    for (let y = 1; y < N - 1 && sx < 0; y++) for (let x = 1; x <= N - 8; x++) {
      let ok = true;
      for (let j = 0; j < 7; j++) if (MAP.cell[y * N + x + j]) { ok = false; x += 6; break; }
      if (ok) { sx = x; sy = y; }
    }
    if (sx < 0) return { skip: 'NO-RUN' };
    const base = sy * N + sx;
    let lad = -1;
    for (let j = 0; j < k; j++) if (!MAP.cell[j] && (j < base || j > base + 6)) { lad = j; break; }
    if (lad >= 0) MAP.vb[lad] |= (VB_LADDER << 0);
    for (let j = 1; j <= 6; j++) MAP.fz[base + j] += 2;
    linkBoundaries();
    const blockedUp = (MAP.vb[base] & VB_BLOCK) ? 1 : 0;
    for (let j = 1; j <= 6; j++) MAP.fz[base + j] -= 2;
    linkBoundaries();
    let stale = 0, first = -1;
    for (let j = 0; j < k; j++) {
      if (j === lad) continue;
      if (MAP.vb[j] !== v0[j]) { stale++; if (first < 0) first = j; }
    }
    let restored = true;
    for (let j = 0; j < k; j++) if (MAP.fz[j] !== fz0[j]) { restored = false; break; }
    return { skip: null, cells: k, run: base, stale: stale, first: first, restored: restored ? 1 : 0,
      blockedUp: blockedUp, lad: lad, ladKept: (lad >= 0 && (MAP.vb[lad] & VB_LADDER)) ? 1 : 0 };
  })()`, ctxVm);
  const idemOk = !idem.skip && idem.restored && idem.stale === 0 && idem.blockedUp === 1 && idem.ladKept === 1;
  console.log(`relink vb    ${idem.skip || 'run at cell ' + idem.run}  raised blocks ${yn(idem.blockedUp)}  ` +
    `grid restored ${yn(idem.restored)}  stale blockers ${idem.stale}` +
    `${idem.first >= 0 ? ' (first at cell ' + idem.first + ')' : ''}  authored ladder kept ${yn(idem.ladKept)}` +
    `  ${idem.skip ? idem.skip : idemOk ? 'RELINK-VB ok' : 'RELINK-VB FAIL'}`);
  process.exit(staleAll || !stOk ? 1 : 0);  // a derived array that disagrees with its formula is a verdict, not a footnote
}

if (MODE === 'mip') {
  /* Issue #19: the ground pass picked its mip from ONE axis of the pixel's world footprint - the u
     component of the row delta, with its v component weighted 0.001 - while the footprint of a
     ground pixel is a long thin strip whose long axis points down the column: |plane|*step*d along
     a row against |ray|*d/|p| down one, and d itself is dz*BH/|p|, so the column axis grows as 1/p^2
     toward the horizon. Selecting from one axis takes a mip far too small and the pass then POINT
     samples it, which is the streaking in every screenshot that shows a ceiling. At the heading this
     probe's camera takes, planeX is 0, so the old term read a footprint of exactly 0 and held mip 0
     on 327 of 327 textured rows.

     So measure the picture instead of the formula: render the ground pass ALONE (no walls to hide it
     and no z-buffer guessing), and take the mean absolute luminance step DOWN A COLUMN, normalised
     by the mean so an exposure shift cannot masquerade as a fix. Ceiling and floor halves are
     reported separately because they are separate plane lookups.

     Two controls run in the same process, because a smoothness metric can always be satisfied by
     blurring the frame, and a probe that cannot fail is worthless:
       CONTROL 1-D   MIPAX=0, the selection this shipped with. Must be WORSE (higher streak).
       CONTROL MUSH  MAP.floorTex/ceilTex swapped for a chain whose every level is the LAST one, so
                     the tiling stays exact (ms = sc*m.w wraps the tile at 1/sc = tileF either way)
                     and any selection whatsoever renders mush. Its streak is low BY CONSTRUCTION,
                     which is why the fix must stay clearly rougher than it - MUSHMARGIN - and why
                     the along-row detail column is printed next to it.
     The mip histogram comes from the shipped mipSel called on the row's own deltas, with the row's
     distance read back out of zbuf (floor rows carry their unclamped solve there), so it cannot
     drift from the selection under test. Rows the far band fills are excluded from the histogram -
     they hold no texture at all - but not from the gradient, where a flat fill contributes zero to
     both sides of every comparison. MIPAX/MIPAR are restored afterwards; nothing here writes a file. */
  const MUSHMARGIN = 1.15;
  const GROUND = 'px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));castGround(S.flash,FOGC[0],FOGC[1],FOGC[2]);';
  const MUSHON = `(()=>{globalThis.__mt={};for(const k of ['floorTex','ceilTex']){const t=MAP[k]||(k==='floorTex'?FLOORS.CONCRETE:CEILS.CONCRETE);const last=t.mips[t.mips.length-1];globalThis.__mt[k]=MAP[k]||null;MAP[k]={w:t.w,h:t.h,data:t.data,tiles:true,mips:t.mips.map(()=>last)}}})()`;
  const MUSHOFF = '(()=>{if(globalThis.__mt){MAP.floorTex=globalThis.__mt.floorTex;MAP.ceilTex=globalThis.__mt.ceilTex;globalThis.__mt=null}})()';
  const sel = (ax, ar, mush) => {
    run(`MIPAX=${ax};MIPAR=${ar};` + (mush ? MUSHON : MUSHOFF));
    run(GROUND);
    const st = run('({BW,BH,hz:Math.round(horizon),FARB,zb:zbuf,rows:(()=>{const h=[0,0,0,0,0,0,0],e=[0,0],sb=2/BW,hz=Math.round(horizon),' +
      'fT=(MAP.floorTex||FLOORS.CONCRETE),cT=(MAP.ceilTex||CEILS.CONCRETE),scF=1/(MAP.floorTile||1.15),scC=1/(MAP.ceilTile||0.9),' +
      'eIdx=((camY|0)*MAP.w+(camX|0))|0,air=(camX|0)>=0&&(camY|0)>=0&&(camX|0)<MAP.w&&(camY|0)<MAP.w&&!MAP.cell[eIdx],' +
      'cz=air?MAP.ceilPlane[eIdx]:Math.max(1,eyeZ+ZQ);' +
      'for(let y=0;y<BH;y++){const p=y-hz;if(!p)continue;const isF=p>0,absP=p>0?p:-p;' +
      'const dRaw=isF?zbuf[y*BW]:((cz-eyeZ)*BH/absP);if(dRaw>FARB)continue;' +
      'const d=Math.min(dRaw,FARB*4),cf=d/absP,tex=isF?fT:cT,sc=isF?scF:scC;' +
      'const k=mipSel(planeX*sb*d,planeY*sb*d,dirX*cf,dirY*cf,sc,tex);h[k]++;if(k===tex.mips.length-1)e[1]++;else e[0]++}' +
      'return {h,e}})()})');
    run(MUSHOFF);
    const d = new Uint32Array(run('px'));
    const { BW, BH, hz, FARB } = st;
    const L = new Float64Array(BW * BH);
    let cSum = 0, cN = 0, fSum = 0, fN = 0;
    for (let y = 0; y < BH; y++) {
      const p = y - hz, r = y * BW;
      for (let x = 0; x < BW; x++) {
        const c = d[r + x], v = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
        L[r + x] = v;
        if (p < 0) { cSum += v; cN++; } else if (p > 0) { fSum += v; fN++; }
      }
    }
    const acc = { dyC: 0, dyF: 0, dx: 0, n: 0 };
    for (let y = 0; y + 1 < BH; y++) {
      const p = y - hz, q = y + 1 - hz;
      if (!p || !q) continue;                                   // a pair touching the horizon row
      const r = y * BW, r2 = r + BW, fl = p > 0;
      for (let x = 0; x < BW; x++) {
        const g = Math.abs(L[r2 + x] - L[r + x]);
        if (fl) acc.dyF += g; else acc.dyC += g;
        if (x + 1 < BW) acc.dx += Math.abs(L[r + x + 1] - L[r + x]);
        acc.n++;
      }
    }
    const nc = Math.max(1, acc.n), mL = (cSum + fSum) / Math.max(1, cN + fN);
    let hi = 0;
    for (let i = 0; i < st.rows.h.length; i++) if (st.rows.h[i]) hi = i;
    return { streakC: 1000 * acc.dyC / nc / mL, streakF: 1000 * acc.dyF / nc / mL, detail: 1000 * acc.dx / nc / mL,
      mean: mL, hist: st.rows.h.slice(0, hi + 1), end: st.rows.e[1], rows: st.rows.e[0] + st.rows.e[1] };
  };
  let bad = 0;
  const DEF = run('({ax:MIPAX,ar:MIPAR})');
  if (process.env.AR) DEF.ar = +process.env.AR;          // sweep the ratio clamp to re-justify MIPAR
  for (let li = 0; li < run('LEVELS.length'); li++) {
    const per = [[], [], []];
    for (let k = 0; k < 2; k++) {
      seedRng(771 + li * 31 + k * 7);
      run(`S.mode='play';S.locked=false;startLevel(${li},true);`);
      // longest sight line, then the same cell turned 45 deg: the axis-aligned heading is where the
      // old term collapsed to zero, the diagonal is where it still read something
      run(`(()=>{const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
        const c=cs[((cs.length*0.31)|0)%cs.length];let best=0,bd=-1;
        for(let k2=0;k2<48;k2++){const a=k2*Math.PI/24;const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;if(d>bd){bd=d;best=a;}}
        P.x=c[0]+.5;P.y=c[1]+.5;P.ang=best+${k}*Math.PI/4;P.pitch=BH*0.02;P.z=floorAt(P.x,P.y);
        for(const e of ENEMIES)e.state='sleep';})()`);
      run('renderWorld()');
      per[0].push(sel(DEF.ax, DEF.ar, false));
      per[1].push(sel(0, DEF.ar, false));
      per[2].push(sel(DEF.ax, DEF.ar, true));
      run(`MIPAX=${DEF.ax};MIPAR=${DEF.ar};`);
    }
    const avg = a => ({ sc: a.reduce((s, v) => s + v.streakC, 0) / a.length, sf: a.reduce((s, v) => s + v.streakF, 0) / a.length,
      detail: a.reduce((s, v) => s + v.detail, 0) / a.length, mean: a.reduce((s, v) => s + v.mean, 0) / a.length,
      end: a.reduce((s, v) => s + v.end, 0) / a.length, rows: a.reduce((s, v) => s + v.rows, 0) / a.length,
      hist: a[0].hist });
    const [fix, ctl, mush] = per.map(avg);
    const dC = 100 * (fix.sc / ctl.sc - 1), dF = 100 * (fix.sf / ctl.sf - 1);
    const smooth = (fix.sc + fix.sf) / (mush.sc + mush.sf + 1e-9);
    const ok = fix.sc + fix.sf < ctl.sc + ctl.sf &&
      fix.sc + fix.sf > MUSHMARGIN * (mush.sc + mush.sf) && fix.detail > mush.detail * MUSHMARGIN;
    if (!ok) bad++;
    console.log(`level ${li}  streak ceil ${fix.sc.toFixed(0)} (ctl ${ctl.sc.toFixed(0)} ${dC >= 0 ? '+' : ''}${dC.toFixed(0)}%, mush ${mush.sc.toFixed(0)})` +
      `  floor ${fix.sf.toFixed(0)} (ctl ${ctl.sf.toFixed(0)} ${dF >= 0 ? '+' : ''}${dF.toFixed(0)}%, mush ${mush.sf.toFixed(0)})` +
      `  detail ${fix.detail.toFixed(0)} (ctl ${ctl.detail.toFixed(0)}, mush ${mush.detail.toFixed(0)})` +
      `  mean ${fix.mean.toFixed(0)}  mips ${fix.hist.join(',')} chainEnd ${fix.end}/${fix.rows} ${ok ? 'ok' : 'FAIL'}`);
    if (process.env.BANDS) console.log(`         smoothness vs mush ${smooth.toFixed(2)}x (must stay above ${MUSHMARGIN}), detail floor is the mush frame's ${mush.detail.toFixed(0)}`);
  }
  run(`MIPAX=${DEF.ax};MIPAR=${DEF.ar};`);
  console.log(bad ? `${bad} level(s) NOT BETTER THAN THE 1-D CONTROL` : 'MIP ok: two-axis selection beats the 1-D control on every level and is not mush');
  process.exit(bad ? 1 : 0);
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

if (MODE === 'anim') {
  /* #73: does an enemy's body change SHAPE while it walks? Asked literally - diff the body pixels
     between t and t + 0.4 s. Since #72 the mesh path gets no animation input at all
     (js/40_render.js hands MESH.draw {kind,x,y,z,yaw,scale,alpha,flash,tint}) and js/13_mesh.js
     builds its legs "straight for the spike", so a body is one static stance however far it
     walks and a corpse fades in place instead of toppling.

     The mask is the `contrast` technique - render the frame, render it again with ENEMIES emptied -
     so the difference IS the silhouette and nothing else in the world can enter it: the dust a
     footfall just splatted, the cycling portal, cell light, fog and decals are all present in both
     renders and cancel. The `replay` row renders ONE phase twice and must read ~0 changed pixels;
     that is the noise floor which makes every number below mean "the shape moved" rather than
     "something in the room moved".

     The gait is advanced by the game's own updateEnemies on a treadmill: each 1/60 s step the
     enemy walks, advances stepPhase by the real distance travelled, and is teleported back before
     the next one - so translation cannot fake the diff, and a fix that reads some field the game
     never sets cannot satisfy it either. `cd` is pinned huge so no attack starts mid-measurement.
     Death and wind-up are sampled by setting the signals directly (dieT, atkT + the lean the
     update would have damped to), because those states also move or damage the player.
     Poses are quantized into buckets by design, so pairs are measured over >= 0.1 s windows; the
     `distinct` count says the cycle is more than a two-frame shuffle. */
  const W = run('BW'), H = run('BH'), N = W * H;
  const KIND = process.env.KIND || 'grunt';
  const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);
  /* the treadmill: record every body, run ONE real updateEnemies step, put them back. Pinning all
     of them (not just ENEMIES[0]) is what lets the COST lane hold a crowd still while it animates. */
  run('var AX = [], AY = [];');
  const TREAD = `(()=>{const n=ENEMIES.length;for(let i=0;i<n;i++){AX[i]=ENEMIES[i].x;AY[i]=ENEMIES[i].y}` +
    `updateEnemies(1/60);for(let i=0;i<n;i++){ENEMIES[i].x=AX[i];ENEMIES[i].y=AY[i]}P.z=floorAt(P.x,P.y)})()`;
  const step = n => { for (let i = 0; i < n; i++) run(TREAD); };
  const BARE = `(()=>{const keep=[];for(const z of ENEMIES)keep.push(z);ENEMIES.length=0;renderWorld();` +
    `for(const z of keep)ENEMIES.push(z)})()`;
  const DTH = 6;                                   // a body pixel counts as changed past this dL
  const MASKMIN = 800;                             // below this the silhouette is too small to judge
  const MINMOVE = 3.0;                             // % of mask pixels that must change (measured: main 0.0)
  /* zbuf comes along because #74 needs to know where the mesh OCCUPIES a pixel, not where it
     happens to be visible: a body row whose colour matches the wall behind it would otherwise read
     as a gap. The mesh writes its own depth where it draws, so "zbuf nearer than the enemy-free
     frame" is the colour-independent copy of the same question. */
  function shot() {
    run('renderWorld()');
    const A = new Uint32Array(run('px')), zA = new Float32Array(run('zbuf'));
    run(BARE);
    return { A, B: new Uint32Array(run('px')), zA, zB: new Float32Array(run('zbuf')) };
  }
  function maskOf(s) {
    const cov = new Uint8Array(N); let n = 0, top = H, bot = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(lum(s.A, i) - lum(s.B, i)) > 4 || (s.A[i] >>> 24) - (s.B[i] >>> 24) !== 0) {
        cov[i] = 1; n++; if (y < top) top = y; if (y > bot) bot = y;
      }
    }
    return { cov, n, top, bot };
  }
  function cmp(s0, m, s1) {
    let n = 0, sum = 0;
    for (let i = 0; i < N; i++) {
      if (!m.cov[i]) continue;
      const d = Math.abs(lum(s0.A, i) - lum(s1.A, i));
      if (d > DTH) { n++; sum += d; }
    }
    return { n, pct: 100 * n / (m.n || 1), dl: n ? sum / n : 0 };
  }
  let bad = 0, attachBad = 0;
  const row = (name, d, m, note) => {
    const ok = d.pct >= MINMOVE;
    if (!ok) bad++;
    console.log('  ' + name.padEnd(14) + ' changed ' + pad(d.pct.toFixed(1), 5) + '% of ' + pad(m.n, 5) + ' mask px' +
      '  mean dL ' + pad(d.dl.toFixed(0), 3) + '  ' + (ok ? 'MOVES' : 'IDENTICAL - static body') + (note ? '  ' + note : ''));
    return d;
  };
  /* Camera: the open cell with the longest clear sight line, looking down it - the same frame for
     the sweep and for the COST lane, so the two measure the same thing. */
  const CAMCELL = `(()=>{
    const cs=[];for(let y=2;y<MH-2;y++)for(let x=2;x<MW-2;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
    let bc=cs[0],bcv=-1;
    for(const c of cs){let m=0;for(let k=0;k<12;k++){const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(k*TAU/12),Math.sin(k*TAU/12),6).dist;if(d>m)m=d;}if(m>bcv){bcv=m;bc=c;}}
    let best=0,bm=-1;
    for(let k=0;k<64;k++){const a=k*TAU/64,d=castRayDist(bc[0]+.5,bc[1]+.5,Math.cos(a),Math.sin(a),7).dist;if(d>bm){bm=d;best=a;}}
    P.x=bc[0]+.5;P.y=bc[1]+.5;P.ang=best;P.pitch=0;P.z=floorAt(P.x,P.y);
    ENEMIES.length=0;
    return {cell:bc,ray:+bm.toFixed(2)};
  })()`;
  // makeEnemy scatters gait phase, tint and facing: pin them so two runs of this probe agree
  const PIN = `e.anim=0;e.stepPhase=0;e.ph=0;e.tint=[1,1,1];e.state='chase';e.alert=true;e.cd=1e9;` +
    `e.movingAmt=0;e.lean=0;e.atkT=0;e.dieT=0;e.stagger=0;e.ang=Math.atan2(P.y-e.y,P.x-e.x);`;
  /* COST=1: the amortization claim, measured the way #53 measures anything - interleaved batches,
     load per batch, several rounds, never one pair. `rebuild-per-frame` is this same code with the
     pose table switched off (MESH.setCache(false)), i.e. what an unamortized animation would cost;
     main has no table to switch off and no pose input at all, so its run of this lane times the
     static bodies it ships. */
  if (process.env.COST) {
    const os = require('os'), frames = +(process.env.FRAMES || 60), rounds = +(process.env.ROUNDS || 4);
    const hasCache = run('typeof MESH.setCache==="function"');
    const SET = on => hasCache ? 'MESH.setCache(' + on + ');' : '';
    const PARK = `(()=>{${SET('true')}while(ENEMIES.length)PARKED.push(ENEMIES.pop())})()`;
    const UNP = on => `(()=>{${SET(on)}while(PARKED.length)ENEMIES.push(PARKED.pop())})()`;
    const variants = hasCache
      ? [['12 bodies, phase-cache', UNP('true')], ['12 bodies, rebuild per frame', UNP('false')], ['0 bodies (the frame floor)', PARK]]
      : [['12 bodies, static geometry', UNP('true')], ['0 bodies (the frame floor)', PARK]];
    run('var PARKED = [];');
    seedRng(4242);
    run(`S.mode='play'; S.locked=false; startLevel(0, true);`);
    const pl = run(CAMCELL);
    run(`(()=>{const K=['grunt','hound','brute'];for(let i=0;i<12;i++){const a=P.ang+(i/11-0.5)*1.4,d=2.4+(i%4)*0.9;` +
      `const e=makeEnemy(K[i%3],P.x+Math.cos(a)*d,P.y+Math.sin(a)*d);${PIN}e.anim=e.stepPhase=i*0.11;ENEMIES.push(e)}})()`);
    console.log('cost: 12 bodies (4 each of grunt/hound/brute) in a 1.4 rad arc at 2.4-5.1 m, camera at cell ' +
      pl.cell + ', ' + frames + ' frames per batch, ' + rounds + ' interleaved rounds');
    for (let r = 0; r < rounds; r++) for (const [name, toggle] of variants) {
      run(toggle);
      step(24);                                        // warm: each side pays its own first builds
      run('MESH.reset()');                             // so the px/tri counters below are this batch
      /* Timed node-side with hrtime, NOT inside the vm: the harness stubs performance.now() as
         Date.now() (tools/view.js:113), so a per-frame delta inside the sandbox is a whole number of
         milliseconds and a 25 ms frame quantizes to 25 or 26 - which reads as a bimodal benchmark
         when the code under test is uniform. One hrtime pair per batch puts the clock's resolution
         at 0.02 ms per frame, and the batches are interleaved across rounds for the reason #53 gave. */
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < frames; i++) { run(TREAD); run('renderWorld()'); }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames;
      const s = run('(()=>({px:MESH.stats().pxFilled, tris:MESH.stats().tris, parts:PARTS.length,' +
        'decals:(()=>{let m=0;for(let i=0;i<DECAL_MASK.length;i++)if(DECAL_MASK[i])m++;return m})(),' +
        'pose:MESH.stats()}))()');
      console.log('  round ' + r + '  ' + name.padEnd(30) + ms.toFixed(2) + ' ms/frame   load ' +
        os.loadavg()[0].toFixed(2) + '   ' + s.px + ' px by bodies / ' + s.tris + ' tris   pose ' +
        s.pose.poseEntries + '/' + s.pose.poseMB + ' MB, ' + s.pose.poseMade + ' built   scene ' +
        s.parts + ' parts, ' + s.decals + ' decal cells');
    }
    process.exit(0);
  }
  for (let li = 0; li < run('LEVELS.length'); li++) {
    seedRng(4242 + li * 31);
    run(`S.mode='play'; S.locked=false; startLevel(${li}, true);`);
    const pl = run(CAMCELL);
    const setup = run(`(()=>{let t=Math.min(1.9,Math.max(1.3,${pl.ray}*0.7)),ex=P.x+Math.cos(P.ang)*t,ey=P.y+Math.sin(P.ang)*t;` +
      `while(t>0.6&&isSolid(ex,ey)){t-=0.2;ex=P.x+Math.cos(P.ang)*t;ey=P.y+Math.sin(P.ang)*t;}` +
      `const e=makeEnemy('${KIND}',ex,ey);${PIN}ENEMIES.push(e);return +t.toFixed(2)})()`);
    console.log(`level ${li}  buf ${W}x${H}  ${KIND} at ${setup} m, cell ${pl.cell}`);
    step(8);                                            // warm: walking speed reached, facing settled
    const s0 = shot(), s0b = shot();
    const m0 = maskOf(s0);
    if (m0.n < MASKMIN) { bad++; console.log('  mask ' + m0.n + ' px: NO BODY TO JUDGE - the probe cannot pass'); }
    const rp = cmp(s0, m0, s0b);
    if (rp.pct > 0.5) bad++;
    console.log('  replay         changed ' + pad(rp.pct.toFixed(2), 5) + '% of ' + pad(m0.n, 5) + ' mask px  ' +
      (rp.pct > 0.5 ? 'WORLD CHURN FAKES THE DIFF' : 'noise floor, so the rows below are shape'));
    const samples = [s0];
    for (let s = 1; s <= 8; s++) { step(3); samples.push(shot()); }   // 3 steps = 0.05 s
    const seen = new Set();
    for (const s of samples) {
      let h = 0;
      for (let i = 0; i < N; i++) if (m0.cov[i]) h = (h * 31 + s.A[i]) | 0;
      seen.add(h);
    }
    console.log('  walk cycle     ' + seen.size + ' distinct bodies in 9 samples over 0.40 s' +
      (seen.size < 4 ? '  IDENTICAL - no gait' : '  ok'));
    if (seen.size < 4) bad++;
    for (const s of [2, 4, 6, 8]) row('walk +' + (s * 0.05).toFixed(2) + 's', cmp(s0, m0, samples[s]), m0);
    /* death: alpha is exactly 1 until dieT 2.4, so between 0 and 0.4 s any pixel change is geometry
       and nothing else. A topple also lowers the top of the silhouette, which the fade cannot do. */
    run(`(()=>{const e=ENEMIES[0];e.state='dead';e.vx=e.vy=e.svx=e.svy=0;e.dieAng=Math.atan2(P.y-e.y,P.x-e.x)+0.7})()`);
    const ds = [];
    for (const v of [0, 0.1, 0.2, 0.4, 0.55]) { run(`ENEMIES[0].dieT=${v}`); const s = shot(); ds.push({ v, s, m: maskOf(s) }); }
    const d0 = ds[0], d4 = ds[3];
    row('topple +0.40s', cmp(d0.s, d0.m, d4.s), d0.m, 'sil top ' + d0.m.top + ' -> ' + d4.m.top);
    const rise = d0.m.bot - d0.m.top;
    if (rise > 20 && d4.m.top - d0.m.top < rise * 0.15) {
      bad++; console.log('  topple         silhouette top moved ' + (d4.m.top - d0.m.top) + ' px of a ' + rise +
        ' px body: it did not go DOWN - ' + 'IDENTICAL');
    }
    /* wind-up: the same atk progress the billboard used (1 - atkT/wind), with the lean the update
       would have damped to. Full extension lands at pr = 1, which is the frame the shot fires in. */
    run(`(()=>{const e=ENEMIES[0];e.state='chase';e.alert=true;e.dieT=0;e.atkMode='melee';e.cd=1e9;e.movingAmt=0.12})()`);
    const as = [];
    for (const pr of [0, 0.25, 0.5, 0.75]) {
      run(`(()=>{const e=ENEMIES[0];e.atkT=e.type.wind*${(1 - pr).toFixed(3)};e.lean=(-0.07+0.30*Math.sin(Math.PI*${pr}))})()`);
      const s = shot(); as.push({ pr, s, m: maskOf(s) });
    }
    row('windup pr .75', cmp(as[0].s, as[0].m, as[3].s), as[0].m);
    const ps = run('MESH.stats()');
    console.log('  pose table     ' + (ps && ps.poseEntries !== undefined
      ? ps.poseEntries + ' cached vertex sets, ' + ps.poseMB + ' MB (this is what amortizes the rebuild)'
      : 'none - so geometry is rebuilt per enemy per frame'));
  }
  /* ---- #74: are the parts ATTACHED? ------------------------------------------------------
     The same mask as the rows above, read DOWN a column instead of across it: between the run of
     body pixels that is the head and the run that is the torso there must be no run of background.
     A row counts as body if the mesh PAINTED there (the px diff) or WROTE DEPTH there (its zbuf
     nearer than the enemy-free frame's), because either signal alone can be fooled - a body pixel
     that happens to match the wall reads as a gap in colour, and neither can invent coverage that
     is not there. Measured on origin/main 1b2e493, grunt at 2.4 m in the spawn stance: 92-112
     head, 113-120 background, 121-170 torso - 8 rows of daylight on a 151 px body, which is the
     live-page defect in #74 (9 rows of 162 there; the deployments differ in buffer size).
     Poses are the spawn stance, +-60 deg of body-vs-camera yaw and one mid-stride bucket: an exact
     butt still cracks at oblique angles where each box's silhouette edge is solved on its own, and
     #73's buckets move the shoulders, so a rest-pose-only check would be the check that cannot
     fail. */
  const AKIND = run('Object.keys(ETYPE)'), ASPEC = run('Object.keys(MESH.SPEC)');
  const APOSE = [[0, 0, 0, 'spawn'], [-Math.PI / 3, 0, 0, 'yaw -60'], [Math.PI / 3, 0, 0, 'yaw +60'],
  [Math.PI / 6, 0.375, 0.9, 'stride +30']];
  const MINDIA = 3;                                   // a first run this short is not a head
  seedRng(4242);
  run('var APX = 0, APY = 0;');
  run(`S.mode='play'; S.locked=false; startLevel(0, true);`);
  const apl = run(CAMCELL);
  const adist = run(`(()=>{let t=2.4,ex=P.x+Math.cos(P.ang)*t,ey=P.y+Math.sin(P.ang)*t;` +
    `while(t>0.6&&isSolid(ex,ey)){t-=0.2;ex=P.x+Math.cos(P.ang)*t;ey=P.y+Math.sin(P.ang)*t;}` +
    `APX=ex;APY=ey;return +t.toFixed(2)})()`);
  const nospec = AKIND.filter(k => ASPEC.indexOf(k) < 0);
  console.log('attached: ' + AKIND.join('/') + ' bodies at ' + adist + ' m, cell ' + apl.cell + ', every gait bucket named above' +
    (nospec.length ? '\n  NO MESH SPEC for ' + nospec.join('/') + ' - those kinds would silently draw as grunts' : ''));
  if (nospec.length) { bad++; attachBad += nospec.length; }
  for (const k of AKIND) {
    for (const [dy, ph, mv, nm] of APOSE) {
      const ap = run(`(()=>{ENEMIES.length=0;const e=makeEnemy('${k}',APX,APY);${PIN}` +
        `e.ang=Math.atan2(P.y-e.y,P.x-e.x)+${dy};e.anim=${ph};e.movingAmt=${mv};ENEMIES.push(e);` +
        `let r=(e.ang-P.ang-Math.PI)%TAU;if(r>Math.PI)r-=TAU;if(r<-Math.PI)r+=TAU;` +
        `const ex=e.x-camX,ey=e.y-camY;` +
        `return {deg:+(r*180/Math.PI).toFixed(0),` +
        `ax:Math.round((BW*0.5)*(1+(dirY*ex-dirX*ey)/(-planeY*ex+planeX*ey)))}})()`);
      const ydeg = ap.deg;
      const s = shot();
      const m = maskOf(s);
      /* the mask that decides coverage is paint OR depth-written: a leg whose cloth happens to
         match the floor is a body pixel even though the colour diff cannot see it, and a bbox
         taken from colour alone would clip the run list at the wrong row. */
      const cov = new Uint8Array(N);
      let an = 0, top = H, bot = -1, lef = W, rig = -1;
      for (let i = 0; i < N; i++) {
        if (!(m.cov[i] || s.zA[i] < s.zB[i] - 1e-4)) continue;
        cov[i] = 1; an++;
        const y = (i / W) | 0, x = i - y * W;
        if (y < top) top = y; if (y > bot) bot = y;
        if (x < lef) lef = x; if (x > rig) rig = x;
      }
      if (an < MASKMIN) {
        bad++; attachBad++;
        console.log('  ' + k.padEnd(6) + pad(nm, 12) + 'body ' + an + ' px: NO BODY TO JUDGE - the probe cannot pass');
        continue;
      }
      /* The shoulder line, from the silhouette itself: the widest row of a body is its arms plus
         torso, so the first row that reaches most of that width is where the torso starts. Above it
         is neck, below it is legs - and the legs are legitimately off-axis, so the background
         between them (#74's rows 182-245) can never enter the measurement. */
      const span = new Int32Array(bot + 2); let wide = 0;
      for (let y = top; y <= bot; y++) {
        let lo = W, hi = -1;
        for (let x = lef; x <= rig; x++) if (cov[y * W + x]) { if (x < lo) lo = x; if (x > hi) hi = x; }
        span[y] = hi >= lo ? hi - lo + 1 : 0;
        if (span[y] > wide) wide = span[y];
      }
      let shRow = bot;
      for (let y = top; y <= bot; y++) if (span[y] * 10 >= wide * 7) { shRow = y; break; }
      /* The body's own axis, projected: the parts are stacked on the vertical world line through
         the enemy's feet, and a vertical line projects to ONE screen column (pitch moves the
         horizon, not the column), so this is the centre line by construction rather than a guess
         from a bounding box - whose centre drifts off it at oblique yaw, and whose crown-row
         centre lands on a CORNER of the head box's top face. The axis is inside every part, so
         every row above the shoulder line must be body here, and the neck's projected half-width
         is >=3 px at this distance, which is why +-1 is still inside the join. */
      const cols = [ap.ax - 1, ap.ax, ap.ax + 1];
      const rec = [];
      for (const x of cols) {
        const runs = []; let st = -1, seen = false, gap = 0;
        for (let y = top; y <= bot; y++) {
          const on = cov[y * W + x];
          if (on) { if (st < 0) st = y; seen = true; }
          else if (st >= 0) { runs.push([st, y - 1]); st = -1; }
          // rows above this column's OWN head top are beside the head, not between its parts
          if (!on && seen && y < shRow) gap++;
        }
        if (st >= 0) runs.push([st, bot]);
        rec.push({ x, runs, gap });
      }
      const gap = Math.max.apply(null, rec.map(r => r.gap)), h = bot - top + 1;
      const runsTxt = rec.map(r => r.runs.slice(0, 3).map(q => q[0] + '-' + q[1]).join(' ')).join(' | ');
      const noHead = shRow - top < MINDIA;
      if (process.env.ATTASCII) {                          // ATTASCII=1: print the mask, '>' = shRow
        for (let y = top; y <= bot; y += 1) {
          let ln = '';
          for (let x = lef; x <= rig; x++) ln += cov[y * W + x] ? '#' : '.';
          console.log('    ' + String(y).padStart(4) + (y === shRow ? '>' : ' ') + ln);
        }
      }
      if (gap > 0 || noHead) { bad++; attachBad++; }
      console.log('  ' + k.padEnd(6) + pad(nm, 12) + 'yaw ' + pad(ydeg, 4) + 'deg  axis col ' + pad(ap.ax, 4) +
        ' shoulders row ' + pad(shRow, 4) +
        ' runs ' + pad(runsTxt, 26) + ' ' +
        (gap ? 'GAP ' + gap + ' of ' + (shRow - top) + ' head rows = ' + (100 * gap / h).toFixed(1) +
          '% of body height  DETACHED - daylight between head and torso'
          : 'no background between head and torso  ATTACHED') + (noHead ? '  NO HEAD TO JUDGE' : ''));
    }
  }
  const why = [];
  if (bad - attachBad) why.push('bodies are drawn in a static stance');
  if (attachBad) why.push(attachBad + ' pose(s) with DETACHED parts');
  console.log(bad ? 'anim: ' + bad + ' assertion(s) FAILED - ' + why.join('; ')
    : 'anim: bodies change shape while they move and their parts are attached');
  process.exit(bad ? 1 : 0);
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
if (MODE === 'props') {
  /* #76: is the world's FURNITURE geometry, or is it still flat art?
     js/40_render.js:150 dispatches `b.mesh ? MESH.draw(b) : drawBillboard(b)` and #72 deliberately
     left props, pickups, projectiles and the portal on the billboard side of that line, so a barrel
     is a quad of painted sheet while a grunt beside it is a solid body with self-occlusion.

     Every row names the assertion that fired, because on current main they fail for three DIFFERENT
     reasons and a probe that only printed "props: FAIL" would not tell a quad apart from a dark orb:
       (A) the silhouette is geometry, not a quad - a billboard contributes ZERO triangles to
           MESH.stats() and never writes zbuf (only castGround/castWalls and the mesh rasterizer
           write it), so "triangles drawn" and "mask pixels whose depth the object itself wrote" are
           two independent readings of the same question. On main both read 0.
       (S) `scale` is total world height and must port 1:1 (40_render.js:635 centres the quad at
           o.z + scale*0.5, 13_mesh.js:365 puts a vertex at o.z + by*sc). A quad's projected height is
           exactly (BH/t)*scale, a mesh's is that times its own authored span, so this measures the
           convention rather than the art - it passes on main by construction and only bites a fix.
       (F) the feet are ON the floor. The generator authors crates and barrels at a literal z: 0.0
           (20_level.js:397,400), so on a raised band they sink into it. The poke raises every open
           cell beyond 2 m by ONE quantum (+0.25 m), which is a step and not a boundary:
           linkBoundaries blocks at fz[n]-fz[i] > 1 (20_level.js:143), so no riser is drawn and no
           wall can occlude the prop and fake the result. A prop that tracks the floor keeps its
           height and its bottom row rises by (BH/t)*0.25 px; a prop at a literal 0 loses the part of
           itself the floor now covers.
       (E) emissive pixels are exempt from scene light. The billboard routes alpha byte 253 and
           `o.self` around the light term entirely (40_render.js:703); the mesh multiplies every
           triangle by li (13_mesh.js:392,404). Dropping MAP.light to 3% is "the lights are off" -
           AMB stays, so this is a RATIO: an exempt object's luminance is untouched, a lit one falls
           to roughly AMB/(AMB+li). The crate and the barrel are the control half of this row: they
           must fall, or the test cannot fail.
       (K) an unauthored kind cannot RENDER. 13_mesh.js:150 is `SPEC[kind] || SPEC.grunt`, so asking
           for a mesh nobody authored answers with a grunt. That is silent in exactly the direction a
           prop conversion must not be, so it is asserted two ways: drawing a bogus kind must THROW,
           and every kind the game can emit must have counts that are not the grunt's.
     COST=1 measures the census instead of a hand-picked dozen (lamps 6/8/9 + crates 7/8/9 + barrels
     7/9/12 = 20/25/30 props, with 8/11/13 pickups, 20_level.js:9,14,19): interleaved drawn/parked
     batches per level, load and uptime printed per batch. Pairs ALWAYS share a level - genLevel() is
     unseeded (#47/#60), so a cross-level pair compares two different maps; #75 lost 3 of 4 rounds
     that way. */
  const W = run('BW'), H = run('BH'), N = W * H;
  const LI = +(process.argv[3] || 0);
  const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);

  /* COST=1: the census lane, before the single-prop placement below rewrites the arrays. */
  if (process.env.COST) {
    const os = require('os'), frames = +(process.env.FRAMES || 40), rounds = +(process.env.ROUNDS || 5);
    run('var PH = [], PQ = [], PKP = [], PKK = [], PKP2 = [];');
    const PARK = '(()=>{while(PROPS.length)PH.push(PROPS.pop());while(PICKUPS.length)PQ.push(PICKUPS.pop())})()';
    const UNP = '(()=>{while(PH.length)PROPS.push(PH.pop());while(PQ.length)PICKUPS.push(PQ.pop())})()';
    /* The camera BOTH variants get: the open cell with the longest clear sight line, looking down it,
       with the enemies asleep so neither side drifts. At the spawn camera most of a level's props sit
       behind walls and the pre-raster cull in MESH.draw returns before they cost anything, so a
       drawn/parked pair measured THERE prices three props and reports it as twenty-five - which is why
       tris/frame is printed beside ms/frame below. */
    const CAMSEE = `(() => {
      const cs = [];
      for (let y = 2; y < MH - 2; y++) for (let x = 2; x < MW - 2; x++) if (!isSolid(x + .5, y + .5)) cs.push([x, y]);
      let bc = cs[0], bcv = -1;
      for (const c of cs) { let m = 0; for (let k = 0; k < 12; k++) { const d = castRayDist(c[0] + .5, c[1] + .5, Math.cos(k * TAU / 12), Math.sin(k * TAU / 12), 6).dist; if (d > m) m = d; } if (m > bcv) { bcv = m; bc = c; } }
      let best = 0, bm = -1;
      for (let k = 0; k < 64; k++) { const a = k * TAU / 64, d = castRayDist(bc[0] + .5, bc[1] + .5, Math.cos(a), Math.sin(a), 7).dist; if (d > bm) { bm = d; best = a; } }
      P.x = bc[0] + .5; P.y = bc[1] + .5; P.ang = best; P.pitch = 0; P.z = floorAt(P.x, P.y);
      for (const e of ENEMIES) e.state = 'sleep';
      return { cell: bc, ray: +bm.toFixed(2) };
    })()`;
    console.log('props cost: interleaved drawn/parked batches; the parked variant has NO prop or pickup in it');
    console.log('  pairs SHARE a level: genLevel() is unseeded, so a cross-level pair would be two maps');
    for (let li = 0; li < 3; li++) {
      run(`S.mode='play'; S.locked=false; startLevel(${li}, true);`);
      const census = run('(()=>{const c={};for(const p of PROPS)c[p.kind]=(c[p.kind]||0)+1;' +
        'return JSON.stringify({props:PROPS.length,pickups:PICKUPS.length,by:c})})()');
      console.log('  level ' + li + '  census ' + census + '  cam ' + JSON.stringify(run(CAMSEE)));
      const acc = { drawn: [], parked: [] }, tri = { drawn: [], parked: [] };
      for (let r = 0; r < rounds; r++) for (const v of [0, 1]) {
        run(v ? PARK : 'null');
        for (let i = 0; i < 12; i++) run('renderWorld()');          // warm what both variants share
        run('MESH.reset()');                                       // so the denominator is THIS batch
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < frames; i++) run('renderWorld()');
        const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames;
        acc[v ? 'parked' : 'drawn'].push(ms);
        tri[v ? 'parked' : 'drawn'].push(Math.round(run('MESH.stats().tris') / frames));
        run(v ? UNP : 'null');
      }
      const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
      const d = med(acc.drawn), p2 = med(acc.parked);
      console.log('    drawn ' + pad(d.toFixed(2), 6) + ' ms/frame at ' + pad(med(tri.drawn), 6) + ' tris' +
        '   parked ' + pad(p2.toFixed(2), 6) + ' ms/frame at ' + pad(med(tri.parked), 6) + ' tris' +
        '   prop cost ' + pad((d - p2).toFixed(2), 6) + ' ms   load ' + os.loadavg()[0].toFixed(2) +
        '  up ' + process.uptime().toFixed(0) + 's  poses ' + run('MESH.stats().poseEntries'));
      console.log('    batches drawn ' + acc.drawn.map(x => x.toFixed(1)).join('/') +
        '  parked ' + acc.parked.map(x => x.toFixed(1)).join('/'));
    }
    process.exit(0);
  }

  run(`S.mode='play'; S.locked=false; startLevel(${LI}, true);`);
  run('var PKP = [], PKK = [], PKP2 = [];');
  const CAMSET = `(()=>{
    const cs=[];for(let y=2;y<MH-2;y++)for(let x=2;x<MW-2;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
    let bc=cs[0],bcv=-1;
    for(const c of cs){let m=0;for(let k=0;k<12;k++){const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(k*TAU/12),Math.sin(k*TAU/12),6).dist;if(d>m)m=d;}if(m>bcv){bcv=m;bc=c;}}
    let best=0,bm=-1;
    for(let k=0;k<64;k++){const a=k*TAU/64,d=castRayDist(bc[0]+.5,bc[1]+.5,Math.cos(a),Math.sin(a),7).dist;if(d>bm){bm=d;best=a;}}
    P.x=bc[0]+.5;P.y=bc[1]+.5;P.ang=best;P.pitch=0;P.z=floorAt(P.x,P.y);
    ENEMIES.length=0;
    if(!PKP.length){for(const p of PROPS)PKP.push(p);for(const k of PICKUPS)PKK.push(k)}
    PROPS.length=0;PICKUPS.length=0;PROJ.length=0;
    return {x:P.x,y:P.y,ang:best,ray:+bm.toFixed(2)};
  })()`;
  /* CAMSET parks the census rather than throwing it away: row (F) has to run on props the GENERATOR
     authored, because their z is the thing under test. */
  const REST = 'PROPS.length=0;PICKUPS.length=0;PROJ.length=0;' +
    'for(const p of PKP)PROPS.push(p);for(const k of PKK)PICKUPS.push(k);';
  const CAM = run(CAMSET);
  // the prop goes on the sight line the camera was just aimed down, at the furthest spot that is
  // still an open cell - a prop inside a wall would be occluded and every row below would be noise
  let SPOT = null;
  for (const dd of [2.9, 2.6, 2.3, 2.0, 1.7, 1.4]) {
    const x = CAM.x + Math.cos(CAM.ang) * dd, y = CAM.y + Math.sin(CAM.ang) * dd;
    if (run('!isSolid(' + x + ',' + y + ')')) { SPOT = { x, y, d: dd }; break; }
  }
  if (!SPOT) { console.log('CAMSET found no open spot on the sight line'); process.exit(1); }
  /* The disc the prop stands on goes up ONE quantum (+0.25 m): a step, not a boundary, because
     linkBoundaries blocks at fz[n]-fz[i] > 1 (20_level.js:143), so no riser is drawn and nothing can
     occlude the prop and fake the result. It is a disc around the PROP and not everything beyond 2 m,
     because the camera sits on that far floor: raise the cell under the player too and eyeZ rises
     with it, every row in the frame slides down by exactly (BH/t)*0.25 px, and a prop anchored to
     the OLD plane looks like it moved down by that much instead of not moving at all. Measured on
     main before that was fixed: bottom row 227 -> 256, i.e. the eye's own 29 px, reported as the
     prop's. */
  const RAISE = `(()=>{for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;` +
    `if(Math.hypot(x+0.5-${SPOT.x},y+0.5-${SPOT.y})<1.35)MAP.fz[i]+=1;}linkBoundaries();})()`;
  const raiseAt = (x, y) => `(()=>{for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const gx=i%MW,gy=(i/MW)|0;` +
    `if(Math.hypot(gx+0.5-${(+x).toFixed(4)},gy+0.5-${(+y).toFixed(4)})<1.35)MAP.fz[i]+=1;}linkBoundaries();})()`;
  /* Put the CAMERA on a clear sight line ~2.6 m from one generated prop of this kind, so row (F) can
     look at a prop the generator authored rather than one this probe invented. Deterministic: props
     are tried in generation order and the first with a >= 1.9 m clear ray wins. */
  const AIM = k => `(()=>{let b=null;for(let i=0;i<PROPS.length;i++){const p=PROPS[i];if(p.kind!==${JSON.stringify(k)})continue;` +
    `let ba=0,bd=-1;for(let j=0;j<48;j++){const a=j*TAU/48,d=castRayDist(p.x,p.y,Math.cos(a),Math.sin(a),6).dist;if(d>bd){bd=d;ba=a}}` +
    `if(bd<1.9)continue;const dd=Math.min(2.6,bd-0.7);` +
    `if(isSolid(p.x+Math.cos(ba)*dd,p.y+Math.sin(ba)*dd))continue;` +
    `b={i:i,x:+p.x.toFixed(4),y:+p.y.toFixed(4),d:+dd.toFixed(2)};` +
    `P.x=p.x+Math.cos(ba)*dd;P.y=p.y+Math.sin(ba)*dd;P.ang=Math.atan2(p.y-P.y,p.x-P.x);P.pitch=0;` +
    `P.z=floorAt(P.x,P.y);break}` +
    `return b})()`;

  /* ONE thing in the world at a time, at the spot, with the generator's own scale. __p is what the
     rows read back for z and scale, so the entry the probe writes is the entry the game draws. */
  const SX = SPOT.x.toFixed(4), SY = SPOT.y.toFixed(4);
  const SC = { barrel: 0.86, crate: 0.72, lamp: 0.95, pickupHealth: 0.42, pickupAmmo: 0.42, pickupArmor: 0.42, orb: 0.3, portal: 1.5 };
  const put = {
    barrel: `PROPS.length=0;PROPS.push({tex:PROP.barrel,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.86,kind:'barrel',hp:26,dead:false});globalThis.__p=PROPS[0]`,
    crate: `PROPS.length=0;PROPS.push({tex:PROP.crate,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.72,kind:'crate'});globalThis.__p=PROPS[0]`,
    lamp: `PROPS.length=0;PROPS.push({tex:PROP.lamp,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.95,kind:'lamp'});globalThis.__p=PROPS[0]`,
    pickupHealth: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'health',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    pickupAmmo: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'ammo',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    pickupArmor: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'armor',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    orb: `PROPS.length=0;PROJ.length=0;PROJ.push({kind:'orb',x:${SX},y:${SY},z:0.9,scale:0.3,vx:0,vy:0,vz:0,t:0,tex:PROP.orb[0]});globalThis.__p=PROJ[0]`,
    portal: `PROPS.length=0;exitX=${SX};exitY=${SY};S.exitOpen=true;globalThis.__p={x:${SX},y:${SY},scale:1.5,z:0.02}`,
  };
  /* The second render of every pair has to have the OBJECT out of it, not just the array emptied:
     the portal is drawn from exitX/exitY unconditionally, so parking it off-map is what removes it.
     Everything else in the world is identical between the two frames, so the difference IS the
     silhouette - the contrast/anim technique, and why no projection math appears below. */
  const hide = {
    barrel: 'PROPS.length=0', crate: 'PROPS.length=0', lamp: 'PROPS.length=0',
    pickupHealth: 'PICKUPS.length=0', pickupAmmo: 'PICKUPS.length=0', pickupArmor: 'PICKUPS.length=0',
    orb: 'PROJ.length=0', portal: 'exitX=-40;exitY=-40',
  };
  const render = code => { run(code + ';S.t=3.5;renderWorld()'); };
  function pair(code, off, on) {
    run('MESH.reset()');
    render(code);
    const A = new Uint32Array(run('px')), zA = new Float32Array(run('zbuf'));
    const tris = run('MESH.stats().tris');
    render(off);
    const out = { A, B: new Uint32Array(run('px')), zA, zB: new Float32Array(run('zbuf')), tris };
    run(on || 'null');
    return out;
  }
  function mask(s) {
    const cov = new Uint8Array(N); let n = 0, top = H, bot = -1, lft = W, rgt = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(lum(s.A, i) - lum(s.B, i)) > 4 || (s.A[i] >>> 24) - (s.B[i] >>> 24) !== 0) {
        cov[i] = 1; n++; if (y < top) top = y; if (y > bot) bot = y; if (x < lft) lft = x; if (x > rgt) rgt = x;
      }
    }
    return { cov, n, top, bot, lft, rgt, h: bot - top + 1 };
  }
  // % of the mask whose depth the object itself wrote: a mesh rasterizer writes zbuf where it draws,
  // a billboard never touches it, so this reads "geometry" without asking how many triangles there are
  function owned(s, m) {
    let a = 0;
    for (let i = 0; i < N; i++) if (m.cov[i] && s.zA[i] < s.zB[i] - 1e-4) a++;
    return 100 * a / (m.n || 1);
  }
  // mean of the brightest frac of the mask: the emissive core of a lamp is a small part of its
  // silhouette, and a mean over the whole body would let a lit post carry a dead bulb past the test
  function hi(b, m, frac) {
    const v = [];
    for (let i = 0; i < N; i++) if (m.cov[i]) v.push(lum(b, i));
    v.sort((x, y) => y - x);
    const k = Math.max(1, Math.round(v.length * frac));
    let s = 0; for (let i = 0; i < k; i++) s += v[i];
    return s / k;
  }
  let bad = 0;
  const fail = msg => { bad++; console.log('    FAIL ' + msg); };
  const gruntTris = run('MESH.trisFor("grunt")'), gruntVerts = run('MESH.vertsFor("grunt")');
  const KINDS = ['barrel', 'crate', 'lamp', 'pickupHealth', 'pickupAmmo', 'pickupArmor', 'orb', 'portal'];
  const EMISSIVE = { lamp: 1, orb: 1, portal: 1 };
  console.log('props: level ' + LI + '  cam ' + CAM.x.toFixed(2) + ',' + CAM.y.toFixed(2) +
    ' (clear ray ' + CAM.ray + ' m)  prop at ' + SPOT.d + ' m  grunt = ' + gruntTris + ' tris');
  for (const kind of KINDS) {
    const P0 = put[kind], HID = hide[kind];
    /* the portal is in EVERY frame - it is drawn from exitX/exitY rather than from a list - so it gets
       parked out of any frame that is measuring something else. Without this its triangles land in row
       (A)'s count and a half-converted prop kind would pass on the strength of a doorway, and its glow
       would land in the top decile of row (E)'s control rows. */
    const PARKO = kind === 'portal' ? '' : 'exitX=-40;exitY=-40;';
    // row (F) parks the camera on a sight line of its own, so every kind re-seats it
    run(CAMSET);
    console.log('  ' + kind.toUpperCase());
    const s = pair(PARKO + P0, HID), m = mask(s);
    // (A) geometry or quad
    if (m.n < 250) fail('(A) ' + kind + ': nothing to judge - the silhouette is ' + m.n + ' px');
    const own = owned(s, m);
    if (s.tris === 0) fail('(A) ' + kind + ': renders as a BILLBOARD QUAD - MESH drew 0 triangles for it ' +
      '(silhouette ' + m.n + ' px, mesh-written depth on ' + own.toFixed(1) + '% of it)');
    else if (own < 40) fail('(A) ' + kind + ': MESH drew ' + s.tris + ' triangles but owns the depth of only ' +
      own.toFixed(1) + '% of its silhouette - the pixels a quad would also leave to the floor');
    else console.log('    mesh: ' + s.tris + ' tris, owns the depth of ' + own.toFixed(1) + '% of ' + m.n + ' mask px');
    // (K) own geometry, and an unauthored kind must not render at all
    let has = true;
    try { run('MESH.trisFor(' + JSON.stringify(kind) + ')'); } catch (e) { has = false; }
    if (has && run('MESH.trisFor(' + JSON.stringify(kind) + ')') === gruntTris &&
      run('MESH.vertsFor(' + JSON.stringify(kind) + ')') === gruntVerts)
      fail('(K) ' + kind + ': no geometry authored - SPEC[kind]||SPEC.grunt answered with the grunt\'s ' +
        gruntTris + ' tris / ' + gruntVerts + ' verts');
    else if (!has) fail('(K) ' + kind + ': MESH.trisFor throws, so nothing is authored for this kind');
    else console.log('    kind: own geometry (' + run('MESH.trisFor(' + JSON.stringify(kind) + ')') +
      ' tris, ' + run('MESH.vertsFor(' + JSON.stringify(kind) + ')') + ' verts vs the grunt\'s ' + gruntTris + ')');
    let threw = false;
    run('MESH.reset()');
    try { run('MESH.draw({kind:"__unauthored__",x:' + SX + ',y:' + SY + ',z:0,scale:0.5})'); }
    catch (e) { threw = true; }
    const ut = run('MESH.stats().tris');
    if (!threw) fail('(K) an unauthored kind RENDERS: MESH.draw({kind:"__unauthored__"}) rasterized ' + ut +
      ' triangles instead of failing - SPEC[kind]||SPEC.grunt is drawing a grunt where a typo should throw');
    // (S) the height convention: scale is TOTAL world height on both paths
    const tY = run('(()=>{const dx=' + SX + '-camX,dy=' + SY + '-camY;return (1/(planeX*dirY-dirX*planeY))*(-planeY*dx+planeX*dy)})()');
    const quad = (H / tY) * SC[kind], ratio = m.h / quad;
    let sp = null;
    try { sp = run('MESH.spanFor(' + JSON.stringify(kind) + ')'); } catch (e) { /* a quad: (A) said it */ }
    /* a SOLID does not project at one distance: the near jamb of a 0.9 m gate standing at 2.9 m is
       2.4 m from the eye, so its crown lands ABOVE the centre-plane quad. That is perspective and not
       a scale bug, so what gets asserted is the window it gives rather than a single number. */
    const rr = sp ? Math.min(sp.r * SC[kind], tY * 0.45) : 0;
    const span = sp ? (sp.y1 - sp.y0) * SC[kind] : SC[kind];
    const hiH = (H / Math.max(0.2, tY - rr)) * span, loH = (H / (tY + rr)) * span;
    if (sp && (m.h > hiH * 1.04 || m.h < loH * 0.96)) fail('(S) ' + kind + ': silhouette is ' + m.h +
      ' px tall at t=' + tY.toFixed(2) + ' m, outside the ' + loH.toFixed(0) + '-' + hiH.toFixed(0) +
      ' px window its own authored ' + span.toFixed(2) + ' m span gives at this distance - scale is TOTAL'
      + ' world height: 40_render.js:635 centres the quad at o.z+scale*0.5, 13_mesh.js:365 puts a'
      + ' vertex at o.z+by*sc');
    else if (!sp) console.log('    scale: n/a for geometry - it is a quad that measures exactly its own ' +
      quad.toFixed(0) + ' px (silhouette x' + ratio.toFixed(2) + '); row (A) is the one that failed');
    else console.log('    scale: ' + m.h + ' px tall x ' + (m.rgt - m.lft + 1) + ' wide, inside the ' +
      loH.toFixed(0) + '-' + hiH.toFixed(0) + ' px window a ' + span.toFixed(2) + ' m body gives at t=' +
      tY.toFixed(2) + ' m, rows ' + m.top + '-' + m.bot);
    // (E) emissive exemption: the same frame with the lights off
    /* "the lights are off" means OFF: MAP.light to 0 AND MAP.amb to 0, because renderWorld re-reads
       AMB from MAP.amb every frame (40_render.js:96) so the ambient floor is the other half of the
       term under test. Scaling MAP.light alone left a measured 0.86 ratio on a LIT crate - the whole
       point of the control row is that it falls to roughly (0.30*visAt*sh)/(AMB+li), so anything that
       cannot push that ratio down cannot see scene light at all. */
    run('globalThis.__L = MAP.light.slice(); globalThis.__A = MAP.amb');
    run('MAP.amb = 0; for(let i=0;i<MW*MH;i++)MAP.light[i] = 0');
    const s2 = pair(PARKO + P0, HID);
    run('MAP.light.set(globalThis.__L); MAP.amb = globalThis.__A');
    const m2 = mask(s2);
    if (m2.n < 250) fail('(E) ' + kind + ': invisible once the lights are off (' + m2.n + ' px) - cannot judge emissive');
    const full = hi(s.A, m, 0.1), dark = hi(s2.A, m, 0.1), rat = full > 0 ? dark / full : 1;
    if (EMISSIVE[kind]) {
      if (rat < 0.85) fail('(E) ' + kind + ': emissive pixels FALL with scene light - top-decile luminance ' +
        full.toFixed(0) + ' lit, ' + dark.toFixed(0) + ' dark (x' + rat.toFixed(2) +
        '): it is multiplied by li, so it goes dark in the rooms where it is the only light source');
      else console.log('    emissive: top-decile ' + full.toFixed(0) + ' -> ' + dark.toFixed(0) +
        ' (x' + rat.toFixed(2) + ') - light-exempt');
    } else if (rat > 0.7) fail('(E) ' + kind + ': the CONTROL did not fall (x' + rat.toFixed(2) +
      ') - this probe cannot see scene light, so every other (E) row here is worthless');
    else console.log('    lit by light, as it should be (control): ' + full.toFixed(0) + ' -> ' + dark.toFixed(0) +
      ' (x' + rat.toFixed(2) + ')');
    /* (F) feet on the floor. For the three kinds the generator authors this runs on a REAL prop from
       the census, with the camera moved onto a clear sight line beside it: the z a prop carries is
       written at 20_level.js:397,400, so an entry hand-written here could not tell floorAt from the
       literal 0.0 that file contains - a first cut of this row placed its own prop at z:floorAt and
       PASSED on main, which is the false-green this repo's own notes warn about. Pickups, the orb and
       the portal stay on the placed entry, legitimately: their z is invented by the draw list
       (40_render.js:114,:119,:120), so no entry can fake it in either direction. */
    const isProp = kind === 'barrel' || kind === 'crate' || kind === 'lamp';
    let fstate = null;
    if (isProp) { run(REST); fstate = run(AIM(kind)); }
    if (isProp && !fstate) fail('(F) ' + kind + ': no GENERATED prop of this kind has a >= 1.9 m clear ray, so '
      + 'its feet could not be judged - the census is unreachable from the camera');
    const fX = fstate ? fstate.x : +SX, fY = fstate ? fstate.y : +SY;
    const fcode = (fstate ? '' : P0 + ';') + PARKO;
    const foff = fstate ? 'PKP2[0]=PROPS.splice(' + fstate.i + ',1)[0]' : HID;
    const fon = fstate ? 'PROPS.splice(' + fstate.i + ',0,PKP2[0])' : 'null';
    const sA = pair(fcode, foff, fon), mA = mask(sA);
    if (mA.n < 250) fail('(F) ' + kind + ': the prop is only ' + mA.n + ' px on screen at ' +
      (fstate ? fstate.d + ' m (a generated one)' : SPOT.d + ' m') + ' - cannot judge its feet');
    const ftY = run('(()=>{const dx=' + fX + '-camX,dy=' + fY + '-camY;return (1/(planeX*dirY-dirX*planeY))*(-planeY*dx+planeX*dy)})()');
    run('globalThis.__F = MAP.fz.slice()');
    run(raiseAt(fX, fY));
    const s3 = pair(fcode, foff, fon), m3 = mask(s3);
    run('MAP.fz.set(globalThis.__F);linkBoundaries();P.z=floorAt(P.x,P.y);ENEMIES.length=0;');
    const keep = m3.h / (mA.h || 1), shift = mA.bot - m3.bot, want = (H / ftY) * 0.25;
    const who = fstate ? 'generated prop ' + fstate.i + ' at ' + fstate.d + ' m' : 'the placed entry';
    // a projectile in flight has no feet: its z is the arc js/30_entities.js owns, so raising the band
    // under it must change NOTHING - the correct answer, not a failure, and not a silent pass either:
    // nothing in this probe or any other gate covers a MOVER's altitude, which #76 leaves to gameplay
    const airborne = kind === 'orb';
    if (airborne) console.log('    feet: n/a - airborne, z is the arc 30_entities.js owns, not floorAt;'
      + ' UNCOVERED by any gate here');
    else if (keep < 0.9) fail('(F) ' + kind + ': SUNK IN THE BAND - raising its floor by one quantum (0.25 m, a step, '
      + 'so no riser is drawn and nothing occludes it) hid ' + (100 * (1 - keep)).toFixed(0) + '% of it (height '
      + mA.h + ' -> ' + m3.h + ' px, bottom ' + mA.bot + ' -> ' + m3.bot + ') on ' + who + ': its z is not floorAt(x,y)');
    else if (shift < want * 0.4) fail('(F) ' + kind + ': the floor rose one quantum and the prop did not (bottom row '
      + mA.bot + ' -> ' + m3.bot + ', expected ~' + want.toFixed(0) + ' px up) on ' + who +
      ' - it is painted at the old plane, so it sinks into any band above 0');
    else console.log('    feet: height kept ' + (100 * keep).toFixed(0) + '%, bottom row up ' + shift +
      ' px (expected ~' + want.toFixed(0) + ') on ' + who);
  }
  console.log(bad ? 'PROPS PROBE: ' + bad + ' FAILURE(S)' : 'PROPS PROBE: every prop volumetric, light-exempt where emissive, and grounded');
  process.exit(bad ? 1 : 0);
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
