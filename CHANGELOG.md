# Changelog

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
