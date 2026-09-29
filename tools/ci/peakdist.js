/* Peak DISTRIBUTION probe — issue #168, diagnostic only, changes nothing.

   node tools/ci/peakdist.js [screen|sweep]        (default: sweep)

   Why this exists: tools/ci/assert.js audio renders 37 sounds and compares ONE number per
   sound to PEAK_MIN, so a single render that lands low fails the gate and a single render that
   lands high passes it. That cannot distinguish "this sound is quiet, the threshold is wrong"
   from "the render dropped samples". Only a distribution can, and the gate prints one sample
   per sound per run, so the distribution had to be measured elsewhere.

   Modes
     screen  every sound the gate drives, rendered once, peaks printed low->high.
             Answers "which sounds live near the line" — the candidates for a floor.
     sweep   REPS renders of each sound in SOUNDS, once per load condition (idle, then BUSY
             busy-loops), printing every peak on its own line plus median/min/max/count-under.

   Env  REPS=30  renders per sound per condition
        BUSY=4   busy-loop children for the loaded condition (0 skips that condition)
        SOUNDS=step  comma-separated calls to sweep: a method name takes every call of that method,
                 "shot(dry)" takes that one. The gate's call list is copied from AUDIO_FN, so a
                 peak printed here is the quantity PEAK_MIN is compared against in CI.
        PEAK_MIN=0.002  the line to count against — read-only here, the gate owns the real one
        SEED=n   pin Math.random in the page to the same xorshift tools/ci/assert.js:176 uses.
        FREEZE=1 stop the game's update loop for the sweep (DEV.freeze), so SEED actually pins the
                 draws a render gets. Use both together.
                 This is the CONTROL: with a fixed stream, peaks that still wander are the
                 renderer being nondeterministic under load; peaks that repeat exactly prove the
                 wander is the RNG draws inside the sound (js/00_core.js:84 fills the noise buffer
                 from Math.random, :117 and :125 draw two more per burst). SEED alone is not a
                 control — the game's own update loop draws from the same stream, so it needs
                 FREEZE=1 with it. Measured on #168: FREEZE+SEED gives the identical peak sequence
                 at idle and at 4.8x the render wall time, so load moves nothing and the spread is
                 the draws.

   Exit codes follow the gate's convention so a failure of the harness never looks like a
   verdict: 0 measured, 2 unknown mode, 3 NOT MEASURED (no browser / page refused to boot).

   The Chrome + CDP plumbing below is a copy of mainAudio's in assert.js rather than a require:
   assert.js runs its main() at load, and making it importable would mean editing the gate to
   write a diagnostic. The launch flags are the same ones on purpose — a measurement taken in a
   different browser environment is not the quantity the gate compares. */
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const url = 'file://' + path.join(ROOT, 'index.html') + '?dev=1&boot=0';
const MODE = process.argv[2] || 'sweep';
const REPS = Math.max(1, +(process.env.REPS || 30));
const BUSY = Math.max(0, +(process.env.BUSY === undefined ? 4 : process.env.BUSY));
const PEAK_MIN = +(process.env.PEAK_MIN || 0.002);
const SEED = process.env.SEED === undefined ? '' : (+process.env.SEED >>> 0);
// FREEZE=1 stops the game's own update loop for the sweep. Without it the rAF loop consumes an
// arbitrary number of Math.random draws between two renders (enemies, particles, pickups all draw),
// so a SEED alone does not pin which slice of the stream a render gets - measured: two SEED=7 runs
// of step() disagreed. Frozen + seeded, the only consumer is the sound, so the control means what it
// says. No camera moves here, so freezing cannot walk the player into the void.
const FREEZE = process.env.FREEZE === '1';
const SR = 44100, DUR = 0.7, NSAMP = Math.round(SR * DUR);
const DEADLINE = +(process.env.DEADLINE || 600) * 1000;

if (MODE === '--busy') {                      // one core, no syscalls, until killed
  let x = 1;
  for (; ;) x = Math.sqrt(x + 1) + 1;
}
if (MODE !== 'screen' && MODE !== 'sweep') {
  console.error('unknown mode "' + MODE + '" - known: screen sweep (--busy is internal)');
  process.exit(2);
}

const pad = (s, n) => String(s).padStart(n);
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n / 2) | 0] : (s[n / 2 - 1] + s[n / 2]) / 2; };

function chromeBin() {
  if (process.env.CHROME) {
    if (fs.existsSync(process.env.CHROME)) return process.env.CHROME;
    console.error('PEAKDIST NOT MEASURED - CHROME=' + process.env.CHROME + ' does not exist');
    process.exit(3);
  }
  const cands = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error('PEAKDIST NOT MEASURED - no Chrome/Chromium binary found at any of:', ...cands.map(c => '  ' + c));
  process.exit(3);
}

