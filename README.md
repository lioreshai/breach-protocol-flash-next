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

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like. The four shots come from a **single boot** of build `dc98788`, the build whose generated levels author **volume** (#188 on top of #162's altitude), and the map is never regenerated between them (`DEV.clear()` and `DEV.cam` only, no `startLevel`, `P.hp` seated to 100 at each pose so a damage vignette is never part of a brightness number), so the corridor, the step faces and the prop layout are one level rather than four coincidences. Those four files were rendered from the **deployed bytes**: each of the 12 subresources was fetched with a cache-buster and md5-compared against the merged tree - `js/20_level.js` is `53ce6c64c85ed72b5657281519267fd7` on both sides, and the marker `authorVolume` counts 2 in the deployed file, 2 in `origin/main`'s and **0** in `origin/main~1`'s - because the capturing workstation's browser egress allowlist will not open the Pages host directly. Same bytes, same engine, same compositor, and the byte check is what makes that sentence evidence rather than an excuse. That roll deals a 26x26 Archive Sublevel with **506 of its 676 cells on the datum**, **144 at `MAP.fz` 4** plus the quanta **1, 2, 3** in one cell each (one three-step stair up), **20 cells at `MAP.fz` -4** plus the quanta **-1, -2, -3** in one cell each (the sunken block and a stair *down* into it), `MAP.cz` **12 - three units of headroom - in 59 cells** and 4 in the other 617, and `MAP.feat` carrying 6 `FEAT_STAIR` and 20 `FEAT_PIT` cells with no ladders and no rails. All three of #188's named features are in this one level, and every one of the four shots shows at least one of them. `node tools/view.js alt` prints the same claim on the probe's own seeds (**9 distinct floor values** per level, **170 / 251 / 307 cells** off the datum, largest contiguous off-datum patch **144 / 225 / 289**, two stair runs of >= 3 cells and 46 / 52 / 52 step faces, **86 / 45 / 100** open columns measuring >= 2 units from `floorAt` to `ceilAt` with the tallest 3.00 m, and 0 unreachable on all three) and `ci.yml` gates on it in the `test` job rather than only reporting it. Unlike the #96 remap named at the end of this paragraph it is **not** a seed-to-layout change either: `authorVolume` draws no random numbers - grepping its body, `js/20_level.js:391-639`, for `Math.random` returns nothing and the comment at `js/20_level.js:372` says why - so a band is a function of the room list. Earlier versions of this paragraph described two different builds, because the corpse change in #82 arrived after the first three shots were taken. `startLevel` calls `genLevel` unconditionally, so any reset deals a new map, and the camera is posed with `DEV.cam` and the frame frozen with `DEV.freeze` so nothing moves between the probe and the capture - and a luminance figure has to be sampled **after** a frame has been drawn at that pose, because `DEV.lum` reads the display canvas, which still holds the previous camera if nothing has rendered since the pose. This recapture's own log shows the trap: one pose printed **51.5** on a stale canvas and **79.9** after a render, 28 points apart on identical pixels. The frame-to-frame floor of any live-page diff is measured now rather than assumed: two renders of an **unchanged** state differ on 19,976 of the 274,680 sampled pixels by more than 2 and on **0** by more than 30, so that spread is grain and not geometry, and every pixel count quoted below is read at >30 on a 4-px stride of the 1440x763 display canvas. Numbers quoted in these captions are **composited canvas** readings - what the site shows, post-post-processing - while `node tools/view.js` quotes the **pre-bloom raster**. A caption number and a probe number are not comparable and are never mixed in one sentence here, and the reason is worth stating exactly, because an earlier version of this paragraph got it wrong: bloom adds about **+20** mean luminance and the ambient vignette takes about **-21** (`js/40_render.js:780` and `:937`, measured over 24 poses in #85), so the two layers agree on average and disagree **per room** - +12 to +15 in a bright one, -6 to -8 in a dark one. There is no constant that converts one into the other. A caption's luminance number describes **one boot of one level**, and it is not comparable to another build's number for the same pose: `83d9411` predates **#96**, after which a seed maps to a different level because `makeEnemy` no longer consumes global `Math.random` draws inside `genLevel`, and **#87** measured the seeded spread across rolls at 18 to 70 points - wider than any difference a caption quotes. **#139** was opened on exactly that non-comparison and closed as not a defect; the corrections on it are the record of four confounds, each cheap to eliminate and each worth naming before the next caption diff: bisect the **metric** as well as the code (`#91` changed what `exposure`'s printed frame mean means), never compare a printed number against a file another probe mode left in the same temp path (`exposure` falls through into a scene dump at a camera its rolls left, `scene 0 0` does not - #58, #61), and remember that same-seed does not mean same-level across a generation remap.

![spawn corridor](docs/screens/level0-spawn.png)

*Spawn cell of Archive Sublevel at **(11.5, 10.5)**, the centre of `MAP.rooms[0]` = (7,8,8,5) - the generator's own spawn seat - at yaw **5.4978 rad (315 deg)**, pitch 0, `P.z` 0 with the feet on the datum floor and the eye therefore at 0.50. The renderer's own DDA answers a wall at **13.44 m** (the map border's face at y = 1.0) while marching that same ray for altitude crosses its first **air-to-air band boundary at 2.13 m**, into cell (13,8) at `MAP.fz` 4 - the `DEV.ray`-versus-`hitscan` disagreement AGENTS.md records, now off by a factor of 6.3 and now with the *near* answer being the one that paints. A 41-ray fan across the 71.5 deg frustum crosses a band on **all 41 rays**, nearest at **1.57 m** (+30 deg) and furthest at **5.81 m** (-30 deg), and the lip of that boundary projects to row **202** of 763 dead ahead, **306** at -30 deg and **101** at +30 deg against a horizon of 383: that diagonal is the frame. This is #188's **raised quadrant**, and it is a diff rather than a caption claim - flattening its **147 cells** to the datum and relinking changes **111,764 of the 274,680 sampled pixels** by more than 30, 40.7% of the frame, and putting them back lands within 2,055. No `FEAT_STAIR` cell and no ladder is in this frustum: the staircase the previous version of this caption described belonged to the `f7d1847` roll. **Composited mean 45.42, mid-window 77.54** on the displayed canvas, sampled after a render at this pose - the next render of the identical state reads 45.41 / 77.53, which is the grain above. The rejected candidate deserves recording, though its numbers belong to the roll it was taken on: the longest sight from the spawn cell was **yaw 45 deg**, 19.09 m to a wall with a band 7.8 m out on the centre ray, a +/- 33 deg fan at that heading found **no stair cell at all**, and it measured **mean 58.34 / mid 49.13**, twenty-one points darker. So the documented rule ("longest lit direction, rejecting props within 4.5 m at +/- 0.4 rad") now needs its band term spelled out, because a long sight along the datum is a picture of a floor under a ceiling and after #162 that is not the picture this caption is for. Two things survive from before: the ceiling still streaks radially near the horizon where true anisotropy exceeds the 4:1 clamp chosen to keep the floor's grout lines (#57) - the grain running across the slab overhead here - and which cell counts as "spawn" is the generator's roll (#60), this boot dealing (11.5, 10.5) where the boot behind the previous version of this shot dealt (18.5, 7.5). What the top of the frame is, precisely: `ceilAt` of the spawn cell is still **1.00**, so the datum corridor here remains one unit tall - but the band's own ceiling plane, `MAP.ceilPlane` of cell (13,8), is **2.00**, which projects to row **-156** on the centre ray, off the top of the frame. So this pose shows a riser and a lip, not a room to look up INTO; the volume that makes a level read as a building is the 59 cells at `MAP.cz` 12, and they sit on other cells of this level (86 of level 0's open columns measure >= 2 units, per `alt`). Cleared with `DEV.clear()`, so nothing is mid-attack and the counter reads 0 LEFT. The rifle at lower right is rasterized geometry and not an overlay: suppressing `drawViewModel` moves **6,849** sampled pixels of this frame, and `js/40_render.js:192` is where it enters the world pass.*

![close wall](docs/screens/level0-facing-wall.png)

*1.50 m from a face, camera (15.5, 17.5) at yaw 0, pitch 0 - and this face is new. #188 moved the camera *inside* the feature: `MAP.cell` at (15,17), (16,17) and (17,17) is **air** with `MAP.fz` **-4, -4 and 0**, so the feet sit at **-1.00** and the eye at **-0.50**, and the lens is still not looking at a solid column but at an **air-to-air boundary** - the slab side of the **datum slab seen from the pit**, drawn over **[-1.00, 0.00]** (the same step rule as the previous build, with its sign inverted by the sunken block). That changes how the distance is proved: the 1.50 m is measured to the **boundary plane** x = 17.0, and `castRayDist` cannot confirm it because it marches straight through the raised air and answers **9.50 m**, the map border - the `DEV.ray`-versus-`hitscan` disagreement AGENTS.md records, now visible in a screenshot. The frame is its own check: the face's foot sits at y = 637 and its lip at y = 127 - the two largest vertical gradients on columns 480 and 720 of the PNG - against a horizon of 383, which is exactly `z = -1.00` and `z = 0.00` at 1.5 m with the eye at -0.50 - so what is in shot is a **one-unit step seen close from below**, its foot and its lip both inside the frame, where a room wall would have run past the top edge. The step rule is the thing under test here and it is falsifiable the same way the geometry claim in the spawn caption is: erasing the sunken block's **23 cells** and relinking changes **218,981 of the 274,680 sampled pixels** of this frame, 79.7%, which is the diff-side statement that this face exists only because 23 cells sit a unit below the datum. This pose reads **mean 118.58, mid-window 178.84** - the brightest of the four by a distance, because a lit sandstone face now fills the frame (the PNG's own top of range is 238 and 5.9% of its pixels read under 24, sampled at stride 3 off the file; a re-render of the same pose reads 118.68 / 178.92, again grain). The two earlier versions of this caption read 56.75 / 35.99 and 40.8 / 25.5 at other cameras on other levels, which is the usual non-comparison after a generation change rather than a brightening. The old back-off lesson survives and is sharper now: in one historical cut the camera stood 1.5 m from a **miss** because `DEV.ray` answers a far-plane distance when it does not hit, and a step makes that permanent - a riser is a drawn face, not a solid cell, so a ray that reports no wall there can still be staring at one from 1.5 m. What the frame is good at is close-range texture on a face that used not to exist: moss, panel wear, and a **two-material seam** about 80% across, because neighbouring boundary faces roll their own material. What is at the bottom right of this frame is no longer painted at all: the rifle is **geometry authored in metres** in `js/13_mesh.js` (`rifle(b, s)` at `js/13_mesh.js:491`) and rasterized into the **world buffer** by `drawViewModel()` (`js/40_render.js:1294`), called from inside `renderWorld()` at `js/40_render.js:192` - so it gets the same projection, the world's own scene-light multiply and the rasterizer's own depth, and `renderOverlay()` (`js/40_render.js:1089`) is left holding the composite, the bloom and the HUD. Its depth test is deliberately pointed at a **swapped scratch array** (`o.near`, `js/13_mesh.js:125` and `:814`) instead of the frame's `zbuf`, because the only nearer thing the world can write there is a wall the player is standing inside, whose `perp` is ~0 - that decision is what stops the gun culling a billboard or punching a hole in the sky (#180, shipped by #185). Read the old sentence in this paragraph's place as the record of that change: the forearms are shaded boxes that can be occluded now, and the thing in the first-person view that still is not right is the **look sway**, whose lag is damped against wall-clock `dt` (`VM.now = performance.now()`) - so far that `tools/view.js` has to put the rig at rest before *both* frames of any pair it diffs (`VMREST`, `tools/view.js:2471`, with the measured leak at `:2461-2466`), because two renders of one state otherwise disagree by 888 px. **#180 is the epic that owns both halves and it is still open**: the geometry shipped, the feel did not.*

![enemies](docs/screens/level0-enemies.png)

*Three grunts killed at the same `dieT = 0.466` (die term 0.847 of the 0.55 the draw path divides by) with the same `dieAng = -pi/2`, dealt `dv = 0, 1, 2`, all three **4.0 m** out and standing on the **-1** band - `DEV.spawn` seats them at (15.5,16.5), (16.14,16.55) and (14.86,16.55), every one inside the sunken block - plus one hound alive in `sleep` **9.0 m** out **on the +1 band** at (15.5,11.5), `floorAt` 1.00: bodies on **both sides of the camera's own band** in one frame, which no version of this shot had before. Camera (15.5, 20.5) at yaw -1.5708 rad (facing -y), pitch 0, player healed to 100 because this is a posed frame and not a played one, HUD reads **1 LEFT**. The lane is column x = 15: open datum at y 20-19 and 15-13, `MAP.fz` **-4** at y 19..16 and **+4** from y 12 downward, and `DEV.ray` calls the centre ray open for **19.5 m** - so one line of sight runs flat, then **down** a unit into the sunken block, then **up** a unit into the raised quadrant with no wall anywhere in it. **Composited mean 81.65, mid-window 96.99.** The hound is **placed, not walked in** - `makeEnemy('hound', 15.5, 11.5)` with `anim 0`, `stepPhase 0` and `state 'sleep'`, because the freeze that pins a still frame also pins whatever gait it found (`DEV.tick(n)` runs no `update()` at all while frozen, `js/90_dev.js:19`), and a frozen still of a moving creature is a claim the sim never made. Its altitude is NOT the `e.z` the spawner leaves at 0: the draw path passes `z: floorAt(e.x, e.y)` (`js/40_render.js:172`), so a body stands on **its own cell's** band - which is also why the three corpses read as standing *in* the pit instead of floating over it. The corpses were assigned by hand for a different reason: `DEV.spawn(kind, n, dist)` deals `dv` **within the call**, so three calls of `n = 1` would have dealt `dv 0, 0, 0`. The version this replaces staged its corpses at 3.11 / 4.01 / 5.10 m on the **datum** and read **mid-window 28.71, mean 26.21**; it is a different level after #188's generator, so the 55-point rise between those numbers and this caption's is the usual non-comparison and nothing should be concluded from it. The frame exists to make one claim falsifiable by eye, and the claim is now the opposite of the one this caption used to carry: **these are three different deaths, not one death rotated.** Earlier versions of this shot showed two corpses that were provably the same pose, because `js/13_mesh.js:201` read `sw = dying ? -0.45 * side`, where `side` is the leg's **loop index** - the only discriminator between two corpses was which leg the loop visited first. #82 replaced that with three authored death rows per kind, dealt at spawn.*

*The variant is `e.dv`, and it is dealt by a **counter, not a dice roll**: `makeEnemy` runs inside `genLevel`, so a `Math.random()` draw there advances the seed stream and rebuilds the entire level for a given seed - as a random draw it moved an exit distance from 29 to 33 and turned a 0.00 landing impulse into 4.07 without touching a line of shading (#90). A crowd therefore cycles the three deaths evenly rather than rolling them; `DEV.spawn("grunt", 6, 2.4)` on the live site yields `dv = 0,1,2,0,1,2`.*

*What the frame can and cannot show, measured rather than asserted. Method first, because it is what makes the numbers mean anything: the sim is frozen, so rendering the **same** state twice and diffing gives **0 px** at the threshold every figure below is read against - more than 30 on the sum of |dR|+|dG|+|dB| over a 4-px stride of the 1440x763 display canvas, 274,680 samples - while the same pair of renders at >2 moves 19,976 px, and that part is grain. What this recapture counts is **strong-change pixels when one body is added to an otherwise empty frame**: that weights a lit body over a big one and is deliberately NOT a silhouette mask, so no box and no hash is claimed from it - **dv 0 3,424 px, dv 1 1,693 px, dv 2 3,063 px**, and the hound on the +1 band **4,092 px**. Three different deaths move three different pixel counts, which is the claim the earlier roll made with masks: **2,188 px (77×103)** for `dv 0`, **3,872 px (209×77)** for `dv 1`, **1,036 px (67×41)** for `dv 2`, the datum hound **1,332 px (35×67)** and the band hound **704 px (63×105)** - a box 105 tall holding only 704 pixels, because **the lip hides the creature's legs** - and, in the set that held the camera, the position, `dieT` and `dieAng` equal and changed only `dv`, **1,884 / 2,112 / 1,116 px** with silhouette hashes **c0aba266 / 364ac1e3 / bd1895e2**. The tool that asserts the claim in the **shape** rather than the count is `node tools/view.js anim`, which `node tools/view.js anim` asserts the same thing per kind, and until #88 it only ever animated `ENEMIES[0]`, i.e. one kind per level, printing three green rows while the hound and brute death poses were never executed. What the masks cannot fix is legibility: at 3-5 m in a lane that reads 28 mid-window the three corpses still overlap into one dark heap to the eye, and `dv 1` is the only sprawl unmistakable from this camera.*

- *The only living body is the **hound on the +1 band at 9.0 m** - not 4.5 m, not upper right, and its feet on z = 1.00. Adding it alone to an otherwise empty frame changes **4,092** sampled pixels by more than 30, so from this datum camera it is **visible**, which is the honest thing to say beside **#189**: that issue's claim is that an enemy on the band above *can be* invisible from the datum and that the shot which hits you is solved the same way, a still frame cannot test the second half at all, and this configuration landed on the visible side. #189 therefore stays open on its own repro rather than being confirmed or closed by a screenshot. The minimap plots that hound as one plane with every other body and no altitude cue - M5 (#16) - and the HUD's **1 LEFT** is correct: three `dead` grunts and one hound in `sleep`.*
- *There is **no lamp in this frame** - both fixtures nearest this lane sit 6-7 m off the axis - so nothing here saturates a pixel and bloom has nothing to work on; the bullet this one replaces, which read the frame's flare as bloom's doing (`js/40_render.js:780`, no bright-pass threshold at all, #84/#85), belonged to the camera it was written for. What the dark area **above** each lip is deserves naming instead: the datum's own ceiling. `ceilAt` of a datum cell beside a raised room is **1.00** and that room's floor is **1.00**, so the ceiling plane ends exactly where the band's floor begins - a lip is the line where the ceiling stops, the riser runs up into it, and everything above it is a room the camera cannot see into.*
- *The sprawled corpse at left is `dv 0`, which is **the death that shipped before variants existed**, row 0 of the table authored number-for-number so that any corpse rolling 0 dies exactly the way it used to. If you have a screenshot of a corpse from before #82, this is the one shape that still matches it.*

*The claim this paragraph used to carry - that `MAP.fz` is 0 in **all 676** cells, `MAP.cz` is 4 in all 676 and `MAP.feat` is zero everywhere, so "vertical" is a property of the engine and not of the picture (M3 step 4) - is false now, and #162 is why. Re-measured in the page on `f7d1847`, the boot behind the **previous** four shots: `MAP.fz` is 0 in **566** of 676 cells, **4** in 107 of them and **1, 2, 3** in one cell each; `MAP.cz` is 4 everywhere except two ladder shafts at 6, cells (20,14) and (10,24); `MAP.feat` carries 3 stair cells and 2 ladder cells, no pits and no rails. Re-measured the same way on `dc98788`, the boot behind **these** shots: `MAP.fz` is 0 in **506** cells, **4** in **144**, **-4** in **20** and the quanta 1, 2, 3, -1, -2, -3 in one cell each; `MAP.cz` is 4 in 617 cells and **12 in 59**; `MAP.feat` carries **6 `FEAT_STAIR`** and **20 `FEAT_PIT`** cells, no ladders and no rails. Nine distinct floor values, a band above the datum AND one below it, spawn and exit still on the datum. Five distinct floor values, one staircase climbable on foot, two ladder links, spawn and exit still on the datum - and that is what `node tools/view.js alt` now asserts as a verdict instead of printing a flatness note, gated in `ci.yml`'s `test` job rather than parked in the reporting job where it could not fail. What is still true is the **scale**: every band here is exactly one unit above the datum (4 quanta of `ZQ = 0.25`), so a room upstairs is a floor at the eye line and the eye is still 0.5 inside a one-unit corridor. A band above the datum, a band below it and 59 columns with three units of headroom are in the picture now; what is still missing is a **storey** - a band you can stand on with a room above it to climb into - and that is M6 (#16).*

![props close-up](docs/screens/level0-props.png)

*A crate **5.00 m** out on the datum at (17.5,17.5), and a crate **5.66 m** out whose own cell sits at `MAP.fz` -4 - **standing a unit BELOW the camera**, on the sunken block - with a lamp 7.07 m beyond it and **10 props within 12 m**: camera (17.5, 22.5) at yaw 3.927 rad (225 deg, `P.ang` -2.3562), pitch 0, `floorAt` 0.00, `ceilAt` 1.00. The datum's edge into the sunken block crosses the centre ray at **3.55 m** (into cell (14,19)) and at 2.59-5.01 m across the frustum, 32 of 41 rays cross a band within 26 m, and the centre ray's own `DEV.ray` wall is **23.34 m** out - so this is a prop shot taken across the lip of a hole rather than across a room. **Composited mean 47.06, mid-window 71.17**, sampled after a render at the posed camera. `PROPS.length` is 20. The previous version of this caption claimed that emptying `PROPS` changes **78,420 pixels** of the frame, and that number is **dropped rather than restated** because it would not reproduce: removing all 20 measured 3,786 strong px while one lamp alone measured 4,418, and putting the list back afterwards left a 3,018 px residual against the reference frame. A mutation-based count of objects that feed an additive glow layer is not a coverage count, so the volume claim below does not lean on it. The rule that found this pose on the previous build counted props inside the field of view at 2-5.5 m with nothing closer than 1.2 m and required a band crossing inside 9 m on the centre ray and on both raking rays, and that is why the pose survives a generation change: on this roll the same camera still has props at 5.00 m and 5.66 m and a band crossing at 3.55 m, except one of the two now stands on a band **below** the eye instead of above it. Both props are meshes since #76, and `MESH.trisFor` still answers **48 triangles for a crate and 84 for a barrel** when it is asked in the page on this build - so what is wrong with them is authoring and not machinery: a **mesh is vertex-coloured, not textured**, so the rust, labels and grime the prop sheets paint (`js/12_sprites.js:336-400`) have no representation at all and a crate is one wood colour with one dark frame band (`js/13_mesh.js:260`); the barrel shows **octagonal banding** because `tube()` runs at `NS = 6` (`js/13_mesh.js:72`, #78); and at an eye 0.50 above its floor a crate whose body spans 0.04-0.84 presents exactly **one face**, so it reads as a board until the player looks down. One thing here reads worse than it is, and one thing reads better than the old caption promised, both by arithmetic rather than opinion. The raised half of the old sentence still holds: `ceilAt` of the camera's cell is 1.00, a band's own floor is 1.00, that plane ends at the band's floor edge, and a sight line that clears the lip enters the band's air and correctly paints whatever stands on it. The new half is the **drop**: with the eye 0.50 above the datum, no ray leaving here can strike the *near* face of a 1-unit hole - reaching z = 0 at a lip plane 3.55 m out needs slope 0.141, and every steeper ray meets the datum floor at 3.55 m or nearer - so the sunken block cannot show its own near wall and the crate standing on it is visible only over the lip. And the volume here is a diff, not a claim: flattening those **23 sunken cells** and relinking changes **70,738 of the 274,680 sampled pixels** of this frame, 25.8%.*

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
