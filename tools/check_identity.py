#!/usr/bin/env python3
"""Validate real Git objects before publication, including attribution trailers.

The release half matters because a release is two artifacts, not one: the commit that
carries release.json, and the annotated tag that marks it published. `docs/RELEASE.md`
step 4 gives the tag to a person, so "merged but never tagged" is a state the repo can be
in silently - and a lightweight or mis-pointed tag is a release the identity rule cannot
see at all. So the tag release.json names is checked as a Git object, the same way every
commit here is.
"""
import base64
import json
import re
import subprocess
import sys

NAME = b'Liore Shai'
EMAIL = b'liores@gmail.com'
EXPECTED = NAME + b' <' + EMAIL + b'>'
TRAILER = re.compile(rb'(?mi)^(?:Co-authored-by|Co-committed-by|Signed-off-by):([^\n]*)$')
VERSION = re.compile(r'v\d+\.\d+(?:\.\d+)?')
SHA = re.compile(r'[0-9a-f]{40}')


def run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True)


def git(args, cwd=None):
    """Return (returncode, stdout) for a git command; never raises on a non-zero exit,
    because for several of these the non-zero answer IS the measurement."""
    result = run(['git'] + args, cwd=cwd)
    return result.returncode, result.stdout.decode('utf-8', 'replace').strip()


def check_refs(refs, cwd=None):
    result = subprocess.run(['git', 'log', '-z',
        '--pretty=format:%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B',
        '--end-of-options', *refs], cwd=cwd, capture_output=True, check=True)
    fields = result.stdout.split(b'\0') if result.stdout else []
    if len(fields) % 6:
        raise ValueError('Malformed Git identity records')
    errors = []
    for i in range(0, len(fields), 6):
        sha, author, email, committer, committer_email, body = fields[i:i+6]
        if (author, email, committer, committer_email) != (NAME, EMAIL, NAME, EMAIL):
            errors.append(sha.decode()[:12] + ': incorrect author or committer')
        if any(match[1].strip() != EXPECTED for match in TRAILER.finditer(body)):
            errors.append(sha.decode()[:12] + ': incorrect attribution trailer')
    return errors


