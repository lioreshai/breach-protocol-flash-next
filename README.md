# BREACH PROTOCOL — browser FPS, zero dependencies

**Run it:** double-click `index.html` (or drag it into a browser window). No server, no build, no
internet, no assets — geometry, textures, sprites and sound are all generated at boot.
[Live site](https://lioreshai.github.io/breach-protocol-flash-next/) ·
[issues](https://github.com/lioreshai/breach-protocol-flash-next/issues) ·
[`docs/`](docs/README.md)

| file | what is in it |
|---|---|
| `index.html` | click this |
| `js/00_core.js` | utils, canvas, state, synthesized audio |
| `js/05_paint.js` | software rasteriser + the noise/SDF kit every asset is painted with |
| `js/10_assets.js` | material baker: albedo → normals → cavity AO → light, per texture |
| `js/11_rig.js` | the RIG sheets and pose cache — the bodies that ship are in `js/13_mesh.js` |
| `js/12_sprites.js` | props and decals, painted per frame from primitives |
| `js/13_mesh.js` | the bodies that ship: enemies and the first-person model |
| `js/20_level.js` | room/corridor generator, height grid, RGB lightmap, decals, occupancy |
| `js/30_entities.js` | weapons, player, enemy AI, projectiles, particles |
| `js/40_render.js` | software raycaster, post FX, 2D overlay/HUD |
| `js/50_ui_input.js` | menus, pointer lock, input, main loop |
| `js/90_dev.js` | the `?dev=1` console — inert without the flag |
| `tools/` | `smoke.js` pass/fail, `view.js` instruments, `recap.js` capture gate, `png.js` PNG writer |

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
| `F4` | cycle quality: PERFORMANCE / BALANCED / ULTRA (`QUAL` in `js/40_render.js`) |

## The game
Three procedurally generated sectors — ARCHIVE SUBLEVEL, RING TRANSPORT, ABATOIR CORE — and one
hand-authored level, THE STACK. Clear every hostile in a sector, the exit portal opens, then find it.
Kills can drop health/ammo, barrels detonate when shot, headshots count double-plus, and difficulty
moves enemy damage, health and count. Levels are multi-storey: staircases, ramps, ladders and pits are
walked, and a deck above you is a surface you can see the underside of.

## How it looks

Eight frames, captured from the deployed build; any merged PR that changes the picture re-takes the
frames it moved. Which build, seed and route drew each one is one row per file in
[`docs/screens/provenance.json`](docs/screens/provenance.json) — this page does not restate it, because
a byte claim written here is false by the next merge (#395). What changed between two recaptures is in
the PR that moved it, not here.

`node tools/recap.js check` decodes the eight PNGs and fails if any number below disagrees with the
bytes, so a caption cannot drift from its frame. All eight were taken in one pass off the
deployed page at build `5d08c12`, and the frames decode to **59.83 / 68.76 / 59.78 / 47.66 / 70.95 / 64.95 / 74.26 / 71.88** mean luma
(`0.2126 R + 0.7152 G + 0.0722 B`, the rule `DEV.lum` uses), in the order they appear below. A **dark
row** is one whose own mean luma is under 24 — the threshold the tool measures at, whatever number a
sentence labels. The same command hashes the four blobs that draw a frame (`index.html`,
`js/10_assets.js`, `js/20_level.js`, `js/40_render.js`) against the digests recorded for the bound
build and prints `SHIP-BIND` when they are this tree's bytes or `FRAME-STALE` naming the blob that
moved; on a tree whose shipped bytes have moved since the shutter, as here, it reads `FRAME-STALE` for
`5d08c12` and a re-take is owed. Run the command rather than trusting this sentence — that is what the
`CAPTION-VERDICT` row exists to check (#653).

![the spawn seat on a lit datum floor, a crate ahead with one face in shade](docs/screens/level0-spawn.png)

The spawn seat (18.5, 5.5) on a lit datum floor, `floorAt` **1.00** — the exposure the tonal gates are
tuned against. **0 of 763 rows average below luminance 24**, mean 59.83, thirds 52.1 / 55.0 / 72.4.
Look at the crate: its two visible faces are no longer one value, and its paint sits at the room's own
brightness instead of a near-white card (#371, #476, #491). The deck under the crosshair is the
near-field anisotropic fetch, so it reads as grain rather than texel steps (#467).

![four risers up to the raised band, in air that is dim rather than black](docs/screens/level0-facing-wall.png)

Four risers in five cells, seen from the tread below at (1.5, 8.5), `floorAt` **0.00**, heading π/2.
**0 of 763 rows average below luminance 24**, mean 68.76, band means 65.4 / 74.8 / 66.1. The air over
the treads is dim rather than empty, and the risers read because their own faces are lit at different
values (#371, #431). No level has an overlook you can look *up* into yet — volume is authored room by
room and a stairwell is not a room (#353, [`docs/VERTICALITY.md`](docs/VERTICALITY.md)).

![one posed grunt, 6 m out, on the camera's own band, lit on one side](docs/screens/level0-enemies.png)

One grunt 6 m out on the camera's own band: the spawn seat, then `DEV.clear()` and
`DEV.spawn('grunt', 1, 6)`, `e.anim` pinned to **0** so it is a rest pose and not a stride — which is
why the HUD reads **1 LEFT**. **0 of 763 rows average below luminance 24** (19 under 34, in a 19-row run
from row 301), mean 59.78, thirds 52.1 / 54.9 / 72.4. The side turned toward the lamp reads brighter
than the side turned away because the face term carries a body's whole light, ambient included (#371);
whether a body separates from the paint behind it at combat range is what `node tools/view.js contrast`
prices (#416).

![the pit lip from 2.5 m out, with the far half of the room fallen away under the tool's softer bar](docs/screens/level0-props.png)

The recorded lip pose, 2.5 m out — camera **(20.5, 11.5)**, yaw **π/2**, feet on `floorAt` **1.00**, HUD
**8 LEFT** because this pose was shot off its own fresh page load. **0 of 763 rows average below luminance 24**,
mean 47.66, band means 51.1 / 37.3 / 54.6; at the tool's other bar of 34 this is the page's largest dark
block, 144 rows with a 141-row run from row 255 — a lamp's pool and a lighter patch of floor hold the
middle of the frame while everything past them falls under the bar. The lip's edge is the lit line
crossing the bottom.

![standing on the deck where this deal's hole is not, a pier close on the left and a crate filling the right](docs/screens/level0-pitfloor.png)

The same recorded pose — (19.5, 14.5), heading **atan2(2, 1) = 1.11 rad**, feet on `floorAt` **0.00** —
in whatever room this seed deals. Frame mean **70.95**, **0 of 763 rows average below luminance 24** and
no rows under 34 at all, top band 63.0 against a middle third of 73.8. What crosses the middle of the
frame is the underside of a floor above this one, which is what the room-height passes put into the
generator's own rooms (#548, #421).

![the authored two-storey level from its own spawn seat](docs/screens/level3-stack.png)

**THE STACK**, the hand-authored level, from its own spawn seat: (1.5, 2.5) on the datum, heading 0.60,
4 hostiles left. **0 of 763 rows average below luminance 24**, mean 64.95, thirds 53.8 / 75.4 / 65.7.
A wall you can shoot at, with a lit floor above its top edge that you cannot shoot at, and the seam is
carried by the surfaces themselves — ashlar blockwork over flagstone — rather than by a light gradient,
so a lip reads as a lip at any distance (#428). The stepped glyphs on the minimap are the climb. Whether
this seat is genuinely under a second storey is a `tools/view.js volume` claim (#353).

![ABATOIR CORE from its arrival seat: the slab over the room fills the top of the frame](docs/screens/level2-abatoir.png)

**ABATOIR CORE**, the room with the most ceiling in the game, from its own arrival seat (24.5, 7.5) on
the datum, heading 0.60, 18 hostiles left. **0 of 763 rows average below luminance 24**, mean 74.26,
thirds 63.7 / 67.5 / 91.6 — the slab over the room is still the largest surface in frame and the darkest
thing on it, and the crates on the deck sit nearer their room's own value than any earlier frame here.
This frame and the next are one page load at two headings, because the two rows of one level have to name
one deal. `tools/view.js surface` prices the ceiling share and the slab-to-deck ratio; the frame only
shows the split.

![the same seat tilted up at the ceiling and what hangs from it](docs/screens/level2-abatoir-ceiling.png)

The same seat on the same deal, turned 1.15 rad right and pitched up 194 px
(`DEV.cam(P.x, P.y, undefined, -0.5539, 194.07)`) so the nearest fitting lands on the crosshair.
**0 of 763 rows average below luminance 24**, with 15 under 34 in an 8-row run from row 740, mean 71.88,
thirds 79.6 / 90.3 / 45.7. The frame carries the rod, the lit panel and a band of wall behind them
rather than the fitting and the room end to end: a ceiling that near is only drawn from about twice the
eye height in metres out, so height reads as a gap instead of something you discover by walking into it
(#413).

## How it works
* **Renderer** — software raycaster (Wolfenstein-style DDA) into an `ImageData`'s `Uint32Array` at
  ~0.5× resolution, upscaled to the window. Light, fog and tint are computed once per column, so each
  pixel costs one texture read, a few multiplies and a clamp.
* **Height** — a quantized per-cell grid (`ZQ = 0.25`), one playable band per column. The ground pass
  solves each pixel against the plane of the cell its own ray lands in, and collapses to the flat
  arithmetic bit for bit on a level with no altitude. Design:
  [`docs/VERTICALITY.md`](docs/VERTICALITY.md).
* **Billboards** (props, pickups, projectiles, portal) are depth-tested per pixel against what the
  ground and wall passes wrote, and alpha blended, so they are occluded correctly by walls and by the
  bodies in `js/13_mesh.js`, which write into the same depth. They get a small distance-based fill
  light, so an unlit prop is still a readable silhouette.
* **Pitch** is a screen shear, converted to a ray slope (`aimPx / BH`) for hit maths, so aiming at legs
  or heads agrees with the hit test. Recoil is a separate term that settles on its own and never pulls
  your vertical aim back to level.
* **Hitscan** is analytic (ray vs. enemy cylinder) rather than marched, so a shotgun blast costs almost
  nothing. A riser is a drawn face, not a solid cell, so it reports as a wall hit.
* **Levels** are rooms + L-corridors with flood-fill validation: unreachable space is rejected and
  spawns are nudged onto reachable cells, so a sector cannot become unwinnable.
* **Enemies** are state machines (sleep → chase → windup → melee/ranged) with line of sight,
  last-known-position tracking, wall sliding, side-stepping and separation steering. They cross bands
  where a staircase, ramp or ladder lets them, and not where it does not.
* **Audio** is pure WebAudio: filtered noise bursts and oscillator sweeps, stereo-panned by the angle
  to the source, over an ambient drone bed that thickens as you take damage.

## Tuning knobs
`js/00_core.js` → `cfg` (FOV, eye height, mouse sens), `js/30_entities.js` → `WEAPONS` / `ETYPE`
(damage, fire rate, enemy stats), `js/20_level.js` → `LEVELS` (map size, room count, spawn tables,
`amb`, `lampCol`, `fogCol`). Quality presets are the `QUAL` table in `js/40_render.js`.
`LEVELS[].rooms` is a target, not a promise — the placement loop keeps whatever it fits, so expect 4-6
rooms on any sector.

## Driving the game from a console (dev mode)
Append **`?dev=1`** and the game boots itself — no click, no pointer lock — and publishes one global,
`DEV`. Without the flag `js/90_dev.js` returns immediately: no globals, no wrappers, no behaviour
change, so the flag cannot leak into normal play. `DEV.help()` prints the list.

Append **`&seed=<int>`** too and the boot becomes reproducible (#166): the dev file installs the game's
own `mulberry` generator over `Math.random` before the deal, so one URL deals one level per build. With
no `seed` parameter `Math.random` is not touched at all. `&seed=` and `#seed=` parse the same way.

| Call | What it does |
|---|---|
| `DEV.boot()` | Start the run through the deploy button's own code path. |
| `DEV.cam(x, y[, z, ang, pitch])` | Park camera and player. `ang` is `P.ang` (radians, +x is 0). Rejects NaN; a position inside a solid cell is snapped out. |
| `DEV.look(dAng[, dPitch])` | Rotate in place. Never feeds `mouse.dx`, so it cannot walk the player into the void. `dPitch` is in **pixels**. |
| `DEV.face([enemy])`, `DEV.nearestEnemy()` | Aim at the nearest living enemy, or a given one. |
| `DEV.freeze([bool])` | Stop `update()` and pin the clock; rendering continues, so two screenshots of "the same frame" really match. |
| `DEV.tick([n])` | Exactly `n` update+render frames at `dt = 1/60`, no vsync. |
| `DEV.spawn(kind[, n, dist])`, `DEV.clear()` | Place `grunt\|hound\|brute` in a deterministic fan `dist` metres ahead — a target blocked by a wall steps sideways before it steps nearer, and no two bodies share a cell, so `n` bodies are `n` bodies in the frame. Returns `cells`, `collapsed`, `sep`, `placed[{x,y,cell,d,why}]`. |
| `DEV.set(name, value)` | Runtime overrides of the quality tier (`res, bloom, grade, grain, far, glow, rigH, rast, dmax, scan, vec, min, max`). |
| `DEV.tiers()` / `DEV.stats()` | The `QUAL` table as it stands; frame ms (`n/med/p95/last`), fps, buffer, draw calls, poses rasterised. |
| `DEV.state()` | JSON-safe snapshot: player (heading under `ang`), level, enemies, counts, `S` flags — plus `seed` (the uint32 pinning this deal, `null` if the URL named none) and `layout`. |
| `DEV.layoutSig()` | FNV-1a over `MAP.fz` then `MAP.cell`: the level's identity. Two boots of one seeded URL must agree and two unseeded boots must not. |
| `DEV.ray(x, y[, z], dx, dy, dz[, maxD])` | Step the real DDA and report the first wall: distance, cell, face. |

```
DEV.boot(); DEV.cam(4.5, 4.5, undefined, 0.6); DEV.freeze(true); DEV.tick(30)
DEV.spawn('brute', 1, 2); DEV.face(); JSON.stringify(DEV.stats())
DEV.ray(P.x, P.y, 0.5, Math.cos(P.ang), Math.sin(P.ang))   // is that wall actually there?
```

Four things about that API that are not what they look like:

- **Aiming by console needs `mouse.down` too** — the look step is gated on `S.locked || mouse.down`
  (`js/30_entities.js:326`) and `?dev=1` never holds pointer lock.
- **`DEV.ray` takes a vector.** `DEV.ray(0, 1.2)` is not "pitch this ray up", it is a DDA starting *at
  cell (0, 1.2)* — and it agrees with `hitscan`, so it cannot falsify it.
- **`P.pitch` is in pixels**, clamped to `±BH * 0.62`: it reads 222.58 where the shot's slope is 0.628.
  Quote `pitchTan()` when a number has to mean slope.
- **`DEV.set('rim', false)` is a dead switch** — nothing in the draw path calls `RIG` any more, so it
  moves no pixel. Use `TINT=k` to A/B body shading.

## Judging the picture without a browser
`node tools/view.js <mode>` renders headlessly through the same code paths with no canvas pixel access
(the stub throws on `getImageData`, so assets cannot accidentally depend on one). `node tools/smoke.js`
is the pass/fail harness; `VERT=1` adds the vertical lane; `node tools/roster.js` replays every
invocation `ci.yml`'s blocking steps run. The catalogue, which modes gate and which only print, and the
timing discipline are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). The common ones:

| mode | what it tells you |
|---|---|
| `sheets`, `stats` | every material and sprite in one PNG; per-texture mean, deviation, gradient, coverage, blown pixels |
| `exposure` | mean luminance over levels × seeds × view angles, as **medians of seeded rolls**, with recorded rows |
| `scene <level> [cam]` | one frame as a PNG plus its luminance stats; `WARM=1` turns the camera |
| `alt`, `heights`, `cull`, `sight`, `drop`, `planes`, `decal` | the vertical suite — bands, planes, occlusion, climbs, mark windows |
| `contrast`, `bands`, `mip`, `volume`, `surface` | legibility: silhouette vs background, band contrast, streaking, authored air, value order between surfaces |

Two warnings that apply to every brightness number. A level lays itself out with `Math.random`, so one
seeded roll at one fixed pose is a *view class*, not a property of the level — 21 to 137 composited mean
across five spawn frames of one level (#155) — which is why both brightness assertions read the median of
seeded rolls and print the rolls. And a seed names a deal *within* one environment: the browser's seed
12345 folds to 2229721315 and the node harness's to 3367779095, so quote the environment beside the seed.

## Notes
* Chrome/Safari/Firefox all fine. Mouse look needs pointer lock, granted on the first click — that click
  does not also fire your weapon.
* On a hidpi display the renderer caps device pixel ratio at 1.5 and renders at ~34-62% window height
  depending on the preset, which keeps it at 60 fps on integrated graphics.
* Boot spends ~1.6 s baking materials and characters, once, before the menu draws.
* Crates and barrels are decoration, not cover — nothing but walls is solid, so sprites never block
  movement or line of sight.
* `T` toggles sound and prints AUDIO ON / AUDIO MUTED, which is how you tell a muted game from a broken
  one. A throwing `AudioNode` call disables sound and closes the context rather than propagating, because
  an exception in `frame()` used to abort before `renderWorld()` and leave the simulation stepping behind
  a still picture.

## Extending it
* **A material**: add an entry to the material list in `js/10_assets.js` and paint it with the `Surf`
  primitives from `js/05_paint.js`. Levels pick wall textures through `pickWallTex`; floor and ceiling
  variants are indexed by the same ids. Never read canvas pixels.
* **A prop**: paint it into `PROP` in `js/12_sprites.js`. Billboards are drawn, filtered and occluded
  for free.
* **An enemy species**: add an `ETYPE` row (speed, `stride`, `gait`, scale, hitbox height) plus its
  geometry in `js/13_mesh.js`. Rig units are fractions of body height so hitboxes and geometry cannot
  drift apart, and gait phase advances with *distance travelled* so a planted foot never slides.
* **A quality knob**: add the field to every row of `QUAL` and read it once in `setGfx`, or in the shader
  that owns it. Never branch on the preset index inside a pixel loop.
* **Verify** with `node tools/roster.js` — it replays every invocation `ci.yml`'s blocking steps run —
  and with the live page, which is the source of truth for anything you can see.

## Where things live
* [`AGENTS.md`](AGENTS.md) — the working agreement: what to run before committing, and how a check earns
  trust.
* [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — the harnesses, the probe catalogue, and what each
  instrument cannot see.
* [`docs/ENGINEERING.md`](docs/ENGINEERING.md) — traps already paid for, each with the measurement that
  found it. Read this before debugging anything the renderer is involved in.
* [`docs/VERTICALITY.md`](docs/VERTICALITY.md) — the height-grid design and why it was chosen that way.
* [`docs/ROADMAP.md`](docs/ROADMAP.md) — direction and the priority rubric. Not status.
* [`docs/RELEASE.md`](docs/RELEASE.md) — when a version ships and the steps that make one.
* [Issues](https://github.com/lioreshai/breach-protocol-flash-next/issues) — backlog, bugs and
  milestones. A PR body names its issue with `Closes #N` **as plain text**; a bare `#N` links and never
  closes, and a keyword inside backticks links nothing while the `issue` check stays green.