function waitPort(dir, proc) {
  const f = path.join(dir, 'DevToolsActivePort');
  let stderr = '', exited = 0;
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('exit', c => { exited = c; });
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const step = () => {
      if (fs.existsSync(f)) {
        const port = +fs.readFileSync(f, 'utf8').split('\n')[0];
        if (port) return res(port);
      }
      if (exited) return rej(new Error('browser exited with code ' + exited + ' before opening DevTools: ' + stderr.slice(-400)));
      if (Date.now() - t0 > 30000) return rej(new Error('no DevToolsActivePort in ' + dir + ' after 30 s; stderr: ' + stderr.slice(-400)));
      setTimeout(step, 50);
    };
    step();
  });
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const pend = new Map();
    let id = 0;
    ws.addEventListener('open', () => res({
      send(method, params) {
        const mid = ++id;
        return new Promise((r2, j2) => {
          pend.set(mid, { r: r2, j: j2 });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { ws.close(); }
    }));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pend.has(msg.id)) {
        const p = pend.get(msg.id); pend.delete(msg.id);
        if (msg.error) p.j(new Error('CDP ' + msg.error.message)); else p.r(msg.result);
      }
    });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception;
    const what = (e && (e.description || e.message || e.className)) || r.exceptionDetails.text || '(no detail)';
    throw new Error('page threw: ' + String(what).split('\n')[0]);
  }
  return r.result ? r.result.value : undefined;
}

function exited(p, ms) {
  return new Promise(res => {
    if (p.exitCode !== null || p.signalCode) return res();
    const t = setTimeout(res, ms);
    p.once('exit', () => { clearTimeout(t); res(); });
  });
}

/* The gate's own call list, copied from AUDIO_FN (tools/ci/assert.js:230-240) so that a number
   printed here is the same quantity PEAK_MIN is compared against in CI. Pan is a NUMBER, the way
   panOf() returns it, which was #157's whole bug. */
function buildCalls() {
  const calls = [];
  for (const k of ['pistol', 'shotgun', 'rifle', 'dry']) calls.push(['shot', [k]]);
  calls.push(['reload', [1]], ['reload', [2]]);
  const pans = [0, 0.45, -0.62];
  for (const p of pans) {
    calls.push(['impact', [p]], ['flesh', [p]], ['gib', [p]], ['explosion', [p]], ['enemyShot', [p]]);
    for (const k of ['grunt', 'hound', 'brute']) calls.push(['growl', [k, p]]);
  }
  calls.push(['pain', []], ['death', []], ['pickup', ['health']], ['pickup', ['ammo']],
    ['portal', []], ['step', []], ['ui', [700]]);
  return calls;
}

// Renders each [method, args] REPS times, each render in its OWN OfflineAudioContext, exactly as the
// gate does, and returns one row per render. S.audioBroken is reset and re-read per render because
// js/00_core.js:224 makes one throw silence every later sound for the page's life — if that ever
// trips mid-sweep the later rows would read ~0 and look like a scheduling loss.
function sweepFn(reps, calls, seed, freeze) {
  const seedLine = seed === '' ? '' : '(function (a) { a = a >>> 0; Math.random = function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(' + seed + ');';
  const freezeLine = freeze ? 'DEV.freeze(true);' : '';
  return `(async function () {
  ${seedLine}
  ${freezeLine}
  const out = { rows: [], warns: [], fatal: null };
  const ow = console.warn;
  console.warn = function () { out.warns.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 200)); };
  S.sound = true;
  try { SND.init(); } catch (e) {}
  const SR = ${SR}, N = ${NSAMP};
  const calls = ${JSON.stringify(calls)};
  try {
    for (const c of calls) {
      const name = c[0] + '(' + c[1].join(',') + ')';
      for (let r = 0; r < ${reps}; r++) {
        S.audioBroken = false;
        const w0 = out.warns.length;
        const off = new OfflineAudioContext(2, N, SR);
        let threw = null, pk = 0;
        const t0 = performance.now();
        try { SND.init(off); } catch (e) { threw = 'init: ' + String(e.message || e).slice(0, 120); }
        if (!threw) { try { SND[c[0]].apply(SND, c[1]); } catch (e) { threw = String((e && e.message) || e).slice(0, 160); } }
        if (!threw) {
          try {
            const buf = await off.startRendering();
            for (let ch = 0; ch < buf.numberOfChannels; ch++) {
              const d = buf.getChannelData(ch);
              for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
            }
          } catch (e) { threw = 'render: ' + String(e.message || e).slice(0, 120); }
        }
        out.rows.push({ name: name, rep: r, peak: +pk.toFixed(5), ms: +(performance.now() - t0).toFixed(1),
          threw: threw, warned: out.warns.length - w0, broken: S.audioBroken === true });
      }
    }
  } catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
  S.audioBroken = false;
  ${freeze ? 'DEV.freeze(false);' : ''}
  try { SND.ac = null; SND.master = null; SND.music = null; SND.noiseBuf = null; SND.init(); } catch (e) {}
  console.warn = ow;
  return out;
})()`;
}

