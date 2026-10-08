# Changelog

## [v1.4.1] - 2026-10-08

### Added
- **Walls have things mounted on them now** (#403, #412, issue #400). Door frames, pipe runs, vent
  collars and hazard bands sit on long walls, and each stands a little way off the face it is bolted to
  - 12 cm of door reveal, 10 cm of pipe bracket, 8 cm of duct collar, a thin striped plate - so it keeps
  a shape when you look along the corridor instead of collapsing into the wall. Doorways are now marked
  at the mouths of rooms rather than lining every passage, so a corridor reads as a passage and a room
  reads as a room. Each level has its own vocabulary: pipework and ducts in the archive, hazard stripes
  on the transport ring, ducting in the abattoir, and all three in THE STACK's finale rooms.
- **The finale plays the difficulty you chose** (#360, issues #354 and #355). On THE STACK the enemy
  count now follows the difficulty setting the way the dealt levels already did, and its explosive
  barrels take damage and detonate instead of absorbing fire forever - Recruit and Nightmare no longer
  ship an identical four-enemy ending with indestructible drums.

### Changed
- **Crates, barrels and lamps read as objects, not cards** (#373, issue #371). Props are turned off the
  grid, so one face catches the key light and the other falls into shadow: the crate in THE STACK's
  arrival view is now about 40 luminance brighter on its lit face than on its flank, where the previous
  build showed both faces within 6 of each other. Two crates in a row are no longer mirror-image clones
  of the same box.
- **A lit level is no longer a white sheet** (#379, issue #377). Bloom now lifts only pixels above a
  brightness threshold instead of adding the same flat push to everything from mid-grey up. Point the
  gun at a lamp in Sector 2 - RING TRANSPORT and the metal deck is metal again: the studs, the shadow
  between them, the line where floor meets far wall, and the bottom edges of crates are all visible.
  On the previous build that frame had 9% of its pixels clipped to white. The light the old pass was
  accidentally supplying comes back as one black-point exposure lift on the room, shouldered at luma 200
  so it cannot re-clip the highlights the bright pass has just un-clipped.
- **The rifle in your hands stops changing colour when you change rooms** (#389, issue #376). It still
  brightens as you walk up to a lamp and still washes warm when you fire, but it is no longer re-tinted
  by the hue of whichever room you are standing in, which read as the gun being made of the walls.
- **THE STACK's walls are no longer washed near-white** (#403). A grime wash was painting an opaque
  sheet across the lower half of every wall and fixture there, which flattened the level's own material
  along with it.

### Fixed
- **The far ceiling stops drawing the level's edge as a flat bright wedge** (#406, issue #375). Rays
  that reach no ceiling at all were still being paid a tall ceiling's bounce light, so the region beyond
  the level's footprint read as an opening in the roof with a hard straight lower edge. It now sits
  darker than the ceiling above your head and falls off, so the same sight line reads as depth.

### Still open in this build
- Long walls are still mostly bare between the fixtures, and small rooms get none at all (#400).
- Some ceilings still show a faint radial structure toward the vanishing point (#19), and the far
  ceiling is now a falloff rather than a solved surface, so its boundary can still be traced (#375).
- Enemy bodies still read as dark cut-outs against a lit wall - the contact shadow that would fix it is
  measured but not yet drawn (#179).
- Level 2 still paints floor, walls and ceiling at close to the same brightness; only two of the four
  levels author a value order (#369).
- Two merged changes here are diagnostics only and move no pixels: a screenshot now states the route that
  bound its seed (#344), and the scene render can look around one level instead of dealing four (#384).

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
