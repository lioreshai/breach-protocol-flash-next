# Working on this repo

Dependency-free browser FPS: software raycaster, all art and audio generated in JS at
boot. No build step, no dependencies, no network, no asset files — `js/*.js` load in
numeric filename order as plain scripts and share globals. Keep it that way.

Direction: better-looking than it has any right to, at 60 fps, then **vertical
navigation** — maps you climb through, not a flat plane.

## Verify before you commit

```
node tools/smoke.js                     # asserts: save/restore balance, colour variety,
                                        # raster median < 16 ms/frame, asset mem < 40 MB
node tools/view.js stats                # per-material variance / mean / unique colours
node tools/view.js sheets               # /tmp/fps_tex.png + /tmp/fps_rig.png
node tools/view.js scene 0 0            # /tmp/fps_scene.png (level 0, cell 0)
node tools/view.js exposure             # mean brightness per level (targets 60-100)
node tools/view.js heights              # which HALF of the frame moves when only floors, or only
                                        # ceilings, change altitude - the M2 probe, exits non-zero
node tools/view.js anim                 # does a body change SHAPE while it walks - masks the silhouette
                                        # by the contrast technique so world churn cannot fake the diff;
                                        # exits non-zero on a static stance. KIND=<kind>, COST=1
node tools/view.js rig | viewmodel | play | diag | decal
node tools/view.js scene 0 0 ASCII=1    # text view, when the pixels want to be numbers
WARM=1 node tools/view.js scene 0 3     # stress: 180 frames, turning camera
```

## Who verifies what

The live site is the source of truth: every merge to `main` deploys to
`https://lioreshai.github.io/breach-protocol-flash-next/`. Whatever can be observed there — a
screenshot, `browser eval` over the game's own globals, thrown errors, measured frame deltas —
**is verified, and nobody waits for a human report on it.** Asking "does this look right to you?"
about a defect already captured in a screenshot is a bug in the workflow, not politeness.

Order of evidence, strongest first:

1. **the live page in a browser** — real GPU path, real aspect ratio, real pointer lock.
2. **`node tools/view.js <probe>`** — geometry, lighting, budgets: deterministic and diffable.
3. **the smoke verdict** — must stay green; proves nothing about how anything looks.

Human judgement still rules what the page cannot reveal: game feel, aim responsiveness, whether the
audio levels are pleasant, difficulty. Ask about those. Do not ask about pixels.

**Hard rule: refresh the README's screenshots after every merged PR that changes the picture.**
Capture them from the deployed build into `docs/screens/` - not from a headless dump, not from an
older build - and put any defect visible in a shot into its caption instead of cropping it out. A
defect in a caption is known; a cropped defect becomes a bug report about someone's display.

**`?dev=1` is the sanctioned way to verify live behaviour.** It boots the game with no click and no
pointer lock and publishes `DEV` (`README.md`: *Driving the game from a console*) — deterministic
camera and enemy placement, `freeze`/`tick` for reproducible frames, `DEV.ray` for geometry claims,
and `DEV.set('rim', false)` to A/B one shading term in the running page. A claim checked through
`DEV` counts as verified; a claim checked by guessing at internals does not. The first hunt that
needed it wasted turns assigning to `P.yaw`, which does not exist — the heading is `P.ang`.

Trap: the headless probes rasterize poses **without** the scene-light multiply, so `view.js rig`
and `contrast` both agreed the characters looked fine while the live site showed something the probes
could not describe (`/tmp/fps_live.png`). A probe passing is not the same thing as a probe being
capable of failing.

That trap carried a **false diagnosis for several commits**, and it is worth keeping the correction
next to the lesson: the live characters did *not* composite as translucent boxes. Correlating body
pixels against the wall behind them (6463 masked px, mean body 89.2 vs mean wall 100) gives **-0.398**,
and masking on a large body-vs-background difference biases correlation *negative*, so a true value of
zero would look like this too — the bodies are opaque, and the see-through impression is torso speckle
against an equally busy wall. What the live site actually shows at close range is a rim band that is too
wide and reads as a white halo (issue #17), which the edge-contrast probe passed because an average
cannot see band *width*. Two lessons, both cheap to keep: a probe that cannot fail is worthless, and a
finding that survives in prose after it was disproven is worse than no finding.

Gate commits on the tool's verdict, not on grep matching a line — grepping "raster cost"
matched even while the assert failed and produced commits with known-failing budgets:

```
out=$(node tools/smoke.js 2>&1); echo "$out" | tail -3
case "$out" in *"SMOKE PASSED"*) git add -A && git commit ;; *) echo NOT COMMITTED ;; esac
```

`node --check` each changed file; for cross-file work parse the concatenation in
*index.html's* order (that order now matches the harness's sorted order on purpose).

