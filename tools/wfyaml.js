#!/usr/bin/env node
'use strict';
/*
 * Workflow-YAML checker, run from ci.yml's required job AND from pr-guard.yml.
 *
 * Why it exists (#107): a workflow file that does not parse produces ZERO jobs, so it reports no
 * check at all - the PR shows nothing where a verdict should be, and an admin merge (which is what
 * `gh pr merge --admin` always is: it bypasses branch protection rather than satisfying it) walks
 * through the gap. The trap that caused it: a step `name:` gaining a colon-space, which a plain YAML
 * scalar cannot carry, and the whole of ci.yml went inert while every visible check read green.
 *
 * Why it is in TWO workflows and not one: a guard cannot check the file it lives in. Put the step
 * only in ci.yml and a broken ci.yml is invisible; put the step only in pr-guard.yml and a broken
 * pr-guard.yml is invisible. Invoked from both, each one reports the other breaking. That is only
 * mutual coverage, so a third failure mode is also handled here: if the parser itself is missing or
 * this file is deleted, that is a loud failure, never a silent pass.
 *
 * Parsing is necessary but not sufficient - a workflow can parse and still describe nothing that
 * runs. So each job must declare runs-on and at least one step, and no step may be a mapping with
 * neither run: nor uses:, which the runner skips while the job still passes.
 *
 * This file is the Node port of tools/wfyaml.rb (#840), which was the repository's only Ruby. Ruby
 * was chosen originally because Psych is a real YAML parser that needs no install on the runner,
 * while python's yaml is a package this repo neither carries nor installs. Node has no YAML parser,
 * so the reader below is written here, dependency-free like everything else in tools/, and is a
 * READER rather than a linter: it builds the document and then applies the rules above to the
 * document. tools/roster.js's yamlLint stays what it always was - structural only, two shapes it
 * happens to recognise - and this file is the parse.
 *
 * THE THREE TRAPS THE READER HAS TO CLEAR, all of them present in the real workflow files:
 *   - `on:` is the boolean true in YAML 1.1, so a reader that resolves *keys* loses every workflow's
 *     trigger block. Keys here are never resolved: readKey() returns the characters before the colon
 *     and nothing else. Values are resolved, and only to null, because the rules only ask whether a
 *     value is absent or empty.
 *   - `${{ matrix.x }}` opens two flow mappings if anything goes looking for one. A plain scalar in
 *     BLOCK context may contain `{`, `}`, `[`, `]` and `,` - those are indicators only in FLOW
 *     context - so a block-context value is read whole, from after the key's colon to the end of the
 *     line, and never scanned for another colon.
 *   - `run: |` carries whole shell scripts that contain lines looking exactly like `on:` and
 *     `jobs:`. A block scalar is consumed by line indentation and its body is never tokenised.
 *
 * What it does not accept, and says so loudly rather than guessing: anchors, aliases, complex
 * (`? `) keys, multiple documents in one stream, and any non-standard tag (which is the same
 * complaint Ruby's safe loader made of a tagged object: loaded but is not a plain mapping).
 *
 * `--self-test` runs the checked-in fixtures in tools/fixtures/wfyaml/ against the rules and against
 * the tree's own workflows, so this guard can be shown to fail - and to pass on an unbroken tree -
 * on a box with no workflows to break.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------------ the reader */

class YamlError extends Error {
  constructor(msg, at) { super(at ? msg + ' at ' + at : msg); this.reason = msg; this.where = at || ''; }
}
class NotMappingError extends Error {}

function newReader(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return { s: src, starts: starts };
}
function atPos(R, i) {
  let lo = 0, hi = R.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R.starts[mid] <= i) lo = mid; else hi = mid - 1; }
  return 'line ' + (lo + 1) + ', column ' + (i - R.starts[lo] + 1);
}
function fail(R, i, msg) { throw new YamlError(msg, atPos(R, i)); }
function eolAt(R, i) { const k = R.s.indexOf('\n', i); return k < 0 ? R.s.length : k; }
function colOf(R, i) {
  let lo = 0, hi = R.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R.starts[mid] <= i) lo = mid; else hi = mid - 1; }
  return i - R.starts[lo];
}
const isSpace = (c) => c === ' ' || c === '\t';

