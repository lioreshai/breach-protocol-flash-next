'use strict';
/* ==================================================================
   00_core.js — utils, canvases, state, synthesized audio
   ================================================================== */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
// frame-rate independent approach to a target: the house damping idiom, named once
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const rnd = (a = 1, b = 0) => b + Math.random() * (a - b);
const rndi = n => (Math.random() * n) | 0;
const pick = a => a[(Math.random() * a.length) | 0];
const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };

/* ---------------- canvases ---------------- */
const cv = document.getElementById('screen');
const ctx = cv.getContext('2d');
let DPR = 1, DW = 0, DH = 0;
const bufCv = document.createElement('canvas');
const bufCtx = bufCv.getContext('2d', { alpha: false });
let BW = 0, BH = 0, imgBuf = null, px = null, zbuf = null;

/* ---------------- config ---------------- */
let FOGC = [9, 12, 20];   // per level: air has a colour
const LVL = 32;                       // light/fog buckets
const cfg = {
  plane: 0.72,      // camera plane => ~71.7 deg horizontal FOV
  eye: 0.5,         // standing eye height, in world units
  sens: 0.0021      // pointer-lock radians per mouse pixel
};

/* ---------------- global state ---------------- */
const DIFFS = [
  { name: 'Recruit', dmg: 0.55, hp: 0.8, cnt: 0.8, droprate: 1.35 },
  { name: 'Marine', dmg: 1.0, hp: 1.0, cnt: 1.0, droprate: 1.0 },
  { name: 'Nightmare', dmg: 1.7, hp: 1.35, cnt: 1.35, droprate: 0.75 }
];
const S = {
  mode: 'title',      // title | play | pause | dead | win
  level: 0, diff: 1, t: 0, dt: 0, fps: 0, frames: 0, fpsT: 0,
  locked: false, exitOpen: false, shake: 0, flash: 0, muzzle: 0, flashCol: [255, 90, 40],
  err: '', audioBroken: false,
  hitMark: 0, headMark: 0, banner: '', bannerT: 0, showMap: true, revealed: 0,
  sound: true, perf: false, runT: 0, gfx: 1
};
const P = {
  x: 2.5, y: 2.5, ang: 0, pitch: 0, vx: 0, vy: 0,
  hp: 100, armor: 0, z: 0, vz: 0, air: false,
  crouch: 0, sprint: 0, bob: 0, bobPhase: 0, recoil: 0,
  weapon: 0, mag: [12, 6, 34], reserve: [140, 48, 240], gren: 4,
  fireT: 0, reloadT: 0, swapT: 0, ads: 0, hurtT: 0, kick: 0, deadT: 0,
  kills: 0, shots: 0, hits: 0, dmg: 0, stepT: 0
};
const keys = Object.create(null);
const mouse = { down: false, rdown: false, dx: 0, dy: 0 };
const feed = [];
function banner(text, t = 2.6) { S.banner = text; S.bannerT = t; }
function killfeed(text, col) { feed.unshift({ text, col: col || '#ffcbb3', t: 3.4 }); if (feed.length > 6) feed.pop(); }

/* ==================================================================
   audio — everything synthesized, no assets
   ================================================================== */
