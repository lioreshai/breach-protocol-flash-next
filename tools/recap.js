'use strict';
/*
 * tools/recap.js - print the capture-caption table and the capture provenance from the committed PNGs
 * (#235, #335).
 *
 * Zero dependencies, no build step: the PNG is decoded here (chunk walk + zlib.inflateSync +
 * the five scanline filters) because node core has no image decoder and adding one is not
 * allowed. Everything the captions quote off a screenshot is printed from the bytes, so a
 * capture PR that forgets to regenerate the prose shows up as a diff in this table instead of
 * as a sentence that quietly stops being true.
 *
 *   node tools/recap.js                 table for docs/screens/*.png in the working tree
 *   node tools/recap.js --rev=<sha>     same table for the blobs committed at <sha>
 *   node tools/recap.js check           gate: README.md's quoted numbers + provenance vs. the files
 *   node tools/recap.js --record        add rows for PNGs whose bytes have no row yet (it can fill
 *                                       the byte-addressed fields - sha256, canvas - and NOTHING
 *                                       about the deal: seed/layout/url/route are written by the
 *                                       session that took the shot, `check` then refuses a null)
 *
 * Env knobs (defaults are what `check` uses): STRIDE=n x-sampling step (default 1, every
 * column), DARK=n dark-row threshold (default 24), DARK_ALT=n second threshold printed (34),
 * DIR=path, README=path, PROV=path (the provenance artifact).
 *
 * Provenance (#335), because a caption that quotes a mean and a seed cannot be re-measured unless
 * the instrument that made the pixels is named too: docs/screens/provenance.json carries one row
 * per PNG, written AT CAPTURE TIME, and `check` verifies it offline against the bytes it decodes -
 * no browser, no network, no re-derivation of DEV.state().layout from a live page. The finding it
 * encodes is that "seed 60" is not one instrument: `open` of the deployed https URL dealt
 * 735688443 across reloads, while the investigating harness - which installed DEV by hash on a
 * file:// page because its `open` dropped the query - dealt 3443423558, 1707513801 and 1284359329
 * for the same typed URL. So a row states origin + install + url + seed + level + layout, and the
 * vocabulary in ORIGINS/INSTALLS below carries the verdict, at the one site the compare reads.
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
 *   claim   - what the capture-pass paragraph states about the bind, against what this checkout's
 *            shipped bytes say (#653). See `captionBind`.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
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
    // sha256 of the bytes that were decoded, so a provenance row addresses THIS frame and cannot be
    // carried over a recapture (a shot is only re-measurable if the claim is tied to the pixels).
    out.push({ name: pair[0], img: img, sha: crypto.createHash('sha256').update(buf).digest('hex'),
      s: measure(img, STRIDE, DARK), s34: measure(img, STRIDE, DARK_ALT) });
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
    // `rows?` because a run of one is written "1 row" in English: a caption that says so is still a
    // claim about a run and its first row, and dropping it here silently un-gates two rows (#604).
    const rn = /longest unbroken run is (\d+) rows?,? (?:starting at|from) row (\d+)/.exec(text.slice(m.index, m.index + 320));
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

/* -------------------------------------------------------------------- deltas */

/*
 * The delta between a frame and the frame it replaces (#668).
 *
 * Three front-page captions quoted a delta - "7.12 lighter than the frame it replaces", "1.16 lighter
 * than the frame he replaces", "+7.65 on the one it replaces - the largest move of the eight" - and
 * not one of them was the difference between those bytes. Two captions each claimed to be the largest
 * move. `check` gated every MEAN and every row census in the same paragraphs, so the pass that
 * re-took the frames updated the aggregate paragraph from +7.12 to +1.16 and left the caption sentence
 * thirty lines above it at 7.12. A caption is the only place these passes state what got better, and a
 * figure in one is copied onward by the next reader, so a wrong delta is not a cosmetic slip.
 *
 * The reason nothing caught it is the reason #664 filed for flatparity's means: the delta was prose.
 * So it is now a measurement with two inputs, both of which this tool can see:
 *
 *   1. the mean of the frame shipping in `docs/screens/`, decoded here from the PNG; and
 *   2. the mean of the frame it replaces, recorded on that shot's row in provenance.json as
 *      `replaces: {rev, sha256, mean}` AT THE PASS THAT SUPERSEDED IT - the same artifact that already
 *      addresses the shipping frame's bytes.
 *
 * A delta is the difference of the two means AS THE TABLE PRINTS THEM (each to two decimals), because
 * that is the arithmetic a reader holding this tool's own output can repeat; the difference of the
 * unrounded means can sit 0.01 away and the DELTA row prints both when they disagree. The delta of the
 * frame in front of you is exact, so quoting a delta from a PREVIOUS pass is the failure this gate
 * exists to make loud.
 *
 * What gates:
 *   - `DELTA-UNBOUND`  a shot row with no `replaces` block: printed and counted, promoted under STRICT.
 *     Nothing can be asserted about a delta nobody recorded, and silence is not a pass.
 *   - `DELTA-BAD`      a `replaces` block whose sha256 is not 64 hex or whose mean is not a luma: FAIL.
 *   - `DELTA-BYTES`    when the superseded blob is reachable from this checkout, its bytes are decoded
 *     and the row's `replaces.mean` is checked against them: FAIL on a disagreement. In a depth-1 CI
 *     checkout the blob is absent and that is named, not guessed at.
 *   - `DELTA`          the delta itself. Where README.md quotes one - the aggregate list, or a caption's
 *     "<s><n> on the frame it replaces" - the quoted number must equal this row. A stale delta is now a
 *     FAILURE the way a stale mean already is.
 *   - `DELTA-LARGEST`  exactly one frame may be called the largest move, and it must be the one this
 *     table says moved most in absolute value. Two captions claiming the same superlative is a FAIL.
 */
const REPL_KEY = 'replaces';
const DELTA_TOL = 0.005;
const LARGEST_RE = /largest (?:move|delta|change)(?: of the eight)?/g;
// The shapes a caption's delta takes on this page: "**+1.16** on the frame it replaces", "**−4.71** on
// the frame it replaces", "1.16 lighter than the frame he replaces", "1.63 lighter than the one it
// replaces". A bare number followed by "replaces" is NOT enough: the pit floor's caption contains
// "having gone *down* 0.57 when the roof was lit", which is a retracted claim about a DIFFERENT
// comparison, and "`floorAt` **1.00**" sits near enough to "the frame it replaces" to be read as one.
// So the connector ("on" / "lighter than" / "darker than") and the noun (frame/one/pose/seat) are both
// required, and the sign comes from the sign or from lighter/darker - #668's three stale deltas were all
// unsigned, and a parser that demanded a sign would report them as no delta at all.
const DELTA_SAY = /([+\u2212-])?\s?(\d+\.\d\d)\s*\*\*?\s*(lighter|darker)?\s*(?:than|on)\s+the\s+(?:frame|one|pose|seat)\b[^.\n]{0,60}?replac(?:es)?/g;
// The aggregate list, same convention as the decode list: one signed value per PNG, embed order.
const DELTA_LIST = /\bdeltas? (?:of|to) \*\*([-+\u2212 0-9.\/]+)\*\*/g;

function signed(s) {
  const t = String(s).trim().replace(/\u2212/g, '-');
  const m = /^([+-])?\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[2]);
  return m[1] === '-' ? -v : v;
}