// Advance to the first column of the next line that carries content, and report its indentation.
// A blank line or a comment-only line is not content. A tab inside indentation is an error: YAML
// forbids tabs where indentation is expected, and this is the shape that silently killed ci.yml once.
function scanToContent(R) {
  // A caller can hand us a position partway along a line - a flow collection that closed before its
  // line ended - so start from the next line unless we are already at the beginning of one.
  if (R.i > 0 && R.s[Math.min(R.i, R.s.length) - 1] !== '\n') R.i = eolAt(R, Math.min(R.i, R.s.length)) + 1;
  while (true) {
    if (R.i >= R.s.length) return { eof: true, indent: -1 };
    let j = R.i;
    while (j < R.s.length && isSpace(R.s[j])) j++;
    const c = j < R.s.length ? R.s[j] : '';
    if (c === '\n') { R.i = j + 1; continue; }
    if (c === '#') { const k = R.s.indexOf('\n', j); R.i = k < 0 ? R.s.length : k + 1; continue; }
    if (c === '') { R.i = R.s.length; continue; }
    const tab = R.s.slice(R.i, j).indexOf('\t');
    if (tab >= 0) fail(R, R.i + tab, 'found a tab where indentation is expected - YAML forbids tabs in indentation');
    return { eof: false, indent: j - R.i };
  }
}
const lineText = (R, start) => R.s.slice(start, eolAt(R, start));

// Does this line open a block sequence entry? Returns the offset just past "- " or null.
function seqEntry(text) {
  if (text[0] !== '-') return null;
  if (text.length === 1) return 1;
  if (isSpace(text[1])) {
    let j = 1;
    while (j < text.length && isSpace(text[j])) j++;
    return j;
  }
  return null;
}
const isDocMarker = (text) => /^---(\s|$)/.test(text) || /^\.\.\.(\s|$)/.test(text);

// The key of a mapping line, as the CHARACTERS before its colon. Deliberately unresolved: `on:` must
// stay "on", because YAML 1.1 would turn it into the boolean true and the trigger block would vanish.
function readKey(R, start) {
  const end = eolAt(R, start);
  const c = R.s[start];
  let i = start, key = null;
  if (c === '"' || c === "'") {
    const q = readQuoted(R, i);
    i = q.next;
    key = q.s;
  } else if (c === '?') {
    fail(R, i, 'a complex ("? ") mapping key is beyond this reader');
  } else {
    i = skipProps(R, i, end);
    let j = i;
    while (j < end) {
      if (R.s[j] === '#' && j > i && isSpace(R.s[j - 1])) break;
      if (R.s[j] === ':' && (j + 1 >= end || isSpace(R.s[j + 1]))) break;
      j++;
    }
    if (j >= end) return null;
    const raw = R.s.slice(i, j).replace(/\s+$/, '');
    if (raw === '') return null;
    if (/[:[\]{},]/.test(raw)) fail(R, i, 'a plain mapping key cannot contain a flow indicator or a colon');
    key = raw;
    i = j;
  }
  let j = i;
  while (j < end && isSpace(R.s[j])) j++;
  if (R.s[j] !== ':') return null;
  if (key === null) return null;
  return { key: key, after: j + 1 };
}

