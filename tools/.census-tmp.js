/* Headless viewer: boots the game like smoke.js and writes PNGs so the procedural
   assets and the raycaster output can actually be looked at without a browser.

   node tools/view.js sheets            -> /tmp/fps_tex.png  (materials + sprites)
   node tools/view.js scene [lvl] [n]   -> /tmp/fps_scene.png (framebuffer, sector lvl, camera n)
   node tools/view.js mip             streak metric for the ground mip selection (#19): one line
                              per level, plus the 1-D and mush controls it is judged against
*/
const vm = require('vm'), fs = require('fs'), path = require('path');
const { writePNG, toRGBA } = require('./png');
/* JSDIR=path - the A/B knob docs/DEVELOPMENT.md and AGENTS.md already tell you to use (#289). Without it
   nothing changes: the probe loads this checkout's js/ exactly as before. With it, every game script AND
   every source-text assertion below reads the variant tree, so a documented control measures the variant it
   names instead of silently re-measuring the current tree and reporting the delta as the variant's (#148's
   self-cancelling harness, in a new costume). The loaded bytes are hashed and printed on the variant side,
   because "I promise I pointed at the other tree" is not evidence - the baseline side is identified by its
   git SHA, the variant side by this digest. */
const JSDIR = process.env.JSDIR ? path.resolve(process.env.JSDIR) : path.join(__dirname, '..', 'js');
const jsFile = f => path.join(JSDIR, f);
const noop = () => {};
const W = +(process.env.VW || 1280), H = +(process.env.VH || 720);   // VW/VH: the sway rows are resolution tests
const MODE = process.argv[2] || 'scene';
const ASCII = process.env.ASCII === '1' || process.env.ASCII === '';
const LVL = +(process.argv[3] || 0);
const CAM = +(process.argv[4] || 0);
// An unknown name used to fall through to the scene dump and exit 0, so a typo in a CI probe list
// ran something, painted a PNG and reported a passing gate (#89).
const PROBES = ['scene', 'alt', 'anim', 'bands', 'columns', 'contrast', 'cull', 'decal', 'diag', 'exposure', 'flatparity', 'heights',
  'drop', 'horizon', 'mip', 'planes', 'play', 'props', 'rig', 'sheets', 'sight', 'stats', 'surface', 'vert', 'viewmodel',
  'volume', 'refs'];
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
    if (kind === 'num' && !(vals.length && vals.every(v => /^\d+(\.\d+)?$/.test(String(v)))))
      throw new TypeError('refRecord ' + mode + '/' + rowName + ': num value must be a bare decimal literal');
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
      const q = /^'([^']*)'$/.exec(t), h = /^0x([0-9a-f]{1,8})$/i.exec(t),
        // #216: a probe that measures a SCALAR (a median luminance, a unique-colour count) records a
        // number, and until now the only literals this scanner could read were quoted strings and hex -
        // so a numeric record died in REFS-DECL-FORM with values silently empty. Bare decimals are a
        // literal the same as the others; a computed or wrapped value is still refused.
        nd = /^\d+(\.\d+)?$/.exec(t);
      if (q) vals.push(q[1]);
      else if (nd) vals.push(nd[0]);
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
/* Rest the VIEWMODEL, as a statement to prefix a renderWorld() with. drawViewModel damps its look-lag
   against WALL time (VM.now = performance.now(), js/40_render.js:1548) and the harness stubs that clock
   as Date.now() (:319), so two renders of ONE state are not the same frame: the gun rig has swung about
   the eye by whatever milliseconds happened to elapse between them. A probe whose oracle is a PAIR of
   renders measures that swing unless it rests the rig in both - which is why contrast arms it (#180) and
   why bands does now (#266: the seam A/B counted 777-917 px of rifle with no seam term in the build at
   all, so its row could not fail on its own subject). VM.ang = P.ang matters as much as the zeros: dAng
   is what the lag damps TOWARD, and after one frame it is already 0. */