def api_get(repo, path):
    """GET repos/<repo>/<path> through gh. Returns (reachable, value); reachable False means the
    API could not be consulted at all - no gh, no token, no network - which is a fact about the
    environment, not a verdict about the release. The publish guard in release_policy.py reads the
    tag the same way; the identity checks reuse that so a checkout without tag objects can still
    answer whether the release artifact exists and who stamped it."""
    try:
        result = subprocess.run(['gh', 'api', 'repos/%s/%s' % (repo, path)],
                                capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False, None
    if result.returncode:
        if 'HTTP 404' in (result.stderr or ''):
            return True, None
        return False, None
    try:
        return True, json.loads(result.stdout)
    except ValueError:
        return False, None


def make_api(repo):
    """A callable that answers API paths, or None when no repository was named. Passing the repo
    explicitly keeps the checker honest off CI: without it nothing reaches the network."""
    return None if not repo else (lambda path: api_get(repo, path))


def tag_object(name, api):
    """('absent' | 'object' | 'unavailable', facts) for the tag `name` as the forge holds it.
    facts carries annotated / tagger / target / message, the same fields the local Git-object
    reads produce. Annotated-ness is visible in the ref alone: the API reports a lightweight tag's
    object type as 'commit' and an annotated one as 'tag'."""
    reachable, ref = api('git/ref/tags/' + name)
    if not reachable:
        return 'unavailable', {}
    if ref is None:
        return 'absent', {}
    obj = ref.get('object') or {}
    target = obj.get('sha', '')
    if obj.get('type') != 'tag':
        return 'object', {'annotated': False, 'target': target}
    reachable, tag = api('git/tags/' + target)
    if not reachable or not isinstance(tag, dict):
        return 'unavailable', {'target': target}
    tagger = tag.get('tagger') or {}
    return 'object', {'annotated': True, 'target': (tag.get('object') or {}).get('sha', ''),
                      'tagger': ((tagger.get('name') or '').strip(),
                                 (tagger.get('email') or '').strip()),
                      'message': tag.get('message') or ''}


def identity_facts(name, facts):
    """Annotated, and stamped by the authorized identity - asserted from whatever the forge or the
    local tag object reports about the tag itself."""
    errors = []
    if not facts.get('annotated'):
        errors.append(name + ': lightweight tag (the ref points straight at a commit). A release '
                      'tag must be ANNOTATED: the tagger is the only identity a release artifact carries.')
        return errors
    if tuple(facts.get('tagger') or ()) != (NAME.decode(), EMAIL.decode()):
        tagger, email = (list(facts.get('tagger') or ['', '']) + ['', ''])[:2]
        errors.append(name + ': tagger is %r %s, must be %s <%s>'
                      % (tagger, email, NAME.decode(), EMAIL.decode()))
    if any(match[1].strip() != EXPECTED for match in TRAILER.finditer(facts['message'].encode())):
        errors.append(name + ': incorrect attribution trailer on the tag')
    return errors


def check_pin(name, target, text, api=None, cwd=None, notes=None, local=True):
    """What has to hold of the commit the tag points at. Its own release.json must name this
    version, and the tag must descend from the commit that manifest pins. One copy of the
    arithmetic for the local-object path and the API path, so the two cannot drift."""
    if text is None:
        return [name + ': ' + target[:12] + ': release.json could not be read, so the pin this tag '
                'claims cannot be checked.']
    try:
        pinned = json.loads(text)
    except ValueError:
        return [name + ': ' + target[:12] + ':release.json is not valid JSON']
    errors = []
    if pinned.get('version') != name:
        errors.append(name + ': points at ' + target[:12] + ' whose release.json names %r. '
                      'The tag and the manifest it pins disagree.' % pinned.get('version'))
    prepared = pinned.get('prepared_from', '')
    if not isinstance(prepared, str) or not SHA.fullmatch(prepared):
        return errors + [name + ': ' + target[:12] + ':release.json prepared_from is %r, not a full SHA'
                         % prepared]
    if not local:
        return errors + ancestry(name, pinned.get('prepared_from', ''), target, api, cwd, notes, local=False)
    code, _ = git(['cat-file', '-e', prepared + '^{commit}'], cwd)
    if code:
        if notes is not None:
            notes.append(name + ': prepared_from ' + prepared[:12] + ' is not in this fetch, so the '
                         'ancestry check did not run here')
        return errors
    return errors + ancestry(name, prepared, target, api, cwd, notes, local=local)


def not_descends(name, target, prepared):
    return (name + ': points at ' + target[:12] + ', which does not descend from release.json '
            'prepared_from ' + prepared[:12] + '. The tag is not on the release commit this '
            'manifest was prepared into.')


def ancestry(name, prepared, target, api, cwd, notes, local=True):
    """An error when the tag does not sit on the history the manifest pins, a note when the tree
    cannot tell. A shallow fetch can hold both ends and nothing between them - a depth-1 checkout
    plus a tag fetch leaves the release commit and the tag's target as two separate shallow tips -
    and then `merge-base --is-ancestor` answers no about a tag that is entirely correct. Proving
    it locally is sound, so local success wins; a local 'no' is only conclusive when the history
    is complete, and otherwise the forge is asked. (#635: this is the false red a runner shows.)"""
    if local:
        if not run(['git', 'merge-base', '--is-ancestor', prepared, target], cwd=cwd).returncode:
            return []
        if git(['rev-parse', '--is-shallow-repository'], cwd)[1] != 'true':
            return [not_descends(name, target, prepared)]
    if api is not None:
        reachable, comparison = api('compare/%s...%s' % (prepared, target))
        if not reachable or not isinstance(comparison, dict):
            if notes is not None:
                notes.append(name + ': the API could not answer compare for prepared_from '
                             + prepared[:12] + ', so the ancestry check did not run here')
            return []
        return [] if comparison.get('status') in ('ahead', 'identical') \
            else [not_descends(name, target, prepared)]
    if local:
        notes.append(name + ': the path from prepared_from ' + prepared[:12] + ' to the tagged '
                     'commit is not in this shallow fetch, so the ancestry check could not be '
                     'decided here')
        return []
    return [not_descends(name, target, prepared)]


def check_tag(name, notes, cwd=None, api=None):
    """The tag object `name` exists as a ref. Assert it is annotated, carries the
    authorized tagger identity, and points at a commit whose own release.json is this
    version and descends from the commit that manifest pins."""
    errors = []
    ref = 'refs/tags/' + name
    _, obj_type = git(['cat-file', '-t', ref], cwd)
    if obj_type == 'tag':
        _, message = git(['for-each-ref', '--format=%(contents)', ref], cwd)
        if any(match[1].strip() != EXPECTED for match in TRAILER.finditer(message.encode())):
            errors.append(name + ': incorrect attribution trailer on the tag')
    elif obj_type == 'commit':
        errors.append(name + ': lightweight tag (the ref points straight at a commit). A release '
                      'tag must be ANNOTATED: the tagger is the only identity a release artifact carries.')
    else:
        errors.append(name + ': refs/tags/' + name + ' resolves to %r, not to a tag or commit object' % obj_type)
        return errors

    _, who = git(['for-each-ref', '--format=%(taggername)|%(taggeremail)', ref], cwd)
    if obj_type == 'tag':
        tagger, _, email = who.partition('|')
        if (tagger.strip(), email.strip(' <>')) != (NAME.decode(), EMAIL.decode()):
            errors.append(name + ': tagger is %r %s, must be %s <%s>'
                          % (tagger.strip(), email.strip(), NAME.decode(), EMAIL.decode()))
    elif who:
        errors.append(name + ': lightweight tag reports a tagger field %r' % who)

    code, target = git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], cwd)
    if code:
        # Shallow checkout: the ref and its object are here, the pointed-at commit is not. The tag
        # object itself still names that commit, so read it off the object rather than peeling the
        # ref, and finish the pin/ancestry checks through the API when one is wired up.
        target = ''
        if obj_type == 'tag':
            _, body = git(['cat-file', 'tag', ref], cwd)
            found = re.search(r'^object ([0-9a-f]{40})$', body, re.M)
            target = found.group(1) if found else ''
        if api is not None and target:
            errors += check_pin(name, target, manifest_at_api(target, api), api=api, notes=notes,
                                local=False)
            notes.append(name + ': tag object verified locally; its target commit is not in this '
                         'fetch, so the tree and ancestry checks ran through the API')
            return errors
        notes.append(name + ': tag object verified; its target commit is not in this fetch, '
                     'so the tree and ancestry checks did not run here')
        return errors

    code, manifest = git(['show', target + ':release.json'], cwd)
    if code:
        return errors + [name + ': points at ' + target[:12] + ', whose tree has no release.json. '
                         'A release tag points at the commit that pins the release.']
    return errors + check_pin(name, target, manifest, api=api, notes=notes, cwd=cwd)


