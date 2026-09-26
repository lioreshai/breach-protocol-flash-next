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
node tools/view.js rig | viewmodel | play | diag | decal
node tools/view.js scene 0 0 ASCII=1    # text view, when the pixels want to be numbers
WARM=1 node tools/view.js scene 0 3     # stress: 180 frames, turning camera
```

## Who verifies what

<<<<<<< HEAD
Whatever can be observed on the deployed site — a screenshot, `browser eval` over the game's own
globals, thrown errors, measured frame deltas — **is verified; nobody waits for a human report on
it.** Asking "does this look right?" about a defect already captured in a screenshot is a bug in
the workflow. Reserve asking for what a page cannot reveal: feel, responsiveness, audio comfort,
difficulty.

Evidence order: **live page** (real GPU path, aspect ratio, pointer lock) → **`view.js` probes**
(geometry, lighting, budgets) → **smoke verdict** (green proves nothing about looks).

**Hard rule: refresh the README's screenshots after every merged PR that changes the picture.**
Capture from the deployed build into `docs/screens/` — not from a headless dump, not from an older
build — and put any defect visible in a shot into its caption instead of cropping it out. A defect
in a caption is known; a cropped defect becomes a bug report about someone's display.

Trap: the headless probes rasterize poses **without** the scene-light multiply, so `view.js rig`
and `contrast` both passed the characters while the deployed site drew enemies as translucent
boxes (`docs/screens/level0-enemies.png`). A probe passing is not a probe being capable of failing.
=======
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

Trap: the headless probes rasterize poses **without** the scene-light multiply, so `view.js rig`
and `contrast` both agreed the characters looked fine while the live site drew them as translucent
boxes (`/tmp/fps_live.png`). A probe passing is not the same thing as a probe being capable of
failing.
>>>>>>> origin/main

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
- **A cell's ceiling is the underside of the floor above:** `ceilAt = floor + max(1 unit,
  neighbour floors above)`. Without this formula you see sky inside buildings.
- **A boundary face spans from the higher of the two floors to the ceiling plane of the air
  side:** `z0 = max(floorAt(a), floorAt(b))`, `z1 = ceilAt(a)`. Never `ceilAt` of the *wall*
  cell: a solid column has no air, so its derived ceiling is a fiction, while its own floor is
  honest — a solid column is solid from its floor up. A span ≤ 0 is a column the DDA stops at
  that draws nothing, and it is a generator fault rather than a code one: a wall whose base sits
  at or above the ceiling plane of the band it encloses, so wall bases must be carried down to
  the lowest band they bound.
- The two literal `1`s left in the flat world: `castGround`'s
  `d = (isF ? eyeZ : 1 - eyeZ) * BH / |p|` and the decal/`zbuf` span math assuming faces span
  0..1. `castWalls`' `y0 = horizon + (eyeZ - 1) * hpx` is gone (M1): the face's `z0/z1` comes
  from the grid and `tstep = mh * dz / (y1 - y0)` tiles a wall texture per **world unit**, not per
  face. Every new formula must collapse to the old one exactly, bit for bit — that is the
  backwards-compat test, and for M1 it was measured rather than argued: 24 frames (3 levels × 2
  seeds × 4 yaws) hashed identical against `HEAD` at an unchanged 3.3 ms median. A face taller
  than a unit pushes `v` past the mip, and `texBil` wraps only at its last texel, so `v` must
  wrap per unit — otherwise the read runs off the array and `undefined & 255` paints fog colour
  where the wall should be, with no black pixel to show for it.
- Light stays **one value per column**, weighted by a band term; do **not** make the lightmap
  per band, because a fading transient re-splats its delta and an un-splat that lands in a
  derived band leaves permanent light (breaks smoke's "blast light fully fades out" assert).
- Decals and lights need **absolute z**; `addWallMark`'s face-relative `clamp(z,0.12,0.88)`
  is only correct today because faces span 0..1.

Milestones, each ending playable with gates green: **M0** representation + absolute `P.z`
(nothing visible) · **M1** boundary faces with real `z0/z1` · **M2** ground plane solved per
*column* (`rowK = BH/|p|` stays the one division; `dz` is cell-constant) **with ceilings in
the same commit** — floors-only shows a phantom floor across a tall room's upper half ·
**M3** bands + links + gravity/step/fall-damage/climb · **M4** everything sits at a height
(enemies, `hitscan`, props, pickups, projectiles, particles, decals, portal trigger)
· **M5** per-band light, glow, minimap altitude cue · **M6** a hand-authored two-storey level.

Three risks that stay invisible to today's gates:

1. `startLevel(i, fresh)` runs `genLevel()` and *then* `resetRun()`, which zeroes `P.z` — a
   band-1 spawn starts inside the floor above. Fix the ordering in M3.
2. `genLevel`'s occupancy gate (`reachable < openCells*0.9`) is a height-blind 4-neighbour
   BFS. Split bands and every attempt fails into the fallback: a lit empty box, no heights,
   every gate green, and the feature silently absent. It must `console.warn('genLevel FALLBACK')`.
3. No existing assert compares z, so "shots pass through the catwalk enemy", "an explosion
   downstairs kills upstairs", "the portal triggers from the floor below" all ship green.
   Needs the numeric altitude probes (`alt`, `drop`, `sight`, `cull`, `horizon`) and a
   `VERT=1` smoke lane before M4 is trustworthy.

Also true and visible in the PNGs: the ceiling streaks at grazing angles (mip selection has
no anisotropy) and a one-unit-tall world makes everything read as a crawlway — both are the
vertical work, not texture knobs. Keep the ground sampler honest about world scale
(`ms = sc * mw`) at every height.
