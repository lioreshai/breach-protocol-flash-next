import json, collections

P = 'docs/screens/provenance.json'
d = json.load(open(P), object_pairs_hook=collections.OrderedDict)
BUILD = 'bd2441a'
URL = 'https://lioreshai.github.io/breach-protocol-flash-next/?dev=1&seed=60'
PROOF = ('The build is proved off the wire before the shutter: index.html and all eleven js/ blobs the '
         'deployed page served were md5-compared against main at ' + BUILD + ' and all twelve matched, so '
         'these pixels came off the page that serves that tree (#395, #420). ')
LOADED = ("Route: reload the url, DEV.freeze(true) the moment the page answers, S.t = 4, banner('', 0), "
          'DEV.tick(30), P.hp = 100, then the pose and one DEV.tick(1) per shot. ')

rows = {
 'level0-spawn': dict(level=0, layout=3105224175, note=
   'RE-TAKEN from the deployed page for #536. ' + PROOF + LOADED +
   'The dealt spawn seat read off the page - (18.5, 5.5) heading 0.60 - and the deal is the one the replaced '
   'row named: layout 3105224175, so every coordinate in the caption is still this room. Seat cell (18,5) '
   'reads MAP.light 0.8305, MAP.cz 16 (ceiling 4.00 over floor 0.00), MAP.ceilFix 2, 8 hostiles, 23 props, 13 '
   'lights; nearest props a barrel 2.83 m at (16.5, 3.5) and a crate 5.00 m at (21.5, 1.5). Frame mean 68.26, '
   'thirds 61.1 / 66.7 / 77.0, 0 of 763 rows under 24 and 0 under 34, against 65.31 on the bytes this '
   'replaces. The +2.95 is light, not geometry: the ceiling light term gained a floor (CEILFL, '
   'js/40_render.js) in #495, so the 4.00 slab over this seat is paid light it used to be paid none of, and '
   'the top band of the frame rose from 52.4 to 61.1.'),
 'level0-facing-wall': dict(level=0, layout=3105224175, note=
   "RE-TAKEN from the deployed page for #536; same page load and deal as level0-spawn (layout 3105224175). "
   + PROOF + 'Pose DEV.cam(1.5, 8.5, floorAt(1.5, 8.5), Math.PI/2, 0); the seat\'s own cell reads MAP.light '
   '0.2489. Re-read this load: the flight at (1, 9)..(1, 13) carries MAP.fz 0, 1, 2, 3, 4 with MAP.feat 0, 1, '
   "1, 1, 0 - three STAIR cells - so the four risers the caption names are still this deal's. Frame mean "
   "46.71, thirds 39.1 / 54.2 / 46.9, 0 of 763 rows under 24 and 15 under the tool's other bar of 34 with a "
   "longest run of 1 from row 18, against 45.31 / 173 rows / run 79 from row 124 on the bytes this replaces. "
   "Two shipped changes take that dark band off the treads: #495 gave the ceiling a light floor and #515 "
   "draws a stair's own step faces instead of a warped flat deck."),
 'level0-props': dict(level=0, layout=3105224175, note=
   'RE-TAKEN from the deployed page for #536; same page load and deal as level0-spawn. ' + PROOF +
   'Pose DEV.cam(20.5, 11.5, floorAt(20.5, 11.5), Math.PI/2, 0) on the datum; re-read this load, the pit '
   'block (19..21, 14..16) reads MAP.fz -4 on all nine cells, so a pit under a lip inside tall air stays a '
   "pit. Frame mean 57.67, thirds 48.6 / 64.0 / 60.4, 0 of 763 rows under 24 and 1 under 34 (longest run 1 "
   'from row 536), against 57.23 and 2 rows on the bytes this replaces. Same lip, same lamp, same crate; the '
   'wall behind them is a lit roof now (#495) and the crate wears the surface pass (#533).'),
 'level0-pitfloor': dict(level=0, layout=3105224175, note=
   'RE-TAKEN from the deployed page for #536; same page load and deal as level0-spawn. ' + PROOF +
   'Pose DEV.cam(19.5, 14.5, floorAt(19.5, 14.5), Math.atan2(2, 1), 0): feet on floor -1.00, own ceiling '
   "0.00, own cell MAP.light 0.3043 - a lamp standing in the camera's own cell. Frame mean 61.82, thirds 46.6 "
   '/ 86.5 / 52.5, 0 of 763 rows under 24 and 0 under 34, against 62.39 and 122 rows under 34 (run 34 from '
   'row 124) on the replaced bytes. This is the one frame in the pass that reads marginally darker: the '
   "camera stands in the pit band looking up at the low ceiling the lamp above it already saturated, so "
   "#495's ceiling floor adds little here, and the ceiling's own band fell from 90.7 to 86.5."),
 'level0-enemies': dict(level=0, layout=3105224175, note=
   'RE-TAKEN from the deployed page for #536, in its own page load - the one load in the pass that does not '
   "carry the level's own hostiles, because DEV.clear() drops them. " + PROOF + LOADED +
   "DEV.cam(18.5, 5.5, floorAt(18.5, 5.5), 0.60, 0), DEV.clear(), DEV.spawn('grunt', 1, 6), DEV.tick(1). "
   "DEV.spawn reports the body it realised at (23.45, 8.89), cell (23, 8), range exactly 6.00 m on the "
   "camera's heading with why 'exact' - no clamp, no lateral rescue; e.anim pinned to 0 by DEV.spawn itself, "
   'HUD 1 LEFT. Frame mean 68.23, thirds 61.0 / 66.7 / 77.0, 0 of 763 rows under 24 and 0 under 34. Two '
   "shipped changes are in this frame: #495 lit the roof behind him (+2.96 of mean against the replaced "
   'bytes), and #18 flattened and deepened the body contact band (SHADOW_D 0.42 -> 0.52, SHADOW_R -0.10 -> '
   '-0.14, SHADOW_F 3 -> 2) so a hostile reads against the deck it stands on; props deliberately keep the '
   'shadow that shipped.'),
 'level2-abatoir': dict(level=2, layout=469427782, note=
   'RE-TAKEN from the deployed page for #536, in its own page load (one url, one boot - never a second '
   'DEV.boot() inside a load). ' + PROOF + "Route: DEV.freeze(true) at load, DEV.boot(), startLevel(2, true), "
   "banner('', 0), S.t = 4, DEV.tick(30), P.hp = 100, then the dealt spawn seat. THE DEAL HELD: layout "
   '469427782, the same signature the replaced row named, so the seat (17.5, 28.5) heading 0.60 on floor '
   '0.00 and every coordinate beside it are still this room. Seat cell reads MAP.light 0.8822, MAP.cz 16 with '
   'the ceiling solving at 4.00, MAP.ceilFix 2, 18 hostiles alive. Frame mean 68.46, thirds 51.6 / 67.7 / '
   '86.2, 0 of 763 rows under 24 and 0 under 34, against 69.72 and thirds 52.1 / 69.3 / 87.9 on the bytes '
   'this replaces - the one frame in the pass that reads darker. Its top band is the slab over the room, and '
   "the roof-to-wall junction (#369) and the riser material (#518) took 0.5 of luma off it; this level's "
   'dealt frame byte (view.js flatparity) is unchanged, so the rooms are identical and only their surfaces '
   'moved.'),
 'level2-abatoir-ceiling': dict(level=2, layout=469427782, note=
   'The same seat, deal and page load as level2-abatoir, turned to the nearest hung fitting this deal puts '
   "within reach of the frame - which is how #413's ask is honoured: the row names the fitting these bytes "
   'actually point at. ' + PROOF + 'MAP.ceilPanes holds four entries on this layout; the nearest with d > '
   '1.5 is at (20.12, 26.88), 3.08 m from the seat at bearing -0.5539 rad, lens at z 2.35 under a slab top '
   'of 4.00 - all four re-read off the page this load, unchanged from the replaced row. Pose DEV.cam(seat, '
   '-0.5539, 194), where 194 px = atan2(2.35 - eyeZ 0.50, 3.08) * BH 359. Frame mean 70.29, thirds 68.5 / '
   '79.2 / 63.2, 0 of 763 rows under 24 and 0 under 34, against 70.26 on the bytes this replaces: the '
   "brightest frame in the set and the one #495's ceiling floor barely moves, because this camera is looking 'at a lit lens rather than at the roof."),
 'level3-stack': dict(level=3, layout=972763321, note=
   "RE-TAKEN from the deployed page for #536, in its own page load: DEV.freeze(true) at load, DEV.boot(), "
   "startLevel(3, true), banner('', 0), S.t = 4, DEV.tick(30), P.hp = 100, then DEV.cam(1.5, 2.5, "
   'floorAt(1.5, 2.5), 0.60, 0). ' + PROOF + 'Layout 972763321 - the hand-authored plan is unchanged from the '
   'replaced row - 4 hostiles, own cell MAP.light 0.1019, own ceiling 1.00 (the seat is under the slab). '
   "Frame mean 57.58, thirds 51.2 / 62.8 / 58.7, 0 of 763 rows under 24 and 0 under 34, against 53.41 / 114 "
   "rows under 34 / run 49 from row 56 on the bytes this replaces. This is the frame whose caption's claim "
   'about DARKNESS became false and was rewritten rather than re-digitated: #495 paid the vault the light it '
   'was paid none of, so the top band runs 51.2 where it ran 40.1 and there is no dark block left to count. '
   'The geometry it is a picture of - the slab face over the room the seat opens into - is unchanged.'),
}

