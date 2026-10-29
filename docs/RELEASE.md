# Releases

The product lead owns releases and their changelog. Features describe their
changes in PRs; they do not add Unreleased entries. CHANGELOG.md starts fresh and
contains only named releases from this policy onward.

## Cadence

release-policy.json sets a daily interval (86400 seconds), measured from the
last successfully published stable GitHub release. New merged changes become
release debt when that interval expires. No changes means no empty release.
Failed attempts, tags without a published release, and product reviews do not
reset the clock. The required release check enforces debt on feature PRs;
versioned release PRs can pay it. An hourly scheduled check records overdue
releases in a release-due issue. API errors fail instead of reporting no debt.

## Prepare and publish

1. The product lead reviews changes since the last published version and writes
   concise player-facing Added, Changed and Fixed notes. Link relevant PRs and
   state unfinished work honestly. Use a new version, normally the next patch.
2. Open a release/vX.Y.Z PR containing the new CHANGELOG.md section and
   release.json. Metadata pins the merged source commit and previous version.
   Preserve earlier released sections. Release PRs package already merged work;
   implementation belongs in feature PRs.
3. The reviewer checks the release notes against the actual changes and verifies
   required CI. Integrate the exact reviewed head with the authorized author and
   committer identity and a normal fast-forward push. Never bypass protection.
4. The product lead verifies the merged release PR and green checks on its exact
   merge commit, creates an annotated tag on that commit, and publishes a GitHub
   release whose notes match the changelog. Later main commits belong to the
   next release. Verify publication; a tag alone does not complete the handoff.
5. Verify the deployed game and record any concrete blocker. Do not silently
   postpone the due date or treat a failed publication as a release.

## The handoff after the release PR merges

Nothing in this repo cuts the tag or publishes the release, so steps 4 and 5 can sit
unfinished with no failure anywhere. `release-publish.yml`'s `release publish (main)` job runs
`tools/release_policy.py publish` on every push to main and hourly: it reads release.json on
main, asks whether a published stable GitHub release carries that version and whether the tag
exists, and goes red once the state is older than the 3600 s grace. The grace is measured, not guessed - the two most recent handoffs took 1042 s and 1674 s. The release-due issue names the
same step (merged-not-tagged, tagged-not-published, or published), and `ci.yml` verifies the tag
itself as a Git object: annotated, tagged by the authorized identity, pointing at a commit whose
own release.json pins that version.

While a merged release PR is simply mid-handoff, the `release` row on other people's PRs stops
failing: the debt belongs to the release owner, and the red row now sits where the work is owed.

The one-time release/changelog-policy-reset PR clears the old cumulative log.
That exception expires once the old Unreleased section is gone.
