/* tools/dev321-sepsweep.js — one-off measurement harness for #321.

   Rebuilds the 80-row placement sweep the issue was measured with: 4 levels x 5 grid-chosen poses
   x requested distance {2, 4, 7.5, 12}, 1 roll per row, n = 3 grunts. A row is BAD when the crowd
   fills n DISTINCT cells (the #93 gate passes) and the closest two centres still get under
   BODY_W metres (the frame draws one blob). Nothing here gates anything - it prints rows and a
   count so a before/after claim can be stated with N and the pose attached.

   Bootstrap is the same vm/DOM stub as tools/smoke.js (copied, not required: smoke is an IIFE),
   and the per-level seat/PRNG shape is the DEV.spawn block's own (SEED + 90210, startLevel(li, true),
   DEV.cam at the dealt seat) so a row here and a row there see the same world.

   usage: node tools/dev321-sepsweep.js [JSDIR=<pristine js>] [SEED=n] [N=3] [BODY_W=0.5]
*/
const vm = require('vm'), fs = require('fs'), path = require('path');
const noop = () => {};
const W = 1280, H = 720;
let ctxDepth = 0;
function ctxStub() {
  const store = {};
  const rnd = i => ((i * 2654435761) >>> 24);
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'save') return () => { ctxDepth++; };
      if (k === 'restore') return () => { ctxDepth--; };
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
  return { width: 300, height: 150, style: {}, getContext: () => ctxStub(), addEventListener: noop, requestPointerLock: () => undefined };
}
const elements = {};
function elStub(id) {
  const reg = {};
  const base = { id, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, textContent: '', onclick: null,
    style: {}, addEventListener: (t, f) => { (reg[t] = reg[t] || []).push(f); }, __fire: (t, ev) => { for (const f of (reg[t] || [])) f(ev); } };
  if (id === 'screen') Object.assign(base, canvasStub());
  elements[id] = base;
  return base;
}
const docListeners = {}, listeners = {};
const SEED = (Number(process.env.SEED) || 12345) >>> 0;
let rs = SEED;
const sbMath = Object.create(Math);
sbMath.random = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
const sandbox = {
  console, Math: sbMath, Date, JSON, Uint32Array, Uint16Array, Uint8ClampedArray, Int16Array, Float32Array, Uint8Array, Object, Array, String, Number, Boolean, Error, isNaN, isFinite, parseInt, parseFloat, setTimeout, clearTimeout,
  document: { getElementById: elStub, createElement: () => canvasStub(),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    exitPointerLock: noop, pointerLockElement: null, hidden: false },
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: noop,
  requestAnimationFrame: f => { sandbox.__raf = f; return 1; },
  devicePixelRatio: 1, innerWidth: W, innerHeight: H,
  AudioContext: undefined, webkitAudioContext: undefined,
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctxVm = vm.createContext(sandbox);
const JSDIR = process.env.JSDIR ? path.resolve(process.env.JSDIR) : path.join(__dirname, '..', 'js');
const jsFile = f => path.join(JSDIR, f);
const jfiles = fs.readdirSync(JSDIR).filter(f => f.endsWith('.js')).sort();
if (!jfiles.length) { console.log('JSDIR ' + JSDIR + ' holds no .js files'); process.exit(1); }
const crypto = require('crypto');
const jhash = crypto.createHash('sha256');
let ts = 0;
const frames = n => { for (let i = 0; i < n; i++) { ts += 16.7; sandbox.__raf(ts); } };
const RL = code => vm.runInContext(code, ctxVm);

const N = Number(process.env.N) || 3;
const BODY_W = Number(process.env.BODY_W) || 0.5;
const POSES = Number(process.env.POSES) || 5;
const DISTS = [2, 4, 7.5, 12];

(async () => {
  for (const f of jfiles) {
    const src = fs.readFileSync(jsFile(f), 'utf8');
    jhash.update(f + '\0' + src);
    vm.runInContext(src, ctxVm, { filename: f });
  }
  console.log('# JSDIR ' + JSDIR + '  js-sha256 ' + jhash.digest('hex').slice(0, 16) + '  ' +
    jfiles.length + ' files' + (process.env.JSDIR ? ' (VARIANT tree)' : ' (this tree)'));
  frames(10);
  const nl = RL('LEVELS.length');
  sandbox.location = { search: '?dev=1', hash: '' };
  RL('S.mode = "play";');
  try { vm.runInContext(fs.readFileSync(jsFile('90_dev.js'), 'utf8'), ctxVm); }
  catch (e) { console.log('90_dev.js did not install - ' + e.message); process.exit(1); }

  let rows = 0, bad = 0, collapsedRows = 0, gotPoses = 0;   // collapsedRows = rows whose crowd missed a cell
  const badList = [];
  for (let li = 0; li < nl; li++) {
    // the DEV.spawn block's own seat deal, so a level here is the level smoke's row stands in
    RL(`(()=>{let a=(${SEED}+90210)>>>0;Math.random=()=>{a=(a+0x6D2B79F5)>>>0;` +
      `let t=a;t=Math.imul(t^t>>>15,t|1);t^=Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};})()`);
    RL('S.mode = "play"; S.locked = true; S.exitOpen = false;');
    RL(`startLevel(${li}, true); S.mode = "play"; S.locked = true; S.exitOpen = false;`);
    RL('for (const k in keys) delete keys[k]; PROJ.length = 0; PARTS.length = 0; DECALS.length = 0;');
    const seat = JSON.parse(RL('JSON.stringify([P.x, P.y, P.ang])'));
    // grid-chosen poses: scan the level for open cells at a fixed stride, keep POSES of them spaced
    // across the floorplan, and face each down its longest clear axis so the row measures FAN WIDTH
    // rather than a wall that forces the rescue path.
    const poses = RL(`(()=>{
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]], out = [];
      const clear = (x, y, d) => { const r = DEV.ray(x, y, P.z, d[0], d[1], 0, 24);
        return r.hit ? r.dist : 24; };
      const cells = [];
      for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++)
        if (!isSolid(x + 0.5, y + 0.5) && floorAt(x + 0.5, y + 0.5) === floorAt(P.x, P.y)) cells.push([x, y]);
      const step = Math.max(1, Math.floor(cells.length / (POSES_PLACEHOLDER + 1)));
      for (let i = step; out.length < POSES_PLACEHOLDER && i < cells.length; i += step) {
        const c = cells[i];
        let best = dirs[0], bd = -1;
        for (const d of dirs) { const q = clear(c[0] + 0.5, c[1] + 0.5, d); if (q > bd) { bd = q; best = d; } }
        if (bd < 3) continue;                       // a cell with no 3 m of run cannot hold a 3-body fan
        out.push([c[0] + 0.5, c[1] + 0.5, Math.atan2(best[1], best[0])]);
      }
      return out})()`.replace(/POSES_PLACEHOLDER/g, String(POSES)));
    if (process.env.SEAT) poses.length = 0, poses.push([seat[0], seat[1], seat[2]]);   // SEAT=1: the smoke row's own pose
    gotPoses = Math.max(gotPoses, poses.length);
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      for (const d of DISTS) {
        const r = JSON.parse(RL(`(()=>{ DEV.clear(); DEV.cam(${p[0]}, ${p[1]}, undefined, ${p[2]});
          const rep = DEV.spawn("grunt", ${N}, ${d});
          const cs = new Set(); for (const e of ENEMIES) cs.add((e.y | 0) * MW + (e.x | 0));
          return JSON.stringify({bodies: ENEMIES.length, cells: cs.size, sep: rep.sep,
            collapsed: rep.collapsed, dist: rep.dist, pl: rep.placed.map(q => [q.x, q.y, q.d, q.lat, q.why]), why: rep.placed.map(q => q.why).join('+'),
            seat: [+(P.x.toFixed(2)), +(P.y.toFixed(2)), +(P.ang.toFixed(3))]}) })()`));
        rows++;
        const badRow = r.cells === N && r.sep !== null && r.sep < BODY_W;
        // collapsedRows is the count of these rows, printed in the census below. It used to also bump
        // a `reported` counter that was never declared, so any run where a crowd did NOT fill N cells
        // threw ReferenceError and died before reaching the line that exists to report those rows.
        if (r.cells !== N) collapsedRows++;
        if (badRow) { bad++; badList.push(`L${li} pose ${pi} @ ${seat[0].toFixed(1)},${seat[1].toFixed(1)} d=${d}: `
          + `cells ${r.cells}/${N} sep ${r.sep} dist ${r.dist.join('/')} why ${r.why} seat ${JSON.stringify(r.seat)}`); }
        console.log(`row ${rows} L${li} pose ${pi} d=${d} cells ${r.cells}/${N} sep ${r.sep === null ? 'n/a' : r.sep}`
          + ` collapsed ${r.collapsed} dist ${r.dist.join('/')} pl ${JSON.stringify(r.pl)}` + (badRow ? '   <== OVERLAP' : ''));
      }
    }
  }
  console.log(`sweep: ${rows} row(s) = ${nl} levels x ${gotPoses} poses x {${DISTS.join(',')}}, n=${N}, BODY_W=${BODY_W}`);
  console.log(`  distinct-cells rows with pair separation under ${BODY_W} m: ${bad}`);
  console.log(`  rows whose crowd did NOT fill ${N} cells (geometry, reported not counted): ${collapsedRows}`);
  badList.forEach(s => console.log('  BAD ' + s));
  console.log(bad ? 'SWEEP: OVERLAP PRESENT' : 'SWEEP: NO OVERLAP');
})();
