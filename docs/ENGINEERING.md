# Traps already paid for

Each of these cost at least one session. The *rule* lives in
[`AGENTS.md`](../AGENTS.md); this file keeps the measurement that found it, because a rule
without its evidence is an opinion and gets argued away.

Two editing rules for this file, so it does not grow back into the thing it replaced: when an
instrument is superseded, keep the lesson and drop the archaeology — git has the rest. And
never transcribe a number a tool prints; cite the tool.

## The renderer

**Three ground shadings are welded to the row solver** and change silently when it changes:
light is sampled cell-quantized on the ground (walls sample bilinear *with* an
`exp(-perp*0.16)` falloff — borrowing the wall formula for the floor costs 9 points of
exposure on level 0), fog is `fogAt(camera-space depth)` with no z term in either pass, and the
`li > 1 → 1` clamp exists only at row init, never on a cell crossing — so a cell under a lamp
renders brighter when the row walks into it than when the row starts in it. Re-key that light
update on the pixel's own cell and the quirk becomes a uniform clamp: parity dies in the
brightest rooms first. `flatparity`'s PARITY and LOCK senses
(`tools/view.js:863`, `:870`) are what hold a flat spawn frame to a literal.

**`ceilAt` in a pixel loop is a cliff.** It walks four neighbours; called from every cell
crossing of the ground pass it cost ~5% of the flat frame. `MAP.ceilPlane` is derived once per
level by *calling* `ceilAt` per column, so the formula stays in one place, and
`tools/view.js planes` compares the array against the formula and exits non-zero when they
disagree — the only thing standing between a forgotten `linkBoundaries()` and last frame's
ceilings.

**A gate can be scoring a rendering artefact and still be green.** #385: the step-lip contrast pair
`bands` scores on the authored level measured 57% because the FAR sample was off-map floor taking the
light of the cell the row's walk last reached — a lamp the player cannot see, at any distance. Fix the
borrow and the same pair measures 35%, so the gate that was "holding" was holding the artefact. When
the two disagree, attribute the luminance to a path before editing it, and when the artefact goes, say
so where the number lives (a per-level floor, re-measured, with the old value beside it) instead of
quietly widening a threshold until the row cannot fail. `heights`' `offmap` row is the instrument that
says which pixels are affected: it counts ground pixels whose ray landed a WHOLE CELL clear of the
level and reports the worst light above ambient each one delivered, split by half and by copy — and it
counts that census outside the `GNDOF` A/B switch, so putting the borrowed lamp back turns the row RED
rather than measuring the fixed arithmetic twice.

**The row loop's mip/fog/light values must stay `const` of the row.** Writing them per pixel —
the obvious way to say "this pixel has its own distance" — cost **+2.5 ms of a 1202×676 frame
for pixels nothing re-solves**: V8 keeps a loop-invariant in a register only while nothing
writes it inside the loop. Off-plane pixels are queued per row (`RX`/`RP`) and painted after
it, which is why the body exists twice.

**Solving the ground per cell is not a drop-in.** An attempt that was `node --check` clean and
md5-identical at the spawn camera still shifted exposure by −4 overall and −9 on level 0.
Established: the segment breaks were not the cause, the solid-cell case was a genuine bug, and
the residual lives in **shading, not geometry** — so a future attempt must diff shading per
row rather than chase segment counts.

**`zbuf` is a distance in every pixel, not a label.** It is allocated `Infinity`
(`js/40_render.js:55`) and `castGround` fills every row each frame; the only place `Infinity`
survives is the `p === 0` horizon row (`:271`), where it is arithmetic, and `HORIZON-DEPTH`
asserts it. Nothing writes 0 any more, so a probe testing for 0 tests a condition that cannot
happen. The mip sampler must clear `zbuf` to the sentinel before each isolated `castWalls`
call (`tools/view.js:1698`–`:1715`) to keep measuring the wall pass alone.

