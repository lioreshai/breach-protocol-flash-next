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

Captured from the build that is on `main` now, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like, and the build behind these four frames is **#210** (`4495c08`), which changed **who is allowed to light a band**: a lamp's vertical weight is now taken against the source's own **floor** rather than added on top of its reach, and a band that no in-band source covers gets **a lamp of its own** at author time. That is two fixes deep into the lighting of off-datum ground, and it is the first recapture in which the pit frame is lit by a lamp **standing in the pit**.

**How these four pixels were obtained, and what that word is worth.** This session's web egress allowlist does not contain `lioreshai.github.io` — `browser open` on the Pages URL is refused inside the tool ("not in the web egress allowlist"), so the capture ran against **the merged tree rendered locally** (`file:///tmp/bprecap210/index.html?dev=1`, a worktree checked out at `4495c08`), which is the artifact the Pages deploy stages (`index.html` + `js/`): **12 of 12** files md5-equal to `origin/main`'s blobs, `topUpEnabled` present twice in `js/20_level.js`, and the page that rendered these frames answers `genLevel.toString().includes('topUpEnabled')` → **true** — the marker read out of the shipped *statement*, before the first screenshot and again after the A/B below, so the picture is not a cached build and the check is not prose about a comment. The deployed copy's own identity was established separately (Pages run 36763106594 success, js md5 parity 11 ok / 0 mismatch, `topUpEnabled` ×2 in the served `js/20_level.js`); what this session could not do is re-check those served bytes from here, and the difference between "the deployed page" and "the merged tree, rendered in a browser" is therefore the one caveat a reader should hold. Everything below was read out of the running page through `DEV`.

All four shots come from **one boot** at the default seed and quality BALANCED — canvas **1440×763** (`innerWidth×innerHeight` at DPR 1), raster buffer **678×359** upscaled **2.12×**, horizon at buffer row 179.5 = canvas row **381**, eye **0.50**, fog **[17, 13, 10]** — with `DEV.freeze(true)` and `DEV.clear()` run **once at the start** and **no `startLevel` between shots**. Two procedure changes from the last recapture, both of which move the numbers: the level was **dealt from the probe's own dice** — `Math.random` replaced by the same LCG `tools/view.js` installs in its sandbox, seeded **1000**, which is that tool's `1000 + level*97 + roll*13` at level 0, roll 0 — so *these PNGs and the probe's numbers are the same world*, and the two-instrument comparison in the table below is a comparison of layers rather than of two maps; and the level-intro banner was cleared with the game's own `banner('', 0)`, because the freeze gates `update()`, which owns that timer, so a frozen frame otherwise keeps "SECTOR 1 · ARCHIVE SUBLEVEL" across the middle of it forever. `DEV.clear()` also took the level's hostiles out, so **nothing moved between the four frames** (`S.t` pinned at 12.78) and the HUD reads **"0 LEFT"** in all four — `enemiesLeft()` is zero, the portal check lives in `update()`, and `MAP` never changed under them. **Vitals read 100 in every frame here**, which is not a small detail: the previous four frames were shot after the page had played real frames before the freeze, carried **66** hp, and had the damage vignette (#85: about −21) *inside* every mean they printed. These do not.

The dice is the single biggest number in this section and it is worth naming before any mean is quoted: `#87` measured the *unseeded* roll spread at 18 to 70 points, wider than any difference below, and `#139` was opened on exactly that non-comparison. Seeding makes these four frames comparable to the probes and to nothing else.

| level | composited `DEV.lum` (spawn frame, roll 0) | raster layer, same frame | `view.js exposure`, raster (4 rolls × 6 yaws) | `tools/ci/assert.js`, composited (5 rolls) |
|---|---|---|---|---|
| 0 ARCHIVE SUBLEVEL | **89.53** / mid 102.54 | **79.72** | mean 74, median 70, spawn roll 80 | median **86** |
| 1 RING TRANSPORT | **26.13** / mid 28.81 | **33.69** | mean 76, median 73, spawn roll 34 | median **85** |
| 2 ABATOIR CORE | **48.44** / mid 65.71 | **51.61** | mean 83, median 85, spawn roll 52 | median **95** |

