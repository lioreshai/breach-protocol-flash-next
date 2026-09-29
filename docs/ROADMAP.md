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
- [x] Numeric altitude probes (`alt`, `drop`, `sight`, `cull`, `horizon`) — all five exist and run.
      `drop`, `sight`, `cull`, `horizon`, `heights`, `planes`, `vert` are in the **blocking** probe list
      (`ci.yml`) and pass with numbers: a 3 m drop lands at 7.21 m/s against 7.43 predicted and hurts
      (hp −25.32 vs the formula's 26.2); a level shot at an enemy one band up hits nothing; a body on
      band +1 moves its silhouette centroid up 89.1 px against 84.5 predicted. **`alt` is the exception:
      it runs in the reporting job only, and it asserts that levels are FLAT** (M0's exit gate). So z is
      no longer invisible to the asserts — but every vertical row *creates* its geometry by poking
      `MAP.fz`, which means none of them can fail on a world that has no altitudes. That is #152.

## Vertical navigation — milestones (design in `AGENTS.md`)

Representation: quantized per-cell height grid (`MAP.fz/cz/vb/feat`, `ZQ = 0.25`), one playable
band per column, portal semantics derived from neighbouring floors. Chosen so `MAP.cell`,
`MAP.light`, `bfsDist`, `DECAL_*` and every `tools/` probe keep their `y*MW+x` indexing, which
is what keeps `smoke.js` meaningful *while* this is in flight.

| # | Ship | Exit gate |
|---|---|---|
| M0 ✓ | Height expressible; `P.z` absolute; flat behaviour bit-identical | `exposure` per level moves `< 3`; smoke green; `alt` reports all-flat |
| M1 ✓ | Boundary faces with real `z0/z1` | `alt` reports boundary faces > 0, no span ≤ 0 (invisible wall) |
| M2 ✓ | Ground plane solved per **column**; ceilings in the same commit | medians within ~1 ms of baseline; `horizon` depth error `< 0.02` |
| M3 ◐ | **Physics ✓** gravity, step-up, fall damage, climb; **generation ✗** — no band or link is ever authored | `drop` clean ✓; `alt`: ≥2 bands per level, ≥1 link per band, 0 unreachable cells — **cannot pass today, and `alt` still asserts flat** |
| M4 ◐ | `hitscan`, culling, blast/exit/pickup bands ✓ gated; enemy movement across bands, projectile ceiling (#148), absolute decal z ✗ | `sight`: 0 cross-band false-visibles ✓; combat asserts on a *generated* two-band level |
| M5 | Per-band light and glow, minimap altitude cue | `exposure` **per band** in 60–100; colour variety not worse |
| M6 | Hand-authored two-storey level | full smoke + user playthrough |

**The frontier is one thing: `genLevel` has never written an altitude.** `MAP.fz` is allocated as an
all-zero `Int8Array` (`js/20_level.js:575`) and no line in `js/` writes it, so `alt` reports
`floors 0..0`, one band and `step faces 0` on all three levels — the representation, the faces, the
ground solver and the movement all work on a world that has nothing to climb. Until 2026-09-29
`AGENTS.md` claimed M3 had shipped ("issue #14 closed"), and #14 is open and was never closed: a
milestone was struck without a verdict beside it, and the next readers inherited a feature that did
not exist. [#152](https://github.com/lioreshai/breach-protocol-flash-next/issues/152) is the blocker
for every vertical claim; [#14](https://github.com/lioreshai/breach-protocol-flash-next/issues/14)
and [#15](https://github.com/lioreshai/breach-protocol-flash-next/issues/15) carry the per-item truth.

Three failure modes that stay **green** while broken (each needs a probe, not a code review):
~~`resetRun()` zeroes `P.z` *after* `genLevel` placed the spawn~~ (fixed: `startLevel` seats
`P.z`/`P.air`/`P.vz` on every path, gated by `vert`); `genLevel`'s height-blind occupancy gate degrades
to a lit empty box with the feature silently absent (the warn ships, the **gate** is still blind);
and ~~nothing compares z~~ — z is compared now, but **only on grids the probes poked themselves**, so
a build with no altitudes at all passes the whole vertical suite (#152).

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
