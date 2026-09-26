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
node tools/view.js scene 0 0 ASCII=1    # text view, since image input is broken here
WARM=1 node tools/view.js scene 0 3     # stress: 180 frames, turning camera
```

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
- Claiming a field is dead: grep **`tools/` too** — probe code strings hide reads (`bfsDist`
  looked dead and was the HUD's objective distance).
- Background jobs running `git add -A` race your edits and produce mis-subject commits.
  Don't launch a commit-including job while editing; audit `git show --stat` after.
- Probes that spin the camera also *drive the player*: recenter or they walk through walls
  into the void, where the grid is undefined and DDA never hits (that is a "freeze").
  `nearestOpen()` rescues an embedded player; `tryMove()` slides along walls.
- `zbuf` holds 0 in columns where no wall was hit, which silently culls billboards there.

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
