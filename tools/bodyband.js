/* bodyband.js - the row profile #655 asks for, on a PNG the repo's own renderer wrote.

   `node tools/view.js scene 2 0` puts a brute close on the right of the ABATOIR CORE frame and
   writes /tmp/fps_scene.png. This reads that PNG back and scans a horizontal line across a window,
   printing the four numbers the issue names: columns covered, the luminance range inside the body,
   how many adjacent-column steps are >= 4 luma, and how many monotone RUNS the profile takes to
   make. The last one is the shape question: a body reads as one solid when a scan across it is a few
   monotone runs (dark side, light side, maybe a top face); it reads as a fan of cards when the same
   scan is an alternating sawtooth. A fan is therefore a high transition count at a low run length,
   and a solid is the opposite, so the two numbers together can tell the two pictures apart and the
   row can fail.

   It reports; it gates nothing. No CI step runs this file, no recorded reference lives here, and it
   changes no pixel: the picture is `tools/view.js`'s, and this only reads it back. That is on
   purpose - #655's first acceptance clause ("a person says it") cannot be measured from the page,
   so the measurable half is a profile a reviewer can reproduce in one command, not a threshold.

   Usage: node tools/bodyband.js [png] [y0] [y1] [x0] [x1]   (defaults: /tmp/fps_scene.png, the
   brute in `scene 2 0` at the frame's own size).
*/
const zlib = require('zlib'), fs = require('fs');

function decode(path) {
  const b = fs.readFileSync(path);
  if (b.length < 8 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47)
    throw new Error('bodyband: "' + path + '" is not a PNG - pass a file tools/view.js wrote');
  let o = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (o + 8 <= b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8);
    const data = b.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6))
    throw new Error('bodyband: only 8-bit RGB/RGBA PNGs are readable (got depth ' + depth + ' colour ' + color + ')');
  const bpp = color === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  let ro = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[ro++], line = raw.slice(ro, ro + stride); ro += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, bb = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += bb;
      else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const pngPath = process.argv[2] || '/tmp/fps_scene.png';
const im = decode(pngPath);
const y0 = +(process.argv[3] || 310), y1 = +(process.argv[4] || 320);
const x0 = Math.max(0, +(process.argv[5] || 840)), x1 = Math.min(im.w - 1, +(process.argv[6] || 940));
const lum = (x, y) => {
  const i = (y * im.w + x) * im.bpp;
  return 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
};
const STEP = 4;                       // a step a person can see: #655 counts transitions of >= 4 luma
let min = 1e9, max = -1e9, trans = 0, runs = 0, runLen = 0, runMax = 0, cols = 0;
for (let y = y0; y <= y1; y++) {
  const s = [];
  for (let x = x0; x <= x1; x++) s.push(Math.round(lum(x, y)));
  cols = s.length;
  let rl = 1;                          // the first run starts at the first column
  for (let i = 1; i < s.length; i++) {
    if (s[i] < min) min = s[i];
    if (s[i] > max) max = s[i];
    if (Math.abs(s[i] - s[i - 1]) >= STEP) { trans++; runs++; runLen += rl; if (rl > runMax) runMax = rl; rl = 1; }
    else rl++;
  }
  runLen += rl; if (rl > runMax) runMax = rl;   // close the row's last run
}
const rows = y1 - y0 + 1;
console.log('bodyband ' + pngPath + ' ' + im.w + 'x' + im.h + '  rows ' + y0 + '-' + y1 + '  cols ' + x0 + '-' + x1);
console.log('  columns covered   ' + cols);
console.log('  luma range        ' + min + ' -> ' + max + '  (' + (max / Math.max(1, min)).toFixed(1) + 'x)');
console.log('  steps >= ' + STEP + ' luma   ' + (trans / rows).toFixed(1) + ' per row (' + trans + ' over ' + rows + ' rows)');
console.log('  monotone runs     ' + (runs / rows).toFixed(1) + ' per row, mean ' +
  (runLen / Math.max(1, runs)).toFixed(1) + ' px long, longest ' + runMax + ' px');
console.log('  reads as ' + ((runLen / Math.max(1, runs)) >= 8 ? 'ONE SOLID (long monotone runs)'
  : (runs / rows) >= 8 ? 'a FAN of slabs (many short runs, alternating)' : 'in between - not decided by this row'));
