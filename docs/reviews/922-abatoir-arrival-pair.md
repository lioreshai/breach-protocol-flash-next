# A hostile at 5 m, before and after, off a running page (#922)

Four frames of the same seat in **ABATOIR CORE**, taken from a live page over CDP with
`node tools/livecap.js cap --levels 2 --dist 5 --body` — never from a headless dump and never from
an older build. The shutter is taken by the page itself (`DEV.tick` with the clock frozen), so each
PNG is the picture a player is handed, at 1440x620.

| file | build | what to look at |
|---|---|---|
| `922-abatoir-5m-before.png` | the byte before the fix (`c92664d`), served locally from a checkout of that commit | his torso: one lit face and one dark one, the seam barely there |
| `922-abatoir-5m-after.png` | the byte that ships (`b9127f3`, GitHub Pages) | the same torso carrying the seam across the chest between those two faces |
| `922-abatoir-5m-turn-plus.png` | ships, eye turned `+0.45 rad` after he was seated | the body **off-centre and near** the left edge of vision — no flat sheet, no hard vertical edge |
| `922-abatoir-5m-turn-minus.png` | ships, eye turned `-0.45 rad` | the same body near the right edge — the seat the report was filed against |
| `922-abatoir-5m-clip-plus.png` | ships, eye turned `+0.6 rad` | the body **cut by** the left edge: his own coverage mask runs raster columns 0-64 of 676 |
| `922-abatoir-5m-clip-minus.png` | ships, eye turned `-0.6 rad` | cut by the right edge — mask columns 610-675 — the case the report describes |

Every frame: seed 60, seed-route `boot=0`, layout `2343219222`, level 2, the dealt arrival seat
`22.50, 13.50` heading `2.4228 rad`, one brute parked at a realised 5.00 m down the camera's own
bearing with a clear line to the eye (`blocked()`-checked), 3272 raster pixels of him painted,
grain off. The two turned frames move only the eye (`DEV.look`), so his feet and the room's pixels
stay where the dealt seat put them.

Provenance of the bytes: the deployed `index.html` and `js/13_mesh.js` were fetched and sha256'd
before the shutter and match `git show b9127f3:` for both — `js/13_mesh.js` is
`7a47c114c39d16476234b9b02129517b39e6c628671386d1ab8eaeb9c8b1f0a7`. The "before" frame is the same
harness pointed at a local static server over a worktree of `c92664d`, whose `js/13_mesh.js` is
`30e6be88bac7b03c5a61078142e5bc50bdbc30128276270ba0612164d357fb8a`. Nothing else differs between
the two frames: same seed, same deal, same seat, same frozen clock.

## What the pair does and does not show

At this distance the two builds are **close**: in both, the brute is one mass with a lit side and a
shaded side, standing on the deck with a contact shadow, and the flat quadrilateral sheets the
report described are gone in both. That is expected — the sheets were a near-field-branch artefact
and the seat the report was filed at is on the far side of that branch's gate (measured in the
issue thread), so this pair is the **negative control**: it shows the fix cost nothing at the seat
the report described, and it is not the evidence that the 4-8 m walk improved.

That evidence is a number, and it is `node tools/view.js contrast`'s walk rows at this same head:
the same body against his own 8 m value reads 0.88/1.01/0.99 in RING TRANSPORT, 1.01/1.03/1.01 in
ABATOIR CORE and 0.82/0.87/0.84 in THE STACK, against 0.77/0.90/0.88, 0.89/0.91/0.89 and
0.72/0.76/0.73 before. The pictures above exist so that claim can be looked at rather than only
read, and so the turned frames can be checked for the sheets coming back at any heading. They do
not: across `+0.45`, `0` and `-0.45 rad` the same body keeps one silhouette with two shaded faces
and a seam.

## What "clipped" means here, measured

The first version of this file called the `±0.45 rad` frames *clipped* by the edge of vision. They
are not, and the word was wrong: on those two frames his columns run x 168-312 and x 1129-1283 of
1440, so about 150 px of deck is still outside him and no body pixel comes within 30 columns of
either edge. At `js/00_core.js`'s camera plane 0.72 — a 71.7° horizontal field — the near edge of a
5 m body only reaches x 152 at that yaw, so cutting starts near 0.56 rad.

The last two frames above are the case the report was actually filed against, taken at `±0.6 rad`
where the frustum does cut him. The proof is the renderer's own coverage mask, not the eye: at
`+0.6 rad` the body's stamped pixels occupy raster columns **0-64** of a 676-wide raster (4,496 px,
rows 74-180), and at `-0.6 rad` columns **610-675** (4,257 px) — in both frames his mask touches the
outer column, so part of him is off screen. What arrives in that sliver is still one mass with a lit
side and a shaded side, the seam across the chest and a contact shadow where he meets the deck; no
quadrilateral sheet of flat colour appears at either heading, and the hard vertical edge the report
named — the seam showing through as a boundary between two faces of one torso — stays a shading
change rather than becoming an edge. The room
behind him is the shipped room in both frames — the turn moves the eye only, so his feet and every
pixel of ABATOIR stay where the dealt seat put them.

So the sheets this issue was written about are gone at every heading that was checked, including the
ones that clip him, and the flat 0.65 luma-per-pixel plateau inside 4.4 m is priced in
`node tools/view.js contrast`'s 4-8 m walk rows rather than in a picture.
