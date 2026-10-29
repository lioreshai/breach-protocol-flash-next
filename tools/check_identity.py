#!/usr/bin/env python3
"""Validate real Git objects before publication, including attribution trailers.

The release half matters because a release is two artifacts, not one: the commit that
carries release.json, and the annotated tag that marks it published. `docs/RELEASE.md`
step 4 gives the tag to a person, so "merged but never tagged" is a state the repo can be
in silently - and a lightweight or mis-pointed tag is a release the identity rule cannot
see at all. So the tag release.json names is checked as a Git object, the same way every
commit here is.
"""
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


def check_tag(name, notes, cwd=None):
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
        # Shallow checkout: the ref and its object are here, the pointed-at commit is not.
        # Say so rather than reporting a check that did not run.
        notes.append(name + ': tag object verified; its target commit is not in this fetch, '
                     'so the tree and ancestry checks did not run here')
        return errors

    code, manifest = git(['show', target + ':release.json'], cwd)
    if code:
        errors.append(name + ': points at ' + target[:12] + ', whose tree has no release.json. '
                      'A release tag points at the commit that pins the release.')
        return errors
    try:
        pinned = json.loads(manifest)
    except ValueError:
        errors.append(name + ': ' + target[:12] + ':release.json is not valid JSON')
        return errors
    if pinned.get('version') != name:
        errors.append(name + ': points at ' + target[:12] + ' whose release.json names %r. '
                      'The tag and the manifest it pins disagree.' % pinned.get('version'))
    prepared = pinned.get('prepared_from', '')
    if not isinstance(prepared, str) or not SHA.fullmatch(prepared):
        errors.append(name + ': ' + target[:12] + ':release.json prepared_from is %r, not a full SHA' % prepared)
        return errors
    code, _ = git(['cat-file', '-e', prepared + '^{commit}'], cwd)
    if code:
        notes.append(name + ': prepared_from ' + prepared[:12] + ' is not in this fetch, so the '
                     'ancestry check did not run here')
        return errors
    if run(['git', 'merge-base', '--is-ancestor', prepared, target], cwd=cwd).returncode:
        errors.append(name + ': points at ' + target[:12] + ', which does not descend from '
                      'release.json prepared_from ' + prepared[:12] + '. The tag is not on the '
                      'release commit this manifest was prepared into.')
    return errors


def check_release(ref='HEAD', branch='', cwd=None):
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
        return check_tag(version, notes, cwd), notes

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

    previous = manifest.get('previous_tag')
    finding = ('release artifact %s: release.json is present and refs/tags/%s does not exist. The '
               'outstanding step is the annotated tag on the merged release commit.' % (version, version))
    if not isinstance(previous, str) or not VERSION.fullmatch(previous):
        return [finding + ' release.json previous_tag is %r, so no earlier artifact can be checked '
                'either.' % previous], notes
    code, _ = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + previous], cwd)
    if code:
        return [finding + ' The previous tag %s is missing too, so this release line has no '
                'verifiable artifact at all.' % previous], notes
    return [finding] + check_tag(previous, notes, cwd), notes


def main(argv):
    refs = [arg for arg in argv if not arg.startswith('--')]
    errors = check_refs(refs or ['HEAD'])
    notes = []
    artifact = '--release' in argv
    if artifact:
        branch = ''
        for i, arg in enumerate(argv):
            if arg == '--branch' and i + 1 < len(argv):
                branch = argv[i + 1]
        artifact_errors, notes = check_release(refs[0] if refs else 'HEAD', branch)
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
