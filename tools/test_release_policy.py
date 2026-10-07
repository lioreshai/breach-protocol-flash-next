import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch
from base64 import b64encode
import json

spec = importlib.util.spec_from_file_location('release_policy', Path(__file__).with_name('release_policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
NOW = datetime(2026, 10, 7, tzinfo=timezone.utc)
HEAD, TAG = 'a' * 40, 'b' * 40
RELEASE = dict(tag_name='v1.2', published_at=(NOW - timedelta(days=1)).isoformat(), draft=False, prerelease=False)
MANIFEST = dict(version='v1.2.1', prepared_from=HEAD, prepared_at=NOW.isoformat())
NOTES = '# Changelog\n\n## [v1.2.1] - 2026-10-07\n\n### Fixed\n\n- Doors open correctly.\n'


class ReleasePolicyTests(unittest.TestCase):
    def status(self, **changes):
        values = dict(policy={'cadence_seconds': 86400}, release=RELEASE, main_sha=HEAD, tag_sha=TAG, now=NOW)
        values.update(changes)
        return policy.evaluate(**values)

    def test_deadline_is_enforced_at_the_exact_boundary(self):
        self.assertTrue(self.status()['due'])
        self.assertFalse(self.status(now=NOW - timedelta(microseconds=1))['due'])

    def test_no_changes_means_no_empty_release(self):
        self.assertFalse(self.status(main_sha=TAG, now=NOW + timedelta(days=30))['due'])

    def test_first_release_is_due(self):
        self.assertTrue(self.status(release=None, tag_sha=None)['due'])

    def test_a_new_publication_resets_the_clock(self):
        self.assertFalse(self.status(release=dict(RELEASE, published_at=NOW.isoformat()))['due'])

    def test_invalid_release_metadata_never_means_no_debt(self):
        for release in (dict(RELEASE, draft=True), dict(RELEASE, prerelease=True),
                        dict(RELEASE, published_at='bad'), dict(RELEASE, published_at=NOW.replace(tzinfo=None).isoformat()),
                        dict(RELEASE, published_at=(NOW + timedelta(days=1)).isoformat())):
            with self.subTest(release=release), self.assertRaises(ValueError):
                self.status(release=release)

    def test_invalid_cadence_is_rejected(self):
        for seconds in (True, 0, -1, '86400'):
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                self.status(policy={'cadence_seconds': seconds})

    def test_feature_prs_do_not_need_changelog_entries(self):
        policy.check_changelog('fix/doors', ['js/doors.js'], policy.RESET_TEXT, policy.RESET_TEXT, None)

    def test_feature_prs_cannot_modify_release_files(self):
        for file in policy.ARTIFACTS:
            with self.subTest(file=file), self.assertRaises(ValueError):
                policy.check_changelog('fix/doors', [file], policy.RESET_TEXT, NOTES, MANIFEST)

    def test_reset_is_once_only_and_has_no_historical_notes(self):
        policy.check_changelog(policy.RESET_BRANCH, ['CHANGELOG.md', 'release-policy.json'], '## Unreleased\nold notes', policy.RESET_TEXT, None)
        policy.check_changelog(policy.RESET_BRANCH, ['CHANGELOG.md', 'release-policy.json'], '## [Unreleased]\nold notes', policy.RESET_TEXT, None)
        with self.assertRaises(ValueError):
            policy.check_changelog(policy.RESET_BRANCH, ['CHANGELOG.md'], policy.RESET_TEXT, policy.RESET_TEXT, None)

    def test_a_versioned_release_adds_concrete_notes_and_matching_metadata(self):
        policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json'], policy.RESET_TEXT, NOTES, MANIFEST)

    def test_old_release_notes_are_preserved(self):
        before = '# Changelog\n\n## [v1.2] - 2026-10-01\n\n- Initial build.\n'
        policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json'], before, NOTES + '\n' + before[13:], MANIFEST)
        with self.assertRaises(ValueError):
            policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json'], before, NOTES, MANIFEST)

    def test_release_branch_is_not_an_implementation_bypass(self):
        with self.assertRaises(ValueError):
            policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json', 'js/doors.js'], policy.RESET_TEXT, NOTES, MANIFEST)
        for branch in ('release/v1.2.1', policy.RESET_BRANCH):
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                policy.check_changelog(branch, ['js/doors.js'], policy.RESET_TEXT, policy.RESET_TEXT, None)

    def test_reset_branch_cannot_waive_cadence_after_bootstrap(self):
        def api(repo, path, optional=False):
            if path == 'git/ref/heads/main':
                return dict(object=dict(sha=HEAD))
            if path.startswith('contents/'):
                return dict(content=b64encode(json.dumps(dict(cadence_seconds=86400)).encode()).decode())
            if path == 'releases/latest':
                return RELEASE
            return dict(sha=TAG)
        with patch.object(policy, 'api', side_effect=api):
            self.assertFalse(policy.status('test/game', policy.RESET_BRANCH)['waived'])

    def test_release_branch_and_metadata_must_match(self):
        for manifest in (None, dict(MANIFEST, version='v9.0'), dict(MANIFEST, prepared_from='bad')):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json'], policy.RESET_TEXT, NOTES, manifest)

    def test_only_real_release_branches_can_pay_debt(self):
        self.assertTrue(policy.release_branch('release/v1.2.1'))
        self.assertTrue(policy.release_branch(policy.RESET_BRANCH))
        self.assertFalse(policy.release_branch('release/anything'))
        self.assertFalse(policy.release_branch('fix/doors'))


if __name__ == '__main__':
    unittest.main()
