'use strict';
/*
 * tools/livecap.js - take a frame off a RUNNING page, and read the figure-ground step the frame
 * actually delivered (#611's third acceptance bullet: "verified on the deployed page, four sectors").
 *
 * Every other instrument in tools/ renders off a page: view.js boots the js/ files in a stub DOM and
 * hashes the buffer. That is the right instrument for geometry, lighting and budgets, and it is the
 * wrong one for the question "#611 is closed when a player can name what they are looking at" - the
 * deployed page is the picture, and a probe that re-implements the page can only ever agree with
 * itself. This tool drives the real page over CDP (Chrome DevTools Protocol, plain WebSocket, no
 * dependencies) and then measures the pair of bars the issue asks for off the delivered pixels.
 *
 *   node tools/livecap.js cap  --url <page> [--seed 60] [--level 0] [--out DIR] [--name shot]
 *   node tools/livecap.js fg   <with.png> <without.png>          # value + hue step at the kept px
 *   node tools/livecap.js both --url <page> [--out DIR]          # cap both arms, print one fg row
 *
 * The page must be a ?dev=1 build: js/90_dev.js is inert without the flag, and everything below goes
 * through DEV (DEV.boot/freeze/tick/cam/spawn/state/lum), so this tool never reaches into the game's
 * internals and never changes what it measures. No --virtual-time-budget: the game loop never goes
 * idle, so that flag hangs; this tool drives the loop itself with DEV.tick and returns when the shutter
 * is taken, with a wall-clock deadline.
 *
 * What "fg" measures is #611's own pair, from the other side of the glass: the pixels that differ
 * between a frame with one body in it and the SAME frame with that body removed (same seed, same deal,
 * same pinned clock, grain off) are that body's delivered silhouette plus the contact patch that
 * reaches outside his feet. Their mean colour against the colour that was behind them is the step the
 * eye gets - a value step (luma) and a chroma step (saturation and hue angle), which is the pair the
 * issue's Done-when asks for. It is a read of the picture, not a gate: nothing here exits non-zero on
 * a colour, and it deliberately re-samples the shipped build rather than a model of it.
 *
 * One thing DOES exit non-zero, and it is not a colour: a row whose kept-pixel mask is under
 * MIN_KEEP_FRAC of the frame is VACUOUS - the steps in it are arithmetic on dither rather than on a
 * body (see the KEEP note below). Vacuity is a failure, not a debt; a weak colour is a result.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || '/usr/local/bin/sandmox-chromium';
const LR = 0.2126, LG = 0.7152, LB = 0.0722;      // Rec.709, the same rule DEV.lum uses

/* KEEP - the smallest kept-pixel mask that can be a body, and the only thing that makes this tool
 * exit non-zero. Grounds, both measured off the deployed 1440x620 build (#683 review, 2026-10-31):
 * a body ~10 m out keeps 4268 px (grunt, RING TRANSPORT), 6323 px (grunt, THE STACK) or 7376 px
 * (brute, ABATOIR CORE) - 0.5% to 0.8% of the frame. A seat whose body an offset has parked BEHIND
 * geometry keeps 22 px inside the centre box and 367 px frame wide: grade dither and bloom spread,
 * 0.0025% of the frame, two orders of magnitude under the weakest real body. The floor goes in that
 * gap at 0.15% of the delivered pixels - 1339 px at 1440x620, an order under the weakest legitimate
 * row and sixty times over the noise. Keyed on frame area, not a raw count, so a --res or a window
 * change moves the floor with the pixels it measures. A row under it is VACUOUS; a row over it is a
 * result whatever it says about the paint. */
const MIN_KEEP_FRAC = 0.0015;

/* ---------------------------------------------------------------- tiny helpers */

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.indexOf('--' + name) > 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function get(url, timeoutMs) {
  return new Promise((res, rej) => {
    const req = http.get(url, r => {
      let b = ''; r.setEncoding('utf8');
      r.on('data', c => { b += c; }); r.on('end', () => res(b));
    });
    req.setTimeout(timeoutMs || 5000, () => req.destroy(new Error('timeout ' + url)));
    req.on('error', rej);
  });
}

function portOpen(port, tries) {
  return new Promise(res => {
    let n = tries || 1;
    const sock = net.connect(port, '127.0.0.1');
    sock.on('connect', () => { sock.destroy(); res(true); });
    sock.on('error', () => { sock.destroy(); res(false); });
    sock.setTimeout(1500, () => { sock.destroy(); res(false); });
    void n;
  });
}

/* ---------------------------------------------------------------- the CDP client */