const load = () => os.loadavg().map(x => x.toFixed(2)).join(' / ');

function summarize(tag, rows) {
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const lines = [];
  for (const [name, rs] of byName) {
    const peaks = rs.map(r => r.peak);
    const under = peaks.filter(p => p < PEAK_MIN).length;
    const threw = rs.filter(r => r.threw).length, warned = rs.filter(r => r.warned).length;
    const broken = rs.filter(r => r.broken).length;
    const sorted = peaks.slice().sort((a, b) => a - b);
    const half = Math.floor(rs.length / 2);
    // slowest half vs fastest half by wall time: if peaks track render slowness, load is the axis;
    // if the two means agree, wall time is not what moves the peak.
    const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    const slow = rs.slice().sort((a, b) => b.ms - a.ms).slice(0, half).map(r => r.peak);
    const fast = rs.slice().sort((a, b) => a.ms - b.ms).slice(0, half).map(r => r.peak);
    lines.push('  ' + tag + ' ' + pad(name, 20) + ' n=' + rs.length
      + '  median ' + median(peaks).toFixed(5) + '  min ' + sorted[0].toFixed(5) + '  max ' + sorted[sorted.length - 1].toFixed(5)
      + '  under ' + under + '/' + rs.length
      + '  threw ' + threw + ' warned ' + warned + ' broken ' + broken
      + '  ms med ' + median(rs.map(r => r.ms)).toFixed(1)
      + '  [slow-half mean ' + mean(slow).toFixed(5) + ' vs fast-half ' + mean(fast).toFixed(5) + ']');
    lines.push('      ' + sorted.map(p => p.toFixed(5)).join(' '));
  }
  return lines.join('\n');
}

async function run(cdp, reps, calls) {
  const t0 = Date.now();
  const r = await evaluate(cdp, sweepFn(reps, calls, SEED, FREEZE));
  if (r.fatal) throw new Error('page-side sweep failed: ' + r.fatal);
  return { rows: r.rows, warns: r.warns, wall: (Date.now() - t0) / 1000 };
}