def manifest_at_api(target, api):
    """release.json as the forge sees it at commit `target`."""
    reachable, contents = api('contents/release.json?ref=' + target)
    if not reachable or not isinstance(contents, dict) or 'content' not in contents:
        return None
    try:
        return base64.b64decode(contents['content']).decode('utf-8', 'replace')
    except (ValueError, UnicodeDecodeError):
        return None


def check_release(ref='HEAD', branch='', cwd=None, api=None):
    """Check the release artifact the manifest at `ref` names. A missing tag is a NAMED
    outstanding step, never 'nothing to check'."""
    notes = []
    code, raw = git(['show', ref + ':release.json'], cwd)
    if code:
        return [ref + ': release.json is missing, so no release artifact can be checked'], notes
    try:
        manifest = json.loads(raw)
    except ValueError:
        return [ref + ': release.json is not valid JSON'], notes
    version = manifest.get('version')
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        return ['release.json version is %r, not a release tag name' % version], notes

    code, _ = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + version], cwd)
    if not code:
        return check_tag(version, notes, cwd, api=api), notes

    # The ref is not in this checkout. That is either the checkout's fault or the release's, and
    # the two must not read the same: ask the forge, which needs no tag fetch at all.
    if api is not None:
        state, facts = tag_object(version, api)
        if state == 'object':
            notes.append('%s: refs/tags/%s is not in this checkout, so the tag was read through the '
                         'API; the identity assertions ran against the forge object' % (version, version))
            errors = identity_facts(version, facts)
            return errors + check_pin(version, facts.get('target', ''),
                                     manifest_at_api(facts.get('target', ''), api),
                                     api=api, notes=notes, local=False), notes
        if state == 'absent':
            notes.append('%s: the API holds no refs/tags/%s, so the tag is outstanding rather than '
                         'unfetched' % (version, version))
            return release_finding(version, manifest, notes, api=api, local=False), notes

    _, any_tag = git(['tag', '--list'], cwd)
    if not any_tag:
        return ['refs/tags/' + version + ' cannot be checked and no tag exists in this checkout at '
                'all: fetch the tags before running the release-artifact check'], notes
    if branch == 'release/' + version:
        # docs/RELEASE.md cuts the tag on the MERGED release commit, so a release PR cannot
        # carry its own artifact yet. Named, not silently skipped.
        notes.append('release artifact %s: not checked, because the tag is cut on the merged '
                     'release commit and this ref is that release PR' % version)
        return [], notes

    return release_finding(version, manifest, notes, cwd=cwd, api=api), notes