Read the middle two columns first, because they agree: `DEV.lum`'s own raster equivalent — the Rec.709 mean of `px`, sampled in the same page at the same camera — lands within **0.3** of the probe's spawn-frame number on all three levels (79.72 against 80, 33.69 against 34, 51.61 against 52). That is the pair that says the two instruments measure one quantity; the *other* columns disagree for stated reasons and the disagreement is not a defect. The composited column is a **single spawn frame** where the probe columns are a **median of 4 rolls × 6 yaws** (and of 5 rolls for the CI lane), so a bright lamp in one roll moves one number and not the other; and #210 moved the probe's world without moving this frame's geometry, so the trend in the probe columns (**74 / 66 / 71 → 74 / 76 / 83 means, 70 / 73 / 85 medians** across #203 and #210, composited CI medians **86 / 85 / 95**) is a brightness trend the *screenshots* also show — level 2's CI median of **95** is **five under the window ceiling**, which is what "+3 lamps per level" (10 / 12 / 19 against main's 7 / 9 / 17) buys. `#211` **is closed by `91bca4b`**, and the claim it existed to make is now a gate rather than prose: `node tools/view.js flatparity` runs under `set -euo pipefail` in the blocking `test` job (`ci.yml:161`), and the triples are md5 literals **in the tool** — `OLD` = `f9e4da3a / f05beeb5 / d4b2d2cd` at `tools/view.js:657`, `SHIP` = `060da4cd / f05beeb5 / 050b225e` at `:664` — so "flat parity holds" is something a tool can now refuse to say, and this recapture watched both rows print `ok` on the shipped build.

A third layer sits beside those two: re-deriving the means from the **saved PNGs** with an independent decoder puts them **0.4 to 1.5 BELOW** `DEV.lum` (87.85 / 24.93 / 87.77 / 35.83 against 89.20 / 25.35 / 89.24 / 36.25, i.e. −1.35 / −0.42 / −1.47 / −0.42, largest on the two bright frames — the same sign and the same window as the last recapture found). The recapture before that one had recorded this gap as "+0.1 to +0.3 **high**", and the recapture before #222 confirmed the sign is the other way, and the PNGs carry no `gAMA`, `cHRM` or `iCCP` chunk (`IHDR` + `IDAT`s + `IEND`, nothing else), so it is the screenshot path, not a colour tag. Single-digit disagreement between a caption and a file is still not a defect; a *sign* flip is worth printing, which is why it is here rather than smoothed over.

A fourth trap this recapture fell into and then disarmed: **film grain has seven phases** (`grainSeed = (grainSeed + 1) % 7`, `js/40_render.js:1203`) and the page's own `requestAnimationFrame` loop keeps compositing between `browser eval` calls, so a "the frame changed" claim must be measured **inside one JS turn**. In-turn, seven grabs of one frozen camera (6 pairs spanning the whole 7-phase cycle, 549,360 px sampled per pair) move **0.009 to 0.028 %** of pixels by more than 4 luma, mean |Δ| 0.19 — the floor under every difference quoted below. Measured *across* eval calls, an unchanged frame reported as much as **2.872 %**, which is a phase artifact and nothing else. The previous caption's "0.036 % (398 px)" floor is the same quantity as the in-turn number.

![the spawn seat on a lit datum floor](docs/screens/level0-spawn.png)