## Timing discipline

- One run on a loaded machine means nothing. Load average ~3 inflated unchanged code from
  3.4 ms to 17–46 ms and made a floor-smoothing change look like a 2× regression. Smoke
  prints five batch medians — read the median *and* the spread; 4.1/9.1/14.8 is noise.
- `WARM=1` turns the camera at 3 rad/s. That is the worst case for pose churn, not normal
  play; use it to stress, not to judge frame rate.
- Cost a broken cache hides is not savings: raster "improved" to 3.4 ms because the rig
  cache had stopped making poses at all. Fixing eviction made the honest number 8.7–14.8.

## Measured perf facts

- **A module-global typed-array out-param kills the hot loop.** `texBil` writing into the
  global `TB` blocked V8 inlining/register allocation; inlining the fetch took `castWalls`
  from 21 ms to 12 ms near a wall. Same code, one indirection.
- **Rasterize after you cull.** A rig pose costs 1–8 ms and the budget is 2–4 poses/frame;
  culling after the fetch let invisible enemies spend it (136 → 72 poses per stress run).
- **Rigs author at on-screen height**, with a coarse size class in the cache key — an entry
  authored at one height is not valid at another.
- Hoist transcedentals out of pixel loops (a decal's `exp` fade is per row, not per pixel).
- Billboards use filtered bilinear + mips; the mip chain only pays off once texture scale is
  in world units (see the `ms = sc * mw` floor bug).

## Traps already paid for

- `'use strict'` cannot go in `11_rig.js` (relies on implicit globals).
- **Three ground shadings are welded to the row solver and change silently when the solver
  changes**, which is how the first M2 attempt came out md5-identical at the spawn camera yet 4
  points darker overall and 9 on level 0: light is sampled **cell-quantized** on the ground (walls
  sample it bilinear *with* a `exp(-perp*0.16)` falloff — borrowing the wall formula for the floor is
  the −9, it is not a unification), fog is `fogAt(camera-space depth)` with **no z term** in either
  pass, and the `li > 1 → 1` clamp exists **only at row init, never on a cell crossing**, so a cell
  under a lamp renders brighter when the row walks into it than when the row starts in it. Re-key
  that light update on the *pixel's* own cell and the quirk becomes a uniform clamp — parity dies in
  the brightest rooms first. M2 keeps all three as they were and says so in the pass header.
- **A cell index is one number, so a range check on it is not a bounds check.** `gy*MW + gx` with
  `gx === -1` is a valid index for the far end of the row above: real cell, real light, wrong plane.
  The light path has always had this wrap (parity now, so it stays); the plane lookups M2 added test
  both axes, because a plane read through a wall paints a room that is behind it. Two more of the
  same family, both silent, both found while fixing #105: a per-pixel
  re-solve that derived its cell as `floor((p.x + off*perp) / TILE)` instead of from the march
  could land **outside the array**, since the offset point is not the point the ray advanced to
  (what ships takes `gx = wx | 0` from the DDA itself, `js/40_render.js:336`, and the offset form
  is the one to refuse in review); and a `cIdx >= 0 && cIdx < NN` guard on `gy*MW + gx` lets
  `sy === -1` read the **last row of the level** - guard on `sx && sy`, both axes, always.
- **`ceilAt` in a pixel loop is a cliff.** It walks four neighbours; called from every cell crossing
  of the ground pass it cost ~5% of the flat frame — same arithmetic, wrong place. Derive it once
  per level into `MAP.ceilPlane` (see the verticality section) and keep the crossings to one read.
- **The ground pixel body exists TWICE**: in the row loop of `castGround`, and in `groundPixel()`,
  which shades the columns whose cell is not on the row's plane. The duplication is the perf fix, not
  taste - the row loop's mip/fog/light values must stay `const` of the row, because writing them per
  pixel (the obvious way to say "this pixel has its own distance") cost **+2.5 ms of a 1202×676
  frame for pixels nothing re-solves**: V8 keeps a loop-invariant in a register only while nothing
  writes it inside the loop. Off-plane pixels are queued per row (`RX`/`RP`) and painted after it.
  Change one copy and you have changed the other, and `scene` md5s only prove the *flat* copy right -
  `heights` is what runs the second one.
- **A parity frame needs a floor decal in it.** The first version of that split crashed in the decal
  branch alone, under `WARM` at 4x resolution, while four `scene` md5s swore parity: those frames
  contain no ground decal at all, so the branch never ran. `heights`' `stripes` config now sprays
  `addGroundSplat` blood/scorch and fails `NO-DECAL-COVERAGE` if no cell carries `DECAL_MASK`.
- **Instrumenting a hot loop changes what it costs.** `window.castGround = function () { …g()… }`
  for a phase-by-phase A/B added **15 ms/frame to both sides** and hid the very difference being
  measured - the wrapper deoptimizes the call site in `renderWorld`, which is the same one-indirection
  cliff documented above. Bisect a hot-loop regression by editing variants of the file and running
  the real probe against them (`JSDIR=` or a worktree), never by timing inside it.
- A probe that measures the **composited** frame cannot see the ground pass: the wall pass repaints
  rows whenever a face's z span changes (a taller ceiling retiles the wall it caps, including the
  rows below the eye line), and the portal cycles on `S.t` while pickups bob. `heights` therefore
  renders each config twice — composite for brightness/black, then a `castGround`-only repaint for
  the geometry diff — and its determinism replay compares ground pixels only.
