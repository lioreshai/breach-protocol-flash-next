/* CI assertions that need the COMPOSITED picture, i.e. a real browser.

   node tools/ci/assert.js [exposure]

   Why a browser and not the vm harness the other tools use: the brightness of the frame the
   player sees lives in the display canvas, after bloom, grade, grain and the HUD overlay, and
   those run through canvas-2D compositing (drawImage with a filter, 'lighter', an 'overlay'
   pattern). tools/view.js's stub no-ops every one of them and throws on getImageData, so the
   number this gate needs cannot exist headlessly - which is exactly why #47 was open: every
   existing brightness assert read the raster BEFORE post FX (js/40_render.js renderOverlay), and
   a deploy that composited too dark or too bright passed CI (#85).

   It shells out to the system Chrome over the DevTools protocol with nothing but node built-ins
   (child_process, http, a global WebSocket), because this repo installs nothing.

   Exit codes are distinct and every one prints why: 0 inside the window, 1 outside the window,
   2 unknown assertion name, 3 NOT MEASURED (no browser, no DEV, page threw, no pixels). A run
   that could not measure must never look like a run that passed.
*/
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODE = process.argv[2] || 'exposure';
const ASSERTS = ['exposure', 'audio'];
const TAG = MODE.toUpperCase() + ' GATE:';
if (!ASSERTS.includes(MODE)) {
  console.error('unknown assertion "' + MODE + '" - known: ' + ASSERTS.join(' '));
  process.exit(2);
}

const MIN = +(process.env.LUM_MIN || 60);
const MAX = +(process.env.LUM_MAX || 100);
// #87: the seeded roll-to-roll spread is 18-70 points, i.e. WIDER than the 40-point window, so a
// single roll outside 60-100 proves nothing. The median of ROLLS is what gets asserted.
const ROLLS = Math.max(5, +(process.env.ROLLS || 5));
const YAWS = Math.max(1, +(process.env.YAWS || 6));
// The dice are view.js exposure's: 1000 + level*97 + roll*13. ROLLSEED shifts them to ask
// "is the verdict a property of the level, or of these four numbers?"
const SEED = (+(process.env.ROLLSEED || 1000)) >>> 0;
/* #155: the SPAWN frame - the first frame at the pose startLevel leaves the player in - is asserted on
   its own band, because the 60-100 window above never sampled it: every sampler in the repo parks the
   camera in an arbitrary open cell and spins it through 6 yaws over 5 rolls, so a gate could read
   86/90/73 while the frame the player actually sees first read 12.7/51.4/129.07 (#155, live page).

   DERIVATION - the band is the gap between two rendered FAILURE states, not a fit to the spawn data.
   Both anchors were measured on the composited frame in this geometry (1280x720, stride 4, roll dice
   1000+level*97) with a throwaway probe: "lamps off" = MAP.light zeroed with the authored ambient left
   in place, "lamps + ambient off" = MAP.light zeroed and MAP.amb 0, "lamp in the lens" = the camera 1 m
   from each of 6 lamps facing it:

     level  spawn medians (5 rolls)      all-lamps-off     lamps+ambient off   lamp 1 m in the lens
     L0     56  (rolls 90 21 55 56 118)  mean 13.0         mean 3.9            mean 79.4 .. 137.5
     L1     48  (rolls 28 48 75 83 24)   mean 14.4         mean 3.7            mean 91.0 .. 110.7
     L2     54  (rolls 43 92 35 137 54)  mean 32.2         mean 17.3           mean 130.1 .. 163.9

   So the top of the band is the DIMMEST lamp-in-the-lens view (79.4, L0) rounded down to 75: a first
   frame that reads as bright as a light fixture 1 m from the lens is a spawn placed in a lamp or a lamp
   that is too strong, and no level's spawn median should need that. The bottom is the BRIGHTEST
   lamps-off render (32.2, L2, whose ambient is 0.3 and whose emissive texels are light-exempt) rounded
   up to 35: below that the first frame has no lamp light in it. Same width as the 60-100 window (40
   points) and 25 lower in the scale, because a spawn view is one wall of one room rather than an average
   over 6 yaws - the measured medians (56/48/54) sit 25-35 under the asserted ones (86/90/73).

   What makes this band legitimate rather than loose is that it is asserted on the MEDIAN of the same 5
   seeded rolls as the check above, while the per-roll values are printed and NOT asserted: a single
   pose has no yaw and no frame averaging, so one roll is a view class, not a property of the level -
   measured per-roll range 21..137, which straddles BOTH failure anchors. That overlap is the honest
   limit of this gate, stated rather than hidden: a single dark roll (21 on L0) is dimmer than a level
   with every lamp unlit (32 on L2), because ambient differs per level (0.19 / 0.185 / 0.3), so no
   absolute threshold can police one frame across three levels. A median can, and a systematic change -
   a spawn view with no light in it, or a lamp in the lens - moves it.

   mid (DEV.lum's CENTRE-HALF region mean, js/90_dev.js:235, not a median of luminances) is printed but
   not asserted: its anchors overlap the legit data (a lightless L2 reads mid 40.1 while L1's spawn
   median mid is 31), so a mid band would either never fail or fail today.

   Consequence to expect: the follow-up to #155 authors light placement once #149 lands. If it brightens
   spawn views past 75 this step goes red, and the answer is to re-derive the band from the two anchors
   above - re-render them, do not nudge the number.

   SPAWN_MIN/SPAWN_MAX override the band so it can be narrowed to prove the check can fail (that is what
   they are for); the defaults below are what CI runs, since ci.yml sets neither.
*/
const SMIN = +(process.env.SPAWN_MIN || 35);
const SMAX = +(process.env.SPAWN_MAX || 75);
const VW = +(process.env.VIEWPORT_W || 1280);
const VH = +(process.env.VIEWPORT_H || 720);
const STRIDE = +(process.env.STRIDE || 4);
const PEAK_MIN = +(process.env.PEAK_MIN || 0.002);   // #157: "nothing threw" is not "audible"; full scale 1.0
const DEADLINE = +(process.env.DEADLINE || 300) * 1000;
const url = 'file://' + path.join(ROOT, 'index.html') + '?dev=1&boot=0';