const VMREST = 'if (typeof VM !== "undefined") { VM.ang = P.ang; VM.lag = 0; VM.vy = 0; }';
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
function boot(knob, seed) {
  elements = {}; rs = seed === undefined ? SEED : seed >>> 0;
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
  const jfiles = fs.readdirSync(JSDIR).filter(f => f.endsWith('.js')).sort();
  if (process.env.JSDIR && !jfiles.length) {
    console.log('JSDIR ' + JSDIR + ' holds no .js files - a variant tree that loads nothing measures nothing');
    process.exit(1);
  }
  const jhash = process.env.JSDIR ? require('crypto').createHash('sha256') : null;
  for (const f of jfiles) {
    const src = fs.readFileSync(jsFile(f), 'utf8');
    if (jhash) jhash.update(f + '\0' + src);
    try { run(src); }
    catch (e) { console.log('LOAD FAIL ' + f + ': ' + e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }
  }
  if (jhash) console.log('# JSDIR ' + JSDIR + '  js-sha256 ' + jhash.digest('hex').slice(0, 16) + '  ' +
    jfiles.length + ' files loaded from the VARIANT tree (baseline side is identified by its git SHA)');
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
  /* NOCAP=1 is the #21 CONTROL SWITCH: it raises the ground pass's light ceiling (LGCAP in
     js/40_render.js) to Infinity, which is the shipped defect reproduced - a cell reached after a
     crossing shades from the raw, unclamped lightmap - so `heights`' LIGHTCAP rows can be SEEN to
     fail. Shading only; no geometry, no lamp, no seed moves. */
  if (process.env.NOCAP === '1') run('LGCAP = Infinity;');
}

boot();
const NL = run("LEVELS.length");
for (let li=0; li<NL; li++) {
  const r = run(`(function(){
    startLevel(${li}, true);
    const N = MAP.w, cell = MAP.cell, fz = MAP.fz, cz = MAP.cz;
    let pair=0; const at=[];
    let enemyAbove=0;
    const open=(x,y)=> x>0&&y>0&&x<N-1&&y<N-1&&!cell[y*N+x];
    for (let y=1;y<N-1;y++) for (let x=1;x<N-1;x++){
      const i=y*N+x; if (cell[i]||cz[i]<=CZ_DEF) continue;
      for (let d=0;d<4;d++){
        const nx=x+DIRX[d], ny=y+DIRY[d];
        if (!open(nx,ny)) continue;
        if ((fz[ny*N+nx]-fz[i])*ZQ >= 0.5) { pair++; if(at.length<4) at.push([x,y,nx,ny]); break; }
      }
    }
    for (const e of ENEMIES) {
      const ex=e.x|0, ey=e.y|0;
      for (let d=0;d<4;d++){
        const nx=ex+DIRX[d], ny=ey+DIRY[d];
        if (!open(nx,ny)) continue;
        if ((fz[ey*N+ex]-fz[ny*N+nx])*ZQ >= 0.5 && cz[ny*N+nx] > CZ_DEF) { enemyAbove++; break; }
      }
    }
    const shot=(lx,ly,ux,uy)=>{
      const oz = floorAt(lx+0.5,ly+0.5) + cfg.eye, tz = floorAt(ux+0.5,uy+0.5) + 0.5;
      P.x=lx+0.5; P.y=ly+0.5; P.z=floorAt(P.x,P.y); P.crouch=0; P.air=false; P.vx=P.vy=P.vz=0;
      const ang=Math.atan2(uy+0.5-P.y, ux+0.5-P.x), dd=Math.hypot(ux-lx,uy-ly);
      const r=hitscan(ang,(tz-oz)/dd,20);
      return [r.enemy?1:0, r.band?1:0, r.wall?1:0, +r.t.toFixed(2)];
    };
    const rows=[];
    for (const a of at) {
      const en = ENEMIES[0]; const sv = {x:en.x,y:en.y,st:en.state,hp:en.hp};
      en.x=a[2]+0.5; en.y=a[3]+0.5; en.state="idle"; en.hp=1e6;
      const up=shot(a[0],a[1],a[2],a[3]);
      en.x=a[0]+0.5; en.y=a[1]+0.5;
      const dn=shot(a[2],a[3],a[0],a[1]);
      const cz0=MAP.cz.slice(); MAP.cz[a[1]*N+a[0]]=CZ_DEF; linkBoundaries();
      en.x=a[2]+0.5; en.y=a[3]+0.5;
      const blk=shot(a[0],a[1],a[2],a[3]);
      MAP.cz[a[1]*N+a[0]]=cz0[a[1]*N+a[0]]; linkBoundaries();
      en.x=sv.x; en.y=sv.y; en.state=sv.st; en.hp=sv.hp;
      rows.push([a,up,dn,blk]);
    }
    return {pair, enemyAbove, rows};
  })()`);
  console.log("L"+li, JSON.stringify(r));
}
