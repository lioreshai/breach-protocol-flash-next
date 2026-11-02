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

/* MIN_COV_FRAC - the same vacuity question asked of the RENDERER's mask instead of of a frame
 * difference: did a body's draw take any pixels at all? Keyed on the raster area the mask lives in,
 * so a --res or a tier change moves the floor with the pixels it counts. MEASURED on the deployed
 * build at seed 60 with COV armed (676x291 raster, brute at the ABATOIR 10 m seat): 445 px stamped.
 * A seat whose line is blocked stamps none, because the mask is last-writer-wins and geometry nearer
 * than him erases him instead of leaving a rim. The floor sits an order under the weakest body. */
const MIN_COV_FRAC = +(process.env.COVFRAC || 0.0006);

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
  var e=ENEMIES[0],pick=null,tried=[],vis=0,
      KB=[0,0.06,-0.06,0.12,-0.12,0.18,-0.18,0.24,-0.24,0.30,-0.30,0.40,-0.40],
      RF=[1,0.94,1.06],D=${+o.body.dist || 10},
      VIS=Math.max(8,Math.round(BW*BH*${MIN_COV_FRAC}));
  /* AND THE CELL/LINE TEST IS NOT ENOUGH, SO THIS ASKS THE RENDERER. blocked() is an XY march: it
     cannot see a lip, a slab edge or a mezzanine deck between the eye and a body standing on the band
     under it, and THE STACK is exactly that level. The first version placed a grunt at a clean-looking
     THE STACK seat and the coverage mask came back with 20 px of him - a hand and a shoulder over a
     slab edge, at a seat the search had just certified as clear. So a candidate is only a seat when
     his own draw actually takes VIS raster pixels, which is the same floor the fg row gates on below.
     One extra rendered frame per candidate is the whole cost, and it buys a mask that cannot disagree
     with the frame it is measuring. */
  for(var i=0;i<KB.length && !pick;i++)for(var q=0;q<RF.length;q++){
    var a=P.ang+KB[i], cx=P.x+Math.cos(a)*D*RF[q], cy=P.y+Math.sin(a)*D*RF[q], why='ok';
    var d0=Math.hypot(cx-P.x,cy-P.y);
    if(isSolid(cx,cy))why='solid cell';
    else if(blocked(P.x,P.y,cx,cy))why='geometry on the line';
    else{for(var j=0;j<PROPS.length;j++){var p=PROPS[j];
      var t=((p.x-P.x)*(cx-P.x)+(p.y-P.y)*(cy-P.y))/(d0*d0);t=Math.max(0,Math.min(1,t));
      if(Math.hypot(p.x-(P.x+(cx-P.x)*t),p.y-(P.y+(cy-P.y)*t))<0.85){why='prop on the line';break;}}}
    if(why==='ok'){                                    // he passed the XY rule: does the frame agree?
      e.x=cx;e.y=cy;e.ang=Math.atan2(P.y-cy,P.x-cx);
      COV=new Uint8Array(BW*BH);DEV.tick(1);
      vis=0;for(var z=0;z<BW*BH;z++)if(COV[z])vis++;COV=null;
      if(vis<VIS)why='only '+vis+' px of him painted';
    }
    tried.push({off:+(KB[i]*D*RF[q]).toFixed(2),why:why});
    if(why==='ok'){pick={x:+cx.toFixed(2),y:+cy.toFixed(2),off:+(KB[i]*D*RF[q]).toFixed(2),
      d:+d0.toFixed(2),vis:vis};break;}
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
  ${o.pair ? `out.b=[];out.m=null;
  /* WHICH PIXELS ARE HIM, FROM THE RENDERER AND NOT FROM THE FRAME DIFFERENCE (#611). A difference
     mask cannot carry a paint verdict: one page load disagrees with ITSELF by ~4k kept px (the rig,
     dither, lamp flicker), and a difference mask at a 10 m seat is 9-13k px - so a third to two
     thirds of the mask is weather, and the weather that survives the k-frame mean sits in the rig's
     box, which is the part of the frame that is NOT the body. The renderer already knows the answer:
     js/00_core.js COV is an opt-in coverage mask, stamped 1 by a body's own mesh draw and 0 by every
     other writer - props, decals, billboards and the view model all stamp 0 (js/40_render.js stamps
     body:0 for the gun, #183), and last-writer-wins so a crate nearer than him takes the pixel and
     stops being silhouette. It is write-only: nothing in the shipped frame reads it, so arming it
     moves no pixel and costs nothing the player pays. So the mask is that mask, read out of the same
     frame as the arm it measures, and the frame difference becomes the cross-check it always should
     have been. */
  COV=new Uint8Array(BW*BH);
  for(var u=0;u<${ARMS};u++){DEV.tick(1);out.b.push(cv.toDataURL('image/png').split(',')[1]);
    if(!out.m){var nb=(BW*BH+7)>>3,by=new Uint8Array(nb);for(var q=0;q<BW*BH;q++)if(COV[q])by[q>>3]|=1<<(q&7);
      var s='';for(var q2=0;q2<nb;q2++)s+=String.fromCharCode(by[q2]);
      out.m=btoa(s);out.buf=[BW,BH];out.dims=[cv.width,cv.height];COV=null;}}
  ENEMIES.length=0;out.c=[];for(var u2=0;u2<${ARMS}*2;u2++){DEV.tick(1);out.c.push(cv.toDataURL('image/png').split(',')[1]);}
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
  /* A Buffer IS a byte array, so `acc[k] += f.d[k]` on one stores the sum mod 256 and the "mean of k
   * frames" comes out as (sum mod 256)/k - the true mean folded into 0..255/k. Measured on frames
   * this tool itself captured (#740 review): four frames whose true mean luma is 87.5 averaged to
   * 22.3, with 943309 of 2678400 channels off by more than 1, and two of the four sectors' value
   * steps changed SIGN. The accumulator has to be wider than a byte; the Buffer is only the output. */
  const acc = new Float64Array(f0.d.length);
  acc.set(f0.d);
  let want = 0;
  for (let k = 0; k < acc.length; k++) want += f0.d[k];
  want /= acc.length;
  for (let i = 1; i < files.length; i++) {
    const f = decodePNG(files[i]);
    if (f.w !== f0.w || f.h !== f0.h) throw new Error('arm frames differ in size: ' + files[0] + ' vs ' + files[i]);
    let s = 0;
    for (let k = 0; k < acc.length; k++) { acc[k] += f.d[k]; s += f.d[k]; }
    want = (want * i + s / acc.length) / (i + 1);   // running mean of the frames' own channel mean
  }
  const d = Buffer.alloc(acc.length);
  let got = 0;
  for (let k = 0; k < acc.length; k++) { const v = Math.round(acc[k] / files.length); d[k] = v; got += v; }
  got /= acc.length;
  /* The canary, so this bug cannot come back inside a green row: the mean of the mean has to be the
   * mean of the frames. Rounding accounts for well under 1/256 of a frame; a byte accumulator is off
   * by tens. Throw rather than print - a folded image makes every step in the row arithmetic on
   * something that was never on screen. */
  if (Math.abs(got - want) > 0.75) throw new Error('avgPNG: the mean of the ' + files.length + '-frame mean is ' +
    got.toFixed(2) + ' but those frames average ' + want.toFixed(2) + ' - the accumulator is losing value '
    + '(a byte array sums mod 256). Fix the accumulator; do not re-record the row.');
  return { w: f0.w, h: f0.h, d };
}

/* The body's OWN pixels, from the coverage mask the renderer stamped (#611). COV lives at raster
 * resolution (js/00_core.js BW x BH, 676x291 at the shipped tier) and the arm PNG is the composited
 * display canvas (1440x620), so each stamped raster pixel is read at the centre of the display pixel
 * it lands in - one sample per body pixel, no block doubling, and the sample is the delivered colour
 * at that spot including whatever bloom bled into it. */
function covSamples(mask, dims, D) {
  const bits = Buffer.from(mask, 'base64'), bw = dims[0], bh = dims[1];
  const ix = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x;
    if (!(bits[i >> 3] & (1 << (i & 7)))) continue;
    const dx = Math.min(D[0] - 1, Math.round((x + 0.5) * D[0] / bw));
    const dy = Math.min(D[1] - 1, Math.round((y + 0.5) * D[1] / bh));
    ix.push((dy * D[0] + dx) * 3);
  }
  return ix;
}

/* The colour read over a fixed set of pixel indices: what the two arms delivered there, as luma and
 * as chroma. Used for the body mask AND for the identity control, so both sides of the comparison
 * are the same estimator over the same pixels. */
function colourAt(A, B, ix) {
  const mB = [0, 0, 0], mA = [0, 0, 0];
  let dsum = 0;
  for (const i of ix) {
    for (let c = 0; c < 3; c++) { mB[c] += B.d[i + c]; mA[c] += A.d[i + c]; }
    dsum += Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
  }
  const n = ix.length || 1;
  for (let c = 0; c < 3; c++) { mB[c] /= n; mA[c] /= n; }
  const luma = m => LR * m[0] + LG * m[1] + LB * m[2];
  const sat = m => { const s = m.slice().sort((a, b) => a - b); return s[2] ? (1 - s[0] / s[2]) * 100 : 0; };
  const hue = m => {
    const r = m[0] / 255, g = m[1] / 255, b = m[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return NaN;
    return 60 * (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  };
  /* The COLOUR axis in the dialect tools/view.js's contrast sweep row already gates on (SEP_C there):
     distance in the luma-normalised opponent plane, so it is a hue/chroma step that neither his nor the
     wall's brightness can buy, and so a live row and a harness row can be read against one another
     instead of against two dialects of the same idea. sat/hue below stay: they are what a person reads
     off the row, this is what it is scored in. */
  const opp = m => { const L = Math.max(luma(m), 1); return [(m[0] - m[1]) / L, ((m[0] + m[1]) * 0.5 - m[2]) / L]; };
  const pB = opp(mB), pA = opp(mA);
  return {
    n: ix.length, delta: +(dsum / n).toFixed(2),
    plane: +(100 * Math.hypot(pB[0] - pA[0], pB[1] - pA[1])).toFixed(1),
    hueGap: null,
    body: mB.map(v => +v.toFixed(1)), bg: mA.map(v => +v.toFixed(1)),
    lumaBody: +luma(mB).toFixed(2), lumaBg: +luma(mA).toFixed(2), valueStep: +(luma(mB) - luma(mA)).toFixed(2),
    satBody: +sat(mB).toFixed(1), satBg: +sat(mA).toFixed(1), chromaStep: +(sat(mB) - sat(mA)).toFixed(1),
    hueBody: +hue(mB).toFixed(1), hueBg: +hue(mA).toFixed(1), hueStep: +(hue(mB) - hue(mA)).toFixed(1)
  };
}

/* The frame centre only: the four HUD corners carry a kill counter and a minimap dot that differ
   between the two arms for reasons that have nothing to do with paint. */
function fg(withBody, without, mask) {
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
  /* With a cov mask in hand the difference mask is a cross-check, not the verdict: its size says how
   * much of the frame this load disagrees about, which includes the rig. Vacuity is then asked of the
   * pixels the renderer says are a body. Without a mask this is the old read, unchanged. */
  const res = { n, minKeep, vacuous: mask ? false : n < minKeep };
  if (!n && !mask) return Object.assign(res, { note: 'no pixel differs - the body contributed nothing the frame delivered' });
  for (let c = 0; c < 3; c++) { mB[c] /= n; mA[c] /= n; }
  const luma = m => LR * m[0] + LG * m[1] + LB * m[2];
  const sat = m => { const s = m.slice().sort((a, b) => a - b); return s[2] ? (1 - s[0] / s[2]) * 100 : 0; };
  const hue = m => {
    const r = m[0] / 255, g = m[1] / 255, b = m[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return NaN;
    return 60 * (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  };
  res.diff = {
    box: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1],
    body: mB.map(v => +v.toFixed(1)), bg: mA.map(v => +v.toFixed(1)),
    lumaBody: +luma(mB).toFixed(2), lumaBg: +luma(mA).toFixed(2), valueStep: +(luma(mB) - luma(mA)).toFixed(2),
    satBody: +sat(mB).toFixed(1), satBg: +sat(mA).toFixed(1), chromaStep: +(sat(mB) - sat(mA)).toFixed(1),
    hueBody: +hue(mB).toFixed(1), hueBg: +hue(mA).toFixed(1), hueStep: +(hue(mB) - hue(mA)).toFixed(1)
  };
  /* The primary read, when the frame came with the renderer's own mask: the pair of bars over the
   * pixels a body's draw took, and the mean delivered delta at those pixels - which is also what the
   * identity control is measured in, so the two are comparable. */
  if (mask) {
    const ix = covSamples(mask.b64, mask.dims, [A.w, A.h]);
    res.cov = colourAt(A, B, ix);
    /* Hue is an angle: the signed difference between two hue angles is meaningless past half a circle,
     * and the raw subtraction put a -3 luma row at "hueStep 266.1". Print the short way round. */
    if (isFinite(res.cov.hueBody) && isFinite(res.cov.hueBg)) {
      let g = Math.abs(res.cov.hueBody - res.cov.hueBg) % 360;
      res.cov.hueGap = +(g > 180 ? 360 - g : g).toFixed(1);
    }
    res.maskEmpty = res.cov.n === 0;         // nothing stamped: either no body, or COV was never armed
  }
  return res;
}

/* The one verdict this tool prints. TWO masks are reported and they mean different things:
 * `cov` is the body's OWN pixels as the geometry pass stamped them (#611's primary), and `diff` is
 * every pixel the two arms disagree about - the body PLUS whatever else this load refuses to agree on
 * with itself, the first-person rig first. A cov mask under MIN_COV_FRAC of the raster is VACUOUS, and
 * so is one whose mean delivered delta does not beat the mean delta the SAME pixels show between two
 * halves of one arm. Neither clause is a colour bar: a weak colour over the floor is a result. */
function fgLine(tag, r, idn, k) {
  const c = r.cov, i = idn && idn.cov;
  return 'FG ' + tag + ' MASK ' + (c ? JSON.stringify(c) : '(no coverage mask came back)') +
    '\n   cross-check, frame-difference mask: ' + (r.diff ? JSON.stringify(r.diff) : '{}') +
    (i ? '\n   IDENTITY ' + i.n + ' of the SAME masked px, both sides ' + (k || 1) + '-frame means, nothing between the '
      + 'halves of one clear arm but ticks; mean delivered delta there ' + i.delta + ' against ' + c.delta +
      ' between the arms. ' + (c.delta > i.delta ? 'The body clears its own floor.'
        : 'The mask does not clear its own floor, so the steps above are not a body.')
      : idn ? '\n   IDENTITY ' + idn + ' kept px between two halves of one arm (the difference mask; no cov mask came back).' : '') +
    (c && c.n < r.covMin ? '\n   VACUOUS: a body\'s draw took ' + c.n + ' px of the ' + r.buf + ' raster, under the '
      + r.covMin + ' px floor (' + (MIN_COV_FRAC * 100).toFixed(3) + '%). Nothing was painted there, so the steps '
      + 'above are arithmetic on nothing. A seat with geometry on the camera-to-body line reads this way, and so '
      + 'does a page whose COV was never armed.' : '') +
    (c && i && !(c.delta > i.delta) ? '\n   VACUOUS BY ITS OWN CONTROL: the same masked px move ' + c.delta +
      ' between the arms and ' + i.delta + ' between two halves of one arm with nothing changed. This load does not '
      + 'agree with itself any less than it disagrees about the body, so the row measures the harness and not the '
      + 'paint. Vacuity is a FAILURE, not a debt.' : '');
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

/* Every frame this run wrote for one arm, in tick order, stopping at the first gap. The clear arm of
 * the `both` route holds TWICE the frames of the body arm (#740 review): the first half is the arm
 * itself and the second half is the identity control, so a count fixed at ARMS would silently drop
 * the control and leave the floor uncomputable. */
function armFiles(dir, base) {
  const out = [];
  for (let i = 0; i < Math.max(1, ARMS) * 2; i++) {
    const f = path.join(dir, base + '-' + i + '.png');
    if (fs.existsSync(f)) out.push(f); else break;
  }
  return out;
}

/* The cov mask that belongs with a set of arm frames. The `both` route writes it beside the frames it
 * was stamped from, so a run's whole read - pixels, colours and the mask that says which of them are
 * the body - stays on disk together and can be re-read without a browser. dims are the RASTER size
 * the mask lives at, which is not the size of the PNG. */
function maskFor(dir, base, file, dims) {
  const f = file ? path.resolve(file) : path.join(dir, base + '-cov.b64');
  if (!fs.existsSync(f)) return null;
  let d = dims ? String(dims).split(/[x,]/).map(Number) : null;
  if (!d || d.length !== 2) { const s = fs.readFileSync(f.replace(/\.b64$/, '.dims'), 'utf8'); d = s.trim().split(/[x,]/).map(Number); }
  if (!d || d.length !== 2 || !d[0] || !d[1]) return { b64: fs.readFileSync(f, 'utf8').trim(), dims: null };
  return { b64: fs.readFileSync(f, 'utf8').trim(), dims: d };
}

/* One fg pair read: the body arm against the clear arm at the pixels the renderer says are his, plus
 * the identity control built from the two halves of the clear arm. Used by `both` (one deal) and by
 * `sweep` (many deals), so the two cannot drift into different measurements of the same thing. */
function pairRead(dir, base) {
  const all = armFiles(dir, base), allC = armFiles(dir, base.replace('-body', '-clear'));
  if (!all.length || !allC.length) return null;
  const k = Math.min(all.length, Math.floor(allC.length / 2));
  if (!k) return null;
  const m = maskFor(dir, base);
  const r = fg(all.slice(0, k), allC.slice(0, k), m);
  r.buf = m ? m.dims[0] * m.dims[1] : 0;
  r.covMin = Math.max(1, Math.round(r.buf * MIN_COV_FRAC));
  const idn = allC.length >= 2 * k ? fg(allC.slice(k, 2 * k), allC.slice(0, k), m) : null;
  if (r.cov) r.cov.vacuous = r.cov.n < r.covMin;
  if (r.cov && r.cov.vacuous) r.vacuous = true;
  if (r.cov && idn && idn.cov) { if (!(r.cov.delta > idn.cov.delta)) r.noisy = true; }
  else if (!r.cov && idn && r.n <= idn.n) r.noisy = true;
  return { r, idn, k };
}

async function cap(o) {
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'livecap-'));
  const deadline = Date.now() + (+o.timeout || 120) * 1000;
  const page = await openPage(o.url, profile, deadline);
  const rows = [];
  let r_mask = null;                                // the cov mask of the shot being fetched right now
  try {
    for (const shot of o.shots) {
      if (Date.now() > deadline - 8000) { rows.push({ name: shot.name, error: 'deadline' }); break; }
      await page.goto(shot.url || o.url);
      if (shot.name === o.shots[0].name && !(await page.evaluate('!!(window.DEV && DEV.on)')))
        throw new Error(o.url + ' is not a ?dev=1 page (js/90_dev.js stayed inert)');
      r_mask = null;
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
            + 'same order as a body mask at 10 m, so single frames cannot carry the row. Twice as many '
            + 'clear frames as body frames: the second half is the IDENTITY control, so the floor is '
            + 'built from the same per-pixel mean as the mask it gates.');
        }
        v.b.forEach((p, i) => fs.writeFileSync(path.join(out, shot.name + '-' + i + '.png'), Buffer.from(p, 'base64')));
        v.c.forEach((p, i) => fs.writeFileSync(path.join(out, shot.clear + '-' + i + '.png'), Buffer.from(p, 'base64')));
        delete v.b; delete v.c;
        if (v.m) {                                  // the renderer's own body mask, kept with the frames it masks
          fs.writeFileSync(path.join(out, shot.name + '-cov.b64'), v.m);
          fs.writeFileSync(path.join(out, shot.name + '-cov.dims'), v.buf.join('x'));   // raster size the mask lives at
          r_mask = { b64: v.m, dims: v.buf, display: v.dims };
          delete v.m;
        }
      }
      rows.push(Object.assign({ name: shot.name, file, mask: r_mask }, v));
    }
  } finally {
    page.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  for (const r of rows) {
    console.log('CAP ' + r.name + (r.file ? ' ' + path.relative(process.cwd(), r.file) : ' ERROR ' + r.error) +
      (r.layout !== undefined ? '  layout ' + r.layout + ' mode ' + r.mode + ' canvas ' + r.canvas +
        ' lum ' + (r.lum ? r.lum.mean + '/' + r.lum.mid : '?') +
        (r.body ? ' body ' + r.kind + ' @ ' + r.body.d + ' m off ' + r.body.off + ' m, ' + r.body.vis +
          ' raster px of him painted' +
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

/* ---------------------------------------------------------------- the deal sweep (#611 bullet 2)
 *
 * "The separation holds in every dealt room rather than in the favourable ones: a 12-deal sweep per
 * level prints the worst sector/seed pair, and the worst pair passes." The harness already runs that
 * sweep on its own dice (tools/view.js contrast, the `worst of 12 deals` row, bars SEP_V / SEP_C there),
 * and this is the same question asked of the build that SHIPS: one page load per deal, the body placed
 * at the 10 m seat the deal allows, and the pair of bars read off the delivered pixels. One page load is
 * one deal - js/90_dev.js installs its generator from the URL and a second DEV.boot() keeps drawing
 * from the advanced stream instead of re-cutting it - so the sweep costs deals x loads and takes
 * minutes, not seconds. That is the price of the row being about the deployed picture rather than about
 * a model of it.
 *
 * The bars are imported from that harness row rather than invented here (SEP_V luma of value step,
 * SEP_C of colour step in the luma-normalised opponent plane), so a deal that passes here and fails
 * there is a disagreement between the page and the harness worth reading, not two tools that quietly
 * mean different things. WORST means the deal with the smaller margin over its OWN bar on either axis -
 * the two axes do not share a unit, so margin-over-bar is the only honest comparison.
 */
const SEP_V = +(process.env.SEP_V !== undefined ? +process.env.SEP_V : 4);     // tools/view.js contrast
const SEP_C = +(process.env.SEP_C !== undefined ? +process.env.SEP_C : 20);    // tools/view.js contrast

function dealUrl(base, seed) {
  return /[?&#]seed=-?\d+/.test(base) ? base.replace(/([?&#]seed=)-?\d+/, '$1' + seed)
    : base + (base.indexOf('?') >= 0 ? '&' : '?') + 'dev=1&seed=' + seed;
}

async function sweep(o) {
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  const shots = [];
  for (const l of o.levels) for (let d = 0; d < o.deals; d++) {
    const seed = o.seed + d * o.step;
    shots.push({ name: 'w' + l + 'd' + d + '-body', clear: 'w' + l + 'd' + d + '-clear', level: l,
      pair: true, url: dealUrl(o.url, seed), seed: seed, deal: d, layout: null,
      body: { kind: o.kind || (l === 2 ? 'brute' : 'grunt'), dist: o.dist } });
  }
  const rows = await cap({ url: o.url, out, shots, timeout: o.timeout });
  const byLevel = {};
  let vacuous = 0, failed = 0;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    /* cap() merges the page's own state over the row, and DEV.state() carries a `name` (the level's),
       so a row cannot be found by shot name after the fact - zip by position instead, which is the
       order cap pushes in, and name the deal by the number this command asked the page for. */
    const r0 = rows[i] && rows[i].file && rows[i].file.indexOf(s.name) >= 0 ? rows[i] : {};
    const line = 'SWEEP L' + s.level + ' deal ' + s.deal + ' seed ' + s.seed + ' layout ' + (r0.layout || '?');
    if (r0.noSeat) {
      console.log(line + ' NO CLEAR SEAT at ' + o.dist + ' m - cannot be measured, counted as unposed');
      if (!flag('keep')) for (const f of armFiles(out, s.name).concat(armFiles(out, s.clear))) fs.unlinkSync(f);
      (byLevel[s.level] = byLevel[s.level] || { unposed: 0 }).unposed++;
      continue;
    }
    const p = pairRead(out, s.name);
    if (!p || !p.r.cov) { console.log(line + ' NO READ (no frames or no coverage mask came back)'); vacuous++; continue; }
    const c = p.r.cov, row = { seed: s.seed, layout: r0.layout, kind: r0.kind, d: r0.body ? r0.body.d : null,
      n: c.n, dv: Math.abs(c.valueStep), dc: c.plane, sat: c.chromaStep, hue: c.hueGap,
      bad: p.r.vacuous || p.r.noisy };
    if (row.bad) { vacuous++; console.log(line + ' VACUOUS - ' + (p.r.vacuous ? 'a body painted ' + c.n + ' px, under the floor' : 'the mask does not clear its own identity floor') + '; not a measurement'); continue; }
    (byLevel[s.level] = byLevel[s.level] || { rows: [], unposed: 0 }).rows.push(row);
    const m = Math.min(row.dv / SEP_V, row.dc / SEP_C);
    console.log(line + ' ' + (row.kind || '?') + ' @ ' + row.d + ' m on ' + row.n + ' px  value ' + c.valueStep +
      ' colour ' + row.dc + (row.dc < SEP_C || row.dv < SEP_V ? '  ** under a bar' : '') +
      '  margin ' + m.toFixed(2) + ' (sat ' + row.sat + ', hue ' + row.hue + ')');
    if (!flag('keep')) for (const f of armFiles(out, s.name).concat(armFiles(out, s.clear))) fs.unlinkSync(f);
  }
  for (const l of Object.keys(byLevel)) {
    const g = byLevel[l];
    if (!g.rows || !g.rows.length) {
      console.log('SWEEP L' + l + ': ' + g.unposed + ' deal(s), NONE posed and measured - the sweep posed no '
        + 'body on this level, which is a FAILURE and not an ok.');
      failed++; continue;
    }
    const worst = g.rows.reduce((a, b) => (Math.min(b.dv / SEP_V, b.dc / SEP_C) < Math.min(a.dv / SEP_V, a.dc / SEP_C) ? b : a));
    const ok = worst.dv >= SEP_V && worst.dc >= SEP_C;
    if (!ok) failed++;
    console.log('SWEEP L' + l + ' WORST of ' + g.rows.length + ' dealt' + (g.unposed ? ' (' + g.unposed + ' could not pose)' : '') +
      ': seed ' + worst.seed + ' layout ' + worst.layout + ' ' + worst.kind + ' @ ' + worst.d + ' m on ' + worst.n +
      ' px - value ' + worst.dv.toFixed(1) + ' against ' + SEP_V + ', colour ' + worst.dc.toFixed(1) + ' against ' + SEP_C +
      (ok ? '  BOTH AXES CLEAR in the worst deal, so the separation holds in this level\'s rooms and not only in the favourable one'
        : '  THE WORST DEAL FAILS' + (worst.dv < SEP_V && worst.dc < SEP_C ? ' on both axes' : worst.dv < SEP_V
          ? ' on value - the right brightness is missing, which is the light path\'s half (#407), not the pigment\'s'
          : ' on colour - he is the right brightness in the wall\'s own colour family, the #611 defect in its original form')));
  }
  console.log('LIVESWEEP ' + Object.keys(byLevel).length + ' level(s) x ' + o.deals + ' deal(s) at ' + o.dist +
    ' m on ' + o.url.replace(/\?.*/, '') + ' - bars ' + SEP_V + ' luma / ' + SEP_C + ' opponent plane, the same two '
    + 'tools/view.js contrast gates (' + (flag('bars') ? 'overridden' : 'defaults there') + '); '
    + vacuous + ' vacuous row(s), ' + failed + ' level(s) whose worst deal fails.');
  if (vacuous || failed) process.exitCode = 1;
}

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
        // the pair path writes l*-body-<i>.png, no single frame
        const p = pairRead(out, 'l' + l + '-body');
        if (!p) continue;
        if (p.r.vacuous || p.r.noisy) vacuous++;
        console.log(fgLine('L' + l, p.r, p.idn, p.k));
      }
      if (vacuous) {
        console.log('LIVECAP ' + vacuous + ' of ' + levels.length + ' FG row(s) VACUOUS - the floor note above each such row says why');
        process.exitCode = 1;
      }
    }
    return;
  }

  if (cmd === 'cost') {
    /* kept separate from the usage text below so a reader who lands here sees what the flags mean */
    const levels = (arg('levels', '0,1,2,3') + '').split(',').map(Number);
    await cost({ url, levels, frames: arg('frames', 24), yawFrames: arg('yawFrames', 8),
      timeout: arg('timeout', 240) });
    return;
  }

  if (cmd === 'fg') {
    const files = process.argv.slice(3).filter(a => a[0] !== '-' && /\.png$/.test(a));
    if (files.length !== 2) { console.log('usage: node tools/livecap.js fg <with-body.png> <without.png> [--mask COV.b64 --dims 676x291]'); process.exit(2); }
    if (!arg('mask', '')) console.log('NOTE no --mask given: this is the frame-difference read, which counts the first-person '
      + 'rig as figure-ground. The `both` command passes the coverage mask the renderer stamped.');
    const mm = maskFor(path.dirname(path.resolve(files[0])), path.basename(files[0]).replace(/-\d+\.png$/, ''), arg('mask', ''), arg('dims', ''));
    const r = fg(files[0], files[1], mm);
    if (r.cov) r.covMin = Math.max(1, Math.round(mm.dims[0] * mm.dims[1] * MIN_COV_FRAC));
    console.log(fgLine('', r));
    if (r.vacuous || (r.cov && r.cov.n < r.covMin)) process.exitCode = 1;
    return;
  }

  if (cmd === 'sweep') {
    const levels = (arg('levels', '0,1,2,3') + '').split(',').map(Number);
    await sweep({ url, levels, deals: +arg('deals', 12), seed: +arg('seed', 60), step: +arg('seedstep', 1013),
      dist: +arg('dist', 10), kind: arg('kind', ''), out, timeout: arg('timeout', 900) });
    return;
  }

  console.log([
    'usage:',
    '  node tools/livecap.js cap  --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR]',
    '  node tools/livecap.js both --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR] [--why]',
    '  node tools/livecap.js fg   <with-body.png> <without.png>',
    '  node tools/livecap.js cost [--url <dev page>] [--levels 0,1,2,3] [--frames 24] [--yawFrames 8]',
    '  node tools/livecap.js sweep [--url <dev page>] [--levels 0,1,2,3] [--deals 12] [--seed 60] [--dist 10]',
    '',
    'sweep = #611 bullet 2 on the deployed build: 12 dealt rooms per level, one page load per deal (the',
    'generator is cut from the URL, so a deal costs a load), a body at the 10 m seat that deal allows, and',
    'the pair of bars read at his own pixels. Prints every deal and then the WORST one per level - the',
    'deal with the smallest margin over its own bar - and exits non-zero when a level\'s worst deal is',
    'under either bar or when a row is vacuous. The bars are the two tools/view.js contrast gates (SEP_V,',
    'SEP_C), overridable with the same names.',
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