function deltaLists(text) {
  const out = [];
  let m; DELTA_LIST.lastIndex = 0;
  while ((m = DELTA_LIST.exec(text))) {
    const vals = m[1].split('/').map(signed);
    if (vals.every(function (v) { return v !== null; })) out.push({ at: m.index, vals: vals });
  }
  return out;
}

// Every per-caption delta claim, attributed to the image block it sits under (the same rule captionStats uses).
function captionDeltas(text, emb) {
  const out = [];
  let m; DELTA_SAY.lastIndex = 0;
  while ((m = DELTA_SAY.exec(text))) {
    let owner = null;
    for (const im of emb) if (im.at < m.index && (!owner || im.at > owner.at)) owner = im;
    const mag = parseFloat(m[2]);
    const neg = m[1] === '-' || m[1] === '\u2212' || m[3] === 'darker';
    out.push({ name: owner ? owner.name : null, at: m.index, val: neg ? -mag : mag });
  }
  const claims = [];
  let c; LARGEST_RE.lastIndex = 0;
  while ((c = LARGEST_RE.exec(text))) {
    let owner = null;
    for (const im of emb) if (im.at < c.index && (!owner || im.at > owner.at)) owner = im;
    claims.push({ name: owner ? owner.name : null, at: c.index });
  }
  return { says: out, claims: claims };
}

