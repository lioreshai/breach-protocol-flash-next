# Roadmap

Durable plan for this repo. The session todo list is ephemeral and this file is not:
when they disagree, this file is the plan and the todo list is one agent's working set.
`AGENTS.md` holds *how to work here*; this holds *what we are building and in what order*.

## North star

A dependency-free browser FPS that looks better than a software raycaster has any right to,
holds 60 fps, and is **fun to play** — playable in the browser in one file-open, with every
asset generated in JS at boot. The current frontier is **vertical navigation**: maps you move
*up and down* through, not a flat plane you walk around.

## Status lives in the issue tracker

This file keeps direction, the priority rubric and measured design constraints. It does **not** keep
status: who is doing what, what is left and what is blocked are [GitHub issues](
https://github.com/lioreshai/breach-protocol-flash-next/issues). Prose status tables go stale silently
and cannot be linked from a commit; an issue can. Every PR names an issue with `Closes #N` (the
keyword matters — a bare `#N` links but does not close on a squash merge) or opts out with
`[no-issue]`, and the `issue` check in `pr-guard.yml` enforces it. Milestones M0–M6, the P0 harness
items and every known defect below have issues; the sections here explain *why* each item is ranked
the way it is.

## How work gets prioritized

1. **Truth of the harness.** Anything that lets a gate report green while the game is broken
   outranks everything, because every other decision is made on top of it.
2. **Vertical navigation milestones,** smallest first, each ending in a playable build.
3. **Things the player sees and feels** (look, feel, clarity of the first-person view).
4. **Readability and maintainability** — a first-class axis, not a cleanup afterthought:
   every milestone ends with a note on what got *simpler*, and a milestone that leaves the
   code harder to change is not done.

## P0 — harness truth

- [x] **Seed the RNG for timed batches.** Done in `tools/smoke.js`: the sandbox now gets
      `Object.create(Math)` with a shadowed `random` (a xorshift PRNG, `SEED=<n>` to vary).
      `Object.assign({}, Math)` copies **nothing** — Math's own properties are non-enumerable
      per spec — which showed up as `TypeError: Math.hypot is not a function` at asset boot.
      Same commit, default seed: **6.4 / 4.5 / 4.6 ms** (was 34.9 / 4.5 / 15.7 ms).
- [ ] **The budget is content-dependent, which the gate could not show.** An earlier entry here
      claimed `SEED=777` measures **18.95 ms and fails** the 16 ms gate on identical code. It does
      not reproduce: on `bf68bcb`, default seed medians **3.33 ms** (batches 3.3/3.3/3.3/3.4/3.4) and
      `SEED=777` medians **8.85 ms** (8.7/8.8/8.8/9.1/9.1) — **both pass**. Whatever produced 18.95,
      it was not this code on this machine, and the P0 framing was retired rather than argued.
      What *is* reproducible is the reason the figure survived: both runs print the same scene class
      (L0 ARCHIVE SUBLEVEL, grid 26x26, 4 rooms, buffer 601x338), differing only in the player's cell
      (10.5,17.5 vs 8.5,13.5), so a 2.7x cost difference was invisible — the line was a bare number.
      PR #32 prints seed, level, player cell and z, grid, rooms and buffer in the verdict line and in
      the failure detail. Still open: is the 2.7x ray content or camera position, and did `genLevel`
      take its fallback arena (#23) — a silent flat lit box is green CI telling a lie.
- [ ] Re-baseline every number in `AGENTS.md` after that, and re-check the two decisions whose
      evidence was weakest (the rig size-class work was justified by a 10× claim from luck).
- [ ] **Brightness was asserted on a pose nobody plays (#155) — now measured on both.** Every sampler
      (`view.js exposure`, `tools/ci/assert.js exposure`) moved the camera to an arbitrary open cell, spun
      it through 6 yaws and ran frames before sampling, so the **first frame** was outside every gate: the
      live page read means **12.73 / 51.41 / 129.07** at the spawn pose while the same build asserted
      **86 / 90 / 73**, all inside 60–100. Fixed in the measurement half (this PR): `view.js exposure`
      prints a spawn mean/`mid` column on the same dice, `assert.js exposure` asserts the spawn median on
      its own band **35–75** composited, derived from two rendered failure states — lamps unlit
      **13.0 / 14.4 / 32.2**, lamp 1 m in the lens **79.4–137.5** — not from the spawn numbers. Both bands
      are medians of 5 seeded rolls, because one fixed pose is a view class: measured per-roll 21–137 on
      level 0, which straddles both anchors. The light-authoring half is **not** in this band of work (it
      follows #149), so a spawn view that legitimately faces a dark wall is still allowed to be dark.
- [x] Numeric altitude probes (`alt`, `drop`, `sight`, `cull`, `horizon`) — all five exist and run.
      `drop`, `sight`, `cull`, `horizon`, `heights`, `planes`, `vert` are in the **blocking** probe list
      (`ci.yml`) and pass with numbers: a 3 m drop lands at 7.21 m/s against 7.43 predicted and hurts
      (hp −25.32 vs the formula's 26.2); a level shot at an enemy one band up hits nothing; a body on
      band +1 moves its silhouette centroid up 89.1 px against 84.5 predicted. **`alt` was the exception, and
      it was worse than "not gating": it had no `process.exit` in its code path at all** - it computed a
      flatness verdict, printed `ALL FLAT ok` / `NOT FLAT - check above`, fell through to the scene dump and
      exited 0. That described `main` when the line was written; `alt` now ends in
      `process.exit(bad ? 1 : 0)` (`tools/view.js:782`), asserts bands instead of flatness, and sits in
      `ci.yml`'s blocking list — #152, closed by #162. So z is
      no longer invisible to the asserts — and the warning that follows, that every vertical row *creates*
      its geometry by poking `MAP.fz` so none can fail on a world with no altitudes, now has a counterweight:
      `alt`'s band rows and `flatparity`'s DEALT census count the grid the **generator** dealt, which a poke
      cannot fake.

## Vertical navigation — milestones (design in `AGENTS.md`)

Representation: quantized per-cell height grid (`MAP.fz/cz/vb/feat`, `ZQ = 0.25`), one playable
band per column, portal semantics derived from neighbouring floors. Chosen so `MAP.cell`,
`MAP.light`, `bfsDist`, `DECAL_*` and every `tools/` probe keep their `y*MW+x` indexing, which
is what keeps `smoke.js` meaningful *while* this is in flight.

| # | Ship | Exit gate |
|---|---|---|
| M0 ✓ | Height expressible; `P.z` absolute; the **flat** world collapses to the old arithmetic bit for bit | `flatparity`'s two flat senses hash a grid **the probe flattens** (PARITY `tools/view.js:863`, LOCK `:870`); smoke green. `exposure`'s per-level `< 3` prints with no exit code, so it reports rather than gates |
| M1 ✓ | Boundary faces with real `z0/z1` | `alt` reports boundary faces > 0, no span ≤ 0 (invisible wall) |
| M2 ✓ | Ground plane solved per **column**; ceilings in the same commit | medians within ~1 ms of baseline; `horizon` depth error `< 0.02` |
| M3 ✓ | **Physics ✓** gravity, step-up, fall damage, climb; **generation ✓** — bands, links and staircases are authored (#152, shipped in #162) | `drop` clean ✓; `alt`: ≥2 bands per level, ≥1 link per band, 0 unreachable cells ✓ — measured on `62d5b5c`, `main`: 9 distinct floor values on each level over 576 / 897 / 1156 open cells, **170 / 251 / 307 cells off the datum**, 46 / 52 / 52 step faces, 0 unreachable, `ALT ok`, exit 0 (N = 1 run) |
| M4 ◐ | `hitscan`, culling, blast/exit/pickup bands ✓ gated; enemy movement across bands, projectile ceiling (#148), absolute decal z ✗ | `sight`: 0 cross-band false-visibles ✓; combat asserts on a *generated* two-band level |
| M5 | Per-band light and glow, minimap altitude cue | `exposure` **per band** in 60–100; colour variety not worse |
| M6 | Hand-authored two-storey level | full smoke + user playthrough |

**What "bit-identical" is gated by, and by which instrument (#214, #219, #224).** The M0 row means the
**flat senses**: `flatparity` fills `MAP.fz`/`MAP.cz` flat itself before hashing each level's spawn frame,
so PARITY and LOCK are a formula-collapse proof — correct for "does the new expression reduce to the old
one on a flat grid" — and *not* a description of a dealt level (the `0 / 0 / 0` cells-off-the-datum census
beside that verdict is read after the probe's own fill, so it is a property of the probe). A flattened
world cannot exercise a term that only acts off the datum, which is why the sign of the band term is
gated elsewhere and not there. The other half is the **DEALT** sense (`view.js:887`), which hashes the
banded world as dealt and gates its md5 clause per level; its dealt-vs-flat pixel ratio is **printed, not
gated** (a level whose spawn camera sees no band reads only the per-render alternation floor — level 2: 8
px of 203,138), and its churn is measured: **9 of 11** recent `js` commit boundaries move at least one of
the three hashes, so DEALT is a lock that re-records often, not a proof that a band term exists or has the
right sign. "Our levels are flat" is not a claim this file makes any more: generation authors bands, and
the numbers are in the M3 row above.

**The frontier is no longer whether altitude is authored.** The paragraph that used to sit here said
`genLevel` had never written an altitude — the grid was an all-zero `Int8Array` that no line wrote — and
that was true of `main` when it was written. It is not now: `authorVolume` (`js/20_level.js:401`) is
called before the occupancy gate (`:843`, then `bfsReach` at `:844`), and `alt` measures the result (the
M3 row above). What that paragraph was really pointing at survives as a different problem: a raised band is
a minority of the floorplan and no column is authored hollow, so a level is multi-storey in `MAP.fz` and
still *reads* flat to a player. That is M4/M5 — perceivability and findability — not generation. The reason
this paragraph was wrong for as long as it was stands, and is the rule: until 2026-09-29 `AGENTS.md` struck
M3 as shipped ("issue #14 closed") with no verdict beside it, and the next readers inherited a feature that
did not exist — a milestone is struck by a verdict a tool prints, not by an edit to a list.
[#152](https://github.com/lioreshai/breach-protocol-flash-next/issues/152) is closed;
[#14](https://github.com/lioreshai/breach-protocol-flash-next/issues/14) and
[#15](https://github.com/lioreshai/breach-protocol-flash-next/issues/15) carry the per-item truth.

Three constraints on the commit that turns generation on — generation came on in #162, so read these as
what that commit had to satisfy, and they still bind any later generator change:

- **Author the bands before the occupancy gate, not after.** `bfsReach` walks the very array `MAP.fz`
  becomes (`js/20_level.js:489-490` says so — the comment sits at `:838` on current `main`, and the call
  pair is `:843` then `:844`), so heights written after the gate are validated against a flat grid the
  player never gets.
- **The gate is height-aware to one quantum only** — this bullet described `main` before #162. `Math.abs(fzArr[ni] - fzArr[idx]) <= 1`
  (`js/20_level.js:127`) admitted a step and refused a ramp or a ladder, both of which span 4 quanta, so a
  generator that authored them failed every attempt into the fallback box. It now OR-s in
  `linkedClimb(vbArr, featArr, …)` (`js/20_level.js:140`), which is the `VB_RAMP`/`VB_LADDER` count this
  bullet asked for.
- **`auto-step` already exists** (`js/30_entities.js:376`, eased `P.z += dz * min(1, 16*dt)`, gated by
  `vert`'s 1-quantum-over / 2-quantum-stop rows) — generation must not add a second lift — and smoke's V15
  needs a **flat 8-cell lane at floor 0** (`tools/smoke.js:876-880`), so a staircase that lands in that lane
  breaks the VERT lane rather than the generator.

Three failure modes that stay **green** while broken (each needs a probe, not a code review):
~~`resetRun()` zeroes `P.z` *after* `genLevel` placed the spawn~~ (fixed: `startLevel` seats
`P.z`/`P.air`/`P.vz` on every path, gated by `vert`); `genLevel`'s height-blind occupancy gate degrades
to a lit empty box with the feature silently absent (the warn ships, the **gate** is still blind);
and ~~nothing compares z~~ — z is compared now, **but on the dealt grid as well as on grids the probes
poked themselves** (`alt`'s band rows and `flatparity`'s DEALT census), so a build whose generator stopped
authoring altitude reddens those two rather than passing the whole vertical suite (#152, closed).

## Visual and feel backlog

- **Lamp fixtures.** Glow is drawn at a hardcoded `z = 0.55` (`drawLightGlow`'s
  `project(L.x, L.y, 0.55)`), which floats whatever the fixture does. Every light needs a
  physical body grounded at `floorAt` (post + base, or ceiling fixture + cone), and M5 makes
  the glow's z come from the lamp, not a constant.
- **First-person viewmodel.** Reported by the user as "tiny disembodied hands, weapon not
  recognisable". Needs: forearms that reach off-screen, a larger, silhouette-legible weapon
  per family, and muzzle flash that reads as coming from the barrel. Verify by rendering the
  viewmodel probe and **looking at the PNG**.
- **Ceiling streaking** near the horizon at grazing angles: the mip footprint's anisotropy ratio is
  clamped at 4:1 (#57) because 8:1 erased the floor's grout lines - a deliberate residual now, not an
  absent feature.
- **Mesh characters**: bodies are geometry now (#69 B2) but they are not *animated* geometry — legs
  are straight, so a walking enemy keeps a static stance and a dying one fades in place. The billboard
  path's gait and death poses are drawn by nothing, and #41's edge still stair-steps at 6 tube sides.

## Code health — standing standards

- **No dependencies, no asset files, no network.** `js/*.js` load in numeric filename order as
  plain scripts sharing globals; `index.html`'s order matches the harness's sorted order.
- **Verify before commit**, gating on the tool's verdict (`case "$out" in *PASSED*)`), never on
  grep matching a line. `node --check` changed files; parse the concatenation in load order.
- **Comments**: default to none. One short line for a trap or a measured number; never a
  multi-line block. What is written in a comment must be true after the commit.
- **Delete, don't archive**: no `_unused`, no re-exports, no `// removed`. Verify dead with a
  grep of `js/` **and** `tools/` — probe strings hide reads.
- **One way to do a thing.** Level data, entity defaults and species numbers each live in one
  place; adding a species or a level must be a one-line change.
- **Docs are part of the change**: `AGENTS.md` for traps and measured facts, this file for
  plan and priority, `README.md` for what the gates actually measure.

### Health backlog

- [ ] Dedup level generation: one `makeMap`/spec path instead of duplicated field lists;
      per-species numbers into `ETYPE`; entity defaults in one table.
- [ ] Delete verified-dead: `LVL`, `total`, `nz`, `e.stuck` (grep `tools/` first).
- [ ] Rig rasterizer's rotated-box bbox over-scans 3–4× (use exact OBB extents).
- [ ] `tools/` needs the same dedup love: probes repeat boot, seed and scene-setup boilerplate.

## Known debt register

- Two commits have mis-matched subjects/content from a background-job `git add -A` race. Do not
  rewrite history while any background job can commit.
- The `worker` subagent returned an **empty** report twice in ~2 seconds (while `planner`
  worked). It then completed a 50-turn, 13-minute M0 implementation on a **short** brief — so
  the failures correlated with very long briefs, not with the agent being broken. Verify
  delegated work with `git status` either way; M0's output was re-run and independently checked.
- A stray `tools/_vac_tmp.js` from a subagent needs deleting.
- Every raster number recorded before the seeding fix is a luck draw; treat as directional only.

## Decision log (details in the commits)

`5f39f1c` floor/ceiling texture scale was magnified ~128× by construction · `bf095ba` rasterize
after the on-screen cull · `93d4d42` rigs authored to occupied height + size class in the cache
key · `54bd063` decals were painted on ceilings, cache could not evict · `004dcde` glow budgets
by lamps drawn, ceilings got their own materials · `eed51d9` the verticality design.
