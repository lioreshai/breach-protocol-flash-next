# Working the tools

What to run, what each probe can and cannot see, and how to read a number off this machine
without fooling yourself. The rules are in [`AGENTS.md`](../AGENTS.md); the traps that produced
them are in [`ENGINEERING.md`](ENGINEERING.md).

## The two harnesses

```
node tools/smoke.js            pass/fail. Save/restore balance, colour variety,
                               raster median < 16 ms/frame, asset memory < 40 MB
VERT=1 node tools/smoke.js     the vertical lane, on top of the above
node tools/view.js <mode>      instruments: geometry, lighting, budgets
node tools/recap.js check      the README's quoted numbers against docs/screens/*.png
node tools/ci/assert.js audio  the only thing that can verify audio (see below)
node tools/wfyaml.rb           every workflow parses, and no job runs nothing
```

`smoke.js` is the verdict. **Match `SMOKE PASSED` / `SMOKE FAILED`, never a row count** — the VERT
lane's `N gating row(s)` is a census of what ran, not of what passed.

## Which probes gate

`ci.yml` runs three tiers, and the difference matters: adding a `process.exit` to a probe in the
third tier silently promotes it into the second.

| tier | contents | effect |
|---|---|---|
| **blocking** | `heights` `mip` `anim` `props` `vert` `planes` `sight` `drop` `horizon` `cull` (and `LEAK=1 CZBAND=1 cull`) `bands` `alt` `flatparity` `recap.js check` | a non-zero exit fails the PR |
| **reporting, but wired to a status** | `for p in alt exposure contrast rig stats sheets decal diag` — the job sets `status=1` if **any** exits non-zero | a new exit code here turns the job blocking; `continue-on-error` does not save it |
| **print only** | `play`, `diag`, `stats`, `sheets`, `rig`'s problem counter | instruments |

So ship a new verdict as a **`KNOWN` row at the measured baseline**: report, go red only past a
measured floor, promote to a hard gate under `STRICT=1`, and print the debt in the verdict line. A
permanently-red row teaches everyone to ignore the rows that mean something.

## The probe catalogue

**Pictures and materials**

| mode | what it tells you |
|---|---|
| `sheets` | every material (4 tiled quads) and sprite in one PNG (`/tmp/fps_tex.png`) |
| `stats` | per texture/sprite: mean, deviation, neighbour gradient, coverage, emissive count, average RGB, blown pixels, and the bake pipeline's albedo × light |
| `diag` | red-channel histograms per material plus measured coverage of every noise threshold helper |
| `scene <level> [cam]` | one frame as a PNG plus its luminance stats. `WARM=1` turns the camera over 180 frames |
| `rig` | pose sheet + coverage/bob metrics. **Dumps the RAW raster** — no light multiply, no fog |
| `viewmodel` | every weapon through hip/ADS/recoil/reload/swap/sprint/airborne, with balanced save/restore |
| `anim` | does a body change SHAPE while it walks — drives the gait through the game's own `updateEnemies` and fails on a static stance. `KIND=`, `COST=1` |

**Light and tone**

