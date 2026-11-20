# #824 — the resting pose at the 2 m seat, with the gun's faces turning and without

Both frames are the SAME deal, the SAME seat and the SAME rig rest pose (ABATOIR CORE, seed 60,
layout 2343219222, `node tools/view.js scene 2 0`), cropped to the rig's own screen box
(x 740-1020, y 420-673) and shown 2x. Left = the shipped build (`69c2dbb`, also what the deployed
page serves); right = the same tree with the period law reverted to main-before-#873's.

- `824-rest-2m-on.png` — one ramp across each part: the slide's top edge is the brightest thing on
  the gun and its flank falls off down the side, so the receiver reads as a block with a top.
- `824-rest-2m-off.png` — the same parts carry as many ~10 mm machining seams as fit, so each face is
  one value and the whole gun is a fan of slabs.

`node tools/view.js viewmodel` prints the scan over the rig's own pixels (rig-on minus rig-off): the
mask holds at 10,504 px / 119 rows on both arms and the luma range holds at 9->132, so the silhouette
is unchanged pixel-for-pixel; the mean monotone run length doubles 6.1 px -> 11.4 px, which is
luminance travelling inside a surface instead of only at its ends. Nothing clips: of 812,552 frame
pixels, 16,616 differ, all of them inside the rig's box, max |dRGB| 63, zero pixels pushed to white.

**How to take both frames again, and what that reproduces.** The left frame is this tree's own render
and the right is the same harness with the pre-#873 `js/` swapped in, so the pair is one checkout and
one seat, not two machines:

```
node tools/view.js scene 2 0                                  # -> 824-rest-2m-on.png
JSDIR=<main-before-#873's js/> node tools/view.js scene 2 0    # -> 824-rest-2m-off.png
```

Each output is the 1202x676 frame buffer; the committed PNGs are its rig box (x 740-1019, y 420-672)
cropped and doubled. Measured on `469cec8` against the bytes committed here: **0 of the 70,840 box
pixels differ on either arm**, so a reader who runs those two commands gets these two frames exactly.
The same run comparing the arms against each other prints 16,614 differing box pixels, max |dRGB| 63,
and no clipped channel in either frame. The left frame is also the deployed picture: index.html and
eleven `js/` blobs served by the Pages URL sha256-matched `main` `69c2dbb`, twelve for twelve, taken
before these measurements — #873's term is on `main`, so there is no deployed build left to compare
against. The front-page frames in `docs/screens/` were shot before that merge and still show the flat
slide; `node tools/recap.js check` says so on this tree (`FRAME-STALE`, 3 of the 4 blobs that draw a
frame), and re-taking them is a separate pass, not part of this pair.
