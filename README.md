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
                    the player actually walks), decal (ground decals reach the floor sampler),
                    anim (does an enemy's body change SHAPE while it walks: masks the silhouette by
                    the contrast technique, drives the gait through the game's own updateEnemies, and
                    fails on a body drawn in a static stance; KIND=<kind> picks the body, COST=1
                    measures the pose table against rebuilding vertices every frame)
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

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like. The four shots come from a **single boot** of build `4fde11c`, recaptured for the v1.1 release, and the map is never regenerated between them (`DEV.clear()` and `DEV.cam` only, no `startLevel`), so the corridor, the wall and the prop layout are one level rather than four coincidences. Earlier versions of this paragraph described two different builds, because the corpse change in #82 arrived after the first three shots were taken. `startLevel` calls `genLevel` unconditionally, so any reset deals a new map, and the camera is posed with `DEV.cam` and the frame frozen with `DEV.freeze` so nothing moves between the probe and the capture. Numbers quoted in these captions are **composited canvas** readings - what the site shows, post-post-processing - while `node tools/view.js` quotes the **pre-bloom raster**. A caption number and a probe number are not comparable and are never mixed in one sentence here, and the reason is worth stating exactly, because an earlier version of this paragraph got it wrong: bloom adds about **+20** mean luminance and the ambient vignette takes about **-21** (`js/40_render.js:736-752` and `:892`, measured over 24 poses in #85), so the two layers agree on average and disagree **per room** - +12 to +15 in a bright one, -6 to -8 in a dark one. There is no constant that converts one into the other. A caption's luminance number describes **one boot of one level**, and it is not comparable to another build's number for the same pose: `83d9411` predates **#96**, after which a seed maps to a different level because `makeEnemy` no longer consumes global `Math.random` draws inside `genLevel`, and **#87** measured the seeded spread across rolls at 18 to 70 points - wider than any difference a caption quotes. **#139** was opened on exactly that non-comparison and closed as not a defect; the corrections on it are the record of four confounds, each cheap to eliminate and each worth naming before the next caption diff: bisect the **metric** as well as the code (`#91` changed what `exposure`'s printed frame mean means), never compare a printed number against a file another probe mode left in the same temp path (`exposure` falls through into a scene dump at a camera its rolls left, `scene 0 0` does not - #58, #61), and remember that same-seed does not mean same-level across a generation remap.

![spawn corridor](docs/screens/level0-spawn.png)

*Build `4fde11c`, spawn cell of Archive Sublevel at (18.5, 7.5), yaw 1.57 rad (90 deg), a wall `hit` at **17.5 m** re-measured with `DEV.ray` - the same distance the era shot recorded, so the corridor is the same corridor. **mid-window 57.4, composited full-frame mean 27.7** on the displayed canvas. For this same pose build `83d9411` measured mid 80.9 / mean 80.6, and the two numbers are not a regression: `83d9411` predates **#96**'s seed-to-layout remap, so that seed photographs a different level there, and #139 - opened on precisely that difference - is closed as not a defect. This frame was posed at the documented coordinates rather than by re-running the era's candidate search, which rejects props within 4.5 m at +/- 0.4 rad; this boot puts a prop at **4.12 m** inside that arc, so the search would have moved on, and this is the era's camera rather than a re-derived one. Two rejected candidates belong to this shot's story. The longest sight (yaw 135 deg) measured 102 mid-window, above the band. The pose before it put a **lamp 1 m from the lens**, filling the frame with a grey pole and a bloom blob - so "longest lit direction" stopped being sufficient the moment props became solids, and the search now rejects any prop within 4.5 m of the camera inside +/- 0.4 rad. What is in frame: two crates, a barrel centre-screen with its hazard band, and a lamp at right that reads as a **dark post**, because a lamp no longer saturates a single pixel of the raster (#84). Two defects survive from before: the ceiling streaks radially near the horizon where true anisotropy exceeds the 4:1 clamp chosen to keep the floor's grout lines (#57), and which cell counts as "spawn" is the generator's roll (#60) - this boot dealt (18.5, 7.5) where the boot behind the previous version of this shot dealt (19.5, 3.5). Cleared with `DEV.clear()`, so nothing is mid-attack and the counter reads 0 LEFT.*

![close wall](docs/screens/level0-facing-wall.png)

