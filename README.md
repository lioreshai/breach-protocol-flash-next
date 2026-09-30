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

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like. The four shots come from a **single boot** of build `dc98788`, the build whose generated levels author **volume** (#188 on top of #162's altitude and #185's geometry viewmodel), and the map is never regenerated between them (`DEV.clear()` and `DEV.cam` only, no `startLevel`, `P.hp` seated to 100 at each pose so a damage vignette is never part of a brightness number), so the corridor, the step faces and the prop layout are one level rather than four coincidences. Byte parity was re-checked at commit time rather than assumed: each of the 11 `js/` subresources was fetched from the Pages host with a cache-buster and md5-compared against the working tree - **11/11 equal**, `js/20_level.js` = `53ce6c64c85ed72b5657281519267fd7` - and the volume marker `RAISED` counts 1 in the deployed `js/20_level.js`, 1 in `origin/main`'s copy and **0** in `origin/main~1`'s, which is what rules out the Pages cache serving the previous build. That roll deals a 26x26 Archive Sublevel with **506 of its 676 cells on the datum**, **144 at `MAP.fz` 4** plus the quanta **1, 2, 3** in one cell each (one three-step stair up), **20 cells at `MAP.fz` -4** plus **-1, -2, -3** in one cell each (the sunken block and a stair down into it), and `MAP.cz` **12 - three units of headroom - in 70 columns** and 4 in the other 606. `node tools/view.js alt` prints the same class of claim on the probe's own seeds and `ci.yml` gates on it in the `test` job. Generation draws no random numbers for these features, so a band is a function of the room list - but **the room list itself is rolled per boot**, and `startLevel` calls `genLevel` unconditionally, so a reset deals a new map: these captions are only comparable to each other, never to another boot's numbers, and **#87** measured the seeded spread at 18 to 70 points, wider than any difference a caption quotes. **#139** was opened on exactly that non-comparison and closed as not a defect; the corrections on it (bisect the *metric* as well as the code, never compare a printed number against a file another probe mode left in the same temp path) still apply. Numbers quoted here are **composited canvas** readings from `DEV.lum` - post bloom, grade, grain and HUD - while `node tools/view.js` quotes the **pre-bloom raster**; bloom adds about **+20** and the vignette takes about **-21** (`js/40_render.js:780`, `:937`, measured over 24 poses in #85), so there is no constant between the two layers and no caption number is ever mixed with a probe number in one sentence. One more instrument fact, measured on this recapture because it burned an hour: **the same frame read two ways gives two numbers.** `DEV.lum` on the live canvas reads 48.08 / 138.94 / 129.82 / 117.15 for the four poses below; decoding the committed PNGs of those same frames with `zlib` at stride 3 reads **45.38 / 131.63 / 123.20 / 111.13** - a systematic ~6 points low in the same direction on all four, which is the screenshot's colour path, not the game. So a number re-derived from the file is not the number in the caption, and a caption that disagrees with a file by single digits is not a defect.

![spawn corridor](docs/screens/level0-spawn.png)

*Spawn cell of Archive Sublevel at **(20.5, 20.5)**, the centre of `MAP.rooms[0]` = (17,17,7,7) - the generator's own spawn seat - at yaw **3.927 rad (225 deg)**, pitch 0, `P.z` 0 with the feet on the datum floor, so the eye is at **0.50**. This is the longest sight the seat deals - **27.58 m** to the wall the renderer's DDA answers on the centre ray - and it is a sight that runs *through* altitude rather than along it: **25 of 41** rays across the 71.5 deg frustum cross a band boundary between **7.60 m** and **18.75 m**, and the centre ray's own first air-to-air crossing is at **16.30 m** into cell **(8,8)** at `MAP.fz` **-4**, i.e. this frame looks from the datum *down* into the sunken block #188 places in the room furthest from spawn. The 8.7 m of floor between the lens and that lip is what fills the lower half of the frame; beyond it the datum ends and the pit's riser begins, which is the one place a still frame cannot tell a pit from a distant floor - AGENTS' note that a prop or a band on a lip reads as floating until the lip itself gets a cue. The raised quadrant is in shot as the wall on the right running above the eye line, and the **tall room** overhead is the `MAP.cz` 12 case: the face climbs past the top of the frame instead of capping at one unit, which is the difference between a crawlway and a building and the whole point of #188. Six props sit in the frustum, **three of them on the +1 band** at 11.66-13.42 m (the other three on the datum at 13.45-13.60 m). **Composited mean 48.08, centre-window 41.41**, sampled after a render at the posed camera; the PNG of this frame decodes 2.7 points lower for the colour-path reason in the paragraph above. Cleared with `DEV.clear()`, so nothing is mid-attack and the counter reads **0 LEFT**. The rifle at lower right is rasterized geometry, not an overlay - `drawViewModel()` runs inside `renderWorld()` (#185, shipped by #180's first half) - and what is still wrong with it is the **look**, which #180 owns. The ceiling streaks radially near the horizon where true anisotropy exceeds the 4:1 clamp chosen to keep the floor's grout lines (#57): that grain across the slab overhead is known.

