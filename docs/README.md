# Documentation

Two files stay at the repository root, on purpose: `README.md` (what the project is, how to run it,
what the picture should look like) and `AGENTS.md` (the working agreement for whoever — human or
agent — is editing here). Everything else lives here.

| File | What it is for |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Direction, the priority rubric, and measured constraints. Not status: status is [issues](https://github.com/lioreshai/breach-protocol-flash-next/issues). |
| [`RELEASE.md`](RELEASE.md) | When this ships a version, and the exact steps that make one. Enforced by the `release` check in `.github/workflows/release-guard.yml`. |
| [`screens/`](screens/) | The README's screenshots, captured from the deployed build. Refreshed by a release PR, and by any PR that changes the picture. |

The rule that keeps these honest is the same one in `AGENTS.md`: **prose status tables are not to be
reintroduced.** If a document here starts listing what is done and what is left, it is duplicating
the issue tracker and will be wrong within a day.
