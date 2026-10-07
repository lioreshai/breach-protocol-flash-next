#!/usr/bin/env python3
"""Release-only notes and a cadence measured from published releases."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

RESET_BRANCH = 'release/changelog-policy-reset'
RESET_TEXT = '# Changelog\n\nRelease notes are recorded here when a version is published.\n'
VERSION = r'v\d+\.\d+(?:\.\d+)?'
SHA = r'[0-9a-f]{40}'
ARTIFACTS = {'CHANGELOG.md', 'release.json', 'release-policy.json'}


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


def evaluate(policy, release, main_sha, tag_sha, now):
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
    return dict(due=due, reason='release due' if due else 'not due' if changed else 'no new changes',
                cadence_seconds=seconds, main_sha=main_sha, last_tag=release['tag_name'],
                last_published_at=release['published_at'], due_at=due_at.isoformat())


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


def status(repo, branch=''):
    # Read policy from main, so a feature PR cannot waive debt by editing it.
    main_sha = api(repo, 'git/ref/heads/main')['object']['sha']
    from base64 import b64decode
    policy_file = api(repo, 'contents/release-policy.json?ref=' + main_sha, optional=branch == RESET_BRANCH)
    policy = json.loads(b64decode(policy_file['content'])) if policy_file else json.loads(Path('release-policy.json').read_text())
    release = api(repo, 'releases/latest', optional=True)
    tag_sha = api(repo, 'commits/' + release['tag_name'])['sha'] if release else None
    value = evaluate(policy, release, main_sha, tag_sha, datetime.now(timezone.utc))
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
            'The product lead prepares the release PR and publishes its merged commit after green checks. '
            'Record concrete blockers here. See docs/RELEASE.md.')
    if matching:
        if matching[0].get('body') != body:
            call(['gh', 'api', 'repos/' + repo + '/issues/' + str(matching[0]['number']),
                  '--method', 'PATCH', '--input', '-'], json.dumps({'body': body}))
    else:
        api(repo, 'issues', {'title': title, 'body': body, 'labels': ['release-due']})


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
    else:
        value = json.loads(Path(args.input).read_text())
        if args.command == 'notify':
            notify(args.repo, value)
        elif value['due'] and not value['waived']:
            raise ValueError('release cadence is overdue; the product lead must finish the release handoff')
        else:
            print('Release cadence passed' + (' (release PR pays the debt)' if value['waived'] else ''))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print('Release policy: ' + str(error), file=sys.stderr)
        sys.exit(1)
