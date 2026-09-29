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
needed it wasted turns assigning to `P.yaw`, which does not exist — the heading is `P.ang`. `DEV.ray` takes a **vector** - `ray(x, y, z, dx, dy, dz, maxD)` - not `(ang, tanP)`: calling
`DEV.ray(0, 1.2)` reads as "pitch this ray up" and is actually a DDA that **starts at cell (0, 1.2)**, i.e. inside
the map border, and answers `hit: false` for a ray that hits a face at 23.5 m. That answer is not merely wrong, it
is unfalsifiable - it agrees with whatever `hitscan` says. Its `through` field is the same family of trap: it is
`zh >= z0 && zh < z1`, an annotation of the ray's altitude against the face's own span, not a second verdict on
whether the shot hit. Also `P.pitch` is in **pixels**, clamped to `+-BH * 0.62` and converted by `pitchTan()`, so
after a look delta it reads 222.58 where the shot's slope was 0.628 - report `pitchTan()`, not `P.pitch`, when a
number has to mean the shot's slope (`js/30_entities.js:326`).

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
- **`zbuf` is a distance in every pixel now, not a label.** It is allocated `Infinity`
  (`js/40_render.js:55`) and `castGround` fills every row each frame (`:296`, `:324`, `:446`); the only
  place `Infinity` survives is the `p === 0` horizon row (`:271`), where it is arithmetic. The older form
  of this trap — "`zbuf` holds 0 where no wall was hit, which silently culls billboards" — described a
  buffer only the wall pass wrote. Nothing writes 0 any more, so a probe or pass that tests for it is
  testing a condition that cannot happen: the billboard test (`:790`) and the mesh test
  (`js/13_mesh.js:524`) are both strictly-nearer comparisons now, which is why #163 had to give ceiling
  rows a real distance instead of a sentinel to make occlusion able to fail at all.
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
- **A fixed-point walk in a quantized domain needs a quantum test, not an iteration count** — and
  M2's version of that lesson is now **partly spent, so do not re-derive it from this bullet**. The
  re-solve used to try 3 times and leave `dS` computed from the *previous* plane (measured then:
  non-convergence on 586,506 of 1,791,686 re-solves, 33%, with `pl = plN` dead on the last pass).
  `groundPixel` today terminates on the quantum (`js/40_render.js:431`,
  `if (Math.abs(plN - pl) <= ZQ) { settled = true; break; }`) and counts exhaustion **separately** in
  `reSolveBad` (`:436`, asserted by `RE-SOLVE-NOT-CONVERGED`). Two consequences, both measured
  2026-09-29 while chasing #170: **`reSolveBad` stays 0 on the pixels that still leak**, so exhaustion
  counting cannot see that bug; and the `<= ZQ` branch is an *exit*, not a *convergence proof* — it
  accepts a one-quantum neighbour and keeps the plane the walk **arrived from**. Answering that branch
  with the nearer plane instead (smaller `|plane - eyeZ|`, since screen distance is
  `|plane - eyeZ| * BH / |p|` in both passes) changed the leak **not at all** (398 px at rows 102..127,
  identical) and broke `heights` with `DEFERRED-STALE-DEPTH` on 3 `stepUp` configs — because
  `groundPixel` is one of the **two copies** of the ground pixel body, so depth became a property of
  *which path painted the pixel* rather than of the geometry. Lesson: when a bug survives a plausible
  arithmetic fix, the pixels are not going through that arithmetic. **Attribute them before editing
  it** (row path vs deferred queue, `castGround`'s split at `:363-371`, `:394`).
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
- **A VERT row can be silently absent while the lane prints green.** `vsetup(label, ok, detail)` *calls*
  `expect` and **returns `ok`**, and the lane uses two shapes: `if (vsetup(...)) { … }` (V17) and
  `if (!vsetup(...)) { } else { … }` (V13/V15). Writing the second as `if (!vsetup(...)) { <body> }` makes
  the row execute **only when its setup failed**, so it never runs on a real level — no print, no assert,
  every neighbour green. The tells are the lane's own **`N gating row(s)` count** (the counter lives in
  `vrow`, so an absent row shows as arithmetic: V18's first version left it at 21, not 22) and a **control
  run** (`git worktree add --detach /tmp/x HEAD`, copy the tool in, run the lane there). A row that has not
  been seen to fail against a build without the fix has not been tested at all (#148 cost a cycle to this).
- **A number that moved across a commit boundary is not evidence until the metric has been bisected too.**
  #139 was opened on a 40-point luminance drop between four README captions and their recapture, and closed
  as not a defect after four confounds, each of which looked like a finding on its own. **#91** changed what
  `exposure`'s printed `frame: mean` means, so bisecting that printout bisects the printout (`git bisect run`
  on a grep of a log line is legal and misleading); **#96** moved `makeEnemy`'s ten global `Math.random`
  draws into a private xorshift, which changed the **seed-to-layout mapping**, so era and main photograph
  different rooms from the same seed - that commit's own body says 12 enemies constructed and discarded move a
  rendered level's mean 66.4 to 70.2, and 66.4 was the era number in the table. And a printed `59.1` appearing
  to disagree with a sampled `28.7` was two probe modes writing the same temp path from different cameras
  (`exposure`'s fall-through dump vs `scene 0 0`, #58/#61) - inside one `exposure` run the printed number and
  the PNG it leaves agree. Each check cost one sampling command or one 6-step bisect over 35 commits; the
  instrument was never the problem, believing a difference before eliminating what moved underneath it was.
- **A closing keyword inside backticks closes nothing.** #145 stayed open after #146 merged with its body
  opening `` `Closes #145` `` - a markdown code span, so GitHub linked nothing - while the `issue` check stayed
  green because it greps the raw text. Same family as a bare `#N`: a green check proves the string was present,
  never that the reference exists. Write the keyword as plain text, and confirm with `gh issue view N --json
  state` after an admin squash merge, which is the only reason this was caught.
- **Quote the roll count beside any median you cite.** These distributions are bimodal, and an even-count median
  averages the two modes instead of selecting one. #143 opened with "composited is 15 points below raster"; ~13
  of that was one tool printing `REPS=4` (median of a 40 and a 66 -> 53) and the other `ROLLS=5` (picks 38) on
  level 2's rolls `39.5 103.3 36.5 66.2 42.5`. The instruments agreed to 0.1 all along, and the real asymmetry
  was 12 points. Same family as #87's "the spread is wider than the window": state N, and when comparing two
  layers compare the **same frames at the same count**, not the headline number each tool happens to print.
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
- **A watch condition must contain no writes at all.** `gh issue edit 128 … && bash /tmp/prwatch.sh 129 7` was
  armed as one line, so the `edit` re-ran on every poll (killed at 7 s after one evaluation). It happened to be
  an idempotent edit against a body file, so nothing broke - pointed at a comment thread or an append instead,
  the same shape posts or corrupts something 37 times. Do the write in the foreground, read the effect back,
  then arm the pure read.

- **A probe that builds its own geometry cannot fail on a world that has none.** Every vertical row in
  `drop`, `sight`, `cull`, `horizon`, `heights` and the VERT smoke lane calls `vpoke`/writes `MAP.fz`
  to create the band it tests — correct while the generator was flat, and now the reason the entire
  vertical suite is green on levels that have **no altitude at all** (`alt`: `floors 0..0`, one band,
  `step faces 0`; the grid the generator builds is `fzTry`, allocated all-zero at
  `js/20_level.js:491` and made `MAP.fz` at `:503`, and **no line writes it** (`:575` is only the fallback
  box). Worse, **`alt` cannot fail**: it computes `flat`, prints `ALL FLAT ok` /
  `NOT FLAT - check above` (`tools/view.js:261`), falls through to the scene dump and exits 0, and it
  sits in the reporting job while `ci.yml`'s blocking list runs the other eight. So CI cannot see the
  missing feature *and* would stay green while printing a contradiction. Making generation real means
  **giving `alt` a verdict** — a `process.exit` on ≥2 bands, ≥1 link per band, 0 unreachable cells,
  ≥1 climbable staircase — after which it belongs in the blocking list (#152). Ask of any
  green vertical verdict: which line creates the geometry this row needs?
- **A probe that reads `zbuf` as a *label* rather than a *distance* breaks silently when the value
  becomes honest.** `!Number.isFinite(pz)` was how `view.js`'s mip rows meant "the wall pass painted
  here" (`tools/view.js:1702`), and `heights` asserted `zc[i] !== Infinity` on ceiling pixels (the #45
  carve-out). #163 made the ground pass store its own solve on ceiling rows (`js/40_render.js`), so the
  mip sampler must now clear `zbuf` to the sentinel before each of its four isolated `castWalls` calls
  (`:1698,:1711,:1714,:1715`) to keep measuring the wall pass alone. The only row that keeps `Infinity`
  is the horizon, where `dz * BH / 0` is arithmetic, not a carve-out — and `HORIZON-DEPTH` asserts it.
- **`startLevel` regenerates the grid, so a poke of `MAP.cz` before it is lost.** `genLevel` reassigns
  `MAP.cz` from a fresh array (`js/20_level.js:606`), so #163's taller-sight-path poke (`MAP.cz.fill
  (CZ_DEF * 2)`) measured "fixed 6 of 7 rows" when it ran before the attach section's own regenerate.
  A probe that pokes altitude must re-seat it **after every `startLevel`**, or its occlusion row is
  structurally unable to fail.
- **A riser one cell ahead makes an occlusion row unable to fail.** cull's "prop one band above is
  hidden by the slab" puts the raised band **three cells** out so the riser's top projects at row ~101
  of 338 and rows 31..101 have no wall face in front of them — the ceiling solve is the only occluder
  there (measured 0 px fixed vs 565/565/490 px with the zbuf writes reverted). One cell ahead puts the
  riser's top at row 0, the wall pass hides the prop by itself, and the row passes on a build with no
  ceiling depth at all (measured: 0 px both ways). Name the config that exercises the case, then check
  it fails on the geometry you did not change.
- **Assert the value, not the placeholder.** #163 turned `heights`' `CEILING-SENTINEL` into
  `CEILING-DEPTH`: a ceiling pixel must now match **the row's own solve** within tolerance
  (`tools/view.js:2038`), not merely be "not Infinity". That is the stronger form — a sentinel renamed
  1e30 passes the old test and fails the new one, as does "hide everything".
- **Quantized-domain non-convergence now has a visible consequence.** Below a raised band's riser lip a
  prop on the band above still draws — measured 398–438 px at rows 102..127 (#163) — because
  `groundPixel`'s fixed point oscillates between the low and raised planes at the seam and answers from
  the plane it arrived at. The failure mode is the one recorded above ("a fixed-point walk in a
  quantized domain needs a quantum test, not an iteration count") - and note that bullet's correction:
  exhaustion counting (`reSolveBad`) reports **0** on exactly these pixels, so it is not the way in;
  attribute the pixels to the row path or the deferred queue before changing any arithmetic. What is
  new here is that pixels show it.

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
half)~~ · **M3** is **two halves and only one shipped**: ~~gravity/step-up/fall-damage/climb~~
(gated by `drop`, `canEnter`'s `VB_LADDER` reads, `vert`) · **bands and links generated — not done,
`genLevel` never writes an altitude** (#152) ← **here** · **M4** everything sits at a height —
`hitscan`, culling, blast band, exit band and pickup hover are gated (`sight`, `cull`, V4, V16, V17),
enemy movement across bands, `updateProj`'s missing ceiling test (#148) and face-relative decal z are
not · **M5** per-band light, glow, minimap altitude cue · **M6** a hand-authored two-storey level.

**A struck-through milestone needs a probe line that proves it, and this one did not have one.**
Until 2026-09-29 this file said "~~M3~~ … (issue #14 closed)" and put the marker on M4. #14 is **open
and was never closed**, and its content — bands and links in `genLevel` — never shipped: the grid is
`fzTry`, allocated as an all-zero `Int8Array` at `js/20_level.js:491` and made into `MAP.fz` at `:503`, and
**no line writes it** (`:575` is the fallback box, not the normal path),
so `view.js alt` reports `floors 0..0`, one band per level and `step faces 0` on all three levels.
The wrong line cost every subsequent session its way into the feature, because "done" is not
something you edit into a milestone list: it is a verdict a tool prints. Strike a milestone only
with the verdict beside it (here: ≥2 bands, ≥1 link per band, 0 unreachable cells, ≥1 climbable
staircase). That verdict does not exist yet, and the reason is worth being exact about: **`alt` has no
`process.exit` in its code path at all.** It computes `flat`, prints `NOT FLAT - check above`, falls
through to the scene dump and exits **0** (`tools/view.js:214-263`; the exits at 571/576 belong to
`vert`, those at 712/833/910/1104 to sight/drop/horizon/cull). The flatness line in its output is
decoration, not a gate — the worst kind of probe, one that cannot fail.

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
2. `genLevel`'s occupancy gate (`reachable < openCells*0.9`) is a 4-neighbour walk that is **half
   height-aware**: `bfsReach(cellArr, fzArr, N, start)` (`js/20_level.js:117`, called at `:492`) admits a
   crossing only when `Math.abs(fzArr[ni] - fzArr[idx]) <= 1` (`:127`) — **one quantum**. A stepped band is
   therefore already reachable, but **a ramp or a ladder is not**: those links are 4 quanta by construction,
   so every attempt that authors one fails the gate and ships the fallback box (the warn at `:566-567`
   fires, which is the only good news). The gate must count `VB_RAMP`/`VB_LADDER` crossings in the same
   commit that turns generation on (#152). Second hazard for that commit: smoke's **V15 needs a flat 8-cell
   lane at floor 0** (`tools/smoke.js:876-880`) and fails `vsetup` without one, so a staircase landing in
   that lane breaks the VERT lane rather than the generator — and note `auto-step` already exists
   (`js/30_entities.js:376`, eased `P.z += dz * min(1, 16*dt)`, gated by `vert`'s 1-quantum-over /
   2-quantum-stop rows), so generation must *not* add a second lift.
3. **A probe can assert the defect, and its rows can fail when you *add* a test.** `view.js sight`'s `+1 band`
   rows raised the enemy a full unit, which closes the boundary's opening `[max(floor), min(ceiling)]` to
   `[1.00, 1.00]` - the enemy is sealed off - and six rows kept printing `hit at t 3.3` for as long as `hitscan`
   ignored altitude (#129 found this by wiring the ceiling term and watching `sight` go red, not by reading it).
   When a new altitude test breaks existing rows, ask whether the row's geometry has an opening at all before
   touching the row's expectation - the answer is usually the geometry. And prove the rewrite changed behaviour
   and not the claim by running the rewritten rows against **unmodified** code: green there is what makes the
   rewrite honest. Related trap, same pass: `ceilAt` is **per cell**, so an opening has to exist along the whole
   flight - lifting one cell moved the stop one cell down the lane (`MISS t 1.8`, measured) instead of opening
   the shot's path.

4. No existing assert compares z where things *move*, so "shots pass through the catwalk enemy", "an
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

**Green CI rows do not mean the merge will go through, and `405` is the message that says so.** Two
failures in one session, both silent: `gh api … > /dev/null 2>&1` swallowed a refusal and only
`gh pr view --json state` printed afterwards showed the PR was still **OPEN**; and the refusal itself
was `{"status":"405"}, "3 of 3 required status checks are expected"` - not a CI complaint but a
**stale merge ref**: the branch was cut off `main` before another PR landed, so the checks the watcher
counted as 7 SUCCESS had run against a merge commit that no longer exists. Read `mergeStateStatus`
(`CLEAN`/`BLOCKED`/`DIRTY`) before merging, and if it is `BLOCKED` with the rows all green, **rebase
onto current `main` and force-push** so CI runs against the real target - never admin-merge past it.
Redirect nothing from a merge call: a lapse that prints nothing cannot be diagnosed after the fact.

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

Status lives in [issues](https://github.com/lioreshai/breach-protocol-flash-next/issues); `docs/ROADMAP.md`
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
