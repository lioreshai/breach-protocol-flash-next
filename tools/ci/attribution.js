/* Attribution probe - issue #168, diagnostic only, changes no production code and no threshold.

   node tools/ci/attribution.js [step]   (arg = only these sounds, same syntax as peakdist SOUNDS)

   Question it answers: the gate compares ONE number per sound to PEAK_MIN, and silencing the
   sound under test did not make the gate notice. So: is the number the gate records actually the
   render of that sound? This runs the gate's OWN sweep (AUDIO_FN's call list and render path,
   tools/ci/assert.js:223) with the whole audio object wrapped, so every burst()/tone() call that
   reaches a context is logged with the tag of the context it was bound to, the wall-clock instant
   it was made, and the call site. For each render it then reports:

     peak      the number PEAK_MIN is compared against
     own       calls made by the method under test (inside the synchronous call)
     foreign   calls that reached THIS context from anywhere else (the game loop, startAmbient's
               tick chain, a later SND.init refilling noiseBuf) during the render window
     prev/next peak of the neighbouring renders in sweep order, to see shared-buffer patterns

   Foreign calls are the whole point: a render whose own sound is silent and whose peak is nonzero
   has been contaminated, and the stack printed beside it names who did it.

   UPDATE from the fix this fed: tools/ci/assert.js now DROPS these calls instead of measuring them,
   so the gate's peak is the sound under test alone. This probe keeps them in on purpose - its job is
   to show what the gate used to be counting, and it cannot show that to a build of itself that
   suppresses. Set FREEZE=1 to stop the update loop as a control for how much is the loop's doing. */
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const url = 'file://' + path.join(ROOT, 'index.html') + '?dev=1&boot=0';
const SR = 44100, DUR = 0.7, NSAMP = Math.round(SR * DUR);
const PEAK_MIN = +(process.env.PEAK_MIN || 0.002);
const DEADLINE = +(process.env.DEADLINE || 300) * 1000;
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const REPS = Math.max(1, +(process.env.REPS || 1));

const pad = (s, n) => String(s).padEnd(n);
function chromeBin() {
  const cands = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (process.env.CHROME) { if (fs.existsSync(process.env.CHROME)) return process.env.CHROME; }
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error('ATTRIBUTION NOT MEASURED - no Chrome binary'); process.exit(3);
}
function waitPort(dir, proc) {
  const f = path.join(dir, 'DevToolsActivePort');
  let stderr = ''; proc.stderr.on('data', d => { stderr += d; });
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const step = () => {
      if (fs.existsSync(f)) { const p = +fs.readFileSync(f, 'utf8').split('\n')[0]; if (p) return res(p); }
      if (proc.exitCode !== null) return rej(new Error('browser exited early: ' + stderr.slice(-300)));
      if (Date.now() - t0 > 30000) return rej(new Error('no DevToolsActivePort; ' + stderr.slice(-300)));
      setTimeout(step, 50);
    }; step();
  });
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl), pend = new Map(); let id = 0;
    ws.addEventListener('open', () => res({
      send(method, params) { const mid = ++id; return new Promise((r, j) => { pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }); },
      close() { ws.close(); }
    }));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); if (m.error) p.j(new Error('CDP ' + m.error.message)); else p.r(m.result); }
    });
  });
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception;
    throw new Error('page threw: ' + String((e && (e.description || e.message)) || r.exceptionDetails.text).split('\n')[0]);
  }
  return r.result ? r.result.value : undefined;
}

