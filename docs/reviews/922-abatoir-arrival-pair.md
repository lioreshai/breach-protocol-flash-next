# A hostile at 5 m, before and after, off a running page (#922)

Four frames of the same seat in **ABATOIR CORE**, taken from a live page over CDP with
`node tools/livecap.js cap --levels 2 --dist 5 --body` — never from a headless dump and never from
an older build. The shutter is taken by the page itself (`DEV.tick` with the clock frozen), so each
PNG is the picture a player is handed, at 1440x620.

| file | build | what to look at |
|---|---|---|
| `922-abatoir-5m-before.png` | the byte before the fix (`c92664d`), served locally from a checkout of that commit | his torso: one lit face and one dark one, the seam barely there |
| `922-abatoir-5m-after.png` | the byte that ships (`b9127f3`, GitHub Pages) | the same torso carrying the seam across the chest between those two faces |
| `922-abatoir-5m-turn-plus.png` | ships, eye turned `+0.45 rad` after he was seated | the body clipped by the left edge of the frame — no flat sheet, no hard vertical edge |
| `922-abatoir-5m-turn-minus.png` | ships, eye turned `-0.45 rad` | the same body clipped by the right edge — the seat the report was filed against |

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
and a seam, at every heading that clips him.
