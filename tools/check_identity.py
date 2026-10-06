#!/usr/bin/env python3
"""Validate real Git objects before publication, including attribution trailers."""
import re
import subprocess
import sys

NAME = b'Liore Shai'
EMAIL = b'liores@gmail.com'
EXPECTED = NAME + b' <' + EMAIL + b'>'
TRAILER = re.compile(rb'(?mi)^(?:Co-authored-by|Co-committed-by|Signed-off-by):([^\n]*)$')


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


def main(refs):
    errors = check_refs(refs or ['HEAD'])
    if errors:
        print('Commits must use Liore Shai <liores@gmail.com> for author and committer.', file=sys.stderr)
        for error in errors[:8]:
            print(error, file=sys.stderr)
        return 1
    print('Commit identities verified.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