/* The gate's call list, copied from AUDIO_FN's `calls` array in tools/ci/assert.js. */
function buildCalls() {
  const calls = [];
  for (const k of ['pistol', 'shotgun', 'rifle', 'dry']) calls.push(['shot', [k], 'shot(' + k + ')']);
  calls.push(['reload', [1], 'reload(1)'], ['reload', [2], 'reload(2)']);
  for (const p of [0, 0.45, -0.62]) {
    calls.push(['impact', [p], 'impact(' + p + ')'], ['flesh', [p], 'flesh(' + p + ')'], ['gib', [p], 'gib(' + p + ')'],
      ['explosion', [p], 'explosion(' + p + ')'], ['enemyShot', [p], 'enemyShot(' + p + ')']);
    for (const k of ['grunt', 'hound', 'brute']) calls.push(['growl', [k, p], 'growl(' + k + ',' + p + ')']);
  }
  calls.push(['pain', [], 'pain()'], ['death', [], 'death()'], ['pickup', ['health'], 'pickup(health)'],
    ['pickup', ['ammo'], 'pickup(ammo)'], ['portal', [], 'portal()'], ['step', [], 'step()'], ['ui', [700], 'ui(700)']);
  return calls;
}

/* AUDIO_FN's render path, verbatim in structure, plus:
     - a tag stamped on each context, so a call can be attributed to the render it landed in
     - SND.burst / SND.tone / SND.init wrapped to record every call and its context
     - the live rAF loop left RUNNING (as the gate leaves it) - FREEZE=1 is the control that stops it */
