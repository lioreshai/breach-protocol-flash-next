import base64
import importlib.util
import os
from pathlib import Path
import re
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


class ApiArtifactTests(unittest.TestCase):
    """The runner's checkout is shallow and may hold no tag objects at all, so the same
    assertions have to be answerable from the forge's objects instead. These rows build a real
    repository (the forge), a real depth-1 clone of it (the checkout), and a bridge that answers
    API paths out of the forge's real Git objects - so a sabotage is still a real tag, and the
    shapes are still the API's."""

    def forge_and_checkout(self, tmp, tag='annotated', forge_tag=True):
        forge = Path(tmp) / 'forge'
        forge.mkdir()
        ReleaseArtifactTests.repo(self, str(forge))
        release = git(str(forge), 'rev-parse', 'HEAD')
        if forge_tag:
            if tag == 'lightweight':
                git(forge, 'tag', 'v1.1', release)
            elif tag == 'actions':
                env = dict(os.environ, GIT_COMMITTER_NAME='GitHub Actions',
                           GIT_COMMITTER_EMAIL='action@github.com')
                subprocess.run(['git', 'tag', '-a', '-m', 'v1.1', 'v1.1', release], cwd=str(forge),
                               env=env, capture_output=True, check=True)
            else:
                git(forge, 'tag', '-a', '-m', 'v1.1', 'v1.1', release)
        checkout = Path(tmp) / 'checkout'
        # --no-tags is the state a runner is in when its tag fetch did not deliver; without it the
        # clone is depth 1 but tagged, which is the other shape, covered separately.
        subprocess.run(['git', 'clone', '-q', '--depth', '1', '--no-tags',
                        forge.as_uri(), str(checkout)], capture_output=True, check=True)
        return str(forge), str(checkout)

    def test_tag_read_through_the_api_verifies_without_a_tag_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp)
            self.assertEqual(git(checkout, 'tag', '--list'), '', 'clone must hold no tags')
            errors, notes = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertEqual(errors, [], notes)
            self.assertIn('through the API', ' '.join(notes))

    def test_lightweight_tag_read_through_the_api_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp, tag='lightweight')
            errors, _ = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertIn('lightweight tag', ' '.join(errors))

    def test_tagger_identity_is_checked_through_the_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp, tag='actions')
            errors, _ = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertIn('tagger is', ' '.join(errors))
            self.assertIn('GitHub Actions', ' '.join(errors))

    def test_tag_on_the_wrong_commit_is_caught_through_the_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp)
            git(forge, 'tag', '-f', '-a', '-m', 'v1.1', 'v1.1', 'HEAD~1')
            errors, _ = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertIn('whose release.json names', ' '.join(errors))

    def test_tag_not_descending_from_prepared_from_is_caught_through_the_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp)
            git(forge, 'checkout', '-q', '--orphan', 'other')
            (Path(forge) / 'b.txt').write_text('two\n')
            git(forge, 'add', 'b.txt')
            git(forge, 'commit', '-q', '-m', 'unrelated')
            orphan = git(forge, 'rev-parse', 'HEAD')
            git(forge, 'checkout', '-q', 'main')
            (Path(forge) / 'release.json').write_text(manifest('v1.1', orphan, 'v1.0'))
            git(forge, 'add', 'release.json')
            git(forge, 'commit', '-q', '--amend', '--no-edit')
            git(forge, 'tag', '-f', '-a', '-m', 'v1.1', 'v1.1', git(forge, 'rev-parse', 'HEAD'))
            # The checkout is depth 1, so re-read the manifest it is checking from the forge.
            subprocess.run(['git', 'fetch', '-q', '--depth', '1', 'origin', 'main'], cwd=checkout,
                           capture_output=True, check=True)
            subprocess.run(['git', 'reset', '-q', '--hard', 'origin/main'], cwd=checkout,
                           capture_output=True, check=True)
            errors, notes = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertIn('does not descend from', ' '.join(errors))
            del notes

    def test_tag_absent_from_the_forge_is_still_a_named_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp, forge_tag=False)
            errors, notes = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertIn('refs/tags/v1.1 does not exist', ' '.join(errors))
            self.assertIn('outstanding step', ' '.join(errors))
            self.assertIn('API', ' '.join(notes))

    def test_unreachable_api_with_no_local_tag_is_a_failure_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp)
            errors, _ = identity.check_release('HEAD', '', checkout, api=dead_api)
            self.assertIn('cannot be checked', ' '.join(errors))
            del forge

    def test_shallow_checkout_with_the_tag_object_finishes_through_the_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            forge, checkout = self.forge_and_checkout(tmp)
            subprocess.run(['git', 'fetch', '-q', '--tags', '--force', 'origin'], cwd=checkout,
                           capture_output=True, check=True)
            errors, notes = identity.check_release('HEAD', '', checkout, api=api_from_repo(forge))
            self.assertEqual(errors, [], notes)
            # Either the objects were all there or the API filled the gap; the row must say which.
            self.assertTrue(notes or not any('not in this fetch' in n for n in notes))


def _git(cwd, *args):
    result = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)
    return result.returncode, result.stdout


def dead_api(path):
    """The forge could not be consulted at all - no gh, no token, no network."""
    return False, None


def api_from_repo(forge):
    """Answer the API paths the checker uses, out of real Git objects in `forge`. Only the shapes
    are the API's; every fact comes from Git, so a sabotaged tag still changes the answer."""
    def api(path):
        if path.startswith('git/ref/tags/'):
            name = path.rsplit('/', 1)[-1]
            code, sha = _git(forge, 'rev-parse', '--verify', '--quiet', 'refs/tags/' + name)
            if code:
                return True, None
            _, kind = _git(forge, 'cat-file', '-t', sha.strip())
            return True, {'object': {'sha': sha.strip(), 'type': kind.strip()}}
        if path.startswith('git/tags/'):
            sha = path.rsplit('/', 1)[-1]
            code, body = _git(forge, 'cat-file', 'tag', sha)
            if code:
                return False, None
            header, _, message = body.partition('\n\n')
            tagger = re.search(r'^tagger (.*?) <(.*?)> \d+', header, re.M)
            return True, {'object': {'sha': re.search(r'^object ([0-9a-f]{40})$', body, re.M).group(1)},
                          'tagger': {'name': tagger.group(1), 'email': tagger.group(2)} if tagger else {},
                          'message': message}
        if path.startswith('contents/release.json?ref='):
            ref = path.split('=', 1)[1]
            code, text = _git(forge, 'show', ref + ':release.json')
            if code:
                return True, None
            return True, {'content': base64.b64encode(text.encode()).decode()}
        if path.startswith('compare/'):
            base, _, head = path[len('compare/'):].partition('...')
            if _git(forge, 'cat-file', '-e', base + '^{commit}')[0]:
                return True, None
            if base == head.strip():
                return True, {'status': 'identical'}
            if not _git(forge, 'merge-base', '--is-ancestor', base, head)[0]:
                return True, {'status': 'ahead'}
            return True, {'status': 'behind' if not _git(forge, 'merge-base', '--is-ancestor',
                                                         head, base)[0] else 'diverged'}
        return False, None
    return api


if __name__ == '__main__':
    unittest.main()