// Anchors and tags are skipped where they are legal and refused where they would change the document.
function skipProps(R, i, end) {
  while (i < end) {
    while (i < end && isSpace(R.s[i])) i++;
    if (R.s[i] === '&') {
      let j = i + 1;
      while (j < end && !isSpace(R.s[j]) && R.s[j] !== ':') j++;
      if (j === i + 1) fail(R, i, 'an empty anchor');
      i = j;
    } else if (R.s[i] === '!') {
      let j = i + 1;
      while (j < end && !isSpace(R.s[j]) && R.s[j] !== ':') j++;
      const tag = R.s.slice(i, j);
      if (!/^(!!(str|int|float|bool|null|seq|map|binary|omap|pairs|set|timestamp|value|merge))?$/.test(tag))
        throw new NotMappingError('tried to load a tagged object (' + tag + ') where a plain mapping was expected');
      i = j;
    } else if (R.s[i] === '*') {
      fail(R, i, 'an alias (' + lineText(R, i).trim() + ') is beyond this reader');
    } else break;
  }
  return i;
}

// A quoted scalar, which may fold across lines the way any plain scalar may: a line break inside it
// is a space, and a backslash before the break is no space at all.
function readQuoted(R, i) {
  const q = R.s[i];
  let j = i + 1, out = '';
  while (j < R.s.length) {
    const c = R.s[j];
    if (c === '\n') {
      let k = j, breaks = 0;
      while (k < R.s.length && (R.s[k] === '\n' || isSpace(R.s[k]))) { if (R.s[k] === '\n') breaks++; k++; }
      // Folding: one break is a space, more than one is a line break. Only whether the scalar has any
      // content at all can change a verdict here, so the exact fold is not worth a spec.
      out += breaks > 1 ? '\n' : ' ';
      j = k;
      continue;
    }
    if (c === q) {
      if (q === "'" && R.s[j + 1] === "'") { out += "'"; j += 2; continue; }
      return { s: out, next: j + 1 };
    }
    if (q === '"' && c === '\\') {
      const n = R.s[j + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', "'": "'" };
      if (n === '\n') { j += 2; continue; }
      if (n === 'u' && /^[0-9a-fA-F]{4}/.test(R.s.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(R.s.slice(j + 2, j + 6), 16)); j += 6; continue; }
      out += (n in map) ? map[n] : n;
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  fail(R, i, 'unterminated quoted scalar');
}

// A plain scalar in BLOCK context: read whole to end of line, stopping only at a comment. Never
// scanned for another colon - that scan is what a plain scalar cannot survive, and is #107.
function readPlainBlock(R, i, end) {
  let j = i;
  while (j < end) {
    if (R.s[j] === '#' && j > i && isSpace(R.s[j - 1])) break;
    if (R.s[j] === ':' && (j + 1 >= end || isSpace(R.s[j + 1])))
      fail(R, j, 'mapping values are not allowed here - a plain scalar cannot carry ": " (#107)');
    j++;
  }
  return { s: R.s.slice(i, j).replace(/\s+$/, ''), next: j };
}

// `run: |` and `run: >`: content chosen by indentation, never tokenised. A shell script inside here
// contains lines that look like `on:` and `jobs:`; re-reading them as structure is the trap.
function readBlockScalar(R, i, indent) {
  const end = eolAt(R, i);
  const folded = R.s[i] === '>';
  let j = i + 1, chomp = 'clip', explicit = 0;
  for (; j < end; j++) {
    const c = R.s[j];
    if (c === '-') { chomp = 'strip'; continue; }
    if (c === '+') { chomp = 'keep'; continue; }
    if (c >= '1' && c <= '9') { if (explicit) fail(R, j, 'two explicit indentation indicators'); explicit = +c; continue; }
    if (isSpace(c)) continue;
    if (c === '#') break;
    fail(R, j, 'unexpected "' + c + '" in a block scalar header');
  }
  const want = explicit ? indent + explicit : -1;
  let p = end + 1, det = want, lines = [], sawBlank = false;
  while (p <= R.s.length) {
    const le = R.s.indexOf('\n', p), lend = le < 0 ? R.s.length : le;
    const raw = R.s.slice(p, lend);
    if (raw.trim() === '') {
      // A blank line belongs to the scalar only while the scalar is still open, so keep it and let
      // the next real line decide whether the scalar ended.
      lines.push('');
      sawBlank = true;
      if (le < 0) { p = R.s.length + 1; break; }
      p = le + 1;
      continue;
    }
    let ind2 = 0;
    while (ind2 < raw.length && raw[ind2] === ' ') ind2++;
    if (det < 0) {
      if (ind2 <= indent) break;
      det = ind2;
    }
    if (ind2 < det) break;
    lines.push(raw.slice(det));
    sawBlank = false;
    if (le < 0) { p = R.s.length + 1; break; }
    p = le + 1;
  }
  R.i = Math.min(p, R.s.length);
  // Chomping says how many line breaks the value ends with, and `keep` is the only one that has to
  // look at the blank lines it swallowed. No rule below can see the difference - the only question
  // ever asked of a `run:` is whether it has any content at all, and blank() trims - so the tail is
  // approximated here and this comment says so instead of pretending to a spec.
  let body;
  if (chomp === 'keep') {
    body = (folded ? lines.join(' ') : lines.join('\n')) + (sawBlank ? '\n' : '');
  } else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    body = folded ? lines.join(' ') : lines.join('\n');
    if (chomp === 'clip' && (body !== '' || sawBlank)) body += '\n';
  }
  return body === '' ? null : body;
}

/* flow context: the indicators really are indicators here, which is why `${{ x }}` has to be quoted
 * inside `{}` and works bare everywhere else in a workflow file. */
function skipFlowWs(R, i) {
  while (i < R.s.length) {
    if (isSpace(R.s[i]) || R.s[i] === '\n') { i++; continue; }
    if (R.s[i] === '#') { const k = R.s.indexOf('\n', i); i = k < 0 ? R.s.length : k + 1; continue; }
    break;
  }
  return i;
}
function readFlowScalar(R, i) {
  const c = R.s[i];
  if (c === '"' || c === "'") return readQuoted(R, i);
  let j = i, out = '';
  while (j < R.s.length) {
    const ch = R.s[j];
    if (ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}') break;
    if (ch === ':' && (j + 1 >= R.s.length || isSpace(R.s[j + 1]) || ',]}['.indexOf(R.s[j + 1]) >= 0)) break;
    if (ch === '#' && j > i && isSpace(R.s[j - 1])) break;
    if (ch === '\n') { out += ' '; j++; continue; }
    out += ch;
    j++;
  }
  out = out.replace(/\s+$/, '');
  return { s: out, next: j };
}
function flowNode(R, i) {
  i = skipFlowWs(R, i);
  const c = R.s[i];
  if (c === undefined || c === '}' || c === ']' || c === ',') return { v: null, next: i };
  if (c === '[' || c === '{') {
    const seq = c === '[';
    const map = new Map(), arr = [];
    i = skipFlowWs(R, i + 1);
    if (R.s[i] === (seq ? ']' : '}')) return { v: seq ? arr : map, next: i + 1 };
    while (true) {
      const k = flowNode(R, i);
      i = skipFlowWs(R, k.next);
      let value = k.v;
      if (!seq && R.s[i] === ':') {
        const v = flowNode(R, i + 1);
        i = skipFlowWs(R, v.next);
        value = v.v;
        map.set(String(k.v), value);
      } else if (seq) arr.push(value);
      else fail(R, i, 'expected ":" after a flow-mapping key');
      i = skipFlowWs(R, i);
      if (R.s[i] === ',') { i = skipFlowWs(R, i + 1); continue; }
      if (R.s[i] === (seq ? ']' : '}')) return { v: seq ? arr : map, next: i + 1 };
      fail(R, i, 'expected "," or "' + (seq ? ']' : '}') + '" to close a flow collection');
    }
  }
  const s = readFlowScalar(R, i);
  return { v: s.s === '' ? null : resolveValue(s.s), next: s.next };
}

// Values are resolved, keys are not. Only null can change a verdict here, but numbers and booleans
// resolve the way the loaders do too, so `runs-on: no` is present-but-false rather than absent and a
// `timeout-minutes: 5` is the same document either way.
function resolveValue(s) {
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON|y|Y)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF|n|N)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return parseFloat(s);
  return s;
}

