# BREACH PROTOCOL — browser FPS, zero dependencies

**Run it:** double-click `index.html` (or drag it into a browser window). No server, no build, no
internet, no assets — everything (geometry, textures, sprites, sound) is generated at boot.

```
fps/
  index.html        <- click this
  js/00_core.js     utils, canvas, state, synthesized audio
  js/05_paint.js    software rasteriser + noise/SDF kit every asset is painted with
  js/10_assets.js   material baker: albedo -> normals -> cavity AO -> light, per texture
  js/11_rig.js      characters as jointed geometry, rasterized at draw time and cached by pose
  js/12_sprites.js  props and decals painted per frame from primitives
  js/20_level.js    room/corridor level generator, RGB lightmap, decals, occupancy
  js/30_entities.js weapons, player, enemy AI, projectiles, particles
  js/40_render.js   software raycaster + post FX + 2D overlay/HUD
  js/50_ui_input.js menus, pointer lock, input, main loop
  tools/smoke.js    headless test harness (node tools/smoke.js)
  tools/view.js     headless visual harness: sheets | stats | diag | exposure | scene | rig
                    (scene honours WARM=1 to exercise the rig cache under a spinning camera)
  tools/png.js      minimal PNG writer used by view.js (no dependencies)
```

## Controls
| | |
|---|---|
| `W A S D` / arrows | move |
| mouse | look (pointer lock; click the window to grab the mouse) |
| left click | fire · hold for auto weapons |
| right click | aim down sights (tighter spread, zoom) |
| `Shift` / `C` | sprint / crouch (crouching lowers your profile under incoming fire) |
| `Space` | jump |
| `R` | reload · `1 2 3` or mouse wheel | weapon select |
| `G` | grenade (area damage, chain-detonates barrels) |
| `Esc` | pause · `M` map · `T` sound · `F3` perf readout |
| `F4` | cycle quality: PERFORMANCE / BALANCED / ULTRA (resolution, bloom, grain, fog depth, rig authoring size) |

## Goal
Three procedurally generated sectors. Clear every hostile, the exit portal opens, then find it.
Kills can drop health/ammo. Barrels detonate when shot. Headshots count double-plus.
Difficulty changes enemy damage, health and count.

## How it looks
Everything is generated in plain JS at boot (~1.6 s): no image files, no fetches, no canvas path
calls. `js/05_paint.js` is a small rasteriser — analytic anti-aliased SDF shapes (segments, discs,
rounded boxes, polygons) plus tileable value noise and fbm — painting into `Uint32Array` bitmaps.

* **Materials** (`js/10_assets.js`) are baked, not painted: a callback writes albedo *and height*
  per texel, then the baker derives normals from that height field, cavity AO from a blurred copy,
  and a specular term from the same normal. Bricks have recessed mortar and chamfers, concrete has
  aggregate pits and spalled cracks, metal has bevelled panels and worn edges, flesh has vein
  networks that carry their own light. Every threshold in that pipeline states its **coverage**
  (fraction of the surface affected) rather than a noise cutoff, because ridged noise spends almost
  all of its area near its median — `node tools/view.js diag` prints the measured coverage of each
  helper so a tuned value stays tuned.
* **Lighting** is one shader everywhere: `colour = albedo × RGB light + fog`. Light comes from a
  per-cell RGB lightmap (lamps accumulate colour, then get blurred so pools blend), tint comes from
  the dominant lamp colour in that cell, and fog is per-level air tint rather than black.
  Texels with alpha 253 are emissive and bypass scene light.
* **Walls, floors and ceilings** are all texture-mapped, with mip selection by screen-space
  footprint and adaptive horizontal stepping so near rows keep detail and distant rows cost one
  sample. Bullet holes, scorch marks and blood pool in *world* space and are composited during the
  wall and floor passes.
* **Characters** (`js/11_rig.js`) are jointed geometry: capsules and rounded boxes specified in
  fractions of body height, posed by a gait phase that advances with *distance travelled* so a
  planted foot stays planted, and rasterized through signed-distance fields at the size they
  occupy. The silhouette is a function of the viewing angle, so facing reads correctly. Poses are
  cached by (species, gait phase, yaw, action) under a byte cap and a per-frame rasterization
  budget; over budget the nearest cached pose is reused rather than paying for another raster.
  Billboards sample with bilinear filtering where texels outnumber pixels, which is what killed the
  shimmer at distance. `js/12_sprites.js` still paints props and decals, and supplies the bitmap
  poses the PERFORMANCE preset uses.
