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

Captured from the deployed build, not from a mockup or an old build: [live site](https://lioreshai.github.io/breach-protocol-flash-next/). These are refreshed whenever a merged PR changes what the game looks like, and this build changes it more than most: **#196** made a one-quantum step draw a **face** (#192's three causes — the wall DDA emitted a riser only when `|dq| > 1` while the generator authors stair treads at *exactly* one quantum, risers wore `MAP.floorTex`, and no floor-half lookup would answer a plane above the eye unless the raise happened to equal `CZ_DEF`). Byte parity was re-checked at commit time rather than assumed: each of the 10 `js/` subresources was fetched from the Pages host with a cache-buster and md5-compared against the working tree — **10/10 equal**, `js/40_render.js` = `f6f745e201421fc96302e4b5f3166c5f` — and the new marker `function slabT(` counts **1** in the deployed copy, **1** in `origin/main`'s and **0** in `origin/main~1`'s, which is what rules out the Pages cache serving the previous build. The four shots come from a **single boot** of that build at the default seed and quality BALANCED (canvas **1202×676**, horizon row **338**, eye **0.50**), and the map is never regenerated between them — `DEV.cam` only, no `startLevel`. Two honesty notes about the numbers below, both learned the expensive way in this repo: nothing seated `P.hp` at these poses, so **vitals read 58** and the damage vignette (#85 measured it at about −21) is *inside* every mean here; and the means are sampled from the **composited canvas** after `DEV.tick(1)` with Rec.601 weights, which is the same layer `DEV.lum` reads but is **not** a PNG decode — #190 measured a decode reading about 6 points low on all four poses, so a file re-derived by a reader will disagree with these figures by single digits in a predictable direction. `node tools/view.js` numbers are a different layer again (pre-bloom raster) and are never mixed into a sentence with these.

This roll deals a 26×26 Archive Sublevel with **510 of 676 cells on the datum**, **144 at `MAP.fz` 4** plus the quanta **1, 2, 3 in one cell each** (a stair up), **16 at `MAP.fz` −4** plus **−1, −2, −3** in one cell each (the sunken block and a stair down), and `MAP.cz` **12 — three units of headroom — in 59 columns** and 4 in the rest. Generation draws no random numbers for those features, but the **room list is rolled per boot** and `startLevel` calls `genLevel` unconditionally, so a reset deals a new map: these captions are comparable to each other and to nothing else — **#87** measured the seeded spread at 18 to 70 points, wider than any difference quoted here, and **#139** was opened on exactly that non-comparison.

![spawn corridor](docs/screens/level0-spawn.png)

*The boot's own spawn seat, **(6.5, 8.5)** — read off `P.x`/`P.y` rather than reconstructed from `MAP.rooms` — turned to yaw **π/2**, pitch 0, feet on the datum so the eye sits at 0.50. **Composited mean 96.4, min 7, max 253.** This is the reference frame for the other three: it is the only pose here that is both on the datum and lit, and the two that are on a lip read 25.6 and 19.7, which is #197. The rifle at lower right is rasterized geometry composited inside `renderWorld()` (#185's shipped half), depth-tested against a swapped scratch array rather than the frame's `zbuf` (#180); what is wrong with it is its **look and proportion**, which #180 owns. The radial grain across the ceiling near the horizon is the 4:1 anisotropy clamp chosen to keep the floor's grout lines (#57) and is known.*

![the flight of five treads](docs/screens/level0-facing-wall.png)

*Camera **(6.5, 1.5)**, yaw **0**, feet on the datum. This is the staircase `tools/view.js cull` puts its own probe camera in front of: **five treads, five cells, each one quantum up**, so the lip is at **+0.25 m** — the exact configuration #192 left as a multiply over nothing, because `dq > 1 || dq < -1` never fired for a stair the generator actually authors. What the frame shows is the fix and the remaining defect at once. The risers are **there**, in wall material rather than the floor's, which is why they are legible as edges and not as a brighter patch of the same carpet; but the flight reads as **dark slats with the far room visible between them**, and the frame averages **25.6 (min 0)** where the pose above averages 96.4. That second half is not #195, which counts luminance *contrast across one lip* (76 / 26 / 12 % against a 45 % bar): here the quantity is **how little light a camera standing at a step receives at all**, and no row in `bands` or `exposure` compares a lip camera's mean against the spawn camera's. Filed as **#197**, numbers in its body, with the likeliest cause named there — light is still **one value per column**, so a tread top one quantum up is lit by whichever column the solver happens to land in, which is M5's (#16) missing per-band term seen from below.*

![the nearest hostile](docs/screens/level0-enemies.png)

*Back at the spawn seat, turned to face the closest living hostile the sim dealt — **7.8 m** away at (7.98, 9.17), `MAP.fz` **0**, i.e. **the same band as the camera** — and the shot averages **89.0 (min 2, max 251)**. Eight hostiles are alive at boot, so this is a walked-in frame rather than a posed one, and it is deliberately *not* an altitude test: a body on the camera's own band is the case nobody disputes. The altitude measurement belongs to the probe, not here — #189's live-page numbers, taken in the previous recapture, were **7,955 px** changed by removing a same-band grunt against **35 px** for each of two grunts on the band above, with a crate in the same cell at the same range changing **0 px**, which is what proved the band bodies are hidden by the **lip's geometry** and not by the enemy draw path forgetting `floorAt`. That is why #189 stays open on its own repro and why this shot says nothing about it either way. The minimap at upper right plots every body in one plane with no altitude cue — also M5 (#16).*

![the pit lip](docs/screens/level0-props.png)

*Camera **(10.5, 14.5)**, yaw **π/2**, feet on the datum, facing the sunken block — `cull`'s pit camera, whose lip is **cell (10, 17) at `MAP.fz` −1, one quantum down**. Two things are visible and both are defects with numbers. The first is what #196 fixed and what this caption exists to record: the lip's riser is a **face** now, in wall material, so the pit edge is a hard lit line across the middle of the frame instead of a hole. The second is everything above it — the upper half of this frame is **unlit black to the top row**, mean **19.7 (min 0)**, and it is the same cause as the staircase above: a tall room's upper half is a long sight to a face, fog is solved with **no `z` term**, and light is **one value per column**, so height buys no light. #196 changed geometry and left that alone, and it is the reason #197 was filed in the session that measured it rather than after. Props are **not** claimed for this frame: the props accessor returned nothing useful at this build (`DEV.stats().decs` read `{}` under `?dev=1`), so prop counts at these cameras are unmeasured, and the previous recapture's numbers were taken on a build whose `DEV.stats()` shape this one changed.*

- *How to reproduce all four: open the site with `?dev=1`, then*
  `DEV.cam(6.5, 8.5, 0.5, Math.PI/2, 0)` · `DEV.cam(6.5, 1.5, 0.5, 0, 0)` ·
  `(function(){var b=ENEMIES.filter(e=>e.hp>0).sort((a,c)=>Math.hypot(a.x-P.x,a.y-P.y)-Math.hypot(c.x-P.x,c.y-P.y))[0];DEV.cam(6.5,8.5,0.5,Math.atan2(b.y-P.y,b.x-P.x),0)})()`, *the nearest living hostile rather than `ENEMIES[0]` — the shot faces whoever is closest, so reproduce it by proximity, not by index.*
  `DEV.cam(10.5, 14.5, 0.5, Math.PI/2, 0)`, *each followed by* `DEV.freeze = true; DEV.tick(1)`.
  *`DEV.cam` takes **five** numbers — `(x, y, z, ang, pitch)` — and passing four leaves the pitch at the
  player's, which is how a "facing east" capture ends up looking at the ceiling.*
- *What #196 did not change is worth stating beside a picture that now has stairs in it: **the generator
  still never authors a walkable band** (#152), so every staircase in a generated level is a flight the
  player can step *up* one quantum at a time rather than a deck with room on it, and the multi-storey
  level the roadmap wants is still authored work (M6, #16). "The stairs draw" and "the level has two
  floors" are different sentences, and only the first one is true of this build.*
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