async function main() {
  const bin = chromeBin();
  const ver = cp.execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-peak-'));
  const proc = cp.spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--disable-gpu', '--no-sandbox',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,720', '--user-data-dir=' + dir, url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp = null, workers = [];
  const watchdog = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch (e) {}
    console.log('PEAKDIST NOT MEASURED - timed out after ' + DEADLINE / 1000 + ' s');
    process.exitCode = 3;
  }, DEADLINE);
  const stopWorkers = () => { for (const w of workers) { try { w.kill('SIGKILL'); } catch (e) {} } workers = []; };
  try {
    const port = await waitPort(dir, proc);
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target among ' + targets.map(t => t.type).join(','));
    cdp = await connect(page.webSocketDebuggerUrl);
    for (let waited = 0; ; waited += 200) {
      const ok = await evaluate(cdp, '!!(window.DEV && DEV.on && typeof SND !== "undefined" && typeof SND.init === "function")');
      if (ok) break;
      if (waited > 20000) throw new Error('window.DEV / SND never appeared - is the page loading with ?dev=1?');
      await new Promise(r => setTimeout(r, 200));
    }
    const booted = await evaluate(cdp, '(()=>{ resize(); if (S.mode !== "play") DEV.boot(); return { mode: S.mode, err: S.err }; })()');
    if (booted.mode !== 'play') throw new Error('DEV.boot() left S.mode at "' + booted.mode + '" (S.err ' + booted.err + ')');
    // Check the code being exercised rather than remembering it (AGENTS.md): an offline render hooks
    // the graph by handing SND.init a context, so a pre-#157 build would report every peak as 0 and
    // this probe would be measuring its own blindness.
    const initLen = await evaluate(cdp, 'SND.init.length');
    if (initLen < 1) throw new Error('SND.init takes no context argument in this build - offline rendering is not hooked, so a zero peak here would be the probe being blind (#157 seam)');
    console.log('peakdist: ' + ver + ', ' + os.cpus().length + ' cores, load ' + load()
      + ', SR ' + SR + ', ' + DUR + ' s renders, PEAK_MIN ' + PEAK_MIN + ' (read-only here), Math.random '
      + (SEED === '' ? 'UNSEEDED (the gate does not seed it either)' : 'SEEDED ' + SEED)
      + ', game loop ' + (FREEZE ? 'FROZEN' : 'running'));

    const all = buildCalls();
    if (MODE === 'screen') {
      const r = await run(cdp, 1, all);
      const rows = r.rows.slice().sort((a, b) => a.peak - b.peak);
      console.log('  one render each of ' + rows.length + ' sounds, load ' + load() + ', ascending peak:');
      for (const s of rows) {
        console.log('    ' + pad(s.name, 22) + s.peak.toFixed(5) + (s.threw ? '  THREW ' + s.threw : s.warned ? '  warn x' + s.warned : s.peak < PEAK_MIN ? '  UNDER' : ''));
      }
      const under = rows.filter(s => s.peak < PEAK_MIN).length;
      console.log('  ' + under + ' of ' + rows.length + ' under ' + PEAK_MIN + ' on this single pass (the gate is one pass like this)');
    } else {
      const picked = (process.env.SOUNDS || 'step').split(',').map(s => s.trim()).filter(Boolean);
      const calls = [];
      for (const name of picked) {
        // a bare method name takes every call of that method; "shot(dry)" takes that one call, so a
        // sweep can name the quiet members of a family rather than all of them
        const hit = all.filter(c => c[0] === name || c[0] + '(' + c[1].join(',') + ')' === name);
        if (!hit.length) throw new Error('no sound named "' + name + '" in the gate list - known calls: ' + all.map(c => c[0] + '(' + c[1].join(',') + ')').join(' '));
        for (const c of hit) calls.push(c);
      }
      console.log('sweeping ' + calls.map(c => c[0] + '(' + c[1].join(',') + ')').join(', ') + ' x ' + REPS + ' renders');
      let rows = await run(cdp, REPS, calls);
      console.log('  IDLE   load ' + load() + ' wall ' + rows.wall.toFixed(1) + ' s');
      for (const r of rows.rows) console.log('    ' + pad(r.name, 20) + ' rep ' + pad(r.rep, 2) + '  peak ' + r.peak.toFixed(5) + '  ' + pad(r.ms.toFixed(0), 5) + ' ms'
        + (r.threw ? '  THREW ' + r.threw : r.warned ? '  warn x' + r.warned : r.broken ? '  audioBroken' : r.peak < PEAK_MIN ? '  UNDER' : ''));
      console.log(summarize('IDLE  ', rows.rows));
      if (BUSY > 0) {
        workers = [];
        for (let i = 0; i < BUSY; i++) workers.push(cp.spawn(process.execPath, [__filename, '--busy'], { stdio: 'ignore' }));
        await new Promise(r => setTimeout(r, 2500));
        console.log('  started ' + BUSY + ' busy-loops, load now ' + load());
        rows = await run(cdp, REPS, calls);
        console.log('  LOADED load ' + load() + ' wall ' + rows.wall.toFixed(1) + ' s');
        for (const r of rows.rows) console.log('    ' + pad(r.name, 20) + ' rep ' + pad(r.rep, 2) + '  peak ' + r.peak.toFixed(5) + '  ' + pad(r.ms.toFixed(0), 5) + ' ms'
          + (r.threw ? '  THREW ' + r.threw : r.warned ? '  warn x' + r.warned : r.broken ? '  audioBroken' : r.peak < PEAK_MIN ? '  UNDER' : ''));
        console.log(summarize('LOADED', rows.rows));
        stopWorkers();
        await new Promise(r => setTimeout(r, 1500));
        console.log('  workers stopped, load ' + load());
      }
    }
    return 0;
  } catch (e) {
    console.log('PEAKDIST NOT MEASURED - ' + (e && e.message ? e.message : e));
    console.log('  a run that could not measure is not a run that passed: nothing was compared.');
    return 3;
  } finally {
    clearTimeout(watchdog);
    stopWorkers();
    if (cdp) { try { cdp.close(); } catch (e) {} }
    try { proc.kill('SIGKILL'); } catch (e) {}
    await exited(proc, 4000);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.error('note: left ' + dir + ' behind: ' + e.message + ' - remove it manually'); }
  }
}

main().then(c => { process.exitCode = c; }, e => { console.log('PEAKDIST NOT MEASURED - ' + (e && e.stack || e)); process.exitCode = 3; });