*1.50 m from a wall face, camera (18.94, 2.06) at yaw 315 deg. The camera was backed off from the **face** - `DEV.ray`'s own hit point - and not from the cell centre, and the distance was re-measured from the finished pose. That re-measure is the interesting part: 856 candidate poses all sat at exactly 1.50 m, so distance was never the filter and the luminance band was, and the winner is the one whose mid-window (84.5 then) sits nearest the middle of it, composited full-frame mean 66.1 then. This build, same pose - camera (18.94, 2.06), yaw 315 deg, `DEV.ray` **hit at 1.50 m** with the face itself on the `x = 20` boundary line at `z 0.50` - reads **mid-window 40.8, mean 25.5**, which is the same non-comparison as the spawn shot's rather than a defect. Two back-off bugs were caught only by measuring **after** posing: in one cut the camera stood 1.5 m from a **miss**, because `DEV.ray` returns a far-plane distance when it does not hit, and in another it landed on `x = 8.0` exactly - a cell boundary - because the back-off was taken from the cell centre, and the confirming ray then reported `dist 0`. What the frame is good at is close-range wall texture: rust streaks, grout, moss, and a two-material corner. The forearms still read as tubes, which is not a shading problem: the first-person viewmodel is immediate-mode Canvas2D vector art drawn in `renderOverlay` (`js/40_render.js:933`), with no texture and no depth test - the subject of #77.*

![enemies](docs/screens/level0-enemies.png)