for s in d['shots']:
    r = rows[s['file']]
    s['origin'] = 'https'; s['install'] = 'url-open'; s['url'] = URL
    s['seed'] = 60; s['level'] = r['level']; s['layout'] = r['layout']
    s['build'] = BUILD; s['at'] = '2026-10-16'; s['sampleRate'] = 44100
    s['staleByBuild'] = None; s['note'] = r['note']

d['plan'] = d['plan'].replace('on the deployed Pages build of main at 1f24660',
                              'on the deployed Pages build of main at ' + BUILD)
old = ('Seven rows were taken on a capture profile that exposed no audio device - SND.ac read null at every '
       'shutter - so they carry `sampleRate: null` and bind the deal they name on a machine that draws the '
       'same zero count; `STRICT=1 node tools/recap.js check` prints each as device-scoped. `level3-stack` '
       '(re-taken later, for #431) read 44100 and binds a machine with a 44100 Hz device instead, which is a '
       'narrower row, not a looser one. A capture that reads a rate narrows its row to one machine and one '
       'device.')
new = ('All eight rows in this pass read `SND.ac.sampleRate` as 44100 at the shutter, so each binds the deal '
       'it names on a machine with a 44100 Hz device - narrower than the mixed null/44100 rows these '
       'replaced, and nothing looser. A capture that reads a rate narrows its row to one machine and one '
       'device.')
assert old in d['plan'], 'plan audio sentence not found'
d['plan'] = d['plan'].replace(old, new)
json.dump(d, open(P, 'w'), indent=2)
open(P, 'a').write('\n')
print('updated', len(d['shots']), 'rows; build', BUILD)