const pad = (s, n) => String(s).padStart(n);
function die(code, lines) { console.error(lines.join('\n')); process.exit(code); }

function chromeBin() {
  // An operator who set CHROME means THAT browser; silently substituting another one is how a
  // guard reports "all clear" for a reason unrelated to the code (AGENTS.md).
  if (process.env.CHROME) {
    if (fs.existsSync(process.env.CHROME)) return process.env.CHROME;
    die(3, [TAG + ' NOT MEASURED - CHROME=' + process.env.CHROME + ' does not exist']);
  }
  const cands = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  die(3, [TAG + ' NOT MEASURED - no Chrome/Chromium binary found at any of:', ...cands.map(c => '  ' + c)]);
}

function waitPort(dir, proc) {
  const f = path.join(dir, 'DevToolsActivePort');
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  let exited = 0;
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
    ws.addEventListener('error', e => rej(new Error('DevTools websocket failed: ' + (e.message || e.type))));
    ws.addEventListener('message', m => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
      if (msg.id && pend.has(msg.id)) {
        const p = pend.get(msg.id); pend.delete(msg.id);
        if (msg.error) p.j(new Error('CDP ' + msg.error.message)); else p.r(msg.result);
      }
    });
  });
}

// One evaluate, and a throw in the page is a failure here rather than an undefined value.
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception;
    // CDP puts the text in `description` ("Error: msg\n at ...") and often leaves `message` unset,
    // so reading only .message reports the page threw "Error: undefined" and hides the reason.
    const what = (e && (e.description || e.message || e.className)) || r.exceptionDetails.text || '(no detail)';
    throw new Error('page threw: ' + String(what).split('\n')[0]);
  }
  return r.result ? r.result.value : undefined;
}

