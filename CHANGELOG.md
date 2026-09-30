## Unreleased

### Added
- **A generated level has volume, not just altitude** (#188). `authorHeights` scattered single room
  interiors one quantum up and left `MAP.cz` at one unit in every column, so a level was multi-storey
  in `MAP.fz` and still read as a crawlway. `authorVolume` authors three named features per level. A
  **raised quadrant** (falling back to a half-plane) stands a unit above the datum, its stranded
  pockets stair-linked and handed back to the datum when a mouth will not take a stair — the largest
  contiguous off-datum patch goes from **40–60 cells** (one room) to **144 / 225 / 287**. A **sunken
  block** with a lip around it, at most **5×4 cells** and 1.00 m down, sits in the room furthest from
  spawn and is linked by a *descending* stair, because dropping in is free and so a flagged crossing
  is not a verified way out. **Tall rooms** take `CZ_TALL` quanta of their own on the largest rooms
  AND on the corridor mouths into them — an open doorway draws no face, and its lintel is the ceiling
  you see through it. Measured at SEED 12345, **86 / 45 / 100** open columns stand **≥ 2 units** from
  `floorAt` to `ceilAt` (tallest **3.00 m**) where a flat level reads exactly 1.00 and a ladder shaft
  reaches 1.50. Wall bases are carried DOWN to the lowest band they bound, once, at the end, which is
  why **faces of span ≤ 0 read 0** on all three levels instead of moving that generator fault to the
  flat side where the spawn, the exit and the probes live. No draw from `Math.random` was added (the
  only changed lines mentioning it are comments) and `planes`' GEN-COUPLE row still hashes cell/fz/
  lamp identical at 0 and 12 enemies constructed. `alt` gained three rows for this — a column you can
  stand up in, off-datum cells reachable from spawn **up and down**, a raised patch you can walk on of
  ≥ max(24, 12% of open cells) — and its band-link rule counts a crossing from the end farther from
  the datum, which is the same cell as it was while every band sat above the datum and the only way a
  descending stair's link shows at all. Cost on smoke's own instrument (median of 5 batches, SEED
  12345, run back to back against `main` on one box): **12.08 ms against main's 10.28**. The limit is
  not depth — digging **every** open cell 4 quanta down measures within **±1.7 ms** of flat (5 batches
  × 3 levels) — it is **plane crossings per row**: a checkerboard dig, one crossing every 2 cells,
  costs **25.2–31.2 ms against 11.4–12.4 flat**.
- **The weapon in your hands is geometry, not a painted sprite** (#180). It is drawn through the
  same rasteriser as the world, into a **scratch depth buffer** so it can never cull a billboard,
  and it is deliberately **absent from the coverage mask** (`body: 0` at the draw site, with
  `contrast`'s emptied-`ENEMIES` row as the guard) so the character-separation probe cannot start
  measuring the gun. Sway was converted to screen space as `2 * planeLen * t / DW` instead of
  `2 * t / DW`, which had made the authored travel **1.399×** too large at the hip and **3.1×** in
  ADS, and barely scaled with field of view (**0.408** against an ideal invariance of **1.00**);
  measured travel/authored
  is now **0.911 / 0.927 / 0.922** at 1280×720, 1600×900 and 960×540, and the FOV-invariance ratio
  went **0.408 → 0.992**. All 24 weapon/pose states paint (**min 1,175 px**, rifle-at-hip bbox
  `x 0.59–0.86 y 0.61–1.00`), **0 frame-depth pixels** are written, and `hitscan` is byte-identical
  with the rig drawn. Cost is real and tracked as **#186**: WARM median **35.0 → 37.0 ms**, flat
  **8.85 → 10.5 ms**.

### Fixed
- **Authored volume made three defects visible that the flat world had been hiding** (#188). (1) A
  **nearer step crease was evicted by a farther riser**: `castWalls` painted a crease in an
  `else if (crk)` *after* the riser's seam, so one ≥2-quanta riser anywhere later in a column deleted
  a 1-quanta crease closer to the camera — **60 of 60** sampled columns on the branch's L0/L2 walk
  lips rendered a lip with no seam at all, and on `main` it was already **53 of 60 on L2**, booked as
  ok because the metric watching it was `mean |dL| ≥ 30`, a brightness test that cannot see geometry.
  (2) Those two lip metrics were themselves calibrated to light level: 0.84 × the luminance of the
  floor in front of the lip is the ceiling the row can reach, so a lip in a room rendering at 27.6
  can never pass any renderer. They gate on **contrast** now — `|a−b|/(a+b) ≥ 0.45` for the luminance
  row, the same fraction of the band's own luminance for the foot drop — with the within-10 term kept
  as a visibility floor and locality measured only on rows no crease in that column reaches, behind a
  coverage guard so the masking cannot read 0.0 vacuously (controls: seam term off = **15 FAIL**,
  eviction back in = **4 FAIL** at 11–12% contrast against 69–70%, crease cap removed = **5 FAIL** on
  locality). (3) Three `vert` rows had premises the bands invalidated, and each was fixed in the
  probe, not in the shipped code it measures: the **auto-step** row poked its lip band only to the end
  of the lane, which a 150-frame walk now steps off — the sample's tail chased a floor of 0 (`P.z 0.25
  → 0.1833 → 0.1344 → 0.0986`, read as `rise spread over 3 intermediate frames`) while the snap at
  `js/30_entities.js:379` had already fired in one frame; the **fall-damage** row dug its pit into the
  level's own loot, and a health pickup standing in that band is taken on the landing frame —
  `damagePlayer(10.6)` fires, hp 100 → 89.40, `takePickup` heals to the 100 cap, and a 2.00-unit drop
  printed **0.0hp** (the row's rule cannot attribute it: the heal lands on the same frame the rule
  uses to recognise fall damage); and the occupancy **split** row raised the `x ≥ N/2` half-plane, a
  flat-world rule about where the spawn sits — on L0 (spawn x 19 of 26) and L2 (30 of 36) it raised
  the ground the BFS starts on, so the exit was reachable *inside* the raised half at d 20 and both
  levels reported `exit sealed FAIL`. It splits on the axis where spawn and exit differ most now.
  Controls, each on unmodified `main` code with this probe: clean = 0 FAIL of 41 rows; the auto-step
  snap disabled = that row FAIL; `imp > 5.25` → `> 99` = the fall row plus the three `hard fall is
  paid for` rows FAIL; `> 1` = the fall row at **−6.0hp** on the 1.25 free drop plus the three
  `jump-speed carry-in` rows FAIL; `bfsReach`'s crossing widened to 4 quanta = all three split rows
  FAIL. **Still broken, and now labelled rather than passed**: **#189**, an enemy on the band above is
  invisible from the datum while the shot that hits you is solved the same way — the probe's POSED row
  reports #189 whenever the body is outside the cone instead of pretending to measure — and **#179**,
  whose cam-1 edge contrast is **16.65 dL against the shipped 24** and 37.94% of the silhouette lost,
  held as a known-issue row with measured floors (15.65 / 41.94) that `STRICT=1` promotes to a failure.
- **The CI audio verdict no longer depends on how busy the runner was** (#168). The inaudible-
  envelope row took the **loudest** `step()` peak of up to 5 renders under a shared CPU, and the
  envelope builder's first ramp can miss its 5 ms window entirely when the event thread is loaded,
  so a low draw could only be rescued by a lucky second attempt: **1 of 16 runs red on an unloaded
  box**, worse under parallel probes, and a sabotage control on `main` **passed the enemy-footstep
  case** (peak 0.27769, 14 of 15 red) because contamination by other systems' footsteps raised the
  average instead of the player's own peak. The verdict is now the **median of up to 7 renders**,
  retried only while that median sits at or below the floor, and each render is **isolated** —
  every `update()` call not issued by the probe is dropped and counted. No max-of-N, no raised
  floor: the 0.002 threshold still means what it says, and the sabotage is red **15/15 and 6/6**
  where `main` was 14/15 with one silent green.
- **A prop on the band above still drew through the slab, in the band of rows just below its riser**
  (#170). **438 / 401 / 398 px at rows 102..127** on L0/L1/L2 stayed visible behind a raised floor.
  Every one of them was painted by the **deferred** ground path (forcing the split never to queue
  removes the leak entirely; forcing it to always queue reproduces it byte-identically), and each was
  queued with plane **2.00** and answered from plane **2.00** — the row's own nearer plane (**1.00**,
  which solves to 2.5–4.0 m against the lamp at 4.00 m) was **never a candidate**, which is why
  tie-breaking the fixed point changed nothing. A deferred pixel now marches the ray the way the row's
  DDA does and adopts **the plane whose cell actually extends to the hit point**, stopping at the
  boundary whose opening `[max floor, min ceiling]` closes at the ray's height (`planeAlong`), and
  `gndWalkEdge` counts the marches that end on a slab edge rather than a plane. The row loop
  deliberately does **not** march: a 40-step DDA per cell crossing measured **38.2 ms against main's
  9.2 on a flat frame** — the documented one-indirection cliff — and no leaking pixel lived there.
  Flat levels are bit-identical (`scene 0 0` md5 unchanged), and so is the **mirror** geometry, which
  is the part that matters: a tall ceiling four cells out with flat floors hashes the ground pass
  `0xbb92cda0 / 0x80688d4a / 0x0186ce30`, identical to main, where the plausible near-plane rule drew
  the **near** ceiling across the room instead. `cull`'s far-slab row now asserts the **whole**
  silhouette instead of excluding rows below the riser's top edge — that exclusion is what let the
  defect print green.
- **A prop, pickup or orb on the band above drew through the floor you were standing on** (#163).
  The ground pass wrote `zbuf = Infinity` on ceiling rows, and a mesh's only occlusion test is
  `occ < z`, so nothing on those rows could ever hide a body: measured at camera `(8.10,19.50)`
  (`floorAt 0.00`) with a lamp prop at `(5.50,19.50)` (`floorAt 1.00`, `ceilAt 2.00`), all **1387**
  mask pixels sat behind `Infinity`. Ceiling rows now carry the ceiling plane's own distance
  (`d = dz*BH/|p|`, finite for any real plane), so the test can lose. No second sentinel was needed
  and none was introduced: the `p === 0` fill keeps `Infinity` for a horizontal ray that never reaches
  a plane. Gated by a two-sided `cull` row - a prop one band above paints **0 px** in the
  ceiling-only band on all three levels while the same prop on the camera's band still paints
  **850 / 756 / 804**, and it fails with **565 / 565 / 490 px at rows 58..101** when the ceiling write
  is reverted. Bodies taller than the room's ceiling plane are now **clipped** instead of smeared
  through it, which is correct geometry against a one-unit world. Cost: WARM interleaved
  **37.23/38.06/37.18 ms** vs main **37.94/38.72/37.43** (-1.4%), smoke median **8.98 vs 8.95 ms**.
  Known, not hidden: **398-438 px at rows 102..127**, below the riser's top edge, still draw through
  the slab because `groundPixel`'s fixed point oscillates between the low and raised planes and gives
  up on the far one - the quantized-domain non-convergence recorded in AGENTS, now with a visible
  consequence (#170).

- **Altitude was in the grid but not on the screen: a step lip read as a ramp and the minimap
  ignored height** (#164).
  A human playing the deployed build after #162 could walk up a staircase yet could not tell they had
  changed level. Risers wear the level's floor material, measuring **86.5 / 87.0 / 86.4** against floor
  **73.2 / 71.4 / 71.0** - a brighter patch of the SAME texture, so there was a luminance cue and no
  EDGE cue, and the minimap read `cell`/`explored` only. A multiply **crease** is now drawn on the row
  where the visible surface changes (light-independent, because an additive rim is floored by `AMB 0.19`
  exactly where separation is needed), plus a band tint per band on the minimap (band 0 keeps the colour
  that shipped, so a flat level paints byte-identical ink). Mean absolute luminance jump across the lip:
  faces **32.1 / 16.1 / 38.4 -> 97.3 / 37.8 / 118.9**, walkable lips **9.4 / 6.9 / 2.0 -> 45.4 / 55.9 /
  34.3**, and the share of walkable lip pixels within 10 luminance of their neighbour falls
  **72.9 / 100 / 100 -> 0.0 / 18.3 / 16.7**. Gated by a new **blocking** probe, `view.js bands`, that runs
  the real DDA per column, cross-checks every claim against the renderer's own `zbuf`, counts pixels
  instead of averages, and fails 11 rows with the seam term switched off.
  Known and filed, not hidden: the **walkable** half of the seam keys on the wall march's first crossing
  rather than the ground pass's own plane test, so it lands correctly in 38/60, 48/60, 33/60 columns
  (#167).

- **Generated levels contained no altitude: every shipped level was a flat slab** (#152, M3's
  generation half).
  `genLevel` allocated `MAP.fz` as all zeros and no line in `js/` ever wrote it, so the whole vertical
  feature - staircases, landings, ladders, band-aware visibility and shots - had nothing to exercise;
  `view.js alt` proved it every run by asserting **flatness** (`ALL FLAT ok`), because flatness was M0's
  exit gate. `authorHeights` now raises room interiors by one unit and links them to the datum with
  4-cell stair runs (or a ladder where the mouth is too short), **before** the occupancy BFS, so the
  generator's reachability gate walks the same grid the player will (`bfsReach` counts `|dq| <= 1`,
  `VB_RAMP`/`VB_LADDER` nibbles and `FEAT_LADDER`). Measured per level: **116 / 144 / 211 cells off the
  datum**, 3 staircases, `0 unreachable of 572 / 897 / 1145`, spawn and exit on the datum, and the
  generator's own `cell`/`lampPos` draw-stream **hash unchanged**. `alt` now asserts the opposite of
  flatness (>= 2 bands, a link into every band, 0 unreachable, a climbable staircase) and is in the
  **blocking** probe list - it can no longer report "ok" for a world with no stairs. Side effects found
  and fixed in the same pass: **riser faces wore `WTEX.CONCRETE`, luminance 136, in no level's palette**,
  and at the 3.19 m mean perpendicular they hit the wall falloff at `li 0.679`, which pushed level 0's
  composited exposure to **103.3 outside the 60-100 window** - risers now wear the level's own floor
  material (raster +1.9, gate green at 94/94/65); the eased auto-step became a **one-frame snap** so a
  step-up cannot drift through a riser; and `view.js`'s exposure sweep set `P.x/P.y` **without seating
  `P.z`**, which rendered half its banded cameras clamped out of their band.
- **A projectile had no ceiling: an orb fired upward passed through it and kept flying** (#148).
  `updateProjectiles`' only obstacle test is `isSolid(nx, ny)` - two dimensions - and `ceilAt` is called
  nowhere in `js/30_entities.js`, so an orb launched in a room whose ceiling plane is **1.000** reached
  **z 4.771** on the deployed build (5.194 in the new lane's pose) and was **still alive 120 frames later**:
  enemy fire crosses a ceiling and lands in the room above, the M4 failure mode AGENTS risk #3 named, and it
  shipped green because every altitude row tests **hitscan** (V13-V15) or a **poked** band. Orbs now pop at
  the plane with a spark and grenades bounce back **down** into the room they were thrown in; the same shot
  after the fix peaks at **0.993 and pops on frame 15**. Gated by a new VERT row **V18** (lane now 22 gating
  rows) that gates both directions: an escaping orb fails, and so does an over-eager "delete anything above
  the plane", because the grenade must stay alive and come back down. The stale line in `tools/smoke.js`'s
  VERT header claiming a projectile's planes are the literals 0.02/0.08 is corrected (#98 moved the floor;
  the ceiling was the gap). V18's first version was **silently absent** - `vsetup` returns `ok`, and
  `if (!vsetup(...)) { body }` runs the body only when setup *fails*, so nothing printed and nothing
  asserted while every neighbour stayed green; the tells were the lane's `N gating row(s)` count holding at
  21 and a control run against `HEAD` that failed to fail. That lesson is now in `AGENTS.md`.
- **The game was silent, and had been for a while: `chain()` handed the pan argument straight to
  `connect()`.** Every positional sound passes `panOf(e)`, which returns `Math.sin()` - a **number**
  (`js/30_entities.js:454`) - while `chain(node, pan)` (`js/00_core.js:98`) did `node.connect(pan)`, so the
  executing statement was `gainNode.connect(0.4)` → *"Failed to execute 'connect' on 'AudioNode': Overload
  resolution failed"*. The node factory that branch wanted, `panner(rel)`, was called from nowhere in `js/`,
  so the only working branch was unreachable; `pan === 0` was the single value that survived (`if (pan)`
  falsy), and `Math.sin()` is rarely 0. It got worse than one bad sound: the fault wrapper
  (`js/00_core.js:205-214`) catches, **closes the context** and leaves every `SND.*` method a no-op, so the
  first enemy at your left flank silences the game for the rest of the page's life - measured on the
  deployed build as `S.audioBroken: true` with `acState: "NO CONTEXT"` at boot, `S.sound` still true, no
  exception escaping, `update()` healthy. `chain()` now takes a pan **position**, builds the `StereoPanner`
  itself and clamps it to ±0.9; the dead `panner()` is gone. `S.err` also stops being erased while
  `S.audioBroken` is set (`js/50_ui_input.js:173` cleared it on every successful frame, so the reason lived
  for 16 ms - that is what "`Serr: null`" in an audio bug report actually meant).
- **Audio now has a numeric gate, which it never had.** `node tools/ci/assert.js audio` drives 37 sounds
  with the game's own argument conventions (pan as a number, weapon kinds from `WEAPONS`, enemy kinds from
  the level configs), each through its **own** `OfflineAudioContext` at 44.1 kHz, and asserts on the
  rendered waveform: nothing throws, nothing renders silence. Per-sound contexts matter - one graph that
  dies and takes the bus with it is the bug being tested for. An `AnalyserNode` tap on a *live* headless
  context was written first and rejected: `--headless=new` reads a render clock that does not advance, so
  all 38 peaks came back as one constant (0.19631) and the audible half of the assert could not fail. Two
  sounds are named as **not** covered rather than silently counted: `fanfare` (notes scheduled with
  `setTimeout`, so offline rendering measures a stopwatch) and `startAmbient` (a loop, different waveform
  per run). Verdict `AUDIO ok peak=0.27984, 37/37 sounds render signal` / `AUDIO GATE FAIL`, exit 1 on
  failure, 3 when the harness itself could not look (a build whose `SND.init` takes no context argument
  prints *"this harness being blind, not the game being silent"* instead of a fake red). Controls: fixed
  build with only `chain()` reverted → **exit 1, 37/37 threw**, `S.err` naming `Object.chain … :104:38`;
  pre-#157 build → exit 3, not a false green. `SND.init(ctx)` is the seam that makes this possible and the
  game never passes an argument. Closes #157.

### Changed
- **The vertical milestones now say what the tools measure, because one of them said something false.**
  `AGENTS.md` recorded M3 as shipped - "~~bands + links~~ (issue #14 closed)" - and put the current marker
  on M4. #14 is **open and was never closed**, and its content never happened: the grid the generator builds
  is `fzTry`, allocated as an all-zero `Int8Array` at `js/20_level.js:491` and made into `MAP.fz` at `:503`,
  and **no line writes it**, so `view.js alt` reports
  `floors 0..0`, a single band per level (`{"0":572}` / `{"0":896}` / `{"0":1146}`) and **`step faces 0`** on
  all three levels. The honest split, now written in both `AGENTS.md` and `docs/ROADMAP.md`: M3's **physics**
  shipped and is gated (`drop` lands a 3 m fall at 7.21 m/s against 7.43 predicted, hurts hp −25.32 against
  the formula's 26.2, and a **blocked** riser stops the player dead - 0.20 m moved in 1 s with `z` unchanged;
  the lift that does exist is `auto-step` at `js/30_entities.js:376`, eased over ~1/16 s, and `vert` gates it
  with 1-quantum-over / 2-quantum-stop rows), M3's **generation** did not, so no
  level in the game has a staircase, a ramp, a ladder or a pit. `docs/ROADMAP.md`'s P0 claim that
  `drop`/`sight`/`cull`/`horizon` were "still owed" is also retired - all four exist, run in the blocking
  probe list and pass. The probe that *would* gate flatness (`alt`) is worse than ungated: **it has no
  `process.exit` in its code path**, so it prints `NOT FLAT - check above`, falls through to the scene dump
  and exits 0 - a verdict line that cannot fail.
  Two rules added so this cannot recur: a milestone may only be struck through **with a verdict line beside
  it**, and a green vertical row must be able to name the line that creates the geometry it tests - every
  vertical row in the suite builds its own band with `vpoke`, which is why a world with no altitudes passes
  all of it. Tracked as **#152**; #14 and #15 were rewritten from these measurements (both carried claims the
  code had since contradicted, #15's being "z is invisible to every existing assert").
- **A second pass corrected four claims the first pass had made about that correction.** `alt` does not
  "assert flatness while unparked" - it cannot fail at all (no `process.exit`, `tools/view.js:214-263`). The
  occupancy gate is not "height-blind": `bfsReach` (`js/20_level.js:117`, used at `:492`) admits crossings
  of `|Δfz| <= 1` (`:127`), which is why it already accepts steps and **refuses ramps and ladders** (4 quanta)
  into the fallback box. A step-up lift is not missing - `auto-step` (`js/30_entities.js:376`) eases `P.z` to
  the floor and `vert` gates it. And the line first cited as the allocation (`:575`) is the **fallback** box;
  the normal path is `fzTry` at `:491` becoming `MAP.fz` at `:503`. Each was checked in the source before
  being rewritten here, which is the point: a citation is a claim, and a wrong one costs the next reader more
  than no citation. Finding them also changed the plan - authored bands must go in **before** `bfsReach` at
  `:492` (the comment at `:489-490` notes the BFS walks the array `MAP.fz` becomes), or the gate certifies a
  flat grid the player never receives.
- **`contrast`'s new exit code made a reporting job blocking, so cam 1's shortfall is a debt row.**
  The verdict shipped in the previous entry went **FAILURE** in `probes`: `ci.yml:188-192` runs
  `for p in alt exposure contrast rig stats sheets decal diag` and sets `status=1` if any exits
  non-zero, so a probe that always exits 1 on unmodified content is a permanent blocking row and
  `mergeStateStatus` BLOCKED - the job's `continue-on-error` does not help, because the row reports the
  step's own `exit $status`. Fixed in the tool, not by widening a threshold until the row cannot fail:
  cam 1's *recorded* separation is now a **known-issue row** in the shape smoke's VERT lanes use
  (`25 gating row(s), 0 known-issue row(s)`), counted in the verdict line -
  `CONTRAST 0 FAILURE(S) of 15 rows, 1 known-issue row (reporting: cam 1 #179)`. It reports at the
  baseline and goes red only when the debt **grows**: below edge dL **15.65** (recorded 16.65 minus 1)
  or above **41.94%** lost (recorded 37.94% plus 4). Both floors are measured on level 0 SEED 12345 -
  the configuration CI runs, deterministic to the digit over repeat runs - and bracketed by the knob
  that moves body shading: unmodified **16.65 / 37.94%** is the debt, `TINT=1` (drops the
  per-individual colour jitter, a neutral repaint) reads **15.95 / 41.44%** and stays a debt, `TINT=2`
  (halves the body's light headroom) reads **15.15 / 43.77%** and trips **both** axes, and `DARKRING=1`
  reads **37.19 / 0%**, which turns the row back into a plain `ok` and drops the count to 0 - paying
  #179 is visible in the output. `STRICT=1` promotes the row to a hard FAIL (exit 1) so the term that
  pays the debt can be A/B'd against a green baseline. Everything else keeps its teeth: an empty mask,
  a nonzero leak, a too-small ring and the cam0/cam2 verdicts stay hard FAILs (cam0 **28 / 17%** and
  cam2 **68 / 0%** read, so they are not debts), and `NOBODY=1` still prints **12** red rows rather
  than confident zeros. Control, for a debt row that might be self-cancelling: the patched probe on
  `a789064` carrying only the `COV` stamping hunks prints the same KNOWN row at exit 0 with identical
  frame hashes (`63bfcab0 6c3c1250 42f22ef0`) and goes red under `STRICT=1` and `TINT=2` there too, so
  the row tracks content rather than this branch's tooling - and on pristine `main` the probe cannot
  even run (`COV is not defined`), because its oracle is the geometry-pass stamp, not the tool.
- **`contrast`'s mask is coverage now, and the probe can fail.** The silhouette used to be
  `|A - B| > 4`, where `B` is the same render with `ENEMIES.length = 0`, which cannot credit anything
  a body changes in the *world*: `B` has none of it, and a shadow falling outside the silhouette joins
  the mask and moves the sampled edge onto the shadow's own falloff, where `dl` is tiny. That is how
  a contact shadow measuring a nonzero value on **4,410 of 37,651** body pixels left cam1
  **bit-identical** (dL 14, lost 44%), while `cull` read **113.0% / 182.3%** of the flat silhouette
  "surviving" and `cover` went **1.1% → 33.3%** (#179). The mask is now `COV` - who painted each
  pixel last, stamped at the mesh and billboard write sites, cleared once per frame by `renderWorld`,
  `null` in play - so a body pixel painted the same colour as the wall is *in* the mask and a shadow
  behind a body is *background*. Ring = mask pixels with an outside neighbour in the 8-neighbourhood;
  background reference = the median luminance of those outside neighbours **of the same composited
  frame**. Five rows per camera with a verdict and a `process.exit`: mask-is-bodies (the enemy-free
  render's coverage must be empty), silhouette big enough, ring measurable, body reads against the
  room (the shipped `edge dL >= 24`, plus `lost <= 70%`), and **leak** - pixels the diff mask claims
  that coverage denies, **0 px on main**, which is the shadow bug made countable. Coverage also sees
  the pixels the diff mask structurally could not contain: **52 / 566 / 0** body pixels at cam0/cam1/
  cam2 differ from the enemy-free render by <= 4, i.e. **20% of cam1's silhouette was invisible to
  the oracle**. Numbers on the same frames, old rule then new: cam0 `0.5%/34/29/13%` →
  `0.5%/32/28/17%`, cam1 `1.1%/15/14/44%` → `1.4%/12/17/38%` (WEAK under both rules, and now it
  exits 1), cam2 `0.2%/82/79/1%` → `0.2%/82/68/0%`. Controls, each seen to move the verdict:
  `NOBODY=1` gives an empty mask and 12 red rows instead of confident zeros, `DARKRING=1` (paint the
  ring black - the scale a future contour term is judged on) takes cam1 from `17/38%` WEAK to
  `37/0%` READS, and `TINT=k` flips verdicts at identical mask geometry, which is what the shipped
  `DEV.set('rim', …)` can no longer do (bodies are meshes since #72; `RIM=0|1` hashes the same frame
  both ways). Pixels are unchanged: `scene` md5s identical on all three levels, WARM PNG md5
  identical across 16 interleaved runs, `exposure` ok, `SMOKE PASSED` with the VERT lane at 25
  gating rows.
- **The README's four shots are back on the deployed build, and the sentences beside them now match the
  shipped code** (#190). Captured from `dc98788`'s **deployed bytes** - all 12 subresources fetched with a
  cache-buster and md5-compared against the merged tree, `js/20_level.js` = `53ce6c64c85ed72b5657281519267fd7`
  on both sides, with the deploy marker `authorVolume` counting **2** in the served file and **0** in
  `origin/main~1`'s - then posed through `?dev=1` at the four documented cameras in **one boot**
  (`DEV.clear()` and `DEV.cam` only, no `startLevel`). Each caption now carries its own composited `DEV.lum`
  (mean / mid-window): **spawn 45.42 / 77.54, facing-wall 118.58 / 178.84, enemies 81.65 / 96.99, props
  47.06 / 71.17**. Volume is claimed only where it is a **diff**: flattening this boot's **147 raised cells**
  changes **111,764** sampled px of the spawn frame (40.7%), its **23 sunken cells** change **218,981** of the
  facing-wall frame (79.7%) and **70,738** of the props frame (25.8%), and all 41 rays of the spawn frustum
  cross a band, nearest at **1.57 m**. Two sentences were simply false rather than stale: the viewmodel is not
  "Canvas2D vector art drawn in `renderOverlay` (`js/40_render.js:865`)" - it is geometry authored in metres
  in `js/13_mesh.js` (`rifle(b, s)` at `:491`) and rasterized into the **world buffer** by `drawViewModel()`
  (`js/40_render.js:1294`), called from inside `renderWorld()` at `:192`, with its depth test pointed at a
  **swapped scratch array** (`o.near`, `js/13_mesh.js:125` and `:814`) so it can neither cull a billboard nor
  punch a hole in the sky (#180's geometry half, shipped by #185); and the smoke raster figure's companion now
  prints `sprites: 0` (`tools/smoke.js:149`, the value this README quoted as 2) precisely because that rig left
  the canvas path. Two more sentences moved because the world moved: the facing-wall pose now stands **inside**
  the sunken block - feet -1.00, eye -0.50, so the slab side it looks at spans **[-1.00, 0.00]** where the
  caption said [0.00, 1.00], the same step rule with its sign inverted - and `DEV.ray` answers **13.44 m** on
  the spawn centre ray where the altitude march answers **2.13 m**. What stayed broken is written where it was
  measured rather than in a summary: **#189** did **not** reproduce - the posed hound on the +1 band changes
  **4,092** sampled px seen from the datum, so this shot neither confirms nor closes the issue, whose second
  half (the shot that hits you being solved the same way) a still frame cannot test at all - and **#180**'s
  look-feel half is still open, the rig's lag damped against wall-clock `dt`, which is why `tools/view.js` has
  to put the rig at rest before **both** frames of any pair it diffs (`VMREST`, `tools/view.js:2471`). One
  number was **dropped rather than restated**: the props caption's "emptying `PROPS` changes 78,420 pixels"
  measured 3,786 px here while a single lamp measured 4,418 and restoring the list left a 3,018 px residual
  against the reference frame, and a mutation count on objects that feed an additive glow layer is not a
  coverage count. The picture changed and so did the prose: `SMOKE PASSED` (raster median **11.77 ms**, batches
  11.5/11.8/11.8/11.8/11.9) and `alt` ok on all three levels with the numbers the captions now quote.

### Added
- **The exposure gate now samples the frame the player actually sees first, and it fails on its own.**
  Every brightness sampler in the repo — `tools/view.js exposure`, `tools/ci/assert.js exposure` — parked
  the camera in an arbitrary open cell, spun it through 6 yaws and ran 20–120 `update()` frames before
  measuring, so all of them asserted a *median over rolls of a pose nobody plays* while the first frame of
  the level was in no gate: the live page read **12.73 / 51.41 / 129.07** means (mids 18.34 / 47.93 /
  149.40) at the spawn pose against the 60–100 target, while the same build asserted **86 / 90 / 73**
  (#155). `view.js exposure` now prints a **spawn** column (mean + centre-half `mid`, same dice as its
  rolls column, on the same generated level, no `update()`), and `tools/ci/assert.js exposure` asserts it
  on a separate band, **35–75** on the composited frame, in a verdict that accounts for both numbers. The
  band is the gap between two rendered failure states, not a fit: measured on this geometry, a spawn frame
  with every lamp unlit reads **13.0 / 14.4 / 32.2** (and 3.7–17.3 with the ambient zeroed too) while a
  lamp 1 m from the lens reads **79.4–137.5** mean, so 35 sits above the brightest unlit render and 75
  below the dimmest lamp-in-the-lens view. It is asserted on the median of the same 5 seeded rolls because
  one fixed pose is a view class rather than a property of the level — the per-roll values range 21–137
  and straddle *both* anchors, so they are printed and not judged; `mid` is printed and not judged because
  its anchors overlap (a lightless level 2 reads mid 40.1 while L1's spawn median mid is 31). Two controls,
  both reverted: narrowing `SPAWN_MAX` to 55 fails level 0's spawn line with the median line still `ok`
  (exit 1), and zeroing `MAP.light` at the spawn frame only collapses the spawn numbers to 13 / 15 / 29
  while the asserted medians stay 86 / 90 / 73 — #155's defect class, caught. The pose is written
  explicitly rather than trusted: `P.ang` is the heading (there is no `P.yaw`), and `P.z` is the **feet** —
  `js/40_render.js:103` adds `cfg.eye`, so setting `floorAt + cfg.eye` would have raised the eye a full
  unit off the floor and measured a floating camera. No light authoring or lamp placement is touched here:
  that is the follow-up once #149 lands, and if it brightens spawn views past 75 this step goes red and the
  band gets re-derived from the two anchors, not nudged.
- **`DEV.lum([{stride}])` reports the luminance of the frame the player actually sees, and CI prints it.**
  `mean` is Rec.709 luma over the whole display canvas (after bloom, grade, grain and the HUD), `mid` over the
  centre half-window - two windows that are not interchangeable, and on this layer `mid` runs 8 to 20 points
  above `mean`, which is the conflation that produced #117 and #139. `tools/ci/assert.js exposure` drives the
  system Chrome over the DevTools protocol with node built-ins only (no dependencies; `tools/ci/no-deps.js`
  still guards the tree) and asserts the **median of 5 seeded rolls per level** inside 60-100, printing the roll
  spread and never asserting it, because that spread is 18-70 points, wider than the window (#87). The dice are
  `view.js exposure`'s own (`1000 + level*97 + roll*13`) so the two tools look at the same levels. Exit codes are
  distinct - 1 outside, 3 NOT MEASURED - so a run that could not reach the canvas never reports a passing grade
  (#122). #47's premise was understated: there was no `DEV.meanLum` and no exposure assert in `tools/smoke.js`
  at all, so no CI job gated brightness on **any** layer. The step ships `continue-on-error: true` because it is
  red on `main` today: level 2's median is **53 on the raster and 38 composited**, against 73/91 and 76/86 on
  levels 0 and 1, and a blocking check that is already overdue deadlocks its own introducing PR. #143 carries
  the numbers and the flip condition.
- **Two rules that were fixed and never asserted now have gates.** The exit changes level through a test that
  includes a band (#105: an xy-only test let the level change from a cell whose floor was a unit below), and a
  pickup has a 0.6 m vertical window (#109: xy proximity took it while the player hovered above it). Neither had
  a regression test: risk #3 in AGENTS.md says as much - nearly every assert in the repo compares x and y.
  Six new VERT rows (the lane goes 15 -> 21 gating rows) stand in the neighbour cell 0.40 m from a parked exit on
  a floor 0.25 above its floor and require the level to stay put, then flatten that floor and require it to
  advance; and stand on a pickup at 0.00 m, 0.50 m above it and 0.90 m above it, requiring it taken, taken (a jump
  peaks at 0.489 m so grabbing mid-air has to keep working) and left. Both rows are self-controlled, and both
  controls were run: deleting #105's band term turns V16 red on all three levels with nothing else failing,
  deleting #109's window turns V17 red on the 0.90 m half with nothing else failing. Writing them found two ways
  to be silently vacuous - on the last level `nextLevel()` ends the run instead of incrementing `S.level`, and
  `takePickup` sets `k.dead` rather than splicing and REFUSES a health pickup at hp 100, so counting array length
  at full health fails a build that is behaving correctly.

### Added

### Changed

### Fixed
- **Level 2 was dark before any post-processing: its lamp count never grew with its size.** `js/20_level.js:530`
  loops `cfgL.lamps`, which is **6 / 8 / 9** for sizes **26 / 32 / 36** - 0.0089 lamps per cell on level 0 against
  **0.0069** on level 2, 22% sparser in the biggest level. Its raster median read **42.5** (53 by the even-count
  artifact below), under the documented 60, so bloom and the vignette were never the cause: switching each shipped
  term off in turn attributes **+28.4 / +27.7 / +8.6** to bloom, **-1.9** to grade, **0.0** to grain, closing to
  within 1.5 points of the composited frame on all three levels. `lamps: 9` to **16** at `:19` moves level 2 to
  **73** on the raster and inside the window composited, while levels 0 and 1 generate byte-identical levels
  (raster 73 / 76 with unchanged rolls, composited 86 / 90) and `smoke` stays green. This also lets the exposure
  step in `ci.yml` be **un-parked**, which completes #47: brightness on the layer the player sees is now blocking,
  not reported. Area-scaling the lamp formula instead of the literal was measured and rejected - it puts level 1
  at 104-117 composited, outside the top of the window.
  Filed rather than folded in: **#149**, because `:531` places lamps with `takeNear(1)` with no spacing or per-room
  guarantee, so level 2's roll 0 stays at 37-48 in every config measured and part of this +35 is content churn (a
  geometry-identical +10-lamp control buys only +23); and **#150**, because `js/40_render.js:780`'s
  `brightness(1.5) contrast(2.1)` composes to `out = 3.15*in - 0.55`, an absolute threshold at in 44.5, so the
  bloom *source* loses energy on a dark frame - gain **x0.67** on level 2 against **x1.28 / x1.22**.
- **`tools/ci/assert.js` left a Chrome profile directory in `/tmp` on every run (#145).** The merged CI log
  ended with `left /tmp/breach-ci-WjYoXX behind: ENOTEMPTY: directory not empty, rmdir '.../Default'`: the
  cleanup removed the profile immediately after SIGTERMing Chrome, so the remove lost to a process that was still
  writing, and the 10 retries of 200 ms were all spent while that process was alive. It now waits for the child
  to exit (up to 4 s) before removing, and a remove that still fails prints the path on **stderr** so the verdict
  stays the last line on stdout - the note had been landing after `EXPOSURE GATE FAIL`, where it reads like part
  of the verdict. Measured on `main`: two full runs, no new `/tmp/breach-ci-*` directories (20 already there from
  earlier runs), exit code still 1 on the parked level-2 failure, stdout ending with the verdict.
- **The v1.1 release said the recaptured frames sit 23-44 luminance points below the captions they replaced, and that was wrong.** Four cheap checks replaced it, each eliminating one confound: the era build predates **#96**'s seed-to-layout remap (same seed, different level - that commit's own body measures 12 constructed-and-discarded enemies moving a rendered level's mean 66.4 to 70.2, and 66.4 is the era number in the table); bisecting the probe's *printed* frame mean lands on **#91**, which changed what that number means, not on any renderer; bisecting the PNG's own pixels lands on #96, a different level rather than a darker one; and a printed `frame: mean 59.1` "disagreeing" with a sampled 28.7 was two probe paths writing the same temp path - `exposure` falls through into a scene dump at a camera its rolls left (`#58`, `#61`), while `scene 0 0` photographs cam0 - because within one `exposure` run the printed number and the PNG it leaves agree at 59.1. #139 is closed as not a defect. Nothing in the thread was outside **#87**'s measured roll spread of 18-70 points, which is the constraint the captions now state instead of implying.

## 1.1 - 2026-09-28

The verticality foundation. M0-M3 landed: a quantized per-cell height grid with absolute
player altitude, boundary faces with real z spans, the ground and ceiling planes solved per
cell, and the links plus gravity, step, fall and climb behaviour that make a column below you
a place a shot, a mark and a body have to respect. **Not in this release: content.** Generated levels
are still flat - measured in the deployed page, `MAP.fz` is 0 in all 676 cells of level 0 and
`MAP.cz` is 4 in all 676 - so verticality here is engine, probes and authored behaviour, not picture,
and M6 is the release that gets to change that sentence. 69 PRs merged since `baseline-v1`, most of
them correctness work on things that had never been tested at altitude: what a shot hits, what
a mark sits on, where a body occludes, which cell owns a light. Screenshots were recaptured from the
deployed build for this release, and the centre of the frame measures 23-44 luminance points below the
numbers in the captions those shots replaced while `view.js exposure` is unchanged across the same pair
of builds - which turned out not to be a darkening at all: `83d9411` predates **#96**, whose removal of
`makeEnemy`'s global `Math.random` draws inside `genLevel` means the same seed lays out a different level,
so the two numbers photograph different rooms. #139 was opened on that difference and closed as not a
defect. This sentence shipped wrong in the release and was corrected afterwards, which is why it says so.

### Added

- **Documentation moved into `docs/`, and a release is now something this repo does.** `docs/ROADMAP.md` (moved with `git mv`; references updated in `README.md`, `AGENTS.md` and `ci.yml`'s seed comments), a new `docs/README.md` index, a new `docs/RELEASE.md`, and `docs/screens/` where it was. `docs/RELEASE.md` sets the trigger — a milestone issue closing, **50 merged PRs since the newest tag**, or the README's screenshots no longer describing the game — plus the version scheme — numbering runs **forward from the changelog's existing `## 1.0`**, whose own text says it is tag `baseline-v1`, so `v1.0` aliases that tag, MINOR per release, MAJOR at playable-complete (M6 authored, `0 known-issue row(s)` in the VERT lane, both smoke lanes green, no open P0) and the checklist, which ends with screenshots captured **from the deployed build** and a tag on the merge commit. `.github/workflows/release-guard.yml` enforces the 50-PR floor, measured as merged PRs whose `mergedAt` is newer than the newest tag. The arithmetic that motivated it, from live data: **68 merged PRs against one tag (`baseline-v1`, 2026-09-25) and zero GitHub releases** — so the first release is overdue by the rule's own arithmetic and lands as `v1.1` straight after this PR, with `v1.0` aliased onto `baseline-v1` so the published baseline finally has a tag. Sequencing matters and is the one design fact worth keeping: **a blocking check that is already overdue would deadlock the PR that introduces it**, so the guard lands running-but-not-required, the release PR (head branch under `release/`, the only exemption, and printed as waived rather than hidden) pays the debt, and *then* `release` joins the required contexts — a PUT that has to carry all four (`test`, `changelog`, `issue`, `release`), because protection on `main` currently requires the first three with `strict: true`. The guard fails rather than reporting zero when the query errors (#122's shape), counts through `gh pr list --state merged` because a REST `sort=updated` paginate can hide a merged PR behind recently-updated closed ones, and on the weekly schedule opens or updates one issue titled `Release debt: N merged PRs since vX`, so debt is visible in the tracker and not only as a red check on somebody's PR. Verified locally where the machine allowed: all six workflow files parse under `tools/wfyaml.rb`'s structural rules (ruby is absent here, so CI's `yaml` job stays authoritative) and the count step run by hand prints `newest tag baseline-v1 at 2026-09-25T17:51:41Z / release debt: 68 merged PR(s) / verdict FAIL`. No `.js` changed, so smoke and the probes are unaffected by construction.
- The changelog's duplicated `### Added` and `### Fixed` headings inside `Unreleased` are collapsed — one of each, which is what a release PR re-headers, and how it accumulates two is now written into the release checklist rather than discovered at release time.
- **`view.js mip` now gates the emissive FETCH, not just the mip chain (#123).** #20 fixed two sites and the probe only watched one: the census row counts alpha bytes in textures, so it can tell that `buildMips` stopped manufacturing `254`, but nothing exercised `castWalls`' bilinear decode, where a wall pixel's flag came from a *blend of the four corner alphas* and a pixel that merely touches an emissive texel averaged to `254.x` and lost the light-exempt branch in **mip 0** — verified only by two scene hashes moving. The new row builds three textures with one colour (`170,160,150`, so the colour blend is identical across them and cannot confound the comparison) on identical geometry, identical light and `G_GRIT=0` (grit's `gk` swings ±0.6 at default quality and would swamp the difference): every texel `253`, every texel `255`, and alternating columns of each, then compares the third render's pixels **one by one** against the first two and requires every one of them to be self-lit. Passing line: `2352 wall px on the face at (18.5, 3.5) +4 -> WALLS[4], perp 3.5 m (band 3.5-3.5, mip 0 of 4, 96.6 px per world unit, AMB 0.3, light 0.026) | all-emissive mean 151.5 vs all-opaque mean 107.6 (gap 43.9) | straddling: 2352 match emissive, 0 match opaque, 0 neither`. Controls: putting the blend back gives `1203 emissive, 1006 opaque, 143 neither` and widening the test to `>= 253` collapses the emissive/opaque gap to **0.0** — both directions fail. Two findings came out of building it. The bug **truncates**: a straddling fetch whose flagged corner weighs under 0.5 blends to `253.x` and `| 0` still reads `253`, so a period-8 pattern passed on the broken build (`1519 -> 1329` emissive, only 190 of ~588 straddling columns moved) and the pattern has to be dense enough that *every* quartet has a flagged corner for the row to mean anything. And the candidate face must be chosen by what `castWalls` **resolves** (`zbuf` flat and near across the sample band): `castRayDist` counts a blocked boundary as a wall and offered a "face" at 2.5 m that the renderer paints at 5.1 m, which would have asserted on pixels that are not that face. The face must also land on mip 0 — asserted outright, since a deeper chain is uniformly `253` after #124's sticky flag and would match emissive for the wrong reason.
- `DEV.mesh()` draws a character as volumetric geometry instead of a billboard, and that geometry now occludes **itself**: the rasterizer writes its own per-pixel depth, so an arm behind a chest stays behind it instead of painting through it. Nothing in the game calls it — the shipped picture is byte-identical (7 scene frames md5-identical to `main`) — and `DEV.mesh({self:false})` puts back the old read-only-depth ordering as a negative control (#69).

- Work is tracked in GitHub issues: every PR must reference one with `Closes #N` or carry `[no-issue]`, the tracker holds milestones and defects that used to live as prose in ROADMAP.md, and a weekly triage sweep reports open issues with no priority or area label.
- `?dev=1` boots the game with no click and no pointer lock and publishes a `DEV` console API (deterministic camera and enemy placement, frozen frames, a DDA ray query, runtime quality overrides including the character rim light), documented in the README.

### Changed

- A level now depends on its seed and nothing else. `makeEnemy` took **ten** draws from the global `Math.random` stream per enemy (gait phase, tint, facing, fidget) and it runs *inside* `genLevel`, so how many enemies a level happened to contain reshuffled its wall textures, lamp positions and pickup phases: constructing twelve of them and throwing them away — no gameplay effect whatsoever — moved a rendered level's mean luminance from 66.4 to 70.2. Per-enemy cosmetics now come from a private stream keyed to a spawn counter, the same xorshift the asset painter uses, which is also what finally lets a probe compare two levels at all: `view.js planes` hashes generation after constructing 0 and 12 enemies and reports `GEN-COUPLE ok`, and it fails all three of its comparisons the moment the coupling is put back (#90).
- Enemies no longer all die the same way. Each kind now authors three death rows — topple angle, fall direction, per-limb swing, how far the body sinks — and the variant is dealt **at spawn**, so a firefight leaves a mix of corpses instead of twenty copies of one pose with the same leg in the air. Variant 0 is the pose that shipped, number for number, which is why `view.js stats / vert / props / heights` are md5-identical to `main` across this change; and the variant is dealt by a **spawn counter rather than a random draw**, because `makeEnemy` runs inside `genLevel` and a single extra `Math.random()` there advances the seed stream and rebuilds every level for a given seed (#82).
- Props are geometry too. A barrel, a crate, a lamp, the three pickups, an orb and the exit portal are rasterized as solids instead of cards that turn to face you, so a prop has a side and a top; the orb and the portal keep their glow through a light-exempt path in the mesh rasterizer, which is what the billboards' alpha byte 253 was for; and a prop's feet come from `floorAt(x, y)` instead of the generator's literal `z: 0.0`. Two traps came with it: a prop's albedo needs the `Surf.lift(1.35, 6)` that `propTex` applies to every prop sheet (without it a crate's brightest pixels measured 62 where the sprite measured 101), and props need a flatter Lambert ramp than bodies (0.75 + 0.42·d against 0.30 + 0.85·d) because `drawBillboard` has no normal term at all — borrowing the body's ramp turned a hazard-red drum the colour of dried mud. At the shipped census (20/25/30 props plus 8/11/13 pickups, all visible from one camera) the cost lane measures **+0.26/+0.58/+0.78 ms/frame** on levels 0/1/2 over interleaved drawn/parked batches, on frames whose prop-free floor is 3.10/3.53/3.57 ms — and the same lane pointed at `main`'s billboards reads 0.02–0.05 ms, so the cards were nearly free and the solids are not; that is the trade #76 accepted. Silhouette-edge contrast is level: mean dL 34.7 to `main`'s 35.0, lost 10.3% on both, at one camera per level on one machine. `view.js props` fails 40 assertions on the build before it (#76, #69).
- Characters are geometry. An enemy is rasterized as a volumetric mesh at its real position, heading and floor height instead of as a billboard whose yaw is one of 8 buckets, so a body has sides, an arm behind a chest stays behind it, and rotation stops popping between poses. Bodies read further apart from the room they stand in — silhouette-edge contrast went from dL 18-40 to dL 22-52, and the share of edge pixels lost against the wall from 23-42% to 0-33% (`view.js contrast`, 3 levels x 3 cameras) — and a crowd got cheaper, not dearer: 18 enemies on screen measured 13.0 ms/frame of billboard poses against 3.3 ms of mesh, and `WARM` stress 13.31 ms avg / 31 ms worst against 4.11 / 11. The one tier that pays is PERFORMANCE, which drew pre-baked sheets and now pays +0.25 ms at 8 bodies, +0.56 ms at 18. What the mesh cannot do yet is animate: a walking enemy no longer cycles a gait and a dying one fades in place instead of toppling, which is why the sprite sheets and pose rasters are still built but no longer drawn (#69 B2, #39).
- Inline the wall bilinear fetch at its single call site and wrap the neighbour texel with an integer mask, guarded by a new smoke assertion that every wall mip dimension is a power of two (#25).
- Occlusion depth is one value per **pixel** instead of one per screen column: the ground pass writes the distance it already solves — including the pixels it queues for the lip of a step, whose colour comes from a different plane than the row's — the wall pass writes its own face span, and the sprite and particle paths compare per pixel. No pixel changed colour, and a column with no wall no longer holds a stale zero that hid sprites there. A flat ceiling row keeps the "occludes nothing" sentinel until the pass that clips against it (#45).

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

- **A shot aimed into the ground now hits the ground.** `hitscan` tested enemies, barrels and (since #125/#128) the band a shot travels through, and had **no test against a floor plane**, so a descending ray crossed the surface under the shooter's feet and kept flying. Measured with the new row's own geometry: an eye at 0.500 firing down a flat lane at `tanP -0.276` answered **`no floor at t 22.5, WALL`, one mark at x 25 z 0.113** — a bullet hole on the far wall 22 m away, from a shot that should have died 1.81 m out. `bandExitT` gained its third exit (kind 3): the ray crossing the floor plane of the **governing** band, solved exactly as `(fl - az) / tanP` and re-keyed per sampled cell like the ceiling, so the flat case stops at `t 1.812` with one ground splat on that cell's own plane (`floor true, wall false`, tracer at `h.z`). The re-key is what keeps a staircase passable to a shot: with `fl` never re-keyed the same staircase shot dies at **`t 2.273`** on the plane it stood on rather than running down the stairs into the wall at their far end. Both directions are gated by VERT row **V15**, which builds the two geometries from one flat lane (a pitched-down shot on flat floor, then the same lane stepped down one quantum per cell) and takes its expected `t` from the frame's measured `eyeH()` and `pitchTan()` rather than a literal, so a sensitivity change moves the want and not the verdict. Two findings came out of writing it. **A 1-unit drop has no legal shot into it, and the arithmetic is the finding, not the row:** from an eye at 0.50 a line to a chest 1.00 below at 4.00 out descends at −0.25 and crosses the shooter's *own* floor plane **1.87 m ahead, inside the shooter's cell**, and a sunk cell's ceiling is derived as the underside of the neighbour's floor, so the boundary opening is `[max floor, min ceil] = [0.00, 0.00]` — the strip between the floors is a slab side and the only honest answer is a floor hit. So `view.js sight`'s `band -1` rows, which lowered the enemy's cell by a whole unit and asserted the shot arrived, were asserting this defect as a feature (the same shape as #128's sealed-opening rows), and they are rewritten here onto a **staircase** — one quantum per cell, which is the slope those rows already aim along, so every boundary on the flight has an opening and the ray stays 0.25 above each floor instead of under it. The probe-only control (rewritten rows against unmodified `main`) prints `SIGHT ok`, so the rewrite changed no behaviour, only what it was hiding; the stop answer for the single-drop case is V15's first half. The other finding saved a change: #131 expected `addGroundSplat`'s `z: 0.01` to need an absolute altitude the way #120 fixed `addWallMark`, and it does not — the ground decal path paints from the cell grid via `decalAlpha(dc, cx, cy)` (`js/40_render.js:468-475`) and never reads `dc.z`, so a splat already sits on its cell's solved plane and the "fix" would have been inert code. **This changes game feel and wants a play-test**: shots fired downward now stop at the floor instead of travelling along it, which is correct on a flat level and is the same question as falling through a hole. `scene` md5s identical on four frames, all ten probes and `exposure` green, raster 10.22 ms against 10.22 on `main` — the march is bounded by the wall distance, so it costs samples on descending shots only.
- **A shot fired at a step now hits the step.** `hitscan`'s wall verdict came from `castRayDist`, a 2D march, so it never noticed a boundary whose floor is above the ray: firing level at a band raised 0.75 m reported the **far wall's** face 21 m away and marked *that* face at eye height - a bullet hole in a wall the bullet never reached. `bandExitT` (js/20_level.js) now classifies what the ray meets at each sample and returns `{t, kind, side}`: a ceiling crossing stops the shot with no wall and no mark (#125), and a boundary whose floor is above the ray is a **riser** - a drawn face, so it reports a wall hit solved exactly on the boundary's integer plane, `addWallMark` clamps the mark into the opening `[_max floor, min ceiling]` (both sides are air here, which is why that top is a `min` over air cells only - a solid side's `ceilAt` is the fiction), and the tracer and hole belong to the riser instead of whatever stands behind the drop. Getting there corrected two things believed about the plane tests: **the governing band is the one the ray is inside, not the one the sample lands in.** A cell *lower* than the shooter - a pit, or a `sight` probe config of -1 unit - has a derived ceiling equal to the surrounding floor plane, so a state test reads "above the ceiling" on a ray descending over a hole and stops it at the boundary (`sight`'s band -1 rows turned into `MISS t 1.8 into wall`); and a ray that has already left its band downward through its own floor plane must not be called a riser either, because hitscan models no ground at all, so it keeps flying and still reaches an enemy standing in a pit below. Both directions are gated by the new VERT row V14 (a step across a lane, fired at from below the riser and through the 25 cm opening above it): with the term removed it prints `wall at t 22.5, 1 mark at x 25 z 0.525`, with the term fired on *any* floor difference the pitched sample fails at `WALL at t 1.5`. `scene` md5s identical on all four frames, exposure unchanged at mean 69, raster 10.50 ms against 10.22 on `main` - the march is per shot, and the spread says noise. #128 also asked for a "fire down a lane into a lower band" row; that case needs the ground test this does not add, so it stays open as the honest pre-existing behaviour (the ray passes over the edge and reaches what is below it), noted in the pass header rather than claimed fixed.
- **A shot aimed at the ceiling no longer hits the wall behind it.** `hitscan`'s wall verdict came out of `castRayDist`, a 2D march, so the ray had no altitude test at all - enemies got one in #98 (`hz` against their own band), barrels got one, walls got none. Measured on the deployed build, one shooter and one face spanning 0.00..1.00: a ray pitched up until it reached z 2.50 answered `wall true` at the face's own distance and punched one mark at z **0.856**, which is the face top minus the decal inset - a bullet hole along the top edge of a wall the bullet had flown over. `bandExitT` (js/20_level.js, beside `losZ`) now marches the ray's own path and stops it where it rises through the ceiling plane of the cell it is in, re-keyed **per sampled cell** so a shot travelling through a ramp or atrium opening is not stopped by the ceiling it started under; the click leaves no mark and the tracer dies on the ceiling instead (`js/30_entities.js` grew the band-hit particle for it). Reverting the wiring reproduces the old verdict exactly: `WALL at t 23.5, z 28.7, 1 mark` in the new VERT row, which also fails the other way if every shot is stopped (the level control then prints `VACUOUS`). The floor half is deliberately not here - stepping below a cell's floor means the ray met a **riser**, which is a face, so that answer is a wall hit with a mark and it also turned out to implicate the harness: `view.js sight`'s `+1 band` rows raise the enemy a full unit, which leaves the boundary's opening at [1.00, 1.00] (empty - the enemy is sealed off) and asserted a hit through it purely because nothing tested altitude. Those six rows are rewritten here to an atrium (the lane's ceilings lifted over the shot's whole flight, because `ceilAt` is per cell - one tall cell just moved the stop one cell down the lane, `MISS t 1.8`), and the probe-only control - rewritten rows against unmodified `main` - prints `SIGHT ok - hit tests follow the body they hit`, so the rewrite changed no behaviour, only what it was hiding (#128 tracks the riser half, with the rows it needs). `scene` md5s are identical on all four frames and raster is 10.23 ms: nothing here touches the picture.
- **Glowing surfaces stay glowing when they are far away.** A texture marks a texel as emissive with alpha **253** and the renderer matches that byte exactly to skip the scene-light multiply, but the mip chain averaged alpha (`aSum / 4`, and `i0` truncates), so a 253 meeting three opaque 255s became **254** - a byte no read site recognises. Every emissive area therefore switched itself off as it receded: measured on the deployed build across the whole texture census, 84% of `FLOORS.FLESH`'s emissive texels were 254 by mip 1, `CEILS.SINEW` reached **0 kept** by mip 3, and `WALLS[1]` lost all of them by mip 2, while no mip 0 anywhere contains a 254 because the painter writes 255 or exactly 253. The chain now carries the flag instead of averaging it (an emissive texel anywhere in the 2x2 keeps the area self-lit, which spreads a glow by half a texel per level instead of deleting it), and `castWalls`' bilinear decode tests its four corner texels rather than their weighted blend, which had the same failure at fractional coordinates in mip 0. The picture changes where emissive textures actually are: scenes on level 0 stay **md5-identical** to `main`, levels 1 and 2 differ, the ground-pass mean moves 101 -> 99 on level 2 and is unchanged (32, 22) on the others, and the frame mean is 69 either way - it goes *down* because the brightest rooms have a light value above 1 (that is #21) and self-lit means no longer inheriting it, while in a dark room the same change is a brightening. `view.js mip` gained a census row: it counts 254s across FLOORS/CEILS/WALLS (3050 emissive texels found, 0 manufactured today) and hands `buildMips` a 16x16 containing one flagged texel and requires 253 back at mip 1; with the averaging chain put back it reports `2437 texel(s) at alpha 254 ... synthetic 1 flagged texel -> mip1 alpha 254`, and a census that found no emissive texel at all would report nothing rather than pass (#20).
- **A bullet hole now appears at the height you fired at, on any floor.** Shooting a wall in a raised room left sparks and no hole at all: the mark's `z` was clamped to `[0.12, 0.88]`, which meant "the middle of the face" only while every face spanned 0..1, while the renderer solves a mark's `z` as an **absolute** altitude — and the call site gated the write on `h.z < 0.96`, an absolute altitude tested against that same flat window, so above ~0.9 m of floor the mark was dropped before it could even be misplaced. Measured on the deployed build: one shooter, one wall 3.5 m away, level pitch — on the datum it left 1 mark at z 0.500 (its top +0.649 above that floor); with the same room raised one metre it left **0**, with the impact sparks correctly at z 2.500, so the hit looked real and recorded nothing. A mark now carries absolute altitude clamped into the **face's own span** — the higher of the two floors to the ceiling plane of the air side, inset by its radius so a disc cannot hang over a band it was not punched in — and the call site asks nothing of altitude except that the shot hit that face. Flat ground is the arithmetic it was (`floorAt` is 0 on generated levels, so the span is 0..1 and a chest-height shot is nowhere near either inset): 4 scene frames md5-identical to `main`. `VERT=1` gained a row that fires a real click through `tryFire` at the arena wall from the flat band and then from a +0.75 m pedestal, asserting a mark exists and lies above the shooter's feet and inside the face; its controls fail in three directions — the old writer clamp reports `1 mark(s) at z 0.88 for a hit at 1.25, want above 0.95` (the hole painted into the floor slab), the old call-site window reports `0 mark(s)`, and a mark never punched at all reports `VACUOUS: the same shot leaves no mark on flat ground either` (#120).
- **An enemy can no longer see through a raised floor.** Sight was a march along the floor plan testing `isSolid` alone, and a raised band is not solid, so an enemy behind a platform saw the player straight through a slab whose riser the wall pass paints and whose boundary byte stops it walking: `los()` returned `true` across a +1.0 m plateau in the middle of a 9 m run on the deployed build (`floorAt` at the midpoint 1.0, `isSolid` false). The ray now carries its endpoints' altitudes and lets any floor **above the sight line** block it, so a 0.75 m lip between two bodies on the flat band hides them from each other while someone standing *on* a ledge stays visible over it — the line is interpolated, not thresholded, because that is the difference between "see over a step" and "see through a slab". Deliberately scoped to the AI's `see`: the blast, melee, light-glow and off-screen-marker users of `los` keep the 2D ray until each has a row that says why. On flat ground the new test cannot fire (`floorAt` is 0 on every generated level) and 4 scene frames are md5-identical to `main`. `VERT=1` gained a row that puts a +0.75 m plateau between an enemy and the player and asserts no alert and no shot, with the same 9 m of flat floor as the control that the enemy *does* see; its controls fail in both directions - the old ray reports `alert 1 … 17 frame(s)` across the plateau, and sight that never resolves reports `VACUOUS: the enemy sees nobody on flat ground either` (#118). 
- **An enemy that stands on a ledge now shoots from the ledge.** A ranged enemy's orb was spawned at `e.scale * 0.62` — the height of its chest *above its feet*, read as an absolute altitude — while #98 had already made the orb's floor the band it flies in, so on any band at or above ~0.55 m the shot was born under the floor the shooter stood on and detonated in the frame it was created. Measured on the deployed build: an orb in 3 of 4 frames at z 0.638 on flat ground, and in **0 of 4** with the shooter's own cell raised one metre, with +12 particles and +1 light as the signature of a pop on frame 1. Grunts stop shooting above 0.55 m and brutes above 0.86 m, and every gate was green because the lane's projectile row pushes its own orb with a correct `z` and never reaches the spawn site. Hit sparks and the death spray quoted the same body-relative-as-absolute expression; they self-correct on the band, so their symptom was blood that sprays along the ground instead of through the air. On flat ground every expression is the one it was (`floorAt` is 0 on generated levels; 4 scene frames md5-identical to `main`). `VERT=1` gained a gating row that drives a **real** enemy's attack decision on a +0.75 m shelf and bounds the orb's first `z` above the feet and below the crown, and its controls fail in both directions: the old spawn reports `0 frame(s) … NONE - fired and popped in the frame it was spawned`, a spawn 3 m high trips the crown bound, and an AI that never fires trips the flat control (#116). 
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