- `exponentialRampToValueAtTime` throws if start OR target is 0 (floors live at 0.0008);
  `AudioContext` starts suspended — `SND.on()` must `resume()`; never gate playback on the
  user's mute flag (`S.sound`); `try/catch` only catches a *synchronous* throw, so wrap the
  whole method (`play` closes over the envelope builder) and `ac.resume().catch()`.
- Three.js port (in a branch): `BufferGeometry` needs the `uv2 → uv` copy; no ShaderMaterial
  tonemapping; `CircleGeometry` thetaLength is a delta; `InstancedMesh` count must be an
  exact multiple of vertices-per-instance; additive blending cannot read its destination.
- **`shape()` already hands the shading closure the signed distance to the silhouette** (`d`,
  `05_paint.js:147`), and `bodyPaint` used to ignore its third argument while its own comment
  claimed a rim existed. A rim light is therefore free — no normal, no gradient, no extra SDF
  eval — and it is angle-correct because `d` is a true distance field. Express the band in *body
  fractions* (`d / authoredHeight`), not pixels, or it thins out as poses get sharper.
- **A rim must be ADDITIVE, not a multiplier.** `base + rim` on an albedo that averages 35,59,68
  still renders dark: the measured silhouette-edge contrast did not move at all. Adding light
  (`C*base + 150*rim`) moved it. And because the raster is multiplied by scene light at composite,
  a rim scaled this way is weakest in exactly the dark rooms where separation is needed most —
  `AMB 0.19` floors it. That tension is unresolved; a contact shadow is the light-independent
  mechanism.
- **`view.js rig` dumps the RAW raster** (no `lr` multiply, no fog), so it shows a lighting
  change's upper bound. The rim that measured correctly in-game still looked like a neon outline
  in that sheet — use it to reject too-strong, never to confirm too-weak.
- `view.js contrast` answers "do the characters read?" numerically: render the world, render it
  again with `ENEMIES.length = 0`, and the difference *is* the silhouette mask — no projection
  math, no depth guessing. cam0 = longest sight line, cam1 = nearest enemy, cam2 = enemy parked
  3.5 m in front of the lens. Pre-rim baseline: edge dL 13–22, 24–60% of edge pixels within 10
  luminance of the wall behind them (i.e. invisible outlines) on all three levels.
