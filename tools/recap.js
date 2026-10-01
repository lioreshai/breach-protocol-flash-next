'use strict';
/*
 * tools/recap.js - print the capture-caption table from the committed PNGs (#235).
 *
 * Zero dependencies, no build step: the PNG is decoded here (chunk walk + zlib.inflateSync +
 * the five scanline filters) because node core has no image decoder and adding one is not
 * allowed. Everything the captions quote off a screenshot is printed from the bytes, so a
 * capture PR that forgets to regenerate the prose shows up as a diff in this table instead of
 * as a sentence that quietly stops being true.
 *
 *   node tools/recap.js                 table for docs/screens/*.png in the working tree
 *   node tools/recap.js --rev=<sha>     same table for the blobs committed at <sha>
 *   node tools/recap.js check           gate: README.md's quoted numbers vs. the files
 *
 * Env knobs (defaults are what `check` uses): STRIDE=n x-sampling step (default 1, every
 * column), DARK=n dark-row threshold (default 24), DARK_ALT=n second threshold printed (34),
 * DIR=path, README=path.
 *
 * check convention, stated because a gate nobody can read is not a gate:
 *   mean   - every `decode to **a / b / c / d / e**` list in README.md with one value per PNG,
 *            read in the order the images are EMBEDDED, must equal the file to MEAN_TOL, and
 *            the lists must agree with each other (#235 found two that did not).
 *   rows   - every "<N> (of M) ) rows average under|below luminance T" sentence is attributed to
 *            the docs/screens image that precedes it; its count, longest run and run start are
 *            compared at the TOOL's threshold, never the sentence's, so a caption cannot pick
 *            its own bar. A threshold label that differs from the tool's is printed as a note.
 *   vacuity - no PNG decoded, a decode that is not a page screenshot, no decode list, no row
 *            sentence, an embed with no file behind it: FAILURE, exit 1. Never an empty pass.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
const LUMA = 'luma = 0.2126 R + 0.7152 G + 0.0722 B (Rec.709 - the rule DEV.lum uses at js/90_dev.js:241;' +
  ' Rec.601 does NOT reproduce the audited captions, it reads spawn 87.26 against the file\'s 87.67)';
const STRIDE = parseInt(process.env.STRIDE || '1', 10);
const DARK = parseFloat(process.env.DARK || '24');
const DARK_ALT = parseFloat(process.env.DARK_ALT || '34');
const HI = [240, 200];
const MEAN_TOL = 0.005;

function die(msg) { throw new Error(msg); }

/* ---------------------------------------------------------------- PNG decode */

