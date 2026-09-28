# Changelog

Rules: every pull request adds a line under **Unreleased** unless it is pure tooling with no
effect on what the player sees or how the code reads - in that case put `[no-changelog]` in the
PR body and the PR guard lets it through. Newest entry first inside a section. One line means
one change: say what the reader would notice, not which file was touched.

## Unreleased

### Added
- `DEV.mesh()` draws a character as volumetric geometry instead of a billboard, and that geometry now occludes **itself**: the rasterizer writes its own per-pixel depth, so an arm behind a chest stays behind it instead of painting through it. Nothing in the game calls it — the shipped picture is byte-identical (7 scene frames md5-identical to `main`) — and `DEV.mesh({self:false})` puts back the old read-only-depth ordering as a negative control (#69).

### Changed
- A level now depends on its seed and nothing else. `makeEnemy` took **ten** draws from the global `Math.random` stream per enemy (gait phase, tint, facing, fidget) and it runs *inside* `genLevel`, so how many enemies a level happened to contain reshuffled its wall textures, lamp positions and pickup phases: constructing twelve of them and throwing them away — no gameplay effect whatsoever — moved a rendered level's mean luminance from 66.4 to 70.2. Per-enemy cosmetics now come from a private stream keyed to a spawn counter, the same xorshift the asset painter uses, which is also what finally lets a probe compare two levels at all: `view.js planes` hashes generation after constructing 0 and 12 enemies and reports `GEN-COUPLE ok`, and it fails all three of its comparisons the moment the coupling is put back (#90).
- Enemies no longer all die the same way. Each kind now authors three death rows — topple angle, fall direction, per-limb swing, how far the body sinks — and the variant is dealt **at spawn**, so a firefight leaves a mix of corpses instead of twenty copies of one pose with the same leg in the air. Variant 0 is the pose that shipped, number for number, which is why `view.js stats / vert / props / heights` are md5-identical to `main` across this change; and the variant is dealt by a **spawn counter rather than a random draw**, because `makeEnemy` runs inside `genLevel` and a single extra `Math.random()` there advances the seed stream and rebuilds every level for a given seed (#82).
- Props are geometry too. A barrel, a crate, a lamp, the three pickups, an orb and the exit portal are rasterized as solids instead of cards that turn to face you, so a prop has a side and a top; the orb and the portal keep their glow through a light-exempt path in the mesh rasterizer, which is what the billboards' alpha byte 253 was for; and a prop's feet come from `floorAt(x, y)` instead of the generator's literal `z: 0.0`. Two traps came with it: a prop's albedo needs the `Surf.lift(1.35, 6)` that `propTex` applies to every prop sheet (without it a crate's brightest pixels measured 62 where the sprite measured 101), and props need a flatter Lambert ramp than bodies (0.75 + 0.42·d against 0.30 + 0.85·d) because `drawBillboard` has no normal term at all — borrowing the body's ramp turned a hazard-red drum the colour of dried mud. At the shipped census (20/25/30 props plus 8/11/13 pickups, all visible from one camera) the cost lane measures **+0.26/+0.58/+0.78 ms/frame** on levels 0/1/2 over interleaved drawn/parked batches, on frames whose prop-free floor is 3.10/3.53/3.57 ms — and the same lane pointed at `main`'s billboards reads 0.02–0.05 ms, so the cards were nearly free and the solids are not; that is the trade #76 accepted. Silhouette-edge contrast is level: mean dL 34.7 to `main`'s 35.0, lost 10.3% on both, at one camera per level on one machine. `view.js props` fails 40 assertions on the build before it (#76, #69).
- Characters are geometry. An enemy is rasterized as a volumetric mesh at its real position, heading and floor height instead of as a billboard whose yaw is one of 8 buckets, so a body has sides, an arm behind a chest stays behind it, and rotation stops popping between poses. Bodies read further apart from the room they stand in — silhouette-edge contrast went from dL 18-40 to dL 22-52, and the share of edge pixels lost against the wall from 23-42% to 0-33% (`view.js contrast`, 3 levels x 3 cameras) — and a crowd got cheaper, not dearer: 18 enemies on screen measured 13.0 ms/frame of billboard poses against 3.3 ms of mesh, and `WARM` stress 13.31 ms avg / 31 ms worst against 4.11 / 11. The one tier that pays is PERFORMANCE, which drew pre-baked sheets and now pays +0.25 ms at 8 bodies, +0.56 ms at 18. What the mesh cannot do yet is animate: a walking enemy no longer cycles a gait and a dying one fades in place instead of toppling, which is why the sprite sheets and pose rasters are still built but no longer drawn (#69 B2, #39).
- Inline the wall bilinear fetch at its single call site and wrap the neighbour texel with an integer mask, guarded by a new smoke assertion that every wall mip dimension is a power of two (#25).
- Occlusion depth is one value per **pixel** instead of one per screen column: the ground pass writes the distance it already solves — including the pixels it queues for the lip of a step, whose colour comes from a different plane than the row's — the wall pass writes its own face span, and the sprite and particle paths compare per pixel. No pixel changed colour, and a column with no wall no longer holds a stale zero that hid sprites there. A flat ceiling row keeps the "occludes nothing" sentinel until the pass that clips against it (#45).

### Fixed
- **Flying things and debris now respect the floor they are in, not the floor the world started on.** An orb fired along a raised band sank through it and kept travelling underneath; sparks and scorch particles shed at altitude slid down to `z = 0.02` and pooled on a floor that is not there; and an orb rolling along a floor a metre BELOW a player on a band damaged them at the legs, because the altitude window of the hit test began at the datum instead of at their feet. All three now resolve against `floorAt`/the player's own altitude, and on flat ground every expression is the one it was (4 scene frames md5-identical to `main`). The `VERT=1` lane's last reporting row promoted itself, and two new gating rows cover the particle and hit-window halves (#98). One of them had to be rewritten after its control stayed green: an orb placed at `z 0.05` in a low column sits *inside* that column's floor slab, so the projectile fix destroyed it before the hit test could run - the row was measuring the clamp instead of the window, and now puts the orb at mid-band where only the window decides.
- **A step you cannot walk up is now a step you can see.** A boundary whose two sides differ by more than one height quantum blocks movement - that part always worked - but the wall pass only ever enumerated faces where a ray stopped at a *solid* column, so an air-to-air step drew nothing and occluded nothing either: geometry showed straight through the thing that was stopping you, and `zbuf` kept the far distance behind it. Such a boundary now stops the ray and paints the side of the floor slab, from the lower floor to the higher one, which is the strip that is actually there: a one-unit step in a one-unit room reads as the wall it effectively is, and a pit gets the wall *below* its lip rather than above it, so a body in a pit keeps showing its crown instead of vanishing. Levels the generator makes are entirely flat, so nothing changed on screen today (4 scene frames md5-identical to `main`, raster unchanged) - the branch is behind a derived `MAP.steps` flag that no generated level can raise (#100). `view.js cull`, whose occlusion row used to report this as a known issue, now gates it and moved into the required probe lane.
- Altitude now counts where it always silently ignored it: **a blast on one band no longer damages a band above it**, **the portal no longer changes level when you are standing in the cell below it**, and **a pickup no longer jumps into your pack while you are hovering a metre above it**. On flat ground all three are bit-identical to the old arithmetic - the blast compares the two columns' floors (every floor is 0), and the pickup still lets you grab things mid-jump, which is why its window is 0.6 m and a jump peaks at 0.489 m (#105, #109). The `VERT=1` lane's two known-issue rows for this promoted themselves to gates, and a new row covers the pickup in both directions.
- The camera's eye now lives in the band the player is standing in, instead of being clamped to `[0.12, 1.4]`: standing on anything above ~0.9 m rendered with the eye frozen at 1.4, and because that number is the ground pass's accept test (`rawA < eyeZ`) it made the pass **reject the floor under the player's own feet** and paint datum `z = 0` in its place - a phantom floor up to two metres below them. Every shipped level is flat, so the picture is unchanged today (4 scene frames md5-identical to `main`, raster 3.42 ms either side of an interleaved pair); `view.js horizon`, whose eye-altitude row used to report this as a known issue, now gates it (#103).
- Shots follow the body they hit. `hitscan` tested the ray's altitude against the enemy's height above **absolute zero**, so an enemy standing on a band one unit up could not be hit at chest height at all, while a shot fired level at the eye passed through the floor under it and hit it anyway; barrels had no altitude test of any kind, so a sunken barrel was still hit by a shot fired over its head. Hit windows are now measured from the target's own floor and the head/body threshold moved with them. `view.js sight` aims analytically at bodies and barrels at four band offsets across 3 levels and fails **21 rows** on the previous build, 0 here: widening the window to plus or minus 50 units fails the 6 rows that must miss, and calling every hit a headshot fails the 12 chest rows, so neither the bug nor its opposite gets through (#98).
- A character's head sits **on** its body. The mesh parts were placed to touch rather than to overlap, so the band between the shoulder line and the base of the head was whatever stood behind the character: 8 rows of daylight in a 151 px grunt at 2.4 m and 4 rows in a 100 px hound, at every yaw and gait bucket tested. The junction is now stitched by a neck that reaches 0.02 of body height into each of the parts it joins, and `view.js anim` reads the body mask down the body's own projected axis and fails if any row between the crown and the shoulder line is background — 8 poses fail on the previous build, all 12 pass here, at contrast numbers that did not move (mean edge dL 36.7 to 36.8, mean lost 14.6% to 14.7%, 3 levels x 3 cameras). A brute has the same hole, 0.052 of body height above its shoulders, but its own shoulder top face hides it from the eye's height, so only its geometry was wrong and only the grunt and the hound failed the pixel test (#74).
- Enemies animate again. The mesh path had **no pose input at all**, so #72 traded the walk cycle for volumetric bodies: every enemy drew one straight-legged stance however fast it walked, and a dying one faded in place instead of falling. A body now carries the same four signals the billboard fed the rig — gait phase, move amount, attack progress, death progress — into a table of vertices authored per **phase bucket** (8 gait × 3 move × 4 attack × 6 death per kind, LRU-capped; a 12-body firefight touches 28 sets and 0.08 MB), so a moving enemy costs a cache hit rather than a rebuild: 25.6 ms/frame against 27.4 for vertices rebuilt every frame, on a frame whose floor with no bodies at all is 25.1. A corpse topples about its contact line toward the direction it was hit in, the arm reaches full extension on the frame the round leaves the muzzle, and `view.js anim` now fails if a body ever stops changing shape — 0.0% of body pixels change on `main` against 13–28% here, with a 0.00% noise floor. Silhouette-edge contrast is unmoved: 36.7 dL against 36.4 measured interleaved on the same machine (#73).
- A level transition seats the player on the **new** level's floor. Entering a sector while falling carried that fall across the portal and cost 22.8 hp of damage for a drop that never happened; and because the generator derives the spawn altitude before its last write to the height grid, a spawn on a raised band arrived 0.5 units inside the floor above and took 28 frames to ease out of it (#14 step 3).
- Ceilings and floors no longer streak at grazing angles. The ground pass picked its mip from one axis
  of a pixel's world footprint — the u component of the row delta, with its v component weighted 0.001 —
  while that footprint is a long thin strip pointing down the column, so looking along a corridor axis,
  where planeX is 0, it read a footprint of exactly zero and point-sampled mip 0 across the whole floor.
  Selection now takes both screen axes of the footprint, ratio-clamped 4:1, once per row, and
  `node tools/view.js mip` measures the streaking and keeps the old 1-D selection as its negative control
  (#19).
- Revising a floor no longer leaves an invisible wall where the step used to be. The boundary flags were
  OR-ed in at every relink, so a step that was raised and then flattened kept blocking movement and drawing
  a face although the grid was flat again; blocking is now rewritten from the grid each relink while the
  authored ramp and ladder bits survive it (#54).
- Walking off a step or into a pit no longer drops the player in a single frame: a column whose floor is
  more than a quantum below the feet hands the player to the same gravity integration a jump uses, so the
  fall takes frames and reads as a fall. The `else P.z = gz` line that snapped them down was correct only
  while every floor was the same floor, which stopped being true when cells gained altitudes.
- A sealed exit or an enemy spawned in a closed pocket could no longer slip past `smoke`: the reachability array the assertions read was wiped to zeros two lines after the generator filled it.
- A forgotten `linkBoundaries()` after writing a cell's height can no longer appear as a seam between
  the walls and the floor: the wall pass now reads the same derived ceiling plane the ground pass
  draws, and `view.js planes` fails when a height write leaves the relink stamp where it was. Flat
  levels render pixel-for-pixel the same.
- `genLevel`'s silent fallback now warns, and sets the spawn altitude - it inherited the previous level's `P.z` on a mid-run transition, and its lamp loop iterated the array cleared one line earlier
- Standing at a step or looking across a sunken room no longer paints the floor or ceiling of a room
  two cells away through the wall: the ground solver may only borrow a height from a column within two
  cells with nothing solid between, it can no longer run out of tries and place a pixel at a distance
  belonging to a height it discarded, and pixels whose ray leaves the level stop borrowing light, tint
  and decals from a cell on the far side of the map. Flat levels render pixel-for-pixel the same.
- Thin limbs stopped glowing: the rim band is now capped by the width of the part under the pixel, so a leg or hanging arm shows a lit edge instead of lighting up edge to edge.
- The character rim light is a thin ridge instead of a wide ramp: at close range it stopped reading as a white halo around the whole silhouette, at the same edge separation and the same frame cost.
- Character rim light now follows the silhouette instead of outlining every capsule, box and disc, so the seams inside a body stopped glowing; gain retuned to keep edge separation at least as good as before.

### Added
- Work is tracked in GitHub issues: every PR must reference one with `Closes #N` or carry `[no-issue]`, the tracker holds milestones and defects that used to live as prose in ROADMAP.md, and a weekly triage sweep reports open issues with no priority or area label.
- `?dev=1` boots the game with no click and no pointer lock and publishes a `DEV` console API (deterministic camera and enemy placement, frozen frames, a DDA ray query, runtime quality overrides including the character rim light), documented in the README.

### Changed
- The `issue` check now accepts the `Refs #N` form AGENTS.md tells us to use, so a PR that is one step of a milestone no longer fails a required check for not closing that milestone.
- The player obeys the height grid: a quantum of floor steps up without a jump being pressed and two
  quanta stops the player, landing from more than about 1.5 units costs health scaled by the impact, and the
  up/down keys change altitude only on a cell flagged as a ladder or a crossing flagged as one. No shipped
  level has a height or a ladder yet, so all of it is asserted as behaviour in `view.js vert` (#14).
- Cell heights are now assigned before the generator's occupancy gate, and reachability is height-aware: a boundary is crossable only when the two floors are within one step. Flat levels are unaffected, pixel for pixel.
- The floor and ceiling are now solved against the height of the cell each pixel's ray lands in,
  instead of against the eye's own floor and ceiling stretched across the whole level: nothing
  changes on today's flat levels — that parity is the gate — and `view.js heights` is the probe that
  proves a room's floor and ceiling now follow the room rather than the camera.
- The extra-seeds check runs on merges to main instead of on every branch push and pull request: it printed the same informational verdict every time and cost ~6 runner-minutes doing it.
- Verification rule written down: anything observable on the live site is verified without waiting for a human report. Fixes a stale note claiming image input is broken here.
- README shows what the game actually looks like today, captured from the deployed build, and that pass is a standing rule after every visible merge.
- Merged branches are deleted instead of accumulating: the repository deletes on merge, and a weekly sweep catches what that setting cannot reach.
- CI required check drops from ~8 min to ~1.5 min: the probes moved to their own job beside the gate, so only guards, syntax and the full smoke run stand between a PR and a merge.
- CI required check is ~6 min faster: the informational seed runs moved to their own job. The PR changelog guard reads the body from the environment now, so a body containing an apostrophe no longer breaks it (or reaches the shell).
- Repo is public, with CI on every push and PR, and Pages deploying every merge to main.
- Weapon viewmodel rebuilt: one bore axis for all three families, so the muzzle flash now comes
  out of the muzzle instead of 90 degrees to the side, and the forearms reach past the frame.
- Characters are drawn with a rim light so they separate from dark walls, and render at roughly
  2.3x the earlier texel height instead of going blocky up close.
- The muzzle flash is a flash: a cone down the barrel plus a 5-spike star with a per-weapon
  flicker seed, instead of a dim circle on the gun's right.

### Fixed
- Lamp fixtures are placed on their cell's floor instead of floating at the middle of the box.
- Rig pose boxes were over-scanned by up to 61%, so most of a character's raster cost was spent
  on empty pixels.
- Sound can no longer leave the audio graph in a stuck state, and a muted context no longer
  leaks a voice per shot.

## 1.0 - 2026-09-26

First public baseline (tag `baseline-v1`). Software raycaster with per-column wall spans,
procedural textures, rigs authored at boot from signed-distance parts, 9-tap perspective ground,
three levels, hound/grunt/brute enemies, and all art and audio generated at boot with no asset
files and no network requests.
