# Changelog

## [v1.4.2] - 2026-10-09

### Added
- **Two storeys can fight each other now** (#397, #423, issue #353). Dealt levels pair a tall room with a
  mezzanine one floor up and put a hostile standing on it - up to three pairs per level - and THE STACK's
  finale authors its own overlook: a pit floor with a grunt on the lip a metre above it. The riser still
  blocks walking, so you still take the stairs, but shots pass through the opening. An enemy on a raised
  band is now a tactical fact rather than scenery.
- **Rooms say what they are for** (#414, issue #400). Three new wall fixtures built at boot - a stock rack,
  a tank with a sight glass and its two plumbing stubs, and an arrow board beside a doorway - and each
  sector authors its own pair: shelving in the ARCHIVE, tanks on the RING, vats and shelving in the
  ABATOIR, one of each in THE STACK's three rooms. Every room now gets one; previously a room whose
  first-choice face was already a door frame got nothing at all.

### Changed
- **Floors and ceilings stop drawing a fan of spokes** (#409, issue #19). A ground or ceiling pixel now
  averages the strip of material it actually covers instead of reading two texels about one texel apart,
  so the streaking that converged on the vanishing point is gone through the mid field - the largest area
  on screen. The floor under your feet keeps its finest detail. `DEV.set('gndfade', 0)` shows the old fetch.
- **A hostile 10 m away keeps his room's light** (#415, issue #407). The baked lamp field was being
  attenuated a second time on bodies and props only, so a grunt standing well inside a lit room read as a
  black cut-out with no lit flank. Distance is now carried by the haze alone, the way walls and floors
  already paid it.
- **No level paints its walls in its own floor's material** (#426, #428, issue #369). ABATOIR CORE's walls
  are now meat with fibre bundles under broad folds rather than its floor's flesh; THE STACK's wear new
  ashlar blockwork over their flagstone deck, authored at the same brightness, so a lip reads as a lip at
  any distance; the ARCHIVE's minority face is form-panelled concrete and the RING's is a grate. Edges that
  used to join two things agreeing in both colour and texture now separate.
- **ABATOIR CORE's roof stops out-lighting the floor you stand on** (#410, issue #369). The lift that keeps
  a 4 m vault from going black is capped by the surface order that level already states: its ceiling band
  falls 66 to 27 against a deck of 49, so the room reads as three surfaces and a tall room reads as *high*
  rather than as *bright*.
- **THE STACK's lamp pools stop bleaching the deck** (#419, issue #408). Six lamps on a 20-cell plan
  overlapped into a plateau above the renderer's ceiling, where the metal's studs had nothing to modulate
  against. The baked field now has a soft knee, so the deck keeps its shading right up to the lamp's base
  and the finale stays as bright as it was (its spawn pair holds at 49/53).
- **The floor past a level's edge belongs to the depth cue** (#396, issue #385). Off-map floor pixels kept
  whichever lamp the ray's walk had passed, at full strength, and ended on a hard line. They now read the
  level's own ambient the way far walls do, so the far field ramps into the fog wash instead of drawing a
  second hard edge where the footprint ends.

### Fixed
- **A shot fired down from a mezzanine hits what you aimed at** (#425, issue #353). Every overlook in the
  game was one-way: the shot from the room up to a body on a band landed, and the return shot flew over his
  head and slapped the floor behind him, because the hit test sampled the ray's height at the near edge of
  the body rather than along it. A grunt firing down from the edge can now be answered.
- **THE STACK's frame in the README is drawn by the build that ships** (#411, issue #388), re-taken from
  the deployed page after the lamp and lighting work above.

### Known in this build
- Only THE STACK authors an overlook; the dealt levels get 0-3 pairs from the generator's pairing pass, and
  the row that proves one is aimable is gated on the authored level only (#353).
- Radial structure is still faintly legible on bright far-ceiling panels. That residual is a level's own
  edge landing on the ceiling plane, not the texture fetch (#19, #375).
- The very core of THE STACK's lamp pool still sits just past the clamp, so the brightest few pixels at a
  lamp's base are flatter than the deck around them (#408).
- ABATOIR CORE still fails its own surface sweep at one pose, and long walls stay bare between fixtures
  (`surface L2 SWEEP`, #369, #400).
- No probe measures a body at 8-16 m yet, so the range lighting above is not pinned by a distance row
  (#407 stays open).
- Two merged increments move no pixels: the surface census now names which face repeats a level's own deck
  material (#424), and the off-map floor fix gains a rendered before/after of the level's outline (#429).

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
- A hostile standing well inside a lit room is still one of the darkest things in the frame: the room's
  light field is attenuated a second time on bodies and props, once on the world (#407). The contact
  shadow that grounds a body on the floor IS drawn now; this is a light problem, not a missing patch.
- ABATOIR CORE's vault can still out-light the floor you stand on at one arrival pose, and two of the
  four levels author no surface value order at all (#369).
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