**A fixed-point walk in a quantized domain needs a quantum test, not an iteration count.**
`groundPixel` terminates on the quantum (`js/40_render.js:431`) and counts exhaustion
separately in `reSolveBad` (`:436`, asserted by `RE-SOLVE-NOT-CONVERGED`). Two things measured
while chasing #170: `reSolveBad` stays **0 on the pixels that still leak**, so exhaustion
counting cannot see that bug; and the `<= ZQ` branch is an *exit*, not a convergence proof — it
accepts a one-quantum neighbour and keeps the plane the walk arrived from. Answering with the
nearer plane instead changed the leak **not at all** (398 px at rows 102..127, identical) and
broke `heights` with `DEFERRED-STALE-DEPTH` on three `stepUp` configs, because depth became a
property of which path painted the pixel. The visible consequence is a prop on a raised band
still drawing below the riser lip — 398–438 px at rows 102..127 (#163).

**A module-global typed-array out-param kills the hot loop.** `texBil` writing into the global
`TB` blocked V8 inlining; inlining the fetch took `castWalls` from 21 ms to 12 ms near a wall.
Same code, one indirection — the same cliff a probe wrapper hits (below).

**A derived flag that is OR-ed in can never be removed.** `linkBoundaries` ended with
`MAP.vb[i] |= bits` to preserve authored `VB_RAMP|VB_LADDER`, and as a side effect nothing
cleared derived `VB_BLOCK`: raising a boundary and flattening it left **7 stale blockers** that
`canEnter` treats as authoritative (#55). Probes never saw it because every config calls
`startLevel(li, true)` first and only ever pokes upward from flat.

## Probes and oracles

**A probe that cannot fail is worthless, and a disproven finding in prose is worse than none.**
The headless probes rasterize poses without the scene-light multiply, so `rig` and `contrast`
both agreed the characters looked fine while the live site showed something they could not
describe. That trap then carried a **false diagnosis for several commits**: the bodies were
never translucent. Correlating body pixels against the wall behind them (6463 masked px, mean
body 89.2 vs wall 100) gives −0.398, and masking on a large body-vs-background difference
biases correlation negative, so a true zero looks the same. What the site actually showed was a
rim band too wide to read as anything but a halo (#17), which an edge-contrast average cannot
see, because an average cannot see band *width*.

**A mask built from a render difference cannot credit a body-driven change.** `contrast` used
to difference the world against itself with `ENEMIES.length = 0`. The second frame has no
shadow in it by construction, so a shadow term never reached the measurement, and a shadow
landing outside the silhouette *joined* the mask. Measured on the contact-shadow branch (#179):
cam1 bit-identical while the term computed a nonzero value on **4,410 of 37,651** body pixels,
`cull` reporting 113.0% / 182.3% of the flat silhouette "surviving". The mask is now `COV` —
who painted each pixel last, stamped at the mesh and billboard write sites, `null` in play. On
the same frames it finds **52 / 566 / 0 px** on cam0/1/2 that the diff mask structurally could
not contain (20% of cam1's silhouette), and `leak` — pixels the diff mask claims that coverage
denies — is 0 on main. Two details that matter: the ring is an **8**-neighbourhood, because a
rasterised silhouette steps diagonally; and the background reference is the median luminance of
outside-mask neighbours **of the same composited frame**.

**Instrumenting a hot loop changes what it costs.** `window.castGround = function () { …g()… }`
for a phase A/B added **15 ms/frame to both sides** and hid the difference being measured: the
wrapper deoptimizes the call site in `renderWorld`.

**A cold sampler cannot share a process with a hashed render.** Rendering `flatparity`'s DEALT
frame in the same process as the flat sense moved its triple with **zero bytes of `js/`
changed** — the extra renders warm the pose cache and depth history the flat sense reads. Hash
each sense in a fresh process, and when a tools-only diff moves a lock, suspect the harness's
render order before the generator. **The sampler's camera is part of the assertion:** a DEALT
sampler at the spawn seat hashed a flat-looking view of level 2, where dealt and flattened
differ by **8 px of 203,138** on the level with the most off-datum cells — so a band-term
deletion failed two levels and passed the third (#226, open). A sampler whose dealt-vs-flat gap
is under the floor is vacuity, which is a FAILURE, not a pass with an explanation.

**A probe that builds its own geometry cannot fail on a world that has none.** Every vertical
row in `drop`, `sight`, `cull`, `horizon`, `heights` and the VERT lane pokes `MAP.fz` to create
the band it tests — correct while the generator was flat, and the reason the whole vertical
suite was green on levels with no altitude at all. `alt` additionally *could not fail*: it
printed `ALL FLAT ok` / `NOT FLAT - check above` and exited 0 from the reporting job. It now
ends in `process.exit(bad ? 1 : 0)` (`tools/view.js:334`) and sits in `ci.yml`'s blocking list.

**A probe that pokes altitude must re-seat it after every `startLevel`.** `genLevel` reassigns
`MAP.cz` from a fresh array (`js/20_level.js:606`), so #163's taller-sight poke measured "fixed
6 of 7 rows" when it ran before the attach section's regenerate.

**Geometry one cell too far makes an occlusion row unable to fail.** `cull`'s "prop one band up
is hidden by the slab" puts the raised band three cells out, so the riser's top projects at row
~101 of 338 and the ceiling solve is the only occluder (0 px fixed, vs 565/565/490 px with the
zbuf writes reverted). One cell ahead and the wall pass hides the prop by itself — the row then
passes on a build with no ceiling depth at all.

**A probe measuring the composited frame cannot see the ground pass.** The wall pass repaints
rows whenever a face's z span changes, including rows below the eye line, and the portal cycles
on `S.t` while pickups bob. `heights` therefore renders each config twice — composite for
brightness, then a `castGround`-only repaint for the geometry diff — and compares ground pixels
only in its determinism replay.

**A negative control that self-cancels inside one frame proves nothing.** Sabotaging a support
test showed the player standing on air for zero frames, because gravity corrected it before the
sample; sampling the landing impulse (`S.shake`) made it a loud failure.

**A VERT row can be absent while the lane prints green.** `vsetup` *calls* `expect` and returns
`ok`, and the lane uses both `if (vsetup(...)) { … }` and `if (!vsetup(...)) { } else { … }`.
Writing the second as `if (!vsetup(...)) { <body> }` runs the row **only when its setup
failed** — no print, no assert, every neighbour green. The tells are the lane's own
`N gating row(s)` count (V18's first version left it at 21, not 22) and a control run in a
detached worktree.

**A probe whose row count is quoted in prose will disagree with the printed one.** The count is
the probe's own tally and moves when a row is added; the disagreement is a defect in the prose.

## Measurement discipline

**One run on a loaded machine means nothing.** Load average ~3 inflated unchanged code from
3.4 ms to 17–46 ms and made a floor-smoothing change look like a 2× regression. Smoke prints
five batch medians — read the median *and* the spread; 4.1/9.1/14.8 is noise.

**Cost a broken cache hides is not savings.** Raster "improved" to 3.4 ms because the rig cache
had stopped making poses at all; fixing eviction made the honest number 8.7–14.8.

**Quote the roll count beside any median.** These distributions are bimodal and an even-count
median averages two modes instead of selecting one. #143 opened with "composited is 15 points
below raster"; ~13 of that was one tool printing `REPS=4` against another's `ROLLS=5` on level
2's rolls `39.5 103.3 36.5 66.2 42.5`. The instruments agreed to 0.1 all along.

**A number that moved across a commit boundary is not evidence until the metric has been
bisected too.** #139 was opened on a 40-point luminance drop between four captions and their
recapture, and closed as not a defect after four confounds: #91 changed what `exposure`'s
`frame: mean` *means*, so bisecting the printout bisects the printout; #96 moved `makeEnemy`'s
ten global `Math.random` draws into a private xorshift, which changed the seed-to-layout
mapping, so two eras photograph different rooms from the same seed (12 enemies constructed and
discarded move a level's mean 66.4 → 70.2); and a printed 59.1 against a sampled 28.7 was two
probe modes writing the same temp path from different cameras. The instrument was never the
problem — believing a difference before eliminating what moved underneath it was.

**A rim must be ADDITIVE, not a multiplier.** `base + rim` on an albedo averaging 35,59,68
still renders dark and moved the measured edge contrast not at all; adding light
(`C*base + 150*rim`) moved it. Because the raster is multiplied by scene light at composite, a
rim scaled this way is weakest in exactly the dark rooms that need separation — `AMB 0.19`
floors it. That tension is unresolved; a contact shadow is the light-independent mechanism.
Express the band in **body fractions** (`d / authoredHeight`), not pixels, or it thins as poses
sharpen. `shape()` already hands the shading closure the signed distance to the silhouette
(`js/05_paint.js:147`), so a rim costs no extra SDF eval and is angle-correct.

**`view.js rig` dumps the RAW raster** (no light multiply, no fog), so it shows a lighting
change's upper bound: use it to reject too-strong, never to confirm too-weak.

## Deploys, docs and git

**Before believing a live behaviour probe, read the source the page is running.** A Pages
deploy leaves the previous build's subresources cached for its `max-age` (~10 min), and
`fetch(url,{cache:'reload'})` inside an `async` eval is useless because the tool serializes the
Promise as `{}`. The check that makes a behaviour probe mean something is
`linkBoundaries.toString().includes('VB_KEEP')` — and **the marker must be code, not prose**:
`toString()` renders comments too, so asserting an old string is *gone* matched a comment
explaining its removal and reported a fixed build as unfixed (#122). `curl` with `?cb=` proves
the CDN's bytes, not the page's code.

**A docs PR has no deploy to verify, and the md5 of a 404 body is `d41d8cd9…`.**
`pages.yml` stages `_site` as `index.html` + `js/` only, deliberately, so everything under
`docs/` — every `docs/screens/*.png` the README embeds included — is **404 on the Pages host**
and always has been. Piping such a body into `md5sum` yields the hash of the empty string and
reports it as a stale deploy; one docs PR spent a 14-minute watch on a condition that could
never become true. Gate deploy checks on **js blobs**, check `curl -w '%{http_code}'` before
blaming `max-age`, and verify a docs-only PR against the **tree**
(`git show origin/main:docs/screens/x.png | md5sum`).

**A closing keyword inside backticks closes nothing.** #145 stayed open after #146 merged with
a body opening `` `Closes #145` `` — a code span, so GitHub linked nothing — while the `issue`
check stayed green because it greps raw text. A green check proves the string was present,
never that the reference exists.

## Audio and ports

- `exponentialRampToValueAtTime` throws if start **or** target is 0 (floors live at 0.0008).
- `AudioContext` starts suspended: `SND.on()` must `resume()`, and playback must never be gated
  on the user's mute flag (`S.sound`).
- `try/catch` only catches a *synchronous* throw, so wrap the whole method — `play` closes over
  the envelope builder — and `ac.resume().catch()`.
- Three.js port (in a branch): `BufferGeometry` needs the `uv2 → uv` copy; no `ShaderMaterial`
  tonemapping; `CircleGeometry`'s `thetaLength` is a delta; `InstancedMesh` count must be an
  exact multiple of vertices-per-instance; additive blending cannot read its destination.

## Measuring an A/B of two renders

**Rendering the same seat twice is not a control.** `renderWorld` advances `S.t` and the view model
sways with it, so an A/B that renders arm A, then arm B, at one seat measures the rifle as well as the
term under test. Measured at a `heights` seat while building `offlook`: 1,018 pixels "differed between
the arms" of a `DEV.set('gndoff', …)` pair, every one of them inside the weapon's silhouette, and the
floor term was in none of them - the rifle had moved by a pixel. Both arms now re-seed, re-deal and
re-seat before rendering (`tools/view.js`'s `OFFLOOK` block), which makes the pair identical to zero
pixels wherever the term cannot reach - a null result that is worth more than the number it replaced.
Read the diff on a rifle-free render too: the view model's edge is a 100-luma step of its own and it
lands exactly where a level outline would.
## A crease that is a fraction is quiet in a dark room

`seamCrease` shades a step lip by MULTIPLYING its pixels, which is scale-invariant: the same fraction
of a bright deck is twice the luminance of the same fraction of a dark one. On the four levels the
authored finale owns the darkest scored deck in the game (it authors `lamps: 0`), and its down-step into
the pit is the one lip in the game that reads flat — `bands` scored it 40% against a 45% want while its
own walk lip, three cells away on a deck twice as bright, scored 70%. Deepening the multiply was
measured and declined: it hardens three lips that already read and re-keys their recorded frames
(3.71% of pixels moved, mean 3.2 luma) to buy one authored row.

**Lighting it was tried first and made it worse.** An authored lamp two cells from that lip took the row
from 40% to **35%**: the pit floor a unit below is inside a datum lamp's band reach, so the lamp raised
the far side of the measured pair faster than the near one (`NOCAP=1` rules out the light ceiling). The
term that works is an ABSOLUTE subtraction in luma, authored per level (`stepEdge`, THE STACK only) and
faded out by the deck's own light above `SEAMK`, so a lit lip — including this level's own walk lip — is
the byte it always was. `bands` L3 face lip 40% -> 49%, the `KNOWN [#203]` tag gone, L0/L1/L2 and every
`flatparity`, `heights` and `exposure` record unmoved in the same tree.