async function openPage(url, profileDir, deadline) {
  const port = +(process.env.CDP_PORT || 9377);
  let up = await portOpen(port);
  let chrome = null;
  if (!up) {
    chrome = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=' + (process.env.CAP_WIN || '1440,763'),
      '--user-data-dir=' + profileDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.on('error', e => console.log('NOTE chrome spawn: ' + e.message));
    while (Date.now() < deadline && !(await portOpen(port))) await sleep(400);
    up = await portOpen(port);
  }
  if (!up) throw new Error('no CDP endpoint on 127.0.0.1:' + port + ' - set CHROME=<path to a chromium build>');

  const list = JSON.parse(await get('http://127.0.0.1:' + port + '/json/list', 8000));
  const page = list.find(t => t.type === 'page') || list[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('CDP target list has no page: ' + JSON.stringify(list).slice(0, 200));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket open failed')); });

  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      pageErrors.push(((d.exception || {}).description || d.text || 'exception').split('\n')[0]);
    }
  };
  const send = (method, params) => new Promise(res => {
    const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  async function evaluate(expr) {
    const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result && m.result.exceptionDetails) {
      const d = m.result.exceptionDetails;
      throw new Error('page threw: ' + (((d.exception || {}).description || d.text || '').split('\n')[0]));
    }
    return m.result && m.result.result ? m.result.result.value : undefined;
  }
  await send('Runtime.enable'); await send('Page.enable');
  return {
    evaluate, pageErrors,
    async goto(u) {
      await send('Page.navigate', { url: u });
      for (let i = 0; i < 60 && Date.now() < deadline; i++) {
        if ((await evaluate('document.readyState')) === 'complete') break;
        await sleep(300);
      }
      await sleep(1200);                            // the boot-time bake runs on the first frames
    },
    close() { try { ws.close(); } catch (e) { void e; } if (chrome) chrome.kill('SIGKILL'); }
  };
}

/* ---------------------------------------------------------------- the DEV route */

/* One page load is one deal (js/90_dev.js refuses a second DEV.boot() on the same load), so every
   shot opens the url again. The pose is the same one docs/screens/provenance.json records: boot,
   freeze the clock so two arms of the same frame agree, tick so the world settles, then the camera.
   `body` places one enemy ~dist metres down the view line and slides him sideways off any prop that
   would stand between the camera and him - a body hidden behind a crate measures zero and reads as
   nothing, which is a different bug (#611 is about the paint, not the occlusion). */
