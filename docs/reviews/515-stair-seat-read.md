# #515 — does a staircase read as a way up, from a seat in THE STACK

One question, per the decision recorded on the issue: the geometry this issue asked for is derived
(#633 stores each band edge's kind; a one-quantum tread is `EK_STEP` and `EK_FACEQ` includes it), so
the only thing left is whether a flight is legible from where a player actually stands. No code
changed here — this is the frame, the poses that make it, and the controls that make it falsifiable.

Level `THE STACK` (L3, hand-authored) carries two flights in its plan (`js/20_level.js` `AUTHORED`):

| flight | treads (`FEAT_STAIR`) | rise |
|---|---|---|
| east corridor | (10,9) +0.25, (11,9) +0.50, (12,9) +0.75 | 1.00 m onto the east wing |
| west mezzanine | (6,4) +0.25, (5,4) +0.50, (4,4) +0.75 | 1.00 m onto the authored deck |

## The frame

`docs/reviews/515-stack-flight-seat.png` — eye height derived from the grid, standing 2 m west of the
east flight, looking straight at it.

```
OUT=/tmp/b.png SEAT=8.5,9.5,0 SET='P.z=floorAt(P.x,P.y)' node tools/view.js scene 3 0
```

## What the grid and the renderer say at that pose

* every tread boundary of every `FEAT_STAIR` cell on this level carries a drawn face — `MAP.vb` has
  `VB_FACE` at the crossing and `MAP.ek` reads `EK_STEP`; the boundaries that read `EK_WALL` are the
  solid cells either side of the corridor and correctly carry no riser.
* `MAP.riserStops` = **278** at this seat and **440** at the foot of the west flight: rays stop at a
  one-quantum riser on authored content, not just on the probe's flight.
* Control, same camera, the three treads flattened into the datum and the boundaries re-linked:
  **217,584 of 812,552 pixels move, mean |Δluma| 40.9.** So the flight is not merely walkable — it is
  a quarter of the frame. The census's `step faces` row and the pixels now agree on this level.

## The judgement, and it is not a pass

At a standing eye the flight does not read as three steps. What the frame shows is one low band with
a hard straight top edge, and a dark band above it where the deck beyond catches no light: tread and
riser are the same brightness, so the eye reads **a kerb with a shadow behind it**, not a climb. The
faces exist, are textured in the wall family and carry the depth buffer — they are just not separated
from each other. The step *edges* are where the light field is missing, which is the other half of
this family (#353 lights a deck from its own band; #421 works the underside of one).

So: the title's claim — "a staircase draws no geometry at all" — is no longer true of any level, and
the remainder is shading on faces that already exist. That is a product call about the light field, so
it is filed here rather than changed under this issue.