function parseNode(R, minIndent) {
  const st = scanToContent(R);
  if (st.eof) return null;
  if (st.indent < minIndent) return null;
  return parseNodeAt(R, st.indent);
}

function parseNodeAt(R, ind) {
  const start = R.i + ind;
  const text = lineText(R, start);
  if (isDocMarker(text)) fail(R, start, 'a workflow file is one document; a second "---" ends the first');
  if (seqEntry(text) !== null) return parseSeq(R, ind);
  if (readKey(R, start)) return parseMap(R, ind);
  return parseInline(R, start, ind);
}

function parseSeq(R, ind) {
  const out = [];
  while (true) {
    const st = scanToContent(R);
    if (st.eof) break;
    if (st.indent < ind) break;
    if (st.indent > ind) fail(R, R.i + st.indent, 'unexpected indentation in a block sequence');
    const start = R.i + ind;
    const text = lineText(R, start);
    if (isDocMarker(text)) break;
    const after = seqEntry(text);
    if (after === null) fail(R, start, 'expected a "- " block sequence entry');
    const c = start + after;
    if (c >= eolAt(R, start) || lineText(R, c).trim() === '') {
      R.i = Math.min(eolAt(R, start) + 1, R.s.length);   // the entry is on the lines below, not this one
      out.push(parseNode(R, ind + 1));
    }
    else {
      const t = lineText(R, c);
      const col = colOf(R, c);
      // A compact entry carries its content partway along the dash's own line. Both nested parsers
      // work from line starts, so blank the dash (same length, so positions and messages are
      // unchanged) and the entry's column becomes the line's indentation like any other node's.
      if (col > ind) R.s = R.s.slice(0, start) + ' '.repeat(c - start) + R.s.slice(c);
      if (seqEntry(t) !== null) out.push(parseSeq(R, col));
      else if (readKey(R, c)) out.push(parseMap(R, col));
      else out.push(parseInline(R, c, ind));
    }
  }
  return out;
}