function devRoute(o) {
  const pose = o.cam ? 'DEV.cam(' + o.cam + ');' : '';
  return `(function(){
  var out={};
  DEV.boot(); DEV.freeze(true); DEV.tick(30);
  startLevel(${o.level | 0}, true); DEV.tick(2);
  DEV.set('grain',0);
  ${pose}
  DEV.clear();
  ${o.body ? `DEV.spawn('${o.body.kind}',1,${+o.body.dist || 10});
  /* A seat is usable when the cell he stands in is air AND the LINE from the camera to him is air.
     Testing only the candidate cell accepts a seat behind a wall or a shelving run: the arm then draws
     no enemy, the two arms differ by grade dither alone, and fg reports that dither as a figure-ground
     step (deployed build, an ARCHIVE seat at 22 kept px, #683 review). So the line is marched by the
     shipped sight rule - js/20_level.js blocked(), a 0.14 m march on isSolid - and a candidate with
     geometry on it is rejected and recorded instead of becoming the seat.

     WHY THE SEARCH TURNS THE BEARING INSTEAD OF SLIDING HIM SIDEWAYS. The first version tried
     off = [0, +-0.9, +-1.8, +-2.7] metres along the perpendicular through the seat he was dealt. Two
     failures, both measured on the deployed build at seed 60: at ARCHIVE SUBLEVEL all seven had a
     prop on the line, so the row printed NO CLEAR SEAT and the sector had no quotable seat at all;
     and a fixed metre slide is a bigger ANGLE the deeper the seat is (2.7 m at 22 m is 7 degrees), so
     the arm that did place was measuring a body seen from a bearing the deal never shows. Turning the
     bearing keeps the realised range equal to the --dist the row is written at, which is the whole
     point of an "8-16 m" acceptance bar, and it samples the arc the camera can actually see instead of
     one line across it. Least-turned first, so a seat that needs no turn is never turned. */
  var e=ENEMIES[0],pick=null,tried=[],
      KB=[0,0.06,-0.06,0.12,-0.12,0.18,-0.18,0.24,-0.24,0.30,-0.30,0.40,-0.40],
      RF=[1,0.94,1.06],D=${+o.body.dist || 10};
  for(var i=0;i<KB.length && !pick;i++)for(var q=0;q<RF.length;q++){
    var a=P.ang+KB[i], cx=P.x+Math.cos(a)*D*RF[q], cy=P.y+Math.sin(a)*D*RF[q], why='ok';
    var d0=Math.hypot(cx-P.x,cy-P.y);
    if(isSolid(cx,cy))why='solid cell';
    else if(blocked(P.x,P.y,cx,cy))why='geometry on the line';
    else{for(var j=0;j<PROPS.length;j++){var p=PROPS[j];
      var t=((p.x-P.x)*(cx-P.x)+(p.y-P.y)*(cy-P.y))/(d0*d0);t=Math.max(0,Math.min(1,t));
      if(Math.hypot(p.x-(P.x+(cx-P.x)*t),p.y-(P.y+(cy-P.y)*t))<0.85){why='prop on the line';break;}}}
    tried.push({off:+(KB[i]*D*RF[q]).toFixed(2),why:why});
    if(why==='ok'){pick={x:+cx.toFixed(2),y:+cy.toFixed(2),off:+(KB[i]*D*RF[q]).toFixed(2),
      d:+d0.toFixed(2)};break;}
  }
  if(!pick){ENEMIES.length=0;out.body=null;out.noSeat=tried;}  // no seat to measure: say so, do not place him anyway
  else{e.x=pick.x;e.y=pick.y;e.ang=Math.atan2(P.y-e.y,P.x-e.x);out.body=pick;out.kind=e.kind;out.tried=tried;}` : 'out.body=null;'}
  DEV.tick(1);
  try{resume();}catch(err){out.resumeErr=String(err);}
  DEV.tick(1);
  var st=DEV.state();
  out.mode=st.mode;out.level=st.level;out.name=st.levelName;out.layout=st.layout;
  out.live=st.enemies.length;out.p=st.p;out.lum=DEV.lum({stride:97});
  out.canvas=cv.width+'x'+cv.height;
  out.png=cv.toDataURL('image/png').split(',')[1];
  /* THE CLEAR ARM COMES FROM THIS SAME LOAD (#611). The two arms used to be two page loads of one url
     - same seed, clock frozen, grain off. They are NOT the same frame: two loads of ARCHIVE SUBLEVEL
     with no body in either one differ by 3814 kept px (Rec.709 summed |dRGB| > 18), boxed at
     x 911-1123, y 408-533. That box is the first-person rig, and its pose is the one thing two loads
     of a running loop never agree on. THE STACK's fg row then read +3.12 luma over 3916 kept px - a
     mask the size of the noise, in the region of the gun, on a sector whose body sits centre-frame.
     So the paid-vs-delivered gap #611 still carries was, at those seats, a measurement of the harness.
     One tick after the body is removed the camera, the deal, the bake and the rig are identical by
     construction, so what is left in the mask is the body and the contact patch that reaches outside
     his feet. The third frame (same load, nothing changed since the clear arm) is the identity arm:
     it measures what one load refuses to agree on with ITSELF, and the fg row prints it, so a mask
     that is noise says so in its own line instead of looking like a weak colour. */
  ${o.pair ? `out.b=[out.png];for(var u=0;u<${ARMS}-1;u++){DEV.tick(1);out.b.push(cv.toDataURL('image/png').split(',')[1]);}
  ENEMIES.length=0;out.c=[];for(var u2=0;u2<${ARMS};u2++){DEV.tick(1);out.c.push(cv.toDataURL('image/png').split(',')[1]);}
  out.png=null;` : ''}
  return out;})()`;
}

/* ---------------------------------------------------------------- PNG read/write */

function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504E47) throw new Error(file + ' is not a PNG');
  let o = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.slice(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1, br = w * ch;
  const rgb = Buffer.alloc(w * h * 3);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++], line = raw.slice(p, p + br); p += br;
    const prev = y > 0 ? raw.slice(p - br, p) : null;
    for (let x = 0; x < br; x++) {
      let v = line[x];
      const left = x >= ch ? line[x - ch] : 0, up = prev ? prev[x] : 0, ul = (x >= ch && prev) ? prev[x - ch] : 0;
      if (ft === 1) v = (v + left) & 255;
      else if (ft === 2) v = (v + up) & 255;
      else if (ft === 3) v = (v + ((left + up) >> 1)) & 255;
      else if (ft === 4) {
        const pp = left + up - ul, pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - ul);
        v = (v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)) & 255;
      }
      line[x] = v;
    }
    for (let x = 0; x < w; x++) {
      rgb[(y * w + x) * 3] = line[x * ch];
      rgb[(y * w + x) * 3 + 1] = line[ch >= 3 ? x * ch + 1 : 0];
      rgb[(y * w + x) * 3 + 2] = line[ch >= 3 ? x * ch + 2 : 0];
    }
  }
  return { w, h, d: rgb };
}