* **Post FX**: bloom from a downscaled bright pass, projected lamp glow with a line-of-sight test,
  film grain and a contrast grade. `F4` trades these against internal resolution.

## How it works
* **Renderer** is a software raycaster (Wolfenstein-style DDA) writing into an `ImageData`'s
  `Uint32Array` at ~0.5× resolution, upscaled to the window. Per-column light, fog and tint are
  computed once per column, so each pixel costs one texture read, a few multiplies and a clamp.
* **Billboards** (props, pickups, enemies, projectiles, portal) are depth-tested against the
  per-column z-buffer and alpha blended; sprites are occluded correctly by walls. They also get a
  small distance-based fill light, so an enemy in an unlit room is still a readable silhouette.
* **Pitch** is a screen shear, so it is converted to a ray slope (`aimPx / BH`) for hit maths —
  aim at legs or head and the hit test agrees. Firing recoil is a separate term that settles on
  its own, so the vertical aim you set with the mouse is never pulled back to level.
* **Hitscan** is analytic (ray vs. enemy cylinder) rather than marched, so a shotgun blast costs
  almost nothing.
* **Levels** are rooms + L-corridors with flood-fill validation: unreachable space is rejected,
  and enemy spawns are nudged onto reachable cells so a sector can never become unwinnable.
* **Enemies** are state machines (sleep → chase → windup → melee/ranged) with line-of-sight,
  last-known-position tracking, wall sliding, side-stepping when blocked and separation steering.
* **Audio** is pure WebAudio: filtered noise bursts + oscillator sweeps, stereo-panned by the
  angle to the source, plus an ambient drone bed that thickens as you take damage.

## Tuning knobs
`js/00_core.js` → `cfg` (FOV, eye height, mouse sens), `js/30_entities.js` →
`WEAPONS` / `ETYPE` (damage, fire rate, enemy stats), `js/20_level.js` → `LEVELS` (map size, room
count, spawn tables, `amb`, `lampCol`, `fogCol`). Quality presets are the `QUAL` table in
`js/40_render.js`. `LEVELS[].rooms` is a target, not a promise — the placement loop keeps whatever
it fits, so expect 4-6 rooms on any sector.

## Judging the picture without a browser
`node tools/view.js <mode>` renders headlessly through the same code paths, with no canvas pixel
access (the stub throws on `getImageData`, so assets cannot accidentally depend on one):

| mode | what it tells you |
|---|---|
| `sheets` | every material (4 tiled quads) and sprite in one PNG (`/tmp/fps_sheets.png`) |
| `stats` | per texture/sprite: mean, deviation, neighbour gradient, coverage, emissive count, average RGB, blown pixels, and the bake pipeline's own albedo × shade × AO terms |
| `diag` | red-channel histograms per material plus measured **coverage** of every noise threshold helper |
| `exposure` | mean luminance and histogram averaged over levels × seeds × 6 view angles — the number to tune brightness against |
| `scene <level> [cam]` | one frame as a PNG (`/tmp/fps_scene.png`) plus its luminance stats |

`REPS=n`, `ONLY=W1` and `ASCII=1` narrow those runs. Levels lay themselves out with `Math.random`,
so `exposure` seeds it; single-run numbers otherwise swing ±20 from lamp placement alone.

## Notes
* Chrome/Safari/Firefox all fine. Mouse look needs pointer lock, granted on the first click — that
  click does not also fire your weapon.
* On a hidpi display the renderer caps device pixel ratio at 1.5 and renders at ~34-62% window
  height depending on the quality preset, which keeps it at 60fps on integrated graphics. `F3`
  shows fps, buffer size and billboard count; `F4` picks the preset.
* Boot spends ~1.6 s baking materials and characters, once, before the menu draws.
* `node tools/smoke.js` runs the whole game headlessly: every menu transition, all three sectors,
  gunfire actually killing something, and 180 generated levels checked for a reachable exit and
  reachable spawns. It must exit 0, keeps raster cost under 16 ms/frame and asset memory under
  40 MB.
* Crates and barrels are decoration, not cover — nothing but walls is solid, so sprites never
  block movement or line of sight.