function parseMap(R, ind) {
  const map = new Map();
  while (true) {
    const st = scanToContent(R);
    if (st.eof) break;
    if (st.indent < ind) break;
    if (st.indent > ind) fail(R, R.i + st.indent, 'unexpected indentation where a mapping key was expected');
    const start = R.i + ind;
    const text = lineText(R, start);
    if (isDocMarker(text)) break;
    if (seqEntry(text) !== null) fail(R, start, 'a block sequence entry cannot be a mapping key');
    const k = readKey(R, start);
    if (!k) fail(R, start, 'expected "key:" where a mapping key was expected');
    let i = k.after;
    const end = eolAt(R, i);
    while (i < end && isSpace(R.s[i])) i++;
    if (i >= end || R.s[i] === '#') {
      // Nothing on this line: the value is the block node below, which must be indented past the
      // key - except a block sequence, which YAML lets sit at the key's own column.
      R.i = Math.min(end + 1, R.s.length);              // look BELOW this line, never at it again
      const nx = scanToContent(R);
      if (nx.eof) map.set(k.key, null);
      else if (nx.indent > ind) map.set(k.key, parseNodeAt(R, nx.indent));
      else if (nx.indent === ind && seqEntry(lineText(R, R.i + nx.indent)) !== null) map.set(k.key, parseSeq(R, ind));
      else map.set(k.key, null);
    } else {
      map.set(k.key, parseInline(R, i, ind));
    }
  }
  return map;
}

