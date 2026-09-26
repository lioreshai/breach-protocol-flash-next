# Changelog

Rules: every pull request adds a line under **Unreleased** unless it is pure tooling with no
effect on what the player sees or how the code reads - in that case put `[no-changelog]` in the
PR body and the PR guard lets it through. Newest entry first inside a section. One line means
one change: say what the reader would notice, not which file was touched.

## Unreleased

### Fixed
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