function writePNG(file, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const tb = Buffer.from(t), buf = Buffer.concat([tb, d]);
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) { crc ^= buf[i]; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & (crc & 1) ? 0xEDB88320 : 0); }
    const cb = Buffer.alloc(4); cb.writeUInt32BE((~crc) >>> 0);
    return Buffer.concat([len, tb, d, cb]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------------------------------------------------------------- the fg read */

/* Per-pixel mean of k frames of ONE arm. A frame of this page is not a fixed picture even with the
 * clock frozen and grain off: two frames of the SAME load, nothing changed between them, differ by
 * 7286 kept px on ARCHIVE (summed |dRGB| > 18) - the rig's pose, the lamp flicker, the dither. At a
 * 10 m seat the whole body mask is 8-12k px, so a one-frame difference is a third signal and two
 * thirds weather, and it dilutes the mean toward the background's own colour - which is the whole of
 * the "the paint pays 9 and the frame delivers 3" row #611 still carries. Averaging is unbiased where
 * an SNR gate would not be: a body pixel that matches the background still contributes a zero step
 * here, because that is what the player is being asked to see. */
function avgPNG(files) {
  const f0 = decodePNG(files[0]);
  const acc = Buffer.from(f0.d);
  for (let i = 1; i < files.length; i++) {
    const f = decodePNG(files[i]);
    if (f.w !== f0.w || f.h !== f0.h) throw new Error('arm frames differ in size: ' + files[0] + ' vs ' + files[i]);
    for (let k = 0; k < acc.length; k++) acc[k] += f.d[k];
  }
  for (let k = 0; k < acc.length; k++) acc[k] = Math.round(acc[k] / files.length);
  return { w: f0.w, h: f0.h, d: acc };
}

/* The frame centre only: the four HUD corners carry a kill counter and a minimap dot that differ
   between the two arms for reasons that have nothing to do with paint. */
function fg(withBody, without) {
  const A = Array.isArray(without) ? avgPNG(without) : decodePNG(without);
  const B = Array.isArray(withBody) ? avgPNG(withBody) : decodePNG(withBody);
  if (A.w !== B.w || A.h !== B.h) throw new Error('the two arms are different sizes: ' + A.w + 'x' + A.h + ' vs ' + B.w + 'x' + B.h);
  const x0 = (A.w * 0.22) | 0, x1 = (A.w * 0.78) | 0, y0 = (A.h * 0.10) | 0, y1 = (A.h * 0.86) | 0;
  let n = 0, bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
  const mB = [0, 0, 0], mA = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * A.w + x) * 3;
    const dr = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
    if (dr <= 18) continue;
    n++;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    for (let c = 0; c < 3; c++) { mB[c] += B.d[i + c]; mA[c] += A.d[i + c]; }
  }
  const minKeep = Math.max(1, Math.round(A.w * A.h * MIN_KEEP_FRAC));
  const res = { n, minKeep, vacuous: n < minKeep };
  if (!n) return Object.assign(res, { note: 'no pixel differs - the body contributed nothing the frame delivered' });
  for (let c = 0; c < 3; c++) { mB[c] /= n; mA[c] /= n; }
  const luma = m => LR * m[0] + LG * m[1] + LB * m[2];
  const sat = m => { const s = m.slice().sort((a, b) => a - b); return s[2] ? (1 - s[0] / s[2]) * 100 : 0; };
  const hue = m => {
    const r = m[0] / 255, g = m[1] / 255, b = m[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return NaN;
    return 60 * (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  };
  return Object.assign(res, {
    box: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1],
    body: mB.map(v => +v.toFixed(1)), bg: mA.map(v => +v.toFixed(1)),
    lumaBody: +luma(mB).toFixed(2), lumaBg: +luma(mA).toFixed(2), valueStep: +(luma(mB) - luma(mA)).toFixed(2),
    satBody: +sat(mB).toFixed(1), satBg: +sat(mA).toFixed(1), chromaStep: +(sat(mB) - sat(mA)).toFixed(1),
    hueBody: +hue(mB).toFixed(1), hueBg: +hue(mA).toFixed(1), hueStep: +(hue(mB) - hue(mA)).toFixed(1)
  });
}

/* The one verdict this tool prints: VACUOUS when the mask is too small to be a body at all. It is a
 * failure, not a caveat - the value and chroma steps in such a row are arithmetic on dither. */