function probeFn(calls, reps, freeze) {
  return `(async function () {
  const out = { rows: [], calls: [], warns: [], fatal: null };
  const ow = console.warn;
  console.warn = function () { out.warns.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 200)); };
  S.sound = true;
  try { SND.init(); } catch (e) {}
  ${freeze ? 'DEV.freeze(true);' : ''}
  const SR = ${SR}, N = ${NSAMP};
  const CALLS = ${JSON.stringify(calls.map(c => [c[0], c[1], c[2]]))};
  let seq = 0, cur = null;
  function site() {
    try {
      const st = String(new Error().stack || '').split('\\n');
      const hop = st.filter(l => !/at (Object\\.|probe|rec)/.test(l) && l.indexOf('at new Error') < 0).slice(0, 4);
      return hop.map(l => l.trim().replace(/^at /, '').replace(/\\s*\\(?file:[^)]*\\)?/, '')).join(' < ');
    } catch (e) { return '?'; }
  }
  function rec(kind, args) {
    const ac = SND.ac;
    out.calls.push({ t: +(performance.now() - (cur ? cur.t0 : performance.now())).toFixed(1),
      kind: kind, args: String(args).slice(0, 70), tag: (ac && ac.__tag) || (ac ? 'UNTAGGED' : 'NO CTX'),
      render: cur ? cur.tag : null, site: site(), gen: (SND.noiseBuf && SND.noiseBuf.__gen) });
  }
  for (const k of ['burst', 'tone']) {
    const f = SND[k];
    SND[k] = function () { rec(k, Array.prototype.slice.call(arguments).join(',')); return f.apply(this, arguments); };
  }
  const initF = SND.init;
  SND.init = function (c) { const r = initF.apply(this, arguments); if (c) c.__gen = seq; if (SND.noiseBuf && SND.noiseBuf.__gen === undefined) SND.noiseBuf.__gen = seq; return r; };
  try {
    for (const c of CALLS) {
      const name = c[2];
      for (let rep = 0; rep < ${reps}; rep++) {
        S.audioBroken = false;
        const off = new OfflineAudioContext(2, N, SR);
        off.__tag = name + '#' + (seq++);
        try { SND.init(off); } catch (e) { out.rows.push({ name: name, rep: rep, peak: 0, threw: 'init', own: 0, foreign: 0 }); continue; }
        cur = { tag: off.__tag, t0: performance.now(), mark: out.calls.length };
        let threw = null, pk = 0;
        const m0 = out.calls.length;
        try { SND[c[0]].apply(SND, c[1]); } catch (e) { threw = String((e && e.message) || e).slice(0, 120); }
        const m1 = out.calls.length;
        try {
          const buf = await off.startRendering();
          for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
          }
        } catch (e) { threw = (threw ? threw + ' ; ' : '') + 'render: ' + String(e.message || e).slice(0, 120); }
        const foreign = out.calls.slice(m1).filter(x => x.tag === off.__tag);
        const wall = +(performance.now() - cur.t0).toFixed(1);
        cur = null;
        out.rows.push({ name: name, rep: rep, peak: +(+pk).toFixed(5), threw: threw,
          own: m1 - m0, foreign: foreign.length, ms: wall,
          foreignSites: foreign.map(x => x.kind + '(' + x.args + ') @+' + x.t + 'ms <- ' + x.site).slice(0, 4) });
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

async function main() {
  const bin = chromeBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-attr-'));
  const proc = cp.spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--disable-gpu', '--no-sandbox',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,720', '--user-data-dir=' + dir, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp = null;
  const watchdog = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} console.log('ATTRIBUTION NOT MEASURED - timeout'); process.exitCode = 3; }, DEADLINE);
  try {
    const port = await waitPort(dir, proc);
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    cdp = await connect(page.webSocketDebuggerUrl);
    for (let w = 0; ; w += 200) {
      if (await evaluate(cdp, '!!(window.DEV && DEV.on && typeof SND !== "undefined" && typeof SND.init === "function")')) break;
      if (w > 20000) throw new Error('page never exposed DEV/SND');
      await new Promise(r => setTimeout(r, 200));
    }
    await evaluate(cdp, '(()=>{ resize(); if (S.mode !== "play") DEV.boot(); return S.mode; })()');
    if (await evaluate(cdp, 'SND.init.length') < 1) throw new Error('SND.init takes no ctx arg - offline seam absent, this build predates #157');
    const all = buildCalls();
    const calls = ONLY.length ? all.filter(c => ONLY.indexOf(c[0]) >= 0 || ONLY.indexOf(c[2]) >= 0) : all;
    if (!calls.length) throw new Error('no call matched ' + ONLY.join(','));
    console.log('attribution: ' + calls.length + ' renders, load ' + os.loadavg().map(x => x.toFixed(2)).join(' ')
      + ', game loop ' + (process.env.FREEZE === '1' ? 'FROZEN' : 'RUNNING (as in the gate)')
      + ', PEAK_MIN ' + PEAK_MIN + ' (read-only here), REPS ' + REPS);
    const r = await evaluate(cdp, probeFn(calls, REPS, process.env.FREEZE === '1'));
    if (r.fatal) throw new Error('page-side failed: ' + r.fatal);
    console.log('  ' + pad('sound', 22) + 'peak     own  foreign  ms     prev      next');
    r.rows.forEach((s, i) => {
      const prev = r.rows[i - 1], next = r.rows[i + 1];
      const under = s.peak <= PEAK_MIN ? ' UNDER' : '';
      console.log('  ' + pad(s.name, 22) + s.peak.toFixed(5) + under + '   ' + pad(s.own, 4)
        + pad(s.foreign, 7) + ' ' + pad(s.ms, 6) + ' '
        + (prev ? prev.peak.toFixed(5) : '  -   ') + '   ' + (next ? next.peak.toFixed(5) : '  -  ')
        + (s.threw ? ' THREW ' + s.threw : ''));
      for (const f of s.foreignSites) console.log('        FOREIGN -> ' + f);
    });
    const tot = r.rows.reduce((a, s) => a + s.foreign, 0);
    const contam = r.rows.filter(s => s.foreign > 0).length;
    console.log('  renders with foreign calls inside their window: ' + contam + '/' + r.rows.length + ', total foreign calls ' + tot);
    return 0;
  } catch (e) {
    console.log('ATTRIBUTION NOT MEASURED - ' + (e && e.message ? e.message : e)); return 3;
  } finally {
    clearTimeout(watchdog);
    if (cdp) { try { cdp.close(); } catch (e) {} }
    try { proc.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
  }
}
main().then(c => { process.exitCode = c; }, e => { console.log('ATTRIBUTION NOT MEASURED - ' + (e && e.stack || e)); process.exitCode = 3; });
