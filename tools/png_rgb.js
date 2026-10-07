'use strict';
/*
 * tools/png_rgb.js - re-encode a capture PNG as colour type 2 (truecolour, no alpha) (#393).
 *
 * Why this exists: every frame in docs/screens/ is colour type 2 except one, and the colour
 * of the file is not cosmetic - tools/recap.js's decoder carries a channel-rotation bug for
 * type 6 (#394), so an RGBA capture gets its caption's mean luma evaluated as
 * 0.2126 G + 0.7152 B + 0.0722 R instead of the rule the README states, and `recap check`
 * compares the README through the same rotation and prints ok while both sides are wrong.
 * A capture in the encoding the other five use is read correctly by the gate as it stands.
 *
 * Chromium screenshots arrive RGBA, so the capture step needs one lossless hop. This tool is
 * that hop, and it refuses to be lossy: it re-decodes what it wrote and requires byte-identical
 * RGB and a fully opaque alpha channel. If a capture ever carries real transparency the tool
 * says so and changes nothing, because dropping that alpha would be a picture change wearing
 * an encoding change's clothes.
 *
 *   node tools/png_rgb.js docs/screens/foo.png     convert in place, print the verdict
 *   node tools/png_rgb.js --check <png>            report the colour type, change nothing
 *
 * Verdict lines:
 *   PNGRGB <file> already colour type 2 (w x h)        no-op, exit 0
 *   PNGRGB <file> -> colour type 2  rgb-diff 0  alpha min 255  bytes A -> B   exit 0
 *   PNGRGB-FAIL <reason>                              nothing written, exit 1
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

function die(msg) { console.log('PNGRGB-FAIL ' + msg); process.exit(1); }

/* --------------------------------------------------------------- PNG decode */

function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
}
const T = crcTable();
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

/* Returns { w, h, bps, color, rgb:Uint8Array(w*h*3), alpha:Uint8Array(w*h)|null }.
 * Only 8-bit truecolour with or without alpha is decoded - that is the whole capture corpus,
 * and anything else is refused rather than guessed at. */
function decode(buf, name) {
  if (buf.length < 16 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    die(name + ': not a PNG (magic missing)');
  let p = 8, ihdr = null, parts = [];
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (len > buf.length) die(name + ': chunk ' + type + ' length exceeds file');
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9],
        interlace: data[12] };
      if (ihdr.depth !== 8) die(name + ': bit depth ' + ihdr.depth + ', only 8 is handled here');
      if (ihdr.color !== 2 && ihdr.color !== 6) die(name + ': colour type ' + ihdr.color +
        ' (only 2 = truecolour and 6 = truecolour+alpha are captures this tool can pass through)');
      if (ihdr.interlace) die(name + ': interlaced capture, not supported');
    } else if (type === 'IDAT') parts.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) die(name + ': no IHDR');
  const bps = ihdr.color === 6 ? 4 : 3;
  const stride = ihdr.w * bps;
  const raw = zlib.inflateSync(Buffer.concat(parts));
  if (raw.length !== ihdr.h * (stride + 1)) die(name + ': IDAT size does not match ' + ihdr.w + 'x' + ihdr.h);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const rgb = new Uint8Array(ihdr.w * ihdr.h * 3);
  const alpha = ihdr.color === 6 ? new Uint8Array(ihdr.w * ihdr.h) : null;
  let o = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[o++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bps ? cur[x - bps] : 0;
      const b = prev[x];
      const c = (x >= bps && y > 0) ? prev[x - bps] : 0;
      let v = raw[o++];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) die(name + ': bad filter type ' + ft + ' at row ' + y);
      cur[x] = v & 255;
    }
    for (let x = 0; x < ihdr.w; x++) {
      const i = x * bps, j = (y * ihdr.w + x) * 3;
      rgb[j] = cur[i]; rgb[j + 1] = cur[i + 1]; rgb[j + 2] = cur[i + 2];
      if (alpha) alpha[y * ihdr.w + x] = cur[i + 3];
    }
    prev = cur;
    cur = Buffer.alloc(stride);
  }
  return { w: ihdr.w, h: ihdr.h, bps: bps, color: ihdr.color, rgb: rgb, alpha: alpha };
}

function encodeRGB(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    rgb.copy ? rgb.copy(raw, o, y * w * 3, (y + 1) * w * 3) : Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3,
      w * 3).copy(raw, o);
    o += w * 3;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* A checksum over the RGB stream only: two files with the same picture in different encodings
 * must agree here, and that is the losslessness claim, stated as a number. */
function rgbHash(rgb) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < rgb.length; i++) { h ^= rgb[i]; h = Math.imul(h, 16777619) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
function luma(rgb) {
  let s = 0;
  for (let i = 0; i < rgb.length; i += 3) s += LR * rgb[i] + LG * rgb[i + 1] + LB * rgb[i + 2];
  return s / (rgb.length / 3);
}

/* ----------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const file = argv.filter(function (a) { return a.indexOf('--') !== 0; })[0];
if (!file) die('usage: node tools/png_rgb.js [--check] <png>');
const p = path.resolve(ROOT, file);
if (!fs.existsSync(p)) die('no such file: ' + file);
const buf = fs.readFileSync(p);
const before = decode(buf, file);

if (checkOnly) {
  console.log('PNGRGB ' + file + ' colour type ' + before.color + ' ' + before.w + 'x' + before.h +
    (before.color === 6 ? '  <- recap.js mis-reads this encoding (#394)' : ''));
  process.exit(0);
}

if (before.color === 2) {
  console.log('PNGRGB ' + file + ' already colour type 2 (' + before.w + 'x' + before.h + '), nothing written');
  process.exit(0);
}

let aMin = 255;
for (let i = 0; i < before.alpha.length; i++) if (before.alpha[i] < aMin) aMin = before.alpha[i];
if (aMin !== 255) die(file + ' carries transparency (alpha min ' + aMin + '); dropping it would change the ' +
  'picture. Convert by hand or keep the alpha-capable encoding and fix the reader (#394).');

const out = encodeRGB(before.w, before.h, before.rgb);
const after = decode(out, file + ' (re-encoded)');
let diff = 0;
for (let i = 0; i < before.rgb.length; i++) if (before.rgb[i] !== after.rgb[i]) diff++;
if (diff !== 0 || rgbHash(before.rgb) !== rgbHash(after.rgb))
  die('re-encode is not lossless: ' + diff + ' differing byte(s) - file left alone');

fs.writeFileSync(p, out);
console.log('PNGRGB ' + file + ' -> colour type 2  rgb-diff ' + diff + '  rgb-hash ' + rgbHash(before.rgb) +
  '  alpha min ' + aMin + '  bytes ' + buf.length + ' -> ' + out.length);
console.log('PNGRGB mean luma (0.2126R+0.7152G+0.0722B) before ' + luma(before.rgb).toFixed(2) +
  ' after ' + luma(after.rgb).toFixed(2) + '  (the two must agree; the caption number is this one)');
process.exit(0);