- Claiming a field is dead: grep **`tools/` too** — probe code strings hide reads (`bfsDist`
  looked dead and was the HUD's objective distance).
- Background jobs race your commits and produce mis-subject commits, and **`git add -A` is not
  the only way to cause one**: naming a path still sweeps whatever a running job has written to
  that file. `9cfc17e` ("Hound legs") carried the M1 worker's alt-probe boundary/span extension
  because I ran `git add tools/view.js` while it was editing the same file — annotated in
  `git notes`, since rewriting history to fix a subject destroys the diff it is supposed to
  document. While a job runs: `git diff --stat` and confirm you own the hunks, or wait.
  Auditing `git show --stat` afterwards catches it; waiting for the notice prevents it.
- Probes that spin the camera also *drive the player*: recenter or they walk through walls
  into the void, where the grid is undefined and DDA never hits (that is a "freeze").
  `nearestOpen()` rescues an embedded player; `tryMove()` slides along walls.
- `zbuf` holds 0 in columns where no wall was hit, which silently culls billboards there.
- **A wall column has no floor plane and no ceiling.** `ceilAt(wall)` = `floor + max(ZQ, cz*ZQ)` with
  `cz` left at 0, i.e. `floor + 0.25` — *below the eye*. Anything that solves a screen row against
  "the plane of the cell the ray is in" must skip solid cells or it will conclude the plane is above
  the eye and paint nothing (that is how a full-frame dark gray, mean 33 where the baseline reads
  79, first appeared). Air-only planes; solid cells inherit the plane carried into them; the wall
  pass paints over those pixels anyway.
- Solving the ground per cell instead of per row is **not** a drop-in. An attempt (kept out of
  history at `7b9665b..80a7f1e`-era tree, `node --check` clean, md5-identical at the spawn camera)
  still shifted exposure by −4 overall, −9 on level 0. Establishes: the segment *breaks* were not
  the cause (disabling them changed nothing), the solid-cell case was a genuine bug, and the
  residual delta lives in shading, not geometry — so a future attempt must diff *shading* per row,
  not chase segment counts. Flat parity is the gate; it failed, so it was reverted rather than
  shipped with a look regression.
- **A probe's determinism assertion must run where the code under test runs.** `view.js heights`
  re-rendered identical state to prove frame-stability *under `if (!poke)`* — i.e. only on `flat`,
  the one config where the deferred-pixel queue is provably empty, so the RX/RP path had no
  determinism coverage at all while the probe printed "all configs determinism ok". Same family as
  `CAMSET` choosing the **longest-ray** yaw, which points the solver away from the map border and
  makes every out-of-map branch structurally unreachable for every gate (that is why `stripes`
  exists). When you add a mechanism, name the config that exercises it and confirm the assertion
  runs *there*.
- **The index-only bounds test is not a bounds check, twice over.** `cIdx >= 0 && cIdx < NN` with
  `sy === -1, sx === 4` is a valid index into the *last row of the level*, so an off-map pixel takes
  light, tint, mirror and decal mask from a cell on the far side. M2 carried two of these
  (`js/40_render.js:258`, `:376`) because the correct two-axis form ten lines away at `:297` got
  copied as a formula rather than as a guard.
- **A fixed-point walk that runs out of iterations still paints.** M2's re-solve tried 3 times and
  left `dS` computed from the *previous* plane when it exhausted: measured non-convergence on
  586,506 of 1,791,686 re-solves (33%) on poked configs, with `pl = plN` dead on the last pass.
  Iteration counts are the wrong convergence test on a **quantized** domain — compare against the
  quantum (`ZQ`) and count non-convergence in a probe, or a step lip's appearance is defined by how
  the loop gives up.
- **Never report a context percentage you did not read from the `<strategy>` block.** This session
  said "~2% of context left" with no such measurement behind it — it was extrapolated down from a
  24% read an hour earlier, and the footer said 79.4% remaining. It was not decoration either: it
  was the stated reason to skip a 195-line fix pass and a tuning cycle. Same rule as any figure —
  read it or say you don't know.
- **A derived flag that is OR-ed in can never be removed.** `linkBoundaries` ended with
  `MAP.vb[i] |= bits` so that authored `VB_RAMP|VB_LADDER` would survive a relink, and as a side
  effect nothing cleared the derived `VB_BLOCK`: raising a boundary and flattening it left a phantom
  wall that `canEnter` treats as authoritative (measured: **7 stale blockers** after a 7-cell
  raise-and-restore, #55). Probes never saw it because every config calls `startLevel(li, true)`
  first and probes only ever poke *upward* from flat. Any "preserve the authored bits" fix must
  mask them (`VB_KEEP = 0x6666`), not stop writing.
- **Before believing a live behaviour probe, read the source the page is actually running.** A Pages
  deploy leaves the previous build's subresources in the browser cache for its `max-age` (~10 min),
  and `fetch(url,{cache:'reload'})` inside an `async` eval is useless because the tool serializes the
  Promise as `{}`. The first "it works" eval after #55 was therefore a **false positive waiting to
  happen**; `linkBoundaries.toString().includes('VB_KEEP')` is the check that makes a behaviour probe
  mean what it says, and the marker it looks for must be **code, not prose**: `toString()` renders comments
  too, so checking that an *old* string is gone matched a comment explaining its removal and reported the
  deployed build as unfixed (#122's live check). Grep the merged file for a token that exists in the shipped
  statement before putting that token in an assertion. `curl` with `?cb=` proves the CDN's bytes, not the page's code.
- **A negative control that self-cancels inside one frame proves nothing.** Sabotaging a support test
  and observing the *post-update* state showed the player standing on air for zero frames, because
  gravity corrected it before the sample — sampling the **landing impulse** (`S.shake`) turned it into
  a loud failure. Same reason an assertion's allowed conclusions must include the repo's legitimate
  `SKIPPED` (the seeds job is push-on-main only), and why `gh pr view -q .field` needs `--json`:
  both made a guard report "all clear" or "refused" for a reason that had nothing to do with the code.
- **A watch command must not contain `case` or multiline shell.** The harness wraps the condition in
  `{ ... ; } 2>&1` on one line, so `;;` becomes a syntax error and bash exits 2 in ~50 ms —
  `bg_19` and `bg_20` both died that way having polled **nothing**, which is indistinguishable from a
  watch whose condition simply never became true. Use a single-line test instead:
  `printf '%s' "$s" | grep -qE "^(MERGED|OPEN CLEAN)"` (`bg_21` worked first try). Same reason PR
  bodies must be written to a file or passed as one quoted `--body` string, never a heredoc in `if`.
- **A watch that greps for absence reports MET when the command fails.** `bg_4` exited 0 after **59 ms**
  having read nothing: its condition was `gh pr checks 121 --json …`, and this `gh` has no `--json` on
  `pr checks`, so the command printed `unknown flag` on stderr, `$s` was empty, neither the `pending` nor
  the `fail` grep matched, and the script fell through to `echo "$s"; exit 0` - a CI watch that "passed"
  before CI had published a single check row, five seconds after `pr create`. Two terms make a condition
  honest: `[ -z "$s" ] && exit 1`, and a **count of the rows you expect** (`ok >= 4`), not merely the
  absence of a bad word. The same trap is why the earlier watches printed a table: they were armed after
  checks existed, so their emptiness never fired.
- **Arm a deploy watch with a marker grepped out of the merged file, never from memory of what you wrote.**
  `bg_8` burned a full 600 s deadline on `grep -c "face's own span"`: that phrase is in the PR body, while the
  shipped comment reads `the ceiling plane of the AIR side`, so the condition could never become true - and a
  watch that cannot succeed prints the same `NOT MET` as a deploy that is merely slow (`last-modified` on the
  CDN said 15:28:15; the watch died at 15:38 still saying "not yet"). The inverse of the bullet above: both
  failure modes look identical from the outside, so the marker is verified against `git show origin/main:<file>`
  before the watch is armed, and a watch that lapses is investigated by reading the deployed bytes rather than
  re-armed with a longer deadline.
  The same discipline applies to a **count** in a condition, and `bg_10` paid for it: the CI watcher's
  `minSuccess` counts `SUCCESS` rows only - `SKIPPED` deliberately does not count, or an all-skipped lane would
  read as green - so a full run here is 7 SUCCESS + 2 informational SKIPPED and passing the *total* row count
  (9) made the condition unsatisfiable for a PR whose checks were all green. Third cousin of the same trap:
  `gh pr view` resolves the repo from the **cwd**, so a watcher script run from outside a checkout dies with
  `failed to run git: not a git repository`, its stdout is empty, and the emptiness guard that makes an
  `unknown flag` failure visible reads it as "checks not published yet". Pass `--repo owner/name` in any script
  meant to be armed from anywhere, and give the watcher distinct exit codes with printed evidence - 0 met,
  3 terminal-but-below-count (prints `SUCCESS=7 < min=9`), 4 the query itself failed (prints gh's stderr) -
  because a lapse that prints nothing cannot be diagnosed after the fact. Use `gh pr view N --json statusCheckRollup` with
  `.status` (`IN_PROGRESS`/`COMPLETED`) and `.conclusion` (`SUCCESS`/`FAILURE`/`SKIPPED`) - `gh pr checks`
  has no machine output here.

## Now: verticality — the design that was chosen

Representation: **a quantized per-cell height grid** (2.5D stacked slabs), not a
sector/portal graph. One playable band per column: `MAP.fz` (floor = `fz*ZQ`, `ZQ=0.25`,
`-4` = pit), `MAP.cz` (own ceiling *above own floor*, default `4` = today's one-unit
room), `MAP.vb` (per-boundary flags, packed per side: BLOCK/THRU/RAMP/LADDER), `MAP.feat`
(STAIR/LADDER/PIT/RAIL + band for the minimap). Portal semantics fall out of the grid: the
opening between two open cells is `[max(fz), min(cz)]`, so stairs, ledges, atria and pits
need no graph. Chosen because `MAP.cell`, `MAP.light`, `DECAL_*`, `bfsDist`, `explored` and
**every probe in `tools/`** index `y*MW+x` — keeping them intact is what keeps
`node tools/smoke.js` meaningful *while* the work is in flight. Cannot do: two walkable
bands in one column, or a floor overhanging the cell it sits above.

- **Blocking ⇒ walkable ⇒ drawn is one byte.** A boundary with `dz > ZQ` that is not a ramp
  gets `VB_BLOCK` on both sides, so the same test makes it opaque in the DDA, impassable in
  `tryMove`, and a textured riser in the wall pass. `VB_THRU` = "see it, not climb it".
  This sentence was **false for the 59 commits between `ef74e52` (M1: boundary faces have real
  z0/z1) and #112**: the span rule below covers the *wall* case, and an air-to-air step satisfied
  "blocking" without ever entering the geometry branch, so the byte stopped the DDA and stopped
  `tryMove` while drawing nothing - a step you could not walk up and could not see. No probe saw it
  because no probe had ever placed the player next to a step (`cull` has those rows now, and they
  fail in both directions).
- **A cell's ceiling is the underside of the floor above:** `ceilAt = floor + max(1 unit,
  neighbour floors above)`. Without this formula you see sky inside buildings.
- **A boundary face spans from the higher of the two floors to the ceiling plane of the air
  side:** `z0 = max(floorAt(a), floorAt(b))`, `z1 = ceilAt(a)`. Never `ceilAt` of the *wall*
  cell: a solid column has no air, so its derived ceiling is a fiction, while its own floor is
  honest — a solid column is solid from its floor up. A span ≤ 0 is a column the DDA stops at
  that draws nothing, and it is a generator fault rather than a code one: a wall whose base sits
  at or above the ceiling plane of the band it encloses, so wall bases must be carried down to
  the lowest band they bound.
  **An air-to-air boundary needs its own span rule, and it is not this one.** There is no wall
  column to carry a base down, and `ceilAt` of either side overshoots both, so the face is the
  **slab side**, `[min(floorA, floorB), max(floorA, floorB)]`. Reusing the wall span - which is
  what the first attempt did - renders, keeps every md5 identical, and builds the riser ABOVE the
  pit lip instead of below it: `cull` then exits 1 on all three levels with the body in the pit
  hidden **completely** (`centroid moved down 0.0 px and only 0.0% of the flat silhouette survives`,
  where correct geometry leaves the crown at 8.4-8.7%), while the step rows lose occlusion in the
  other direction and report the body still visible behind a 1 m step (1505 of 1540 px, background
  churn 25% instead of 203,137 px / 100%). Gated by
  `MAP.steps`, derived in `linkBoundaries` for exactly the reason `VB_BLOCK` is: generated levels
  are entirely flat, so this branch is dead code on shipped content until M6 authors steps, and
  `planes`' `STEPS-FLAG` row is what catches a forgotten relink. Note the ordering trap - a
  `poke()` relinks and *recomputes* `MAP.steps`, so a control that forces the flag must do it
  after the poke or the row measures nothing.
- **The last literal `1` of the flat world is gone from the ground pass.** M2 replaced
  `d = (isF ? eyeZ : 1 - eyeZ) * BH / |p|` with the same expression solved against the plane of the
  cell the pixel's own ray lands in (`floorAt` below the horizon, `MAP.ceilPlane` above), kept as a
  *predictor*: a pixel whose cell is at the eye's altitude reuses the row's distance untouched, so a
  flat level runs the old arithmetic bit for bit (measured: 4 frames md5-identical, exposure
  77/62/59 unchanged). What is left of the flat assumption is the decal/`zbuf` span math, which
  still assumes faces span 0..1. `castWalls`' `y0 = horizon + (eyeZ - 1) * hpx` went in M1: the
  face's `z0/z1` comes from the grid and `tstep = mh * dz / (y1 - y0)` tiles a wall texture per
  **world unit**, not per face. Every new formula must collapse to the old one exactly, bit for
  bit — that is the backwards-compat test, and for M1 it was measured rather than argued: 24 frames
  (3 levels × 2 seeds × 4 yaws) hashed identical against `HEAD` at an unchanged 3.3 ms median. A
  face taller than a unit pushes `v` past the mip, and `texBil` wraps only at its last texel, so `v`
  must wrap per unit — otherwise the read runs off the array and `undefined & 255` paints fog colour
  where the wall should be, with no black pixel to show for it.
- **The renderer reads ceilings from `MAP.ceilPlane`**, a derived array filled by `buildCeilPlanes()`
  at the end of `linkBoundaries()`, because calling `ceilAt` from the ground pass's cell crossings
  cost 5% of the flat frame. It is filled by *calling* `ceilAt` per column (formula lives in one
  place) and hangs off the same hook as `MAP.vb`, so **anything that writes `MAP.fz`/`MAP.cz` must
  call `linkBoundaries()` afterwards** — `tools/view.js planes` compares the array against the
  formula per column and exits non-zero when they disagree, which is the only thing standing between
  a forgotten write and last frame's ceilings.
- Light stays **one value per column**, weighted by a band term; do **not** make the lightmap
  per band, because a fading transient re-splats its delta and an un-splat that lands in a
  derived band leaves permanent light (breaks smoke's "blast light fully fades out" assert).
- Decals and lights need **absolute z**; `addWallMark`'s face-relative `clamp(z,0.12,0.88)`
  is only correct today because faces span 0..1.

Milestones, each ending playable with gates green: ~~**M0** representation + absolute `P.z`~~ ·
~~**M1** boundary faces with real `z0/z1`~~ · ~~**M2** the ground plane solved per **cell**, floors
and **ceilings in the same commit** (floors-only shows a phantom floor across a tall room's upper
half)~~ · ~~**M3** bands + links + gravity/step/fall-damage/climb~~ (issue #14 closed) · **M4**
everything sits at a height (enemies, `hitscan`, props, pickups, projectiles, particles, decals,
portal trigger) ← **here** ·
**M5** per-band light, glow, minimap altitude cue · **M6** a hand-authored two-storey level.

`node tools/view.js heights` is the probe that makes M2 verifiable while every shipped level is
still flat: it pokes `MAP.fz`/`MAP.cz` into six configurations per level (tall ceilings, a pit beyond
3 m, sunk 4-column stripes, a platform, the eye standing on a raised band) and asserts **which half
of the frame moved** — measured on the ground pass alone, because the wall pass legitimately
repaints rows the moment a face's z span changes. Emulating the old constant-plane solver through all
four plane lookups makes 12 of its 18 configs FAIL at 0.00% moved; solving a plane against a **solid**
column FAILs four more by drifting ~20% of the ceiling rows. Read that as: the probe can see the
feature, and it can see the two ways M2 has already failed.

Three risks that were invisible to the gates when this list was written:

1. ~~`startLevel(i, fresh)` runs `genLevel()` and *then* `resetRun()`, which zeroes `P.z`~~ — fixed in
   M3 step 3, and the ordering was not the whole hazard: `resetRun` derives `P.z` from `floorAt`, but
   the **non-fresh** entries (`nextLevel`, `retry`, `again`) run no `resetRun` at all, so the feet kept
   what the generator's own line computed *before* its last write to `MAP.fz`, and `P.air`/`P.vz` were
   never re-seated. `startLevel` now seats all three after generation, on every path, and
   `view.js vert`'s spawn-altitude rows are the gate — reverted, they measure `P.z 0 vs floorAt 0.5`
   with the feet below the floor, and `hp 77.16` after 60 frames of a fall carried across the portal.
2. `genLevel`'s occupancy gate (`reachable < openCells*0.9`) is a height-blind 4-neighbour
   BFS. Split bands and every attempt fails into the fallback: a lit empty box, no heights,
   every gate green, and the feature silently absent. It must `console.warn('genLevel FALLBACK')`.
3. No existing assert compares z where things *move*, so "shots pass through the catwalk enemy", "an
   explosion downstairs kills upstairs", "the portal triggers from the floor below" all ship green.
   The ground plane now has one (`heights`); the geometry of movers does not. Needs the numeric
   altitude probes (`drop`, `sight`, `cull`, `horizon`) and a `VERT=1` smoke lane before M4 is
   trustworthy.

Also true and visible in the PNGs: the ceiling streaks at grazing angles (mip selection has
no anisotropy) and a one-unit-tall world makes everything read as a crawlway — both are the
vertical work, not texture knobs. Keep the ground sampler honest about world scale
(`ms = sc * mw`) at every height.

## Branch hygiene

`delete_branch_on_merge` is **on** for the repository, so a merged PR's remote branch disappears by
itself, and `.github/workflows/prune.yml` (weekly + manual) sweeps whatever that setting cannot
reach. Do not add ancestry checks to that sweep: merges here are **squash** merges, so a merged
branch's content is in `main` while its commit is not an ancestor of it, and
`git merge-base --is-ancestor origin/<branch> origin/main` reports a fully merged branch as
unmerged. Detect by PR state (`gh pr list --state merged --head <branch>`) and prune local branches
for merged PRs too, or the local repo keeps ghosts that make `git branch` look like open work.

**Merge through the API, not `gh pr merge --admin`.** That command printed *nothing at all* and
merged nothing (PR #98, 2026-09-28) - a silent success-reporting failure, with CI green and the
issue still open, which is the worst possible shape for a merge tool. Use
`gh api -X PUT /repos/<repo>/pulls/<N>/merge -f sha=<full 40-char head> -f merge_method=squash
-f commit_message="… Closes #N"`: it answers 422 when the SHA is stale or the base moved, and
`{"merged":true}` when it worked. Pass the **full** SHA - a 7-char prefix 422s with `sha should be
40 characters` - and pin it to the head that CI actually ran.

**A YAML step `name:` cannot contain `': '`.** A plain scalar cannot contain colon-space, so the
*whole workflow* fails to parse: no step runs, nothing is reported, and CI stays green until the
workflow runs (#107 - caught in review, not by CI, because the file that broke could not report
it). `tools/wfyaml.rb` now asserts each workflow parses, that `jobs` is non-empty, and that every
job has `runs-on`, `steps`, and a `run:`/`uses:` on each step - which is a real exit path for the
class "a job that runs nothing". It cannot catch a bad *mapping* (a step list indented under a
mapping key instead of a sequence parses into garbage that still has a `runs-on`) and it cannot
check **its own** file, so `ci.yml` and `pr-guard.yml` validate **each other**: one breaking is
reported by the other.

**Never stack a PR on another PR's branch here.** GitHub **closes** a PR whose base branch is deleted,
and with `delete_branch_on_merge` on, that is exactly what merging the parent does: PR #9 (`base=feat/dev-mode`,
the rim fix) was closed the instant PR #8 merged and deleted that branch — no error, no warning, and its
commit was nowhere near `main`. A silently closed PR looks like a merged one in a session summary, so
verify a fix reached `main` by grepping its content (`git show origin/main:js/11_rig.js | grep -c rimSil`),
never by PR bookkeeping. Branch every change off `main`; if two changes touch the same file, sequence them.

## Issue tracking

Status lives in [issues](https://github.com/lioreshai/breach-protocol-flash-next/issues); `ROADMAP.md`
keeps direction and measured constraints, and prose status tables are not to be reintroduced. A PR
body carries `Closes #N` — **the keyword, not a bare `#N`**, because merges here are squash merges and
a bare reference links the issue while leaving it open, which is how a tracker dies. `[no-issue]` is
the opt-out, same shape as `[no-changelog]`, and the `issue` check in `pr-guard.yml` is the gate.

Milestones are issues too (M2 = #13, M3 = #14, M4 = #15, M5+M6 = #16), so "what is left" is a query
rather than a document. Two habits follow from how this repo merges:

- **Confirm the close.** After an admin squash merge, check `gh issue view N --json state` instead of
  assuming. A merge whose reference lived in the commit message but not the PR body closes nothing, and
  an issue left open after its work shipped is worse than no issue, because the next reader re-does it.
- **File a measured defect as an issue in the session that measured it**, numbers in the body. Bug #20
  (the mip chain averages alpha to 254 while the ground tests `alpha === 253` exactly, so emissive
  texels silently lose their light-exempt path in every mip) was a by-product of reading code for a
  different task; parked in a transcript it would have evaporated.
