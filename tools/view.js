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
const W = +(process.env.VW || 1280), H = +(process.env.VH || 720);   // VW/VH: the sway rows are resolution tests
const MODE = process.argv[2] || 'scene';
const ASCII = process.env.ASCII === '1' || process.env.ASCII === '';
const LVL = +(process.argv[3] || 0);
const CAM = +(process.argv[4] || 0);
// An unknown name used to fall through to the scene dump and exit 0, so a typo in a CI probe list
// ran something, painted a PNG and reported a passing gate (#89).
const PROBES = ['scene', 'alt', 'anim', 'bands', 'contrast', 'cull', 'decal', 'diag', 'exposure', 'flatparity', 'heights',
  'drop', 'horizon', 'mip', 'planes', 'play', 'props', 'rig', 'sheets', 'sight', 'stats', 'vert', 'viewmodel', 'refs'];
if (!PROBES.includes(MODE)) {
  console.error('unknown probe "' + MODE + '" - known: ' + PROBES.join(' '));
  process.exit(2);
}
/* ---------------------------------------------------------------------------------------------
 * RECORDED REFERENCES (#216 probe-half). A *recorded reference* is a literal a probe compares a
 * measured value against: flatparity's PARITY/LOCK/DEALT md5 triples and cull's CZBAND crc32
 * triple. Until now the only census of them was a grep, and #216's own survey said what it read:
 * `grep -cE '[0-9a-f]{32}' tools/view.js` = 3, which misses cull's crc32 refs (that pattern cannot
 * match 0x9c03d4f4) and cannot tell a live compare from a historical triple quoted in a comment.
 * So "21 of 22 blocks print verdicts with no hash behind them" was a claim about a blind instrument.
 *
 * The mechanism replaces the instrument instead of sampling it: a record is DECLARED by the code
 * that compares against it. The declaration binds the literals (a const whose value is a refRecord
 * call returning them unchanged), so the declaration *is* the compare - a probe cannot gain, lose
 * or edit a reference without the inventory moving, and prose cannot invent one. `tools/refs.lock`
 * is the machine-readable table of those declarations (`node tools/view.js refs --record` writes
 * it) and the inventory is asserted against the table from inside `flatparity`, which `ci.yml:161`
 * runs under `set -euo pipefail`, so no new CI step and no new gate is needed to make it bite.
 * Comparison is two-directional and a difference in either direction exits 1: a declaration with no
 * row is `REFS-DECLARED-MISSING`, a row with no declaration (the declaration was deleted) is
 * `REFS-IN-TABLE-UNDECLARED`, an edited literal is `REFS-VALUES-MOVED`. A missing or unparsable
 * table is a FAILURE, never a silent pass (#216's vacuity rule: a check that cannot fail).
 *
 * What this makes falsifiable: the COUNT, KIND and VALUES of recorded references per block, printed
 * on every CI run - which is the form of "N blocks have no hash behind their verdicts" that can move
 * when someone adds one, instead of rotting in a paragraph.
 *
 * What it still cannot see: the blocks whose verdict numbers are COMPUTED, not hashed - `alt`'s
 * cells-lit-from-a-band-above, `heights`' % of frame moved, `contrast`'s edge dL and lost-%,
 * `exposure`'s means, `mip`'s streak counts, `bands`' legibility pair, `scene`'s dumps. Nothing here
 * turns a computed figure into a hash; those rows report, they do not lock, and they are listed by
 * name in every run of this inventory rather than counted in a document.
 * --------------------------------------------------------------------------------------------- */
const REFS_FILE = process.env.REFS_LOCK || path.join(__dirname, 'refs.lock');
const REFS_RECORD = process.argv.includes('--record');
const REFS_ROSTER = PROBES.filter(n => n !== 'refs');
const REFS_CAND = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*refRecord\(/;
const REFCALL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*refRecord\(\s*'([a-z]+)'\s*,\s*'([A-Za-z0-9_\-]+)'\s*,\s*'([a-z0-9]+)'\s*,\s*\[([^\]]*)\]/;
const refHex8 = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
/* A record is declared, not asserted: this returns its literals, so the line that registers a
   reference is the line the compare reads them from. Kind is validated in both directions - the
   same rule the static scan applies - so a truncated hash cannot become a lock by typo. */
function refRecord(mode, rowName, kind, vals) {
  for (const v of vals) {
    if (kind === 'md5' && !(/^[0-9a-f]{32}$/.test(v))) throw new TypeError('refRecord ' + mode + '/' + rowName + ': md5 value "' + v + '" is not 32 hex');
    if (kind === 'crc32' && !(typeof v === 'number' && v >= 0 && v <= 0xffffffff)) throw new TypeError('refRecord ' + mode + '/' + rowName + ': crc32 value "' + v + '" is not a uint32');
  }
  return vals;
}
/* The scan is line-oriented on purpose: a declaration must fit on the line that binds it, and a
   refRecord call that does not parse is reported (REFS-DECL-FORM) rather than skipped, so a record
   cannot hide by being wrapped, computed, or bound to something nothing reads. */
function refScan() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n'), decls = [], badform = [];
  for (let i = 0; i < src.length; i++) {
    const L = src[i];
    if (!REFS_CAND.test(L)) continue;
    const m = REFCALL.exec(L);
    if (!m) { badform.push(i + 1); continue; }
    const vals = [];
    for (const raw of m[5].split(',')) {
      const t = raw.trim();
      const q = /^'([^']*)'$/.exec(t), h = /^0x([0-9a-f]{1,8})$/i.exec(t);
      if (q) vals.push(q[1]);
      else if (h) vals.push(refHex8(parseInt(h[1], 16)));
      else badform.push(i + 1);
    }
    decls.push({ vname: m[1], mode: m[2], row: m[3], kind: m[4], vals: vals.join(' '), line: i + 1 });
  }
  return { decls, badform, src };
}
function refTable(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [], bad = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim()[0] === '#') continue;
    const c = line.split('\t');
    if (c.length !== 5 || c[0] !== 'ref') bad.push(line);
    else rows.push({ key: c[1] + '/' + c[2], mode: c[1], row: c[2], kind: c[3], vals: c[4] });
  }
  return { rows, bad };
}
function refWrite(decls, file) {
  const head = ['# tools/refs.lock - the recorded-reference inventory of tools/view.js (#216 probe-half).',
    '# One row per probe verdict that compares a measured value against a recorded literal, in the',
    '# form:  ref <TAB> probe <TAB> row <TAB> kind <TAB> value(s), space separated.',
    '# Regenerate:  node tools/view.js refs --record      Assert:  node tools/view.js refs',
    '# A declaration with no row here fails REFS-DECLARED-MISSING; a row with no declaration fails',
    '# REFS-IN-TABLE-UNDECLARED; an edited literal fails REFS-VALUES-MOVED. None of the three is a',
    '# warning, and the row runs inside flatparity, which ci.yml runs blocking.'].join('\n');
  const body = decls.slice().sort((a, b) => (a.mode + a.row < b.mode + b.row ? -1 : 1))
    .map(d => ['ref', d.mode, d.row, d.kind, d.vals].join('\t')).join('\n');
  fs.writeFileSync(file, head + '\n' + body + '\n');
}
/* One inventory, two callers: `refs` mode prints it alone, and flatparity feeds it its own row()
   so a disagreement is a FAIL row in a blocking step. Pure fs + string work: it renders nothing, so
   it cannot warm the pose cache or move a lock (#243's ordering cliff is why that matters here). */
function refInventory(row) {
  const { decls, badform, src } = refScan();
  row('REFS-DECL-FORM every record declaration parses to a lock row', badform.length === 0,
    decls.length + ' declaration(s) parse' + (badform.length ? ', ' + badform.length + ' do NOT (lines ' +
      badform.join(',') + ' - a record must be a const binding of a refRecord call with a literal array on that one line' : '') +
      '; a record that cannot be read is not a record');
  const offRoster = decls.filter(d => !REFS_ROSTER.includes(d.mode));
  row('REFS-ROSTER every record names a probe this tool knows', offRoster.length === 0,
    offRoster.length ? offRoster.map(d => d.mode + '/' + d.row).join(' ') + ' - a record on an unknown block compares against nothing'
      : decls.map(d => d.mode + '/' + d.row + ' (' + d.kind + ' @:' + d.line + ')').join(' '));
  const keys = decls.map(d => d.mode + '/' + d.row), dups = keys.filter((k, i) => keys.indexOf(k) !== i);
  row('REFS-DUP-KEY no two declarations share a probe+row key', dups.length === 0,
    dups.length ? 'duplicate ' + dups.join(' ') : 'keys ' + keys.join(' '));
  const tab = refTable(REFS_FILE);
  if (!tab) {
    row('REFS-LOCKFILE the lock table exists', false, 'no table at ' + REFS_FILE + ' with ' + decls.length +
      ' declaration(s) in ' + path.basename(__filename) + ' - run `node tools/view.js refs --record`. Absence is a FAILURE: a probe that finds nothing to compare against must not report ok.');
    return { decls, tab: null };
  }
  row('REFS-LOCK-FORM every lock row parses', tab.bad.length === 0,
    tab.rows.length + ' row(s) read' + (tab.bad.length ? ', ' + tab.bad.length + ' unparsable: ' + tab.bad.join(' | ').slice(0, 160) : ' (ref<TAB>probe<TAB>row<TAB>kind<TAB>values)'));
  const tkeys = tab.rows.map(r => r.key);
  const missing = decls.filter(d => tkeys.indexOf(d.mode + '/' + d.row) < 0);
  const undecl = tab.rows.filter(r => keys.indexOf(r.key) < 0);
  const moved = tab.rows.filter(r => keys.indexOf(r.key) >= 0 &&
    r.vals !== decls[keys.indexOf(r.key)].vals);
  row('REFS-DECLARED-MISSING every declared record has a lock row', missing.length === 0,
    missing.length ? missing.map(d => d.mode + '/' + d.row + ' (declared @:' + d.line + ')').join(' ') + ' - the table was not regenerated after the declaration' : missing.length + ' missing');
  row('REFS-IN-TABLE-UNDECLARED every lock row has a declaration', undecl.length === 0,
    undecl.length ? undecl.map(r => r.key + ' - the compare was deleted from ' + path.basename(__filename) + ' and the table still claims it exists') : undecl.length + ' orphan rows');
  row('REFS-VALUES-MOVED values in the table are the values in the code', moved.length === 0,
    moved.length ? moved.map(r => r.key + ' table [' + r.vals + '] vs code [' + decls[keys.indexOf(r.key)].vals + ']').join(' ; ') : moved.length + ' moved');
  /* Reporting half - never a failure, always printed: the counts the prose used to carry, and the
     reconciliation with the grep #216 surveyed with, including the 0x family that grep cannot see. */
  const byKind = {}, byBlock = {};
  for (const d of decls) { byKind[d.kind] = (byKind[d.kind] || 0) + 1; (byBlock[d.mode] = byBlock[d.mode] || []).push(d.row); }
  const noRec = REFS_ROSTER.filter(n => !byBlock[n]);
  console.log('  --  records: ' + decls.length + ' (' + Object.keys(byKind).sort().map(k => k + ' ' + byKind[k]).join(', ') +
    ') across ' + Object.keys(byBlock).length + ' of ' + REFS_ROSTER.length + ' verdict-printing probes; with none: ' + noRec.length + ' [' + noRec.join(' ') + ']');
  let md5Lines = 0, hxRefs = 0, hxOther = 0;
  const hxSeen = [];
  for (let i = 0; i < src.length; i++) {
    const L = src[i];
    if (/[0-9a-f]{32}/.test(L)) md5Lines++;
    for (const h of (L.match(/0x[0-9a-f]{7,8}/g) || [])) {
      if (L.indexOf('refRecord(') >= 0) hxRefs++;
      else { hxOther++; if (hxSeen.length < 6) hxSeen.push(h + ' @:' + (i + 1)); }
    }
  }
  console.log('  --  #216\'s instrument reconciled: `grep -cE \'[0-9a-f]{32}\' tools/view.js` = ' + md5Lines +
    ' line(s) - equal to the ' + (byKind.md5 || 0) + ' md5 record(s) here, because each now sits on the line that binds it.' +
    ' The crc32 family is invisible to that grep: ' + hxRefs + ' 0x… literal(s) inside a declaration vs ' + hxOther +
    ' mentions elsewhere, which are historical triples quoted in comments and the FNV/PRNG constants' +
    ' - first: ' + hxSeen.join(' ') + '. A grep counts mentions; this table counts compares.');
  return { decls, tab };
}
if (MODE === 'refs') {
  let rbad = 0;
  const rrow = (label, ok, detail) => { if (!ok) rbad++; console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + ' - ' + detail); return ok; };
  const sc = refScan();
  if (REFS_RECORD) {
    refWrite(sc.decls, REFS_FILE);
    const back = refTable(REFS_FILE);
    rrow('REFS-ROUNDTRIP the table written re-reads with every declaration',
      !!back && back.bad.length === 0 && back.rows.length === sc.decls.length,
      back ? back.rows.length + ' row(s) read back, ' + back.bad.length + ' unparsable, ' + sc.decls.length + ' declared -> ' + REFS_FILE : 'unreadable');
    console.log(rbad ? 'REFS RECORD FAILED - wrote ' + REFS_FILE + ' and could not read it back' : 'refs recorded ' + sc.decls.length + ' references -> ' + REFS_FILE);
    process.exit(rbad ? 1 : 0);
  }
  refInventory(rrow);
  console.log(rbad ? 'REFS ' + rbad + ' FAILURE(S) - the declared records and ' + path.basename(REFS_FILE) + ' disagree (regenerate with `node tools/view.js refs --record` only after the code change is the one you meant)'
    : 'refs ok - ' + sc.decls.length + ' recorded reference(s) in ' + new Set(sc.decls.map(d => d.mode)).size +
      ' of ' + REFS_ROSTER.length + ' probes, table agrees (' + REFS_FILE + ')');
  process.exit(rbad ? 1 : 0);
}
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
let elements = {};
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
let sandbox, ctxVm;
const run = code => vm.runInContext(code, ctxVm, { filename: 'view' });
// levels lay themselves out with Math.random, so measurements need a seeded one
function seedRng(seed) {
  run(`(()=>{let a=${seed | 0}>>>0;Math.random=()=>{a=(a+0x6D2B79F5)>>>0;` +
    `let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};})()`);
}
/* BOOT THE GAME INTO A FRESH CONTEXT. At module load this runs exactly once, in the same order as
   before, so every mode that boots once - which is every mode except the DEALT sampler - hashes what
   it always hashed. It is a FUNCTION because #243 needs to be able to say "nothing that a previous
   render did is still in memory", and that is a property of the BOOT, not of a list of caches:
   clearing caches finds what whoever listed them thought of, a fresh instantiation finds all of it.
   The two things a new context does NOT clear are node-side and listed here:
     elements  - elStub hands the same stub object to every game instance, so boot N would inherit
                 boot N-1's event handlers and textContent;
     rs        - js boot-time art is drawn from the sandbox Math, whose generator lives in this file,
                 so without the reset boot N would texture the world further along the stream.
   The LAMPS knob used to be applied after the load loop at module scope; it is applied here instead,
   in the same position, so a re-boot honours it exactly as the first boot did. */
function boot(knob) {
  elements = {}; rs = SEED;
  sandbox = {
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
  ctxVm = vm.createContext(sandbox);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'js')).filter(f => f.endsWith('.js')).sort()) {
    try { run(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8')); }
    catch (e) { console.log('LOAD FAIL ' + f + ': ' + e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }
  }
  /* LAMPS=off suppresses the #204 coverage top-up at AUTHOR time and nothing else. js/20_level.js
     topUpEnabled() is the one call site, so the budget lamps, the exit pad, the grid and every global
     Math.random draw are the ones the shipped path makes - the difference between the two records is the
     <=3 top-up lamps and no more, which tools/view.js flatparity ASSERTS (the knob-off lamp list must be a
     field-by-field prefix of the shipped one) rather than assumes. It exists because flat parity is
     compared in a world the probe flattened after generation: with the top-up on, a flat level carries
     lamps that were authored for bands the probe deleted, so the flat md5 stops being a formula test. See
     that mode's header before quoting either triple. It sat at module scope until #243 moved it in here,
     one line after the load loop, so a re-boot applies it exactly as the first boot did. */
  if (knob !== false && process.env.LAMPS === 'off') run('topUpEnabled = function () { return false; };');
}
boot();
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
  /* Altitude cross-section. Until #152 this probe's verdict was FLATNESS - M0's exit gate, "the flat
     world is bit-identical" - which is now precisely what generation must NOT produce. The verdict is
     inverted into M3's exit gate: >=2 bands, >=1 unblocked link into every band above the datum, no
     open cell the height-aware crossing rule cannot reach, >=1 climbable staircase, and no face of
     span <=0. Every number it printed before is still printed, so a before/after diff reads, and the
     gate sets the exit code (this probe used to always exit 0, which is why it was only ever reporting).
     Nothing here pokes MAP.fz: these are the bands the generator authored, or the row is lying. */
  let bad = 0, knownN = 0, rowsN = 0;
  const row = (label, ok, detail) => {
    console.log('  ' + label.padEnd(44) + (ok ? ' ok  ' : ' FAIL') + '  ' + detail);
    if (!ok) bad++;
  };
  for (let li = 0; li < 3; li++) {
    const r = vm.runInContext(`(function(){
      startLevel(${li}, true);
      const N = MAP.w, cell = MAP.cell, fz = MAP.fz, vb = MAP.vb, feat = MAP.feat;
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
      /* M3's rows, all on the generated grid. The crossing rule is the generator's own bfsReach, with
         the nibbles and the feature byte handed to it, so this cannot drift from what the occupancy
         gate believed - and dFlat is the SAME layout with the bands erased, which is what makes
         "the bands sealed nothing" a separate claim from "this level has no pockets". */
      const start = MAP.rooms[0].cy * N + MAP.rooms[0].cx, zero = new Int8Array(N * N);
      const dBand = bfsReach(cell, fz, N, start, vb, feat);
      const dFlat = bfsReach(cell, zero, N, start);
      let unreach = 0, sealed = 0, reachUp = 0, reachDown = 0, reachOff = 0, farReach = 0;
      for (let i = 0; i < N * N; i++) {
        if (cell[i]) continue;
        if (dBand[i] < 0) { unreach++; if (dFlat[i] >= 0) sealed++; continue; }
        if (fz[i] > 0) reachUp++; else if (fz[i] < 0) reachDown++;
        if (fz[i]) { reachOff++; if (dBand[i] > farReach) farReach = dBand[i]; }
      }
      // one link per band, counted from the end that is FARTHER from the datum, so a stair is not
      // counted twice. The old form used the HIGH side, which is the same thing while every band sits
      // above the datum and cannot see a sunken one at all: the crossing that reaches a pit floor is
      // the step DOWN from its stair, whose high side is the stair cell, so the pit's own band looked
      // unlinked on a level where bfsReach reaches every cell of it (#181). Identical on an
      // all-nonnegative grid, which is what main is.
      const linkIn = {}, blockedStep = {};
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x; if (cell[i]) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRX[d], ny = y + DIRY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const j = ny * N + nx; if (cell[j] || j < i) continue;
          const dq = fz[j] - fz[i];
          if (!dq) continue;
          const near = Math.abs(fz[i]) <= Math.abs(fz[j]) ? fz[i] : fz[j];
          const far = near === fz[i] ? fz[j] : fz[i];
          if (far === 0) continue;
          const cross = Math.abs(dq) <= 1 || linkedClimb(vb, feat, i, j, d);
          linkIn[far * ZQ] = (linkIn[far * ZQ] || 0) + (cross ? 1 : 0);
          if (!cross) blockedStep[far * ZQ] = (blockedStep[far * ZQ] || 0) + 1;
        }
      }
      // a staircase is derived, not trusted from FEAT_STAIR: a maximal chain along +x/+y whose floors
      // rise by exactly one quantum per cell, every crossing of it walkable, at least 3 cells long
      let stairs = 0, stairCells = 0, ladCells = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x; if (cell[i]) continue;
        if (feat[i] === FEAT_LADDER) ladCells++;
        for (let d = 0; d < 4; d++) {
          const px = x - DIRX[d], py = y - DIRY[d];
          if (px >= 0 && py >= 0 && px < N && py < N && !cell[py * N + px] && fz[py * N + px] === fz[i] - 1) continue;
          let len = 1, kx = x, ky = y, walk = true;
          for (;;) {
            const ax = kx + DIRX[d], ay = ky + DIRY[d];
            if (ax < 0 || ay < 0 || ax >= N || ay >= N) break;
            const a = ay * N + ax;
            if (cell[a] || fz[a] !== fz[ky * N + kx] + 1) break;
            if ((vb[ky * N + kx] >> (d << 2)) & 1) { walk = false; break; }
            len++; kx = ax; ky = ay;
          }
          if (len >= 3 && walk) { stairs++; stairCells += len; }
        }
      }
      const nBands = Object.keys(bands).length;
      let bandLink = 0, noLink = [];
      for (const k of Object.keys(bands)) if (+k !== 0) { if (linkIn[k]) bandLink++; else noLink.push(k); }
      /* #181's three rows, on the same generated grid and derived the same way - nothing here trusts
         a feature byte, and none of it pokes a grid the probe drew for itself.
         headroom: ceilAt - floorAt of an OPEN column. A flat level is exactly 1 (CZ_DEF quanta), and
         the only way a column reaches 2 is MAP.cz authored above 4, so this is "a room you can stand
         up in", not a ceiling the derived formula happened to lift.
         runs: the largest 4-connected patch of open columns sharing one off-datum floor. Main raises
         whole ROOMS, so its largest patch is one room; a band you can walk on for its whole width has
         to be bigger than any room on the map.
         reachUp/reachDown: cells off the datum the player's own crossing rule gets to from spawn. */
      let headMax = 0, headCols = 0;
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const i = y * N + x; if (cell[i]) continue;
        const h = ceilAt(x, y) - fz[i] * ZQ;
        if (h > headMax) headMax = h;
        if (h >= 2) headCols++;
      }
      const seen = new Uint8Array(N * N);
      let runMax = 0, runFloor = 0, runTot = 0, runs = 0;
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (cell[i] || seen[i] || !fz[i]) continue;
        const q = fz[i];
        let n = 0; const st = [i]; seen[i] = 1;
        for (let k = 0; k < st.length; k++) {
          const c = st[k], cx = c % N, cy = (c / N) | 0; n++;
          for (let d = 0; d < 4; d++) {
            const j = (cy + DIRY[d]) * N + (cx + DIRX[d]);
            if (j < 0 || j >= N * N || cell[j] || seen[j] || fz[j] !== q) continue;
            seen[j] = 1; st.push(j);
          }
        }
        runTot += n; runs++;
        if (n > runMax) { runMax = n; runFloor = q * ZQ; }
      }
      return { open, nonFlat, minF, maxF, faces, faceUnblocked, blockedFlat,
        bfaces, badSpan, minSpan, maxSpan, bands, bandsN: MAP.bands, nBands, unreach, sealed,
        linkIn, blockedStep, stairs, stairCells, ladCells, bandLink, noLink, steps: MAP.steps,
        headMax, headCols, runMax, runFloor, runTot, runs, reachUp, reachDown, reachOff, farReach,
        spawnBand: floorAt(P.x, P.y), exitBand: floorAt(exitX, exitY) };
    })()`, ctxVm);
    console.log(`level ${li}  open ${r.open}  floors ${r.minF}..${r.maxF}  bands ${JSON.stringify(r.bands)}`);
    const runWant = Math.max(24, Math.round(r.open * 0.12));
    console.log(`         boundary ${r.bfaces} span ${r.bfaces ? r.minSpan + '..' + r.maxSpan : '-'} span<=0 ${r.badSpan}` +
      `  step faces ${r.faces} unblocked-step ${r.faceUnblocked}  blockedFlat byDir ${r.blockedFlat.join(',')}` +
      `  ${r.bfaces > 0 && r.badSpan === 0 ? 'FACES ok' : 'FACE FAIL'}`);
    row(`L${li} at least two bands`, r.nBands >= 2 && r.bandsN === r.nBands,
      `${r.nBands} distinct floor values over ${r.open} open cells, MAP.bands ${r.bandsN}, ${r.nonFlat} cells off the datum`);
    row(`L${li} every band above the datum is linked`, r.noLink.length === 0 && r.nBands >= 2,
      `unblocked crossings into each band ${JSON.stringify(r.linkIn)}, blocked steps ${JSON.stringify(r.blockedStep)},` +
      ` bands without a link [${r.noLink.join(' ')}] (ladder columns ${r.ladCells})`);
    row(`L${li} no open cell the bands cannot reach`, r.unreach === 0,
      `${r.unreach} unreachable of ${r.open} under the height-aware crossing rule, ${r.sealed} of them by the` +
      ` bands themselves (the same layout with the bands erased reaches ${r.open - r.sealed})`);
    row(`L${li} a staircase can be climbed on foot`, r.stairs >= 1 && r.faces > 0 && r.steps === 1,
      `${r.stairs} run(s) of >=3 cells rising one quantum each (${r.stairCells} cells), ${r.faces} step faces, ` +
      `MAP.steps ${r.steps} (a step face with the flag at 0 draws nothing - #100 on generated content)`);
    row(`L${li} spawn and exit stay on the datum`, r.spawnBand === 0 && r.exitBand === 0 && r.badSpan === 0,
      `spawn floor ${r.spawnBand.toFixed(2)}, exit floor ${r.exitBand.toFixed(2)}, faces of span<=0 ${r.badSpan}`);
    // #181: being in the grid is not being perceivable. These three rows are the difference between a
    // level that is multi-storey in MAP.fz and one that reads as a crawlway, and every one of them is
    // RED ON MAIN - main authors no CZ_TALL column, no cell below the datum, and no off-datum patch
    // larger than a single room.
    row(`L${li} a column you can stand up in (>=2 units)`, r.headCols >= 1,
      `${r.headCols} open column(s) measure >= 2 units from floorAt to ceilAt, tallest ${r.headMax.toFixed(2)}; ` +
      `a flat level reads exactly 1.00 there and a ladder shaft reaches 1.50, so 0 is the flat-world answer`);
    row(`L${li} off the datum is reachable from spawn, up AND down`, r.reachUp >= 1 && r.reachDown >= 1,
      `${r.reachUp} cell(s) above the datum and ${r.reachDown} below it reached from spawn by the crossing rule ` +
      `(furthest ${r.farReach} crossings away); a level with no sunken band reports 0 below`);
    row(`L${li} a raised band you can walk on, not hop onto`, r.runMax >= runWant,
      `largest contiguous patch of one off-datum floor is ${r.runMax} cells at floor ${r.runMax ? r.runFloor.toFixed(2) : '-'}, ` +
      `want >= ${runWant} (12% of ${r.open} open cells, 24 floor); ${r.runs} patch(es), ${r.runTot} off-datum cells across all of them`);
    /* #203's rows. A lamp must not light columns whose band it is not on, and the vertical term
       must be a literal 1 at the lamp's own band. Magnitudes are measured through the game's own
       splatLight - each static light is splatted against a snapshot of MAP.light and un-splatted,
       so the numbers are what the shipped kernel delivers, and only the dz classification is
       computed here. The config that exercises these rows is the generated grid from the
       startLevel(li, true) at the top of this loop: the wrong-band population exists because the
       generator authored the bands (#152), nothing is poked, and popGeo >= 1 on every level is
       the non-vacuity proof that there were real cells to measure. */
    const v = vm.runInContext(`(function(){
      const N = MAP.w, snap = MAP.light.slice(), stat = LIGHTS.filter(L => L.stat);
      const srcOK = new Uint8Array(N * N), srcBad = new Uint8Array(N * N), srcGeo = new Uint8Array(N * N);
      /* The same decomposition read by SIGN of the floor difference. dz above is |L.z - floor|, so a
         column 1.00 m ABOVE a datum lamp (dz 0.22) and a pit floor 1.00 m BELOW it (dz 1.78) land on
         opposite sides of the 1.03 test for reasons that have nothing to do with the kernel: the dz
         form cannot see an upward crossing at all. fd below is source floor minus column floor, which
         is what the kernel's own band term compares. */
      const fGeo = new Uint8Array(N * N), fUp = new Uint8Array(N * N), fDn = new Uint8Array(N * N);
      const fUpQ = new Int8Array(N * N), fDnQ = new Int8Array(N * N), fPad = new Uint8Array(N * N), fPadGeo = new Uint8Array(N * N), fPadDisc = new Uint8Array(N * N);
      const hist = {}, fh = {}; let maxDrift = 0, bad = 0, badLight = 0, pop = 0, popGeo = 0, geoN = 0;
      for (const L of stat) {
        const lz = L.z === undefined ? floorAt(L.x, L.y) : L.z;
        const lf = L.z === undefined ? lz : L.z - LHOVER;          // the source's own FLOOR
        MAP.light.set(snap);
        splatLight(L, L.str);
        const R = Math.ceil(L.r);
        for (let y = Math.max(0, (L.y - R) | 0); y < Math.min(N, L.y + R); y++)
          for (let x = Math.max(0, (L.x - R) | 0); x < Math.min(N, L.x + R); x++) {
            const i = y * N + x;
            if (MAP.cell[i]) continue;
            if (Math.hypot(x + .5 - L.x, y + .5 - L.y) >= L.r) continue;
            const dz = Math.abs(lz - MAP.fz[i] * ZQ);
            if (dz > 1.03 + 1e-3) {
              srcGeo[i] = 1;
              if (MAP.light[i] - snap[i] > 1e-4) srcBad[i] = 1;
            } else srcOK[i] = 1;
            const k = dz.toFixed(2); hist[k] = (hist[k] || 0) + 1;
            const fd = lf - MAP.fz[i] * ZQ, q = Math.round(fd / ZQ);
            const got = MAP.light[i] - snap[i] > 1e-4;             // this source delivered light HERE
            if (Math.abs(fd) > ZQ + 1e-9) {
              fGeo[i] = 1;
              if (L.z === undefined) fPadDisc[i] = 1;                       // any open cell in the pad's disc
              if (fd > 0) fPadGeo[i] = 1;                                   // ...of those, the ones BELOW it
              const bk = Math.abs(q) <= 1 ? '1' : Math.abs(q) === 2 ? '2' : Math.abs(q) === 3 ? '3' : '4+';
              const hk = (fd < 0 ? 'up' : 'dn') + bk;
              fh[hk] = (fh[hk] || 0) + 1;
              if (got) { if (fd < 0) { fUp[i] = 1; if (q < fUpQ[i]) fUpQ[i] = q; } else { fDn[i] = 1; if (q > fDnQ[i]) fDnQ[i] = q; }
                if (fd > 0 && L.z === undefined) fPad[i] = 1; }
            }
          }
        splatLight(L, -L.str);
        for (let j = 0; j < MAP.light.length; j++) { const e = Math.abs(MAP.light[j] - snap[j]); if (e > maxDrift) maxDrift = e; }
      }
      MAP.light.set(snap);
      let upN = 0, dnN = 0, upLit = 0, dnLit = 0, padN = 0, padGeo = 0, padDisc = 0;
      const upBk = {}, dnBk = {};
      for (let i = 0; i < N * N; i++) {
        if (MAP.cell[i]) continue;
        if (srcGeo[i]) popGeo++;
        if (srcBad[i]) { pop++; if (!srcOK[i]) { bad++; badLight += snap[i]; } }
        if (fGeo[i]) geoN++;
        if (fUp[i]) { upN++; upLit += snap[i]; const b = -fUpQ[i], k = b <= 1 ? '1' : b === 2 ? '2' : b === 3 ? '3' : '4+'; upBk[k] = (upBk[k] || 0) + 1; }
        if (fDn[i]) { dnN++; dnLit += snap[i]; const k = fDnQ[i] <= 1 ? '1' : fDnQ[i] === 2 ? '2' : fDnQ[i] === 3 ? '3' : '4+'; dnBk[k] = (dnBk[k] || 0) + 1; if (fPad[i]) padN++; }
        if (fPadGeo[i]) padGeo++; else if (fPadDisc[i]) padDisc++;
      }
      /* The weight itself, through the shipped splatLight: a zero-extent synthetic light (str 1,
         centre distance 0) authored at z = f + LHOVER + dq STANDS on the band f + dq, so dq is the
         FLOOR difference the band term compares - the term verbatim at the centre pixel. This table
         used to be indexed by the EMITTER height (z = f + dz), which is why a lamp's own band read
         dz 0.78 there: #203's kernel folded the hover into the comparison, so the probe had to as
         well. Same properties, honest variable, and both signs probed at |fd| = 1 m. */
      const cx = P.x | 0, cy = P.y | 0, f = floorAt(cx + .5, cy + .5), i0 = cy * N + cx;
      const probeAt = dq => { MAP.light.set(snap);
        splatLight({ x: cx + .5, y: cy + .5, z: f + LHOVER + dq, r: 1.2, str: 1 }, 1);
        const q = MAP.light[i0] - snap[i0]; MAP.light.set(snap); return +q.toFixed(6); };
      const tbl = [0, .25, .5, 1, -.25, -.5, -1].map(dq => probeAt(dq));
      const neg = probeAt(-1);
      buildTint();
      return { bad, pop, popGeo, badLight: bad ? badLight / bad : 0, hist, tbl, neg, maxDrift, lamps: stat.length,
        geoN, upN, dnN, fh, upBk, dnBk, padN, padGeo, padDisc, upMean: upN ? upLit / upN : 0, dnMean: dnN ? dnLit / dnN : 0 };
    })()`, ctxVm);
    row(`L${li} a lamp is untaxed at its own band`, Math.abs(v.tbl[0] - 1) < 1e-4 && Math.abs(v.tbl[1] - 1) < 1e-4 && Math.abs(v.tbl[4] - 1) < 1e-4,
      `w(fd=0)=${v.tbl[0]} w(fd=+1q)=${v.tbl[1]} w(fd=-1q)=${v.tbl[4]} - the synthetic lamp stands ON the column's floor in the first case and one quantum off it in the other two, so a weight that taxes any of them darkens every lamp it stands over (a term that compares the EMITTER rather than the source's floor puts a lamp's own band one hover off: a hard |dz|>1 gate reads 0 here, and the /2 falloff written in #203 taxes 0.78 to 0.76)`);
    row(`L${li} light does not cross a band boundary`, v.tbl[2] <= 0.02 && v.tbl[3] <= 0.02 && v.tbl[5] <= 0.02 && v.tbl[6] <= 0.02 && Math.abs(v.neg - v.tbl[3]) < 1e-4,
      `w(+2q)=${v.tbl[2]} w(+4q)=${v.tbl[3]} w(-2q)=${v.tbl[5]} w(-4q)=${v.tbl[6]}, and the +/-1 m pair agrees (${v.neg} vs ${v.tbl[3]}) so the term reads |fd| and not a signed fd. #203's reach - fd in [-1.81,+0.25] - answers w(+4q)=0 AND w(-4q)=1, so a row that probes one sign only cannot see the bleed it is meant to stop`);
    row(`L${li} no cell lit only from a wrong band`, v.bad <= 2 && v.popGeo >= 1,
      `${v.bad} open cell(s) take their ONLY light from a lamp more than one quantum past its hover (the #203 measurement was 41/114/67 per level on the unweighted kernel), mean MAP.light there ${v.bad ? v.badLight.toFixed(3) : '-'} (issue: 0.583/0.410/0.549); ${v.pop} cell(s) still receive any wrong-band light, ${v.popGeo} lie in a wrong-band disc at all (non-vacuity), ${v.lamps} lamps, dz histogram ${JSON.stringify(v.hist)} - dz is |L.z - floor| and blind to sign, so the two floor-difference rows below say what actually crosses a band`);
    row(`L${li} no column is lit from a band ABOVE it`, v.dnN === 0 && v.geoN >= 1,
      `${v.dnN} open cell(s) take direct light from a source whose FLOOR is at least one quantum ABOVE their own (by quanta ${JSON.stringify(v.dnBk)}, mean MAP.light there ${v.dnN ? v.dnMean.toFixed(3) : '-'}, ${v.padN} of them from a z-less source on the floorAt default). #203 already blocks fd > ZQ for an authored lamp, so this is the half that closed and it reads 0 on main; counted separately from the row below so a kernel that trades one half for the other cannot pass this pair`);
    row(`L${li} no column is lit from a band BELOW it`, v.upN === 0 && v.geoN >= 1,
      `${v.upN} open cell(s) take direct light from a source whose FLOOR is at least one quantum BELOW their own (by quanta ${JSON.stringify(v.upBk)}, mean MAP.light there ${v.upN ? v.upMean.toFixed(3) : '-'}; off-band discs cover ${v.geoN} open cells, non-vacuity). |L.z - floor| <= LHOVER + ZQ is fd in [-1.81, +0.25] in floor terms, so a datum lamp lit the raised band a whole unit above it at full weight while a pit one quantum below it stayed dark - the half #203 left open, and invisible to the dz row above because a cell 1.00 m up reads dz 0.22`);
    row(`L${li} no pit floor is lit from the exit pad above it`, v.padN === 0,
      `${v.padN} cell(s) take light from a Z-LESS source standing above them (the exit pad is the only z-less static light: it emits from floorAt of its own cell); the pad's disc covers ${v.padGeo + v.padDisc} open cells that are not on the pad's own band, ${v.padGeo} of them on a band BELOW it, so where that second number is 0 the pad has no floor below it to leak into and this row is reporting nothing. On 2c5a94f level 0 shows the #209 measurement: 3 cells at mean light 1.452 at SEED 12345, every one pad-carried, because the reach was fd <= LHOVER + ZQ = 1.03 m downward and a pit floor four quanta under the pad sat inside it. The pad deliberately keeps NO z - authoring a hover would tax the pools under the stair, which bands' L2 lip rows measured at 46% -> 43% - so #209 is settled by the reach plus a lamp on the pit band of its own, not by an authored z on the pad`);
    row(`L${li} every lamp splat is exactly reversible`, v.maxDrift < 1e-4,
      `max |MAP.light - snapshot| over splat+un-splat of all ${v.lamps} static lamps ${v.maxDrift.toExponential(1)} - the fade asserts in smoke stand on the delta un-splat using the same kernel as the splat`);
  }
  /* #204's coverage criteria and #206's residual, on the protocol #199 measured them with rather than on
     the single probe-seeded world above: 12 seeded rolls per level (dice 1000 + level*97 + roll*13, the
     same numbers tools/ci/assert.js rolls), the GENERATED grid with nothing poked - the config that
     exercises these rows is generation itself (#152), so a placement rule that wrote MAP.fz would show
     up here - and the DELIVERED lightmap as startLevel leaves it (splat + blurLight + buildTint).
     Delivered is the point: until #206 the blur carried light across a lip, so the wrong-band
     population was not zero and could not be, which is why #206's criterion was "must not grow past
     the recorded population" and not "= 0". #206 chose option A - the blur now applies the splat
     kernel's own band term (one quantum of floor difference per hop), so what remains is the
     staircase residue: one blur pass spans one intermediate cell, a source exactly 2 quanta off a
     cell's floor can still light the far side of a step. That residue is the recorded floor. An
     in-band source is the KERNEL's own band term restated on the source's FLOOR -
     LHOVER comes off an authored lamp, a z-less source is already standing on its floor - rather than
     the old LIGHT_REACH constant, which #208 deleted together with the emitter-height reach it named; a
     probe string that read that constant would throw here, which is the AGENTS lesson that a probe
     string can be the only reader a "dead" field has. Recorded on 2c5a94f under this floor-referenced
     test, 12 rolls: pit-dark 117/71/62 of 181/194/175 cells (MAP.fz <= -3) at mean light
     0.077/0.174/0.230, wrong-band-lit 123/377/337 at 0.231/0.254/0.311, no-source-in-disc
     976/1537/1140. Recorded on this branch after #206's blur band gate, same dice: wrong-band-lit 19/10/16 at
     0.092/0.121/0.132 (the bleeding kernel measured 37/49/75 on df919c3 there). A pit-dark of 0 with pit 0 would be vacuity rather than a fix, so the population
     rides along in the detail and pit > 0 is part of the assertion. */
  {
    const MAIN_PIT = [181, 194, 175], MAIN_OOB = [19, 10, 16];   // #206: recorded on the gated kernel; the bleeding kernel was 123/377/337 (2c5a94f) / 37/49/75 (df919c3)
    /* #213: dark-OPEN cells recorded at the shipped lamp record, per level, over these same 12 rolls. A
       top-up source whose intensity drops pays for dimmer pit light with darker floor somewhere else, and
       that is the trade this refuses - the T64M0.35 variant of the sweep is exactly "coverage sold to buy
       dim" (+247/+497/+329 here). The 1.02 tolerance is measured slack, not a guessed one: the shipped pair
       (TARGET 32, MINF 0.5) lands at +1/+4/+2 over these references, and the variant above sits 25-45x
       further out, so the row cannot be tightened into a coin flip or widened into a no-op.
       #206 re-recorded these values to 344/1194/1055: with the blur band gate, the cells whose ONLY
       light was the cross-band bleed become honestly dark (+92/+111/+183 over the pre-gate readings
       253/1087/874 on df919c3 - the wrong-band population this fix deletes plus the sub-threshold
       tail it also carried, reclassified, not new darkness). The slack and the T64M0.35 distance
       from it are unchanged. */
    const TOPUP_DARK_REF = [344, 1194, 1055];
    for (let lv = 0; lv < 3; lv++) {
      const A = { pit: 0, pitDark: 0, pitSum: 0, oob: 0, oobSum: 0, nosrc: 0, dark: 0, open: 0, lamps: 0, pitRolls: 0, noPitAt: [] };
      for (let r = 0; r < 12; r++) {
        seedRng(1000 + lv * 97 + r * 13);
        const c = vm.runInContext(`(function(){
          startLevel(${lv}, true);
          const N = MAP.w, cell = MAP.cell, fz = MAP.fz, light = MAP.light;
          const S = []; for (const L of LIGHTS) S.push({ x: L.x, y: L.y, r: L.r, f: L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER });
          let pit = 0, pitDark = 0, pitSum = 0, oob = 0, oobSum = 0, nosrc = 0, dark = 0, open = 0;
          for (let i = 0; i < N * N; i++) {
            if (cell[i]) continue;
            open++;
            const fl = fz[i] * ZQ, lt = light[i], dk = lt < 0.05;
            if (fz[i] <= -3) { pit++; pitSum += lt; if (dk) pitDark++; }
            const px = i % N + 0.5, py = ((i / N) | 0) + 0.5;
            let inR = 0, good = 0;
            for (const s of S) {
              if (Math.hypot(s.x - px, s.y - py) >= s.r) continue;
              inR++; if (Math.abs(s.f - fl) <= ZQ + 1e-9) good++;
            }
            if (dk) { dark++; if (!inR) nosrc++; }
            else if (inR && !good) { oob++; oobSum += lt; }
          }
          return { pit: pit, pitDark: pitDark, pitSum: pitSum, oob: oob, oobSum: oobSum, nosrc: nosrc, dark: dark, open: open,
            lamps: LIGHTS.filter(function (L) { return L.stat; }).length };
        })()`, ctxVm);
        A.pit += c.pit; A.pitDark += c.pitDark; A.pitSum += c.pitSum; A.oob += c.oob; A.oobSum += c.oobSum;
        A.nosrc += c.nosrc; A.dark += c.dark; A.open += c.open; A.lamps += c.lamps;
        if (c.pit) A.pitRolls++; else A.noPitAt.push(r);
      }
      const dref = Math.round(1.02 * TOPUP_DARK_REF[lv]);
      /* One row for the whole pit criterion, because either half alone passes on a world that broke the
         other: "no dark pit cell" was green while the pit was a white box (DEV.lum 168 mean / 229 mid,
         #213), and "pit light below the ceiling" would be green on the LAMPS=off world that has 181/177/146
         dark cells (117/71/62 where #204 measured it on 2c5a94f). The four clauses are printed with their
         values because the row is the record. NO
         composited-frame threshold is asserted here: the sweep measured the WORST pit frame as immovable by
         this mechanism - level 2 stays 183.8 mean / 245 mid in every placement config, because the glow
         overlay has no altitude term (#221 owns that half) - so a frame rule would be permanently red for a
         reason no lamp change can fix. The recorded frame numbers ride along beside the verdict instead. */
      row(`L${lv} a pit reads lit, not blown`,
        A.pitDark === 0 && A.pit > 0 && A.pitSum / A.pit <= 0.55 && A.dark <= dref,
        `(1) ${A.pitDark} of ${A.pit} pit cells (MAP.fz <= -3, main has ${MAIN_PIT[lv]} of them) hold less than 0.05 delivered`
        + ` light (the LAMPS=off control measures 181/177/146 here on the gated kernel - 118/72/62 before #206, when datum tails reached into pits, and 117/71/62 on 2c5a94f) - (2) that population exists in ${A.pitRolls} of`
        + ` the 12 rolls${A.noPitAt.length ? `, no pit at roll${A.noPitAt.length > 1 ? 's' : ''} ${A.noPitAt.join(' and ')}` : ''}, so this is not a row silently running on two levels - (3) mean delivered light there ${A.pit ? (A.pitSum / A.pit).toFixed(3) : 'no pit at all'} against the 0.55 ceiling`
        + ` (main's unscaled top-up 0.672/0.631/0.647, which is the #213 white box) - (4) ${A.dark} dark of ${A.open} open cells against`
        + ` ${dref} = round(1.02 x ${TOPUP_DARK_REF[lv]}). ${(A.lamps / 12).toFixed(2)} lamps/instance (main 7/9/17), ${A.nosrc} cells with no`
        + ` source in the XY disc (the #199 coverage half). No frame threshold is asserted: the worst sampled pit`
        + ` frame is 157.1/162.5/183.8 mean and 206.6/213.9/245.0 centre-half mid in the COMPOSITED page for`
        + ` these parameters and is unchanged by lamp intensity at all (#221, the glow overlay has no altitude term).`);
      row(`L${lv} delivered wrong-band light does not spread`, A.oob <= MAIN_OOB[lv],
        `${A.oob} open cell(s) hold delivered light with NO source standing on their own band within reach (recorded on the #206-gated kernel: ${MAIN_OOB[lv]}; the bleeding kernel was 123/377/337 on 2c5a94f and 37/49/75 on df919c3), mean`
        + ` light there ${A.oob ? (A.oobSum / A.oob).toFixed(3) : '-'} (gated: 0.092/0.121/0.132; bleeding main: 0.231/0.254/0.311). #206 gated the blur with the splat kernel's own band term, so what is left is staircase residue: one blur pass spans one intermediate cell and a source exactly 2 quanta off a floor can light the far side of a step. That residue is the record, not a leak -`
        + ` growing past it means the gate was weakened or lamps were authored off their own floor, which is the #204 control that measured 155/194/169 pit cells`);
    }
  }
  /* #221: the glow is composited, not splatted, so the lightmap's band term never reached it. A lamp
     standing on the datum painted additive light into the pixels of a pit a unit below it - level 2
     roll 9, camera on the pit floor, composited mean 183.8 and centre-half 245.0, and that frame was
     bit-for-bit identical in all 17 configurations of a lamp-intensity sweep INCLUDING the one that
     dims the top-up to MINF = 0, so no lamp knob owns it. This row measures the COMPOSITED layer
     headlessly, which the harness cannot paint: the ctx stub records paths, not pixels. So it reads
     the DRAW CALLS the shipped drawLightGlow makes (GLOWREC, null in play - the COV pattern of
     js/00_core.js) against the world those calls land on, and every sample of the disc's lattice is
     classified by two routes the shipped term does not use: the surface's CELL comes from marching
     the shipped zbuf distance back off the face into the air the ray came through (a MAP.fz lookup),
     and its ALTITUDE comes from inverting project(); a pixel counts as leaked only when a shipped fill
     rect actually covers it. The composited means themselves are the live page's, through DEV.lum
     (AGENTS: the page is the source of truth) - what gates here is that the disc does not cover a
     surface it has no business lighting, and that it still covers the one it does. Units are
     alpha-units per sampled pixel over a stride-8 lattice, never a luminance, and they are
     comparable across builds because the falloff model is a fixed function of the recorded geometry. */
  {
    const ZQv = run('ZQ'), MD = 8;
    const RECPIT = [0.293, 0.299, 0.314], RECPITN = [181, 194, 175], RECOOB = [19, 10, 16], RECDARK = [0, 0, 0];
    /* #206: RECPIT and RECOOB are MAP.light censuses, so the blur band gate moved them with the
       kernel (0.426/0.423/0.464 and 123/377/337 were the bleeding kernel's df919c3 readings - the
       pit means carried a real cross-band tail on top of the direct coverage light, which is what
       #206 exists to delete). The clause's whole job is to say a COMPOSITED change did not touch
       MAP.light, and it can only say that against the kernel that ships. RECDARK stays 0: coverage
       authors a source per band and pit cells still get ≥ 0.05 delivered light everywhere. */
    /* Bound MEASURED, not guessed: the shipped term reads frac 0.000 on every qualifying roll of all
       three levels, and the revert-the-term control reads 1.000 (100 % of the disc's alpha landing on
       a surface that is not the source's band). 0.05 is a twentieth of the control, not a twentieth of
       the fix - it is set against the worst SAMPLE of the sweep, which is what #221's own warning
       asks for, and the shipped value is not near it. */
    const MAXFRAC = 0.05, MINDELIV = 0.95;
    const gAl = (r, k) => r >= 1 ? 0 : (r <= 0.45 ? k * 0.7 + (k * 0.22 - k * 0.7) * (r / 0.45)
      : k * 0.22 * (1 - (r - 0.45) / 0.55));
    // the surface a device pixel shows: its band's FLOOR by the grid, and its altitude by project()-1
    const surf = (W, X, Y) => {
      const bx = (X * W.BW / W.DW) | 0, by = (Y * W.BH / W.DH) | 0;
      if (bx < 0 || bx >= W.BW || by < 0 || by >= W.BH) return null;
      const dz = W.zbuf[by * W.BW + bx];
      if (!isFinite(dz)) return null;
      const z = W.eyeZ - ((by - W.horizon) / W.BH) * dz, c = bx * 2 / W.BW - 1;
      for (const bk of [0.05, 0.2, 0.5, 1.2]) {
        const rr = dz - bk;
        const gx = Math.floor(W.camX + rr * (W.dirX + W.planeX * c)), gy = Math.floor(W.camY + rr * (W.dirY + W.planeY * c));
        if (gx < 0 || gy < 0 || gx >= W.N || gy >= W.N) continue;
        const j = gy * W.N + gx;
        if (W.cell[j]) continue;
        return { f: W.fz[j] * ZQv, z: z, q: W.fz[j] };
      }
      return null;
    };
    /* Place the camera the way #221 was measured - in the pit looking up at a lamp on the band above
       (sign +1), or at the lip looking down at a lamp that is genuinely below (sign -1) - on the
       GENERATED grid, nothing poked, and report the population of the frame beside the verdict. */
    const glowAt = (lv, roll, sign) => {
      seedRng(1000 + lv * 97 + roll * 13);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      const sel = vm.runInContext(`(function(){
        const N = MAP.w, cell = MAP.cell, fz = MAP.fz, lamps = LIGHTS.filter(function(L){return L.stat;});
        let best = null;
        for (let i = 0; i < N * N; i++) {
          if (cell[i]) continue;
          const cf = fz[i] * ZQ;
          for (let j = 0; j < lamps.length; j++) {
            const L = lamps[j];
            const lf = L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER;
            const dq = Math.round((lf - cf) / ZQ);
            if (dq * (${sign}) <= 0 || Math.abs(dq) < 2) continue;
            if ((${sign}) > 0 ? cf > -3 * ZQ : Math.abs(cf) > 3 * ZQ) continue;
            const qx = i % N + .5, qy = ((i / N) | 0) + .5, d = Math.hypot(L.x - qx, L.y - qy);
            if (d > 5 || d < 1.0 || !los(qx, qy, L.x, L.y)) continue;
            const sc = Math.abs(dq) * 4 - d;
            if (!best || sc > best.sc) best = { sc: sc, cx: qx, cy: qy, q: cf, lf: lf, d: d, dq: dq,
              lx: L.x, ly: L.y };
          }
        }
        const out = { sel: best, W: null, draws: [], pit: 0, pitDark: 0, pitSum: 0, oob: 0 };
        if (best) {
          P.x = best.cx; P.y = best.cy; P.z = floorAt(P.x, P.y); P.vx = P.vy = P.vz = 0; P.air = false;
          P.crouch = 0; P.pitch = 0; P.bob = 0; P.kick = 0; P.ads = 0; S.flash = 0; shakeX = 0; shakeY = 0; S.t = 0;
          P.ang = Math.atan2(best.ly - best.cy, best.lx - best.cx);
          for (const e of ENEMIES) e.state = 'sleep';
          PARTS.length = 0;
          performance.now = () => 5; VM.t = 5;
          for (let i = 0; i < 6; i++) renderWorld();
          out.W = { BW: BW, BH: BH, DW: DW, DH: DH, horizon: horizon, eyeZ: eyeZ, camX: camX, camY: camY,
            dirX: dirX, dirY: dirY, planeX: planeX, planeY: planeY, zbuf: zbuf, N: MAP.w, cell: MAP.cell, fz: MAP.fz };
          GLOWREC = [];
          renderOverlay();
          out.draws = GLOWREC.slice();
          GLOWREC = null;
        }
        for (let k = 0; k < N * N; k++) {
          if (cell[k]) continue;
          let inR = 0, good = 0;
          const px = k % N + .5, py = ((k / N) | 0) + .5, fl = fz[k] * ZQ;
          for (let j = 0; j < lamps.length; j++) {
            const L = lamps[j];
            if (Math.hypot(L.x - px, L.y - py) >= L.r) continue;
            inR++;
            if (Math.abs((L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER) - fl) <= ZQ + 1e-9) good++;
          }
          const dk = MAP.light[k] < 0.05;
          if (fz[k] <= -3) { out.pit++; out.pitSum += MAP.light[k]; if (dk) out.pitDark++; }
          if (!dk && inR && !good) out.oob++;
        }
        return out;
      })()`, ctxVm);
      if (!sel.sel) return { sel: null, st: null, pit: sel.pit, pitDark: sel.pitDark, pitSum: sel.pitSum, oob: sel.oob };
      const st = { leak: 0, on: 0, onDeliv: 0, spanCross: 0, crossN: 0, onN: 0, model: 0, rects: 0, lamps: sel.draws.length,
        dq: 0 };
      for (const g of sel.draws) {
        st.rects += g.rects.length / 5;
        const x0 = Math.max(0, Math.floor(g.x - g.rad)), x1 = Math.min(sel.W.DW, Math.ceil(g.x + g.rad));
        const y0 = Math.max(0, Math.floor(g.y - g.rad)), y1 = Math.min(sel.W.DH, Math.ceil(g.y + g.rad));
        for (let Y = y0 + (MD >> 1); Y < y1; Y += MD) for (let X = x0 + (MD >> 1); X < x1; X += MD) {
          const a = gAl(Math.hypot(X - g.x, Y - g.y) / g.rad, g.k);
          st.model += a;
          let w = 0;
          for (let i = 0; i < g.rects.length; i += 5)
            if (X >= g.rects[i] && X < g.rects[i] + g.rects[i + 2] && Y >= g.rects[i + 1] && Y < g.rects[i + 1] + g.rects[i + 3]) { w = g.rects[i + 4]; break; }
          const s = surf(sel.W, X, Y);
          if (!s) continue;
          if (Math.abs(s.f - g.lf) <= ZQv + 1e-9) { st.onN++; st.on += a; st.onDeliv += a * w; }
          else { st.crossN++; st.leak += a * w; st.dq = Math.max(st.dq, Math.abs(Math.round((g.lf - s.f) / ZQv))); }
          if (Math.abs(s.z - g.lf) > ZQv + 1e-9) st.spanCross += a * w;
        }
      }
      return { sel: sel.sel, st: st, pit: sel.pit, pitDark: sel.pitDark, pitSum: sel.pitSum, oob: sel.oob };
    };
    /* The parity collapse of the COMPOSITED layer, which flatparity's md5 cannot see because px is the
       buffer the world pass writes and the glow is drawn onto the display canvas after it. Force the
       grid flat the way flatparity forces it, and every lamp's fill must be the ONE clipped rect it
       always was - same geometry, same alpha, no run dropped. A term that clips the bbox, or is keyed
       on the camera's band, or compares a ceiling plane where it means a floor plane, shows up here. */
    const glowFlat = lv => {
      seedRng(1000 + lv * 97);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      return vm.runInContext(`(function(){
        MAP.fz.fill(0); MAP.cz.fill(CZ_DEF); linkBoundaries();
        for (const L of LIGHTS) if (L.stat && L.z !== undefined) L.z = floorAt(L.x, L.y) + LHOVER;
        MAP.light.fill(0); MAP.lR.fill(0); MAP.lG.fill(0); MAP.lB.fill(0); MAP.lw.fill(0);
        for (const L of LIGHTS) splatLight(L, L.str);
        blurLight(); buildTint();
        const L0 = LIGHTS.find(function (L) { return L.stat; });
        if (L0) { P.x = L0.x; P.y = L0.y; }        P.pitch = 0; P.vx = P.vy = P.vz = 0; P.air = false; P.crouch = 0; P.z = floorAt(P.x, P.y);
        for (const e of ENEMIES) e.state = 'sleep';
        performance.now = () => 5; VM.t = 5;
        for (let i = 0; i < 8; i++) renderWorld();
        GLOWREC = [];
        renderOverlay();
        const out = { lamps: 0, multi: 0, dev: 0 };
        for (const g of GLOWREC) {
          out.lamps++;
          if (g.rects.length !== 5) out.multi++;
          const rx = Math.max(0, g.x - g.rad), ry = Math.max(0, g.y - g.rad);
          const rw = Math.min(DW, g.x + g.rad) - rx, rh = Math.min(DH, g.y + g.rad) - ry;
          out.dev = Math.max(out.dev, g.rects.length === 5 ? Math.abs(g.rects[0] - rx) + Math.abs(g.rects[1] - ry) +
            Math.abs(g.rects[2] - rw) + Math.abs(g.rects[3] - rh) + Math.abs(g.rects[4] - 1) : 9e9);
        }
        GLOWREC = null;
        return out;
      })()`, ctxVm);
    };
    for (let lv = 0; lv < 3; lv++) {
      const G = { rolls: 0, noSceneAt: [], worstFrac: 0, worstAt: '-', crossN: 0, dqMax: 0, spanMax: 0,
        lampsMin: 1e9, lampsSum: 0, rectMax: 0, pit: 0, pitDark: 0, pitSum: 0, oob: 0, lipRoll: -1, lipDeliv: 1,
        lipOn: 0, lipOnN: 0, lipCross: 0, lipSel: null, lipLamps: 0 };
      for (let r = 0; r < 12; r++) {
        const g = glowAt(lv, r, 1);
        G.pit += g.pit; G.pitDark += g.pitDark; G.pitSum += g.pitSum; G.oob += g.oob;
        if (!g.sel) { G.noSceneAt.push(r); continue; }
        G.rolls++;
        G.crossN += g.st.crossN; G.dqMax = Math.max(G.dqMax, g.st.dq); G.rectMax = Math.max(G.rectMax, g.st.rects);
        G.lampsMin = Math.min(G.lampsMin, g.st.lamps); G.lampsSum += g.st.lamps;
        const frac = g.st.model > 0 ? g.st.leak / g.st.model : 0;
        const sf = g.st.model > 0 ? g.st.spanCross / g.st.model : 0;
        G.spanMax = Math.max(G.spanMax, sf);
        if (frac > G.worstFrac) { G.worstFrac = frac; G.worstAt = 'roll ' + r; }
      }
      for (let r = 0; r < 12 && G.lipRoll < 0; r++) {
        const g = glowAt(lv, r, -1);
        if (!g.sel) continue;
        G.lipRoll = r; G.lipSel = g.sel; G.lipLamps = g.st.lamps; G.lipCross = g.st.crossN;
        G.lipDeliv = g.st.on > 0 ? g.st.onDeliv / g.st.on : 0;   // no on-band px = 0, never a vacuous 1
        G.lipOn = g.st.on; G.lipOnN = g.st.onN;
      }
      const fl = glowFlat(lv);
      const pm = G.pit ? G.pitSum / G.pit : 0;
      row(`L${lv} the glow is admitted by the SURFACE's band`,
        G.rolls >= 1 && G.crossN > 0 && G.worstFrac <= MAXFRAC && G.spanMax <= MAXFRAC && G.lampsSum > 0 &&
        G.lipRoll >= 0 && G.lipDeliv >= MINDELIV && G.lipOn > 0 && G.pitDark === RECDARK[lv] &&
        Math.abs(pm - RECPIT[lv]) <= 0.005 && G.oob <= RECOOB[lv] && fl.lamps > 0 && fl.multi === 0 && fl.dev < 1e-9,
        `(1) ${G.crossN} sampled px of ${G.rolls} of 12 rolls sit on a surface that is not the source's band `
        + `(worst band step ${G.dqMax} quanta, no pit-floor camera at roll${G.noSceneAt.length ? `s ${G.noSceneAt.join(' and ')}` : 's none'}), `
        + `and ${G.worstFrac.toFixed(3)} of a disc's alpha lands there (worst ${G.worstAt}; altitude route ${G.spanMax.toFixed(3)}; `
        + `the revert control reads 1.000 on this clause - 100 % of every disc painted into the pit, which IS #221's 183.8/245.0) `
        + `${G.lampsSum} lamp discs drawn across those ${G.rolls} cameras (min ${G.lampsMin === 1e9 ? 0 : G.lampsMin} at a single one of them), so the row is not `
        + `satisfied by deleting the glow (that control reads on-delivered 0.00 and FAILS clause 3) (3) at the LIP camera, roll `
        + `${G.lipRoll} ${G.lipSel ? G.lipSel.cx.toFixed(1) + ',' + G.lipSel.cy.toFixed(1) + ' floor ' + G.lipSel.q.toFixed(2) + ' looking at a lamp ' + G.lipSel.lf.toFixed(2) : 'none found'}, the source's own band still `
        + `receives ${G.lipDeliv.toFixed(3)} of the alpha the disc carries onto it (${G.lipOn.toFixed(1)} alpha on ${G.lipOnN} px, ${G.lipLamps} lamps, `
        + `${G.lipCross} cross-band px) - the camera-band-not-surface-band version reads 0.000 there, because it drops the `
        + `whole disc and a player at the lip loses the lamp below them entirely (4) MAP.light is untouched by a composited `
        + `change: ${G.pitDark} dark of ${G.pit} pit cells against the recorded ${RECDARK[lv]} of ${RECPITN[lv]} at mean `
        + `delivered ${pm.toFixed(3)} against the recorded ${RECPIT[lv]} and ${G.oob} wrong-band-lit open cells against `
        + `${RECOOB[lv]} (the splat-pass sabotage moves THIS clause, not 1-3) (5) on a forced-flat level the fill is the one `
        + `rect it always was: ${fl.lamps} lamps, ${fl.multi} multi-rect, geometry+alpha deviation ${fl.dev.toExponential(1)} - flatparity's md5 `
        + `cannot see this layer, px is the buffer the world pass wrote before it.`);
    }
  }
  console.log(bad ? `ALT ${bad} FAILURES - the bands are not there, not linked, or there is nothing to look at`
    : 'ALT ok - bands authored, linked, reachable, and there is volume to look at');
  process.exit(bad ? 1 : 0);
}

if (MODE === 'flatparity') {
  /* The backwards-compatibility test every altitude change has passed: force the grid flat and
     the spawn-camera frame must hash bit-identical against the build before the change. The
     generator authors real bands now (#152), so flat has to be FORCED - and the lightmap
     rebuilt through the game's own splatLight after the forcing, because a lightmap splatted
     over banded ground still carries the weight the fixed build evaluated against those bands.
     Each authored-z light's hover offset is re-seated on the flat grid with the same
     arithmetic the generator uses (floorAt + 0.78 for a lamp), so both sides of the comparison
     run one identical world; z-less lights (the exit pad) are left z-less and take the
     floorAt default on both builds, which is byte-equal by construction. Nothing here is in
     the shipped path.

     TWO TRIPLES, AND THEY MEAN DIFFERENT THINGS. Since #208 the generator authors lamps by a coverage
     rule (#204), so this probe can force a flat world two ways: with the lamp record the shipped path
     makes, or with the coverage top-up suppressed at author time (LAMPS=off, view.js:152). They hash
     differently, and only one of them is a parity proof:

       PARITY  LAMPS=off    the top-up never authored, so the lamp record is 2c5a94f's and the ONLY
                            difference from that build is the band term in splatLight. This is the
                            formula-collapse proof every altitude change since M1 has passed.
       LOCK    LAMPS unset   the shipped record: same formula, more lamps, some of them placed for a
                            band this probe then flattened. It moves when PLACEMENT moves and proves
                            nothing about a term - it is a regression lock on lamp placement.

     The trap this header exists to close: "the flat md5 parity holds" read off the LOCK row is not
     evidence that a shading change is bit-neutral. Since #208 that sentence was true of the LOCK row and
     false as a formula claim, and nothing said so - L0 moved to 4262d051 (81.3) and L2 to 050b225e
     (51.7) with the kernel alone measured bit-neutral. So both are recorded, both are checked, the knob
     is in the label of each row, and the gap between them is decomposed into lamps below rather than
     waved away. Run LAMPS=off when what you are asking is "is my term bit-neutral?".

     CONTROLS, each run against this branch's kernel in its own worktree (never a file copy of the
     probe), so both rows are known to be able to fail AND known to be unable to fail on one thing:

       this js, LAMPS=off                     the OLD triple, ok - the kernel term is bit-neutral;
       MAIN's js (2c5a94f) with these tools   LOCK FAIL x2 (L0, L2 - L1 is byte-identical in both
                                            records) and PARITY ok x3: the same run reproduces the
                                            OLD triple, which is the third quadrant for free, because
                                            those hashes are what main's own flatparity prints;
       this js, refs set to the OLD triple    LOCK FAIL x2 - so the LOCK row is satisfied by the
                                            recorded md5, not merely by the hashes being stable;
       this js, radial exponent 1.6 -> 1.55   PARITY FAIL x3 and LOCK FAIL x3 (means 82.8 / 34.9 /
                                            52.5) - a term that is NOT bit-neutral reddens both;
       this js, band term made ONE-SIDED      the two FLAT senses stay GREEN on all three levels - LOCK
         (light reaching up blocked, reaching  060da4cd/f05beeb5/050b225e and PARITY f9e4da3a/f05beeb5/
          down unbounded: `lf - floor >=        d4b2d2cd, byte-identical to main - and THAT is the limit of
          -ZQ - 1e-9`, the variant that trades  what a FLAT frame can prove. THE DEALT SENSE DOES NOT: on
          one half of the bleed for the other)  that kernel it reddens 3 of 3 levels at the grid-chosen
                                            DEALT_SEATS camera #226 installed (measured on #226's branch
                                            with the sabotage and the assertion in one tree; at the spawn
                                            seats #219 inherited it was 2 of 3, and level 2's green row
                                            there - an 8-px dealt frame - was the blind camera, not a
                                            blind row). This is not a threshold a reviewer could tighten: on a
                                            flat grid the term reduces to the literal 1 before the sign
                                            is ever read, so NO flat frame can ever fail a signed term.
                                            The sign is gated twice now - DEALT by the dealt frame, and
                                            alt by the lightmap, whose "no column is lit from a band
                                            ABOVE it" row reads 169 / 279 / 117 on the one-sided kernel
                                            and 0 / 0 / 0 on main (169 / 279 / 117 above and 281 / 198 /
                                            270 below with the term deleted outright, wv = 1). The 273
                                            this row used to quote for level 1, and CHANGELOG:131/:137,
                                            was an older deal's digit - measured 279 on this branch.

     The hashed frame is not the first renderWorld of the process. Two determinism hazards
     are measured at 9656176 while building this probe: the FIRST frame after startLevel hashes
     differently across identical builds (the pose cache answers a cold request from the
     nearest-pose path, whose contents depend on process history), and EVERY frame hashes
     differently inside one process - the harness stubs performance.now() as Date.now()
     (view.js:121), and drawViewModel integrates its look-lag against that wall-clock dt (the
     same trap viewmodel's own notes at :3055 and :4007 describe: "two frames rendered back to
     back are NOT the same pose"). So the probe pins the sandbox clock, renders a few frames at
     constant dt until the damping converges, and hashes a warm frame - then re-renders and
     re-hashes to prove the pair agree before anyone compares them across builds. */
  const crypto = require('crypto');
  /* RECORDED. OLD is what 2c5a94f's own flatparity prints, measured in this checkout; SHIP is what this
     build's shipped path prints. L1 is byte-identical in both senses at this dice - the top-up adds no
     lamp to level 1 here (the counts are printed in the decomposition rows), so only 2 of 3 levels can
     tell the senses apart, and the control row says so instead of claiming a triple moved. */
  const OLD = refRecord('flatparity', 'PARITY', 'md5', ['f9e4da3af18836db903fd7cbdf2b0206', 'f05beeb58f1266a1aea7e44712995292', 'd4b2d2cd539c3b620ea0ce5ab115d50a']);
  const OLDM = [79.7, 34.1, 47.5];
  /* #213 moves SHIP[0] to 060da4cd (80.8, from 4262d051/81.3) and nothing else: a coverage top-up's
     intensity now scales with the cells it covers, so the shipped world gains DIMMER sources and L0's
     spawn frame repaints. L1 and L2 are byte-identical at TARGET <= 64 - their top-ups each cover >= 32
     cells, so the scale is exactly 1 and 1.05 * 1 === 1.05. The PARITY triple did not move at all, which
     is the knob-independence proof: with the top-up suppressed at author time this change runs no code. */
  const SHIP = refRecord('flatparity', 'LOCK', 'md5', ['060da4cdaadc2e4a4276ce8f06b0eecf', 'f05beeb58f1266a1aea7e44712995292', '050b225e3f295b3ca991d59addea2f1c']);
  const SHIPM = [80.8, 34.1, 51.7];
  /* #219's DEALT triple, #226's camera: the frame of each level AS DEALTED - bands, band term, shipped
     lamp record, same dice (1000 + level*97) and the same pinned-clock ninth render - but at a seat
     CHOSEN FROM THE GRID, not the spawn seat #219 inherited. Where LOCK is a
     regression lock on lamp PLACEMENT in a world this probe flattened, this one is a lock on the
     banded world the generator deals: it moves when the dealt picture moves, which the two flat triples
     structurally cannot do. Its churn is MEASURED, not assumed - see the DEALT row for the count (9 of 11
     recent js commits move at least one of the three hashes at the spawn-seat camera; the new seats only
     raise the odds of a move), which is what makes this a lock that
     re-records often rather than a proof. The clauses beside it are the falsifiable half. History kept
     from the spawn-seat triple (ecb797dd/96a450d0/22d473ed, means 79.5/33.7/51.7, recorded across #219,
     #224 and #195, whose dealt frames differed from their flattened twins on 45,871 / 78,636 / 8 px):
     the triple below replaces it at the same dice, and #195's crease entry survives in the churn run,
     not in this line. */
  /* #226. The triple above was hashed at the SPAWN seat, and the spawn seat is a cell the generator
     happens to start the player on, not a pose chosen to see anything: level 2's dealt frame differed
     from its flattened one by 8 px of 203,138 while the level holds 292 off-datum open cells, so a
     sabotage that deletes splatLight's band term (wv = 1: banded world, flat-shaded light) moved the
     dealt hash on 2 of 3 levels and the class shipped green on the level with the MOST altitude.
     The seats below are chosen from the grid instead: for each level, the spawn cell plus open cells
     reached by walking out from it, each scored by how many of the level's off-datum OPEN cells an
     eye-height DDA sweep across the camera FOV (2*atan(cfg.plane)) ENTERS; candidates were restricted
     to DATUM cells so the dealt-vs-flat gap counts what the camera SEES and not a frame shift from the
     player's own altitude; ties by longest central ray (CAMSET's lesson, as a tiebreak only); the
     chosen entry per level is a candidate whose dealt md5 MOVES under wv = 1 and, among those, the one
     with the largest dealt-vs-flat gap. The chosen seats, per level, are then (off-datum-in-view /
     dealt-vs-flat px / wv=1 dealt-vs-dealt px moved): L0 (14.5,12.5,3pi/4) 137 of 165 / 195,990 /
     196,075; L1 (14.5,7.5,0) 174 of 246 / 195,620 / 196,718; L2 (15.5,17.5,5pi/8) 184 of 292 /
     198,982 / 198,618. Candidate scoring ran in single-level cold children (their gaps read +-2 px off
     the sampler's, e.g. 195,621 vs 195,620); at the time the sampler's level-ordered process was THE RECIPE
     and a child that rendered only level 2 hashed it ce8e96a3 while the sampler hashed 158327b0 at the SAME
     js and seat - #224's alternation arriving BETWEEN levels, and the reason #243 retired that recipe: the
     sampler now boots before every level, so the roster order cannot reach the hash and the cold children's
     numbers are the lock. The wv = 1 column is a true dealt-vs-dealt buffer diff at the sampler order
     (clean and sabotaged trees, buffers dumped and diffed; the six hashes cross-check the full-probe
     control run line for line). Rejected with the
     worst gaps: flat-looking corners whose view
     contains NO off-datum column at all (L1 (3.5,30.5) 0/246, L2 (34.5,34.5) 0/292 - the 8-px class in
     seat form), the L0 corner (18.5,2.5) at 2/165, and the spawn seats themselves - the L2 spawn seat
     at its grid-best yaw sees 24/292 and gaps 11,271 px, clearing the vacuity floor on 4% of the
     population, while its SHIPPED default yaw - the pose #224 hashed - gaps 8 px and does not move at
     all when the band term dies. The triples below were re-recorded cold at
     the new seats, two cold samplers agreeing per level. The census clause and the DEALT-VACUOUS row
     below are the falsifiable half; a DEALT ref locks the dealt picture only where the camera is
     pointed at it, and the chosen views enter 137/165, 174/246 and 184/292 of each level's off-datum
     open population - the coverage count is printed per seat, the frame pixel difference is gated. */
  const DEALT_SEATS = [
    [14.5, 12.5, 2.356194490192345],  // L0 dice 1000: 137/165 off-datum open cells in view, gap 195,990 px
    [14.5, 7.5, 0],                   // L1 dice 1097: 174/246 in view, gap 195,621 px
    [15.5, 17.5, 1.9634954084936207]  // L2 dice 1194: 184/292 in view, gap 198,984 px
  ];
  const DEALTVAC = 4096;  // px of the 203,138-px frame (2%) - #226 vacuity floor, see the DEALT-VACUOUS row
  /* #243 re-recorded this triple for L1 and L2, and NOTHING about the world moved.
     old  3e88c850 / 889817bf / 158327b0   the level-ordered sampler's numbers: level 0 cold, levels 1 and
          2 hashed with a level's worth of rendering in front of them.
     new  3e88c850 / f240fd35 / ce8e96a3   the same three levels each hashed after a boot and nothing else.
     L0 did not move, which is the control: it was already the first thing its process drew. L1 and L2 moved
     by 24 px and 16 px of 203,138 - the view model's rectangle, x 407..459 y 276..305 - because the gun's
     depth scratch no longer arrives carrying the previous level's rectangle (see DEALT-ORDER for the
     attribution and the boot in the sampler for the fix). The means are IDENTICAL to two decimals (57.3 /
     58.7 / 86.0), which is what 16 pixels of a 203,138-px frame does to a mean, and the dealt-vs-flat gaps
     are 195,990 / 195,621 / 198,984 px against #226's floor of 4,096: the seats still see what they were
     chosen for. The two numbers #241 recorded as the cold children's (f240fd35, ce8e96a3) are now the lock,
     so the value a single-level run prints and the value the roster prints are the same number - which is
     the DEALT-ORDER row's whole job. */
  /* #206 re-recorded this triple again, and here the world DID move: blurLight gained the splat
     kernel's own band gate, so delivered light no longer crosses a riser in the dealt grids - the
     cells beside slabs and the pit floors that leaned on cross-band tails go darker (means 57.3 /
     58.7 / 86.0 -> 55.3 / 57.8 / 85.1), and the dealt wrong-band population fell 37/49/75 ->
     19/10/16 per 12 rolls. The two FLAT senses (LOCK, PARITY) did not move a bit under the same
     change - which is what makes this a light-population move rather than a renderer move. */
  const DEALT = refRecord('flatparity', 'DEALT', 'md5', ['bb12ef3e81443b9260a0827b55a6154f', '370d3f7a88596a5bfc36bfc9c98b6858', '3a51e659bf0b5cd60985447928db01cf']);
  const DEALTM = [55.3, 57.8, 85.1];
  const OFF = process.env.LAMPS === 'off';
  const f1 = v => (v === undefined || v === null ? '-' : (+v).toFixed(1));
  const md5of = () => { const d = new Uint32Array(run('px'));
    return crypto.createHash('md5').update(Buffer.from(d.buffer, d.byteOffset, d.byteLength)).digest('hex'); };
  const hashes = [], mns = [], flat = [], dealt = [], openCells = [];
  const NL = run('LEVELS.length');
  const CENSUS = `(()=>{ let n = 0, o = 0; for (let i = 0; i < MAP.fz.length; i++) {
      if (MAP.cell[i]) continue; o++; if (MAP.fz[i] !== 0) n++; } return { off: n, open: o }; })()`;
  /* THE DEALT SENSE GETS ITS OWN PROCESS, AND THAT IS A MEASURED RESULT, NOT A TASTE. The frame is
     hashed at a FIXED render index with the clock pinned, and rendering ANYTHING else in the process
     first moves that hash. Measured three ways against the recorded 060da4cd/f05beeb5/050b225e:
     8 extra renders before the flat hash gives e96fe6bb/f746bcb5/32d25823, 9 gives
     bee34388/90f20cbd/050b225e - and rendering the dealt frame per level, whether BEFORE the flat hash
     (L0/L1 move to bee34388/90f20cbd) or AFTER it (L1/L2 move to 37cb3011 and 4e718f4f/b9ba6913), moves
     LOCK and PARITY too. So there is no ordering in which a dealt render and a flat hash coexist, and
     the probe's own doctrine - "this probe may not render both records in one process" - is what settles
     it: DEALT is sampled by a cold child that never flattens anything, exactly as the two lamp records
     are sampled cold. It used to blame "the pose cache answering a cold request from the nearest-pose
     path" for what moved between renders; #243 measured that claim and it is FALSE for the levels: clearing
     js/13_mesh.js's POSE between levels leaves all three dealt hashes byte-identical, js/11_rig.js's LRU
     answers 0 entries / 0 made at every level boundary because the draw path has not called RIG since #72,
     and what does move is 24 px (L1) / 16 px (L2) inside the view model's own rectangle - the gun's depth
     scratch, cleared over the region the PREVIOUS frame's view model wrote. That is why the sampler boots
     per level rather than clearing a list, and why DEALT-ORDER exists to keep it honest. */
  const LUMA = `const d = new Uint32Array(px), B = BW * BH; let s = 0;
      for (let i = 0; i < B; i++) s += 0.2126 * (d[i] & 255) + 0.7152 * (d[i] >> 8 & 255) + 0.0722 * (d[i] >> 16 & 255);
      return s / B;`;
  const SETTLE = `P.pitch = 0; P.vx = P.vy = P.vz = 0; P.air = false; P.crouch = 0; P.z = floorAt(P.x, P.y);
      for (const e of ENEMIES) e.state = 'sleep';
      performance.now = () => 5; VM.t = 5;   // pin the clock: the lag must advance by a constant dt, not by wall ms
      for (let k = 0; k < 8; k++) renderWorld();
      renderWorld();`;
  const FLATTEN = `MAP.fz.fill(0); MAP.cz.fill(CZ_DEF); linkBoundaries();
      for (const L of LIGHTS) if (L.stat && L.z !== undefined) L.z = floorAt(L.x, L.y) + 0.78;
      MAP.light.fill(0); MAP.lR.fill(0); MAP.lG.fill(0); MAP.lB.fill(0); MAP.lw.fill(0);
      for (const L of LIGHTS) splatLight(L, L.str);
      blurLight(); buildTint();`;
  if (process.env.FP_DEALT) {
    /* The DEALT sampler: the level as the generator dealt it - no fill, no cz reset, no relink, no lamp
       re-seat, no splat rebuild, and NO flat render, because a flat render here would move the hash
       below (see above). Same dice, same settle, same ninth render as every other sense in this probe.
       The camera is DEALT_SEATS[lv], #226, applied AFTER the deal by three plain assignments: the RNG
       rule stays exactly #224's (seedRng BEFORE startLevel, so the level is generated from the deal and
       the camera consumes no draws), and the seat cannot perturb generation, enemies or props.
       FP_DEALT1=<lv> samples ONE level and nothing else: the loop still runs 0..NL-1 but skips every
       other level's startLevel and every render, so that level's dealt frame is a cold render in a
       process that has rendered nothing else. #243 hashes each level alone and in level order with it. */
    const ONLY = process.env.FP_DEALT1 === undefined ? -1 : +process.env.FP_DEALT1;
    for (let lv = 0; lv < NL; lv++) {
      if (ONLY >= 0 && lv !== ONLY) continue;
      /* ONE BOOT PER LEVEL, AND THE HASH CANNOT DEPEND ON THE ORDER ANYMORE (#243). What used to leak
         between levels is named by measurement, not by guesswork: hashing level 1 alone in a process
         that rendered nothing else differs from hashing it after level 0 on 24 px of 203,138 (level 2:
         16 px), all of it inside the box x 407..459, y 276..305 of the 601x338 frame - the view model's
         own rectangle, at the bottom of the screen. The mechanism is the gun's DEPTH HISTORY: the scratch
         it self-occludes against is cleared over the region the PREVIOUS frame's view model wrote
         (js/13_mesh.js:858, the induction at :153), so the first frames of a fresh level inherit the
         rectangle the gun drew in the level before, and pixels whose self-occlusion differs never heal -
         nine renders did not heal them. The pose cache is NOT it: clearing MESH's POSE between levels
         moves all three hashes not at all (a hit rebuilds nothing and changes nothing), and js/11_rig.js's
         LRU answers 0 entries / 0 made at every level boundary because the draw path has not called RIG
         since #72. Clearing those two would therefore have been a fix that fixes nothing. A re-boot is the
         whole of it because it is not a list: every module global of every js file - zbuf, DECAL_*, LIGHTS,
         POSE, the view-model scratch and its rectangle - comes back at its own initial value, and the two
         node-side holders that outlive a context (elements, rs) are reset inside boot(). knob=false: the
         DEALT sense always reports the SHIPPED lamp record, in code rather than only in the spawn env. */
      boot(false);
      seedRng(1000 + lv * 97);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      const s = DEALT_SEATS[lv];
      run(`P.x=${s[0]}; P.y=${s[1]}; P.ang=${s[2]};`);
      const c = run(CENSUS), dm = run(`(()=>{ ${SETTLE} ${LUMA} })()`);
      const dh = md5of(), dpix = Array.from(new Uint32Array(run('px')));
      // The same level flattened by the probe's own recipe, rendered again at the same render count, so
      // the pixel difference below is the DEALT frame's worth of geometry rather than a camera move.
      run(`(()=>{ ${FLATTEN} ${SETTLE} return 0; })()`);
      const fpix = new Uint32Array(run('px'));
      let nd = 0;
      for (let i = 0; i < fpix.length; i++) if (fpix[i] !== dpix[i]) nd++;
      console.log('  dealt level ' + lv + ' md5 ' + dh + ' mean ' + dm.toFixed(1) + ' off-datum ' + c.off + '/' + c.open +
        ', ' + nd + ' of ' + fpix.length + ' px differ from the flattened frame, rng ' + (1000 + lv * 97) +
        ' at seat ' + DEALT_SEATS[lv].join(','));
    }
    process.exit(0);
  }
  for (let lv = 0; lv < NL; lv++) {
    seedRng(1000 + lv * 97);
    run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
    /* The census is a COUNT, not a render: it reads the dealt grid without touching it, so it costs
       nothing and pollutes nothing - which is why it can sit in the flat pass at all. */
    const c0 = run(CENSUS);
    dealt.push(c0.off); openCells.push(c0.open);
    const mean = run(`(()=>{ ${FLATTEN} ${SETTLE} ${LUMA} })()`);
    hashes.push(md5of()); mns.push(mean);
    /* How many off-datum OPEN cells survive the fill just above: 0, because THIS probe put it there. Read
       from the world that was just hashed rather than from this file's comments. */
    flat.push(run(CENSUS).off);
    console.log('  level ' + lv + '  flat spawn-frame md5 ' + hashes[lv] + '  mean ' + mean.toFixed(1) +
      '   [dealt grid: ' + dealt[lv] + '/' + openCells[lv] + ' open cells off the datum]');
  }
  if (process.env.FP_CHILD) process.exit(0);
  /* The self-check re-runs the WHOLE probe as a cold child process and demands identical
     per-level hashes. Consecutive renders inside ONE process are NOT hash-stable: measured at
     9656176, the same state alternates between two frames every renderWorld, deterministically
     (a 16-render hash stream repeats exactly across independent runs), and the alternation
     survives removing enemies, props, pickups and lights - some per-render cache or pool state
     in the draw path is responsible; this probe does not claim to have found its mechanism.
     What WAS measured true is the property this tool needs: cold-process-to-cold-process, the
     whole hash stream is byte-identical. So the probe spawns itself (a twin of this pass, plus two
     cold samples of the other lamp record) and requires the pairs to agree before calling these md5s
     comparable across builds - a parity claim hashes a
     cold-start frame at a fixed render index, never "the second render". The clock pin above
     is separate and load-bearing: the harness stubs performance.now() as Date.now() (view.js:
     121) and drawViewModel integrates look-lag against that dt (:3055/:4007 describe the same
     trap), so unpinned frames advance the gun's lag by wall milliseconds - which is how two
     runs of ONE unchanged build hashed differently under machine load at first. */
  const spawn = flip => {
    const env = Object.assign({}, process.env, { FP_CHILD: '1' });
    if (flip) { if (OFF) delete env.LAMPS; else env.LAMPS = 'off'; }
    const c = require('child_process').spawnSync(process.execPath, [__filename, 'flatparity'],
      { env, encoding: 'utf8', timeout: 900000 });
    const h = [], mm = []; let n = 0;
    for (const line of String(c.stdout || '').split('\n')) {
      const q = /^\s*level (\d+)\s+flat spawn-frame md5 ([0-9a-f]{32})\s+mean ([-\d.]+)/.exec(line);
      if (!q) continue;
      const lv = +q[1]; h[lv] = q[2]; mm[lv] = +q[3]; n++;
    }
    return { h, mm, n, status: c.status, why: String(c.error || c.stderr || '').split('\n')[0] };
  };
  /* The DEALT sampler, cold. It always runs the SHIPPED lamp record - the knob is a lamp-authoring knob
     and the dealt world is the shipped one - so an LAMPS=off pass still reports the same DEALT hashes and
     says so. Two samples, because one cold process proves nothing about stability: the property every
     hash in this probe rests on is cold-to-cold. */
  const spawnDealt = () => dealLines(runDealt({}));
  /* ONE LEVEL IN A PROCESS THAT RENDERS NOTHING ELSE (#243). Same sampler, one level skipped past rather
     than rendered: FP_DEALT1=<lv> makes the loop `continue` for every other level, so nothing before this
     level's own startLevel has drawn a pixel in this context. The DEALT-ORDER row below hashes with this
     AND with the level-ordered sampler and requires the two to agree - which is what makes the recorded
     triple a property of the LEVEL and not of the roster that happened to run before it. */
  const spawnDealtOne = lv => dealLines(runDealt({ FP_DEALT1: String(lv) }));
  const runDealt = (extra) => {
    const env = Object.assign({}, process.env, { FP_DEALT: '1' }, extra);
    delete env.LAMPS; delete env.FP_CHILD;
    return require('child_process').spawnSync(process.execPath, [__filename, 'flatparity'],
      { env, encoding: 'utf8', timeout: 900000 });
  };
  const dealLines = c => {
    const r = { h: [], mm: [], dn: [], dOpen: [], dPx: [], dTot: [], rng: [], n: 0, status: c.status,
      why: String(c.error || c.stderr || '').split('\n')[0] };
    for (const line of String(c.stdout || '').split('\n')) {
      const q = /^\s*dealt level (\d+) md5 ([0-9a-f]{32}) mean ([-\d.]+) off-datum (\d+)\/(\d+), (\d+) of (\d+) px differ from the flattened frame, rng (\d+)/.exec(line);
      if (!q) continue;
      const lv = +q[1]; r.h[lv] = q[2]; r.mm[lv] = +q[3]; r.dn[lv] = +q[4]; r.dOpen[lv] = +q[5];
      r.dPx[lv] = +q[6]; r.dTot[lv] = +q[7]; r.rng[lv] = +q[8]; r.n++;
    }
    return r;
  };
  const sameStream = (a, b, n) => a.n === n && b.n === n && a.h.slice(0, n).every((x, i) => x === b.h[i]);
  const twin = spawn(false);
  if (twin.status !== 0 || !sameStream({ h: hashes, n: hashes.length }, twin, hashes.length)) {
    console.log('FLATPARITY UNSTABLE on the ' + (OFF ? 'LAMPS=off' : 'shipped') + ' pass - hashes describe nothing.' +
      ' child exit ' + twin.status + ' ' + twin.why);
    process.exit(1);
  }
  /* The OTHER lamp record, sampled twice cold. Twice, because a single cold process proves nothing about
     stability - the property above is cold-to-cold - and this pass may not render both records in one
     process, which is the alternation the comment above measured. The samples run with FP_CHILD so they
     print their streams and do not recurse; the rows below are printed once, by the pass that was asked
     for them. */
  const o1 = spawn(true), o2 = spawn(true);
  if (o1.status !== 0 || o2.status !== 0 || !sameStream(o1, o2, hashes.length)) {
    console.log('FLATPARITY UNSTABLE across the LAMPS=' + (OFF ? 'unset' : 'off') + ' pass - hashes describe nothing.' +
      ' child exits ' + o1.status + '/' + o2.status + ' ' + (o1.why || o2.why));
    process.exit(1);
  }
  const shipH = OFF ? o1.h : hashes, shipM = OFF ? o1.mm : mns;
  const parH = OFF ? hashes : o1.h, parM = OFF ? mns : o1.mm;
  const dv1 = spawnDealt(), dv2 = spawnDealt();
  /* Each level again, alone in its own process. Three children, ~10 s each on this box: the price of
     proving the lock does not depend on the order, and the only way to ask the question - "individually"
     and "in level order" cannot be sampled in the same process, because a process that sampled both would
     itself be an order. */
  const dOne = [];
  for (let lv = 0; lv < NL; lv++) dOne.push(spawnDealtOne(lv));
  if (dv1.status !== 0 || dv2.status !== 0 || !sameStream(dv1, dv2, NL)) {
    console.log('FLATPARITY UNSTABLE across the DEALT samplers - the dealt hashes describe nothing.' +
      ' child exits ' + dv1.status + '/' + dv2.status + ' ' + (dv1.why || dv2.why));
    process.exit(1);
  }
  let bad = 0;
  const row = (label, ok, detail) => { if (!ok) bad++; console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + ' - ' + detail); return ok; };

  for (let lv = 0; lv < NL; lv++) {
    row('L' + lv + ' PARITY  collapses to 2c5a94f   [LAMPS=off - the coverage top-up never authored]',
      parH[lv] === OLD[lv],
      'md5 ' + parH[lv] + ' mean ' + f1(parM[lv]) + ' against the triple 2c5a94f prints (' + OLD[lv] + ' mean ' + OLDM[lv] +
      '). The lamp record is that build\'s, so the only difference from it is the band term in splatLight: THIS is the\n' +
      '        formula-collapse proof, the one a shading change is gated on. Run LAMPS=off to use it.');
    row('L' + lv + ' LOCK    holds at the shipped record   [LAMPS unset]',
      shipH[lv] === SHIP[lv],
      'md5 ' + shipH[lv] + ' mean ' + f1(shipM[lv]) + ' against the recorded ' + SHIP[lv] + ' mean ' + SHIPM[lv] +
      '. This is a REGRESSION LOCK on lamp placement, not a\n' +
      '        formula claim: it moves when a placement rule moves, so green here is NOT evidence that a term is bit-neutral.');
  }
  /* #219. The census used to be counted from the grid AFTER this probe's own MAP.fz.fill(0), so the run
     ended by printing "0 / 0 / 0 cells off the datum" as a property of the game while describing the
     probe - the trap AGENTS.md records for alt (a probe that builds its own geometry cannot fail on a
     world that has none), arriving from the other side: a probe that ERASES geometry cannot fail on a
     world that has it either, and then reports the resulting blindness as flatness. Three clauses are
     asserted per level, each measured from a grid that has the geometry its own claim needs:
       dealt >= 1     the generator authored altitude. Counted over OPEN columns with the game's own
                      MAP.cell, which is alt's definition - a solid column's fz is a wall base carried
                      down to the band it bounds, not a band anyone walks on;
       after == 0     the flat senses really do hash a flattened grid, which is what makes PARITY a
                      collapse rather than a description of an already-flat world;
       md5 == DEALT   the lock #219 asked for, on the world as dealt, sampled cold in its own process,
                      at a camera chosen from the grid (#226) and not the spawn seat - and only if the
                      sampler dealt itself from the dice it says it did (rng == 1000 + level*97, #224's
                      rule, now captured from the sampler line instead of ambient).
       px >= FLOOR   DEALT-VACUOUS (#226, its own row below): how much of the dealt frame the bands
                      actually cause, now GATED. The floor is 4,096 px of the 203,138-px frame (2%),
                      chosen from the measurements beside it: the old spawn seats read 45,871 / 78,636 /
                      8 px, and 8 px of 203,138 is the per-render alternation floor - a frame that
                      differs from its own flattened twin by nothing the camera can attribute to the
                      bands. The new seats measure 195,620..198,982 px at the sampler order, 48x above the floor, so the
                      row
                      is nowhere near its own cliff, while a camera that sees no band - the 8-px class -
                      cannot pass it. Vacuity is a FAILURE, never a pass with an explanation attached.
     Churn measured over the 12 most recent js commits (828d1b4 back to f7d1847, one recipe against each
     commit's own js at the pinned dice, two cold samples per commit, all stable): 9 of the 11 with a
     measured parent move at least one of the three hashes - only 4f2b9c0 (#217, a prop-cull fix) and
     acdf91d (#183) leave the dealt frame byte-identical. Per column the triple is carried almost entirely
     by level 0 (9 of 11 boundaries move L0, 2 move L1, 5 move L2), so a single-level DEALT lock would be
     a nearly-dead lock - level 0 carries the signal on its own. Attribution is the child's: in a list
     filtered to js-touching commits the older row is the parent, so a pair that hashes equal means the
     newer commit left the dealt frame alone. So a DEALT lock re-records on most js commits: it is a LOCK,
     and the clauses above it, not the ref, are
     what would catch generation regressing to flat. On the SIGN: the two flat senses cannot see one at
     all (fd = 0 collapses the term to the literal 1 before the sign is read). DEALT can, and was measured
     to - the one-sided kernel `lf - floor >= -ZQ - 1e-9` reddens this row on 2 of 3 levels, and level 2 is
     green because its camera looks at none of its 292 off-datum cells, not because the row is blind. alt
     gates the same class through the lightmap, where the population is countable. */
  for (let lv = 0; lv < NL; lv++) {
    row('L' + lv + ' DEALT  the dealt grid is banded, the flat grid is flat, the dice is the deal, and the dealt frame holds',
      dv1.dn[lv] >= 1 && flat[lv] === 0 && dv1.h[lv] === DEALT[lv] && dv1.rng[lv] === 1000 + lv * 97,
      dv1.dn[lv] + ' of ' + dv1.dOpen[lv] + ' open cells of the level dealt at dice ' + (1000 + lv * 97) + ' sit off the'
      + ' datum (counted from the dealt grid in the sampler that hashed it, before any fill); ' + flat[lv] + ' survive'
      + ' the fill the PARITY/LOCK senses hash, so those two rows describe a world THIS PROBE flattened. The dealt frame'
      + ' differs from the same level flattened by this probe on ' + dv1.dPx[lv] + ' of ' + dv1.dTot[lv] + ' px ('
      + (100 * dv1.dPx[lv] / dv1.dTot[lv]).toFixed(2) + '% of the frame) at the same render count: that ratio is what a'
      + ' DEALT md5 is actually worth at this camera, which #226 chose from the grid rather than inherited from the'
      + ' spawn seat (seat ' + DEALT_SEATS[lv].join(', ') + ', scored by off-datum cells entered by an eye-height FOV'
      + ' sweep - see DEALT_SEATS for the table and the rejected candidates). rng ' + dv1.rng[lv] + ': the sampler'
      + ' reseeds to the deal BEFORE startLevel and the seat costs no draws, so this frame describes THAT deal. Dealt md5 '
      + dv1.h[lv] + ' mean ' + f1(dv1.mm[lv]) + ' against the recorded ' + DEALT[lv] + ' mean ' + DEALTM[lv] +
      ' (two cold'
      + ' samplers agree). At 0 off-datum cells the generator has stopped authoring altitude and PARITY/LOCK would'
      + ' hold on an already-flat world - the first clause is what makes them a collapse rather than a tautology (alt'
      + ' gates >=2 bands, their links and reachability; this gates that there was any geometry here to collapse).'
      + ' Churn: 9 of 11 recent js commits moved this hash (measured at the pre-#226 spawn-seat camera), so green here is a lock on the dealt picture, not a proof'
      + ' that a band term exists or has the right sign.');
    row('L' + lv + ' DEALT-VACUOUS  the dealt frame and the flattened frame are different pictures at this camera',
      dv1.dPx[lv] >= DEALTVAC,
      dv1.dPx[lv] + ' of ' + dv1.dTot[lv] + ' px (' + (100 * dv1.dPx[lv] / dv1.dTot[lv]).toFixed(2) + '%) of the dealt frame'
      + ' differ from the same level flattened at the SAME seat and render count, against a vacuity floor of ' + DEALTVAC +
      ' px (2% of frame, set from the spawn-seat measurements: the worst camera that still saw bands read 45,871 px,'
      + ' and the 8-px level-2 spawn row was pure alternation floor - a frame comparing nothing). A DEALT md5 hashed at'
      + ' a camera below this floor locks a flat-looking view of a banded level and the wv = 1 class ships green there'
      + ' (#226 measured exactly that on the spawn seats: 2 of 3 levels tripped). This row FAILs with this name when'
      + ' the sampler goes blind again - it never fails silently as a green lock.');
    /* #243. THE LOCK MUST NOT DEPEND ON THE ORDER THE ROSTER RAN IN. The two triples this row compares
       cannot be sampled in one process - a process that sampled both would itself BE an order - so the
       per-level child above and the level-ordered sampler above are the two halves, and their agreement is
       the claim. What used to make them disagree is attributed, not guessed: hashing level 1 alone in a
       process that had rendered nothing differed from hashing it after level 0 on 24 px of 203,138, and
       level 2 on 16 px, every one of them inside x 407..459, y 276..305 of the 601x338 frame - the view
       model's rectangle. The gun's DEPTH HISTORY is the mechanism (the scratch it self-occludes against is
       cleared over the region the PREVIOUS frame's view model wrote, js/13_mesh.js:858 with the induction at
       :153), so the first frames of a fresh level inherit the rectangle the gun drew a level ago and the
       pixels whose self-occlusion differs do not heal - nine renders did not heal them. The two caches the
     * issue named are NOT it: clearing MESH's POSE between levels moves all three hashes not at all, and
       js/11_rig.js's LRU answers 0 entries / 0 made at every level boundary because nothing in the draw
       path has called RIG since #72. So the fix is a re-boot per level, which is not a list of caches and
       therefore cannot be incomplete, and this row is what stays red if a future js commit puts state
       somewhere the boot does not reach. */
    const one = dOne[lv];
    const hOne = one.h[lv], hOrd = dv1.h[lv];
    const isMd5 = s => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
    row('L' + lv + ' DEALT-ORDER  the dealt hash is a property of the level, not of the order the roster ran in',
      isMd5(hOne) && isMd5(hOrd) && one.n === 1 && one.status === 0 &&
      hOne === hOrd && hOne === DEALT[lv] && one.rng[lv] === 1000 + lv * 97,
      (isMd5(hOne) ? 'hashed ALONE in its own process: ' + hOne : 'NO HASH from the single-level sampler (exit ' +
        one.status + ' ' + (one.why || 'no line matched') + ')') + ', hashed IN LEVEL ORDER by the sampler that ran ' +
        NL + ' levels in one process: ' + (isMd5(hOrd) ? hOrd : 'none') + ', recorded ' + DEALT[lv] + ', against a ' +
        NL + '-level roster that has rendered ' + (lv === 0 ? 'nothing' : 'level' + (lv === 1 ? ' 0' : 's 0..' + (lv - 1))) +
        ' before it. They agree because the DEALT sampler re-boots the game before every level (see the sampler), and '
      + 'the two orders are then the same state reached by two routes. A disagreement is #243 come back: the recorded '
      + 'triple would again describe a render ORDER rather than a level, so any probe that reorders or parallelises the '
      + 'roster turns the DEALT rows red with a clean tree. NO HASH is VACUITY, not a pass - a row comparing nothing '
      + 'cannot agree with anything, so an empty or malformed hash fails here by name. rng ' + one.rng[lv] + ' and ' +
      one.dPx[lv] + ' px of dealt-vs-flat gap say the lone sampler really did deal the level rather than skip it.');
  }
  const dLock = shipH.filter((x, i) => x !== OLD[i]).length, dPar = parH.filter((x, i) => x !== SHIP[i]).length;
  const sumGap = [], addN = [];

  /* WHY the two triples differ, decomposed into lamps instead of asserted. Each pass: generate (same
     dice the hash loop uses), snapshot the lamp record, then run the probe's own flatten recipe and sum
     the DELIVERED light channel, blur included, because that is what the frame reads. The two records
     must differ by the top-up lamps and nothing else, so the knob-off record is required to be a
     field-by-field prefix of the shipped one (x, y, r, str, authored z) - that is the check that the
     knob suppresses the top-up and not the world. Then each top-up lamp is splatted ALONE, in the
     authored world and in the flattened one: blurLight is o[i] = sum(w*v)/n with n a function of position
     only, so it is linear and the sum of the blurred solos must equal the difference of the sums to
     floating-point noise. If that residual is not noise the gap is not the lamps, and this row is the
     formula bug. */
  if (!OFF) {
    const KNOB = off => 'topUpEnabled = function () { return ' + (!off) + '; };';
    const SNAP = `(function(){ return { n: LIGHTS.length, np: PROPS.length,
      l: LIGHTS.map(L => ({ x: L.x, y: L.y, r: L.r, str: L.str, z: L.z, col: L.col })) }; })()`;
    const FLAT = `(function(){ const N = MAP.w, B = N * N;
      globalThis.__fzAuth = MAP.fz.slice();
      MAP.fz.fill(0); MAP.cz.fill(CZ_DEF); linkBoundaries();
      for (const L of LIGHTS) if (L.stat && L.z !== undefined) L.z = floorAt(L.x, L.y) + 0.78;
      MAP.light.fill(0); MAP.lR.fill(0); MAP.lG.fill(0); MAP.lB.fill(0); MAP.lw.fill(0);
      for (const L of LIGHTS) splatLight(L, L.str);
      blurLight(); buildTint();
      let post = 0; for (let i = 0; i < B; i++) post += MAP.light[i];
      return { post, lt: Array.from(MAP.lt), l: LIGHTS.map(L => ({ x: L.x, y: L.y, r: L.r, str: L.str, z: L.z, col: L.col })) }; })()`;
    const SOLO = (L, cond) => `(function(){ const N = MAP.w, B = N * N, L = ${JSON.stringify(L)};
      MAP.light.fill(0); MAP.lR.fill(0); MAP.lG.fill(0); MAP.lB.fill(0); MAP.lw.fill(0);
      splatLight(L, L.str);
      let pre = 0, touch = 0, lit = 0, offb = 0;
      for (let i = 0; i < B; i++) { const v = MAP.light[i]; pre += v; if (v > 1e-6) { touch++; if (v >= 0.25) lit++; if (${cond}) offb++; } }
      blurLight();
      let post = 0; for (let i = 0; i < B; i++) post += MAP.light[i];
      return { pre, post, touch, lit, offb }; })()`;
    const COND_AUTH = `Math.abs(MAP.fz[i] * ZQ - (L.z === undefined ? floorAt(L.x, L.y) : L.z - LHOVER)) > ZQ + 1e-9`;
    for (let lv = 0; lv < NL; lv++) {
      run(KNOB(true)); seedRng(1000 + lv * 97);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      const b0 = run(SNAP), bF = run(FLAT);
      run(KNOB(false)); seedRng(1000 + lv * 97);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      const s0 = run(SNAP);
      const au = s0.l.slice(b0.l.length).map(L => run(SOLO(L, COND_AUTH)));
      const sF = run(FLAT);
      const ex = sF.l.slice(bF.l.length).map(L => run(SOLO(L, `globalThis.__fzAuth[i] !== 0`)));
      let prefix = s0.l.length >= b0.l.length;
      for (let k = 0; prefix && k < b0.l.length; k++)
        for (const f of ['x', 'y', 'r', 'str', 'z']) if (s0.l[k][f] !== b0.l[k][f]) prefix = false;
      const delta = sF.post - bF.post, solos = ex.reduce((a, o) => a + o.post, 0), resid = Math.abs(delta - solos);
      let tintMoved = 0;
      for (let i = 0; i < bF.lt.length; i += 3) if (Math.abs(bF.lt[i] - sF.lt[i]) > 4 || Math.abs(bF.lt[i + 1] - sF.lt[i + 1]) > 4 ||
        Math.abs(bF.lt[i + 2] - sF.lt[i + 2]) > 4) tintMoved++;
      row('L' + lv + ' the gap between the two triples is the top-up lamps and nothing else',
        prefix && ex.length === s0.l.length - b0.l.length && (delta === 0 ? resid < 1e-4 : resid <= Math.abs(delta) * 0.001),
        'lamps ' + b0.n + ' -> ' + s0.n + ', props ' + b0.np + ' -> ' + s0.np + ', knob-off record is a field-by-field prefix of the shipped one: '
        + (prefix ? 'yes' : 'NO'));
      sumGap[lv] = delta; addN[lv] = ex.length;
      console.log('          flat delivered light sum ' + sF.post.toFixed(1) + ' shipped vs ' + bF.post.toFixed(1) + ' knob-off = '
        + delta.toFixed(2) + '; the ' + ex.length + ' top-up lamp(s) alone deliver ' + solos.toFixed(2) + ' through the same blur'
        + ' (residual ' + resid.toExponential(1) + '), so the ' + f1(shipM[lv]) + '-' + f1(parM[lv]) + ' frame-mean gap is lamps placed on a world'
        + ' the probe flattened, not a term\n          per lamp, cells it serves where it was authored -> cells it lights once the probe flattened'
        + ' the world (the second number is larger because a lamp authored for an N-cell band lands on the whole datum floor): '
        + (ex.length ? ex.map((o, k) => '\n            ' + (au[k] ? au[k].lit : '?') + ' cells at >=0.25 -> ' + o.lit + ' cells at >=0.25, of the '
          + o.touch + ' cells it touches ' + o.offb + ' sit where a band was deleted, blurred sum ' + o.post.toFixed(2)).join('') : 'none')
        + (tintMoved ? '\n          the delivered TINT also moves on ' + tintMoved + ' cells (the lamps carry the level lamp colour, so'
          + ' the gap is not a light-channel-only difference)' : ''));
    }
  }
  /* The instrument comparison, measured rather than asserted: a spawn-camera frame sees the cells it
     can see, so a lamp placed in a room the camera cannot reach moves NO pixel. The lightmap sum has no
     such blindness. On these dice level 1's frame is byte-identical in both senses while its light sum
     moves by +131 - which is why the LOCK row above is called a lock and not a proof, and why the
     decomposition is what a placement change is actually read against. */
  /* Counted from a BOOLEAN, not from a string prefix. The first version classified each level into
     'md5+sum' or 'md5 BLIND, sum+' and then counted `seen.filter(s => s[0] === 'm')` - both labels
     begin with 'm', so the count was ALWAYS NL and the row printed "3 of 3 move their flat lightmap
     sum WITHOUT moving a pixel" on the same line whose own per-level list said two of the three had
     moved a pixel (measured: 4262d051/f05beeb5/050b225e vs the old triple, so L0 and L2 moved). A
     count that cannot take another value is not a measurement (AGENTS), and this one was load-bearing
     prose: it is the sentence that tells a reviewer the LOCK row is blind to a lamp in an unseen room.
     Each level is now classified by BOTH instruments - md5 moved or not, lightmap sum moved or not - so
     "md5 BLIND, sum+" is the only label that means the frame is blind, "BOTH FLAT" says the top-up lit
     nothing at all, and the row asserts the md5 column agrees with dLock and that a lamp that was added
     moved the lightmap. On main's js the honest reading is 0 blind / 3 BOTH FLAT, because the knob is
     inert there and the two records are the same world - which is the vacuity the dLock >= 1 term sees. */
  const md5Moved = sumGap.map((d, i) => shipH[i] !== OLD[i]);
  const sumMoved = sumGap.map(d => d > 1e-6);
  const seen = sumGap.map((d, i) => md5Moved[i] ? (sumMoved[i] ? 'md5+sum' : 'md5+ (flat sum)')
    : (sumMoved[i] ? 'md5 BLIND, sum+' : 'BOTH FLAT'));
  const blind = sumGap.filter((d, i) => sumMoved[i] && !md5Moved[i]).length;
  const moved = md5Moved.filter(m => m).length, still = sumGap.filter((d, i) => !sumMoved[i] && !md5Moved[i]).length;
  row('the LOCK row is not a lamp census (frame md5 vs lightmap sum)',
    dLock === dPar && dLock >= 1 && (sumGap.length ? sumGap.every(d => d >= 0) && addN.every(n => n >= 0) &&
      moved === dLock && sumGap.every((d, i) => addN[i] === 0 || sumMoved[i]) : true),
    'per level ' + (seen.join(' ') || 'light sums only measured without LAMPS=off')
    + (sumGap.length ? '; ' + blind + ' of ' + NL + ' move their flat lightmap sum WITHOUT moving a pixel'
      + ', ' + moved + ' of ' + NL + ' move a pixel too (dLock ' + dLock + ')'
      + (still ? ', ' + still + ' of ' + NL + ' move neither - the top-up added no lamp that the lightmap sees'
        : '') + ' (gaps +' + sumGap.map(d => d.toFixed(1)).join(' / +') + ' delivered light from +' + addN.join('/')
      + ' lamp(s))'
      : '; the decomposition runs on the shipped pass only, so run this mode without LAMPS=off for it')
    + '. A placement rule that only touches rooms the spawn camera cannot see therefore CANNOT move this'
    + ' triple, so do not read the LOCK row as a lamp census - and note the pair is not vacuous: on MAIN'
    + ' the two senses are identical, the sums do not move, and this row goes red.');
  /* #211 ask 2: the limitation printed NEXT TO the verdict instead of buried in this block's header.
     Every cell of a hashed level sits on the datum, so `fd = 0` and the band term is the literal 1
     before any SIGN is read: NO flat frame can fail a signed band term, and no reference hash can be
     narrowed to make it able to. Measured, not argued - the one-sided kernel `lf - floor >= -ZQ - 1e-9`
     prints ok on all six FLAT rows and hashes both flat triples byte-identical (060da4cd/f05beeb5/
     050b225e and f9e4da3a/f05beeb5/d4b2d2cd, #210 and re-measured on this branch), while alt's band-above
     row FAILS 169/279/117 on that same kernel (the 273 this file carried for level 1 was an older deal's
     digit) and DEALT reddens on 3 of 3 levels at its grid-chosen seats (#226 re-measured with the sabotage
     and the assertion in one tree; it was 2 of 3 at the spawn seats this change replaced). So this probe's flat senses gate the collapse, and the
     dealt frame plus alt's lightmap rows gate the sign; no one of them gates the term. */
  console.log('  --  NECESSARY, NOT SUFFICIENT, AND FLAT BY CONSTRUCTION HERE: the grids behind the two FLAT md5s '
    + 'above are flattened by THIS PROBE (MAP.fz.fill(0) in the hash loop, run after startLevel and before the splat '
    + 'rebuild), so fd = 0 in every cell of the grids they hashed and `Math.abs(lf - floorAt(col)) <= ZQ + 1e-9` '
    + 'evaluates to the literal 1 there - both flat senses are BLIND TO THE SIGN of the band term, and no reference '
    + 'hash can be narrowed to make them able to fail one. That 0 describes the probe, not the game. DEALT CENSUS, '
    + 'counted from the grid the generator dealt at this probe\'s own dice (1000 + level*97), over open columns: '
    + dv1.dn.join(' / ') + ' cells off the datum of ' + dv1.dOpen.join(' / ') + ' open, and the DEALT rows above hash '
    + 'those levels as dealt (triple ' + DEALT.map(x => x.slice(0, 8)).join('/') + '). `view.js alt` counts the same '
    + 'predicate at the harness\'s ambient SEED stream, which it does not reseed per level, so ITS DIGITS DIFFER BY '
    + 'CONSTRUCTION - what the two probes are gated to agree on is "off-datum cells exist", never a number. What each '
    + 'sense can see of the SIGN, measured on this branch against the one-sided kernel `lf - floor >= -ZQ - 1e-9` (up '
    + 'blocked, down unbounded): the flat triples come out byte-identical to the recorded ones (060da4cd/f05beeb5/'
    + '050b225e), as #210 found; DEALT moves on 3 of 3 levels - #226 replaced the inherited spawn seats with grid-chosen '
    + 'DEALT_SEATS cameras, so a dealt frame that ignores which side of its lamp the light came from is no longer a '
    + 'frame any sampled level can pass on (at the spawn seats it was 2 of 3, level 2 green on a dealt frame that '
    + 'differed from its flattened twin by 8 px of 203,138 - a camera that saw no band to lose); and alt\'s "no '
    + 'column is lit from a band ABOVE it" row reads 169 / 279 / 117 on that kernel against 0 / 0 / 0 here (the 273 '
    + 'this file and CHANGELOG used to quote for level 1 was an older deal; #219 measured 279). A green FLAT parity '
    + 'row is still NOT proof that a band term exists or points the right way.')
  /* #216 probe-half, and the reason this row lives HERE rather than in a step of its own: the
     recorded references this probe owns are the only numbers in tools/view.js a claim can be checked
     against, and until now the only census of them was a grep that reads 3 and cannot see cull's
     crc32 family at all. Asserting the inventory from inside a blocking step means the count cannot
     drift out of the prose again: adding a lock, deleting one, or editing a literal all redden this
     row, and the row prints which blocks still have nothing behind their verdicts. It renders
     nothing, so it cannot warm the pose cache or move a triple (#243). */
  refInventory(row);
  console.log(bad ? 'FLATPARITY ' + bad + ' FAILURES - the PARITY triple no longer collapses with LAMPS=off, the LOCK triple moved, or the recorded-reference inventory disagrees with tools/refs.lock (the REFS rows above say which)'
    : 'flatparity ok - PARITY collapses to 2c5a94f with LAMPS=off (formula collapse), LOCK holds on the shipped lamp'
    + ' record (regression lock) and DEALT holds on the world as dealt (population + lock). Two cold processes per'
    + ' sense agree. The two FLAT senses are BLIND TO THE SIGN of the band term; DEALT and alt\'s band-above rows are'
    + ' what gate a sign, and the census beside them is what says the game is not flat (the line above)');
  process.exit(bad ? 1 : 0);
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
      let rf = 0, mx = -1, mxIdx = -1, fb = -1, fbIdx = -1;
      // since #152 the exit is chosen among the BAND-0 cells of bfsReach's own field, so "the exit is
      // at the far end" has to be measured by that rule - the flat-farthest cell may be a raised room
      const exitIdx0 = ((exitY | 0) * N + (exitX | 0));
      const exitBand0 = MAP.fz[exitIdx0], exitD0 = bfsDist[exitIdx0];   // before the split poke below
      let ties = 0;
      for (let i = 0; i < N * N; i++) {
        if (flat[i] >= 0) { rf++; if (flat[i] > mx) { mx = flat[i]; mxIdx = i; } }
        if (bfsDist[i] >= 0 && MAP.fz[i] === 0 && bfsDist[i] > fb) { fb = bfsDist[i]; fbIdx = i; }
      }
      // js/20_level.js:595 scans with a strict > over ascending i, so a tie is the generator's own
      // answer too: the claim is the DISTANCE and the band, not which argmax cell it landed on
      for (let i = 0; i < N * N; i++) if (bfsDist[i] === fb && MAP.fz[i] === 0) ties++;
      const stepFz = new Int8Array(N * N); for (let i = 0; i < N * N; i++) stepFz[i] = (i % 3) ? 1 : 0;
      const dStep = bfsReach(MAP.cell, stepFz, N, start);
      let rs = 0; for (let i = 0; i < N * N; i++) if (dStep[i] >= 0) rs++;
      /* The seam this raises has to have the SPAWN on the near side and the EXIT on the far one, or
         "the split refuses" is a claim about a seam no path crosses. Before generation the spawn was
         room[0] in the top-left, so x >= N/2 did exactly that; #188 authors bands and the spawn can now
         sit at x 19 of 26 (L0) or x 30 of 36 (L2), so the old half raised the ground the BFS starts on,
         the exit was reachable inside the raised half at d 20 and L0/L2 reported "exit sealed FAIL".
         Split on the axis where spawn and exit differ most, and raise the half beyond its midpoint. */
      const sx = start % N, sy = (start / N) | 0, eX = exitX | 0, eY = exitY | 0;
      const axY = Math.abs(eY - sy) > Math.abs(eX - sx);
      const cut = axY ? ((sy + eY) >> 1) : ((sx + eX) >> 1);
      const splitFz = new Int8Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (axY ? (eY > sy ? y > cut : y <= cut) : (eX > sx ? x > cut : x <= cut)) splitFz[y * N + x] = 2;
      }
      const dSplit = bfsReach(MAP.cell, splitFz, N, start);
      let rb = 0, blocked = 0;
      for (let i = 0; i < N * N; i++) { if (dSplit[i] >= 0) rb++; if (flat[i] >= 0 && dSplit[i] < 0) blocked++; }
      const exitIdx = exitIdx0;
      MAP.fz = splitFz; linkBoundaries();
      return { N: N, exitAtFar: exitBand0 === 0 && fb >= 0 && exitD0 === fb, exitDist: exitD0, farBand0: fb, rfAtExit: mx, reachFlat: rf, reachStep: rs, reachSplit: rb, blocked: blocked, ties: ties, exitQ: exitBand0, argmaxSame: fbIdx === exitIdx0 ? 1 : 0,
        warns: warns.length, exitSealed: dSplit[exitIdx] < 0, stamp: MAP.linkStamp };
    })()`, ctxVm);
    const ok = r.exitAtFar && r.reachStep === r.reachFlat && r.reachSplit < r.reachFlat && r.blocked > 0 && r.warns === 0 && r.exitSealed;
    if (!ok) bad++;
    console.log(`level ${li}  N ${r.N}  exit is the far band-0 cell ${r.exitAtFar ? 'ok' : 'FAIL'} (d=${r.exitDist} of ${r.farBand0}, ` +
      `${r.ties} cell(s) at that distance on the datum, exit column ${r.exitQ === 0 ? 'on the datum' : r.exitQ + ' quanta off it'}` +
      `${r.argmaxSame ? ', same cell as the argmax' : ', a tied cell rather than the first argmax'})` +
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
  /* Mechanical rows own their cast: sleeping enemies is not enough because a sleeping enemy wakes
     on sight and shoots the player mid-sample, which is how "landing impulse" came to mean "was
     there a hound in the lane". The rows below measure feet, floors and gravity. */
  const PRE = li => `S.mode='play';S.locked=false;S.diff=1;startLevel(${li},true);` +
    `ENEMIES.length=0;for(const k in keys)delete keys[k];` +
    `P.vx=P.vy=P.vz=0;P.air=false;P.crouch=0;P.hp=100;P.armor=0;`;
  /* A lane is a straight run of open columns. With dy = 0 the only probe tryMove can reach is the
     one pointing down the run, so a lane is a corridor the assertion owns end to end. Since #152 a
     lane also has to sit at ONE altitude, or the rows below walk across an authored step and measure
     that instead of the lip they poked. */
  const LANE = `(()=>{for(let y=1;y<MH-2;y++)for(let x=1;x<MW-6;x++){let n=0;` +
    `while(n<10&&x+n<MW-1&&!MAP.cell[y*MW+x+n]&&MAP.fz[y*MW+x+n]===MAP.fz[y*MW+x])n++;if(n>=6)return{x:x,y:y,n:n};}return null})()`;
  /* A poke that leaves a face of span <= 0 is a grid fault and would blame the wrong code, so the
     legality of every config is reported before any FAIL below is allowed to point at the player.
     The AIR side owns the ceiling plane - js/40_render.js:599 reads ceilPlane of the cell the eye is
     in - so this walks open cells against solid neighbours, the way LEGAL below and view.js `planes`
     already do. ceilAt of a solid column is the fiction AGENTS warns about; on a flat grid the two
     sides agree, which is how the wall-side form survived until generation authored bands. Air-to-air
     risers are NOT counted here: their face is the slab side [min floor, max floor], another rule. */
  const SPANS = `(()=>{let tot=0,bad=0;for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;` +
    `for(let d=0;d<4;d++){const nx=x+DIRX[d],ny=y+DIRY[d];if(nx<0||ny<0||nx>=MW||ny>=MH||!MAP.cell[ny*MW+nx])continue;` +
    `tot++;if(!(ceilAt(x,y)-faceZ0(x,y,d)>0))bad++;}}return{tot:tot,bad:bad}})()`;
  /* Carrying: a wall column must reach down to the lowest band it bounds, or the face it shows has
     span <= 0. Same pass as view.js heights' CARRY, and the reason a dig poke below must run it. */
  const CARRY = `(()=>{for(let k=0;k<2;k++)for(let i=0;i<MW*MH;i++){if(!MAP.cell[i])continue;let m=MAP.fz[i];
    for(let d=0;d<4;d++){const x=i%MW,y=(i/MW)|0,nx=x+DIRX[d],ny=y+DIRY[d];
      if(nx<0||ny<0||nx>=MW||ny>=MH)continue;const n=ny*MW+nx;
      if(!MAP.cell[n]&&MAP.fz[n]<m)m=MAP.fz[n];}MAP.fz[i]=m;}})()`;
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
    /* Attribute the shake before judging it. The sample carries hp precisely so an impulse can be
     * told apart from damage, and this row was judging them together: on the level SEED=1 deals, an
     * enemy reaches the walking player once, hp goes 100 -> 91, shake peaks at 4.07, and the row
     * called that a self-cancelling support test - while max shake over the frames BEFORE the hit
     * was 0.000. The same row read 0.00 and passed on SEED=4, so across 8 seeds main failed 7 of
     * them and CI stayed green because SEED is pinned to 12345, which happens to deal a lane with
     * nobody in it. A gate whose colour depends on whether an enemy wandered by measures the level. */
    const hp0 = s[0][4], hpEnd = s[s.length - 1][4], nHit = s.filter((r, i) => i && r[4] !== s[i - 1][4]).length;
    const shkNH = Math.max.apply(null, s.filter(r => r[4] === hp0).map(r => r[5]));
    VROW('L' + li + ' flat walk keeps P.z on the floor', !sep && !air && adv > 2 && shkNH < 0.05,
      `P.z off the floor ${sep}/150 frames, airborne ${air}, impulse on un-hit frames ${shkNH.toFixed(2)}` +
      ` (any-source peak ${shk.toFixed(2)}, ${nHit} hit${nHit === 1 ? '' : 's'} taking hp ${hp0.toFixed(0)} -> ${hpEnd.toFixed(0)}), ` +
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
      /* Absolute, not `+=`: the lane may already sit on a raised band, and a step written against a
         cell whose own floor is unknown is not the step the row's name claims. CARRY keeps the wall
         bases under the band they bound, so a face of span 0 cannot blame the renderer for this poke.
         The band runs to the map's inner border, not to the end of the lane: since #188 the column
         after a lane can be another band rather than a wall, and a 150-frame walk travels ~7.2 units,
         so a poke that stops with the lane is WALKED OFF THE END of and the tail of the sample then
         measures the step down off the poke (measured: P.z 0 -> 0.25 at the lip, then 0.1833 -> 0.1344
         -> 0.0986 as the ease chased a floor of 0), which is not the lip this row is named for. */
      run(CFG('', `const q=MAP.fz[${CY} * MW + ${CX}];` +
        `for(let x=${CX}+3;x<MW-1;x++)MAP.fz[${CY} * MW + x]=q+${dq};` + CARRY));
      const Z0 = run('P.z'), sp = run(SPANS), s = run(RUN(150, 'KeyW'));
      /* The same byte that makes the face opaque makes it impassable, so the row names which side it
         expects: the 1-quantum lip must NOT be VB_BLOCK (or auto-step has nothing to walk over) and
         the 2-quantum one must BE VB_BLOCK (or the row passes on an invisible wall). */
      const blk = run(`vbAt(${CX + 2.5},${CY + 0.5},0)&VB_BLOCK`);
      const wantBlk = want === 'over' ? 0 : run('VB_BLOCK');
      const zs = s.map(r => r[1]), crossed = s[s.length - 1][0] > LIPX + 0.2;
      const air = s.filter(r => r[3]).length;
      const mid = zs.filter(z => z > zs[0] + 1e-9 && z < Z0 + dq * 0.25 - 1e-9).length;
      const endZ = zs[zs.length - 1], wantZ = Z0 + (want === 'over' ? 0.25 : 0);
      /* The rise must take ONE frame: js/30_entities.js:379 sets P.z = floorAt for a grounded rise of
         at most ZQ, and the ease it replaced ran 26 frames to converge within 1e-4 (measured on the
         flat build). Either direction is a regression now - a lift that drifts costs the camera 26
         frames of climbing floor, a lift that never fires leaves endZ below wantZ - so mid is judged,
         not printed. */
      const ok = sp.bad === 0 && blk === wantBlk && air === 0 && endZ === wantZ && mid === 0 &&
        (want === 'over' ? crossed : !crossed);
      VROW('auto-step over ' + name, ok,
        `faces ${sp.tot - sp.bad}/${sp.tot} legal, lip boundary ${blk ? 'VB_BLOCK' : 'walkable'} (want ${wantBlk ? 'VB_BLOCK' : 'walkable'}), ` +
        `crossed ${crossed ? 'yes' : 'no'}, P.z ${zs[0]} -> ${endZ} (want ${wantZ}), ` +
        `rise spread over ${mid} intermediate frames (want 0 - the snap at js/30_entities.js:379), airborne ${air}`);
      if (want === 'over') {
        const path = [];
        for (const r of s) if (!path.length || r[1] !== path[path.length - 1]) path.push(r[1]);
        console.log('    P.z path ' + path.map(v => v.toFixed(4)).join(' -> '));
      }
    }
    /* A drop the collision path lets you walk off has to take FRAMES: the else branch used to snap
       P.z to the floor, which is the teleport this step exists to remove. */
    run(CFG('', `const q=MAP.fz[${CY} * MW + ${CX}];` +
      `for(let j=3;j<${N};j++)MAP.fz[${CY} * MW + ${CX} + j]=q-4;` + CARRY));
    const spd = run(SPANS), s = run(RUN(120, 'KeyW'));
    const airAt = s.map((r, i) => r[3] ? i : -1).filter(i => i >= 0);
    let mono = true;
    for (let i = 1; i < s.length; i++) if (s[i][1] > s[i - 1][1] + 1e-12) mono = false;
    const uniq = new Set(s.map(r => r[1])).size;
    /* hp is attributed by frame, not totalled: this row asserted dmg === 0 and read 8, 11, 16 and
       19 on four different level rolls, which was a grunt's 9-damage projectile and nothing to do
       with the fall. A drop on the frame the feet return to the floor is fall damage; anything else
       is not this row's business, but it is printed so the reader can see it. */
    let landDmg = 0, hitDmg = 0;
    for (let i = 1; i < s.length; i++) {
      const dh = s[i][4] - s[i - 1][4];
      if (dh < -1e-9) { if (!s[i][3] && s[i - 1][3]) landDmg += -dh; else hitDmg += -dh; }
    }
    landDmg = +landDmg.toFixed(3); hitDmg = +hitDmg.toFixed(3);
    VROW('walking off a 1-unit ledge falls over frames', spd.bad === 0 && airAt.length >= 3 && mono && uniq >= 4 && landDmg === 0,
      `airborne ${airAt.length} frames, monotonic ${mono ? 'yes' : 'no'}, ${uniq} distinct P.z, ` +
      `hp lost ${landDmg} from the fall (${hitDmg} from hits, attributed per frame), ` +
      `lands on ${s[s.length - 1][2]} at P.z ${s[s.length - 1][1]}`);
    const from = airAt.length ? Math.max(0, airAt[0] - 1) : 0, to = airAt.length ? Math.min(s.length - 1, airAt[airAt.length - 1] + 1) : 0;
    console.log('    frame        x       P.z    floor  air');
    for (let i = from; i <= to; i++) if (i - from < 26 || i > to - 3)
      console.log('    ' + String(i).padStart(5) + ' ' + s[i][0].toFixed(3).padStart(9) + ' ' + s[i][1].toFixed(5).padStart(9) +
        ' ' + s[i][2].toFixed(2).padStart(7) + ' ' + (s[i][3] ? 'yes' : 'no').padStart(5));
    /* Landing costs health above the free-drop limit and nothing below it. Each drop is dug into
       the lane to an ABSOLUTE altitude - q0 quanta down by k - because the lane may be a raised room,
       where a relative `-= k` and a start at z 0 put the feet k*ZQ - floorAt apart and the label stops
       being the drop. The measured start and landing altitudes are printed beside the drop. */
    const rows = [];
    for (const k of [5, 8, 10, 13, 16]) {
      /* PICKUPS.length=0 belongs in this poke, not in PRE: the dig drops the landing altitude to the
         floor of every column the player walks over, and a health pickup standing in that band is
         TAKEN on the landing frame - js/30_entities.js:430 (+25, capped at 100) runs in the same
         update as the damage, on the same frame the row's own rule uses to recognise fall damage, so
         the row cannot attribute it. Measured on #188: damagePlayer(10.6) fires at x 3.5, hp goes
         100 -> 89.40, the pickup heals to 100 and the 2.00-unit drop prints 0.0hp. Clearing it in PRE
         instead would shift how much randomness the run consumes, and every later row would see a
         different level roll (measured: L2's flat walk 7.16 -> 5.21 units, spawn rows +/-32 faces). */
      run(CFG('', `PICKUPS.length=0;globalThis.__q0=MAP.fz[${CY} * MW + ${CX} + 2];` +
        `for(let j=1;j<${N};j++)MAP.fz[${CY} * MW + ${CX} + j]=globalThis.__q0-${k};` + CARRY) +
        PLACE(CX + 2.5, CY + 0.5, 'globalThis.__q0*ZQ'));
      const sp = run(SPANS), zFrom = run('P.z');
      const r = run('(()=>{let i=0;do{update(1/60);i++}while(P.air&&i<240);' +
        'return{i:i,hp:+P.hp.toFixed(3),z:P.z,gz:floorAt(P.x,P.y)}})()');
      rows.push({ want: k * 0.25, h: +(zFrom - r.gz).toFixed(6), zFrom: zFrom, zTo: r.gz,
        dmg: +(100 - r.hp).toFixed(3), fr: r.i, landed: r.z === r.gz, spans: sp.bad });
    }
    const over = rows.slice(1);
    const mono2 = over.every((r, i) => i === 0 || r.dmg > over[i - 1].dmg);
    const exact = rows.every(r => Math.abs(r.h - r.want) < 1e-9);
    VROW('fall damage free under 1.5 units, scaled over', exact && rows[0].dmg === 0 && over.every(r => r.dmg > 0) && mono2 && rows.every(r => r.landed && !r.spans),
      rows.map(r => `${r.h.toFixed(2)} (${r.zFrom.toFixed(2)}->${r.zTo.toFixed(2)}) ${r.dmg.toFixed(1)}hp/${r.fr}f`).join('  ') +
      (exact ? '' : '  WANT the drops to measure ' + rows.map(r => r.want.toFixed(2)).join(', ') + ' - the dig is not the drop') +
      '   (drop, start -> landing altitude -> hp lost / frames)');
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
  /* A level entry, performed the way the game performs it: the first startLevel puts the player on
     the flat grid, then the band is raised and the level is started again through the path under
     test. The two calls are SPLIT because #95: a row that arms P.air/P.vz inside the same script
     that then calls startLevel never lets anything observe the state it is named for, so a refactor
     that dropped the arm would print the same "airborne 0". Arming in its own run turns the
     precondition into a measurement, and VACUOUS is then a verdict rather than a caption. */
  const ENTER1 = (li, dq, plateau) => `S.mode='play';S.locked=false;S.diff=1;globalThis.__spawnBand=0;` +
    `globalThis.__spawnPlateau=0;startLevel(${li},true);P.hp=100;ENEMIES.length=0;` +
    `globalThis.__spawnBand=${dq};globalThis.__spawnPlateau=${plateau};`;
  const ENTER2 = (li, fresh) => `startLevel(${li},${fresh ? 'true' : 'false'});` +
    `for(const e of ENEMIES)e.state='sleep';for(const k in keys)delete keys[k];P.crouch=0;` +
    /* startLevel above repopulates ENEMIES - so the sleep loop cannot keep the sample clean here.
       Clear the cast: an entry point that costs the player health because an NPC wandered into frame
       is not an altitude defect, and the sampler attributes whatever hp does move so the row still
       says which source it means. */
    `ENEMIES.length=0;`;
  const AIRSET = vz => `P.air=true;P.vz=${vz};`;
  const PEEK = `({z:P.z,f:floorAt(P.x,P.y),air:P.air?1:0,vz:+P.vz.toFixed(4),` +
    `q:MAP.fz[((P.y|0)*MW+(P.x|0))],solid:isSolid(P.x,P.y)?1:0,` +
    /* cap mirrors renderWorld's OWN clamp (js/40_render.js), not the flat world's [0.12, 1.4] that
       #103 retired: quoting the dead interval made every raised-band row print "render eye capped`
       `0.1 below the grid" - a regression claim about a renderer that caps nothing there. */
    `below:(P.z<floorAt(P.x,P.y)-1e-9)?1:0,cap:+((cfg.eye+P.z-P.crouch*0.19)-` +
    `clamp(cfg.eye+P.z-P.crouch*0.19,floorAt(P.x,P.y)+0.12,ceilAt(P.x,P.y)-0.06)).toFixed(4)})`;
  /* The consequence, not just the number: 60 frames of standing still. Feet below the column's own
     floor means the step-up eases the camera out of the slab, and a carried-over vz runs the fall
     integration against a floor that was never left, which costs health for a fall that never did. */
  const SETTLE = `(()=>{const s=[];for(let i=0;i<60;i++){update(1/60);` +
    `s.push([+P.z.toFixed(6),+floorAt(P.x,P.y).toFixed(4),P.air?1:0,+P.hp.toFixed(3)]);}` +
    `const drop=(f)=>{let d=0;for(let i=1;i<s.length;i++){const dh=s[i][3]-s[i-1][3];if(dh<-1e-9&&f(i))d+=-dh;}` +
    `return +d.toFixed(3)};return{off:s.filter(r=>Math.abs(r[0]-r[1])>1e-9).length,` +
    `air:s.filter(r=>r[2]).length,hp:+P.hp.toFixed(3),` +
    `land:drop(i=>!s[i][2]&&s[i-1][2]),hit:drop(i=>!(!s[i][2]&&s[i-1][2]))}})()`;
  /* A fall SAMPLED FROM THE ARMED STATE. Seeding the sample with the state before the first update
     is not decoration: a player armed at the floor with vz -7 lands during frame 1, so a loop that
     samples after each update sees no airborne frame and no hp step at all - the self-cancelling
     negative control AGENTS.md already warns about, arriving as a row that reports a clean landing
     for a fall the row itself caused. */
  const FALL = `(()=>{const s=[],snap=()=>[+P.z.toFixed(6),+floorAt(P.x,P.y).toFixed(4),P.air?1:0,` +
    `+P.hp.toFixed(3),+P.vz.toFixed(4)];s.push(snap());for(let i=0;i<90;i++){update(1/60);s.push(snap());}` +
    `let land=-1;for(let i=1;i<s.length;i++)if(!s[i][2]&&s[i-1][2]){land=i;break;}` +
    `const drop=(f)=>{let d=0;for(let i=1;i<s.length;i++){const dh=s[i][3]-s[i-1][3];if(dh<-1e-9&&f(i))d+=-dh;}` +
    `return +d.toFixed(3)};const e=s[s.length-1];return{land:land,air:s.filter(r=>r[2]).length,` +
    `off:land<0?-1:s.slice(land).filter(r=>Math.abs(r[0]-r[1])>1e-9).length,` +
    `fallhp:drop(i=>!s[i][2]&&s[i-1][2]),hithp:drop(i=>!(!s[i][2]&&s[i-1][2])),` +
    `z:e[0],f:e[1],airE:e[2],vz:e[4],hp:+P.hp.toFixed(3)}})()`;
  const LEGAL = `(()=>{let tot=0,bad=0;for(let i=0;i<MW*MH;i++){if(MAP.cell[i])continue;const x=i%MW,y=(i/MW)|0;` +
    // the AIR side owns the ceiling plane (js/40_render.js:599 reads ceilPlane of the cell the eye is
    // in); ceilAt of a solid column is the fiction this file warns about, and on a flat grid the two
    // agree, which is how taking it from the wall cell survived until generation authored bands
    `for(let d=0;d<4;d++){const nx=x+DIRX[d],ny=y+DIRY[d];if(nx<0||ny<0||nx>=MW||ny>=MH||!MAP.cell[ny*MW+nx])continue;` +
    `tot++;if(!(ceilAt(x,y)-faceZ0(x,y,d)>0))bad++;}}return{tot:tot,bad:bad}})()`;
  const spawnRow = (label, li, fresh, dq, vz, plateau) => {
    run(ENTER1(li, dq, plateau || 0));
    /* Armed BEFORE the entry: this is a fall carried in from the level the player was leaving, and
       the entry is supposed to absorb it. Reading the arm back is what makes "airborne 0" below
       mean "the entry seated the feet" rather than "nothing ever armed" (#95). */
    let armed = null;
    if (vz) { run(AIRSET(vz)); armed = run(PEEK); }
    run(ENTER2(li, fresh));
    const r = run(PEEK), st = run(SETTLE), lg = run(LEGAL);
    const vac = !!vz && (!armed.air || Math.abs(armed.vz - vz) > 1e-9);
    const ok = !vac && r.z === r.f && !r.below && !r.air && r.vz === 0 && !r.solid && !lg.bad &&
      !st.off && !st.air && st.land === 0;
    VROW(label, ok, (vac ? `VACUOUS - arming vz ${vz} left airborne ${armed ? armed.air : '?'}, ` +
      `vz ${armed ? armed.vz : '?'}, so this row tested nothing | ` : '') +
      (armed ? `armed airborne ${armed.air} vz ${armed.vz} before the entry | ` : '') +
      `P.z ${r.z} vs floorAt ${r.f} (spawn column ${r.q} quanta), feet below the floor ` +
      `${r.below ? 'YES' : 'no'}, airborne ${r.air}, vz ${r.vz}, in geometry ${r.solid} | faces ` +
      `${lg.tot - lg.bad}/${lg.tot} legal | then ${st.off}/60 frames off the floor, airborne ${st.air}, ` +
      `hp ${st.hp} (fall ${st.land}, hits ${st.hit})` +
      (r.cap ? ` | eye clamped ${r.cap} by the band's own ceiling` : ''));
  };
  /* And the same velocity on the other side of the entry, where it is REAL: the entry seated the
     feet, then the player is airborne inside the new level. This is the row that makes the row
     above's "hp 100" mean something - one magnitude, two outcomes, so a threshold that drifts or a
     landing that stops seating shows up as a FAIL rather than as agreement between two zeros. */
  const fallRow = (label, li, fresh, vz, wantHp) => {
    run(ENTER1(li, 0, 0));
    run(ENTER2(li, fresh));
    run(AIRSET(vz));
    const armed = run(PEEK), st = run(FALL);
    const vac = !armed.air || Math.abs(armed.vz - vz) > 1e-9;
    const grounded = !st.airE && st.vz === 0 && Math.abs(st.z - st.f) < 1e-9;
    const ok = !vac && st.land > 0 && st.land <= 60 && st.off === 0 && grounded &&
      st.hithp === 0 && (wantHp ? st.fallhp > 0 && st.hp < 100 : (st.fallhp === 0 && st.hp === 100));
    VROW(label, ok, (vac ? `VACUOUS - arming vz ${vz} left airborne ${armed.air}, vz ${armed.vz} | ` : '') +
      `armed airborne ${armed.air} vz ${armed.vz} after the entry | lands frame ${st.land} of 90, ` +
      `${st.air} airborne frames, ${st.off} frames off the floor after landing, hp ${st.hp} ` +
      `(from the fall ${st.fallhp}, from hits ${st.hithp}) | ends airborne ${st.airE}, vz ${st.vz}, ` +
      `P.z ${st.z} vs floorAt ${st.f}`);
  };
  for (let li = 0; li < run('LEVELS.length'); li++) {
    spawnRow('L' + li + ' spawn on flat ground (new game)', li, true, 0, 0);
    spawnRow('L' + li + ' spawn on flat ground (level change)', li, false, 0, 0);
    spawnRow('L' + li + ' entering a level airborne', li, false, 0, -7);
    /* -7 m/s is the impact the engine charges for (js/30_entities.js); +3.0 is the jump it documents
       as damage-free. The pair brackets the free/hurt threshold at a level start. */
    fallRow('L' + li + ' a hard fall INSIDE the level is paid for', li, false, -7, true);
    fallRow('L' + li + ' a jump-speed carry-in costs no health', li, false, 3.0, false);
    spawnRow('L' + li + ' spawn on a +1-quantum band (level change)', li, false, 1, 0);
    spawnRow('L' + li + ' spawn on a +2-quantum band (new game)', li, true, 2, 0);
    spawnRow('L' + li + ' spawn on a +2-quantum band (level change)', li, false, 2, 0);
    spawnRow('L' + li + ' spawn on a +4-quantum plateau (level change)', li, false, 4, 0, 1);
  }
  run(`if(globalThis.__genReal){genLevel=globalThis.__genReal;globalThis.__genReal=null;globalThis.__spawnBand=0;}`);
  if (bad) { console.log('vert: FAILED'); process.exit(1); }
  console.log('vert: all levels ok');
  // Without this the pass path fell through into the scene dump: CI's gate step printed a
  // "frame: mean" and painted /tmp/fps_scene.png whose value depends on where this probe left the
  // RNG stream, which reads like a measurement of the level and measures nothing (#89).
  process.exit(0);
}

if (MODE === 'sight') {
  /* #98: hitscan tested a *world* altitude against the enemy's height above absolute zero, so a body
     standing on a band one unit up was unhittable and a barrel one unit down was hit by a shot fired
     level at the eye. Levels are still flat, so nothing here is visible in play yet - the point is
     that M4 is built on these two branches. Every row derives its own expectation from floorAt and
     scale rather than quoting a constant, and the "must miss" rows exist so that widening the window
     to +infinity cannot pass: the bug and its opposite both fail, only the band-relative window passes. */
  let bad = 0;
  const row = (label, ok, detail) => {
    console.log('  ' + label.padEnd(44) + (ok ? ' ok  ' : ' FAIL') + '  ' + detail);
    if (!ok) bad++;
  };
  for (let li = 0; li < 3; li++) {
    const res = run(`(function(){
      const out = {skip: null, rows: []};
      let lane = null;
      for (let y = 2; y < MH - 2 && !lane; y++) for (let x = 2; x < MW - 8 && !lane; x++) {
        let n = 0; for (let k = 0; k < 7; k++) if (!MAP.cell[y * MW + x + k]) n++;
        if (n >= 7) lane = {x: x + 0.5, y: y + 0.5};
      }
      if (!lane) { out.skip = 'no 7-cell straight run on this level'; return out; }
      startLevel(${li}, true);
      const en = ENEMIES[0];
      if (!en) { out.skip = 'no enemy generated'; return out; }
      /* the cast must be out of the lane, not merely asleep: a sleeping neighbour absorbs the nearest
         hit and reports the bug absent (#96 learned this the same way) */
      ENEMIES.length = 0; ENEMIES.push(en);
      const px = lane.x, py = lane.y, ex = lane.x + 4, ey = lane.y;
      const probe = (dq, aimFrac, tanFix) => {
        const fz0 = MAP.fz.slice(), cz0 = MAP.cz.slice();
        if (dq > 0) for (const [cx, cy] of [[ex, ey], [ex + 1, ey]]) MAP.fz[(cy | 0) * MW + (cx | 0)] += dq;
        /* A boundary whose opening is EMPTY cannot be shot through, so raising the enemy a full unit has to
           open the shooter's ceiling too or the row silently asserts "shots ignore altitude": the opening
           between two cells is [max(floor), min(ceiling)], and floor+1.00 against a 1.00 ceiling is
           [1.00, 1.00] - nothing. A tall shooter cell is the legal version (an atrium, which is what M6
           authors), and it keeps the same claim - a shot can reach an enemy standing one band up - through
           geometry that actually has a hole in it. Restored with cz0 below, like the fz poke. */
        /* The opening must exist along the whole flight, not just at the shooter's feet: ceilAt is per cell, so
           one tall cell leaves the ray crossing z=1.00 inside the NEXT cell, whose ceiling is 1.00, and the
           stop lands 1.8 m out - measured. So the lane is opened as one atrium (this is what M6 authors: a
           gallery you can shoot up into), which keeps the row's claim - a shot reaches an enemy one band up -
           and puts a real hole in the geometry it travels through. */
        if (dq > 0) {
          const cZ = Math.max(4, Math.ceil((dq * ZQ + en.scale + 0.25) / ZQ));
          for (let k = 0; k <= 6; k++) MAP.cz[((py | 0) * MW) + ((px | 0) + k)] = cZ;
        } else if (dq < 0) {
          /* #131 made this poke a staircase instead of a single drop, and the reason is arithmetic: from an eye
             at 0.50 a line to a chest 1.00 below at 4.00 out descends at -0.25 and crosses the shooter's OWN
             floor plane 1.87 m ahead - inside the shooter's cell - so aiming into a 1-unit drop is aiming into
             a floor slab, and #131's floor term is what says so. A sunk cell has no opening by default either:
             its ceiling is DERIVED as the underside of the neighbour's floor, so the boundary is
             [max floor, min ceil] = [0.00, 0.00]. What does reach an enemy one band down is a band that steps
             down at least as fast as the ray - one quantum per cell is a 0.25 rise on a 1.00 run, exactly the
             slope the row aims along - and that is real M3/M6 content rather than a fiction: every boundary on
             the flight has an opening, and the ray stays ~0.25 above each cell's floor instead of under it.
             The stop answer for the single-drop case belongs in a row of its own (smoke's VERT lane, V15). */
          for (let k = 1; k <= 6; k++) MAP.fz[((py | 0) * MW) + ((px | 0) + k)] += Math.max(dq, -k);
        }
        linkBoundaries();
        en.x = ex; en.y = ey; en.state = 'idle'; en.alert = false; en.hp = 1e6; en.dead = false;
        P.x = px; P.y = py; P.ang = 0; P.crouch = 0; P.air = false; P.vz = 0;
        P.z = floorAt(px, py);
        const ef = floorAt(ex, ey), eyeZ = cfg.eye + P.z;
        const aimZ = tanFix === undefined ? ef + en.scale * aimFrac : eyeZ + tanFix * 4;
        const surf = 4 - en.r;                      // a cylinder's near surface is nearer than its axis
        const r = hitscan(0, (aimZ - eyeZ) / surf, 20);
        const hitZ = r.info ? r.info.z : null;
        const got = {
          ef, eyeZ, aimZ, dq,
          hitEnemy: r.enemy ? 1 : 0, hitZ, head: r.info && r.info.head ? 1 : 0,
          t: r.t, wall: r.wall ? 1 : 0, barrel: r.info && r.info.barrel ? 1 : 0,
          bodyLo: ef + 0.02, bodyHi: ef + en.scale, headAt: ef + en.scale * 0.78,
        };
        for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = fz0[i];
        for (let i = 0; i < MAP.cz.length; i++) MAP.cz[i] = cz0[i];
        linkBoundaries();
        return got;
      };
      const rows = [];
      for (const dq of [0, 4, -4, 2]) rows.push({k: 'chest' + dq, g: probe(dq, 0.5)});
      for (const dq of [0, 4, -4]) rows.push({k: 'head' + dq, g: probe(dq, 0.85)});
      rows.push({k: 'flat', g: probe(4, 0, 0)});
      /* the prop branch has no z test at all today: it answers on perp and range alone */
      const bar = {tex: PROP.barrel, x: ex, y: ey, scale: 0.86, z: floorAt(ex, ey), kind: 'barrel', hp: 26, dead: false};
      for (const dq of [0, -4]) {
        const fz0 = MAP.fz.slice();
        MAP.fz[(ey | 0) * MW + (ex | 0)] += dq;
        linkBoundaries();
        bar.z = floorAt(ex, ey);
        const props0 = PROPS.slice(); PROPS.length = 0; PROPS.push(bar);   // same lesson as the cast: clear, do not merely move (#96)
        P.x = px; P.y = py; P.ang = 0; P.crouch = 0; P.air = false; P.vz = 0; P.z = floorAt(px, py);
        ENEMIES[0].state = 'dead';                       // the prop branch only runs when nothing else hit
        const eyeZ = cfg.eye + P.z;
        const aim = dq === 0 ? bar.z + bar.scale * 0.5 : eyeZ;   // lid-aim when level, flat aim when sunk
        const r = hitscan(0, (aim - eyeZ) / (4 - 0.4), 20);   // the barrel's near face, not its axis
        rows.push({k: 'barrel' + dq, g: {ef: bar.z, eyeZ, aimZ: aim, dq, hitEnemy: 0, hitZ: r.info ? r.info.z : null,
          head: 0, t: r.t, wall: r.wall ? 1 : 0, barrel: r.info && r.info.barrel ? 1 : 0,
          bodyLo: bar.z, bodyHi: bar.z + bar.scale, headAt: Infinity}});
        PROPS.length = 0; for (const q of props0) PROPS.push(q);
        ENEMIES[0].state = 'idle';
        for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = fz0[i];
        linkBoundaries();
      }
      /* #189's fairness half, and the trap that ate the last session's rows (#129): a row that raises
         an enemy a band up without opening the flight asserts nothing, so EVERY number that decides
         these two rows is printed. One flight, one byte of difference between the two configs:
           BLOCK  cells 3..5 keep the one-unit ceiling the generator authors in every column that is
                  not a TALL ROOM, so the ray - which is in real air at 1.11 m because it started in a
                  two-unit room - crosses into cell 3 ABOVE that column's ceiling plane, i.e. inside
                  its slab. The wall pass draws no face there (the two floors are equal, dz = 0), the
                  ceiling pass paints the plane, and cull's own row says a prop one band up is hidden:
                  so the shot has to stop on the boundary line.
           OPEN   the same cells get the tall ceiling - an atrium, the same geometry the band +1 rows
                  above already author - so the flight has a hole in it all the way and the shot must
                  reach the same body at the same aim.
         The OPEN row hitting is what makes the BLOCK row's miss mean "the slab" rather than "no body in
         the cone": vacuity here is a FAILURE, and canBlock is the precondition stated as arithmetic.
         The marker is read out of bandExitT's own source (code, not prose) so a build that lost the
         term cannot print its way past these two rows. */
      const CZS = 8;                                        // quanta: a 2.00 m ceiling, #181's TALL ROOM
      out.slab = (() => {
        const fz0 = MAP.fz.slice(), cz0 = MAP.cz.slice();
        const lx = lane.x | 0, ly = lane.y | 0;
        const setCell = (k, dq, czq) => { const i = ly * MW + lx + k; MAP.fz[i] = dq; if (czq !== undefined) MAP.cz[i] = czq; };
        const build = (openFlight) => {
          for (let k = 0; k <= 6; k++) setCell(k, 0, 4);            // the datum band, one-unit rooms
          for (let k = 0; k <= 2; k++) setCell(k, 0, CZS);          // the shooter's room is TALL
          for (let k = 3; k <= 5; k++) setCell(k, 0, openFlight ? CZS : 4);
          setCell(6, 4, undefined);                                 // the column the body stands on
          linkBoundaries();
        };
        const fire = () => {
          const ex = lx + 6.5;
          en.x = ex; en.y = lane.y; en.state = 'idle'; en.alert = false; en.hp = 1e6; en.dead = false;
          P.x = lane.x; P.y = lane.y; P.ang = 0; P.crouch = 0; P.air = false; P.vz = 0;
          P.z = floorAt(lane.x, lane.y);
          const ef = floorAt(ex, lane.y), eyeZ = cfg.eye + P.z, aimZ = ef + en.scale * 0.85;
          const tp = (aimZ - eyeZ) / (6 - en.r);
          const r = hitscan(0, tp, 20);
          const bx = bandExitT(P.x, P.y, 1, 0, eyeZ, tp, 20);        // same ray, for the kind + solved t
          const geo = [];
          for (let k = 0; k <= 6; k++) geo.push(floorAt(lx + k + 0.5, lane.y).toFixed(2) + '/' + ceilAt(lx + k + 0.5, lane.y).toFixed(2));
          return { t: r.t, hit: r.enemy ? 1 : 0, hz: r.info ? r.info.z : null, wall: r.wall ? 1 : 0,
            band: r.band ? 1 : 0, floorStop: r.floor ? 1 : 0, kind: bx.kind, bt: bx.t,
            ef, eyeZ, aimZ, altAt3: eyeZ + tp * 2.5, scale: en.scale, reach: 6 - en.r,
            bodyLo: ef + 0.02, bodyHi: ef + en.scale,
            f2: floorAt(lx + 2.5, lane.y), c2: ceilAt(lx + 2.5, lane.y),
            f3: floorAt(lx + 3.5, lane.y), c3: ceilAt(lx + 3.5, lane.y),
            f6: floorAt(ex, lane.y), c6: ceilAt(ex, lane.y), geo: geo.join(' ') };
        };
        const o = { term: bandExitT.toString().indexOf('nfl >= fl') >= 0 ? 'PRESENT' : 'REMOVED' };
        build(false); o.block = fire();
        build(true); o.open = fire();
        /* #259: the same flight asked of the enemy's EYE instead of the player's shot. Geometry differs
           from the slab rows in one byte - here the BODY's column is a band up rather than the shot being
           aimed up at it - because the claim is about the boundary between the two columns, whose opening
           [max floor, min ceilAt] is [1.00, 1.00]: zero. BLOCK must therefore answer "not visible" in BOTH
           directions; OPEN gives the whole flight a ceiling of 2.00 (the same atrium the rows above author)
           and must answer "visible" in both, which is what makes BLOCK's miss mean the slab and not a body
           that was never reachable. Marker is read out of losZ's own source, code not prose. */
        const eyeBuild = (openFlight) => {
          for (let k = 0; k <= 6; k++) setCell(k, 0, 4);
          if (openFlight) for (let k = 2; k <= 6; k++) setCell(k, 0, CZS);
          setCell(6, 4, openFlight ? CZS : 4);
          linkBoundaries();
        };
        const eyeRun = () => {
          const ex = lx + 6.5;
          en.x = ex; en.y = lane.y; en.state = 'idle'; en.alert = false; en.hp = 1e6; en.dead = false;
          P.x = lx + 0.5; P.y = lane.y; P.ang = 0; P.crouch = 0; P.air = false; P.vz = 0;
          P.z = floorAt(P.x, P.y);
          const ef = floorAt(ex, lane.y), eeye = ef + en.scale * 0.62, peye = cfg.eye + P.z;
          const dd = ex - P.x;
          const bu = bandExitT(P.x, P.y, 1, 0, peye, (eeye - peye) / dd, dd);
          const bd = bandExitT(ex, lane.y, -1, 0, eeye, (peye - eeye) / dd, dd);
          return { up: losZ(P.x, P.y, peye, ex, lane.y, eeye) ? 1 : 0,
            down: losZ(ex, lane.y, eeye, P.x, P.y, peye) ? 1 : 0,
            d: dd, peye, eeye, ef, scale: en.scale,
            kindUp: bu.kind, tUp: bu.t, kindDn: bd.kind, tDn: bd.t,
            f0: floorAt(P.x, P.y), c0: ceilAt(P.x, P.y),
            f5: floorAt(lx + 5.5, lane.y), c5: ceilAt(lx + 5.5, lane.y),
            f6: ef, c6: ceilAt(ex, lane.y),
            zEdge: peye + (eeye - peye) * ((lx + 6) - P.x) / dd };
        };
        eyeBuild(false); o.eblock = eyeRun();
        eyeBuild(true); o.eopen = eyeRun();
        o.eyeTerm = losZ.toString().indexOf('bandExitT(ax, ay, dx / d') >= 0 ? 'PRESENT' : 'REMOVED';
        for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = fz0[i];
        for (let i = 0; i < MAP.cz.length; i++) MAP.cz[i] = cz0[i];
        linkBoundaries();
        return o;
      })();
      out.rows = rows; out.dist = 4; return out;
    })()`);
    if (res.skip) { console.log(`L${li}: ${res.skip}  SKIP`); bad++; continue; }
    for (const {k, g} of res.rows) {
      const f = n => (n === null || n === undefined ? ' -' : n.toFixed(3));
      if (k.startsWith('chest')) {
        const dq = +k.slice(5);
        const inBand = g.hitZ !== null && g.hitZ >= g.bodyLo && g.hitZ <= g.bodyHi;
        row(`L${li} chest shot at band ${dq > 0 ? '+' : ''}${dq / 4}`,
          g.hitEnemy === 1 && !g.head && inBand,
          `enemy floor ${f(g.ef)}  eye ${f(g.eyeZ)}  aim ${f(g.aimZ)}  hit ${g.hitEnemy ? 'hz ' + f(g.hitZ) : 'MISS t ' + g.t.toFixed(1) + (g.wall ? ' into wall' : '')}  window ${f(g.bodyLo)}..${f(g.bodyHi)}`);
      } else if (k.startsWith('head')) {
        const dq = +k.slice(4);
        const inBand = g.hitZ !== null && g.hitZ >= g.bodyLo && g.hitZ <= g.bodyHi;
        row(`L${li} head shot at band ${dq > 0 ? '+' : ''}${dq / 4}`,
          g.hitEnemy === 1 && g.head === 1 && inBand,
          `enemy floor ${f(g.ef)}  hit ${g.hitEnemy ? 'hz ' + f(g.hitZ) + ' at ' + ((g.hitZ - g.bodyLo) / (g.bodyHi - g.bodyLo)).toFixed(2) + ' of the body -> ' + (g.head ? 'HEAD' : 'body') : 'MISS t ' + g.t.toFixed(1)}  head above ${f(g.headAt)}`);
      } else if (k === 'flat') {
        row(`L${li} level shot at enemy one band up`,
          g.hitEnemy === 0,
          `enemy floor ${f(g.ef)}  shot stays at ${f(g.aimZ)}  hit ${g.hitEnemy ? 'hz ' + f(g.hitZ) + ' - hitting through the floor' : 'no enemy (t ' + g.t.toFixed(1) + (g.wall ? ', riser stops it' : ', flies past') + ')'}`);
      } else if (k.startsWith('barrel')) {
        const dq = +k.slice(6);
        row(`L${li} barrel shot at band ${dq > 0 ? '+' : ''}${dq / 4}`,
          g.barrel === (dq === 0 ? 1 : 0) && (dq !== 0 || g.hitZ >= g.bodyLo),
          `barrel ${f(g.ef)}..${f(g.bodyHi)}  aim ${f(g.aimZ)}  ${g.barrel ? 'barrel hit at hz ' + f(g.hitZ) : 'no barrel hit (t ' + g.t.toFixed(1) + ')'}`);
      }
    }
    /* #189: the two slab rows. Print the geometry BEFORE the verdict's arithmetic, because the whole
       history of these rows is a miss that meant nothing (#129: rows printed `hit at t 3.3` for an
       enemy sealed behind a closed opening; the mirror of that is a row that passes because nothing
       was ever reachable). term = what bandExitT's own source says, so a reverted build is named. */
    const S = res.slab;
    const sf = n => (n === null || n === undefined ? ' -' : n.toFixed(2));
    if (!S) row(`L${li} slab rows`, false, 'no result returned');
    else {
      const b = S.block, o = S.open;
      // can the geometry BLOCK? entered column not higher than the flight, its ceiling below the ray,
      // the shooter's column still air above the ray, and the body's column actually a band up.
      const canBlock = b.f3 <= b.f2 && b.c3 <= b.altAt3 && b.altAt3 < b.c2 && b.f6 > b.f2 && b.c6 > b.f6;
      // can the SAME flight HIT? the ray under every column's ceiling along the flight, body's band open.
      const canHit = o.altAt3 < o.c3 && o.c6 > o.f6 && o.altAt3 < o.c6;
      const geo = g => `cells f/c ${g.geo}  | boundary 2|3: floors ${sf(g.f2)}->${sf(g.f3)}, ceilAt ${sf(g.c2)}->${sf(g.c3)}, ray ${sf(g.altAt3)}, opening [${sf(Math.max(g.f2, g.f3))}, ${sf(Math.min(g.c2, g.c3))}]  | body column f/c ${sf(g.f6)}/${sf(g.c6)}`;
      row(`L${li} shot at a body one band up stops at the slab`,
        canBlock && b.hit === 0 && b.band === 1 && b.wall === 0 && b.bt < b.reach,
        `${canBlock ? 'stops ' + b.bt.toFixed(2) + ' m (boundary into cell 3, body at ' + b.reach.toFixed(2) + '), band stop no wall verdict, t ' + b.t.toFixed(2) : 'VACUOUS - geometry cannot block (ray ' + sf(b.altAt3) + ' vs entered ceiling ' + sf(b.c3) + ')'}  aim ${sf(b.aimZ)} from eye ${sf(b.eyeZ)} on floor 0  kind ${b.kind}  term ${S.term}  ${geo(b)}`);
      row(`L${li} same shot through an opening along the flight hits`,
        canHit && o.hit === 1 && o.hz !== null && o.hz >= o.bodyLo && o.hz <= o.bodyHi,
        `${canHit ? (o.hit ? 'hit hz ' + sf(o.hz) + ' at t ' + o.t.toFixed(2) + ' in window ' + sf(o.bodyLo) + '..' + sf(o.bodyHi) : 'MISS t ' + o.t.toFixed(2) + (o.wall ? ' into wall' : o.band ? ' band stop' : '')) : 'VACUOUS - the opened flight still has no hole (ray ' + sf(o.altAt3) + ' vs ceilings ' + sf(o.c3) + '/' + sf(o.c6) + ')'}  aim ${sf(o.aimZ)} from eye ${sf(o.eyeZ)}  kind ${o.kind}  term ${S.term}  ${geo(o)}`);
    }
    /* #259: the eye rows. canBlockEye is the opening arithmetic, stated rather than assumed: a boundary
       whose [max floor, min ceilAt] has no height cannot be looked through, and the row refuses to claim a
       block on geometry that has a hole in it. The OPEN rows are the anti-over-block arm - they must stay
       green whether or not the term is present, so a build that blocks everything cannot pass this block. */
    const E = res.slab;
    if (!E) row(`L${li} eye rows`, false, 'no result returned');
    else {
      const eb = E.eblock, eo = E.eopen;
      const openB = Math.min(eb.c5, eb.c6) - Math.max(eb.f5, eb.f6);
      const openO = Math.min(eo.c5, eo.c6) - Math.max(eo.f5, eo.f6);
      const ef2 = n => (n === null || n === undefined ? ' -' : n.toFixed(2));
      const egeo = g => `boundary 5|6: floors ${ef2(g.f5)}->${ef2(g.f6)}, ceilAt ${ef2(g.c5)}->${ef2(g.c6)}, opening [${ef2(Math.max(g.f5, g.f6))}, ${ef2(Math.min(g.c5, g.c6))}]  | line at the boundary ${ef2(g.zEdge)}  | eye cells ${ef2(g.f0)}/${ef2(g.c0)} and ${ef2(g.f6)}/${ef2(g.c6)}  | d ${ef2(g.d)}`;
      row(`L${li} the enemy's eye stops at a slab (band above -> datum)`,
        openB <= 0 && eb.down === 0,
        `${openB <= 0 ? (eb.down ? 'VISIBLE THROUGH THE SLAB - kind ' + eb.kindDn + ' t ' + ef2(eb.tDn) : 'blocked at t ' + ef2(eb.tDn) + ' (kind ' + eb.kindDn + ', band exit before the target at ' + ef2(eb.d) + ')') : `VACUOUS - the boundary has a ${ef2(openB)} m opening, nothing to block`}  enemy eye ${ef2(eb.eeye)} on floor ${ef2(eb.ef)}, player eye ${ef2(eb.peye)} on floor ${ef2(eb.f0)}, body ${ef2(eb.ef)}..${ef2(eb.ef + eb.scale)}  term ${E.eyeTerm}  ${egeo(eb)}`);
      row(`L${li} the same eye sees a body through an opening (band above -> datum)`,
        openO > 0 && eo.down === 1,
        `${openO > 0 ? (eo.down ? 'visible, kind ' + eo.kindDn + ' at t ' + ef2(eo.tDn) + ' of ' + ef2(eo.d) : 'BLOCKED THROUGH THE OPENING - the term blocks a flight that has a hole in it') : 'VACUOUS - the opened flight has no hole'}  eye ${ef2(eo.eeye)} -> ${ef2(eo.peye)}  kind ${eo.kindDn}  term ${E.eyeTerm}  ${egeo(eo)}`);
      row(`L${li} the eye is blocked the other way too (datum -> band above)`,
        openB <= 0 && eb.up === 0,
        `${openB <= 0 ? (eb.up ? 'VISIBLE THROUGH THE SLAB - kind ' + eb.kindUp + ' t ' + ef2(eb.tUp) : 'blocked at t ' + ef2(eb.tUp) + ' (kind ' + eb.kindUp + ')') : 'VACUOUS - the boundary has no slab'}  line ${ef2(eb.peye)} -> ${ef2(eb.eeye)} at the boundary ${ef2(eb.zEdge)}  term ${E.eyeTerm}  ${egeo(eb)}`);
      row(`L${li} and sees through the opening the other way`,
        openO > 0 && eo.up === 1,
        `${openO > 0 ? (eo.up ? 'visible, kind ' + eo.kindUp + ' at t ' + ef2(eo.tUp) + ' of ' + ef2(eo.d) : 'BLOCKED THROUGH THE OPENING') : 'VACUOUS - no hole in the opened flight'}  kind ${eo.kindUp}  term ${E.eyeTerm}  ${egeo(eo)}`);
    }
    /* #15's remaining item: nobody had ever asked whether an enemy on band 0 follows a player onto
       band 1, or whether a ramp means anything to the mover. It drives the REAL update loop for 240
       frames in five configs that differ by one byte of the boundary, and reads the outcome from the
       grid rather than from a state flag: canEnter refuses a crossing on VB_BLOCK and nothing else,
       so the staircase (dz = 1 quantum each) and the ramp/ladder (dz = 4 quanta with the climb bit
       clearing the block) must all let the body arrive, and the SAME raised band with no climb bit
       must not. The wall row also asserts sees 0, which is the #261 eye term doing its job on a mover
       that cannot reach: a body that walks into a slab it cannot see through is the bug this row
       exists to catch, and the ramp row is the sabotage control - author the 4-quantum boundary
       WITHOUT the ramp bit and the row goes red, so it credits the byte and not the geometry. */
    const PU = run(`(function(){
      startLevel(${li}, true);
      let lane = null;
      for (let y = 2; y < MH - 2 && !lane; y++) for (let x = 2; x < MW - 8 && !lane; x++) {
        let n = 0; for (let k = 0; k < 7; k++) if (!MAP.cell[y * MW + x + k]) n++;
        if (n >= 7) lane = { x: x, y: y };
      }
      if (!lane) return { skip: 'no 7-cell straight run on this level' };
      const fz0 = MAP.fz.slice(), cz0 = MAP.cz.slice(), vb0 = MAP.vb.slice(), en = ENEMIES[0];
      if (!en) return { skip: 'no enemy generated' };
      ENEMIES.length = 0; ENEMIES.push(en);
      const cell = (k) => lane.y * MW + lane.x + k;
      const arm = (kind) => {
        for (let k = 0; k <= 6; k++) { MAP.fz[cell(k)] = 0; MAP.cz[cell(k)] = 4; MAP.vb[cell(k)] = 0; }
        if (kind === 'stair') { for (let k = 3; k <= 6; k++) MAP.fz[cell(k)] = k - 2; }
        if (kind === 'wall' || kind === 'ramp' || kind === 'ladder' || kind === 'noramp') {
          for (let k = 3; k <= 6; k++) MAP.fz[cell(k)] = 4;
        }
        if (kind === 'ramp') { MAP.vb[cell(2)] |= VB_RAMP; MAP.vb[cell(3)] |= VB_RAMP | (VB_RAMP << 8); }
        if (kind === 'ladder') { MAP.vb[cell(2)] |= VB_LADDER; MAP.vb[cell(3)] |= VB_LADDER | (VB_LADDER << 8); }
        linkBoundaries();
        P.x = lane.x + 6.5; P.y = lane.y + 0.5; P.ang = Math.PI; P.hp = 100; P.deadT = 0;
        P.air = false; P.vz = 0; P.crouch = 0; P.z = floorAt(P.x, P.y);
        en.x = lane.x + 0.5; en.y = lane.y + 0.5; en.state = 'chase'; en.alert = true;
        en.lx = P.x; en.ly = P.y; en.loseT = 1.6; en.hp = 1e6; en.dead = false; en.atkT = 0; en.cd = 0; en.stuck = 0;
        S.mode = 'play'; S.locked = false; PROJ.length = 0;
        let sees = 0, stuckT = 0, reach = 999, climbed = 0;
        for (let i = 0; i < 240; i++) {
          update(1 / 60);
          if (floorAt(en.x, en.y) > 0.01) climbed = 1;
          const dd = Math.hypot(P.x - en.x, P.y - en.y);
          if (dd < reach) reach = dd;
          if (losZ(en.x, en.y, floorAt(en.x, en.y) + en.scale * 0.62, P.x, P.y, eyeH())) sees++;
          if (en.stuck > 0.5) stuckT++;
        }
        return { dx: +(en.x - lane.x).toFixed(2), q: +floorAt(en.x, en.y).toFixed(2),
          reach: +reach.toFixed(2), sees: sees, stuckT: stuckT, climbed: climbed,
          blk: vbAt(lane.x + 0.5, lane.y + 0.5, 0), reachBy: +en.type.reach.toFixed(2),
          dzq: MAP.fz[cell(3)] };
      };
      const o = { gate: canEnter.toString().indexOf('VB_BLOCK') >= 0 ? 'PRESENT' : 'REMOVED' };
      for (const k of ['flat', 'stair', 'wall', 'ramp', 'ladder', 'noramp']) o[k] = arm(k);
      for (let i = 0; i < MAP.fz.length; i++) { MAP.fz[i] = fz0[i]; MAP.cz[i] = cz0[i]; MAP.vb[i] = vb0[i]; }
      linkBoundaries();
      return o; })()`);
    if (PU.skip) row(`L${li} pursuit rows`, false, PU.skip + ' - VACUOUS');
    else {
      const pf = g => `arrives x ${g.dx.toFixed(2)} of 6.00 cells, floor ${g.q.toFixed(2)}, closest ${g.reach.toFixed(2)} (reach ${g.reachBy.toFixed(2)}), eye sees ${g.sees}/240, stuck ${g.stuckT}, boundary block ${g.blk & 1}, gate ${PU.gate}, dz ${g.dzq} q`; 
      const arrived = g => g.dx > 5.0 && g.reach < g.reachBy;
      row(`L${li} a band-0 enemy walks a staircase to a band-1 player`,
        PU.stair.climbed === 1 && arrived(PU.stair),
        `${PU.stair.climbed ? 'climbs: ' : 'NEVER LEFT THE DATUM: '}${pf(PU.stair)}`);
      row(`L${li} a ramp is a link to the AI, not a wall`,
        PU.ramp.climbed === 1 && arrived(PU.ramp) && PU.noramp.climbed === 0 && !arrived(PU.noramp),
        `${pf(PU.ramp)}  | same band with the ramp bit ABSENT: ${pf(PU.noramp)}`);
      row(`L${li} a ladder is a link to the AI too`,
        PU.ladder.climbed === 1 && arrived(PU.ladder),
        pf(PU.ladder));
      row(`L${li} a slab the eye cannot see through stops the body as well`,
        PU.wall.climbed === 0 && !arrived(PU.wall) && PU.wall.sees === 0 && PU.wall.reach > PU.wall.reachBy,
        `${PU.wall.climbed ? 'CLIMBED A BLOCKED SLAB: ' : 'stops at the slab: '}${pf(PU.wall)}`);
      row(`L${li} and on flat ground the chase still closes`,
        arrived(PU.flat) && PU.flat.sees > 200,
        pf(PU.flat));
    }
  }
  console.log(bad ? `SIGHT ${bad} FAILURES` : 'SIGHT ok - hit tests follow the body they hit');
  process.exit(bad ? 1 : 0);
}

if (MODE === 'drop') {
  /* M3's gravity, driven through the real input layer at a fixed dt: does the player leave the ground
     when the floor leaves, land ON the floor below rather than the far cell's, take damage only past
     the impact threshold, and read one quantum down as a step rather than a fall? Driving P.vx by
     hand does nothing - updatePlayer recomputes velocity from `keys` every frame - so the run is
     driven by keys and facing, the way a player is. Landing is judged on the frame the feet arrive
     (#95: sampling the post-update state measures gravity's correction, not gravity), and shake and
     hp are sampled together so a hurt can never be mistaken for a landing. */
  let bad = 0;
  const row = (label, ok, detail) => {
    console.log('  ' + label.padEnd(46) + (ok ? ' ok  ' : ' FAIL') + '  ' + detail);
    if (!ok) bad++;
  };
  const ZQ = run('ZQ'), G = 9.2, SAFE = 5.25;   // js/30_entities.js:333 - 5.25 m/s is a 1.5 m drop
  const PLACE = (x, y, ang) => `P.x=${x};P.y=${y};P.ang=${ang};P.vx=P.vy=P.vz=0;P.air=false;P.z=floorAt(P.x,P.y);` +
    `S.shake=0;for(const k of ['KeyW','KeyA','KeyS','KeyE','KeyQ','Space','ShiftLeft'])delete keys[k];`;
  const trace = (fr) => run(`(()=>{const s=[];keys['KeyW']=1;for(let i=0;i<${fr};i++){update(1/60);` +
    `s.push([P.x,P.y,P.z,P.air?1:0,P.vz,P.hp,S.shake,floorAt(P.x,P.y)]);}return s})()`);
  const snap = () => run('(function(){ window.__fz0 = MAP.fz.slice(); return 1; })()');
  const poke = (cells, dq) => run(`(function(){
    if (!window.__fz0 || window.__fz0.length !== MAP.fz.length) window.__fz0 = MAP.fz.slice();
    for (const i of [${cells.map(c => (c[1] | 0) * run('MW') + (c[0] | 0)).join(',')}]) MAP.fz[i] += ${dq};
    linkBoundaries(); return 1; })()`);
  const restore = () => run('(function(){ for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = __fz0[i]; linkBoundaries(); return 1; })()');
  const angTo = (dx, dy) => Math.atan2(dy, dx);
  const PRE = li => `S.mode='play';S.locked=false;S.diff=1;startLevel(${li},true);` +
    // ENEMIES.length=0 belongs in PRE: a live enemy reaches the walking player for 8 hp a hit and
    // damagePlayer adds shake, and an unattributed shake is how this row first read as a landing that
    // never happened - the #96 lesson, relearned in my own code. hp is sampled per frame below so each
    // row can name WHICH impulse it is counting.
    `ENEMIES.length=0;PROPS.length=0;for(const k in keys)delete keys[k];` +
    `P.vx=P.vy=P.vz=0;P.air=false;P.crouch=0;P.hp=100;P.armor=0;S.shake=0;`;

  for (let li = 0; li < run('LEVELS.length'); li++) {
    seedRng((SEED ^ (li * 2654435761)) >>> 0);
    run(PRE(li));
    snap();
    // the longest open run from the spawn, so the lane exists in whatever direction the level offers
    const lane = (() => {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let best = null;
      for (const d of dirs) {
        run(PLACE(run('P.x'), run('P.y'), angTo(d[0], d[1])));
        const n = run(`(()=>{let n=0;const X=Math.floor(P.x),Y=Math.floor(P.y);
          while(n<8 && MAP.cell[(Y+${d[1]}*n)*MW + X+${d[0]}*n] === 0) n++; return n})()`);
        if (!best || n > best.n) best = { n, dx: d[0], dy: d[1] };
      }
      return best;
    })();
    if (lane.n < 3) { row(`L${li} lane`, false, `no open run of 3 cells from spawn in any direction (best ${lane.n})`); continue; }
    const X = run('P.x'), Y = run('P.y'), LX = Math.floor(X), LY = Math.floor(Y);
    const cellAt = (k) => [[LX + lane.dx * k, LY + lane.dy * k]];
    const put = (x, y) => run(`(()=>{ ${PLACE(x, y, angTo(lane.dx, lane.dy))} return 1 })()`);

    // --- falls: raise the cell the player STANDS ON, so walking forward is stepping off a ledge ----
    const fall = (dq, frames) => {
      put(X, Y);
      poke(cellAt(0), dq);
      put(X, Y);                                    // re-seat ON the raised floor
      const s = trace(frames);
      const airOn = s.findIndex(r => r[3]);
      const landIx = s.findIndex((r, i) => i && s[i - 1][3] && !r[3]);
      const land = landIx < 0 ? null : {
        f: landIx + 1, z: s[landIx][2], gz: s[landIx][7], imp: -s[landIx - 1][4],
        shake: s[landIx][6] - s[landIx - 1][6], hp: s[landIx - 1][5] - s[landIx][5],
      };
      restore();
      return { airOn, air: s.filter(r => r[3]).length, land, end: s[s.length - 1], h: dq * ZQ };
    };

    let r = fall(4, 90);
    const vSafe = Math.sqrt(2 * G * r.h);
    row(`L${li} stepping off a ${(r.h).toFixed(2)} m ledge falls and lands with an impulse`,
      r.air > 0 && !!r.land && Math.abs(r.land.z - r.land.gz) < 0.02 && !r.end[3] &&
      r.land.shake > 0.8 && r.land.hp === 0,
      `air from frame ${r.airOn + 1} (${r.air} airborne frames), landed frame ${r.land && r.land.f} at z ${r.land && r.land.z.toFixed(4)} ` +
      `on floor ${r.land && r.land.gz.toFixed(2)}, impact ${r.land ? r.land.imp.toFixed(2) : '-'} m/s vs sqrt(2gh)=${vSafe.toFixed(2)} ` +
      `(threshold ${SAFE}), shook ${r.land && r.land.shake.toFixed(2)}, hp -${r.land && r.land.hp}`);

    r = fall(12, 120);
    const vHard = Math.sqrt(2 * G * r.h);
    row(`L${li} a ${(r.h).toFixed(2)} m drop hurts`,
      r.air > 0 && !!r.land && r.land.hp > 3 && Math.abs(r.land.z - r.land.gz) < 0.02,
      `impact ${r.land ? r.land.imp.toFixed(2) : '-'} m/s vs ${vHard.toFixed(2)} predicted, hp -${r.land && r.land.hp.toFixed(2)} ` +
      `(formula (imp-${SAFE})*12 = ${Math.max(0, (vHard - SAFE) * 12).toFixed(1)}), landed on floor ${r.land && r.land.gz.toFixed(2)}`);

    // --- a step UP: blocked, and no lift from reading the far cell's floor as support --------------
    put(X, Y);
    poke(cellAt(1).concat(cellAt(2)), 4);
    const vb = run(`(function(){ return { own: MAP.vb[${LY * run('MW') + LX}], ahead: MAP.vb[${(LY + lane.dy) * run('MW') + LX + lane.dx}] }; })()`);
    put(X, Y);
    const w = trace(60);
    const moved = Math.hypot(w[w.length - 1][0] - X, w[w.length - 1][1] - Y);
    const zmax = Math.max.apply(null, w.map(x => x[2])), zmin = Math.min.apply(null, w.map(x => x[2]));
    const airF = w.findIndex(x => x[3]);
    restore();
    row(`L${li} a step up blocks without lifting the player`,
      moved < 0.7 && airF < 0 && Math.abs(zmax - zmin) < 1e-6,
      `moved ${moved.toFixed(2)} m in 1 s into the riser, z stayed ${zmin.toFixed(4)} (max ${zmax.toFixed(4)}), ` +
      `air ${airF < 0 ? 'never' : 'frame ' + (airF + 1)}, vb own 0x${(vb.own >>> 0).toString(16)} ahead 0x${(vb.ahead >>> 0).toString(16)}`);

    // --- one quantum down must be a STEP: the edge test is strict (gz < P.z - ZQ), so no air ------
    put(X, Y);
    poke(cellAt(1).concat(cellAt(2)), -1);
    put(X, Y);
    const zStart = run('P.z');
    const st = trace(45);
    const stAir = st.findIndex(x => x[3]);
    const jump = Math.max.apply(null, st.map((x, i) => i ? x[6] - st[i - 1][6] : 0));
    const zEnd = st[st.length - 1][2];
    restore();
    row(`L${li} one quantum down is a step, not a fall`,
      stAir < 0 && jump < 0.5 && Math.abs(zEnd - (zStart - ZQ)) < 0.02,
      `air ${stAir < 0 ? 'never' : 'frame ' + (stAir + 1)}, biggest shake jump ${jump.toFixed(3)}, hp -${(st[0][5] - st[st.length - 1][5]).toFixed(2)}, ` +
      `z ${zStart.toFixed(3)} -> ${zEnd.toFixed(3)} (wants ${(zStart - ZQ).toFixed(3)})`);

    /* --- one quantum UP, and nothing blocking it: the boundary is walkable (dq 1 never earns
       VB_BLOCK), so the feet have to END on the new floor, not drift onto it. The row counts the
       frames after the crossing whose z disagrees with floorAt, because the auto-step ease converges
       to the same number within 1e-4 - a final-state comparison alone cannot tell a lift from an
       ease, and 26 frames of camera drift on a 0.25 m step is the defect (#152). --- */
    put(X, Y);
    poke(cellAt(1).concat(cellAt(2)), 1);
    put(X, Y);
    const zUp = run('P.z');
    const su = trace(45);
    const suAir = su.findIndex(x => x[3]);
    const suMove = Math.hypot(su[su.length - 1][0] - X, su[su.length - 1][1] - Y);
    const suShake = Math.max.apply(null, su.map((x, i) => i ? x[6] - su[i - 1][6] : 0));
    const suCross = su.findIndex(x => x[7] > zUp + 1e-9);
    const suOff = suCross < 0 ? -1 : su.slice(suCross + 1).filter(x => Math.abs(x[2] - x[7]) > 1e-9).length;
    const suVb = run(`(function(){ return MAP.vb[${(LY + lane.dy) * run('MW') + LX + lane.dx}]; })()`);
    const zUpEnd = su[su.length - 1][2], gUpEnd = su[su.length - 1][7];
    restore();
    row(`L${li} an unblocked quantum step up lifts the feet`,
      suCross >= 0 && suOff === 0 && suAir < 0 && suShake < 0.5 && suMove > 0.7 &&
      zUpEnd === gUpEnd && Math.abs(zUpEnd - (zUp + ZQ)) < 1e-6,
      `crossed on frame ${suCross + 1} into floor ${gUpEnd.toFixed(2)}, ${suOff} later frames with z off the floor `
      + `(an eased lift would drift ~26), z ${zUp.toFixed(3)} -> ${zUpEnd.toFixed(3)} (wants ${(zUp + ZQ).toFixed(3)}), `
      + `moved ${suMove.toFixed(2)} m, air ${suAir < 0 ? 'never' : 'frame ' + (suAir + 1)}, biggest shake jump `
      + `${suShake.toFixed(3)} (a landing impulse), vb of the far cell 0x${(suVb >>> 0).toString(16)} (VB_BLOCK not set)`);
  }

  console.log(bad ? `DROP ${bad} FAILURES` : 'DROP ok - the player lands on the floor they fall to');
  process.exit(bad ? 1 : 0);
}

if (MODE === 'horizon') {
  /* #24's horizon half. M0 made P.z an absolute altitude, and the claim was that the horizon stays
     where the CAMERA puts it - js/40_render.js:97 carries no altitude term at all, only BH/2 + aimPx
     + bob + shake. Asserting that alone is vacuous (a constant horizon passes it too), so the rows
     come in pairs: invariance to altitude, then proof the frame really did change, then proof the
     horizon DOES move when the thing that should move it does. The third row reads the renderer's own
     eye altitude: js/40_render.js:95 clamps it into [0.12, 1.4], a bound written when P.z was a crouch
     offset in [0,1]; under absolute altitude it becomes a CEILING on where the player can stand. */
  let bad = 0, known = 0;
  const STRICT = !!process.env.STRICT;
  const row = (label, ok, detail, knownIssue) => {
    const tag = ok ? ' ok  ' : knownIssue ? 'KNOWN' : ' FAIL';
    console.log('  ' + label.padEnd(46) + tag + '  ' + detail + (ok || !knownIssue ? '' : '  [' + knownIssue + ']'));
    if (ok) return;
    if (knownIssue && !STRICT) known++; else bad++;
  };
  const ZQ = run('ZQ'), BW = run('BW'), BH = run('BH'), MW = run('MW');
  const PRE = li => `S.mode='play';S.locked=false;S.diff=1;startLevel(${li},true);ENEMIES.length=0;PROPS.length=0;` +
    `for(const k in keys)delete keys[k];P.vx=P.vy=P.vz=0;P.air=false;P.crouch=0;P.hp=100;P.armor=0;S.shake=0;P.bob=0;P.pitch=0;P.recoil=0;`;
  const snap = () => run('(function(){ window.__fz0h = MAP.fz.slice(); return 1; })()');
  // the index is built INSIDE the sandbox on purpose: MW changes per level (26x26 then 32x32), so a
  // value captured once at probe start indexes off the end of the array past level 0, and a typed-array
  // write past the end is silently dropped - the poke then does nothing and the frame never changes.
  const poke = (cells, dq) => run(`(function(){
    for (const i of [${cells.map(c => `${(c[1] | 0)} * MW + ${(c[0] | 0)}`).join(',')}]) MAP.fz[i] += ${dq};
    linkBoundaries(); return 1; })()`);
  const restore = () => run('(function(){ for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = __fz0h[i]; linkBoundaries(); P.z = floorAt(P.x, P.y); return 1; })()');
  const look = () => run('(function(){ P.z = floorAt(P.x, P.y); renderWorld(); return { hz: horizon, eye: eyeZ, z: P.z, cfg: cfg.eye }; })()');
  const frame = () => new Uint32Array(run('px'));
  const diffPx = (a, b) => { let n = 0; for (let i = 0, N = a.length; i < N; i++) if (a[i] !== b[i]) n++; return n; };

  for (let li = 0; li < run('LEVELS.length'); li++) {
    seedRng((SEED ^ (li * 2654435761)) >>> 0);
    run(PRE(li)); snap();
    const flat = look(), frameFlat = frame();
    const own = [[Math.floor(run('P.x')), Math.floor(run('P.y'))]];

    const rows = [];
    for (const dq of [4, -4, 8]) {
      poke(own, dq);
      const a = look(), frameA = frame(), changed = diffPx(frameFlat, frameA);
      poke(own, -dq);
      rows.push({ dq, a, changed });
    }
    const hzErr = Math.max.apply(null, rows.map(r => Math.abs(r.a.hz - flat.hz)));
    row(`L${li} the horizon does not know the player's altitude`, hzErr < 1,
      `horizon ${flat.hz.toFixed(3)} at the level's own datum vs ${rows.map(r => r.a.hz.toFixed(3)).join(' / ')} at P.z ${rows.map(r => r.a.z.toFixed(2)).join(' / ')} (worst |d| ${hzErr.toFixed(3)} px of ${BH}) - js/40_render.js:97 has no altitude term`);

    const minChanged = Math.min.apply(null, rows.map(r => r.changed));
    row(`L${li} the frame does know it, so the row above can fail`,
      minChanged > 0.01 * BW * BH,
      `fewest pixels changed by a poke of ${rows.map(r => (r.dq * ZQ).toFixed(2)).join(' / ')} m: ${minChanged} of ${BW * BH} (${(100 * minChanged / (BW * BH)).toFixed(2)}%), P.z ${rows.map(r => r.a.z.toFixed(2)).join(' / ')} (a poke that does not move P.z did not reach the grid)`);

    // the renderer's own eye, on each band, against cfg.eye + P.z with the clamp not binding
    const eyeRows = rows.map(r => ({ dq: r.dq, want: flat.cfg + r.a.z, got: r.a.eye, z: r.a.z }));
    const worst = eyeRows.reduce((m, r) => Math.max(m, Math.abs(r.got - r.want)), 0);
    row(`L${li} the eye altitude tracks the band the player stands on`, worst < 1e-6,
      `cfg.eye ${flat.cfg.toFixed(2)}: eye should be ${eyeRows.map(r => r.want.toFixed(2)).join(' / ')} for P.z ${eyeRows.map(r => r.z.toFixed(2)).join(' / ')}, renderer uses ${eyeRows.map(r => r.got.toFixed(2)).join(' / ')} - js/40_render.js:95 clamps to [0.12, 1.4], a bound from when P.z was a crouch offset (worst off ${worst.toFixed(2)} m)`, '#103');

    const pRow = [];
    for (const pk of [200, -200]) {
      run(`P.pitch=${pk};`);
      pRow.push({ pk, hz: look().hz });
    }
    run('P.pitch=0;');
    const slope = (pRow[0].hz - pRow[1].hz) / (pRow[0].pk - pRow[1].pk);
    row(`L${li} pitching the camera moves the horizon`,
      Math.abs(slope - 1) < 0.02 && Math.abs(pRow[0].hz - flat.hz) > 100,
      `horizon ${flat.hz.toFixed(1)} at pitch 0, ${pRow.map(r => r.hz.toFixed(1) + ' at pitch ' + r.pk).join(', ')} -> ${slope.toFixed(4)} px of horizon per px of pitch (aimPx is in pixels, so 1)`);
    restore();
  }

  console.log((bad ? `HORIZON ${bad} FAILURES` : 'HORIZON ok - the horizon belongs to the camera, not to the floor') +
    (known ? `  (${known} known ${STRICT ? 'FAILED under STRICT' : 'reporting'} rows: eyeZ clamps at 1.4, #103)` : ''));
  process.exit(bad ? 1 : 0);
}

if (MODE === 'cull') {
  /* #24's cull half: does a body's SILHOUETTE move with the band it stands on, and does a body
     behind a raised floor actually go behind it? Since #72 the draw entry computes floorAt(e.x, e.y)
     per frame, so the answer should be yes - but nothing asserts it, which is what "shots pass
     through the catwalk enemy" and "the body floats over the mezzanine" both shipped green means.
     The mask is render-with minus render-without (the contrast technique), so world churn from the
     poke cannot fake it: poking MAP.fz changes the room, and the difference cancels the room.
     Predictions come from similar triangles (rows = dz * BH / perp) and are printed next to the
     measurement rather than quoted from a derivation. */
  let bad = 0, known = 0;
  const STRICT = !!process.env.STRICT;
  // Rows come in two kinds and the difference must be in the exit code, not in a comment: the
  // displacement families assert (they would fail today if the draw entry stopped reading floorAt),
  // the occlusion family detects #100 and is red until that is fixed. STRICT=1 gates the latter too.
  const row = (label, ok, detail, knownIssue) => {
    const tag = ok ? ' ok  ' : knownIssue ? 'KNOWN' : ' FAIL';
    console.log('  ' + label.padEnd(46) + tag + '  ' + detail + (ok || !knownIssue ? '' : '  [' + knownIssue + ']'));
    if (ok) return;
    if (knownIssue && !STRICT) known++; else bad++;
  };
  const W = run('BW'), H = run('BH'), ZQS = run('ZQ');
  const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);
  let czRows = 0;                                              // #177: CZBAND rows actually emitted

  // one frame with the body, one without: the difference IS the silhouette
  const shot = () => {
    run('S.t = 3.5; renderWorld()');
    const A = new Uint32Array(run('px'));
    run('__keep = ENEMIES.slice(); ENEMIES.length = 0; renderWorld(); ENEMIES.length = 0; for (const q of __keep) ENEMIES.push(q);');
    const B = new Uint32Array(run('px'));
    let n = 0, sy = 0, top = H, bot = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(lum(A, i) - lum(B, i)) > 4 || (A[i] >>> 24) - (B[i] >>> 24) !== 0) {
          n++; sy += y; if (y < top) top = y; if (y > bot) bot = y;
        }
      }
    }
    return { px: n, cy: n ? sy / n : -1, top: bot >= 0 ? top : -1, bot };
  };

  for (let li = 0; li < 3; li++) {
    const setup = run(`(function(){
      startLevel(${li}, true);
      /* #223: the lightmap THIS level was generated with, stamped before any row can splat a
         transient into it. MAP.light is maintained by splat/un-splat deltas at runtime, so reading it
         late would make a recorded reference depend on which rows ran first. Nothing between here and
         the CZBAND block calls startLevel again, so this is the grid the hashed frame renders. */
      window.__lwGen = MAP.light.slice();
      let lane = null;
      for (let y = 2; y < MH - 2 && !lane; y++) for (let x = 2; x < MW - 9 && !lane; x++) {
        let n = 0; for (let k = 0; k < 8; k++) if (!MAP.cell[y * MW + x + k]) n++;
        if (n >= 8) lane = { x: x + 0.5, y: y + 0.5 };
      }
      if (!lane) return { skip: 'no 8-cell straight run' };
      const en = ENEMIES[0];
      if (!en) return { skip: 'no enemy generated' };
      ENEMIES.length = 0; ENEMIES.push(en);              // isolate the cast: clear, do not move (#96)
      en.state = 'sleep'; en.alert = false; en.movingAmt = 0; en.anim = 0;
      P.x = lane.x; P.y = lane.y; P.z = floorAt(P.x, P.y); P.ang = 0; P.pitch = 0; P.crouch = 0;
      return { lane };
    })()`);
    if (setup.skip) { console.log(`L${li}: ${setup.skip}  SKIP`); bad++; continue; }
    // props out of the lane too: a crate between the lens and the body occludes one config and not
    // the next, which on L0 (a 114 px speck) read as "the sunk body is BIGGER than the flat one".
    // The mask cancels anything static across the two renders, so this only removes confounders.
    run('window.__props = PROPS.slice(); PROPS.length = 0;');
    const putProps = () => run('PROPS.length = 0; for (const q of __props) PROPS.push(q);');

    // the saved grid stays inside the sandbox: an Int8Array serialises as {"0":..}, not as a row
    const poke = (cells, dq) => run(`(function(){
      window.__fz0 = MAP.fz.slice();
      ${JSON.stringify(cells)}.forEach(([cx, cy]) => { MAP.fz[(cy | 0) * MW + (cx | 0)] += ${dq}; });
      linkBoundaries();
      return MAP.fz[(cells0 = 0, ${JSON.stringify(cells)}[0][1] | 0) * MW + (${JSON.stringify(cells)}[0][0] | 0)];
    })()`);
    const restore = () => run('(function(){ for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = __fz0[i]; linkBoundaries(); return 1; })()');

    // A: the body alone moves band-to-band; the lane between the lens and it stays flat
    /* #163 changes what THIS geometry shows, so the row owns a taller sight path. A body one band above
       a flat corridor is behind that corridor's ceiling slab, and once ceiling rows carry a distance it is
       correctly INVISIBLE: measured on the fixed build, area 0 px on all three levels where main reported
       1489/1533/1410 px and a 87-95 px centroid shift - the row had been measuring a body drawn through
       the floor above it. The altitude claim is still worth gating, so MAP.cz goes to CZ_DEF*2 for the
       pair: that lifts the plane the rays cross without moving any floor, both renders of every pair
       share the poke, and the difference is still the body and nothing else. Restored before the step
       rows, which must stay on a 1-unit ceiling to be comparable with `flat`. */
    run('window.__cz0 = MAP.cz.slice(); MAP.cz.fill(CZ_DEF * 2); linkBoundaries();');
    const base = run(`(function(){
      const en = ENEMIES[0]; en.x = ${setup.lane.x} + 4; en.y = ${setup.lane.y}; en.z = floorAt(en.x, en.y);
      return { d: Math.hypot(en.x - P.x, en.y - P.y), scale: en.scale, ef: floorAt(en.x, en.y) };
    })()`);
    const flat = shot();
    const pred = zq => Math.abs(zq) * ZQS * run('BH') / base.d;
    // The two directions are different physical situations and must not share one assertion.
    // Raised: the body is fully visible above the flat lane, so its centroid moves by the projected
    // unit. Sunk: the lip of its own hole hides almost all of it - THAT IS CORRECT, and the visible
    // remainder should be small and LOW, so this row asserts occlusion rather than displacement. An
    // earlier version applied the raised rule to both and called correct occlusion a failure.
    const exCell = [Math.floor(setup.lane.x + 4), Math.floor(setup.lane.y)];
    poke([exCell], 4);
    run('ENEMIES[0].z = floorAt(ENEMIES[0].x, ENEMIES[0].y);');
    const up = shot();
    restore();
    const shiftUp = up.cy >= 0 && flat.cy >= 0 ? flat.cy - up.cy : 0;
    const want = pred(4);
    row(`L${li} body on a band +1`,
      shiftUp >= 0.5 * want && up.px > 0.4 * flat.px && up.px < 2.5 * flat.px,
      `centroid moved up ${shiftUp.toFixed(1)} px of ${want.toFixed(1)} predicted for 1 unit at ${base.d.toFixed(1)} m (rows = BH/perp), area ${up.px} vs ${flat.px}, top ${flat.top} -> ${up.top}`);

    poke([exCell], -4);
    run('ENEMIES[0].z = floorAt(ENEMIES[0].x, ENEMIES[0].y);');
    const dn = shot();
    restore();
    const shiftDn = dn.cy >= 0 && flat.cy >= 0 ? dn.cy - flat.cy : 0;
    row(`L${li} body in a pit is hidden by its own lip`,
      shiftDn > 0 && dn.px < 0.5 * flat.px,
      `centroid moved down ${shiftDn.toFixed(1)} px and only ${(100 * dn.px / flat.px).toFixed(1)}% of the flat silhouette survives (the crown at ${base.ef.toFixed(2)}+${base.scale.toFixed(2)} is all that clears the lip), top ${flat.top} -> ${dn.top}`);
    run('MAP.cz.set(__cz0); linkBoundaries();');   // the taller sight path belongs to row A alone

    // B: a step up between the lens and the body, measured twice, because the interesting question is
    // not only "is the body hidden" but "did the step draw ANYTHING": a boundary with VB_BLOCK on the
    // LOW cell's uphill nibble (js/20_level.js:143 - asymmetric, so reading the raised cell shows 0 and
    // looks like a missing derivation) is impassable, yet the wall pass cannot enumerate it because a
    // face is produced only where the DDA stops at a SOLID column (js/40_render.js:503-508) and an
    // air-air border never stops the DDA at all. STEP is in quanta so the threshold can be walked.
    const STEP = +(process.env.STEP || 4);
    const mid = [];
    for (let k = 1; k <= 3; k++) mid.push([Math.floor(setup.lane.x) + k, Math.floor(setup.lane.y)]);
    run('(function(){ window.__bak = ENEMIES.slice(); ENEMIES.length = 0; renderWorld(); return 1; })()');
    const bgFlat = new Uint32Array(run('px'));
    poke(mid, STEP);
    run('renderWorld()');
    const bgPoke = new Uint32Array(run('px'));
    const horizonPx = run('horizon');            // the engine's own horizon, not a derivation
    let bgn = 0, bgTop = -1, bgBot = -1, bgBelow = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (bgFlat[i] !== bgPoke[i]) { bgn++; if (bgTop < 0) bgTop = y; bgBot = y; if (y > horizonPx) bgBelow++; }
    }
    const facts = run(`(function(){
      const lo = ${(Math.floor(setup.lane.x) | 0)} * MW + ${(Math.floor(setup.lane.y) | 0)};
      const hi = ${(Math.floor(setup.lane.x) + 3 | 0)} * MW + ${(Math.floor(setup.lane.y) | 0)};
      return { vbLow: MAP.vb[lo], vbHigh: MAP.vb[hi], VB_BLOCK: VB_BLOCK,
        floorLow: floorAt(P.x, P.y), floorHigh: floorAt(P.x + 3, P.y),
        ceilLow: ceilAt(P.x, P.y), cpLow: MAP.ceilPlane[lo], cpHigh: MAP.ceilPlane[hi],
        canUp: canEnter(lo, 0) ? 1 : 0 };
    })()`);
    run('(function(){ for (let i = 0; i < MAP.fz.length; i++) MAP.fz[i] = __fz0[i]; linkBoundaries(); ENEMIES.length = 0; for (const q of __bak) ENEMIES.push(q); return 1; })()');

    poke(mid, STEP);
    const hid = shot();
    const stops = run('MAP.riserStops');      // rays that stopped at an air->air riser this frame
    restore();
    /* A WALKABLE step (one quantum: you step up it, canEnter allows it) draws a FACE and must not
       BLOCK: those are two different bytes and #192 is the proof that the row had them welded. What
       this row demands is that the crossing be RECORDED - some ray must stop at a riser once a
       1-quantum step stands in the frame - because the wall pass used to emit a face only above
       `|dq| > 1`, a threshold copied from the VB_BLOCK rule that decides what canEnter refuses, and
       so a staircase was a hole in zbuf with a seam multiply painted over it. The flag still has to
       be forced to 1 AFTER the poke: poke() relinks, relinking recomputes MAP.steps to 0 for a grid
       whose only step is one quantum, and forcing it first made this row print 0 stops whatever the
       renderer did (the STEP-threshold control caught that, and nothing else could). The flattened
       base is kept for the same reason it was put in: generated content legitimately has faces now
       (#152 authors 1-unit risers), so without the flat control the row would print a nonzero number
       on a build that drew nothing at all. STEP stays an env knob: STEP=1 moves the OTHER row's
       geometry onto this one's, which is how a renderer that stops at every height difference - or
       at none - is told apart from one that stops where the byte says to. */
    run('MAP.fz.fill(0); linkBoundaries(); MAP.steps = 1;');
    const walkFlat = shot();
    const stopsFlat = run('MAP.riserStops');
    poke(mid, 1);
    run('MAP.steps = 1');
    const walk = shot();
    const stops1 = run('MAP.riserStops');
    restore();
    // An AUTHORED ramp is the other case that must not draw a face: it is a slope the ground pass
    // paints, its bit lives in VB_KEEP so a relink preserves it while clearing the derived blocker,
    // and this is the only row that exercises the RAMP clause of the renderer's stop test - nothing
    // in the generator authors a ramp, so every other path through that clause is unreachable.
    // ONE raised cell, not a run: the flanks of a run are ordinary step faces and would legitimately
    // stop rays. What must survive is the view of the body behind the slope.
    restore();
    const ramp = run(`(function(){
      const ly = ${Math.floor(setup.lane.y)}, loX = ${Math.floor(setup.lane.x) | 0} + 1, hiX = loX + 1;
      MAP.fz[ly * MW + hiX] += ${STEP};
      MAP.vb[ly * MW + loX] |= VB_RAMP;                 // uphill nibble of the low cell (+x)
      MAP.vb[ly * MW + hiX] |= VB_RAMP | (VB_RAMP << 8);  // the slope CONTINUES through the cell: the
      //   -x nibble is the same crossing seen from above, and the +x nibble is its far edge - leave
      //   that one plain and the raised cell is a plinth whose far step-down hides the body legitimately
      linkBoundaries();
      return { canUp: canEnter(loX + 0.5, ly + 0.5, hiX + 0.5, ly + 0.5) ? 1 : 0,
               vb: (MAP.vb[ly * MW + loX] >> 0) & 15, steps: MAP.steps };
    })()`);
    const rampShot = shot();
    const stopsR = run('MAP.riserStops');
    restore();
    row(`L${li} an authored ramp is a slope, not a wall`, rampShot.px > 0.6 * flat.px && ramp.canUp === 1,
      `body behind the ramp kept ${(100 * rampShot.px / Math.max(1, flat.px)).toFixed(0)}% of its silhouette` +
      ` (${flat.px} -> ${rampShot.px} px), canEnter ${ramp.canUp ? 'allows' : 'REFUSES'} the crossing,` +
      ` nibble 0x${ramp.vb.toString(16)}, MAP.steps ${ramp.steps}, ${stopsR} ray(s) stopped on faces nearby`);
    row(`L${li} a walkable step of ${(ZQS).toFixed(2)} m draws a face`, stopsFlat === 0 && stops1 > 0,
      `${stops1} ray(s) stopped at the riser of a 1-quantum step (want > 0: a tread the player walks up` +
      ` is geometry the depth buffer must carry - #192), ${stopsFlat} on the same frame with the grid` +
      ` flattened to the datum (want 0 - the control that keeps this row from being satisfied by the` +
      ` faces generated content legitimately has); the body behind the step kept` +
      ` ${(100 * walk.px / Math.max(1, walkFlat.px)).toFixed(0)}% of its silhouette on that base (${walkFlat.px} -> ${walk.px} px)` +
      ` and canEnter still steps over the crossing`);
    row(`L${li} body behind a step of ${(STEP * ZQS).toFixed(2)} m`,
      hid.px < 0.25 * flat.px && stops > 0,
      `silhouette ${hid.px} px vs ${flat.px} flat; background changed ${bgn} px (${(100 * bgn / (W * H)).toFixed(2)}%, rows ${bgTop}..${bgBot}); ` +
      `low cell blocks ${(facts.vbLow & facts.VB_BLOCK) ? 'yes' : 'no'} (vb 0x${facts.vbLow.toString(16)}, raised cell 0x${facts.vbHigh.toString(16)}), ` +
      `floors ${facts.floorLow.toFixed(2)} -> ${facts.floorHigh.toFixed(2)}, ceilAt(low) ${facts.ceilLow.toFixed(2)}, ceilPlane ${facts.cpLow.toFixed(2)} -> ${facts.cpHigh.toFixed(2)}`);
    /* ---- #163: does a PROP on the band above go BEHIND the slab? ------------------------------
       The ground pass left Infinity on every ceiling row (js/40_render.js:287,:311) and a mesh's only
       occlusion test is `occ < z` (js/13_mesh.js:524), so nothing on those rows could hide a body and
       the part of a prop above the low room's ceiling plane drew through the floor it stands on.
       The geometry is chosen, not convenient: the raised band starts THREE cells out, so the riser's
       top edge projects at row ~101 of 338 while the lamp's crown is at row ~31 - rows 31..101 have no
       wall face in front of them at all, and the ceiling solve is the only occluder there. Raising the
       band ONE cell ahead instead puts the riser top at row 0, the wall pass hides the prop by itself,
       and the row passes on a build with no ceiling depth at all (measured: 0 px both ways) - which is
       the "probe that cannot fail" this file keeps having to relearn.
       Both halves move ONE variable: the same 9 cells, the same prop, the same camera, band cz+4 and
       band cz. Measured per level (L0/L1/L2, BH 338): above the band 0 px fixed vs 565/565/490 px
       reverted at rows 58..101, every reverted pixel behind a sentinel zbuf; own band 850/756/804 px,
       of which 364/262/313 sit above the horizon over ceiling rows whose zbuf is now finite and < FARB
       - a nearer body still draws, so "hide everything" and "Infinity renamed to 1e30" both fail here. */
    const BG = run(`(()=>{
      const cx = ${Math.floor(setup.lane.x) | 0}, cy = ${Math.floor(setup.lane.y) | 0};
      P.x = ${setup.lane.x}; P.y = ${setup.lane.y}; P.ang = 0; P.pitch = 0; P.crouch = 0;
      P.z = floorAt(P.x, P.y); ENEMIES.length = 0; PROPS.length = 0; PROJ.length = 0;
      exitX = -40; exitY = -40;
      const cz = MAP.fz[cy * MW + cx], cells = [];
      for (let k = 3; k <= 6; k++) for (let d = -1; d <= 1; d++) {
        const x = cx + k, y = cy + d;
        if (x < 1 || y < 1 || x >= MW - 1 || y >= MH - 1 || MAP.cell[y * MW + x]) continue;
        cells.push([x, y]);
      }
      return { cz, cells, lx: cx + 4.5, ly: cy + 0.5, pf: floorAt(cx + 4.5, cy + 0.5) };
    })()`);
    const LAMP = `PROPS.length = 0; PROPS.push({tex:PROP.lamp,x:${BG.lx},y:${BG.ly},z:floorAt(${BG.lx},${BG.ly}),scale:0.95,kind:'lamp'});`;
    // one band above the camera (cz + 4 quanta = +1.00 m), air cells only, grid restored by restore()
    const setBand = zq => run(`(function(){
      window.__fz0 = MAP.fz.slice();
      ${JSON.stringify(BG.cells)}.forEach(([cx, cy]) => { MAP.fz[(cy | 0) * MW + (cx | 0)] = ${zq}; });
      linkBoundaries(); return MAP.fz[${Math.floor(setup.lane.y)} * MW + ${Math.floor(setup.lane.x) + 4}];
    })()`);
    const FARBV = run('FARB'), HZZ = Math.round(run('horizon'));
    /* Rows above RISE_TOP have NO wall face in front of them: RISE_TOP is where the raised band's
       riser projects (similar triangles, horizon - (slab underside - eyeZ) * BH / distance to the
       boundary), so for y < RISE_TOP the ceiling solve is the only thing that can hide the prop, which
       is exactly the #163 case. BELOW it the pixel sits on the low/raised SEAM: that band used to be
     EXCLUDED here, which made the row print green while a prop drew through the slab (398-438 px,
     #170 - and the pixels were all on the deferred path, answered from the plane the queued solve had
     reached rather than the one whose cell extends to the hit point). Asserted whole now. */
    const CAMCP = run(`MAP.ceilPlane[${Math.floor(setup.lane.y)} * MW + ${Math.floor(setup.lane.x)}]`);
    const TBOUND = 2.5;                                  // cell cx+3 starts at x = cx + 3, camera at cx + 0.5
    const RISE_TOP = HZZ - (CAMCP - run('eyeZ')) * run('BH') / TBOUND;
    // with the prop, then without: the difference IS the prop, so world churn cannot fake the mask
    const pshot = cutY => {
      run('MESH.reset(); S.t = 3.5; renderWorld()');
      const A = new Uint32Array(run('px'));
      run('window.__pq = PROPS.slice(); PROPS.length = 0; renderWorld(); for (const q of __pq) PROPS.push(q);');
      const B = new Uint32Array(run('px')), zB = new Float32Array(run('zbuf'));
      let n = 0, inR = 0, top = H, bot = -1, above = 0, fin = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(lum(A, i) - lum(B, i)) > 4 || (A[i] >>> 24) - (B[i] >>> 24) !== 0) {
          n++; if (y < top) top = y; if (y > bot) bot = y;
          if (y < cutY) inR++;
          if (y < HZZ) { above++; const z = zB[i]; if (z > 0 && z < FARBV) fin++; }
        }
      }
      return { n, inR, top, bot, above, fin };
    };
    setBand(BG.cz + 4);
    run(LAMP);
    const above = pshot(RISE_TOP);
    const lampT = run(`(()=>{const dx=${BG.lx}-camX,dy=${BG.ly}-camY;return (1/(planeX*dirY-dirX*planeY))*(-planeY*dx+planeX*dy)})()`);
    setBand(BG.cz);
    run(LAMP);
    const ownB = pshot(-1);
    restore();
    run('PROPS.length = 0;');
    row(`L${li} a prop one band above is hidden by the slab`,
      above.n <= Math.max(24, 0.04 * ownB.n) && above.inR <= Math.max(16, 0.02 * ownB.n) &&
      ownB.n >= 250 && ownB.above >= 0.2 * ownB.n &&
      ownB.fin >= 0.6 * ownB.above,
      `lamp 0.95 m at ${lampT.toFixed(2)} m on band ${((BG.cz + 4) * run('ZQ')).toFixed(2)} vs the camera's ${(BG.cz * run('ZQ')).toFixed(2)}: ${above.n} px of silhouette at rows ${above.top}..${above.bot}, of which ${above.inR} in the ceiling-only band above the riser's top edge (ceilPlane ${CAMCP.toFixed(2)}, boundary ${TBOUND} m) - the seam band below the riser's edge is asserted too, not excluded (#170); the same prop on the camera's own band keeps ${ownB.n} px, ${ownB.above} above the horizon with a finite ceiling distance (FARB ${FARBV}) behind ${ownB.fin} of them`);
    console.log(`  L${li} reference: flat silhouette ${flat.px} px, centroid ${flat.cy.toFixed(1)} of ${H}, rows ${flat.top}..${flat.bot}, body ${base.scale.toFixed(2)} units at ${base.d.toFixed(2)} m`);

    putProps();

    /* ---- LEAK ATTRIBUTION (LEAK=1) -------------------------------------------------------------
       Two env vars, and each exists to catch ONE wrong fix (#177):
         LEAK=1   catches "the leak is gone, so the deferred pass is fine": it says WHICH GROUND PATH
                  painted the pixels, so a fix that answers them from the row instead of the re-solve
                  cannot be mistaken for a fix of the arithmetic. The attribution itself is only as
                  good as the geometry: on current main the #170 leak is 0 px, so these rows report
                  the split with an empty mask and say so (LEAK-VACUUM) rather than print zeros as a
                  verdict. CZBAND is the part that can still fail on this build.
         CZBAND=1 catches "adopt the nearer plane on ceiling rows": it hashes the ground pass over the
                  MIRROR geometry - floors flat, a farther ceiling four cells out - where that rule
                  paints the NEAR ceiling across a room whose ceiling is genuinely farther. It is the
                  only row in the repo that sees that fix, because every other config either raises
                  both ceilings (nothing queues) or raises a FLOOR (the leak geometry, now fixed).
       CFG=ship,nodefer,alldefer picks the configs, LEAKROW=1 adds the per-pixel row-path/deferred map.
       Off by default: `node tools/view.js cull` without them runs no line of this block.
       CZBAND hashes recorded on fix/far-band-light-197 (#197, the commit that moves the far band's light
       off the camera's own cell; they were 14c12844/8ab438b0/5a425d84 on 5f14a09, and before that the
       bb92cda0/80688d4a/0186ce30 quoted in #177): L0 2711a2a8, L1 10157366, L2 eaee1fd8.
       Which ground path paints the pixels where a prop on the band above still draws through the
       slab? Same frame, three configs of ONE line (js/40_render.js:468): ship (the split as
       authored), nodefer (the split can never queue, so castGround's own body paints every pixel of
       the row and groundPixel runs on nothing) and alldefer (the split always queues, so
       groundPixel paints everything the row does not far-band away). The config is a SOURCE
       transform of castGround, not a wrapper around it, so the hot-loop-wrapper cost documented in
       AGENTS cannot be confused with a picture change - and each config's own deferred-call count
       is the proof the patch is live: 0 for nodefer, ~one per pixel for alldefer.
       Provenance is recorded by wrapping groundPixel the way `heights` already does, so a pixel is
       'deferred' iff the renderer itself decided to re-solve it and 'row-painted' otherwise; the
       ground pass covers every pixel of every row, so there is no third case except the horizon.
       Nothing here changes arithmetic, thresholds or any row above: the block runs after every
       verdict for the level, restores MAP.fz and un-patches castGround. */
    if (process.env.LEAK) {
      const NEEDLE = 'if (planeC !== planeA) { RX[nm] = x; RP[nm] = planeC; nm++; continue; }';
      const REPL = c => c === 'nodefer' ? NEEDLE.replace('if (planeC', 'if (false && planeC')
        : c === 'alldefer' ? 'if (true) { RX[nm] = x; RP[nm] = planeC; nm++; continue; }'
          : NEEDLE;
      const CFGS = (process.env.CFG || 'ship,nodefer,alldefer').split(',');
      run('var GD={set:new Uint8Array(0),a:[],n:0,cap:400000};');
      const GRES = '(()=>{if(GD.set.length<BW*BH)GD.set=new Uint8Array(BW*BH);else GD.set.fill(0);GD.a.length=0;GD.n=0})()';
      const GON = `(()=>{if(!globalThis.__gpL){globalThis.__gpL=groundPixel;const O=groundPixel;groundPixel=` +
        `function(x,pl,row){GD.set[row+x]=1;if(GD.a.length<GD.cap)GD.a.push(row+x,pl);GD.n++;return O.apply(this,arguments)}}})()`;
      const GOFF = '(()=>{if(globalThis.__gpL){groundPixel=globalThis.__gpL;globalThis.__gpL=null}})()';
      const CUT = Math.ceil(RISE_TOP);
      let defPx = 0;
      /* One frame of the #163 geometry under one config of the split: the with/without-prop pair
         (the difference IS the prop), the occluder depth that pair leaves behind, and a ground-only
         replay that gives per-pixel PROVENANCE (deferred iff the renderer itself queued it) plus the
         depth the ground pass alone stored. The control band (dq=0, the prop on the camera's own
         flat band) is the config-independence check: nothing queues there, so all three configs must
         agree with the 804-px silhouette `cull` already reports. */
      const frame = (cfg, dq) => {
        const patched = run(`(function(){
          if (!globalThis.__cgO) globalThis.__cgO = castGround;
          const src = globalThis.__cgO.toString(), rep = ${JSON.stringify(REPL(cfg))};
          if (src.indexOf(${JSON.stringify(NEEDLE)}) < 0) return 'NEEDLE-NOT-FOUND';
          castGround = eval('(' + src.split(${JSON.stringify(NEEDLE)}).join(rep) + ')');
          return castGround.toString().indexOf(rep) >= 0 ? 'ok' : 'PATCH-FAILED';
        })()`);
        setBand(BG.cz + dq); run(LAMP);
        run(GRES + ';' + GON + ';MESH.reset();S.t=3.5;renderWorld();' + GOFF);
        const A = new Uint32Array(run('px')), frameDef = run('GD.n');
        run('window.__pq=PROPS.slice();PROPS.length=0;MESH.reset();S.t=3.5;renderWorld();for(const q of __pq)PROPS.push(q);');
        const B = new Uint32Array(run('px')), zo = new Float32Array(run('zbuf'));
        run(GRES + ';' + GON + ';px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));castGround(S.flash,FOGC[0],FOGC[1],FOGC[2]);' + GOFF);
        /* The record of what the deferred pass ANSWERED is built here rather than inside the renderer:
           the wrapper sees the plane each pixel was QUEUED with, and the ground pass's final zbuf at
           that pixel is the distance the deferred body stored (the row fills its own distance first and
           the queue drains after it, so nothing else writes it). Inverting d = dz*BH/|p| gives back the
           plane that answered, so "which plane won" needs no probe-side copy of the renderer's maths and
           no edit to js/ - the one exception is the FARB*4 clamp, which shows up as an implied plane
           outside the grid and is reported as such. */
        const zg = new Float32Array(run('zbuf')), dg = new Uint8Array(run('GD.set')), groundDef = run('GD.n'), tr = new Float64Array(run('GD.a'));
        restore(); run('castGround = globalThis.__cgO;');
        return { patched: patched, A: A, B: B, zo: zo, zg: zg, dg: dg, def: frameDef, defG: groundDef, tr: tr };
      };
      const hit = (r, i) => Math.abs(lum(r.A, i) - lum(r.B, i)) > 4 || (r.A[i] >>> 24) - (r.B[i] >>> 24) !== 0;
      // full-frame mask: total, the CLEAN band (y < CUT, the ceiling rows #163 made honest), rows
      const full = r => {
        let n = 0, clean = 0, top = H, bot = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (hit(r, i)) { n++; if (y < top) top = y; if (y > bot) bot = y; if (y < CUT) clean++; }
        }
        return { n, clean, top, bot };
      };
      // the same PIXEL SET in every config, so a depth range means something across rows
      const over = (r, idx) => {
        let vis = 0, def = 0, row = 0, ovr = 0, mn = Infinity, mx = -Infinity, omn = Infinity, omx = -Infinity;
        for (const i of idx) {
          if (hit(r, i)) vis++;
          if (r.dg[i]) def++; else row++;
          if (r.zo[i] !== r.zg[i]) ovr++;
          if (r.zg[i] < mn) mn = r.zg[i]; if (r.zg[i] > mx) mx = r.zg[i];
          if (r.zo[i] < omn) omn = r.zo[i]; if (r.zo[i] > omx) omx = r.zo[i];
        }
        return { vis, def, row, ovr, mn, mx, omn, omx };
      };
      const lampT = run(`(()=>{const dx=${BG.lx}-camX,dy=${BG.ly}-camY;return (1/(planeX*dirY-dirX*planeY))*(-planeY*dx+planeX*dy)})()`);
      const idxOf = r => { const a = []; for (let y = CUT; y < H; y++) for (let x = 0; x < W; x++) if (hit(r, y * W + x)) a.push(y * W + x); return a; };
      // the reference pixel set is ALWAYS the shipped split's leak pixels, even when CFGS skips ship
      let refIdx = CFGS[0] === 'ship' ? null : idxOf(frame('ship', 4));
      for (const cfg of CFGS) {
        const r = frame(cfg, 4), f = full(r);
        if (cfg === 'ship') defPx = r.defG;
        if (!refIdx) refIdx = idxOf(r);
        const o = frame(cfg, 0), s = over(r, refIdx), own = over(o, refIdx), ownc = full(o);
        /* Across the WHOLE seam band, not just the mask: how many of these pixels did the wall pass
           paint at all? The row's premise is that below RISE_TOP a pixel sits on the seam, where a
           riser face exists - if the wall pass wrote none of them, the ceiling solve is the only
           occluder there and the leak has a second contributor (a riser that draws nothing). */
        let bandN = 0, bandWall = 0;
        for (let y = CUT; y <= 127 && y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x; bandN++; if (r.zo[i] !== r.zg[i]) bandWall++;
        }
        const perRow = [];
        if (process.env.LEAKROW) {
          let last = -1;
          for (const i of refIdx) {
            const y = (i / W) | 0; if (y !== last) { perRow.push(`${y}:`); last = y; }
            perRow.push(r.dg[i] ? 'D' : 'R');
          }
        }
        console.log(`    L${li} ${cfg.padEnd(9)} patch ${r.patched}  groundPixel-calls/frame ${String(r.def).padStart(6)} ` +
          `(ground-only ${r.defG}) | RAISED mask ${f.n} px rows ${f.top}..${f.bot}, CLEAN y<${CUT} ${f.clean} px | ` +
          `on the ship-config leak set (${refIdx.length} px): visible ${s.vis}, row-painted ${s.row}, deferred ${s.def}, ` +
          `wall/mesh overwrote ${s.ovr}, ground z ${s.mn.toFixed(2)}..${s.mx.toFixed(2)}, occluder z ${s.omn.toFixed(2)}..${s.omx.toFixed(2)}` +
          ` | own-band control ${ownc.n} px (visible there ${own.vis}) | seam band y ${CUT}..127: ${bandWall} of ${bandN} px painted by the wall pass | lamp at ${lampT.toFixed(2)} m`);
        if (process.env.LEAKROW) console.log(`      ${refIdx.length} px as R/D in row order  ${perRow.join('')}`);
        /* What groundPixel ANSWERED on exactly those pixels: queued plane -> plane it settled on, the
           distance that produced, whether the loop called it converged, and the same depth if the
           NEARER plane (the one the eye is closer to, so the one the ray reaches first) had answered.
           The QUEUED plane comes from the wrapper, the plane that ANSWERED is inverted out of the
           distance the deferred body stored (d = dz*BH/|p|, so z = eyeZ -+ d*|p|/BH): the row's own plane
           is not in that argument list at all, which is the finding. The same depth is then quoted for
           the NEARER of the two planes, the one the eye is closer to and so the ray reaches first. */
        if (cfg === 'ship') {
          const EYE = run('eyeZ'), BHV = run('BH'), HZ = Math.round(run('horizon')), FB = run('FARB') * 4;
          const want = new Set(refIdx), hist = new Map();
          let seen = 0, samePl = 0, moved = 0, nearHides = 0, dNearMin = Infinity, dNearMax = -Infinity;
          for (let k = 0; k < r.tr.length; k += 2) {
            const i = r.tr[k]; if (!want.has(i)) continue;
            seen++; const pl0 = r.tr[k + 1], dS = r.zg[i];
            const y = (i / W) | 0, p = y - HZ, isF = p > 0, absP = p > 0 ? p : -p;
            const plF = isF ? EYE - dS * absP / BHV : EYE + dS * absP / BHV;      // the plane that answered
            if (Math.abs(plF - pl0) <= ZQS) samePl++; else moved++;
            const plN = Math.abs(plF - EYE) <= Math.abs(pl0 - EYE) ? plF : pl0;      // nearer to the eye = hit first
            let dN = (isF ? EYE - plN : plN - EYE) * BHV / absP; if (dN > FB) dN = FB;
            if (dN < lampT) nearHides++;
            if (dN < dNearMin) dNearMin = dN; if (dN > dNearMax) dNearMax = dN;
            const key = `${pl0.toFixed(2)}->${plF.toFixed(2)} ${Math.abs(plF - pl0) <= ZQS ? 'answered-as-queued' : 'MOVED'} d ${dS.toFixed(2)}`;
            hist.set(key, (hist.get(key) || 0) + 1);
          }
          const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([k, v]) => `${k} x${v}`).join(', ');
          console.log(`      trace of the leak set: ${seen}/${refIdx.length} px traced (deferred px ${r.defG}), ` +
            `answered-as-queued ${samePl}, moved ${moved}, plane answers ${top || 'NONE'} | ` +
            `nearer-plane depth ${isFinite(dNearMin) ? dNearMin.toFixed(2) + '..' + dNearMax.toFixed(2) : '-'}, ` +
            `which hides the lamp on ${nearHides} of ${seen}`);
        }
      }
      /* An empty mask is a RESULT about the geometry, not a passing row: 0 leak px means #170 is fixed
         here, and every number above was computed over the empty set. Say which, and name the row that
         is still capable of failing on this build (AGENTS: a probe that cannot fail is worthless). */
      if (!refIdx.length) console.log(`    L${li} LEAK-VACUUM: the ship-config leak set is 0 px, so the ` +
        `attribution above has no pixels to attribute - the #170 geometry does not leak on this build. ` +
        `The deferred path is still live (${defPx} groundPixel calls/frame); CZBAND=1 is the row that ` +
        `can still fail on this build (#177)`);
      /* A rule that makes the leak vanish can still be wrong, and `heights` cannot see this one: a
         CEILING step (a tall room beyond a low one, floors FLAT, so the ray goes through the doorway
         and up to a farther ceiling) is the mirror of the leak geometry, and no config in the repo has
         a near ceiling and a farther ceiling in the same frame - `tallRoom` raises every cell, so
         planeA and the neighbour agree and nothing queues. This hashes the ground pass's own framebuffer
         for that frame, so two builds can be compared on it. CZBAND=1, and the value is meaningless on
         its own - only its agreement or disagreement across two trees means anything. */
      /* The values the ground pass answers on this geometry - the two-sided form of printing them (#177).
         A wrong ceiling rule that passes every shipped gate MOVES these, which is the whole reason the row
         exists; a deliberate change to the ceiling answer updates all three together with the row that
         justifies it, and nothing else. Moved by fix/far-band-light-197 (#197) off 5f14a09, where they
         were 0x14c12844 / 0x8ab438b0 / 0x5a425d84: the far band now reads the cell its own row solves
         into, so a frame whose horizon band lands in a different cell than the camera's paints differently
         - measured with LEAK=1 CZBAND=1 in this tree, and the three together with nothing else. Moved
         again by fix/203-lamp-band-weight (#203) off 9656176, where they were 0x2711a2a8 / 0x10157366 /
         0xeaee1fd8: a lamp's splat no longer reaches columns more than one quantum past its hover, so a
         ceiling-step frame whose ground lands under a wrong-band lamp now paints darker there. Note that
         L2 did NOT move - that is the control that this is the band weight and not a global brightness
         shift, and it is the same asymmetry the exposure numbers showed (74 / 66 / 71 against 77 / 70 /
         71). Measured with LEAK=1 CZBAND=1 in this tree, and reproduced byte-for-byte by CI on the same
         commit, which is what makes re-recording them honest rather than convenient. Moved a third time
         by fix/band-bleed-close (#208) off 2c5a94f, where they were 0x4bd739d4 / 0xcfc1fdac / 0xeaee1fd8:
         the band term in the splat kernel now references the SOURCE's floor rather than its emitter
         height, and a band the lamp budget never reached gets a lamp of its own. All three moved, and
         the px-difference counts held at 51048 / 49614 / 49586 against main's 51047 / 49620 / 49586 -
         the ground pass changed because the LIGHT under it did, not because the geometry did, which is
         the claim the four-quadrant control makes (variant js + these refs ok, main js + these refs
         FAIL x3, main js + the old refs ok, variant js + the old refs FAIL x3). Note that the kernel
         term ALONE measures 0x765abed0 / 0x020678dc / 0x2621e6d1: these three are the kernel plus the
         coverage lamps, and the two sets are not interchangeable. Moved a fourth time by
         level/206-blurband (#206) off df919c3, where they were 0x9c03d4f4 / 0xeec7be60 / 0x7dd66c40:
         blurLight now applies the splat kernel's own band gate, so no cross-slab tail lights the
         ground beside a band boundary any more. L2 held - the same "band weight, not global
         brightness" control #203 noted - and the px-difference counts held at 51048 / 49614 / 49586,
         so the ground pass changed because the LIGHT under it did and not because the geometry did. */
      const CZBAND_REF = refRecord('cull', 'CZBAND', 'crc32', [0x8f763884, 0x77511300, 0x7dd66c40]);   // LEAK=1 CZBAND=1, cull's own step rows
      /* #223: the WORLD sense, recorded beside the lane sense, because czS.h above is a lightmap
         instrument only ON ONE CAMERA'S FRAME: it moves when the lightmap changed somewhere that frame
         rasterizes and holds when it changed somewhere it cannot, so its green never proves "the
         lightmap is unchanged". This sense is the same question asked of every cell the generator lit.
         MEASURED on this tree (LEAK=1 CZBAND=1 cull, one run per arm; lane = czS.h above, world = the
         digest recorded below; the number is the level's lightmap sum):
           arm    change                                 L0                 L1                 L2
           main   -                                      = / =   300.47     = / =   392.00     = / =   773.20
           x0.999 every static source x 0.999            MOVE / MOVE      MOVE / MOVE      MOVE / MOVE
           x0.80  every static source x 0.80             MOVE / MOVE      MOVE / MOVE      MOVE / MOVE
           ONE0.1 ONE top-up lamp at 0.1 str             HOLD / MOVE 276  MOVE / MOVE 360  MOVE / MOVE 713
           T64    TOPUP_TARGET 32 -> 64 (one lamp's tsc) HOLD / MOVE 296  MOVE / MOVE 360  HOLD / HOLD 773
           T128   TOPUP_TARGET 32 -> 128                MOVE / MOVE 263  MOVE / MOVE 360  MOVE / MOVE 755
           LAMP   MAX_ADD 3 -> 1 (fewer top-up lamps)   MOVE / MOVE 217  MOVE / MOVE 294  MOVE / MOVE 664
           WV1    #252's blurLight band gate DELETED    MOVE / MOVE      MOVE / MOVE      HOLD / MOVE
         The issue's claim needs narrowing in both directions and the table says which way. It is too
         STRONG for a global intensity change - the lane hash moves on 3 of 3 levels at x 0.999, so
         nothing off-lane is hiding there - and too WEAK for the localised class: one top-up lamp at
         0.1 str takes 24.14 of L0's 300.47 (-8.0% of the level's delivered light) with L0's lane hash
         BYTE-IDENTICAL, and TARGET=64 moves L0's lightmap by 4.19 with the same identical lane hash.
         So the floor between the two readings is not a threshold (the world sense is bit-exact) but a
         measured miss: the largest delta the lane lets through is 24.14 of 300.47 on L0 against the
         0.30 of 300.47 (x 0.999) at which it does move - WHICH source changed decides it, not how
         small the change is. #252 is the regression this row exists for: deleting blurLight's band
         gate returns L0/L1's lane hashes to the pre-#252 literals (0x9c03d4f4 / 0xeec7be60) while L2's
         stays 0x7dd66c40, byte-identical, so on the third level the old verdict could not have seen it.
         Both senses stay because they read different things: the lane hash rasterizes the LIVE lightmap
         on the cells one camera reaches, the world digest reads the GENERATED lightmap on every cell.
         The printed drift (MAP.light now vs the snapshot taken straight after startLevel) is 0 on all
         three levels, so on this path they are the same array; a nonzero drift would mean a row had
         splatted a transient into the frame and the pair had stopped being comparable. */
      const CZLIGHT_REF = refRecord('cull', 'CZBAND-LIGHT', 'crc32', [0xb0988514, 0xb54c0a14, 0xcb62daf2]);
      if (process.env.CZBAND) {
        czRows++;
        run(`(function(){ window.__cz0b = MAP.cz.slice(); ${JSON.stringify(BG.cells)}
          .forEach(([x, y]) => { MAP.cz[(y | 0) * MW + (x | 0)] += 4; }); linkBoundaries(); return 1; })()`);
        /* The same frame under a config of the split. The shipped config's hash is the value to diff
           across builds; the nodefer one is the control that says the frame is worth hashing at all:
           if forcing every pixel through the ROW body leaves the hash alone, this geometry queues
           nothing and the number has stopped being an instrument of the seam. */
        const czFrame = cfg => {
          const p = run(`(function(){
            if (!globalThis.__cgO) globalThis.__cgO = castGround;
            const src = globalThis.__cgO.toString(), rep = ${JSON.stringify(REPL(cfg))};
            if (src.indexOf(${JSON.stringify(NEEDLE)}) < 0) return 'NEEDLE-NOT-FOUND';
            castGround = eval('(' + src.split(${JSON.stringify(NEEDLE)}).join(rep) + ')');
            return castGround.toString().indexOf(rep) >= 0 ? 'ok' : 'PATCH-FAILED';
          })()`);
          setBand(BG.cz); run('PROPS.length = 0; ENEMIES.length = 0; MESH.reset(); S.t = 3.5; renderWorld();');
          const flatG = new Uint32Array(run('px'));
          run(GRES + ';px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));castGround(S.flash,FOGC[0],FOGC[1],FOGC[2]);');
          const g = new Uint32Array(run('px'));
          let h = 0x811c9dc5, dfl = 0;
          for (let i = 0; i < g.length; i++) { h = (h ^ g[i]) * 16777619 >>> 0; if (g[i] !== flatG[i]) dfl++; }
          run('castGround = globalThis.__cgO;');
          return { p, h, dfl };
        };
        const czS = czFrame('ship'), czN = czFrame('nodefer');
        /* The world sense: the generated lightmap of this level, hashed whole. No render, no poke -
           a typed-array read, so it cannot warm the pose cache or move a lock (#243's cliff). */
        const lw = new Float32Array(run('window.__lwGen'));
        const lwb = new Uint8Array(lw.buffer), lwn = new Float32Array(run('MAP.light'));
        let lwH = 0x811c9dc5, lwSum = 0, lwMax = 0, lwDrift = 0;
        for (let i = 0; i < lwb.length; i++) lwH = (lwH ^ lwb[i]) * 16777619 >>> 0;
        for (let i = 0; i < lw.length; i++) {
          const v = lw[i]; lwSum += v; if (v > lwMax) lwMax = v;
          const d = v - lwn[i]; lwDrift = Math.abs(d) > lwDrift ? Math.abs(d) : lwDrift;
        }
        /* How much of the level's lighting this one frame could even see: a DISTANCE test against the
           renderer's own far term at the sampled camera, not an occlusion test, so it over-counts.
           Printed so a lane-sense green reads as the placement statement it is (#223 ask 1). */
        const lampN = run(`LIGHTS.filter(L => L.stat === 1).length`);
        const lampF = run(`(function(){ const C = ${BG.lx - 4}, D = ${BG.ly}; let n = 0;
          for (const L of LIGHTS) if (L.stat === 1 && Math.hypot(L.x - C, L.y - D) < ${FARBV}) n++; return n; })()`);
        const cpFar = run(`MAP.ceilPlane[${Math.floor(setup.lane.y)} * MW + ${Math.floor(setup.lane.x) + 4}]`);
        const hex = v => '0x' + v.toString(16).padStart(8, '0');
        row(`L${li} the ceiling-step frame exercises the deferred pass`, czS.p === 'ok' && czN.h !== czS.h,
          `ceilings ${CAMCP.toFixed(2)} -> ${cpFar.toFixed(2)} four cells out, floors flat: ground-pass hash ` +
          `${hex(czS.h)} (${czS.dfl} px differ from the composited frame) | nodefer control ${czN.p} ` +
          `${hex(czN.h)} - the two agree only if this geometry queues nothing, which would make the hash ` +
          `worthless rather than clean (#177)`);
        const laneOk = czS.h === CZBAND_REF[li], worldOk = lwH === CZLIGHT_REF[li];
        row(`L${li} the ceiling-step ground hash AND the lightmap under it are the recorded ones`,
          laneOk && worldOk,
          `LANE ${hex(czS.h)} vs recorded ${hex(CZBAND_REF[li])} (${czS.dfl} px of the ground pass differ ` +
          `from the composited frame; ${lampF} of ${lampN} static lamps within ${FARBV.toFixed(0)} m of this ` +
          `camera - a DISTANCE test, not an occlusion test) | WORLD ${hex(lwH)} vs recorded ` +
          `${hex(CZLIGHT_REF[li])} (sum ${lwSum.toFixed(2)} over ${lw.length} cells, max ${lwMax.toFixed(3)}, ` +
          `drift from now ${lwDrift ? lwDrift.toExponential(1) : '0'}) | ` +
          (laneOk && worldOk ? 'both senses at the record' : !laneOk && worldOk
            ? 'GEOMETRY or RENDER changed, the GENERATED lightmap did NOT - the class #177\'s wrong fix '
              + '(adopt the nearer ceiling plane) lands in' : laneOk
            ? 'THE GENERATED LIGHTMAP CHANGED AND THIS LANE DOES NOT SHOW IT - the frame hash alone reads '
              + 'GREEN here (#223): the changed source is off this camera\'s lane' :
            'both senses moved - a light change this lane also rasterizes, or a grid change on top of it') +
          `. Green means the WHOLE level's generated lightmap is the recorded one, not that a light change ` +
          `was invisible: the lane hash alone holds byte-identical when a source off the lane moves ` +
          `(measured: one top-up lamp at 0.1 str, -8.0% of L0's lightmap, leaves L0's lane hash unchanged, ` +
          `and #252's band-gate removal leaves L2's unchanged), while a GLOBAL source scale moves it on 3 of 3.`);
        restore(); run('MAP.cz.set(__cz0b); linkBoundaries();');
      }
    }
  }
  if (process.env.CZBAND) row('CZBAND emitted a hash for every level', czRows === 3,
    `${czRows} of 3 levels printed a ceiling-step hash - an absent row reads as silence, not as a pass (#177)`);


  /* ---- #192: what DEPTH the far surface of a generated lip carries -------------------
     cull's other rows ask where a BODY is drawn. These ask what the renderer's own zbuf
     holds for the SURFACE on the far side of a step, on content the GENERATOR authored: not
     one byte of MAP.fz or MAP.cz is written in this block, so no row can be satisfied by
     geometry the probe drew for itself - the trap AGENTS.md records for every vertical row
     ever written here, and the reason `find` below is the first thing each row runs.

     Three cases per level, each found by scanning the grid the generator wrote:
       pit     a boundary from the datum DOWN to a band below it (`find` case 'pit'),
       stair   a maximal run of >=3 cells rising exactly one quantum per cell, every crossing
               walkable - derived the way `alt` derives it (view.js:303-318), not FEAT_STAIR,
               which is a minimap byte (#case: `find` 'stair'),
       deck    a boundary from the datum UP to a band above it (`find` case 'deck').
     Each candidate is preferred at |dq| == 1 - the step #192 is about, the one the wall pass
     used to leave unrecorded in zbuf - and ties go to the widest far band, because a lip that
     opens onto one cell has almost no far surface to sample. When a level has no 1-quantum
     instance of a case the row runs on the shallowest one it does have and says so: it then
     gates geometry main draws too, which makes it a guard row, not a #192 row.

     The expectation is computed from GEOMETRY, in the two forms the renderer itself writes
     (this is CEILING-DEPTH in `heights` - assert the row's own solve, never "not Infinity"):
       a FACE answers at its perpendicular parameter distance. js/40_render.js:825 stores
         `zbuf[idx] = perp` for EVERY row of the face's projected span and the DDA stops at the
         first face it emits, so the honest answer is the nearest EMITTING crossing whose span
         covers the row - not the nearest surface along the ray, which is a different question
         and the one a naive march gets wrong at a pit lip, where the riser paints over ground
         that is centimetres nearer.
       a PLANE answers at |plane - eyeZ| * BH / |p| for that pixel's own p, and only while the
         cell that owns the plane reaches the hit point: a plane solved past its own cell is the
         phantom floor M2 exists to stop.

     The camera sits FARBACK cells behind the boundary on the datum, because at 1 m a
     one-quantum lip projects off-screen and the row structurally cannot fail - cull's own #163
     row puts its riser three cells out for that reason (view.js:1354-1360) and `bands` poses
     its walk lip at 3.5 m. Rows whose far-band fast path fires (|plane-eyeZ|*BH/p > FARB: the
     row is FILLED with one number and no pixel is solved) and pixels whose honest answer sits
     past FARMAX are refused and counted, not guessed at, and the two rows at either end of a
     face's span are refused too - there the pass rounds and the march does not.  */
  const FARBACK = +(process.env.FARBACK || 3), FARTOL = +(process.env.FARTOL || 0.05);
  const FARMIN = +(process.env.FARMIN || 240), FARMAX = +(process.env.FARD || 22);
  const FARDBG = !!process.env.DBG;

  /* One march over the grid that answers every floor-half row of a column at once. It reads the
     grid, the camera and the renderer's own zbuf, and no other part of the renderer, so a pass
     that stopped RECORDING a face shows up here as a wrong distance rather than as an absence -
     which is the only way a row can catch the bug #192 is about. */
  const lipRows = (li, want) => {
    seedRng((SEED ^ (li * 2654435761)) >>> 0);
    return run(`(function () {
      S.mode = 'play'; S.locked = false; startLevel(${li}, true);
      exitX = -40; exitY = -40;                                       // no portal in the frame
      const N = MAP.w, cell = MAP.cell, fz = MAP.fz, cp = MAP.ceilPlane, vb = MAP.vb;
      const want = ${JSON.stringify(want)}, BACK = ${FARBACK}, MAXD = ${FARMAX}, TOL = ${FARTOL};

      // ---- FIND the generated feature. This block never writes MAP.fz or MAP.cz, so the cells a
      // row poses against come out of these two scans and nothing else: the boundary loop below is
      // the line that finds a pit lip and a raised deck, the run loop is the line that finds a
      // staircase. A level with no such feature returns skip= and the row FAILS as VACUOUS.
      const patch = i => {                        // how wide the far band this boundary opens onto is
        const q = fz[i], seen = new Uint8Array(cell.length), st = [i]; seen[i] = 1;
        for (let k = 0; k < st.length; k++) {
          const c = st[k], cx = c % N, cy = (c / N) | 0;
          for (let d = 0; d < 4; d++) {
            const j = (cy + DIRY[d]) * N + cx + DIRX[d];
            if (j < 0 || j >= cell.length || cell[j] || seen[j] || fz[j] !== q) continue;
            seen[j] = 1; st.push(j);
          }
        }
        return st.length;
      };
      const back = (x, y, d, q) => {              // BACK open cells at one floor, straight behind
        for (let k = 0; k <= BACK; k++) {
          const cx = x - DIRX[d] * k, cy = y - DIRY[d] * k;
          if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) return false;
          const i = cy * N + cx;
          if (cell[i] || fz[i] !== q) return false;
        }
        return true;
      };
      const pool = [];
      if (want !== 'stair')
        for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
          const i = y * N + x; if (cell[i] || fz[i]) continue;         // the datum, or not a candidate
          for (let d = 0; d < 4; d++) {
            const nx = x + DIRX[d], ny = y + DIRY[d];
            if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
            const j = ny * N + nx; if (cell[j]) continue;
            const dq = fz[j] - fz[i]; if (!dq) continue;
            if ((vb[i] >> (d << 2)) & (VB_RAMP | VB_LADDER)) continue;   // a climb link draws no lip
            const kind = fz[j] < 0 ? 'pit' : fz[j] > 0 ? 'deck' : null;  // below / above the datum
            if (kind !== want || !back(x, y, d, 0)) continue;
            pool.push({ x, y, nx, ny, d, dq, len: 1, wide: patch(j) });
          }
        }
      if (want === 'stair')
        // a maximal run of >=3 cells rising exactly one quantum per cell with every crossing
        // walkable, derived the way alt derives it (view.js:303-318) because FEAT_STAIR is a
        // minimap byte and a byte is not geometry. The row reads the run's FIRST riser.
        for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
          const i = y * N + x; if (cell[i] || fz[i]) continue;
          for (let d = 0; d < 4; d++) {
            const qx = x - DIRX[d], qy = y - DIRY[d];
            if (qx >= 0 && qy >= 0 && qx < N && qy < N && !cell[qy * N + qx] &&
              fz[qy * N + qx] === fz[i] - 1) continue;                 // not maximal at the low end
            let len = 1, kx = x, ky = y, walk = true;
            for (;;) {
              const ax = kx + DIRX[d], ay = ky + DIRY[d];
              if (ax < 0 || ay < 0 || ax >= N || ay >= N) break;
              const a = ay * N + ax;
              if (cell[a] || fz[a] !== fz[ky * N + kx] + 1) break;
              if ((vb[ky * N + kx] >> (d << 2)) & VB_BLOCK) { walk = false; break; }
              len++; kx = ax; ky = ay;
            }
            if (len >= 3 && walk && back(x, y, d, 0))
              pool.push({ x, y, nx: x + DIRX[d], ny: y + DIRY[d], d, dq: 1, len, wide: len });
          }
        }
      // smallest height difference first, because the one-quantum step is the case #192 is about;
      // then the widest far band, then cell order - deterministic, and it draws no random numbers
      pool.sort((a, b) => (Math.abs(a.dq) - Math.abs(b.dq)) || (b.wide - a.wide) ||
        (a.y * N + a.x) - (b.y * N + b.x));
      const T = pool[0];
      if (!T) return { notFound: 'no generated ' + want + ' with ' + BACK + ' flat datum cells behind it', pool: pool.length };

      // ---- pose the camera BACK cells back on the datum, square on to the boundary
      const CX = T.x - DIRX[T.d] * BACK + 0.5, CY = T.y - DIRY[T.d] * BACK + 0.5;
      ENEMIES.length = 0; PROPS.length = 0; PROJ.length = 0; PARTS.length = 0;
      P.x = CX; P.y = CY; P.ang = Math.atan2(DIRY[T.d], DIRX[T.d]); P.pitch = 0; P.crouch = 0;
      P.vx = 0; P.vy = 0; P.vz = 0; P.air = false; P.bob = 0; P.kick = 0;
      P.z = floorAt(P.x, P.y);
      S.t = 3.5; renderWorld();
      const FARQ = fz[T.ny * N + T.nx];
      const R = { BW, BH, hz: Math.round(horizon), eyeZ, FARB, risers: MAP.riserStops, steps: MAP.steps,
        cam: [CX, CY], cell: [T.x, T.y], far: [T.nx, T.ny], dir: T.d, dq: T.dq, len: T.len, wide: T.wide,
        near: fz[T.y * N + T.x] * ZQ, farZ: FARQ * ZQ, pool: pool.length,
        face: [0, 0, 0], slab: [0, 0, 0], plane: [0, 0, 0], skip: {}, cols: 0, rows: 0, rowFar: 0,
        worst: 0, ex: [], exKind: '' };
      const rowBand = (eyeZ - floorAt(P.x, P.y)) * BH;      // the row's own solve, before the p divide
      const pFar = Math.floor(rowBand / FARB) + 1;          // at or under this p the row is FILLED, not solved
      const seenRow = new Uint8Array(BH);
      for (let x = 1; x < BW - 1; x++) {
        const cf = x * (2 / BW) - 1, rx = dirX + planeX * cf, ry = dirY + planeY * cf;
        const ax = Math.abs(rx), ay = Math.abs(ry), sx = rx > 0 ? 1 : -1, sy = ry > 0 ? 1 : -1;
        let cx = camX | 0, cy = camY | 0, stop = 0;
        let tx = ax > 0 ? (rx > 0 ? cx + 1 - camX : camX - cx) / ax : 1e30;
        let ty = ay > 0 ? (ry > 0 ? cy + 1 - camY : camY - cy) / ay : 1e30;
        const cells = [], cross = [];
        let face = null;
        for (let g = 0; g < 24; g++) {
          const tOut = tx < ty ? tx : ty, i = cy * N + cx;
          const air = cx >= 0 && cy >= 0 && cx < N && cy < N && !cell[i];
          cells.push({ tIn: g ? cross[g - 1].t : 0, tOut, air, fz: air ? fz[i] : 0 });
          if (!air) { stop = 1; break; }                              // a column and the void stop the march
          if (!(tOut < MAXD)) { stop = 2; break; }
          const gX = tx < ty, nx = cx + (gX ? sx : 0), ny = cy + (gX ? 0 : sy);
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) { stop = 3; break; }
          const j = ny * N + nx, dd = gX ? (sx > 0 ? 0 : 2) : (sy > 0 ? 1 : 3);
          const dq = fz[j] - fz[i], solid = !!cell[j];
          let emit = 0, z0 = 0, z1 = 0;
          if (solid) { z0 = Math.max(fz[i], fz[j]) * ZQ; z1 = cp[i]; emit = 1; }
          else if (dq && !((vb[i] >> (dd << 2)) & (VB_RAMP | VB_LADDER))) {
            emit = 1; z0 = Math.min(fz[i], fz[j]) * ZQ; z1 = Math.max(fz[i], fz[j]) * ZQ;
          }
          const rec = { t: tOut, solid, emit, z0, z1, farZ: fz[j] * ZQ,
            tgt: cx === T.x && cy === T.y && nx === T.nx && ny === T.ny };
          if (emit && !face) face = rec;
          cross.push(rec);
          cx = nx; cy = ny;
          if (gX) tx += 1 / ax; else ty += 1 / ay;
        }
        for (let y = R.hz + pFar; y < BH; y++) {
          const p = y - horizon;
          if (!(p > pFar - 1)) continue;
          let got = 0, kind = '';
          if (face) {                                   // the wall pass paints over whatever was there
            const y0 = Math.ceil(horizon + (eyeZ - face.z1) * BH / face.t);
            const y1 = Math.floor(horizon + (eyeZ - face.z0) * BH / face.t);
            if (y > y0 && y < y1) { got = face.t; kind = face.tgt ? 'face' : 'otherFace'; }
            else if (face.solid) { R.skip.overWall = (R.skip.overWall || 0) + 1; continue; }
            else if (eyeZ - p * face.t / BH >= face.z1) { /* the ray clears the step: march on */ }
            else { const k = face.tgt ? 'lipEdge' : 'otherLip'; R.skip[k] = (R.skip[k] || 0) + 1; continue; }
          }
          if (!got) for (let k = 0; k < cells.length; k++) {           // a PLANE, in marching order
            const c = cells[k], pl = c.fz * ZQ;
            if (!c.air) { R.skip.wallStop = (R.skip.wallStop || 0) + 1; break; }
            if (pl >= eyeZ - 1e-9) {                                   // no floor solve exists for it: the
              const cr = cross[k - 1];                                 // crossing under its slab answers
              if (cr) { got = cr.t; kind = cr.tgt ? 'slab' : 'otherSlab'; }
              break;
            }
            const tF = (eyeZ - pl) * BH / p;
            if (tF <= c.tIn + 0.05) continue;                          // the plane is behind us
            if (tF <= c.tOut - 0.05) { got = tF; kind = c.fz === FARQ ? 'plane' : 'otherPlane'; break; }
            const cr = cross[k];                                       // it runs past this cell, so the
            if (cr && cr.farZ >= eyeZ - 1e-9) { got = cr.t; kind = cr.tgt ? 'slab' : 'otherSlab'; break; }
            if (cr && (cr.solid || cr.emit)) {                         // side, or a face that will paint
              R.skip[cr.solid ? 'wallStop' : 'emitStop'] = (R.skip[cr.solid ? 'wallStop' : 'emitStop'] || 0) + 1;
              break;
            }
          }
          if (kind !== 'face' && kind !== 'plane' && kind !== 'slab') {
            R.skip.ground = (R.skip.ground || 0) + 1; continue;
          }
          const b = kind === 'face' ? R.face : kind === 'plane' ? R.plane : R.slab;
          b[0]++; seenRow[y] = 1;
          const dz = zbuf[y * BW + x] - got;
          if (Math.abs(dz) > TOL) {
            b[1]++; if (dz > 0) b[2]++;
            if (Math.abs(dz) > Math.abs(R.worst)) { R.worst = dz; R.ex = [x, y, +p.toFixed(0), zbuf[y * BW + x], got]; R.exKind = kind; }
          }
        }
        R.cols++;
      }
      for (let y = 0; y < BH; y++) if (seenRow[y]) R.rows++;
      R.rowFar = pFar - 1;
      return R;
    })()`);
  };

  for (let li = 0; li < run('LEVELS.length'); li++) {
    for (const want of ['pit', 'stair', 'deck']) {
      const R = lipRows(li, want);
      if (R.notFound) {
        row(`L${li} ${want} lip: zbuf holds the far surface`, false,
          `VACUOUS - ${R.notFound} (the scan found nothing to pose against, so this level gives the row no` +
          ` way to fail: ${R.pool || 0} candidate(s) of any size, none with a straight datum approach)`);
        continue;
      }
      const px = R.face[0] + R.plane[0] + R.slab[0], bad = R.face[1] + R.plane[1] + R.slab[1];
      const far = R.face[2] + R.plane[2] + R.slab[2];
      const skipl = Object.keys(R.skip).length ? Object.keys(R.skip).map(k => `${k} ${R.skip[k]}`).join(', ') : 'nothing';
      row(`L${li} ${want} lip: zbuf holds the far surface`, px >= FARMIN && R.rows > 0 && bad === 0,
        `camera (${R.cam[0].toFixed(1)},${R.cam[1].toFixed(1)}) on ${R.near.toFixed(2)} at cell (${R.cell}) dir ${R.dir}` +
        ` -> band ${R.farZ.toFixed(2)} (${R.dq > 0 ? '+' : ''}${R.dq} q, ${R.len} tread(s), ${R.wide} cell(s) of it -` +
        ` ${Math.abs(R.dq) === 1 ? '1 quantum: the step #192 leaves unrecorded on main' : `|dq|=${Math.abs(R.dq)}, which main draws too - a GUARD row here`})` +
        `: ${px} px on ${R.rows} rows compared, ${bad} disagree (${R.face[1] + R.slab[1]} at a face, ${R.plane[1]} at a plane,` +
        ` ${far} of them FARTHER than honest), ${R.cols} columns, ${R.rowFar} far-band rows excluded;` +
        ` face ${R.face[0]} px/${R.face[1]} bad, slab ${R.slab[0]}/${R.slab[1]}, plane ${R.plane[0]}/${R.plane[1]};` +
        ` refused: ${skipl}; riserStops ${R.risers}, MAP.steps ${R.steps}, horizon ${R.hz}, eyeZ ${R.eyeZ.toFixed(2)}` +
        (R.ex.length ? `; worst ${R.worst.toFixed(2)} at x${R.ex[0]} row ${R.ex[1]} p=${R.ex[2]}: zbuf ${R.ex[3].toFixed(2)}` +
          ` vs honest ${R.ex[4].toFixed(2)} (${R.exKind})` : ''));
      if (FARDBG) console.log(`    dbg L${li} ${want}: ${JSON.stringify(R)}`);
    }
  }

  /* ---- #212: what a pit lip 1.5 m out is allowed to own -----------------------------------
     The capture that filed #212 read 93.8 % of the pixels ABOVE the horizon as wall texture at a
     camera 1.5 m from a pit lip, `zbuf` recording a face at 0.14-0.21 m there while every ray found
     open ground. Attributed on the merged build at that recipe (dealt dice 1000, the page's own
     678x359 raster, `MAP.riserStops` 678 of 678 agreeing with the page at 1.5 m and 675 of 678 at
     3.5 m), the WALL pass emits the lip's slab side at perp 1.50 with span [-1.00, 0.00] and paints
     rows 300..359 of 359 - nothing above the horizon at any of the four swept distances, where the
     wall oracle reads 0.0 / 0.0 / 0.1 / 3.2 % at 1.5 / 2.5 / 3.5 / 7.5 m, the OPPOSITE trend to the
     report. So neither hypothesis in the issue survives: the riser's span and row clip are right
     (it paints its own projected band and no row above it), and the boundary is not drawn-without-
     blocking either - it emits in every column and the DDA stops at it, with `VB_BLOCK` on the DOWN
     side's opposite nibble so climbing back up is refused and stepping down is not, which is what
     makes a pit a pit and is exactly why the solid-only `DEV.ray` answers "open ground": it cannot
     see an air->air riser at all, and never could.
     What owns those pixels is a PROP. The generator drops crates and barrels at cell CENTRES
     (js/20_level.js:983 - `c[0]+0.5`), `tryMove` (js/30_entities.js) gives props no collision what-
     soever, and the capture's camera (20.5, 15.5) sat on the centre of a cell that holds a barrel:
     distance 0.00 m, its mesh magnified out to the rasterizer's 0.12 m near plane, filling the
     frame with drum-red and writing `zbuf` 0.142 through the mesh's self-occlusion store
     (js/13_mesh.js:764) where the geography's own ceiling solve reads 0.997. A bright frame that is
     a wall, from inside a prop. The invariant that broke is therefore neither "blocking => drawn"
     nor a riser span: it is that NOTHING may paint the frame from inside the camera.
     So this row POKES both halves - a band 4 quanta down one cell beyond the lip, and one barrel
     prop at the camera's own position - so no roll and no dealt layout can satisfy it or empty it.
     The dealt level's own pit-cell and prop counts are printed beside it to say which of the two
     numbers came from the generator (none) and which was authored by the row (both).
     The config that exercises the assertion is the 1.5 m one: at 2.5 and 3.5 m the prop is still at
     the eye (the cull is by footprint, not by the lip's distance) and the lip subtends less, so
     those rows are the guard against the fix spreading - a crate 3 m out must still occlude. */
  const lipCover = (li, dist) => run(`(function () {
    const DIST = ${dist};
    S.mode = 'play'; S.locked = false; startLevel(${li}, true);
    exitX = -40; exitY = -40;                                  // no portal in the frame
    const N = MAP.w, cell = MAP.cell, fz = MAP.fz, cp = MAP.ceilPlane, vb = MAP.vb;
    let dealtPit = 0;
    for (let i = 0; i < cell.length; i++) if (!cell[i] && fz[i] <= -2) dealtPit++;
    const dealtProps = PROPS.length;
    let lip = null;
    outer:
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) for (let d = 0; d < 4; d++) {
      let ok = true;
      for (let k = -5; k <= 3; k++) {
        const cx = x + DIRX[d] * k, cy = y + DIRY[d] * k, i = cy * N + cx;
        if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1 || cell[i] || fz[i]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let k = 1; k <= 3; k++) fz[(y + DIRY[d] * k) * N + x + DIRX[d] * k] -= 4;   // a 1 m pit
      linkBoundaries();
      lip = { x, y, d };
      break outer;
    }
    if (!lip) return { fail: 'no straight 6-cell datum lane in this level to poke a lip into' };
    const d = lip.d, bx = lip.x + (DIRX[d] > 0 ? 1 : DIRX[d] < 0 ? 0 : 0.5), by = lip.y + (DIRY[d] > 0 ? 1 : DIRY[d] < 0 ? 0 : 0.5);
    ENEMIES.length = 0; PROJ.length = 0; PARTS.length = 0; PICKUPS.length = 0; PROPS.length = 0;
    P.x = bx - DIRX[d] * DIST; P.y = by - DIRY[d] * DIST;
    P.ang = Math.atan2(DIRY[d], DIRX[d]); P.pitch = 0; P.crouch = 0;
    P.vx = 0; P.vy = 0; P.vz = 0; P.air = false; P.bob = 0; P.kick = 0; P.z = floorAt(P.x, P.y);
    S.t = 3.5;
    // the capture's case, authored rather than dealt: a barrel prop AT THE CAMERA
    PROPS.push({ tex: PROP.barrel, x: P.x, y: P.y, scale: 0.86, z: floorAt(P.x, P.y), kind: 'barrel', hp: 26, dead: false });
    const near = lip.y * N + lip.x, far = (lip.y + DIRY[d]) * N + lip.x + DIRX[d];
    renderWorld();
    const hInt = Math.round(horizon), comp = new Uint32Array(px), cz = new Float32Array(zbuf);
    const keep = PROPS.slice(); PROPS.length = 0;
    renderWorld();
    const bare = new Uint32Array(px); PROPS.length = 0; for (const p of keep) PROPS.push(p);
    px.fill(0xFF000000 | FOGC[2] << 16 | FOGC[1] << 8 | FOGC[0]); zbuf.fill(Infinity);
    castGround(S.flash, FOGC[0], FOGC[1], FOGC[2]);
    const gz = new Float32Array(zbuf);
    px.fill(0xFF000000 | FOGC[2] << 16 | FOGC[1] << 8 | FOGC[0]); zbuf.fill(Infinity);
    castWalls(S.flash, FOGC[0], FOGC[1], FOGC[2]);
    const wz = new Float32Array(zbuf);
    let above = 0, wall = 0, prop = 0, minC = Infinity, minG = Infinity;
    for (let y = 0; y < hInt; y++) for (let x = 0; x < BW; x++) {
      const i = y * BW + x; above++;
      if (isFinite(wz[i])) wall++;
      if (comp[i] !== bare[i]) prop++;
      if (isFinite(cz[i]) && cz[i] < minC) minC = cz[i];
      if (isFinite(gz[i]) && gz[i] < minG) minG = gz[i];
    }
    // the lip's own geometry, square on the lane so perp IS the axis distance to the plane
    const z0 = Math.min(fz[near], fz[far]) * ZQ, z1 = Math.max(fz[near], fz[far]) * ZQ, hpx = BH / DIST;
    return {
      BW, BH, hz: hInt, eyeZ: +eyeZ.toFixed(2), dist: DIST, steps: MAP.steps, risers: MAP.riserStops,
      above, wallPct: +(100 * wall / above).toFixed(2), propPct: +(100 * prop / above).toFixed(2),
      minComp: +minC.toFixed(3), minGround: +minG.toFixed(3), dealtPit, dealtProps,
      cam: [+P.x.toFixed(1), +P.y.toFixed(1)], cell: [lip.x, lip.y], dir: d,
      band: [+(fz[near] * ZQ).toFixed(2), +(fz[far] * ZQ).toFixed(2)],
      vbNear: (vb[near] >> (d << 2)) & 15, vbFar: (vb[far] >> ((d ^ 2) << 2)) & 15,
      enterDown: canEnter(lip.x + 0.5, lip.y + 0.5, lip.x + 0.5 + DIRX[d] * 0.25, lip.y + 0.5 + DIRY[d] * 0.25),
      enterUp: canEnter(lip.x + 0.5 + DIRX[d] * 0.75, lip.y + 0.5 + DIRY[d] * 0.75, lip.x + 0.5 + DIRX[d] * 0.5, lip.y + 0.5 + DIRY[d] * 0.5),
      y0: +(horizon + (eyeZ - z1) * hpx).toFixed(1), y1: +(horizon + (eyeZ - z0) * hpx).toFixed(1),
      propDist: 0.0
    };
  })()`);
  for (const dist of [1.5, 2.5, 3.5]) for (let li = 0; li < run('LEVELS.length'); li++) {
    const C = lipCover(li, dist);
    if (C.fail) { row(`L${li} pit lip ${dist} m: nothing paints the frame from inside the camera`, false, `VACUOUS - ${C.fail}`); continue; }
    const okP = C.propPct <= 1, okZ = C.minComp >= 0.9;
    row(`L${li} pit lip ${dist} m: nothing paints the frame from inside the camera`, okP && okZ,
      `camera (${C.cam}) on the datum at cell (${C.cell}) dir ${C.dir} -> lip ${C.dist} m ahead, band ${C.band[0]} / ${C.band[1]}` +
      ` (slab side [${Math.min(C.band[0], C.band[1]).toFixed(2)}, ${Math.max(C.band[0], C.band[1]).toFixed(2)}], projected rows ${C.y0}..${C.y1},` +
      ` drawn ${Math.max(0, Math.ceil(C.y0))}..${Math.min(C.BH - 1, Math.floor(C.y1))} of ${C.BH}, horizon ${C.hz} - the riser's whole band is BELOW the` +
      ` eye line, which is hypothesis (a) refuted on this geometry) - vb ${C.vbNear}/2/${C.vbFar} (down-step walkable, up-step blocked),` +
      ` canEnter down ${C.enterDown} up ${C.enterUp}, riserStops ${C.risers}/${C.BW}, MAP.steps ${C.steps}` +
      `: ${C.propPct}% of the above-horizon pixels belong to the barrel prop standing AT the camera (bound 1) and min zbuf there is ${C.minComp}` +
      ` against the ground pass's own ${C.minGround} (floor 0.90 - a prop face at 0.14 m is inside the camera, past the mesh's 0.12 m near` +
      ` plane, which is the number the issue read as a wall). Wall-pass coverage of the same half reads ${C.wallPct}% here - evidence, not` +
      ` asserted: this lane is a corridor, and at the capture's room pose the wall oracle is 0.0%. Dealt level had ${C.dealtPit} pit cells and` +
      ` ${C.dealtProps} props; the pit and the prop in this row are both poked, so no roll empties it`);
  }


  console.log((bad ? `CULL ${bad} FAILURES` : 'CULL ok - bodies sit on the band they stand on') +
    (known ? `  (${known} known ${STRICT ? 'FAILED under STRICT' : 'reporting'} rows: air-air steps occlude nothing, #100)` : ''));
  process.exit(bad ? 1 : 0);
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

  /* #100 gave the wall pass a second derived fact: MAP.steps, read once per frame to decide whether
     a riser can exist anywhere. A grid with steps whose flag still says flat draws nothing while
     movement stays blocked - the original #100, resurrected by a forgotten linkBoundaries() rather
     than by missing code - so the flag has to be shown to track the grid BOTH ways, and to be stale
     exactly when the relink was skipped rather than always right by luck. Since #152 the generator
     authors bands, so the flat state is built here (fill 0 + relink) instead of assumed from the
     level, and whether the GENERATED grid carries the right flag is alt's row to gate. */
  const stp = vm.runInContext(`(function(){
    startLevel(0, true);
    const N = MAP.w;
    let idx = -1;
    for (let k = 1; k < MAP.cell.length - 2; k++) {
      if (k % N === N - 1) continue;                       // a neighbour must be in the same row
      if (MAP.cell[k] || MAP.cell[k + 1]) continue;        // walls already draw their own face
      idx = k; break;
    }
    if (idx < 0) return { skip: 'no air-air pair on this seed' };
    const j = idx + 1, fz0 = MAP.fz.slice();
    const gen = MAP.steps;
    MAP.fz.fill(0); linkBoundaries();                       // the row's OWN flat baseline: since #152 the
    const flat0 = MAP.steps;                                // generator authors bands, so flatness can no
                                                            // longer be assumed from the level on disk
    MAP.fz[j] += 8;                                        // a step with NO relink: the stale state
    const staleFlag = MAP.steps;
    linkBoundaries();
    const relinked = MAP.steps;
    MAP.fz.set(fz0); linkBoundaries();
    const restored = MAP.steps;                             // back to the generated grid, whose flag is alt's row
    return { cell: idx, gen: gen, flat0: flat0,
             staleFlag: staleFlag, relinked: relinked, restored: restored };
  })()`, ctxVm);
  const stepsOk = !stp.skip && stp.flat0 === 0 && stp.relinked === 1 &&
    stp.staleFlag === 0 && stp.restored === stp.gen;
  console.log(`relink steps   ${stp.skip || 'cell ' + stp.cell}  generated ${stp.gen}  flat ${stp.flat0}  ` +
    `poked without relink ${stp.staleFlag}  after relink ${stp.relinked}  grid restored ${stp.restored}  ` +
    `${stp.skip ? stp.skip : stepsOk ? 'STEPS-FLAG ok' : 'STEPS-FLAG FAIL - steps would draw nothing'}`);
  console.log(`relink vb    ${idem.skip || 'run at cell ' + idem.run}  raised blocks ${yn(idem.blockedUp)}  ` +
    `grid restored ${yn(idem.restored)}  stale blockers ${idem.stale}` +
    `${idem.first >= 0 ? ' (first at cell ' + idem.first + ')' : ''}  authored ladder kept ${yn(idem.ladKept)}` +
    `  ${idem.skip ? idem.skip : idemOk ? 'RELINK-VB ok' : 'RELINK-VB FAIL'}`);
  /* Generation must depend on the seed and nothing else. makeEnemy used to take ten draws from the
     global stream per enemy (js/30_entities.js:29-36, #90), so how many enemies a level happens to
     contain moved its texture layout, lamp positions and pickup phases. Both arms seed FIRST, then
     construct k enemies, then generate: construction is the ONLY difference between them and has no
     gameplay effect at all, so a grid that still moves means the stream is coupled again - the
     coupling is what made level-comparing probes unreproducible (#87, #91). Seeding before each arm
     is what makes this a comparison rather than two visits to the same stream. */
  const genArm = (k) => {
    seedRng(20260927);
    return run(`(function(){
      for (let i = 0; i < ${k}; i++) makeEnemy('grunt', 1.5, 1.5);
      ENEMIES.length = 0;
      startLevel(0, true);
      const hh = (arr, f) => { let g = 2166136261; for (let i = 0; i < arr.length; i++) { g ^= (f ? f(arr[i]) : arr[i]) | 0; g = Math.imul(g, 16777619); } return g >>> 0; };
      return { cell: hh(MAP.cell), fz: hh(MAP.fz), lamp: hh(LIGHTS, (l) => (l.x * 1000) | 0),
        nL: LIGHTS.length, nP: PICKUPS.length, nX: PROPS.length };
    })()`);
  };
  const g0 = genArm(0), g12 = genArm(12);
  const genOk = g0.cell === g12.cell && g0.fz === g12.fz && g0.lamp === g12.lamp &&
    g0.nL === g12.nL && g0.nP === g12.nP && g0.nX === g12.nX;
  console.log(`gen stream   0 vs 12 enemies constructed  cell ${g0.cell}/${g12.cell}  fz ${g0.fz}/${g12.fz}  ` +
    `lampPos ${g0.lamp}/${g12.lamp}  counts ${g0.nL}L/${g0.nP}P/${g0.nX}X vs ${g12.nL}L/${g12.nP}P/${g12.nX}X  ` +
    `${genOk ? 'GEN-COUPLE ok' : 'GEN-COUPLE FAIL - constructing an enemy moves the level'}`);
  // A config that could not run is a skip, not a pass (#89); one that ran and failed is a verdict.
  // RELINK-VB is the #55 stale-blocker guard, and it used to print into a step that exited 0.
  // STEPS-FLAG is the same coupling for the #100 riser flag: a stale flag is an invisible step.
  process.exit(staleAll || !stOk || (!idem.skip && !idemOk) || (!stp.skip && !stepsOk) || !genOk ? 1 : 0);
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

  /* #20: the emissive marker has to survive the chain. 253 is a FLAG (this texel emits light), not a
     coverage value, and the renderer matches it exactly - the ground row loop, groundPixel and castWalls'
     bilinear decode. Measured on the deployed build, no mip 0 anywhere holds a 254, because the painter
     writes 255 or exactly 253; every 254 in a deeper mip is therefore a texel that stopped being emissive
     because aSum/4 averaged it (FLOORS.FLESH lost 84% of its emissive area by mip 1, WALLS[1] all of it by
     mip 2). So count nothing but manufactured bytes, and separately hand buildMips a 16x16 with one flagged
     texel so the invariant is checked against the function and not only against what the painter happened to
     produce today. emTotal is the VACUOUS guard: a census that finds no emissive texel proves nothing. */
  const mark = run(`(()=>{const sets=[['FLOORS',FLOORS],['CEILS',CEILS],['WALLS',WALLS]];
    let made254=0,emTotal=0,worst='',worstN=0;
    for(const [nm,obj] of sets){if(!obj)continue;
      for(const [k,t] of Object.entries(obj)){if(!t||!t.mips)continue;
        let e0=0,made=0;
        for(let i=0;i<t.mips.length;i++){const d=t.mips[i].data;
          for(let p=0;p<d.length;p++){const a=d[p]>>>24;
            if(a===253){if(!i)e0++;}else if(a===254){made++;made254++;}}}
        emTotal+=e0;
        if(made>worstN){worstN=made;worst=nm+'['+k+'] mip0 emissive '+e0+' manufactured '+made;}}}
    const q=new Uint32Array(256);for(let i=0;i<256;i++)q[i]=pk(10,10,10,255);q[0]=pk(200,180,120,253);
    const one=buildMips(16,16,q);
    const a1=one.length>1?one[1].data[0]>>>24:-1;
    return {made254,emTotal,worst,a1,levels:one.length}})()`);
  const markOk = mark.made254 === 0 && mark.emTotal > 0 && mark.a1 === 253;
  console.log(`emissive marker   ${markOk ? 'ok' : 'FAIL'}   ${mark.emTotal} emissive texels censused across ` +
    `FLOORS/CEILS/WALLS, ${mark.made254} texel(s) at alpha 254 (a value the painter never writes: ${mark.worst || 'none'}); ` +
    `synthetic 1 flagged texel -> mip1 alpha ${mark.a1} (want 253, chain has ${mark.levels} levels)`);

  /* #123: the census above gates the CHAIN. The OTHER site #20 had to fix is the bilinear FETCH in castWalls,
     and nothing gated it: the old code averaged the four corner alphas, so a wall pixel that merely TOUCHES an
     emissive texel blended to 254.x, missed the light-exempt branch and got multiplied by scene light - in
     mip 0, where the census cannot see it, because the census reads texture bytes, not what the fetch produced.
     Gated by pixels, with three hand-built textures on the SAME geometry, the SAME light and G_GRIT=0 (grit's
     gk swings +/-0.6 at the default quality, which would swamp the comparison):
       E  every texel alpha 253  -> the self-lit form, colour*(1-fog) + fogCol*fog
       O  every texel alpha 255  -> the scene-lit form, colour*lr + fogCol*fog
       A  same RGB, alpha alternating per texel in x -> every fetch with a fractional u straddles E and O
     All three carry ONE colour, so the bilinear colour blend is identical across them and the only thing that
     can move an A pixel from E to O is whether the branch saw the flag. A pixel closer to O than to E is the
     bug. A render where NO A pixel is closer to O means the pattern was never resolved (a mip >= 1 chain is
     uniformly 253 since #124's sticky flag), the second way this could pass for the wrong reason, so that is
     asserted too. Reverting the four tests to a blend moves the straddling pixels onto O; widening the test to
     >= 253 makes ordinary opaque texels self-lit and collapses the E-O gap to nothing.
     The face is chosen by what castWalls RESOLVES (zbuf in the sample band flat and near), not by
     castRayDist: that march counts a blocked boundary as a wall and picked a "face" at 2.5 m that the renderer
     paints at 5.1 m, so a candidate chosen from it would have asserted on pixels that are not that face.
     zbuf is cleared to the sentinel before each castWalls here: since #163 the ground pass leaves a real distance
     on ceiling rows too, and this row reads zbuf to find the pixels THE WALL PASS painted, so borrowing the ground
     pass's leftovers would have widened the sample band onto ceiling geometry without saying so. */
  const fetchRes = run(`(()=>{
    const cand=[];
    for(let y=2;y<MH-2&&cand.length<12;y++)for(let x=2;x<MW-6;x++){
      if(isSolid(x+.5,y+.5))continue;
      let d=-1;for(let k=1;k<=4;k++)if(isSolid(x+k+.5,y+.5)){d=k;break;}
      // air at ONE floor up to the face (the wall column itself carries no band): since #152
      // generation raises rooms, and a riser inside the run resolves the sample band onto the riser
      // instead of the face this row is asserting on
      for(let k=1;d>1&&k<d;k++)if(MAP.fz[(y|0)*MW+x+k]!==MAP.fz[(y|0)*MW+x])d=-1;
      if(d>0)cand.push([x+.5,y+.5,d]);}
    if(!cand.length)return{skip:'no air cell with a material wall within 4 m to +x'};
    const TW=WALLS[0].w,TH=WALLS[0].h;
    const texOf=al=>{const d=new Uint32Array(TW*TH);
      for(let y=0;y<TH;y++)for(let x=0;x<TW;x++)d[y*TW+x]=pk(170,160,150,al===2?((x&1)?255:253):al);
      return {w:TW,h:TH,data:d,tiles:true,mips:buildMips(TW,TH,d)}};
    const TE=texOf(253),TO=texOf(255),TA=texOf(2);
    const x0=(BW*0.46)|0,x1=(BW*0.54)|0;
    const lum=i=>{const c=px[i];return 0.2126*(c&255)+0.7152*(c>>8&255)+0.0722*(c>>16&255)};
    const bak=[];for(let i=0;i<WALLS.length;i++)bak[i]=WALLS[i];
    const gk=G_GRIT,gt=G_TRI;G_GRIT=0;G_TRI=false;
    let hit=null,tried=0;
    for(const c of cand){
      tried++;
      P.x=c[0];P.y=c[1];P.ang=0;P.pitch=0;P.crouch=0;P.z=floorAt(c[0],c[1]);P.air=false;P.vx=P.vy=P.vz=0;
      for(const e of ENEMIES)e.state='sleep';
      const IDX=(MAP.cell[(c[1]|0)*MAP.w+((c[0]|0)+c[2])]-1+WALLS.length)%WALLS.length;
      renderWorld();
      px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));zbuf.fill(Infinity);castWalls(S.flash,FOGC[0],FOGC[1],FOGC[2]);
      const hzz=Math.round(horizon),y0=Math.max(0,hzz-24),y1=Math.min(BH-1,hzz+24);
      const idxs=[];let lo=1e9,hi=-1e9;
      for(let x=x0;x<x1;x++)for(let y=y0;y<=y1;y++){const i=y*BW+x,pz=zbuf[i];
        if(!Number.isFinite(pz)||pz<=0.05)continue;idxs.push(i);if(pz<lo)lo=pz;if(pz>hi)hi=pz;}
      // accept only a candidate that lands on MIP 0 (spanPx >= 0.6 texels/unit), because a deeper chain is
      // uniformly 253 since #124 and would make the fetch assertion pass without exercising mip 0 at all
      const span = BH / ((lo + hi) / 2);
      if (idxs.length >= 160 && hi - lo < 0.45 && lo > 1.1 && hi < 4.2 && span >= TH * 0.6) { hit = { c, IDX, lo, hi, idxs, hzz }; break; }
    }
    if(!hit){for(let i=0;i<WALLS.length;i++)WALLS[i]=bak[i];G_GRIT=gk;G_TRI=gt;
      return{skip:'no candidate resolved a flat face-on face 1.1-4.2 m away in the sample band',tried};}
    WALLS[hit.IDX]=TE;
    px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));zbuf.fill(Infinity);castWalls(S.flash,FOGC[0],FOGC[1],FOGC[2]);
    const grab=()=>{const a=new Float64Array(hit.idxs.length);for(let k=0;k<hit.idxs.length;k++)a[k]=lum(hit.idxs[k]);return a};
    const LE=grab();
    WALLS[hit.IDX]=TO;px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));zbuf.fill(Infinity);castWalls(S.flash,FOGC[0],FOGC[1],FOGC[2]);const LO=grab();
    WALLS[hit.IDX]=TA;px.fill(pack(FOGC[0],FOGC[1],FOGC[2]));zbuf.fill(Infinity);castWalls(S.flash,FOGC[0],FOGC[1],FOGC[2]);const LA=grab();
    const perp=hit.idxs.length?zbuf[hit.idxs[(hit.idxs.length/2)|0]]:0,spanPx=BH/perp,th=bak[0].h;
    const mip=spanPx<th*0.6?(spanPx<th*0.3?(spanPx<th*0.15?3:2):1):0;
    const wi=(hit.c[1]|0)*MAP.w+((hit.c[0]|0)+hit.c[2]);
    const amb=AMB,lit=MAP.light?Math.max(MAP.light[wi],MAP.light[(hit.c[1]|0)*MAP.w+(hit.c[0]|0)]):1;
    for(let i=0;i<WALLS.length;i++)WALLS[i]=bak[i];G_GRIT=gk;G_TRI=gt;
    return {LE,LO,LA,n:hit.idxs.length,perp:+perp.toFixed(3),spanPx:+spanPx.toFixed(1),mip,
      levels:TE.mips.length,lo:+hit.lo.toFixed(3),hi:+hit.hi.toFixed(3),tried,spot:[+hit.c[0].toFixed(1),+hit.c[1].toFixed(1)],
      face:hit.c[2],IDX:hit.IDX,horizon:hit.hzz,amb:+amb.toFixed(3),lit:+lit.toFixed(3)}})()`);
  let fetchOk = false, fetchLine = '';
  if (!fetchRes || fetchRes.skip) fetchLine = `FAIL   SKIPPED: ${fetchRes ? fetchRes.skip : 'scan failed'} (${fetchRes ? fetchRes.tried : 0} candidates tried) - the fetch is not being exercised`;
  else {
    const LE = Float64Array.from(fetchRes.LE), LO = Float64Array.from(fetchRes.LO), LA = Float64Array.from(fetchRes.LA);
    let nE = 0, nO = 0, nOther = 0, sE = 0, sO = 0;
    for (let k = 0; k < LA.length; k++) {
      const dE = Math.abs(LA[k] - LE[k]), dO = Math.abs(LA[k] - LO[k]);
      sE += LE[k]; sO += LO[k];
      if (dE <= 1) nE++; else if (dO <= 1) nO++; else nOther++;
    }
    const meanE = sE / LA.length, meanO = sO / LA.length, gap = meanE - meanO;
    /* Alternating columns, and that choice is the whole point of the row: the bug truncates, so a straddling
       fetch blends to 253.x when the flagged corner's weight is under 0.5 and `| 0` still reads 253, which made
       a period-8 pattern pass on the broken build (measured: 1519 -> 1329 emissive, only 190 of ~588 straddling
       columns moved). With every other texel flagged, EVERY fetch has at least one flagged corner (t1 or t3 in
       the pair, whatever fx and fy are), so correct code must make every pixel self-lit and the blend must make
       every one of them 254 and scene-lit - a 100% vs 0% signal with no dependence on where u lands.
       mip === 0 is asserted outright, because a deeper chain is uniformly 253 after #124's sticky flag and would
       fake the emissive half while proving nothing about the fetch. The >= 253 direction (ordinary opaque texels
       treated as self-lit) is caught by the E-O gap collapsing - control B measures it. */
    fetchOk = gap > 20 && fetchRes.mip === 0 && nE >= LA.length * 0.98 && nO <= LA.length * 0.02;
    fetchLine = `${LA.length} wall px on the face at (${fetchRes.spot[0]}, ${fetchRes.spot[1]}) +${fetchRes.face} -> ` +
      `WALLS[${fetchRes.IDX}], perp ${fetchRes.perp} m (band ${fetchRes.lo}-${fetchRes.hi}, mip ${fetchRes.mip} of ` +
      `${fetchRes.levels - 1}, ${fetchRes.spanPx} px per world unit, AMB ${fetchRes.amb}, light ${fetchRes.lit}) | ` +
      `all-emissive mean ${meanE.toFixed(1)} vs all-opaque mean ${meanO.toFixed(1)} (gap ${gap.toFixed(1)}, must ` +
      `stay > 20 - the exemption has to be visible in this light) | straddling: ${nE} match emissive, ${nO} match ` +
      `opaque, ${nOther} neither - prediction is EVERY pixel emissive: with the flag on alternating texels, each ` +
      `bilinear quartet has at least one flagged corner (t1 or t3, whatever fx/fy are), so the four tests must ` +
      `catch all ${LA.length} and blending the four alphas must lose all of them to the scene-lit form (254 is not ` +
      `253) | mip must be 0: a deeper chain is uniformly 253 since #124 and would match emissive for the wrong ` +
      `reason | ${fetchRes.tried} candidate(s) scanned`;
  }
  console.log(`wall fetch        ${fetchOk ? 'ok' : 'FAIL'}   ${fetchLine}`);


  console.log(bad ? `${bad} level(s) NOT BETTER THAN THE 1-D CONTROL` : 'MIP ok: two-axis selection beats the 1-D control on every level and is not mush');
  process.exit(bad || !markOk || !fetchOk ? 1 : 0);
}

if (MODE === 'exposure') {
  /* Average over levels x rolls x yaws. Two things this prints and used to hide:
     - the ROLLS separately, because the generator's roll moves a frame by more than the 60-100 band
       is wide. Measured on the deployed page through DEV (which never seeds), four startLevel rolls
       of level 0 at one yaw read 90.6 / 62.7 / 50.7 / 63.8 - a 40-point spread, the whole width of
       the band - so a single mean per level is a dice roll dressed as a property of the level (#87).
       The probe seeds, so its own spread is smaller than that; the point of printing it is that
       nobody has to take that on faith any more.
     - WHICH LAYER the numbers are in. Everything here is the raster BEFORE bloom, grade and grain,
       which together move the mean by about +20 and -21 and cancel unevenly per room (#85). A
       screenshot is not comparable to a number below, and saying so is half of why this exists. */
  const N = run('LEVELS.length'), reps = +(process.env.REPS || 4);
  const buckets = new Array(8).fill(0);
  let grand = 0, gpix = 0, gclip = 0, gdark = 0;
  /* mid = mean of the CENTRE HALF of the frame, the same region DEV.lum calls mid (js/90_dev.js:235),
     so the number here and the number tools/ci/assert.js prints off the display canvas mean one
     thing. It is a region mean, NOT a median of luminances - reading it as one is how a bright lamp
     off-centre looks like a dark frame. */
  const lumOf = c => 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
  const med2 = a => { const s = a.slice().sort((x, y) => x - y), k = s.length; return k % 2 ? s[(k / 2) | 0] : (s[k / 2 - 1] + s[k / 2]) / 2; };
  const midOf = (d, w, h) => {
    let s = 0, k = 0;
    const x0 = (w * 0.25) | 0, x1 = (w * 0.75) | 0, y0 = (h * 0.25) | 0, y1 = (h * 0.75) | 0;
    for (let y = y0; y < y1; y++) { const row = y * w; for (let x = x0; x < x1; x++) { s += lumOf(d[row + x]); k++; } }
    return k ? s / k : NaN;
  };
  console.log('exposure: raster BEFORE bloom/grade/grain (the composited frame is not this number), '
    + reps + ' seeded rolls x 6 yaws per level, band 60-100 quoted against the MEDIAN not a mean');
  console.log('  spawn column = the FIRST FRAME, no update(): the pose startLevel leaves (js/20_level.js:562-563\n' +
    '  sets P.x/P.y from nearestOpen of the spawn room centre, P.ang is authored as a constant 0.6 there, and\n' +
    '  P.z is the FEET - js/40_render.js:103 adds cfg.eye). One pose, one roll each, same dice as the rolls column.');
  for (let lv = 0; lv < N; lv++) {
    let sum = 0, n = 0;
    const hist = new Array(8).fill(0);
    const rolls = [], spawnMeans = [], spawnMids = [];
    for (let r = 0; r < reps; r++) {
      seedRng(1000 + lv * 97 + r * 13);
      run(`S.mode='play'; S.locked=false; startLevel(${lv}, true);`);
      /* #155: the frame the player actually sees first. Every sampler in this repo, this one included,
         moved the camera to an arbitrary open cell and spun it through yaws, so the spawn frame was in
         no gate while the medians below sat comfortably inside 60-100. Taken on the SAME generated level
         as this roll, before the yaw loop re-poses the camera, so median and spawn on one line are
         two views of one world rather than two worlds. The pose is written, not trusted, in the form
         the other probes use: P.ang is the heading (there is no P.yaw) and P.z is the feet. */
      const pose = run(`(()=>{const sx=P.x, sy=P.y, sa=P.ang;
        P.x=sx; P.y=sy; P.ang=sa; P.pitch=0; P.vx=P.vy=P.vz=0; P.air=false; P.crouch=0;
        P.z=floorAt(sx,sy); for(const e of ENEMIES) e.state='sleep';
        return {z:P.z, f:floorAt(P.x,P.y)}})()`);
      if (!(pose.z === pose.f)) console.log('  SPAWN-POSE FAIL level ' + lv + ' roll ' + r + ': P.z ' + pose.z + ' is not floorAt ' + pose.f);
      run('renderWorld()');
      const sW = run('BW'), sH = run('BH'), sd = new Uint32Array(run('px'));
      let sSum = 0; for (let i = 0; i < sd.length; i++) sSum += lumOf(sd[i]);
      spawnMeans.push(sSum / sd.length); spawnMids.push(midOf(sd, sW, sH));
      let rs = 0, rn = 0;
      // average over yaws: looking down the longest corridor over-weights fog
      for (let w = 0; w < 6; w++) {
        run(`(()=>{const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
          const c=cs[((cs.length*0.31+${r})|0)%cs.length];
          P.x=c[0]+.5;P.y=c[1]+.5;P.ang=${w}*Math.PI/3+0.13;P.pitch=BH*0.02;P.z=floorAt(P.x,P.y);
          for(const e of ENEMIES)e.state='sleep';})()`);
        run('renderWorld()');
        const BW = run('BW'), BH = run('BH'), d = new Uint32Array(run('px')), m = d.length;
        for (let i = 0; i < m; i++) {
          const c = d[i], L = 0.2126 * (c & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c >> 16 & 255);
          sum += L; rs += L; hist[Math.min(7, (L / 32) | 0)]++; if (L > 250) gclip++; if (L < 24) gdark++;
        }
        n += m; rn += m; gpix += m;
      }
      rolls.push(rs / rn);
    }
    const sorted = rolls.slice().sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length / 2) | 0]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    for (let b = 0; b < 8; b++) buckets[b] += hist[b];
    grand += sum;
    const spSorted = spawnMeans.slice().sort((a, b) => a - b);
    console.log('  level ' + lv + '  mean ' + pad((sum / n).toFixed(0), 3) +
      '  median ' + pad(med.toFixed(0), 3) +
      '  rolls ' + rolls.map(v => pad(v.toFixed(0), 3)).join(' ') +
      '  spread ' + pad((sorted[sorted.length - 1] - sorted[0]).toFixed(0), 3) +
      '  buckets ' + hist.map(v => (100 * v / n).toFixed(0)).join(',') +
      '  | spawn mean ' + pad(med2(spawnMeans).toFixed(0), 3) +
      '  mid ' + pad(med2(spawnMids).toFixed(0), 3) +
      '  rolls ' + spawnMeans.map(v => pad(v.toFixed(0), 3)).join(' ') +
      '  spread ' + pad((spSorted[spSorted.length - 1] - spSorted[0]).toFixed(0), 3));
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
     The heights are pokes to MAP.fz/cz, not generator changes, and since #152 the generator authors
     bands of its own - so this probe FLATTENS the grid it pokes onto. Its assertions are about which
     half of the frame reacts to a plane change, and that question needs a base whose planes are known;
     whether the GENERATED bands render is alt's exit gate and the exposure probe's, not this one's. */
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
      run(`S.mode='play';S.locked=false;startLevel(${li},true);MAP.fz.fill(0);MAP.cz.fill(CZ_DEF);linkBoundaries();`);
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
         distance - the far band included, since that branch fills the row with the same number - on
         BOTH halves of the frame. The ceiling half used to assert the Infinity sentinel instead (the
         #45 carve-out); #163 replaced that carve-out with the row's own ceiling solve, so the
         assertion became the same arithmetic as the floor half rather than a weaker one: one number
         that has to agree with the row instead of one number that could only ever be Infinity.
         Deferred pixels are excluded here and covered by the samples above, so this cannot
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
          } else {
            ceilTot++;
            if (!(zc[i] > 0) || Math.abs(zc[i] - dR) > Math.max(1e-5, dR * tolRel)) ceilBad++;
          }
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
      // a ceiling row that carries a sentinel, a zero or a distance that is not its own solve cannot
      // hide a body on the band above, which is #163; the horizon row is exempt above, not here
      if (ceilBad) fail += ' CEILING-DEPTH';
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
        `  horizon ${hzBad ? 'BROKEN' : 'sentinel ok'}  ceiling ${ceilTot} ${ceilBad ? ceilBad + ' NOT THE ROW SOLVE' : 'rows carry their own distance'}` +
        `${dWhy ? '  ' + dWhy : ''}`);
      // determinism now runs on EVERY config and on the ground-only repaint: it used to sit under `if (!poke)`, i.e. on `flat` alone - the one config whose RX/RP queue is provably empty, so the deferred pixel body had no coverage while this printed ok
      seedRng(4242 + li * 31);
      run(`S.mode='play';S.locked=false;startLevel(${li},true);MAP.fz.fill(0);MAP.cz.fill(CZ_DEF);linkBoundaries();`);
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
  /* Do the characters separate from the room they are standing in?

     THE MASK IS COVERAGE, NOT A RENDER DIFFERENCE. It used to be |A - B| > 4, where B is the same
     render with ENEMIES emptied, and that cannot credit anything a body changes in the WORLD: B has
     no shadow in it by construction, so no shadow term ever reaches dl, and a shadow that falls
     OUTSIDE the silhouette JOINS the mask, which moves the sampled edge onto the shadow's own
     falloff boundary where dl is tiny. Measured on the contact-shadow branch (#179): cam1 read
     BIT-IDENTICAL (dL 14, lost 44%) with a term computing a nonzero value on 4,410 of 37,651 body
     pixels, `cull` reported 113.0% / 182.3% of the flat silhouette "surviving", and cover went
     1.1% -> 33.3%. What a diff mask can see is the mask's GEOMETRY; the shading inside it is
     invisible to it, and the shading is what this probe is for.

     So the mask now comes from the body pass itself. COV (js/00_core.js, armed here, stamped at the
     mesh and billboard pixel writes) records who painted each pixel LAST, 1 being a body's own
     draw; renderWorld clears it once per frame and it is null in play. Two consequences, both the
     point: a body pixel painted the SAME colour as the wall behind it is now in the mask - that
     pixel is by definition one whose difference is 0, so the old mask could never contain it - and
     a shadow behind the body is now BACKGROUND, where a shadow belongs.

     RULES, identical for all three cameras:
       mask        M[i] = 1 where a body's draw was the last writer of pixel i. An alpha-blended
                   draw (a corpse fading) stamps too, so a fading body counts as drawn.
       edge ring   a mask pixel inside rows/cols 1..n-2 (the same border margin the old loop used)
                   with at least one of its EIGHT neighbours outside the mask. Eight, not four: a
                   rasterised silhouette steps diagonally and a 4-neighbour ring calls those steps
                   interior.
       background  the MEDIAN luminance of the outside-mask neighbours in that pixel's 3x3, taken
                   from the SAME composited frame as the body - one value, robust to the neighbour
                   that is shadow and the one that is lit wall. A ring pixel with no outside-mask
                   neighbour is counted and fails the ring row. edge dRGB's reference is the
                   outside neighbour whose luminance is nearest that median, so the two numbers
                   describe the same pixel.
       thresholds  unchanged from the shipped probe: separated above dl 4, an edge pixel LOST below
                   dl 10, verdict WEAK below edge dL 24. Plus: lost under 70%, mask at least
                   MINMASK px, ring at least 8 px, an empty mask is a FAILURE rather than a zero,
                   and every pixel the old diff mask claims but coverage denies is counted and
                   fails - that leak IS the bug this rewrite fixes, made countable.

     Controls (env, and each one is run before this branch is proposed for merge):
       NOBODY=1   renders the measured frame with ENEMIES emptied: the mask must come back empty
                  and every row must go RED. A probe that printed "lost 0%" here would repeat the
                  exact defect it was written to fix.
       DARKRING=1 paints the edge ring black in the frame before measuring, which is the scale a
                  future contour-style term gets judged on: edge dL up, lost down.
       TINT=k     repaints the bodies with their own per-individual tint, the colour the mesh shades
                  with, so "the rows move with BODY shading, not with mask geometry" is testable.
       POSEONLY=1 drops every body but the POSED one from the measured frame. Same camera, same cell,
                  same yaw, same geometry - it is how a WEAK verdict gets attributed: posed body alone
                  reading 24+ while the crowd reads 20 says the shortfall is in FOUND bodies merging
                  into the room, not in the pose.
       FLAT=1     flattens the grid (MAP.fz.fill(0), cz back to CZ_DEF, relink) after the level builds.
                  This is the control that says the POSE is the mechanism and not the level: on the
                  volume branch a camera whose cone is 0.56 m deep measures nothing, and with the
                  slab gone the same camera finds a clear ray and its mask comes back non-zero.
       RIM=0|1    runs RIG.setRim (the call DEV.set('rim', ...) makes) and prints a frame hash with
                  PIXHASH=1, which is how this run shows the shipped rim switch no longer reaches
                  the picture: #72 moved bodies off the rig raster onto the mesh, and nothing in
                  the draw path calls RIG any more.
       STRICT=1   promotes cam 1's #179 debt row from KNOWN to a hard FAIL, which is how the term that
                  pays the debt gets A/B'd against a baseline that is green WITH the debt already paid.

     EVERY CAMERA POSES ITS BODY (#189). Bodies are meshes occlusion-tested against `zbuf`, and since
     #162 `zbuf` carries the riser lips the generator now authors, so a body on the band above a
     camera can be hidden COMPLETELY by a 1 m ledge 0.56 m in front of the lens - cam 1 on the volume
     branch measured 0 px that way while every enemy in the level stayed alive and in the frustum.
     That occlusion is CORRECT (`cull` asserts it) and it is reported per camera below, but it cannot
     be measured against, so all three cameras now do what cam 2 always did: march from the lens with
     the renderer's own stop conditions and park ONE body in the clear, on the camera's own band, at
     the same distance. Nothing else about the cameras moved - same cells, same yaws, same conventions -
     and the rows that guarantee and judge that body say POSED in their label, because a posed body
     and a found one are not the same evidence and a reader has to be able to tell them apart. */
  const W = run('BW'), H = run('BH'), N = W * H;
  const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);
  const DARKRING = process.env.DARKRING === '1';
  const NOBODY = process.env.NOBODY === '1';
  const POSEONLY = process.env.POSEONLY === '1';
  const FLAT = process.env.FLAT === '1';
  const RIM = process.env.RIM === undefined ? -1 : +process.env.RIM ? 1 : 0;
  const TINTK = process.env.TINT === undefined ? NaN : +process.env.TINT;
  const PIXHASH = process.env.PIXHASH === '1';
  const MINMASK = 200, DLR = 4, DLLOST = 10, DLMIN = 24, LOSTMAX = 70, RINGMIN = 8, LEAKMAX = 0;
  /* Per-frame edge statistics, factored out of the camera loop so the posed frame, the found frame and
     the flat control are measured by the SAME arithmetic as the crowd frame - a control computed by a
     second implementation is not a control. Identical loops to the ones this block used inline. */
  const nCover = (m) => { let n = 0; for (let i = 0; i < N; i++) if (m[i]) n++; return n; };
  const ringOf = (m) => {
    const r = [];
    for (let y = 1; y < H - 1; y++) {
      const rw = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = rw + x;
        if (!m[i]) continue;
        if (m[i - 1] && m[i + 1] && m[i - W] && m[i + W] && m[i - W - 1] && m[i - W + 1] && m[i + W - 1] && m[i + W + 1]) continue;
        r.push(i);
      }
    }
    return r;
  };
  const edgeOf = (f, m, ring) => {
    let eDL = 0, eRGB = 0, lost = 0, noBg = 0;
    for (let t = 0; t < ring.length; t++) {
      const i = ring[t], vals = [], idxs = [];
      for (const o of NB) { const j = i + o[1] * W + o[0]; if (!m[j]) { vals.push(lum(f, j)); idxs.push(j); } }
      if (!vals.length) { noBg++; continue; }
      const srt = vals.slice().sort((p, q) => p - q);
      const med = srt.length & 1 ? srt[srt.length >> 1] : (srt[(srt.length >> 1) - 1] + srt[srt.length >> 1]) * 0.5;
      let k = 0, bk = 1e18;
      for (let u = 0; u < vals.length; u++) { const d = Math.abs(vals[u] - med); if (d < bk) { bk = d; k = u; } }
      const j = idxs[k], dl = Math.abs(lum(f, i) - med);
      eDL += dl; eRGB += (Math.abs((f[i] & 255) - (f[j] & 255)) + Math.abs((f[i] >> 8 & 255) - (f[j] >> 8 & 255)) +
        Math.abs((f[i] >> 16 & 255) - (f[j] >> 16 & 255))) / 3;
      if (dl < DLLOST) lost++;
    }
    const en = ring.length - noBg;
    return { dl: en ? eDL / en : 0, rgb: en ? eRGB / en : 0, lost: en ? 100 * lost / en : 0, en, noBg, ring: ring.length };
  };
  /* ---- #244: THE TORSO GRADIENT, ONE DEFINITION, IN A TOOL THAT SHIPS --------------------------
     #232 was paid with numbers measured by a COPY of this file in /tmp, and three sessions have since
     produced three definitions of "the torso's within-surface gradient", none of which can fail:
       (a) `stats`' grunt rows (grad 6.1-6.7) - texel-space variance of the billboard sheets #72 took
           out of the draw path. The shipped body is MESH.draw, so no change to a mesh can move it.
       (b) #240's rows (1.02-2.32 -> 3.24-4.53) - a band of PIXEL ROWS (0.20..0.51 from the crown)
           including the silhouette ring, so a contour term pays it and a pose-resolution change moves
           it; it also lived in a file that no longer exists.
       (c) #246's hand measurement (2.98 -> 3.79 on rows 317-451) - family (b) with a third row set.
     The definition recorded here, chosen because the thing being claimed is about the COMPOSITED
     frame (AGENTS: the raw-raster `rig` sheet showed a rim the live site contradicted):
       frame    the composited crowd frame of a real level, from the real draw path, exactly the frame
                the coverage rows above measure. Not a sheet, not a raw raster, not a crop.
       region   pixels the coverage mask says a BODY painted last, inside the projection of the torso
                box's OWN authored span (heights [sp.hip, sp.sh] of js/13_mesh.js's SPEC) and its
                projected half-width (sp.shLat * 1.05), per body, projected by the mesh's own formula
                Y = horizon + BH*(eyeZ - z)/depth. Authored BODY HEIGHTS, never row numbers: a sharper
                pose, a different distance or a different buffer scales the band with the body instead
                of drifting off it - which is what (b) got wrong and what makes the numbers comparable
                across builds.
       interior a torso pixel counts only with a 2 px cushion of mask around it (all 25 neighbours).
                The silhouette ring is therefore STRUCTURALLY out of this number, so the row can say
                the gradient came from the SURFACE. #232 required the mean AND silhouette channels
                unmoved; a band average that includes the outline can be paid by fattening the outline.
       operator mean |L(x+1) - L(x-1)| / 2 - the luminance slope per screen pixel, which is exactly
                what #232's slope-as-the-constant term delivers by construction (amplitude =
                TS_SLOPE * projected period / 4, so the slope is TS_SLOPE * the grazing band, and the
                number is independent of the projected period - a mip-correct term reads the same near
                and far, which is the property worth gating).
       controls room gradient: the same operator over the non-mask pixels of the same frame (the ratio
                is what "the torso reads as armour, not as a box" means on screen); the DC of the wave
                (mean of the SIGNED slope, which is the zero-mean half measured inside one frame); and
                torso boil against the SAME BODY's limb band across a 0.03 rad turn (legs carry no term,
                so they are a motion control that needs no literal and no build with the term off - and
                NOT a gradient control: legs are faceted tubes and read 2.8-11.6 dL/px with no term in
                the tree at all, which is why there is no "rise over the limb band" gate here).          */
  const TG_SP = {
    grunt: { sh: 0.815, hip: 0.50, crown: 0.983, half: 0.1029 },
    hound: { sh: 0.720, hip: 0.50, crown: 0.895, half: 0.1365 },
    brute: { sh: 0.775, hip: 0.44, crown: 0.935, half: 0.1680 }
  };
  /* The floor sits between the two measured readings of THIS arithmetic: the pre-#232 tree (js/
     reverted to 135c8ad^) run with THIS probe, and current main. Nine cells each (3 levels x 3 cameras,
     SEED 12345; the CI cell is L0 cam 0/2):
       no torso term in js/    0.00 0.01 0.02 0.02 0.04 0.09 0.14 0.68   (L0 cam 0 0.02, cam 2 0.01)
       shipped term            2.17 2.51 2.51 2.52 2.54 2.54 2.74 3.31
     The separation is sharper than #240's because a flat-shaded triangle carries NO intra-face slope, so
     the termless torso reads about 0.0 - the 1.02-2.32 in that record was the silhouette ring and the
     seams between faces, which this definition excludes by construction. Floor 1.40 is twice the
     strongest termless cell and 0.64 of the weakest shipped one: it trips on a term that loses a third
     of its slope, not on a dark room.                                                        */
  const TG_PRE = 0.68, TG_POST = 2.17, TG_FLOOR = 1.40, TG_MINPX = 60;
  /* The mean and motion halves, measured on the same nine cells of both trees. The mean channel is the
     DC of the wave: the mean of the SIGNED slope less the frame\'s own, which cancels on a zero-mean
     triangle (0.00 to 0.53 with no term in js/, 0.00 to 0.80 shipped - the widest legit cell is L2 cam 1,
     246 px of torso) and does not cancel on a unipolar seam, a multiplier or a term clamped off centre.
     Floor 1.20 is 1.5x the widest legit cell. The whole-silhouette mean this term costs across the two
     trees on the CI cell is +0.4 (46.1 -> 46.5 cam 0, 48.6 -> 49.0 cam 2): small and POSITIVE, not the
     -0.2 #240 quoted, so it is printed rather than repeated.
     BOIL IS REPORTED AND NOT GATED, and that is a measurement rather than a dodge: torso boil measured
     9.3 to 13.8 across the whole shipped parameter space (TS_SLOPE 0 / 9 / 30 - TS_MAX clamps the
     amplitude - and TS_CYC 10 / 28) against the limb band of the same bodies at 17.96 to 37.49, on every
     cell of both trees. No setting this file can express crosses a ceiling at +3, and AGENTS is explicit
     that a threshold nothing can cross is a row that cannot fail. What the ceiling DOES catch is a
     mechanism anchored to the SCREEN rather than to the body - a specular or a noise term painted in
     output space, which is the failure #232 rejected when the leg specular died. The trade #244 asks to
     keep visible - more slope or a faster seam for more boil - lands in the printed ratio below (4.39
     shipped, 8.50 at TS_CYC = 28, both at 542 torso px), and the gradient floor is what stops the faster
     seam from buying that trade with structure: TS_CYC = 28 measures 1.62 dL/px.                       */
  const TG_BIAS = 1.20, TG_MEANMOVE = 0.4, TG_BOILLO = 9.3, TG_BOILHI = 13.8, TG_LIMBOILLO = 17.96,
    TG_LIMBOILHI = 37.49, TG_NOISE = 4.39, TG_NOISESAB = 8.50;
  /* Which js/ the process is actually running, grepped out of the SHIPPED STATEMENT (code, not prose:
     a comment explaining a removal would match a prose marker - AGENTS #122). This is what makes the
     revert arm and the shading A/B provable rather than "I promise I pointed at the other tree". */
  const TG_MARK = (() => {
    try {
      const src = fs.readFileSync(path.join(__dirname, '..', 'js', '13_mesh.js'), 'utf8');
      if (!/TS_SLOPE \* TPR \* 0\.25/.test(src)) return 'js/13_mesh.js term ABSENT (no per-pixel torso term in this tree)';
      const k = /TS_CYC = ([0-9.]+)[^;]*?TS_SLOPE = ([-0-9.]+)/.exec(src);
      return 'js/13_mesh.js term PRESENT (TS_CYC ' + (k ? k[1] : '?') + ', TS_SLOPE ' + (k ? k[2] : '?') + ')';
    } catch (e) { return 'js/13_mesh.js unreadable: ' + e.message; }
  })();
  /* One implementation, used for the crowd frame and for every frame this row is compared against,
     so a control measured by a second implementation would not be a control (see edgeOf above). */
  const torsoStats = (F, M, list, cm, F2) => {
    const hw = W * 0.5, invDet = 1 / (cm.planeX * cm.dirY - cm.dirX * cm.planeY);
    const slope = (f, i) => Math.abs(lum(f, i + 1) - lum(f, i - 1)) * 0.5;
    // the same operator WITHOUT the absolute value: its mean is the DC the wave carries, see TG_BIAS
    const slopeS = (f, i) => (lum(f, i + 1) - lum(f, i - 1)) * 0.5;
    const r = { px: 0, gs: 0, sgs: 0, ls: 0, bs: 0, limbPx: 0, limbGs: 0, limbBs: 0, silPx: 0, silLs: 0, rej: 0,
      grad: 0, bias: 0, bandMean: 0, boil: 0, limbGrad: 0, limbBoil: 0, silMean: 0, room: 0, roomBias: 0, roomN: 0, per: [] };
    for (const e of list) {
      const sp = TG_SP[e.k]; if (!sp) continue;
      const dx = e.x - cm.camX, dy = e.y - cm.camY;
      const tY = invDet * (-cm.planeY * dx + cm.planeX * dy);
      if (tY < 0.3) { r.per.push({ k: e.k, d: tY, px: 0, g: 0, boil: 0, lpx: 0, lboil: 0, why: 'behind the lens', dead: e.dead }); continue; }
      const tX = invDet * (cm.dirY * dx - cm.dirX * dy);
      const hpx = hw * sp.half * e.s / tY, sx = hw * (1 + tX / tY);
      const x0 = Math.max(2, Math.ceil(sx - hpx)), x1 = Math.min(W - 3, Math.floor(sx + hpx));
      if (x1 <= x0) { r.per.push({ k: e.k, d: tY, px: 0, g: 0, boil: 0, lpx: 0, lboil: 0, why: 'off screen', dead: e.dead }); continue; }
      const rowH = h => cm.hz + cm.BH * (cm.eyeZ - (e.z + h * e.s)) / tY;
      // [top row, bottom row, which accumulator] - torso band, then the limb band BELOW the hip
      const bands = [[Math.ceil(rowH(sp.sh)), Math.floor(rowH(sp.hip)), 0],
        [Math.ceil(rowH(sp.hip - 0.06)), Math.floor(rowH(0.06)), 1]];
      const acc = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
      for (const bd of bands) {
        const a = acc[bd[2]];
        for (let y = Math.max(2, bd[0]); y <= Math.min(H - 3, bd[1]); y++) {
          const rw = y * W;
          for (let x = x0; x <= x1; x++) {
            const i = rw + x;
            if (!M[i]) continue;
            let cushion = true;
            for (let oy = -2; oy <= 2 && cushion; oy++) {
              const o = rw + oy * W;
              for (let ox = -2; ox <= 2; ox++) if (!M[o + x + ox]) { cushion = false; break; }
            }
            if (!cushion) { r.rej++; continue; }
            a[0]++; a[1] += slope(F, i); a[2] += lum(F, i); a[4] += slopeS(F, i);
            if (F2) a[3] += Math.abs(lum(F2, i) - lum(F, i));
          }
        }
      }
      // the same column window over the whole body: the mean channel's reference, no cushion needed
      for (let y = Math.max(1, Math.floor(rowH(sp.crown + 0.03))); y <= Math.min(H - 2, Math.ceil(rowH(-0.03))); y++) {
        const rw = y * W;
        for (let x = x0; x <= x1; x++) { const i = rw + x; if (!M[i]) continue; r.silPx++; r.silLs += lum(F, i); }
      }
      const a = acc[0], b = acc[1];
      r.px += a[0]; r.gs += a[1]; r.sgs += a[4]; r.ls += a[2]; r.bs += a[3];
      r.limbPx += b[0]; r.limbGs += b[1]; r.limbBs += b[3];
      r.per.push({ k: e.k, d: tY, px: a[0], g: a[0] ? a[1] / a[0] : 0, boil: a[0] ? a[3] / a[0] : 0,
        lpx: b[0], lboil: b[0] ? b[3] / b[0] : 0, dead: e.dead });
    }
    let rs = 0, rss = 0;
    // EVERY column, not a stride: a strided sample of a 2-px-period pattern biases the SIGNED mean, and
    // the signed mean is the DC the mean channel is gated on.
    for (let y = 2; y < H - 2; y += 2) {
      const rw = y * W;
      for (let x = 2; x < W - 2; x++) { const i = rw + x; if (M[i]) continue; rs += slope(F, i); rss += slopeS(F, i); r.roomN++; }
    }
    r.room = r.roomN ? rs / r.roomN : 0; r.roomBias = r.roomN ? rss / r.roomN : 0;
    r.grad = r.px ? r.gs / r.px : 0;
    r.bias = r.px ? Math.abs(r.sgs / r.px - r.roomBias) : 0; r.bandMean = r.px ? r.ls / r.px : 0;
    r.boil = r.px ? r.bs / r.px : 0; r.limbGrad = r.limbPx ? r.limbGs / r.limbPx : 0;
    r.limbBoil = r.limbPx ? r.limbBs / r.limbPx : 0; r.silMean = r.silPx ? r.silLs / r.silPx : 0;
    return r;
  };
  /* cam 1's separation on unmodified shipped content is BELOW the DLMIN gate it is held to, and #179
     (Epic A) is filed for the shading term that pays it. So that ONE row reports instead of failing -
     the shape smoke's VERT lanes already print (`N gating row(s), N known-issue row(s)`) and that
     `drop` and `cull` use above - and the day the term lands it becomes a plain ok row with no CI and
     no workflow edit. It is NOT allowed to grow, and the floors below are measured, not guessed (all
     cam 1, level 0, SEED 12345 - the configuration CI runs, deterministic to the digit over repeat
     runs of the same build):
       unmodified      edge dL 16.65   lost 37.94%   <- the recorded debt, printed KNOWN, exit 0
       TINT=1          edge dL 15.95   lost 41.44%   drops the per-individual colour jitter: a neutral
                                                   repaint, so still the debt rather than a regression
       TINT=2          edge dL 15.15   lost 43.77%   halves the body's light headroom: a real loss of
                                                   separation, and it trips BOTH floors
       TINT=0, DARKRING edge dL 37     lost 0-1%     pays the debt: the row turns back into a plain ok
     Hence the rule "the debt may not grow on either axis": recorded minus 1 dL, recorded plus 4 points
     of lost. The dL axis separates TINT=1 from TINT=2 (0.30 / 0.50 of margin) and the lost axis
     agrees with it on every state measured here, so the verdict does not rest on one number's rounding.
     cam 0 and cam 2 are NOT debt rows - they read - and they keep failing outright.

     #188 SPLITS THAT OBJECT IN TWO, because on the volume branch the body in cam 1's shot is no longer
     necessarily a body the GAME placed, and "the debt is paid" cannot be allowed to mean "the probe
     found somewhere to stand a body". The two debts are:
       FOUND  (DEBT below, unchanged to the digit) the frame with every body where the game put it, the
              frame those floors were recorded against. It runs ONLY when the march says a found body
              is in the cone; when it does not, the row reports #189 instead of pretending to measure.
       POSED  (POSE_FLOOR below) the frame with only the body the probe parked in the clear. Same
              camera, same cell, same yaw, different reason for the number: it says what a body the
              player could actually see looks like, and it is NOT evidence about #179's term.
       FOUND  (DEBT below on the cell those floors were recorded on; the measured floor elsewhere) the
              frame with every body where the game put it. It runs ONLY when the march says a found body
              is in the cone; when it does not, the row reports #189 instead of pretending to measure.
       POSED  (POSE_FLOOR below) the frame with only the body the probe parked in the clear. Same
              camera, same cell, same yaw, different reason for the number: it says what a body the
              player could actually see looks like, and it is NOT evidence about #179's term.
     THAT IS A GATE CHANGE AND IT IS PRINTED, NOT LABELLED AWAY: on the CI cell under FLAT=1 the FOUND
     frame reads 44 dL / 14% lost and the POSED frame 35 dL / 15% (both measured on this branch), where
     the same camera banded and unposed measures 16.65 - so a single row that accepted either body would
     report #179 PAID with no shading term landing anywhere, just by moving the body into the light.
     Only the FOUND row can say #179 is paid; the POSED row's ok is labelled posed and says so. */
  const DEBT = { cam: 1, issue: '#179', dl: 16.65, lost: 37.94, dlFloor: 15.65, lostCeil: 41.94 };
  /* The distance floor the pose honours - min(3.5, max(POSEFLOOR, 0.7 x clear)) - and therefore the
     number the #189 conditional is measured against. One constant on purpose: the row that says "the
     cone cannot reach the pose floor" and the pose that cannot reach it must read the same value. */
  const POSEFLOOR = 1.2;
  /* The window the POSED/FOUND read rows report #179 in is [floor, gate), floor = max(POSE_FLOOR,
     flatControl - BANDTOL), and both terms are measured, not rounded:
       POSE_FLOOR = one dL under the worst number the sweep of this branch produced anywhere; see the
         measured lists beside the constants below. It is a catastrophe backstop only - the term that
         decides the row is the control.
       BANDTOL     = the most separation the BAND is allowed to cost, from the matched pairs of that
         sweep (same body, same spot, grid at the datum). Measured cost, every value: -4 -1 0 0 +2 +2 +5
         +8, hence 8. See the sweep note beside the constants.
     The control is what makes the window FALSIFIABLE: #179's term is a body-shading term, so if it
     lands and moves the flat layout's number while this row's number stays where it is, the floor
     rises past the number and the row goes RED. "Banded lighting is the cause" is falsified by exactly
     that measurement - and on level 0 it is already false: the flat control reads 21 where the banded
     frame reads 20, so on this level the band costs ~1 dL and the shortfall is the room's own light. */
  /* Floors measured on this branch, not rounded guesses. The sweep is 3 levels x 2 seeds x {crowd,
     POSEONLY} x {banded, grid at the datum} = 24 runs of this probe (N per row below), and the control
     in each weak row is the SAME bodies on the SAME spots with the grid at the datum, rendered in the
     same process - not a FLAT=1 rerun, which re-poses the body at another distance and compares a
     "band effect" that is a distance effect.
       POSED values (cam 1, the posed body alone): 14 14 25 25 35 35 36 36 38 38 39 39 40 40 43 43 43 43,
         N=18 of 24 runs - the other 6 could not pose at all (cone max 0.19 / 0.40 / 0.65 m) and are
         #189 rows, not numbers. min 14 -> POSE_FLOOR 13. lost on those same runs peaks at 42 (the 14 dL
         pair), so POSE_LOSTCEIL 45.
       BANDED values (cam 2's crowd/POSEONLY frames): banded 20 32 24 31 36 15 35 34 24 27, flat 21 37 24
         20 31 37 16 35 22 27 -> min 15 -> BANDED_FLOOR 14; lost peaks at 48 -> BAND_LOSTCEIL 52.
       BAND cost, from the matched pairs of that sweep (banded minus control): -4 -1 0 0 +2 +2 +5 +8, so
         BANDTOL 8. The +8 is cam 2's posed body alone on the raised band (15 against a control of 22);
         the crowd on the same spot loses only 2, because other bodies in the ring lift the control too.
     That list is also the answer to "can the distribution separate banded from unlit": NOT by a
     threshold, but cell by cell through the control. On L0/s7 the posed body reads 14 with a control of
     14 (band cost 0 - that room is unlit, and #179's shading term is the only thing that can move it);
     on L1/s7 cam 2 reads 24 against a control of 20 (the band HELPS). A single global floor could not
     tell those two cells apart; the per-cell control can, which is why the floor is max(backstop,
     control - BANDTOL) and the backstop is only a catastrophe detector. */
  const POSE_FLOOR = 13, POSE_LOSTCEIL = 45, BANDED_FLOOR = 14, BAND_LOSTCEIL = 52, BANDTOL = 8;
  /* The cell #179's floors were recorded against. Everything CI runs is this cell; the other cells of
     the sweep get the same measured floor every other banded row uses, because 15.65 dL was never
     measured on level 1 and calling a 14 there "the debt grew" would be inventing a baseline. */
  const DEBT_CELL = LVL === 0 && SEED === 12345;
  const STRICT = !!process.env.STRICT;
  const PLANE = +run('cfg.plane');                       // camera half-width in dir units: atan() is the half-FOV
  const FOVH = Math.atan(PLANE) * 180 / Math.PI;
  const FOVH_JS = Math.atan(PLANE);                      // the same half-FOV in radians, for the pose fan
  let bad = 0, nrows = 0, known = 0, maskDead = false, tgCams = 0;
  const tgCamsAt = [];
  const noPoseNotes = [];   // #242: per-cam reason a camera posed nothing, so the verdict line NAMES it
  const knownIssues = new Set();   // which issues the KNOWN rows are carrying, in the order they appeared
  // a row that could not measure anything is a FAILURE, never a KNOWN: a row that silently skips is
  // the "probe that cannot fail" this rewrite exists to remove, so vacuity stays out of the debt branch.
  const row = (label, ok, detail, debt) => {
    nrows++;
    const gate = ok || !debt || STRICT;
    console.log('    ' + label.padEnd(46) + (ok ? ' ok  ' : gate ? ' FAIL' : 'KNOWN') + '  ' + detail +
      (ok || !debt ? '' : '  [' + debt + ' debt' + (STRICT ? ', gated by STRICT=1' : '') + ']'));
    if (ok) return;
    if (gate) bad++; else { known++; knownIssues.add(debt); }
  };
  const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const BRAD = 0.35;                       // a body's own radius: the march clears it past its NEAR edge
  /* #242 NAMES the reason a camera yielded no pose. Four different failures used to print as one
     sentence ('the axis march stops at 0.56 m'), which is how cam 1's emptiness came to be quoted as
     if it were a measurement:
       BAND GATE      the march's own slab test - |fz[a]-fz[b]| over one quantum on a boundary with no
                      VB_RAMP/VB_LADDER link - stops the ray, and the pose's exact-band rule then
                      refuses every candidate past the lip. `canEnter` is never consulted here.
       SOLID WALL /   a wall column, or the map border, stops the ray: occlusion, not the band.
       OFF-MAP BORDER
       POSE PATH      candidates WERE placeable (spotPlace > 0) and nothing got posed, or a pose
                      painted no pixels: the probe's own body handling, never a debt.
     The POSE CACHE cannot explain "no pose" - nothing was rasterised, so the cache was never reached -
     and that is said out of the counters (spotPlace, posedPx), not out of prose. */
  const CAUSENAME = { slab: 'BAND GATE', wall: 'SOLID WALL', void: 'OFF-MAP BORDER', clear: 'NOTHING STOPS THE RAY', guard: 'MARCH GUARD' };
  const sgn = (v, n) => (v >= 0 ? '+' : '') + v.toFixed(n);
  const noPoseCause = (g) => {
    if (g.pose) return '';
    const stop = g.clear.toFixed(2) + ' m';
    if (!g.tried) return 'SEARCH NEVER RAN: no living enemy to place, so no candidate was examined';
    if (g.spotPlace > 0) return 'POSE PATH: ' + g.spotPlace + ' of ' + g.tried + ' candidates were placeable and nothing was posed - not the band, not the march, and not the pose cache (no pose existed to rasterise)';
    const gate = g.clearWhy === 'slab' ? 'BAND GATE: the march stops on a ' + sgn(g.clearDz, 2) + ' m slab across the boundary at ' + stop + ', with no ramp or ladder link on it'
      : g.clearWhy === 'wall' ? 'SOLID WALL at ' + stop + ': occlusion, not the band'
        : g.clearWhy === 'void' ? 'OFF-MAP BORDER at ' + stop + ': the ray left the grid'
          : (CAUSENAME[g.clearWhy] || 'NO CAUSE NAMED') + ' at ' + stop;
    return gate + ' - ' + g.coneMax.toFixed(2) + ' m of cone against the ' + POSEFLOOR.toFixed(2) +
      ' m pose floor, ' + g.spotOff + '/' + g.tried + ' candidates on ANOTHER band, ' + g.spotBand +
      ' past a lip, ' + g.spotPlace + ' placeable, pose cache not reached';
  };
  /* The geometry this probe has to ask with. castRayDist stops at SOLID columns only, so it answers
     "visible" for a body standing behind a riser lip that castWalls then hides - cam 1's whole
     vacuity on the volume branch is that (a 1 m ledge at 0.56 m, a body at 2.24 m, #189). This
     mirrors the stop conditions of js/40_render.js's DDA instead: a solid column, or an air->air
     boundary of more than one quantum that no ramp or ladder links. Flat levels take neither branch,
     so there the march is castRayDist by another name. */
  run(`window.__march = function (ox, oy, rx, ry, maxD) {
    let mx = ox | 0, my = oy | 0, px = mx, py = my;
    const ddx = Math.abs(1 / (rx || 1e-9)), ddy = Math.abs(1 / (ry || 1e-9));
    let stepX, stepY, sdx, sdy;
    if (rx < 0) { stepX = -1; sdx = (ox - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - ox) * ddx; }
    if (ry < 0) { stepY = -1; sdy = (oy - my) * ddy; } else { stepY = 1; sdy = (my + 1 - oy) * ddy; }
    let side = 0, g = 0;
    while (g++ < 220) {
      let t;
      if (sdx < sdy) { t = sdx; sdx += ddx; mx += stepX; side = 0; } else { t = sdy; sdy += ddy; my += stepY; side = 1; }
      if (mx < 0 || my < 0 || mx >= MW || my >= MH) return { dist: Math.min(t, maxD), why: 'void', dz: 0 };
      if (t > maxD) return { dist: maxD, why: 'clear', dz: 0 };
      const i = my * MW + mx;
      if (MAP.cell[i]) return { dist: t, why: 'wall', dz: 0 };
      const d = side === 0 ? (stepX > 0 ? 0 : 2) : (stepY > 0 ? 1 : 3);
      const pi = py * MW + px, dq = MAP.fz[i] - MAP.fz[pi];
      // #242: dz names HOW MUCH band the gate that stopped this ray is worth, in metres, so a
      // "no pose" verdict can say which gate refused rather than leaving the reader to guess.
      if ((dq > 1 || dq < -1) && !(MAP.vb[pi] & ((VB_RAMP | VB_LADDER) << (d << 2)))) return { dist: t, why: 'slab', dz: dq * ZQ };
      px = mx; py = my;
    }
    return { dist: maxD, why: 'guard', dz: 0 };
  }`);
  console.log('contrast: coverage-mask oracle on level ' + LVL + '  buffer ' + W + 'x' + H +
    (DARKRING ? '  DARKRING' : '') + (NOBODY ? '  NOBODY' : '') +
    (RIM >= 0 ? '  RIM=' + RIM : '') + (isNaN(TINTK) ? '' : '  TINT=' + TINTK) + (POSEONLY ? '  POSEONLY' : '') +
    (FLAT ? '  FLAT(grid forced to the datum before the cameras are set)' : ''));
  console.log('contrast: every camera POSES one body by a geometric march on its own band before it measures '
    + '(cam 2 has always done that; #189 is why all three must) - a body a slab legitimately hides stays '
    + 'hidden, and is counted and named on the occlusion line instead of emptying the mask.');
  console.log('contrast: cam ' + DEBT.cam + "'s read row is SPLIT (#188): a FOUND-body row keeps " + DEBT.issue +
    '\'s recorded floors and is the only row that can say the debt is paid, and a POSED-body row is measured\n' +
    'contrast: against floors taken from a POSEONLY sweep, because a posed body on this same camera and cell reads '
    + 'far above a found one - 44 dL vs ' + DEBT.dl + ' under FLAT=1 - so one row accepting either would report '
    + DEBT.issue + '\n' +
    'contrast: paid with no shading term landing. Rows that cannot measure because the CONE is shallower than a\n' +
    'contrast: body report #189 with the march\'s own bound beside them; rows that cannot measure for any other\n' +
    'contrast: reason are FAILUREs. cam 2\'s banded WEAK reports ' + DEBT.issue + ' with an in-run at-datum control as its\n' +
    'contrast: falsifier, and STRICT=1 promotes every KNOWN row to a hard FAIL.');
  /* #180 puts the rifle in the raster, so it is now part of what a pair of renders must hold FIXED.
     drawViewModel damps its look-lag against wall-clock dt (VM.now = performance.now()), so two
     frames rendered back to back are NOT the same pose - which is fatal here, because this probe's
     oracle IS a pair of renders. Measured with the rig in the frame and at rest never applied:
     cam 1's diff goes 2272 -> 3158 px and cam 2's 431 -> 1231, all of it leak (LEAKMAX is 0), and the
     leak also disqualifies cam 1's debt row, since a row that leaks has not measured the baseline it
     owes. The coverage mask never saw it either way - MESH.draw carries body: 0 for the rig, so tri()
     stamps 0 and the mask stays 999 / 2838 / 431 px, identical to main. Putting the rig at rest before
     BOTH sampled frames removes the cause instead of the symptom and leaves the gun in the picture;
     this is the same REST the viewmodel probe uses for the same reason (#180). VM.ang = P.ang matters
     as much as the zeros: dAng is what the lag damps TOWARD, and after one frame it is already 0. */
  const VMREST = 'if (typeof VM !== "undefined") { VM.ang = P.ang; VM.lag = 0; VM.vy = 0; }';
  for (let cam = 0; cam < 3; cam++) {
    run(`startLevel(${LVL}, true); S.mode='play'; S.locked=false;`);
    if (FLAT) run('MAP.fz.fill(0); MAP.cz.fill(CZ_DEF); linkBoundaries(); for (const e of ENEMIES) e.z = floorAt(e.x, e.y);');
    const camG = run(`(()=>{
      window.__posed = null; window.__looked = null;
      const cs=[];for(let y=1;y<MH-1;y++)for(let x=1;x<MW-1;x++)if(!isSolid(x+.5,y+.5))cs.push([x,y]);
      const c=cs.length?cs[((cs.length*0.31+${cam})|0)%cs.length]:[P.x|0,P.y|0];
      P.x=c[0]+.5;P.y=c[1]+.5;P.pitch=0;P.z=floorAt(P.x,P.y);
      // cam 0 looks down the longest sight line, cam 1 looks AT the nearest enemy, cam 2 parks
      // the nearest enemy 3.5 m in front of the lens: the first measures specks on the horizon,
      // the last measures the silhouette at the size a player actually has to read it.
      if (${cam} === 1 && ENEMIES.length) {
        let be=null,bd=1e9;
        for(const e of ENEMIES){if(e.state==='dead')continue;const d=Math.hypot(e.x-c[0]-.5,e.y-c[1]-.5);if(d<bd){bd=d;be=e;}}
        if(be){P.ang=Math.atan2(be.y-P.y,be.x-P.x);window.__looked=be;}
      } else {
        let best=0,bd=-1;
        for(let k=0;k<48;k++){const a=k*Math.PI/24;
          const d=castRayDist(c[0]+.5,c[1]+.5,Math.cos(a),Math.sin(a),9).dist;
          if(d>bd){bd=d;best=a;}}
        P.ang=best;
      }
      /* POSE (all three cams, cam 2's mechanism generalised): walk from the lens with the renderer's
         own stop conditions and park one body in the clear, on the camera's OWN band, at the distance
         cam 2 has always used - min(3.5, max(1.2, 0.7 x clear)). A candidate that lands in a wall, in
         a pit or past a riser lip is refused and the previous one tried, 0.12 m at a time. If the
         view RAY has no room for a body at all - cam 1 on the volume branch stands 0.56 m from a
         riser lip, which is less than a body's own radius - the search fans over the frustum it is
         already looking through, axis first and then symmetrically to 60% of the half-FOV, so the
         camera's cell, its yaw and its distance convention all stay exactly as they were and the only
         thing that moved is the body. On a flat grid the march is castRayDist by another name and the
         axis candidate is the one cam 2 used to take, so a flat level reposes nothing it posed honestly.
         On a cam that picked a body to look at, that body is left where it is when there is another
         to spend, so the occlusion a ledge causes stays in the frame AND in the line below. */
      let poseD = 0, poseWhy = 'no enemies in the level', clear = 0, poseOff = 0, poseClear = 0;
      let clearWhy = 'clear', clearDz = 0; const spots = [];
      /* coneMax = the furthest the SAME __march lets a body stand at all (clear minus its own radius,
         best over the rays the search samples) - the bound the #189 conditional is read from, so it
         cannot be inflated without changing the march that places bodies, and the row that prints it
         goes red rather than known if someone inflates it. The three counters are the census of what
         the search refused, and all three are needed because "the cone is 0.4 m deep" and "the search
         never ran" look the same from coneMax alone: tried counts every candidate point examined,
         offBand counts those in a wall or on ANOTHER band (the raised quadrant past a lip - cam 1 on
         the CI cell, where every candidate is off-band, not merely past a lip), pastLip counts those
         on the band but beyond the march, and placeable is what the whole test accepted - a pose that
         fails with placeable > 0 failed for a body-handling reason, not #189. */
      let coneMax = 0, spotTried = 0, spotBand = 0, spotPlace = 0, spotOff = 0;
      const alive = ENEMIES.reduce((n, q) => n + (q.state !== 'dead' ? 1 : 0), 0);
      const band = floorAt(P.x, P.y);
      if (ENEMIES.length) {
        const cx0 = Math.cos(P.ang), cy0 = Math.sin(P.ang);
        const axq = __march(P.x, P.y, cx0, cy0, 8);
        clear = axq.dist; clearWhy = axq.why; clearDz = axq.dz;
        const spread = ${FOVH_JS} * 0.6 / 5;              // 5 steps reaches 60% of the half-FOV, well inside the frame
        const victim = () => ENEMIES.find(q => q.state !== 'dead' && q !== window.__looked) ||
          ENEMIES.find(q => q.state !== 'dead');
        for (let w = 0; w < 11 && !poseD; w++) {
          const s = w === 0 ? 0 : (w & 1 ? (w + 1) >> 1 : -((w + 1) >> 1));
          const a = P.ang + s * spread, cx = Math.cos(a), cy = Math.sin(a);
          const cl = w === 0 ? clear : __march(P.x, P.y, cx, cy, 8).dist;
          if (cl - ${BRAD} > coneMax) coneMax = cl - ${BRAD};
          for (let d = Math.min(3.5, Math.max(${POSEFLOOR}, cl * 0.7)), k = 0; k < 30 && d >= ${POSEFLOOR}; k++, d -= 0.12) {
            const bx = P.x + cx * d, by = P.y + cy * d;
            const bz = floorAt(bx, by), solid = isSolid(bx, by);
            const onBand = !solid && Math.abs(bz - band) <= 1e-6;
            spotTried++;
            /* #242: the census of what the search refused, printed per spot so the next session does
               not re-try this lane. dz is the band delta of the SPOT itself (floorAt there minus the
               camera's own band) - the one number that says "off band" instead of "refused". */
            if (spots.length < 44) spots.push({ ray: w, deg: (a - P.ang) * 180 / Math.PI, cl: cl, d: d,
              dz: bz - band, why: solid ? 'solid' : (bz - band !== 0 ? 'off-band' : (d > cl - ${BRAD} ? 'past-lip' : 'placeable')) });
            if (!onBand) { spotOff++; continue; }
            if (d > cl - ${BRAD}) { spotBand++; continue; }
            spotPlace++;
            const e = victim();
            if (!e) { poseWhy = 'every body is dead'; break; }
            window.__foundPos = { x: e.x, y: e.y, z: e.z, ang: e.ang };
            window.__poseSpot = { x: bx, y: by, z: floorAt(bx, by), ang: a + Math.PI };
            e.x = bx; e.y = by; e.z = floorAt(bx, by); e.ang = a + Math.PI; e.movingAmt = 0;
            window.__posed = e; poseD = d; poseOff = a - P.ang; poseClear = cl; poseWhy = 'posed'; break;
          }
        }
        if (!poseD && poseWhy === 'no enemies in the level') poseWhy = 'no clear spot on the camera band at the ' + ${POSEFLOOR} + ' m floor or beyond, within 60% of the frustum (the axis march stops at ' + clear.toFixed(2) + ' m)';
      }
      for(const e of ENEMIES)e.state='sleep';
      return {n:ENEMIES.length, pose:poseD, why:poseWhy, clear:clear, band:band, off:poseOff, poseClear:poseClear,
        coneMax:coneMax, spotBand:spotBand, spotPlace:spotPlace, spotOff:spotOff, tried:spotTried, alive:alive,
        clearWhy:clearWhy, clearDz:clearDz, spots:spots};
    })()`);
    // arm the mask (null in play; this probe is its only caller) and any shading control
    run('if (!COV || COV.length !== BW * BH) COV = new Uint8Array(BW * BH);');
    /* What the renderer can see of every body, asked per body with the march above rather than
       guessed from the mask: `inF` is the centre test against the camera's half-FOV, `stop` is where
       the first solid column or riser lip cuts the sight line, `vis` says the sight line got past the
       body's NEAR edge (BRAD in). A dead body is not a body to measure and is skipped. */
    const bodies = run(`(()=>{const o=[],cx=Math.cos(P.ang),cy=Math.sin(P.ang);
      for(const e of ENEMIES){if(e.state==='dead')continue;
        const dx=e.x-P.x,dy=e.y-P.y,d=Math.hypot(dx,dy);
        const fw=dx*cx+dy*cy,lat=cfg.plane*(dy*cx-dx*cy);
        const inF=d>0.01&&fw>0.2&&Math.abs(lat)<=fw;
        const m=inF?__march(P.x,P.y,dx/d,dy/d,d):{dist:d,why:'outside'};
        o.push({d:d,inF:inF?1:0,stop:m.dist,why:m.why,vis:(inF&&m.dist>d-${BRAD})?1:0,posed:e===window.__posed?1:0});
      }return o})()`);
    if (RIM >= 0) run('RIG.setRim(' + RIM + ')');
    if (!isNaN(TINTK)) run('for (const e of ENEMIES) e.tint = [' + TINTK + ',' + TINTK + ',' + TINTK + '];');
    run('window.__keep = ENEMIES.slice();');
    if (NOBODY) run('ENEMIES.length = 0;');
    if (POSEONLY) run('for (let i = ENEMIES.length - 1; i >= 0; i--) if (ENEMIES[i] !== window.__posed) ENEMIES.splice(i, 1);');
    run('S.t = 3.5; ' + VMREST + ' renderWorld()');
    const A = new Uint32Array(run('px')), M = new Uint8Array(run('COV'));
    // the cross-check frame: the same world with the bodies out, which is what the OLD mask was.
    // Its coverage is the empty-mask control - the cast is out of the scene it rendered.
    run('ENEMIES.length = 0; ' + VMREST + ' renderWorld();');
    const B = new Uint32Array(run('px')), MB = new Uint8Array(run('COV'));
    run('ENEMIES.length = 0; for (const q of __keep) ENEMIES.push(q);');
    /* The pose corroborated by PIXELS: the frame with ONLY the posed body in it. "The camera has a
       body it can see" must not be satisfied by whatever else happened to be standing in the shot,
       and "the march calls it clear" has to be checkable against what the draw path made of that.
       The same frame is what the POSED read row measures, so #188's floors and this pixel count come
       off one render and one mask - the row cannot disagree with the pose row about what is in frame. */
    let posedPx = -1, posedSt = null, otherPx = 0;
    if (!NOBODY && camG.pose) {
      run('ENEMIES.length = 0; if (window.__posed) ENEMIES.push(window.__posed); ' + VMREST + ' renderWorld();');
      const PF = new Uint32Array(run('px')), MP = new Uint8Array(run('COV'));
      posedPx = nCover(MP);
      posedSt = edgeOf(PF, MP, ringOf(MP));
      posedSt.px = posedPx;
      // pixels the CROWD frame has that the posed body alone cannot account for = some other body drew
      for (let i = 0; i < N; i++) if (M[i] && !MP[i]) otherPx++;
      run('ENEMIES.length = 0; for (const q of __keep) ENEMIES.push(q);');
    }
    /* The FOUND frame: every body back where the GAME put it, including the one this camera moved.
       That is the frame #179's floors were recorded against and the only frame allowed to say the debt
       is paid (#188's gate change: a posed body reads 44 dL on the cell where a found one reads 16.65,
       so one row accepting either would report #179 paid with no term landing). The march is asked
       again HERE, after the positions are restored, because "is a found body in the cone" is a question
       about the found frame - and when it says no, the row reports #189 with the cone bound instead of
       measuring an empty shot. */
    let foundN = -1, foundSt = null, foundVis = 0, foundIn = 0, foundStop = -1;
    const ctlCache = {};
    const control = (which) => ctlCache[which] || (ctlCache[which] = flatCtl(which));
    /* Re-render the FOUND frame from scratch and measure it: every body back on the spot the game put it
       on, same S.t, rig at rest. The FOUND row compares what it is about to report against this, so the
       row cannot be handed the posed frame (or any other frame) and print an ok: the pixels have to agree
       with the claim, and the probe is deterministic enough for them to agree exactly. */
    const foundStatsNow = () => {
      run('if (window.__posed && window.__foundPos) { const p = window.__posed, f = window.__foundPos;'
        + ' p.x = f.x; p.y = f.y; p.z = f.z; p.ang = f.ang; } S.t = 3.5; ' + VMREST + ' renderWorld();');
      const XF = new Uint32Array(run('px')), XC = new Uint8Array(run('COV'));
      const st = edgeOf(XF, XC, ringOf(XC));
      st.px = nCover(XC);
      run('if (window.__posed && window.__poseSpot) { const p = window.__posed, s = window.__poseSpot;'
        + ' p.x = s.x; p.y = s.y; p.z = s.z; p.ang = s.ang; }');
      return st;
    };
    if (!NOBODY && cam === DEBT.cam) {
      const fq = run(`(()=>{if(window.__posed&&window.__foundPos){const p=window.__posed,f=window.__foundPos;
          p.x=f.x;p.y=f.y;p.z=f.z;p.ang=f.ang;}
        const cx=Math.cos(P.ang),cy=Math.sin(P.ang);let n=0,k=0,stop=1e9;
        for(const e of ENEMIES){if(e.state==='dead')continue;
          const dx=e.x-P.x,dy=e.y-P.y,d=Math.hypot(dx,dy);
          const fw=dx*cx+dy*cy,lat=cfg.plane*(dy*cx-dx*cy);
          if(!(d>0.01&&fw>0.2&&Math.abs(lat)<=fw))continue;
          const m=__march(P.x,P.y,dx/d,dy/d,d);k++;if(m.dist>d-${BRAD})n++;if(m.dist<stop)stop=m.dist;}
        return {n:n,k:k,stop:stop>1e8?-1:stop}})()`);
      foundVis = fq.n; foundIn = fq.k; foundStop = fq.stop;
      if (foundVis) {
        run('S.t = 3.5; ' + VMREST + ' renderWorld();');
        const CF = new Uint32Array(run('px')), MC = new Uint8Array(run('COV'));
        foundN = nCover(MC);
        foundSt = edgeOf(CF, MC, ringOf(MC));
        foundSt.px = foundN;
        // the falsifier for THIS frame, taken while every body is still on its FOUND spot
        if (!(foundSt.dl >= DLMIN && foundSt.lost <= LOSTMAX)) control('found');
      }
    }
    // put the posed body back on its pose spot, so the posed control below matches the posed frame above
    if (!NOBODY && camG.pose) run('if (window.__posed && window.__poseSpot) { const p = window.__posed, s = window.__poseSpot;'
      + ' p.x = s.x; p.y = s.y; p.z = s.z; p.ang = s.ang; }');
    /* THE FALSIFIER, in-run: the SAME bodies on the SAME spots with the grid at the datum. It is asked
       only for a frame that came in WEAK, and it is the measurement that decides whether "banded
       lighting is the cause" survives - #179's term is a body-shading term, so a term that moves this
       control and leaves the banded number where it is pushes the row's floor over the number and the
       row goes red. Flattening here rather than re-running with FLAT=1 matters: FLAT=1 flattens before
       the cameras are set, so it also RE-POSES the body at another distance (measured on L1/12345 cam 2:
       2.45 m banded vs 3.50 m flat, a -10 dL "band effect" that is a distance effect). */
    function flatCtl(which) {
      run('window.__fzS = MAP.fz.slice(); window.__czS = MAP.cz.slice();'
        + ' MAP.fz.fill(0); MAP.cz.fill(CZ_DEF); linkBoundaries(); for (const e of ENEMIES) e.z = floorAt(e.x, e.y);');
      if (which === 'posed') run('ENEMIES.length = 0; if (window.__posed) ENEMIES.push(window.__posed);');
      run('S.t = 3.5; ' + VMREST + ' renderWorld();');
      const FF = new Uint32Array(run('px')), MF = new Uint8Array(run('COV'));
      const st = edgeOf(FF, MF, ringOf(MF));
      st.px = nCover(MF);
      /* A control that leaves the LEVEL flat is not a control, it is the next row's world: restore the
         grid the level generated (and every body's z on it) before returning, so nothing measured after
         this silently measures the datum. startLevel in the NEXT camera iteration is not the fix - it
         would only hide the leak on the cameras that come later. */
      run('MAP.fz.set(window.__fzS); MAP.cz.set(window.__czS); linkBoundaries();'
        + ' ENEMIES.length = 0; for (const q of __keep) ENEMIES.push(q); for (const e of ENEMIES) e.z = floorAt(e.x, e.y);');
      return st;
    }
    if (!NOBODY && posedSt && !(posedSt.dl >= DLMIN && posedSt.lost <= LOSTMAX)) control('posed');
    let nMB = 0;
    for (let i = 0; i < N; i++) if (MB[i]) nMB++;
    // ---- the occlusion tally (#189): named, counted, reported - not swallowed into a zero mask ----
    const inFr = bodies.filter(b => b.inF), visB = inFr.filter(b => b.vis), hidB = inFr.filter(b => !b.vis);
    const slabB = hidB.filter(b => b.why === 'slab'), obstB = hidB.filter(b => b.why !== 'slab');
    const posedB = bodies.find(b => b.posed);
    const badBlock = hidB.filter(b => !(b.stop < b.d)).length;
    // ---- coverage mask + edge ring (8-neighbourhood) ----
    const ring = [];
    let nM = 0;
    for (let y = 1; y < H - 1; y++) {
      const r = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = r + x;
        if (!M[i]) continue;
        nM++;
        if (M[i - 1] && M[i + 1] && M[i - W] && M[i + W] && M[i - W - 1] && M[i - W + 1] && M[i + W - 1] && M[i + W + 1]) continue;
        ring.push(i);
      }
    }
    if (DARKRING) for (const i of ring) A[i] = 0xFF000000;      // a contour term, hand-painted
    let eDL = 0, eRGB = 0, lost = 0, noBg = 0, bDL = 0;
    for (let t = 0; t < ring.length; t++) {
      const i = ring[t], vals = [], idxs = [];
      for (const o of NB) { const j = i + o[1] * W + o[0]; if (!M[j]) { vals.push(lum(A, j)); idxs.push(j); } }
      if (!vals.length) { noBg++; continue; }
      const srt = vals.slice().sort((p, q) => p - q);
      const med = srt.length & 1 ? srt[srt.length >> 1] : (srt[(srt.length >> 1) - 1] + srt[srt.length >> 1]) * 0.5;
      let k = 0, bk = 1e18;
      for (let u = 0; u < vals.length; u++) { const d = Math.abs(vals[u] - med); if (d < bk) { bk = d; k = u; } }
      const j = idxs[k], dl = Math.abs(lum(A, i) - med);
      eDL += dl; eRGB += (Math.abs((A[i] & 255) - (A[j] & 255)) + Math.abs((A[i] >> 8 & 255) - (A[j] >> 8 & 255)) +
        Math.abs((A[i] >> 16 & 255) - (A[j] >> 16 & 255))) / 3;
      if (dl < DLLOST) lost++;
    }
    for (let i = 0; i < N; i++) if (M[i]) bDL += Math.abs(lum(A, i) - lum(B, i));
    // ---- the OLD rule, kept as a cross-check on the same pixels ----
    const cov = new Uint8Array(N);
    let oCover = 0, oSum = 0, oEdge = 0, oEn = 0, oLost = 0, oRGB = 0, leak = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(lum(A, i) - lum(B, i));
      if (d > DLR || (A[i] >>> 24) - (B[i] >>> 24) !== 0) { cov[i] = 1; oCover++; oSum += d; if (!M[i]) leak++; }
    }
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!cov[i] || (cov[i - 1] && cov[i + 1] && cov[i - W] && cov[i + W])) continue;
      const j = cov[i - 1] ? i + 1 : cov[i + 1] ? i - 1 : cov[i - W] ? i + W : i - 1;
      const dl = Math.max(Math.abs(lum(A, i) - lum(B, j)), Math.abs(lum(A, j) - lum(A, i)));
      oEdge += dl; oEn++;
      if (Math.abs(lum(A, i) - lum(B, j)) < DLLOST) oLost++;
      oRGB += (Math.abs((A[i] & 255) - (B[j] & 255)) + Math.abs((A[i] >> 8 & 255) - (B[j] >> 8 & 255)) +
        Math.abs((A[i] >> 16 & 255) - (B[j] >> 16 & 255))) / 3;
    }
    const ghost = nM - (oCover - leak);                          // drawn, and invisible in the diff
    const pct = v => (100 * v / N).toFixed(1) + '%';
    const f = (v, n) => (v ? (v / n).toFixed(0) : '0');
    const enring = ring.length - noBg;
    const covDL = nM ? bDL / nM : 0, edgeDL = enring ? eDL / enring : 0, edgeRGB = enring ? eRGB / enring : 0;
    const lostPct = enring ? 100 * lost / enring : 0;
    const verdict = !nM ? 'NO COVERAGE - the mask has no body in it'
      : nM < MINMASK ? 'TOO SMALL - ' + nM + ' mask px is below the ' + MINMASK + ' px floor'
      : !enring ? 'NO RING - nothing to sample'
      : edgeDL < DLMIN || lostPct > LOSTMAX ? 'WEAK - silhouettes merge into the room' : 'READS';
    console.log('cam ' + cam + '  ' + W + 'x' + H + (camG.pose ? '  POSED body at ' + camG.pose.toFixed(2) +
      ' m on band ' + camG.band.toFixed(2) + ' (pose ray clear to ' + camG.poseClear.toFixed(2) + ' m' +
      (Math.abs(camG.off) > 1e-6 ? ', ' + (camG.off * 180 / Math.PI).toFixed(1) + ' deg off the axis, whose march stops at ' + camG.clear.toFixed(2) + ' m' : ', axis march clear to ' + camG.clear.toFixed(2) + ' m') + ')'
      : '  NO POSE [' + (camG.pose ? '' : camG.spotPlace > 0 ? 'POSE PATH' : !camG.tried ? 'NO ENEMY' : CAUSENAME[camG.clearWhy] || 'UNKNOWN') + ']: ' + camG.why) + (PIXHASH ? '  frame ' + (() => {
      let h = 2166136261;
      for (let i = 0; i < N; i += 7) h = ((h ^ A[i]) * 16777619) >>> 0;
      return (h >>> 0).toString(16);
    })() : ''));
    console.log('  coverage   cover ' + pct(nM) + '  body dL ' + f(bDL, nM) + '  edge dL ' + f(eDL, enring) +
      '  edge dRGB ' + f(eRGB, enring) + '  lost ' + lostPct.toFixed(0) + '%   ' + verdict);
    console.log('  diff-mask  cover ' + pct(oCover) + '  body dL ' + f(oSum, oCover) + '  edge dL ' + f(oEdge, oEn) +
      '  edge dRGB ' + f(oRGB, oEn) + '  lost ' + (oEn ? (100 * oLost / oEn).toFixed(0) : '0') + '%' +
      '   (cross-check, the pre-#179 rule on these same pixels)');
    console.log('  masks      coverage ' + nM + ' px vs diff ' + oCover + ' px  |  drawn-but-invisible ' +
      ghost + ' px  |  diff-not-covered (leak) ' + leak + ' px  |  ring ' + enring + ' of ' + ring.length +
      (noBg ? ' (' + noBg + ' with no outside neighbour)' : ''));
    /* Informational, and tied to #189: a body on the band above a camera can be hidden COMPLETELY by
       a ledge the wall pass is right to draw, and `cull` asserts that geometry, so this is not a
       failure - it is the reason the body below is posed. The numbers are the shape #189 was filed
       with: how far the body is, and how much nearer the thing in front of it is. */
    const named = b => b.map(q => 'body ' + q.d.toFixed(2) + ' m / block ' + q.stop.toFixed(2) + ' m').join(', ');
    console.log('  occlusion  ' + inFr.length + ' of ' + bodies.length + ' bodies in the +' + FOVH.toFixed(1) +
      ' deg half-frustum: ' + visB.length + ' in the clear, ' + slabB.length + ' hidden by slab/band geometry' +
      (slabB.length ? ' [' + named(slabB.slice(0, 4)) + (slabB.length > 4 ? ', +' + (slabB.length - 4) : '') + ']' : '') +
      (obstB.length ? ', ' + obstB.length + ' behind a wall' : '') +
      '   reporting only, not gated: #189');
    /* ---- #244 THE TORSO'S OWN GRADIENT, on this composited frame, with its three controls -------
       The frame is re-rendered here (same S.t, rig at rest) and counted against the pixels the
       coverage line above described, because this row CLAIMS to be about that frame - a row handed
       some other frame is the failure #232's numbers already had, and the re-render agreement makes it
       checkable rather than promised. TB is the same shot turned 0.03 rad: the boil half of #232's
       requirement, measured by pixels instead of by folklore. */
    run('S.t = 3.5; ' + VMREST + ' renderWorld();');
    const TA = new Uint32Array(run('px')), TM = new Uint8Array(run('COV'));
    const TGL = run('ENEMIES.map(e => ({k: e.kind, x: e.x, y: e.y, z: e.z, s: e.scale, dead: e.state === "dead" ? 1 : 0}))');
    const TGC = run('({camX, camY, dirX, dirY, planeX, planeY, eyeZ, hz: horizon, BW, BH})');
    let tgSamePx = 0;
    for (let i = 0; i < N; i++) if (TA[i] !== A[i]) tgSamePx++;
    const tgAng = run('P.ang');
    run('P.ang += 0.03; S.t = 3.5; ' + VMREST + ' renderWorld();');
    const TB = new Uint32Array(run('px'));
    run('P.ang = ' + tgAng + ';');
    const tstat = torsoStats(TA, TM, TGL, TGC, TB);
    const tgMean = Math.abs(tstat.bandMean - tstat.silMean);
    if (tstat.px >= TG_MINPX) { tgCams++; tgCamsAt.push(cam); }
    console.log('  torso      ' + (tstat.px ? 'grad ' + tstat.grad.toFixed(2) + ' dL/px on ' + tstat.px +
      ' interior torso px' : 'NOT MEASURED - no torso pixel cleared the 2 px interior cushion') +
      '  |  room ' + tstat.room.toFixed(2) + ' on ' + tstat.roomN + ' px (ratio ' +
      (tstat.room ? (tstat.grad / tstat.room).toFixed(2) : '-') + ')  |  band mean ' + tstat.bandMean.toFixed(1) +
      ' vs body mean ' + tstat.silMean.toFixed(1) + '  |  limb band ' + tstat.limbGrad.toFixed(2) + ' dL/px'
      + ' (not a gradient control - faceted tubes, 2.8-11.6 dL/px with no term in the tree)  |  DC '
      + tstat.bias.toFixed(2) + " after the frame's own " + tstat.roomBias.toFixed(2) + '  |  boil 0.03 rad torso '
      + tstat.boil.toFixed(2) + ' / limbs ' + tstat.limbBoil.toFixed(2) +
      (tstat.grad ? ' (noise per unit structure ' + (tstat.boil / tstat.grad).toFixed(2) + ')' : '') +
      ' / limbs ' + tstat.limbBoil.toFixed(2) + '  |  px rejected for sitting in the ring ' + tstat.rej +
      '  |  re-render vs the frame above: ' + tgSamePx + ' px differ');
    console.log('             gradient per body the mesh drew - kind, distance, interior torso px, dL/px, boil: ' +
      (tstat.per.length ? tstat.per.map(q => q.k + (q.dead ? '/dead' : '') + ' ' + q.d.toFixed(2) + ' m ' +
        (q.px ? q.px + ' px @ ' + q.g.toFixed(2) + ' (boil torso ' + q.boil.toFixed(2) + ' / limbs ' + q.lboil.toFixed(2) + ')' : (q.why || 'no interior torso px'))).join(', ') : 'no body in the frame') +
      '   [' + TG_MARK + ']');
    /* TWO ROWS ABOUT THE FRAME BEFORE ANY CONTRAST IS MEASURED, both stated as POSED because a body
       the probe put in the shot is not evidence that the game's own placement is readable:
         the pose row is the guarantee this probe needs to measure anything at all - one body the
           march says is in the clear, on the camera's own band, painting pixels of its own.
         the accounting row is #189 turned into a number: every body in the frustum is either in the
           clear or named as hidden, the two add up to the count, and a hidden one is block-nearer
           than it is body-farther. That a body IS hidden never fails this row (the slab is correct);
           a hidden body being uncounted, or nothing being left to measure, does. */
    /* #189 is a GEOMETRIC reason for having nothing to measure, and it must be proven by the same march
       that places the bodies rather than by a number written next to the row: coneMax is how far ANY
       sampled ray of this frustum lets a body stand at all (its march distance minus the body's own
       radius), spotBand counts on-band candidates the march refused at a lip. Cone max below the pose
       floor with refusals above zero means "this cone is shallower than a body" - #189, a KNOWN row.
       At or above the floor, a spot existed and the pose failed anyway: that is a bug in this probe and
       stays RED. It is also why inflating the bound cannot rescue the row - the inflation has to be made
       in __march's own answer, which is the value the pose is placed with. */
    /* Is the COVERAGE MASK ALIVE? The diff mask (A vs B) does not depend on COV at all, so a run where
       a body moved pixels but coverage says nothing did is a dead mask, not an empty scene. Cam 0 is
       measured first, so by the time cam 1's rows print this is known, and without it a mask that
       stopped stamping would be reported as #189 on the one camera whose cone is also shallow - a broken
       instrument wearing a known-issue label, which is the exact shape this probe exists to refuse. */
    if (nM === 0 && oCover > 0) maskDead = true;
    /* #242 splits the two reasons a camera yields no pose, because they are not the same verdict:
         NO ENEMY IN REACH   the LEVEL's geometry leaves this cone shallower than a body AND the frame
                             agrees - not one body pixel was painted. That is #189 part 2's debt (an
                             enemy on the band above is not visible or placeable from the datum): real,
                             reported, and a KNOWN row, because making it red makes CI red forever and a
                             permanently-red row teaches everyone to ignore the rows that mean something.
         NO POSE WITH A BODY IN FRAME
                             a living enemy is in the world and the coverage mask sees a body's draw,
                             yet the search rasterised no pose. The shot is measurable while the probe
                             says it is not - a regression, a FAILURE, an exit code. (A mask that stopped
                             stamping is the third branch and was already red, via maskDead.) */
    const bodyInFrame = nM > 0;
    const noPoseBad = !camG.pose && !NOBODY && camG.alive > 0 && bodyInFrame;
    const nearDz = (() => {
      const sp = (camG.spots || []).filter(s => s.why === 'off-band' || s.why === 'past-lip' || s.why === 'solid');
      if (!sp.length) return null;
      let b = sp[0];
      for (const s of sp) if (s.d < b.d) b = s;
      return b.dz;
    })();
    const m189 = !camG.pose && camG.coneMax < POSEFLOOR && camG.tried > 0 && !NOBODY && !maskDead && !bodyInFrame;
    const boundTxt = (m189 ? 'NO ENEMY IN REACH at cam ' + cam + ': ' : noPoseBad ? 'NO POSE WITH A BODY IN FRAME at cam ' + cam + ': ' : '') +
      'axis march stops at ' + camG.clear.toFixed(2) + ' m' +
      (camG.tried && !camG.pose ? ' (' + (CAUSENAME[camG.clearWhy] || camG.clearWhy) + ')' : '') + ', cone max ' + camG.coneMax.toFixed(2) +
      ' m against the ' + POSEFLOOR.toFixed(2) + ' m pose floor: ' + camG.tried + ' spot(s) examined in the frustum, ' +
      camG.spotOff + ' off the band, ' + camG.spotBand + ' past a lip, ' + camG.spotPlace + ' placeable' +
      (nearDz === null ? '' : ', nearest candidate ' + sgn(nearDz, 2) + ' m off this band');
    /* #242: a camera that poses nothing says WHY once, in one named sentence, and then lists what it
       refused so the next session does not re-try the same lane (#226's seat census is the model: the
       rejects get printed, so they stop being re-counted as news). */
    if (!camG.pose && camG.tried) {
      noPoseNotes.push('cam ' + cam + ' ' + (m189 ? 'NO ENEMY IN REACH' : noPoseBad ? 'NO POSE WITH A BODY IN FRAME' : 'NO POSE') +
        ' = ' + (camG.spotPlace > 0 ? 'POSE PATH (' + camG.spotPlace + ' placeable, none posed)'
          : (CAUSENAME[camG.clearWhy] || 'UNKNOWN') + ' at ' + camG.clear.toFixed(2) + ' m, '
            + camG.spotOff + '/' + camG.tried + ' candidates off band' + (nearDz === null ? '' : ', nearest ' + sgn(nearDz, 2) + ' m')));
      console.log('  no-pose    ' + (m189 ? 'NO ENEMY IN REACH - reported, not gated (#189 part 2: an enemy on the band above is not placeable from this seat)'
        : noPoseBad ? 'NO POSE WITH A BODY IN FRAME - a REGRESSION, not the #189 debt: ' + nM + ' px of body in the shot while the search posed nothing'
          : maskDead ? 'the coverage mask itself is dead (see the mask rows), so #189 cannot be blamed for this cam'
            : 'not #189: ' + camG.why) + '  |  ' + noPoseCause(camG));
      if (camG.spots && camG.spots.length) {
        console.log('             ' + camG.tried + ' candidate spot(s) examined from this lens, ' + camG.spotPlace +
          ' placeable - the rejects, so nobody re-tries them:');
        for (const s of camG.spots) console.log('               ray ' + String(s.ray).padStart(2) +
          (s.deg >= 0 ? '  +' : '  ') + s.deg.toFixed(1) + ' deg off axis   that ray clear to ' + s.cl.toFixed(2) +
          ' m   spot at ' + s.d.toFixed(2) + ' m   band ' + sgn(s.dz, 2) + ' m   ' + s.why.toUpperCase());
      }
    }
    /* Every row below that needs a body IN THE FRAME is vacuous on this camera for the same geometric
       reason, and vacuity here is not the silent skip the row() note forbids: it is conditional on a
       measured bound (coneMax < the floor the pose uses, from __march itself), it prints that bound, and
       cam 0 and cam 2 stay hard gates, so a mask that stopped working at the source still goes red on
       the cameras whose cone is deep. A row that failed for a reason other than nothing drawing - a mask
       that counts the ROOM, a partition that does not add up - is never labelled. */
    const m189vac = m189 && nM === 0;
    const poseOk = camG.pose > 0 && !!posedB && !!posedB.vis && posedPx >= MINMASK;
    row('cam ' + cam + ' has a POSED body it can see', poseOk,
      camG.pose ? 'POSED at ' + camG.pose.toFixed(2) + ' m on band ' + camG.band.toFixed(2) +
        (Math.abs(camG.off) > 1e-6 ? ', ' + (camG.off * 180 / Math.PI).toFixed(1) + ' deg off the axis (which stops at ' + camG.clear.toFixed(2) + ' m)' : '') +
        ', pose ray clear to ' + camG.poseClear.toFixed(2) + ' m, paints ' + posedPx + ' px alone (floor ' + MINMASK + ')' +
        (posedB && !posedB.vis ? ' - but the march disagrees: stops at ' + posedB.stop.toFixed(2) + ' m' : '') +
        (cam === 1 && slabB.length ? ' (the found body it was looking at is behind a slab at ' + slabB[0].stop.toFixed(2) + ' m)' : '')
        : 'NO POSE: ' + camG.why + ' | ' + (m189 ? boundTxt
          : noPoseBad ? 'a BODY IS IN THE FRAME (' + nM + ' px of coverage) and the search posed nothing, so this is a regression and not #189: ' + boundTxt
          : camG.coneMax < POSEFLOOR ? 'the cone reaches only ' + camG.coneMax.toFixed(2) + ' m but the search examined '
            + camG.tried + ' spot(s), so nothing here says #189: ' + boundTxt
            : 'cone max ' + camG.coneMax.toFixed(2) + ' m is at or above the ' + POSEFLOOR.toFixed(2) + ' m floor and ' +
              camG.spotPlace + ' spot(s) were placeable, so the pose failed for a reason that is NOT #189'),
      !poseOk && m189 ? '#189' : undefined);
    const partOk = inFr.length === visB.length + hidB.length && inFr.length >= 1 && badBlock === 0;
    row('cam ' + cam + ' frustum bodies are all accounted for',
      partOk && !!posedB && !!posedB.inF,
      inFr.length + ' in frustum = ' + visB.length + ' clear + ' + hidB.length + ' hidden, posed body ' +
      (posedB ? (posedB.inF ? 'in frustum and ' + (posedB.vis ? 'clear' : 'BLOCKED at ' + posedB.stop.toFixed(2) + ' m') : 'OUTSIDE the frustum')
        : m189 ? 'missing because the cone cannot hold one | ' + boundTxt : 'missing') +
      (badBlock ? ', ' + badBlock + ' hidden without a nearer block distance' : ''),
      m189 && partOk ? '#189' : undefined);
    row('cam ' + cam + ' mask is bodies, not the room', nMB === 0 && nM > 0,
      nMB ? 'rendering with ENEMIES emptied still stamps ' + nMB + ' px of coverage - the mask is counting something other than the cast'
        : !nM ? 'vacuous: nothing drew in the measured frame either, so this proves nothing about the mask' +
          (m189vac ? ' | nothing drew because no body is in the clear: ' + boundTxt : '')
          : 'ENEMIES emptied -> coverage empty, so every one of the ' + nM + ' mask px below is a body\'s own draw',
      m189vac && !nMB ? '#189' : undefined);
    row('cam ' + cam + ' silhouette is big enough', nM >= MINMASK, nM + ' px = ' + pct(nM) + ' of the frame' +
      (posedPx >= 0 ? ' (POSED body paints ' + posedPx + ' of them alone)' : '') +
      (nM ? '' : ' - NOTHING DREW: rows below are not measurements' + (m189vac ? ' | ' + boundTxt : '')),
      m189vac ? '#189' : undefined);
    row('cam ' + cam + ' edge ring is measurable', enring >= RINGMIN && noBg === 0,
      enring + ' ring px' + (noBg ? ', ' + noBg + ' with no background sample' : '') +
      (!enring && m189vac ? ' | a ring of pixels a body painted, and no body painted any: ' + boundTxt : ''),
      m189vac ? '#189' : undefined);
    const reads = nM >= MINMASK && enring >= RINGMIN && edgeDL >= DLMIN && lostPct <= LOSTMAX;
    // a measurement at all: something drew, the ring has pixels, and the mask does not leak. Only a
    // row that measured can owe a debt - vacuity is a FAILURE (see the row() note above).
    const measured = nM >= MINMASK && enring >= RINGMIN && leak <= LEAKMAX;
    /* THE DEBT, IN TWO PARTS (#188). On the volume branch the body in cam 1's shot is not necessarily a
       body the GAME placed, and "#179 is paid" cannot be allowed to mean "the probe found somewhere to
       stand a body" - on the CI cell the FOUND frame under FLAT=1 reads 44 dL / 14% and the POSED frame
       35 dL / 15%, where the same camera banded and unposed measures 16.65. So cam 1 gets TWO rows, each
       with its own object and its own floor:
         FOUND  every body where the game put it - the frame #179's floors were recorded against, and
                the only frame that can say the debt is paid. Runs only when a placed body is in the
                clear inside the cone; when none is, the row says #189 and prints the cone bound.
         POSED  the single body the march parked in the clear - what a body the player could actually
                see looks like. Its floor comes from the POSEONLY sweep below, and its ok is NOT
                evidence about #179's term; the line says so.
       For cam 0 and cam 2 the crowd frame stays the measured frame; cam 2's WEAK rides the banded floor
       (#179/M5) with the in-run at-datum control as its falsifier. cam 0 keeps failing outright. */
    if (cam === DEBT.cam) {
      const fVac = !!foundSt && foundSt.px >= MINMASK && foundSt.en >= RINGMIN;
      const fReads = fVac && foundSt.dl >= DLMIN && foundSt.lost <= LOSTMAX;
      /* On the cell #179's floors were recorded on, they are the window unchanged. Elsewhere the row
         uses the same measured floor as the other banded rows: a number never measured on level 1 cannot
         be the baseline a level-1 frame "grew past". */
      const fCtl0 = ctlCache.found || null;   // rendered by the FOUND block above, while the bodies were on their found spots
      /* On the cell #179's floors were recorded on, they are the window unchanged. Elsewhere the row
         uses the same measured floor as the other banded rows: a number never measured on level 1 cannot
         be the baseline a level-1 frame "grew past". */
      const fFloor = DEBT_CELL ? DEBT.dlFloor : Math.max(BANDED_FLOOR, (fCtl0 ? fCtl0.dl : DLMIN) - BANDTOL);
      const fCeil = DEBT_CELL ? DEBT.lostCeil : BAND_LOSTCEIL;
      /* THE FOUND ROW MUST PROVE IT MEASURED A FOUND FRAME: it re-renders the frame it claims to report
         and requires the same coverage and the same edge dL. A row handed the posed frame instead - or
         one whose restore silently failed - differs here, because the posed body's pixels are not the
         found bodies' pixels. Under POSEONLY the found frame is not the measured frame by request, so
         the row does not measure at all and the re-render is not owed. */
      const fRe = foundVis ? foundStatsNow() : null;
      const fSame = POSEONLY || !fRe || !foundSt || (fRe.px === foundN && Math.abs(fRe.dl - foundSt.dl) < 0.05);
      const fDebt = !fReads && fVac && !!foundSt && foundSt.dl < DLMIN && foundSt.dl >= fFloor && foundSt.lost <= fCeil
        && fSame ? DEBT.issue : undefined;
      const fOk = fReads && (!foundSt || fSame);
      if (!bodies.length || NOBODY) {
        row('cam 1 body reads - FOUND bodies', false,
          NOBODY ? 'vacuous: NOBODY=1 emptied the scene, so there is no placement in the frame to judge - this row is a control and fails by design'
            : 'vacuous: no living body in the level, so there is no placement to judge', undefined);
      } else if (!foundVis || !foundSt) {
        row('cam 1 body reads - FOUND bodies', false,
          foundIn + ' body(ies) the GAME placed inside the cone, ' + foundVis + ' of them in the clear (nearest stop '
          + (foundStop < 0 ? 'none' : foundStop.toFixed(2)) + ' m) - there is no found-body measurement to take'
          + (noPoseBad ? ', BUT THE FRAME HAS A BODY IN IT (' + nM + ' px of coverage drawn by a body the probe never posed), so "nothing is in the clear" is a broken visibility solve and not the debt' : '') +
          ' | ' + boundTxt,
          // #242: the debt label needs the frame to agree. A posed body's own pixels are not evidence
          // that a PLACED one was visible (measured on L1/12345: the pose draws 1932 px while all 8
          // placed bodies sit behind slabs - that is #189, and it was red for one commit here).
          noPoseBad ? undefined : '#189');
      } else {
        row('cam 1 body reads - FOUND bodies', fOk,
          'edge dL ' + foundSt.dl.toFixed(1) + ' vs ' + DLMIN + ', lost ' + foundSt.lost.toFixed(0) + '% vs ' + LOSTMAX +
          ' on ' + foundN + ' px of coverage, ' + foundVis + '/' + foundIn + ' placed bodies in the clear' +
          (POSEONLY ? '' : ' | re-rendered from the found spots it is ' + (fSame ? 'the same frame: ' : 'NOT the same frame: ') +
            fRe.px + ' px, edge dL ' + fRe.dl.toFixed(1) + (fSame ? '' : ' against the ' + foundN + ' px and dL '
            + (foundSt ? foundSt.dl.toFixed(1) : '0') + ' this row was handed - it is measuring a frame that is not the found one')) +
          (fCtl0 ? ' | the SAME bodies on the SAME spots with the grid at the datum read ' + fCtl0.dl.toFixed(1) + ' dL / '
            + fCtl0.lost.toFixed(0) + '% on ' + fCtl0.px + ' px' + (DEBT_CELL ? '' : ', so the band costs '
            + (fCtl0.dl - foundSt.dl).toFixed(1) + ' dL and the window opens at max(' + BANDED_FLOOR + ', '
            + fCtl0.dl.toFixed(1) + ' - ' + BANDTOL + ') = ' + fFloor.toFixed(1)) : '') +
          (fOk || !fVac ? '' : fDebt
            ? ' - debt, fails below ' + fFloor.toFixed(2) + ' dL or above ' + fCeil.toFixed(2) + '% lost'
            : fVac ? ' - the DEBT GREW: below the floor ' + fFloor.toFixed(2) + ' dL / ' + fCeil.toFixed(2) + '%'
              : ' - vacuous: ' + foundN + ' px / ring ' + foundSt.en + ' is under the ' + MINMASK + '/' + RINGMIN + ' floors'),
          fDebt);
      }
      const pVac = !!posedSt && posedSt.px >= MINMASK && posedSt.en >= RINGMIN;
      const pReads = pVac && posedSt.dl >= DLMIN && posedSt.lost <= LOSTMAX;
      if (!pVac) {
        row('cam 1 body reads - POSED body', false,
          camG.pose ? 'vacuous: the posed body paints ' + posedPx + ' px with ring ' + (posedSt ? posedSt.en : 0) +
            ', under the ' + MINMASK + '/' + RINGMIN + ' floors - not a measurement, not a debt'
            : m189 ? 'nothing to measure, and the reason is the cone and not the shading: ' + boundTxt
              : 'vacuous: ' + camG.why, camG.pose || !m189 ? undefined : '#189');
      } else {
        const pCtl = pReads ? null : control('posed');
        const pFloor = Math.max(POSE_FLOOR, pCtl ? pCtl.dl - BANDTOL : POSE_FLOOR);
        const pDebt = !pReads && posedSt.dl < DLMIN && posedSt.dl >= pFloor && posedSt.lost <= POSE_LOSTCEIL
          ? DEBT.issue + ' (posed)' : undefined;
        row('cam 1 body reads - POSED body', pReads,
          'edge dL ' + posedSt.dl.toFixed(1) + ' vs ' + DLMIN + ', lost ' + posedSt.lost.toFixed(0) + '% vs ' + LOSTMAX +
          ' on ' + posedPx + ' px (crowd frame has ' + otherPx + ' px more than this body alone; floors from a'
          + ' 24-run sweep, N=18 measurable, min 14)' +
          (pCtl ? ' | the SAME body on the SAME spot at the datum reads ' + pCtl.dl.toFixed(1) + ' dL on ' + pCtl.px +
            ' px, so the band costs ' + (pCtl.dl - posedSt.dl).toFixed(1) + ' dL and the window opens at max(' + POSE_FLOOR +
            ', ' + pCtl.dl.toFixed(1) + ' - ' + BANDTOL + ') = ' + pFloor.toFixed(1) : '') +
          (pReads ? '' : pDebt ? ' | reported, NOT paid: a posed body reads high on cells where a found one does not'
            : ' | below the measured floor ' + pFloor.toFixed(1) + ' dL, a regression rather than a debt'),
          pDebt);
      }
    } else {
      /* cam 2's WEAK on a banded level is #179/M5's lighting debt, and the in-run control is what makes
         the label falsifiable instead of a synonym for "this room is dark": the same bodies on the same
         spots with the grid at the datum. A shading term that lifts THAT past DLMIN while this number
         stays here moves the floor to (control - BANDTOL) and turns this row RED; a control as weak as
         this frame says the band is not the cause and the label is wrong on this cell. */
      const ctlC = (reads || !measured || cam !== 2) ? null : control('crowd');
      const bFloor = Math.max(BANDED_FLOOR, ctlC ? ctlC.dl - BANDTOL : BANDED_FLOOR);
      const debt = !reads && measured && cam === 2 && edgeDL < DLMIN && edgeDL >= bFloor && lostPct <= BAND_LOSTCEIL
        ? DEBT.issue : undefined;
      row('cam ' + cam + ' body reads against the room' + (camG.pose ? ' (posed body in shot)' : ''), reads,
        'edge dL ' + edgeDL.toFixed(1) + ' vs ' + DLMIN + ', lost ' + lostPct.toFixed(0) + '% vs ' + LOSTMAX +
        (ctlC ? ' | the same bodies on the same spots at the datum read ' + ctlC.dl.toFixed(1) + ' dL on ' + ctlC.px +
          ' px, so the band costs ' + (ctlC.dl - edgeDL).toFixed(1) + ' dL and the window opens at max(' + BANDED_FLOOR +
          ', ' + ctlC.dl.toFixed(1) + ' - ' + BANDTOL + ') = ' + bFloor.toFixed(1) +
          (ctlC.dl < DLMIN ? ' | NOTE: the control is ITSELF below ' + DLMIN + ', so on this cell the band is not the cause - '
            + (DLMIN - ctlC.dl).toFixed(0) + ' dL of the ' + (DLMIN - edgeDL).toFixed(0) + ' dL shortfall is the room\'s own '
            + 'light (the deficit even an unbanded level has here) and ' + (ctlC.dl - edgeDL).toFixed(0) + ' dL is the band' : '') +
          ' | FALSIFIER for "banded lighting is the cause": a body-shading term that moves the datum control past ' + DLMIN +
          ' while this number does not move pushes the floor over it and turns this row red' : '') +
        (reads || cam !== 2 || !measured ? '' : debt ? ' - banded debt, fails below ' + bFloor.toFixed(1) + ' dL'
          : ' - below the measured banded floor ' + bFloor.toFixed(1) + ' dL: a regression, not the debt'),
        debt);
    }
    row('cam ' + cam + ' diff mask leaks nothing', leak <= LEAKMAX,
      leak + ' px differ between the two renders but no body painted them' +
      (leak ? ' - a body-driven WORLD change is being counted as the body (#179)' : ''));
    /* ---- #244, the rows that make those numbers fail on a regression -----------------------------
       Two gated rows per camera: the gradient the SURFACE carries (the ring is out of it by
       construction, so an outline cannot pay it) and the two channels #232 required UNMOVED (mean and
       motion). Both are vacuity-gated first: pixels under TG_MINPX is a FAILURE wherever a body is in
       the frame, and only the proven #189 cone - the branch the cam 1 rows above already report - gets
       to call it no measurement to take. */
    const tgVac = tstat.px >= TG_MINPX;
    const tgDebt = tgVac || bodyInFrame || NOBODY ? undefined : '#189';
    const tgWhy = tgDebt ? ' - NO MEASUREMENT: ' + boundTxt
      : ' - VACUITY: ' + tstat.px + ' px of interior torso is under the ' + TG_MINPX + ' floor while ' + nM +
        ' body px are in the frame, so the band is not landing on a torso';
    /* A camera whose mask is EMPTY has no torso to measure, and cam 1's five #189 rows above already
       carry that debt; a sixth and seventh KNOWN row would only teach the reader to skim the tally.
       So the rows are emitted wherever the mask has a body in it, and the case where nothing drew at
       all is still two red lines away from green: the per-cam print above says NOT MEASURED, and the
       run's own vacuity row below fails if no camera measured anything. */
    if (nM > 0) {
      row('cam ' + cam + ' torso carries surface structure', tgVac && tstat.grad >= TG_FLOOR,
        'torso gradient ' + tstat.grad.toFixed(2) + ' dL/px vs floor ' + TG_FLOOR + ' on ' + tstat.px +
        ' interior torso px; floor between the two measured trees (no term in js/: ' + TG_PRE + ', shipped: '
        + TG_POST + ' - weakest of nine cells, the termless torso reads about 0.0 because a flat-shaded'
        + ' triangle has no intra-face slope, so the 1.02-2.32 #240 quoted was ring and face seams rather'
        + ' than surface); the room in this frame reads ' + tstat.room.toFixed(2) + ' dL/px, so the torso'
        + ' delivers ' + (tstat.room ? (100 * tstat.grad / tstat.room).toFixed(0) : '0') + '% of what the'
        + ' walls do on screen' + (tgVac ? '' : tgWhy) + ' [' + TG_MARK + ']' +
        (tgSamePx ? ' | NOTE: the re-render differs from the coverage frame on ' + tgSamePx + ' px' : ''), tgDebt);
      row('cam ' + cam + ' torso gradient not paid by mean or edge', tgVac && tstat.bias <= TG_BIAS,
        'DC of the wave ' + tstat.bias.toFixed(2) + ' dL/px vs floor ' + TG_BIAS + ' (mean of the SIGNED'
        + " slope less the frame's own " + tstat.roomBias.toFixed(2) + ': a zero-mean triangle cancels, a'
        + ' unipolar seam, a multiplier or a term clamped off centre does not; 0.00 to 0.53 measured with no'
        + ' term in js/, 0.00 to 0.80 shipped) | the whole-silhouette mean this term costs across the two'
        + ' trees: ' + TG_MEANMOVE + ' - this frame band ' + tstat.bandMean.toFixed(1) + ', body '
        + tstat.silMean.toFixed(1) + ', |d| ' + tgMean.toFixed(2) + " is the region's own albedo step and is"
        + ' printed, not gated | outline: ' + tstat.rej + ' torso px rejected for sitting within 2 px of the'
        + ' silhouette, and the gradient above counts nothing else, so an outline cannot pay it' +
        ' | boil 0.03 rad: torso ' + tstat.boil.toFixed(2) + ', limb band of the same bodies '
        + tstat.limbBoil.toFixed(2) + ', noise per unit structure ' + (tstat.px ? (tstat.boil / Math.max(tstat.grad, 1e-9)).toFixed(2) : '0') +
        ' - REPORTED, NOT GATED: torso boil measures ' + TG_BOILLO + ' to ' + TG_BOILHI +
        ' across the shipped parameter space (TS_SLOPE 0 / 9 / 30, TS_CYC 10 / 28) against limbs '
        + TG_LIMBOILLO + ' to ' + TG_LIMBOILHI + ', so a ceiling here would be a row nothing can cross; the'
        + ' slope/seam trade is visible in the ratio (' + TG_NOISE + ' shipped, ' + TG_NOISESAB + ' at TS_CYC'
        + ' = 28, whose gradient, 1.62, is what the floor is really guarding)' + (tgVac ? '' : tgWhy), tgDebt);
    } else {
      console.log('    torso rows SKIPPED at cam ' + cam + ': NOTHING DREW in the measured frame (' + nM +
        ' coverage px), so there is no surface to measure - the #189 rows above carry that, and the run\'s'
        + ' vacuity row below carries the case where no camera measured at all');
    }
  }
  if (process.env.ARMCOST) {
    /* What the mask costs WHEN A PROBE ARMS IT - the only state in which it can cost anything, and
       the number that says what a run of this probe pays. Interleaved rolls in one process, same
       compiled script on both sides (ARM is a sandbox global, not a rewritten loop), median of 5
       rolls of 100 frames, per the timing discipline. Camera and cast are cam 2's: the largest
       silhouette in this probe, so the mask writes the most pixels. */
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const off = [], on = [];
    for (let r = 0; r < 5; r++) {
      for (const arm of [0, 1]) {
        run('window.ARM = ' + arm + ';');
        const v = +run(`(function (){
          const keep = COV; COV = ARM ? keep : null;
          const t = []; for (let f = 0; f < 100; f++) { const a = Date.now(); renderWorld(); t.push(Date.now() - a); }
          COV = keep; t.sort((x, y) => x - y); return t[50];
        })()`);
        (arm ? on : off).push(v);
      }
    }
    console.log('arm cost (cam 2 frame, 5 interleaved rolls of 100 frames, ms/frame): off median ' +
      med(off).toFixed(2) + ' [' + off.join(' ') + ']  armed median ' + med(on).toFixed(2) +
      ' [' + on.join(' ') + ']');
  }
  /* #244's own vacuity line, at the level of the INSTRUMENT: the torso rows exist on every camera, so
     a run in which not one camera produced a torso reading is a red line, not a quiet 0.00 in a line
     nobody reads. That is the failure #244 was filed for: numbers no recorded row can fail. */
  row('the torso gradient measured at least one camera', tgCams > 0,
    tgCams + ' of 3 cameras produced at least ' + TG_MINPX + ' interior torso px' +
    (tgCams ? ' (cam ' + tgCamsAt.join(' ') + ')' : ' - the torso row is not measuring, which is the defect #244 was filed for') +
    (tgCams === 3 ? '' : '; a camera that produced none says why on its own rows above'));
  const debtTail = known ? ', ' + known + ' known-issue row' + (known > 1 ? 's' : '') + ' (' +
    (STRICT ? 'FAILED under STRICT=1' : 'reporting') + ': ' + [...knownIssues].join(' ') + ')' : '';
  const poseTail = noPoseNotes.length ? '  |  no-pose cause: ' + noPoseNotes.join('  |  ') : '';
  console.log((bad || known ? `CONTRAST ${bad} FAILURE(S) of ${nrows} rows` + debtTail
    : `CONTRAST ok - ${nrows} rows: bodies separate from the rooms they stand in` + debtTail) + poseTail);
  run('COV = null;');
  process.exit(bad ? 1 : 0);
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
  const VMIN = 3;                                  // death variants #82 asks each kind to author
  const IOVMIN = 0.75;                             // masks overlapping more than this are ONE silhouette
  /* the corpse's signature: its coverage bitmap, translated to its own bbox and quantised to a
     16x16 grid of counts. Normalising by the bbox is what makes a corpse that merely slid two
     pixels down the wall sign the same, while one that lies along the other axis does not; the
     counts are bucketed in 2s because raster edge pixels are not reproducible between poses. */
  function maskHash(m) {
    let top = H, bot = -1, lef = W, rig = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.cov[y * W + x]) {
      if (y < top) top = y; if (y > bot) bot = y; if (x < lef) lef = x; if (x > rig) rig = x;
    }
    if (bot < 0) return 'EMPTY';
    const hh = bot - top + 1, ww = rig - lef + 1, g = new Int32Array(256);
    for (let y = top; y <= bot; y++) for (let x = lef; x <= rig; x++) if (m.cov[y * W + x])
      g[((((y - top) * 16 / hh) | 0) * 16 + (((x - lef) * 16 / ww) | 0))]++;
    let h = 2166136261;
    for (let i = 0; i < 256; i++) h = ((h ^ Math.min(255, g[i] >> 1)) * 16777619) >>> 0;
    return h.toString(16);
  }
  function maskIoU(a, b) {
    let inter = 0, uni = 0;
    for (let i = 0; i < N; i++) {
      const t = (a.cov[i] ? 1 : 0) + (b.cov[i] ? 1 : 0);
      if (t === 2) inter++; else if (t) uni++;
    }
    return uni ? inter / uni : 1;
  }
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
  let bad = 0, attachBad = 0, judgeBad = 0;
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
  // dv belongs here for the same reason: makeEnemy rolls it at spawn, and a random variant would
  // make the rows below depend on the run (the death section sets it per variant explicitly).
  const PIN = `e.anim=0;e.stepPhase=0;e.ph=0;e.tint=[1,1,1];e.state='chase';e.alert=true;e.cd=1e9;` +
    `e.movingAmt=0;e.lean=0;e.atkT=0;e.dieT=0;e.stagger=0;e.dv=0;e.ang=Math.atan2(P.y-e.y,P.x-e.x);`;
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
    /* #163: ceiling rows now carry a distance, so a body is CLIPPED where it crosses the ceiling plane
       instead of smearing through it. On the shipped one-unit rooms that is a real change to what these
       rows look at - the brute at 1.9 m went from a 18381 px mask whose top was the frame edge (row 0)
       to a 12597 px mask clipped at row 62, and a topple measured from a clipped crown moves 11 px where
       the row wants 15% of the body. The claims here are about bodies changing SHAPE and parts staying
       ATTACHED, and none of them is about ceiling height, so the probe lifts its own sight path: cz to
       CZ_DEF*2 for every frame of the run, floors untouched, so nothing is clipped and every threshold
       below still measures a whole body. Both renders of a pair share the world, so the mask is the body. */
    run('MAP.cz.fill(CZ_DEF * 2); linkBoundaries();');
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
    /* ---- #82: does EVERY enemy die the same way? -------------------------------------
       One corpse per death variant, sampled by setting e.dv - a field the renderer is supposed
       to read and main does not, so setting it there changes nothing and every variant renders
       the same body. That is what makes this row red on main without the probe knowing whether
       the fix exists: the assertion is about the PICTURE, and the only way to satisfy it is to
       make the picture depend on the field.
       The mask is the same contrast technique as every row above, and the sample is the frame
       the corpse RESTS in (dieT 0.55 = die bucket 5), because that is the pose the player walks
       past for the next three seconds - "they all die the same way" is a claim about the corpse,
       not about the two frames it takes to get there. Two variants are DISTINCT when their
       bbox-normalised masks hash differently AND their raw overlap stays under IOVMIN: the hash
       alone would let a one-pixel twitch count as a new death, IoU alone cannot tell a duplicate
       from a mirrored one. The >=15% silhouette-top assert the topple row already made now runs
       for EVERY variant - "it topples" is not the same claim as "every way of dying topples", and
       a variant that stays standing would slide through as a distinct hash. */
    /* Every kind, not whatever ENEMIES[0] happens to be. A first version of this loop animated
       ENEMIES[0] and so asserted ONE kind per level - three levels of grunt, three green rows, and
       nothing at all said about a hound or a brute, whose fall rows are authored separately
       (SPEC[k].die). Kind flows per draw (js/40_render.js:156), so forcing kind, type and scale on
       the same body is enough to exercise every row of the table. */
    const VKIND = run('Object.keys(ETYPE)');
    for (const vk of VKIND) {
    const VL = vk.padEnd(6);
    run(`(()=>{const e=ENEMIES[0];e.state='dead';e.vx=e.vy=e.svx=e.svy=0;e.dieAng=Math.atan2(P.y-e.y,P.x-e.x)+0.7})()`);
    run(`ENEMIES[0].kind=${JSON.stringify(vk)};ENEMIES[0].type=ETYPE[${JSON.stringify(vk)}];ENEMIES[0].scale=ETYPE[${JSON.stringify(vk)}].scale;`);
    const VNM = run('typeof MESH.DIEV === "number" ? MESH.DIEV : 0');
    const DT = [0, 0.1, 0.2, 0.4, 0.55];              // dieT -> die buckets 0, 1, 2, 4, 5
    const vs = [];
    for (let v = 0; v < VMIN; v++) {
      const ss = [];
      for (const t of DT) {
        run('MESH.reset();ENEMIES[0].dv=' + v + ';ENEMIES[0].dieT=' + t + ';renderWorld();');
        const tri = run('MESH.stats().tris'), s = shot(), m = maskOf(s);
        ss.push({ t, s, m, h: maskHash(m), tri });
      }
      const a = ss[0], c = ss[3], f = ss[ss.length - 1];
      vs.push({ v, a, f, h: f.h, tri: f.tri });
      row(vk + ' topple v' + v + ' .40s', cmp(a.s, a.m, c.s), a.m, 'sil top ' + a.m.top + ' -> ' + c.m.top);
      const rise = a.m.bot - a.m.top;
      if (rise > 20 && c.m.top - a.m.top < rise * 0.15) {
        bad++; console.log('  ' + VL + 'topple v' + v + '    silhouette top moved ' + (c.m.top - a.m.top) + ' px of a ' + rise +
          ' px body: it did not go DOWN - ' + 'IDENTICAL');
      }
      /* the variant's own timeline, hashed: a death that jumps from standing to flat in one bucket
         would satisfy "it topples" and "it is a different corpse" while still being a pop. This is
         also the row that keeps the old dieT sweep in the build, so the pose table below still
         contains the same death buckets it did before variants existed. */
      const along = new Set(ss.map(z => z.h)).size;
      if (along < 3) bad++;
      console.log('  ' + VL + 'fall v' + v + '      ' + along + '/' + ss.length + ' distinct silhouettes on the way down   mask px ' +
        ss.map(z => z.m.n).join('/') + '   ' + (along < 3 ? 'IDENTICAL - it pops instead of falling' : 'ok'));
      if (v > 0 && f.m.n < a.m.n * 0.4) {
        bad++; console.log('  ' + VL + 'corpse v' + v + '    rests at ' + f.m.n + ' mask px against dv0\'s ' + a.m.n +
          ': it collapsed into the floor, so "distinct" would be "missing"');
      }
    }
    const dh = new Set(vs.map(z => z.h)).size;
    const pairs = [];
    for (let i = 0; i < VMIN; i++) for (let j = i + 1; j < VMIN; j++) pairs.push(maskIoU(vs[i].f.m, vs[j].f.m));
    const ovok = dh === VMIN && pairs.every(z => z < IOVMIN);
    if (!ovok) bad++;
    console.log('  ' + VL + 'death variants ' + dh + '/' + VMIN + ' distinct of dv 0..' + (VMIN - 1) + '   IoU ' +
      pairs.map(z => z.toFixed(2)).join(' ') + '   rest px ' + vs.map(z => z.f.m.n).join('/') +
      '   tris ' + vs.map(z => z.tri).join('/') + (ovok ? '  VARIES' : '  IDENTICAL - every corpse is the same corpse'));
    if (VNM && VNM !== VMIN) {
      bad++; console.log('  ' + VL + 'death variants the table authors ' + VNM + ' variants per kind, the design asks for ' + VMIN);
    }
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
      ? ps.poseEntries + ' cached vertex sets, ' + ps.poseMB + ' MB' + (ps.capMB ? ' of ' + ps.capMB.toFixed(2) + ' MB cap' : '') +
        ' (this is what amortizes the rebuild)'
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
  // #163 again, and this is why the poke above was not enough: this section re-runs startLevel, which
  // regenerates the grid and resets MAP.cz to CZ_DEF, so the ceiling came back down to one unit and the
  // brute's head went back inside the slab (brute spawn: first run 24-151 becomes 92-151, i.e. the head
  // is gone and the widest row IS the top row - NO HEAD TO JUDGE). Same reason, same poke, after the
  // regenerate rather than before it.
  run('MAP.cz.fill(CZ_DEF * 2); linkBoundaries();');
  const apl = run(CAMCELL);
  const adist = run(`(()=>{let t=2.4,ex=P.x+Math.cos(P.ang)*t,ey=P.y+Math.sin(P.ang)*t;` +
    `while(t>0.6&&isSolid(ex,ey)){t-=0.2;ex=P.x+Math.cos(P.ang)*t;ey=P.y+Math.sin(P.ang)*t;}` +
    `APX=ex;APY=ey;return +t.toFixed(2)})()`);
  const nospec = AKIND.filter(k => ASPEC.indexOf(k) < 0);
  /* Per-kind distance, because MASKMIN counts pixels and bodies are not the same size. A grunt at
     2.4 m paints ~4,800 mask px; a hound at 2.4 m painted 591 on main at 5835134, so one threshold
     across three body sizes declared the hound rows "NO BODY TO JUDGE" and anim has exited 1 on
     main ever since with nothing actually detached. Each kind is now judged at the FARTHEST distance
     that clears MASKMIN, and a kind that clears it at no distance still reports it rather than
     passing quietly. */
  function maskCount(s) { const m = maskOf(s); let n = 0; for (let i = 0; i < N; i++) if (m.cov[i] || s.zA[i] < s.zB[i] - 1e-4) n++; return n; }
  const DK = {};
  for (const k of AKIND) {
    let picked = 0;
    for (let d = adist; d >= 0.9; d -= 0.3) {
      run(`(()=>{ENEMIES.length=0;const e=makeEnemy('${k}',P.x+Math.cos(P.ang)*${d.toFixed(2)},P.y+Math.sin(P.ang)*${d.toFixed(2)});` +
        `${PIN}e.ang=Math.atan2(P.y-e.y,P.x-e.x);ENEMIES.push(e)})()`);
      if (maskCount(shot()) >= MASKMIN) { picked = +d.toFixed(2); break; }
    }
    DK[k] = picked || +adist.toFixed(2);
  }
  console.log('attached: ' + AKIND.map(k => k + ' @' + DK[k] + ' m').join(', ') + ', cell ' + apl.cell + ', every gait bucket named above' +
    (nospec.length ? '\n  NO MESH SPEC for ' + nospec.join('/') + ' - those kinds would silently draw as grunts' : ''));
  if (nospec.length) { bad++; attachBad += nospec.length; }
  for (const k of AKIND) {
    for (const [dy, ph, mv, nm] of APOSE) {
      const ap = run(`(()=>{ENEMIES.length=0;const e=makeEnemy('${k}',P.x+Math.cos(P.ang)*${DK[k]},P.y+Math.sin(P.ang)*${DK[k]});${PIN}` +
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
        bad++; judgeBad++;
        console.log('  ' + k.padEnd(6) + pad(nm, 12) + 'body ' + an + ' px at ' + DK[k] + ' m: NO BODY TO JUDGE at any distance - the probe cannot pass');
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
  if (bad - attachBad - judgeBad) why.push('bodies are drawn in a static stance');
  if (attachBad) why.push(attachBad + ' pose(s) with DETACHED parts');
  if (judgeBad) why.push(judgeBad + ' pose(s) too small to judge at ANY distance - a probe-geometry problem, not a detachment failure');
  console.log(bad ? 'anim: ' + bad + ' assertion(s) FAILED - ' + why.join('; ')
    : 'anim: bodies change shape while they move and their parts are attached');
  process.exit(bad ? 1 : 0);
}

if (MODE === 'viewmodel') {
  /* The view model is GEOMETRY now (#180), so the only honest reader is the raster. A mesh writes
     into `px` and issues no canvas op at all - measured 27,375 raster writes against 0 recorded
     fills - which is why this probe used to record canvas paths and reported "geometry missing" for
     a rifle that was painting 13,853 pixels, and why four attempts of this epic stayed green while
     shipping zero pixels: a frame mean cannot move when nothing is drawn. Every number below is one
     rendered frame diffed against the SAME frame with drawViewModel suppressed, the way `contrast`
     isolates a body by deleting it, so nothing in the room can fake the signal and a rig that paints
     nothing fails rather than passing on an exposure that never noticed it. */
  run('S.mode="play"; S.locked=false; startLevel(0, true);');
  const BW = run('BW'), BH = run('BH'), DW = run('DW'), DH = run('DH');
  const states = [
    ['hip', '', 'LR'], ['ads', 'P.ads=1', 'C'], ['recoil', 'P.kick=WEAPONS[P.weapon].kick;S.muzzle=1', 'LR'],
    ['reload', 'P.reloadT=WEAPONS[P.weapon].reload*0.5', 'LR'], ['reload-mid', 'P.reloadT=WEAPONS[P.weapon].reload*0.2', 'LR'],
    ['swap', 'P.swapT=0.3', 'LR'], ['sprint', 'P.sprint=1;P.bobPhase=1.2;keys.KeyW=1;P.vx=4', 'LR'],
    ['airborne', 'P.air=true;P.vz=3', 'LR'],
  ];
  const QUAD = 0.85;                     // painted pixels required in the lower-right quadrant
  const MINPX = 256;                     // measured minimum across the 24 states: 1,175 (a pistol mid-swap)
  let bad = 0;
  /* THE RIG IS PUT AT REST BEFORE EACH PAIR (#180). drawViewModel damps its sway against wall-clock
     dt (VM.now = performance.now()), so two frames rendered back to back are NOT the same pose: the
     look-lag term was still moving 0.0093 rad between the pair, which is the gun's whole silhouette
     in the diff and made every painted-pixel count below a lie about churn instead of geometry.
     After two frames VM.ang equals P.ang, so dAng is 0 and lag damps to exactly 0; the explicit zeros
     cover the first frame AND make the measured pose independent of how long the sandbox took to
     render the frames before it, which a probe must be. The second frame of each pair runs the pass
     STUBBED, which freezes the sway state rather than advancing it, and that is what makes the two
     frames differ by the rig and by nothing else. */
  const REST = 'for (let i = 0; i < 6; i++) renderWorld(); VM.lag = 0; VM.vx = 0; VM.vy = 0;';
  // record the instance the pass submits, so a red row can say "culled" or "never submitted"
  run('window.__VMSAVE = window.drawViewModel; window.__REC = []; (function () { var o = MESH.draw; MESH.draw = function (a) { window.__REC.push({ near: !!a.near, x: a.x, y: a.y, z: a.z }); return o.apply(this, arguments) }; })()');

  /* One frame of the rig and one without it. Returns the diff, measured in the page: 200k pixels and
     200k depths must not cross the bridge twice per state. zbuf is compared because it is a DISTANCE
     in every pixel now - a rig that writes one, even a sentinel, silently culls billboards. */
  function pair(set, keep) {
    run('P.ads=0; P.kick=0; P.reloadT=0; P.swapT=0; P.sprint=0; P.air=false; P.vz=0; P.bobPhase=0; S.muzzle=0; keys.KeyW=0; P.vx=0; P.vy=0; ' + set);
    run('window.drawViewModel = window.__VMSAVE; ' + REST);
    const err = run('(()=>{try{window.__REC=[];MESH.reset();renderWorld();return null}catch(e){return String(e.message)}})()');
    const a = run('MESH.stats().tris');
    const pxOn = keep ? new Uint32Array(run('px')) : null;   // kept only by the flash rows, which diff two rigs
    run('window.__P0 = px.slice(); window.__Z0 = zbuf.slice(); window.__H0 = JSON.stringify(hitscan(P.ang, pitchTan(), 12));');
    run('window.drawViewModel = function () {}; VM.lag = 0; MESH.reset(); renderWorld();');
    const b = run('MESH.stats().tris');
    const o = run('(()=>{const A=window.__P0,B=px;' +
      'const idet=1/(planeX*dirY-dirX*planeY),dx=VMPOS[0]-camX,dy=VMPOS[1]-camY;' +
      'const ty=idet*(-planeY*dx+planeX*dy),tx=idet*(dirY*dx-dirX*dy);' +
      'const pax=BW*0.5*(1+tx/ty),pay=horizon+BH*(eyeZ-VMPOS[2])/ty,R=70;let n=0,x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,sx=0,sy=0,q=0,nx=0,nsx=0;' +
      'for(let i=0;i<A.length;i++){if(A[i]!==B[i]){n++;const X=i%BW,Y=(i/BW)|0;sx+=X;sy+=Y;' +
      'if(X>BW*0.5&&Y>BH*0.5)q++;const ddx=X-pax,ddy=Y-pay;if(ddx*ddx+ddy*ddy<R*R){nx++;nsx+=X;}' +
      'if(X<x0)x0=X;if(X>x1)x1=X;if(Y<y0)y0=Y;if(Y>y1)y1=Y;}}' +
      'let zd=0;const Z=window.__Z0;for(let i=0;i<Z.length;i++)if(zbuf[i]!==Z[i])zd++;' +
      'return {n,x0,x1,y0,y1,cx:sx/n,cy:sy/n,q,zd,nx,cxN:nx?nsx/nx:NaN,ax:pax,ay:pay,' +
      'hs:JSON.stringify(hitscan(P.ang,pitchTan(),12))===window.__H0}})()');
    run('window.drawViewModel = window.__VMSAVE;');
    const rec = run('window.__REC.filter(r => r.near).slice(-1)[0]');
    const cb = run('({camX,camY,dirX,dirY,planeX,planeY,eyeZ,horizon,planeLen})');
    const tf = run('[].concat(Array.from(VMPOS), Array.from(VMROT))');
    let anchor = null;
    /* The instance the pass handed the rasterizer, read back through the frame's OWN camera basis.
       When nothing paints this is the difference between "geometry missing" (what four sessions read)
       and "geometry culled because the projection was shown a camera that is not the eye" - and it is
       arithmetic over numbers the frame used, not a re-derivation of them. */
    if (rec) {
      const idet = 1 / (cb.planeX * cb.dirY - cb.dirX * cb.planeY);
      const dx = rec.x - cb.camX, dy = rec.y - cb.camY;
      const ty = idet * (-cb.planeY * dx + cb.planeX * dy), tx = idet * (cb.dirY * dx - cb.dirX * dy);
      anchor = { d: ty, t: tx, sx: (BW * 0.5) * (1 + tx / ty), sy: cb.horizon + BH * (cb.eyeZ - rec.z) / ty };
    }
    return { o, a, b, err, rec, anchor, tf, cb, pxOn };
  }

  const kinds = run('WEAPONS.map(w => w.kind)');
  for (let wi = 0; wi < run('WEAPONS.length'); wi++) {
    for (const [name, setup, where] of states) {
      const r = pair('P.weapon=' + wi + '; ' + setup);
      const d = r.o, problems = [];
      if (r.err) problems.push('threw ' + r.err);
      if (r.tf.some(v => !isFinite(v))) problems.push('non-finite anchor or basis');
      if (d.zd) problems.push(d.zd + ' frame-depth pixels written - the rig culls billboards');
      if (!d.hs) problems.push('hitscan changed when the rig was drawn - it is shootable');
      if (d.b - d.a > 0) problems.push('the rig rasterized ' + (d.b - d.a) + ' tris into the frame WITHOUT the view-model pass');
      const tris = r.a - r.b;
      if (tris <= 0) problems.push('0 triangles submitted - ' + (r.anchor
        ? (r.anchor.d < 0.12 || r.anchor.d > 2
          ? 'culled, anchor at depth ' + r.anchor.d.toFixed(3) + ' m / lateral ' + r.anchor.t.toFixed(3) +
            ' plane-units -> screen ' + r.anchor.sx.toFixed(0) + ',' + r.anchor.sy.toFixed(0) + ' of ' + BW + 'x' + BH +
            ' (camera camX ' + r.cb.camX.toFixed(2) + ', camY ' + r.cb.camY.toFixed(2) + ', dir ' +
            r.cb.dirX.toFixed(2) + ',' + r.cb.dirY.toFixed(2) + ')'
          : 'culled for a reason the anchor does not explain (depth ' + r.anchor.d.toFixed(3) + ' m)')
        : 'the pass submitted no instance at all'));
      if (d.n < MINPX) problems.push('only ' + d.n + ' pixels painted - geometry missing');
      /* Where the gun belongs on screen. Hip, recoil, reload, swap, sprint and airborne are the art's
         hip pose: `ox = DW*(0.5 + 0.155*(1-ads))` put the anchor at 0.655 of the width and `oy = DH + ...`
         below the bottom edge, so the rig enters from the lower-right corner. ADS is the exception by
         design - VMSIT sits it on the CENTRE line - and what the art asserted there was the SIGHT
         PICTURE (`sx = (DW*0.5 - ox)/sc` put the rear-sight bracket on screen centre). A silhouette
         centroid is the wrong stand-in for that - the stock and the hands still hang right of the line -
         so ADS is asserted to STRADDLE the centre of the frame on both axes. */
      if (where === 'LR') {
        if (!(d.n >= MINPX && d.q >= QUAD * d.n)) problems.push('only ' + (100 * d.q / Math.max(1, d.n)).toFixed(0) +
          '% of its pixels in the lower-right quadrant');
      } else if (!(d.x0 < BW * 0.5 && d.x1 > BW * 0.5 && d.y0 < BH * 0.5 && d.y1 > BH * 0.5)) problems.push('ADS box ' +
        (d.x0 / BW).toFixed(2) + '-' + (d.x1 / BW).toFixed(2) + ' x ' + (d.y0 / BH).toFixed(2) + '-' + (d.y1 / BH).toFixed(2) +
        ' does not straddle the centre - there is no sight picture on the middle of the frame');
      /* The anchor must sit between the rasterizer's near clip and a metre or two of reach. This is
         the row that replaces the old "entirely off screen", which was unreachable: culled geometry
         paints nothing, so the painted box is empty rather than out of range. It fires on a stale
         camera basis (7.643 m, measured), on authored metres reaching the projection unscaled, and on
         an anchor that collapses onto the camera plane (depth <= 0.12). */
      if (r.anchor && !(r.anchor.d > 0.12 && r.anchor.d < 2)) problems.push('anchor depth ' +
        r.anchor.d.toFixed(3) + ' m - the rig is not in the player\'s hands (near clip 0.12)');
      console.log(('w' + wi + ' ' + kinds[wi] + ' ' + name).padEnd(24),
        'paint ' + String(d.n).padStart(5) + ' px  tris ' + String(tris).padStart(4),
        'bbox x ' + (d.x0 / BW).toFixed(2) + '-' + (d.x1 / BW).toFixed(2),
        'y ' + (d.y0 / BH).toFixed(2) + '-' + (d.y1 / BH).toFixed(2),
        'centroid ' + (d.cx / BW).toFixed(2) + ',' + (d.cy / BH).toFixed(2) +
        '  near-pivot ' + d.nx + ' px',
        'quad ' + (100 * d.q / Math.max(1, d.n)).toFixed(0) + '%',
        r.anchor ? 'anchor ' + r.anchor.d.toFixed(3) + ' m' : '',
        problems.length ? '<< ' + problems.join(', ') : '');
      bad += problems.length ? 1 : 0;
    }

    /* THE FLASH LEAVES ALONG THE BORE. It used to be emitted along +x, 90 deg off the bore, and the
       row that caught it compared the hip bbox with the recoil bbox - a screen-space test on a
       screen-space gun. That premise is gone: a horizontal bore at pitch 0 converges on the vanishing
       point, so its MUZZLE projects further in than the SIGHTS do and no flash can push the bbox up
       past them (measured: hip top 0.61, muzzle row 0.70, flash tip 0.64 - the old row failed all
       three recoil states on correct geometry). Two measurements replace it, one in the geometry's own
       metres and one in the frame's own pixels, and both are direction tests rather than thresholds:
       (a) which verts does mz=1 ADD, and are they on the bore axis ahead of the muzzle - a rig whose
           flash runs out of the side of the receiver fails this exactly, in metres, at any resolution;
       (b) the flash's painted pixels (same state, same pose, muzzle light only) against the projected
           bore line: their mean along-bore must be positive (past the muzzle, not inside the gun) and
           their mean across it must be near zero (centred on the axis, not beside it). */
    const MU = run('MESH.muzzleFor("' + kinds[wi] + '")');
    const gA = run('MESH.weapon("' + kinds[wi] + '", {mz:0})'), gB = run('MESH.weapon("' + kinds[wi] + '", {mz:1})');
    const fProblems = [];
    let fN = 0, fz0 = 1e9, fz1 = -1e9, fxm = 0, fym = 0, fz = 0, fNote = '';
    for (let i = gA.p.length / 6; i < gB.p.length / 6; i++) {
      fN++; const x = gB.p[i * 6], y = gB.p[i * 6 + 1], z = gB.p[i * 6 + 2];
      fz += z; if (z < fz0) fz0 = z; if (z > fz1) fz1 = z;
      if (Math.abs(x) > fxm) fxm = Math.abs(x); if (Math.abs(y) > fym) fym = Math.abs(y);
    }
    if (!fN) fProblems.push('mz=1 adds no geometry - the flash would not draw');
    else {
      if (fz0 < MU - 0.06) fProblems.push('flash geometry starts at z ' + fz0.toFixed(3) + ' m, well behind the muzzle crown at ' + MU.toFixed(3));
      if (fN && fz / fN < MU) fProblems.push('flash geometry is centred at z ' + (fz / fN).toFixed(3) + ' m, BEHIND the muzzle at ' + MU.toFixed(3) + ' - it is inside the gun');
      if (fxm > 0.06 || fym > 0.06) fProblems.push('flash geometry is off the bore axis: |x| ' + fxm.toFixed(3) + ' m, |y| ' + fym.toFixed(3) + ' m');
      if (fN > gB.tris) fProblems.push('flash vertex count ' + fN + ' exceeds its own triangle count');
    }
    const r0 = pair('P.weapon=' + wi + '; P.kick=WEAPONS[' + wi + '].kick; S.muzzle=0', true);
    const r1 = pair('P.weapon=' + wi + '; P.kick=WEAPONS[' + wi + '].kick; S.muzzle=1', true);
    // the bore's own screen line, from the instance the frame submitted
    let along = -1e9, across = 0, sumA = 0, sumC = 0, fpx = 0;
    if (r1.anchor) {
      const idet = 1 / (r1.cb.planeX * r1.cb.dirY - r1.cb.dirX * r1.cb.planeY);
      const proj = (wx, wy, wz) => {
        const dx = wx - r1.cb.camX, dy = wy - r1.cb.camY;
        const ty = idet * (-r1.cb.planeY * dx + r1.cb.planeX * dy), tx = idet * (r1.cb.dirY * dx - r1.cb.dirX * dy);
        return [(BW * 0.5) * (1 + tx / ty), r1.cb.horizon + BH * (r1.cb.eyeZ - wz) / ty];
      };
      const pv = Array.from(run('VMPOS')), rv = Array.from(run('VMROT'));
      const bp = z => proj(pv[0] + rv[2] * z, pv[1] + rv[5] * z, pv[2] + rv[8] * z);
      const m0 = bp(MU), m1 = bp(MU + 0.25);
      let ux = m1[0] - m0[0], uy = m1[1] - m0[1];
      const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const [msx, msy] = m0;
      // these two frames differ by the flash geometry alone: same pose, same kick, muzzle light only
      const A0 = r0.pxOn, B0 = r1.pxOn;
      let fx0 = 1e9, fx1 = -1e9, fy0 = 1e9, fy1 = -1e9;
      for (let i = 0; i < A0.length; i++) if (A0[i] !== B0[i]) {
        fpx++; const X = i % BW, Y = (i / BW) | 0, dX = X - msx, dY = Y - msy;
        if (X < fx0) fx0 = X; if (X > fx1) fx1 = X; if (Y < fy0) fy0 = Y; if (Y > fy1) fy1 = Y;
        const al = dX * ux + dY * uy, ac = -dX * uy + dY * ux;
        if (al > along) along = al; if (Math.abs(ac) > across) across = Math.abs(ac);
        sumA += al; sumC += ac;
      }
      fpx ? 0 : fProblems.push('the muzzle flash paints no pixels at all');
      if (fpx >= 8 && !(sumA / fpx > 0)) fProblems.push('flash centroid is BEHIND the muzzle plane (mean along-bore ' + (sumA / fpx).toFixed(1) + ' px)');
      if (fpx >= 8 && Math.abs(sumC / fpx) > 10) fProblems.push('flash centroid is ' + (sumC / fpx).toFixed(1) + ' px off the bore axis - it leaves sideways');
      if (fpx >= 8 && along < 8) fProblems.push('flash reaches only ' + along.toFixed(1) + ' px along the bore');
      fNote = 'flash ' + fpx + ' px  bbox x ' + (fx0 / BW).toFixed(2) + '-' + (fx1 / BW).toFixed(2) +
        ' y ' + (fy0 / BH).toFixed(2) + '-' + (fy1 / BH).toFixed(2) +
        '  along ' + along.toFixed(1) + ' px  across ' + across.toFixed(1) +
        ' px  mean(along ' + (sumA / Math.max(1, fpx)).toFixed(1) + ', across ' + (sumC / Math.max(1, fpx)).toFixed(1) + ')  verts ' +
        fN + ' z ' + fz0.toFixed(3) + '..' + fz1.toFixed(3) + ' of muzzle ' + MU.toFixed(3);
    } else fNote = 'flash ' + fN + ' verts, no anchor to measure it against';
    console.log(('w' + wi + ' ' + kinds[wi] + ' flash').padEnd(24), fNote,
      fProblems.length ? '<< ' + fProblems.join(', ') : '');
    bad += fProblems.length ? 1 : 0;
  }

  /* THE SWAY IS CONVERTED WITH THE PROJECTION, NOT WITH THE CANVAS (#180). The art translated a
     screen-space anchor by bobX DEVICE px (js/40_render.js on main: `ox = DW*(0.5+0.155*(1-ads)) +
     (VM.vx + bobX)*(1-ads*0.6)`), and the rig is a WORLD object, so the term needs the same
     world-units-per-pixel factor the ground and mesh passes use. Lateral, that is 2*planeLen*t/DW -
     planeLen, not 2, because the horizontal field comes from the camera plane. The old conversion used
     2*t/DW and so painted 1/planeLen = 1.39x the art's travel, which is a field-of-view error, not a
     canvas-size one: the ratio it produces tracks planeLen and ignores resolution. Two rows follow.
     (i) painted travel against authored travel, both in raster px; (ii) painted travel against itself
     at a different planeLen, which must NOT move - the authored term is a slide across the screen, so
     the metres it implies are what has to change with the field of view.
     MEASURED NEAR THE PIVOT, ON PURPOSE: the walk also rolls the rig (`roll = ... sin(bobPhase)*0.012
     *(0.4+0.6*sp)`), and a rotation about the anchor moves a mask centroid by leverAngle*leverArm -
     1.8 px of contamination on a 6.8 px signal when averaged over the whole silhouette, which is
     enough to hide a 39% error. Within 70 px of the projected anchor the lever arm is short and the
     contamination is under 0.5 px, so the ratio separates 1.00 from 1.39 instead of reading 1.12 for
     both. The pivot is the instance the frame submitted, not a re-derivation. */
  const amp = (9 + 9 * 1);                       // the art's own bobX amplitude at sprint, device px
  const authored = amp * (DH / 900) * BW / DW;   // device px -> raster px, via the frame's own dims
  const PLANE0 = run('cfg.plane');
  function travel(wide) {
    /* SYMMETRIC ABOUT THE REST POSE, which is why these two states are +/-(PI/2) rather than 0 and
       PI/2: the rig spans depths 0.15 to 0.9 m, so a lateral shift changes the SILHOUETTE as well as
       its position (a near part slides further in px than a far one). Measured from the rest pose that
       is a one-sided bias worth 12% of the signal; measured from +A to -A it is mirror-image and
       cancels, and the translation and the roll lever both simply double. */
    const A = pair('P.sprint=1; keys.KeyW=1; P.vx=4; P.bobPhase=-Math.PI / 2');
    const B = pair('P.sprint=1; keys.KeyW=1; P.vx=4; P.bobPhase=Math.PI / 2');
    return { d: B.o.cxN - A.o.cxN, n: A.o.nx, px: A.o.n, pl: B.cb.planeLen };
  }
  const T1 = travel(false);
  run('cfg.plane = ' + (PLANE0 * 2).toFixed(4) + ';');
  const T2 = travel(true);
  run('cfg.plane = ' + PLANE0 + ';');
  let problems = [];
  if (!(T1.n > 64 && T1.px > MINPX)) problems.push('too few pixels near the pivot to measure travel (' + T1.n + ')');
  else if (!(Math.abs(T1.d / (2 * authored) - 1) <= 0.12)) problems.push('painted sway travel is ' +
    (T1.d / (2 * authored)).toFixed(3) + 'x the art\'s authored travel - the conversion does not use planeLen');
  console.log('sway travel'.padEnd(24), 'authored ' + (2 * authored).toFixed(2) + ' px  painted ' + T1.d.toFixed(2) +
    ' px  ratio ' + (T1.d / (2 * authored)).toFixed(3) + '  (over ' + T1.n + ' px within 70 px of the pivot; DW x DH ' +
    DW + 'x' + DH + ', raster ' + BW + 'x' + BH + ', planeLen ' + T1.pl.toFixed(3) + ')',
    problems.length ? '<< ' + problems.join(', ') : '');
  bad += problems.length ? 1 : 0;
  problems = [];
  if (!(Math.abs(T2.d / T1.d - 1) <= 0.25)) problems.push('sway travel moves ' + (T2.d / T1.d).toFixed(2) +
    'x when the field of view doubles - the slide is tied to the canvas, not to the projection');
  console.log('sway vs field of view'.padEnd(24), 'painted ' + T1.d.toFixed(2) + ' px at planeLen ' + T1.pl.toFixed(3) +
    ', ' + T2.d.toFixed(2) + ' px at planeLen ' + T2.pl.toFixed(3) + '  ratio ' + (T2.d / T1.d).toFixed(3),
    problems.length ? '<< ' + problems.join(', ') : '');
  bad += problems.length ? 1 : 0;

  console.log(bad ? bad + ' viewmodel states with problems' : 'viewmodel: all states paint geometry in the lower-right quadrant, no depth written, shots unaffected, sway travels as authored');
  /* The counter was already here, it just never reached an exit code, so four weapons problems and
     zero were the same green. Without this exit the block also fell through to the scene dump,
     painting a PNG whose mean depends on where this probe left the RNG stream (#89). */
  process.exit(bad ? 1 : 0);
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
  /* #180: the view model is GEOMETRY in the world buffer now, so a probe that isolates a prop by
     pixel diff measures the rifle along with it - measured 12 failures here, every one of them the
     gun in the lower-right corner of the mask ("the silhouette is CUT by the frame, rows ..337").
     The rig is not furniture and not part of the world these rows measure, so it is suppressed here
     the way the viewmodel probe suppresses the WORLD to see the rig alone. */
  run('window.drawViewModel = function () {};');
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
    `if(bd<1.9)continue;` +
    /* The camera has to stand on the BAND whose floor the prop's feet are on, because `floorAt` is per
       cell: the longest-ray direction can leave the prop's room, and an eye a unit below then looks at
       the prop THROUGH that room's floor. The ground pass fills zbuf with Infinity on ceiling rows
       (js/40_render.js:287,:311) and a mesh's only occlusion test is `occ < z` (js/13_mesh.js:524), so
       nothing hides the body there and the mask is the part of it above the low room's ceiling, clipped
       by the top of the frame - measured on the first banded build at level 0 prop 0: cam floor 0.00,
       prop floor 1.00, rows 0..88 of 338, zbuf Infinity behind all 1387 px, while the entry the game
       drew was z=floorAt at the correct height. On a flat level floorAt is equal in every cell, so this
       test passes for every yaw, the argmax above is kept, and the camera is the one that shipped. */
    `const pf=floorAt(p.x,p.y),at=(a,d)=>floorAt(p.x+Math.cos(a)*d,p.y+Math.sin(a)*d);` +
    `if(at(ba,Math.min(2.6,bd-0.7))!==pf){let bj=-1,bv=-1;` +
    `for(let j=0;j<48;j++){const a=j*TAU/48,d=castRayDist(p.x,p.y,Math.cos(a),Math.sin(a),6).dist;` +
    `if(d<1.9||d<=bv||at(a,Math.min(2.6,d-0.7))!==pf)continue;bv=d;bj=j}` +
    `if(bj<0)continue;ba=bj*TAU/48;bd=bv}` +
    `const dd=Math.min(2.6,bd-0.7);` +
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
    /* The orb's z used to be the literal 0.9. Since #163 a mesh is occluded by the ceiling plane, and a
       0.3 m body centred at 0.9 in a one-unit room stands with half its span INSIDE the slab, so (S)
       measured a clipped 30 px instead of the 34-37 px its own authored span gives. It is now hung
       0.35 m under the ceiling of its own cell - under the slab at any band, still above the floor at
       every band, and (F) already reports the orb as airborne because 30_entities.js owns its arc. */
    barrel: `PROPS.length=0;PROPS.push({tex:PROP.barrel,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.86,kind:'barrel',hp:26,dead:false});globalThis.__p=PROPS[0]`,
    crate: `PROPS.length=0;PROPS.push({tex:PROP.crate,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.72,kind:'crate'});globalThis.__p=PROPS[0]`,
    lamp: `PROPS.length=0;PROPS.push({tex:PROP.lamp,x:${SX},y:${SY},z:floorAt(${SX},${SY}),scale:0.95,kind:'lamp'});globalThis.__p=PROPS[0]`,
    pickupHealth: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'health',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    pickupAmmo: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'ammo',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    pickupArmor: `PROPS.length=0;PICKUPS.length=0;PICKUPS.push({type:'armor',x:${SX},y:${SY},bob:0,dead:false});globalThis.__p=PICKUPS[0]`,
    orb: `PROPS.length=0;PROJ.length=0;PROJ.push({kind:'orb',x:${SX},y:${SY},z:ceilAt(${SX},${SY})-0.35,scale:0.3,vx:0,vy:0,vz:0,t:0,tex:PROP.orb[0]});globalThis.__p=PROJ[0]`,
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
    else if (!sp) fail('(S) ' + kind + ': cannot be measured - it renders as a quad that measures exactly its own ' +
      quad.toFixed(0) + ' px (silhouette x' + ratio.toFixed(2) + '), which reports nothing about whether the '
      + 'generator scale survived the port. (A) says why it is a quad, and a row that cannot answer its ' +
      'own question has not passed it');
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
    const cutRef = mA.top <= 0 || mA.bot >= H - 1 || m3.bot >= H - 1, cutTop = m3.top <= 0;
    const airborne = kind === 'orb';
    if (airborne) console.log('    feet: n/a - airborne, z is the arc 30_entities.js owns, not floorAt;'
      + ' UNCOVERED by any gate here');
    /* A silhouette CUT by the frame cannot answer this question: its h and bot are then the frame's own
       edge, so a prop seen from BELOW its band - the case AIM now refuses - reads as "hid 82% of itself"
       without having moved. The two crops are not equally harmless: a reference frame that is cut, or a
       bottom row that runs off either frame, measures nothing at all, while a tall entry (the portal is
       1.5 m) whose TOP leaves the frame only after the raise still has a real bottom edge, so the shift
       is still the prop and only `keep` is a crop - which gets said on the row rather than passed off as
       a kept height. A sunk prop is still caught either way: its bottom row does not rise by `want`. */
    else if (cutRef) fail('(F) ' + kind + ': the silhouette is CUT by the frame (rows ' + mA.top + '..' +
      mA.bot + ' then ' + m3.top + '..' + m3.bot + ' of ' + H + '), so "height kept" and "bottom row" '
      + 'describe the crop and not the feet - the camera is not looking at this prop from its own band');
    else if (keep < 0.9 && !cutTop) fail('(F) ' + kind + ': SUNK IN THE BAND - raising its floor by one quantum (0.25 m, a step, '
      + 'so no riser is drawn and nothing occludes it) hid ' + (100 * (1 - keep)).toFixed(0) + '% of it (height '
      + mA.h + ' -> ' + m3.h + ' px, bottom ' + mA.bot + ' -> ' + m3.bot + ') on ' + who + ': its z is not floorAt(x,y)');
    else if (shift < want * 0.4) fail('(F) ' + kind + ': the floor rose one quantum and the prop did not (bottom row '
      + mA.bot + ' -> ' + m3.bot + ', expected ~' + want.toFixed(0) + ' px up) on ' + who +
      ' - it is painted at the old plane, so it sinks into any band above 0');
    else console.log('    feet: height kept ' + (100 * keep).toFixed(0) + '%, bottom row up ' + shift +
      ' px (expected ~' + want.toFixed(0) + ') on ' + who +
      (cutTop ? ' [top of the ' + m3.h + ' px body leaves the frame after the raise: height is a crop, '
        + 'the bottom row is not]' : ''));
  }
  /* #218: props stop the player. tryMove consults the SAME authored footprint row (F)'s siblings
     draw with (MESH.foot * scale, js/13_mesh.js:799) grown by the mover radius, gated on the grid:
     a prop on another band hangs in the air and blocks no one. These rows drive the REAL loop
     (update -> updatePlayer -> tryMove), never a poke of P.x, and each one prints the population
     it drove - a prop-collision row that silently never reached a prop is the `alt` pit-population
     family, so reaching is counted, and zero reached is a FAILURE not an ok. The drives set keys
     and tick frames so gravity, the auto-step and the landing impulse are all live, per #218's
     own ask: sampling the post-update state after gravity would self-cancel. */
  console.log('  PROP COLLISION (#218)');
  const RAD218 = 0.28;                                       // the player radius js/30_entities.js calls tryMove with
  const row218 = (label, ok, detail) => {
    console.log('    ' + label.padEnd(26) + (ok ? ' ok  ' : 'FAIL ') + ' ' + detail);
    if (!ok) bad++;
  };
  const FOOTK = {};
  for (const k of ['barrel', 'crate', 'lamp']) FOOTK[k] = run('MESH.foot(' + JSON.stringify(k) + ')');
  const DRIVE = (sx, sy, i, frames) => `(()=>{
    const p=PROPS[${i}]; const f=MESH.foot(p.kind)*(p.scale||1), r=f+${RAD218};
    P.x=${sx.toFixed(4)};P.y=${sy.toFixed(4)};P.z=floorAt(P.x,P.y);P.vx=0;P.vy=0;P.air=false;P.deadT=0;
    P.ang=Math.atan2(p.y-P.y,p.x-P.x);keys['KeyW']=1;
    let minEdge=1e9,fIn=0,deep=0;
    for(let k=0;k<${frames};k++){update(1/60);
      const ax=Math.abs(p.x-P.x),ay=Math.abs(p.y-P.y);
      if(ax<f&&ay<f&&Math.abs(floorAt(p.x,p.y)-floorAt(P.x,P.y))<ZQ){fIn++;const dp=f-Math.max(ax,ay);if(dp>deep)deep=dp;}
      const e=Math.max(ax,ay)-r;if(e<minEdge)minEdge=e;
    }
    keys['KeyW']=0;
    const ax=Math.abs(p.x-P.x),ay=Math.abs(p.y-P.y);
    return{minEdge:+minEdge.toFixed(4),fIn,deep:+deep.toFixed(3),
      inside:ax<f&&ay<f&&Math.abs(floorAt(p.x,p.y)-floorAt(P.x,P.y))<ZQ};
  })()`;
  const BAND218 = (i, raise, frames) => `(()=>{
    const p=PROPS[${i}]; const f=MESH.foot(p.kind)*(p.scale||1), r=f+${RAD218};
    const cx=p.x|0, fzi=(p.y|0)*MW+cx, sx=cx-0.02, sy=p.y-r-0.30;
    if(${raise ? 1 : 0}){MAP.fz[fzi]+=1;linkBoundaries();}
    P.x=sx;P.y=sy;P.z=floorAt(sx,sy);P.vx=0;P.vy=0;P.air=false;P.deadT=0;P.ang=Math.PI/2;keys['KeyW']=1;
    let crossed=false,minEdge=1e9,fIn=0;
    for(let k=0;k<${frames};k++){update(1/60);
      const ax=Math.abs(p.x-P.x),ay=Math.abs(p.y-P.y);
      const e=Math.max(ax,ay)-r;if(e<minEdge)minEdge=e;
      if(ax<f&&ay<f&&Math.abs(floorAt(p.x,p.y)-floorAt(P.x,P.y))<ZQ)fIn++;
      if(P.y>p.y+r){crossed=true;break;}
    }
    keys['KeyW']=0;
    const stepOK=${raise ? 'canEnter(sx,p.y,cx+0.5,p.y)' : 'true'};
    if(${raise ? 1 : 0}){MAP.fz[fzi]-=1;linkBoundaries();}
    return{crossed,minEdge:+minEdge.toFixed(3),fIn,stepOK,r:+r.toFixed(3)};
  })()`;
  const SLIDE218 = (i, frames) => `(()=>{
    const p=PROPS[${i}]; const f=MESH.foot(p.kind)*(p.scale||1), r=f+${RAD218};
    P.x=p.x+r+0.45;P.y=p.y-r-0.20;P.z=floorAt(P.x,P.y);P.vx=0;P.vy=0;P.air=false;P.deadT=0;
    P.ang=Math.atan2(0.866,-0.5);keys['KeyW']=1;
    let crossed=false,minEdge=1e9,fIn=0;
    for(let k=0;k<${frames};k++){update(1/60);
      const ax=Math.abs(p.x-P.x),ay=Math.abs(p.y-P.y);
      const e=Math.max(ax,ay)-r;if(e<minEdge)minEdge=e;
      if(ax<f&&ay<f&&Math.abs(floorAt(p.x,p.y)-floorAt(P.x,P.y))<ZQ)fIn++;
      if(P.y>p.y+r){crossed=true;break;}
    }
    keys['KeyW']=0;
    return{crossed,minEdge:+minEdge.toFixed(3),fIn,fy:+P.y.toFixed(3)};
  })()`;
  for (let li = 0; li < 3; li++) {
    run(`S.mode='play'; S.locked=false; startLevel(${li}, true); ENEMIES.length=0; PROJ.length=0;`);
    const cands = run(`(()=>{for(const p of PROPS)if(p.kind==='crate'||p.kind==='barrel'||p.kind==='lamp'){}
      return PROPS.map((p,i)=>({i,k:p.kind,x:p.x,y:p.y,s:p.scale||1,gz:floorAt(p.x,p.y)}))})()`);
    const cen = {}; let nSolidProp = 0;
    for (const c of cands) { cen[c.k] = (cen[c.k] || 0) + 1; if (FOOTK[c.k] > 0) nSolidProp++; }
    /* row 1: head-on drives into authored props from the four axis directions */
    const chosen = []; const perK = {};
    for (const c of cands) { if (FOOTK[c.k] <= 0) continue; if ((perK[c.k] || 0) >= 2) continue; perK[c.k] = (perK[c.k] || 0) + 1; chosen.push(c); }
    const offs = [[1.35, 0], [-1.35, 0], [0, 1.35], [0, -1.35]];
    const poses = []; let skippedHatch = 0;
    for (const c of chosen) for (const o of offs) {
      const sx = c.x + o[0], sy = c.y + o[1];
      const v = run(`({s:isSolid(${sx.toFixed(4)},${sy.toFixed(4)}),z:floorAt(${sx.toFixed(4)},${sy.toFixed(4)}),h:(typeof propBlocks==='function')&&propBlocks(${sx.toFixed(4)},${sy.toFixed(4)},${RAD218})})`);
      if (v.s || v.h || Math.abs(v.z - c.gz) >= run('ZQ')) { if (v.h) skippedHatch++; continue; }  // buried, hatched start or band-crossing pose: cannot test the blocker
      poses.push({ c, sx, sy });
    }
    let drove = 0, reached = 0, penPoses = 0, penFrames = 0, penDeep = 0, worstEdge = -9;
    for (const q of poses) {
      const o = run(DRIVE(q.sx, q.sy, q.c.i, 45));
      drove++;
      if (o.minEdge <= 0.12) reached++;
      if (o.minEdge > worstEdge) worstEdge = o.minEdge;
      penFrames += o.fIn;
      if (o.fIn || o.inside) { penPoses++; if (o.deep > penDeep) penDeep = o.deep; }
    }
    row218('blocks drove-in player',
      drove > 0 && reached > 0 && penPoses === 0 && penFrames === 0,
      reached === 0 || drove === 0
        ? 'VACUITY: drove ' + drove + ' poses into ' + nSolidProp + ' props (' + JSON.stringify(cen) +
          ') and REACHED none - the row tested nothing'
        : 'props ' + cands.length + ' (' + JSON.stringify(cen) + '), drove ' + drove + ' poses, '
          + reached + ' REACHED the blocker' + (skippedHatch ? ' (+' + skippedHatch + ' starts skipped as inside another prop\'s blocker)' : '') +
          ', poses ever inside a footprint ' + penPoses +
          ' (frames ' + penFrames + ', deepest ' + penDeep.toFixed(2) + ' m past the centre edge), '
          + 'worst stopped edge +' + worstEdge.toFixed(2) + ' m');
    /* row 2: the band case on a crate whose grown footprint (foot*scale+rad > 0.5) overhangs the
       neighbouring cell, so a band-blind test can reach the lane; raised cell is +1 quantum = a
       step, not a boundary (row (F)'s own precedent), so no wall can stand in for the band term */
    let bi = -1;
    for (const c of cands) {
      if (c.k !== 'crate' || FOOTK.crate * c.s + RAD218 <= 0.52) continue;
      const cx = Math.floor(c.x), cy = Math.floor(c.y);
      const laneOK = run(`!isSolid(${cx - 0.02},${cy - 0.35})&&!isSolid(${cx - 0.02},${c.y})&&!isSolid(${cx - 0.02},${cy + 1.4})&&!(typeof propBlocks==='function'&&propBlocks(${cx - 0.02},${cy - 0.35},${RAD218}))&&!(typeof propBlocks==='function'&&propBlocks(${cx - 0.02},${cy + 1.4},${RAD218}))`);
      if (laneOK) { bi = c.i; break; }
    }
    if (bi < 0) row218('respects the band', false,
      'VACUITY: no generated crate whose ghost (foot*scale+' + RAD218 + ') overhangs an open flanking lane on level ' + li);
    else {
      const A = run(BAND218(bi, 1, 50)), B = run(BAND218(bi, 0, 50));
      row218('respects the band',
        A.stepOK && A.crossed && A.fIn === 0 && !B.crossed && B.fIn === 0 && B.minEdge <= 0.12,
        'crate#' + bi + ' ghost r ' + A.r + ' m overhangs the lane by ' + (A.r - 0.5).toFixed(2) +
        ' m: raised one quantum (a step, canEnter across the lip = ' + A.stepOK + ') walked through = ' +
        A.crossed + ' (ghost min edge ' + A.minEdge + ', never inside); same-band control blocked at edge '
        + B.minEdge + ' crossed=' + B.crossed + (B.fIn ? ' PENETRATED ' + B.fIn + ' frames' : ''));
    }
    /* row 3: slide, not seal - a pose that grazes the prop's face at ~20 deg must keep advancing
       along the free axis and end past the prop's far edge of the ghost; a seal blocks the whole
       move at first contact and the pose dies beside the face */
    const spos = [];
    for (const c of cands) {
      if (FOOTK[c.k] <= 0) continue;
      const cx = Math.floor(c.x), cy = Math.floor(c.y);
      const r = FOOTK[c.k] * c.s + RAD218;
      const laneOK = run(`!isSolid(${(c.x + r + 0.45).toFixed(4)},${(c.y - r - 0.2).toFixed(4)})&&!isSolid(${cx + 1},${cy - 1})&&!isSolid(${cx + 1},${cy + 1})&&!(typeof propBlocks==='function'&&propBlocks(${(c.x + r + 0.45).toFixed(4)},${(c.y - r - 0.2).toFixed(4)},${RAD218}))`);
      if (laneOK) spos.push(c);
      if (spos.length >= 4) break;
    }
    let sBrush = 0, sCross = 0, sSkip = 0, sWorst = 9;
    for (const c of spos) {
      const o = run(SLIDE218(c.i, 60));
      if (o.minEdge > 0.12) { sSkip++; continue; }        // the lane never met the ghost: pose tests nothing
      sBrush++;
      if (o.crossed) sCross++;
      else sWorst = Math.min(sWorst, o.fy);
    }
    row218('slides, does not seal',
      sBrush > 0 && sCross === sBrush,
    sBrush === 0 ? 'VACUITY: ' + spos.length + ' candidate props on level ' + li + ', NONE brushed the ghost (skipped ' + sSkip + ') - the row tested nothing' :
      spos.length + ' face-graze poses at ~30 deg, brushed ' + sBrush + ' (skipped ' + sSkip + ' that never met the ghost), crossed the lane ' + sCross +
      (sCross < sBrush ? ' - stuck beside the face (worst final y ' + sWorst.toFixed(2) + ')'
        : ' (a seal would stop at first contact instead of sliding on the free axis)'));
  }
  console.log(bad ? 'PROPS PROBE: ' + bad + ' FAILURE(S)' : 'PROPS PROBE: every prop volumetric, light-exempt where emissive, grounded, and solid to the player');
  process.exit(bad ? 1 : 0);
}
if (MODE === 'bands') {
  /* #164: altitude reached the geometry (#162) and no pixels - a player can climb a staircase and
     report "almost impossible to tell I was on a different level". These rows ask the question that
     complaint describes: WHERE THE RENDERER'S OWN DEPTH says the surface jumps, does the luminance
     jump with it, and is the jump an EDGE (a narrow band at the crease) rather than a level shift?
     Nothing here pokes MAP.fz - the lips come out of the GENERATED grid, the column classification
     out of the renderer's ray and the seam A/B out of the SEAM global, so no row can be satisfied by
     geometry the probe drew for itself (the trap every vertical row in this file used to have), and
     every number counts columns, rows and pixels because an average cannot see the WIDTH of a band. */
  let bad = 0, knownN = 0, rowsN = 0, STRICT = !!process.env.STRICT;   // debt rows go red under STRICT=1
  const debts = new Set();
  const W = run('BW'), H = run('BH'), ZQS = run('ZQ');
  const DIST = +(process.env.DIST || 3.5), STRIDE = +(process.env.STRIDE || 2);
  // a column counts only when the plane it crossed IS the target plane: averaging columns that
  // crossed a different lip smears the pair measure (measured 9.4 vs 38 for one and the same step)
  const TOL = +(process.env.TOL || 0.06);
  const DBG = !!process.env.DBG;
  const SEAMW = run('typeof SEAMW === "number" ? SEAMW : 0');
  const row = (label, ok, detail, debt, belowBar) => {
    // A debt row is the shape this repo uses for a shortfall that is REAL and MEASURED but not owned
    // by the change in front of it: it reports KNOWN rather than silently widening a threshold until
    // the row cannot fail, it goes red the moment the number falls past a floor measured on the
    // build that shipped it, and STRICT=1 promotes it to a failure - so the debt is still seen to
    // fail, which is the whole difference between a known issue and a disabled test (#188's lesson).
    // `ok` is that floor; `belowBar` says the FULL expectation was not met, which is what keeps the
    // debt VISIBLE in a passing run instead of hidden inside a widened threshold.
    const known = ok && !!debt && !!belowBar && !STRICT;
    rowsN++;
    console.log('  ' + label.padEnd(52) + (ok && !belowBar ? ' ok  ' : known ? 'KNOWN' : ' FAIL') + '  ' + detail +
      (ok && !belowBar ? '' : !debt ? '' : '  [' + debt + ']'));
    if (ok && !belowBar) return;
    if (known) { knownN++; debts.add(debt); } else bad++;
  };
  const lum = (b, i) => 0.2126 * (b[i] & 255) + 0.7152 * (b[i] >> 8 & 255) + 0.0722 * (b[i] >> 16 & 255);
  // -1 when the build has no such term: an assignment to a name the renderer never reads would
  // silently create a new global and the A/B control would then prove nothing (AGENTS: a control
  // that self-cancels is worse than no control), so the toggle is read back AND timed on pixels.
  const seamArm = v => run('(function(){ if (typeof SEAM !== "number") return -1; SEAM = ' + v + '; return SEAM; })()');
  const lumAvg = (b, w, y0, y1, x) => {
    const a = Math.max(0, Math.min(H - 1, Math.round(y0))), e = Math.max(0, Math.min(H - 1, Math.round(y1))), st = e >= a ? 1 : -1;
    let s = 0, n = 0;
    for (let y = a; st > 0 ? y <= e : y >= e; y += st) { s += lum(b, y * w + x); n++; }
    return n ? s / n : 0;
  };
  /* First surface change along every column's ray, in the renderer's own parametrisation
     (point = cam + ray * t, and t is also the perpendicular distance because dir.(dir + plane*cam)
     = 1), refined by bisection so the row maths is not quantized by the sampling step. A crossing
     into an open cell at the same altitude is not an event - the DDA does not stop there either.
     kind: wall = a solid column; face = an air->air step of >=2 quanta; walk = exactly 1 quantum,
     which is WALKABLE (canEnter steps over it, VB_BLOCK stays clear) and since #192 draws a face
     like any other step - the two kinds differ in the SPAN they paint, a wall-like step in a
     one-unit room closing to the ceiling plane of the air side, a one-quantum step being the side
     of a 0.25 m slab. ramp/ladder links draw no lip in either case, so they are excluded from both
     kinds. Before #192 the walk branch of the rows below asserted the ABSENCE of geometry, which is
     the defect the renderer fix is about. */
  const march = (cx, cy, all) => run(`(function () {
    const N = MAP.w, cell = MAP.cell, fz = MAP.fz, vb = MAP.vb, sb = 2 / BW;
    const NX = [1, 0, -1, 0], NY = [0, 1, 0, -1];
    // all=1 enumerates every crease the wall pass could paint, so it marches as far as castWalls
    // does (the guard, i.e. the map border) instead of stopping at the row's own 3.5 m sample plane
    const D = ${all ? 60 : DIST} + 0.3, CX = ${cx}, CY = ${cy}, RES = [], STOP1 = ${all ? 0 : 1};
    const ceilOf = i => {                       // js/10_world ceilAt, mirrored for the face's top
      const f = fz[i], x = i % N, y = (i / N) | 0; let m = 0;
      for (let k = 0; k < 4; k++) { const nx = x + NX[k], ny = y + NY[k]; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue; const j = ny * N + nx; if (cell[j] || fz[j] > f) m = Math.max(m, fz[j] - f); }
      return (f + Math.max(1, m)) * ZQ;
    };
    for (let x = 1; x < BW - 1; x += ${STRIDE}) {
      const cam = x * sb - 1, rx = dirX + planeX * cam, ry = dirY + planeY * cam;
      let mx = CX | 0, my = CY | 0, t = D, guard = 0, ev = null;
      if (mx < 0 || my < 0 || mx >= N || my >= N || cell[my * N + mx]) { RES.push([x, 'void', 0, 0, 0, 0, 0]); continue; }
      const sX = rx < 0 ? -1 : 1, sY = ry < 0 ? -1 : 1;
      const qX = Math.abs(1 / rx), qY = Math.abs(1 / ry);
      let sdX = rx < 0 ? (CX - mx) * qX : (mx + 1 - CX) * qX;
      let sdY = ry < 0 ? (CY - my) * qY : (my + 1 - CY) * qY;
      let prev = my * N + mx;
      while (guard++ < 300) {                    // castWalls' own enumeration, side semantics included
        let d;
        if (sdX < sdY) { mx += sX; t = sdX; sdX += qX; d = sX > 0 ? 0 : 2; }
        else { my += sY; t = sdY; sdY += qY; d = sY > 0 ? 1 : 3; }
        if (t > D) break;
        const cur = my * N + mx;
        if (cell[cur]) { const a = fz[prev], w = fz[cur]; ev = [x, 'wall', w - a, t, a * ZQ, Math.max(a, w) * ZQ, ceilOf(prev)]; break; }
        const dq = fz[cur] - fz[prev];
        if (dq) {
          if (vb[prev] & (VB_RAMP | VB_LADDER) << (d << 2)) { prev = cur; continue; }   // climbable: no lip
          if (Math.abs(dq) > 1) {          // js/40_render.js:567 draws the SLAB side of an air->air step
            ev = [x, 'face', dq, t, fz[prev] * ZQ, Math.min(fz[cur], fz[prev]) * ZQ, Math.max(fz[cur], fz[prev]) * ZQ];
            break;
          }
          ev = [x, 'walk', dq, t, fz[prev] * ZQ, Math.min(fz[cur], fz[prev]) * ZQ, Math.max(fz[cur], fz[prev]) * ZQ];
          if (STOP1) break;                       // all=1: the row's own first event; all=0: keep the whole list
          RES.push(ev); ev = null; prev = cur; continue;
        }
        prev = cur;
      }
      RES.push(ev || [x, 'far', 0, D, fz[prev] * ZQ, 0, 0]);
    }
    return RES;
  })()`);

  /* A boundary of the wanted kind with a straight level 5-cell approach in any of the four
     directions, nearest the spawn - the lip a player meets first. A tie goes to the one whose side
     cells match, so most of the frame is looking at it. */
  const lipFor = (kind, sx, sy) => run(`(function () {
    const N = MW, cell = MAP.cell, fz = MAP.fz, vb = MAP.vb, want = ${JSON.stringify(kind)};
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    let best = null, bs = -1;
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      for (let d = 0; d < 4; d++) {
        const i = y * N + x, j = (y + DY[d]) * N + x + DX[d];
        if (cell[i] || cell[j] || j < 0 || j >= N * N) continue;
        const dq = fz[j] - fz[i]; if (!dq) continue;
        const linked = !!(vb[i] & (VB_RAMP | VB_LADDER) << (d << 2));
        const here = Math.abs(dq) > 1 ? (linked ? 'ramp' : 'face') : 'walk';
        if (here !== want) continue;
        let ok = 1;
        for (let k = 1; k <= 4; k++) {
          const cx2 = x - DX[d] * k, cy2 = y - DY[d] * k;
          if (cx2 < 1 || cy2 < 1 || cx2 >= N - 1 || cy2 >= N - 1) { ok = 0; break; }
          const c = cy2 * N + cx2;
          if (cell[c] || fz[c] !== fz[i]) { ok = 0; break; }
        }
        if (!ok) continue;
        const p = d % 2 === 0 ? 1 : 0;                              // the lip's own long axis
        let wide = 1;
        for (const s of [-1, 1]) {
          const a = (y + DY[p] * s) * N + x + DX[p] * s, b = a + DY[d] * N + DX[d];
          if (cell[a] || cell[b] || fz[a] !== fz[i] || fz[b] !== fz[j]) break;
          wide++;
        }
        const dd = Math.hypot(x + 0.5 - ${sx}, y + 0.5 - ${sy});
        const sc = wide * 1000 - dd;
        // the BOUNDARY PLANE, not the cell centre: a +x crossing lives at x+1 and a -x one at x, so
        // the lens sits DIST of PERPENDICULAR distance from the lip the rows are solved against
        const ppx = x + (DX[d] > 0 ? 1 : DX[d] < 0 ? 0 : 0.5), ppy = y + (DY[d] > 0 ? 1 : DY[d] < 0 ? 0 : 0.5);
        if (sc > bs) { bs = sc; best = { x, y, d, dq, wide, cx: ppx - DX[d] * ${DIST}, cy: ppy - DY[d] * ${DIST}, ang: Math.atan2(DY[d], DX[d]) }; }
      }
    }
    return best || { skip: 'no boundary of that kind with a straight level 5-cell approach' };
  })()`);

  const pose = (cx, cy, ang) => run(`(function () {
    ENEMIES.length = 0; PROPS.length = 0; PROJ.length = 0; PARTS.length = 0;   // isolate the cast
    P.x = ${cx}; P.y = ${cy}; P.ang = ${ang}; P.pitch = 0; P.crouch = 0;
    P.vx = 0; P.vy = 0; P.vz = 0; P.air = false; P.bob = 0; P.kick = 0; P.z = floorAt(P.x, P.y);
    return 1;
  })()`);

  // the share of lip pixels that are indistinguishable from their neighbour - the visibility floor,
  // and the reason a contrast of 1.0 between two near-black rows cannot pass this row.
  const WITHIN_MAX = +(process.env.WITHIN_MAX || 35);
  /* The step is judged as CONTRAST, |a-b|/(a+b), not as absolute luminance. A crease is a MULTIPLY in
     the renderer (the lip row keeps 1 - SEAMD - SEAMC = 0.16 of what was there), so the most it can
     move is 0.84 times how bright the surface already is: the branch's L1 walk lip sits on a floor
     that renders at 27.6 with the row in front at 29.5, so its ceiling on mean |dL| is 23.2 and an
     absolute 30 is unreachable however hard the renderer works - while the SAME 84% crease on main's
     L1 walk lip (68.3 / 84.6) measured 73.7. Measured on the six lips of each tree: seam ON 0.55-0.79
     on the branch and 0.56-0.79 on main, seam OFF 0.11-0.31, and 0.11-0.12 on the columns whose
     crease the wall pass drops for a farther riser. The threshold sits in that gap: the worst failing
     value measured is 0.31, the best passing one 0.55. */
  const CON_MIN = +(process.env.CON_MIN || 0.45);
  /* CON_WFLOOR is the hard line under the WALK kind's contrast debt (#192): 0.12 is what the worst
     generated level measures on the build that introduced the face (L0 0.76, L1 0.26, L2 0.12), and
     0.00 is what a renderer that draws no geometry at all measures there, so the row still fails hard
     on main and stays a KNOWN row on this one until the riser's material/lighting is tuned. */
  const CON_WFLOOR = +(process.env.CON_WFLOOR || 0.06);
  /* CON_FLOOR is the hard line under the FACE kind's contrast debt (#203): the lamp-band weight
     removes the pool a deck lamp used to cast DOWN onto the lip floor - #203's own example of the
     bug - and that pool was load-bearing at the L2 lip, which sat at 0.46 against the 0.45 bar on
     main. Measured on the fixed build 0.61 (L0) / 0.69 (L1) / 0.43 (L2); the floor sits one notch
     under the worst (0.40) so the row stays KNOWN for this debt and goes hard-red on any build
     that removes more edge than the weight does. The naive reach=1 control measures the SAME
     0.43 here (it differs from the fix only at dz 1.03, a class this lip's floor is not in) - the
     bands row is not what rejects that design; the alt weight-table rows are.
     #206 consumed the notch at the same mechanism's diffuse half: the blur no longer carries the far
     band's light down onto the lip floor either, which is the tail #203 removed from the splat. The
     L2 lip's pair, measured per column across the row's own cameras, moved lU 33.10 -> 30.67 (the
     floor in front of the step - that is the deleted tail) with lD 12.03 -> 11.99 (the riser row,
     untouched), and the face kind's worst generated level reads 0.43 (post-#203 main) -> 0.39.
     The floor moves one notch under the new worst, exactly as it moved under the old one, so the row
     stays KNOWN for the #203 debt (a light-independent riser mechanism - same tension as the body
     rim) and still goes hard-red on any build removing more edge than this kernel does. */
  const CON_FLOOR = +(process.env.CON_FLOOR || 0.36);
  // the same rule for the seam band's depth: mean(B-A) over the band, over mean(A) over that band.
  // Measured 1.13-1.45 on all six lips of the branch with the term on, 0.00 with SEAM=0.
  const DROP_CON_MIN = +(process.env.DROP_CON_MIN || 0.45);
  /* #197's two bars, both measured on the trees that needed them (see the far-band block below): the
     step over the FARB boundary, and the share of the frame that may be near-black. A half-frame with no
     band in it at all is VACUOUS and counts against the row, never in its favour. */
  const FARB_STEP_MAX = +(process.env.FARB_STEP_MAX || 8);
  const FARDARK_MAX = +(process.env.FARDARK_MAX || 55), FARDARK_L = +(process.env.FARDARK_L || 24);
  for (let li = 0; li < 3; li++) {
    const spawn = run(`(function () { startLevel(${li}, true); return [P.x, P.y]; })()`);
    // SEAM=0 runs this whole probe with the term switched off in the renderer, so the same rows can
    // be shown red against the shipped build rather than only against a base checkout
    const seam = seamArm(process.env.SEAM === '0' ? 0 : 1);
    let diffPx = 0;
    for (const kind of ['face', 'walk']) {
      const L = lipFor(kind, spawn[0], spawn[1]);
      if (L.skip) { row(`L${li} ${kind} lip exists to measure`, false, L.skip); continue; }
      pose(L.cx, L.cy, L.ang);
      if (seam === 1) {
        run('SEAM = 1');
        if (process.env.SEAMD) run('SEAMD = ' + Number(process.env.SEAMD));
        if (process.env.SEAMU) run('SEAMU = ' + Number(process.env.SEAMU));
        if (process.env.SEAMW) run('SEAMW = ' + Number(process.env.SEAMW));
      }
      run('S.t = 3.5; renderWorld()');
      const A = new Uint32Array(run('px')), zb = new Float32Array(run('zbuf'));
      const hor = run('horizon'), eye = run('eyeZ'), risers = run('MAP.riserStops');
      let B = A;
      if (seam === 1) { run('SEAM = 0'); run('S.t = 3.5; renderWorld()'); B = new Uint32Array(run('px')); run('SEAM = 1'); }
      const m = march(L.cx, L.cy);
      /* Every crease each column contains, not just the one the row measures: a staircase puts the
         next tread's lip above this one and the sunken block's riser behind it, and the seam paints
         those bands too. Locality has to be measured on rows NO crease reaches, or the next lip's own
         edge is booked as a leak (measured 10.2 on the branch's L2 walk lip, on rows that belonged to
         a real riser). A tint moves rows nothing reaches, so it still counts as a leak. */
      const creaseByX = {};
      /* Each entry is one band seamCrease will paint: [perp, anchor altitude, the altitude the band
         runs TOWARD, dir]. The band runs into the face from its anchor row, so a step DOWN - whose
         drawn slab side lies BELOW yc(the eye's own floor) - is masked below that row, not above it
         (#195); the lower floor's crease and the far lip's catch-light both run up. Masking every
         band upward from the anchor instead hides rows no term reaches and leaves the rows a down-step
         lip does reach unmasked, which reads as a 6-10 px-lum leak on a build whose seam is local. */
      for (const c of march(L.cx, L.cy, 1)) {
        if (c[1] === 'walk' || c[1] === 'face') {
          const zE = c[4], zL = c[5], zH = c[6], zO = zE === zL ? zH : zL;
          const list = (creaseByX[c[0]] = creaseByX[c[0]] || []);
          list.push([c[3], zE, zO, zO > zE ? -1 : 1]);                  // the lip the eye stands at
          if (zE !== zL) list.push([c[3], zL, zH, -1]);                 // step down: the far crease too
          list.push([c[3], zH, zL, -1]);                                // the far lip's catch-light
        }
      }
      const reaches = (x, y) => {
        const cs = creaseByX[x];
        if (!cs) return false;
        for (let k = 0; k < cs.length; k++) {
          const h2 = H / cs[k][0], yA = hor + (eye - cs[k][1]) * h2, yB = hor + (eye - cs[k][2]) * h2;
          const b2 = Math.min(Math.abs(yB - yA) * 0.5, h2 * SEAMW), dir = cs[k][3] === 1 ? 1 : -1;
          const y0 = dir > 0 ? Math.ceil(yA) : Math.floor(yA), y1 = y0 + dir * b2;
          if (dir > 0 ? (y >= y0 && y <= y1) : (y <= y0 && y >= y1)) return true;
        }
        return false;
      };
      const lumDiffClear = (p, q, x, y0, y1) => {
        const a = Math.max(0, Math.min(H - 1, Math.round(y0))), e = Math.max(0, Math.min(H - 1, Math.round(y1))), st = e >= a ? 1 : -1;
        let s = 0, n2 = 0;
        for (let y = a; st > 0 ? y <= e : y >= e; y += st) {
          if (reaches(x, y)) continue;
          s += Math.abs(lum(p, y * W + x) - lum(q, y * W + x)); n2++;
        }
        clearRows += n2;
        return n2 ? s / n2 : 0;
      };
      if (DBG) {
        const hsh = {};
        for (const c of m) { const k = c[1] + (Math.abs(c[3] - DIST) <= TOL ? '@D' : '@else'); hsh[k] = (hsh[k] || 0) + 1; }
        console.log(`    dbg L${li} ${kind} lip (${L.x},${L.y}) d${L.d} dq ${L.dq} wide ${L.wide} cam(${L.cx.toFixed(2)},${L.cy.toFixed(2)}) ang ${L.ang.toFixed(3)}: ` + JSON.stringify(hsh));
      }
      let n = 0, sum = 0, sgn = 0, within = 0, zok = 0, off = 0;
      let dropSum = 0, wideSum = 0, spanSum = 0, farSum = 0, farN = 0, dip = 0, touched = 0, near0 = 0, conSum = 0, refSum = 0, clearRows = 0;
      /* #167's placement claim, measured on the EYE's own side of the boundary and on the FACE's own
         side of the lip. The form this replaces located the band by argmax INSIDE +-win of the analytic
         lip row, so a band displaced across the lip could not be seen at all: the search always found
         "a" band and called it near, which is why the row could print 60 of 60 while the walkable crease
         was keyed on a crossing other than the one those pixels resolve against. Two things are fixed
         here: the anchor is yc = the row of the floor the RAY STANDS ON (c[4], never the height-sorted
         lower floor - for a step DOWN the lower floor is the FAR side and its projection lands on the
         NEAR floor's rows, so anchoring on it measures a plane no pixel shows), and the verdict is the
         side-aware one in the column loop below. WIDE is only the window that separates DISPLACED (a
         band exists, not on this face) from NOTHING (no band within +-WIDE of the lip, ~1.3 m at DIST).
         NEAR = a band inside the painted face, on its side of the lip; FAR = a band only beyond the lip;
         NOMOVE = the term painted nothing in the window: vacuity, never a pass. */
      const WIDE = 4 * Math.max(6, Math.round(2 * (H / DIST) * SEAMW));
      let nearW = 0, farW = 0, noW = 0;
      for (const c of m) {
        if (c[1] !== kind || Math.abs(c[3] - DIST) > TOL) continue;
        const x = c[0], perp = c[3], zLo = c[5], zHi = c[6], hp = H / perp;
        // yLip is the row the VISIBLE surface changes at: the camera side of the boundary. A floor
        // below the eye always projects below its own row, so every row under yLip is the near floor
        // and every row above it is the far surface - the seam band runs upward from yLip in every
        // case, and the pair that straddles the lip is (yLip, yLip + 1) whichever way the step goes.
        const zCam = kind === 'face' ? zLo : c[4], zOther = zCam === zLo ? zHi : zLo;
        const yLip = hor + (eye - zCam) * hp, yOther = hor + (eye - zOther) * hp;
        const bw = Math.min(Math.abs(yOther - yLip) * 0.5, hp * SEAMW), yF = Math.floor(yLip);
        if (yF < bw + 16 || yF > H - 14) continue;
        if (kind === 'face') {                          // the wall pass must have painted a face here
          if (Math.abs(zb[yF * W + x] - perp) > 0.02) { off++; continue; }
          zok++;
        } else {
          /* A walk lip carries a FACE now (#192), so this is the branch above's expectation: the
             boundary's own perpendicular distance, same tolerance. Read at a row INSIDE the riser's
             span rather than at yLip, because yLip is the span's EDGE - the one row where the ground
             pass and the wall pass both answer, and a one-quantum riser is only ~24 rows tall at
             DIST, so the edge row is a rounding decision rather than a measurement. */
          const s0 = Math.ceil(hor + (eye - zHi) * hp), s1 = Math.floor(hor + (eye - zLo) * hp);
          const yS = Math.round((s0 + s1) / 2);
          if (yS < 0 || yS >= H || Math.abs(zb[yS * W + x] - perp) > 0.02) { off++; continue; }
          zok++;
        }
        // the pair across the step lip: the lip row and the floor immediately in front of it
        const lU = lum(A, (yF + 1) * W + x), lD = lum(A, yF * W + x);
        const dP = lU - lD, den = lU + lD;
        n++; sum += Math.abs(dP); sgn += dP; if (Math.abs(dP) <= 10) within++;
        conSum += den > 12 ? Math.abs(dP) / den : 0;
        // the seam on its own, with everything else about the frame held still. Its band is located
        // empirically - the strongest shift anywhere within +-0.5 m of the geometric lip - and the
        // OFFSET from the analytic lip is asserted below, because a seam painted 1 m from the step it
        // is supposed to describe would otherwise read as a pass. (The renderer keys the seam on the
        // cell its own DDA stepped from, and on columns that clip a cell corner that cell is not the
        // one a sampled march lands in: measured 22 px apart on L2, which is one quantum.)
        const win = Math.max(6, Math.round(2 * hp * SEAMW));
        let yb = -1, peak = 0;
        for (let y = Math.max(0, yF - win); y <= Math.min(H - 1, yF + win); y++) {
          const d = lum(B, y * W + x) - lum(A, y * W + x);
          if (d > peak) { peak = d; yb = y; }
        }
        const bRows = (() => {
          let k = 0;
          for (let y = yb; y >= 0 && y >= yb - win - 2; y--) {
            if ((lum(B, y * W + x) - lum(A, y * W + x)) >= peak * 0.5) k++; else break;
          }
          return k;
        })();
        let band = 0, ref = 0, nRows = 0;
        for (let k = 0; k <= bRows; k++) {
          band += lum(B, (yb - k) * W + x) - lum(A, (yb - k) * W + x); ref += lum(A, (yb - k) * W + x); nRows++;
        }
        // locality: the SAME term measured a band's width clear of the crease on the far side, and on
        // the floor 6-14 rows in front of it. Offsets are fixed (win = 2 design band widths), not
        // relative to the band this column happened to show, or a narrower band would look leakier.
        const a1 = lumDiffClear(A, B, x, yb - win - 4, yb - win - 12);
        const a2 = lumDiffClear(A, B, x, yb + 6, yb + 14);
        const mid = lumAvg(A, W, yb - bRows * 0.25, yb - bRows * 0.75, x);
        const near = lumAvg(A, W, yb + bRows + 6, yb + bRows + 16, x);
        const far = lumAvg(A, W, yb - bRows - 6, yb - bRows - 16, x);
        dropSum += nRows ? band / nRows : 0; refSum += nRows ? ref / nRows : 0;
        wideSum += bRows; spanSum += Math.abs(yOther - yLip);
        farSum += Math.max(a1, a2); farN++;
        if (mid < near - 12 && mid < far - 12) dip++;
        if (yb >= 0 && Math.abs(yb - yF) <= win) near0++;
        if (peak > 4) touched++;
        {
          /* "Near the lip row" is not the claim: a band that starts at the lip and runs into the WRONG
             surface is a band on the wrong side of the lip, and that is the #167 failure. A riser always
             paints the SLAB side (js/40_render.js:973 takes z0/z1 from rz0/rz1 for every dq, post-#196),
             so the painted face owns exactly one side of the lip row yc: from yc toward the OTHER floor's
             row. The gated claim is therefore that the term DARKENS A ROW INSIDE THAT FACE, strictly on
             its own side of yc and within win rows of it. The anchor row itself is excluded, because
             seamCrease's extra k=0 term is painted there whichever way dir goes: counting it lets
             3edf43b's march key (band runs UP from the anchor whatever the step direction) pass 60 of 60
             columns on a DOWN lip - measured, with both a distance-only and an anchor-inclusive form - so
             a row that counts it cannot fail on the defect it is bought for. A column whose only band is
             on the far side of the lip is DISPLACED (farW); one with no band anywhere in the wide window
             is vacuity (noW). Both are FAILUREs of the walkable row, never a silent pass. */
          const yc = Math.floor(hor + (eye - c[4]) * hp);
          const zF = c[4] === c[5] ? c[6] : c[5];                      // the far side's floor
          const yO = hor + (eye - zF) * hp;
          const want = yO >= yc ? 1 : -1;                               // the face's own side
          const lim = Math.min(win, Math.round(Math.abs(yO - yc)));     // never deeper than the face
          let onFace = 0, anywhere = 0;
          for (let k = 1; k <= lim; k++) {
            const y = yc + want * k;
            if (y >= 0 && y < H) onFace = Math.max(onFace, lum(B, y * W + x) - lum(A, y * W + x));
          }
          for (let y = Math.max(0, yc - WIDE); y <= Math.min(H - 1, yc + WIDE); y++)
            anywhere = Math.max(anywhere, lum(B, y * W + x) - lum(A, y * W + x));
          if (onFace > 4) nearW++;
          else if (anywhere > 4) farW++;
          else noW++;
        }
      }
      const meanD = n ? sum / n : 0, pctW = n ? 100 * within / n : 100, meanCon = n ? conSum / n : 0;
      // the foot drop as a fraction of how bright that band is: the term is a multiply, so on a floor
      // rendering at 27 the most it can be is 0.84 of 27 and an absolute 18 px-lum is out of reach in
      // a dim room while the same crease on a floor at 106 measured 88 (main L0 walk)
      const dropBar = farN ? dropSum / farN : 0, dropCon = refSum ? dropSum / refSum : 0;
      row(`L${li} ${kind} lip: geometry the depth buffer agrees with`,
        n >= 24 && zok >= n * 0.9,
        `${n} of ${m.length} columns cross a ${kind} lip at ${DIST} m (refused ${off}: the renderer's `
        + `own zbuf says nothing is there), riserStops ${risers}, horizon ${hor.toFixed(1)}, eyeZ ${eye.toFixed(2)}`);
      row(`L${li} ${kind} lip: luminance steps where depth steps`,
        n >= 24 && meanCon >= (kind === 'walk' ? CON_WFLOOR : CON_FLOOR) && pctW <= WITHIN_MAX,
        `contrast across the lip ${(100 * meanCon).toFixed(0)}% (want >= ${(100 * CON_MIN).toFixed(0)}%`
        + (kind === 'walk' ? `, hard floor ${(100 * CON_WFLOOR).toFixed(0)}%`
          : `, hard floor ${(100 * CON_FLOOR).toFixed(0)}%`) + `), `
        + `mean |dL| ${meanD.toFixed(1)}, ${(pctW).toFixed(1)}% of lip pixels within 10 of their neighbour `
        + `(want <= ${WITHIN_MAX}%), signed ${(n ? sgn / n : 0).toFixed(1)} `
        + `- ${kind === 'face' ? 'a riser wears the floor material, so today the step is a brighter patch of the same texture'
            : 'a walk lip is a 0.25 m slab side drawn as a face (#192): the depth steps there, so the'
            + ' luminance must step with it rather than be the floor texture painted through the riser'}`,
        // The walk kind is the #192 debt: since a tread is a FACE, the pair across the lip is floor vs
        // a 0.25 m slab side, and that side is the level's own wall material at the light level of the
        // room - measured on the fix 76% (L0) / 26% (L1) / 12% (L2) where main's legibility came from the
        // crease multiply the change removes (69/76/70%). The DEPTH half of the row is the #192 gate and
        // is hard; the luminance half is a shading/material tuning question (a riser that reads as an
        // edge in a dark room needs the light-independent mechanism, same tension as the body rim), so
        // it reports as debt above a floor measured one notch under the worst generated level, and a
        // build that draws no face at all still fails it hard at 0%.
        // The face kind carries the #203 debt: the lamp-band weight removed the pool a deck lamp
        // cast DOWN onto the lip floor - #203's own example of the bug - and the L2 lip measured
        // 0.46 (main) -> 0.43 (fixed) against the 0.45 bar; the same light-independent riser
        // tuning gap, the same hard fail past CON_FLOOR.
        meanCon < CON_MIN ? (kind === 'walk' ? '#195' : '#203') : undefined,
        meanCon < CON_MIN);
      row(`L${li} ${kind} lip: a seam band at the crease, not a shade`,
        seam === 1 && dropCon >= DROP_CON_MIN && wideSum / (n || 1) >= 1 &&
        wideSum / (spanSum || 1) <= 0.45 && farSum / (farN || 1) <= 5 &&
        // and the locality term must have been MEASURED: masking every row of both windows would
        // make it read 0.0 on a build that tints the whole frame, which is the one thing it owns
        clearRows >= (farN || 1) * 4 &&
        /* The placement term, #167. Both halves of this row used to be `near0 >= max(12, n*0.5)`, a bar
           whose own instrument could not see the failure it was bought for (the argmax lived inside the
           window, so a band on the wrong side of the lip still scored near: 60 of 60 while the crease ran
           the wrong way). The mechanism it was filed against is gone - the march-keyed walkable crease
           (`crk`) was deleted by 754d9ce (#196), which made every step a DRAWN riser, so the crease is
           now keyed on the face the wall pass painted rather than on a crossing the march only walked
           past - and the bar is the face row's measured standard: every counted column, 0 misplaced, 0
           without a band. Measured on main, all six rows read n of n with 0 and 0 (299/240/239 face,
           60/60/60 walk), and restoring 3edf43b's march key puts 60 of 60 on L1 and L2 (their walk lip
           is a step DOWN, so the band runs up out of the face) and 299 of 299 on L0's face (a 1 m step
           DOWN) in the MISPLACED column with the row exiting 1 - the bar sits where nothing was widened.
           L0's walk lip is a step UP, where the two keys agree, so that row stays green under the
           sabotage; it is stated rather than hidden. Vacuity fails: n >= 24 counted columns here, the
           lip-exists row above, and the seam-term row under it. */
        n >= 24 && nearW === n && farW === 0 && noW === 0,
        `the band is ${(100 * dropCon).toFixed(0)}% brighter with the term off (${dropBar.toFixed(1)} px-lum `
        + `off a floor at ${(refSum / (farN || 1)).toFixed(0)}), the step is a crease not a shade; want >= `
        + `${(100 * DROP_CON_MIN).toFixed(0)}%), band `
        + `${(n ? wideSum / n : 0).toFixed(1)} px of a ${(n ? spanSum / n : 0).toFixed(0)} px riser `
        + `(${(100 * wideSum / (spanSum || 1)).toFixed(0)}% - wider than that is a tint, not an edge), `
        + `${(farSum / (farN || 1)).toFixed(1)} a band's width clear of every crease in the column on both sides `
        + `(locality, want <= 5, measured on ${farN ? (clearRows / farN).toFixed(1) : '0'} of 18 rows/column) `
        + `of those, ${n ? (100 * dip / n).toFixed(0) : 0}% also read as a local luminance minimum `
        + `(lighting-dependent: the AMB floor sinks it in dark rooms - see the #164 note), `
        + `${near0} of ${n} bands land within 0.5 m of the lip the grid says, ${touched} of ${n} moved at all`
        + `; #167: ${nearW} of ${n} columns have a seam band INSIDE the painted face on its own side of the`
        + ` lip row on the eye's own side (within ${(200 * SEAMW).toFixed(0)} cm of it), ${farW} with a band only`
        + ` on the far side of the lip, ${noW} with no band at all within \u00b1${(800 * SEAMW).toFixed(0)} cm`
        + ` - GATING at 0 misplaced, both kinds (was >= 50%)`);
    }
    if (seam === 1) {
      {
        run('SEAM = 1; S.t = 3.5; renderWorld()');
        const A = new Uint32Array(run('px'));
        run('SEAM = 0; S.t = 3.5; renderWorld()');
        const B = new Uint32Array(run('px'));
        run('SEAM = 1');
        for (let i = 0; i < A.length; i += 7) if (Math.abs(lum(A, i) - lum(B, i)) > 4) diffPx += 7;
      }
    }
    row(`L${li} the seam term is in the build and moves pixels`, seam === 1 && diffPx > 0,
      seam === -1 ? 'no SEAM global in js/: the A/B control cannot arm, so no lip row above it means anything'
        : seam === 0 ? `the term is switched OFF for this control run (SEAM=0): the lips above have no edge`
        : `SEAM=1 vs SEAM=0 moves ${diffPx} px of the frame (every 7th sampled)`);

    // the band cue in the minimap: colours paired to cells by recording the layer's own fillRects
    const mm = run(`(function () {
      const rec = [], fz = MAP.fz, cell = MAP.cell, N = MW; let cur = '';
      const ctxo = { globalAlpha: 1, font: '', lineWidth: 1, textAlign: 'left', imageSmoothingEnabled: true };
      Object.defineProperty(ctxo, 'fillStyle', { get: () => cur, set: v => { cur = v; } });
      for (const k of ['save', 'restore', 'setTransform', 'drawImage', 'strokeRect', 'beginPath', 'arc', 'fill',
        'translate', 'rotate', 'fillText', 'stroke', 'clearRect']) ctxo[k] = () => { };
      ctxo.fillRect = (x, y, w, h) => { rec.push([cur, x, y]); };
      const fake = { width: 0, height: 0, style: {}, getContext: () => ctxo };
      const old = document.createElement;
      document.createElement = () => fake;
      mmLayer = null; mmKey = ''; mmRevealed = -1;
      explored.fill(1); S.revealed++;
      drawMinimap(1);
      document.createElement = old;
      const size = Math.min(DW * 0.2, DH * 0.24), s = size / Math.max(MW, MH);
      const byBand = {};
      for (const r of rec) {
        const gx = Math.floor(r[1] / s), gy = Math.floor(r[2] / s);
        if (gx < 0 || gy < 0 || gx >= N || gy >= N || cell[gy * N + gx]) continue;
        const b = fz[gy * N + gx] * ZQ;
        (byBand[b] = byBand[b] || {})[r[0]] = (byBand[b][r[0]] || 0) + 1;
      }
      return byBand;
    })()`);
    const bands = Object.keys(mm).map(Number).sort((a, b) => a - b);
    const colOf = b => Object.keys(mm[b]).sort((p, q) => mm[b][q] - mm[b][p])[0];
    /* The datum is the band MOST cells stand on, not the numerically lowest one. While every band sat
       at or above the datum those were the same band, and a pit is the first thing to separate them:
       taking the lowest made the pit the datum and flagged the real datum's own ink as a collision -
       the same one-sided rule alt's link count had to lose. */
    const cntOf = b => Object.keys(mm[b]).reduce((s, c) => s + mm[b][c], 0);
    const datum = colOf(bands.reduce((a, b) => cntOf(b) > cntOf(a) ? b : a));
    const offBands = bands.filter(b => Math.abs(b) > 1e-6);
    const sameOff = offBands.filter(b => colOf(b) === datum);
    row(`L${li} minimap shows which band a cell is on`, bands.length >= 2 && sameOff.length === 0,
      `${bands.length} bands painted: ` + bands.map(b => `${b.toFixed(2)}m ${colOf(b)}`).join(', ') +
      (sameOff.length ? ` - ${sameOff.length} off-datum band(s) still use the datum colour` : ''));
    /* #189 part 1: MAP.feat authors STAIR/LADDER/PIT cells and no HUD code read them, so the climb
       was undiscoverable. These rows gate the minimap cue that plots them. The cue is drawn by
       js/50_ui_input.js's drawFeatCues AFTER renderOverlay (the HUD file owns it; the renderer file
       does not), so these rows record the main display ctx, not the layer's fake - the layer rows
       above stay pure band-tint accounting. Cue fills are identified by MMFEAT's colour strings,
       which grep says occur nowhere else in js/. explored is zeroed for the capture because that is
       the spawn frame: measured 0 of 26/26/18 feat cells sit inside the reveal disc (radius
       sqrt(52) cells), so an explored-gated cue would paint nothing when it matters (control 2).
       A pop of 0 is a FAILURE, not an ok - the vacuity rule, cells must exist to be cued. */
    const cq = run(`(function () {
      const N = MW, feat = MAP.feat, rec = [], pop = [0, 0, 0, 0, 0], cells = [];
      let climb = null, cdist = 1e9;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x, k = feat[i] | 0;
        if (k < 1 || k > 4) continue;
        pop[k]++; cells.push([x, y, k]);
        if (k === 1 || k === 2) {
          const d = Math.hypot(x + 0.5 - ${spawn[0]}, y + 0.5 - ${spawn[1]});
          if (d < cdist) { cdist = d; climb = [x, y, k, d, MAP.fz[i]]; }
        }
      }
      const U2 = DH / 900, size2 = Math.min(DW * 0.2, DH * 0.24), pad2 = 18 * U2;
      const x2 = DW - size2 - pad2, y2 = pad2 + 6 * U2, s2 = size2 / Math.max(MW, MH);
      explored.fill(0); S.revealed++;                 // spawn-frame state; drawFeatCues must not care
      const have = typeof drawFeatCues === 'function' && typeof MMFEAT !== 'undefined';
      const of = ctx.fillRect, cols = have ? MMFEAT.map(c => String(c)) : [];
      if (have) {
        ctx.fillRect = function (x, y, w, h) { rec.push([String(this.fillStyle), x, y, w, h]); };
        drawFeatCues(U2);
        ctx.fillRect = of;
      }
      return { pop, cells, climb, rec, cols, mw: MW, mh: MH, x2, y2, s2,
        wired: /drawFeatCues/.test(frameInner.toString()), dead: !have };
    })()`);
    const cellKeyOf = (px, py) => Math.floor((px - cq.x2) / cq.s2) + ',' + Math.floor((py - cq.y2) / cq.s2);
    const featAt = {};
    for (const [x, y, k] of cq.cells) featAt[x + ',' + y] = k;
    const cuedCell = {};
    let misplaced = 0, cueFills = 0;
    for (const [col, px, py] of cq.rec) {
      const k = cq.cols.indexOf(col);
      if (k < 0) continue;
      cueFills++;
      const key = cellKeyOf(px, py);
      if (featAt[key] === k) cuedCell[key] = 1; else misplaced++;
    }
    const popTot = cq.pop.reduce((a, b) => a + b, 0);
    const cuedK = [0, 0, 0, 0, 0];
    for (const [x, y, k] of cq.cells) if (cuedCell[x + ',' + y]) cuedK[k]++;
    const cuedTot = cuedK.reduce((a, b) => a + b, 0);
    row(`L${li} every feat cell the map authors gets its cue`, !cq.dead && cq.wired && popTot > 0 && cuedTot === popTot && misplaced === 0,
      `pop STAIR ${cq.pop[1]} LADDER ${cq.pop[2]} PIT ${cq.pop[3]} RAIL ${cq.pop[4]} -> cued ${cuedK[1]}/${cq.pop[1]} ${cuedK[2]}/${cq.pop[2]} ${cuedK[3]}/${cq.pop[3]} ${cuedK[4]}/${cq.pop[4]}` +
      ` of ${cq.cells.length} cells at ${cq.s2.toFixed(2)} px/cell; ${cueFills} cue fills, ${misplaced} at the wrong cell or kind; frame loop ${cq.wired ? 'calls' : 'DOES NOT CALL'} drawFeatCues` +
      (cq.dead ? ' - no MMFEAT in the build' : popTot === 0 ? ' - NO FEAT CELLS (vacuity is a FAILURE, not an ok)' : ''));
    if (!cq.climb) {
      row(`L${li} spawn seat can find the nearest climbable cell`, false, 'no STAIR/LADDER cell authored - vacuity');
    } else {
      const [cx, cy, k, d, band] = cq.climb;
      const px0 = cq.x2 + cx * cq.s2, py0 = cq.y2 + cy * cq.s2;
      const ink = cq.rec.find(([col, px, py, w, h]) =>
        cq.cols.indexOf(col) >= 0 && px < px0 + cq.s2 && px + w > px0 && py < py0 + cq.s2 && py + h > py0);
      const DISC = Math.sqrt(52);
      row(`L${li} spawn seat can find the nearest climbable cell`, !!ink,
        `nearest STAIR/LADDER cell ${d.toFixed(1)} cells = ${d.toFixed(1)} m at (${cx},${cy}) band ${band >= 0 ? '+' : ''}${band}, ` +
        `${d > DISC ? 'OUTSIDE' : 'inside'} the ${DISC.toFixed(1)}-cell reveal disc - an explored-gated cue would ${d > DISC ? 'paint NOTHING here' : 'already show it'}; ` +
        `its minimap pixel ${ink ? 'carries ' + ink[0] : 'IS BACKGROUND - no cue before the player has been there'}`);
    }
    const inv = run(`(function () {
      const rec = [], of = ctx.fillRect;
      const z0 = P.z; P.z = z0 + ${ZQS} * 4;                 // feet a full band above the seat
      if (typeof drawFeatCues === 'function') {
        ctx.fillRect = function (x, y, w, h) { rec.push([String(this.fillStyle), x, y]); };
        drawFeatCues(DH / 900);
        ctx.fillRect = of;
      }
      P.z = z0;
      return rec;
    })()`);
    const base = cq.rec.map(r => [r[0], r[1], r[2]]);
    row(`L${li} the cue invents no altitude (the #16 gap stays visible)`,
      cq.rec.length > 0 && JSON.stringify(base) === JSON.stringify(inv),
      `${base.length} cue fills identical with the player on their own band and 1 band higher: cell ink is band-vs-MAP.fzBase (level-wide), ` +
      `never player-relative - where YOU are is the arrow, not a tint (#16 gap kept, not papered over)`);
    /* #197: WHERE THE FAR BAND GETS ITS LIGHT. castGround fills - does not texture - every row whose own
       plane solve passes FARB: the horizon band of a flat level, the upper half of a tall room, the far
       side of a pit. That fill used to read MAP.light and the tint of cellIdx(camX, camY) - the CAMERA
       column - so the brightness of everything past 22 m was the lamp luck of wherever the eye stood, and
       a measured frame read 22.7 mean with 63.6% of pixels under 24 because one cell said so. What gates
       it is LUMINANCE CONTINUITY ACROSS THE FARB BOUNDARY, not a threshold on how bright the band is:
       take the LAST FILLED ROW (|p| = floor(dz*BH/FARB), the renderer own rule and its own dz, from the
       band the eye stands in) against the FIRST TEXTURED ROW (|p| + 1) - same frame, same columns, ~1 m
       apart in distance, so the world on either side of the boundary is the same world and the only thing
       that can move is the shading. Same cell and same light: the step is the texture own grain. The
       camera cell: the step is the difference between two rooms, drawn as a hard edge across the middle of
       the frame. The rows are read off a castGround-only repaint, because the wall pass legitimately covers
       part of the band and would hide the pixels this asks about; the band is CHECKED to be a fill (one
       value across the row) rather than assumed, so a frame with no band in it is VACUOUS and counts
       against the row instead of passing quietly; and the camera is sampled at the spawn and at the
       nearest lip the grid offers, four yaws each, so no single pose can satisfy the row incidentally.
       Measured 2026-09-30 at 9 cameras x 6 yaws x both halves: this build reads 4.2 / 5.8 / 3.4 mean
       |step| on levels 0/1/2 and origin/main reads 18.4 / 19.1 / 9.8 - the bar sits in that gap, closer
       to the fix than to main, and L2 is the level that can only pass on a small number of cameras
       because its floor material is mostly emissive at the coarse mip, where the light barely counts. */
    const farProbe = () => run(`(function () {
      const N = MAP.w, cell = MAP.cell, fz = MAP.fz, cp = MAP.ceilPlane, lm = MAP.light;
      px.fill(pack(FOGC[0], FOGC[1], FOGC[2]));
      castGround(S.flash, FOGC[0], FOGC[1], FOGC[2]);
      const hz = Math.round(horizon), cx = camX | 0, cy = camY | 0, ci = cy * N + cx, out = [];
      const stat = y => {
        let s = 0, mn = 1e9, mx = -1e9, first = px[y * BW], same = true;
        for (let x = 0; x < BW; x++) {
          const v = px[y * BW + x], Lv = 0.2126 * (v & 255) + 0.7152 * (v >> 8 & 255) + 0.0722 * (v >> 16 & 255);
          s += Lv; if (Lv < mn) mn = Lv; if (Lv > mx) mx = Lv; if (v !== first) same = false;
        }
        return { mean: s / BW, mn, mx, spread: mx - mn, flat: same };
      };
      for (const side of [1, -1]) {
        const isF = side > 0, air = cx >= 0 && cy >= 0 && cx < N && cy < N && !cell[ci];
        const raw = air ? (isF ? fz[ci] * ZQ : cp[ci]) : eyeZ;
        const okA = isF ? raw < eyeZ : raw > eyeZ;
        const pl = okA ? raw : (isF ? Math.min(0, eyeZ - ZQ) : Math.max(1, eyeZ + ZQ));
        const dz = isF ? eyeZ - pl : pl - eyeZ;
        if (!(dz > 0)) { out.push({ side, skip: 'no plane of the band the eye stands in reaches these rows' }); continue; }
        const pb = Math.floor(dz * BH / FARB), yF = hz + side * pb, yT = hz + side * (pb + 1);
        if (pb < 1 || yF < 0 || yF >= BH || yT < 0 || yT >= BH) { out.push({ side, pb, skip: 'band off frame' }); continue; }
        let bsum = 0, bn = 0, tsum = 0, tn = 0, bandFlat = true;
        for (let p = 1; p <= pb; p++) { const y = hz + side * p; if (y < 0 || y >= BH) break; const q = stat(y); bsum += q.mean; bn++; if (!q.flat) bandFlat = false; }
        for (let k = 1; k <= 3; k++) { const y = hz + side * (pb + k); if (y < 0 || y >= BH) break; const q = stat(y); tsum += q.mean; tn++; }
        const f = stat(yF), t = stat(yT);
        out.push({ side, pb, yF, yT, dz, fill: f, tex: t, bandMean: bn ? bsum / bn : 0, texMean: tn ? tsum / tn : 0,
          bandFlat, dF: zbuf[yF * BW], dT: zbuf[yT * BW], camL: lm && ci >= 0 && ci < lm.length ? lm[ci] : -1 });
      }
      return out; })()`);
    const farFrame = () => {
      const fr = new Uint32Array(run('px'));
      let dk = 0, n = 0, s = 0;
      for (let i = 0; i < fr.length; i += 3) {
        const v = fr[i], L = 0.2126 * (v & 255) + 0.7152 * (v >> 8 & 255) + 0.0722 * (v >> 16 & 255);
        s += L; n++; if (L < FARDARK_L) dk++;
      }
      return { dark: 100 * dk / n, mean: s / n };
    };
    const cams = [[spawn[0], spawn[1]]];
    const lipF = lipFor('face', spawn[0], spawn[1]);
    if (!lipF.skip) cams.push([lipF.cx, lipF.cy]);
    const lipW = lipFor('walk', spawn[0], spawn[1]);
    if (!lipW.skip) cams.push([lipW.cx, lipW.cy]);
    /* plus a fixed lattice of open cells, first in row order: two cameras can be satisfied by luck -
       level 2 reads 9.8 on main across 108 half-frames while the spawn and the face lip alone read 7.8, and a
       floor that is mostly emissive at the coarse mip barely answers the lightmap at all - a lattice is
       what stops one lucky pose from being the verdict. Deterministic: MAP.cell, row-major, no draw of any random number. */
    const lat = run(`(function () { const N = MAP.w, cell = MAP.cell, st = Math.max(3, (N / 6) | 0), out = [];
      for (let y = 1; y < N - 1 && out.length < 6; y += st) for (let x = 1; x < N - 1 && out.length < 6; x += st)
        if (!cell[y * N + x]) out.push([x + 0.5, y + 0.5]);
      return out; })()`);
    for (const c of lat) cams.push(c);
    const YAWS = [0, Math.PI / 3, 2 * Math.PI / 3, Math.PI, 4 * Math.PI / 3, 5 * Math.PI / 3];
    const nFrame = cams.length * YAWS.length;
    let fSamples = 0, fStep = 0, fWorst = 0, fVac = 0, fDark = 0, fMean = 0, fParts = [];
    for (const [fx, fy] of cams) for (const fyaw of YAWS) {
      pose(fx, fy, fyaw);
      run('S.t = 3.5; renderWorld()');
      const fr = farFrame();
      fDark += fr.dark; fMean += fr.mean;
      for (const h of farProbe()) {
        if (h.skip) { fVac++; continue; }
        // a fill row is ONE value across the row: if it is not, there is no band here and the pair proves nothing
        if (!h.fill.flat || h.tex.flat || !h.bandFlat) { fVac++; continue; }
        const st = h.fill.mean - h.tex.mean;
        fSamples++; fStep += Math.abs(st);
        fParts.push(`${h.side > 0 ? 'f' : 'c'}${h.pb}:${st >= 0 ? '+' : ''}${st.toFixed(1)}@${h.dF.toFixed(0)}m`);
        if (Math.abs(st) > fWorst) fWorst = Math.abs(st);
      }
    }
    const nSamp = fSamples || 1;
    row(`L${li} far band: its light is the cell the row solves into, not the camera own`,
      fSamples >= nFrame && fStep / nSamp <= FARB_STEP_MAX && fDark / nFrame <= FARDARK_MAX,
      `mean |step| across the FARB boundary ${(fStep / nSamp).toFixed(2)} (want <= ${FARB_STEP_MAX}), worst ${fWorst.toFixed(1)} over ${fSamples} half-frames `
      + `at ${cams.length} cameras x ${YAWS.length} yaws (${fParts.slice(0, 8).join(' ')}${fParts.length > 8 ? ' ...' : ''}); that frame is `
      + `${(fDark / nFrame).toFixed(1)}% under luminance ${FARDARK_L} (want <= ${FARDARK_MAX}%), raster mean ${(fMean / nFrame).toFixed(1)} `
      + `- FARB ${run('FARB')} m, ${fVac} half-frame(s) with no band to measure`,
      undefined, fVac > fSamples);
  }
  console.log((bad ? `BANDS ${bad} FAILURE(S) - altitude is in the grid and not on the screen` :
    'BANDS ok - the step lip reads as an edge, the seam is a band not a tint, the far band reads the cell it solves into, and the minimap shows the band') +
    `, ${bad} gating row(s) of ${rowsN}, ${knownN} known-issue row(s)` + (knownN ? ' (' + [...debts].join(', ') + ')' : '') +
    (STRICT && knownN ? ' - STRICT=1: debt rows counted as failures' : ''));
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