// A node that starts on the current line at index i, where ind is the indentation of the line it is
// the value of (needed only to bound a block scalar).
function parseInline(R, i, ind) {
  const end = eolAt(R, i);
  i = skipProps(R, i, end);
  if (i >= end) return parseNode(R, ind + 1);
  const c = R.s[i];
  if (c === '|' || c === '>') return readBlockScalar(R, i, ind);
  if (c === '[' || c === '{') {
    const f = flowNode(R, i);
    const rest = eolAt(R, f.next);
    if (R.s.slice(f.next, rest).trim() !== '' && R.s.slice(f.next, rest).trim()[0] !== '#')
      fail(R, f.next, 'unexpected content after a flow collection');
    R.i = rest + 1;
    return f.v;
  }
  if (c === '"' || c === "'") {
    const q = readQuoted(R, i);
    // A quoted scalar may fold onto the lines below it; only its content matters here.
    const rest = eolAt(R, q.next);
    const tail = R.s.slice(q.next, rest).trim();
    if (tail !== '' && tail[0] !== '#') fail(R, q.next, 'unexpected content after a quoted scalar');
    R.i = Math.min(rest + 1, R.s.length);
    return q.s === '' ? null : q.s;
  }
  const p = readPlainBlock(R, i, end);
  let s = p.s;
  // A plain scalar does continue onto a deeper line - and a deeper line carrying ": " is exactly the
  // error readPlainBlock raises, which is why `a: b` over `  c: d` fails instead of inventing a key.
  let next = end + 1;
  while (next <= R.s.length) {
    R.i = next;
    const nx = scanToContent(R);
    if (nx.eof) break;
    if (nx.indent <= ind) break;
    const cs = R.i + nx.indent, ce = eolAt(R, cs);
    const t = lineText(R, cs);
    if (seqEntry(t) !== null || isDocMarker(t)) break;
    if (readKey(R, cs)) fail(R, cs, 'mapping values are not allowed here - a plain scalar cannot carry ": " (#107)');
    s += ' ' + readPlainBlock(R, cs, ce).s;
    next = ce + 1;
  }
  R.i = Math.min(next, R.s.length);
  return s === '' ? null : resolveValue(s);
}

function parseDocument(src) {
  const R = newReader(src.replace(/\r\n/g, '\n'));
  R.i = 0;
  let st = scanToContent(R);
  if (st.eof) return null;
  if (st.indent === 0 && /^---(\s|$)/.test(lineText(R, 0))) R.i = eolAt(R, 0) + 1;
  st = scanToContent(R);
  if (st.eof) return null;
  const v = parseNodeAt(R, st.indent);
  st = scanToContent(R);
  if (!st.eof) {
    const t = lineText(R, R.i + st.indent);
    if (/^\.\.\.(\s|$)/.test(t)) { R.i = eolAt(R, R.i) + 1; st = scanToContent(R); }
    if (!st.eof) {
      const u = lineText(R, R.i + st.indent);
      if (/^---(\s|$)/.test(u)) fail(R, R.i + st.indent, 'a workflow file is one document; a second "---" ends the first');
      fail(R, R.i + st.indent, 'a workflow file is one document; content follows the first one');
    }
  }
  return v;
}

/* ---------------------------------------------------------------------------- the rules */

const isNil = (v) => v === undefined || v === null;
const blank = (v) => isNil(v) || String(v).trim() === '';
const asMap = (v) => (v instanceof Map ? v : new Map());
const nSteps = (v) => (Array.isArray(v) ? v.length : (v instanceof Map ? v.size : 0));

