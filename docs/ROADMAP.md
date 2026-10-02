# Roadmap

Direction, the priority rubric, and the constraints that have been measured. **Not status** — who
is doing what, what is left and what is blocked are
[issues](https://github.com/lioreshai/breach-protocol-flash-next/issues). Prose status tables go
stale silently and cannot be linked from a commit; an issue can.

[`AGENTS.md`](../AGENTS.md) holds *how to work here*. [`VERTICALITY.md`](VERTICALITY.md) holds the
height-grid design. This holds *what we are building and in what order*.

## North star

A dependency-free browser FPS that looks better than a software raycaster has any right to, holds
60 fps, and is **fun to play** — playable in one file-open, every asset generated in JS at boot.
The current frontier is **vertical navigation**: maps you move up and down through.

## How work gets prioritized

1. **Truth of the harness.** Anything that lets a gate report green while the game is broken
   outranks everything, because every other decision is made on top of it.
2. **Vertical navigation milestones,** smallest first, each ending in a playable build.
3. **Things the player sees and feels** — look, feel, clarity of the first-person view.
4. **Readability and maintainability** — a first-class axis, not a cleanup afterthought. Every
   milestone ends with a note on what got *simpler*; one that leaves the code harder to change is
   not done.

## P0 — harness truth

- [ ] **The raster budget is content-dependent, and the gate still cannot show it.** Two runs can
      print the same scene class (L0 ARCHIVE SUBLEVEL, grid 26×26, 4 rooms, buffer 601×338) and
      differ 2.7× in cost, because only the player's cell differs. #32 now prints seed, level,
      player cell and z, grid, rooms and buffer in the verdict line — but the open question is
      whether that 2.7× is ray content or camera position, and whether `genLevel` took its fallback
      arena (#23: a silent flat lit box is green CI telling a lie). The trend is the warning: the
      flat default-seed median recorded at **3.33 ms** read **12.35 ms** at the `v1.2` build on the
      same scene class, so the 16 ms gate is 1.3× away rather than 5×.
- [ ] **Re-baseline the numbers quoted in the docs** after that, and re-check the two decisions
      whose evidence was weakest — the rig size-class work was justified by a 10× claim from luck.
- [x] **Seed the RNG for timed batches.** `tools/smoke.js` gets `Object.create(Math)` with a
      shadowed xorshift `random` (`SEED=<n>` to vary). `Object.assign({}, Math)` copies **nothing**
      — Math's own properties are non-enumerable per spec — which showed up as
      `TypeError: Math.hypot is not a function` at asset boot.
- [x] **Brightness was asserted on a pose nobody plays (#155).** Every sampler moved the camera to
      an arbitrary open cell and spun it through 6 yaws before sampling, so the first frame was
      outside every gate: the live page read **12.73 / 51.41 / 129.07** at the spawn pose while the
      same build asserted **86 / 90 / 73**, all inside 60–100. Both samplers now carry a spawn
      column, and `assert.js exposure` asserts the spawn median on its own band (35–75 composited)
      derived from two rendered failure states — lamps unlit **13.0 / 14.4 / 32.2**, a lamp 1 m in
      the lens **79.4–137.5**. Both bands are medians of 5 seeded rolls, because one fixed pose is a
      view class: per-roll 21–137 on level 0 straddles both anchors.
- [x] **Numeric altitude probes.** `alt`, `drop`, `sight`, `cull`, `horizon`, `heights`, `planes`
      and `vert` all exist, are in `ci.yml`'s blocking list, and pass with numbers: a 3 m drop lands
      at 7.21 m/s against 7.43 predicted and hurts (hp −25.32 vs 26.2 predicted); a level shot at an
      enemy one band up hits nothing; a body on band +1 moves its silhouette centroid up 89.1 px
      against 84.5 predicted. `alt` was the exception and worse than "not gating" — it had no
      `process.exit` in its code path at all — fixed in #152/#162.

## Vertical navigation — milestones

Design, rules and open risks: [`VERTICALITY.md`](VERTICALITY.md).

| # | Ship | Exit gate |
|---|---|---|
| M0 ✓ | Height expressible; `P.z` absolute; the flat world collapses to the old arithmetic bit for bit | `flatparity`'s flat senses (PARITY, LOCK) |
| M1 ✓ | Boundary faces with real `z0/z1` | `alt`: boundary faces > 0, no span ≤ 0 |
| M2 ✓ | Ground plane solved per cell; ceilings in the same commit | `heights`; medians within ~1 ms of baseline |
| M3 ✓ | Physics (gravity, step-up, fall damage, climb) and generation (bands, links, staircases) | `vert`, `drop`; `alt`'s band rows (#152) |
| M4 ◐ | Everything sits at a height: hitscan, culling, blast/exit/pickup bands, AI across bands, absolute decal z | `sight`, `cull`, `decal`, V4/V16/V17 |
| M5 | Per-band light and glow, minimap altitude cue | `exposure` **per band** in 60–100; colour variety not worse |
| M6 | Hand-authored two-storey level | full smoke + a user playthrough |

**What the two senses of "bit-identical" gate** (#214, #219, #224). `flatparity` fills
`MAP.fz`/`MAP.cz` flat itself before hashing, so PARITY and LOCK are a **formula-collapse proof** —
correct for "does the new expression reduce to the old one on a flat grid" — and not a description
of a dealt level. A flattened world cannot exercise a term that only acts off the datum. The
**DEALT** sense hashes the banded world as dealt and gates its md5 per level; its dealt-vs-flat
pixel ratio is *printed, not gated*, and 9 of 11 recent `js` commit boundaries move at least one of
the three hashes — so DEALT is a lock that re-records often, not a proof that a band term exists or
has the right sign.

**The frontier is no longer whether altitude is authored.** `authorVolume` (`js/20_level.js:401`)
runs before the occupancy gate and `alt` measures the result. What is left is perceivability: a
raised band is a minority of the floorplan and no column is authored hollow, so a level is
multi-storey in `MAP.fz` and still *reads* flat to a player. That is M4/M5, not generation.

Still green while broken: **`genLevel`'s occupancy gate is height-blind past one quantum**, so a
generator that authors a ramp or ladder degrades to the fallback box — the warn ships, the gate is
still blind (`VERTICALITY.md`, risk 1).

## Visual and feel backlog

- **Lamp fixtures.** Glow is drawn at a hardcoded `z = 0.55` (`drawLightGlow`'s
  `project(L.x, L.y, 0.55)`), which floats whatever the fixture does. Every light needs a physical
  body grounded at `floorAt`, and M5 makes the glow's z come from the lamp rather than a constant.
- **First-person viewmodel.** Reported as "tiny disembodied hands, weapon not recognisable". Needs
  forearms that reach off-screen, a larger silhouette-legible weapon per family, and muzzle flash
  that reads as coming from the barrel. Verify by rendering the viewmodel probe and looking at it.
- **Ceiling streaking** near the horizon at grazing angles: the mip footprint's anisotropy ratio is
  clamped at 4:1 (#57) because 8:1 erased the floor's grout lines — a deliberate residual, not an
  absent feature.
- **Mesh characters are not *animated* geometry.** Legs are straight, so a walking enemy keeps a
  static stance and a dying one fades in place; `anim` is the row that says so. #41's edge still
  stair-steps at 6 tube sides.
- **Silhouette separation against a busy wall** (#17) — and the rim/contact-shadow tension in
  [`ENGINEERING.md`](ENGINEERING.md) is the reason it is not a one-line fix.

## Code health — standing standards

- **No dependencies, no asset files, no network.** `js/*.js` load in numeric filename order as
  plain scripts sharing globals; `index.html`'s order matches the harness's sorted order.
- **Verify before commit, gating on the tool's verdict**, never on a grep matching a line.
  `node --check` changed files; parse the concatenation in load order.
- **Comments**: default to none. One short line for a trap or a measured number; never a multi-line
  block. What a comment says must be true after the commit.
- **Delete, don't archive**: no `_unused`, no re-exports, no `// removed`. Verify dead with a grep
  of `js/` **and** `tools/` — probe strings hide reads.
- **One way to do a thing.** Level data, entity defaults and species numbers each live in one
  place; adding a species or a level must be a one-line change.
- **Docs are part of the change,** and short is part of being correct: a transcribed number rots,
  so point at the tool that prints it.

### Health backlog

- [ ] Dedup level generation: one `makeMap`/spec path instead of duplicated field lists;
      per-species numbers into `ETYPE`; entity defaults in one table.
- [ ] Delete verified-dead: `LVL`, `total`, `nz`, `e.stuck` (grep `tools/` first).
- [ ] Rig rasterizer's rotated-box bbox over-scans 3–4× — use exact OBB extents.
- [ ] `tools/` needs the same dedup: probes repeat boot, seed and scene-setup boilerplate.

## Known debt register

- Two commits have mis-matched subjects/content from a background-job `git add -A` race, annotated
  in `git notes`. Do not rewrite history while any background job can commit.
- Every raster number recorded before the seeding fix is a luck draw — directional only.
- `#216` is open until the probe blocks whose verdicts are computed rather than hashed have
  recorded rows; `#226` is open on the DEALT sampler's camera.

## Decision log (details in the commits)

`5f39f1c` floor/ceiling texture scale was magnified ~128× by construction · `bf095ba` rasterize
after the on-screen cull · `93d4d42` rigs authored to occupied height + size class in the cache
key · `54bd063` decals were painted on ceilings, cache could not evict · `004dcde` glow budgets by
lamps drawn, ceilings got their own materials · `eed51d9` the verticality design.