![close wall](docs/screens/level0-facing-wall.png)

*1.50 m from a face - camera **(11.5, 11.5)** at yaw 0, pitch 0, feet on the datum (`floorAt` 0, eye 0.50) and the face **not a wall**. The centre ray's first band crossing is at **exactly 1.50 m** into cell **(13,11)**, which sits at `MAP.fz` **4** with its own ceiling plane at **2.00**, so the plane the lens is 1.5 m from is a **boundary plane at x = 13.0**, drawn as the slab side of an air-to-air step (AGENTS' air-to-air span rule, not the wall rule). Distance is therefore proved against the plane, not against `DEV.ray`: the wall DDA answers **13.50 m** down this ray because it marches straight through the raised air - the `DEV.ray`-versus-`hitscan` disagreement recorded in AGENTS, visible in a screenshot. All **41 of 41** frustum rays cross a band between **1.50 m** and **1.85 m**, so there is no datum left in this frame at all; what is in shot is one step seen close, with the band's own ceiling plane 1.5 units above the eye. This is the brightest of the four shots - **mean 138.94, centre-window 195.25**, its top of range 240 and 5.1% of the PNG's pixels under 24 - because a lit sandstone face at 1.5 m fills the frame; the two earlier versions of this caption quoted 118.58 and 56.75 at other cameras on other rolls, which is the usual non-comparison after a generation change rather than a brightening. The back-off lesson survives and a step makes it permanent: `DEV.ray` answers a far-plane distance when it does not hit, so a camera can stand 1.5 m from a **miss** - a riser is a drawn face, not a solid cell, and a ray that reports no wall there can still be staring at one from 1.5 m. What the frame is good at is close-range texture on a face that did not exist before #188, including the two-material seam neighbouring boundary faces roll for themselves. The geometry viewmodel is in shot at bottom right and is depth-tested against a **swapped scratch array** rather than the frame's `zbuf` (`o.near`, #180) - that is what stops the gun culling a billboard or punching a hole in the sky.

![enemies](docs/screens/level0-enemies.png)

*Three grunts, **posed rather than walked in**, camera **(8.5, 10.5)** at yaw 0 on the datum (eye 0.50), the riser lip at **x = 13.0** so there is **4.50 m** of datum floor before the step. One grunt stands on the **camera's own band** at **3.00 m**; the other two stand on the **+1 band** at **8.00 m and 8.06 m**, feet at `floorAt` 1.00. The frame's claim is a pixel count, and it is the live-page measurement #189 was missing: removing the datum grunt changes **7,955** pixels of this frame by more than 30 (stride 1, full 1440x763 canvas); removing **each** of the two band grunts changes **35** - **51** for the pair - while the HUD counts **3 LEFT** and the minimap draws three blips. The control that decides what that means: dropping a **crate** into the same cell at the same 8.00 m range changes **0 px**, and a grunt in that cell changes **67**. So the band bodies are hidden by the **lip's geometry** - the sight line to a body standing on a floor 1.00 high, from an eye 0.50 high 4.50 m short of the step, clears the lip only near the crown - and **not** by the enemy draw path ignoring `floorAt`, which was the suspicion before this control was run and is now disproved. Props on that same band at 6.1-7.3 m do render in the shot below, which is the same statement from the other side: the lip hides what is far enough and short enough, and #189 is about the cone being narrow at the datum, not about props and bodies being drawn differently. **Composited mean 129.82, centre-window 185.75**; two renders of the identical frozen state differ on **0** px at >30, so every count above is geometry and not grain. Corpses are not in this frame: `DEV.tick` while frozen runs no `update()`, so a rig that has never been posed stays unposed, and the honest way to show a body is to let the sim run before freezing.

