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
moves enemy damage, health and count.

## How it looks

Captured from the deployed build and refreshed by any merged PR that changes the picture. Which build
drew each frame, at what seed and by what route, is one row per file in
[`docs/screens/provenance.json`](docs/screens/provenance.json) — this page does not restate it, because
a byte claim written here is false by the next merge (#395). What *changed* between two recaptures is
in the PR that moved it, not here.

`node tools/recap.js check` decodes the eight PNGs and fails if any number below disagrees with the
bytes, so a caption cannot drift from its frame. The eight frames decode to **63.98 / 20.87 / 63.93 / 47.81 / 68.50 / 64.98 / 64.56 / 72.01** mean luma
(`0.2126 R + 0.7152 G + 0.0722 B`, the rule `DEV.lum` uses), in the order they appear below. A dark
row below means a row whose own mean luma is under 24 — the threshold the tool measures at, whatever
number a sentence labels.

Three of these eight frames are still drawn at build `ce9d39d`, two at the build that was deployed when
their pixels were taken, one at `a61b540` and two at `dac241d`; the build that drew each one is named per
file in `provenance.json`, and the deployed page moves past them all. Treat every frame as what its own
caption's build drew, not as a screenshot of today's deploy (#395, #431). Opening a frame's recorded URL does
re-deal that frame's level — the page installs the seeded dice itself at `?dev=1&seed=` (`js/90_dev.js:26`) —
so a re-take is one page load with one boot, never a second `DEV.boot()` inside the same load
(`js/90_dev.js:21-22`). What ages a frame is the build named in its row: the generator draws a different count
between builds, so today's deploy deals those URLs a different deal. What that does to a frame is not one
thing. Where a caption's claim is *geometry*, the re-take is a digit refresh: the two frames re-taken for
#431 sit on a deal with the same spawn seat, the same 3 × 3 pit at `MAP.fz` -4 and the same five-cell flight,
so only the means and the lamp positions moved. Where a caption's claim is about *darkness* it is a rewrite:
the three frames still at `ce9d39d` count rows that today's build does not leave dark at all (488 rows under
24 at that build's stairwell, 0 at this one, at the same coordinates), and a frame of that stairwell is a
different picture with a different point to make. `node tools/recap.js check` prints and counts the rows
labelled stale-by-build.

![the spawn seat on a lit datum floor](docs/screens/level0-spawn.png)

The spawn seat (18.5, 5.5) on a lit datum floor: **0 of 763 rows average below luminance 24** — no dark
band left to count, thirds 51.5 / 64.2 / 76.3. This is the exposure the tonal gates are tuned against.
The light is the cell's own ambient (`MAP.light` 0.831 at (18,5)); no lamp is in frame, and the drum
centre-frame is a red barrel 5 m out. The seat's own column carries four units of authored air above
it, so this is the first place the ground pass's per-row ceiling term is allowed to do anything — it is
exactly 0 while a plane solves within 3.0 of the eye, which is every pixel of a one-unit level.

![four risers up to the raised band, and the black air above them](docs/screens/level0-facing-wall.png)

Four risers in five cells: the flight at (1, 9) steps `MAP.fz` **0, 1, 2, 3, 4** up to (1, 13), three of
those cells flagged `MAP.feat` STAIR, seen from the tread below at (1.5, 8.5). **488 of 763 rows average under luminance 24 and the longest unbroken run is 277 rows, starting at row 0**
(mean 20.87, band means 9.5 / 32.1 / 21.0). The lit treads stepping up to a floor one band higher are
real; the black air over
them is the absence of a lamp, not the absence of a ceiling — the camera's own cell reads `MAP.light`
0.02 while the band two cells away runs 0.26 → 1.20 because two lamps stand on it. Volume is authored
room by room, and a stairwell is not a room: no level has an overlook you can look *up* into yet
(#353, [`docs/VERTICALITY.md`](docs/VERTICALITY.md)).

![one posed grunt, 6 m out, on the camera's own band](docs/screens/level0-enemies.png)

One grunt 6 m out on the camera's own band — the spawn seat, then `DEV.clear()` and
`DEV.spawn('grunt', 1, 6)` (`kind, n, dist`), which is why the HUD reads **1 LEFT**. He lands at
(23.45, 8.89) on `MAP.fz` 0 like the camera, in a cell reading `MAP.light` 0.422, with `e.anim` pinned
to **0**: rest pose, not a stride (`view.js anim` gates motion). **0 of 763 rows average below luminance 24**
here, thirds 51.4 / 64.1 / 76.3. Bodies are meshes from `js/13_mesh.js`; whether one
reads against the paint behind it at combat range is what `node tools/view.js contrast` prices (#416).

![the pit lip from 2.5 m out, lit by a lamp standing in the pit](docs/screens/level0-props.png)

The pit lip from 2.5 m out — camera **(20.5, 11.5)**, yaw **π/2**, feet on the datum, the lip plane
exactly 2.50 m ahead. **307 of 763 rows average under luminance 24 and the longest unbroken run is 251 rows from row 32**
(mean 47.81). The hole is the 3×3 block (19..21, 14..16) at `MAP.fz` **-4** with its
own ceiling at one unit, so a pit inside air the tall-air feature made tall stays a pit under a lip
instead of becoming a shaft; the lamp standing in it at (20.5, 16.5) is on band **-1.00**, 5 m from this
camera. The pool of light is that lamp's own band, and the lip is lit by the lane.

![standing in the hole, two cells from the lamp that lights it, on the band the glow refuses](docs/screens/level0-pitfloor.png)

Standing in the hole at (19.5, 14.5), heading **atan2(2, 1) = 1.11 rad** so the lamp sits on the
crosshair: feet on **floor −1.00**, own ceiling **0.00**, `MAP.light` **0.23** — under a third of the
spawn seat's, and yet the frame mean is **68.50**, the brightest of the six. **201 of 763 rows average under luminance 24
and the longest unbroken run is 175 rows from row 31**: this is a lamp working from inside the band it
refuses from above.

![the authored two-storey level from its own spawn seat](docs/screens/level3-stack.png)

**THE STACK**, the hand-authored level, from its spawn seat: (1.5, 2.5) on the datum, heading 0.60, 4
hostiles left, and **0 of 763 rows average below luminance 24** (mean 64.98, thirds 45.6 / 74.2 / 75.2;
at the tool's other bar, 47 rows under 34, longest run 42 from row 260). The seat's own cell carries a
ceiling at **1.00** — you are under the slab — and seven cells along the heading the plan opens into an
atrium whose ceiling solves at **4.00** over `floor 0.00`. What crosses the middle of the frame is the
wall of the room the seat opens into, with the atrium's lit floor visible above its top edge: a surface
you cannot shoot at, over a wall you can. That edge is carried by the surfaces themselves rather than by
the light on them — rectified ashlar blockwork with incised joints and tie holes over flagstone and moss
— so a lip reads as a lip at any distance, in bright light or dim, and not only where a lamp happens to
graze it (#428). The vault is still the darkest large surface in the frame: its band runs 45.6 against
the deck's 75.2, and this is the first frame of this seat where that gap is the *surfaces* talking — the
blockwork and the flagstone are different materials, and the deck no longer out-lights the roof over it
because the finale's floor stops burning past the picture it is lit for (#369). The stepped glyphs on
the minimap are the staircase that gets you up there. Hand-authoring removes the seed excuse — this plan
is written cell by cell over a 20 × 20 grid — and it also shows what is still missing:
`tools/view.js volume` reports this seat's headroom as `1.00..1.00`, so the level is genuinely two-storey
in `MAP.fz` and still reads as a low room with a bright slit in it (#353). Against the frame this one
replaces the whole move is the floor: mean 66.75 → 64.98, bottom third 78.7 → 75.2, middle 76.1 → 74.2,
and the top third unchanged at 45.6; the wall did not move, because the wall moved in the previous
re-take, the one that also took this seat from 50.14 to 66.75 when the room gained visible ceiling
fittings.

![ABATOIR CORE from its arrival seat: the slab over the room fills the top of the frame](docs/screens/level2-abatoir.png)

**ABATOIR CORE**, the room with the most ceiling in the game, from its own arrival seat (18.5, 23.5)
on the datum, heading 0.60, 18 hostiles left: **0 of 763 rows average below luminance 24** (mean 64.56,
thirds 48.2 / 73.6 / 71.9). The top third of this frame reads **48.2** and the bottom **71.9**, and that
split is the whole story of the ceiling: the slab is the largest surface the player sees and the darkest
one on it. `tools/view.js surface` puts this level's ceiling at **47 % of the frame** against a floor at
38 %, and the deck it looks down on is lit 1.9x brighter than the slab it looks up at.

![the same seat turned to the fitting hung over the entrance, 3 m ahead](docs/screens/level2-abatoir-ceiling.png)

The same seat on the same deal, turned 0.556 rad right and pitched up 25 px, which is where this deal
puts a fitting over the entrance: **0 of 763 rows average below luminance 24** (mean 72.01, thirds
66.9 / 70.3 / 78.8). Six fittings are hung over this room's circulation; the one in frame is 3.06 m
from the seat with its lens let down to **2.35 m** under a slab authored at **4.00 m**. What the frame
carries is the rod and the lit panel on it, and the empty band above them is the room's height: the slab
those fittings bolt through sits above this frame's top row, because the frame can only draw a ceiling
that near from about twice its headroom in metres out (#413). So the height reads as a gap rather than as
three parts of one object you can see end to end, and it stops being something you discover by walking
into it. The left third of the frame is the doorway wall the seat stands in, 1 m away — the player sees it
when they turn, so it stays in the shot.

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

Four things that each cost a verification pass:

- **Aiming by console needs `mouse.down` too** — `update()`'s look step is gated on
  `S.locked || mouse.down` (`js/30_entities.js:326`) and `?dev=1` never holds pointer lock.
- **`DEV.ray` takes a vector.** `DEV.ray(0, 1.2)` reads as "pitch this ray up" and is a DDA starting
  *at cell (0, 1.2)*: an answer that agrees with whatever `hitscan` says, so it cannot be falsified.
- **`P.pitch` is in pixels**, clamped to `±BH * 0.62` and converted by `pitchTan()` — it reads 222.58
  where the shot's slope is 0.628. Quote `pitchTan()` when a number has to mean slope.
- **`DEV.set('rim', false)` is a dead switch.** Bodies became meshes in #72 and nothing in the draw path
  calls `RIG`, so it moves no pixel. Use `TINT=k` to A/B body shading.

## Judging the picture without a browser
`node tools/view.js <mode>` renders headlessly through the same code paths with no canvas pixel access
(the stub throws on `getImageData`, so assets cannot accidentally depend on one). `node tools/smoke.js`
is the pass/fail harness; `VERT=1` adds the vertical lane. The catalogue, which modes gate and which
only print, and the timing discipline are in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). The common ones:

| mode | what it tells you |
|---|---|
| `sheets`, `stats` | every material and sprite in one PNG; per-texture mean, deviation, gradient, coverage, blown pixels |
| `exposure` | mean luminance over levels × seeds × view angles, as **medians of seeded rolls**, with recorded rows |
| `scene <level> [cam]` | one frame as a PNG plus its luminance stats; `WARM=1` turns the camera |
| `alt`, `heights`, `cull`, `sight`, `drop`, `planes`, `decal` | the vertical suite — bands, planes, occlusion, climbs, mark windows |
| `contrast`, `bands`, `mip`, `volume`, `surface` | legibility: silhouette vs background, band contrast, streaking, authored air, value order between surfaces |

One warning that applies to every brightness number: a level lays itself out with `Math.random`, so one
seeded roll at one fixed pose is a *view class*, not a property of the level — measured 21 to 137
composited mean across five spawn frames of one level (#155). Both brightness assertions therefore read
the median of seeded rolls and print the rolls. A seed names a deal *within* one environment: the
browser's seed 12345 folds to 2229721315 and the node harness's to 3367779095, because the two consume
different numbers of draws before generation. Quote the environment beside the seed.

## How work is tracked
Backlog, bugs and milestones are
[GitHub issues](https://github.com/lioreshai/breach-protocol-flash-next/issues), not lines in a markdown
file — an issue can be linked from the commit that closes it and a paragraph cannot.

* A PR body names its issue with `Closes #N` (or `Fixes #N`) **as plain text**. The keyword is required:
  on a squash merge a bare `#13` links the issue and leaves it open forever. `[no-issue]` is the opt-out.
* Feature PRs leave `CHANGELOG.md`, `release.json` and `release-policy.json` at main's contents; the
  product lead writes player-facing notes only in a `release/vX.Y.Z` PR
  ([`docs/RELEASE.md`](docs/RELEASE.md)).
* [`docs/ROADMAP.md`](docs/ROADMAP.md) keeps direction and the priority rubric. Status questions go to
  the tracker.

## Notes
* Chrome/Safari/Firefox all fine. Mouse look needs pointer lock, granted on the first click — that click
  does not also fire your weapon.
* On a hidpi display the renderer caps device pixel ratio at 1.5 and renders at ~34-62% window height
  depending on the preset, which keeps it at 60 fps on integrated graphics.
* Boot spends ~1.6 s baking materials and characters, once, before the menu draws.
* Crates and barrels are decoration, not cover — nothing but walls is solid, so sprites never block
  movement or line of sight.
* `T` toggles sound and prints AUDIO ON / AUDIO MUTED, which is how you tell a muted game from a broken
  one. A throwing `AudioNode` call disables sound and closes the context rather than propagating: an
  exception in `frame()` used to abort before `renderWorld()`, leaving the simulation stepping behind a
  still picture.

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

Working here? [`AGENTS.md`](AGENTS.md) is the working agreement,
[`docs/ENGINEERING.md`](docs/ENGINEERING.md) is the list of traps already paid for, and
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) says what each probe can and cannot see.