const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n / 2) | 0] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Runs in the page: one ROLL of the generator, then every yaw. The PRNG line is tools/view.js's
// seedRng body on the same 1000 + level*97 + roll*13 dice, so the two tools average the same
// generated levels and their numbers are comparable rather than two dice wearing one label. Seeded
// rolls are also what lets a REQUIRED check be red for a reason instead of on a whim (#87).
const ROLL_FN = `(function (lv, roll, yaws, stride, seed) {
  (function (a) { a = a >>> 0; Math.random = function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(seed);
  startLevel(lv, true);
  S.banner = ''; S.bannerT = 0;
  const cs = [];
  for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) if (!isSolid(x + 0.5, y + 0.5)) cs.push([x, y]);
  if (!cs.length) throw new Error('level ' + lv + ' generated no open cells');
  const c = cs[((cs.length * 0.31 + roll) | 0) % cs.length];
  for (const e of ENEMIES) e.state = 'sleep';
  DEV.freeze(true);
  /* #155: the FIRST FRAME, before any camera move and with update() frozen, on this same generated
     level. The pose is written rather than trusted: P.ang is the heading (there is no P.yaw) and P.z
     is the FEET - js/40_render.js:103 adds cfg.eye to it, so adding cfg.eye here would raise the eye a
     full unit off the floor and measure a floating camera. */
  const pose = (() => {
    const sx = P.x, sy = P.y, sa = P.ang;
    P.x = sx; P.y = sy; P.ang = sa; P.pitch = 0; P.vx = P.vy = P.vz = 0; P.air = false; P.crouch = 0;
    P.z = floorAt(sx, sy);
    if (!(P.z === floorAt(P.x, P.y))) throw new Error('spawn pose is not seated: P.z ' + P.z + ' vs floorAt ' + floorAt(P.x, P.y));
    DEV.tick(1);
    const s = DEV.lum({ stride: stride });
    if (!isFinite(s.mean)) throw new Error('DEV.lum returned a non-finite mean on the spawn frame');
    return { mean: s.mean, mid: s.mid, x: +sx.toFixed(2), y: +sy.toFixed(2), ang: +sa.toFixed(3) };
  })();
  let sum = 0, mid = 0, rast = 0;
  for (let w = 0; w < yaws; w++) {
    DEV.cam(c[0] + 0.5, c[1] + 0.5, undefined, w * 2 * Math.PI / yaws + 0.13, BH * 0.02);
    DEV.tick(2);                       // one frame to refill caches after the regen, one to measure
    const s = DEV.lum({ stride: stride });
    if (!isFinite(s.mean)) throw new Error('DEV.lum returned a non-finite mean at yaw ' + w);
    sum += s.mean; mid += s.mid;
    let rs = 0; const m = px.length;
    for (let i = 0; i < m; i++) { const q = px[i], L = 0.2126 * (q & 255) + 0.7152 * (q >> 8 & 255) + 0.0722 * (q >> 16 & 255); rs += L; }
    rast += rs / m;
  }
  DEV.freeze(false);
  return { mean: sum / yaws, mid: mid / yaws, raster: rast / yaws, cells: cs.length, buf: cv.width + 'x' + cv.height, spawn: pose };
})(%LV%, %ROLL%, %YAWS%, %STRIDE%, %SEED%)`;

/* ---------------- audio (#157) ---------------- */

/* Page side: render every sound through an OfflineAudioContext and measure the WAVEFORM it produces.
   Two reasons, both learned the hard way. A real-time AnalyserNode tap inside --headless=new reads a
   render clock that does not advance, so every peak came back as the same constant and the "audible"
   half of the assert could not fail; and a CI box has no output device at all. Offline rendering is
   deterministic, device-free and still real WebAudio, so handing connect() a number instead of a node
   throws there exactly as it does in a browser. Each sound gets its OWN context so one failure cannot
   hide the next - being able to hide the next failure is how #157 stayed invisible for so long. */
