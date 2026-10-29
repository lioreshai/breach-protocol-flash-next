import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
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
PUBLISHED = dict(RELEASE, tag_name='v1.2.1')
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
            if path.startswith('contents/release-policy.json'):
                return dict(content=b64encode(json.dumps(dict(cadence_seconds=86400)).encode()).decode())
            if path.startswith('contents/release.json'):
                return dict(content=b64encode(json.dumps(dict(version='v1.2', prepared_from=HEAD)).encode()).decode())
            if path.startswith('commits?sha=main'):
                return [dict(commit=dict(committer=dict(date=(NOW - timedelta(hours=1)).isoformat())))]
            if path == 'releases/latest':
                return RELEASE
            if path.startswith('commits/'):
                return dict(sha=TAG)
            return RELEASE
        with patch.object(policy, 'api', side_effect=api):
            self.assertFalse(policy.status('test/game', policy.RESET_BRANCH)['waived'])

    def test_publish_state_names_the_outstanding_step(self):
        manifest = dict(version='v1.2.1', prepared_from=HEAD)
        merged = NOW - timedelta(minutes=5)
        for step, tag, release in ((policy.MERGED, None, None),
                                   (policy.TAGGED, TAG, None),
                                   (policy.PUBLISHED, TAG, PUBLISHED)):
            with self.subTest(step=step):
                value = policy.publish_state(manifest, tag, release, merged, NOW)
                self.assertEqual(value['step'], step)
                self.assertEqual(value['outstanding'], step != policy.PUBLISHED)
                self.assertFalse(value['overdue'])

    def test_unpublished_state_becomes_overdue_at_the_grace_and_never_nothing_to_check(self):
        manifest = dict(version='v1.2.1', prepared_from=HEAD)
        merged = NOW - timedelta(hours=1)
        for tag, release in ((None, None), (TAG, None)):
            with self.subTest(tag=tag is not None):
                self.assertFalse(policy.publish_state(manifest, tag, release, merged, NOW,
                                                      grace=policy.PUBLISH_GRACE)['overdue'])
                past = policy.publish_state(manifest, tag, release, merged,
                                            NOW + timedelta(seconds=policy.PUBLISH_GRACE),
                                            grace=policy.PUBLISH_GRACE)
                self.assertTrue(past['overdue'])
        with self.assertRaises(ValueError):
            policy.publish_state(None, TAG, RELEASE, merged, NOW)

    def test_in_flight_publication_does_not_block_a_feature_pr(self):
        manifest = dict(version='v1.2.1', prepared_from=HEAD)
        in_flight = policy.publish_state(manifest, None, None, NOW - timedelta(minutes=5), NOW)
        value = self.status(publication=in_flight)
        self.assertFalse(value['due'])
        self.assertIn('publication in flight: merged-not-tagged', value['reason'])
        overdue = policy.publish_state(manifest, None, None, NOW - timedelta(hours=2), NOW)
        self.assertTrue(self.status(publication=overdue)['due'])

    def test_draft_or_prerelease_publication_is_never_published(self):
        manifest = dict(version='v1.2.1', prepared_from=HEAD)
        for release in (dict(RELEASE, draft=True), dict(RELEASE, prerelease=True)):
            with self.subTest(release=release), self.assertRaises(ValueError):
                policy.publish_state(manifest, TAG, release, NOW - timedelta(minutes=5), NOW)

    def test_outstanding_step_is_named_in_the_debt_issue(self):
        manifest = dict(version='v1.2.1', prepared_from=HEAD)
        line = policy.publication_line(policy.publish_state(manifest, None, None,
                                                            NOW - timedelta(hours=2), NOW))
        self.assertIn('merged-not-tagged for v1.2.1', line)
        self.assertIn('PAST THE GRACE', line)
        self.assertIn('Outstanding release step: none',
                      policy.publication_line(policy.publish_state(manifest, TAG, PUBLISHED, NOW,
                                                                   NOW)))

    def test_release_branch_and_metadata_must_match(self):
        for manifest in (None, dict(MANIFEST, version='v9.0'), dict(MANIFEST, prepared_from='bad')):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                policy.check_changelog('release/v1.2.1', ['CHANGELOG.md', 'release.json'], policy.RESET_TEXT, NOTES, manifest)

    def test_only_real_release_branches_can_pay_debt(self):
        self.assertTrue(policy.release_branch('release/v1.2.1'))
        self.assertTrue(policy.release_branch(policy.RESET_BRANCH))
        self.assertFalse(policy.release_branch('release/anything'))
        self.assertFalse(policy.release_branch('fix/doors'))


WORKFLOWS = Path(__file__).resolve().parents[1] / '.github' / 'workflows'
EVENT_TEST = re.compile(r"^github\.event_name\s*(==|!=)\s*'([a-z_]+)'")