// Best-effort: decode the SUPERSEDED frame from the object store, so a row's recorded replaced mean is
// checked against bytes and not only against the number typed next to it. Absent in a depth-1 checkout.
function replacedBytes(rev, name) {
  try {
    const buf = cp.execFileSync('git', ['show', rev + ':docs/screens/' + name + '.png'],
      { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    const s = measure(pngDecode(buf, name), STRIDE, DARK);
    return { sha: crypto.createHash('sha256').update(buf).digest('hex'), mean: s.mean };
  } catch (e) { return null; }
}

function deltaCheck(rows, prov, fails, notes) {
  let nrows = 0, unbound = 0, verified = 0;
  const d = {};
  if (prov.err) return { d: d, nrows: 0, unbound: 0, verified: 0 };
  for (const r of rows) {
    const e = prov.byFile[r.name];
    nrows++;
    const rep = e && e.row && e.row[REPL_KEY];
    if (!rep || !rep.rev) {
      unbound++;
      d[r.name] = null;
      console.log('DELTA-UNBOUND     ' + r.name.padEnd(20) + 'no `' + REPL_KEY + '` block on its shot row, so the delta between this '
        + 'frame and the frame it replaces is not computable here - record `{' + REPL_KEY + ': {rev, sha256, mean}}` for the '
        + 'superseded PNG in ' + PROV_REL + ' or write no delta in its caption'
        + (process.env.STRICT ? '' : ' (STRICT=1 gates this row)'));
      if (process.env.STRICT) fails.push(r.name + ': a caption-era delta with no replaced-frame mean recorded');
      continue;
    }
    if (typeof rep.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rep.sha256)) {
      d[r.name] = null; nrows++;
      console.log('DELTA-BAD         ' + r.name.padEnd(20) + '`' + REPL_KEY + '.sha256` is ' + JSON.stringify(rep.sha256) +
        ', not the 64 hex digits that address the superseded bytes');
      fails.push(r.name + ': ' + REPL_KEY + '.sha256 is not a sha256');
      continue;
    }
    if (typeof rep.mean !== 'number' || !(rep.mean > 0 && rep.mean < 255)) {
      d[r.name] = null; nrows++;
      console.log('DELTA-BAD         ' + r.name.padEnd(20) + '`' + REPL_KEY + '.mean` is ' + JSON.stringify(rep.mean) +
        ', not a luma, so the delta this row feeds to the captions is not a measurement');
      fails.push(r.name + ': ' + REPL_KEY + '.mean is not a luma');
      continue;
    }
    const now = Math.round(r.s.mean * 100) / 100, was = Math.round(rep.mean * 100) / 100;
    const dRound = Math.round((now - was) * 100) / 100, dExact = r.s.mean - rep.mean;
    d[r.name] = { now: now, was: was, d: dRound, exact: dExact, claims: [] };
    // Verify the replaced mean against the superseded bytes when this checkout still has them.
    nrows++;
    const got = replacedBytes(String(rep.rev), r.name);
    if (!got) {
      notes.push(r.name + ': the superseded frame at ' + rep.rev + ' is not in this checkout, so `'
        + REPL_KEY + '.mean` was taken as recorded (a depth-1 checkout cannot read it)');
    } else if (got.sha !== rep.sha256) {
      console.log('DELTA-BYTES       ' + r.name.padEnd(20) + 'the PNG at ' + rep.rev + ':' + r.name + '.png is ' + got.sha.slice(0, 12) +
        ' and the row addresses ' + rep.sha256.slice(0, 12) + ' - the block describes bytes that are not the frame this one replaces');
      fails.push(r.name + ': ' + REPL_KEY + ' addresses bytes other than ' + rep.rev + ':' + r.name + '.png');
    } else if (Math.abs(got.mean - rep.mean) > DELTA_TOL) {
      console.log('DELTA-BYTES       ' + r.name.padEnd(20) + 'the frame it replaces decodes ' + got.mean.toFixed(4) +
        ' and the row records ' + rep.mean.toFixed(4) + ' - the delta the captions quote is off by '
        + Math.abs(got.mean - rep.mean).toFixed(4));
      fails.push(r.name + ': replaced-frame mean recorded ' + rep.mean.toFixed(2) + ', those bytes decode ' + got.mean.toFixed(2));
    } else {
      verified++;
    }
    console.log((got && got.sha === rep.sha256 && Math.abs(got.mean - rep.mean) <= DELTA_TOL ? 'ok      ' : 'DELTA         ') +
      r.name.padEnd(20) + 'delta  now ' + now.toFixed(2).padStart(7) + '  replaces ' + was.toFixed(2).padStart(7) +
      '  ' + (dRound >= 0 ? '+' : '\u2212') + Math.abs(dRound).toFixed(2).padStart(6) +
      (Math.abs(dExact - dRound) > DELTA_TOL ? '  (unrounded ' + (dExact >= 0 ? '+' : '\u2212') + Math.abs(dExact).toFixed(4) +
        ', the table rounds each mean first)' : '') +
      (got && got.sha === rep.sha256 ? '  bytes at ' + rep.rev : '  recorded at ' + rep.rev));
  }

  // The aggregate list: one value per PNG, in the order the images are embedded - the decode-list rule.
  const txt = readReadme();
  const emb = embeds(txt);
  const order = emb.filter(function (e, i) { return emb.findIndex(function (x) { return x.name === e.name; }) === i; })
    .map(function (e) { return e.name; });
  const lists = deltaLists(txt).filter(function (l) { return l.vals.length === rows.length; });
  nrows++;
  if (!lists.length) {
    console.log('DELTA-VACUOUS           README.md quotes no `deltas to **a / b / ...**` list with ' + rows.length +
      ' values while ' + (rows.length - unbound) + ' shot row(s) carry a replaced-frame mean - a page that quotes no '
      + 'delta is the quiet option, and this tool does not implement it: the deltas are computed here, so the page names them');
    fails.push('README.md quotes no per-frame delta list while provenance records replaced-frame means');
  } else {
    for (const l of lists) {
      for (let i = 0; i < l.vals.length; i++) {
        const nm = order[i], ent = d[nm];
        nrows++;
        if (!ent) { console.log('DELTA-UNBOUND     ' + nm.padEnd(20) + 'the delta list at char ' + l.at + ' quotes ' + l.vals[i].toFixed(2) + ' for a frame with no replaced-frame mean'); fails.push(nm + ': a delta quoted with nothing to compute it from'); continue; }
        const ok = Math.abs(l.vals[i] - ent.d) <= DELTA_TOL;
        console.log((ok ? 'ok      ' : 'MISMATCH') + ' ' + nm.padEnd(20) + 'delta  README ' + l.vals[i].toFixed(2).padStart(7) +
          '  table ' + ent.d.toFixed(2).padStart(7) + '  d ' + Math.abs(l.vals[i] - ent.d).toFixed(3) + (ok ? '' : ' > tol ' + DELTA_TOL) + '  (list @' + l.at + ')');
        if (!ok) fails.push(nm + ' delta quoted ' + l.vals[i].toFixed(2) + ', its two means give ' + ent.d.toFixed(2));
      }
    }
  }

  // The per-caption sentences, and the superlative.
  const cs = captionDeltas(txt, emb);
  for (const s of cs.says) {
    nrows++;
    if (!s.name) { console.log('DELTA-ORPHAN          a delta sentence at char ' + s.at + ' sits under no image, so nothing says which frame it is about'); fails.push('a delta sentence with no frame above it'); continue; }
    const ent = d[s.name];
    if (!ent) { console.log('DELTA-UNBOUND     ' + s.name.padEnd(20) + 'quotes a delta of ' + s.val.toFixed(2) + ' on a frame whose row carries no replaced-frame mean, so nothing computes it'); fails.push(s.name + ': a caption delta with no replaced-frame mean'); continue; }
    else {
      const ok = Math.abs(s.val - ent.d) <= DELTA_TOL;
      console.log((ok ? 'ok      ' : 'MISMATCH') + ' ' + s.name.padEnd(20) + 'delta  README ' + s.val.toFixed(2).padStart(7) +
        '  table ' + ent.d.toFixed(2).padStart(7) + '  d ' + Math.abs(s.val - ent.d).toFixed(3) + '  (caption @' + s.at + ')');
      if (!ok) fails.push(s.name + ': its caption quotes ' + s.val.toFixed(2) + ' and its own two means give ' + ent.d.toFixed(2) + ' - the sentence is a previous pass\'s delta');
      ent.claims.push(s.val);
    }
  }
  for (const s of cs.says) if (d[s.name]) d[s.name].quoted = s.val;
  let largestName = null, largestAbs = -1;
  for (const k in d) if (d[k] && Math.abs(d[k].d) > largestAbs) { largestAbs = Math.abs(d[k].d); largestName = k; }
  for (const c of cs.claims) {
    nrows++;
    if (!c.name) { console.log('DELTA-LARGEST         a "largest move" claim at char ' + c.at + ' sits under no image and so names no frame'); fails.push('a largest-move claim with no frame above it'); continue; }
    const ent = d[c.name];
    if (!ent) { console.log('DELTA-LARGEST     ' + c.name.padEnd(20) + 'claims the largest move with no replaced-frame mean to rank it on'); fails.push(c.name + ': largest-move claim with no delta'); continue; }
    if (c.name !== largestName) {
      console.log('DELTA-LARGEST     ' + c.name.padEnd(20) + 'is called the largest move of the eight at char ' + c.at + ' and its own delta is ' +
        ent.d.toFixed(2) + ', while ' + largestName + ' moved ' + (d[largestName].d >= 0 ? '+' : '\u2212') + Math.abs(d[largestName].d).toFixed(2));
      fails.push(c.name + ': called the largest move, ' + largestName + ' moved further (' + ent.d.toFixed(2) + ' vs ' + d[largestName].d.toFixed(2) + ')');
    } else {
      ent.superl = true;
      console.log('ok      DELTA-LARGEST ' + c.name.padEnd(20) + 'is the page\'s one largest-move claim and it is the frame whose delta is largest (' +
        ent.d.toFixed(2) + ')');
    }
  }
  return { d: d, nrows: nrows, unbound: unbound, verified: verified, largest: largestName, claims: cs.claims.length };
}

/* ---------------------------------------------------------------- provenance */

// The whole vocabulary of instruments, and the only place the verdicts are written. Everything the
// tool says about a route is read from these two tables, so a row cannot gain a milder label by
// rewording itself, and a fourth instrument has to be declared here before a shot can claim it.
// The verdicts are #335's measurements, not judgements.
const ORIGINS = {
  https: { verdict: 'ok', why: 'the deployed page keeps the query string, so the URL the operator opened is the URL js/90_dev.js:23 reads' },
  file: { verdict: 'DECLINE', why: 'file:// dropped the query in the harness whose three deals this issue records, so DEV was never installed by the URL that names the seed' }
};
const INSTALLS = {
  'url-open': { verdict: 'BIND', why: 'open <url> on the deployed page: #335 reloaded ?dev=1&seed=60 and read layout 735688443 twice' },
  'in-page-nav': { verdict: 'REPORT', why: 'location change + reload on an https page: the reader regex does see ?seed=, but no measurement in this repo binds a deal to this route' },
  'hash': { verdict: 'REPORT', why: 'DEV installed from a #...&seed= fragment: the regex at js/90_dev.js:23 accepts it, and the route that produced three deals for one "seed 60" is this family' }
};
const PROV_REL = 'docs/screens/provenance.json';
const URL_SEED = /[?&#]seed=(-?\d+)/;      // js/90_dev.js:23 - the seed the running page actually reads

/*
 * The deal's third term (#404). A seeded live boot advances the seeded stream through the audio
 * buffer BEFORE the generator runs: DEV.boot() -> startGame() runs SND.init() ahead of
 * startLevel(0, true) (js/90_dev.js:60, js/50_ui_input.js:59-60) and SND.init fills its noise buffer
 * with Math.floor(ac.sampleRate * 1.5) draws from that same stream (js/00_core.js:95-96). So
 * (seed, level) is not the whole key that identifies a world - one URL deals one level PER AUDIO
 * DEVICE, 66,150 draws at 44.1 kHz against 72,000 at 48 kHz - and a row that names only a seed
 * binds a deal on the machine that took it, not on the next one. A row therefore states
 * `sampleRate`: the integer SND.ac.sampleRate read at capture time, or null when the capture did not
 * read it. null is a NAMED, COUNTED qualification (PROVENANCE-DEVICE), never silence: it says the
 * binding below is per-machine and STRICT=1 gates it. `--record` cannot invent it.
 *
 * A row's `layout` has three terms beyond (seed, level), and the printed row names them so a reader
 * cannot over-read the binding. The page DOES pin the dice: ?dev=1&seed=<int> installs mulberry over
 * Math.random before anything generates (js/90_dev.js:26), and says so in its own report - DEV.seed
 * (js/90_dev.js:500) and the `[DEV] seed <n> (mulberry)` boot marker (js/90_dev.js:506). So opening a
 * row's url re-deals that row's layout, and #335 measured exactly that (`url-open` above). The three
 * terms are:
 *   1. the audio device, this row's own term - see HW_WHY;
 *   2. ONE BOOT PER PAGE LOAD. The pin is installed once, when the script loads, so a second
 *      DEV.boot() inside the same page load draws from the advanced stream and deals something else
 *      (js/90_dev.js:21-22). Measured on the deployed build for #431: two page loads of one url each
 *      read the same level-0 layout, and a second in-page DEV.boot() read a different layout, twice.
 *      That is a ROUTE rule - reload the url, do not boot twice - not missing shipped code, and the
 *      `seedRng` ReferenceError some sessions read as proof of a missing pin is only the name of a
 *      harness global (tools/view.js:311) that the page has no reason to define.
 *   3. the BUILD. The generator's draw count moves between builds, so a layout belongs to the build
 *      its row names, not to the url alone. A capture session that measures a newer build re-dealing
 *      writes `staleByBuild` on its rows; `check` PRINTS and COUNTS that label and never gates it -
 *      from a checkout this tool cannot know what any deploy deals.
 */
const STALE_FIELD = 'staleByBuild';   // prose: which build this layout was measured stale against

/*
 * The build's second term (#536). A row's `build` names a commit, and from a checkout this tool
 * cannot say whether that commit still ships: CI's checkout is depth 1 (actions/checkout@v4 with no
 * fetch-depth, so there is no history to diff) and the deploy is another machine. That gap is how
 * #468, #478, #431 and #536 were each filed: the front page's frames bound a build, render commits
 * landed, and the pictures quietly described a game that no longer shipped.
 *
 * What IS local and decisive is the bytes that draw a frame. `builds` records, per build a row names,
 * the sha256 of the shipped blobs a capture pass proves off the wire one blob at a time - index.html
 * plus the three files that put any pixel on screen: js/10_assets.js makes the textures, js/20_level.js
 * the lit materials, js/40_render.js is the rasterizer. `check` recomputes them from this tree. All
 * equal: these frames show what this checkout ships. Unequal: a blob that draws a frame moved, so the
 * frames show the picture the OLD blob drew - named per file, not as a sentence.
 *
 * This is an UPPER bound on "the picture changed": a comment inside js/40_render.js moves a digest and
 * moves no pixel. That is why the row prints and counts by default and gates only under STRICT=1 - the
 * promotion path this repo already uses for a new gate, so the debt shows in the verdict line before it
 * shows in anyone's way. It widens no threshold and does not replace `staleByBuild`, which is a capture
 * session's measurement of what a DEPLOY deals; this is a checkout's measurement of what its own bytes
 * draw.
 */
const SHIP_FILES = ['index.html', 'js/10_assets.js', 'js/20_level.js', 'js/40_render.js'];
const BUILDS_KEY = 'builds';
const PROVENANCE_HINT = 'provenance.json records no shipped-bytes digest for it, so nothing here can say whether those '
  + 'frames still show what ships (add builds[<build>].files = the sha256 of ' + SHIP_FILES.join(' + ') + ' at that build)';

function shipDigests(rev) {
  const out = {};
  for (const f of SHIP_FILES) {
    try {
      const buf = rev ? cp.execFileSync('git', ['show', rev + ':' + f], { cwd: ROOT, maxBuffer: 1 << 26 })
        : fs.readFileSync(path.join(ROOT, f));
      out[f] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) { out[f] = null; }
  }
  return out;
}

/*
 * One row per distinct build named by the shot rows. A row that names no build, a build the artifact
 * records no digests for, and a build whose shipped blobs differ from this tree are three different
 * sentences and print as three different labels; none of them is silence. Under STRICT=1 all three fail
 * - that is the gate promoted - and by default they are counted in the verdict line.
 */
function buildCheck(prov, fails, notes) {
  const STRICT = !!process.env.STRICT;
  const rev = prov.rev || null;
  let nrows = 0, bound = 0, drift = 0;
  if (prov.err) return { nrows: 0, bound: 0, drift: 0 };
  const builds = prov[BUILDS_KEY] || {};
  const named = [];
  for (const s of prov.shots) if (named.indexOf(s.build) < 0) named.push(s.build);
  const here = shipDigests(rev);
  const src = rev ? 'rev ' + rev : 'this checkout';
  for (const b of named) {
    nrows++;
    if (b === null || b === undefined) {
      console.log('SHIP-UNBOUND      (no build)  a shot row names no build, so nothing states which shipped bytes drew '
        + 'those pixels - the sha256 says which PNG this is, not which game' + (STRICT ? '' : ' (STRICT=1 gates this row)'));
      drift++;
      if (STRICT) fails.push('a provenance row names no build');
      continue;
    }
    const rec = builds[b];
    if (!rec || !rec.files) {
      console.log('SHIP-UNBOUND      ' + String(b).padEnd(12) + PROVENANCE_HINT + (STRICT ? '' : ' (STRICT=1 gates this row)'));
      drift++;
      if (STRICT) fails.push('build ' + b + ' has no shipped-bytes digest in ' + PROV_REL);
      continue;
    }
    const unreadable = SHIP_FILES.filter(function (f) { return !here[f]; });
    if (unreadable.length) {
      nrows++;
      console.log('SHIP-UNREADABLE   ' + String(b).padEnd(12) + 'cannot read ' + unreadable.join(' ') + ' at ' + src +
        ' - the compare did not run, which is a named gap and not a pass');
      notes.push('the shipped-bytes compare could not read ' + unreadable.join(' ') + ' at ' + src);
      continue;
    }
    const moved = SHIP_FILES.filter(function (f) { return rec.files[f] !== here[f]; });
    if (!moved.length) {
      bound++;
      console.log('ok      SHIP-BIND     ' + String(b).padEnd(12) + 'the four blobs that draw a frame are byte-identical in '
        + src + ' - these frames show what ships here (' + SHIP_FILES.join(', ') + ')');
      continue;
    }
    drift++;
    console.log('FRAME-STALE       ' + String(b).padEnd(12) + moved.length + ' of ' + SHIP_FILES.length +
      ' shipped blob(s) that draw a frame differ between build ' + b + ' and ' + src + ': ' + moved.join(', ') +
      ' - every frame bound to ' + b + ' shows the picture the old blob drew, so a re-take off a deploy of ' + src +
      ' is owed' + (STRICT ? '' : ' (printed; STRICT=1 gates it)'));
    if (STRICT) fails.push('frames bound to build ' + b + ' while ' + moved.join(' ') + ' moved since');
  }
  return { nrows: nrows, bound: bound, drift: drift };
}

/*
 * The capture-pass paragraph's own claims (#653).
 *
 * `buildCheck` measures the bind from this checkout's bytes and prints `SHIP-BIND` or `FRAME-STALE`.
 * The paragraph in README.md that describes a pass states the same fact twice over, in prose: which
 * build the eight frames were taken at, and that on the tree carrying them the bind row reads
 * `SHIP-BIND`, so the front page is today's picture. A pass before #651 left that prose describing the
 * pass before it - the rows had been rekeyed to a new build and the paragraph still named the old one
 * and still said no re-take was owed - which is #653, and the same shape had happened one build
 * earlier. It survived a merge because of where the check sits: the row that knows the answer is
 * printed and gates only under STRICT=1, so a blocking step runs green while the sentence above it is
 * false.
 *
 * So the sentence is read and compared rather than trusted.
 *   1. Which build does the paragraph name as the one these frames were taken at? If the shot rows bind
 *      a different build, that is a FAILURE with no threshold in it: two checked-in files state two
 *      different facts about the same pixels, and exactly one of them can be true.
 *   2. Does the paragraph assert that the bind HOLDS (it reads `SHIP-BIND`, the blobs are identical,
 *      no re-take is owed) for a build whose shipped blobs this checkout says moved? That is #653's
 *      shape. It counts by default and gates under STRICT=1, the promotion path `FRAME-STALE` itself
 *      uses - because the assertion is true on the tree a capture pass lands on and ages on the next
 *      commit that moves a shipped byte, and a comment-only change to a renderer moves a digest and
 *      moves no pixel. The age is the debt; the row names it.
 * A paragraph that states neither is printed as a note and is not a failure: the README's own rule at
 * "a byte claim written here is false by the next merge (#395)" recommends saying less, so a claim
 * removed is the recommended state, not a hole. It is printed, because a deleted claim and a checked
 * claim are different pages and only one of them is green in this table.
 */
const CAP_BUILD = /deployed page at build\s+`([0-9a-f]{7,40})`/;
const CAP_VERDICT = /reads\s+`(SHIP-BIND|FRAME-STALE)`\s+for\s*`?([0-9a-f]{7,40})?/;
const CAP_FRESH = /no re-take is owed|today\'s picture|the front page is today/i;
// A freshness phrase only asserts the bind where the paragraph is talking about the bound build. The
// window is around the build mention in the whitespace-flattened page, so a stray "today's picture" in
// a sentence about the tool is not read as a claim about these pixels.
const CAP_WINDOW = 400;

function captionBind(txt, prov, fails, notes) {
  const STRICT = !!process.env.STRICT;
  let nrows = 0, debt = 0;
  if (prov.err) return { nrows: 0, debt: 0 };
  const builds = prov[BUILDS_KEY] || {};
  const bound = [];
  for (const s of prov.shots) if (s.build !== null && s.build !== undefined && bound.indexOf(s.build) < 0) bound.push(s.build);
  const flat = txt.replace(/\s+/g, ' ');
  const src = prov.rev ? 'rev ' + prov.rev : 'this checkout';

  const named = CAP_BUILD.exec(flat);
  let claimBuild = named ? named[1] : null;
  nrows++;
  if (!named) {
    notes.push('the capture-pass paragraph names no bound build, so there is nothing here for the bind row to contradict');
  } else if (!bound.length) {
    console.log('CAPTION-VACUOUS   ' + claimBuild.padEnd(12) + 'the paragraph names build ' + claimBuild + ' as the build these '
      + 'frames were taken at and no shot row names a build at all, so the compare could not run - a named gap, not a pass');
    fails.push('README names a bound build while no provenance shot row names one');
  } else if (bound.indexOf(claimBuild) < 0) {
    console.log('CAPTION-BUILD       ' + claimBuild.padEnd(12) + 'the paragraph names build ' + claimBuild + ' as the build the eight '
      + 'frames were taken at; the shot rows bind ' + bound.join('/') + ' - the front page names a build that drew none of '
      + 'the pixels under it, so one of the two files is stale prose (#653)');
    fails.push('README names build ' + claimBuild + ' while the shot rows bind ' + bound.join('/'));
  } else {
    console.log('ok      CAPTION-BUILD ' + claimBuild.padEnd(12) + 'the build the capture-pass paragraph names is the build the eight '
      + 'shot rows bind');
  }

  const v = CAP_VERDICT.exec(flat);
  if (!claimBuild && v && v[2]) claimBuild = v[2];
  const near = named ? flat.slice(Math.max(0, named.index - CAP_WINDOW), named.index + CAP_WINDOW) : '';
  const statesBind = !!v || (named && CAP_FRESH.test(near));
  nrows++;
  if (!statesBind) {
    notes.push('the capture-pass paragraph states no bind verdict, so no sentence here can be falsified by a moved blob (#395)');
    return { nrows: nrows, debt: 0 };
  }
  if (!claimBuild || !builds[claimBuild] || !builds[claimBuild].files) {
    console.log('CAPTION-UNBOUND     ' + String(claimBuild === null ? '(none)' : claimBuild).padEnd(12) + 'the paragraph states a bind '
      + 'verdict and nothing here records the shipped bytes it refers to, so the compare did not run - see SHIP-UNBOUND above');
    notes.push('a bind verdict in README.md could not be checked because the build it names has no digests in ' + PROV_REL);
    return { nrows: nrows, debt: 0 };
  }
  const rec = builds[claimBuild];
  const here = shipDigests(prov.rev || null);
  const moved = SHIP_FILES.filter(function (f) { return rec.files[f] !== here[f]; });
  // Which way does the paragraph lean, and which way do the bytes lean? Both directions of disagreement
  // are the same defect: a page written by one pass and shipped by the commits after it. #653 was the
  // first of them; a paragraph that still says "a re-take is owed" after the frames were re-taken is the
  // second, and it is just as misleading to the reader in front of it.
  const claimed = v ? v[1] : 'SHIP-BIND';
  const holds = !moved.length;
  const agrees = (claimed === 'SHIP-BIND') === holds;
  if (agrees) {
    console.log('ok      CAPTION-VERDICT ' + claimBuild.padEnd(10) + 'the paragraph reads ' + claimed + ' for build ' + claimBuild +
      ', which is what ' + src + '\'s bytes say too (' + (holds ? SHIP_FILES.join(', ') + ' all agree, so no re-take is owed here'
        : moved.length + ' of ' + SHIP_FILES.length + ' differ: ' + moved.join(', ') + ', so a re-take is owed here)'));
  } else if (claimed === 'SHIP-BIND') {
    debt++;
    console.log('CAPTION-STALE       ' + claimBuild.padEnd(12) + 'the paragraph states the bind holds for build ' + claimBuild +
      ' while ' + moved.length + ' of ' + SHIP_FILES.length + ' shipped blob(s) that draw a frame differ in ' + src + ': ' +
      moved.join(', ') + ' - the front page says these frames are the picture it ships and the bind row says a re-take is owed; '
      + 'the paragraph is one commit behind its own table' + (STRICT ? '' : ' (printed; STRICT=1 gates it)'));
    if (STRICT) fails.push('README states the bind holds for ' + claimBuild + ' while ' + moved.join(' ') + ' moved since');
  } else {
    debt++;
    console.log('CAPTION-FRESH       ' + claimBuild.padEnd(12) + 'the paragraph reads ' + claimed + ' for build ' + claimBuild +
      ' while all ' + SHIP_FILES.length + ' shipped blobs that draw a frame are byte-identical in ' + src + ' - the front page '
      + 'says a re-take is owed when the bind row says it is not, which is the same drift in the other direction'
      + (STRICT ? '' : ' (printed; STRICT=1 gates it)'));
    if (STRICT) fails.push('README reads FRAME-STALE for ' + claimBuild + ' while every shipped blob still matches it');
  }
  return { nrows: nrows, debt: debt };
}

const HW_FIELD = 'sampleRate';
const HW_WHY = 'one seed deals one level per audio device: SND.init draws floor(sampleRate*1.5) seeded values before genLevel (#404)';
const ABOUT = 'Capture-time provenance for docs/screens/*.png (#335). One row per shot, written by the session that '
  + 'took the pixels: sha256/canvas are properties of the bytes, origin/install/url/seed/level/layout/build are '
  + 'properties of the instrument and cannot be recovered from the PNG afterwards. `node tools/recap.js check` '
  + 'verifies each row against the file it addresses and against every other row of the same (seed, level); '
  + 'the vocabulary and the route verdicts live in tools/recap.js, not here.';

function provPath() { return process.env.PROV || path.join(ROOT, PROV_REL); }

function loadProv(rev) {
  let txt;
  try {
    txt = rev ? cp.execFileSync('git', ['show', rev + ':' + PROV_REL], { cwd: ROOT, encoding: 'utf8' })
      : fs.readFileSync(provPath(rev), 'utf8');
  } catch (e) { return { err: 'no readable provenance artifact at ' + (rev ? rev + ':' : '') + PROV_REL + ' (' + e.message.split('\n')[0] + ')' }; }
  let doc;
  try { doc = JSON.parse(txt); }
  catch (e) { return { err: PROV_REL + ' is not valid JSON: ' + e.message.split('\n')[0] }; }
  if (!doc || !Array.isArray(doc.shots)) return { err: PROV_REL + ' has no `shots` array' };
  if (doc[BUILDS_KEY] !== undefined && (typeof doc[BUILDS_KEY] !== 'object' || doc[BUILDS_KEY] === null || Array.isArray(doc[BUILDS_KEY])))
    return { err: PROV_REL + ': `' + BUILDS_KEY + '` is not an object keyed by build' };
  const byFile = {};
  for (const s of doc.shots) {
    if (!s || typeof s.file !== 'string') return { err: PROV_REL + ': a shot row has no file name' };
    if (byFile[s.file]) return { err: PROV_REL + ': ' + s.file + ' has ' + (byFile[s.file].n + 1) + ' rows - one shot, one declaration' };
    byFile[s.file] = { row: s, n: 1 };
  }
  const out = { byFile: byFile, shots: doc.shots, rev: rev || null };
  if (doc[BUILDS_KEY]) out[BUILDS_KEY] = doc[BUILDS_KEY];
  return out;
}

// The instrument's verdict on a row: can this route bind a seed at all?
function routeVerdict(p) {
  const o = ORIGINS[p.origin], i = INSTALLS[p.install];
  if (!o || !i) return { kind: 'VOCAB', text: 'route ' + JSON.stringify(p.origin) + ' + ' + JSON.stringify(p.install) +
    ' is not in the declared vocabulary (origins: ' + Object.keys(ORIGINS).join('/') + ', installs: ' + Object.keys(INSTALLS).join('/') + ')' };
  if (o.verdict === 'DECLINE') return { kind: 'DECLINE', text: 'origin ' + p.origin + ': ' + o.why };
  if (i.verdict === 'DECLINE') return { kind: 'DECLINE', text: 'install ' + p.install + ': ' + i.why };
  return { kind: i.verdict, text: p.origin + ' + ' + p.install + ': ' + i.why };
}

function deal(p) {
  return 'seed ' + (p.seed === null || p.seed === undefined ? 'null' : p.seed) + ' level ' +
    (p.level === null || p.level === undefined ? 'null' : p.level) + ' layout ' +
    (p.layout === null || p.layout === undefined ? 'null' : p.layout) + ' via ' + p.origin + '/' + p.install;
}

/*
 * One row per decoded PNG: the entry must exist, must address the bytes on disk, must name a route
 * that can bind a seed, and must agree with every other shot of the same (seed, level). An entry
 * that is absent, orphaned, stale or routed through an instrument that cannot bind is a named
 * FAILURE; the only row that reports without failing is an unproven-but-declared route.
 */
function provCheck(rows, prov, fails, notes) {
  notes = notes || [];
  const STRICT = !!process.env.STRICT;
  let nrows = 0, bind = 0, report = 0, device = 0, stale = 0;
  if (prov.err) {
    console.log('PROVENANCE-ARTIFACT      ' + prov.err);
    fails.push('no usable provenance artifact - every shot in the set is undeclared');
    return { nrows: nrows + 1, bind: 0, report: 0, device: 0, stale: 0 };
  }
  const keys = {};
  for (const r of rows) {
    const e = prov.byFile[r.name];
    nrows++;
    if (!e) {
      console.log('PROVENANCE-MISSING ' + r.name.padEnd(20) + 'docs/screens/' + r.name + '.png has no row in ' + PROV_REL +
        ' - a shot nobody can re-take cannot be a verification');
      fails.push(r.name + '.png has no provenance row');
      continue;
    }
    const p = e.row;
    const v = routeVerdict(p);
    const bad = [];
    if (v.kind === 'VOCAB') bad.push(v.text);
    if (p.sha256 !== r.sha) bad.push('the row addresses ' + String(p.sha256).slice(0, 12) + ' and the file is ' + r.sha.slice(0, 12) +
      ' - this entry describes different bytes than the PNG (recapture: re-declare the deal)');
    const canvas = r.s.w + 'x' + r.s.h;
    if (p.canvas !== canvas) bad.push('the row says canvas ' + JSON.stringify(p.canvas) + ', the PNG decodes ' + canvas);
    if (p.seed === null || p.seed === undefined) bad.push('DEV.state().seed is null - an unseeded boot deals a different level every load, so this frame is an era measurement');
    if (p.level === null || p.level === undefined) bad.push('no level - (seed, level) is the key that identifies a deal');
    if (p.layout === null || p.layout === undefined) bad.push('DEV.state().layout not recorded, so nothing downstream can re-measure this shot');
    // The audio term, declared beside the compare that reads it: an integer pins the deal across
    // machines, a missing/null one says this row's binding is per-machine and is COUNTED as such.
    let hw = 'unrecorded';
    if (!(HW_FIELD in p)) bad.push('no ' + HW_FIELD + ' key - ' + HW_WHY + ', so a row that names no sample rate binds a deal on its own machine only (add ' + HW_FIELD + ': <hz> or null)');
    else if (p[HW_FIELD] === null || p[HW_FIELD] === undefined) {
      console.log('PROVENANCE-DEVICE  ' + r.name.padEnd(20) + deal(p) + ' - the deal this route binds is device-scoped: '
        + HW_WHY + ', and this capture recorded no SND.ac.sampleRate, so it reproduces on a machine that '
        + 'draws the same count, opening this url once per page load (js/90_dev.js:21-22)'
        + (STRICT ? '' : ' (STRICT=1 gates this row)'));
      device++; nrows++;
      if (STRICT) fails.push(r.name + ': a binding row with no ' + HW_FIELD);
    } else if (!Number.isInteger(p[HW_FIELD]) || p[HW_FIELD] < 8000 || p[HW_FIELD] > 192000) {
      bad.push(HW_FIELD + ' = ' + JSON.stringify(p[HW_FIELD]) + ' is not an AudioContext sample rate (an integer of 8000..192000 Hz)');
    } else hw = p[HW_FIELD] + 'Hz';
    const m = URL_SEED.exec(String(p.url || ''));
    if (!m) bad.push('the url names no seed=, so the page cannot have read one');
    else if (p.seed !== null && p.seed !== undefined && (m[1] | 0) !== (p.seed | 0) && (parseInt(m[1], 10) >>> 0) !== (p.seed >>> 0))
      bad.push('the url carries seed=' + m[1] + ' and the row claims seed ' + p.seed);
    if (bad.length || v.kind === 'DECLINE') {
      console.log((v.kind === 'DECLINE' ? 'PROVENANCE-ROUTE   ' : 'PROVENANCE-BAD     ') + r.name.padEnd(20) + deal(p) +
        (v.kind === 'DECLINE' ? '\n' + ' '.repeat(21) + 'route declined - ' + v.text : '') +
        bad.map(function (b) { return '\n' + ' '.repeat(21) + '- ' + b; }).join(''));
      fails.push(r.name + ': ' + (v.kind === 'DECLINE' ? 'route cannot bind the seed it claims' : 'provenance row does not hold'));
      if (v.kind === 'DECLINE') continue;
    } else if (v.kind === 'REPORT') {
      console.log('PROVENANCE-UNPROVEN' + ' ' + r.name.padEnd(20) + deal(p) + ' - route declared, not measured to bind: ' + v.text);
      report++;
    } else {
      console.log('ok      ' + r.name.padEnd(20) + deal(p) + '  bytes ' + r.sha.slice(0, 8) + '  ' + canvas +
        (p.build ? '  build ' + p.build : '') + '  deal ' + hw);
      bind++;
    }
    // Staleness is a measurement a capture session recorded, never this tool's guess: printed, counted,
    // never failed, because what a deploy deals is not readable from a checkout.
    if (p[STALE_FIELD]) {
      console.log('STALE-BUILD        ' + r.name.padEnd(20) + 'this frame is build ' + p.build + "'s deal and " + p[STALE_FIELD]);
      stale++;
    }
    if (p.seed !== null && p.seed !== undefined && p.level !== null && p.level !== undefined) {
      // Two rows of one (seed, level) are one world ONLY at one audio term: at different sample
      // rates the same seed legitimately deals two different levels (#404), so the rate is part of
      // the key this compare is allowed to call a contradiction. An unrecorded rate keys as
      // 'device-unrecorded', which still contradicts every other unrecorded row - so today's six
      // rows disagree exactly as they did before this field existed.
      const key = (p.seed >>> 0) + '/' + p.level + '/' + (Number.isInteger(p[HW_FIELD]) ? p[HW_FIELD] + 'Hz' : 'device-unrecorded');
      if (keys[key] && keys[key].layout !== p.layout) {
        console.log('PROVENANCE-DISAGREE' + ' ' + r.name.padEnd(20) + 'seed ' + (p.seed >>> 0) + ' level ' + p.level + ' deal ' + key.split('/')[2] +
          ' is layout ' + p.layout + ' here and ' + keys[key].layout + ' in ' + keys[key].row.file +
          ' - one seed at one sample rate deals one level, so one of these two shots was not taken by the route it claims');
        fails.push('seed ' + (p.seed >>> 0) + ' level ' + p.level + ' has two layouts at one audio term (' + keys[key].row.file + ' vs ' + r.name + ')');
        nrows++;
      } else if (!keys[key]) keys[key] = { layout: p.layout, row: p };
      // The one laundering path this field opens, named so it cannot be quiet: two shots of one
      // (seed, level) that declare DIFFERENT audio terms are two worlds by declaration, so the
      // DISAGREE compare above cannot see them. That is legitimate across machines and false within
      // one capture session, and offline there is nothing that tells which - so the pair is printed
      // and counted instead of passing.
      else {
        const other = Object.keys(keys).filter(function (k) {
          return k !== key && keys[k].row.seed === p.seed && keys[k].row.level === p.level;
        });
        for (const k of other) {
          console.log('PROVENANCE-SPLIT   ' + r.name.padEnd(20) + 'seed ' + (p.seed >>> 0) + ' level ' + p.level +
            ' is claimed as two deals - ' + key.split('/')[2] + ' here (layout ' + p.layout + ') and ' + k.split('/')[2] +
            ' in ' + keys[k].row.file + ' (layout ' + keys[k].layout + ') - a different sample rate re-deals one seed (#404), '
            + 'so these are two frames; on one instrument at most one of them is true');
          notes.push(r.name + ' vs ' + keys[k].row.file + ': one (seed, level) claimed at two audio terms');
          nrows++;
        }
      }
    }
  }
  for (const s of prov.shots) if (!rows.some(function (r) { return r.name === s.file; })) {
    console.log('PROVENANCE-ORPHAN  ' + String(s.file).padEnd(20) + 'a provenance row names no PNG that decodes');
    fails.push((s.file || '?') + ': provenance row with no PNG behind it');
    nrows++;
  }
  // A page load boots one level (js/90_dev.js:21-22 - one url, one boot), so a row's load label is a claim about
  // a DEAL, not about a session: two rows naming one load name one (seed, level, layout). #604's review found a
  // level-2 row whose note claimed the level-0 page load while its own level field said 2 - true in the fields,
  // false in the prose, and prose was the only place the contradiction lived. Reading the label out of the note
  // makes it a field this tool already compares. Rows naming no label are COUNTED, never failed: a label is a
  // capture convention, a contradiction is a defect.
  const loads = {};
  let labelled = 0, unlabelled = 0;
  for (const s of prov.shots) {
    const lm = /\bload ([A-Za-z])\b/.exec(String(s.note || ''));
    if (!lm) { unlabelled++; continue; }
    labelled++;
    const key = lm[1].toUpperCase();
    const d = (s.seed >>> 0) + '/' + s.level + '/' + s.layout;
    if (loads[key] && loads[key].deal !== d) {
      console.log('PROVENANCE-LOAD    ' + String(s.file).padEnd(20) + 'load ' + key + ' is claimed as ' + deal(loads[key].row) +
        ' in ' + loads[key].row.file + ' and as ' + deal(s) + ' here - one page load boots one level, so one of these two '
        + 'shots was not taken in the load its own note names');
      fails.push('load ' + key + ' is claimed as two different deals (' + loads[key].row.file + ' vs ' + s.file + ')');
      nrows++;
    } else if (!loads[key]) loads[key] = { deal: d, row: s };
  }
  notes.push('provenance: ' + labelled + ' row(s) name a page-load label and are cross-checked against every other row '
    + 'naming it, ' + unlabelled + ' name none');
  console.log('note                   provenance gated: one row per PNG, its sha256 against the bytes, its canvas against the '
    + 'decode, its url against its seed, its ' + HW_FIELD + ' against the vocabulary, and (seed, level, '
    + HW_FIELD + ') against every other shot of that deal; printed and not gated' + (STRICT ? ' (STRICT=1 gates the audio term)' : '')
    + ': an unrecorded audio term, build, at, note, which are prose about the session');
  console.log('RECAP-PROVENANCE ' + bind + ' shot(s) binding, ' + report + ' unproven-route, ' + device
    + ' device-scoped deal(s), ' + stale + ' stale-by-build(s), ' + (prov.shots.length) + ' row(s) in ' + PROV_REL);
  return { nrows: nrows, bind: bind, report: report, device: device, stale: stale };
}

function recordMode(rows) {
  const doc = (() => { try { return JSON.parse(fs.readFileSync(provPath(), 'utf8')); } catch (e) { return { about: ABOUT, shots: [] }; } })();
  const have = {};
  for (const s of doc.shots || []) have[s.file] = s;
  let added = 0, stale = 0;
  for (const r of rows) {
    const s = have[r.name];
    if (s && s.sha256 === r.sha) { console.log('ok      ' + r.name.padEnd(20) + 'row addresses these bytes - ' + deal(s)); continue; }
    if (s) {
      // The bytes moved, so the deal this row declares is addressed to a frame that no longer exists.
      // Re-addressing the sha and keeping seed/layout would turn a byte-mismatch FAILURE into a silent
      // pass as soon as anyone ran the recorder, so the claim goes with the bytes it described.
      s.sha256 = r.sha; s.canvas = r.s.w + 'x' + r.s.h; stale++;
      // staleByBuild goes with them: it is a claim about the layout the old bytes carried.
      for (const k of ['origin', 'install', 'url', 'seed', 'level', 'layout', 'build', HW_FIELD, STALE_FIELD]) s[k] = null;
      s.note = 'RE-ADDRESSED by tools/recap.js --record: the PNG bytes moved, so the deal this row carried belonged to the previous frame. Fill origin/install/url/seed/level/layout from DEV.state() at capture time - if the same route and the same URL produced these pixels, that is the same six values re-stated by hand. `check` FAILs the row until then.';
      console.log('STALE   ' + r.name.padEnd(20) + 'bytes moved; sha256+canvas re-addressed and the deal fields CLEARED:');
      console.log(' '.repeat(21) + 'the old seed/layout pair was a claim about the previous pixels, not these');
      continue;
    }
    doc.shots.push({ file: r.name, sha256: r.sha, canvas: r.s.w + 'x' + r.s.h, origin: null, install: null, url: null,
      seed: null, level: null, layout: null, build: null, [HW_FIELD]: null, at: null,
      note: 'FILL AT CAPTURE TIME - recap can derive sha256 and canvas from the PNG, nothing else; ' + HW_FIELD
        + ' comes off SND.ac.sampleRate in the page, which is what says WHICH machine this seed deals (#404)' });
    added++;
    console.log('NEW     ' + r.name.padEnd(20) + 'row added with the byte-addressed fields only; DEV.state() side is null');
  }
  doc.shots.sort(function (a, b) { return a.file < b.file ? -1 : 1; });
  // A build a row names deserves its shipped-bytes entry, or `check` can only call it unbound. The
  // digests here are THIS checkout's blobs: a capture session binds the build it proved off the wire,
  // so the entry is only honest when that proof put the deploy and this tree on the same bytes.
  const builds = doc[BUILDS_KEY] || (doc[BUILDS_KEY] = {});
  for (const s of doc.shots) {
    if (typeof s.build === 'string' && s.build && !builds[s.build]) {
      builds[s.build] = { files: shipDigests(null), note: 'sha256 of the blobs that draw a frame, read from the checkout '
        + 'that ran --record; the session that captured must prove that tree and the deploy are the same bytes (blob by blob) '
        + 'or name the build it actually proved (#536)' };
      console.log('NEW     BUILDS          ' + s.build.padEnd(12) + 'shipped-byte digests taken from this checkout for the build its rows name');
      added++;
    }
  }
  if (added || stale) {
    fs.writeFileSync(provPath(), JSON.stringify(doc, null, 2) + '\n');
    console.log('wrote ' + PROV_REL + ': ' + added + ' new row(s), ' + stale + ' re-addressed');
  }
  console.log('RECAP-RECORD ' + rows.length + ' PNG(s), ' + added + ' row(s) added, ' + stale + ' re-addressed - a null deal field is a FAILURE in `check`, never a pass');
  return 0;
}

function checkMode(rows, rev) {
  const txt = readReadme();
  const fails = [], notes = [];
  const byName = {};
  let nrows = 0;
  for (const r of rows) byName[r.name] = r;

  // Field 0 - provenance (#335). Before any caption number is compared: a caption whose pixels cannot
  // be re-taken is not made true by the number matching.
  const pv = provCheck(rows, loadProv(rev), fails, notes);
  nrows += pv.nrows;
  // Field 0b - the build's shipped bytes (#536). Provenance says which deal a frame came from; this
  // says whether the bytes that DRAW a frame still match the ones in this tree.
  const bv = buildCheck(loadProv(rev), fails, notes);
  nrows += bv.nrows;
  // Field 0c - what the paragraph SAYS about that bind (#653). buildCheck is the measurement; this is
  // the prose that describes it, twice left behind by the pass it described.
  const cb = captionBind(txt, loadProv(rev), fails, notes);
  nrows += cb.nrows;

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

  // Field 1b - the deltas between each frame and the frame it replaces (#668). Computed here from the
  // shipped PNG and the superseded frame its shot row names, so a caption's delta is a measurement and
  // not a figure carried forward from the pass before last.
  const dl = deltaCheck(rows, loadProv(rev), fails, notes);
  nrows += dl.nrows;

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
  console.log('note                   gated: the ' + rows.length + ' means, the ' + rows.length + ' deltas against the frames they replace, the row statistics and every shot\'s provenance; printed and not gated:' +
    ' the >=240 / >=200 shares and the band means, which the captions quote beside canvas numbers; the shipped-bytes bind, which '
    + 'names which frames owe a re-take without claiming any pixel moved; and the capture-pass paragraph\'s own bind claim, '
    + 'which is true on the tree a pass lands on and ages from the next shipped byte that moves');
  for (const k in labels) notes.push(labels[k] + ' caption(s) label the threshold ' + k + ', the tool measures at ' + DARK);
  for (const n of notes) console.log('note                   ' + n);
  console.log('RECAP ' + fails.length + ' FAILURE(S) of ' + nrows + ' rows, ' + pv.bind + ' shot(s) with a binding route' +
    (pv.report ? ', ' + pv.report + ' with an unproven route' : '') +
    (pv.device ? ', ' + pv.device + ' with a device-scoped deal (#404)' : '') +
    (pv.stale ? ', ' + pv.stale + ' labelled stale-by-build (a re-take off a newer deploy re-deals; the caption coordinates are inside one build)' : '') +
    ', ' + bv.bound + ' build(s) bound to this tree\'s shipped blobs' +
    (bv.drift ? ', ' + bv.drift + ' build(s) whose shipped blobs moved (frames describe a picture that no longer ships' +
      (process.env.STRICT ? '' : '; STRICT=1 gates it') + ')' : '') +
    (cb.debt ? ', ' + cb.debt + ' capture-pass sentence(s) asserting a bind this checkout\'s bytes deny' +
      (process.env.STRICT ? '' : '; STRICT=1 gates it') : '') +
    (dl.unbound ? ', ' + dl.unbound + ' frame(s) with no replaced-frame mean, so no delta is computable for them' +
      (process.env.STRICT ? '' : '; STRICT=1 gates them') : '') +
    (notes.length ? ', ' + notes.length + ' note(s)' : ''));
  return fails.length ? 1 : 0;
}

/* --------------------------------------------------------------------- main */

module.exports = { pngDecode: pngDecode, measure: measure };

if (require.main === module) main();

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] === 'check' ? 'check' : (argv.indexOf('--record') >= 0 ? 'record' : 'stats');
  let rev = null;
  for (const a of argv) if (a.indexOf('--rev=') === 0) rev = a.slice(6);
  let rows = [];
  try { rows = loadAll(rev, process.env.DIR); }
  catch (e) {
    console.log('RECAP-VACUOUS ' + e.message);
    console.log('RECAP 1 FAILURE(S), nothing decoded - vacuity is a failure, not a pass');
    process.exit(1);
  }
  if (mode === 'record') process.exit(recordMode(rows));
  if (rows.length) printTable(rows);
  if (mode === 'stats') {
    console.log('');
    console.log('# provenance (#335) - the instrument each frame came from, read from ' + PROV_REL + ', not derived here');
    provCheck(rows, loadProv(rev), []);
    buildCheck(loadProv(rev), [], []);
  }
  if (mode === 'check') console.log('');
  process.exit(mode === 'check' ? checkMode(rows, rev) : 0);
}