const SND = {
  ac: null, master: null, musicGain: null, noiseBuf: null, music: null,
  init() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume().catch(function () {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ac = new AC(); } catch (e) { return; }
    const comp = this.ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 6;
    this.master = this.ac.createGain(); this.master.gain.value = 0.85;
    this.master.connect(comp); comp.connect(this.ac.destination);
    this.musicGain = this.ac.createGain(); this.musicGain.gain.value = 0.0; this.musicGain.connect(this.master);
    const n = Math.floor(this.ac.sampleRate * 1.5), b = this.ac.createBuffer(1, n, this.ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = b;
    this.startAmbient();
  },
  // A context that was created before the first gesture stays suspended until
  // something resumes it; skipping every sound while suspended used to mean a
  // silently muted game, so nudge it awake and let the next call make noise.
  on() {
    if (!S.sound || !this.ac) return false;
    if (this.ac.state === 'suspended') { this.ac.resume().catch(function () {}); return false; }
    return this.ac.state === 'running';
  },
  t() { const c = this.ac.currentTime; return isFinite(c) ? Math.max(0, c) : 0; },
  panner(rel) {
    if (!this.ac.createStereoPanner) return null;
    const p = this.ac.createStereoPanner();
    p.pan.value = clamp(Math.sin(rel || 0), -0.9, 0.9);
    return p;
  },
  chain(node, pan) { if (pan) { node.connect(pan); pan.connect(this.master); } else node.connect(this.master); },
  burst(dur, f0, f1, q, gain, type, pan) {          // filtered noise
    if (!this.on()) return;
    const t = this.t(), s = this.ac.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = this.ac.createBiquadFilter(); bp.type = type || 'bandpass';
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    bp.Q.value = q;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0008, t); g.gain.linearRampToValueAtTime(Math.max(0.0009, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + Math.max(0.012, dur));
    s.connect(bp); bp.connect(g); this.chain(g, pan);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  },
  tone(type, f0, f1, dur, gain, pan, detune) {      // oscillator sweep
    if (!this.on()) return;
    const t = this.t(), o = this.ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (detune) o.detune.value = detune;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0008, t); g.gain.linearRampToValueAtTime(Math.max(0.0009, gain), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + Math.max(0.012, dur));
    o.connect(g); this.chain(g, pan); o.start(t); o.stop(t + dur + 0.02);
  },
  shot(kind) {
    if (!this.on()) return;
    if (kind === 'pistol') { this.burst(0.14, 2600, 320, 0.7, 0.5); this.tone('square', 420, 90, 0.09, 0.16); }
    else if (kind === 'shotgun') { this.burst(0.30, 1700, 150, 0.5, 0.75); this.tone('sawtooth', 200, 55, 0.22, 0.3); }
    else if (kind === 'rifle') { this.burst(0.085, 3200, 700, 0.9, 0.4); this.tone('square', 620, 180, 0.05, 0.1); }
    else { this.burst(0.05, 1400, 900, 3, 0.18); }   // dry click
  },
  reload(stage) {
    if (stage === 0) this.burst(0.06, 900, 500, 4, 0.22);
    else this.burst(0.05, 1500, 2200, 6, 0.2), this.tone('square', 900, 1300, 0.04, 0.07);
  },
  impact(pan) { this.burst(0.08, 3000, 800, 1.6, 0.22, 'bandpass', pan); },
  flesh(pan) { this.burst(0.13, 800, 180, 1.1, 0.42, 'lowpass', pan); this.tone('sawtooth', 160, 60, 0.1, 0.12, pan); },
  gib(pan) { this.burst(0.26, 600, 90, 0.9, 0.55, 'lowpass', pan); },
  explosion(pan) {
    this.burst(0.75, 900, 60, 0.5, 0.95, 'lowpass', pan);
    this.tone('sine', 120, 26, 0.6, 0.55, pan);
    this.tone('sawtooth', 70, 30, 0.35, 0.2, pan);
  },
  growl(kind, pan) {
    if (kind === 'hound') this.tone('sawtooth', 700, 220, 0.28, 0.14, pan, 18);
    else if (kind === 'brute') { this.tone('sawtooth', 150, 52, 0.55, 0.26, pan, 24); this.burst(0.4, 400, 120, 0.8, 0.2, 'lowpass', pan); }
    else { this.tone('sawtooth', 330, 120, 0.34, 0.18, pan, 12); this.burst(0.3, 700, 200, 1.2, 0.14, 'bandpass', pan); }
  },
  enemyShot(pan) { this.tone('triangle', 900, 260, 0.16, 0.16, pan); this.burst(0.1, 1800, 500, 1.5, 0.12, 'bandpass', pan); },
  pain() { this.tone('sawtooth', 260, 120, 0.22, 0.26); this.burst(0.18, 700, 200, 1, 0.25, 'lowpass'); },
  death() { this.tone('sawtooth', 180, 40, 1.1, 0.4); this.burst(1.0, 500, 80, 0.7, 0.4, 'lowpass'); },
  pickup(kind) {
    if (kind === 'armor') { this.tone('square', 500, 1200, 0.16, 0.16); this.tone('sine', 900, 1800, 0.12, 0.08); }
    else { this.tone('square', 660, 1320, 0.1, 0.14); this.tone('sine', 1320, 1980, 0.09, 0.07); }
  },
  portal() { this.tone('sine', 200, 1400, 0.7, 0.2); this.burst(0.6, 400, 3000, 0.7, 0.14); },
  step() { this.burst(0.05, 380, 170, 1.2, 0.09, 'lowpass'); },
  ui(f) { this.tone('square', f || 700, (f || 700) * 1.6, 0.05, 0.07); },
  fanfare(win) {
    const notes = win ? [523, 659, 784, 1046] : [392, 330, 262];
    if (!this.ac) return;
    notes.forEach((f, i) => setTimeout(() => { this.tone('square', f, f * 1.01, 0.34, 0.13); this.tone('sine', f / 2, f / 2, 0.4, 0.1); }, i * 130));
  },
  startAmbient() {
    const ac = this.ac;
    // low drone bed
    const mk = (f, g) => {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 190; lp.Q.value = 3;
      const gn = ac.createGain(); gn.gain.value = g;
      o.connect(lp); lp.connect(gn); gn.connect(this.musicGain); o.start();
      const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.05 + Math.random() * 0.08;
      const lg = ac.createGain(); lg.gain.value = g * 0.6;
      lfo.connect(lg); lg.connect(gn.gain); lfo.start();
    };
    mk(41, 0.30); mk(41.4, 0.18); mk(61.5, 0.10);
    const s = ac.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.7;
    const gn = ac.createGain(); gn.gain.value = 0.03;
    s.connect(bp); bp.connect(gn); gn.connect(this.musicGain); s.start();
    // slow tension pulse
    const tick = () => {
      if (this.ac && S.mode === 'play') {
        const i = P.hp < 35 ? 0.55 : 1.6;
        this.tone('sine', 55, 30, 0.22, P.hp < 35 ? 0.16 : 0.07);
        setTimeout(tick, i * 1000);
      } else setTimeout(tick, 1400);
    };
    setTimeout(tick, 1200);
  }
};

