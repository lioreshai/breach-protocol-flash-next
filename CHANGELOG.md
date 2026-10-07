# Changelog

## [v1.4] - 2026-10-07

### Added
- **A fourth level: THE STACK** (#304). The first hand-authored map, and the first you climb through —
  two storeys you can stand on and look up into. It is smaller than the dealt levels and its layout is the
  same every run, while the other three are still dealt from a seed.
- **Every dealt level digs a reachable sunken floor** (#288) — a pit in the room furthest from the spawn
  that you can drop into and climb back out of.
- **No level deals you a one-unit ceiling any more** (#283): tall air is authored first, so a room is never
  too low to stand in.
- **The arrival room opens upward** (#300) — four units of air above the spawn seat, with the far ceiling
  lit so you can tell there is one.
- **Big rooms get a lamp standing in them** (#337); a wide band of floor is no longer left unlit.
- **Grenades come back from the fight** (#362). Kills and grenade crates restock the pouch, so the grenade
  counter can rise during a level instead of only falling. Grenade crates have a body of their own now
  instead of borrowing the ammo box (#361).
- **The deploy screen lists jump and climb** (#363), so the vertical controls are discoverable before the
  first level, not after a failed attempt at one.

### Changed
- **Light stops at floors and walls** (#252). A lamp's glow no longer bleeds through a slab into the room
  above or below it, so a lit room reads as a lit room.
- **Levels author which surface is brightest** (#380): walls lead, the floor you stand on sits mid, the
  ceiling sits lowest, so a ceiling stops out-shading the room under it. Two levels author the order; the
  rest render byte-identical.
- **Enemies learn a room and keep a chase** (#364). An alerted room stays alerted, a chase continues when
  you break line of sight and come back, and the later levels trade hits harder.
- **Enemies stop shooting through slabs they cannot see through** (#261), and a melee swing now asks which
  floor it is standing on at the moment of the swing (#365) rather than the one it remembered.
- **Bodies read as bodies.** The grunt's torso carries its own surface structure instead of a flat gradient
  (#240), a body that comes down lays its weapon along its own axis (#359), the walk cycle is driven by the
  step's phase and shape (#339), and your own viewmodel's shoulders now sit under the head with the neck
  filled in (#326, #341).
- **Frame cost came down on the paths that were paying per pixel**: one ceiling march per row and cell
  instead of per queued pixel (#294), one deferred paint per coalesced ceiling run instead of per column
  (#297), and the viewmodel's geometry cache key quantized per term so a steady aim stops rebuilding
  geometry it already has (#342).

### Fixed
- **Floors and ceilings stopped drawing a fan of spokes** (#370, #383). The radial comb that appeared across
  any distant floor or ceiling was the sampler reaching outside its own texture; it filters now, and the
  far field takes the same washed answer in every copy of the ground pixel. The far ceiling also stopped
  drawing the level's own outline as a bright wedge (#392).
- **A prop on the floor above no longer draws through the slab** between you and it (#331).
- **A bullet hole in a step is drawn in the step** (#269) instead of floating above it, and a shot fired
  upward stops at the ceiling of the column it actually entered (#258).
- **Light no longer smears where a ground ray crosses a cell boundary** (#311).
- **An authored doorway lamp was standing in the door jamb and sealing the doorway** (#351). Doors open
  again.
- **Props no longer spawn on the spawn seat** (#329) — you arrive with two metres of clearance.
- **The title screen stopped printing its own separator as escape text** (#390).

### Still open in this build
- Some floor between lamps is still darker than the lamps imply; the graded reach that would have fixed it
  was measured and rejected (#368), so the dark floor is mapped but not cured.
- Enemy bodies still read as dark cut-outs against a lit wall — the contact shadow shipped as a measurement,
  not as pixels (#271, #179).
- Every wall in the game is still one unbroken sheet of one material with nothing mounted on it (#400).
- THE STACK is authored, so it does not change between runs; only the dealt levels do.
