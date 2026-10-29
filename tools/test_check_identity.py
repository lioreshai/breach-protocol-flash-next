import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_identity', Path(__file__).with_name('check_identity.py'))
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)

NAME, EMAIL = 'Liore Shai', 'liores@gmail.com'


def git(cwd, *args, identity_ok=True):
    env = dict(os.environ, GIT_AUTHOR_NAME=NAME, GIT_AUTHOR_EMAIL=EMAIL,
               GIT_COMMITTER_NAME=NAME, GIT_COMMITTER_EMAIL=EMAIL)
    result = subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True)
    assert result.returncode == 0, (args, result.stderr)
    return result.stdout.strip()


def manifest(version, prepared, previous):
    return ('{\n  "version": "%s",\n  "prepared_from": "%s",\n  "previous_tag": "%s"\n}\n'
            % (version, prepared or '' * 40, previous))


class ReleaseArtifactTests(unittest.TestCase):
    """One throwaway repository per case: the checker reads real Git objects, so the
    sabotage is a real tag, a real manifest, a real commit - never a stubbed answer."""

    def repo(self, tmp, previous=True):
        git(tmp, 'init', '-q', '-b', 'main')
        (Path(tmp) / 'a.txt').write_text('one\n')
        (Path(tmp) / 'release.json').write_text(manifest('v1.0', None, ''))
        git(tmp, 'add', 'a.txt', 'release.json')
        git(tmp, 'commit', '-q', '-m', 'release: v1.0')
        first = git(tmp, 'rev-parse', 'HEAD')
        # release.json pins the commit it was prepared from, which for the first release is
        # its own commit; every later one pins the commit the release PR merged into.
        (Path(tmp) / 'release.json').write_text(manifest('v1.0', first, ''))
        git(tmp, 'add', 'release.json')
        git(tmp, 'commit', '-q', '-m', 'release: pin v1.0')
        first = git(tmp, 'rev-parse', 'HEAD')
        if previous:
            git(tmp, 'tag', '-a', '-m', 'v1.0', 'v1.0')
        (Path(tmp) / 'release.json').write_text(manifest('v1.1', first, 'v1.0' if previous else ''))
        git(tmp, 'add', 'release.json')
        git(tmp, 'commit', '-q', '-m', 'release: v1.1')
        return tmp, first, git(tmp, 'rev-parse', 'HEAD')

    def test_annotated_tag_on_the_pinned_release_commit_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, release = self.repo(tmp)
            git(tmp, 'tag', '-a', '-m', 'v1.1', 'v1.1', release)
            errors, notes = identity.check_release('HEAD', '', tmp)
            self.assertEqual(errors, [], notes)
            self.assertEqual(notes, [])

    def test_missing_tag_is_a_failure_and_names_the_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, _ = self.repo(tmp)
            errors, notes = identity.check_release('HEAD', '', tmp)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn('refs/tags/v1.1 does not exist', errors[0])
            self.assertIn('outstanding step', errors[0])
            # The previous artifact is still verified, so the row is never "nothing to check".
            self.assertEqual(notes, [])

    def test_missing_tag_and_missing_previous_tag_is_still_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, _ = self.repo(tmp, previous=False)
            errors, _ = identity.check_release('HEAD', '', tmp)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn('no tag exists in this checkout', errors[0])

    def test_lightweight_tag_fails_the_annotated_assertion(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, release = self.repo(tmp)
            git(tmp, 'tag', 'v1.1', release)
            errors, _ = identity.check_release('HEAD', '', tmp)
            self.assertIn('lightweight tag', errors[0])

    def test_tagger_identity_is_the_authorized_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, release = self.repo(tmp)
            env = dict(os.environ, GIT_COMMITTER_NAME='GitHub Actions',
                       GIT_COMMITTER_EMAIL='action@github.com')
            subprocess.run(['git', 'tag', '-a', '-m', 'v1.1', 'v1.1', release], cwd=tmp, env=env,
                           capture_output=True, check=True)
            errors, _ = identity.check_release('HEAD', '', tmp)
            self.assertIn('tagger is', ' '.join(errors))
            self.assertIn('GitHub Actions', ' '.join(errors))

    def test_tag_on_the_wrong_commit_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, _ = self.repo(tmp)
            git(tmp, 'tag', '-a', '-m', 'v1.1', 'v1.1', 'HEAD~1')
            errors, _ = identity.check_release('HEAD', '', tmp)
            self.assertIn('whose release.json names', ' '.join(errors))

    def test_tag_that_does_not_descend_from_the_pinned_commit_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, release = self.repo(tmp)
            # An unreachable-but-present commit: the tag sits on it, so the manifest it pins
            # does not lie on the tagged commit's own history.
            git(tmp, 'checkout', '-q', '--orphan', 'other')
            (Path(tmp) / 'b.txt').write_text('two\n')
            git(tmp, 'add', 'b.txt')
            git(tmp, 'commit', '-q', '-m', 'unrelated')
            orphan = git(tmp, 'rev-parse', 'HEAD')
            git(tmp, 'checkout', '-q', 'main')
            path = Path(tmp) / 'release.json'
            data = manifest('v1.1', orphan, 'v1.0')
            path.write_text(data)
            git(tmp, 'add', 'release.json')
            git(tmp, 'commit', '-q', '--amend', '--no-edit')
            target = git(tmp, 'rev-parse', 'HEAD')
            git(tmp, 'tag', '-f', '-a', '-m', 'v1.1', 'v1.1', target)
            errors, notes = identity.check_release('HEAD', '', tmp)
            self.assertIn('does not descend from', ' '.join(errors))
            self.assertEqual(notes, [])
            del release

    def test_release_pr_names_its_own_unmade_tag_without_failing(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp, _, _ = self.repo(tmp)
            errors, notes = identity.check_release('HEAD', 'release/v1.1', tmp)
            self.assertEqual(errors, [])
            self.assertEqual(len(notes), 1, notes)
            self.assertIn('not checked', notes[0])

    def test_checkout_with_no_tags_at_all_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            git(tmp, 'init', '-q', '-b', 'main')
            (Path(tmp) / 'release.json').write_text(manifest('v1.1', 'b' * 40, 'v1.0'))
            git(tmp, 'add', 'release.json')
            git(tmp, 'commit', '-q', '-m', 'release: v1.1')
            errors, _ = identity.check_release('HEAD', '', tmp)
            self.assertIn('no tag exists in this checkout', ' '.join(errors))


if __name__ == '__main__':
    unittest.main()