def release_finding(version, manifest, notes, cwd=None, api=None, local=True):
    """The verdict for a release.json whose tag does not exist: name the outstanding step, and
    still verify whatever earlier artifact exists. This can never read 'nothing to check'."""
    finding = ('release artifact %s: release.json is present and refs/tags/%s does not exist. The '
               'outstanding step is the annotated tag on the merged release commit.' % (version, version))
    previous = manifest.get('previous_tag')
    if not isinstance(previous, str) or not VERSION.fullmatch(previous):
        return [finding + ' release.json previous_tag is %r, so no earlier artifact can be checked '
                'either.' % previous]
    if local:
        code, _ = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + previous], cwd)
        if code:
            return [finding + ' The previous tag %s is missing too, so this release line has no '
                    'verifiable artifact at all.' % previous]
        return [finding] + check_tag(previous, notes, cwd, api=api)
    state, facts = tag_object(previous, api)
    if state != 'object':
        return [finding + ' The previous tag %s could not be read through the API either, so this '
                'release line has no verifiable artifact at all.' % previous]
    notes.append('%s: previous artifact read through the API; %s is not in this checkout' % (previous, previous))
    return [finding] + identity_facts(previous, facts) + check_pin(
        previous, facts.get('target', ''), manifest_at_api(facts.get('target', ''), api),
        api=api, notes=notes, local=False)


def main(argv):
    # `--branch ""` is the ordinary case on a push event, and git treats an empty argument as a
    # bad revision: parse the flags out instead of filtering on "does not start with --".
    refs, branch, repo, skip = [], '', '', False
    for i, arg in enumerate(argv):
        if skip:
            skip = False
            continue
        if arg in ('--branch', '--repo'):
            value = argv[i + 1] if i + 1 < len(argv) else ''
            if arg == '--branch':
                branch = value
            else:
                repo = value
            skip = True
            continue
        if arg.startswith('--') or not arg:
            continue
        refs.append(arg)
    errors = check_refs(refs or ['HEAD'])
    notes = []
    artifact = '--release' in argv
    if artifact:
        artifact_errors, notes = check_release(refs[0] if refs else 'HEAD', branch, api=make_api(repo))
        errors += artifact_errors
    if errors:
        print('Commits must use Liore Shai <liores@gmail.com> for author and committer, and the '
              'release artifact release.json names must be a correctly tagged Git object.', file=sys.stderr)
        for error in errors[:8]:
            print(error, file=sys.stderr)
        for note in notes[:4]:
            print('note: ' + note, file=sys.stderr)
        return 1
    print('Commit identities verified.')
    if artifact:
        print('Release artifact verified.')
    for note in notes[:4]:
        print('note: ' + note)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