*The boot's own spawn seat — **(11.5, 7.5)**, heading **0.6 rad**, pitch 0 — re-seated with `DEV.cam(P.x, P.y, undefined, P.ang, 0)` so the position and heading are the ones generation handed the player and only the pitch is pinned. `DEV.cam` answers `snapped: false`; feet on the datum (`MAP.fz` **0**, `MAP.cz` **4** = one unit of headroom, eye **0.50**), vitals **100**, HUD **"0 LEFT"**, buffer **678×359**, and `DEV.ray` down the view puts the first **solid** at **16.357 m** in border cell **(25, 16)** — a clean sweep of open ground, not a room full of cover. `MAP.light` at the camera's own column is **1.289**. **Composited mean 89.20, centre-half 102.16**; raster layer **79.68 / 78.17**. The honest headline for this frame is what its row statistics *do not* show: **0 of 763 rows average below luminance 20** (band means 59.9 / 62.5 / 57.4 / 42.7 / 55.2 / 131.3 / 145.4 / 139.3 / 110.6, where a band mean is the mean luma of nine equal vertical bands of the composited rows, x sampled at stride 4), where the same-named frame in the last recapture had **323 of 763** there. That is not this roll being luckier — it is #203 and #210 putting light on the band the camera stands on, and it narrows **#199** (unlit geography is lamp *coverage*: 63–72 % of dark cells have no source inside the disc radius in XY at all) to the frames where the geography genuinely has no source, two of which are below. The rifle at lower right is geometry composited inside `renderWorld()` (#185's shipped half), depth-tested against a swapped scratch array rather than the frame's `zbuf`; what is wrong with it is still its **look and proportion** — a featureless slab of that size at that angle, no hands in it — and **#180** owns that. The disc at upper right is the minimap, and on this frame it is **almost entirely black**: at the spawn seat the level is unexplored, so the **band palette** (`MMBAND[fz − fzBase]`, nine colours from −1.00 m to +1.00 m) that the last caption called "the only altitude cue anywhere in the interface" is not visible in this picture either. The player's own altitude is stated nowhere in this frame (**#16** = M5 + M6). The streaking across the ceiling is the anisotropy clamp chosen to keep the floor's grout lines (#57) and is known.*

![four risers up to the raised band, and the dark above them](docs/screens/level0-facing-wall.png)

*Camera **(1.5, 8.5)**, yaw **π/2**, pitch 0, feet on the datum, buffer **678×359**, vitals **100**, HUD **"0 LEFT"**, looking up the flight that links the datum to the raised band: **mouth (1, 9) at `MAP.fz` 0, then (1, 10) at 1, (1, 11) at 2, (1, 12) at 3, landing (1, 13) at 4** — four risers of one quantum each, `MAP.fz` × 0.25 m. The lip under the crosshair is `MAP.fz` **0 → 1**, a 0.25 m step whose drawn face is the slab side **[0.00, 0.25]** in wall material; `canEnter` passes **both ways** (a one-quantum crossing is walkable and the auto-step at `js/30_entities.js:376` is the only lift in the level), `ceilAt` of the tread above the lip is **1.25**, and `MAP.riserStops` reads **496 of 678 columns** stopped by a step face rather than a solid column — #196's fix *in the picture*. **Composited mean 25.35, centre-half 31.89**; raster **33.56 / 34.40**. Two defects own pixels in this frame. **#199** owns the top of it: **345 rows average under luminance 20 and the first 232 rows run unbroken** (band means 6.9 / 9.1 / 17.0 / 38.3 / 47.3 / 40.8 / 33.7 / 17.9 / 18.5), because the geography up there has no lamp — `MAP.light` is **0.022** at the camera's own column, **0.029** at the tread in front of it and **0.034** on the landing at `MAP.fz` 1, and the nearest static lamp is **7.62 m** away *standing on the band above*, `z` 1.78 (`MAP.fz` 4, disc radius 9.7). The sentence this replaces twice — "a camera at a step is dark because height buys no light" — was measured and disproven (+18.0 ± 19.0 *brighter* at matched lamp distance, frame mean tracking the camera column's own `MAP.light` at r = +0.62 over 44 samples), and on this seeded world the pair simply reads **spawn 89.20 against stair 25.35**: a 64-point gap in the *other* direction, which is a coverage statement about this world, not a verdict about height. **#195** owns the tread itself: `bands` scores a generated walk lip's luminance step at **L0 face 54 % / L0 walk 72** after #210, against the **45 %** bar, with **L1 walk 27 KNOWN** and **L2 walk 10 KNOWN** — on two levels of three a tread is a *shade* rather than an *edge*, and here the lit face under the crosshair is the part that does read.*

