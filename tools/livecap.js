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
  var e=ENEMIES[0],px=-Math.sin(P.ang),py=Math.cos(P.ang),bx=e.x,by=e.y;
  var off=[0,0.9,-0.9,1.8,-1.8,2.7,-2.7],pick=null;
  for(var i=0;i<off.length;i++){
    var cx=bx+px*off[i],cy=by+py*off[i],d0=Math.hypot(cx-P.x,cy-P.y),ok=!isSolid(cx,cy);
    if(ok){for(var j=0;j<PROPS.length;j++){var p=PROPS[j];
      var t=((p.x-P.x)*(cx-P.x)+(p.y-P.y)*(cy-P.y))/(d0*d0);t=Math.max(0,Math.min(1,t));
      if(Math.hypot(p.x-(P.x+(cx-P.x)*t),p.y-(P.y+(cy-P.y)*t))<0.85){ok=false;break;}}}
    if(ok){pick={x:+cx.toFixed(2),y:+cy.toFixed(2),off:off[i],d:+d0.toFixed(2)};break;}
  }
  if(!pick)pick={x:+bx.toFixed(2),y:+by.toFixed(2),off:0,d:${+o.body.dist || 10},fallback:true};
  e.x=pick.x;e.y=pick.y;e.ang=Math.atan2(P.y-e.y,P.x-e.x);
  out.body=pick;out.kind=e.kind;` : 'out.body=null;'}
  DEV.tick(1);
  try{resume();}catch(err){out.resumeErr=String(err);}
  DEV.tick(1);
  var st=DEV.state();
  out.mode=st.mode;out.level=st.level;out.name=st.levelName;out.layout=st.layout;
  out.live=st.enemies.length;out.p=st.p;out.lum=DEV.lum({stride:97});
  out.canvas=cv.width+'x'+cv.height;
  out.png=cv.toDataURL('image/png').split(',')[1];
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

/* The frame centre only: the four HUD corners carry a kill counter and a minimap dot that differ
   between the two arms for reasons that have nothing to do with paint. */
function fg(withBody, without) {
  const A = decodePNG(without), B = decodePNG(withBody);
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
  if (!n) return { n: 0, note: 'no pixel differs - the body contributed nothing the frame delivered' };
  for (let c = 0; c < 3; c++) { mB[c] /= n; mA[c] /= n; }
  const luma = m => LR * m[0] + LG * m[1] + LB * m[2];
  const sat = m => { const s = m.slice().sort((a, b) => a - b); return s[2] ? (1 - s[0] / s[2]) * 100 : 0; };
  const hue = m => {
    const r = m[0] / 255, g = m[1] / 255, b = m[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return NaN;
    return 60 * (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  };
  return {
    n, box: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1],
    body: mB.map(v => +v.toFixed(1)), bg: mA.map(v => +v.toFixed(1)),
    lumaBody: +luma(mB).toFixed(2), lumaBg: +luma(mA).toFixed(2), valueStep: +(luma(mB) - luma(mA)).toFixed(2),
    satBody: +sat(mB).toFixed(1), satBg: +sat(mA).toFixed(1), chromaStep: +(sat(mB) - sat(mA)).toFixed(1),
    hueBody: +hue(mB).toFixed(1), hueBg: +hue(mA).toFixed(1), hueStep: +(hue(mB) - hue(mA)).toFixed(1)
  };
}

/* ---------------------------------------------------------------- commands */

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
      if (!v || !v.png) { rows.push(Object.assign({ name: shot.name }, v, { error: 'no png came back' })); continue; }
      const file = path.join(out, shot.name + '.png');
      fs.writeFileSync(file, Buffer.from(v.png, 'base64'));
      delete v.png;
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
        (r.body ? ' body ' + r.kind + ' @ ' + r.body.d + ' m off ' + r.body.off : '') : ''));
  }
  if (page.pageErrors.length) console.log('NOTE page exceptions: ' + page.pageErrors.slice(0, 3).join(' | '));
  return rows;
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
        shots.push({ name: 'l' + l + '-clear', level: l });
        shots.push({ name: 'l' + l + '-body', level: l, body: { kind: arg('kind', l === 2 ? 'brute' : 'grunt'), dist: +arg('dist', 10) } });
      } else {
        shots.push({ name: 'l' + l + '-arrival', level: l });
      }
    }
    const rows = await cap({ url, out, shots, timeout: arg('timeout', 180) });
    if (cmd === 'both') {
      for (const l of levels) {
        const a = path.join(out, 'l' + l + '-body.png'), b = path.join(out, 'l' + l + '-clear.png');
        if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
        const r = fg(a, b);
        console.log('FG L' + l + ' ' + JSON.stringify(r));
      }
    }
    return;
  }

  if (cmd === 'fg') {
    const files = process.argv.slice(3).filter(a => a[0] !== '-');
    if (files.length !== 2) { console.log('usage: node tools/livecap.js fg <with-body.png> <without.png>'); process.exit(2); }
    console.log('FG ' + JSON.stringify(fg(files[0], files[1])));
    return;
  }

  console.log([
    'usage:',
    '  node tools/livecap.js cap  --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR]',
    '  node tools/livecap.js both --url <dev page> [--levels 0,1,2,3] [--dist 10] [--out DIR]',
    '  node tools/livecap.js fg   <with-body.png> <without.png>',
    '',
    'both = one page load per arm, same seed, clock frozen, grain off, one body ~dist m down the',
    'view line; then the fg row: the value (luma) and chroma (saturation / hue) step at the pixels',
    'the frame delivered for that body. cap alone leaves the frames on disk to look at.',
    'CHROME=<path> overrides the chromium binary; the page must be reachable (a deployed Pages',
    'build or any http(s) url serving this repo with ?dev=1).'
  ].join('\n'));
}

main().catch(e => { console.log('LIVECAP-FAIL ' + (e && e.message || e)); process.exit(1); });
