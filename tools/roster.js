#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------------------------
 * tools/roster.js - run CI's BLOCKING roster, not a hand-copied subset of it (#338).
 *
 * WHY. `AGENTS.md` listed `node tools/view.js cull` as the local verify command and `ci.yml:120`
 * ran a *second*, env-gated invocation of the same mode, `LEAK=1 CZBAND=1 node tools/view.js cull`,
 * which is the only place the CZBAND crc32 records are compared. On PR #337's head the documented
 * command printed `CULL ok` (exit 0) and CI printed `CULL 3 FAILURES` (exit 1) on identical bytes.
 * The defect is not a threshold and not a compare: it is WHICH INVOCATIONS RUN, and it existed
 * because the same list of commands was maintained by hand in two files.
 *
 * HOW THIS AVOIDS BECOMING THE THIRD COPY OF THE LIST. There is no list of modes in this file. The
 * roster is read out of `.github/workflows/ci.yml`: jobs are found at indent 2, a job is a GATE iff
 * it does not set `continue-on-error` and is not labelled informational; steps are found at indent 6
 * and their `run:` blocks at indent >= 10; every `node tools/view.js <mode>` / `node tools/smoke.js`
 * in a gate step becomes one roster entry, with the `VAR=value` prefix that sits in front of the
 * word `node` carried along as that entry's environment. A blocking step, or a whole new blocking
 * job, added to the workflow is therefore IN the roster without anyone editing this file - and a
 * job that loses its `continue-on-error` joins the roster too, which is the honest direction for a
 * check that started gating.
 *
 * WHY IT CANNOT SILENTLY DROP AN ENTRY. Two extractors read the same file by different means and
 * their line-number sets must agree (`--list`, exit non-zero, names the symmetric difference):
 *   (A) the structural walk above - it knows about steps, jobs and run blocks;
 *   (B) a structure-blind regex over every non-comment line of the file, attributed to a job only by
 *       its line range - it cannot be fooled by indentation, quoting or command substitution.
 * So a shape the walk does not understand (a step written `- run:` with no name, a command parked at an
 * indentation the walk treats as a mapping key) is LOUD, not silent: the scan still counts what CI runs
 * and the row names the lines the walk would have dropped. Measured that way on a copy: a gates step
 * whose header was deleted prints "parsed 2 != raw 17" and exits 1. The walk deliberately does not grow
 * a rule for every legal YAML - an unrecognised shape must fail, not be guessed at.
 * A third rule covers what neither can classify: an invocation whose mode is a shell loop variable
 * (`node tools/view.js "$p"`) cannot be run as stated. It is not a command, it is a HANDFUL of
 * commands wearing one line's clothes, so the roster reads the `for <var> in <words>; do` header out
 * of the same step body and replays one invocation per word (#662) - the words come from ci.yml, so
 * there is no third copy of the mode list here and the list cannot rot. Whether those invocations
 * COUNT depends on the step's own shell, not on the job label: a step that ends `exit $status` after
 * setting `status=1` on a failure exits non-zero in CI whatever its job's `continue-on-error` says,
 * so its modes are replayed and their failures are counted. A step that swallows them (`seeds`) is
 * printed as an off-roster note listing what it runs, because reporting is not coverage. That is the
 * whole of #662: `probes` is labelled "they report, they do not gate" while its step is
 * `for p in alt exposure contrast rig stats sheets decal diag viewmodel` and `exit $status`, and a
 * roster that read only the label left eight of those nine modes unreplayed - which cost PR #649 a
 * red CI on a head whose local roster was clean. An unresolvable loop variable in a GATE step still
 * FAILS the roster rather than running nothing. Blocking steps that run a tool this roster does not
 * cover by design (`recap.js`, `ci/assert.js`, `wfyaml.rb`) are printed as a named gap, not a silent one.
 *
 * VERDICTS. Each entry runs in order, keeps going after a failure, and contributes one line: the
 * child's own exit code, and the child's own verdict *string* (the last line of its output that
 * reads like a verdict - `SMOKE PASSED`, `CULL ok ...`, `vert: FAILED`). No grep of an intermediate
 * line, which is the trap AGENTS.md records: `raster cost` matched while the assert was failing. The
 * exit code is the verdict for view.js modes (each block ends in `process.exit(bad ? 1 : 0)`); for
 * smoke the workflow's own literal (`SMOKE PASSED`) is required, since that step gates on the word.
 * An invocation that produced NO output is FAILURE, never ok, whatever it exited: a step that ran
 * nothing is the failure mode this whole file exists to remove. A passing exit code whose verdict
 * line says FAILED, or a failing exit code whose line says ok, is printed as FAILURE with the
 * mismatch named. The census ends every run, e.g.
 *   ROSTER 16 invocation(s), 0 failed, 15 ok, 1 known-reporting
 * `known-reporting` counts invocations that passed while their own output carried a non-zero
 * known-issue tally - debt that is visible in the count instead of folded into "ok".
 *
 * ENVIRONMENT. Each child starts from a SCRUBBED environment: the ci line's own `VAR=value` prefix
 * plus PATH/HOME/TMPDIR/TZ/LANG/CI, plus OUT, which selects a PNG path and cannot change a row. Any
 * other variable is dropped and named on that entry's line - but only when the tools actually read
 * that name, so the line says `[ambient dropped: LEAK]` rather than listing the shell. An ambient
 * `LEAK=1` or `STRICT=1` would change WHICH ROWS RUN and reproduce locally the exact invisibility
 * #338 is about. `ROSTER_KEEP_ENV=1` passes the shell through instead (the census then says so) for
 * anyone deliberately A/B-ing a knob.
 *
 * ---------------------------------------------------------------------------------------------
 * CENSUS OF ENV-GATED VERDICT ROWS (ask #2 of #338). `node tools/roster.js --env` prints it: every
 * `process.env.` read in `tools/view.js` and `tools/smoke.js`, its class, and the LIVE `file:line` of
 * each read. It replaces a block of this header that transcribed those line numbers - `main` grew
 * rows in view.js, every number in it went stale inside a week, and a reader who trusted one would
 * have gone looking at the wrong code. AGENTS.md's rule: a transcribed number rots and the tool
 * cannot. What is left here is the part a tool cannot derive, the CLASSIFICATION (the `ENV_CLASS` map
 * below is the only copy, and `--env` reads it rather than restating it):
 *   A  a ROW EXISTS only when the var is set - the #338 shape: unset env, silent row, the summary
 *      still prints `ok`, and nothing in the default output names the missing row;
 *   B  the row prints either way but its EXIT CODE does not unless the var is set (filed debt promoted
 *      to a gate - `STRICT`). CI never sets it, so local and CI agree; an ambient STRICT=1 is still a
 *      different verdict, which is the safe direction and still the reason children are scrubbed;
 *   C  the var changes WHICH ROWS OR INPUTS are measured, not whether a row exists;
 *   D  a threshold, floor or print - hides no row.
 * A name the map does not carry is printed unclassified and COUNTED, so a knob someone adds later is
 * visible as unclassified rather than quietly assumed harmless; a name the map carries and the tools
 * no longer read FAILS the census, which is exactly the rot this block used to be.
 *
 * Row-gating names that CI's roster steps DO set, and so are carried into the child instead of being
 * scrubbed: VERT (smoke) and LEAK + CZBAND (cull) - `--env` prints the ci.yml line for each. Everything
 * in A that CI does not set is what ask #2 wants named inside each mode's own summary; that edit
 * belongs in tools/view.js's verdict blocks and is deliberately NOT part of this increment.
 *
 * USAGE.  node tools/roster.js            run the whole roster in ci.yml's order, loop-expanded
 *         node tools/roster.js --quick 3  the first 3 only (census says PARTIAL)
 *         node tools/roster.js --only exposure[,decal]  just those mode(s) - the census says PARTIAL,
 *                                       and it is how one mode's redness is proven to be caught
 *         node tools/roster.js --list     parse + drift check + yaml lint, run nothing
 *         node tools/roster.js --env      the env-gated row census above, with live line numbers
 * --------------------------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CI_FILE = path.join(ROOT, '.github', 'workflows', 'ci.yml');

// The two harnesses whose invocations this roster replays. Anything else a blocking step runs is
// reported as a named gap in the roster's scope, not silently skipped.
const SCOPED = { 'view.js': true, 'smoke.js': true };
const KEEP_ENV = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'CI'];
// Where a dump is written is not a knob that changes WHICH ROWS RUN: OUT selects a PNG path only
// (tools/view.js:212, and every later use is a writePNG target). Carried so a caller can point the
// renders somewhere that cannot collide with a job already running in another worktree.
const PATH_ENV = ['OUT'];
const KEEP_ALL = KEEP_ENV.concat(PATH_ENV);
const PASSTHROUGH = process.env.ROSTER_KEEP_ENV === '1';

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const ENVC = argv.includes('--env');
const qIdx = argv.indexOf('--quick');
const QUICK = qIdx >= 0 ? Math.max(1, +(argv[qIdx + 1] || 1) || 1) : 0;
// A named subset, for proving that one mode's redness is actually caught without paying for the whole
// roster. The census calls it PARTIAL: a subset run is never the gate (#338's whole lesson).
const oIdx = argv.indexOf('--only');
const ONLY = oIdx >= 0 ? String(argv[oIdx + 1] || '').split(/[,\s]+/).filter(Boolean) : [];

/* ---------------------------------------------------------------- the structure-blind count (B) */

function isComment(line) { return /^\s*#/.test(line); }
// Structure-blind: matches the command text however it is wrapped - `run:`, `out=$( )`, `if ...; then`.
const RAW_RE = /\bnode\s+[^\s|&;()]*tools\/(view|smoke)\.js\b/g;
// Any tools/*.js run through node, for naming blocking steps outside this roster's scope.
const ANY_RE = /\bnode\s+[^\s|&;()]*tools\/[^\s|&;()]+\.js\b/g;

function scanRaw(lines, re) {
  const hits = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    re.lastIndex = 0;
    let n = 0, m;
    while ((m = re.exec(line)) !== null) n++;
    for (let k = 0; k < n; k++) hits.push(i + 1);
  });
  return hits;
}

