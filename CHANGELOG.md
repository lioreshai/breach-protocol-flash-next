# Changelog

## [v1.4.16] - 2026-10-27

### Added

- **Every room you walk into has something to walk past** (#631, PR #644). A dealt sector used to open on
  one long empty box: a lid, a floor, a strip of wall, and nothing between the crate line and the far
  surface. Each room now carries a **pier run** — a line of single columns across the room's longer view,
  one cell of gap between piers — so the room breaks into bays and you see *past* the line instead of into
  it. Piers wear the room's minority wall face rather than its primary one, so they read as columns
  standing in a bay and not as a slab of the deck. In the room you wake in the line is placed from your own
  facing: four to six cells down the view, with a gap on your centre line, so the first frame looks
  *through* the columns at the room beyond. A pier can only ever remove openness, so nothing you could
  reach before is unreachable now. Authored THE STACK is untouched.
- **The wall you walk toward carries a thing** (#400, PR #649). The face exposed where a deck steps up used
  to be one uninterrupted sheet of concrete. Where an axis sight line from your spawn met a wall carrying
  only paint, that face now mounts an object for its sector — a drum or tank in RING TRANSPORT, shelving in
  ARCHIVE SUBLEVEL and THE STACK — in up to two directions per sector. Each stands well off the face, so it
  keeps a flank and an edge when you look along the wall at an angle instead of reading as paint. On a deal
  whose arrival walls are already furnished the pass places nothing and the level's bytes do not move.

### Changed

- **Hostiles resolve a beat earlier at the ranges this game is actually fought at** (#611, PR #657). A
  body's delivered colour was *predicted*: background samples taken around his silhouette, and his own
  value re-computed from a shading model. Every term of that model was right and the mean of his pixels
  still was not, so in unfavourable rooms he landed within a point or two of the wall directly behind him —
  no silhouette at all at 8-16 m. His value step is now measured at the pixels he really takes over: colour
  and depth inside his projected box are saved before he draws, and only a pixel whose depth his draw
  lowered counts as his. The push is paid against the surface that was provably behind him, the same pixel
  in the same frame under the same lamps.
- **The front page's frames describe the build they came from** (#597, PR #666). All eight screenshots were
  re-taken from the deployed build and each caption now carries that build's own numbers.

### Fixed

- **Looking off the edge of a deck no longer stretches that floor to the horizon** (#518, #515, #516, #517,
  PR #670). Deferred floor columns — the ones a row hands to a second solver because a height boundary
  crossed under them — could adopt a *lower* plane further along the ray and then paint with it, even when
  the ray never arrived at any surface. A deck's altitude was then solved out to the horizon: warped stairs,
  a pit that read as a table when viewed from the deck above, and the edge of the band you were standing on
  turning into a texture suggestion instead of a place. A march that reaches nothing now says so, and those
  pixels answer the floor you are actually standing on or the far band. The march's crossing budget also
  stopped hiding a second, shorter reach inside the one it declares, so a ray that used to run out of tries
  now finishes its own walk.

### Known limitations

- **Standing under a mezzanine still reads flat** (#421, PRs #660, #663). Every pose the census measures
  today clears its underside luma floor — `node tools/view.js` prints the per-level rows — but a frame that
  shows the storey above you from directly beneath it is still the sheet this work was filed from. A new
  census row now says whether the limit is your heading or the deal itself; on the first generated sector it
  is the deal, not the lens.
- **A rim can still disagree with itself** (#633, PR #673). An edge that stops your feet while painting
  nothing, or a painted kerb that turns out to be a wall, is still possible: the per-boundary *kind* is not
  stored yet. This window removed two edge words that were documented but implemented nowhere, so the three
  places that ask "what is this edge" can no longer give different answers. The issue stays open.
- **The ceiling's radial streak is unchanged** (#19, PR #667). The texture-carried fan sits inside 4 m,
  where the pixel is magnified; the far-field walk measures zero on the fetch that ships, so that knob stays
  a one-constant A/B instead of becoming a seventeenth filter. The acceptance target it was gated against
  sat below the streak of a ceiling with its texture removed — a bar no fetch change could have met — and is
  now verdicted against the shipped look.
- No crash- or stall-class fixes landed in this window.

## [v1.4.15] - 2026-10-26

### Added

- **THE STACK has a floor above you, and it reads as a floor** (#421, PR #656). The west hall now carries a
  four-cell mezzanine a metre over the deck, reached by a three-tread stair that shows on the minimap, and
  you can stand on it. Two lamps make it legible: one standing on the deck above, so the raised floor is lit
  by something that is actually on it, and one in the hall below, so the aisle under the slab is lit too.
  Before this, a raised floor left both the deck and the space beneath it unlit, so a floor overhead was a
  flat black sheet you could not tell apart from the level's own ceiling. The stair and the slab are on the
  sector's minimap bands, so the map still tells you which storey you are on.

### Changed

- **A crate 8-16 m away stands on the deck instead of floating over it** (#18, PRs #650, #654). The contact
  shadow that grounds a hostile's feet grew with distance on purpose, because a patch drawn in metres
  collapses to a pixel or two by the time he is 12 m out — but the growth only applied to bodies, so at the
  ranges a fight actually starts a crate's bottom edge was as bright as its top edge and it looked like a
  decal pasted on the floor. Props now get the same rule. It removes light rather than adding any, so it
  still works in the dark rooms where a brightened rim used to floor to nothing. The near field inside 4 m
  is unchanged, byte for byte. The check behind it now judges the ink by *where it lands* — every far dark
  pixel has to fall inside the footprint of a shadow that could have cast it, and the pool's width is
  measured against the crate rather than against its own disc — so a cue that has smeared into a smudge
  fails instead of passing with the same pixel count.
- **The front page describes the frames it shows** (#597, PR #651). All eight screenshots were re-taken from
  the deployed build and each caption now carries that build's own numbers instead of figures from an older
  one. The pit-lip frame was the worst offender: the darkest frame on the page, with 149 of 763 rows under
  luminance 34 and a 142-row dark run from row 255, captioned as two dark rows and a 2-row run.

### Fixed

- No crash- or stall-class fixes landed in this window.

### Known limitations

- The mezzanine deck is deliberately four cells, not a wing. The minimap takes the sector's modal floor band
  as its datum, and a deck of six or more cells would flip that band, at which point the map's colour stops
  telling you which storey you are on — so the deck that fixes one cue would break another. Dealt (randomly
  generated) sectors still never raise a floor over another, so this reads in THE STACK's authored layout
  only; #421 stays open for the rest.
- The crate's contact pool is honestly loose at long range: the sanctioned growth alone puts a 0.27 m crate's
  patch at 0.88 m by 13 m, so the width bar catches gross widening rather than a few centimetres, and the
  final read on crates at 8, 12 and 16 m in lit and unlit rooms still needs an eye on a running frame.
- One front-page frame — the pit lip — came off a cleared load, and its HUD reads 0 LEFT where the same
  sector's arrival seat reads 8. Its caption now says so instead of hiding it. A clean re-take needs an
  instrument that re-deals the same layout, and has to take all five level-0 frames in one go, so it is not
  done here; #597 stays open.

## [v1.4.14] - 2026-10-25

### Added

- **Something is mounted on the wall you wake up facing** (#400, PR #624). RING TRANSPORT used to open on
  one long grey face with nothing on it while the other three sectors put a thing on your arrival wall. The
  generator now reads the four sight lines out from the spawn square and requires the first wall one of them
  meets to carry an *object* — a rack, a tank, a vent plate or a doorway, each standing far enough off the
  face to show a flank and hold a silhouette at 8 m. A wall that already carries one is left alone; a wall
  carrying only paint has that paint turned into the object. Rooms also try their object kinds before their
  paint kinds, so the fixture every room is guaranteed to have is a thing rather than a stripe.
- **Racks and duct collars stand off the long walls** (#400, PR #647). THE STACK's six long straight runs
  that owned nothing but a hazard stripe now have an object at the point down the wall your eye lands on
  when you look along it; the six that already owned one keep it, so all twelve of that level's qualifying
  runs carry an object. The other three sectors look exactly as they did — the new rule found their runs
  already furnished and says so rather than painting over them.
- **A hanging ceiling lamp shows its lamp** (#629, PR #630). In a tall room a pendant was a dark three-metre
  rod with a two-pixel lens on the end, so the roof of the frame carried a black column and none of the four
  arrival frames showed the light itself. The fitting now has a shallow cone reflector with its own glow at
  the mouth, the drawn stem is capped at 1.6 m so a rod is never the longest line in its own fitting, and a
  rod is no longer drawn at all when a wall or slab hides the lamp at the end of it. No light source moved,
  so no light pool changed.

### Changed

- **A hostile reads against the wall that frames him** (#611, PR #626). In a room that lit an enemy to the
  same brightness as the surface behind him, he arrived a beat late — you were finding him rather than
  seeing him. The game now checks four pixels just inside his silhouette that the depth buffer says are
  *behind* him, and if his own paint would land him less than four luminance under that surface it darkens
  his albedo until he does not. The push is a grey scale, so his colour is untouched, and it adds no light —
  the room is not made brighter to make him visible. At each sector's 10 m seat the value step is now
  10.9 / 12.7 / 6.0 / 15.2 lumas against a 4-luma bar; with the term disarmed in the same build the first of
  those falls to 3.2, which is the defect.
- **A grunt's head sits on his shoulders** (#80, PR #628). The band of neck between shoulder line and head
  was 6.1 % of his height and it was the side of a tube — the one face whose brightness depends on the
  room's light — which is why a head that was geometrically closed still read as floating in a dim cell. The
  exposed column is capped, so the top of the shoulders carries the head's weight visually; the band is now
  4.8 % of body height. The visor rides the skull, so a lower head cannot leave it behind. Hounds and brutes
  draw identical pixels — only the grunt's geometry was long.
- **Close up, the ceiling stops combing into streaks** (#19, PR #645). A ceiling tile near you is tens of
  screen pixels wide, so a pixel there covers *less* than one texel of the material and the fetch answered
  with that single texel — whose value depends on where the pixel sits, which drew as a family of lines
  through the vanishing point. Such a pixel now takes part of its material's average in proportion to how
  little of the material it can see; one that covers a whole texel is unchanged. THE STACK's roof near-field
  streak drops 119 -> 78, and along-row grain on the shipped frames moves at most one point from the previous
  build (27 / 28 / 29 / 24), so the roof still reads as a surface rather than porridge. The floor is
  untouched — the term is gated to ceiling rows.

### Fixed

- **A floor above you stops wearing the ceiling's paint** (#421, PR #641). Look up under a mezzanine and you
  saw the level's own ceiling material — same grain, one straight edge, no depth — so the storey directly
  above you looked like the roof over your head everywhere else and you could not tell where the slab's edge
  was, which is the edge you shoot over. It now reads as a floor seen from below: painted plate over joists,
  a joist shadow every half metre along the span, and a lit near edge where the deck above stops. Under RING
  TRANSPORT's raised deck that near edge steps 18 lumas instead of 7.5. Nothing was lit harder: the change is
  four shape constants on a surface the renderer already drew, so the room below still decides how bright the
  plate gets and the underside still cannot out-light the deck you stand on.
- **An enemy standing next to a crate keeps his own contact shadow** (#18, PR #646). Where his shadow patch
  and a crate's overlapped, the floor took whichever disc was registered last — and props are registered
  after bodies, so it was always the crate's. A crate's disc is small and tight, so on the deck the two share
  his grounding simply stopped and he floated on the one patch of floor where he was closest to something. The
  floor now answers a pixel with the darkest disc covering it, which is what the wall-face pass has always
  done, so the two agree and the overlap belongs to whoever occludes more.
- **The generator's paint-to-object conversion ran on no deal, ever** (#400, PR #647). The rule that claims a
  face wearing only a hazard band or pipe run and bolts a thing to it in place compared a stored face
  orientation against the wrong numbering and returned false every time it was called — three separate passes
  asked for it and all three got nothing, on every deal. It is fixed, and the probe that covers it has been
  run against the broken arithmetic to confirm the new row can actually go red.

### Known limitations

- A crate more than about 4 m away still casts no contact shadow of its own; it grounds nothing at the ranges
  enemies are actually engaged at. That gap is now measured per caster so a red row names it instead of
  averaging it away (PR #648), and the fix is in review (PR #650) — giving props the same range growth the
  bodies got made an enemy's own far band collapse in the test that measures him, so the two need separating
  before it lands.
- Sector 1's long sight line is still one concrete band with tanks standing in front of it (#400). Its runs do
  carry objects, so this is not the same defect; what that frame needs is a fixture whose shape survives being
  seen nearly edge-on, which is a renderer question, not a placement one.
- Ceiling streaking is fixed where it was worst but not everywhere: sectors 0 and 1 stay above the streak bar
  at the shipped baseline, and the measurements on #19 put that residue on the light ramp and the slab geometry
  rather than on the texture fetch.
- Past about 22 m the game still stops drawing a surface, so the horizon stays a flat band and distance tells
  you nothing there (#616, still open).
- Several of this release's items keep their own issue open because only part of the acceptance landed: #400,
  #421 and #80 are visible improvements, not closed work.

## [v1.4.13] - 2026-10-23

### Changed

- **You arrive facing the storey the level built over you** (#421, PR #482). Every sector used to drop you at
  one fixed bearing whatever the generator had laid out. On ARCHIVE SUBLEVEL and RING TRANSPORT a raised deck
  already stands within twelve metres of the arrival cell — 19 and 26 columns of the first frame have a floor
  over their head — so the level opened on an empty stretch of deck with its best geometry off to one side.
  The arrival heading is now read from the map the loader just built: you walk in looking at the nearest deck
  overhead, at its lit underside, the lip where that underside ends, and whatever stands on top of it. RING
  TRANSPORT's opening frame stops being dim for that reason (its shipped frame mean goes 44.2 -> 94.3), not
  because it was relit — the same room, turned towards itself. ABATOIR CORE declares the bearing it always had
  and arrives identically on every deal; THE STACK still falls through to the shipped heading, because bringing
  its authored plateau into the seat's reach is the open half of this work.
- **The space past a room's far wall is air, not that room's own paint** (#19, PR #636). Looking beyond the
  last wall gave you a flat grey sheet, cut top and bottom by a dead-straight line and the same colour whether
  what lay out there was deck thirty metres away or nothing at all: the engine had no surface out there but
  answered anyway, with the room's material averaged to its own mean and lit only by ambient. Those rays now
  take the level's air at full fog — the value the horizon line is already filled with — mixed in by how much
  of the row left the map and ramped from the far radius, so the band reads as distance and nothing switches on
  as you walk past 22 m. Three of the four arrival views sit 1.5-3.3 luminance darker in that band and hold
  their overall exposure; `DEV.set('farvoid', 0)` puts the old sheet back for a side-by-side.
- **An enemy keeps his footing as he walks away** (#18, PR #638). The dark contact patch under a hostile is
  authored in metres, so the further he got the fewer screen pixels of it survived, and at 16 m it painted
  nothing at all on all four sectors — he became a cut-out pasted on the wall behind him, which took away the
  one separation cue that was supposed to work without any lamp. His patch now grows with range past a 4 m dead
  range, continuously, so a hostile walking away keeps a base instead of lifting off the floor. Inside 4 m
  every pose renders the same pixels as before, and a crate's or barrel's contact band is untouched.

### Fixed

- **THE STACK's upper floor is lit** (#199, PR #637). One fixture now stands at the north end of the storey the
  finale builds over you — the one band of that level no lamp's disc ever reached, its nearest fitting having
  stood 8.9 m away against a 7.2 m disc. Cells of the sector under no light at all drop from 336 to 156 of 3072
  (10.9 % to 5.1 % over the same twelve deals), and looking south from that storey reads lit to the far wall
  instead of going near-black by mid range (frame mean 61.9 -> 94.5 at that seat). What stays dark stays dark
  because it sits near the edge of a lamp's own falloff, not because nothing was ever placed to reach it.

### Known limitations

- **The far field is half fixed** (#19). The change above covers rays that leave the level. A far ray that
  stays *inside* the map still ignores the fog law, so a room forty metres out reads as bright as one at
  twenty-two (#616) — the band's brightness for those rays is the next thing to correct.
- **The gun in your hands is still mostly silhouette** (#587). A carried pistol's barrel, magazine and grip
  contribute no pixels at the hip and the shotgun and rifle a few hundred each; what should be rounded parts is
  one flat slab, and two of the three guns' parts turn out to sit behind the rig's own near plane rather than
  behind other geometry. Lowering the tubes and raking the grips were measured and do not help. The per-weapon
  shortfall is printed by `tools/view.js viewmodel` instead of being argued from prose, and closing it is open.
- **A hostile ten metres out can still lose to the wall behind him** (#416, #611). The separation check gained
  two arms that price what the room is doing: on ARCHIVE SUBLEVEL wall grain accounts for only 11 % of the
  busyness delivered behind his outline, and flattening the lamp field makes that region *busier* rather than
  quieter, so no surface or lighting change buys him the edge — it has to come from his own edge. The
  deal-by-deal sweep now reports the deal closest to failing rather than the last one measured, which surfaced
  an ABATOIR CORE deal at a tenth of the brightness bar. That deal is now measurable; it is not fixed yet.
- **The glow overlay still carries no altitude term** (#221), so a conspicuously dark frame can survive a
  correct lightmap, and no placement pass is planned for it — the fix belongs to the shade side.

## [v1.4.12] - 2026-10-21

### Changed

- **A generated sector has more than one ceiling height** (#548, PRs #564, #612). Every room-shaped space a
  level deals now authors ceiling of its own: the big room reads tall, the small room reads low, and the
  corridor between them is the thing you duck through. Before, every room on a dealt level carried the same
  four units of air, so the roof was one continuous plane with no seam and no end anywhere in the frame, and a
  six-cell room wore the same lid as the atrium — which is why "the frame is floor, roof and a sliver of wall"
  survived the change that was supposed to answer it. Every dealt sector now puts at least two room ceilings in
  the world, so the eye gets a second plane to measure the first one against, and the wall you can walk up to
  runs well above your eyeline instead of sitting in a band over your head. Corridors, doorways, crawlways and
  ladder columns keep exactly the air they had, and no floor, step, slab or stair moved: the level deals the
  same geometry cell for cell.
- **Stairs, pits and platform edges show the surface your ray actually reaches** (#518, PR #584). A floor pixel
  whose ray slipped under a slab used to be painted at the distance of the plane *beyond* the crossing, so the
  far deck stretched across a hole, the bottom landing was painted over the first treads, and the surface past
  a raised band's edge smeared out to the horizon. That one wrong distance was the shared cause of three
  separate complaints — stairs looking warped (#515), a pit reading as a table from the deck above it (#516),
  and a platform's own edge not being a place you could read (#517). All three are gone with the one fix; the
  ordinary case, a floor you can see straight down onto, is unchanged pixel for pixel.
- **The corner of every frame is a hand, not a crate** (#562, PRs #567, #613). The mass under the gun finished
  in a flat right-angled cap with the back of the hand a plate aimed straight at the lens — two flat faces at
  one depth is what a crate is made of — and it was painted the same tan as a crate. It is now a tapered fist
  with a knuckle end and a wrist end, a lit side and a shaded side, wearing worn dark leather that reads
  clearly cooler and darker than a crate at the same light; the cuff block is gone and what leaves the bottom
  edge of the picture is fist, wrist, forearm, with no rectangle in the outline. The forearm takes the same
  size ramp the fists do when you bring the gun up, so the wrist doesn't stay put while the hand shrinks to
  the grip. The gun's size, position and sway are unchanged.
- **An enemy keeps his own colours in a tinted room** (#611, PR #615). His paint used to have the dealt room's
  lamp hue multiplied over it, so in a room whose hue sat close to his kind's — a blue-grey grunt on a
  blue-grey wall, a maroon brute on pink — he was the wall's colour family with a bump in it and resolved a
  beat late. The room's cast on a body is now cancelled in his pigment, so at 8-16 m what reaches the eye is
  his own material while the wall behind him keeps the room's hue. He separates from his background in every
  dealt room rather than only in the favourable ones. In the strongest tint this also lifts him a little in
  brightness, which is the useful direction: he was darker than the wall behind him.

### Fixed

- **A room is lit as one space, not as a chain of pools** (#199, PR #585). Lamps read as isolated tables of
  light with a near-black plain between them, because the falloff curve's tail puts the deck at 0.04 of a
  source at four fifths of its radius — and nearly all of the dark floor in a dealt sector sits *inside* a
  lamp's own disc, so it was the curve, not a coverage gap. The floor a curve leaves under the floor level now
  sits at that level instead: a lit cell keeps its exact value, so nothing gains light for being near two
  lamps. Dark open floor roughly halves — 2.8 → 1.6, 9.6 → 7.2, 5.7 → 4.3, 16.8 → 10.9 % of open floor on the
  four sectors — while the overall lightmap mean barely moves, so a lamp still reads as a lamp and the room's
  size is readable from its ground.
- **The front page shows the build that ships** (#578, #533, PRs #604, #609, #614). All eight frames on the
  project page were re-taken from the deployed build rather than from a diagnostic render, and the two
  crate-distance frames the barrel work asked for are in place, so the pictures describe this game.

### Known limitations

- A camera that faces a raised band with no lamp standing on it still shows black floor there. The deck lift
  is deliberately band-aware and will not spill the floor's light up a riser, so this half of #199 is lamp
  *placement* on raised bands, not another falloff term.
- THE STACK, the hand-built finale, authors one room clearance: its ceilings come from plan glyphs and the
  new per-room rule never runs there, so the last sector still reads flatter in height than the three dealt
  sectors before it. (#548)
- Nothing you can stand on is an underside over the room you wake in — a raised step is one unit up while a
  room's ceiling sits four units over its own floor, so no step placement can be a ceiling above you. A real
  second storey (#353) is owed before that reads. (#548)
- More air per room puts more roof in the frame, so the roof's own brightness work (#495) matters more after
  this, not less. Measured here, no sector's roof share rose and one ratio moved 0.80 → 0.77, still above its
  bar — but the pressure is now in the same direction twice.
- The magnified ceiling term for the near-band hairline comb ships switched off (#19, PR #610). It is sound
  and free, and an earlier claim that it fixed the comb was wrong: measured against the shipped build, one
  sector moved for real and three moved by nothing to one point, because the near band is owned by the light
  gradient and the slab geometry, not by the texel. The term stays in the build behind a development switch
  with a probe row that can fail if it stops reaching, so the next take starts from a measurement.
- A hostile's separation is now shown by existing contrast rows rather than gated by its own per-sector pair
  of bars, and the front-page hero frame has not been re-taken for it. (#611)

## [v1.4.11] - 2026-10-20

### Changed

- **Looking up reads a ceiling now** (#495, PRs #589, #599, #600, #601). The roof covers 40-50 % of a standing
  frame and was the flattest, darkest thing in it: a flat sheet with a fan of aliased speckle near the horizon.
  Its detail was simply too fine to survive — a ceiling is drawn at tens of centimetres per pixel, so the
  distance filtering averaged the texel speckle away and delivered a mean. Every ceiling material is now broken
  into slab bays about 0.45 m across, which are two, four and eight pixels wide at the near, mid and far
  distances a roof is actually seen at, so a joint stays a joint: panel seams read as bays, rock strata read as
  slabs, the hide in ABATOIR CORE reads as stretched sheets. The bays are laid out to average exactly zero, so
  no ceiling gains brightness for being detailed. Each sector's roof was then re-valued against its own deck and
  the decks give part of it back, so the frame is traded rather than brightened: ARCHIVE SUBLEVEL's roof moves
  from 0.49 to 0.68 of the floor you walk on, RING TRANSPORT 0.45 to 0.70, ABATOIR CORE 0.59 to 0.65, and
  THE STACK's vault keeps its own paler instance of the same rock. Ceiling brightness still cannot out-shine the
  deck it spans, lamps and geometry are untouched, and no sector's overall exposure moved out of its window.
- **The gun's rounded parts stop being one flat value when you aim down the sights** (#587, PRs #594, #595).
  Two separate faults. The surface added to the weapon last release was computed and then thrown away by the
  mesh builder, so the barrels, magazine tubes, stocks, grips and trigger guards still left the builder with no
  shading at all and painted flat. And the wrap-around shading that makes a pipe look round had been switched
  off for the whole weapon on the reasonable-but-wrong grounds that its pipes are too thin to carry it. They are
  too thin for *stripes*; they are not too thin for one wave around the part, which is what a faceted barrel
  reads as at this art scale. The pistol's grip, the shotgun's pump, grip and stock and the rifle's grip and
  stock now read as turned wood and polymer instead of slab. Thin parts — barrel crowns, magazine tubes, trigger
  guards — deliberately keep their lengthwise machined rings and no circumferential band, so they don't shimmer.
  The weapon's silhouette, size and brightness are unchanged and hip-fire frames are pixel-for-pixel identical;
  the roundness arrives when you bring it up.

### Fixed

- **There is one crate in the game** (#386, PR #596). The hand-built finale placed its cover at the scale its
  plan was drawn at, while every generated sector places crates 28 % smaller. Same prop, a third taller on
  screen and a wider obstruction to walk into — so the last sector's cover was not the cover you spent three
  sectors learning to shoot around and squeeze past. Both placement paths now read one scale, the one you
  actually learn. Lamps and barrels already agreed and are untouched.

### Known limitations

- The weapon's thin tubes still read flat in their second dimension; only their lengthwise machining is
  present. Giving them a circumferential band needs the shading amplitude split per term, which is not done yet.
  Parts emitted later also still repaint the hip pose's tubes wholesale. (#587)
- ABATOIR CORE's arrival frame reaches 0.65 roof-to-deck, just under the 0.7 the roof work set out for. Its paint
  is now at full parity with its own deck; the remaining deficit is the additive half of the delivered pixel —
  exposure lift and bloom compress a ratio — and that frame sits close to an exposure gate, so buying the last
  0.05 there is a different problem than painting. (#495, #505)
- Crates are now consistent in size but still one design; the finale reads as the same prop repeated.

## [v1.4.10] - 2026-10-19

### Changed

- **Your rifle finally has a surface** (#587, PR #588). Holding the gun at the hip, the receiver, dust
  cover, magazine and grip now read as machined metal with a legible light direction, the way a crate
  already does. Until now the viewmodel was the one object in the game painted flat — a grey solid in the
  bottom-right of every frame, in front of a world whose walls wear one of twenty detailed materials. Each
  face carries a shallow gradient with a few discrete steps of grain, and the detail is built to average
  out to nothing: the gun's overall brightness does not move, and the fists, sleeve and muzzle flash are
  pixel-for-pixel unchanged.
- **A barrel is no longer three flat bands of colour** (#533, PRs #579, #581). Grain now runs *around* the
  drum, at about the order of detail of the deck it stands on, and it stays put as you walk past. The
  cause was geometric: a barrel's structure coordinate was the ring vertex's linear position, which is
  constant on the two diagonal side faces of the drum, so half of every barrel in the world was being fed
  no detail at all while the crate next to it carried three times as much per pixel. Faces are now paired
  pixel-for-pixel at both levels of the distance coarsening, so barrels gain no light for being detailed —
  a barrel's mean is 26.3 here against 26.4 before.
- **The roof gets its brightness back on two sectors** (#495, PR #586). Roughly half of a standing frame is
  ceiling, and RING TRANSPORT and THE STACK had their whole sector dimmed by about five lumas to hold up one
  corridor's wall-to-roof corner. That corner is now held where it actually lives — at the junction, whose
  local cap was paying rows past its band nothing and, worse, multiplying them *up* — so the sector-wide
  dim was rolled back to its authored values. THE STACK's arrival roof reads 0.72 of the deck under it
  (was 0.59), RING TRANSPORT 0.46 (was 0.39), ARCHIVE SUBLEVEL 0.48 (was 0.45); ABATOIR CORE is unchanged.
  You read the panel grid and the rock instead of a dark wash, and no ceiling out-shines the surface it
  lands on: all six graded poses on all four levels stay at least 15 lumas under.

### Fixed

- **A raised floor's edge is now drawn at its edge** (#517, PR #583). Standing on a raised deck and looking
  down its lip, the crease belonging to the *far* floor — the one at the foot of the slab, a floor you are
  not standing on — was multiplied onto the deck a step short of the edge, so the place you are about to
  walk over was marked by a band of shade lying on flat floor. At THE STACK's face-lip frame that band sat
  96 rows below the last pixel of the slab's face, and 190 of 240 columns carried their strongest edge there
  instead of at the lip. One edge now marks the lip, and a down-lip crease on a dark deck gets its strength
  back through the same authored edge term a lit deck already uses. Movement is untouched — a one-quantum
  crossing stays walkable.
- **Looking up at a step no longer crashes the renderer** (#517, PR #583). When a lip sat above the top of
  the frame, the row the lip clip kept came back negative, the wall row loop started off the top of the
  screen, and on a level that authors no accent colour the first test to hit that path threw a
  null-colour TypeError inside `castWalls`. Found by running the full probe roster rather than part of it;
  such a lip now keeps every visible row on the deck you stand on.

### Known limitations

- **The floor beside a height change still stores depth your ray never reaches** (#518, PRs #580, #582).
  Nothing on screen changed for this one, and that is the honest state: two renderer fixes have now been
  built against the acceptance poses and neither moved them. What shipped is the instrument the fix needs —
  the poses had been handing their own reference march *your own footing*, so anything farther away always
  fell back to the row's own distance and counted as wrong no matter what was drawn. With that corrected,
  the phantom counts drop to 1817 / 3240 / 1952 pixels (from 3001 / 3240 / 4380) at the staircase, the pit
  and the band's edge, and every phantom pixel now names which pass wrote it — the row's own fill, the
  deferred copy, or both. Three different fixes, and this build is the first that can say which is which.
- **The roof is still under-bright at three of the four arrival seats** (#495, PR #586): 0.72 of the deck at
  THE STACK, 0.48, 0.46 and 0.54 elsewhere. The junction is no longer the reason; exposure headroom is. The
  ceiling is 41-49 % of the frame, so lifting it to 0.7x costs about +5 lumas of frame median, and the
  exposure gate leaves ARCHIVE and RING 9.7 and 9.5 lumas under its top anchor and ABATOIR 4.3. That is
  #505's call, not a number to move here. ABATOIR CORE authors no ceiling lift at all, so its 0.54 is the
  derived cap's ceiling, not a dose.
- **A floor above you still reads as a ceiling, not a floor** (#421). This build fixes the from-above half
  of #517 — the lip you stand on — but a slab seen from underneath is still open work. **The fan of radial
  streaks on distant floors and ceilings is still there too** (#19); neither is changed in this build.
- **Prop brightness is still out of the room band at seven seats across the four sectors** (#371), and the
  README's eight frames are still bound to an older build than this one (#578).

## [v1.4.9] - 2026-10-18

### Changed

- **A lamp now reads as metal standing in the light it throws** (#371, PRs #566, #570). A lamp's painted
  post, foot and shade were brightened as if they were part of the bulb, so in a dim room the fixture was
  the brightest solid in its part of the frame and the pool of light on the floor under it was *dimmer*
  than the metal standing in it — which is backwards, and it made a row of lamps read as a row of glowing
  sticks. The bulb itself is untouched, byte for byte; the fixture's metal is now dark enough that the
  order reads post < base < bulb. On the four sectors, lamps over the brightness bar went from six to
  one, and the one left is named below.
- **A barrel no longer earns extra light for being round** (#371, PR #574). Prop shading was centred on
  the flat faces of a box, but a drum's curved side always shows *some* face to the key light, so every
  barrel in the game collected about 10% more light per pixel than the crate standing next to it in the
  same light. Drums keep their lit side and their shaded side — only the average moved — and barrels and
  crates now sit in the same band as the rest of the room's props.
- **Three more sectors put their ceiling under the walls it covers** (#369, PRs #571, #576). Looking up
  in ARCHIVE SUBLEVEL, RING TRANSPORT and THE STACK gave you a roof that read *brighter* than the walls
  rising into it, which erases the one junction the eye sorts a room by: you could not tell where the
  room ended and the storey above began. Each of those levels now carries a deliberate value order for
  its surfaces, so the wall-to-roof corner holds and a lit vault reads as a lit vault instead of a wash.

### Fixed

- **A single step now looks like a step** (#517, PR #558). A one-quantum rise — a low mezzanine, a
  poked flight of treads, a kerb — drew no riser face at all, because the renderer asked a walkability
  question ("can I step up this?") where it should have asked a drawing question ("is there a face
  here?"). So a step you could walk up had no visible edge, no side face, and the deck beyond its lip
  appeared to solve *through* the step's own volume. Every step you can walk up now draws its face and
  its edge. Levels with no height changes are byte-for-byte unchanged.
- **Enemies sit on the deck instead of floating above it** (#18, PR #569). The shading that separates a
  body from the floor was painted as a disc centred under the silhouette — where the body itself covers
  it — so at any useful distance a grunt looked pasted onto the floor. That shading now lands just
  outside the feet, lighter where it spreads over more floor, and reads as a contact band you can see
  even when an enemy is edge-on. A grunt now looks like he is standing on something.

### Known limitations

- **Looking at the floor still shows a fan of radial streaks toward the vanishing point**, most obviously
  on floors and ceilings at distance (#19). This build adds the measurement that rules texture tiling out
  as the cause — coarsening the ceiling tile four-fold moved the streak score 27 → 30 and made the
  picture mushier, so the shipped tiling stays — which means the cause is still unidentified, not
  narrowed.
- **Looking down at a raised band, three views still answer the wrong distance** (#518, PR #559). Up a
  staircase, 3001 of 4620 sampled floor pixels store a depth farther than their own ray arrives at
  (walked 3.2 m against the adopted plane's 10.4 m); at the lip of a pit, the far riser's rows answer at
  3.5 m where the authored geometry says 8.5 m; and at a band's drop face the stored depth does not step
  where the face ends. These three are one defect seen from three seats, and the poses that measure them
  are now in the harness so the fix has something to be graded against.
- **One lamp still sits just over the brightness bar** (#371, PRs #557, #560, #565). The fixture in
  ARCHIVE SUBLEVEL is metal standing inside the brightest pool in its room, so the one value that makes a
  crate read right in an open hall leaves that lamp over the line — brightening the room's props as a
  group cannot fix it without dimming every crate. What changed this build is *how it is charged*: every
  prop is now measured against the deck beside itself rather than a room average, so the remaining
  offender is a named seat with a number instead of an argument.
- **Contact shading is one ring shape for every body** (#18). A grunt, a drone and a heavy all cast the
  same soft band; only its radius differs.

## [v1.4.8] - 2026-10-17

### Changed

- **A staircase now looks like a staircase** (#515, PRs #539, #540). Walking up to a flight, the deck
  read as a warped flat plane and the floor of the room *beyond* appeared to solve up through the steps
  themselves, so a staircase set in a wall line read as a ramp that is not there. The treads and side
  risers are now solid geometry with an edge you can see, and they wear the level's own wall material
  rather than a concrete no level is built from. Reported from live play: "stairs do not render and look
  like some weird warped view."
- **The floor you see is the floor your ray arrives at** (#518, PR #534). The ground pass answered a
  floor pixel by solving an infinite plane and painting whichever cell the solve landed in, so it
  adopted any *lower* floor further along the ray. Down a staircase you were shown the bottom floor's
  surface at the distance of a solve past the stairs; looking into a pit from the deck, the far lip's
  side was painted with the far deck's texture, at the far deck's distance, under the far deck's light;
  and the band you stand on lost its own far edge, because past that edge its surface was the deck plane
  run out to the horizon. The floor now walks the ray and stops at the first surface genuinely in the
  way — the question the ceiling half has asked since #170.
- **The face that caps a raised deck wears the room's own stone** (#518, PR #538). Every drop face in
  the game wore the same grey concrete — a material in no level's palette — so THE STACK read as ashlar
  walls meeting concrete edges. A drop face in an ashlar room is ashlar now, a drop face in a metal room
  is metal, and the joint between a deck and the face rising out of it is two materials that belong to
  the same room. Levels with no height changes are byte-for-byte unchanged.
- **Where the roof meets the side of a raised band, there is now a corner** (#369, PR #541). That
  junction was the one place in a vertical level where the roof ran straight into a slab side with no
  edge between them, so the frame could not say where the room ended and the storey above it began. The
  roof's junction band was skipped on exactly those columns, and its width was solved from the raised
  band's *floor* rather than the ceiling above it, which collapsed it to a pixel or two. The face-minus-
  roof gap at the lip reads +3.9 → +10.9 on RING TRANSPORT's main pose and -24.2 → -14.6 on ARCHIVE
  SUBLEVEL's. Every other pose, including all four look-up poses, is byte-identical.
- **The line where a room stops and its roof starts now holds across the whole corner** (#369, PRs
  #542, #543). In ARCHIVE SUBLEVEL and RING TRANSPORT a roof could read brighter than the wall it lands
  on, which erases the one junction the eye sorts the frame by: the bound that is supposed to keep the
  roof under the wall applied to a single screen row, while that corner is read over the eight rows
  nearest it. Median face-minus-roof gap is now ARCHIVE 22.6 / 19.5 / 14.9 / 21.2 / 24.7 (was
  14.4 / 0.3 / 3.2 / 13.0 / 17.4) and RING 15.0 and 11.2 (were -0.1 and 4.7). A roof already sitting
  below the line is written by the crease alone, byte for byte.
- **A crate and a barrel have a surface now, not three flat colours** (#533, PR #535). Props were fed no
  surface structure at all, and where they did get some it ran in one screen direction only, so a crate
  read as corrugated — ridges running straight down the box — rather than grained. Up close a crate's
  faces now break into 6 levels where they broke into 3, and that structure varies in both screen
  directions at the same brightness.
- **A crate stops outshining the room it stands in** (#371, PR #554). Furniture was lit through the
  branch that draws enemies, which adds a directionless fill whose only job is to stop a hostile
  arriving as a black cut-out at engagement range; no wall, floor or ceiling in the game carries it. A
  crate in a dim corridor therefore arrived as a lit card — brighter than the wall behind it and brighter
  than the deck under it, with no side of it in shadow. Enemies keep the fill. Furniture is now lit by
  the room it is standing in, and nothing was dimmed to get there.

### Documentation

- **The front page's eight frames now say when they have gone stale** (#536, PRs #545, #550, #553). The
  claim "this is the game as it ships" went false four times without anyone noticing, because a frame
  records a build and render work keeps landing. The frames have been re-taken off the build that ships,
  and a blocking check now compares the files that draw a frame against the files those frames were
  taken from, naming the one that moved. Nothing on the screen changes.

### Fixed

- **A storey that stands over a room without touching it is recognised as a floor above you** (#518,
  PR #547). The test for "is the ceiling over my head somebody else's floor" looked at the eight
  touching cells and stopped; it now looks up to four cells out, and refuses a floor that merely equals
  the plane already drawn there. No level dealt today stands a deck over a lower room, so the four
  sectors are unchanged as they ship — that is the measurement, not an omission, and a new `planes` row
  prints the count per deal so the claim stays a tool rather than a sentence. A synthetic overhang is
  classified correctly where the old rule left it plain ceiling.

### Known limitations

- A slab's side still presents one band where a tread face, a soffit and a void are three different
  spans, so a pit still reads wrong when seen from the deck above it (#518).
- THE STACK's own spawn pose still reads its roof-to-wall gap at 10.3 against the 15 bar. Three
  formulations of that bound all leave it near 10, so what inverts there is the deck's delivered light,
  not the corner term (#369).
- The generator raises a band by exactly one clearance, so nothing yet stands a floor *over* a lower
  room: the way up is visible from where you start, but you do not still see a second storey from
  beneath it (#518).
- Whether a staircase reads right on the live page is an open look verdict, not a passing row (#515).

## [v1.4.7] - 2026-10-15

### Changed

- **The ceiling stopped being a black sheet** (#495, PR #502). The roof is the largest surface in a
  standing frame — 41–50 % of what you see — and it was drawn at a third to a half of the brightness of
  the deck it covered, with no material in it. It now reads as a surface: panel grid, rock and its own
  shading are visible, and it sits at 0.56–0.74 of the floor under it instead of 0.41–0.57. THE STACK got
  its own rock paint so its vault lifts against a pale deck without washing out. Nothing got brighter
  overall: the lift is paid per sector out of that sector's own headroom.
- **The line where a room stops and its roof starts is drawn** (#369, PR #526). In ABATOIR CORE the wall
  used to run up and become its own roof — one red, three surfaces, no edge. A crease now runs along that
  junction, 0.6 m of ceiling deep, keeping its metres at any distance so it thins to a line far off
  instead of smearing. A high room reads as high. This spends no brightness to say it.
- **THE STACK's finale stopped looking like an overexposed photograph** (#503, PR #509). The floor you
  spawn on delivered 148 luma with 13.3 % of it past the clip point, so a lamp's pool could only blow out
  further and a body in the open read as a dark speck on white. A lamp's colour may no longer add
  brightness it isn't entitled to: that deck now delivers 98 luma with nothing clipping, in the same band
  as the other three sectors, so a lamp has room to rise above the floor it lands on.
- **A crack in a wall reads as a groove instead of a black hairline** (#416, PR #527). ARCHIVE
  SUBLEVEL's brick carried its cracks as a one-texel line about 110 luminance below the brick face, which
  is a crack up close and per-pixel noise past a metre — and, being the sharpest thing in the frame, it
  made a body at 10 m look flat by comparison. The groove is now wider than the texel that samples it and
  its dark is a shadowed brown. Surface relief is untouched; it is still the darkest thing on the face.
- **Enemies, crates and barrels now sit on the deck instead of floating over it** (#18, PRs #511, #531).
  A crate's base carries a visible dark contact band (6.4 % of its silhouette area against 1.6–2.6 %
  before), and an enemy's base band is 25–28 % deeper on every sector, so at combat range a hostile reads
  as an object standing in the room rather than a dark cutout pasted on the far wall. It is a multiply on
  the lit ground, so the cue survives the lamps going out.
- **An enemy at the far end of a march keeps his surface** (#416, PR #513). A grunt at 10 m arrived with
  one luminance per face — less local structure than the deck behind him — because the seam term was
  switched off just inside combat range to avoid shimmer. He now draws one coarser level of the same
  pattern instead of dropping it: his own surface reads 2.93 luma per screen pixel where it read 1.40, at
  the same brightness, so a body walking through that range boundary changes which seams he wears, not how
  bright he is.
- **The raised storey a level builds now reaches the room you wake in** (#421, PR #514). The generator
  used to place its plateau wherever a quadrant boundary happened to fall, usually the far side of the
  map. On ABATOIR CORE the number of columns within 12 m of your spawn that have a floor over their head
  goes from 0 to 14: the riser, the lip you can shoot over and the floor above it are now inside the
  distance the frame can actually resolve, and the way up starts near where you begin. Deals that already
  put something over the entry room are unchanged, byte for byte.
- **RING TRANSPORT has one deliberate mark on it** (#466, PR #500). That sector was so consistent a
  cold blue-grey that nothing in it looked placed on purpose. Every deck lip and stair nosing now carries
  a painted amber edge — a continuous warm line tracing where the platform actually is, at 1.5–2.1 % of
  the frame's coloured pixels.

### Added

- **Every room says what it is for, even in one open hall** (#422, PR #463). Rooms now get a wall fixture
  that names them — shelving, a tank with a sight glass, an arrow board by a doorway. RING TRANSPORT is
  dealt as one hall with no interior walls at several generator seeds, so the per-room pass found no wall
  to mount on and placed none anywhere; it now mounts on the first wall that room looks straight at, and
  places five on each of those seeds where it used to place zero. A fixture too small for the face it
  landed on is swapped for one that fits.
- **There is a hand on the gun** (#499, PR #508). The weapon is no longer one grey slab: a cool steel
  upper over a warm polymer lower with a parting seam between them, and a fist that reaches the frame at
  hip — the lower right of a spawn frame used to hold no skin-toned pixels at all.

### Fixed

- **A verdict that depended on which machine ran it** (#505, PR #512). The first-frame brightness check
  compares your arrival frame against a band, and one sector sat 1.5 lumas under its top — close enough
  that the same build passed on one runner and failed on another. The film-grain phase is now pinned on
  every measured frame (worth up to a luma of runner, not of code) and the gate renders its own failure
  anchors instead of trusting a transcript, so the budget it is operating on is printed with the verdict.
- **The finale's exit was scored against somebody else's map** (#421, PR #514). THE STACK's reachability
  check was reading the previous level's distance field at the wrong stride and had been printing `ok` by
  arithmetic luck; it now scores each level from its own field, seeded at the square the player actually
  stands on rather than the generator's own centre cell.

### Documentation

- All eight README frames are recaptured from the build that ships (#468, #431, PRs #532, #530), each
  served file byte-compared against the deployed build before the shutter, with a provenance row per frame
  in `docs/screens/provenance.json`. ABATOIR CORE's pair is a different room now — the level work above
  re-dealt that seed — and THE STACK's frame is a step dimmer than the one it replaces.

### Known limitations

- **Two sectors' roofs are still short of where we want them.** RING TRANSPORT reads at 0.583 of its deck
  and ABATOIR CORE at 0.530; lifting them further costs about 5 lumas of frame median at 41–50 % coverage,
  which is the entire distance from their arrival frames to the top of the brightness window. Getting them
  up means either something else in those frames giving way or re-deriving the window from its anchors —
  both bigger than a paint commit. #495 stays open.
- **The arrival frame has very little room under its ceiling.** The four sectors' first frames now sit with
  1.4 to 15.8 lumas to spare under the top anchor. That number is now printed instead of discovered in a
  failed run, but it has not been bought back: #505 stays open, and re-deriving what the top anchor means
  is a review decision, not a paint decision.
- **An enemy's grounding band is deeper, not wider.** Widening his radius is measured and does not fit the
  sanctioned shadow-area cap (1.3–1.7× at the next step up). The cap has to be re-derived from each
  caster's own footprint before a wide ring can ship, so #18 stays open with the prop half landed.
- **One long-range readability row is still debt.** ARCHIVE's 10 m body misses its bar by well under one
  luma of outline step, and no material pays it: flattening that seat's deck grain moves the background
  busyness by 0.01 and its light field moves the other way. #416 stays open.
- **A staircase near a lamp is the loudest thing in its room** (#466, PR #500). The painted lip band covers
  every riser on the level, stair nosings included. Excluding stairs is a one-clause follow-up if wanted.
- **THE STACK's plateau is where it always was.** That level is a hand-authored plan, so moving its raised
  band is an edit to the plan's altitude rows, not to the generator. And you still do not arrive *facing*
  the storey above you — that is the arrival-heading half of #421, still open.
- **Not every overlook deck is lit.** 4/5, 3/5, 7/8 and 1/1 overlook decks on the four sectors read lit
  from a source on their own band, and none of them is lit by a rule — every lit deck is the deal's
  accident. The count is now measured and printed (#353, PR #520); lighting those decks is not done.

## [v1.4.6] - 2026-10-13

### Fixed

- **Floors stopped throwing bright wedges out of the vanishing point** (#19, PRs #493, #494, #498).
  Every screenshot of this game showed a fan of pale lines running away from the camera across the
  deck. Three separate causes were found and fixed, each in the band where it actually lived. Deep
  in the frame, a minified floor pixel was handing most of its own area to a *single* texel of a
  coarser material — one stretched, hard-edged sample — and it now averages the area it really
  covers; that alone takes the floor streak from 52 / 66 / 64 / 69 down to 43 / 56 / 55 / 60 across
  the four sectors. Close up, within a metre or two, a floor pixel covered less than one texel and
  was reading one texel with a hard edge; it now takes the same four-tap fetch every wall and body
  in the game has always used, so the lines under your feet are gone without the picture going
  soft. And on RING TRANSPORT the deck's diamond plate and the panel ceiling's grid repeat faster
  than the far texture levels can honestly carry, so those levels now fade toward the material's
  own average instead of keeping a broken copy of the pattern — that sector's floor streak goes 55
  to 42, and its deck stops strobing along the sight line. Ridges are exactly as sharp as they were
  directly below you: level-zero texture is never mixed. The remaining streak is measured, bounded
  and still open on #19 — see *Known limitations*.

### Changed

- **Crates and barrels stopped being the loudest thing in a dim room** (#371, PR #491). Painted
  prop faces are 12% darker, so a wooden box reads as a solid standing in its room rather than as a
  saturated orange card in front of a dark wall. Sweeping every seat in each sector — not just the
  four arrival cameras the earlier pass looked at — the count of seats where a prop outshines the
  deck it stands on falls from 3 to 0 (ARCHIVE SUBLEVEL), 1 to 0 (RING TRANSPORT), 3 to 0 (ABATOIR
  CORE) and 1 to 1 (THE STACK). Lamps are untouched: a lamp is still the warm thing that says *that
  room is lit, you can walk there*.
- **The stone decks of ARCHIVE SUBLEVEL and THE STACK lost their green** (#466, PR #492). Those two
  sectors are grimy stone under an amber lamp, and their floor was the one surface wearing a damp
  vegetation green nothing else in the room has. The flagstone mottle is now a dry lichen brown at
  the same brightness: at ARCHIVE's arrival seat the deck-to-wall hue gap closes from 27 degrees to
  12 and the room reads as one interior. No exposure moved and the other two sectors are unchanged.
- **ABATOIR CORE's floor is no longer the same colour as its walls** (#466, PR #497). The deck's
  authored hue sat nine tenths of a degree from the wall's, so the only thing telling you which side
  of a lip you were on was whether a lamp happened to be shining on it. The floor now reads cooler
  and drain-dark against the wet muscle of the walls — floor band h10 to h358 with the wall held at
  h8, at identical luminance — so the room reads as built rather than wrapped.
- **Every screenshot in the README is now a picture of the game that actually ships** (#468, #478,
  PRs #489, #501). All eight frames were re-taken in one pass from the deployed build, with every
  served file byte-compared against that build before the shutter, and each now carries a provenance
  row (bytes, build, level deal, pose, frame statistics) in `docs/screens/provenance.json` instead of
  a caption that may or may not describe it. Two capture bugs were fixed on the way: a page left
  painting while a harness polled silently re-dealt the generated levels, and the pulsing exit-portal
  overlay made the frame's brightness a function of wall-clock time. Captions were rewritten where
  this build no longer produces the thing they counted, and still say plainly what reads flat.
- **The texture-streak check can now say which distance band a streak lives in, and can fail a
  build** (#19, PR #496). Earlier passes reported one number per surface, which is direction- and
  distance-blind, so six rounds of this fix argued about *where* the defect sat. The streak is now
  bucketed by each pixel's own solved distance, and the census now blocks the build when it stops
  accounting for its own frame instead of printing a tidy table over the failure.

### Known limitations

- **The fan is quieter, not gone.** The residual on floors and ceilings sits inside about four
  metres of the player, where the fetch magnifies a single texel and what varies across a row is
  *which* texel it stands in. Two further mechanisms were built and measured against that band —
  reading the whole footprint up the texture chain (#504) and fading a distant ceiling toward its
  material's own average (#506) — and neither carried the case, so both shipped switched off and
  change no pixels at the default. #19 stays open with the residual bounded by measurement rather
  than by argument.
- **One prop seat is still over the bar** (#371, PR #491). At THE STACK seat 2,2 props read +45.7
  luma over their own deck. That is a lamp's light cell, not the crate's colour, and a second paint
  cut was deliberately not applied — it would have dimmed every prop in the game to fix one cell.
- **A pale hard-edged wedge can still appear at a level's outer edge** (#375). How far away the
  renderer should *believe* ground past the level's boundary is is a separate open problem, and part
  of what looked like floor streaking belongs to it rather than to #19.
- **The README's generated-sector frames are still deal-bound** (#431). The level you arrive in is
  dealt from the random stream, so a caption naming a particular stair or lamp describes one boot of
  one build; the provenance table now states that rather than promising reproducibility it cannot
  offer. Captures record a null sample rate because the capture host exposes no audio device, so the
  deal they bind is device-scoped until #404 lands.

## [v1.4.5] - 2026-10-12

### Added
- **A crate now has a sunny side and a shady one** (#476, issue #371). Walk round a crate, a barrel or a
  dropped lamp and the bright face moves to whichever flank the room is actually lighting. Before this the
  two faces you could see of the same box sat only 18 luma apart: a prop's light was the room's ambient
  floor plus a lamp ramp, so the ambient half could never fall into shadow no matter which way the box was
  turned. Props now pay the same orientation tax a wall face has always paid - the whole light, ambient
  included, is scaled by which way the face points - centred so a prop's average brightness is unchanged.
  Face separation on a crate goes 94.8 -> 126.2 luma apart and on a barrel 73.9 -> 98.7. A prop is still
  lit by its room rather than glowing on its own: the lit/unlit control still reads x0.44.

### Changed
- **Props stopped outshining the rooms they stand in** (#371). Crate wood and two barrel materials were
  authored so bright that, after the sprite lift every prop gets, the lit face of a box sat *above* the
  deck it stands on - at ABATOIR CORE's arrival camera prop pixels read 153.7 against a deck of 89.2, and
  at THE STACK's the loudest thing in frame was a barrel, not the floor. The four loudest poses now sit
  +23.0 / +10.2 / +23.5 / -7.9 relative to their own deck, and no prop face pixel sits at a channel
  ceiling in any of them, so props take the room's light instead of clipping it away.
- **The rock ceiling above you stops being the rock under you** (#466). ARCHIVE SUBLEVEL and THE STACK
  painted their ceiling with the same moss that paints their decks, so those levels' ceilings read as
  damp concrete 9 degrees of hue away from the floor and the STACK's ceiling sat at saturation 0.02.
  Growth needs standing water at the foot of a wall; what reaches a ceiling is water that ran and dried,
  so the ceiling now carries a pale, cool mineral film stretched along the strata it already draws, with
  no growth at all. Ceiling-to-deck hue separation is 9 -> 28 degrees on ARCHIVE and 85 -> 169 on the
  STACK. The film is brightness-neutral, so no room's exposure moved and the other two levels are
  byte-identical.
- **ABATOIR CORE's ceiling is now part of ABATOIR CORE** (#466). Overhead in the abattoir was a mauve
  hide (hue 314) which, under the level's green lamp field, rendered as a silt-yellow slab - 41 degrees of
  hue away from the wall it meets, in the one level whose whole theme is a single red interior. It is a
  tanned membrane in that family now (hue 7.5), and the arrival seat reads ceiling hue 31 against wall 9:
  overhead still reads as overhead because it is *darker*, not because it is a different colour. Both paint
  terms were authored at the exact brightness of what they replace, so this is a colour change and not an
  exposure one - every seeded exposure median is unchanged - and the other three levels' ceilings come back
  byte-identical. With this tile repainted, all four sectors put their surfaces in one colour family at
  their own seat.
- **The README says which of its screenshots can actually be re-taken** (#431). Five frames of generated
  levels have been stale since one particular build, because the level you arrive in is dealt from wherever
  the random stream happens to have reached - so the stair flight or lamp a caption names belongs to a
  different world. The capture record now states both real terms (one boot per page load, and the build),
  names the build each stale frame was dealt from, and no longer promises a row is reproducible when it is
  not. No gameplay or rendering code is involved.

### Fixed
- **THE STACK's floor stops burning past the picture** (#369). The finale deck's extra floor light
  overcorrected: at the level's own arrival camera it delivered 121 luma with 0.09% of the frame past the
  showable top, so the largest surface in the shot lost its tread, its staining and its tile joints. It
  reads 118.3 now with 0.03% blown, and the rule that a vault may not outshine the floor it covers still
  holds. THE STACK is the only level that authors that term, so the other three levels are byte-identical.
- **THE STACK's screenshot matches the game** (#369, #431). The frame the README printed for the finale was
  one build behind once its deck was repainted; it is re-taken from the deployed build and its caption's
  numbers now describe those bytes.

### Known limitations
- Some props still read brighter than the deck they stand in. Grading a whole sector instead of four
  arrival cameras (#371) finds props over their deck by up to +28.0 (ARCHIVE SUBLEVEL), +55.7 (RING
  TRANSPORT), +32.1 (ABATOIR CORE) and +52.5 (THE STACK) at seats the earlier probe never aimed at. That
  sweep is a census and is not charged against any budget, so the paint there is still wrong.
- You still arrive without seeing the storey above you. Grading the frame the game actually hands the
  player - not a purpose-built look-up camera - measures 0 / 0 / 0 / 25 soffit pixels within reach across
  the four sectors against a bar of 8,000, with 19 and 28 soffit columns in reach of the ARCHIVE and RING
  seats. The undersides render; the arrival camera is not placed where they show, and that placement is
  the open part of #421.
- Five README frames of generated levels remain stale by build and cannot be re-taken to match their
  captions until #420 settles how a shipped capture pins its level.

## [v1.4.4] - 2026-10-11

### Added
- **A floor above you now reads as a floor, and it ends somewhere** (#461, #472, issue #421). Walk under a
  raised deck and look up. The plate over your head used to be the same flat dark sheet with one straight edge
  that is over your head everywhere else in the level, so you could neither tell the level had a second storey
  directly above you nor see where that slab stopped - the first thing you need before you try to shoot over
  it. The underside is now its own surface: a paler plated soffit with a joist rib every half metre running up
  toward the deck, a lit lip along the side the deck stands on, and a shadow gap where the underside stops
  against the ceiling. Across the slab's edge in the frames this was filed from the step goes from 3.4 and
  11.5 luma to 62.9 and 59.1, so the edge is the loudest thing about that boundary instead of a coincidence of
  lighting. Nothing about geometry, movement or the light budget changed, and a flat level draws byte-identical
  frames.
- **A tall room shows what lights it** (#456, #462, issue #413). A ceiling fitting let down on its stem now
  reads as one object: a single lit panel hanging a little above head height, on a rod that is brightest at its
  foot and fades up into the dark of the slab it disappears into, with the lens's own uplight reaching back onto
  that slab as a warm ring so the fitting's foot shows against a dark ceiling too. Before this the frame carried
  a bright panel and a flat black tick above it, with nothing at all on the slab it bolts through. A room's
  height now reads from what hangs in it. A low corridor's flush plate is untouched, and no light source moved,
  so no room's exposure moved either.

### Changed
- **ABATOIR CORE stops wearing a colour from another level** (#474, issue #466). Standing at its arrival camera,
  the room is a wet red interior - salmon fibre walls, a red cracked deck, a pale tendon ceiling - and then one
  face in five was quilted violet panelling with a magenta seam. Turn a corner and a fibre face meets a purple
  one. That face is now an oxblood panel with an amber seam, authored at the violet tile's own brightness so
  nothing gets lighter or darker and the quilt, the drainage and the darkness stay. The sector reads as one grimy
  interior with exactly one deliberate thing in it: the green lamp field overhead, which is the accent the level
  was written with.
- **The README describes the game** (#460, issues #395 and #401). Half of it had become a running account of
  every recapture of six screenshots, with the md5 of the page that served each shutter - none of it a
  description of the game, and every number in it rotted on the next merge. It is now 261 lines with a 60-line
  "How it looks", the capture record lives beside it, **ABATOIR CORE** is shown for the first time (#469), and
  THE STACK's frame is re-taken from the build that actually serves it, so the wall in the picture is the
  blockwork in the game rather than the masonry family four releases ago (#471).

### Fixed
- **An enemy at combat range keeps his room's light** (#458, issue #407). Every surface here composes its pixel
  the same way - texture times light, with the coloured air wash added on top - but one path multiplied its light
  by the haze *and* added the wash, so a body paid for the air twice while the wall two metres behind it paid
  once. That is why a hostile on the far side of a lit room arrived as a black cut-out with no front and no
  species. A body 16 m away now keeps about three times the light he kept, and at 8 m about one and a half times;
  five of the seven measurable distance seats are inside the visibility bar where one was. Distance is still
  paid for - by the wash, by the lamp field's own falloff and by the body's fill term - it is simply no longer
  booked twice on the one surface in the game that mattered. Close-range silhouettes and torso shading are
  unchanged.
- **Floors stop breaking into wedges in the near and mid field** (#467, issue #19). The deck's two-tap
  anisotropic fetch had its spacing truncated toward zero in one copy of the ground pixel instead of rounded, so
  over the band from half a texel to one texel of footprint it loaded the same texel three times, averaged
  nothing, and kept the point fetch's radial wedge - a filter that was on and inert, in exactly the band the
  distance blend hands off at. Two lines change, in both copies of the pixel body. Floor streak counts fall on
  all four sectors (56 / 71 / 72 / 75 to 52 / 66 / 63 / 69) and the ceiling's worst region with them. Mip
  *selection* is untouched: the deck directly under you is still full resolution and fine detail stays 3-5x its
  blur control, which is the difference between averaging an area and blurring the floor.
- **A lit prop face answers the lamp again** (#450, issue #371). A crate in a lit room had 75.6% of the pixels on
  its lit flank pinned at maximum red while the wall behind it pinned none, and a pinned channel cannot carry a
  gradient - so that face returned one number no matter where you stood or how bright the room was, the flat
  orange card floating in front of the wall. A prop face turned into the key was being lit up to 1.28x what the
  same light does to a wall. The over-bright part of that ramp now approaches full scale without reaching it:
  nothing is pinned, the face has a range again, and the mean moves by about one luma. A prop in a dim room is
  unchanged to the byte, and a lamp's aperture is still a light source.

### Known limitations
- An enemy at 16 m in ARCHIVE SUBLEVEL is still 22-23 luma *below* the surface behind him against a 20 bar, and
  one seat in RING TRANSPORT now reads 19 luma *above* it: a body does not pay the wall's own face falloff, which
  is the opposite complaint to the one just fixed. Neither is settled (#458).
- A slab's far edge, where it is in the frame at all, is now unmistakable - but you only see it in 1 of 6 standing
  poses on ABATOIR CORE and on THE STACK, because from most seats under a deck that edge is not on screen. That is
  a pose-coverage gap, not a shading gap, and no further term on that plane can put it there (#421).
- Near-field floor streaks fell by 3-9 points, not to zero (#19), and the wedge pattern in the far field is
  unchanged.
- In a low corridor the ceiling fitting is still a plate flush on the slab and only enters the frame from about
  1.5 m out, so up close you are inside it (#413).
- The rule "every room says what it is for" is still unmet in the open-hall level class; the work is written and
  on hold pending a design decision (#422).

## [v1.4.3] - 2026-10-10

### Added
- **A ceiling with a cause of light on it** (#437, #446, #448, issue #413). Every room now carries a
  light fitting on its own ceiling - a surface-mounted strip with a housing tray, recessed rim, warm
  diffuser and corner bolts - and the pool overhead comes from that fitting rather than from nowhere.
  Room height finally reads: a vault puts its fitting 4 m over your head, a low passage keeps it near
  the top of the frame. One fitting is also hung three to five metres ahead of the square you start a
  level in, so the deck in front of the arrival point is lit and the frame opens somewhere.
- **The wall you are facing has something on it** (#439, issue #400). Wall fixtures are mounted about
  every six metres down a face you can see down, instead of one object at the far edge of the map. A
  long wall now carries pipe runs, vent plates, shelving or a hazard band at eye height, and a room big
  enough to see into carries a second thing that says what it is for.

### Changed
- **Equally lit rooms read alike** (#438, issue #416). Every material was painted with its own albedo
  constants and nothing bounded one against another, so two rooms under the same lamp could be a glaring
  near-white tile and a murky dark panel. The brightest faces come down 15-20% and the darkest few come
  up about 10%, and the noisiest backgrounds - the meat and mossy-stone families - are quieter, so a
  body's silhouette does the separating rather than the floor behind it.
- **A lit floor stops arriving as one white sheet** (#440, #444, issue #377). The top of the frame's
  range now ends below the line where a pixel stops carrying a level, so a lamp pool on a pale deck keeps
  its gradient across the band that used to go flat white. The bright pass also can no longer push an
  already-bright pixel across that line at all, whatever a level author does. Standing by a lamp in THE
  STACK, the wall around the lamp keeps its surface; ARCHIVE SUBLEVEL's spawn frame goes from 1.22% of
  pixels clipped to 0.12%. Mid-tones, shadows and the muzzle flash are unchanged to within a luma.
- **THE STACK's walls stop being the same grey as their floor** (#442, issue #369). Wall faces now carry
  slightly more of the room's own light than the deck does, so a pit lip, a step and a ledge edge read as
  edges instead of continuing the surface you are standing on. A slab's exposed side still wears the deck,
  so a step still reads as floor - and the three generated levels do not change by a single pixel.
- **ABATOIR CORE's floor stops lighting itself** (#449, issue #416). Its vein network was painted as
  emissive texels, which the renderer counts as light sources: 5.6% of the deck sat at a fixed brightness
  in a dark room exactly as in a lit one, brighter than every wall face in the game. The veins are now
  raises in the hide - a paler, drier surface with a small crest - so the highlight sits where the lamp
  actually is and the deck dims when the room does.

### Fixed
- **THE STACK's dark down-step is visible** (#435, issue #385). The crease that gives every step its edge
  was purely a fraction of the pixel's own brightness, so on the one level that authors no lamps at all it
  bought half the depth it buys elsewhere and the step you can walk into read flat. It now carries a few
  lumas of absolute depth as well, fading out as the deck's own light rises; that lip now measures 53%
  contrast against the 45% the game asks for, and every lit step in the campaign draws as it did before.

### Known limitations
- The strip fitting sits flush with the ceiling slab, so in a tall room it leaves the frame roughly twice
  its headroom in metres out. At the ARCHIVE start the entrance fitting reads as a brighter wash on the
  sheet and a pool on the deck ahead of you rather than as an object, and ABATOIR CORE still delivers no
  ceiling pool its own cameras can measure (#413).
- Crates and barrels are still drawn square to the grid, so no face of a box ever falls in shadow and they
  read flatter and more saturated than the walls behind them (#371, fix in review).
- A hostile ten metres away still loses the unlit half of his silhouette to the wall behind him. The
  distance rows that price that half landed in this release; the shading half is still open (#407).
- A room whose every face is already a doorway or opens into another room can still receive no purpose
  fixture, so the RING's arrival wall stays the barest of the four (#400, #422).
- One material's grain is still busier than the band aims for, and the bound that keeps glowing paint from
  going back underfoot is a probe you run rather than a gate CI enforces (#416, #451).

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
