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