*The variant is `e.dv`, and it is dealt by a **counter, not a dice roll**: `makeEnemy` runs inside `genLevel`, so a `Math.random()` draw there advances the seed stream and rebuilds the entire level for a given seed - as a random draw it moved an exit distance from 29 to 33 and turned a 0.00 landing impulse into 4.07 without touching a line of shading (#90). A crowd therefore cycles the three deaths evenly rather than rolling them; `DEV.spawn("grunt", 6, 2.4)` on the live site yields `dv = 0,1,2,0,1,2`.*

*What the frame can and cannot show, measured rather than asserted. Method first, because it is what makes the numbers mean anything: the sim is frozen, so rendering the **same** state twice and diffing gives **0 px** at the threshold every figure below is read against - more than 30 on the sum of |dR|+|dG|+|dB| over a 4-px stride of the 1440x763 display canvas, 274,680 samples - while the same pair of renders at >2 moves 19,976 px, and that part is grain. What this recapture counts is **strong-change pixels when one body is added to an otherwise empty frame**: that weights a lit body over a big one and is deliberately NOT a silhouette mask, so no box and no hash is claimed from it - **dv 0 3,424 px, dv 1 1,693 px, dv 2 3,063 px**, and the hound on the +1 band **4,092 px**. Three different deaths move three different pixel counts, which is the claim the earlier roll made with masks: **2,188 px (77×103)** for `dv 0`, **3,872 px (209×77)** for `dv 1`, **1,036 px (67×41)** for `dv 2`, the datum hound **1,332 px (35×67)** and the band hound **704 px (63×105)** - a box 105 tall holding only 704 pixels, because **the lip hides the creature's legs** - and, in the set that held the camera, the position, `dieT` and `dieAng` equal and changed only `dv`, **1,884 / 2,112 / 1,116 px** with silhouette hashes **c0aba266 / 364ac1e3 / bd1895e2**. The tool that asserts the claim in the **shape** rather than the count is `node tools/view.js anim`, which `node tools/view.js anim` asserts the same thing per kind, and until #88 it only ever animated `ENEMIES[0]`, i.e. one kind per level, printing three green rows while the hound and brute death poses were never executed. What the masks cannot fix is legibility: at 3-5 m in a lane that reads 28 mid-window the three corpses still overlap into one dark heap to the eye, and `dv 1` is the only sprawl unmistakable from this camera.*

- *The only living body is the **hound on the +1 band at 9.0 m** - not 4.5 m, not upper right, and its feet on z = 1.00. Adding it alone to an otherwise empty frame changes **4,092** sampled pixels by more than 30, so from this datum camera it is **visible**, which is the honest thing to say beside **#189**: that issue's claim is that an enemy on the band above *can be* invisible from the datum and that the shot which hits you is solved the same way, a still frame cannot test the second half at all, and this configuration landed on the visible side. #189 therefore stays open on its own repro rather than being confirmed or closed by a screenshot. The minimap plots that hound as one plane with every other body and no altitude cue - M5 (#16) - and the HUD's **1 LEFT** is correct: three `dead` grunts and one hound in `sleep`.*
- *There is **no lamp in this frame** - both fixtures nearest this lane sit 6-7 m off the axis - so nothing here saturates a pixel and bloom has nothing to work on; the bullet this one replaces, which read the frame's flare as bloom's doing (`js/40_render.js:780`, no bright-pass threshold at all, #84/#85), belonged to the camera it was written for. What the dark area **above** each lip is deserves naming instead: the datum's own ceiling. `ceilAt` of a datum cell beside a raised room is **1.00** and that room's floor is **1.00**, so the ceiling plane ends exactly where the band's floor begins - a lip is the line where the ceiling stops, the riser runs up into it, and everything above it is a room the camera cannot see into.*
- *The sprawled corpse at left is `dv 0`, which is **the death that shipped before variants existed**, row 0 of the table authored number-for-number so that any corpse rolling 0 dies exactly the way it used to. If you have a screenshot of a corpse from before #82, this is the one shape that still matches it.*

*The claim this paragraph used to carry - that `MAP.fz` is 0 in **all 676** cells, `MAP.cz` is 4 in all 676 and `MAP.feat` is zero everywhere, so "vertical" is a property of the engine and not of the picture (M3 step 4) - is false now, and #162 is why. Re-measured in the page on `f7d1847`, the boot behind the **previous** four shots: `MAP.fz` is 0 in **566** of 676 cells, **4** in 107 of them and **1, 2, 3** in one cell each; `MAP.cz` is 4 everywhere except two ladder shafts at 6, cells (20,14) and (10,24); `MAP.feat` carries 3 stair cells and 2 ladder cells, no pits and no rails. Re-measured the same way on `dc98788`, the boot behind **these** shots: `MAP.fz` is 0 in **506** cells, **4** in **144**, **-4** in **20** and the quanta 1, 2, 3, -1, -2, -3 in one cell each; `MAP.cz` is 4 in 617 cells and **12 in 59**; `MAP.feat` carries **6 `FEAT_STAIR`** and **20 `FEAT_PIT`** cells, no ladders and no rails. Nine distinct floor values, a band above the datum AND one below it, spawn and exit still on the datum. Five distinct floor values, one staircase climbable on foot, two ladder links, spawn and exit still on the datum - and that is what `node tools/view.js alt` now asserts as a verdict instead of printing a flatness note, gated in `ci.yml`'s `test` job rather than parked in the reporting job where it could not fail. What is still true is the **scale**: every band here is exactly one unit above the datum (4 quanta of `ZQ = 0.25`), so a room upstairs is a floor at the eye line and the eye is still 0.5 inside a one-unit corridor. A band above the datum, a band below it and 59 columns with three units of headroom are in the picture now; what is still missing is a **storey** - a band you can stand on with a room above it to climb into - and that is M6 (#16).*

![props close-up](docs/screens/level0-props.png)

*Props, camera **(8.5, 11.5)** at yaw 0 on the datum, cleared so **0 LEFT**: seven of the level's 20 props sit in the frustum, **two lamps on the datum** at 3.16 m and 4.47 m, a **crate on the datum** at 12.65 m, and **two crates and two barrels on the +1 band** at 6.08, 6.71, 7.21 and 7.28 m - props standing at two altitudes in one frame, The number that says how much of the frame they own is a diff rather than a claim: emptying `PROPS` changes **14,690** pixels by more than 30 and putting them back returns the frame to **0** px difference, so props are not decoration in this shot but not the whole frame either, and the four on the band are visible because at 6-7 m a 0.84-high crate seen from an eye 0.50 high over a lip 4.50 m away clears that lip - which is the exact opposite of the grunt at 8.00 m in the shot above, and the reason both shots exist. **Composited mean 117.15, centre-window 165.97.** What is wrong with the props is authoring and not machinery: a mesh is **vertex-coloured, not textured**, so the rust, labels and grime the prop sheets paint (`js/12_sprites.js`) have no representation and a crate is one wood colour with one dark frame band; the barrel shows **octagonal banding** because `tube()` runs at `NS = 6` (#78); and at an eye 0.50 above its floor a crate whose body spans 0.04-0.84 presents almost **one face**, so it reads as a board until the player looks down. Nothing in this frame is drawn through a ceiling: the band's floor plane ends at the band's floor edge, so a sight line that clears the lip correctly paints whatever stands on it, and the lip's own missing cue is #189's other half.

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
| `exposure` | mean luminance and histogram averaged over levels × seeds × 6 view angles — the number to tune brightness against — plus a **spawn** column: mean and centre-half `mid` of the **first frame**, the pose `startLevel` leaves the player in, with no `update()` and no camera move (#155). The band that window asserts is 60–100 on the composited layer in `tools/ci/assert.js`; the spawn column is reported here and asserted separately there, and the two numbers are different layers — not comparable |
| `scene <level> [cam]` | one frame as a PNG (`/tmp/fps_scene.png`) plus its luminance stats |

`REPS=n` and `ONLY=W1` narrow runs, `ASCII=1` prints text instead of writing a PNG, and
`OUT=` redirects the PNG path. Levels lay themselves out with `Math.random`,
so `exposure` seeds it; single-run numbers otherwise swing ±20 from lamp placement alone.
That swing is why both brightness assertions read the **median of seeded rolls**: one seeded roll at one
fixed pose is a view class, not a property of the level — measured 21 to 137 composited mean across five
spawn frames of one level (#155), a range that straddles both failure anchors, so the per-roll values are
printed and the median is what gets judged.

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

* the raster figure is `renderWorld()+renderOverlay()` on a frame with nobody in it - the line beside
  it prints `sprites: 0`, which is `drawCalls` (`tools/smoke.js:149`), and it reads 0 rather than the 2
  this sentence used to quote because the first-person rig left the canvas path in #185 and is now
  rasterized **inside** `renderWorld` at `js/40_render.js:192`, so the floor it measures now *includes
  the viewmodel* and is no longer a world-only floor. That loop read **11.77 ms/frame** (batches
  11.5/11.8/11.8/11.8/11.9) on a 601x338 buffer at SEED 12345. Gameplay cost is what
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
