**Issue:** Closes #

### What changes, in one sentence

### Which gate proves it

- [ ] `node tools/smoke.js` prints `SMOKE PASSED` (raster < 16 ms/frame median, assets < 40 MB,
      save/restore balance, colour variety)
- [ ] `node tools/view.js alt` still reports `FACES ok` / `ALL FLAT ok` on all three levels
- [ ] `node tools/view.js exposure` has not moved more than ~3 mean luminance per level
- [ ] look change? PNG in `/tmp` named in the description, for eyes-on review

### Numbers, or it did not happen

Paste the before/after measurements. "Looks better" is not evidence; a variance, an edge dL, a
median frame time, or an md5 that is unchanged when it must be is.

### Verticality

Does this touch anything that still assumes flat (`castGround`, `tryMove`, `MAP.light`,
`cellTint`, `bfsDist`, `DECAL_MASK`, the minimap)? Say so even if the answer is "yes, and I
worked around it" - it is what the next person needs.

### Notes for the reader

Anything a future reader of `git log` would not infer from the diff.
