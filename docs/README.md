# Documentation

Two files stay at the repository root, on purpose: [`README.md`](../README.md) (what the project is,
how to run it, what the picture should look like) and [`AGENTS.md`](../AGENTS.md) (the working
agreement for whoever — human or agent — is editing here). Everything else lives here.

| File | What it is for |
|---|---|
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | The harnesses and the probe catalogue: what each one gates, what it cannot see, and how to read a number off this machine. |
| [`ENGINEERING.md`](ENGINEERING.md) | Traps already paid for, each kept with the measurement that found it. |
| [`VERTICALITY.md`](VERTICALITY.md) | The height-grid design, its milestones and its open risks. |
| [`ROADMAP.md`](ROADMAP.md) | Direction, the priority rubric, and measured constraints. Not status: status is [issues](https://github.com/lioreshai/breach-protocol-flash-next/issues). |
| [`RELEASE.md`](RELEASE.md) | When this ships a version, and the exact steps that make one. Enforced by the `release` check in `.github/workflows/release-guard.yml`. |
| [`screens/`](screens/) | The README's screenshots, captured from the deployed build, and [`provenance.json`](screens/provenance.json) — one row per shot naming its bytes (`sha256`), the route DEV was installed by (`origin` + `install` + `url`) and the deal it dealt (`seed`, `level`, `layout`, `build`). Refreshed by a release PR, and by any PR that changes the picture. A capture is only reproducible if it names its seed **and** its route — a seed read through the wrong instrument is not the same deal (#335). `node tools/recap.js check` gates every row against the bytes it embeds, and `node tools/recap.js --record` writes the fields it can derive. |

Three rules keep these honest, and they are the reason this set is short:

- **Prose status tables are not to be reintroduced.** A document that lists what is done and what
  is left duplicates the issue tracker and will be wrong within a day.
- **If a tool prints a number, point at the tool.** A transcribed figure rots; the tool cannot.
- **When an instrument is superseded, keep the lesson and drop the archaeology.** Git remembers
  which probe used to measure what. These files are for whoever is working now.