function checkFile(p, src, log) {
  let doc;
  try {
    doc = parseDocument(src);
  } catch (e) {
    if (e instanceof NotMappingError) {
      log.err(p + ': loaded but is not a plain mapping - NotMappingError: ' + e.message);
      return 1;
    }
    if (!(e instanceof YamlError)) throw e;      // an internal bug is a loud failure, never a silent pass
    log.err(p + ': does not parse - ' + e.reason + (e.where ? ' at ' + e.where : ''));
    log.err('  a workflow that does not parse produces ZERO jobs, so no check is reported at all');
    return 1;
  }
  const jobs = doc instanceof Map ? asMap(doc.get('jobs')) : new Map();
  if (jobs.size === 0) {
    log.err(p + ': parses but declares no jobs - it would produce zero checks');
    return 1;
  }
  let bad = null, jobCount = 0, stepCount = 0;
  for (const [name, raw] of jobs) {
    const j = raw instanceof Map ? raw : new Map();
    if (isNil(j.get('runs-on')) && isNil(j.get('uses'))) {
      bad = p + ': job ' + name + ' has no runs-on - it would never start';
      break;
    }
    const steps = j.get('steps');
    const isList = Array.isArray(steps);
    if (isNil(j.get('uses')) && (!isList || steps.length === 0)) {
      bad = p + ': job ' + name + ' has no steps - it would pass without doing anything';
      break;
    }
    if (isList) {
      const bare = [];
      steps.forEach((s, idx) => {
        if (s instanceof Map && blank(s.get('run')) && blank(s.get('uses'))) bare.push(idx);
      });
      if (bare.length) { bad = p + ': job ' + name + ' step(s) ' + bare.join(', ') + ' have no run: or uses: - skipped while the job passes'; break; }
    }
    jobCount++;
    stepCount += nSteps(steps);
  }
  if (bad) { log.err(bad); return 1; }
  log.out(p + ': ' + jobCount + ' job(s), ' + stepCount + ' step(s) parse');
  return 0;
}

function checkPath(p, log) {
  let src;
  try {
    src = fs.readFileSync(p, 'utf8');
  } catch (e) {
    log.err(p + ': does not parse - ' + e.message);
    log.err('  a workflow that does not parse produces ZERO jobs, so no check is reported at all');
    return 1;
  }
  return checkFile(p, src, log);
}

function globWorkflows(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const pick = (ext) => names.filter((n) => n.endsWith(ext)).sort().map((n) => path.join(dir, n));
  return pick('.yml').concat(pick('.yaml'));
}

/* ----------------------------------------------------------------------------- the CLI */

function run(argv, log) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      const dir = argv[i + 1];
      if (dir === undefined) { log.err('wfyaml.js: --dir needs a directory'); return 2; }
      const found = globWorkflows(dir);
      if (!found.length) {
        log.err(dir + ': no workflow files found - a glob that matches nothing is a silent pass');
        return 1;
      }
      files.push.apply(files, found);
      break;
    } else if (a === '--self-test') {
      return selfTest(log);
    } else if (a.indexOf('--') === 0) {
      log.err('wfyaml.js: unknown flag ' + a);
      return 2;
    } else if (!fs.existsSync(a)) {
      log.err(a + ': no such file');
      return 1;
    } else files.push(a);
  }
  if (!files.length) { log.err('usage: node tools/wfyaml.js <file>... | --dir <dir>'); return 2; }
  let failAny = false;
  for (const p of files) if (checkPath(p, log)) failAny = true;
  if (failAny) { log.err('WORKFLOW YAML IS BROKEN'); return 1; }
  log.out('all ' + files.length + ' workflow file(s) parse and can run');
  return 0;
}

/* -------------------------------------------------------------------------- the self-test */

const FIXTURES = path.join(__dirname, 'fixtures', 'wfyaml');