| mode | what it tells you |
|---|---|
| `exposure` | mean luminance over levels × seeds × 6 view angles, as **medians of seeded rolls**, plus the spawn-seat column. Carries recorded rows and an exit code (#216) |
| `contrast` | do the characters read against what is behind them. Mask is `COV` (who painted each pixel last), ring is an 8-neighbourhood, background is the median of outside-mask neighbours of the same frame |
| `bands` | the legibility pair |
| `mip` | streak counts; clears `zbuf` to the sentinel per isolated `castWalls` call |

**Geometry and verticality**

| mode | what it tells you |
|---|---|
| `alt` | per-level bands, links, unreachable cells, climbable staircases. Exits non-zero (`tools/view.js:334`) |
| `heights` | which **half** of the frame moves when only floors, or only ceilings, change altitude. Six configs per level, measured on the ground pass alone |
| `planes` | `MAP.ceilPlane` against the `ceilAt` formula, per column |
| `cull` | occlusion: props and bodies behind slabs, risers and ceilings |
| `sight` | line of sight and whether the AI can cross a band at all — fifteen rows driving the real `update()` loop for 240 frames |
| `drop` | gravity, step-up, fall damage, climb |
| `horizon` | the horizon row's depth |
| `decal` | every mark a shot leaves is inside the face it was punched on |
| `flatparity` | the backwards-compat test: a flat level must render bit for bit as before. PARITY, LOCK and DEALT senses |
| `refs` | the recorded-reference inventory, printed with no render |

Knobs: `REPS=n` and `ONLY=W1` narrow runs, `ASCII=1` prints text instead of a PNG, `OUT=`
redirects the path, `SEED=`, `TINT=k` A/Bs body shading, `JSDIR=` points at a variant tree,
`PIXHASH=1` hashes frames, `STRICT=1` promotes debt rows.

**Recorded references:** read the count, kind and values off `node tools/view.js refs`.
`tools/refs.lock` is the table, regenerated with `refs --record`, and `refInventory` asserts
declarations against it from inside `flatparity`. A missing or stale table is a FAILURE, never a
silent pass. Blocks whose verdicts are *computed* rather than hashed — `alt`, `heights`,
`contrast`, `exposure`, `mip`, `bands`, `scene` — have no reference behind them; label figures
quoted from them (#216).

## Audio cannot be verified with the two harnesses

The `vm` harnesses stub `AudioContext` as undefined, so `SND.init()` bails and **no sound is ever
built in `view.js` or `smoke.js`**. `node tools/ci/assert.js audio` drives every `SND` method with
the game's own argument conventions through its own `OfflineAudioContext` and measures the
waveform (#157). It gates CI. In a browser the `ERROR (loop alive)` banner and `S.err` are the
other trace; `S.err` survives while `S.audioBroken` is set, because clearing it every frame made
"audio died silently" undiagnosable.

## Timing discipline

- **One run on a loaded machine means nothing.** Load average ~3 inflated unchanged code from
  3.4 ms to 17–46 ms and made a floor-smoothing change look like a 2× regression. Smoke prints
  five batch medians — read the median *and* the spread; 4.1/9.1/14.8 is noise.
- **`WARM=1` turns the camera at 3 rad/s.** That is the worst case for pose churn, not normal
  play; use it to stress, not to judge frame rate.
- **Cost a broken cache hides is not savings.** Raster "improved" to 3.4 ms because the rig cache
  had stopped making poses at all; honest was 8.7–14.8.
- **The raster figure is a floor, not gameplay cost.** It is an empty frame, and since #185 it
  includes the viewmodel, which rasterizes inside `renderWorld` (`js/40_render.js:192`). Gameplay
  cost is `WARM=1 node tools/view.js scene 1 0` over 180 frames.
- **Never time inside a hot loop.** A wrapper for a phase A/B added 15 ms/frame to both sides.
  Bisect with `JSDIR=` or a worktree and run the real probe.

## Measured perf facts

- **A module-global typed-array out-param kills the hot loop.** Inlining `texBil`'s fetch took
  `castWalls` from 21 ms to 12 ms near a wall. Same code, one indirection.
- **Rasterize after you cull.** A rig pose costs 1–8 ms and the budget is 2–4 poses/frame;
  culling after the fetch let invisible enemies spend it (136 → 72 poses per stress run).
- **Rigs author at on-screen height,** with a coarse size class in the cache key: an entry
  authored at one height is not valid at another.
- **Hoist transcendentals out of pixel loops** — a decal's `exp` fade is per row, not per pixel.
- **Billboards use filtered bilinear + mips,** and the mip chain only pays off once texture scale
  is in world units (the `ms = sc * mw` floor bug).

## Verifying the live page

`?dev=1` is the sanctioned way; the `DEV` API and its three gotchas are in
[`../README.md`](../README.md) ("Driving the game from a console"). Two rules on top of it:

- **A claim checked through `DEV` counts as verified; a claim checked by guessing at internals does
  not.** The first hunt that needed it wasted turns assigning to `P.yaw`, which does not exist.
- **Read the source the page is actually running** before believing a behaviour probe — a Pages
  deploy leaves the previous build cached for its `max-age`. Assert on a marker that is **code,
  not prose**, grepped out of the merged file. See [`ENGINEERING.md`](ENGINEERING.md).