function fgLine(tag, r, idn, k) {
  return 'FG ' + tag + ' ' + JSON.stringify(r) +
    (idn !== null && idn !== undefined ? '\n   IDENTITY ' + idn + ' kept px between two frames of ONE '
      + 'arm, one tick apart (' + (k || 1) + '-frame means). That is the floor this row has to clear.' : '') +
    (r.vacuous ? '\n   VACUOUS: ' + r.n + ' kept px, under the ' + r.minKeep + ' px floor (' +
      (MIN_KEEP_FRAC * 100).toFixed(2) + '% of the frame). That mask is not a body, so the steps in the '
      + 'row above are noise. Look at the arms; a seat with geometry on the camera-to-body line reads '
      + 'this way.' : '') +
    (r.noisy ? '\n   VACUOUS BY ITS OWN CONTROL: ' + r.n + ' kept px against an identity floor of ' +
      idn + ' in the same load. The mask is no larger than what this frame refuses to agree on with '
      + 'itself, so the steps above are not a body either. Vacuity is a FAILURE, not a debt.' : '');
}

/* ---------------------------------------------------------------- the live frame cost (#529) */

/* One page load, one level, four arms of the SAME seat, all timed in the same page:
     dealt   the heading this build's seatFacing handed the player when the level loaded
     pinned  the literal 0.6 rad every seat used before arrival bearings were derived (#421),
             which is the heading tools/view.js's `seat price` row times its ratio against
     up      the dealt heading with the eye tilted at the storey the level built overhead
     circle  the same seat through 8 yaw samples, so a swing that is really "any heading costs
             about the same" cannot hide behind the two named ones
 * The clock is frozen (DEV.freeze) so every arm renders the same world: what varies between the
 * arms is what the eye contains, which is exactly the quantity #529 argues about. The frame is
 * timed with the page's own performance.now() around DEV.tick, so it includes everything the
 * running game puts in a frame - the first-person rig included - which is the difference between
 * this read and the harness's: view.js times renderWorld() batches into a node-side stub buffer,
 * this times the frame a player actually gets. Both numbers are wanted, and they are allowed to
 * disagree; when they do, the ratio that reaches the player is this one.
 *
 * WHY THE ARMS RUN IN INTERLEAVED ROUNDS AND ARE TAKEN BY MEDIAN. The first version timed one arm
 * after another in a fixed order. On the two sectors whose dealt heading IS the pinned literal
 * (RING TRANSPORT and ABATOIR CORE, both 0.600 rad here) the SAME pose timed 41.84 ms in one arm and
 * 54.43 ms in the other - a 1.30x swing made by nothing but the order the arms ran in, on a shared
 * runner. A ratio taken off a drifting timer is not a measurement, so every arm is sampled once per
 * round, the round rotates which arm goes first, and each arm's number is the median of its rounds.
 * The sectors where the dealt heading equals the pinned one are then a free instrument: one pose
 * timed twice, so their ratio has to land on 1.00, and one that does not says the timer is drifting.
 * That is printed as IDENTITY SPREAD on the row and fails the read - a ratio that cannot tell an
 * identical frame from itself cannot price a turned one. */
function costRoute(o) {
  const N = +o.frames || 4, R = +o.rounds || 5, M = +o.yawFrames || 3;
  return `(function(){
  var out={arms:{}};
  DEV.boot(); DEV.freeze(true); DEV.tick(30);
  startLevel(${o.level | 0}, true); DEV.tick(2);
  DEV.set('grain',0);
  DEV.clear();
  DEV.tick(1);
  try{resume();}catch(e){out.resumeErr=String(e);}
  DEV.tick(1);
  var st=DEV.state();
  out.name=st.levelName; out.layout=st.layout; out.mode=st.mode; out.p=st.p;
  var x=st.p.x, y=st.p.y, z=st.p.z, dealt=st.p.ang, acc={};
  function sample(tag,ang,pitch,n){
    DEV.cam(x,y,z,ang,pitch);
    DEV.tick(2);                                  // settle: the first frame of a new view pays the caches
    var t0=performance.now();
    for(var i=0;i<n;i++) DEV.tick(1);
    (acc[tag]=acc[tag]||[]).push((performance.now()-t0)/n);
  }
  var UP=BH*${YAWUP}, arms=[['dealt',dealt,0],['pinned',${PINHEAD},0],['up',dealt,UP]];
  for(var r=0;r<${R};r++){
    for(var k=0;k<3;k++){var a=arms[(k+r)%3]; sample(a[0],a[1],a[2],${N});}
  }
  for(var q=0;q<${R};q++) for(var k2=0;k2<8;k2++) sample('c'+k2,dealt+k2*Math.PI/4,0,${M});
  for(var t in acc) out.arms[t]=acc[t];
  out.buf=[BW,BH]; out.tier=DEV.stats().tier; out.gfx=st.gfx;
  return out;})()`;
}

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1]
  : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };
const med = a => +median(a).toFixed(2);
const ID_TOL = 0.10;                              // how far one pose may time from itself, in x

async function cost(o) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'livecost-'));
  const deadline = Date.now() + (+o.timeout || 240) * 1000;
  const page = await openPage(o.url, profile, deadline);
  const rows = [];
  try {
    for (const lvl of o.levels) {
      if (Date.now() > deadline - 12000) { rows.push({ level: lvl, error: 'deadline' }); break; }
      await page.goto(o.url);
      if (!rows.length && !(await page.evaluate('!!(window.DEV && DEV.on)')))
        throw new Error(o.url + ' is not a ?dev=1 page (js/90_dev.js stayed inert)');
      const v = await page.evaluate(costRoute({ level: lvl, frames: o.frames, rounds: o.rounds,
        yawFrames: o.yawFrames }));
      rows.push(Object.assign({ level: lvl }, v));
    }
  } finally {
    page.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  let swung = 0, ident = 0, drift = 0;
  for (const r of rows) {
    if (r.error) { console.log('COST L' + r.level + ' ERROR ' + r.error); continue; }
    const a = r.arms, dealt = r.p.ang;
    const dms = med(a.dealt), pms = med(a.pinned), ums = med(a.up);
    const circle = []; for (let k = 0; k < 8; k++) circle.push(med(a['c' + k]));
    const differs = Math.abs(Math.atan2(Math.sin(dealt - PINHEAD), Math.cos(dealt - PINHEAD))) > 1e-6;
    const ratio = dms / Math.max(1e-6, pms);
    const upR = ums / Math.max(1e-6, dms);
    const lo = Math.min.apply(null, circle), hi = Math.max.apply(null, circle);
    if (differs) { if (ratio >= LIVE_SWING) swung++; }
    else { ident++; if (!(Math.abs(ratio - 1) <= ID_TOL)) drift++; }
    console.log('COST L' + r.level + ' ' + r.name + ' seat ' + r.p.x.toFixed(2) + ',' + r.p.y.toFixed(2) +
      ' dealt ' + dealt.toFixed(3) + ' rad (' + (differs ? 'a turned seat' : 'the pinned heading itself') +
      ')  dealt ' + dms + '  pinned ' + pms + '  up ' + ums + ' ms/frame | dealt/pinned ' + ratio.toFixed(2) +
      'x, turned up ' + upR.toFixed(2) + 'x, yaw circle ' + lo.toFixed(2) + '-' + hi.toFixed(2) + 'x  [' +
      r.tier + '/' + r.gfx + ' ' + r.buf.join('x') + ', layout ' + r.layout + ', ' + a.dealt.length + ' round(s)' +
      (differs ? '' : ', IDENTITY SPREAD ' + ratio.toFixed(2) + 'x' + (Math.abs(ratio - 1) <= ID_TOL ? '' : ' DRIFT')) + ']');
  }
  if (page.pageErrors.length) console.log('NOTE page exceptions: ' + page.pageErrors.slice(0, 3).join(' | '));
  if (!ident) {
    console.log('LIVECOST no sector sat at the pinned heading, so nothing here checked the timer against ' +
      'itself - no ratio below means anything. FAILURE, not a clean bill.');
    process.exitCode = 1;
    return rows;
  }
  if (drift) {
    console.log('LIVECOST ' + drift + ' of ' + ident + ' sector(s) timed ONE POSE ' + ID_TOL.toFixed(2) +
      'x apart across its two arms - the timer is drifting, so the dealt/pinned ratios above are not ' +
      'measurements. Raise --rounds or --frames. Vacuity is a FAILURE: a ratio that cannot tell an ' +
      'identical frame from itself cannot price a turned one.');
    process.exitCode = 1;
    return rows;
  }
  console.log('LIVECOST ' + ident + ' sector(s) timed one pose to within ' + ID_TOL.toFixed(2) +
    'x, so the timer is steady; dealt/pinned reads ' +
    rows.filter(r => !r.error).map(r => (med(r.arms.dealt) / med(r.arms.pinned)).toFixed(2) + 'x').join(' ') +
    ' in the RUNNING game, ' + swung + ' of them at or over the ' + LIVE_SWING.toFixed(2) +
    'x that would put a player-visible swing behind the harness ratio (tools/view.js `seat price`). ' +
    (swung ? 'The swing reaches the frame.' : 'The swing does not reach the frame: the harness prices a ' +
      'buffer, the player gets this.'));
  return rows;
}