/* ---------------------------------------------------------------- the structural walk (A) */

function walk(lines) {
  const jobs = [];
  let job = null, inJobs = false;
  lines.forEach((line, i) => {
    const no = i + 1;
    if (/^jobs:\s*$/.test(line)) { inJobs = true; job = null; return; }
    if (!inJobs) return;
    if (/^[A-Za-z_]/.test(line)) { inJobs = false; job = null; return; }      // back to a top-level key
    let m = /^  ([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (m) { job = { key: m[1], start: no, end: lines.length, cont: false, label: '', steps: [], inv: [] };
      jobs.push(job); return; }
    if (!job) return;
    m = /^    continue-on-error:\s*(true|false)\s*$/.exec(line);
    if (m) job.cont = m[1] === 'true';
    m = /^    name:\s*(.+?)\s*$/.exec(line);
    if (m) job.label = m[1].replace(/^['"]|['"]$/g, '');
    m = /^      -\s*(?:name|uses):\s*(.*?)\s*$/.exec(line);
    if (m) { job.steps.push({ name: m[1].replace(/^['"]|['"]$/g, ''), start: no, runs: [] }); return; }
    const st = job.steps[job.steps.length - 1];
    if (st && /^          run:\s*[|>]/.test(line)) st.runs.push(no);
  });
  for (let i = 0; i < jobs.length; i++) {
    jobs[i].end = jobs[i + 1] ? jobs[i + 1].start - 1 : lines.length;
    for (const st of jobs[i].steps) {
      // A step's body runs from its `- name:` line to the next `- ` at indent 6, the next job-level
      // key at indent 4, or a top-level key. Inside it, ONLY lines indented >= 10 are shell: a step
      // key (`with:`, `if:`, `env:`) sits at 8, and its mapping values at 10 - handled separately,
      // because an `env:` block is a workflow's other way of putting a VAR in front of a command.
      const to = jobs[i].end;
      let inEnv = false;
      for (let ln = st.start + 1; ln <= to; ln++) {
        const line = lines[ln - 1];
        if (/^      - /.test(line) || /^ {0,4}\S/.test(line)) break;
        if (/^ {8}env:\s*$/.test(line)) { inEnv = true; continue; }
        if (isComment(line)) continue;
        if (!/^ {10,}\S/.test(line)) { if (/^ {0,8}\S/.test(line)) inEnv = false; continue; }
        const e = inEnv && /^ {10,}([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*?)\s*$/.exec(line);
        if (e) { (st.envBlock || (st.envBlock = [])).push([e[1], e[2].replace(/^['"]|['"]$/g, '')]); continue; }
        if (/^ {10,}run:\s*(\S.*?)\s*$/.test(line)) {                      // `run: node tools/...` inline
          const inline = parseCmd(/^ {10,}run:\s*(\S.*?)\s*$/.exec(line)[1], ln);
          if (inline.length) st.inv = (st.inv || []).concat(inline);
          inEnv = false; continue;
        }
        if (/^ {10,}[A-Za-z_][A-Za-z0-9_]*:/.test(line)) { inEnv = false; continue; }
        // A shell loop header, and whether this step's own shell turns a child's failure into its own
        // exit code. Both are read from the body rather than assumed from the job's label (#662): the
        // `probes` job is labelled "they report, they do not gate" and its step exits 1 on a red probe.
        const lp = /^ {10,}for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*;\s*do\b/.exec(line);
        if (lp) { st.loop = { name: lp[1], words: lp[2].trim().split(/\s+/).filter(Boolean), line: ln, text: line.trim() }; continue; }
        const xv = /^\s*exit\s+\$\{?([A-Za-z_]\w*)\}?/.exec(line.slice(10));
        if (xv) st.exitVar = xv[1];
        const a1 = /(?:^|[;&|]\s*)([A-Za-z_]\w*)=1\b/.exec(line.slice(10));
        if (a1) (st.assigns || (st.assigns = new Set())).add(a1[1]);
        const parsed = parseCmd(line, ln);
        if (parsed.length) st.inv = (st.inv || []).concat(parsed);
      }
    }
  }
  for (const j of jobs) {
    j.gate = !j.cont && !/\binformational\b/i.test(j.label);
    j.inv = [];
    for (const st of j.steps) {
      // A step GATES ON ITS OWN EXIT CODE iff it exits on a variable it sets to 1 on a failure. That is
      // the shape #662 is about, and it is a property of the shell, not of `continue-on-error`.
      st.exitGate = !!(st.exitVar && st.assigns && st.assigns.has(st.exitVar));
      if (st.loop) st.loop.exitVar = st.exitVar || '';
      for (const inv of st.inv || []) {
        inv.step = st.name;
        inv.env = (st.envBlock || []).concat(inv.env);                             // ci-line prefix wins
        if (inv.env.some((kv) => /\$/.test(kv[1]))) inv.unexpandable = true;
        inv.exitVar = st.exitVar || '';
        inv.variants = expandLoop(inv, st.loop);
        inv.exitVar = st.exitVar || '';
        inv.counted = j.gate || (st.exitGate && inv.variants.every((v) => !v.unexpandable));
      }
    }
  }
  return jobs;
}

/* A step body's `for <var> in a b c; do ... node tools/view.js "$var" ... done` is not one command but
 * as many as the word list. The list is read out of ci.yml (#662) - this file carries no mode list, so
 * a mode added to the loop is IN the roster without anyone editing it. Substitution covers the mode
 * AND the `VAR=$s` prefix form (the `seeds` loop), and a list whose own words need expanding stays
 * unresolvable, which is a FAILURE in a gate step and a printed note elsewhere. */
function expandLoop(inv, loop) {
  if (!loop) return [inv];
  const useRe = new RegExp('\\$\\{?' + loop.name + '\\}?');
  const sub = (s) => String(s).replace(new RegExp('\\$\\{?' + loop.name + '\\}?', 'g'), '\u0000');
  if (!(useRe.test(inv.mode || '') || inv.env.some((kv) => useRe.test(kv[1])))) return [inv];
  if (!loop.words.length || loop.words.some((w) => /[$'"`\\|&;<>()]/.test(w))) return [inv];
  const bad0 = loop.words.some((w) => inv.mode !== null && sub(inv.mode).replace('\u0000', w).indexOf('$') >= 0);
  return loop.words.map((w) => {
    const mode = inv.mode === null ? null : sub(inv.mode).replace(/\u0000/g, w);
    const env = inv.env.map((kv) => [kv[0], sub(kv[1]).replace(/\u0000/g, w)]);
    const unexpandable = bad0 || /[$]/.test(mode || '') || env.some((kv) => /[$]/.test(kv[1]));
    return { line: inv.line, tool: inv.tool, mode, env, unexpandable, text: inv.text, fromLoop: true,
      exitVar: inv.exitVar || (loop.exitVar || ''), job: inv.job, step: inv.step, stepExitVar: loop.exitVar,
      loopName: loop.name, loopLine: loop.line, loopWords: loop.words.slice(),
      cmd: (env.map((kv) => kv[0] + '=' + kv[1]).join(' ') + ' node tools/' + inv.tool +
            (mode ? ' ' + mode : '')).trim() };
  });
}

// One line -> the command(s) it runs. Returns [] when the line runs nothing in scope.
function parseCmd(text, lineNo) {
  const out = [];
  const re = /\bnode\s+([^\s|&;()]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const toolTok = m[1];
    const base = path.basename(toolTok);
    if (!/^(view|smoke)\.js$/.test(base) && !SCOPED[base]) continue;
    if (!/(^|\/)tools\//.test(toolTok)) continue;                                // not the harness
    const tail = text.slice(m.index + m[0].length);
    const tokens = tail.split(/[\s]+/).filter(Boolean);
    let mode = null, unexpandable = false;
    if (base === 'view.js') {
      const t = tokens.length ? tokens[0].replace(/^["']|["']$/g, '') : '';
      if (/^[A-Za-z_][\w-]*$/.test(t)) mode = t;
      else if (/\$/.test(t)) { mode = t; unexpandable = true; }
      else if (t !== '') { mode = t; unexpandable = true; }                       // quoted/odd form
    }
    const env = [];
    const pre = text.slice(0, m.index);
    const ere = /\b([A-Z][A-Z0-9_]*)=([^\s()|&;]*)/g;
    let e;
    while ((e = ere.exec(pre)) !== null) env.push([e[1], e[2]]);
    if (env.some((kv) => /\$/.test(kv[1]))) unexpandable = true;
    out.push({ line: lineNo, tool: base, mode, env, unexpandable, text: text.trim(),
      cmd: (env.map((kv) => kv[0] + '=' + kv[1]).join(' ') + ' node tools/' + base +
            (mode ? ' ' + mode : '')).trim() });
  }
  return out;
}

/* Which variable names the harnesses can read at all - so "ambient var dropped" names only knobs
 * that could have changed a verdict, instead of the 40-odd names a login shell happens to carry. */
function toolEnvNames() {
  const names = new Set();
  for (const f of ['view.js', 'smoke.js']) {
    let src = '';
    try { src = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8'); } catch (e) { continue; }
    const re = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

/* ---------------------------------------------------------------- the env-gated row census (#338 ask #2) */

/* The classification half of the census; the LINE half is read out of the tools at run time, and
 * `--env` prints the two together. Class letters are explained in this file's header. Attribution is
 * by NAME, and a name that appears in more than one mode is classified by its most consequential use
 * - which is why every row also prints where it is read, so the reader can check the attribution
 * rather than take it. */
const ENV_CLASS = {
  LEAK: ['A', 'cull: the whole "which ground path paints a seam pixel" block, every config'],
  CFG: ['A', 'cull: the config LIST that block iterates, so it also sets HOW MANY leak rows there are'],
  LEAKROW: ['A', 'cull: per-row R/D dump (print only, adds no row)'],
  CZBAND: ['A', 'cull: the ceiling-step ground-hash + lightmap rows and the "one hash per level" row. THE row #338 is about'],
  BOOT: ['A', 'volume: per-seed deals vs the default one-stream sweep - same rows, DIFFERENT coverage measured'],
  DEALS: ['A', 'volume: how many deals (rows) the verdict is over'],
  SEAM: ['A', 'bands: arms/disarms the seam term the seam rows measure (SEAM=0 disarms)'],
  BANDS: ['A', 'mip: the extra smoothness-vs-mush line'],
  LAMPS: ['A', 'refs / flatparity: whether the lamp-authoring row runs at all; selects PARITY vs LOCK sense'],
  NOCAP: ['A', 'refs: the lamp sweep cap'],
  FP_DEALT: ['A', 'flatparity: selects the DEALT sampler'],
  FP_DEALT1: ['A', 'flatparity: the second DEALT sampler'],
  FP_CHILD: ['A', 'flatparity: the cold-child marker'],
  VERT: ['A', 'smoke: the entire VERT lane - every mover/portal/blast row at altitude'],
  TURN: ['A', 'columns: the turning sweep block'],
  STRICT: ['B', 'promotes filed debt to a gating row (alt, volume, horizon, cull, contrast, anim, bands, smoke VERT)'],
  STEP: ['C', 'cull: the step the leak walk takes'],
  AR: ['C', 'mip: the strip aspect ratio'],
  KIND: ['C', 'anim / stats: which kind is measured'],
  FRAMES: ['C', 'anim / props: frames per roll'],
  ROUNDS: ['C', 'anim / props: rolls'],
  REPS: ['C', 'exposure / columns: rolls'],
  COVROLLS: ['C', 'exposure: coverage rolls'],
  NT: ['C', 'columns: sweep lattice/batch inputs'],
  NW: ['C', 'columns: sweep lattice/batch inputs'],
  PITCH: ['C', 'columns: sweep lattice/batch inputs'],
  BATCH: ['C', 'columns: sweep lattice/batch inputs'],
  BHS: ['C', 'columns: sweep lattice/batch inputs'],
  BWS: ['C', 'columns: sweep lattice/batch inputs'],
  GFX: ['C', 'columns: which gfx set'],
  VW: ['C', 'the render size both harnesses measure at'],
  VH: ['C', 'the render size both harnesses measure at'],
  ASCII: ['C', 'the ASCII print path'],
  SEED: ['C', 'the dealt seed'],
  JSDIR: ['C', 'WHICH CODE the verdict is of - a knob, so it is scrubbed like any other'],
  REFS_LOCK: ['C', 'WHICH REFERENCE TABLE the verdicts are against - same'],
  PSEAT: ['C', 'surface PROP-SECTOR: score ONE named seat instead of the stride walk, so a seat on an issue can be re-measured in a fresh process'],
  BPROK: ['C', 'surface PROP-SECTOR: which DECK the prop is charged against (metres beside a prop, 0 = whole-frame deck)'],
  ARM: ['C', 'surface PROP-SECTOR: the seat-skip radius for a lamp at arm\'s length (0 = never skip)'],
  OUT: ['D', 'where a PNG dump goes; changes no row, so it is carried rather than scrubbed'],
};

function envCensus() {
  const reads = new Map();               // name -> Map(file -> Set(line))
  const perFile = [];
  for (const f of ['view.js', 'smoke.js']) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8').split('\n'); }
    catch (e) { perFile.push(`${f}: UNREADABLE (${e.code || e.message})`); continue; }
    const re = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let hitLines = 0, occurrences = 0;
    const names = new Set();
    src.forEach((line, i) => {
      re.lastIndex = 0;
      let m, n = 0;
      while ((m = re.exec(line)) !== null) {
        if (!reads.has(m[1])) reads.set(m[1], new Map());
        const byFile = reads.get(m[1]);
        if (!byFile.has(f)) byFile.set(f, new Set());
        byFile.get(f).add(i + 1);
        names.add(m[1]); n++;
      }
      if (n) { hitLines++; occurrences += n; }
    });
    perFile.push(`${f}: ${hitLines} line(s), ${occurrences} read(s), ${names.size} distinct name(s)`);
  }
  // Which ci.yml line sets each name: derived from the workflow, never typed here - the roster carries
  // these into the child instead of scrubbing them, which is what makes them not-ambient.
  let ciLines = [];
  try { ciLines = fs.readFileSync(CI_FILE, 'utf8').split('\n'); } catch (e) { /* printed as a gap below */ }
  const setAt = (name) => {
    const out = [];
    ciLines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (new RegExp(`\\b${name}=[^\\s]+`).test(line) && /\bnode\s+[^|&;]*tools\/(view|smoke)\.js/.test(line)) out.push(i + 1);
    });
    return out;
  };

  console.log(`ENV-CENSUS  ${perFile.join('; ')}`);
  const rows = [...reads.entries()].map(([name, at]) => ({
    name, at, n: [...at.values()].reduce((a, s) => a + s.size, 0),
    cls: ENV_CLASS[name] ? ENV_CLASS[name][0] : '-', why: ENV_CLASS[name] ? ENV_CLASS[name][1] : '',
  }));
  rows.sort((a, b) => (a.cls === b.cls ? a.name.localeCompare(b.name) : (a.cls === '-' ? 1 : b.cls === '-' ? -1 : a.cls.localeCompare(b.cls))));
  const where = (at) => {                      // view.js:18,343 +4  smoke.js:83  - deduped, grouped by file
    const parts = [];
    for (const [f, set] of at) {
      const l = [...set].sort((x, y) => x - y);
      parts.push(`${f}:${l.slice(0, 4).join(',')}` + (l.length > 4 ? ` +${l.length - 4}` : ''));
    }
    return parts.join(' ');
  };
  for (const r of rows) {
    console.log(`  ${r.cls}  ${r.name.padEnd(11)} ${where(r.at).padEnd(44)} ${r.why}`);
    const s = r.cls === 'A' || r.cls === 'B' ? setAt(r.name) : [];
    if (s.length) console.log(`        ci.yml sets it at ${s.map((n) => 'ci.yml:' + n).join(', ')} - carried into the child, not scrubbed`);
  }
  const counts = { A: 0, B: 0, C: 0, D: 0, '-': 0 };
  for (const r of rows) counts[r.cls]++;
  // The rot this replaces: a name the map classifies that neither harness reads any more. The census
  // would then be pointing at code that moved, which is the failure mode of a hand-kept table.
  const stale = Object.keys(ENV_CLASS).filter((n) => !reads.has(n));
  console.log(`ENV-CENSUS ${stale.length ? 'FAIL' : 'ok'} - ` +
    `A ${counts.A} name(s) gate whether a ROW EXISTS, B ${counts.B}, C ${counts.C} change what is measured, ` +
    `D ${counts.D}, ${counts['-']} read but unclassified (thresholds, floors, prints) - ` +
    `${stale.length} classified name(s) no longer read: ${stale.join(', ') || 'none'}`);
  if (stale.length)
    console.log('  A classification that points at a read which no longer exists is the rot this census\n' +
      '  replaces: update ENV_CLASS to match the tools, do not leave the row described here.');
  return stale.length ? 1 : 0;
}

/* ---------------------------------------------------------------- the yaml lint (#107) */

// Structural lint only - CI's own `ruby tools/wfyaml.rb` does a real parse, and ruby is not on every
// box this file runs on. Enough to fail the two shapes that have bitten here: a tab in indentation
// and a plain-scalar step name containing colon-space, either of which makes the WHOLE file fail to
// parse, which means no step runs and nothing is reported.
function yamlLint(lines) {
  const bad = [];
  const names = new Map();
  lines.forEach((line, i) => {
    const no = i + 1;
    if (/^\t/.test(line) || /^ +\t/.test(line)) bad.push(`ci.yml:${no} tab in indentation - YAML forbids it, the file will not parse`);
    const m = /^ *(?:-\s*)?(?:name|job):\s*(\S.*?)\s*$/.exec(line);
    if (m) {
      const raw = m[1];
      const quoted = /^['"]/.test(raw);
      if (!quoted && /:\s/.test(raw))
        bad.push(`ci.yml:${no} plain-scalar name contains colon-space ("${raw}") - a plain scalar cannot, the file will not parse (#107)`);
      if (!quoted && /\s#\S/.test(raw))
        bad.push(`ci.yml:${no} name contains an unquoted "#" - YAML starts a comment there`);
      if ((quoted && (raw.match(/['"]/g) || []).length % 2) || (quoted && !/['"]$/.test(raw)))
        bad.push(`ci.yml:${no} name has an unbalanced quote`);
      const key = line.indexOf('name:') + '|' + raw;
      names.set(key, (names.get(key) || 0) + 1);
    }
  });
  for (const [k, n] of names) if (n > 1) bad.push(`duplicate step/job name "${k.split('|')[1]}" x${n} - a workflow cannot key two steps alike`);
  return bad;
}

/* ---------------------------------------------------------------- verdicts */

const FAIL_WORD = /\bFAILED\b|\b[1-9][\d,]*\s+FAILUR/;
const KNOWN_WORD = /([1-9][\d,]*)\s*(?:known-issue|known reporting)\s+row/i;
const VERDICT_SHAPED = /\b(FAILED|FAILURES|FAIL\b|ok\b|PASSED\b)/;
const splitLines = (s) => String(s || '').split('\n').map((x) => x.replace(/\s+$/, '')).filter((x) => x !== '');

function verdictOf(res, entry) {
  const so = splitLines(res.stdout), se = splitLines(res.stderr), out = so.concat(se);
  if (res.error) return { status: 'FAIL', why: 'spawn failed: ' + res.error.message, line: '', notes: [] };
  const code = res.status === null ? 'signal ' + res.signal : res.status;
  const notes = [];
  if (!out.length)
    return { status: 'FAIL', why: `RAN NOTHING - no output at all, exit ${code}`, line: '', notes };
  if (!so.length) notes.push('nothing on stdout, showing stderr');
  const src = so.length ? so : se;
  // The tool's OWN verdict line, found the way each tool writes it: smoke's last PASSED/FAILED (the
  // word CI's step gates on), a view.js mode's last line that opens with its own name
  // (`CULL ok ...`, `heights: all configs ok`, `vert: FAILED`), else the last verdict-shaped line.
  let v;
  if (entry.tool === 'smoke.js') v = [...src].reverse().find((s) => /\bSMOKE (PASSED|FAILED)\b/.test(s));
  else {
    const q = entry.mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp('^\\s*(?:' + q + '[:, ]|' + q + '\\b)', 'i');
    v = [...src].reverse().find((s) => named.test(s));
  }
  if (v === undefined) {
    v = [...src].reverse().find((s) => VERDICT_SHAPED.test(s));
    if (v !== undefined) notes.push("no line opened with the tool's verdict name; showing the last verdict-shaped line");
  }
  if (v === undefined) { v = src[src.length - 1]; notes.push('no verdict-shaped line in the output at all'); }
  const saysFail = FAIL_WORD.test(v);
  let status;
  if (code !== 0) { status = 'FAIL'; if (!saysFail) notes.push(`exit ${code} but its verdict line does not say FAIL`); }
  else if (saysFail) { status = 'FAIL'; notes.push('exit 0 but its own verdict line says FAIL'); }
  else if (entry.tool === 'smoke.js' && !out.some((s) => /\bSMOKE PASSED\b/.test(s))) {
    status = 'FAIL'; notes.push('exit 0 with no SMOKE PASSED line (the word this step gates on)');
  } else {
    const kn = out.map((s) => KNOWN_WORD.exec(s)).filter(Boolean);
    status = kn.length ? 'KNOWN' : 'ok';
  }
  return { status, why: '', line: v.length > 200 ? v.slice(0, 197) + '...' : v, notes, code };
}

/* ---------------------------------------------------------------- run */

function main() {
  const lines = fs.readFileSync(CI_FILE, 'utf8').split('\n');
  const problems = [];
  const notes = [];

  problems.push(...yamlLint(lines));
  const jobs = walk(lines);
  if (!jobs.length) problems.push('ci.yml: the structural walk found no jobs under "jobs:" - either the file is not YAML or it changed shape');
  const gateJobs = jobs.filter((j) => j.gate);
  const selfRun = [];
  if (!gateJobs.length) problems.push('ci.yml: no blocking job found (every job is continue-on-error or informational) - a roster with no gates is not a roster');

  // (A) structural
  const gateLines = new Set(), offRoster = [], scopedOther = [];
  for (const j of jobs) {
    for (const st of j.steps) {
      for (const inv of st.inv || []) {
        inv.job = j.key; inv.step = st.name; inv.gate = j.gate;
        if (j.gate) gateLines.add(inv.line); else offRoster.push(inv);
        j.inv.push(inv);
      }
    }
  }
  // (B) structure-blind, attributed to a job by line range only. Counted as OCCURRENCES, not lines:
  // two commands on one line are two invocations, so a count comparison cannot be satisfied by a
  // line that happens to hold both.
  const rawAll = scanRaw(lines, RAW_RE);
  const rawGate = rawAll.filter((no) => jobs.some((j) => j.gate && no >= j.start && no <= j.end));
  const rawSet = new Set(rawGate);
  const gateArr = [];
  for (const j of gateJobs) for (const st of j.steps) for (const inv of st.inv || []) gateArr.push(inv);
  const gateInvN = gateArr.length, rawInvN = rawGate.length;
  const onlyA = [...gateLines].filter((n) => !rawSet.has(n)).sort((a, b) => a - b);
  const onlyB = rawGate.filter((n) => !gateLines.has(n)).sort((a, b) => a - b);
  if (onlyA.length || onlyB.length || gateInvN !== rawInvN) {
    problems.push(`CI-ROSTER-DISAGREEMENT: the structural walk found ${gateInvN} invocation(s) in the blocking steps `
      + `(on ${gateLines.size} line(s)), the structure-blind line scan found ${rawInvN} (on ${rawSet.size}). ` +
      (onlyA.length ? `Only the walk saw ci.yml:${onlyA.join(', ')} - a command the roster would run blind. ` : '') +
      (onlyB.length ? `Only the scan saw ci.yml:${onlyB.join(', ')} - a blocking invocation the roster would DROP.` : ''));
  }
  if (gateInvN !== rawInvN)
    problems.push(`CI-ROSTER-COUNT: parsed ${gateInvN} != raw ${rawInvN} in the blocking steps`);

  const roster = [];
  const ENVNAMES = toolEnvNames();
  let gateLoopLines = 0;
  for (const j of jobs) {
    for (const st of j.steps) for (const inv of st.inv || []) {
      if (!inv.counted) continue;                                  // a reporting step that swallows status
      const vars = inv.variants;
      if (vars.some((v) => v.unexpandable)) {
        if (j.gate)
          problems.push(`ci.yml:${inv.line} in job "${j.key}" step "${st.name}" runs \`${inv.text.trim()}\` - ` +
            `a gate invocation whose command cannot be formed from the line (a shell loop whose word list is not ` +
            `literal, or an unset expansion). The roster cannot replay it, and running nothing is exactly what #338 is about.`);
        continue;
      }
      if (j.gate && vars.some((v) => v.fromLoop)) gateLoopLines++;
      for (const v of vars) { v.job = j.key; v.step = st.name; v.gate = j.gate; roster.push(v); }
    }
  }
  const gateRunN = roster.filter((v) => v.gate && !v.fromLoop).length;
  const loopRun = roster.filter((v) => v.fromLoop);
  if (LIST && gateRunN + gateLoopLines !== gateInvN)
    problems.push(`CI-ROSTER-COUNT: ${gateRunN} replayable + ${gateLoopLines} loop line(s) != ${gateInvN} parsed in the blocking steps`);
  // What this roster did NOT run, named in the verdict line as well as the listing (#662 ask 1): a
  // reporting step whose shell swallows its children's exit codes is not coverage, and saying so beats
  // saying nothing about eight unreplayed modes.
  const notRun = [];
  for (const j of jobs) {
    if (j.gate) continue;
    for (const st of j.steps) for (const inv of st.inv || [])
      if (!inv.counted && inv.variants.every((v) => !v.unexpandable)) notRun.push({ line: inv.line, job: j.key, step: st.name, n: inv.variants.length, cmd: inv.cmd });
  }

  // Blocking steps that run a harness this roster does not cover by design - a named gap, not a silent one.
  for (const j of gateJobs) {
    for (let ln = j.start; ln <= j.end; ln++) {
      const line = lines[ln - 1];
      if (isComment(line)) continue;
      ANY_RE.lastIndex = 0;
      let m;
      while ((m = ANY_RE.exec(line)) !== null) {
        const base = path.basename(m[0].replace(/^node\s+/, ''));
        if (SCOPED[base]) continue;
        if (base === 'roster.js') { selfRun.push({ line: ln, job: j.key }); continue; }
        scopedOther.push({ line: ln, job: j.key, cmd: m[0].replace(/^node\s+/, '') });
      }
      const ruby = /\bruby\s+(\S*tools\/[^\s]+\.rb)/.exec(line);
      if (ruby && !isComment(line)) scopedOther.push({ line: ln, job: j.key, cmd: ruby[1] });
      // A blocking step can also run a python tool - the release guard and the release-artifact
      // identity check are both python. Neither is replayed here, but neither may be invisible:
      // a python step that silently stopped running would change the gate and leave this roster's
      // own count untouched.
      const py = /\bpython3\s+(?:-m\s+\S+|(\S*tools\/[^\s]+\.py))/.exec(line);
      if (py && !isComment(line))
        scopedOther.push({ line: ln, job: j.key, cmd: py[1] || line.trim().replace(/^python3\s+/, '') });
    }
  }

  // A silenced gate invocation is the same defect in another costume: both parses above skip comments,
  // so `# node tools/view.js cull` would read as an honest 16. Commented-out commands are counted
  // separately and fail, because retiring a verdict means deleting the line (#338's lesson is that a
  // row nobody runs still leaves a green summary behind).
  const silenced = [];
  lines.forEach((line, i) => {
    const m = /^\s*#\s*(?:[A-Z][A-Z0-9_]*=\S*\s+)*node\s+[^\s]*tools\/(?:view|smoke)\.js.*$/.exec(line);
    if (m && jobs.some((j) => j.gate && i + 1 >= j.start && i + 1 <= j.end)) silenced.push(i + 1);
  });
  if (silenced.length)
    problems.push(`COMMENTED-OUT GATE INVOCATION at ci.yml:${silenced.join(', ')} - the blocking steps contain a commented command. `
      + `A commented-out verdict is invisible to BOTH parses above and to CI; delete the line to retire it, or uncomment it.`);

  if (LIST) {
    console.log(`roster of the blocking steps of ${path.relative(ROOT, CI_FILE)} ` +
      `(jobs: ${jobs.map((j) => j.key + (j.gate ? ' [gate]' : ' [reporting]')).join(', ')})`);
    roster.forEach((inv, i) => console.log(`  ${String(i + 1).padStart(2)}  ci.yml:${String(inv.line).padStart(3)}  ${inv.cmd}` +
      (inv.fromLoop ? '   [one of ' + inv.loopWords.length + ' mode(s) read off the loop at ci.yml:' + inv.loopLine +
        (inv.gate ? ', a GATE step]' : '; job "' + inv.job + '" ends exit $' + inv.exitVar + ', so it counts]') : '')));
    for (const o of scopedOther)
      console.log(`  --  ci.yml:${String(o.line).padStart(3)}  BLOCKING, outside this roster's scope (tools/view.js, tools/smoke.js): ${o.cmd}`);
    for (const o of offRoster) {
      if (o.counted && o.variants.some((v) => v.fromLoop))
        console.log(`  --  ci.yml:${String(o.line).padStart(3)}  job "${o.job}" is labelled reporting, but its step sets ` +
          `\`${o.exitVar}=1\` on a failure and ends \`exit $${o.exitVar}\`, so all ${o.variants.length} invocation(s) the loop at ` +
          `ci.yml:${o.variants[0].loopLine} names are replayed above (#662)`);
      else if (o.counted)
        console.log(`  --  ci.yml:${String(o.line).padStart(3)}  not a gate, but replayed because job "${o.job}" step "${o.step}" exits on it: ${o.text.slice(0, 90)}`);
      else
        console.log(`  --  ci.yml:${String(o.line).padStart(3)}  not run: job "${o.job}" reports, does not gate (its step swallows the child's status): ${o.text.slice(0, 90)}`);
    }
    for (const o of selfRun)
      console.log(`  --  ci.yml:${String(o.line).padStart(3)}  this roster's own drift check runs as a blocking step in job "${o.job}" (it is the gate on the count above, not an entry in it)`);
    console.log(`COUNT ${gateRunN + gateLoopLines} replayable invocation(s) = ${gateInvN} structural = ${rawInvN} raw ` +
      `in ${gateJobs.length} blocking job(s), ${offRoster.length} off-roster, ${scopedOther.length} out-of-scope blocking`);
    console.log(`LOOP ${loopRun.length} invocation(s) replayed from shell loop(s) in ci.yml, their failures counted; ` +
      `${notRun.length} loop line(s) NOT replayed (${notRun.map((o) => 'ci.yml:' + o.line + ' in job "' + o.job + '"').join(', ') || 'none'})`);
    console.log(`yaml: ${jobs.length} job(s), ${jobs.reduce((a, j) => a + j.steps.length, 0)} step(s) walked; ` +
      `lint checked tabs, colon-space in plain scalars, unbalanced quotes, duplicate names` +
      ` (CI asserts a real parse with its own wfyaml step)`);
    if (problems.length) { console.log(`DRIFT FAIL - ${problems.length} problem(s):`); problems.forEach((p) => console.log('  ' + p)); return 1; }
    console.log('DRIFT ok - two independent parses of ci.yml agree on the blocking roster');
    return 0;
  }

  const run = QUICK ? roster.slice(0, QUICK) : ONLY.length ? roster.filter((v) => ONLY.some((t) =>
    (v.mode && v.mode === t) || v.tool === t || v.tool === t + '.js' || v.cmd.indexOf(t) >= 0)) : roster;
  if (ONLY.length && !run.length)
    { console.log(`ROSTER 0 invocation(s) - --only ${ONLY.join(',')} matched nothing in the roster; --list prints it`); return 1; }
  let failed = 0, okN = 0, knownN = 0;
  const t0 = Date.now();
  for (let i = 0; i < run.length; i++) {
    const inv = run[i];
    const env = PASSTHROUGH ? Object.assign({}, process.env) : {};
    if (!PASSTHROUGH) for (const k of KEEP_ALL) if (process.env[k] !== undefined) env[k] = process.env[k];
    for (const [k, v] of inv.env) env[k] = v;
    const dropped = PASSTHROUGH ? [] : Object.keys(process.env).filter((k) =>
      !(k in env) && !(KEEP_ALL.indexOf(k) >= 0) && process.env[k] !== undefined && ENVNAMES.has(k));
    const overridden = PASSTHROUGH ? [] : inv.env.filter((kv) => process.env[kv[0]] !== undefined &&
      process.env[kv[0]] !== kv[1]).map((kv) => kv[0] + ': shell had ' + process.env[kv[0]]);
    const abs = path.join(ROOT, 'tools', inv.tool);
    const args = inv.mode ? [abs, inv.mode] : [abs];
    const s = Date.now();
    const res = cp.spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60 * 1000 });
    const v = verdictOf(res, inv);
    const secs = ((Date.now() - s) / 1000).toFixed(1);
    if (v.status === 'FAIL') failed++; else if (v.status === 'KNOWN') knownN++; else okN++;
    // DEBT SHOWS IN THE TAG: a KNOWN row passed, but it passed while its own output carried a
    // non-zero known-issue tally - the #338 lesson is that the tally, not the word "ok", is what a
    // reader has to see, so it is not folded into `ok`.
    const tag = v.status === 'FAIL' ? 'FAIL' : v.status === 'KNOWN' ? 'KNOWN' : 'ok   ';
    let l = `[${String(i + 1).padStart(2)}/${run.length}] ${tag} exit ${res.status === null ? 'signal' : res.status}` +
      `  ${secs.padStart(6)}s  ci.yml:${inv.line}  ${inv.cmd}`;
    if (inv.fromLoop) l += `  [the loop at ci.yml:${inv.loopLine}${inv.gate ? '' : ', counted because job "' + inv.job + '"\'s step exits on $' + inv.exitVar}]`;
    if (dropped.length) l += `  [ambient dropped: ${dropped.join(',')}]`;
    if (overridden.length) l += `  [ci line wins over shell: ${overridden.join(', ')}]`;
    console.log(l);
    console.log(`        ${v.line || v.why}` + (v.notes.length ? `   (${v.notes.join('; ')})` : ''));
    // On a failure the tool's own output is the finding, the same way ci.yml's steps print
    // `echo "$out" | tail -20`: "keeps going after a failure" is only useful if a red line is
    // actionable without re-running the invocation by hand.
    if (v.status === 'FAIL') {
      const tail = splitLines(res.stdout).concat(splitLines(res.stderr)).filter((s) => s !== v.line).slice(-20);
      if (tail.length) { console.log('        --- last ' + tail.length + ' line(s) of its output ---');
        for (const s of tail) console.log('        ' + s.slice(0, 240)); }
    }
    if (res.signal) console.log(`        killed by ${res.signal} after ${secs}s - the roster ran nothing to a verdict`);
  }
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  let census = `ROSTER ${run.length} invocation(s), ${failed} failed, ${okN} ok, ${knownN} known-reporting`;
  // The verdict line names what a per-mode run would not have run at all (#662): the modes that came
  // out of a shell loop rather than a literal line, and any loop the roster still cannot replay.
  const loopHere = run.filter((v) => v.fromLoop);
  if (loopHere.length) census += `  [incl. ${loopHere.length} read off ci.yml's shell loop(s), failures counted]`;
  if (notRun.length) census += `  [NOT RUN: ${notRun.map((o) => o.n + ' invocation(s) of the loop at ci.yml:' + o.line).join(', ')} - that step swallows its children's status]`;
  if (QUICK) census += `  [PARTIAL: first ${run.length} of ${roster.length} in ci.yml's order]`;
  if (ONLY.length) census += `  [PARTIAL: --only ${ONLY.join(',')}: ${run.length} of ${roster.length} in ci.yml's order]`;
  if (PASSTHROUGH) census += '  [shell environment passed through: ROSTER_KEEP_ENV=1]';
  console.log(`${census}  in ${total}s`);
  if (problems.length) { console.log(`CI-ROSTER-DISAGREEMENT (${problems.length} problem(s)):`); problems.forEach((p) => console.log('  ' + p)); }
  return failed || problems.length ? 1 : 0;
}

process.exit(ENVC ? envCensus() : main());