![one posed grunt, 6 m out, on the camera's own band](docs/screens/level0-enemies.png)

*The spawn seat again — **(11.5, 7.5)**, heading **0.6 rad**, pitch 0 — with one grunt placed by **`DEV.spawn('grunt', 1, 6)`**, so this is a **posed body, not the level's population**: `DEV.clear()` took the level's hostiles out at the start of the session, `DEV.spawn` pins gait phase, tint, facing and death variant so two boots put the same grunt in the same pose. The HUD in **this** frame reads **"1 LEFT"** — visible at the top of the picture — because `DEV.spawn` pushes into `ENEMIES` and `enemiesLeft()` counts it; the other three frames read **"0 LEFT"** (`DEV.clear()` took the level's population out at the start of the session, and `enemiesLeft()` measured 0 at each of those cameras). It landed at **(16.452, 10.888)**, `MAP.fz` **0 — the camera's own band** — **6.00 m** out, `state 'sleep'`, `hp 34`, facing the camera, `MAP.light` **0.595** at its column; `DEV.ray` along that bearing finds the first solid at **16.357 m** (border cell (25, 16)), so nothing stands between the crosshair and the body. **Composited mean 89.24, centre-half 101.95** — **+0.04** over the identical frame with no body in it (89.20 / 102.16), which is why the measure of what a body contributes is the pixel set and not the mean. Measured **inside one JS turn**, one render apart, against the in-turn grain floor of 0.009–0.028 %: **4,165 of 1,098,720 px (0.379 %)** move by more than 4 luma, averaging **43.1** across those pixels, centre-half **1.349 %** — about 20× the floor, and the same order as the 4,790 px (0.44 %) the same camera produced in the last recapture; sampled again on this build the same pair moves **4,133 px (0.377 %)**, mean **27.1** across those pixels, centre-half **1.356 %** (a second sample, two renders on, gives 4,139 px / 1.351 %). The shot is deliberately **not** an altitude test, and the honest version of that sentence is now measured rather than asserted: the same grunt, same 6.00 m, placed on **the band above** the stair camera (cell (1, 14), `MAP.fz` 4, **+1.00 m** over the camera's own floor) moves **8,782 px (0.799 %)**, mean **14.5** on the moved pixels, centre-half 0.682 % — on this build **8,674 px (0.789 %)** at mean **14.5**, so #222 changed neither case by more than 1 %. So *this* lip does not hide a body at all — **#189**'s complaint is the **deck** case in its own repro (a body on the band above at 8 m owning **35 px** against a crate's **0**), and it stays open on that repro, not on this staircase. #16's gap is in the corner of this frame too: minimap **cells** carry the band as a colour and **bodies** are plotted in one plane with no altitude term.*

![the pit lip from three metres out, lit by a lamp standing in the pit](docs/screens/level0-props.png)

*Camera **(20.5, 13.5)**, yaw **π/2**, pitch 0, feet on the datum, buffer **678×359**, vitals **100**, HUD **"0 LEFT"**, facing the sunken block: datum cell **(20, 16) at `MAP.fz` 0 → cell (20, 17) at `MAP.fz` −4**, four quanta, a **1.00 m** drop into a block whose columns all read −4 (plus the −3 tread of the descending stair at (17, 17)) — floor **−1.00**, own ceiling **0.00**, exactly one unit of headroom inside, which is why standing in it works and climbing back out *this* face does not: `canEnter` passes **down** and refuses **up**. `MAP.riserStops` is **675 of 678 columns**, so the pit edge is a hard lit line across the frame rather than a hole in the depth buffer. **What the picture actually shows, read off the file:** the lower third is the lip's riser band, lit and readable; above the horizon the geography is black (#199, the run below); and dead centre, between the crosshair and the lip, stands **a barrel prop** that hides the middle of the edge and the pit lamp behind it — the lamp's own glow is visible to its right, the pit floor itself is not in this frame at all. That is #218's pixels in a still: props are authored at cell centres and have no collision, so one can stand on the sightline to the thing a caption is describing. **This is the frame that documents #204, and it does so as a measurement rather than as a caption claim.** The pit's 16 floor cells (`MAP.fz` ≤ −3) carry a mean delivered `MAP.light` of **0.377** and **0 of them** sit under 0.05; switch the #210 top-up off at author time (`topUpEnabled = function () { return false; }`, the knob `tools/view.js LAMPS=off` uses) and **re-deal the same dice** and the same 16 cells read **0.002** with **16 of 16 under 0.05** — the lamp list goes from **10 to 7**, and the three it loses include one **standing in the pit** at (19.5, 19.5), `z` **−0.22** = floor −1.00 + `LHOVER` 0.78 — the lamp #222 re-lit, from `str` **1.05** to **0.525** = `TOPUP_BASE` 1.05 × clamp(16 covered cells / `TOPUP_TARGET` 32). Same two cameras, same dice, before → after: this lip camera **20.62 → 36.25** (centre-half 33.54 → **60.79**), and **standing on the pit floor** at (19.5, 19.5) facing **+π/2** **36.00 → 157.24** (centre-half 48.06 → **215.33**, `MAP.light` **0.580** at that column). Both halves of that pair were re-measured on the shipped build, not inherited: the knob-off arm reads **20.33 / 33.54** at this camera and **35.98 / 48.05** on the pit floor (its centre-half matches the printed 33.54 and 48.06 to 0.01, its mean sits 0.29 and 0.02 below, and `flatparity`'s **PARITY `f9e4da3a / f05beeb5 / d4b2d2cd`** is byte-identical across #222 because the ramp never runs when the top-up is suppressed at author time), while the build before #222 (`7614238`) at the same seed and the same poses reads **44.20 / 73.05** and **168.10 / 228.94** — the numbers this caption carried before this recapture. The pit-floor camera now states its heading because it must: at that one cell the four cardinal headings compose to **68.12 / 157.24 / 111.12 / 46.37** (0, +π/2, π, −π/2), a 111-point spread no lamp can explain. The grid is identical in both arms — same 572 open cells, same `MAP.fz` histogram — so the difference is light authored on a band, and nothing else. **The after number is also the overshoot, and #213 owns its history while #221 owns what is left of it**: one lamp at `LHOVER` 0.78 m inside a 5×3 hole reads a composited mean of **157** and a centre-half of **215** standing on the pit floor (mean delivered light **0.002 → 0.377** on this dice, **0.426 / 0.423 / 0.464** across `alt`'s 12 rolls, dark **16/16 → 0/16**), which is still nearly blown — **2.62 %** of its sampled pixels sit at or above 240 luma, against **0.07 %** in the frame above — and #204's original symptom ("a 0.25 m dip is floodlit and a 0.50 m pit is black") has flipped sign and then been dimmed, not vanished; `alt`'s pit row is green at **0 of 181 / 194 / 175 dark, mean 0.426 / 0.423 / 0.464** against its 0.55 ceiling, with that population present in **11 / 12 / 10** of the 12 rolls (`828d1b4`'s own record of the unscaled top-up: **0.672 / 0.631 / 0.647**; 2c5a94f: **117 / 71 / 62 dark at 0.077 / 0.174 / 0.230**) and says nothing about how bright the lit end is. **What lamp intensity cannot reach is the glow overlay, and that is #221.** Measured at this pit-floor pose, `DEV.set('glow', 0)` moves the frame by **0.01** mean (157.26 → 157.27) — the camera stands in the lamp's own cell, so `drawLightGlow` skips it on its `d < 0.35` test and draws no candidate at all — while the same switch at this lip camera moves **0.47** mean and **1.75** centre-half (36.32 → 35.85, 60.85 → 59.10), where datum lamps *are* in the frame. So on this dice the white box at (19.5, 19.5) is the pit lamp's own ground light filling a one-unit-high hole, and #221's case — a lamp on a band *above* a pit, which `project()` puts at the wrong screen row and `los()` cannot see a slab between — is the frame `alt` reports as **183.8 mean / 245 mid** on level 2, which no placement knob moves. Both halves stay open: #213 closed by `828d1b4` (the scale), **#221 open** for the glow's missing altitude term. One population caveat for that row: on **this** dice the sunken block deals on levels 0 and 1 (16 pit cells each, mean **0.377 / 0.386**, 0 dark) and **not at all on level 2**, where `MAP.fz` never goes below the datum at roll 0 — so #210's pit verdict is non-vacuous on two of three levels per roll, which is the same reason `alt` prints the population beside the verdict. **303 rows average under luminance 20 here and the first 273 run unbroken** (band means 9.5 / 9.5 / 11.5 / 26.6 / 40.7 / 74.5 / 66.6 / 60.6 / 28.3, mean **36.25**, centre-half **60.79**, raster **39.04 / 49.14**; the frame's own mean read **36.25 / 36.26 / 36.28 / 36.32** when this session sampled it four times, spread 0.07 luma across re-poses and re-deals of one dice) — that is **#199** again: the geography above the pit has no source in any disc. **#209**'s pixels are in this frame's light budget rather than in its picture: the exit pad at **(24, 24)** is the one static source authored with **no z**, its disc covers **172** open cells that are not on its own band and **169** of those are *below* it, and on this dice it delivers **0** cells of pit light — the row passes because #210 gave the pit a lamp of its own, which is the resolution #209 says to settle on, with the pad's reach still unbounded downward.*

- *One more thing the page does at a pit, found by pointing a camera at one and not believing it: **the same pit from 1.5 m out was not a pit, and it was not a wall either (#212, closed by #217).** At (20.5, 15.5), yaw π/2 — one cell back from the lip cell, open ground under the camera — **93.8 % of the pixels above the horizon carried *prop* texture** while `DEV.ray` reported **open ground to 9.5 m**, `MAP.fz` says the lip's slab side is 1.5 m ahead and `MAP.riserStops` reads 678/678, and `zbuf` on rows 10…355 of the mid columns records the face at **0.14 to 0.21 m**. The fraction falls off with distance: **13.5 %** at 2.5 m, **2.8 %** at 3.5 m (the shot above), **0.4 %** at 5.5 m, **0 %** at 7.5 m, with `min zbuf` climbing from 0.14 to 1.00 across the same sweep, and the composited mean of the 1.5 m pose is **71.62** — a *bright* frame, which is why no brightness gate sees it. What #217 found when it attributed those pixels is that they belong to neither geometry nor texture: at this camera the wall pass paints **0.0 %** of the above-horizon rows, the lip's own riser face spans `[-1.00, 0.00]` and is drawn wholly *below* the eye, and **95.8 % of those pixels belong to a barrel prop at 0.00 m** — props are authored at cell centres and this camera sat on a cell centre, so the mesh, magnified to the rasterizer's `NEAR = 0.12`, *was* the frame. `DEV.ray`'s open ground was never a second verdict either: it breaks on **solid** columns and cannot see an air→air riser. #217 skips a prop whose authored footprint (`MESH.foot`) contains the eye, which is the render half; the movement half — props are not collision at all, so a player can walk into one — is **#218**.*
- *How to reproduce all four: open the site with `?dev=1`, replace `Math.random` with the LCG `tools/view.js`'s `seedRng` installs, seed it **1000**, then* `startLevel(0, true); DEV.freeze(true); DEV.clear(); banner('', 0)` *once — the freeze gates `update()` and pins the clock, the clear takes the level's hostiles out so no frame can drift between shots, the banner call is the game's own way of ending an intro overlay whose timer the freeze stopped — and then,* **with no `startLevel` in between**,
  `DEV.cam(P.x, P.y, undefined, P.ang, 0)` · `DEV.cam(1.5, 8.5, undefined, Math.PI/2, 0)` · `DEV.cam(11.5, 7.5, undefined, 0.6, 0)` followed by `DEV.spawn('grunt', 1, 6)` · `DEV.cam(20.5, 13.5, undefined, Math.PI/2, 0)`,
  *and one pose that is quoted but not shot,* `DEV.cam(19.5, 19.5, undefined, Math.PI/2, 0)` *— the pit-floor camera whose numbers live in the props caption above. It gets no file: looked at, that frame is floor texture from row 0 to row 762 with no riser, no lamp and no body in it (the camera stands inside the lamp's own cell, in a hole exactly one unit high), so a fifth PNG would be a picture of grain while the numbers say more. **Four files, four images; the pit floor stays numeric.**
  *each followed by* `DEV.tick(1)` *before reading `DEV.lum()` and the canvas PNG. Re-dealing is safe and reproducible: this recapture re-dealt the same dice four times and the pit-lip frame's mean spread by* **0.07** *luma (36.25 / 36.26 / 36.28 / 36.32), and the build before #222, re-dealt the same way, lands on 44.20 against the 44.30 the last caption printed.*
  *`DEV.cam` takes **five** numbers — `(x, y, z, ang, pitch)` — and passing four leaves the pitch at the player's, which is how a "facing east" capture ends up looking at the ceiling. The heading is* **`P.ang`** *(there is no* `P.yaw`*), and* `P.pitch` *is in buffer pixels, so report* `pitchTan()` *(0 in all four frames) when a number has to mean a slope.*
- *Proving a shot is a different frame rather than a `DEV.cam` that did not take: `DEV.lum().mean` across the four is **89.20 → 25.35 → 89.24 → 36.25**, no two alike, and pairwise over the composited pixels **93.2 %** of them move by more than 4 luma between the spawn and the stair camera. Against the in-turn floor of **0.009–0.028 %** (re-measured on this build at **0.0184 %** — 202 px of 1,098,720 between two grabs of one frozen camera one render apart; the last capture's figure came from 7 grabs across the 7-phase grain cycle, 549,360 px sampled per pair) every "the frame changed" claim above clears the noise by at least an order of magnitude — and the claims that do *not* clear it are the ones about bodies, which is why those are printed as pixel counts (4,165 and 8,782, re-shooting to 4,133 and 8,674 on this build) and not as means.*
- *Both lips were read out of `MAP.fz` first and then checked against the page's own geometry rather than a hand-rolled walkability test: the two columns and their `MAP.fz` pair, `floorAt` on each side, `ceilAt` of the far side, `canEnter` in **both** directions, and `MAP.riserStops` after the tick (496/678 at the flight, 675/678 at the pit). Of those, only `riserStops` proves the geometry is in the* picture *rather than in the grid —* `DEV.ray` *cannot see an air→air riser at all, because it breaks on* **solid** *columns only (it reports 16.5 m and 9.5 m of clear air down the two lanes above, straight through every step and through the pit lip).*
- *What is still open beside these four frames, and which pixels each one owns: **#199** (the 232-row and 273-row dark runs above the flight and above the pit — `splatLight` splats a 2-D disc and lamp `z` buys coverage), **#195** (the tread that is a shade rather than an edge: **L0 face 54 %, L0 walk 72** after #210, **L1 face 69 / L1 walk 27 KNOWN, L2 face 43 KNOWN / L2 walk 10 KNOWN**, against a **45 %** bar), **#189** (bodies on a **deck** above, 35 px against a crate's 0 in its own repro — the staircase case is measured above and is *not* it), **#209** (the z-less exit pad, whose disc still reaches 169 open cells below its own band and delivered 0 of the pit's light on this dice), **#180** (the viewmodel's look and proportion), **#211** (closed: `flatparity` runs in the required job now, both senses — and note that the *reason* its sign-blindness note printed was itself wrong, which is **#219**). Newly filed beside it: **#216** (21 of 22 probe blocks print verdicts with no hash behind them), **#218** (props have no collision), **#219** (`flatparity`'s census counts its own `MAP.fz.fill(0)`, and a dealt-frame md5 sense would close the sign blindness for real), **#206** (wrong-band light still spreads by `blurLight`, 37 open cells on level 0 against main's recorded 123, so "must not grow", not "= 0"), **#212** (closed: that frame was a barrel prop standing on the camera's own cell centre, not a wall — the bullet above), **#213** (closed by `828d1b4`: the lit pit overshot — mean light 0.002 → 0.630 and pit-floor `DEV.lum` 36.00 → **168 mean / 229 mid** from one lamp at `LHOVER` in a 5×3 hole, the sign-flipped symptom #204 closed into — and a coverage top-up now carries `TOPUP_BASE * clamp(covered / TOPUP_TARGET, TOPUP_MINF, 1)`, so that same camera reads **157 mean / 215 mid** at 0.377 delivered light), and **#221** (open: `drawLightGlow` has no altitude term, so a lamp standing on the band *above* a pit paints that pit — #222's `alt` row records the worst sampled pit frame at **183.8 mean / 245 mid** on level 2 and no placement knob moves it; measured here, the same switch costs this pit-floor frame 0.01 luma and this lip frame 0.47, so #221 owns a different camera than the one the white box was quoted from), and **#16** = M5 + M6, per-band light with a glow cue and then a hand-authored two-storey level. **#204 is closed** and its frame is above, its lit-end overshoot half-closed by #222 and now owned by **#221**; **#152 is closed** (`f7d1847`, and `alt` is in the blocking list with a verdict), and this roll is what its output looks like: **nine floor values in one level, 165 of its 572 open cells off the datum** (144 at `MAP.fz` 4, 15 at −4, one cell at each of ±1, ±2, ±3), 10 lamps of which three are on bands the budget had left dark. "The stairs draw" and "the level has two floors" remain different sentences, and the pit lamp is the first of these fixes to make the *floor you are standing on* part of the picture.*

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
