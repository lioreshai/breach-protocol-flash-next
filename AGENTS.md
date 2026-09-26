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

## Eyes-on workflow

Image input is broken in this model config, so visual claims must be numeric (variance,
unique colours, mean exposure, sampled paths) **plus a PNG in `/tmp` for the user to
open** — `open /tmp/fps_scene.png`. The assistant cannot open the page in a browser here
(loopback and `file://` are blocked by policy and `PI_WEB_ALLOW_LOCAL` stays unset), so
the user is the visual gate: ask them to look at the dump and to play the game.

## Now: verticality — what currently assumes flat

- `WALL_H = 1`: walls span z 0..1, so a cell is a unit box. Slabs/stacks need per-wall
  `z0/z1` and the wall span math (`u` along the wall, `yh/y0` from `z`) must use them.
- `castGround` projects rows from a plane at `eyeZ` / `1-eyeZ` — one plane per row. Floors
  at varying heights need the row solved per column from the cell's floor height (and then
  the `zbuf` occlusion trick becomes real: cull ground pixels already covered by a wall).
- Player physics and collision are 2D (`tryMove`, circle vs grid cells). Needs `P.z`,
  gravity, step-up/step-down, and fall damage at the level's ceiling height.
- `MAP.light`, `cellTint`, `bfsDist`, `DECAL_MASK/GRID` are keyed by 2D cell — multi-height
  cells need a z in the key or a documented convention (light and sound bleed vertically).
- Sprites/rigs already carry `o.z` (base height) and `ETYPE.scale` (hitbox height), so
  things on ledges work in the projection as long as `zbuf` and the ground pass agree.
- Minimap is top-down 2D; it needs an altitude cue (current-cell z, or arrows for stairs).

Keep the smoke gates green while doing it, and keep the floor/ceiling sampler honest about
world scale (`ms = sc * mw`) at every height.