/* An exception thrown from inside an AudioNode call must never reach the game
 * loop - before this, one bad audio parameter killed the frame between
 * update() and renderWorld(), so the simulation kept running while the screen
 * froze on the last good frame. Any audio failure now disables sound and the
 * game carries on. */
for (const k of Object.keys(SND)) {
  const f = SND[k];
  if (typeof f !== 'function' || k === 'init') continue;
  SND[k] = function () {
    try { return f.apply(this, arguments); }
    catch (e) {
      // Sound is broken, not muted: S.sound stays the user's preference so pressing
      // T cannot announce AUDIO ON over a closed context.
      if (!S.audioBroken) { S.audioBroken = true; noteError(e, 'audio disabled'); }
      if (SND.ac) { try { SND.ac.close(); } catch (e2) {} SND.ac = null; }
      return undefined;
    }
  };
}

/* Every catch in this project used to be silent, and S.err was written but read by
 * nothing, so a swallowed exception left no trace in the console or on screen. One
 * helper now records and reports; the frame loop paints it and the console sees it. */
function noteError(e, where) {
  const msg = String((e && e.message) || e);
  const at = e && e.stack ? String(e.stack).split('\n')[1] : '';
  S.err = where + ': ' + msg + (at ? ' @ ' + at.trim() : '');
  if (typeof console !== 'undefined' && console.warn) console.warn('[' + where + ']', msg);
  return S.err;
}