const AUDIO_FN = `(async function () {
  const out = { sounds: [], warns: [], peakMax: 0, fatal: null };
  const ow = console.warn;
  console.warn = function () { out.warns.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 200)); };
  S.sound = true;                        // never gate on the user's mute flag; here the probe needs it on
  try { SND.init(); } catch (e) {}
  out.preBroken = S.audioBroken === true;
  out.preState = SND.ac ? SND.ac.state : 'NO CONTEXT';
  const SR = 44100, DUR = 0.7, N = Math.round(SR * DUR);
  const pans = [0, 0.45, -0.62];        // 0 is the ONE value that used to survive chain(); the others are what panOf() returns
  const calls = [];
  for (const k of ['pistol', 'shotgun', 'rifle', 'dry']) calls.push(['shot', [k]]);
  calls.push(['reload', [1]], ['reload', [2]]);
  for (const p of pans) {
    calls.push(['impact', [p]], ['flesh', [p]], ['gib', [p]], ['explosion', [p]], ['enemyShot', [p]]);
    for (const k of ['grunt', 'hound', 'brute']) calls.push(['growl', [k, p]]);
  }
  calls.push(['pain', []], ['death', []], ['pickup', ['health']], ['pickup', ['ammo']], ['portal', []], ['step', []], ['ui', [700]]);
  // fanfare is deliberately NOT in the sweep: its notes go through setTimeout, so offline rendering
  // cannot schedule them and a peak measured here would be a stopwatch reading, not a sound. Saying so
  // is the point - a probe that quietly skips a sound and counts it as covered is worse than no probe.
  for (const c of calls) {
    const name = c[0] + '(' + c[1].join(',') + ')';
    S.audioBroken = false;
    const off = new OfflineAudioContext(2, N, SR);
    try { SND.init(off); } catch (e) { out.sounds.push({ name: name, threw: 'init: ' + String(e.message || e).slice(0, 120), warned: 0, peak: 0 }); continue; }
    const w0 = out.warns.length;
    let threw = null;
    try { SND[c[0]].apply(SND, c[1]); } catch (e) { threw = String((e && e.message) || e).slice(0, 160); }
    let pk = 0;
    try {
      const buf = await off.startRendering();
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
      }
    } catch (e) { threw = (threw ? threw + ' ; ' : '') + 'render: ' + String(e.message || e).slice(0, 120); }
    pk = +pk.toFixed(5);
    out.sounds.push({ name: name, threw: threw, warned: out.warns.length - w0, peak: pk });
    if (pk > out.peakMax) out.peakMax = pk;
  }
  // Hand the game back its own live context before anything else can run.
  S.audioBroken = false;
  try { SND.ac = null; SND.master = null; SND.music = null; SND.noiseBuf = null; SND.init(); } catch (e) {}
  out.state = SND.ac ? SND.ac.state : 'NO CONTEXT';
  out.broken = S.audioBroken === true;
  out.err = S.err || null;
  out.sampleRate = SR;
  console.warn = ow;
  return out;
})()`;

