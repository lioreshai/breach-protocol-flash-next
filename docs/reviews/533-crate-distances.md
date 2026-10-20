# #533 clause 5: the same crate at 3 m and at 10 m

Issue #533's fifth acceptance clause asks for "frames of the same crate at about 3 m and about 10 m, from the
live page, in the PR". The feature itself is long merged; these two pictures are the only outstanding artefact.

## How they were made, and in what sense they are "the live page"

The browser tool refuses `lioreshai.github.io` - it is not in its web egress allowlist - so a literal
browser capture is not available in this session, and I am not going to describe these pixels as having come
from one. What was established instead:

- every served blob of the deployed build (`index.html` and all eleven `js/*.js`, twelve in total) matches
  `origin/main` byte-for-byte by md5;
- the frames below were rendered from that same `origin/main` tree, by `tools/view.js`'s own headless harness
  (its sandbox, DOM stubs, `boot()` and `writePNG`) rather than by a second renderer.

So the build in the pictures is the build the page serves, and the renderer is the renderer the probes gate on.
That is an equivalence argument, not a claim about a browser.

## What each frame shows

One `startLevel(0, true)` deal serves both frames, so the two differ only in where the camera stands. The crate
is `PROPS` index filtered on `kind === 'crate'` - index 0 on L0 is a lamp - at `(20.5, 3.5)` in a world holding
seven crates.

| frame | camera | centre distance | `los()` to the crate centre | wall cells on the segment |
|---|---|---|---|---|
| `533-crate-3m.png` | `(23.5, 3.5)`, facing −x | 3.00 m | true | 0 |
| `533-crate-10m.png` | `(10.5, 3.5)`, facing +x | 10.00 m | true | 0 |

`los()` is `js/20_level.js:552`, the same segment test the game judges an enemy by, so "the crate is what is
being looked at" is answered by the shipped predicate rather than by a new one. Each pose was also rejected
outright if `DEV.cam` had snapped it into a wall (`js/90_dev.js:68`); that mattered - the first 10 m attempt
reported a fine distance while actually standing 11 m to one side, looking at other crates.

At 3 m the crate fills the centre of the frame with its two faces, the band and the nail line readable. At 10 m
the same crate is one object among several along the same wall, still distinguishable from the wall and the
floor but carrying visibly less of its own surface. Full-frame colour counts differ the same way: 25,100
distinct colours at 3 m, 19,749 at 10 m over the same 203,138 painted pixels at 601x338.

## Reproducing them

```
head -383 tools/view.js > /tmp/533cap.js && cat <<'JS' >> /tmp/533cap.js
<sandbox.location = ?dev=1; DEV installed; one startLevel(0, true); then for DIST in 3, 10:
 try the eight axis poses at DIST metres, keep the first that DEV.cam did not snap and that `los()`
 agrees to, renderWorld() six times, and write the framebuffer with writePNG>
JS
JSDIR=$PWD/js L533=0 CR533=0 node /tmp/533cap.js scene 0 0
```

Nothing under `js/`, `tools/` or `docs/screens/` changed: this PR adds two PNGs and this file. `docs/screens/`
and its `provenance.json` belong to #578/#604 and are untouched here.
