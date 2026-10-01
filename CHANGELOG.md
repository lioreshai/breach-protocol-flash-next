## Unreleased

### Added

- **The capture-caption table is decoded from the PNGs instead of typed into prose** (#235).
  `tools/recap.js` reads `docs/screens/*.png` with its own PNG reader (chunk walk, `zlib.inflateSync`,
  the five scanline filters — no dependency, the reader half of `tools/png.js`) and prints per file the
  frame mean, the share at or above 240 / 200 luma, the dark-row count with its longest run and start
  row at two thresholds, and three band means, with the sampling stride and the luma rule in the header.
  `node tools/recap.js --rev=<sha>` runs the same decoder over the blobs at a revision, which is how the
  reader validates itself against the files it replaced: on the four PR #233 swapped out it prints
  **87.82 / 24.89 / 87.74 / 35.80**, the numbers that caption carries, to 0.00.
  `node tools/recap.js check` is the gate — now a blocking step in `ci.yml` — comparing every
  `decode to **a / b / c / d / e**` list in `README.md` (read in embed order, tolerance 0.005, and the
  lists must agree with *each other*: line 76 and line 104 of the file used to disagree) and every
  "rows average under luminance" sentence, attributed to the image block it sits under, at the tool's
  own threshold so a caption cannot pick its own bar. **30 rows, 0 failures on `main`.** Vacuity is a
  FAILURE: nothing decodable, an embed with no file behind it, or a README quoting nothing exits 1.
  Two findings the tool now prints instead of arguing: the audited numbers are **Rec.709** luma at every
  column (`js/90_dev.js:241`'s own rule) — Rec.601 reads spawn **87.26** against the file's **87.67** and
  reproduces none of the captions — and the dark-row bar they were measured at is **24**, not the 20 the
  sentences print: at 24 `facing-wall` reads **417 rows / 244-run from row 0** and its predecessor **402 /
  239**, `props` **343 / 277** and **337 / 277**, all four exact, while 20 reads 361 / 232 and 34 reads
  535 / 298. Controls seen red before merge: two PNGs swapped in a scratch copy (mean 87.67 quoted against
  24.69 in the bytes, rows 0 against 417), one caption's mean re-generated to 88.67, and `DIR` pointed at
  a directory with no PNGs in it.
### Fixed

- **The step-lip seam row now asks which SIDE of the lip the band is on, and the ~40 % it was filed
  about turns out to have been fixed elsewhere** (#167). `node tools/view.js bands`' placement term was
  `near0 >= max(12, n*0.5)` with the band located by argmax INSIDE ±win of the analytic lip row, so a
  band displaced across the lip could not be seen: the search always found *a* band and called it near,
  and a 50 % bar on an instrument that cannot report FAR is a row that cannot fail. Re-measured on
  `da5dad5` with a wide (±4 win ≈ 1.3 m) predicate, **the wrong-side fraction on the walkable columns is
  0 of 60, 0 of 60, 0 of 60** against the issue's 22/60, 12/60, 27/60 — because `git log -S crk` shows
  the march-keyed walkable crease was deleted by `754d9ce` (#196), which made every step a DRAWN riser,
  so `seamCrease` is now reached only from `if (riser && SEAM)` (`js/40_render.js:1051-1058`) and is
  keyed on the boundary whose face the wall pass painted. **No `js/` changed: nothing was left to fix
  in the renderer, and no ground-pass seam term was added** — `castGround`'s row loop and `groundPixel()`
  contain no seam term and provably cannot see this case, because a riser paints the slab side
  (`js/40_render.js:973`, `z0/z1` from `rz0/rz1` for every `dq`) so the ground pass never answers for a
  lip's pixels. The row is tightened to what it should always have said, for BOTH kinds: a column counts
  only if the seam A/B diff exceeds 4 on a row strictly INSIDE the painted face, on the face's own side
  of the lip row `yc = floor(hor + (eye - c[4]) * hp)` (the floor the RAY STANDS ON — never the
  height-sorted lower floor, whose projection for a step DOWN lands on the near floor's rows), within
  `win` ≈ 32 cm and never deeper than the face; the anchor row itself is excluded because
  `seamCrease`'s `k = 0` term is painted there whichever way `dir` goes — with it, the sabotage passes
  60 of 60 on a DOWN lip. Gate `n >= 24 && nearW === n && farW === 0 && noW === 0`; measured spread on
  main: **299/299, 240/240, 239/239 face and 60/60, 60/60, 60/60 walk, 0 misplaced, 0 with no band**, so
  nothing was widened to reach the bar. Seen to fail in both directions: restoring `3edf43b`'s march key
  in the same tree (`grep -c SAB167A js/40_render.js` = 3) puts **60 of 60 on L1 and L2's walk rows and
  299 of 299 on L0's face** in the MISPLACED column, `BANDS 4 FAILURE(S)`, exit 1, and restoring the file
  prints `0 gating row(s) of 36` at exit 0 — L0's own walk lip is a step UP, where the two keys agree,
  so that one row stays green under that sabotage and says so. Vacuity is a FAILURE, not a pass:
  flattening the grid inside `linkBoundaries` exits 1 with six `lip exists to measure` rows (9 FAILURE(S)
  total), and sampling at a plane no lip reaches (`DIST=24`) exits 1 with 19. What is NOT fixed here is
  where the displaced population went: under a *dominant-band* predicate (argmax over the wide window,
  not the shipped gate) **139 of 299 L0 face columns put their strongest band at the far edge of the
  same drawn face**, all DOWN-step lips, from the crease's second term (`js/40_render.js:1057`) and
  #195's `dir` rule rather than from the march key — a #195-family tuning gap with its own issue, not
  this row's, and the reason the L0 face row's own contrast pair is measured at the far floor's row
  (`tools/view.js`, `const zCam = kind === 'face' ? zLo : c[4]`).
  Locks unchanged because no pixel changed: `flatparity` PARITY `f9e4da3a f05beeb5 d4b2d2cd` and LOCK
  `060da4cd f05beeb5 050b225e`, DEALT `bb12ef3e 370d3f7a 3a51e659`, `cull`'s CZBAND
  `0x8f763884 0x77511300 0x7dd66c40` and CZBAND-LIGHT `0xb0988514 0xb54c0a14 0xcb62daf2` all read "vs
  recorded" identical, `refs ok - 5 recorded reference(s)`, `RECAP 0 FAILURE(S) of 28 rows`, both smoke
  lanes green (`VERT=1`: 25 gating rows), `heights` all configs ok, `contrast 0 FAILURE(S) of 27 rows,
  7 known-issue rows`. Measured 2026-10-01.

- **The torso-gradient numbers that paid #232 now have a row in the repo that can fail** (#244).
  `node tools/view.js contrast` gained `cam N torso carries surface structure` and `cam N torso gradient not
  paid by mean or edge`, plus a run-level vacuity row: the gradient is mean `|L(x+1) − L(x−1)|/2` over the
  pixels the coverage mask calls a body, inside the projection of the torso box's authored `SPEC` heights
  (hip → shoulder, so it scales with the body and not with the pose's resolution) and 2 px clear of the
  silhouette, on the **composited** frame. Measured with this arithmetic on nine cells (3 levels × 3 cameras):
  **0.00–0.68 with no torso term in `js/`** (a `135c8ad^` tree, era pre-#232) against **2.17–3.31 shipped**
  (era `135c8ad`+), floor **1.40**; the termless torso reads ~0.0 because a flat-shaded triangle carries no
  intra-face slope, so the 1.02–2.32 #240 quoted was ring and face seams, not surface. Controls seen red:
  the same probe over `js/` at `135c8ad^` (exit 1, printing `js/13_mesh.js term ABSENT`), and `TS_SLOPE = 0`
  with the silhouette byte-identical at 1924 / 0 / 2143 px (exit 1, `term PRESENT (TS_CYC 10, TS_SLOPE 0)`).
  The mean half is the wave's DC — the mean of the *signed* slope less the frame's own, 0.00–0.53 termless
  and 0.00–0.80 shipped, floor 1.20 — and the whole-silhouette mean this term costs measures **+0.4** on the
  CI cell, not the −0.2 #240 quoted. Boil is printed and **not** gated, because torso boil measures 9.3–13.8
  across the whole shipped parameter space (`TS_SLOPE` 0/9/30, `TS_CYC` 10/28) against the same bodies' limb
  band at 17.96–37.49, and a ceiling nothing can cross is a row that cannot fail; the trade is visible in the
  printed noise-per-unit-structure ratio (**4.39** shipped, **8.50** at `TS_CYC = 28`, whose gradient 1.62 is
  what the floor is really guarding). Verdict on the CI cell is `0 FAILURE(S) of 27 rows, 7 known-issue rows`.

- **A grunt's own torso surface now has structure, so separation is not carried by the silhouette alone** (#232).
  The issue's `grad 6.3-6.7` was measured on the material table, which is the **billboard sheet `#72` took out of
  the draw path** — the shipped body is `MESH.draw`, flat-shaded **per triangle**, so a chest is one box of ~26 px
  at 6 m carrying **one** luminance. Measured on the composited frame at the contrast cams with a torso-region
  readout (body y 0.50..0.815 = rows 0.20..0.51 from the crown): torsograd **1.60 / 1.07** on level 0 and
  **1.02 / 2.32 / 1.43** on level 2, against a whole-body 2.7 and a room behind it of 2.2-2.9 (L0) and 4.7-5.9 (L2).
  So the torso is the flattest part of the body on screen too, by 2-3x against the room — the issue's finding, with
  the right instrument. A per-vertex value cannot fix it (`tri()` writes one packed colour per triangle), so the
  term is per pixel and its constant is the **slope** (TS_SLOPE luminance per screen pixel), with amplitude =
  slope × projected-period / 4 and the period a fraction of **authored body height** (TS_CYC seams per body unit,
  faded out under TS_MINP px) — the mip behaviour a wall texture gets by chain, in two lines, and what keeps the
  term from boiling: mean |dL| over body px after a 0.03 rad turn is **29.19 against 29.37 off**, while the
  higher-frequency settings cost +1.2 to +3.0. It is a zero-mean triangle wave, so the mean does not move
  (45.9→45.7, 46.2→46.0, 35.3→35.0, 46.9→46.7), it is banded by the grazing term `1-|N·V|` floored at TS_BMIN —
  the mesh's angle-correct stand-in for the rig's signed distance, so the chest square to the eye still reads — and
  it is **torso geometry only**: legs and outline are untouched, because a specular that rode the gait read as noise
  and shrinking the silhouette breaks the walk. Because it is added in **output space inside the mesh draw**, after
  the mesh's own `AMB + li·lt·sh`, it is not floored by `AMB 0.19` the way the rig's raster rim is: the delta is
  **+2.18 / +2.13** on dark level 0 and **+2.22 / +2.21 / +2.00** on bright level 2, the same term doing the same
  work in both. Gates: contrast unchanged where it must not move (cam0 **49.9→50.0**, cam2 **28.6→28.8**, L2
  28.2→28.3 / 28.8→28.7, verdict 0 FAILURE of 22 rows with the same **7 known-issue rows**), `TINT=2` still moves
  cam0 49.9→41.8 at identical mask geometry so the rows still answer to body shading, all six lock hashes and
  `cull` byte-identical, smoke PASSED at raster median 12.4 vs 12.5 ms over 3 interleaved pairs (no resolvable
  delta), VERT 25 gating rows green, and a 4x crop of the body box reads as armour panels rather than a neon
  outline. Residual, stated: on the **bright** level the torso reaches 3.2-4.5 against the room's own 4.7-5.9, i.e.
  55-78% of what the walls deliver on screen, because TS_SLOPE is one global constant and buying the rest costs
  the boil neutrality above. The readout lives in a throwaway copy of `view.js` (`/tmp`), not in `tools/` — #232's
  follow-up should give it a row.
- **`contrast` names why a camera yields no body, and can no longer dress a regression as the #189 debt** (#242).
  On `3f69d6f` cam1 scores **nothing**: `NO POSE`, 7 known-issue rows, the march stopping at **0.56 m**, and
  **11** candidate spots tried with **0** placeable — so every sentence in this file and `AGENTS.md` built on
  "cam1 is WEAK at 16.65 dL" was quoting a grid that no longer generates that seat. `view.js contrast` now
  prints the **stop cause** (`BAND GATE` — the march's own `|fz[a]-fz[b]| > 1 quantum` slab test, with no
  `VB_RAMP`/`VB_LADDER` link on that boundary, `canEnter` never consulted; or `SOLID WALL`, `OFF-MAP BORDER`,
  `POSE PATH`, `NOTHING STOPS THE RAY`) in the per-camera line and in the verdict line, and lists every
  rejected spot with its ray offset, that ray's march distance, its distance from the lens and its **band
  delta** (cam1 on the CI cell: rays 0…10 at 0 to ±21.5°, every candidate at 1.20 m sitting **+1.00 m** above
  the camera's band, all `OFF-BAND`), so nobody re-tries them. The issue asked for "no posed body" to be a
  hard `process.exit`; that would make CI **permanently** red, because cam1's emptiness is #189 part 2's real
  debt and a permanently-red row teaches everyone to ignore the rows that mean something, so the two causes
  are **split** instead: `NO ENEMY IN REACH` (nothing posed *and* nothing drew) stays a `KNOWN` row, while
  `NO POSE WITH A BODY IN FRAME` (a living enemy, body pixels in the coverage mask, zero poses rasterised)
  is a `FAILURE` with an exit code. Seen to fail: with one enemy moved into cam2's cone **and** the pose fan's
  cone capped under the floor, main's `view.js` exits **0** printing `0 FAILURE(S) of 22 rows, 9 known-issue
  rows` — 6,678 px of body in the shot labelled as the level's geometry — while this build exits **1** with
  `NO POSE WITH A BODY IN FRAME - a REGRESSION, not the #189 debt: 6678 px …` naming cam 2; restoring the
  tree puts the verdict back at `0 FAILURE(S) of 22 rows, 7 known-issue rows`, exit 0. Controls unchanged
  on the shipped cell (`FLAT` / `POSEONLY` / `TINT=2` / `STRICT` / `NOBODY`, and the 3 levels × 2 seeds matrix):
  every row-count and failure-count matches `main` to the digit, so the split moves no verdict — only the
  reason beside it. Locks byte-identical (`LOCK 060da4cd f05beeb5 050b225e`, `PARITY f9e4da3a f05beeb5
  d4b2d2cd`, `DEALT 3e88c850 889817bf 158327b0`, `cull CZBAND 0x9c03d4f4 0xeec7be60 0x7dd66c40`),
  `SMOKE PASSED` at raster median **11.58 ms**, `VERT=1` **25 gating row(s), 0 known-issue row(s)**, `recap
  check` **0 FAILURE(S) of 28 rows**. Caveat, stated: on this cell a pose-path regression at cam0/cam2 was
  already red through the `MINMASK` floor and the cone-max branch — what this changes is that the debt label
  can no longer absorb it, and that a shallow-cone camera whose frame plainly has a body in it stops being
  reported as the level's fault.

- **The DEALT triple no longer depends on the order the probe rendered the roster in** (#243). The three dealt
  md5s were reproducible only with levels run in order inside one process: hashing level 1 alone in a process
  that had rendered nothing else gave `f240fd35` where the roster gave `889817bf`, and level 2 `ce8e96a3` against
  `158327b0`, with zero bytes of `js/` changed — a lock whose value describes a render ORDER, which any future
  probe that reorders or parallelises the roster turns red on a clean tree. Attributed by dumping both buffers:
  **24 px of 203,138 (L1) and 16 px (L2)**, every one inside `x 407..459, y 276..305` of the 601×338 frame — the
  view model's rectangle. The gun's **depth history** is the mechanism: the scratch it self-occludes against is
  cleared over the region the *previous* frame's view model wrote (`js/13_mesh.js:858`, the induction at `:153`),
  so the first frames of a fresh level inherit the rectangle the gun drew a level ago and the pixels whose
  self-occlusion differs never heal — nine renders did not heal them. The two caches the issue blamed are
  measurably innocent: clearing `MESH`'s `POSE` between levels leaves all three hashes byte-identical, and
  `RIG`'s LRU answers *0 entries / 0 made* at every level boundary because nothing in the draw path has called
  `RIG` since #72 — so the fix is not a list of caches. `view.js`'s game boot is now a function: called once at
  module load in the same order as before (every other mode byte-stable) and again **before every level in the
  DEALT sampler**, and a new context plus the two node-side holders it cannot clear — the `elements` stub cache,
  which would otherwise hand a second game instance the first one's event handlers, and `rs`, the sandbox `Math`
  stream boot-time art is drawn from — is the whole of it. `FP_DEALT1=<lv>` samples one level with nothing else
  rendered, and the new `DEALT-ORDER` row hashes every level both ways and requires the two to agree; an empty or
  malformed hash is VACUITY and fails by name. Seen red in the same tree (`#243CTL-NOBOOT`, the boot call removed
  → L1 in-order `889817bf` against alone `f240fd35`, 4 FAIL rows, exit 1) and back to green on restore. **Lock:
  `DEALT 3e88c850 / f240fd35 / ce8e96a3`, re-recorded here** — L0 unchanged because it was already the first thing
  the process drew, L1/L2 now being the cold children's numbers #241 had to footnote; means identical at
  57.3 / 58.7 / 86.0, dealt-vs-flat gaps 195,990 / 195,621 / 198,984 px against #226's 4,096-px vacuity floor and
  the seat census unchanged at 165/572, 246/900, 292/1150. `LOCK 060da4cd f05beeb5 050b225e`,
  `PARITY f9e4da3a f05beeb5 d4b2d2cd` and `cull CZBAND 0x9c03d4f4 0xeec7be60 0x7dd66c40` byte-identical,
  `SMOKE PASSED` at raster median **12.28 ms** (batches 12.2/12.2/12.3/12.3/12.8), `VERT=1` **25 gating row(s),
  0 known-issue row(s)**, `contrast` **0 FAILURE(S) of 22 rows, 7 known-issue rows**, `recap check` **0 FAILURE(S)
  of 28 rows**. Cost, stated: `flatparity` went from 37 s to 96 s on this box (eleven boots where it had two),
  because order-independence is now something the sampler does rather than something the reader remembers.
- **`cull`'s CZBAND verdict is a pair now, so its green means the lightmap and not just the lane** (#223).
  `LEAK=1 CZBAND=1 node tools/view.js cull` compared ONE crc32 - a hash of one camera's ground-pass frame on one
  8-cell lane - which moves when the lightmap changes somewhere that frame rasterizes and holds when it changes
  somewhere it cannot, so neither "it stayed put, my change is invisible" nor "it moved, my change is global"
  was ever licensed by it. The row now records a second sense beside it, `cull/CZBAND-LIGHT`, a digest of the
  whole level's **generated** lightmap (`MAP.light` stamped in `cull`'s `setup()` straight after `startLevel`, so
  a transient splat cannot make the record order-dependent - the printed drift between snapshot and now is **0**
  on all three levels), the verdict is the AND of the two, and the detail names which sense moved. Measured on
  this tree, one run per arm (`lane / world`, number = lightmap sum): a **global** source scale moves both
  senses on 3 of 3 levels at x 0.999 (so #223's "1 of 3 levels" is too strong for that class - the lane is not
  blind there), and so do `MAX_ADD 3→1`, `TOPUP_TARGET=128`; but **one top-up lamp at 0.1 str takes 24.14 of
  L0's 300.47 (-8.0 %) of delivered light and leaves L0's lane hash BYTE-IDENTICAL**, and `TOPUP_TARGET=64`
  moves L0's lightmap by 4.19 with the same identical hash. The floor between the readings is therefore not a
  threshold (both senses are bit-exact records) but a measured miss: **24.14 of 300.47 let through by the lane
  against the 0.30 of 300.47 at which it does move** - WHICH source changed decides it, not how small the change
  is. #252's own regression is the case the row exists for: deleting `blurLight`'s band gate returns L0/L1's lane
  hashes to the pre-#252 literals `0x9c03d4f4 / 0xeec7be60` while L2's stays `0x7dd66c40`, byte-identical, so on
  the third level the old verdict was structurally unable to fail; that arm now reads 3 FAIL rows with L2 saying
  "the generated lightmap changed and this lane does not show it", and `alt` agrees with #206's recorded
  37/49/75 census rather than the row duplicating it. The arm that shows what was wrong: `TOPUP_TARGET=64` leaves
  `flatparity` **green (exit 0)** and `SMOKE PASSED`, and reads L0 FAIL on the world sense alone, L1 FAIL on
  both, L2 ok. Both senses stay because they read different things - the lane hash sees the LIVE lightmap on the
  cells one camera reaches, the world digest sees the GENERATED lightmap on every cell - and the four verdict
  classes are each printed by a real arm (main, `CZ_DEF 4→5`, one lamp at 0.1, the band-gate deletion). Locks
  byte-identical as required of a probe-side change: `LOCK 060da4cd f05beeb5 050b225e`,
  `PARITY f9e4da3a f05beeb5 d4b2d2cd`, `DEALT bb12ef3e 370d3f7a 3a51e659` and the existing
  `cull CZBAND 0x8f763884 0x77511300 0x7dd66c40`; the new record `CZBAND-LIGHT 0xb0988514 0xb54c0a14
  0xcb62daf2` is additive and `tools/refs.lock` carries 5 rows that agree with their declarations.
  `SMOKE PASSED` at raster median **11.55 ms** (batches 11.4/11.5/11.6/11.6/11.8), `VERT=1` **25 gating row(s),
  0 known-issue row(s)**, `contrast` **0 FAILURE(S) of 27 rows, 7 known-issue rows**, `recap check` **0 FAILURE(S)
  of 28 rows**. Two premises from #223 did not survive measurement: a global intensity change is visible to the
  lane on 3 of 3 levels, and "every other gate stayed green" is false on the localised arms - `alt` reddens on
  TARGET=64, on the single-lamp arm and on the band-gate deletion.

## [v1.2] - 2026-10-01

**M3 shipped: the generator authors altitude.** 48 PRs merged since `v1.1`, and this is the release
that closes M3 (#14) — the milestone whose content landed in #162 while the issue stayed open, which
is why the strike-through in `AGENTS.md` needed a verdict beside it rather than an edit. `view.js alt`
now ends in `process.exit(bad ? 1 : 0)` and asserts bands, links, reachability and staircases on the
generated grid, and it is in `ci.yml`'s blocking list. Being in the grid is not being perceivable: what
is left of verticality is M4/M5 — authored volume, light and findability — not another generator pass.
Gates at this build: `SMOKE PASSED` at raster median **12.35 ms** (5 batches 12.2/12.2/12.3/12.4/12.4,
16 ms gate), `VERT=1` **25 gating row(s), 0 known-issue row(s)**.
- **Light no longer diffuses through a slab: cells lit with no source on their own band fell from
  37/49/75 to 19/10/16** (#206, option A from measurement). `blurLight` smoothed the one lightmap per
  column across band boundaries while the splat kernel has been band-locked since #203/#208 —
  measured fresh on df919c3, **0/0/0** cells are *direct*-lit off-band and every wrong-band cell was
  this kernel carrying light across a riser (the issue's 74/142/138 was the 2c5a94f population;
  #208/#209 had already shrunk it). The pass now applies the splat kernel's own predicate to each
  neighbour — a neighbour more than one quantum of floor difference away contributes **zero**, its
  weight kept in the denominator exactly as a solid column's already is — and on a flat level every
  neighbour qualifies at its original weight in its original order, so the pass is **bit-identical**
  there: flatparity LOCK/PARITY `060da4cd/f05beeb5/050b225e` and `f9e4da3a … d4b2d2cd` hold
  unchanged. Light stays **one value per column**: a fading transient still re-splats its delta into
  the same array and the un-splat stays exact, so smoke's "blast light fully fades out" is untouched
  and smoke gains a targeted boundary check (a z-less splat whose disc straddles a slab paints **0**
  wrong-band cells and cancels to the snapshot; it fails at 108 cells when the splat weight is
  sabotaged to `wv = 1`). What remains is staircase residue — one blur pass spans one intermediate
  cell, so a source exactly 2 quanta off-band still lights the far side of a step — and it is the
  recorded floor now (`MAIN_OOB`; deleting the gate sends `alt` red at exactly 37/49/75). Re-recorded
  with the kernel, each with its reason: DEALT `3e88c850/f240fd35/ce8e96a3` →
  `bb12ef3e/370d3f7a/3a51e659` (means 55.3/57.8/85.1 — pit floors and slab-adjacent cells lose the
  tail), CZBAND `0x9c03d4f4/0xeec7be60/0x7dd66c40` → `0x8f763884/0x77511300/0x7dd66c40` with
  px-counts **held** at 51048/49614/49586 and L2 again unmoved (the band-weight-not-brightness
  control), the dark-cell budget 252/1083/872 → **344/1194/1055** (+92/+111/+183 is the deleted
  bleed plus its sub-threshold tail reclassified honestly dark — pre-gate df919c3 measured
  253/1087/874), the glow census `RECPIT` → 0.293/0.299/0.314, and the LAMPS=off control dark-pit
  census 118/72/62 → 181/177/146 (pits without a source of their own now honestly get nothing —
  #204's cliff made sharp and even, which is what #206 asked for). One floor moved **down**, stated
  plainly: `bands`' face-lip legibility row (#203's debt, hard floor 0.40 under a 0.45 bar) lost
  4.5 points at the L2 lip — 43→39%, the floor of the step in front of the riser was wearing the far
  band's tail (lU 33.10→30.67, lD unchanged) — and its floor is re-recorded one notch under the new
  worst (0.36), exactly as #203 recorded it one notch under the old; the row still hard-fails on any
  build removing more edge than this kernel does, still reports the #203 debt below the bar, and the
  light-independent riser mechanism it calls for is now the only thing that can bring the point back.
  Gates: smoke PASSED (raster median 11.93, batches 11.7/11.7/11.9/11.9/12.1), VERT 25 gating rows,
  alt ok, bands ok, horizon ok, contrast **0 FAILURE(S) of 27 rows / 7 known-issue rows** unchanged,
  cull ok, exposure medians 69/71/83 in the 60–100 band, recap 0 of 28. js **does** change pixels on
  the dealt (live) levels — floor light beside band boundaries — so the README screenshots are owed a
  recapture PR from the deployed build.
### Added

- **The minimap plots the climbs the generator authored, before the player finds them** (#189 part 1).
  `MAP.feat` authors `STAIR`/`LADDER`/`PIT` cells and no HUD code read them, so an off-band region was
  undiscoverable from the datum. `drawFeatCues` (js/50_ui_input.js, called by the frame loop after
  `renderOverlay` under the same `S.showMap` gate `drawMinimap` carries) glyphs every feat cell — stair
  two horizontal ticks, ladder a vertical bar, pit a square — **regardless of `explored`**, measured
  first: at SEED 12345 the pop is **STAIR 6 / LADDER 0 / PIT 20 (L2 12), RAIL 0 — nothing writes
  FEAT_RAIL** — **0 of 26 / 26 / 18** feat cells sit inside the reveal disc (radius `sqrt(52)` cells,
  js/30_entities.js) and the nearest staircase is **10.4 / 13.9 / 25.3 cells** from the spawn seat, so
  an explored-gated cue paints nothing when it matters. At the default minimap every cell gets its own
  **6.65 / 5.40 / 4.80 px**, so the glyph fits at 1-px-per-cell × ~5; no cue had to move to a HUD line.
  Ink is band-vs-`MAP.fzBase`, level-wide, never player-relative — where *you* are stays the arrow
  (#16 gap kept visible, asserted not argued). `bands` gained three rows per level: cue coverage with
  populations and a misplaced-cell count (0 cells authored is a FAILURE, not an ok), spawn-seat
  findability (nearest climb cell + whether its minimap pixel is non-background at explored = 0), and
  an invariance row that reddens if the cue ever encodes the player's own band. Controls seen red in a
  control worktree: cue reverted → 0 cues with cells present; cue gated on `explored` → the spawn-seat
  clause; glyph at the wrong kind or one cell east → the coverage/misplacement clause; `MAP.feat`
  emptied → vacuity as FAILURE. Cost: **0.015 ms/frame** measured alone (600 calls, headless fillRect
  hook), and order-flipped paired batches (5×60 frames/side, loadavg ~3) put frame cost at **12.98 vs
  13.10 ms** median — inside the noise. All four lock senses printed unchanged: LOCK
  060da4cd/f05beeb5/050b225e, PARITY f9e4da3a/f05beeb5/d4b2d2cd, CZBAND
  0x9c03d4f4/0xeec7be60/0x7dd66c40, DEALT ecb797dd/96a450d0/22d473ed — the cue paints on the display
  canvas after `renderWorld` writes `px`, never into `px`.
- **A generated level has volume, not just altitude** (#188). `authorHeights` scattered single room
  interiors one quantum up and left `MAP.cz` at one unit in every column, so a level was multi-storey
  in `MAP.fz` and still read as a crawlway. `authorVolume` authors three named features per level. A
  **raised quadrant** (falling back to a half-plane) stands a unit above the datum, its stranded
  pockets stair-linked and handed back to the datum when a mouth will not take a stair — the largest
  contiguous off-datum patch goes from **40–60 cells** (one room) to **144 / 225 / 287**. A **sunken
  block** with a lip around it, at most **5×4 cells** and 1.00 m down, sits in the room furthest from
  spawn and is linked by a *descending* stair, because dropping in is free and so a flagged crossing
  is not a verified way out. **Tall rooms** take `CZ_TALL` quanta of their own on the largest rooms
  AND on the corridor mouths into them — an open doorway draws no face, and its lintel is the ceiling
  you see through it. Measured at SEED 12345, **86 / 45 / 100** open columns stand **≥ 2 units** from
  `floorAt` to `ceilAt` (tallest **3.00 m**) where a flat level reads exactly 1.00 and a ladder shaft
  reaches 1.50. Wall bases are carried DOWN to the lowest band they bound, once, at the end, which is
  why **faces of span ≤ 0 read 0** on all three levels instead of moving that generator fault to the
  flat side where the spawn, the exit and the probes live. No draw from `Math.random` was added (the
  only changed lines mentioning it are comments) and `planes`' GEN-COUPLE row still hashes cell/fz/
  lamp identical at 0 and 12 enemies constructed. `alt` gained three rows for this — a column you can
  stand up in, off-datum cells reachable from spawn **up and down**, a raised patch you can walk on of
  ≥ max(24, 12% of open cells) — and its band-link rule counts a crossing from the end farther from
  the datum, which is the same cell as it was while every band sat above the datum and the only way a
  descending stair's link shows at all. Cost on smoke's own instrument (median of 5 batches, SEED
  12345, run back to back against `main` on one box): **12.08 ms against main's 10.28**. The limit is
  not depth — digging **every** open cell 4 quanta down measures within **±1.7 ms** of flat (5 batches
  × 3 levels) — it is **plane crossings per row**: a checkerboard dig, one crossing every 2 cells,
  costs **25.2–31.2 ms against 11.4–12.4 flat**.
- **The weapon in your hands is geometry, not a painted sprite** (#180). It is drawn through the
  same rasteriser as the world, into a **scratch depth buffer** so it can never cull a billboard,
  and it is deliberately **absent from the coverage mask** (`body: 0` at the draw site, with
  `contrast`'s emptied-`ENEMIES` row as the guard) so the character-separation probe cannot start
  measuring the gun. Sway was converted to screen space as `2 * planeLen * t / DW` instead of
  `2 * t / DW`, which had made the authored travel **1.399×** too large at the hip and **3.1×** in
  ADS, and barely scaled with field of view (**0.408** against an ideal invariance of **1.00**);
  measured travel/authored
  is now **0.911 / 0.927 / 0.922** at 1280×720, 1600×900 and 960×540, and the FOV-invariance ratio
  went **0.408 → 0.992**. All 24 weapon/pose states paint (**min 1,175 px**, rifle-at-hip bbox
  `x 0.59–0.86 y 0.61–1.00`), **0 frame-depth pixels** are written, and `hitscan` is byte-identical
  with the rig drawn. Cost is real and tracked as **#186**: WARM median **35.0 → 37.0 ms**, flat
  **8.85 → 10.5 ms**.

- **The exposure gate now samples the frame the player actually sees first, and it fails on its own.**
  Every brightness sampler in the repo — `tools/view.js exposure`, `tools/ci/assert.js exposure` — parked
  the camera in an arbitrary open cell, spun it through 6 yaws and ran 20–120 `update()` frames before
  measuring, so all of them asserted a *median over rolls of a pose nobody plays* while the first frame of
  the level was in no gate: the live page read **12.73 / 51.41 / 129.07** means (mids 18.34 / 47.93 /
  149.40) at the spawn pose against the 60–100 target, while the same build asserted **86 / 90 / 73**
  (#155). `view.js exposure` now prints a **spawn** column (mean + centre-half `mid`, same dice as its
  rolls column, on the same generated level, no `update()`), and `tools/ci/assert.js exposure` asserts it
  on a separate band, **35–75** on the composited frame, in a verdict that accounts for both numbers. The
  band is the gap between two rendered failure states, not a fit: measured on this geometry, a spawn frame
  with every lamp unlit reads **13.0 / 14.4 / 32.2** (and 3.7–17.3 with the ambient zeroed too) while a
  lamp 1 m from the lens reads **79.4–137.5** mean, so 35 sits above the brightest unlit render and 75
  below the dimmest lamp-in-the-lens view. It is asserted on the median of the same 5 seeded rolls because
  one fixed pose is a view class rather than a property of the level — the per-roll values range 21–137
  and straddle *both* anchors, so they are printed and not judged; `mid` is printed and not judged because
  its anchors overlap (a lightless level 2 reads mid 40.1 while L1's spawn median mid is 31). Two controls,
  both reverted: narrowing `SPAWN_MAX` to 55 fails level 0's spawn line with the median line still `ok`
  (exit 1), and zeroing `MAP.light` at the spawn frame only collapses the spawn numbers to 13 / 15 / 29
  while the asserted medians stay 86 / 90 / 73 — #155's defect class, caught. The pose is written
  explicitly rather than trusted: `P.ang` is the heading (there is no `P.yaw`), and `P.z` is the **feet** —
  `js/40_render.js:103` adds `cfg.eye`, so setting `floorAt + cfg.eye` would have raised the eye a full
  unit off the floor and measured a floating camera. No light authoring or lamp placement is touched here:
  that is the follow-up once #149 lands, and if it brightens spawn views past 75 this step goes red and the
  band gets re-derived from the two anchors, not nudged.
- **`DEV.lum([{stride}])` reports the luminance of the frame the player actually sees, and CI prints it.**
  `mean` is Rec.709 luma over the whole display canvas (after bloom, grade, grain and the HUD), `mid` over the
  centre half-window - two windows that are not interchangeable, and on this layer `mid` runs 8 to 20 points
  above `mean`, which is the conflation that produced #117 and #139. `tools/ci/assert.js exposure` drives the
  system Chrome over the DevTools protocol with node built-ins only (no dependencies; `tools/ci/no-deps.js`
  still guards the tree) and asserts the **median of 5 seeded rolls per level** inside 60-100, printing the roll
  spread and never asserting it, because that spread is 18-70 points, wider than the window (#87). The dice are
  `view.js exposure`'s own (`1000 + level*97 + roll*13`) so the two tools look at the same levels. Exit codes are
  distinct - 1 outside, 3 NOT MEASURED - so a run that could not reach the canvas never reports a passing grade
  (#122). #47's premise was understated: there was no `DEV.meanLum` and no exposure assert in `tools/smoke.js`
  at all, so no CI job gated brightness on **any** layer. The step ships `continue-on-error: true` because it is
  red on `main` today: level 2's median is **53 on the raster and 38 composited**, against 73/91 and 76/86 on
  levels 0 and 1, and a blocking check that is already overdue deadlocks its own introducing PR. #143 carries
  the numbers and the flip condition.
- **Two rules that were fixed and never asserted now have gates.** The exit changes level through a test that
  includes a band (#105: an xy-only test let the level change from a cell whose floor was a unit below), and a
  pickup has a 0.6 m vertical window (#109: xy proximity took it while the player hovered above it). Neither had
  a regression test: risk #3 in AGENTS.md says as much - nearly every assert in the repo compares x and y.
  Six new VERT rows (the lane goes 15 -> 21 gating rows) stand in the neighbour cell 0.40 m from a parked exit on
  a floor 0.25 above its floor and require the level to stay put, then flatten that floor and require it to
  advance; and stand on a pickup at 0.00 m, 0.50 m above it and 0.90 m above it, requiring it taken, taken (a jump
  peaks at 0.489 m so grabbing mid-air has to keep working) and left. Both rows are self-controlled, and both
  controls were run: deleting #105's band term turns V16 red on all three levels with nothing else failing,
  deleting #109's window turns V17 red on the 0.90 m half with nothing else failing. Writing them found two ways
  to be silently vacuous - on the last level `nextLevel()` ends the run instead of incrementing `S.level`, and
  `takePickup` sets `k.dead` rather than splicing and REFUSES a health pickup at hp 100, so counting array length
  at full health fails a build that is behaving correctly.

### Changed

- **"flat md5 parity holds" is a verdict a machine prints** (#211). `flatparity` gained md5 literals in
  #210 and **no step ran it**, so both triples could have rotted back into a PR caption exactly like the
  prose they replaced. The required job's `Probe gates` step now runs it (13 modes → **14 invocations**),
  and one command covers **both** senses because the probe spawns the other lamp record cold rather than
  waiting for a human to remember the knob — which is the failure mode this issue is about:
  **PARITY** `[LAMPS=off]` `f9e4da3a / f05beeb5 / d4b2d2cd`, means **79.7 / 34.1 / 47.5** (the
  formula-collapse proof, the lamp record is `2c5a94f`'s), and **LOCK** `[LAMPS unset]`
  `4262d051 / f05beeb5 / 050b225e`, means **81.3 / 34.1 / 51.7** (a regression lock on lamp *placement*,
  green there is not evidence a term is bit-neutral). Cost **+21 s** to the required job, the largest row
  in it: 3 levels × 4 cold processes, which is what makes the stream comparable across builds. Wiring
  shown in both directions — this tree **exit 0**; `2c5a94f`'s `js` with these tools → **LOCK FAIL ×2
  (L0, L2) + census FAIL, exit 1**; these tools with `SHIP` refs set to the OLD triple → **LOCK FAIL ×2,
  exit 1**, so the row is satisfied by the recorded md5 and not merely by hashes being stable. The
  blindness is now **printed beside the verdict** instead of buried in the block header: the hashed
  levels carry **0 / 0 / 0** cells off the datum of **1296**, so `fd = 0` everywhere and the band term is
  the literal `1` before any sign is read. Consequence, measured and stated rather than glossed: on the
  one-sided kernel `lf - floor >= -ZQ - 1e-9` **all six rows print `ok`** and BOTH triples hash
  byte-identical (`flatparity` **exit 0**) — the row added here is blind to that kernel, as #211 says it
  must be, and reference hashes cannot be narrowed to fix it. CI as a whole still reddens it: the step
  aborts at `cull` (**CULL 2 FAILURES**) before `flatparity` runs, and `alt`'s direction rows fail
  **169 / 279 / 117** (measured on this kernel at both `4495c08` and `7f62f82`; #211's body quotes **273**
  for L1 and that number does not reproduce here). No `js/` line changed: direction rows **0/0/0**, pit
  dark **0 of 181/194/175** at **0.672/0.631/0.647**, `bands` debt **3 of 27** with L0 face lip **54 %**
  all unchanged. Closes #211.

- **README screenshots and captions recaptured two merges after the picture changed** (#203, #210).
  The four shots came from one `?dev=1` boot of `4495c08` at canvas **1440×763** / raster **678×359**,
  BALANCED, `DEV.freeze(true)` + `DEV.clear()` once and no `startLevel` between shots, with two
  procedure changes that move the numbers: the level was **dealt from the probe's own dice** (the
  `tools/view.js` `seedRng` LCG installed in the page, seeded **1000** = its `1000 + level*97 + roll*13`
  at level 0 roll 0), so the PNGs and the probe numbers are one world instead of two maps; and the
  level-intro banner was ended with the game's own `banner('', 0)`, because the freeze gates the
  `update()` that owns its timer and a frozen frame otherwise keeps "SECTOR 1 · ARCHIVE SUBLEVEL"
  across the middle of the picture. **Vitals read 100**, so the damage vignette that sat inside the
  previous four frames' means (they carried 66 hp) is gone from these. Verification is a **code**
  marker, not prose: `genLevel.toString().includes('topUpEnabled')` → **true** in the page that rendered
  them, re-read after the A/B restored the knob, and **12/12** `js` + `index.html` md5-equal to
  `origin/main`. This session's egress allowlist refuses `lioreshai.github.io`, so the capture ran
  against the merged tree rendered locally rather than the Pages URL, and the caption says so instead
  of implying otherwise. What the captions now claim, measured: the pit frame's 16 floor cells
  (`MAP.fz <= -3`) read mean light **0.630** with **0 of 16** under 0.05, and re-dealing **the same dice**
  with #210's top-up off (`topUpEnabled` returning false, the `LAMPS=off` knob) puts them at **0.002**
  with **16 of 16** dark and the lamp list at **7 instead of 10** — lip camera **20.62 → 44.30**,
  pit-floor camera **36.00 → 168.18** (centre-half **228.92**, `MAP.light 0.908`), which documents
  #204 as a measurement and records that its symptom has **flipped sign** (filed as **#213**): a lamp
  in a 5x3 hole now reads near-blown. Two instrument findings, both printed instead of smoothed: an independent PNG
  decode sits **0.5 to 2.0 BELOW** `DEV.lum` here (−1.96 / −0.53 / −1.58 / −0.71 luma), the opposite
  sign to the "**+0.1 to +0.3 high**" the last caption recorded, and the PNGs carry no colour chunk; and
  because film grain cycles **7 phases** (`js/40_render.js:1203`) while the page's own rAF keeps
  compositing between `eval` calls, a "the frame changed" claim is only meaningful **inside one JS
  turn** — in-turn the floor is **0.009–0.028 %** of pixels moving >4 luma, across turns an unchanged
  frame reported **2.872 %**. New finding, filed as **#212**: **the same pit from 1.5 m out is a wall** —
  **93.8 %** of the pixels above the horizon carry wall texture while `DEV.ray` reports open ground to
  **9.5 m** and `zbuf` records the face at **0.14–0.21 m** on rows 10…355, falling to 13.5 % at 2.5 m,
  2.8 % at 3.5 m and 0 % beyond 7.5 m, at a *bright* mean of 71.62, so no brightness gate can see it.
  Also fixed in passing: the claim that the minimap's band palette is "the only altitude cue" (the spawn
  frame's minimap is unexplored black), the "0.036 %" noise floor restated as the in-turn number, and
  the enemies frame's #189 sentence — the staircase case is measured at **8,782 px (0.799 %)** for a body
  a full band above the camera, so #189 keeps the **deck** repro and not this one.

- README screenshots refreshed from the deployed build carrying `66eea67` (#200) in one `?dev=1`
  boot, all **11** `js` subresources md5-checked against the tree (11/11; marker `FARFAN` 5 served /
  5 in `main` / **0** in `main~1`), and the sentences beside them rewritten because one of them was
  **false**: the captions explained a step-lip camera as dark *because height buys no light*, a
  diagnosis a 44-sample sweep disproved (**+18.0 ± 19.0** brighter than its own spawn camera at
  matched lamp distance, frame mean tracking **the camera column's own** `MAP.light` at **r = +0.62**,
  N = 44), and on this boot the ordering simply inverts (**+31.7** the other way). What #200 changed
  is the **far band's** source and magnitude — `bands` mean |step| across `FARB` **18.4 / 19.1 / 9.8
  → 4.2 / 5.8 / 3.4** — and what still leaves geography dark is #199 (`splatLight` discards lamp `z`)
  plus a fog colour of [17, 13, 10] whose luma is 13.63. Three stale verification claims fixed in
  passing: the raster buffer is **678×359 upscaled 2.125×** into a 1440×763 canvas, not "1202×676";
  vitals read **66**, not 58; an independent PNG decode sits **+0.1 to +0.3** from `DEV.lum`, not
  "about 6 points low". The line claiming the generator authors no walkable band is deleted because
  **#152 closed** — this roll deals five floor values and walkable links at ±1…±3 quanta.

- README screenshots refreshed from the deployed build carrying `754d9ce` (#196) in one
  `?dev=1` boot, all 10 `js` subresources md5-checked against the tree (10/10; marker
  `function slabT(` = 1 deployed, 1 in main, 0 in main~1). Captions state the fix and the two
  defects it left: a five-tread flight at (6.5, 1.5) draws its risers in wall material but
  averages 25.6 where the spawn camera averages 96.4 (#197), the pit lip at (10.5, 14.5) is a
  hard lit face under an unlit black upper half at 19.7 (#16’s missing per-band light), and
  the same-band hostile shot says out loud that it is not an altitude test (#189 keeps its own
  repro). The section separates “the stairs draw” from “the level has two floors” (#152),
  and names the unseated vitals 58 as the damage vignette instead of leaving it inside the means.
- **The ground-pass diagnostic is a blocking CI row** (#177 follow-up). `cull` now runs twice in the
  probes job, once plain and once under `LEAK=1 CZBAND=1`, so the wrong-fix falsifier that only those
  two rows can see - adopting the nearer ceiling plane, which leaves every shipped verdict green -
  turns the build red instead of being caught by a human who ran the right command. Measured on
  `main`: the gated row exits 0 with ceiling-step ground hashes `14c12844` / `8ab438b0` / `5a425d84`,
  and the plain run above it stays byte-identical because the diagnostic is env-gated.
- **A step you can walk up is now a face you can see** (#192). `castWalls` emitted an air-to-air
  riser only when `|dq| > 1`, so a staircase tread, a pit lip and a deck edge - all one quantum,
  which is what the generator authors - were painted as floor from a plane 0.25 m away: `zbuf` said
  the room below was under the camera, and the lip read as a void or a brighter patch of the same
  texture. Any `dq != 0` now emits the slab-side face (the crossing stays `VB_THRU`, so 1-quantum
  steps remain walkable and auto-stepped), risers wear a wall material instead of `MAP.floorTex`, and
  the seam-for-walkable-step branch is gone because the step is geometry now. A floor-half pixel
  whose own cell's floor is at or above the eye is no longer refused to the far plane: the deferred
  copy marches to the boundary the ray slips under (`slabT`), which is where the deck case stopped
  leaking 380 px instead of 565 on `heights`' stepUp. The DDA's previous-cell lookup is bounds-checked
  on both axes, where `qy * N + qx` wrapped a border step to the far end of the level. Flat frames are
  bit-for-bit unchanged (9 frames hashed identical over 3 levels x 3 yaws; `scene` md5s identical on
  levels 0 and 2). `cull` gains 9 camera-posed rows against generated lips - 2640 px/level of `zbuf`
  compared to an independent march, 2640 disagreeing on main and 0 here - and `bands`' walk-lip rows
  now demand the face, their luminance half reporting the #192 debt (26% / 12% on L1 / L2 against the
  45% bar, hard floor 6%, red under `STRICT=1`).
- **README screenshots and captions recaptured from the deployed build** (#190). The four shots
  were two builds out of date and two of the four captions described a different level than the pixels
  under them. All four are now re-shot from ONE boot of the live site at `?dev=1` (build `dc98788`),
  byte parity re-checked at commit time: **11/11** `js/` subresources md5-equal against the Pages host
  with a cache-buster, and the volume marker counts 1 deployed, 1 in `origin/main`, **0** in
  `origin/main~1`. That roll deals 506 of 676 cells on the datum, 144 at `MAP.fz` 4, 20 at -4 with the
  quanta-1..3 and -1..-3 stairs, and `MAP.cz` 12 in **70 columns**. The enemies caption now carries
  the measurement #189 lacked: at a camera 4.50 m short of a lip, a grunt on the camera's own band at
  3.00 m owns **7,955** px at >30 while each of two grunts on the band above at 8.00 m owns **35**, and
  the control says why — a **crate** in the same cell at the same range owns **0 px**, so it is the
  lip's geometry hiding them and not the enemy draw path ignoring `floorAt`. One instrument fact cost an
  hour and is now written down: `DEV.lum` on the live canvas and the committed PNG of the same frame
  differ by a systematic ~6 points (48.08 to 45.38, 138.94 to 131.63, 129.82 to 123.20, 117.15 to
  111.13), which is the screenshot colour path, so single-digit disagreement between a caption and a
  file is not a defect.
- **The vertical milestones now say what the tools measure, because one of them said something false.**
  `AGENTS.md` recorded M3 as shipped - "~~bands + links~~ (issue #14 closed)" - and put the current marker
  on M4. #14 is **open and was never closed**, and its content never happened: the grid the generator builds
  is `fzTry`, allocated as an all-zero `Int8Array` at `js/20_level.js:491` and made into `MAP.fz` at `:503`,
  and **no line writes it**, so `view.js alt` reports
  `floors 0..0`, a single band per level (`{"0":572}` / `{"0":896}` / `{"0":1146}`) and **`step faces 0`** on
  all three levels. The honest split, now written in both `AGENTS.md` and `docs/ROADMAP.md`: M3's **physics**
  shipped and is gated (`drop` lands a 3 m fall at 7.21 m/s against 7.43 predicted, hurts hp −25.32 against
  the formula's 26.2, and a **blocked** riser stops the player dead - 0.20 m moved in 1 s with `z` unchanged;
  the lift that does exist is `auto-step` at `js/30_entities.js:376`, eased over ~1/16 s, and `vert` gates it
  with 1-quantum-over / 2-quantum-stop rows), M3's **generation** did not, so no
  level in the game has a staircase, a ramp, a ladder or a pit. `docs/ROADMAP.md`'s P0 claim that
  `drop`/`sight`/`cull`/`horizon` were "still owed" is also retired - all four exist, run in the blocking
  probe list and pass. The probe that *would* gate flatness (`alt`) is worse than ungated: **it has no
  `process.exit` in its code path**, so it prints `NOT FLAT - check above`, falls through to the scene dump
  and exits 0 - a verdict line that cannot fail.
  Two rules added so this cannot recur: a milestone may only be struck through **with a verdict line beside
  it**, and a green vertical row must be able to name the line that creates the geometry it tests - every
  vertical row in the suite builds its own band with `vpoke`, which is why a world with no altitudes passes
  all of it. Tracked as **#152**; #14 and #15 were rewritten from these measurements (both carried claims the
  code had since contradicted, #15's being "z is invisible to every existing assert").
- **A second pass corrected four claims the first pass had made about that correction.** `alt` does not
  "assert flatness while unparked" - it cannot fail at all (no `process.exit`, `tools/view.js:214-263`). The
  occupancy gate is not "height-blind": `bfsReach` (`js/20_level.js:117`, used at `:492`) admits crossings
  of `|Δfz| <= 1` (`:127`), which is why it already accepts steps and **refuses ramps and ladders** (4 quanta)
  into the fallback box. A step-up lift is not missing - `auto-step` (`js/30_entities.js:376`) eases `P.z` to
  the floor and `vert` gates it. And the line first cited as the allocation (`:575`) is the **fallback** box;
  the normal path is `fzTry` at `:491` becoming `MAP.fz` at `:503`. Each was checked in the source before
  being rewritten here, which is the point: a citation is a claim, and a wrong one costs the next reader more
  than no citation. Finding them also changed the plan - authored bands must go in **before** `bfsReach` at
  `:492` (the comment at `:489-490` notes the BFS walks the array `MAP.fz` becomes), or the gate certifies a
  flat grid the player never receives.
- **`contrast`'s new exit code made a reporting job blocking, so cam 1's shortfall is a debt row.**
  The verdict shipped in the previous entry went **FAILURE** in `probes`: `ci.yml:188-192` runs
  `for p in alt exposure contrast rig stats sheets decal diag` and sets `status=1` if any exits
  non-zero, so a probe that always exits 1 on unmodified content is a permanent blocking row and
  `mergeStateStatus` BLOCKED - the job's `continue-on-error` does not help, because the row reports the
  step's own `exit $status`. Fixed in the tool, not by widening a threshold until the row cannot fail:
  cam 1's *recorded* separation is now a **known-issue row** in the shape smoke's VERT lanes use
  (`25 gating row(s), 0 known-issue row(s)`), counted in the verdict line -
  `CONTRAST 0 FAILURE(S) of 15 rows, 1 known-issue row (reporting: cam 1 #179)`. It reports at the
  baseline and goes red only when the debt **grows**: below edge dL **15.65** (recorded 16.65 minus 1)
  or above **41.94%** lost (recorded 37.94% plus 4). Both floors are measured on level 0 SEED 12345 -
  the configuration CI runs, deterministic to the digit over repeat runs - and bracketed by the knob
  that moves body shading: unmodified **16.65 / 37.94%** is the debt, `TINT=1` (drops the
  per-individual colour jitter, a neutral repaint) reads **15.95 / 41.44%** and stays a debt, `TINT=2`
  (halves the body's light headroom) reads **15.15 / 43.77%** and trips **both** axes, and `DARKRING=1`
  reads **37.19 / 0%**, which turns the row back into a plain `ok` and drops the count to 0 - paying
  #179 is visible in the output. `STRICT=1` promotes the row to a hard FAIL (exit 1) so the term that
  pays the debt can be A/B'd against a green baseline. Everything else keeps its teeth: an empty mask,
  a nonzero leak, a too-small ring and the cam0/cam2 verdicts stay hard FAILs (cam0 **28 / 17%** and
  cam2 **68 / 0%** read, so they are not debts), and `NOBODY=1` still prints **12** red rows rather
  than confident zeros. Control, for a debt row that might be self-cancelling: the patched probe on
  `a789064` carrying only the `COV` stamping hunks prints the same KNOWN row at exit 0 with identical
  frame hashes (`63bfcab0 6c3c1250 42f22ef0`) and goes red under `STRICT=1` and `TINT=2` there too, so
  the row tracks content rather than this branch's tooling - and on pristine `main` the probe cannot
  even run (`COV is not defined`), because its oracle is the geometry-pass stamp, not the tool.
- **`contrast`'s mask is coverage now, and the probe can fail.** The silhouette used to be
  `|A - B| > 4`, where `B` is the same render with `ENEMIES.length = 0`, which cannot credit anything
  a body changes in the *world*: `B` has none of it, and a shadow falling outside the silhouette joins
  the mask and moves the sampled edge onto the shadow's own falloff, where `dl` is tiny. That is how
  a contact shadow measuring a nonzero value on **4,410 of 37,651** body pixels left cam1
  **bit-identical** (dL 14, lost 44%), while `cull` read **113.0% / 182.3%** of the flat silhouette
  "surviving" and `cover` went **1.1% → 33.3%** (#179). The mask is now `COV` - who painted each
  pixel last, stamped at the mesh and billboard write sites, cleared once per frame by `renderWorld`,
  `null` in play - so a body pixel painted the same colour as the wall is *in* the mask and a shadow
  behind a body is *background*. Ring = mask pixels with an outside neighbour in the 8-neighbourhood;
  background reference = the median luminance of those outside neighbours **of the same composited
  frame**. Five rows per camera with a verdict and a `process.exit`: mask-is-bodies (the enemy-free
  render's coverage must be empty), silhouette big enough, ring measurable, body reads against the
  room (the shipped `edge dL >= 24`, plus `lost <= 70%`), and **leak** - pixels the diff mask claims
  that coverage denies, **0 px on main**, which is the shadow bug made countable. Coverage also sees
  the pixels the diff mask structurally could not contain: **52 / 566 / 0** body pixels at cam0/cam1/
  cam2 differ from the enemy-free render by <= 4, i.e. **20% of cam1's silhouette was invisible to
  the oracle**. Numbers on the same frames, old rule then new: cam0 `0.5%/34/29/13%` →
  `0.5%/32/28/17%`, cam1 `1.1%/15/14/44%` → `1.4%/12/17/38%` (WEAK under both rules, and now it
  exits 1), cam2 `0.2%/82/79/1%` → `0.2%/82/68/0%`. Controls, each seen to move the verdict:
  `NOBODY=1` gives an empty mask and 12 red rows instead of confident zeros, `DARKRING=1` (paint the
  ring black - the scale a future contour term is judged on) takes cam1 from `17/38%` WEAK to
  `37/0%` READS, and `TINT=k` flips verdicts at identical mask geometry, which is what the shipped
  `DEV.set('rim', …)` can no longer do (bodies are meshes since #72; `RIM=0|1` hashes the same frame
  both ways). Pixels are unchanged: `scene` md5s identical on all three levels, WARM PNG md5
  identical across 16 interleaved runs, `exposure` ok, `SMOKE PASSED` with the VERT lane at 25
  gating rows.
- **Two sentences of the README were stale prose rather than merely old** (#190, alongside the
  recapture). The first-person viewmodel was still described as Canvas2D art drawn in `renderOverlay`,
  which #185 ended - it is geometry rasterized inside `renderWorld()` against a swapped scratch depth -
  and the frame loop was still described as `renderWorld()` + `renderOverlay()` per frame, where the
  canvas-overlay `drawCalls` counter now reads 0 on a steady frame (`tools/smoke.js:149`) because the
  rig left that path. Both sentences are cited to the merged files now; the captions themselves were
  rewritten from live-page measurements, and every number in them was measured at the posed camera on
  the deployed build.
- **The LEAK/CZBAND ground-pass diagnostic is a probe now, and it is the row that sees a wrong ceiling
  fix** (#177). `cull` gained ~200 env-gated lines from `measure/leak-attribution`, rebased onto the
  engine that #188 left behind it. `LEAK=1` attributes each leak pixel to the row path or the deferred
  re-solve by SOURCE-transforming the split at `js/40_render.js:468` (never by wrapping it - the wrapper
  cliff is documented) and stamping provenance off `groundPixel` itself: `ship` / `nodefer` / `alldefer`
  answer **14,276 / 0 / 194,123** calls per frame, which is the proof the patch is live. On current main
  the #170 leak set is **0 px on all three levels**, so those rows print `LEAK-VACUUM` with the deferred
  call count beside them instead of reporting an average over the empty set. `CZBAND=1` is the half that
  can still fail here: a CEILING step (floors flat, a farther ceiling four cells out) is the mirror of the
  leak geometry, and the ground pass's framebuffer over it hashes **14c12844 / 8ab438b0 / 5a425d84** on
  `76e9356` - recorded as a row, not as prose. Two-sided, measured with the probe byte-identical
  (`b353219a`) and only the engine swapped: the nearer-plane-on-ceiling-rows rule (`eee37f3`, #177's named
  wrong fix) reads **0ef7fae8 / 0c06c14c / 76e93114** and turns **both** rows red on all three levels
  (`CULL 6 FAILURES`, exit 1) because that rule also collapses the control - `nodefer` then hashes
  *equal* to `ship`, i.e. queueing stops mattering - while its own parent (`535e285`) reads
  **bb92cda0 / 80688d4a / 0186ce30**, the values #177 quotes, so the rule is what moved the number (era
  held constant, `px differ` identical at 47,431) and **#188's generated volume is what moved those
  values off main's**. A build with no diagnostic prints **0 rows and exits 0** - silence reading as a
  pass is why the block also counts its own rows (sabotaged to skip one level it reads `2 of 3` and
  fails). Parity with `js/` untouched and every var unset: `cull`, `heights`, `planes`, `alt` verdicts
  identical to `main`, `scene` md5s identical on all three levels, `SMOKE PASSED`.

### Fixed

- **The DEALT sampler's camera is chosen from the grid, not inherited from the spawn seat** (#226). Level 2's dealt frame differed from its flattened twin by 8 px of 203,138 — its spawn camera sees none of the level's 292 off-datum cells — so the `wv = 1` control (band term deleted) tripped only 2 of 3 DEALT levels; `DEALT_SEATS` now seats each level at a datum cell picked by how many off-datum open cells an eye-height FOV sweep enters (137/165, 174/246, 184/292 in view), a new `DEALT-VACUOUS` row FAILs any sampler whose dealt-vs-flat gap drops under 4,096 px (2% of frame), the sampler prints and the row asserts its `rng=`, and the triple re-recorded cold at the new seats: `wv = 1` now FAILs 3 of 3 with both flat triples byte-identical.

- **A step you walk DOWN now has an edge at the lip you are standing at** (#195). `seamCrease` was
  anchored on the **lower** of a step's two floors and always ran its band upward, which is the right
  row for a step up (the eye's floor IS the lower one there) and the wrong one for a step down: the
  wall pass paints a down-step slab side from `yc(the eye's own floor)` DOWNWARD, so the crease landed
  on the far edge of the band and the visible lip got no shading at all. Measured over the lips each
  level offers (36 lips x 3 seeds, 2,040 columns): **57 / 77 / 59 %** contrast across an UP lip against
  **17 / 17 / 29 %** across a DOWN one, the band reaching the lip row on **100 %** of up columns and
  **0 %** of down ones — the failing pixels were never "risers too dark", they were a crease painted
  one band-height away from the edge it describes. `seamCrease` takes the direction now and the caller
  passes the eye's own side; the lower floor's crease is kept where it was, because for a step up that
  is the same row, so **no up-step pixel changes value** (the census reports up lips identical to the
  digit, 49.0 / 69.0 / 42.0 % before and after). `bands`' WALK row: **72 / 27 / 10 % → 72 / 57 / 71 %**,
  within-10 **0 / 10 / 25 % → 0 / 0 / 0 %**, all three `ok` at the 45 % bar and the printed tally moves
  from `3 known-issue row(s) (#195, #203)` to `1 known-issue row(s)`. **Refused, with numbers:** the
  riser wearing the level's own wall family — risers already wear ONE entry (`WTEX.CONCRETE`, in no
  level's palette, not split across families), and swapping it for the level's own family measures
  **71 / 24 / 10** with L2's within-10 rising to 35 %; a global ×1.45 brighten of every riser face —
  **62 / 42 / 21**, mean |dL| on L2 20.4 → 58.9 while its contrast sits at **21 %**, which is the shape
  of a magnitude knob that cannot step pixels which are not stepping (and it reddens #203's floor on
  L2's face lip, 43 % → 27 %); the riser wearing the level's floor texture — **78 / 21 / 18**, so the
  material difference across the seam is load-bearing, not a nuisance; and `v` phased to world height
  instead of the face top — **71 / 26 / 12**. Lighting was ruled out by the same census: the failing
  down lips sit in the *brighter* rooms (frame mean 59–86 against 36–58 for the passing up lips), so
  `AMB` sinking an additive term is not the mechanism, and the shipped term is a multiply anyway.
  `bands`' locality mask now mirrors the band direction it is meant to describe (masking every band
  upward from the anchor hides rows no term reaches and books the rows a down-step lip does reach as a
  6–10 px-lum leak); the mask alone moves no contrast number — 72 / 27 / 10 with main's renderer, same
  as main. Flat senses are byte-identical (PARITY `f9e4da3a/f05beeb5/d4b2d2cd`, LOCK
  `060da4cd/f05beeb5/050b225e`) because a flattened grid has no risers, and `LEAK=1 CZBAND=1 cull`
  `0x9c03d4f4/0xeec7be60/0x7dd66c40` is unchanged because no light moved. The **dealt** lock for level 0
  moved (`ec629433 → ecb797dd`, mean 79.7 → 79.5) and is re-recorded: **1,009 of 203,138 px, every one
  of them darker** (mean −23.3, rows 181..195) — one 15-row crease band at one step-down lip in the
  spawn view — with levels 1 and 2 byte-identical. Raster median 12.07 → 11.72 ms over 3 interleaved
  rolls (N = 5 batches of 180 frames, load 3.1–3.8): no cost above the noise floor, because the extra
  call runs only on riser columns of a step-down face.
- **The lamp glow is now admitted by the band of the surface it paints, not by the screen** (#221).
  `drawLightGlow` composited an additive disc for any lamp that passed `los()` and a distance test —
  no band term, no `fd`, no altitude test of any kind — while `splatLight` has carried
  `|sourceFloor − floorAt(cell)| <= ZQ` since #203. The splat was right and the overlay was not, so a
  lamp standing on the datum painted light *into* the pixels of a pit a unit below it: level 2 roll 9,
  camera on the pit floor, composited **183.8 mean / 245.0 centre-half**, and that frame was
  bit-for-bit identical in **all 17 configurations of a lamp-intensity sweep including `MINF = 0`** —
  a knob that changes nothing cannot be the mechanism, and `MAP.light` read a correct 0.808 there.
  The gate is now the splat's own term evaluated on the **painted surface**: `zbuf` has been a
  distance in every pixel since #163, and project() inverts, so backing `zbuf` off by a few
  centimetres along `dir + plane·(2x/BW − 1)` gives the air cell the ray came through, and
  `MAP.fz` of that cell is the band the pixel belongs to. Rejected runs are dropped from the disc's
  fill (row runs merged down, so a disc over one band is still the one `fillRect` it always was);
  the per-lamp `floorAt` and the per-row `(row − horizon)/BH` are hoisted, and nothing calls
  `ceilAt` in the loop. **Refused: skipping the disc when the source's band differs from the
  camera's cell band** — at #221's camera that draws **0 lamp discs** (a player at a pit lip loses
  the lamp below them entirely, and at L2 roll 1 the source's own band receives **27.44 of 33.3**
  alpha instead of **160.13 of 258.1**), and refused too the altitude-*span* form, which cannot tell
  the underside of the slab the lamp stands on from the floor of the band it bounds (**0.222** of the
  disc leaked into the pit on that variant against **0.000** here). The parity collapse is checkable
  rather than argued: **`flatparity`'s PARITY [LAMPS=off] triple
  `f9e4da3a`/`f05beeb5`/`d4b2d2cd` and LOCK [LAMPS unset] `060da4cd`/`f05beeb5`/`050b225e` are all
  byte-identical** — the glow paints the display canvas in `renderOverlay`, after the buffer
  `flatparity` hashes, so nothing was re-recorded, and `alt`'s new row adds the clause that layer
  cannot see: on a forced-flat level every disc must still be **one rect at alpha 1**, deviation
  **0.0e+00**. `MAP.light` is untouched by construction and asserted: **0 of 181 / 194 / 175** pit
  cells dark at mean delivered **0.426 / 0.423 / 0.464**, blast-fade and the splat/un-splat
  reversibility asserts green, `VERT=1` **25 gating rows / 0 known-issue**, `exposure` medians
  **70 / 72 / 85** identical across the change at N = 4 rolls × 6 yaws. Four controls reddened four
  different clauses of `alt`'s row: **revert-the-term** (frac **1.000** vs **0.000** shipped, every
  other clause identical — the baseline is #221's frame), **camera-band-not-surface-band** (**0**
  discs drawn), **the glow's band term moved into `splatLight`** (pit mean light **0.506 / 0.503 /
  0.551** and wrong-band-lit **55 / 91 / 145** — the lightmap moves, clauses 1–3 and 5 do not, so the
  shipped change is provably in the composited pass), and **the glow deleted** (on-delivered
  **0.000**); **`LAMPS=off`** stays red at **118 / 72 / 62** dark pits, so fewer lamps satisfies
  nothing. Cost: headless `renderOverlay` at a lip camera reads **5.8 ms/frame** with the term
  against **0.12** without, but the identical loop costs **1631 ms in a `vm` context against 28 ms
  in the host** for 12M iterations, so that headless number is the harness, not the browser; it is
  linear in the lattice (a 4× coarser one reads 0.43 ms), which is what the stride is there to tune.
- **Props stop the player, with the footprint the art already authored** (#218). #217 stopped a prop the
  EYE is inside from painting the frame, and said the movement half was a movement change: until now
  `tryMove` gave props no test at all, so a player driven into a crate ended up **inside** it — measured
  on main at SEED 12345, **22 / 24 / 23 driven poses** across the three levels reached a prop and every
  one of them penetrated, **168–177 frames** of drive spent standing inside a footprint, deepest **0.26 m**
  — dead centre. `propBlocks` now consults `MESH.foot(kind) * scale` — the same number #217's render skip
  reads, grown by the mover radius (the Minkowski sum of two axis-aligned squares, so sliding off a prop's
  face is the same geometry as sliding along a wall) — and gates it on the grid: `floorAt` of the entered
  cell against the prop's own band, in quanta of `ZQ`. The test lives in the movement tick, never a pixel
  loop; smoke's raster median is **11.5 ms N=5 at load 1.98** against main's **12.2 N=5 at load 2.36**.
  A band-blind version of the same test stops a player on the datum **0.15 m short of the lip** under a
  prop on the band above, which is #189's family and now reddens the `props` band row; the seal-not-slide
  version freezes face-graze poses **0/4 across every level** beside the prop instead of crossing. The
  embedded escape hatch keys on the same grown radius, not the bare footprint — keyed on the footprint an
  escaping mover freezes in the ring between the two. Enemies respect the same byte: **656 / 490 / 811**
  blocked moves where main reported 0, blocker-overlap frames **376 → 15, 222 → 0, 387 → 16**. No spawn
  landed inside a footprint in **18 rolls**, and a parked-in-prop dev pose drives clear in **7 frames**.
  #217's render-side skip stays as the guard it is. `props` gained 9 rows (3 levels × collision / band /
  slide, each printing its prop census and reached-population, vacuity a FAILURE); smoke's VERT lane
  counts stay **25 gating, 0 known-issue**, and its `vboot` now re-seeds the stream per lane — the V11
  sight row had been riding on how many draws earlier sections happened to make, which #218's movement
  shifted (measured: a pinned eye on a re-seeded world, alert 0/90 across seeds and across builds).
- **`flatparity`'s census counted its own `fill(0)` and reported the game as flat** (#219). The run ended
  with "the hashed levels carry **0 / 0 / 0** cells off the datum" beside a verdict that the band term is
  blind to its own sign — and that 0 came from the probe's own `MAP.fz.fill(0)` two lines above the count,
  on a `main` whose dealt levels hold **165 / 246 / 292** off-datum open cells at the same dice (`alt`
  reads 170 / 251 / 307 at its own unseeded stream). A probe that ERASES geometry cannot fail on a world
  that has any, and then reports the resulting blindness as flatness. The census is counted from the DEALT
  grid now, over open columns with the game's own `MAP.cell`, and a per-level row asserts it. A third
  sense, **DEALT**, hashes each level's spawn frame as generated — no fill, no relink, no lamp re-seat,
  same dice, same pinned-clock ninth render — recorded at `ec629433/96a450d0/22d473ed` (means 79.7/33.7/
  51.7) with the off-datum population and the dealt-vs-flat pixel gap printed beside the verdict. It needs
  its own cold process, which is a measured result and not a taste: rendering anything before the flat hash
  moves LOCK/PARITY — 8 extra renders gives `e96fe6bb/f746bcb5/32d25823` and 9 gives
  `bee34388/90f20cbd/050b225e`, and a dealt render per level moves them whether it goes first
  (`bee34388/90f20cbd`) or last (`37cb3011`, `4e718f4f/b9ba6913`). Churn was measured BEFORE recording
  refs, over the 12 most recent js commits at the pinned dice, two cold samples each and all stable: **9 of
  the 11 boundaries with a measured parent move at least one of the three hashes** — only `4f2b9c0` (#217,
  prop cull) and `acdf91d` (#183) leave the dealt frame byte-identical — and the signal sits almost wholly in
  level 0 (**9** of 11 boundaries move L0, **2** move L1, **5** move L2; the columns hold 10 / 3 / 6 distinct
  values across the 12, so an L1-only lock would have been nearly dead). This is a lock that re-records on
  most js commits and the population clause, not the ref, is the falsifiable half. Controls, each a real
  file variant of `js/20_level.js` in a detached worktree: deleting the `authorVolume` call (the write that
  makes a level non-flat — `fzTry` is allocated all-zero, so absence is what flattens) reddens census and
  DEALT on **3 of 3** levels, exit 1; `wv = 1` (a banded world with flat-shaded light) leaves both flat
  triples byte-identical to main and reddens DEALT on **2 of 3**, exit 1; the one-sided kernel
  `lf - floor >= -ZQ - 1e-9` does the same, which is the first answer this repo has had — rather than a
  hypothesis — to whether a banded-but-flat-shaded world is detectable. Level 2 is the honest exception and
  prints why: its dealt frame differs from its flattened one on **8 px of 203,138**, the alternation floor,
  so that camera sees none of its 292 off-datum cells and its dealt hash locks almost nothing. LOCK,
  PARITY and CZBAND unchanged (`060da4cd/f05beeb5/050b225e`, `f9e4da3a/f05beeb5/d4b2d2cd`,
  `0x9c03d4f4/0xeec7be60/0x7dd66c40`), and the stale 169/**273**/117 this probe's header quotes for level 1
  is corrected to the measured 169/**279**/117 (#219 item 2, named in #216).
- **A pit read as a white box because a coverage top-up was authored as a full lamp** (#213). A 5×3 pit
  (16 cells) and a 300-cell floor received **identical** sources, so standing inside a lit pit read
  `DEV.lum` **168 mean / 229 mid** while the big floor stayed under-lit: #204's symptom with its sign
  flipped. A top-up's intensity is now `TOPUP_BASE * clamp(coveredCells / TOPUP_TARGET, TOPUP_MINF, 1)`,
  `coveredCells` being the count the placement score already computes (`score = sc*16 + OPENAT`), with
  `TOPUP_BASE 1.05 / TOPUP_TARGET 32 / TOPUP_MINF 0.5` as module consts — **not** behind an env var,
  because a row gated on a knob a human must remember is the failure mode this repo already documents.
  `cov/32 = 0.5` exactly for a 16-cell hole, so **TARGET is the pit knob** and MINF only bites on bands
  under 16 cells, where a proportional source would be a dark cell with a lamp prop on it. Placement is
  untouched — lamps stay **9.83 / 12.00 / 19.67** with top-ups **2.83 / 3.00 / 2.67**, so `MAX_ADD = 3`
  still binds — and `topUpEnabled()` is untouched. Pit mean light **0.672/0.631/0.647 → 0.426/0.423/0.464**
  at **0 of 181 / 194 / 175** dark cells, dark-open **252/1083/872 → 253/1087/874**, composited pit floor
  **90.4/89.8/127.9 → 73.5/77.3/118.4** mean and **115.1/119.9/166.9 → 94.2/104.0/156.9** centre-half,
  exposure medians **70/72/85** unchanged. `alt`'s row became **`a pit reads lit, not blown`**, four
  clauses, every value printed: no dark cell, **a population that exists in 11 / 12 / 10 of the 12 rolls**
  (no pit at L0 roll 11, L2 rolls 0 and 4 — a pit row that silently runs on two levels is this repo's
  known blind spot), mean ≤ **0.55**, and dark-open ≤ `round(1.02 × TOPUP_DARK_REF)` = **257 / 1105 /
  889** so dim cannot be bought with coverage. **No composited-frame threshold is asserted**: the worst
  pit frame is immovable by this mechanism (level 2 stays **183.8 mean / 245 mid** in all 17 placement
  configs, because the glow overlay has no altitude term — **#221** owns that half), so a frame rule would
  be permanently red for a reason no lamp change can fix; the frame numbers print beside the verdict
  instead. Controls, each a file variant in its own worktree: this branch **PASS ×3**; `TARGET = ∞` (main's
  full lamp) clause 3 **FAIL ×3** at 0.672/0.631/0.647; `TARGET 256, MINF 0` clause 1 **FAIL ×3** (6/8/4
  dark pit cells — #204's symptom "fixed" by going dark); `TARGET 64, MINF 0.35` clause 4 **FAIL ×3**
  (dark-open **+247/+497/+329**, coverage sold to buy dim); `LAMPS=off` clause 1 **FAIL** (118/72/62), so
  the row cannot be satisfied by deleting the feature. **`PARITY [LAMPS=off]`
  `f9e4da3a/f05beeb5/d4b2d2cd` did not move** — the ramp never runs when the top-up is suppressed at author
  time, which is the knob-independence proof — while **LOCK L0 legitimately moved `4262d051 → 060da4cd`
  (mean 81.3 → 80.8)** because the shipped world gains dimmer sources; L1 `f05beeb5` and L2 `050b225e`
  stay **byte-identical** at TARGET ≤ 64, where the scale is exactly 1 and `1.05 * 1 === 1.05`.
  `LEAK=1 CZBAND=1 cull` holds **0x9c03d4f4/0xeec7be60/0x7dd66c40** with no re-record; smoke **PASSED**
  (blast-fade and splat reversibility green) at raster median **11.68 ms**, `VERT=1` at **25 gating rows /
  0 known-issue**, and the 13-mode roster exits 0.
- **A prop the camera stands inside painted the whole frame as a wall** (#212). The recapture that
  filed this read **93.8 %** of the pixels above the horizon as wall texture at a camera 1.5 m from a
  pit lip, `zbuf` recording a face at 0.14–0.21 m there while `DEV.ray` reported open ground to 9.5 m.
  Attributed on the merged build at that recipe — dealt dice 1000, the page's own **678×359** raster,
  `MAP.riserStops` **678 of 678** at 1.5 m and **675 of 678** at 3.5 m, agreeing with the page to the
  unit — the wall pass is **not** in it: the lip's slab side emits at perp **1.50** with span
  **[−1.00, 0.00]** and paints rows **300..359 of 359**, wholly below the eye line, at every swept
  distance, where the wall-pass oracle reads **0.0 / 0.0 / 0.1 / 3.1 %** at 1.5 / 2.5 / 3.5 / 7.5 m —
  the opposite trend to the report. So neither hypothesis survives: no riser paints rows above its own
  projected top, and no boundary is drawn without blocking (the byte is right — a down-step is
  walkable, the nibble back up is `VB_BLOCK` — and `DEV.ray` cannot see an air→air riser at all, so
  "open ground" was never a disagreement). What owns those pixels is a **prop**: crates and barrels
  are authored at cell **centres** (`js/20_level.js:983`) and `tryMove` gives props no collision, so
  the capture's camera (20.5, 15.5) was standing in the middle of a barrel — distance **0.00 m** — its
  mesh magnified out to the rasterizer's 0.12 m near plane, writing `zbuf` **0.142** through the
  mesh's self-occlusion store (`js/13_mesh.js:764`) where the geography's own ceiling solve reads
  **0.997**. A prop whose authored footprint contains the eye is now skipped; the radius comes from
  the geometry table through `MESH.foot`, not from a guess in the draw loop, and the cull is by
  footprint so a crate 3 m out still occludes. `cull` gains **9 rows** — a poked −1.00 m lip at
  1.5 / 2.5 / 3.5 m with a barrel prop at the camera, on all three levels — which **FAIL on
  `origin/main`** at 94.7 % prop-owned pixels and min `zbuf` 0.155 and pass here at 0.0 % and 1.000;
  pit and prop are both poked, so no roll empties them. Not fixed here, and stated rather than
  smuggled in: props are still not collision, so a player can still walk into one — he now sees
  through it instead of into it. Nothing in the four README cameras sits inside a prop (checked at
  all four poses on all three levels) and every hash held: flatparity PARITY
  `f9e4da3a/f05beeb5/d4b2d2cd`, LOCK `4262d051/f05beeb5/050b225e`, `LEAK=1 CZBAND=1 cull`
  `0x9c03d4f4/0xeec7be60/0x7dd66c40`, so no lock was re-recorded and no recapture is owed.
- **A light lit the band above its own, and a band the lamp budget missed was black geography**
  (#208, #204). #203 closed half of the bleed and left the other half open, because its term compared
  the **emitter height** with the column's floor: `|L.z - floor| <= LHOVER + ZQ` is `fd ∈ [-1.81,
  +0.25]` in **floor** terms, so a lamp lit a floor up to 1.75 m **above** itself (7 quanta) while a
  floor one quantum **below** it stayed dark. Read by signed floor difference over 12 rolls per level,
  that is **275 / 32 / 261** cells per level taking *direct* light from a source standing a band or
  more **below** them (mean delivered **0.799 / 1.001 / 1.032** of which **0.21–0.27** is the crossing
  itself) against **8 / 12 / 6** reaching down, and **43 / 224 / 194** cells whose only light arrives
  across a band. `splatLight` now recovers the source's **floor** (`L.z - LHOVER`, or `floorAt` for a
  z-less source, which never had a hover to subtract) and asks `|fd| <= ZQ`: the source's own band and
  one quantum either way, nothing beyond, in the **un-splat** as much as the splat, so `smoke`'s "blast
  light fully fades out" still has one kernel for add and remove (`alt`'s reversibility row reads
  **1.2e-7** across 10/12/20 lamps). `LIGHT_REACH` is gone with the reach it named — its only other
  reader was a probe string, which is the AGENTS lesson that a "dead" field's last reader can be
  inside a `runInContext` template.
  Closing the reach exposes the second half, because a band that was lit by borrowing now has to light
  itself: **#204's** top-up, retargeted from *lampless* bands to **under-covered** ones. A band is
  covered when a source standing on it delivers ≥ **0.25** to a cell — measured by calling the shipped
  `splatLight` for that band's sources onto a scratch lightmap, so the criterion cannot drift from the
  kernel, and measured **pre-blur** because counting the blur residue is what lets a datum pad stand
  in for a pit lamp (#209). Bands under 8 reachable interior cells are skipped, ≤ 2 lamps go on one
  band, ≤ 3 per level, and the placement maximises how many of that band's unserved cells the new disc
  covers, drawing from a **private LCG**. `MAP.cell/fz/cz/vb/feat/ceilPlane` and the enemy and pickup
  positions hash **identical** to `main` on all three levels; only `LIGHTS` and the lamp props differ
  (7/9/17 → **10/12/19–20**, i.e. **+3.0** per level, where #207's lampless-band rule spent +0.9 — the
  budget binds on every level, so the rule wants more lamps than it is allowed and the guard is
  load-bearing).
  Delivered: the wrong-band population goes **123 / 377 / 337 → 37 / 51 / 75** cells and its **direct**
  component **43 / 224 / 194 → 0**, with **0.0 %** of delivered energy arriving off-band by splat (the
  residual is `blurLight`'s, #206, so it is not 0 and was not made 0 by authoring lamp `z`). Dark pit
  floors **117 / 71 / 62** of **181 / 194 / 175** → **0** at mean light **0.672 / 0.631 / 0.647** with
  the pad left **z-less**; the 3 pad-carried pit cells that #209 measured at SEED 12345 read 0 because
  the reach shrank, not because the pad was authored a height. Raised-band mean light **0.537 / 0.411
  / 0.657 → 0.541 / 0.524 / 0.769** (dark raised cells **205 / 557 / 392 → 52 / 157 / 154**), and all
  open cells **0.428 / 0.379 / 0.593 → 0.546 / 0.474 / 0.670**. Cost, stated plainly: the frame is
  **brighter** — `exposure` means **74 / 66 / 71 → 74 / 76 / 83** (medians 70/72/72 → 70/73/85) and the
  composited gate's medians **86 / 84 / 76 → 86 / 85 / 95**, every median inside 60-100 but L2 19 points
  up. `bands`' L0 face lip, which the kernel term alone drove to **43 %** (a 4th known-issue row),
  comes back to **54 %** against the 45 % bar and the debt rows stay at main's 3; the other five lips
  hold within **±1 point** of main except L2 walk (11 % → 10 %, above its 6 % floor). Own-band blast
  light is **byte-identical** (**658.37 / 1590, 809.29 / 2022, 749.99 / 2049**) and the band **above** a
  blast now lights **0.00 over 0 cells**. Flat parity: the kernel term alone reproduces all three
  forced-flat md5s (**f9e4da3a / f05beeb5 / d4b2d2cd**, means 79.7 / 34.1 / 47.5) and so does this tree
  with the top-up suppressed; shipped, L0 and L2 move (**4262d051** mean 81.3, **050b225e** mean 51.7)
  because the coverage lamps light a world whose bands the probe flattened — an honest deviation, not a
  formula regression, and not papered over by re-recording the md5s. `CZBAND` re-recorded to
  **0x9c03d4f4 / 0xeec7be60 / 0x7dd66c40** with all four quadrants run (variant+new ok, main+new FAIL
  ×3, main+old ok, variant+old FAIL ×3) and the px-difference counts holding at **51048 / 49614 /
  49586** against main's 51047 / 49620 / 49586. Perf is a wash: interleaved 3 pairs at load 2.4–3.0,
  **11.77 / 11.95 / 11.95 ms** against main's **12.33 / 11.45 / 11.72**.
- **"Flat md5 parity holds" stopped proving anything about a term** (#208 follow-up, tool-only).
  `flatparity` compared nothing: it hashed a flat spawn frame, checked the hash against its own cold
  child for **stability**, and printed "compare these md5s across builds" — no recorded reference in
  its whole code path (0 md5 literals in its block at `2c5a94f`), and `ci.yml` never ran it. So the
  sentence every altitude change since M1 has been gated on lived in PR prose only, and since #208 the
  generator authors lamps by a coverage rule, which broke it twice over: the probe flattens `MAP.fz`
  **after** generation, so a shipped flat frame carries top-up lamps that were placed for bands the
  probe then deleted, and the md5 moves with **placement** rather than with any term. The mode now
  prints and asserts **two triples with two names**. `LAMPS=off` (a documented knob styled like
  `WARM=`/`SEED=`, wired to one new call site, `genLevel`'s `topUpEnabled()`, read once per level at
  author time) suppresses the top-up and nothing else — the budget lamps, the exit pad, the grid and
  every global `Math.random` draw stay the shipped ones — and that record must reproduce
  `f9e4da3af18836db903fd7cbdf2b0206 / f05beeb58f1266a1aea7e44712995292 / d4b2d2cd539c3b620ea0ce5ab115d50a`
  at means **79.7 / 34.1 / 47.5**: **PARITY**, the formula-collapse proof a shading change is gated on.
  Without the knob the shipped record must hold **4262d051… / f05beeb5… / 050b225e…** at
  **81.3 / 34.1 / 51.7**: **LOCK**, a regression lock on lamp placement, green is not evidence of
  bit-neutrality, and neither triple may be quoted as "parity" without saying which. The gap is
  decomposed rather than waved away: flat delivered light **469.6 vs 321.0 (L0), 518.6 vs 387.5 (L1),
  839.3 vs 758.6 (L2)** against **3 / 3 / 2** top-up lamps splatted **alone** through the same (linear)
  blur, which accounts for the difference to **1.1e-6 / 8.4e-8 / 2.0e-7** — the residual is the formula
  bug row, and it is noise. Four quadrants seen to disagree, each in its own tree: knob-off + old refs
  **ok**, main's `js` + these refs **LOCK FAIL ×2** (L1 is byte-identical in both records), main's own
  build + its own probe **ok at the old triple** (and unable to fail on content, which is the defect
  this entry is about), shipped + old refs **FAIL ×2**.
- **A probe count that could only ever read 3** (found while writing the row above). The first version
  of the census row classified each level into `md5+sum` or `md5 BLIND, sum+` and then counted
  `seen.filter(s => s[0] === 'm')` — **both labels start with `m`**, so the count was always `NL` and
  the row printed "**3 of 3** move their flat lightmap sum WITHOUT moving a pixel" on the same line
  whose own per-level list said two of the three had moved a pixel. The sentence was the one that tells
  a reviewer the LOCK row cannot see a lamp in a room the spawn camera misses, so it was load-bearing
  prose fed by a constant. Each level is now classified by **both** instruments (md5 moved / lightmap
  sum moved) into `md5+sum`, `md5 BLIND, sum+`, `md5+ (flat sum)`, `BOTH FLAT`, the blind count is
  derived from the md5 comparison the rows are gated on, and the row asserts the two agree (`moved ==
  dLock`) and that a lamp added moved the lightmap — so on main's `js` it reads **0 blind, 3 BOTH
  FLAT**, which is the vacuity `dLock >= 1` already reddens. Honest reading here: **1 of 3** (L1).
- **What no flat frame can ever see, printed where the claim lives.** Replacing the band term's
  `|lf - floor| <= ZQ + 1e-9` with `lf - floor >= -ZQ - 1e-9` — one-sided, blocking the upward half and
  allowing light **down** past any number of bands, and it leaks: `alt` reads **169 / 273 / 117** cells
  lit from a band above on that very kernel (the figure that reproduces today is **169 / 279 / 117** —
  level 1's digit is the one that moved, and it moved with the `#96` seed-to-layout change, so 273 is
  what that older deal measured and 279 is what this kernel measures: `tools/view.js:846` and the #214
  bullet below both carry 279; the second figure in this bullet is the same older reading, kept as
  measured *then*, not re-quotable as current evidence) — leaves **all six** flatparity rows green on all three
  levels, LOCK hashing `4262d051 / f05beeb5 / 050b225e` and PARITY `f9e4da3a / f05beeb5 / d4b2d2cd`
  bit for bit. Not a threshold set too wide: on a flat world `fd = 0` in every cell, so the term
  reduces to the literal 1 before the sign is ever read. Flat parity is **necessary and never
  sufficient** for a band term, and `alt`'s two direction rows are what see the sign (they fail at
  **275 / 32 / 261** upward on main's kernel and **169 / 273 / 117** downward on the one-sided one).
  Recorded in the mode's header so the next reader is not told a proof is stronger than it is.
- **A lamp lit columns whose band it was not on** (#203). `splatLight` splatted a **2-D disc and
  discarded `L.z`**, although lamps carry one (`js/20_level.js:845`, `z = floorAt + 0.78`), so light
  crossed band boundaries as if the slab were glass: **13–17 % of open cells** on every level carried
  **0.208 / 0.222 / 0.263** units from a lamp more than a band away, and **41 / 114 / 67** cells
  (attribution filter; the `alt` row's own filter measures **53 / 135 / 66**) took their **only** light
  from such a lamp at mean **0.583 / 0.410 / 0.549** — geography that reads as lit from a direction it
  cannot be lit from. The kernel now multiplies the disc by a **hover-tolerant** binary term,
  `wv = |L.z − floorAt(col)| <= LHOVER + ZQ ? 1 : 0`, which is **exactly 1 on a lamp's own band** (that
  band reads `dz = 0.78`, and one quantum under its floor reads `1.03`) so no lamp is taxed for standing
  where it stands — the naive `|dz| > 1` gate and the `exp(-(dz/1.5)²)` falloff written in the issue
  both **darken every lamp in the game** and drop level 1's exposure to **49.2 / 56.2**, below the
  60–100 window, which is why the weight is a quantum test rather than a curve. Transients keep no
  authored `z` and default to the emitting cell's own `floorAt` (documented at the call sites and in the
  commit); the exit pad ships `z`-less on that same default because an authored `z` measurably taxed the
  pools near the exit and changed nothing else. Wrong-band-only cells are **0 / 0 / 0**, a forced-flat
  level is **md5-identical** to `9656176` (a comparison made in that session against that commit — what
  holds a forced-flat md5 to a literal today is `flatparity`'s PARITY/LOCK triples, `tools/view.js:863,
  :870`, added by #214 three eras later), splat+un-splat round-trips to **1.2e-7** so the fade asserts
  in `tools/smoke.js` stand untouched, and the new `alt` rows fail **6 times** against HEAD's `js`.
  What it costs is filed as **#204**: the term is a step, so two quanta below a lamp the direct term is
  exactly zero — pit floors lose **79 / 74 / 42 %** of their light and **0.25 m reads floodlit while
  0.50 m reads black**. The ramp that would buy that back was measured and rejected: it returns the
  darkness and leaves **53 / 134 / 66** cells lit through a band boundary with `alt` red six times.

- **The far band took its light from the camera's cell, not from the cell it draws** (#197).
  `castGround` FILLS — does not texture — every row whose own plane solve passes `FARB` (22 m at the
  BALANCED tier): the horizon band of a flat level, the upper half of a tall room, the far side of a
  pit. That fill read `MAP.light` and the tint of `cellIdx(camX, camY)`, the **camera's** column, so
  brightness past 22 m was the lamp luck of wherever the eye happened to stand — measured on the
  deployed build at camera (10.5, 14.5) yaw π/2, that column's `MAP.light` 0.574 and a neutral tint
  predict a fill of 16.5, the frame's upper half measures 16.3, the whole frame 22.7 and **63.6 %** of
  its pixels sit under 24. The row now samples **its own fan**: 8 points across the row at the row's
  own solve distance, one lightmap + tint lookup per sample and **never one per pixel** (a row at
  `FARB` spans ~30 m, so one cell would book all of it to one lamp), and a sample that leaves the map
  gets what the textured path itself gives an off-map column — no light, white tint — which is the grey
  the same ray paints one metre inside `FARB`. The band's *magnitude* came out of the same measurement:
  `(18 + light * 26)` was a texture mean in disguise, so the literals are gone and the fill is the mean
  of the mip the band replaces, with emissive texels averaged by their own light-exempt rule. No pair of
  literals could have worked — sweeping them puts level 0's floors at (19, 26) and level 1's at (70, 7),
  because the floor materials' mip4 mean measures **89–131** and the ceilings' **44–79** — and one
  material (level 2's floor) is 52 emissive texels of 64 at the coarse mip, which a plain mean overstates
  by **+28**. Scored on the row ADJACENT to the band (same frame, same columns, ~1 m apart in distance, so
  the world either side of the boundary is one world and only the shading can move): mean |step|
  **4.2 / 5.8 / 3.4** per level against **18.4 / 19.1 / 9.8** on main, at 9 cameras × 6 yaws × both halves
  of the frame; the raster mean moves by ≤ 0.4 and the composited exposure gate stays at 87 / 93 / 77 (median of 5
  rolls, spawn frames 57 / 48 / 63). `bands` gained a blocking row for that step and for the frame's dark
  share, and it **FAILS on unmodified `origin/main` at all three levels** with no edit to `js/`; `CZBAND`'s
  ground-pass hashes moved to `2711a2a8 / 10157366 / eaee1fd8` because the band legitimately changed.
- **Authored volume made three defects visible that the flat world had been hiding** (#188). (1) A
  **nearer step crease was evicted by a farther riser**: `castWalls` painted a crease in an
  `else if (crk)` *after* the riser's seam, so one ≥2-quanta riser anywhere later in a column deleted
  a 1-quanta crease closer to the camera — **60 of 60** sampled columns on the branch's L0/L2 walk
  lips rendered a lip with no seam at all, and on `main` it was already **53 of 60 on L2**, booked as
  ok because the metric watching it was `mean |dL| ≥ 30`, a brightness test that cannot see geometry.
  (2) Those two lip metrics were themselves calibrated to light level: 0.84 × the luminance of the
  floor in front of the lip is the ceiling the row can reach, so a lip in a room rendering at 27.6
  can never pass any renderer. They gate on **contrast** now — `|a−b|/(a+b) ≥ 0.45` for the luminance
  row, the same fraction of the band's own luminance for the foot drop — with the within-10 term kept
  as a visibility floor and locality measured only on rows no crease in that column reaches, behind a
  coverage guard so the masking cannot read 0.0 vacuously (controls: seam term off = **15 FAIL**,
  eviction back in = **4 FAIL** at 11–12% contrast against 69–70%, crease cap removed = **5 FAIL** on
  locality). (3) Three `vert` rows had premises the bands invalidated, and each was fixed in the
  probe, not in the shipped code it measures: the **auto-step** row poked its lip band only to the end
  of the lane, which a 150-frame walk now steps off — the sample's tail chased a floor of 0 (`P.z 0.25
  → 0.1833 → 0.1344 → 0.0986`, read as `rise spread over 3 intermediate frames`) while the snap at
  `js/30_entities.js:379` had already fired in one frame; the **fall-damage** row dug its pit into the
  level's own loot, and a health pickup standing in that band is taken on the landing frame —
  `damagePlayer(10.6)` fires, hp 100 → 89.40, `takePickup` heals to the 100 cap, and a 2.00-unit drop
  printed **0.0hp** (the row's rule cannot attribute it: the heal lands on the same frame the rule
  uses to recognise fall damage); and the occupancy **split** row raised the `x ≥ N/2` half-plane, a
  flat-world rule about where the spawn sits — on L0 (spawn x 19 of 26) and L2 (30 of 36) it raised
  the ground the BFS starts on, so the exit was reachable *inside* the raised half at d 20 and both
  levels reported `exit sealed FAIL`. It splits on the axis where spawn and exit differ most now.
  Controls, each on unmodified `main` code with this probe: clean = 0 FAIL of 41 rows; the auto-step
  snap disabled = that row FAIL; `imp > 5.25` → `> 99` = the fall row plus the three `hard fall is
  paid for` rows FAIL; `> 1` = the fall row at **−6.0hp** on the 1.25 free drop plus the three
  `jump-speed carry-in` rows FAIL; `bfsReach`'s crossing widened to 4 quanta = all three split rows
  FAIL. **Still broken, and now labelled rather than passed**: **#189**, an enemy on the band above is
  invisible from the datum while the shot that hits you is solved the same way — the probe's POSED row
  reports #189 whenever the body is outside the cone instead of pretending to measure — and **#179**,
  whose cam-1 edge contrast is **16.65 dL against the shipped 24** and 37.94% of the silhouette lost,
  held as a known-issue row with measured floors (15.65 / 41.94) that `STRICT=1` promotes to a failure.
- **The CI audio verdict no longer depends on how busy the runner was** (#168). The inaudible-
  envelope row took the **loudest** `step()` peak of up to 5 renders under a shared CPU, and the
  envelope builder's first ramp can miss its 5 ms window entirely when the event thread is loaded,
  so a low draw could only be rescued by a lucky second attempt: **1 of 16 runs red on an unloaded
  box**, worse under parallel probes, and a sabotage control on `main` **passed the enemy-footstep
  case** (peak 0.27769, 14 of 15 red) because contamination by other systems' footsteps raised the
  average instead of the player's own peak. The verdict is now the **median of up to 7 renders**,
  retried only while that median sits at or below the floor, and each render is **isolated** —
  every `update()` call not issued by the probe is dropped and counted. No max-of-N, no raised
  floor: the 0.002 threshold still means what it says, and the sabotage is red **15/15 and 6/6**
  where `main` was 14/15 with one silent green.
- **A prop on the band above still drew through the slab, in the band of rows just below its riser**
  (#170). **438 / 401 / 398 px at rows 102..127** on L0/L1/L2 stayed visible behind a raised floor.
  Every one of them was painted by the **deferred** ground path (forcing the split never to queue
  removes the leak entirely; forcing it to always queue reproduces it byte-identically), and each was
  queued with plane **2.00** and answered from plane **2.00** — the row's own nearer plane (**1.00**,
  which solves to 2.5–4.0 m against the lamp at 4.00 m) was **never a candidate**, which is why
  tie-breaking the fixed point changed nothing. A deferred pixel now marches the ray the way the row's
  DDA does and adopts **the plane whose cell actually extends to the hit point**, stopping at the
  boundary whose opening `[max floor, min ceiling]` closes at the ray's height (`planeAlong`), and
  `gndWalkEdge` counts the marches that end on a slab edge rather than a plane. The row loop
  deliberately does **not** march: a 40-step DDA per cell crossing measured **38.2 ms against main's
  9.2 on a flat frame** — the documented one-indirection cliff — and no leaking pixel lived there.
  Flat levels are bit-identical (`scene 0 0` md5 unchanged), and so is the **mirror** geometry, which
  is the part that matters: a tall ceiling four cells out with flat floors hashes the ground pass
  `0xbb92cda0 / 0x80688d4a / 0x0186ce30`, identical to main, where the plausible near-plane rule drew
  the **near** ceiling across the room instead. `cull`'s far-slab row now asserts the **whole**
  silhouette instead of excluding rows below the riser's top edge — that exclusion is what let the
  defect print green.
- **A prop, pickup or orb on the band above drew through the floor you were standing on** (#163).
  The ground pass wrote `zbuf = Infinity` on ceiling rows, and a mesh's only occlusion test is
  `occ < z`, so nothing on those rows could ever hide a body: measured at camera `(8.10,19.50)`
  (`floorAt 0.00`) with a lamp prop at `(5.50,19.50)` (`floorAt 1.00`, `ceilAt 2.00`), all **1387**
  mask pixels sat behind `Infinity`. Ceiling rows now carry the ceiling plane's own distance
  (`d = dz*BH/|p|`, finite for any real plane), so the test can lose. No second sentinel was needed
  and none was introduced: the `p === 0` fill keeps `Infinity` for a horizontal ray that never reaches
  a plane. Gated by a two-sided `cull` row - a prop one band above paints **0 px** in the
  ceiling-only band on all three levels while the same prop on the camera's band still paints
  **850 / 756 / 804**, and it fails with **565 / 565 / 490 px at rows 58..101** when the ceiling write
  is reverted. Bodies taller than the room's ceiling plane are now **clipped** instead of smeared
  through it, which is correct geometry against a one-unit world. Cost: WARM interleaved
  **37.23/38.06/37.18 ms** vs main **37.94/38.72/37.43** (-1.4%), smoke median **8.98 vs 8.95 ms**.
  Known, not hidden: **398-438 px at rows 102..127**, below the riser's top edge, still draw through
  the slab because `groundPixel`'s fixed point oscillates between the low and raised planes and gives
  up on the far one - the quantized-domain non-convergence recorded in AGENTS, now with a visible
  consequence (#170).

- **Altitude was in the grid but not on the screen: a step lip read as a ramp and the minimap
  ignored height** (#164).
  A human playing the deployed build after #162 could walk up a staircase yet could not tell they had
  changed level. Risers wear the level's floor material, measuring **86.5 / 87.0 / 86.4** against floor
  **73.2 / 71.4 / 71.0** - a brighter patch of the SAME texture, so there was a luminance cue and no
  EDGE cue, and the minimap read `cell`/`explored` only. A multiply **crease** is now drawn on the row
  where the visible surface changes (light-independent, because an additive rim is floored by `AMB 0.19`
  exactly where separation is needed), plus a band tint per band on the minimap (band 0 keeps the colour
  that shipped, so a flat level paints byte-identical ink). Mean absolute luminance jump across the lip:
  faces **32.1 / 16.1 / 38.4 -> 97.3 / 37.8 / 118.9**, walkable lips **9.4 / 6.9 / 2.0 -> 45.4 / 55.9 /
  34.3**, and the share of walkable lip pixels within 10 luminance of their neighbour falls
  **72.9 / 100 / 100 -> 0.0 / 18.3 / 16.7**. Gated by a new **blocking** probe, `view.js bands`, that runs
  the real DDA per column, cross-checks every claim against the renderer's own `zbuf`, counts pixels
  instead of averages, and fails 11 rows with the seam term switched off.
  Known and filed, not hidden: the **walkable** half of the seam keys on the wall march's first crossing
  rather than the ground pass's own plane test, so it lands correctly in 38/60, 48/60, 33/60 columns
  (#167).

- **Generated levels contained no altitude: every shipped level was a flat slab** (#152, M3's
  generation half).
  `genLevel` allocated `MAP.fz` as all zeros and no line in `js/` ever wrote it, so the whole vertical
  feature - staircases, landings, ladders, band-aware visibility and shots - had nothing to exercise;
  `view.js alt` proved it every run by asserting **flatness** (`ALL FLAT ok`), because flatness was M0's
  exit gate. `authorHeights` now raises room interiors by one unit and links them to the datum with
  4-cell stair runs (or a ladder where the mouth is too short), **before** the occupancy BFS, so the
  generator's reachability gate walks the same grid the player will (`bfsReach` counts `|dq| <= 1`,
  `VB_RAMP`/`VB_LADDER` nibbles and `FEAT_LADDER`). Measured per level: **116 / 144 / 211 cells off the
  datum**, 3 staircases, `0 unreachable of 572 / 897 / 1145`, spawn and exit on the datum, and the
  generator's own `cell`/`lampPos` draw-stream **hash unchanged**. `alt` now asserts the opposite of
  flatness (>= 2 bands, a link into every band, 0 unreachable, a climbable staircase) and is in the
  **blocking** probe list - it can no longer report "ok" for a world with no stairs. Side effects found
  and fixed in the same pass: **riser faces wore `WTEX.CONCRETE`, luminance 136, in no level's palette**,
  and at the 3.19 m mean perpendicular they hit the wall falloff at `li 0.679`, which pushed level 0's
  composited exposure to **103.3 outside the 60-100 window** - risers now wear the level's own floor
  material (raster +1.9, gate green at 94/94/65); the eased auto-step became a **one-frame snap** so a
  step-up cannot drift through a riser; and `view.js`'s exposure sweep set `P.x/P.y` **without seating
  `P.z`**, which rendered half its banded cameras clamped out of their band.
- **A projectile had no ceiling: an orb fired upward passed through it and kept flying** (#148).
  `updateProjectiles`' only obstacle test is `isSolid(nx, ny)` - two dimensions - and `ceilAt` is called
  nowhere in `js/30_entities.js`, so an orb launched in a room whose ceiling plane is **1.000** reached
  **z 4.771** on the deployed build (5.194 in the new lane's pose) and was **still alive 120 frames later**:
  enemy fire crosses a ceiling and lands in the room above, the M4 failure mode AGENTS risk #3 named, and it
  shipped green because every altitude row tests **hitscan** (V13-V15) or a **poked** band. Orbs now pop at
  the plane with a spark and grenades bounce back **down** into the room they were thrown in; the same shot
  after the fix peaks at **0.993 and pops on frame 15**. Gated by a new VERT row **V18** (lane now 22 gating
  rows) that gates both directions: an escaping orb fails, and so does an over-eager "delete anything above
  the plane", because the grenade must stay alive and come back down. The stale line in `tools/smoke.js`'s
  VERT header claiming a projectile's planes are the literals 0.02/0.08 is corrected (#98 moved the floor;
  the ceiling was the gap). V18's first version was **silently absent** - `vsetup` returns `ok`, and
  `if (!vsetup(...)) { body }` runs the body only when setup *fails*, so nothing printed and nothing
  asserted while every neighbour stayed green; the tells were the lane's `N gating row(s)` count holding at
  21 and a control run against `HEAD` that failed to fail. That lesson is now in `AGENTS.md`.
- **The game was silent, and had been for a while: `chain()` handed the pan argument straight to
  `connect()`.** Every positional sound passes `panOf(e)`, which returns `Math.sin()` - a **number**
  (`js/30_entities.js:454`) - while `chain(node, pan)` (`js/00_core.js:98`) did `node.connect(pan)`, so the
  executing statement was `gainNode.connect(0.4)` → *"Failed to execute 'connect' on 'AudioNode': Overload
  resolution failed"*. The node factory that branch wanted, `panner(rel)`, was called from nowhere in `js/`,
  so the only working branch was unreachable; `pan === 0` was the single value that survived (`if (pan)`
  falsy), and `Math.sin()` is rarely 0. It got worse than one bad sound: the fault wrapper
  (`js/00_core.js:205-214`) catches, **closes the context** and leaves every `SND.*` method a no-op, so the
  first enemy at your left flank silences the game for the rest of the page's life - measured on the
  deployed build as `S.audioBroken: true` with `acState: "NO CONTEXT"` at boot, `S.sound` still true, no
  exception escaping, `update()` healthy. `chain()` now takes a pan **position**, builds the `StereoPanner`
  itself and clamps it to ±0.9; the dead `panner()` is gone. `S.err` also stops being erased while
  `S.audioBroken` is set (`js/50_ui_input.js:173` cleared it on every successful frame, so the reason lived
  for 16 ms - that is what "`Serr: null`" in an audio bug report actually meant).
- **Audio now has a numeric gate, which it never had.** `node tools/ci/assert.js audio` drives 37 sounds
  with the game's own argument conventions (pan as a number, weapon kinds from `WEAPONS`, enemy kinds from
  the level configs), each through its **own** `OfflineAudioContext` at 44.1 kHz, and asserts on the
  rendered waveform: nothing throws, nothing renders silence. Per-sound contexts matter - one graph that
  dies and takes the bus with it is the bug being tested for. An `AnalyserNode` tap on a *live* headless
  context was written first and rejected: `--headless=new` reads a render clock that does not advance, so
  all 38 peaks came back as one constant (0.19631) and the audible half of the assert could not fail. Two
  sounds are named as **not** covered rather than silently counted: `fanfare` (notes scheduled with
  `setTimeout`, so offline rendering measures a stopwatch) and `startAmbient` (a loop, different waveform
  per run). Verdict `AUDIO ok peak=0.27984, 37/37 sounds render signal` / `AUDIO GATE FAIL`, exit 1 on
  failure, 3 when the harness itself could not look (a build whose `SND.init` takes no context argument
  prints *"this harness being blind, not the game being silent"* instead of a fake red). Controls: fixed
  build with only `chain()` reverted → **exit 1, 37/37 threw**, `S.err` naming `Object.chain … :104:38`;
  pre-#157 build → exit 3, not a false green. `SND.init(ctx)` is the seam that makes this possible and the
  game never passes an argument. Closes #157.

- **Level 2 was dark before any post-processing: its lamp count never grew with its size.** `js/20_level.js:530`
  loops `cfgL.lamps`, which is **6 / 8 / 9** for sizes **26 / 32 / 36** - 0.0089 lamps per cell on level 0 against
  **0.0069** on level 2, 22% sparser in the biggest level. Its raster median read **42.5** (53 by the even-count
  artifact below), under the documented 60, so bloom and the vignette were never the cause: switching each shipped
  term off in turn attributes **+28.4 / +27.7 / +8.6** to bloom, **-1.9** to grade, **0.0** to grain, closing to
  within 1.5 points of the composited frame on all three levels. `lamps: 9` to **16** at `:19` moves level 2 to
  **73** on the raster and inside the window composited, while levels 0 and 1 generate byte-identical levels
  (raster 73 / 76 with unchanged rolls, composited 86 / 90) and `smoke` stays green. This also lets the exposure
  step in `ci.yml` be **un-parked**, which completes #47: brightness on the layer the player sees is now blocking,
  not reported. Area-scaling the lamp formula instead of the literal was measured and rejected - it puts level 1
  at 104-117 composited, outside the top of the window.
  Filed rather than folded in: **#149**, because `:531` places lamps with `takeNear(1)` with no spacing or per-room
  guarantee, so level 2's roll 0 stays at 37-48 in every config measured and part of this +35 is content churn (a
  geometry-identical +10-lamp control buys only +23); and **#150**, because `js/40_render.js:780`'s
  `brightness(1.5) contrast(2.1)` composes to `out = 3.15*in - 0.55`, an absolute threshold at in 44.5, so the
  bloom *source* loses energy on a dark frame - gain **x0.67** on level 2 against **x1.28 / x1.22**.
- **`tools/ci/assert.js` left a Chrome profile directory in `/tmp` on every run (#145).** The merged CI log
  ended with `left /tmp/breach-ci-WjYoXX behind: ENOTEMPTY: directory not empty, rmdir '.../Default'`: the
  cleanup removed the profile immediately after SIGTERMing Chrome, so the remove lost to a process that was still
  writing, and the 10 retries of 200 ms were all spent while that process was alive. It now waits for the child
  to exit (up to 4 s) before removing, and a remove that still fails prints the path on **stderr** so the verdict
  stays the last line on stdout - the note had been landing after `EXPOSURE GATE FAIL`, where it reads like part
  of the verdict. Measured on `main`: two full runs, no new `/tmp/breach-ci-*` directories (20 already there from
  earlier runs), exit code still 1 on the parked level-2 failure, stdout ending with the verdict.
- **The v1.1 release said the recaptured frames sit 23-44 luminance points below the captions they replaced, and that was wrong.** Four cheap checks replaced it, each eliminating one confound: the era build predates **#96**'s seed-to-layout remap (same seed, different level - that commit's own body measures 12 constructed-and-discarded enemies moving a rendered level's mean 66.4 to 70.2, and 66.4 is the era number in the table); bisecting the probe's *printed* frame mean lands on **#91**, which changed what that number means, not on any renderer; bisecting the PNG's own pixels lands on #96, a different level rather than a darker one; and a printed `frame: mean 59.1` "disagreeing" with a sampled 28.7 was two probe paths writing the same temp path - `exposure` falls through into a scene dump at a camera its rolls left (`#58`, `#61`), while `scene 0 0` photographs cam0 - because within one `exposure` run the printed number and the PNG it leaves agree at 59.1. #139 is closed as not a defect. Nothing in the thread was outside **#87**'s measured roll spread of 18-70 points, which is the constraint the captions now state instead of implying.

## 1.1 - 2026-09-28

The verticality foundation. M0-M3 landed: a quantized per-cell height grid with absolute
player altitude, boundary faces with real z spans, the ground and ceiling planes solved per
cell, and the links plus gravity, step, fall and climb behaviour that make a column below you
a place a shot, a mark and a body have to respect. **Not in this release: content.** Generated levels
are still flat - measured in the deployed page, `MAP.fz` is 0 in all 676 cells of level 0 and
`MAP.cz` is 4 in all 676 - so verticality here is engine, probes and authored behaviour, not picture,
and M6 is the release that gets to change that sentence. 69 PRs merged since `baseline-v1`, most of
them correctness work on things that had never been tested at altitude: what a shot hits, what
a mark sits on, where a body occludes, which cell owns a light. Screenshots were recaptured from the
deployed build for this release, and the centre of the frame measures 23-44 luminance points below the
numbers in the captions those shots replaced while `view.js exposure` is unchanged across the same pair
of builds - which turned out not to be a darkening at all: `83d9411` predates **#96**, whose removal of
`makeEnemy`'s global `Math.random` draws inside `genLevel` means the same seed lays out a different level,
so the two numbers photograph different rooms. #139 was opened on that difference and closed as not a
defect. This sentence shipped wrong in the release and was corrected afterwards, which is why it says so.

### Added

- **Documentation moved into `docs/`, and a release is now something this repo does.** `docs/ROADMAP.md` (moved with `git mv`; references updated in `README.md`, `AGENTS.md` and `ci.yml`'s seed comments), a new `docs/README.md` index, a new `docs/RELEASE.md`, and `docs/screens/` where it was. `docs/RELEASE.md` sets the trigger — a milestone issue closing, **50 merged PRs since the newest tag**, or the README's screenshots no longer describing the game — plus the version scheme — numbering runs **forward from the changelog's existing `## 1.0`**, whose own text says it is tag `baseline-v1`, so `v1.0` aliases that tag, MINOR per release, MAJOR at playable-complete (M6 authored, `0 known-issue row(s)` in the VERT lane, both smoke lanes green, no open P0) and the checklist, which ends with screenshots captured **from the deployed build** and a tag on the merge commit. `.github/workflows/release-guard.yml` enforces the 50-PR floor, measured as merged PRs whose `mergedAt` is newer than the newest tag. The arithmetic that motivated it, from live data: **68 merged PRs against one tag (`baseline-v1`, 2026-09-25) and zero GitHub releases** — so the first release is overdue by the rule's own arithmetic and lands as `v1.1` straight after this PR, with `v1.0` aliased onto `baseline-v1` so the published baseline finally has a tag. Sequencing matters and is the one design fact worth keeping: **a blocking check that is already overdue would deadlock the PR that introduces it**, so the guard lands running-but-not-required, the release PR (head branch under `release/`, the only exemption, and printed as waived rather than hidden) pays the debt, and *then* `release` joins the required contexts — a PUT that has to carry all four (`test`, `changelog`, `issue`, `release`), because protection on `main` currently requires the first three with `strict: true`. The guard fails rather than reporting zero when the query errors (#122's shape), counts through `gh pr list --state merged` because a REST `sort=updated` paginate can hide a merged PR behind recently-updated closed ones, and on the weekly schedule opens or updates one issue titled `Release debt: N merged PRs since vX`, so debt is visible in the tracker and not only as a red check on somebody's PR. Verified locally where the machine allowed: all six workflow files parse under `tools/wfyaml.rb`'s structural rules (ruby is absent here, so CI's `yaml` job stays authoritative) and the count step run by hand prints `newest tag baseline-v1 at 2026-09-25T17:51:41Z / release debt: 68 merged PR(s) / verdict FAIL`. No `.js` changed, so smoke and the probes are unaffected by construction.
- The changelog's duplicated `### Added` and `### Fixed` headings inside `Unreleased` are collapsed — one of each, which is what a release PR re-headers, and how it accumulates two is now written into the release checklist rather than discovered at release time.
- **`view.js mip` now gates the emissive FETCH, not just the mip chain (#123).** #20 fixed two sites and the probe only watched one: the census row counts alpha bytes in textures, so it can tell that `buildMips` stopped manufacturing `254`, but nothing exercised `castWalls`' bilinear decode, where a wall pixel's flag came from a *blend of the four corner alphas* and a pixel that merely touches an emissive texel averaged to `254.x` and lost the light-exempt branch in **mip 0** — verified only by two scene hashes moving. The new row builds three textures with one colour (`170,160,150`, so the colour blend is identical across them and cannot confound the comparison) on identical geometry, identical light and `G_GRIT=0` (grit's `gk` swings ±0.6 at default quality and would swamp the difference): every texel `253`, every texel `255`, and alternating columns of each, then compares the third render's pixels **one by one** against the first two and requires every one of them to be self-lit. Passing line: `2352 wall px on the face at (18.5, 3.5) +4 -> WALLS[4], perp 3.5 m (band 3.5-3.5, mip 0 of 4, 96.6 px per world unit, AMB 0.3, light 0.026) | all-emissive mean 151.5 vs all-opaque mean 107.6 (gap 43.9) | straddling: 2352 match emissive, 0 match opaque, 0 neither`. Controls: putting the blend back gives `1203 emissive, 1006 opaque, 143 neither` and widening the test to `>= 253` collapses the emissive/opaque gap to **0.0** — both directions fail. Two findings came out of building it. The bug **truncates**: a straddling fetch whose flagged corner weighs under 0.5 blends to `253.x` and `| 0` still reads `253`, so a period-8 pattern passed on the broken build (`1519 -> 1329` emissive, only 190 of ~588 straddling columns moved) and the pattern has to be dense enough that *every* quartet has a flagged corner for the row to mean anything. And the candidate face must be chosen by what `castWalls` **resolves** (`zbuf` flat and near across the sample band): `castRayDist` counts a blocked boundary as a wall and offered a "face" at 2.5 m that the renderer paints at 5.1 m, which would have asserted on pixels that are not that face. The face must also land on mip 0 — asserted outright, since a deeper chain is uniformly `253` after #124's sticky flag and would match emissive for the wrong reason.
- `DEV.mesh()` draws a character as volumetric geometry instead of a billboard, and that geometry now occludes **itself**: the rasterizer writes its own per-pixel depth, so an arm behind a chest stays behind it instead of painting through it. Nothing in the game calls it — the shipped picture is byte-identical (7 scene frames md5-identical to `main`) — and `DEV.mesh({self:false})` puts back the old read-only-depth ordering as a negative control (#69).

- Work is tracked in GitHub issues: every PR must reference one with `Closes #N` or carry `[no-issue]`, the tracker holds milestones and defects that used to live as prose in ROADMAP.md, and a weekly triage sweep reports open issues with no priority or area label.
- `?dev=1` boots the game with no click and no pointer lock and publishes a `DEV` console API (deterministic camera and enemy placement, frozen frames, a DDA ray query, runtime quality overrides including the character rim light), documented in the README.

### Changed

- A level now depends on its seed and nothing else. `makeEnemy` took **ten** draws from the global `Math.random` stream per enemy (gait phase, tint, facing, fidget) and it runs *inside* `genLevel`, so how many enemies a level happened to contain reshuffled its wall textures, lamp positions and pickup phases: constructing twelve of them and throwing them away — no gameplay effect whatsoever — moved a rendered level's mean luminance from 66.4 to 70.2. Per-enemy cosmetics now come from a private stream keyed to a spawn counter, the same xorshift the asset painter uses, which is also what finally lets a probe compare two levels at all: `view.js planes` hashes generation after constructing 0 and 12 enemies and reports `GEN-COUPLE ok`, and it fails all three of its comparisons the moment the coupling is put back (#90).
- Enemies no longer all die the same way. Each kind now authors three death rows — topple angle, fall direction, per-limb swing, how far the body sinks — and the variant is dealt **at spawn**, so a firefight leaves a mix of corpses instead of twenty copies of one pose with the same leg in the air. Variant 0 is the pose that shipped, number for number, which is why `view.js stats / vert / props / heights` are md5-identical to `main` across this change; and the variant is dealt by a **spawn counter rather than a random draw**, because `makeEnemy` runs inside `genLevel` and a single extra `Math.random()` there advances the seed stream and rebuilds every level for a given seed (#82).
- Props are geometry too. A barrel, a crate, a lamp, the three pickups, an orb and the exit portal are rasterized as solids instead of cards that turn to face you, so a prop has a side and a top; the orb and the portal keep their glow through a light-exempt path in the mesh rasterizer, which is what the billboards' alpha byte 253 was for; and a prop's feet come from `floorAt(x, y)` instead of the generator's literal `z: 0.0`. Two traps came with it: a prop's albedo needs the `Surf.lift(1.35, 6)` that `propTex` applies to every prop sheet (without it a crate's brightest pixels measured 62 where the sprite measured 101), and props need a flatter Lambert ramp than bodies (0.75 + 0.42·d against 0.30 + 0.85·d) because `drawBillboard` has no normal term at all — borrowing the body's ramp turned a hazard-red drum the colour of dried mud. At the shipped census (20/25/30 props plus 8/11/13 pickups, all visible from one camera) the cost lane measures **+0.26/+0.58/+0.78 ms/frame** on levels 0/1/2 over interleaved drawn/parked batches, on frames whose prop-free floor is 3.10/3.53/3.57 ms — and the same lane pointed at `main`'s billboards reads 0.02–0.05 ms, so the cards were nearly free and the solids are not; that is the trade #76 accepted. Silhouette-edge contrast is level: mean dL 34.7 to `main`'s 35.0, lost 10.3% on both, at one camera per level on one machine. `view.js props` fails 40 assertions on the build before it (#76, #69).
- Characters are geometry. An enemy is rasterized as a volumetric mesh at its real position, heading and floor height instead of as a billboard whose yaw is one of 8 buckets, so a body has sides, an arm behind a chest stays behind it, and rotation stops popping between poses. Bodies read further apart from the room they stand in — silhouette-edge contrast went from dL 18-40 to dL 22-52, and the share of edge pixels lost against the wall from 23-42% to 0-33% (`view.js contrast`, 3 levels x 3 cameras) — and a crowd got cheaper, not dearer: 18 enemies on screen measured 13.0 ms/frame of billboard poses against 3.3 ms of mesh, and `WARM` stress 13.31 ms avg / 31 ms worst against 4.11 / 11. The one tier that pays is PERFORMANCE, which drew pre-baked sheets and now pays +0.25 ms at 8 bodies, +0.56 ms at 18. What the mesh cannot do yet is animate: a walking enemy no longer cycles a gait and a dying one fades in place instead of toppling, which is why the sprite sheets and pose rasters are still built but no longer drawn (#69 B2, #39).
- Inline the wall bilinear fetch at its single call site and wrap the neighbour texel with an integer mask, guarded by a new smoke assertion that every wall mip dimension is a power of two (#25).
- Occlusion depth is one value per **pixel** instead of one per screen column: the ground pass writes the distance it already solves — including the pixels it queues for the lip of a step, whose colour comes from a different plane than the row's — the wall pass writes its own face span, and the sprite and particle paths compare per pixel. No pixel changed colour, and a column with no wall no longer holds a stale zero that hid sprites there. A flat ceiling row keeps the "occludes nothing" sentinel until the pass that clips against it (#45).

- The `issue` check now accepts the `Refs #N` form AGENTS.md tells us to use, so a PR that is one step of a milestone no longer fails a required check for not closing that milestone.
- The player obeys the height grid: a quantum of floor steps up without a jump being pressed and two
  quanta stops the player, landing from more than about 1.5 units costs health scaled by the impact, and the
  up/down keys change altitude only on a cell flagged as a ladder or a crossing flagged as one. No shipped
  level has a height or a ladder yet, so all of it is asserted as behaviour in `view.js vert` (#14).
- Cell heights are now assigned before the generator's occupancy gate, and reachability is height-aware: a boundary is crossable only when the two floors are within one step. Flat levels are unaffected, pixel for pixel.
- The floor and ceiling are now solved against the height of the cell each pixel's ray lands in,
  instead of against the eye's own floor and ceiling stretched across the whole level: nothing
  changes on today's flat levels — that parity is the gate — and `view.js heights` is the probe that
  proves a room's floor and ceiling now follow the room rather than the camera.
- The extra-seeds check runs on merges to main instead of on every branch push and pull request: it printed the same informational verdict every time and cost ~6 runner-minutes doing it.
- Verification rule written down: anything observable on the live site is verified without waiting for a human report. Fixes a stale note claiming image input is broken here.
- README shows what the game actually looks like today, captured from the deployed build, and that pass is a standing rule after every visible merge.
- Merged branches are deleted instead of accumulating: the repository deletes on merge, and a weekly sweep catches what that setting cannot reach.
- CI required check drops from ~8 min to ~1.5 min: the probes moved to their own job beside the gate, so only guards, syntax and the full smoke run stand between a PR and a merge.
- CI required check is ~6 min faster: the informational seed runs moved to their own job. The PR changelog guard reads the body from the environment now, so a body containing an apostrophe no longer breaks it (or reaches the shell).
- Repo is public, with CI on every push and PR, and Pages deploying every merge to main.
- Weapon viewmodel rebuilt: one bore axis for all three families, so the muzzle flash now comes
  out of the muzzle instead of 90 degrees to the side, and the forearms reach past the frame.
- Characters are drawn with a rim light so they separate from dark walls, and render at roughly
  2.3x the earlier texel height instead of going blocky up close.
- The muzzle flash is a flash: a cone down the barrel plus a 5-spike star with a per-weapon
  flicker seed, instead of a dim circle on the gun's right.

### Fixed

- **A shot aimed into the ground now hits the ground.** `hitscan` tested enemies, barrels and (since #125/#128) the band a shot travels through, and had **no test against a floor plane**, so a descending ray crossed the surface under the shooter's feet and kept flying. Measured with the new row's own geometry: an eye at 0.500 firing down a flat lane at `tanP -0.276` answered **`no floor at t 22.5, WALL`, one mark at x 25 z 0.113** — a bullet hole on the far wall 22 m away, from a shot that should have died 1.81 m out. `bandExitT` gained its third exit (kind 3): the ray crossing the floor plane of the **governing** band, solved exactly as `(fl - az) / tanP` and re-keyed per sampled cell like the ceiling, so the flat case stops at `t 1.812` with one ground splat on that cell's own plane (`floor true, wall false`, tracer at `h.z`). The re-key is what keeps a staircase passable to a shot: with `fl` never re-keyed the same staircase shot dies at **`t 2.273`** on the plane it stood on rather than running down the stairs into the wall at their far end. Both directions are gated by VERT row **V15**, which builds the two geometries from one flat lane (a pitched-down shot on flat floor, then the same lane stepped down one quantum per cell) and takes its expected `t` from the frame's measured `eyeH()` and `pitchTan()` rather than a literal, so a sensitivity change moves the want and not the verdict. Two findings came out of writing it. **A 1-unit drop has no legal shot into it, and the arithmetic is the finding, not the row:** from an eye at 0.50 a line to a chest 1.00 below at 4.00 out descends at −0.25 and crosses the shooter's *own* floor plane **1.87 m ahead, inside the shooter's cell**, and a sunk cell's ceiling is derived as the underside of the neighbour's floor, so the boundary opening is `[max floor, min ceil] = [0.00, 0.00]` — the strip between the floors is a slab side and the only honest answer is a floor hit. So `view.js sight`'s `band -1` rows, which lowered the enemy's cell by a whole unit and asserted the shot arrived, were asserting this defect as a feature (the same shape as #128's sealed-opening rows), and they are rewritten here onto a **staircase** — one quantum per cell, which is the slope those rows already aim along, so every boundary on the flight has an opening and the ray stays 0.25 above each floor instead of under it. The probe-only control (rewritten rows against unmodified `main`) prints `SIGHT ok`, so the rewrite changed no behaviour, only what it was hiding; the stop answer for the single-drop case is V15's first half. The other finding saved a change: #131 expected `addGroundSplat`'s `z: 0.01` to need an absolute altitude the way #120 fixed `addWallMark`, and it does not — the ground decal path paints from the cell grid via `decalAlpha(dc, cx, cy)` (`js/40_render.js:468-475`) and never reads `dc.z`, so a splat already sits on its cell's solved plane and the "fix" would have been inert code. **This changes game feel and wants a play-test**: shots fired downward now stop at the floor instead of travelling along it, which is correct on a flat level and is the same question as falling through a hole. `scene` md5s identical on four frames, all ten probes and `exposure` green, raster 10.22 ms against 10.22 on `main` — the march is bounded by the wall distance, so it costs samples on descending shots only.
- **A shot fired at a step now hits the step.** `hitscan`'s wall verdict came from `castRayDist`, a 2D march, so it never noticed a boundary whose floor is above the ray: firing level at a band raised 0.75 m reported the **far wall's** face 21 m away and marked *that* face at eye height - a bullet hole in a wall the bullet never reached. `bandExitT` (js/20_level.js) now classifies what the ray meets at each sample and returns `{t, kind, side}`: a ceiling crossing stops the shot with no wall and no mark (#125), and a boundary whose floor is above the ray is a **riser** - a drawn face, so it reports a wall hit solved exactly on the boundary's integer plane, `addWallMark` clamps the mark into the opening `[_max floor, min ceiling]` (both sides are air here, which is why that top is a `min` over air cells only - a solid side's `ceilAt` is the fiction), and the tracer and hole belong to the riser instead of whatever stands behind the drop. Getting there corrected two things believed about the plane tests: **the governing band is the one the ray is inside, not the one the sample lands in.** A cell *lower* than the shooter - a pit, or a `sight` probe config of -1 unit - has a derived ceiling equal to the surrounding floor plane, so a state test reads "above the ceiling" on a ray descending over a hole and stops it at the boundary (`sight`'s band -1 rows turned into `MISS t 1.8 into wall`); and a ray that has already left its band downward through its own floor plane must not be called a riser either, because hitscan models no ground at all, so it keeps flying and still reaches an enemy standing in a pit below. Both directions are gated by the new VERT row V14 (a step across a lane, fired at from below the riser and through the 25 cm opening above it): with the term removed it prints `wall at t 22.5, 1 mark at x 25 z 0.525`, with the term fired on *any* floor difference the pitched sample fails at `WALL at t 1.5`. `scene` md5s identical on all four frames, exposure unchanged at mean 69, raster 10.50 ms against 10.22 on `main` - the march is per shot, and the spread says noise. #128 also asked for a "fire down a lane into a lower band" row; that case needs the ground test this does not add, so it stays open as the honest pre-existing behaviour (the ray passes over the edge and reaches what is below it), noted in the pass header rather than claimed fixed.
- **A shot aimed at the ceiling no longer hits the wall behind it.** `hitscan`'s wall verdict came out of `castRayDist`, a 2D march, so the ray had no altitude test at all - enemies got one in #98 (`hz` against their own band), barrels got one, walls got none. Measured on the deployed build, one shooter and one face spanning 0.00..1.00: a ray pitched up until it reached z 2.50 answered `wall true` at the face's own distance and punched one mark at z **0.856**, which is the face top minus the decal inset - a bullet hole along the top edge of a wall the bullet had flown over. `bandExitT` (js/20_level.js, beside `losZ`) now marches the ray's own path and stops it where it rises through the ceiling plane of the cell it is in, re-keyed **per sampled cell** so a shot travelling through a ramp or atrium opening is not stopped by the ceiling it started under; the click leaves no mark and the tracer dies on the ceiling instead (`js/30_entities.js` grew the band-hit particle for it). Reverting the wiring reproduces the old verdict exactly: `WALL at t 23.5, z 28.7, 1 mark` in the new VERT row, which also fails the other way if every shot is stopped (the level control then prints `VACUOUS`). The floor half is deliberately not here - stepping below a cell's floor means the ray met a **riser**, which is a face, so that answer is a wall hit with a mark and it also turned out to implicate the harness: `view.js sight`'s `+1 band` rows raise the enemy a full unit, which leaves the boundary's opening at [1.00, 1.00] (empty - the enemy is sealed off) and asserted a hit through it purely because nothing tested altitude. Those six rows are rewritten here to an atrium (the lane's ceilings lifted over the shot's whole flight, because `ceilAt` is per cell - one tall cell just moved the stop one cell down the lane, `MISS t 1.8`), and the probe-only control - rewritten rows against unmodified `main` - prints `SIGHT ok - hit tests follow the body they hit`, so the rewrite changed no behaviour, only what it was hiding (#128 tracks the riser half, with the rows it needs). `scene` md5s are identical on all four frames and raster is 10.23 ms: nothing here touches the picture.
- **Glowing surfaces stay glowing when they are far away.** A texture marks a texel as emissive with alpha **253** and the renderer matches that byte exactly to skip the scene-light multiply, but the mip chain averaged alpha (`aSum / 4`, and `i0` truncates), so a 253 meeting three opaque 255s became **254** - a byte no read site recognises. Every emissive area therefore switched itself off as it receded: measured on the deployed build across the whole texture census, 84% of `FLOORS.FLESH`'s emissive texels were 254 by mip 1, `CEILS.SINEW` reached **0 kept** by mip 3, and `WALLS[1]` lost all of them by mip 2, while no mip 0 anywhere contains a 254 because the painter writes 255 or exactly 253. The chain now carries the flag instead of averaging it (an emissive texel anywhere in the 2x2 keeps the area self-lit, which spreads a glow by half a texel per level instead of deleting it), and `castWalls`' bilinear decode tests its four corner texels rather than their weighted blend, which had the same failure at fractional coordinates in mip 0. The picture changes where emissive textures actually are: scenes on level 0 stay **md5-identical** to `main`, levels 1 and 2 differ, the ground-pass mean moves 101 -> 99 on level 2 and is unchanged (32, 22) on the others, and the frame mean is 69 either way - it goes *down* because the brightest rooms have a light value above 1 (that is #21) and self-lit means no longer inheriting it, while in a dark room the same change is a brightening. `view.js mip` gained a census row: it counts 254s across FLOORS/CEILS/WALLS (3050 emissive texels found, 0 manufactured today) and hands `buildMips` a 16x16 containing one flagged texel and requires 253 back at mip 1; with the averaging chain put back it reports `2437 texel(s) at alpha 254 ... synthetic 1 flagged texel -> mip1 alpha 254`, and a census that found no emissive texel at all would report nothing rather than pass (#20).
- **A bullet hole now appears at the height you fired at, on any floor.** Shooting a wall in a raised room left sparks and no hole at all: the mark's `z` was clamped to `[0.12, 0.88]`, which meant "the middle of the face" only while every face spanned 0..1, while the renderer solves a mark's `z` as an **absolute** altitude — and the call site gated the write on `h.z < 0.96`, an absolute altitude tested against that same flat window, so above ~0.9 m of floor the mark was dropped before it could even be misplaced. Measured on the deployed build: one shooter, one wall 3.5 m away, level pitch — on the datum it left 1 mark at z 0.500 (its top +0.649 above that floor); with the same room raised one metre it left **0**, with the impact sparks correctly at z 2.500, so the hit looked real and recorded nothing. A mark now carries absolute altitude clamped into the **face's own span** — the higher of the two floors to the ceiling plane of the air side, inset by its radius so a disc cannot hang over a band it was not punched in — and the call site asks nothing of altitude except that the shot hit that face. Flat ground is the arithmetic it was (`floorAt` is 0 on generated levels, so the span is 0..1 and a chest-height shot is nowhere near either inset): 4 scene frames md5-identical to `main`. `VERT=1` gained a row that fires a real click through `tryFire` at the arena wall from the flat band and then from a +0.75 m pedestal, asserting a mark exists and lies above the shooter's feet and inside the face; its controls fail in three directions — the old writer clamp reports `1 mark(s) at z 0.88 for a hit at 1.25, want above 0.95` (the hole painted into the floor slab), the old call-site window reports `0 mark(s)`, and a mark never punched at all reports `VACUOUS: the same shot leaves no mark on flat ground either` (#120).
- **An enemy can no longer see through a raised floor.** Sight was a march along the floor plan testing `isSolid` alone, and a raised band is not solid, so an enemy behind a platform saw the player straight through a slab whose riser the wall pass paints and whose boundary byte stops it walking: `los()` returned `true` across a +1.0 m plateau in the middle of a 9 m run on the deployed build (`floorAt` at the midpoint 1.0, `isSolid` false). The ray now carries its endpoints' altitudes and lets any floor **above the sight line** block it, so a 0.75 m lip between two bodies on the flat band hides them from each other while someone standing *on* a ledge stays visible over it — the line is interpolated, not thresholded, because that is the difference between "see over a step" and "see through a slab". Deliberately scoped to the AI's `see`: the blast, melee, light-glow and off-screen-marker users of `los` keep the 2D ray until each has a row that says why. On flat ground the new test cannot fire (`floorAt` is 0 on every generated level) and 4 scene frames are md5-identical to `main`. `VERT=1` gained a row that puts a +0.75 m plateau between an enemy and the player and asserts no alert and no shot, with the same 9 m of flat floor as the control that the enemy *does* see; its controls fail in both directions - the old ray reports `alert 1 … 17 frame(s)` across the plateau, and sight that never resolves reports `VACUOUS: the enemy sees nobody on flat ground either` (#118). 
- **An enemy that stands on a ledge now shoots from the ledge.** A ranged enemy's orb was spawned at `e.scale * 0.62` — the height of its chest *above its feet*, read as an absolute altitude — while #98 had already made the orb's floor the band it flies in, so on any band at or above ~0.55 m the shot was born under the floor the shooter stood on and detonated in the frame it was created. Measured on the deployed build: an orb in 3 of 4 frames at z 0.638 on flat ground, and in **0 of 4** with the shooter's own cell raised one metre, with +12 particles and +1 light as the signature of a pop on frame 1. Grunts stop shooting above 0.55 m and brutes above 0.86 m, and every gate was green because the lane's projectile row pushes its own orb with a correct `z` and never reaches the spawn site. Hit sparks and the death spray quoted the same body-relative-as-absolute expression; they self-correct on the band, so their symptom was blood that sprays along the ground instead of through the air. On flat ground every expression is the one it was (`floorAt` is 0 on generated levels; 4 scene frames md5-identical to `main`). `VERT=1` gained a gating row that drives a **real** enemy's attack decision on a +0.75 m shelf and bounds the orb's first `z` above the feet and below the crown, and its controls fail in both directions: the old spawn reports `0 frame(s) … NONE - fired and popped in the frame it was spawned`, a spawn 3 m high trips the crown bound, and an AI that never fires trips the flat control (#116). 
- **Flying things and debris now respect the floor they are in, not the floor the world started on.** An orb fired along a raised band sank through it and kept travelling underneath; sparks and scorch particles shed at altitude slid down to `z = 0.02` and pooled on a floor that is not there; and an orb rolling along a floor a metre BELOW a player on a band damaged them at the legs, because the altitude window of the hit test began at the datum instead of at their feet. All three now resolve against `floorAt`/the player's own altitude, and on flat ground every expression is the one it was (4 scene frames md5-identical to `main`). The `VERT=1` lane's last reporting row promoted itself, and two new gating rows cover the particle and hit-window halves (#98). One of them had to be rewritten after its control stayed green: an orb placed at `z 0.05` in a low column sits *inside* that column's floor slab, so the projectile fix destroyed it before the hit test could run - the row was measuring the clamp instead of the window, and now puts the orb at mid-band where only the window decides.
- **A step you cannot walk up is now a step you can see.** A boundary whose two sides differ by more than one height quantum blocks movement - that part always worked - but the wall pass only ever enumerated faces where a ray stopped at a *solid* column, so an air-to-air step drew nothing and occluded nothing either: geometry showed straight through the thing that was stopping you, and `zbuf` kept the far distance behind it. Such a boundary now stops the ray and paints the side of the floor slab, from the lower floor to the higher one, which is the strip that is actually there: a one-unit step in a one-unit room reads as the wall it effectively is, and a pit gets the wall *below* its lip rather than above it, so a body in a pit keeps showing its crown instead of vanishing. Levels the generator makes are entirely flat, so nothing changed on screen today (4 scene frames md5-identical to `main`, raster unchanged) - the branch is behind a derived `MAP.steps` flag that no generated level can raise (#100). `view.js cull`, whose occlusion row used to report this as a known issue, now gates it and moved into the required probe lane.
- Altitude now counts where it always silently ignored it: **a blast on one band no longer damages a band above it**, **the portal no longer changes level when you are standing in the cell below it**, and **a pickup no longer jumps into your pack while you are hovering a metre above it**. On flat ground all three are bit-identical to the old arithmetic - the blast compares the two columns' floors (every floor is 0), and the pickup still lets you grab things mid-jump, which is why its window is 0.6 m and a jump peaks at 0.489 m (#105, #109). The `VERT=1` lane's two known-issue rows for this promoted themselves to gates, and a new row covers the pickup in both directions.
- The camera's eye now lives in the band the player is standing in, instead of being clamped to `[0.12, 1.4]`: standing on anything above ~0.9 m rendered with the eye frozen at 1.4, and because that number is the ground pass's accept test (`rawA < eyeZ`) it made the pass **reject the floor under the player's own feet** and paint datum `z = 0` in its place - a phantom floor up to two metres below them. Every shipped level is flat, so the picture is unchanged today (4 scene frames md5-identical to `main`, raster 3.42 ms either side of an interleaved pair); `view.js horizon`, whose eye-altitude row used to report this as a known issue, now gates it (#103).
- Shots follow the body they hit. `hitscan` tested the ray's altitude against the enemy's height above **absolute zero**, so an enemy standing on a band one unit up could not be hit at chest height at all, while a shot fired level at the eye passed through the floor under it and hit it anyway; barrels had no altitude test of any kind, so a sunken barrel was still hit by a shot fired over its head. Hit windows are now measured from the target's own floor and the head/body threshold moved with them. `view.js sight` aims analytically at bodies and barrels at four band offsets across 3 levels and fails **21 rows** on the previous build, 0 here: widening the window to plus or minus 50 units fails the 6 rows that must miss, and calling every hit a headshot fails the 12 chest rows, so neither the bug nor its opposite gets through (#98).
- A character's head sits **on** its body. The mesh parts were placed to touch rather than to overlap, so the band between the shoulder line and the base of the head was whatever stood behind the character: 8 rows of daylight in a 151 px grunt at 2.4 m and 4 rows in a 100 px hound, at every yaw and gait bucket tested. The junction is now stitched by a neck that reaches 0.02 of body height into each of the parts it joins, and `view.js anim` reads the body mask down the body's own projected axis and fails if any row between the crown and the shoulder line is background — 8 poses fail on the previous build, all 12 pass here, at contrast numbers that did not move (mean edge dL 36.7 to 36.8, mean lost 14.6% to 14.7%, 3 levels x 3 cameras). A brute has the same hole, 0.052 of body height above its shoulders, but its own shoulder top face hides it from the eye's height, so only its geometry was wrong and only the grunt and the hound failed the pixel test (#74).
- Enemies animate again. The mesh path had **no pose input at all**, so #72 traded the walk cycle for volumetric bodies: every enemy drew one straight-legged stance however fast it walked, and a dying one faded in place instead of falling. A body now carries the same four signals the billboard fed the rig — gait phase, move amount, attack progress, death progress — into a table of vertices authored per **phase bucket** (8 gait × 3 move × 4 attack × 6 death per kind, LRU-capped; a 12-body firefight touches 28 sets and 0.08 MB), so a moving enemy costs a cache hit rather than a rebuild: 25.6 ms/frame against 27.4 for vertices rebuilt every frame, on a frame whose floor with no bodies at all is 25.1. A corpse topples about its contact line toward the direction it was hit in, the arm reaches full extension on the frame the round leaves the muzzle, and `view.js anim` now fails if a body ever stops changing shape — 0.0% of body pixels change on `main` against 13–28% here, with a 0.00% noise floor. Silhouette-edge contrast is unmoved: 36.7 dL against 36.4 measured interleaved on the same machine (#73).
- A level transition seats the player on the **new** level's floor. Entering a sector while falling carried that fall across the portal and cost 22.8 hp of damage for a drop that never happened; and because the generator derives the spawn altitude before its last write to the height grid, a spawn on a raised band arrived 0.5 units inside the floor above and took 28 frames to ease out of it (#14 step 3).
- Ceilings and floors no longer streak at grazing angles. The ground pass picked its mip from one axis
  of a pixel's world footprint — the u component of the row delta, with its v component weighted 0.001 —
  while that footprint is a long thin strip pointing down the column, so looking along a corridor axis,
  where planeX is 0, it read a footprint of exactly zero and point-sampled mip 0 across the whole floor.
  Selection now takes both screen axes of the footprint, ratio-clamped 4:1, once per row, and
  `node tools/view.js mip` measures the streaking and keeps the old 1-D selection as its negative control
  (#19).
- Revising a floor no longer leaves an invisible wall where the step used to be. The boundary flags were
  OR-ed in at every relink, so a step that was raised and then flattened kept blocking movement and drawing
  a face although the grid was flat again; blocking is now rewritten from the grid each relink while the
  authored ramp and ladder bits survive it (#54).
- Walking off a step or into a pit no longer drops the player in a single frame: a column whose floor is
  more than a quantum below the feet hands the player to the same gravity integration a jump uses, so the
  fall takes frames and reads as a fall. The `else P.z = gz` line that snapped them down was correct only
  while every floor was the same floor, which stopped being true when cells gained altitudes.
- A sealed exit or an enemy spawned in a closed pocket could no longer slip past `smoke`: the reachability array the assertions read was wiped to zeros two lines after the generator filled it.
- A forgotten `linkBoundaries()` after writing a cell's height can no longer appear as a seam between
  the walls and the floor: the wall pass now reads the same derived ceiling plane the ground pass
  draws, and `view.js planes` fails when a height write leaves the relink stamp where it was. Flat
  levels render pixel-for-pixel the same.
- `genLevel`'s silent fallback now warns, and sets the spawn altitude - it inherited the previous level's `P.z` on a mid-run transition, and its lamp loop iterated the array cleared one line earlier
- Standing at a step or looking across a sunken room no longer paints the floor or ceiling of a room
  two cells away through the wall: the ground solver may only borrow a height from a column within two
  cells with nothing solid between, it can no longer run out of tries and place a pixel at a distance
  belonging to a height it discarded, and pixels whose ray leaves the level stop borrowing light, tint
  and decals from a cell on the far side of the map. Flat levels render pixel-for-pixel the same.
- Thin limbs stopped glowing: the rim band is now capped by the width of the part under the pixel, so a leg or hanging arm shows a lit edge instead of lighting up edge to edge.
- The character rim light is a thin ridge instead of a wide ramp: at close range it stopped reading as a white halo around the whole silhouette, at the same edge separation and the same frame cost.
- Character rim light now follows the silhouette instead of outlining every capsule, box and disc, so the seams inside a body stopped glowing; gain retuned to keep edge separation at least as good as before.

- Lamp fixtures are placed on their cell's floor instead of floating at the middle of the box.
- Rig pose boxes were over-scanned by up to 61%, so most of a character's raster cost was spent
  on empty pixels.
- Sound can no longer leave the audio graph in a stuck state, and a muted context no longer
  leaks a voice per shot.


## 1.0 - 2026-09-26

First public baseline (tag `baseline-v1`). Software raycaster with per-column wall spans,
procedural textures, rigs authored at boot from signed-distance parts, 9-tap perspective ground,
three levels, hound/grunt/brute enemies, and all art and audio generated at boot with no asset
files and no network requests.
