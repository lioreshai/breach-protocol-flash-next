# Working on this repo

Dependency-free browser FPS: software raycaster, all art and audio generated in JS at
boot. No build step, no dependencies, no network, no asset files — `js/*.js` load in
numeric filename order as plain scripts and share globals. Keep it that way.

Direction: better-looking than it has any right to, at 60 fps, then **vertical
navigation** — maps you climb through, not a flat plane. Status is
[issues](https://github.com/lioreshai/breach-protocol-flash-next/issues);
[`docs/ROADMAP.md`](docs/ROADMAP.md) holds direction and the priority rubric.

Three companions to this file, so that this one stays short enough to read every session:

| | |
|---|---|
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | The probes, the dev console, timing discipline, the measured perf facts |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) | Traps already paid for, each with the measurement that found it |
| [`docs/VERTICALITY.md`](docs/VERTICALITY.md) | The height-grid design, its milestones and its open risks |

**Keep them short.** If a tool prints a number, point at the tool instead of transcribing
it — a transcribed number rots and the tool cannot. When an instrument is superseded, the
rule it taught stays and the archaeology goes; git remembers the rest.

## Architecture invariants

- Height is a quantized per-cell grid. `ZQ = 0.25`; `MAP.fz` is floor in quanta, `MAP.cz`
  own clearance, `MAP.vb` per-boundary flags, `MAP.feat` terrain features. **One playable
  band per column** — no overlapping floors, no floor overhanging the cell below it.
- **Anything that writes `MAP.fz` or `MAP.cz` must call `linkBoundaries()` afterwards.** It
  rebuilds `MAP.vb`, `MAP.steps` and `MAP.ceilPlane`. Author heights, then validate
  reachability. A fix that preserves authored bits must *mask* them (`VB_KEEP`), never stop
  clearing derived ones.
- **A cell index is one number, so a range check on it is not a bounds check.** `gy*MW + gx`
  with `gx === -1` is a valid index into the row above. Guard `sx` and `sy` separately,
  always (`js/40_render.js:297` is the correct form).
- **A wall column has no floor plane and no ceiling.** Solid cells inherit the plane carried
  into them. Anything solving a screen row against "the plane of the cell the ray is in" must
  skip solid cells.
- Wall faces and air-to-air risers have **different spans**. A wall face is
  `[max(floorA, floorB), ceilAt(air side)]`; a riser is the side of a floor slab,
  `[min floor, max floor]`. Decals and lights carry absolute z and clamp into the span the
  renderer actually draws.
- Light is **one value per column** with a band term. Do not add a second lightmap: a fading
  transient re-splats its delta, and an un-splat landing in a derived band leaves permanent
  light.
- The ground pixel body exists **twice** — the row loop in `castGround`, and `groundPixel()`
  for off-plane columns. The duplication is a measured perf fix, not taste. Change one copy
  and you have changed the other.
- `'use strict'` cannot go in `js/11_rig.js`; it relies on implicit globals.
- Current enemies and the first-person model use `js/13_mesh.js`. The old `RIG` sheets and
  the `rim` toggle still exist and move no shipped pixel — trace the live call site before
  choosing a file or a probe.
- Before calling a field dead, grep `tools/` too: probe code strings hide reads.

## Verify before you commit

```
node tools/smoke.js                     # save/restore balance, colour variety,
                                        # raster median < 16 ms/frame, asset mem < 40 MB
VERT=1 node tools/smoke.js              # the vertical lane
node tools/view.js <probe>              # see docs/DEVELOPMENT.md for the catalogue
node --check <each changed file>        # cross-file work: parse index.html's order
```

**Gate on the tool's verdict, never on a grep for a line.** Grepping `raster cost` matched
while the assert was failing and produced commits with known-failing budgets; the VERT lane's
`N gating row(s)` census prints whether or not a row in it FAILED, which is how PR #269 went
red after a locally "passing" check. Match `SMOKE PASSED` / `SMOKE FAILED`, or the
`ASSERT FAIL` lines:

```
out=$(node tools/smoke.js 2>&1); echo "$out" | tail -3
case "$out" in *"SMOKE PASSED"*) git add -A && git commit ;; *) echo NOT COMMITTED ;; esac
```

Order of evidence, strongest first:

1. **the live page in a browser** — real GPU path, real aspect ratio, real pointer lock.
   Every merge to `main` deploys to
   `https://lioreshai.github.io/breach-protocol-flash-next/`.
2. **`node tools/view.js <probe>`** — geometry, lighting, budgets: deterministic and diffable.
3. **the smoke verdict** — must stay green; proves nothing about how anything looks.

The live site is the source of truth, so anything observable there — a screenshot, a
`browser eval` over the game's own globals, a thrown error, a measured frame delta — **is
verified, and nobody waits for a human report on it.** Asking "does this look right to you?"
about a defect already captured in a screenshot is a workflow bug, not politeness. Human
judgement rules only what the page cannot reveal: game feel, aim responsiveness, whether the
audio is pleasant, difficulty. Ask about those. Do not ask about pixels.

**Read the recorded-reference count off `node tools/view.js refs`, not off any sentence.**
`tools/refs.lock` is the machine-readable table; `refInventory` asserts declarations against
it from inside `flatparity`, which `ci.yml` runs blocking, so a stale table is a FAIL rather
than a drift. Probe blocks whose verdicts are *computed* rather than hashed have no reference
behind them — a figure quoted from their prose is one session's measurement, so label it
(#216 stays open until those blocks have rows).

**Refresh the README's screenshots after every merged PR that changes the picture.** Capture
from the deployed build into `docs/screens/` — not a headless dump, not an older build — and
put any defect visible in a shot into its caption rather than cropping it out. A defect in a
caption is known; a cropped defect becomes a bug report about someone's display.
`release-guard.yml` requires the README to embed at least one `docs/screens/*.png`.

## How a check earns trust

These are the rules the traps in [`docs/ENGINEERING.md`](docs/ENGINEERING.md) keep teaching.
They generalize; the measurements that found them are in that file.

- **A probe passing is not the same as a probe being capable of failing.** Before trusting a
  green row, ask which line creates the geometry it needs — and run it against a build without
  the fix. A row that has never been seen to fail has not been tested.
- **Name the config that exercises the mechanism, and confirm the assertion runs there.** A
  determinism check that only ran on `flat` left the deferred path with no coverage while
  printing "all configs determinism ok".
- **A mask built from a render difference can see geometry, never the shading inside it.** Use
  the coverage mask (`COV`), and A/B body shading with `TINT=k` — the `rim` toggle is dead.
- **A new `process.exit` in a probe is a gate change wearing a probe's clothes.** `ci.yml`'s
  `probes` job sets `status=1` if any listed probe exits non-zero. Ship a verdict with a
  `KNOWN` row at the measured baseline, go red only past a measured floor, promote under
  `STRICT=1`, and print the debt in the verdict line. Vacuity — no ring, a nonzero leak,
  nothing drawn where something should be — is a FAILURE, never a debt.
- **Assert the value, not the placeholder.** "not the sentinel" passes for a renamed sentinel;
  "matches the row's own solve within tolerance" does not.
- **When a bug survives a plausible arithmetic fix, the pixels are not going through that
  arithmetic.** Attribute them to a path before editing it.
- **Run the sabotage and the assertion in one tree,** and prove it by printing a marker out of
  the sabotaged file. Reverting between a variant's two probes makes every row a measurement
  of `main`.
- **A number that moved across a commit boundary is not evidence until the metric has been
  bisected too.** State the roll count beside any median — these distributions are bimodal.
- **Never report a figure you did not measure**, context percentage included. Read it, or say
  you don't know.
- **Instrumenting a hot loop changes what it costs.** Bisect by editing variants of the file
  and running the real probe against them (`JSDIR=`, or a worktree), never by timing inside it.

## Shell, watches and background jobs

- **A watch that greps for absence reports MET when the command fails.** Two terms make a
  condition honest: `[ -z "$s" ] && exit 1`, and a count of the rows you expect — never only
  the absence of a bad word. Give a watcher distinct exit codes with printed evidence; a lapse
  that prints nothing cannot be diagnosed afterwards.
- **Arm a deploy watch with a marker grepped out of the merged file**
  (`git show origin/main:<file>`), never from memory of what you wrote. A watch that cannot
  succeed prints the same `NOT MET` as a deploy that is merely slow.
- **A watch condition must contain no writes**, and no `case` or multiline shell — the harness
  wraps it on one line, so `;;` is a syntax error and the job dies in ~50 ms having polled
  nothing. Do writes in the foreground, read the effect back, then arm the pure read.
- `gh` here has no `--json` on `pr checks`; use `gh pr view N --json statusCheckRollup`. Pass
  `--repo owner/name` in anything armed from outside a checkout. `SKIPPED` is a legitimate
  conclusion, so count `SUCCESS` rows rather than total rows.
- **Background jobs race your commits, and naming a path does not save you** — `git add
  tools/view.js` sweeps whatever a running job just wrote there. While a job runs, confirm you
  own the hunks with `git diff --stat`, or wait. Annotate a mis-subject commit in `git notes`;
  rewriting history to fix a subject destroys the diff it documents.
- Probes that spin the camera also drive the player: recenter, or they walk into the void where
  the grid is undefined and the DDA never hits.

## Branch hygiene

- **Branch every change off `main`. Never stack a PR on another PR's branch.** GitHub closes a
  PR whose base branch is deleted, and `delete_branch_on_merge` is on, so merging the parent
  does exactly that — silently. Verify a fix reached `main` by grepping its content
  (`git show origin/main:js/11_rig.js | grep -c rimSil`), never by PR bookkeeping.
- **Merge through the API, not `gh pr merge --admin`** — that printed nothing and merged
  nothing (#98). Use `gh api -X PUT /repos/<repo>/pulls/<N>/merge -f sha=<full 40-char head>
  -f merge_method=squash -f commit_message="… Closes #N"`, which answers 422 on a stale SHA and
  `{"merged":true}` when it worked. **Redirect nothing from a merge call.**
- **Read `mergeStateStatus` before merging.** `BLOCKED` with every row green means a stale
  merge ref — rebase onto current `main` and force-push so CI runs against the real target,
  never admin-merge past it. The refusal is a `405`.
- Merges here are **squash** merges, so a merged branch's commit is not an ancestor of `main`.
  Detect merged branches by PR state (`gh pr list --state merged --head <branch>`), never by
  `merge-base --is-ancestor`; that is why `prune.yml` carries no ancestry check.
- **A YAML step `name:` cannot contain `': '`** — a plain scalar cannot hold colon-space, so
  the whole workflow fails to parse and nothing reports (#107). `tools/wfyaml.rb` asserts each
  workflow parses and that no job runs nothing; it cannot check its own file, so `ci.yml` and
  `pr-guard.yml` validate each other.

## Issue tracking

A PR body carries `Closes #N` — **the keyword as plain text**, not a bare `#N` and not inside
backticks. Squash merges mean a bare reference links the issue and leaves it open, and a
closing keyword inside a code span links nothing while the `issue` check in `pr-guard.yml`
stays green, because it greps raw text. `[no-issue]` is the opt-out, same shape as
`[no-changelog]`.

- **Confirm the close** with `gh issue view N --json state` after an admin squash merge. An
  issue left open after its work shipped is worse than no issue: the next reader re-does it.
- **File a measured defect as an issue in the session that measured it**, numbers in the body.
  Parked in a transcript it evaporates.
- Milestones are issues too (M2 #13, M3 #14, M4 #15, M5+M6 #16), so "what is left" is a query.
  **Strike a milestone only with the verdict that proves it beside it** — "done" is not
  something you edit into a list, it is something a tool prints.
- **Prose status tables are not to be reintroduced** in any document here.