// Each fixture names the reason it must fail with. A fixture that fails for a DIFFERENT reason, or
// a broken fixture that passes, is a failure here - that is what keeps the set from passing by
// looking at nothing. The last case is the other half: the tree's own workflows must still parse.
const FIXTURE_CASES = [
  ['colon-space-name.yml', 1, ': does not parse - mapping values are not allowed here - a plain scalar cannot carry ": " (#107)'],
  ['tab-indent.yml', 1, ': does not parse - found a tab where indentation is expected - YAML forbids tabs in indentation'],
  ['no-jobs.yml', 1, ': parses but declares no jobs - it would produce zero checks'],
  ['no-steps.yml', 1, ': job build has no steps - it would pass without doing anything'],
  ['name-only-step.yml', 1, ': job build step(s) 0 have no run: or uses: - skipped while the job passes'],
  ['no-runs-on.yml', 1, ': job build has no runs-on - it would never start'],
  ['empty-dir', 1, ': no workflow files found - a glob that matches nothing is a silent pass'],
  ['ok.yml', 0, ': 1 job(s), 2 step(s) parse'],
  ['traps.yml', 0, ': 2 job(s), 2 step(s) parse'],
];

function selfTest(log) {
  let bad = 0, n = 0;
  for (const [file, want, reason] of FIXTURE_CASES) {
    const out = [], err = [];
    const tmp = file === 'empty-dir';
    const abs = tmp ? fs.mkdtempSync(path.join(os.tmpdir(), 'wfyaml-empty-')) : path.join(FIXTURES, file);
    // Hand the guard the path the way a developer would type it, so the line it echoes back is the
    // line this table claims, and so the check covers relative paths too.
    const shown = path.relative(process.cwd(), abs) || abs;
    let code;
    try {
      code = run(tmp ? ['--dir', shown] : [shown], { out: (s) => out.push(s), err: (s) => err.push(s) });
    } catch (e) {
      code = 'threw ' + e.message;
    }
    if (tmp) fs.rmSync(abs, { recursive: true, force: true });
    n++;
    const got = out.concat(err);
    // A parse failure's own line ends with the reader's position, so the stated reason is matched as
    // the line's beginning and the position is free to be whatever the file says.
    const wantLine = shown + reason;
    const hit = got.find((l) => (want === 0 ? l === wantLine : l.indexOf(wantLine) === 0));
    if (code !== want) {
      bad++;
      log.err('SELFTEST FAIL - ' + file + ': exit ' + code + ', expected ' + want + ' - it printed ' + (got.join(' | ') || '(nothing at all)'));
      continue;
    }
    if (hit === undefined) {
      bad++;
      log.err('SELFTEST FAIL - ' + file + ': exit ' + want + ' but nothing in its output is the stated reason');
      log.err('  expected a line beginning: ' + wantLine);
      log.err('  it printed: ' + (got.join(' | ') || '(nothing at all)'));
      continue;
    }
    log.out('selftest ' + file.padEnd(22) + (want === 0 ? 'passes' : 'fails for its stated reason') + ' - ' + hit);
  }
  // The other direction, on the unbroken tree: the guard's real subject still parses. Without this
  // row a reader that fails everything would go green on the fixtures above.
  const real = path.join(__dirname, '..', '.github', 'workflows');
  const out = [], err = [];
  const code = run(['--dir', real], { out: (s) => out.push(s), err: (s) => err.push(s) });
  n++;
  const verdict = out[out.length - 1];
  if (code !== 0 || !/^all \d+ workflow file\(s\) parse and can run$/.test(verdict || '')) {
    bad++;
    log.err('SELFTEST FAIL - the tree\'s own workflows: exit ' + code + ' [' + out.concat(err).join(' | ') + ']');
  } else {
    log.out('selftest .github/workflows    passes - ' + verdict + ':');
    for (const l of out) if (l !== verdict) log.out('  ' + l);
  }
  if (bad) { log.err('SELFTEST FAILED - ' + bad + ' of ' + n + ' case(s) wrong'); return 1; }
  log.out('SELFTEST ok - ' + n + ' case(s): every broken fixture failed for its own stated reason, every clean '
    + 'fixture parsed, and the tree\'s own workflows parse');
  return 0;
}

if (require.main === module) {
  let code;
  try {
    code = run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
  } catch (e) {
    console.error('wfyaml.js: ' + (e && e.stack ? e.stack : e));
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseDocument: parseDocument, checkFile: checkFile, run: run };
