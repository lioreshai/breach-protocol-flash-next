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

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like, and the build behind these four frames is **#200**, which changed what the **far band** is made of: every ground row past `FARB` = 22 m used to take its light and tint from **the camera's own cell**, and now samples eight points along the row's own plane solve and takes its magnitude from the mip it replaces. (The stairs themselves came from **#196** — the one-quantum riser that is geometry, in wall material, with the floor half answering a plane above the eye — and they are still what makes two of these frames worth looking at.) Byte parity was re-checked at capture time rather than assumed: each of the 11 `js/` subresources was fetched from the Pages host with a cache-buster and md5-compared against `origin/main` — **11/11 equal**, `js/40_render.js` = `aaf2be75b238979280c00681bd782449` — and the merged marker `FARFAN` counts **5** in the served copy, **5** in `origin/main`'s and **0** in `origin/main~1`'s, which is what rules out the Pages cache serving the previous build. On that build `node tools/view.js bands` reads **mean |step| across the FARB boundary 4.22 / 5.83 / 3.42** (want ≤ 8, levels 0/1/2) and prints `2 known-issue row(s) (#195 riser legibility)`; the same row **exits 1 on a tree without the fix** — PR **#200**'s control tree, same probe, unmodified `js/`, where it prints **mean |step| 18.4 / 19.1 / 9.8** on levels 0/1/2 and `3 FAILURE(S)` — because there the far band is one constant per frame driven only by the camera column. A second triple sits in that PR's body, **18.2 / 20.8 / 9.8**: that is a **rejected variant**, a build that multiplied the wash's lit term by the fog attenuation `invRow`, and it is one digit from the control's own numbers, so the two are easy to confuse — the control is the *no-fix* tree, the other is a fix that overshot. All four shots come from a **single boot** of that build at the default seed and quality BALANCED — canvas **1440×763** (`innerWidth×innerHeight` at DPR 1), raster buffer **678×359** upscaled **2.125×**, horizon at buffer row 179.45 = canvas row **381**, eye **0.50**, fog **[17, 13, 10]** — with `DEV.freeze(true)` and `DEV.clear()` run **once at the start** and **no `startLevel` between shots**, so `MAP` never changes under them and `S.t` stayed pinned at 4.28 across all four (the freeze gates `update()` itself, so `DEV.tick(n)` renders without simulating: nothing walked, fell or shot between frames). Two honesty notes about the numbers below, both learned the expensive way in this repo: nothing re-seats `P.hp` at these poses and the page plays real frames before the freeze, so **vitals read 66** in all four and the damage vignette (#85 measured it at about −21) is *inside* every mean here; and the means come from `DEV.lum()` — Rec.709 weights, every 4th pixel of `cv`, i.e. **after** bloom, grade, grain and the HUD. Re-deriving them from the saved PNGs with an independent decoder puts them **+0.1 to +0.3 high**, not the "about 6 points low" an earlier caption claimed: full-frame means 24.05 / 55.79 / 23.88 / 13.83 against `DEV.lum` 23.86 / 55.59 / 23.61 / 13.73, and centre-half 38.56 / 83.03 / 37.88 / 15.20 against 38.55 / 82.86 / 37.66 / 15.66. The residual is the stride and the grain, not a layer change. `node tools/view.js` numbers are a third layer again (pre-bloom raster) and are never mixed into a sentence with these.

This boot deals a 26×26 **ARCHIVE SUBLEVEL** — 676 cells, 100 solid, **576 open**, of which **417 sit on the datum**, **144 at `MAP.fz` 4** (the raised band), **9 at `MAP.fz` −4** (the sunken block: a 3×3 hole at x 18–20, y 4–6), plus the two links that make those bands walkable — quanta **1, 2, 3 in one cell each** going up and **−1, −2, −3 in one cell each** going down. `MAP.cz` is **12 — three units of headroom — in 60 columns** and 4 in the other 516. Note that this *is* #152 shipped: generation authors walkable bands now, five floor values in one level. What it still does not author is a **deck with room on it**, so every staircase here is a flight you step up one quantum at a time and the two-storey level the roadmap wants remains authored work (M6, #16). The **room list is rolled per boot** and `startLevel` calls `genLevel` unconditionally, so a reset deals a new map — and the *first* boot of this session dealt a staircase and **no pit at all**, which is why these four frames come from the second boot of the same build. They are comparable to each other and to nothing else: **#87** measured the seeded spread at 18 to 70 points, wider than any difference quoted here, and **#139** was opened on exactly that non-comparison.

