# Release process

A release is the moment the repo can be **pointed at**: a tag, a changelog section with a date,
screenshots that came from the build the tag names, and a GitHub release listing what shipped.

## When

Any one of these, whichever comes first:

1. **A milestone issue closes.** The milestones are issues too (M3 = #14, M4 = #15, M5+M6 = #16), so
   "is a milestone done" is a query, not a paragraph.
2. **50 merged PRs since the newest tag.** This is the enforcement floor, and it is the one the
   `release` status check computes. 50 PRs here is roughly a week of work; past that the distance
   between "what is deployed" and "what is named" stops being reconstructible.
3. **A picture or feel change worth a baseline.** If the README's screenshots stop describing the
   game, the README is lying, so the fix is a release, not a caption edit.

The session that crosses a trigger runs this checklist. If it cannot finish, it files the debt
issue (`.github/workflows/release-guard.yml` opens one automatically on the weekly schedule) rather
than leaving the count to rise silently.

## Versioning

`## 1.0` already exists in the changelog, and its own sentence says that section is tag
`baseline-v1`. The numbering therefore runs **forward from the baseline** rather than being re-derived
underneath it:

* **`v1.0`** aliases `baseline-v1` (`git tag v1.0 baseline-v1`) so the published section has a tag.
* **MINOR** per release: `v1.1` = M0–M3, the verticality foundation.
* **MAJOR** marks a new playable-complete era: **`v2.0`** when M6's two-storey level is authored, the
  VERT lane prints `0 known-issue row(s)`, both smoke lanes are green and no P0 issue is open.
* **Patch** releases (`v1.1.1`) are for a defect that ships in a release and gets fixed shortly after;
  they carry a changelog section and nothing else.

A release whose gates are not green is not a release: if a known-issue row is red, either it is fixed
or the release notes say so and it stays an issue.

## Checklist

Work on a branch named `release/vX.Y`. That name matters: the guard waives debt **only** for a
branch starting `release/`, which is what keeps the release PR itself mergeable while the debt is
what the PR exists to pay.

```bash
git checkout -b release/vX.Y main
```

1. **Changelog.** Move everything under `Unreleased` into `## [vX.Y] – YYYY-MM-DD`, keeping the
   Added / Changed / Fixed split and keeping the measured numbers in the text. `Unreleased` must carry
   **exactly one** heading of each kind before you re-header it: a PR that adds its own `### Fixed`
   instead of appending to the existing one is how the section ends up with two, and the second set
   silently survives a release as part of the wrong version. A release section that says "various
   fixes" is the thing this repo's changelog was written to not be.
2. **Screenshots, from the deployed build** into `docs/screens/`, and any defect visible in a shot
   goes into its caption rather than being cropped (`AGENTS.md`, hard rule). Not from a headless
   dump, not from an older checkout — `https://lioreshai.github.io/breach-protocol-flash-next/`.
   Then `node tools/recap.js check`, which gates the README's quoted numbers against the files it
   embeds. The capture happens on the host; the files do not live there, so a docs PR is verified
   against the **merged tree** ([`ENGINEERING.md`](ENGINEERING.md), "Deploys, docs and git").

   **Name the deal the photograph took, because five caption numbers depend on it.** Open
   **`?dev=1&seed=<n>`**, never `?dev=1` alone: without the seed `Math.random` is unseeded
   (`js/90_dev.js:23-26`), so **every boot deals a different level** — `DEV.state().seed` reads
   `null`, and that file's own comment records two unseeded layouts (`2016015967` vs `34562729`). A
   caption's mean luma is then a property of one session's random draw, and `recap check` is gating a
   number nobody can re-derive. The PNGs in `docs/screens/` were captured 2026-10-01 (`8f34527`);
   the seed parameter landed 2026-10-02 (`8c7a626`). **Their numbers are era measurements, not
   reproducible claims** — record the seed beside each shot, in the caption or the commit body.

   The rest of the recipe, one line per wrong shot:

   - **Window 1440×763.** The canvas buffer equals the CSS size, which is the geometry every existing
     PNG has; another window changes every row statistic silently.
   - **`DEV.boot(); DEV.freeze(true); DEV.tick(30)`**, then `DEV.cam(...)` and one `DEV.tick(1)` per
     shot. `freeze` pins the clock but `S.t` cannot be assigned (a write snapped back to 5.13), so
     pickup and portal bob stay wall-clock dependent and **two sessions' PNGs will never be
     md5-equal** — compare statistics, never hashes.
   - **Never reach for `DEV.clear()` to get an enemy out of frame.** It leaves **`0 LEFT`** on the
     HUD, a dev artifact rather than a game state, and it lands in the caption. Re-`boot()` instead:
     the seed restores that level's own enemies. To *add* a posed body use `DEV.spawn(kind, 1, 6)`.
   - **Rank poses with `DEV.lum()`, not with screenshots.** Same Rec.709 rule `recap` uses, and it
     tracked the decoded PNG to one point (58.3 against 57.41), so a sweep of yaws and cells costs
     renders instead of round trips. It ranks candidates; it does not accept them — still look.
   - **Prove which build the page runs with an eval-visible marker.** A function-local `const` is not
     one: `typeof SHOULDER_LIFT` read `undefined` on a page that *had* the change, because the
     declaration sits inside a function (`js/13_mesh.js:90`). A name on a shipped export table works
     and can carry the claim with it — `MESH.neckBand` exists only in that build and returned the
     band it was verifying.
   - **A pose must show what its caption says.** A staircase found by scanning `MAP.fz` along +x is a
     row of cells the camera *stands in*: viewed along the row it reads as one band whatever the
     feature byte says (`FEAT_STAIR`, no ramp bits, `(9..12, 1)` looked like a single step in three
     framings). Confirm the risers are in the frame before writing the caption, and re-derive the
     pose when they are not.
3. **Direction.** `docs/ROADMAP.md` gets its constraints updated if measurements moved (frame
   budgets, raster medians). No status tables.
4. **Gates**, with the numbers in the release PR body:

   ```bash
   node tools/smoke.js                      # must print SMOKE PASSED
   VERT=1 node tools/smoke.js               # row count and known-issue count, both quoted
   for p in heights mip anim props vert planes sight drop horizon cull exposure; do
     node tools/view.js $p >/dev/null 2>&1; printf "[%s] %s  " "$?" "$p"; done
   ```

   A red gate is not a release. If a known-issue row is red, either it is fixed or it stays an issue
   and the release says so in its notes.
5. **Merge by API with the full head SHA** (never `gh pr merge`, and never swallow the merge's
   stderr — a `405 … required status checks are expected` means the merge ref is stale):

   ```bash
   R=lioreshai/breach-protocol-flash-next
   sha=$(gh pr view N --repo "$R" --json headRefOid --jq .headRefOid)
   gh api -X PUT "repos/$R/pulls/N/merge" -f sha="$sha" -f merge_method=squash
   ```
6. **Tag the merge commit and publish** — the tag goes on `main` after the merge, not on the branch:

   ```bash
   git checkout main && git pull --ff-only
   git tag -a vX.Y -m "vX.Y: <milestone> — <one line>" && git push --follow-tags
   gh release create vX.Y --generate-notes --title "vX.Y <name>" \
     --notes-file /tmp/notes.md          # milestones closed and issues since the last tag
   ```
7. **Verify the page** the tag describes: the GitHub Pages deploy, then a `?dev=1` boot with no
   thrown errors and the probes' claims re-checked through `DEV` (`README.md`: *Driving the game
   from a console*). The deployed build is the source of truth for a merged commit.

## How the debt reads

`.github/workflows/release-guard.yml` runs on every PR, weekly, and on demand. It counts merged PRs
whose `mergedAt` is newer than the newest tag (`gh pr list --state merged --limit 500 --json
mergedAt` — the same command a human would run; a REST `sort=updated` paginate can hide a merged PR
behind closed ones inside the page budget, so it is not used), and:

* **≥ 50** → the `release` check fails, naming the count and the tag. It is a required check, so
  merges stop until a release lands.
* **API error** → the check fails too, never "0 merged PRs, all clear". A guard that reports clean on
  a query that errored is worse than no guard (issue #122).
* **Weekly, if due** → opens or updates one issue titled `Release debt: N merged PRs since vX`, so
  the debt is visible in the tracker and not only as a red check on someone's PR.
* **Branch `release/*`** → the verdict is waived for that PR, printed as waived, and the merge is what
  clears the count. This is the only exemption, and it is a branch name a reviewer can see.