def read_workflow(text):
    """Two facts a skipped-row audit needs: which events trigger this file, and which of its jobs
    carry an `if:` or declare themselves informational. Deliberately textual - the standard library
    has no YAML and this repo installs nothing - and it reads only indent-2 keys under `on:` and
    `jobs:` plus indent-4 `if:` / `continue-on-error:` / `name:` inside a job, which is the shape
    every workflow here uses. CI's `ruby tools/wfyaml.rb --dir .github/workflows` does the real
    parse and runs blocking, so a file this reader cannot walk is red before this row is."""
    top, job, doc = None, None, {'on': [], 'jobs': []}
    for raw in text.splitlines():
        key = re.match(r'^(\s*)([A-Za-z0-9_-]+):(.*)$', raw)
        if not key or raw.lstrip().startswith('#'):
            continue
        indent, name, rest = len(key.group(1)), key.group(2), key.group(3).strip()
        if indent == 0:
            top, job = name, None
        elif indent == 2 and top == 'on':
            doc['on'] += [name] if not rest else [p.strip() for p in rest.split(',')]
        elif indent == 2 and top == 'jobs':
            job = {'key': name, 'if': '', 'continue-on-error': False, 'name': name, 'run': []}
            doc['jobs'].append(job)
        elif indent == 4 and job is not None:
            if name == 'if':
                job['if'] = rest
            elif name == 'continue-on-error':
                job['continue-on-error'] = rest == 'true'
            elif name == 'name':
                job['name'] = rest
        elif indent >= 6 and job is not None and name == 'run':
            job['run'].append(rest)
    return doc


def runs_on(condition, event):
    """True / False / None for a job's `if:` under one event name. None means 'cannot tell', and
    only `github.event_name ==|!= 'x'` terms joined by && and || are readable - anything else, a
    parenthesized or foreign expression, is None, so an unreadable condition is never read as
    'this job is skipped here'."""
    if not condition.strip():
        return True
    if condition.strip().startswith('${{'):
        return None
    unknown = False
    for clause in condition.split('||'):
        clause_ok, clause_unknown = True, False
        for term in clause.split('&&'):
            match = EVENT_TEST.match(term.strip())
            if match is None:
                clause_unknown = True
                clause_ok = False
                continue
            equal = match.group(1) == '=='
            clause_ok = (match.group(2) == event) == equal
            if not clause_ok:
                break
        if clause_ok:
            return True
        unknown = unknown or clause_unknown
    return None if unknown else False


class PublishGuardTriggerTests(unittest.TestCase):
    """A named job that its own workflow's trigger skips still reports a check row, and an
    unclassified SKIPPED row is not a passing blocking check. So a guard that must not speak on a
    pull_request cannot be a job in a workflow that triggers on pull_request - it has to be a file
    that does not. PR #696 learned this by putting the publish guard in release-guard.yml: the row
    went from 'nine PRs blocked by someone else's unfinished release' to 'every PR blocked by a
    skipped row', which is the same alarm on the wrong people (#635)."""

    def workflows(self):
        return {p.name: read_workflow(p.read_text())
                for p in sorted(WORKFLOWS.glob('*.y*ml')) if p.is_file()}

    def test_the_condition_reader_agrees_with_the_runner(self):
        # Guards the two rows below: a reader that said 'skipped' about everything would make the
        # audit green while every job in the repo vanished from every run.
        for condition, event, want in (
                ("github.event_name == 'push'", 'pull_request', False),
                ("github.event_name == 'push'", 'push', True),
                ("github.event_name != 'push'", 'pull_request', True),
                ("github.event_name == 'push' && github.ref == 'refs/heads/main'", 'pull_request', False),
                ("github.event_name == 'push' || github.event_name == 'schedule'", 'schedule', True),
                ("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", 'pull_request', False),
                ("github.ref == 'refs/heads/main'", 'pull_request', None),
                ('', 'pull_request', True)):
            with self.subTest(condition=condition, event=event):
                self.assertEqual(runs_on(condition, event), want)

    def test_the_publish_guard_is_a_workflow_no_pull_request_runs(self):
        docs = self.workflows()
        runners = {name: doc for name, doc in docs.items()
                   if any('release_policy.py publish' in line
                          for job in doc['jobs'] for line in job['run'])}
        self.assertTrue(runners, 'no workflow runs `release_policy.py publish` at all, so a merged '
                                 'release can go unpublished with no failure anywhere (#635)')
        for name, doc in sorted(runners.items()):
            with self.subTest(workflow=name):
                self.assertNotIn('pull_request', doc['on'],
                                 f'{name} runs the publish guard and also triggers on pull_request, '
                                 'so every pull_request run carries its skipped check row')
                self.assertIn('push', doc['on'], f'{name} must run on a push to main, where the '
                                                 'release merge commit is the thing that is late')
                self.assertIn('schedule', doc['on'], f'{name} must run hourly, or a release merged '
                                                     'and then forgotten is never re-checked')

    def test_no_gating_job_is_skipped_on_an_event_its_workflow_triggers_on(self):
        bad = []
        for name, doc in sorted(self.workflows().items()):
            if 'pull_request' not in doc['on']:
                continue
            for job in doc['jobs']:
                if job['continue-on-error'] or runs_on(job['if'], 'pull_request') is not False:
                    continue
                bad.append(f"{name}: job {job['key']} (name {job['name']!r}) is gated off "
                           f'pull_request by `if: {job["if"]}` while the file still triggers on it')
        self.assertFalse(bad, 'A pull_request run reports a check row for a skipped job and an '
                              'unresolved skipped row is not a passing blocking check, so this '
                              'silently blocks PRs whose own diff is fine (#635). Give the job its '
                              'own workflow file with no pull_request trigger, or mark it '
                              'informational with continue-on-error.\n' + '\n'.join(bad))


if __name__ == '__main__':
    unittest.main()