![spawn corridor](docs/screens/level0-spawn.png)

*The boot's own spawn seat — **(17.5, 14.5)**, heading **0.6 rad** — read out of `DEV.state()` and re-seated with `DEV.cam(P.x, P.y, undefined, P.ang, 0)`, so the position and heading are the ones generation handed the player and only the pitch is pinned. Feet on the datum (`MAP.fz` **0**, eye **0.50**), vitals **66**, raster buffer **678×359**, `DEV.cam` answers `snapped: false`, and `DEV.ray` down the view puts the first solid at **9.09 m** in border cell (25, 19). The HUD's centre line reads **"0 LEFT"** — the level's *name* occupies that line only once the portal opens, so "ARCHIVE SUBLEVEL" in the paragraph above comes from `DEV.state().levelName`, not from this frame. **Composited mean 23.86, centre-half 38.55.** Per-row means put the **top 323 of 763 rows below luminance 20** (deciles 8.7 / 10.6 / 8.8 / 9.7 / 46.9 / 62.8 / 27.4 / 21.9 / 19.6 / 24.7): that is #199 — the lightmap leaves that geography at zero because `splatLight` splats a **2-D disc and throws lamp `z` away** — plus the fact that this level's fog colour **[17, 13, 10]** has Rec.709 luma **13.63**, so distance-to-nothing converges on ~13 whatever the lightmap says. This is the reference frame for the other three, and it is *not* the bright one: the stair pose below is **31.7 points brighter** than it. The rifle at lower right is geometry composited inside `renderWorld()` (#185's shipped half), depth-tested against a swapped scratch array rather than the frame's `zbuf`; what is wrong with it is its **look and proportion** — a featureless slab of that size at that angle, with no hands in it — and #180 owns that. The disc at upper right is the minimap, whose cells are painted from a **band palette** (`MMBAND[fz − fzBase]`, nine colours from −1.00 m to +1.00 m): that two-tone disc is currently the **only** altitude cue anywhere in the interface, because nothing in the frame itself says which band a cell is on (#16). The radial grain across the ceiling near the horizon is the 4:1 anisotropy clamp chosen to keep the floor's grout lines (#57) and is known.*

![three treads up to the raised band](docs/screens/level0-facing-wall.png)

*Camera **(1.5, 8.5)**, yaw **π/2**, pitch 0, feet on the datum, buffer **678×359**, vitals **66**, HUD **"0 LEFT"**, looking up the flight that links the datum to the raised band: **mouth (1, 9) at `MAP.fz` 0, then (1, 10) at 1, (1, 11) at 2, (1, 12) at 3, landing (1, 13) at 4**. The lip under the crosshair is therefore `MAP.fz` **0 → 1** — **one quantum, 0.25 m** — and its drawn face is the slab side **[0.00, 0.25]** in wall material: `faceZ0` answers **0.25** there, `canEnter` passes **both ways** (a one-quantum crossing is walkable and the auto-step at `js/30_entities.js:376` is the only lift in the level), and `MAP.riserStops` counts **496 of 678 columns** stopped by a step face rather than a solid column on this frame — #196's fix *in the picture*, not just in the source. **Composited mean 55.59, centre-half 82.86**, which is where a sentence that used to sit here has to be deleted rather than corrected: an earlier version of this caption read a lip camera as *dark* (25.6 against its own spawn pose at 96.4) and explained it as a camera at a step receiving little light because height buys none. That diagnosis was measured and disproven, and on this boot the ordering simply **inverts** — **+31.7** in the other direction at the same tier and pitch. The sweep recorded in #197's thread found the same across 3 levels × 5 seeds × 3 cameras (raster layer): at matched lamp distance a lip camera reads **brighter** than its own spawn camera (**+18.0 ± 19.0 over 9 pairs**), and frame mean tracks **the camera column's own** `MAP.light` at **r = +0.62 (N = 44)** — here **0.123** at the camera's column against **0.361** on the tread in front of it. So the pair those captions were built on was **roll noise (#87)** and can invert in a fresh boot; what a quantum of height genuinely does not buy is a **band term** (#16), which is a different sentence from the one it replaced. Still wrong in this frame: **tread legibility**, which `bands` scores as a generated walk lip's luminance step across the lip at **76 / 26 / 12 %** on levels 0/1/2 against a **45 %** bar — on two levels of three a tread is a *shade* rather than an *edge* (#195) — and a 71-row **near-black stripe at rows 31–102** above the flight, which is #199 and the fog colour again, not the step.*

![one posed grunt, 6 m out](docs/screens/level0-enemies.png)

*The spawn seat again — **(17.5, 14.5)**, heading **0.6 rad**, pitch 0 — with one grunt placed by **`DEV.spawn('grunt', 1, 6)`**, so this is a **posed body, not the level's population**: `DEV.clear()` took the level's hostiles out at the start of the session — `LEVELS[0].spawn` deals 5 grunts and 3 hounds — so that nothing could move or shoot between the four frames, the HUD therefore reads **"1 LEFT"** here and in the pit frame below (and **"0 LEFT"** in the two frames above it), and `DEV.spawn` pins gait phase, tint, facing and death variant so that two boots put the same grunt in the same pose. It landed at **(22.452, 17.888)**, `MAP.fz` **0 — the camera's own band** — **6.00 m** out, `state 'sleep'`, `hp 34`, facing the camera; vitals **66**, buffer **678×359**; `DEV.ray` along that bearing finds its first solid at **9.087 m** (border cell (25, 19)) and at torso height 0.55 the same **9.09 m**, so nothing stands between the crosshair and the body. **Composited mean 23.61, centre-half 37.66** — 0.25 *below* the identical camera with no body in it, which is why the honest measure of what the body contributes is the pixel set rather than the mean: against the spawn frame at an identical camera, **4,790 of 1,098,720 px** (0.44 %) move by more than 4 luma, averaging **44.8** across those pixels and peaking at 184. The shot is deliberately *not* an altitude test — a body on the camera's own band is the case nobody disputes — and #189's complaint is about bodies on the **band above**, hidden by the lip's own geometry rather than by the draw path forgetting `floorAt`; that stays open on its own repro and is invisible from a datum camera. And #16's gap is in the corner of this frame too: minimap **cells** carry the band as a colour, but **bodies** are plotted in one plane with no altitude term at all.*

![the pit lip, one metre down](docs/screens/level0-props.png)

*Camera **(19.5, 2.5)**, yaw **π/2**, pitch 0, feet on the datum, buffer **678×359**, vitals **66**, HUD **"1 LEFT"**, facing the sunken block. The lip under the crosshair is **cell (19, 3) at `MAP.fz` 0 → cell (19, 4) at `MAP.fz` −4**: **four quanta, a 1.00 m drop**, into a 3×3 hole whose every column reads −4 — floor **−1.00**, own ceiling **0.00**, i.e. exactly one unit of headroom inside the pit, which is why standing in it works and climbing back out *this* face does not: `canEnter` passes **down** and refuses **up**, and the way out is the link on the hole's −x side (`MAP.fz` −3 at (17, 4), −2 at (16, 4), −1 at (15, 4)). `MAP.riserStops` is **678 of 678 columns** — every column of this frame stops at a step face, so the pit edge is a hard lit line across the lower third instead of a hole in the depth buffer, which is #196's half of the work. **Composited mean 13.73, centre-half 15.66**, and this frame is close to a direct measurement of the *fog*: `MAP.light` reads **0.00** at the camera's column, **0.00** at the lip's and **−4.3e-10** (a faded transient's signed zero) at the pit's, and level 0's `fogCol` **[17, 13, 10]** has luma **13.63** — the frame lands **0.1** from the colour of distance-to-nothing, with **rows 0–355 under luminance 20** (deciles 4.2 / 4.9 / 2.5 / 2.0 / 12.5 / 26.7 / 14.2 / 11.6 / 26.2 / 33.8). That is **#199**, and it is *not* height: nothing in this corner of the lightmap was ever lit, because `splatLight` splats a 2-D disc and discards lamp `z`; M5's missing per-band term (#16) is the *other* half and belongs in the same place. Props are **not** claimed for this frame either, despite its filename: this roll's **20 props and 180 decals** are wherever generation put them, no camera here was chosen for one, and the counts come from `DEV.state().counts` (`DEV.stats()` has no decal accessor).*

- *How to reproduce all four: open the site with `?dev=1`, then* `DEV.freeze(true); DEV.clear()` *once — the
  freeze gates `update()` itself and pins `S.t`, the clear takes the level's hostiles out so no frame can
  drift between shots — and then,* **with no `startLevel` in between**,
  `DEV.cam(P.x, P.y, undefined, P.ang, 0)` · `DEV.cam(1.5, 8.5, undefined, Math.PI/2, 0)` ·
  `DEV.cam(17.5, 14.5, undefined, 0.6, 0)` followed by `DEV.spawn('grunt', 1, 6)` · `DEV.cam(19.5, 2.5, undefined, Math.PI/2, 0)`,
  *each followed by* `DEV.tick(1)` *before reading `DEV.lum()` and the canvas PNG.*
  *`DEV.cam` takes **five** numbers — `(x, y, z, ang, pitch)` — and passing four leaves the pitch at the
  player's, which is how a "facing east" capture ends up looking at the ceiling.*
- *Proving a shot is a different frame rather than a `DEV.cam` that did not take: `DEV.lum().mean` across
  the four is **23.86 → 55.59 → 23.61 → 13.73**, no two alike, and pairwise over the saved PNGs
  **80.6 % / 80.6 % / 68.5 %** of pixels move by more than 4 luma between consecutive shots, against
  **0.036 %** (398 px) for re-rendering **one** camera twice. That last number is the floor under every
  "the frame changed" claim: it is BALANCED's per-frame grain, and it is also why two renders of one
  camera agree to 0.06 in luma while **not** hashing to the same PNG bytes.*
- *Both lips were read out of `MAP.fz` first and then checked against the page's own geometry rather than a
  hand-rolled walkability test: the two columns and their `MAP.fz` pair, `floorAt` on each side, `ceilAt`
  of the far side, `canEnter` in **both** directions, and `MAP.riserStops` after the tick. Of those, only
  `riserStops` proves the geometry is in the *picture* rather than in the grid — `DEV.ray` cannot see an
  air→air riser at all, because it breaks on **solid** columns only (it reports 16.5 m and 22.5 m of clear
  air down the two lanes above, straight through every step).*
- *What is still open beside these four frames: **#199** (a fifth to two thirds of a frame's visible ground
  solves to a column the lightmap left at zero — `splatLight` is a 2-D disc that discards lamp `z`),
  **#195** (a generated tread's luminance step is 76 / 26 / 12 % against a 45 % bar), **#189** (bodies on
  the band above, hidden by the lip's geometry), **#180** (the viewmodel's look and proportion) and
  **#16** = M5 + M6, per-band light with a glow cue and then a hand-authored two-storey level. **#152** is
  closed, and the roll above is what closed it: **five floor values, two links, 159 of its 576 open cells off
  the datum**. "The stairs draw"
  and "the level has two floors" remain different sentences: the first is true of generated content now, and
  the second is true of `MAP.fz` and not yet of anything a player would call a floor.*
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