async function mainAudio() {
  const bin = chromeBin();
  const ver = cp.execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-audio-'));
  const proc = cp.spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--disable-gpu', '--no-sandbox',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--window-size=' + VW + ',' + VH, '--user-data-dir=' + dir, url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp = null;
  const watchdog = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} die(3, [TAG + ' NOT MEASURED - timed out after ' + DEADLINE / 1000 + ' s']); }, DEADLINE);
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
    // Check the code that is about to be exercised. Reading SND.chain.toString() is useless here: every
    // SND method is replaced by the fault wrapper's closure (js/00_core.js:202), so its source would
    // describe the wrapper and report the fix as missing. index.html loads these bytes verbatim.
    const core = fs.readFileSync(path.join(ROOT, 'js', '00_core.js'), 'utf8');
    // A probe must tell "the code is broken" from "I could not look". Offline rendering hooks the graph by
    // handing SND.init a context; a build whose init ignores its arguments (anything before #157) would
    // make every peak read 0.00000 for a reason that has nothing to do with the game being silent.
    const initLen = await evaluate(cdp, 'SND.init.length');
    if (initLen < 1) {
      console.log(TAG + ' NOT MEASURED - SND.init takes no context argument in the running build, so the graph cannot be rendered offline (the seam #157 added). A zero peak here would be this harness being blind, not the game being silent.');
      return 3;
    }
    const r = await evaluate(cdp, AUDIO_FN);
    if (r.fatal) throw new Error(r.fatal);
    const bad = r.sounds.filter(s => s.threw || s.warned);
    const quiet = r.sounds.filter(s => !s.threw && !s.warned && s.peak <= PEAK_MIN);
    console.log('audio: ' + ver + ', ' + r.sounds.length + ' sounds driven with the game\u2019s own argument conventions '
      + '(pan passed as a number), each rendered through its own 0.7 s OfflineAudioContext at 44100 Hz - '
      + 'deterministic, no output device, and a wrong node signature still throws as it does in a browser');
    console.log('  before the probe touched anything: S.audioBroken ' + r.preBroken + ', live context "' + r.preState + '"');
    if (!core.includes('createStereoPanner')) {
      console.log('  NOTE: js/00_core.js has no createStereoPanner - this is the unfixed (#157) code, so pan goes into connect() as a number.');
    }
    console.log('  not measured by this probe: fanfare (notes scheduled with setTimeout), startAmbient (a looping drone - offline rendering would measure a different sound each run).');
    for (const s of bad.concat(quiet)) {
      console.log('  ' + pad(s.name, 22) + ' peak ' + s.peak.toFixed(5) + '  '
        + (s.threw ? 'THREW ' + s.threw : (s.warned ? 'warn x' + s.warned + ': ' + r.warns.slice(-1)[0] : 'SILENT')));
    }
    console.log('  peaks: max ' + r.peakMax + ', inaudible ' + quiet.length + '/' + r.sounds.length + ', throwing '
      + bad.length + ', S.audioBroken after sweep ' + r.broken + ', S.err ' + JSON.stringify(r.err));
    if (bad.length || quiet.length || r.broken) {
      console.log('AUDIO GATE FAIL: ' + bad.length + ' of ' + r.sounds.length + ' sounds threw, ' + quiet.length
        + ' rendered silence' + (r.broken ? ', and S.audioBroken is set - every sound is now a no-op' : ''));
      return 1;
    }
    if (r.peakMax < PEAK_MIN) {
      console.log('AUDIO GATE FAIL: nothing threw but the loudest render peaked at ' + r.peakMax + ' < ' + PEAK_MIN
        + ' - a graph that throws nothing and produces no signal is still silent.');
      return 1;
    }
    console.log('AUDIO ok: peak ' + r.peakMax + ', ' + r.sounds.length + '/' + r.sounds.length + ' sounds render signal, nothing threw');
    return 0;
  } catch (e) {
    console.log(TAG + ' NOT MEASURED - ' + (e && e.message ? e.message : e));
    console.log('  this is a failure of the harness, not a passing grade: nothing was compared.');
    return 3;
  } finally {
    clearTimeout(watchdog);
    if (cdp) { try { cdp.close(); } catch (e) {} }
    try { proc.kill('SIGKILL'); } catch (e) {}
    await exited(proc, 4000);
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('note: left ' + dir + ' behind: ' + e.message + ' - remove it manually'); }
  }
}

