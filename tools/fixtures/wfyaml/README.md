# Fixtures for `node tools/wfyaml.js --self-test`

Each file here is broken in exactly ONE of the ways the guard claims to catch, and names that way in
`FIXTURE_CASES` in `tools/wfyaml.js`. `--self-test` fails if a fixture passes, fails for a different
reason, or exits with a code the table does not say - which is what keeps this set from passing by
looking at nothing. `ok.yml` and `traps.yml` are the other direction: they must parse, so a reader
that over-reports cannot go green either.

| file | the one defect |
|---|---|
| `colon-space-name.yml` | a step `name:` carrying colon-space (#107) - the whole file stops parsing |
| `tab-indent.yml` | a tab where indentation is expected - the whole file stops parsing |
| `no-jobs.yml` | parses, declares nothing that runs |
| `no-runs-on.yml` | a job the runner would never start |
| `no-steps.yml` | a job that passes without doing anything |
| `name-only-step.yml` | a step that is a name and nothing else, skipped while the job passes |
| `ok.yml` | nothing - the shape a real workflow has |
| `traps.yml` | nothing, and three shapes a naive reader gets wrong: the key `on:` (boolean `true` in YAML 1.1), `${{ }}` in a plain scalar, and a `run: |` block scalar full of lines that look like structure |

An empty directory cannot be committed, so the empty-dir case makes one in `os.tmpdir()` at run time.