/* ---------------------------------------------------------------- commands */

let armsNote = false;      // the same-load arms note is printed once per run, not once per sector
const ARMS = +arg('arms', 4);   // frames averaged per arm; 1 reproduces the single-frame read

function armFiles(dir, base) {
  const out = [];
  for (let i = 0; i < ARMS; i++) {
    const f = path.join(dir, base + '-' + i + '.png');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

async function cap(o) {
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'livecap-'));
  const deadline = Date.now() + (+o.timeout || 120) * 1000;
  const page = await openPage(o.url, profile, deadline);
  const rows = [];
  try {
    for (const shot of o.shots) {
      if (Date.now() > deadline - 8000) { rows.push({ name: shot.name, error: 'deadline' }); break; }
      await page.goto(o.url);
      if (shot.name === o.shots[0].name && !(await page.evaluate('!!(window.DEV && DEV.on)')))
        throw new Error(o.url + ' is not a ?dev=1 page (js/90_dev.js stayed inert)');
      const v = await page.evaluate(devRoute(shot));
      if (!v || (!v.png && !v.b)) { rows.push(Object.assign({ name: shot.name }, v, { error: 'no png came back' })); continue; }
      const file = v.b ? path.join(out, shot.name + '-0.png') : path.join(out, shot.name + '.png');
      if (v.png) fs.writeFileSync(file, Buffer.from(v.png, 'base64'));   // the pair path puts it in b[0]
      delete v.png;
      if (v.b) {                                      // the same-load arms (#611): K frames, not one
        if (!armsNote) {
          armsNote = true;
          console.log('NOTE arms: ' + v.b.length + ' body frames and ' + v.c.length + ' clear frames, all '
            + 'in ONE page load, averaged per pixel before the mask. One frame of this page differs from '
            + 'the next by ~7.3k px at a frozen clock - the rig, dither and lamp flicker - which is the '
            + 'same order as a body mask at 10 m, so single frames cannot carry the row.');
        }
        v.b.forEach((p, i) => fs.writeFileSync(path.join(out, shot.name + '-' + i + '.png'), Buffer.from(p, 'base64')));
        v.c.forEach((p, i) => fs.writeFileSync(path.join(out, shot.clear + '-' + i + '.png'), Buffer.from(p, 'base64')));
        delete v.b; delete v.c;
      }
      rows.push(Object.assign({ name: shot.name, file }, v));
    }
  } finally {
    page.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  for (const r of rows) {
    console.log('CAP ' + r.name + (r.file ? ' ' + path.relative(process.cwd(), r.file) : ' ERROR ' + r.error) +
      (r.layout !== undefined ? '  layout ' + r.layout + ' mode ' + r.mode + ' canvas ' + r.canvas +
        ' lum ' + (r.lum ? r.lum.mean + '/' + r.lum.mid : '?') +
        (r.body ? ' body ' + r.kind + ' @ ' + r.body.d + ' m off ' + r.body.off + ' m' +
          (o.why && r.tried ? ' [tried ' + r.tried.map(t => t.off + ':' + t.why).join(' ') + ']' : '') :
          r.noSeat ? ' NO CLEAR SEAT - no bearing x range candidate has a clear camera-to-body line [' +
            r.noSeat.map(t => t.off + ':' + t.why).join(' ') + '] - body NOT placed' : '') : ''));
  }
  if (page.pageErrors.length) console.log('NOTE page exceptions: ' + page.pageErrors.slice(0, 3).join(' | '));
  return rows;
}

/* The swing that would make the harness ratio a player fact rather than a harness fact. Set from the
 * rework brief on #529, not from a wish: at or over 1.4x the frame a player gets at the dealt heading
 * is measurably worse than the heading the seats used to use, and a change that flattens it is worth
 * making. Under it, the ~2x the harness reports lives in the harness. */
const LIVE_SWING = +(process.env.LIVE_SWING || 1.40);
const PINHEAD = 0.6;                        // the pre-#421 literal, and view.js's VMHEAD
const YAWUP = 0.25;                         // P.pitch as a fraction of BH: the eye on the slab overhead

async function main() {
  const cmd = process.argv[2];
  const url = arg('url', 'https://lioreshai.github.io/breach-protocol-flash-next/?dev=1&seed=' + arg('seed', '60') + '&boot=0');
  const out = arg('out', 'livecap');

  if (cmd === 'cap' || cmd === 'both') {
    const levels = (arg('levels', arg('level', '0,1,2,3')) + '').split(',').map(Number);
    const shots = [];
    for (const l of levels) {
      if (cmd === 'both' || flag('body')) {
        if (cmd === 'both') {
          /* ONE load per sector, three arms, in the order that makes the mask the body: the body
             frame, then him removed, then the same frame again as the identity control. */
          shots.push({ name: 'l' + l + '-body', clear: 'l' + l + '-clear', level: l, pair: true,
            body: { kind: arg('kind', l === 2 ? 'brute' : 'grunt'), dist: +arg('dist', 10) } });
        } else {
          shots.push({ name: 'l' + l + '-clear', level: l });
          shots.push({ name: 'l' + l + '-body', level: l, body: { kind: arg('kind', l === 2 ? 'brute' : 'grunt'), dist: +arg('dist', 10) } });
        }
      } else {
        shots.push({ name: 'l' + l + '-arrival', level: l });
      }
    }
    const rows = await cap({ url, out, shots, timeout: arg('timeout', 180), why: flag('why') });
    if (cmd === 'both') {
      let vacuous = 0;
      for (const l of levels) {
        const A = armFiles(out, 'l' + l + '-body'), B = armFiles(out, 'l' + l + '-clear');
        if (!A.length || !B.length) continue;          // the pair path writes l*-body-<i>.png, no single frame
        const r = fg(A, B);
        // the floor: two frames of ONE arm, nothing between them but a tick
        const idn = B.length > 1 ? fg([B[0]], [B[1]]).n : null;   // one arm, two frames: the floor
        if (idn !== null && r.n <= idn) r.noisy = true;       // a mask no bigger than the noise is noise
        if (r.vacuous || r.noisy) vacuous++;
        console.log(fgLine('L' + l, r, idn, A.length));
      }
      if (vacuous) {
        console.log('LIVECAP ' + vacuous + ' of ' + levels.length + ' FG row(s) VACUOUS - the floor note above each such row says why');
        process.exitCode = 1;
      }
    }
    return;
  }

  if (cmd === 'cost') {
    const levels = (arg('levels', '0,1,2,3') + '').split(',').map(Number);
    await cost({ url, levels, frames: arg('frames', 24), yawFrames: arg('yawFrames', 8),
      timeout: arg('timeout', 240) });
    return;
  }

  if (cmd === 'fg') {
    const files = process.argv.slice(3).filter(a => a[0] !== '-');
    if (files.length !== 2) { console.log('usage: node tools/livecap.js fg <with-body.png> <without.png>'); process.exit(2); }
    const r = fg(files[0], files[1]);
    console.log(fgLine('', r));
    if (r.vacuous) process.exitCode = 1;
    return;
  }

  console.log([
    'usage:',
    '  node tools/livecap.js cap  --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR]',
    '  node tools/livecap.js both --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR] [--why]',
    '  node tools/livecap.js fg   <with-body.png> <without.png>',
    '  node tools/livecap.js cost [--url <dev page>] [--levels 0,1,2,3] [--frames 24] [--yawFrames 8]',
    '',
    'cost = the running game\'s own frame, timed at one seat four ways: the heading the deal authored,',
    'the pinned literal 0.6 rad, the same heading turned up at the storey, and a yaw circle. The',
    'running-game A/B that tools/view.js\'s `seat price` row has to agree with (#529): the harness',
    'times renderWorld batches in node, this times the frame a player gets. A sector whose dealt',
    'heading IS the pinned one prices nothing; if no sector does, the row says so and exits non-zero.',
    '',
    'both = one page load per arm, same seed, clock frozen, grain off, one body ~dist m down the',
    'view line; then the fg row: the value (luma) and chroma (saturation / hue) step at the pixels',
    'the frame delivered for that body. cap alone leaves the frames on disk to look at.',
    'A seat is used only when neither a wall nor a prop is on the camera-to-body line (the shipped',
    'sight rule, js/20_level.js blocked); if no offset clears, the CAP row says NO CLEAR SEAT and no',
    'body is placed. An fg row whose mask is under ' + (MIN_KEEP_FRAC * 100).toFixed(2) + '% of the frame prints VACUOUS',
    'and exits non-zero - that mask is dither, not a body. A weak colour step over the floor is a',
    'result and exits 0.',
    'CHROME=<path> overrides the chromium binary; the page must be reachable (a deployed Pages',
    'build or any http(s) url serving this repo with ?dev=1).'
  ].join('\n'));
}

main().catch(e => { console.log('LIVECAP-FAIL ' + (e && e.message || e)); process.exit(1); });