async function main() {
  const bin = chromeBin();
  const ver = cp.execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-ci-'));
  const proc = cp.spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--disable-gpu', '--no-sandbox',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--mute-audio', '--window-size=' + VW + ',' + VH, '--user-data-dir=' + dir, url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp = null;
  const watchdog = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} die(3, ['EXPOSURE GATE: NOT MEASURED - timed out after ' + DEADLINE / 1000 + ' s']); }, DEADLINE);
  try {
    const port = await waitPort(dir, proc);
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target among ' + targets.map(t => t.type).join(','));
    cdp = await connect(page.webSocketDebuggerUrl);
    // Pin the LAYOUT viewport rather than trusting --window-size: headless reserves part of the
    // window for its own chrome (here 1280x720 became 1280x581), and BH = DH * tier.res, so an
    // unpinned run measures a different geometry on a different browser build. Pinned, this render
    // is BW x BH = 601 x 338, the same buffer tools/view.js's harness rasterizes into.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

    for (let waited = 0; ; waited += 200) {
      const ok = await evaluate(cdp, '!!(window.DEV && DEV.on && typeof DEV.lum === "function")');
      if (ok) break;
      if (waited > 20000) throw new Error('window.DEV.lum never appeared - is the page loading with ?dev=1?');
      await new Promise(r => setTimeout(r, 200));
    }
    // Boot through the deploy button's own path so the frame measured is a play frame, not the
    // title screen's attract orbit, and say so loudly if the page refuses to get into play.
    const booted = await evaluate(cdp, '(()=>{ resize(); if (S.mode !== "play") DEV.boot(); return { mode: S.mode, err: S.err || null }; })()');
    if (booted.mode !== 'play') throw new Error('DEV.boot() left S.mode at "' + booted.mode + '" (S.err ' + booted.err + ')');
    // A behaviour probe must check the code it is running, not its memory of it (AGENTS.md):
    // getImageData is in the shipped statement, so a lum that read the raster would fail here.
    const src = await evaluate(cdp, 'DEV.lum.toString()');
    if (!src.includes('getImageData')) throw new Error('DEV.lum does not read the canvas (no getImageData in its source) - it is not measuring the composited frame');
    const nLevels = await evaluate(cdp, 'LEVELS.length');
    const buf = await evaluate(cdp, '[cv.width, cv.height, QUAL[S.gfx].name, BW, BH]');
    console.log('exposure: COMPOSITED frame = display canvas ' + buf[0] + 'x' + buf[1] + ' (' + buf[2] + ' tier, raster '
      + buf[3] + 'x' + buf[4] + '), '
      + ver + ', stride ' + STRIDE + ' sample, ' + ROLLS + ' seeded rolls x ' + YAWS + ' yaws per level, band '
      + MIN + '-' + MAX + ' quoted against the MEDIAN not a mean, spawn band ' + SMIN + '-' + SMAX + ' (the first frame)');
    console.log('  (same seeded dice as tools/view.js exposure; its "raster BEFORE bloom/grade/grain" column '
      + 'below is the layer that prints there - the two are not comparable, which is what #85 was about)');

    const bad = [], badSpawn = [];
    let allMed = 0;
    for (let lv = 0; lv < nLevels; lv++) {
      const rolls = [], mids = [], rasts = [], spM = [], spMid = [], spAng = [];
      for (let r = 0; r < ROLLS; r++) {
        const expr = ROLL_FN.replace('%LV%', lv).replace('%ROLL%', r).replace('%YAWS%', YAWS).replace('%STRIDE%', STRIDE)
          .replace('%SEED%', (SEED + lv * 97 + r * 13) >>> 0);
        const v = await evaluate(cdp, expr);
        rolls.push(v.mean); mids.push(v.mid); rasts.push(v.raster);
        spM.push(v.spawn.mean); spMid.push(v.spawn.mid); spAng.push(v.spawn.ang);
        if (!(v.spawn.x >= 0 && v.spawn.y >= 0)) throw new Error('spawn pose is off-map at roll ' + r + ': ' + v.spawn.x + ',' + v.spawn.y);
        process.stdout.write('.');
      }
      process.stdout.write('\n');
      const sorted = rolls.slice().sort((a, b) => a - b);
      const med = median(rolls), spread = sorted[sorted.length - 1] - sorted[0];
      allMed += med;
      const okv = med >= MIN && med <= MAX;
      if (!okv) bad.push('level ' + lv + ' median ' + med.toFixed(1) + ' outside ' + MIN + '-' + MAX);
      const spMed = median(spM), spSorted = spM.slice().sort((a, b) => a - b);
      const oksp = spMed >= SMIN && spMed <= SMAX;
      if (!oksp) badSpawn.push('level ' + lv + ' spawn median ' + spMed.toFixed(1) + ' outside ' + SMIN + '-' + SMAX
        + ' (rolls ' + spM.map(v => v.toFixed(0)).join(' ') + ')');
      console.log('  level ' + lv + pad('  mean ' + (rolls.reduce((a, b) => a + b) / rolls.length).toFixed(0), 9)
        + pad('  median ' + med.toFixed(0), 11)
        + '  rolls ' + rolls.map(v => pad(v.toFixed(0), 3)).join(' ')
        + pad('  spread ' + spread.toFixed(0), 10)
        + pad('  mid ' + median(mids).toFixed(0), 7)
        + pad('  raster ' + median(rasts).toFixed(0), 11)
        + (okv ? '  ok' : '  OUTSIDE')
        + '  | spawn ' + pad(spMed.toFixed(0), 4) + pad(' mid ' + median(spMid).toFixed(0), 6)
        + '  rolls ' + spM.map(v => pad(v.toFixed(0), 3)).join(' ')
        + pad('  spread ' + (spSorted[spSorted.length - 1] - spSorted[0]).toFixed(0), 9)
        + '  yaw ' + spAng[0] + (oksp ? '  ok' : '  OUTSIDE'));
    }
    allMed /= nLevels;
    console.log('  ALL     median ' + allMed.toFixed(1) + '  (mean of the per-level medians)');
    if (bad.length || badSpawn.length) {
      console.log('EXPOSURE GATE FAIL: composited frame outside the ' + MIN + '-' + MAX
        + (badSpawn.length ? ' window, or the first frame at spawn outside ' + SMIN + '-' + SMAX : '') + ' (both on the composited frame)');
      bad.concat(badSpawn).forEach(b => console.log('  ' + b));
      console.log('  the window is the documented exposure target (AGENTS.md: 60-100), here from LUM_MIN/LUM_MAX;');
      console.log('  a median this far off is a shading or post-FX change, and the per-roll values are printed');
      console.log('  above because the roll spread is wider than the window (#87) and is not asserted.');
      if (badSpawn.length) {
        console.log('  the SPAWN band is separate because it samples the FIRST FRAME at the pose startLevel');
        console.log('  leaves (no yaw averaging, no update()), which the 60-100 window never sampled (#155).');
        console.log('  Derivation in the SPAWN_MIN/SPAWN_MAX block at the top of this file: 35 is above the');
        console.log('  brightest render with every lamp unlit (32.2, L2) and 75 is below the dimmest lamp');
        console.log('  1 m in the lens (79.4, L0). LOW = the spawn view has no lamp light in it; HIGH = a');
        console.log('  lamp is in the lens. Asserted on the median of the 5 rolls because one fixed pose is');
        console.log('  a view class rather than a property of the level (per-roll range measured 21-137,');
        console.log('  which straddles both anchors); the rolls are printed above and not judged.');
      }
      return 1;
    }
    console.log('EXPOSURE ok: every level medians inside ' + MIN + '-' + MAX + ' and every level spawn frame inside '
      + SMIN + '-' + SMAX + ' on the composited frame');
    return 0;
  } catch (e) {
    console.log('EXPOSURE GATE: NOT MEASURED - ' + (e && e.message ? e.message : e));
    console.log('  this is a failure of the harness, not a passing grade: nothing was compared.');
    return 3;
  } finally {
    clearTimeout(watchdog);
    if (cdp) cdp.close();
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000).unref();
    // Chrome is still writing into the profile when it is signalled, so removing the directory immediately
    // loses to it: CI's log showed ENOTEMPTY on Default and one leftover directory per run (#145), and 10
    // retries of 200 ms were not enough because the process was alive for all of them. Wait for it to exit,
    // and if the remove still refuses, the path goes to stderr so the verdict stays the last stdout line.
    await exited(proc, 4000);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.error('note: left ' + dir + ' behind: ' + e.message + ' - remove it manually'); }
  }
}

(MODE === 'audio' ? mainAudio() : main()).then(c => { process.exitCode = c; }, e => { console.log(TAG + ' NOT MEASURED - ' + (e && e.stack || e)); process.exitCode = 3; });

// resolve when the child is really gone (or after ms), so cleanup cannot race its profile writes (#145)
function exited(p, ms) {
  return new Promise(res => {
    if (p.exitCode !== null || p.signalCode) return res();
    const t = setTimeout(res, ms);
    p.once('exit', () => { clearTimeout(t); res(); });
  });
}
