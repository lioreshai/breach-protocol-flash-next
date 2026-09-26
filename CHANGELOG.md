# Changelog

Rules: every pull request adds a line under **Unreleased** unless it is pure tooling with no
effect on what the player sees or how the code reads - in that case put `[no-changelog]` in the
PR body and the PR guard lets it through. Newest entry first inside a section. One line means
one change: say what the reader would notice, not which file was touched.

## Unreleased

### Changed
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