function pngDecode(buf, name) {
  if (buf.length < 16 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    die(name + ': not a PNG (magic missing)');
  let p = 8, ihdr = null, plte = null, parts = [], iend = false;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (len > buf.length) die(name + ': chunk ' + type + ' length exceeds file');
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9],
        comp: data[10], filt: data[11], inter: data[12] };
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'IEND') { iend = true; break; }
    p += 12 + len;
  }
  if (!ihdr) die(name + ': no IHDR');
  if (!iend) die(name + ': no IEND (truncated)');
  if (!parts.length) die(name + ': no IDAT - nothing to decode');
  if (ihdr.inter) die(name + ': interlaced PNG not supported');
  if (ihdr.comp !== 0) die(name + ': compression method ' + ihdr.comp + ' not supported');
  if (ihdr.filt !== 0) die(name + ': filter method ' + ihdr.filt + ' not supported');
  const CH = [0, 0, 3, 1, 2, 0, 4][ihdr.color];
  if (!CH) die(name + ': unsupported colour type ' + ihdr.color);
  if (ihdr.depth !== 8 && ihdr.depth !== 16) die(name + ': unsupported bit depth ' + ihdr.depth);
  if (ihdr.color === 3 && !plte) die(name + ': palette PNG with no PLTE');
  const bps = CH * (ihdr.depth >> 3);
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const srow = ihdr.w * bps;
  if (raw.length !== (srow + 1) * ihdr.h)
    die(name + ': IDAT inflates to ' + raw.length + ' bytes, scanlines need ' + (srow + 1) * ihdr.h);
  const lin = Buffer.alloc(srow * ihdr.h);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[pos++];
    const cur = y * srow, prev = cur - srow;
    for (let x = 0; x < srow; x++) {
      const a = x >= bps ? lin[cur + x - bps] : 0;
      const b = y > 0 ? lin[prev + x] : 0;
      const c = (x >= bps && y > 0) ? lin[prev + x - bps] : 0;
      let v = raw[pos++];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) die(name + ': bad filter type ' + ft + ' at row ' + y);
      lin[cur + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(ihdr.w * ihdr.h * 3);
  if (ihdr.color === 2) lin.copy(rgb);
  else if (ihdr.color === 6 || ihdr.color === 4) {
    for (let i = 0, j = 0; i < lin.length; i += bps) {
      const g = lin[i];
      rgb[j++] = ihdr.color === 4 ? g : lin[i + 1];
      rgb[j++] = ihdr.color === 4 ? g : lin[i + 2];
      rgb[j++] = g;
    }
  } else if (ihdr.color === 0) {
    for (let i = 0, j = 0; i < lin.length; i += bps) { rgb[j++] = lin[i]; rgb[j++] = lin[i]; rgb[j++] = lin[i]; }
  } else {
    for (let i = 0, j = 0; i < lin.length; i += bps) {
      const ix = ihdr.depth === 16 ? ((lin[i] << 8) | lin[i + 1]) : lin[i];
      const q = ix * 3;
      if (q + 2 >= plte.length) die(name + ': palette index ' + ix + ' past PLTE');
      rgb[j++] = plte[q]; rgb[j++] = plte[q + 1]; rgb[j++] = plte[q + 2];
    }
  }
  return { w: ihdr.w, h: ihdr.h, rgb: rgb };
}

/* ------------------------------------------------------------------- stats */

function measure(img, stride, darkThr) {
  const w = img.w, h = img.h, rgb = img.rgb, rows = new Float64Array(h);
  let n = 0, sum = 0; const hi = [0, 0];
  const s = Math.max(1, stride | 0);
  for (let y = 0; y < h; y++) {
    let rs = 0, rn = 0, base = y * w * 3;
    for (let x = 0; x < w; x += s) {
      const i = base + x * 3;
      const L = LR * rgb[i] + LG * rgb[i + 1] + LB * rgb[i + 2];
      rs += L; rn++; sum += L; n++;
      for (let k = 0; k < HI.length; k++) if (L >= HI[k]) hi[k]++;
    }
    rows[y] = rs / rn;
  }
  let cnt = 0, run = 0, runStart = 0, cur = 0, curStart = 0;
  for (let y = 0; y < h; y++) {
    if (rows[y] < darkThr) { cnt++; if (cur === 0) curStart = y; cur++; if (cur > run) { run = cur; runStart = curStart; } }
    else cur = 0;
  }
  const band = [0, 0, 0], bn = [0, 0, 0];
  for (let y = 0; y < h; y++) { const k = Math.min(2, (y * 3 / h) | 0); band[k] += rows[y]; bn[k]++; }
  return {
    w: w, h: h, px: w * h, n: n, mean: sum / n,
    hi: hi.map(function (c) { return 100 * c / n; }),
    dark: { thr: darkThr, count: cnt, run: run, start: runStart },
    bands: band.map(function (b, k) { return b / bn[k]; })
  };
}

