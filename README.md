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
bytes, so a caption cannot drift from its frame. The eight frames decode to **70.43 / 50.05 / 70.38 / 65.85 / 63.34 / 69.01 / 76.07 / 77.84** mean luma
(`0.2126 R + 0.7152 G + 0.0722 B`, the rule `DEV.lum` uses), in the order they appear below. A dark
row below means a row whose own mean luma is under 24 — the threshold the tool measures at, whatever
number a sentence labels.

All eight were re-taken in one pass off the deployed page at build `69f6f54`; the pass proved its build off the
wire by sha256-comparing all twelve served blobs against that commit before the shutter, so
every frame below is the picture the page draws, at the build its row names. Whether that is still today's picture is no longer a sentence
that ages: `node tools/recap.js check` hashes the four blobs that draw a frame — `index.html`, `js/10_assets.js`,
`js/20_level.js`, `js/40_render.js` — against the digests recorded for the bound build in
[`docs/screens/provenance.json`](docs/screens/provenance.json), and prints `SHIP-BIND` when this tree's bytes are
those bytes or `FRAME-STALE` naming the blob that moved. A pass aged badly once, binding `bd2441a` while two
render commits landed in review, and the tool exists so it cannot age quietly again; the bind is an upper bound on
"the picture changed", since a comment inside a renderer moves a digest and moves no pixel, so the row names the
blob and leaves the re-take call to a human. On the tree that carries these frames that row reads `SHIP-BIND` for
`69f6f54`: the four blobs that draw a frame are byte-identical here and in the build these eight rows bind, so on this tree the front page is today's picture; the next renderer or level commit turns that row to
`FRAME-STALE` and a re-take is owed again, which is the row's purpose rather than a defect in it. All three of this pass's deals re-rolled, and one of the reasons is the change this re-take was filed for:
the arrival heading became **derived** on the two sectors that do not declare one (#482), so an arriving player is
turned toward the deck the generator laid near the entrance instead of standing at a literal 0.60. The room-height
passes are the other reason — they author height in the generator's own dice, so one seed deals a different sector at
a later build. This pass re-ran the same url at one page load and one boot per level and read every pose back out of
the page that drew it. ARCHIVE SUBLEVEL re-rolled to 3951692944 where its five rows named 1898908958; three of those
five are the deal's own arrival seat and turn therefore carry the derived bearing (**2.1731** at the spawn seat),
while the other two keep their recorded `DEV.cam` coordinates, so what is held constant across them is the *camera*,
not the sector. ABATOIR CORE re-rolled to 513487353 with its seat reading back at (22.5, 13.5), where the frames these
replace named 1425048100 at (24.5, 7.5) — and its heading stayed the authored **0.60**, because this sector DECLARES
`seatAng` (#421 DECISION 1) and arrives the way it always did. THE STACK's hand-written plan re-rolled too, to
3610925125 where its row named 1154765829: the plan is authored, its bearing is not, so its seat turns as well. The
seats are read back, not carried. What is *not* restated here is the interior the old captions quoted — a cell's `MAP.light`, where a lamp or
a barrel was standing, which 3×3 block held the pit — because those describe rooms this seed no longer deals, and a
generated level's deal is pinned only per build (#420).

What moved the picture since the frames these replace: a lamp's deck stops falling to black between its pools
(#199), every room got its own air instead of the largest two alone (#548), the floor a ray arrives at is the floor
that gets drawn (#518), a magnified ceiling pixel pays for the area its texel cannot cover (#19), and the fists stop
wearing the crate's paint (#562) — and, above all, the second room-height pass (#548), which is the author of every
number in the last two paragraphs because it both re-lit the air and re-dealt the sectors. The second author of this
pass's numbers is the derived arrival bearing (#482), and it moved the frames that show a seat rather than a pose.
Per frame against the bytes they replace: ARCHIVE SUBLEVEL's spawn seat +10.60 and its posed grunt +10.60, its
stairwell −18.71, its pit floor −7.61 and its pit lip +18.19. Those five are not five relightings: two of them are one
re-deal seen from unchanged coordinates, two are the same seat turned by the derived bearing, and one is both, which is
why the sign flips with the room the camera lands in and the face it is turned to. THE STACK is +4.06 — a hand-written
plan, the same seat, and a derived bearing that turns it to a different part of the hall. ABATOIR CORE is +1.81 with
its up-tilted twin +5.96, and neither of those is the bearing's doing: this sector declares its heading, so the frames
moved only because **the deal re-rolled** and put a different room behind the same look (#420).

The shipped picture those numbers describe is the one the last pass introduced: a roof that is a lit surface
rather than a black sheet, because the ceiling's light term gained a floor (#495); an enemy's base that reads
against the deck it stands on (#18); a stair that draws its own step faces (#515); the face that caps your deck
wearing the room's own stone (#518); a crate with a surface instead of three flat colours (#533); and the line
where a room stops and its roof start drawn rather than implied (#369).
The deck within a couple of metres is fetched by the anisotropic tap pair (#467), so its near field reads as
continuous grain instead of texel steps. Each row of `provenance.json` still names the deal its frame came from, because what a URL deals
ages by build: the generator draws a different count between builds, so a re-take reloads the frame's own url
- one page load, one boot, never a second `DEV.boot()` inside the same load (`js/90_dev.js:21-22`) - and the
capture plan that makes these eight reproducible is written there, not here. Where a caption counts *darkness*
rather than geometry, the count below is the pass before this one's story told once and kept: the pit floor's 122
rows and THE STACK's 114 under the 34 bar became none at all when the roof was given a light floor (#495), and the
stairwell's 173 became 15 with its 79-row run gone (#431). This pass moved them again, and it moved them by re-dealing
and by turning the seat rather than by re-lighting: **none of the eight frames has a row under the 24 bar at all**, as
on the pass before it. At the tool's other bar six of them do: ABATOIR CORE's arrival seat **56 rows** under 34 in a
56-row run from row 291, the spawn seat and the posed grunt 43 each in the same 43-row run from row 301, the stairwell
25 in a 9-row run from row 743, the pit floor 9 in an 8-row run from row 98 and the pit lip 7 in a 7-row run from row
536. THE STACK and the up-tilted ABATOIR shot count nothing at either bar.

![the arrival seat turned to the deck this deal laid: lit floor and barrels ahead, a dark band of far room across the middle](docs/screens/level0-spawn.png)

The spawn seat (18.5, 5.5) on a lit datum floor — the seat this build's own deal puts you in, read off the
page rather than typed, and this pass for the first time at the bearing the deal turns you to rather than the 0.60 a
caption used to type (**0 of 763 rows average below luminance 24**; 43 rows under the tool's softer 34 bar in a 43-row
run from row 301 - mean 70.43, thirds 69.8 / 63.0 / 78.5). This is the exposure the tonal gates are tuned against, and
it is 10.60 lighter than the frame it replaces for two reasons that are not a relighting: the sector dealt at this seed
is not the one the replaced frame stood in (#548 re-cut the generator's dice), and the heading is no longer the literal
0.60 that row posed but the **2.1731** `seatFacing` derived from this deal's own grid (#421, #482) - the turn this
re-take exists to show. What
the frame still shows is the same shipped picture: a wall face whose two visible faces are no longer one value, and a
roof that is a lit surface over the deck rather than a sheet.
Its two visible faces now sit at different values — the face-orientation term carries its whole light, ambient
included — and its paint sits at the room's own brightness rather than a near-white card (#371, #476, #491).
At a near-tie azimuth the two faces still land close together and the box reads flatter than it should: the
term is per face, not per prop. The seat reads `floorAt` **0.00**, where the replaced frame's seat stood one unit
higher on the same quantized grid - a different band, which is #548 writing height in rooms it used to leave at the
default - so this is the
first place the ground pass's per-row ceiling term is allowed to do anything, and it is exactly 0 while a plane
solves within 3.0 of the eye. The deck under the crosshair is the near field #467 changed: at this range the
footprint is 1-2 texels and the fetch is the anisotropic tap pair, which is why the four streak counts
`view.js mip` prints for the sectors fell when that pair landed. Where a lamp or a prop was standing in the replaced
frame is not restated here: prop placement comes out of the deal, and this seed's deal moved (#420).
Two things the frame does not settle are said plainly rather than cropped out. The dark band across the middle of the
frame is the far half of the room at the eye line, and it reads as a band of shade rather than as a slab with an edge
on it - the underside half of #421, still open. And the seat's own turn is derived from the nearest deck the scan can
reach, so on a deal where that face is far the bearing is deal-dependent; ABATOIR CORE declares its heading for that
reason (#421 DECISION 1) and this sector does not.

![a lip and a fall of deck at the recorded tread pose, in air that is dim rather than black](docs/screens/level0-facing-wall.png)

The recorded tread pose at (1.5, 8.5), heading π/2, feet on `floorAt` **0.00** - the coordinates kept, the sector
re-dealt under them, and this deal puts a lip and a fall in the frame where the replaced caption counted four risers
in five cells. **0 of 763 rows average below luminance 24**
(mean 50.05, band means 45.8 / 57.9 / 46.4; at the tool's other bar, 25 rows under 34 in a 9-row run from row 743,
where the replaced frame carried 24 with a 13-row run of its own).
The air over the lip is dim, not empty, and the faces read apart
because their own orientation carries light (#371, #431). The dark block this caption used to count went with the room
that carried it - 173 rows under 34 became 15 in the pass before last, 18 in the last one, and 25 here, because the
stairwell those rows belonged to is not the room dealt at this seed - and
three shipped changes account for the long fall: the ceiling gained a light floor
(#495) and a stair now draws its own step faces instead of a warped flat deck (#515). Volume is authored room
by room, and a stairwell is not a room: no level has an overlook you can look *up* into yet
(#353, [`docs/VERTICALITY.md`](docs/VERTICALITY.md)).

![one posed grunt, 6 m out, on the camera's own band, lit on one side](docs/screens/level0-enemies.png)

One grunt 6 m out on the camera's own band — the spawn seat, then `DEV.clear()` and
`DEV.spawn('grunt', 1, 6)` (`kind, n, dist`), which is why the HUD reads **1 LEFT**; the load reads one hostile after
the clear-and-spawn, and the camera pose reads back (18.5, 5.5) on `floorAt` 1.00. He lands on the same band as the
camera and the light falls off
across him: the side turned toward the lamp reads brighter than the side turned away, because the face term now
covers a body's whole light, ambient included (#371). He is posed with `e.anim` pinned to **0**: rest pose, not
a stride (`view.js anim` gates motion). **0 of 763 rows average below luminance 24** here — 19 of them under 34, in a
19-row run from row 301 — mean 59.78, thirds
52.1 / 54.9 / 72.4, 1.16 lighter than the frame he replaces because he is standing in a re-dealt room rather than in
the one the replaced row described (#420); his base sits in a contact band that is flatter and deeper than the one he
replaced (#18). Bodies are meshes from `js/13_mesh.js`; whether one
reads against the paint behind it at combat range is what `node tools/view.js contrast` prices (#416), and the
wall behind him in this frame is the repainted one.

![the pit lip from 2.5 m out, its edge lit, with this deal's far half staying above the tool's softer bar](docs/screens/level0-props.png)

The recorded lip pose, 2.5 m out — camera **(20.5, 11.5)**, yaw **π/2**, feet on `floorAt` **1.00** — and ARCHIVE
SUBLEVEL re-rolled under it - and, this time, turned as well: the lip pose is a `DEV.cam` bearing, so the camera keeps
the replaced frame's yaw while the sector beneath it is dealt again. **0 of 763 rows average below luminance 24**, with 7 rows under the tool's
softer 34 bar in a 7-row run from row 536 (mean 65.85, band means 65.0 / 68.9 / 63.7) - the smallest dark block on the
page, where the replaced frame's far half ran 144 rows under that bar in a 141-row run. The frame is 18.19 lighter than
the one it replaces, and the cause is the re-roll rather than a relight: the same coordinates stand in a different
room, whose far half now stays lit past the lip. The lip's own edge is the lit line crossing the lower third. This frame's HUD reads **8 LEFT**,
because this pass shot the pose off its own fresh page load instead of one that had been cleared, so the eight
hostiles this deal seats are in the frame rather than held back from it. The crate at the right of the frame is the
point the last two passes were making: its two visible faces are no longer the same value, and its paint no longer
out-shines the room behind it (#476, #491). The band of dark past them is the deal's doing, not the light's — #199
lifted that deck clear of the bar and this seed put it back down by moving the room (#420).

![a wall-mounted rack across a room with a lower floor under it, and the underside of a slab above that](docs/screens/level0-pitfloor.png)

The replaced frame's pose - (19.5, 14.5), heading **atan2(2, 1) = 1.11 rad**, feet on `floorAt` **-1.00**, every
one of them read back off the load that drew this frame - and this seed's ARCHIVE SUBLEVEL re-rolled, so the camera
stands in a different room than the one the replaced caption described: a wall-mounted rack ahead of it on a brick
face, and a slab a quantum below the datum under the crosshair - the one seat of the eight that is not standing on
the datum floor. Frame mean **63.34**; **0 of 763 rows average below luminance 24**, with 9 rows under the tool's
softer bar in an 8-row run from row 98. This frame went **down** 7.61, and the cause is the re-roll rather than a
relight: the same coordinates over a different sector. The face filling the upper half of the frame is the wall the
rack is mounted on, and the dark band above it is the underside of a floor above this one - which is what the
room-height passes (#548, #421) put into the generator's own rooms. Its top band reads 52.9
against the middle third's 85.8. The replaced
row explained this frame as having gone *down* 0.57 when the roof was lit; that was #495 measured against an
older arm, and these bytes do not show it. The floor under the crosshair comes off the same near-field fetch as the
spawn seat's deck, which is why it falls off across the room instead of stepping texel to texel (#467).

![the authored two-storey level from its own spawn seat](docs/screens/level3-stack.png)

**THE STACK**, the hand-authored level, from its spawn seat: (1.5, 2.5) on the datum, at the derived heading
**0.8761**, 4
hostiles left, and **0 of 763 rows average below luminance 24** (mean 69.01, thirds 59.9 / 77.5 / 69.6; at the
tool's other bar, no rows under 34 at all, where the replaced frame counted 6 in a 5-row run from row 101). The seat reads back at (1.5, 2.5) on `floorAt` **0.00**, turned by `seatFacing` rather than by the literal 0.60 the replaced row posed, 4 hostiles left, and the plan it sits in
is the hand-written one. The heights the replaced caption read off that plan — the slab over the seat, the opening
the heading stops at, the span of the face crossing the middle of the frame — are not restated here: #421 authored
a storey into this plan since those numbers were taken, and this pass read the seat, the layout and the luma off
the page rather than re-solving the plan. What the frame shows is still the shape those numbers were about: a wall
you can shoot at, with a lit floor above its top edge that you cannot. That edge is carried by the surfaces themselves rather than by
the light on them — rectified ashlar blockwork with incised joints and tie holes over flagstone and moss
— so a lip reads as a lip at any distance, in bright light or dim, and not only where a lamp happens to
graze it (#428). You can read that in the frame: the blocks and their joints are legible out to the far end of
the wall, and the deck under them is a different stone rather than the same one lit differently. The stepped
glyphs on the minimap are the climb that gets you up there. Hand-authoring removes the seed excuse — this
plan is written cell by cell over a 20 × 20 grid — and it also shows what is still missing:
Whether this seat is genuinely under a second storey is a `tools/view.js volume` claim and this pass did not
re-read it; what the frame shows is a bright band over a lit deck, which is the shape #353 is about. What this pass takes back is the
darkness the last caption described: the vault is no longer the darkest large surface, its band runs **59.9**
against the deck's 77.5, and there is no dark block left to count, because #495 gave the ceiling a light floor
and this seat's slab top is a lit surface now. The plan is written cell by cell and the seat is still (1.5, 2.5),
turned to a derived bearing rather than the 0.60 the replaced row posed, and this frame is +4.06 on the one it
replaces because the signature over it
moved: layout 3610925125 where the replaced row named 1154765829, and
the every-room air pass (#548) is the author of that: it now writes height in rooms it used to leave at the default,
authored plan included. What moved between these bytes and the last pass is air and the light in it, not the plan:
the lit roof (#495), the roof-to-wall junction (#369), the riser material (#518) and the prop surface (#533),
on top of the ashlar family these faces already wore (#428). The heights the replaced caption read off this plan -
the slab at 1.00 over the seat, the atrium opening at 4.00, where the heading's first face stops - are not restated,
because #548 authors height in the authored cells too and this pass did not re-solve them.

![ABATOIR CORE from its arrival seat: the slab over the room fills the top of the frame](docs/screens/level2-abatoir.png)

**ABATOIR CORE**, the room with the most ceiling in the game, from its own arrival seat (22.5, 13.5)
on the datum, at the heading this sector DECLARES (`seatAng` 0.60, #421 DECISION 1), 18 hostiles left: **0 of 763 rows average below luminance 24**, with 56 rows under the tool's
softer 34 bar in a 56-row run from row 291 (mean 76.07, thirds 68.4 / 70.4 / 89.5). The top third reads **68.4** and the bottom **89.5**: the slab over the room is still the
largest surface in frame and the darkest thing on it, and the crates on the deck sit nearer their room's own
value than any frame here showed before (#479, #491). This frame and the next are one page load at two
headings, because the two rows of one level have to name one deal — and read the seat before the numbers: this
level's deal moved with the room-height work that landed since the last pass (#548), so the room dealt at this
seed is a different room again, layout 513487353 with this deal's seat read back at (22.5, 13.5) where the replaced
row named 1425048100 at (24.5, 7.5) — and 3133926234 at (17.5, 28.5), 1553972932, 469427782, 1029396294, 2728567296
and 1812275020 before it. This is the one sector whose arrival frame did not turn, because it is the one sector that
declares its bearing instead of deriving it (#482); the frame moved only because the room behind the bearing moved. The coordinates the old
caption gave describe a floor plan that is no longer dealt, not a room that shifted, and that re-roll is #420's
standing problem rather than a defect in this frame; it is also all of this frame's +1.81. `tools/view.js surface`
prices the ceiling share and the slab-to-deck ratio; the frame itself only shows the split.

![the same seat tilted up at the ceiling and what hangs from it](docs/screens/level2-abatoir-ceiling.png)

The same seat on the same deal, turned 1.15 rad right and pitched up 194 px: **0 of 763 rows average below luminance 24**, and nothing under the tool's
softer 34 bar at all (mean 77.84, thirds 79.0 / 92.4 / 62.1, and +5.96 on the frame it replaces). The pose is the replaced row's verbatim - `DEV.cam(P.x, P.y, undefined, -0.5539, 194.07)` - so the two frames
stay comparable across the re-roll, and that is also why this caption no longer names a fitting: the coordinates
the old caption read off its own deal described a room this seed does not deal, and this pass read back the seat,
the layout and the luma rather than re-solving which panel the pitch lands on. What the frame carries is the rod,
the lit panel and a band of the wall behind them
rather than the fitting and the room end to end — a ceiling that near is only drawn from about twice the eye
height in metres out (#413). So the height reads as a gap rather than as three parts of one object you can see
end to end, and it stops being something you discover by walking into it.

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
