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
  tools/view.js     headless visual harness. Modes: sheets, stats, diag, exposure, scene (WARM=1 stresses the rig
                    cache over 180 frames), rig (pose sheet + coverage/bob metrics, ASCII=1 prints
                    a text render), viewmodel (every weapon through hip/ADS/recoil/reload/swap/
                    sprint/airborne, verifying overlay geometry lands on screen with balanced
                    save/restore), play (drives the real frame()/update() loop through every level,
                    weapon, reload, fire, sprint, combat and level transition, and measures how far
                    the player actually walks), decal (ground decals reach the floor sampler)
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
### What it looks like today

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like. All three come from a **single boot**: `startLevel` calls `genLevel` unconditionally, so any reset deals a new map, and the camera is posed with `DEV.cam` and the frame frozen with `DEV.freeze` so nothing moves between the probe and the capture.

![spawn corridor](docs/screens/level0-spawn.png)

*Spawn cell of Archive Sublevel, turned toward the longest direction that lands in the 60-100 luminance band: yaw 1.18 rad, 12.4 m of sight, mean 62.3. Floors and ceilings now choose their mip from **both** axes of the pixel footprint (#57), so the ground keeps tile detail into the middle distance instead of point-sampling into mush. Two defects survive in this frame. The ceiling near the horizon still streaks radially, because the true anisotropy there exceeds the 4:1 clamp that was chosen to keep the floor's grout lines. And the geometry of "spawn" depends on which level the generator dealt (#60): the three boots taken while shooting these put spawn in three different cells with sight lines of 12.4, 17.9 and 21.5 m. The level was cleared with `DEV.clear()` so nothing is mid-attack, which is why the counter reads 0 LEFT.*

![close wall](docs/screens/level0-facing-wall.png)

*1.5 m from a wall face. The forearms still read as tubes. The strip of floor along the bottom is what close ground looks like after #57 - busier and more legible than the point-sampled version it replaced - so the older note here, that the floor was over-saturated and too busy at close range, is re-stated against the new sampling rather than quietly dropped.*

![enemies](docs/screens/level0-enemies.png)

*Four enemies from the same generated level as the shot above. Hounds placed at 4.00 m had closed to 2.96 m by capture, grunts at 6.45 m, all four in `chase`, mean luminance 63.3, player at 100. `DEV.spawn(kind, n, dist)` clamps to the first open cell **short** of `dist`, so "metres in front" is an upper bound: from a pose without a clear sight line both spawns land at 1.45 m and the frame becomes a wall of torso. The rim light is a thin ridge now (#33: half-max band 9.00 to 2.22 px at a 600 px body), so the white-halo defect that used to be described in this caption is obsolete. What is actually visible: the limbs are still implicit-quad silhouettes (#41) - look at the near hound's legs - and the bodies are opaque, which is a measurement and not an impression, correlation -0.398 over 6463 masked body pixels against the wall behind them, body mean luminance 89.2 against wall 100, with the caveat that masking on a large difference biases correlation negative, so there is no positive tracking at all either way. The mottled read is torso speckle against an equally busy wall. The white flare at the near hound's feet is a lamp standing directly behind it.*negative*, so there is no positive tracking at all: the bodies are

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

* **Audio** (`js/00_core.js`, `SND`) is synthesised at call time - noise bursts and tones panned by
  bearing over an ambient bed; `T` toggles it and prints AUDIO ON / AUDIO MUTED. See *Audio* below
  for the two traps that cost a debugging session each.

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

## Driving the game from a console (dev mode)

Append **`?dev=1`** to the URL and the game boots itself — no click, no pointer lock — and publishes
one global, `DEV`. Without that flag `js/90_dev.js` returns immediately: no globals, no wrappers, no
behaviour change, so the flag cannot leak into normal play. `DEV.help()` prints this list in the
console.

| Call | What it does |
|---|---|
| `DEV.boot()` | Starts the run through the deploy button's own code path. |
| `DEV.cam(x, y[, z, ang, pitch])` | Parks camera and player. `ang` is `P.ang` (radians, +x is 0). Rejects NaN; a position inside a solid cell is snapped through the game's own `nearestOpen()`, so it cannot embed the player in a wall. |
| `DEV.look(dAng[, dPitch])` | Rotates in place. It never feeds `mouse.dx`, so it cannot walk the player into the void where DDA never hits. |
| `DEV.face([enemy])`, `DEV.nearestEnemy()` | Aim at the nearest living enemy, or a given one. |
| `DEV.freeze([bool])` | Stops `update()` and pins the clock; rendering continues, so two screenshots of "the same frame" really match. |
| `DEV.tick([n])` | Exactly `n` update+render frames at `dt = 1/60`, no vsync. |
| `DEV.spawn(kind[, n, dist])`, `DEV.clear()` | Place `grunt\|hound\|brute` in a deterministic fan `dist` metres in front of the camera; drop enemies/projectiles/particles. |
| `DEV.set(name, value)` | Runtime overrides of the quality tier (`res, bloom, grade, grain, far, glow, rigH, rast, dmax, scan, vec, min, max`) plus **`rim`** — the character rim light, for a live A/B. |
| `DEV.tiers()` / `DEV.stats()` | The `QUAL` table as it now stands; frame ms (`n/med/p95/last`), fps, buffer, draw calls, poses rasterised this frame, `RIG.stats()`, enemy count, tier name. |
| `DEV.state()` | JSON-safe snapshot: player (heading under `ang`), level, enemies, counts, `S` flags. |
| `DEV.ray(x, y[, z], dx, dy, dz[, maxD])` | Steps the real DDA and reports the first wall: distance, cell, face. |

Three things to do with it:

```
DEV.boot(); DEV.cam(4.5, 4.5, undefined, 0.6); DEV.freeze(true); DEV.tick(30)
DEV.spawn('brute', 1, 2); DEV.face(); JSON.stringify(DEV.stats())
DEV.set('rim', false)                       // then screenshot; DEV.set('rim', true) to restore
DEV.ray(P.x, P.y, 0.5, Math.cos(P.ang), Math.sin(P.ang))   // is that wall actually there?
```

The `rim` toggle exists because a defect in how characters composite survived every headless probe:
the probes rasterize poses without the scene-light multiply, so a probe passing was not a probe
being capable of failing. Being able to switch one shading term off in the running page turns that
kind of claim into a measurement.

## Judging the picture without a browser
`node tools/view.js <mode>` renders headlessly through the same code paths, with no canvas pixel
access (the stub throws on `getImageData`, so assets cannot accidentally depend on one):

| mode | what it tells you |
|---|---|
| `sheets` | every material (4 tiled quads) and sprite in one PNG (`/tmp/fps_tex.png`) |
| `stats` | per texture/sprite: mean, deviation, neighbour gradient, coverage, emissive count, average RGB, blown pixels, and the bake pipeline's own albedo × shade × AO terms |
| `diag` | red-channel histograms per material plus measured **coverage** of every noise threshold helper |
| `exposure` | mean luminance and histogram averaged over levels × seeds × 6 view angles — the number to tune brightness against |
| `scene <level> [cam]` | one frame as a PNG (`/tmp/fps_scene.png`) plus its luminance stats |

`REPS=n` and `ONLY=W1` narrow runs, `ASCII=1` prints text instead of writing a PNG, and
`OUT=` redirects the PNG path. Levels lay themselves out with `Math.random`,
so `exposure` seeds it; single-run numbers otherwise swing ±20 from lamp placement alone.

## How work is tracked

Backlog, bugs and milestones are [GitHub issues](https://github.com/lioreshai/breach-protocol-flash-next/issues),
not lines in a markdown file — an issue can be linked from the commit that closes it and a paragraph
cannot. The mechanics:

* A PR body names its issue with `Closes #N` (or `Fixes #N`). **The keyword is required**: on a squash
  merge a bare `#13` links the issue and leaves it open forever, and an issue nobody ever closes is
  worse than no tracker, because it teaches everyone to ignore it. The `issue` check enforces this.
* `[no-issue]` in the body is the opt-out for work that genuinely is not tracked. Like
  `[no-changelog]`, the marker has to be written down where someone can disagree with it.
* Commits may name the issue too (`M2: … (#13)`), which is what makes `git log` navigable.
* `triage.yml` runs weekly and reports open issues with no priority or no area label. It reports; it
  never labels or closes anything by itself.
* `ROADMAP.md` keeps direction, the priority rubric and measured constraints. Status questions go to
  the tracker.

## Notes
* Chrome/Safari/Firefox all fine. Mouse look needs pointer lock, granted on the first click — that
  click does not also fire your weapon.
* On a hidpi display the renderer caps device pixel ratio at 1.5 and renders at ~34-62% window
  height depending on the quality preset, which keeps it at 60fps on integrated graphics. `F3`
  shows fps, buffer size and billboard count; `F4` picks the preset.
* Boot spends ~1.6 s baking materials and characters, once, before the menu draws.
* `node tools/smoke.js` runs the whole game headlessly: every menu transition, all three sectors,
  gunfire actually killing something, and 180 generated levels checked for a reachable exit and
  reachable spawns. It must exit 0, keeps raster cost under 16 ms/frame **on a nearly empty frame** and asset memory under
  40 MB (every texture table plus the rig cache).
* Crates and barrels are decoration, not cover — nothing but walls is solid, so sprites never
  block movement or line of sight.


## Audio
Sound is synthesised at call time in `SND` (`js/00_core.js`) - filtered noise bursts and tones,
panned by the bearing to the source, over an ambient bed. `T` toggles it and prints AUDIO ON /
AUDIO MUTED, which is how you tell a muted game from a broken one. Two traps are worth knowing
before you touch it, because both cost a debugging session:

* An exponential ramp may not leave a value of zero. Footstep gain is scaled by distance, so a
  distant footfall reached `exponentialRampToValueAtTime` sitting at 0 and threw in Chrome - the
  envelopes therefore start at 0.0008 and floor their target above it.
* A context created before the first user gesture stays `suspended` until something resumes it.
  `SND.on()` nudges it awake instead of returning false forever, which is what silently muted the
  whole game.

As a last resort any throwing `AudioNode` call disables sound and closes the context rather than
propagating: an exception anywhere in `frame()` used to abort the frame before `renderWorld()`, so
the simulation kept stepping behind a still picture and the game looked hung while it was fine. The
frame body now also paints the message if it does throw, and renders anyway.

## Extending it
* **A material**: add an entry to the material list in `js/10_assets.js` and paint it with the
  `Surf` primitives from `js/05_paint.js`. Levels pick wall textures through `pickWallTex`, and
  floor and ceiling variants are indexed by the same ids. Never read canvas pixels - the headless
  harness throws on `getImageData` so that painting stays procedural and stays testable.
* **A prop**: paint it into `PROP` in `js/12_sprites.js`. Billboards are drawn, filtered and
  occluded for free.
* **An enemy species**: add an `ETYPE` row (speed, `stride`, `gait`, scale, hitbox height) plus a
  `RIGSPEC` entry and `RIGCOL` colours in `js/11_rig.js`. Rig units are fractions of body height, so
  hitboxes and geometry cannot drift apart. Gait phase advances with *distance travelled*, so a
  planted foot never slides - keep new locomotion honest by driving `stepPhase` the same way.
* **A quality knob**: add the field to every row of `QUAL` and read it once in `setGfx`, or in the
  shader that owns it. Never branch on the preset index inside a pixel loop.
* **Verify** with `node tools/smoke.js`, then whichever probe covers the change: `exposure` for
  anything tonal, `play` for logic and input, `viewmodel` for the overlay, `scene` with `WARM=1`
  for anything that costs frame time. Budgets: raster under 16 ms/frame, assets under 40 MB
  (currently ~5.4 MB plus a rig cache capped at 9 MB), exposure mean near 71 with under 15% of
  pixels below 24.


## What the gates actually measure
`tools/smoke.js` is the only pass/fail harness; the `tools/view.js` probes **print, they do not
fail** - `rig` will happily report `RIG PROBLEMS:` and exit 0. Read them as instruments, not as a
build. Three numbers deserve honesty rather than a badge:

* the raster figure is `renderWorld()+renderOverlay()` on an almost-empty frame (the run prints
  `billboards: 2` right beside it), so it is a floor, not gameplay. Gameplay cost is what
  `WARM=1 node tools/view.js scene 1 0` measures over 180 frames; on this machine that has been
  ~10 ms avg and 35-76 ms worst, which is a different claim than "16 ms/frame".
* asset memory now walks `WALLS`, `PROP`, `ENEMY`, `FLOORS`, `CEILS`, `DECAL` **and** the rig cache.
  Before that it quoted 5.4 MB for something the game held ~30% more of.
* exposure varies a lot per level (recent run: 91 / 37 / 37, mean 55), so the mean is a dial to
  tune against, not a target. Levels 2 and 3 are the dark industrial ones.

Two traps that will bite a contributor:

* `js/11_rig.js` is the one file **without** `'use strict'` and it relies on implicit globals
  (`cache`, `frame`, `nearest`, `raster`, `CAP`, `BUCKETS`). Adding the directive breaks the game.
* Nothing runs audio headlessly - both harnesses stub `AudioContext` as undefined, so `SND.init()`
  bails. Audio changes are only exercised in a browser; the on-screen `ERROR (loop alive)` banner
  and `S.err` are what tell you there.