function loadAll(rev, dir) {
  const out = [], names = [];
  if (rev) {
    const ls = cp.execFileSync('git', ['ls-tree', '--name-only', '-r', rev, '--', 'docs/screens'],
      { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const f of ls) if (f.endsWith('.png')) names.push([path.basename(f).replace(/\.png$/, ''), f]);
  } else {
    const d = dir || path.join(ROOT, 'docs/screens');
    if (!fs.existsSync(d)) die('no such directory: ' + d);
    for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.png')) names.push([f.replace(/\.png$/, ''), f]);
  }
  names.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  if (!names.length) die('no PNGs to decode in ' + (rev ? 'rev ' + rev : (dir || path.join(ROOT, 'docs/screens'))));
  for (const pair of names) {
    const buf = rev ? cp.execFileSync('git', ['show', rev + ':' + pair[1]], { cwd: ROOT, maxBuffer: 1 << 28 })
      : fs.readFileSync(path.join(dir || path.join(ROOT, 'docs/screens'), pair[1]));
    const img = pngDecode(buf, pair[0]);
    out.push({ name: pair[0], img: img, s: measure(img, STRIDE, DARK), s34: measure(img, STRIDE, DARK_ALT) });
  }
  return out;
}

function fmtRow(r) {
  return r.name.padEnd(20) + r.s.w + 'x' + r.s.h + ' '.repeat(4) +
    String(r.s.px).padStart(9) + r.s.mean.toFixed(2).padStart(8) +
    r.s.hi.map(function (p) { return p.toFixed(2).padStart(8); }).join('') +
    String(r.s.dark.count).padStart(6) + String(r.s.dark.run).padStart(6) + String(r.s.dark.start).padStart(6) +
    String(r.s34.dark.count).padStart(6) + String(r.s34.dark.run).padStart(6) + String(r.s34.dark.start).padStart(6) +
    r.s.bands.map(function (b) { return b.toFixed(1).padStart(7); }).join('');
}

function printTable(rows) {
  console.log('# tools/recap.js - stats decoded from docs/screens/*.png');
  console.log('# ' + LUMA);
  console.log('# x sampled at stride ' + STRIDE + (STRIDE === 1 ? ' (every column - N is the whole frame)' :
    ' columns, so N is the frame and the mean is over ' + rows[0].s.n + ' sampled px'));
  console.log('# a dark row is a row whose own mean luma < ' + DARK + '. That is the threshold the captions were');
  console.log('#   measured at and it reproduces both the committed files and the ones they replaced:');
  console.log('#   facing-wall 417 rows / 244-run from row 0 and 402 / 239 on its predecessor, props 343 / 277 and');
  console.log('#   337 / 277. Threshold 20 reads 361 / 232 and 305 / 274, threshold 34 reads 535 / 298 and 441 / 325,');
  console.log('#   so the "luminance 20" a caption prints is a label, not the bar its numbers came from.');
  console.log('# both dark blocks report the count, the longest contiguous run and that run\'s first row; a band');
  console.log('# mean is the mean of the row means of ' + rows[0].s.h + '/3 rows');
  const cols = [['file', 20], ['size', 12], ['N', 9], ['mean', 8], ['>=240', 8], ['>=200', 8],
    ['rows', 6], ['run', 6], ['start', 6], ['rows', 6], ['run', 6], ['start', 6],
    ['top', 7], ['mid', 7], ['bot', 7]];
  let head = '';
  for (const c of cols) head += c[0].padStart(c[1]);
  console.log(head);
  console.log(' '.repeat(20 + 12 + 9 + 8 + 8 + 8) + ('(luma < ' + DARK + ')').padEnd(18) + ('(luma < ' + DARK_ALT + ')'));
  for (const r of rows) console.log(fmtRow(r));
}

/* --------------------------------------------------------------- README gate */

function num(s) { return parseFloat(s); }

function readReadme() {
  const p = process.env.README || path.join(ROOT, 'README.md');
  if (!fs.existsSync(p)) die('no README at ' + p);
  return fs.readFileSync(p, 'utf8');
}

function embeds(text) {
  const out = [];
  const re = /!\[[^\]]*\]\(docs\/screens\/([^)"#]+)\.png\)/g;
  let m;
  while ((m = re.exec(text))) out.push({ name: m[1], at: m.index });
  return out;
}

// "<N> of <M> rows average under|below luminance <T>" plus, in the same sentence, the longest run.
function captionStats(text, emb) {
  const rows = [];
  const sre = /(\d+)(?: of (\d+))? rows average (?:under|below) luminance (\d+)/g;
  let m;
  while ((m = sre.exec(text))) {
    let owner = null;
    for (const im of emb) if (im.at < m.index && (!owner || im.at > owner.at)) owner = im;
    if (!owner) continue;
    const rn = /longest unbroken run is (\d+) rows,? (?:starting at|from) row (\d+)/.exec(text.slice(m.index, m.index + 320));
    rows.push({ name: owner.name, at: m.index, count: +m[1], total: m[2] ? +m[2] : null, thr: +m[3],
      run: rn ? +rn[1] : null, start: rn ? +rn[2] : null });
  }
  return rows;
}

function decodeLists(text) {
  const out = [];
  const re = /decode to \*\*([0-9][0-9. \/]*)\*\*/g;
  let m;
  while ((m = re.exec(text))) out.push({ at: m.index, vals: m[1].split('/').map(function (s) { return num(s.trim()); }) });
  return out;
}

function checkMode(rows) {
  const txt = readReadme();
  const fails = [], notes = [];
  const byName = {};
  let nrows = 0;
  for (const r of rows) byName[r.name] = r;

  // Vacuity first: a run that decoded nothing, or decoded something that is not a page screenshot,
  // is a FAILURE - it must never print as an empty table that passes (#235, AGENTS.md).
  if (!rows.length) { console.log('RECAP-VACUOUS no PNG decoded - nothing was measured'); return 1; }
  for (const r of rows) {
    const ok = r.s.px >= 200000 && r.s.h >= 200 && r.s.mean > 0 && r.s.mean < 255;
    console.log((ok ? 'ok      ' : 'VACUOUS ') + r.name.padEnd(20) + 'decodes to ' + r.s.w + 'x' + r.s.h +
      ', ' + r.s.px + ' px, mean ' + r.s.mean.toFixed(2));
    nrows++;
    if (!ok) { console.log('RECAP 1 FAILURE(S) of ' + nrows + ' rows - vacuity is a failure, not a pass'); return 1; }
  }

  const emb = embeds(txt);
  // An embed with no file behind it, or a file no caption embeds: both are the same hole as a
  // table with no rows in it.
  for (const e of emb) if (!byName[e.name]) {
    console.log('MISMATCH ' + e.name.padEnd(20) + 'README embeds docs/screens/' + e.name + '.png, which does not decode');
    fails.push('README embeds ' + e.name + '.png, which does not decode');
  }
  for (const r of rows) {
    const hit = emb.some(function (e) { return e.name === r.name; });
    console.log((hit ? 'ok      ' : 'MISMATCH') + ' ' + r.name.padEnd(20) + 'embedded in README.md: ' + hit);
    nrows++;
    if (!hit) fails.push(r.name + '.png is in the tree and no caption embeds it');
  }

  // Field 1 - mean. Order = the order the images are embedded in the README.
  const order = emb.filter(function (e, i) { return emb.findIndex(function (x) { return x.name === e.name; }) === i; })
    .map(function (e) { return e.name; });
  const lists = decodeLists(txt).filter(function (l) { return l.vals.length === rows.length; });
  if (!lists.length) {
    console.log('RECAP-VACUOUS README.md quotes no `decode to` list with ' + rows.length + ' values');
    return 1;
  }
  for (const l of lists) {
    for (let i = 0; i < l.vals.length; i++) {
      const nm = order[i], r = byName[nm];
      nrows++;
      if (!r) { console.log('MISMATCH value ' + (i + 1) + ' of the list at char ' + l.at + ' maps to no decodable file'); fails.push('unmappable decode list'); continue; }
      const d = Math.abs(l.vals[i] - r.s.mean), ok = d <= MEAN_TOL;
      console.log((ok ? 'ok      ' : 'MISMATCH') + ' ' + nm.padEnd(20) + 'mean   README ' + l.vals[i].toFixed(2).padStart(7) +
        '  file ' + r.s.mean.toFixed(2).padStart(7) + '  d ' + d.toFixed(3) + (ok ? '' : ' > tol ' + MEAN_TOL) + '  (list @' + l.at + ')');
      if (!ok) fails.push(nm + ' mean quoted ' + l.vals[i].toFixed(2) + ', the file decodes ' + r.s.mean.toFixed(2));
    }
  }
  for (let i = 1; i < lists.length; i++) {
    const same = lists[i].vals.every(function (v, k) { return Math.abs(v - lists[0].vals[k]) <= MEAN_TOL; });
    console.log((same ? 'ok      ' : 'MISMATCH') + ' (self)              README\'s ' + lists.length +
      ' decode lists agree' + (same ? '' : ' - list ' + (i + 1) + ' at char ' + lists[i].at + ' differs'));
    nrows++;
    if (!same) fails.push('README.md quotes two different decode sets for the same files');
  }

  // Field 2 - per-caption row statistics, at the tool's threshold (see the header convention).
  const stats = captionStats(txt, emb);
  if (!stats.length) { console.log('RECAP-VACUOUS README.md quotes no row statistics at all'); return 1; }
  const labels = {};
  for (const q of stats) {
    const r = byName[q.name];
    if (!r) { console.log('MISMATCH ' + q.name.padEnd(20) + 'caption quotes rows, no such PNG decodes'); fails.push(q.name + ': rows quoted, file missing'); continue; }
    const cmp = [['rows', q.count, r.s.dark.count]];
    if (q.run !== null) cmp.push(['run ', q.run, r.s.dark.run], ['start', q.start, r.s.dark.start]);
    else notes.push(q.name + ': the caption counts dark rows but names no run, so run/start are not gated there');
    for (const c of cmp) {
      const ok = c[1] === c[2];
      console.log((ok ? 'ok      ' : 'MISMATCH') + ' ' + q.name.padEnd(20) + c[0] + '   README ' + String(c[1]).padStart(7) +
        '  file ' + String(c[2]).padStart(7) + '   (rows with mean luma < ' + DARK + ' of ' + r.s.h + ')');
      nrows++;
      if (!ok) fails.push(q.name + ' ' + c[0].trim() + ' quoted ' + c[1] + ', the file says ' + c[2] + ' at threshold ' + DARK);
    }
    if (q.thr !== DARK) labels[q.thr] = (labels[q.thr] || 0) + 1;
  }
  console.log('note                   gated: the ' + rows.length + ' means and the row statistics; printed and not gated:' +
    ' the >=240 / >=200 shares and the band means, which the captions quote beside canvas numbers');
  for (const k in labels) notes.push(labels[k] + ' caption(s) label the threshold ' + k + ', the tool measures at ' + DARK);
  for (const n of notes) console.log('note                   ' + n);
  console.log('RECAP ' + fails.length + ' FAILURE(S) of ' + nrows + ' rows' + (notes.length ? ', ' + notes.length + ' note(s)' : ''));
  return fails.length ? 1 : 0;
}

/* --------------------------------------------------------------------- main */

module.exports = { pngDecode: pngDecode, measure: measure };

if (require.main === module) main();

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] === 'check' ? 'check' : 'stats';
  let rev = null;
  for (const a of argv) if (a.indexOf('--rev=') === 0) rev = a.slice(6);
  let rows = [];
  try { rows = loadAll(rev, process.env.DIR); }
  catch (e) {
    console.log('RECAP-VACUOUS ' + e.message);
    console.log('RECAP 1 FAILURE(S), nothing decoded - vacuity is a failure, not a pass');
    process.exit(1);
  }
  if (rows.length) printTable(rows);
  if (mode === 'check') console.log('');
  process.exit(mode === 'check' ? checkMode(rows) : 0);
}