*Three grunts killed at the same `dieT = 0.466` with the same `dieAng`, placed at **3.12 m, 4.00 m and 5.11 m** across the corridor, plus two hounds alive, placed at 8.57 m and standing **7.53 m** out when the frame was taken (`DEV.spawn`, then 25 `DEV.tick` frames of approach with the freeze released before the pose). Camera (12.5, 7.5) at yaw 3.665 rad (210 deg), player healed to 100 because this is a posed frame and not a played one, HUD reads 2 LEFT. Recaptured on `4fde11c`: corpses at **3.13 m, 4.00 m and 5.12 m**, the two hounds **7.53 m** out and in `chase`, **mid-window 34.4, full-frame mean 43.9, blown 0.000%** - the era frame's mean (46.2) survives while its mid-window (74.1) does not, and that difference is **#96**'s remap rather than a darkening (#139, closed); corpses also lie low and the frame's edges are floor and HUD. Two staging corrections came out of rebuilding the pose. `DEV.spawn(kind, n, dist)` deals `dv` **within the call**, so three calls of `n = 1` dealt `dv 0, 0, 0` and the death rows had to be assigned by hand to get 0, 1, 2 - the `DEV.spawn("grunt", 6, 2.4)` claim below is about one call of six and still holds. And `DEV.tick(n)` while frozen runs **no `update()`** (`js/90_dev.js:19`), so the 25 frames of approach needed the freeze released; frozen, the hounds sit in `sleep`, and a still image of that frame would not admit it was wrong. The frame exists to make one claim falsifiable by eye, and the claim is now the opposite of the one this caption used to carry: **these are three different deaths, not one death rotated.** Earlier versions of this shot showed two corpses that were provably the same pose, because `js/13_mesh.js:201` read `sw = dying ? -0.45 * side`, where `side` is the leg's **loop index** - the only discriminator between two corpses was which leg the loop visited first. #82 replaced that with three authored death rows per kind, dealt at spawn.*

*The variant is `e.dv`, and it is dealt by a **counter, not a dice roll**: `makeEnemy` runs inside `genLevel`, so a `Math.random()` draw there advances the seed stream and rebuilds the entire level for a given seed - as a random draw it moved an exit distance from 29 to 33 and turned a 0.00 landing impulse into 4.07 without touching a line of shading (#90). A crowd therefore cycles the three deaths evenly rather than rolling them; `DEV.spawn("grunt", 6, 2.4)` on the live site yields `dv = 0,1,2,0,1,2`.*

*What the frame can and cannot show, measured rather than asserted. Masking each corpse against the identical frame with `ENEMIES` emptied: **4,693 px** (154×71) for `dv 0`, **1,735 px** (97×63) for `dv 1`, and **263 px** (31×20) for `dv 2` - the third corpse is **behind the second** from this angle, so the frame honestly shows two of the three shapes. It is a generated level, and every wider placement for it was either solid or behind a prop, so the occlusion is left in rather than staged away. The claim it cannot carry is in the numbers instead: at one camera with `dieT` and `dieAng` held equal and only `dv` changing, the three corpses mask **3,226 / 2,829 / 2,162 px** with bounding boxes **129×66, 125×80, 97×45** and give **three distinct silhouette hashes**. `node tools/view.js anim` asserts the same thing per kind - and until #88 it only ever animated `ENEMIES[0]`, i.e. one kind per level, printing three green rows while the hound and brute death poses were never executed.*

- *The upright body dead centre is a **hound at 8.6 m**, mid-stride (#75), its limbs self-occluding through the per-pixel depth buffer (#71). The second hound is at the same range, 3.2 m to the other side, and is **lost behind the lamp's flare and the viewmodel**: the HUD's 2 LEFT is correct, the minimap plots both of them, and this frame shows one.*
- *That flare is **bloom**, whose additive lift (`js/40_render.js:736-752`, no bright-pass threshold at all) is the only thing that saturates a pixel any more; the raster underneath has none (#84, #85).*
- *The sprawled corpse at left is `dv 0`, which is **the death that shipped before variants existed**, row 0 of the table authored number-for-number so that any corpse rolling 0 dies exactly the way it used to. If you have a screenshot of a corpse from before #82, this is the one shape that still matches it.*

*Still true and still unimplemented: every cell in this frame is at floor 0 with a one-unit ceiling - `MAP.fz` is 0 in **all 676** cells (26×26, min 0 and max 0 - re-measured in the page on `4fde11c`, identical numbers), `MAP.cz` is 4 in all 676, and `MAP.feat` is zero everywhere - so "vertical" remains a property of the engine and not of the picture (M3 step 4).*

![props close-up](docs/screens/level0-props.png)

*A crate at 2.2 m and a barrel at 4.1 m, camera (20.5, 6.5) at yaw 30 deg, composited mid-window 80.1 then. Same camera on this build, `DEV.ray` hit at 5.2 m: **mid-window 41.5, mean 17.5** (the #96 non-comparison again), and this boot deals **one prop at 3.61 m** inside the band where the era frame had a crate at 2.2 m and a barrel at 4.1 m - `PROPS.length` is 20 either way, so what differs is placement, not density. The pose was chosen by counting props inside the field of view at 2-5.5 m with nothing closer than 1.2 m, then taking the brightest-on-band candidate; emptying `PROPS` changes **37,093 pixels** of this frame, which is the honest way to say how much of it they own. Both are meshes since #76 (48 triangles for a crate, 84 for a barrel), so what is wrong with them is authoring and not machinery: a **mesh is vertex-coloured, not textured** (`js/13_mesh.js:89-91`), so the rust, labels and grime the prop sheets paint (`js/12_sprites.js:306-410`) have no representation at all and a crate is flat yellow with one dark band; the barrel shows **octagonal banding** because `tube()` is `NS*2` triangles at `NS = 6` (#78); and at an eye height of half a unit a 0.72-tall crate presents exactly **one face**, so it reads as a board until the player looks down. Neither lamp in this frame blows a pixel of the raster (#84), and the flare that does exist belongs to bloom (#85).*

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
* **Characters** (`js/13_mesh.js`) are volumetric meshes: six-sided tubes and chamfered boxes built
  from the same body fractions as `js/11_rig.js`, placed at the enemy's real position, heading and
  floor height, flat-shaded from a world-space normal and rasterized into the framebuffer the
  raycaster owns. The triangle raster writes the per-pixel depth it wins, which is what lets a body
  hide its own far side, and it clips at the near plane, so a body can walk into the lens. It has no
  animation yet — legs are straight — so the jointed 2D rasters (`js/11_rig.js`) and the bitmap
  sheets (`js/12_sprites.js`) are still built and probed by `view.js rig` and `DEV.set('rim')`, but
  nothing in a frame draws them any more; #69 B5 deletes them. Poses used to be cached by
  (species, gait phase, yaw, action); yaw left that key, because geometry is valid at every angle.
  `js/12_sprites.js` still paints props and decals.
* **Post FX**: bloom from a downscaled bright pass, projected lamp glow with a line-of-sight test,
  film grain and a contrast grade. `F4` trades these against internal resolution.

* **Audio** (`js/00_core.js`, `SND`) is synthesised at call time - noise bursts and tones panned by
  bearing over an ambient bed; `T` toggles it and prints AUDIO ON / AUDIO MUTED. See *Audio* below
  for the two traps that cost a debugging session each.

## How it works
* **Renderer** is a software raycaster (Wolfenstein-style DDA) writing into an `ImageData`'s
  `Uint32Array` at ~0.5× resolution, upscaled to the window. Per-column light, fog and tint are
  computed once per column, so each pixel costs one texture read, a few multiplies and a clamp.
* **Billboards** (props, pickups, projectiles, portal) are depth-tested per pixel against the
  distance the ground and wall passes wrote, and alpha blended, so a sprite is occluded correctly by
  walls and by the bodies in `js/13_mesh.js`, which write into that same depth. They also get a
  small distance-based fill light, so an unlit prop is still a readable silhouette.
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
| `DEV.look(dAng[, dPitch])` | Rotates in place. It never feeds `mouse.dx`, so it cannot walk the player into the void where DDA never hits. `dPitch` is in **pixels** (same unit as `P.pitch`), and it bypasses the gate below. |
| `DEV.face([enemy])`, `DEV.nearestEnemy()` | Aim at the nearest living enemy, or a given one. |
| `DEV.freeze([bool])` | Stops `update()` and pins the clock; rendering continues, so two screenshots of "the same frame" really match. Frozen frames run **no `update()` at all** (`js/90_dev.js:19`), so a frozen `DEV.tick(n)` fires nothing and drops nothing - it renders only. Drive the firing path unfrozen and take determinism from `DEV.tick`'s fixed `dt=1/60`. |
| `DEV.tick([n])` | Exactly `n` update+render frames at `dt = 1/60`, no vsync. |
| `DEV.spawn(kind[, n, dist])`, `DEV.clear()` | Place `grunt\|hound\|brute` in a deterministic fan `dist` metres in front of the camera; drop enemies/projectiles/particles. |
| `DEV.set(name, value)` | Runtime overrides of the quality tier (`res, bloom, grade, grain, far, glow, rigH, rast, dmax, scan, vec, min, max`) plus **`rim`** — the character rim light, for a live A/B. |
| `DEV.tiers()` / `DEV.stats()` | The `QUAL` table as it now stands; frame ms (`n/med/p95/last`), fps, buffer, draw calls, poses rasterised this frame, `RIG.stats()`, enemy count, tier name. |
| `DEV.state()` | JSON-safe snapshot: player (heading under `ang`), level, enemies, counts, `S` flags. |
| `DEV.ray(x, y[, z], dx, dy, dz[, maxD])` | Steps the real DDA and reports the first wall: distance, cell, face. |

Two facts that cost a verification pass each, learned while checking #132 live:

- **Aiming by console needs `mouse.down` too.** `update()`'s look step is gated on `S.locked || mouse.down` (`js/30_entities.js:326`) and `?dev=1` never holds pointer lock, so assigning `mouse.dy` alone is wiped by the unconditional `mouse.dx = mouse.dy = 0` at the end of the look step (`js/30_entities.js:331`) and the shot stays level. Set `mouse.down = true` for the frame that should consume it (that is what the smoke rows do), or use `DEV.look(0, dPitch)`, which assigns `P.pitch` directly. Read the slope back with `pitchTan()` - `P.pitch` is pixels.
- **`DEV.ray` and `hitscan` disagree at a step, and both are right.** A riser is a *drawn face* whose span is `[max(floor), ceilAt(air)]`, not a solid cell, so `DEV.ray` marching through it reports `hit: false` (through the opening above the step) or `hit: false` below the face, while `hitscan` stops at the boundary because `bandExitT` classifies the crossing. Cross-check a riser claim against `faceZ0(x, y, d)` and `ceilAt`, not against `DEV.ray`; `DEV.ray`'s `through` annotation is the field that says whether the cell it stopped in was air.

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
* `docs/ROADMAP.md` keeps direction, the priority rubric and measured constraints. Status questions go to
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
  `sprites: 2` right beside it), so it is a floor, not gameplay. Gameplay cost is what
  `WARM=1 node tools/view.js scene 1 0` measures over 180 frames; on this machine that has been
  ~10 ms avg and 35-76 ms worst, which is a different claim than "16 ms/frame".
* asset memory now walks `WALLS`, `PROP`, `ENEMY`, `FLOORS`, `CEILS`, `DECAL` **and** the rig cache.
  Before that it quoted 5.4 MB for something the game held ~30% more of.
* exposure varies a lot per level (recent run: 91 / 37 / 37, mean 55), so the mean is a dial to
  tune against, not a target. Levels 2 and 3 are the dark industrial ones.

Two traps that will bite a contributor:

* `js/11_rig.js` is the one file **without** `'use strict'` and it relies on implicit globals
  (`cache`, `frame`, `nearest`, `raster`, `CAP`, `BUCKETS`). Adding the directive breaks the game.
* The `vm` harnesses (`tools/view.js`, `tools/smoke.js`) stub `AudioContext` as undefined, so `SND.init()`
  bails there and **no sound is ever built in those two tools** - an audio change cannot be verified with
  them. What does verify it is `node tools/ci/assert.js audio`: it drives every `SND` method with the
  game's own argument conventions through its own `OfflineAudioContext` and measures the waveform (#157).
  It gates CI. In a browser the on-screen `ERROR (loop alive)` banner and `S.err` are the other trace;
  `S.err` now survives while `S.audioBroken` is set, because clearing it every frame made "audio died
  silently" undiagnosable.
