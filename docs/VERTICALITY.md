# Verticality — the design that was chosen

Status is [issues](https://github.com/lioreshai/breach-protocol-flash-next/issues); milestones are
issues too (M2 #13, M3 #14, M4 #15, M5+M6 #16). This file is the design and its open risks.

## Representation

**A quantized per-cell height grid** (2.5D stacked slabs), not a sector/portal graph. One playable
band per column:

| | |
|---|---|
| `MAP.fz` | floor in quanta — `floor = fz * ZQ`, `ZQ = 0.25`, `-4` = pit |
| `MAP.cz` | own ceiling *above own floor*; default `4` = a one-unit room |
| `MAP.vb` | per-boundary flags, packed per side: BLOCK / THRU / RAMP / LADDER |
| `MAP.feat` | STAIR / LADDER / PIT / RAIL + band, for the minimap |
| `MAP.steps` | derived: this boundary is an air-to-air step |
| `MAP.ceilPlane` | derived: the ceiling plane per column |

Portal semantics fall out of the grid — the opening between two open cells is
`[max(fz), min(cz)]`, so stairs, ledges, atria and pits need no graph. Chosen because `MAP.cell`,
`MAP.light`, `DECAL_*`, `bfsDist`, `explored` and **every probe in `tools/`** index `y*MW+x`;
keeping them intact is what keeps `node tools/smoke.js` meaningful while the work is in flight.

**Cannot do:** two walkable bands in one column, or a floor overhanging the cell it sits above.

## The rules that hold it together

- **Blocking ⇒ walkable ⇒ drawn is one byte.** A boundary with `dz > ZQ` that is not a ramp gets
  `VB_BLOCK` on both sides, so one test makes it opaque in the DDA, impassable in `tryMove`, and a
  textured riser in the wall pass. `VB_THRU` means "see it, not climb it". This was **false for 59
  commits**: an air-to-air step satisfied "blocking" without entering the geometry branch, so the
  byte stopped the DDA and `tryMove` while drawing nothing — a step you could neither walk up nor
  see. No probe saw it because no probe had placed the player next to a step; `cull` has those rows
  now, and they fail in both directions.
- **A cell's ceiling is the underside of the floor above:**
  `ceilAt = floor + max(1 unit, neighbour floors above)`. Without it you see sky indoors.
- **A wall face spans `[max(floorA, floorB), ceilAt(air side)]`** — never `ceilAt` of the *wall*
  cell, because a solid column has no air and its derived ceiling is a fiction while its own floor
  is honest. A span ≤ 0 is a generator fault, not a code one: a wall whose base sits at or above
  the ceiling plane of the band it encloses. Carry wall bases down to the lowest band they bound.
- **An air-to-air boundary needs its own span rule: the slab side,**
  `[min(floorA, floorB), max(floorA, floorB)]`. Reusing the wall span renders, keeps every flat
  md5 identical, and builds the riser *above* the pit lip instead of below it — `cull` then hides a
  body in the pit completely (0.0% of the flat silhouette surviving, where correct geometry leaves
  the crown at 8.4–8.7%) while the step rows lose occlusion the other way and report a body still
  visible behind a 1 m step. Gated by `cull`'s step rows (`tools/view.js:2178`, `:2185`).
  Ordering trap: a `poke()` relinks and recomputes `MAP.steps`, so a control that forces the flag
  must do it **after** the poke, or the row measures nothing.
- **Decals and lights carry absolute z, clamped into the span the renderer draws.** Solid column:
  `[max floor, ceilAt(air)]`. Air-to-air: `[min floor, max floor]` (`js/40_render.js:864`,
  #100/#192). Taking the solid-column rule on a riser is self-cancelling arithmetic — `ceilAt` of
  the lower cell *is* the upper cell's floor, so the window has zero height on every step and every
  mark pins to `maxFloor + r`, one disc above the geometry. A flat level stays byte-identical,
  which is exactly why no existing row saw it. A strip thinner than the disc (a 0.25 m tread, a
  0.22–0.30 m disc) is **centred**, not pinned to its bottom edge. `hitscan` reports a riser as a
  wall hit (`js/30_entities.js:149`), so a player reaches this line, and `view.js decal` is the row
  that knows it.
- **The renderer reads ceilings from `MAP.ceilPlane`,** filled by `buildCeilPlanes()` at the end of
  `linkBoundaries()`, because calling `ceilAt` from the ground pass's cell crossings cost 5% of the
  flat frame. It is filled by *calling* `ceilAt` per column, so the formula lives in one place —
  and therefore **anything that writes `MAP.fz`/`MAP.cz` must call `linkBoundaries()` afterwards**.
  `view.js planes` compares the array against the formula per column.
- **Light stays one value per column,** weighted by a band term. Do not make the lightmap per band:
  a fading transient re-splats its delta, and an un-splat landing in a derived band leaves
  permanent light, which breaks smoke's "blast light fully fades out" assert.
- **Every new formula must collapse to the old one exactly, bit for bit, on a flat level.** That is
  the backwards-compat test, and `flatparity` is where it lives. A face taller than a unit pushes
  `v` past the mip, and `texBil` wraps only at its last texel, so `v` must wrap per unit —
  otherwise the read runs off the array and `undefined & 255` paints fog colour where the wall
  should be, with no black pixel to show for it.
- What is left of the flat assumption is the decal/`zbuf` span math, which still assumes faces span
  0..1.

## Milestones

~~**M0** representation + absolute `P.z`~~ · ~~**M1** boundary faces with real `z0/z1`~~ ·
~~**M2** the ground plane solved per cell, floors **and ceilings in the same commit**~~
(floors-only shows a phantom floor across a tall room's upper half) · ~~**M3** gravity, step-up,
fall damage, climb; bands and links generated~~ · **M4 + M5 — what a player can see and climb**
← *here* · **M6** a hand-authored two-storey level.

**M3 is complete and the levels still read flat.** That is not a contradiction, it is the finding:
`alt` on 2026-10-02 (SEED 12345) reports **9 distinct floor values** per level, **170 / 251 / 307 cells off the datum** on L0 / L1 / L2, **2 staircase runs of >= 3 cells** (10 cells) rising one quantum each, **46 / 52 / 52 step faces** and 0 unreachable cells, with headroom columns >= 2 units at **86 on L0 and 45 on L1, tallest 3.00 m**. Volume therefore exists: `CZ_TALL = 12`, three units of air, is authored at `js/20_level.js:434` and written to the largest rooms and their mouth ring at `:649`, `:651-661`, and ladder shafts get `cz = |band| + 2` at `:512`. What is true is narrower than "nothing is hollow": **coverage** - `tallWant` is `rooms.length >= 8 ? 2 : 1` (`:637`, filter `:638-646`), so one or two rooms per level get it, and ~70 % of open columns keep a 1.00 ceiling - and **reach** - the mouth ring carries the tall air exactly one cell past the wall, so from a corridor the volume sits behind a 1-unit duct. The third limiter is not geometry at all: **light** - ceiling rows take the same per-column lightmap value as the floor rows below them with no height term (`js/40_render.js:581`, `lt = cellTint(cIdx); li = lm[cIdx]`), so a 3-unit ceiling is lit exactly like the floor it stands on, and a tall room reads as a short one. Being in the grid is not being perceivable. The next milestone is **authored volume
and findability**, not another shading term.

- **M4** — everything sits at a height: `hitscan` including the entered column's ceiling plane
  (#258); the enemy's eye asking that same solver where its line leaves the band rather than
  deriving a second rule (#261); culling, blast band, exit band and pickup hover (`sight`, `cull`,
  V4, V16, V17); and whether the AI can cross a band at all (#263 — fifteen `sight` rows drive the
  real `update()` loop for 240 frames across five configs differing by one byte of the boundary; a
  staircase, a ramp and a ladder all arrive at floor 1.00, and the same band with no climb bit
  stops the body at 3.81 m with the eye seeing 0/240). Face-relative decal z is gone, and `decal`'s
  15 rows gate the mark window.
- **M5** — per-band light, glow, minimap altitude cue.

**Strike a milestone only with the verdict that proves it beside it.** This file once said
"~~M3~~ … (issue #14 closed)" while #14 was open and its content had never shipped — the grid was
allocated all-zero and no line wrote it, so `alt` reported `floors 0..0` on all three levels. The
wrong line cost every subsequent session its way into the feature. "Done" is not something you edit
into a list; it is a verdict a tool prints. For M3 that verdict is ≥2 bands, ≥1 link per band, 0
unreachable cells, ≥1 climbable staircase — `tools/view.js:334`, in `ci.yml`'s blocking list.

## Open risks

1. **`genLevel`'s occupancy gate is only half height-aware.** `bfsReach`
   (`js/20_level.js:117`, called at `:492`) admits a crossing only when
   `Math.abs(fzArr[ni] - fzArr[idx]) <= 1` — **one quantum** (`:127`). A stepped band is therefore
   reachable, but **a ramp or a ladder is not**: those links are 4 quanta by construction, so an
   attempt that authors one fails the gate and ships the fallback box (the warn at `:566` fires,
   which is the only good news). The gate must count `VB_RAMP`/`VB_LADDER` crossings. Second
   hazard in the same commit: smoke's **V15 needs a flat 8-cell lane at floor 0**
   (`tools/smoke.js:876`) and fails `vsetup` without one, so a staircase landing in that lane
   breaks the VERT lane rather than the generator. And `auto-step` already exists
   (`js/30_entities.js:376`, gated by `vert`'s 1-quantum-over / 2-quantum-stop rows) — generation
   must not add a second lift.
2. **A new altitude test can break existing rows, and the row is usually right.** `sight`'s
   `+1 band` rows raise the enemy a full unit, which closes the opening `[max(floor), min(ceiling)]`
   to `[1.00, 1.00]` — the enemy is sealed off — and six rows kept printing `hit at t 3.3` for as
   long as `hitscan` ignored altitude (#129 found this by wiring the ceiling term and watching
   `sight` go red). Ask whether the row's geometry has an opening at all before touching its
   expectation, and prove a rewrite changed behaviour and not the claim by running the rewritten
   rows against **unmodified** code. Related: `ceilAt` is per cell, so an opening must exist along
   the whole flight — lifting one cell moves the stop one cell down the lane.
3. **Nothing compares z where things *move*.** The ground plane has `heights`; the geometry of
   movers does not, beyond what M4 has added. "An explosion downstairs kills upstairs" and "the
   portal triggers from the floor below" can still ship green.
4. **Spawn altitude has three seats, not one.** `resetRun` derives `P.z` from `floorAt`, but the
   non-fresh entries (`nextLevel`, `retry`, `again`) run no `resetRun` at all, so the feet kept
   whatever the generator computed before its last write to `MAP.fz`, and `P.air`/`P.vz` were never
   re-seated. `startLevel` now seats all three on every path; `view.js vert`'s spawn-altitude rows
   are the gate, and reverted they measure `P.z 0` against `floorAt 0.5` with the feet below the
   floor.

Also true and visible in the screenshots: ceiling streaks at grazing angles (mip selection has no
anisotropy), and a one-unit-tall world reading as a crawlway. Both are the vertical work, not
texture knobs. Keep the ground sampler honest about world scale (`ms = sc * mw`) at every height.
