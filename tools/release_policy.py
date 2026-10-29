#!/usr/bin/env python3
"""Release-only notes and a cadence measured from published releases."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

RESET_BRANCH = 'release/changelog-policy-reset'
RESET_TEXT = '# Changelog\n\nRelease notes are recorded here when a version is published.\n'
VERSION = r'v\d+\.\d+(?:\.\d+)?'
SHA = r'[0-9a-f]{40}'
ARTIFACTS = {'CHANGELOG.md', 'release.json', 'release-policy.json'}
# How long a merged release PR may sit untagged/unpublished before the alarm goes up.
# Measured, not guessed: #619 merged 2026-10-22T22:40:50Z and published 22:58:12Z (1042 s);
# #684 merged 2026-10-28T15:01:38Z and published 15:29:32Z (1674 s). The grace sits above both
# so a product lead working at normal speed never sees a false row, and a forgotten step does.
PUBLISH_GRACE = 3600
PUBLISHED, TAGGED, MERGED = 'published', 'tagged-not-published', 'merged-not-tagged'


def grace_seconds():
    # A knob for the sabotage run and for a box testing a shorter window; the committed
    # default is the measured one and no workflow overrides it.
    raw = os.environ.get('RELEASE_PUBLISH_GRACE', '')
    if not raw:
        return PUBLISH_GRACE
    try:
        value = int(raw)
    except ValueError:
        raise ValueError('RELEASE_PUBLISH_GRACE must be an integer number of seconds')
    if value < 0:
        raise ValueError('RELEASE_PUBLISH_GRACE must not be negative')
    return value


def publish_state(manifest, tag_sha, published, merged_at, now, grace=None):
    """Which step of docs/RELEASE.md step 4 is outstanding for the release release.json names.

    `manifest` is release.json on main, `tag_sha` the commit refs/tags/<version> peels to (or
    None), `published` the GitHub release carrying that tag (or None), `merged_at` when the
    release commit landed on main. A manifest with neither tag nor release is MERGED - a named
    outstanding step, never 'nothing to check'."""
    grace = PUBLISH_GRACE if grace is None else grace
    if not isinstance(manifest, dict):
        raise ValueError('release.json is missing from main: the release guard has nothing to guard')
    version = manifest.get('version')
    if not isinstance(version, str) or not re.fullmatch(VERSION, version):
        raise ValueError('release.json version is %r, not a release version' % (version,))
    if published is not None:
        if published.get('draft') is not False or published.get('prerelease') is not False:
            raise ValueError('the release tagged %s is a draft or prerelease, which does not '
                             'complete the handoff' % version)
        if published.get('tag_name') != version:
            raise ValueError('the latest release is tagged %r but release.json names %r'
                             % (published.get('tag_name'), version))
    if published is not None and tag_sha is None:
        raise ValueError('a release exists for %s but its tag does not' % version)
    step = PUBLISHED if published is not None else TAGGED if tag_sha else MERGED
    age = None if merged_at is None else int((now - merged_at).total_seconds())
    outstanding = step != PUBLISHED
    overdue = outstanding and age is not None and age > grace
    return dict(step=step, version=version, outstanding=outstanding, age_seconds=age,
                grace_seconds=grace, overdue=overdue,
                reason='the GitHub release is published' if step == PUBLISHED else
                'the annotated tag ' + version + ' exists but no GitHub release is published' if
                step == TAGGED else 'no tag and no release exist for ' + version)


def call(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-900:])
    return result.stdout.strip()


def api(repo, path, payload=None, optional=False):
    args = ['gh', 'api', 'repos/' + repo + '/' + path]
    if payload is not None:
        args += ['--method', 'POST', '--input', '-']
    try:
        return json.loads(call(args, json.dumps(payload) if payload is not None else None))
    except RuntimeError as error:
        if optional and 'HTTP 404' in str(error):
            return None
        raise


def stamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('release timestamps need a timezone')
    return result


def cadence_seconds(policy):
    seconds = policy.get('cadence_seconds')
    if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds <= 0:
        raise ValueError('cadence_seconds must be a positive integer')
    return seconds


def release_branch(branch):
    return branch == RESET_BRANCH or re.fullmatch('release/' + VERSION, branch) is not None


def evaluate(policy, release, main_sha, tag_sha, now, publication=None):
    seconds = cadence_seconds(policy)
    if not re.fullmatch(SHA, main_sha):
        raise ValueError('main SHA is missing or invalid')
    if release is None:
        return dict(due=True, reason='first release', cadence_seconds=seconds,
                    main_sha=main_sha, last_tag=None, last_published_at=None, due_at=None)
    if release.get('draft') is not False or release.get('prerelease') is not False:
        raise ValueError('latest release must be published and stable')
    if not re.fullmatch(VERSION, release.get('tag_name', '')) or not re.fullmatch(SHA, tag_sha or ''):
        raise ValueError('latest release tag or commit is invalid')
    published = stamp(release['published_at'])
    if published > now + timedelta(minutes=1):
        raise ValueError('latest release is dated in the future')
    due_at = published + timedelta(seconds=seconds)
    changed = main_sha != tag_sha
    due = changed and now >= due_at
    reason = 'release due' if due else 'not due' if changed else 'no new changes'
    # A release PR that has merged and is waiting on its tag/release is not a debt the next
    # feature PR pays. Before this, the merge -> publish window failed `release` on every open
    # PR (#621-#630 read BLOCKED for 18 minutes on nothing but that gap); the guard below is
    # the row that goes red, on main. Past the grace the debt is real again.
    if publication and publication['outstanding']:
        if not publication['overdue']:
            due, reason = False, 'publication in flight: ' + publication['step']
        elif due:
            reason = 'release PR merged, publication outstanding: ' + publication['step']
    return dict(due=due, reason=reason,
                cadence_seconds=seconds, main_sha=main_sha, last_tag=release['tag_name'],
                last_published_at=release['published_at'], due_at=due_at.isoformat(),
                publication=publication)


def check_changelog(branch, changed, before, after, manifest):
    touched = ARTIFACTS.intersection(changed)
    match = re.fullmatch('release/(' + VERSION + ')', branch)
    if not touched:
        if match or branch == RESET_BRANCH:
            raise ValueError('reserved release branches must contain their release package')
        return
    if branch == RESET_BRANCH and re.search(r'^## (?:Unreleased|\[Unreleased\])\s*$', before, re.M):
        if after != RESET_TEXT or 'release.json' in touched:
            raise ValueError('the one-time reset must leave only the release-notes heading')
        return
    if not match:
        raise ValueError('release files may change only in a versioned release PR; feature PRs leave them unchanged')
    if not {'CHANGELOG.md', 'release.json'}.issubset(touched):
        raise ValueError('a release must update notes and release.json together')
    if any(path not in ARTIFACTS and path != 'README.md' and not path.startswith('docs/') for path in changed):
        raise ValueError('release PRs package already merged changes; implementation belongs in feature PRs')
    if not isinstance(manifest, dict) or manifest.get('version') != match[1]:
        raise ValueError('release branch and release.json version disagree')
    if not re.fullmatch(SHA, manifest.get('prepared_from', '')):
        raise ValueError('release.json must pin the source commit')
    date = stamp(manifest['prepared_at']).date().isoformat()
    header = f'## [{match[1]}] - {date}\n'
    if not after.startswith('# Changelog\n\n' + header):
        raise ValueError('the newest changelog section must name this release and its date')
    if re.search(r'^## (?:Unreleased|\[Unreleased\])\s*$', after, re.M):
        raise ValueError('Unreleased notes are no longer supported')
    old_sections = re.search(r'^## \[v', before, re.M)
    if old_sections and not after.endswith(before[old_sections.start():]):
        raise ValueError('keep previously published release notes unchanged')
    section = after[len('# Changelog\n\n' + header):]
    if old_sections:
        section = section[:-len(before[old_sections.start():])]
    if not re.search(r'^- \S', section, re.M):
        raise ValueError('a release needs concrete notes')


def git_file(ref, file, optional=False):
    try:
        return call(['git', 'show', ref + ':' + file]) + '\n'
    except RuntimeError:
        if optional:
            return ''
        raise


def publication_on_main(repo, now=None, ref=''):
    """The publish state of the release release.json names, read from main.

    `ref` is a local git ref instead of main, used by the sabotage run so a doctored
    release.json can be checked in the one tree that made it."""
    now = now or datetime.now(timezone.utc)
    if ref:
        raw = git_file(ref, 'release.json', optional=True)
        manifest = json.loads(raw) if raw else None
        main_sha = call(['git', 'rev-parse', ref])
        merged_at = stamp(call(['git', 'log', '-1', '--format=%cI', ref, '--', 'release.json']))
    else:
        main_sha = api(repo, 'git/ref/heads/main')['object']['sha']
        from base64 import b64decode
        contents = api(repo, 'contents/release.json?ref=' + main_sha)
        manifest = json.loads(b64decode(contents['content']))
        commits = api(repo, 'commits?sha=main&path=release.json&per_page=1')
        if not isinstance(commits, list) or not commits:
            raise ValueError('no commit on main touches release.json; the release guard cannot '
                             'date the outstanding step')
        merged_at = stamp(commits[0]['commit']['committer']['date'])
    version = manifest.get('version') if isinstance(manifest, dict) else None
    if not isinstance(version, str) or not re.fullmatch(VERSION, version or ''):
        raise ValueError('release.json version is %r, not a release version' % (version,))
    tag_sha = api(repo, 'commits/' + version, optional=True)
    tag_sha = tag_sha['sha'] if tag_sha else None
    release = api(repo, 'releases/tags/' + version, optional=True)
    if release is not None and release.get('tag_name') != version:
        raise ValueError('the release queried for %s reports tag_name %r' % (version, release.get('tag_name')))
    return publish_state(manifest, tag_sha, release, merged_at, now, grace_seconds()), main_sha


def status(repo, branch=''):
    # Read policy from main, so a feature PR cannot waive debt by editing it.
    main_sha = api(repo, 'git/ref/heads/main')['object']['sha']
    from base64 import b64decode
    policy_file = api(repo, 'contents/release-policy.json?ref=' + main_sha, optional=branch == RESET_BRANCH)
    policy = json.loads(b64decode(policy_file['content'])) if policy_file else json.loads(Path('release-policy.json').read_text())
    release = api(repo, 'releases/latest', optional=True)
    tag_sha = api(repo, 'commits/' + release['tag_name'])['sha'] if release else None
    publication = publication_on_main(repo)[0]
    value = evaluate(policy, release, main_sha, tag_sha, datetime.now(timezone.utc), publication)
    value['waived'] = bool(re.fullmatch('release/' + VERSION, branch)) or (branch == RESET_BRANCH and policy_file is None)
    return value


def notify(repo, value):
    title = 'Release due: scheduled release cadence'
    issues = api(repo, 'issues?state=open&labels=release-due&per_page=30')
    if len(issues) == 30:
        raise ValueError('release-debt issue query filled its page; cannot create another reliably')
    matching = [issue for issue in issues if issue['title'] == title and 'pull_request' not in issue]
    if len(matching) > 1:
        raise ValueError('more than one release-debt issue exists')
    if not value['due']:
        if matching:
            call(['gh', 'issue', 'close', str(matching[0]['number']), '--repo', repo,
                  '--comment', 'Published release cadence is current.'])
        return
    if api(repo, 'labels/release-due', optional=True) is None:
        api(repo, 'labels', {'name': 'release-due', 'color': 'd93f0b',
                           'description': 'A scheduled release is due; the product lead owns the handoff.'})
    body = (f"A release is due under release-policy.json ({value['cadence_seconds']} seconds).\n\n"
            f"Last published version: {value['last_tag'] or 'none'}.\n"
            f"Published at: {value['last_published_at'] or 'never'}.\n"
            f"Due at: {value['due_at'] or 'now'}.\n\n"
            + publication_line(value.get('publication')) + '\n\n'
            + 'The product lead prepares the release PR and publishes its merged commit after green checks. '
            'Record concrete blockers here. See docs/RELEASE.md.')
    if matching:
        if matching[0].get('body') != body:
            call(['gh', 'api', 'repos/' + repo + '/issues/' + str(matching[0]['number']),
                  '--method', 'PATCH', '--input', '-'], json.dumps({'body': body}))
    else:
        api(repo, 'issues', {'title': title, 'body': body, 'labels': ['release-due']})


def publication_line(publication):
    """One line naming which step of docs/RELEASE.md step 4 is outstanding, so nobody diffs
    timestamps to find out why a check is red."""
    if not publication:
        return 'Outstanding release step: unknown, the status carried no publication state.'
    age = publication['age_seconds']
    shown = 'unknown age' if age is None else f"{age} s since the release commit landed"
    if not publication['outstanding']:
        return f"Outstanding release step: none - {publication['version']} is published ({shown})."
    return (f"Outstanding release step: {publication['step']} for {publication['version']} "
            f"({shown}, alarm at {publication['grace_seconds']} s). "
            + ('PAST THE GRACE: finish the handoff - tag the merge commit and publish the release.'
               if publication['overdue'] else 'Within the grace; the tag and release are still owed.'))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check-changelog')
    check.add_argument('--base', required=True)
    check.add_argument('--head', default='HEAD')
    check.add_argument('--branch', required=True)
    query = commands.add_parser('status')
    query.add_argument('--repo', required=True)
    query.add_argument('--branch', default='')
    query.add_argument('--output', required=True)
    for name in ('notify', 'verdict'):
        command = commands.add_parser(name)
        command.add_argument('--input', required=True)
        if name == 'notify':
            command.add_argument('--repo', required=True)
    guard = commands.add_parser('publish')
    guard.add_argument('--repo', required=True)
    guard.add_argument('--ref', default='', help='local git ref instead of main, for a one-tree check')
    args = parser.parse_args()
    if args.command == 'check-changelog':
        changed = call(['git', 'diff', '--name-only', args.base, args.head]).splitlines()
        before = git_file(args.base, 'CHANGELOG.md')
        after = git_file(args.head, 'CHANGELOG.md')
        raw = git_file(args.head, 'release.json', optional=True)
        check_changelog(args.branch, changed, before, after, json.loads(raw) if raw else None)
        cadence_seconds(json.loads(git_file(args.head, 'release-policy.json')))
        if raw and 'release.json' in changed:
            call(['git', 'merge-base', '--is-ancestor', json.loads(raw)['prepared_from'], args.base])
        print('Release-only changelog policy passed.')
    elif args.command == 'status':
        value = status(args.repo, args.branch)
        Path(args.output).write_text(json.dumps(value) + '\n')
        print(json.dumps(value))
    elif args.command == 'publish':
        value, main_sha = publication_on_main(args.repo, ref=args.ref)
        print(f"release publish guard: {value['step']} for {value['version']} "
              f"(main {main_sha[:12]}, {value['age_seconds']} s since that commit, "
              f"grace {value['grace_seconds']} s) - {value['reason']}")
        if value['overdue']:
            raise ValueError('release.json on main names ' + value['version'] + ', which is '
                             + value['step'] + ' after ' + str(value['age_seconds'])
                             + ' s. docs/RELEASE.md step 4 is unfinished and every feature PR '
                               'is waiting behind it.')
    else:
        value = json.loads(Path(args.input).read_text())
        if args.command == 'notify':
            notify(args.repo, value)
        elif value['due'] and not value['waived']:
            raise ValueError('release cadence is overdue (' + value.get('reason', 'reason unknown')
                             + '); the product lead must finish the release handoff')
        else:
            print('Release cadence passed' + (' (release PR pays the debt)' if value['waived'] else '')
                  + (' - ' + value['reason'] if value.get('reason') not in (None, 'release due',
                                                                            'not due') else ''))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print('Release policy: ' + str(error), file=sys.stderr)
        sys.exit(1)
