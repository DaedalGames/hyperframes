# Watching a video you only see as stills

A video model watches motion; you look at pictures. Looking at more pictures does not close that gap. What closes it is letting measurement choose which frames to look at, and turning motion into a picture. Evenly spaced frames, one to five a second, made earlier rebuilds see hard cuts as dissolves, miss one-frame flashes and land entrances 2–12 frames off. The rebuilds that matched the original frame for frame had looked at every frame of every window where something changed.

## The loop

1. **Map.** `npx hyperframes measure events .reverse/source.mp4 --map` reads every frame at 160 px. It returns the shots, the long holds, the sound's onsets and beats, and `windows`: stretches where something changes, each with what changes (`cut`, `flash 1f`, `appear r1c2,r1c3`, `change …`) and the sound's onsets inside it. Cells are a 4x4 grid, `r0c0` top left. The full event list is in the JSON file it names.
2. **Overview.** `measure frames .reverse/source.mp4 --every 1` puts one frame a second on a sheet: the structure, the layouts, the look.
3. **Each window.** `measure frames .reverse/source.mp4 --events` gives one strip per window with its consecutive frames, numbered. A long window is thinned, but the frames before, at and after each event are always kept. Read a strip left to right: which frame is the first with the new state, and what happened in between.
4. **A move in one picture.** `measure trail .reverse/source.mp4 --from <a> --to <b> --roi <tight round the element>` lays the window's frames over each other, earliest faintest, with the moving part's centre numbered, plus a heat map of where the picture changed. A slide leaves a row of ghosts, a scale leaves nested outlines, a mask reveal leaves an edge that sweeps while the content stays put.
5. **Zoom.** `measure frames --at <t> --roi <x,y,w,h> --width 0` crops at full size to read text, glyph shapes and edges.
6. **Measure.** The numbers in the spec come from the commands below, not from a picture.
7. **Settle the mechanism**, then write the segment in `REVERSE.md` and close it: later segments do not need its pictures.

Budget about 8 pictures a segment, more where the map shows many windows. Pictures are the most expensive thing in your context; long films go section by section, and when your harness has sub-agents, one section each, with this file and the map.

## Mechanism questions

Settle each one that applies with a picture or a number, not with a first impression:

1. **Scale or reveal?** Does the artwork grow, or does a mask open over artwork that stays put? Compare the content's size at the start and end of the reveal.
2. **Camera or object?** Does the whole picture move (`measure rhythm` names push in, pull out, pan, handheld per shot), or one element over a still background? One moving card is not a camera move. A camera that travels (a dolly or tracking shot) slides near things past far ones at different speeds; a zoom or pan moves everything together. Zooms and pans can be added afterwards on a camera group; travel cannot, so a re-shot person's prompt has to ask for it.
3. **Cut or transition?** Hard cut, dissolve, wipe, a moving occluder, a tile reveal, a match move. The map's `cut` has a `frames` length when it spans several frames (a whip, a short dissolve).
4. **How does it appear?** Pop at full size, scale in with or without overshoot, fade, type-on by character, word by word, slide from an edge. Look at the frames either side of the onset, then `measure box --track` or `measure curve` for the ease.
5. **How does it move?** Direction, travel as a share of the frame, duration, ease family, overshoot or none, holds. Follow the same instance through lead-in, peak and settle; matching end points says nothing about the path.
6. **Smooth or stepped?** `measure rhythm`'s `update_fps` near half the frame rate means animation on twos. A film animated on twos looks wrong rebuilt smooth.
7. **Blur or glow?** Tell a sharp core, a one-sided directional smear, a symmetric glow and focus blur apart; give onset, peak and decay.
8. **What is the type made of?** Zoom in at full size. Letters showing a photo, lines or other text are a knockout: what shows through is its own layer. Letters showing the footage behind them bent, with a dark rim and a light edge, are glass ("Effects" in `check.md`). Name solid, gradient, glass, chrome, blur or glow in the spec; a flat grey stand-in reads as a different film.
9. **Particles and dust:** colour, dot size, density at start and peak, where dense or empty, drift direction and speed.
10. **Cursor:** tip position (`measure track`), arrow, hand and I-beam swaps, press and release, and the interface's response. Arriving is not clicking.
11. **3D or flat?** A narrowing box can be rotation, crop or scale; check its four corners before calling it 3D.
12. **Footage or drawn?** Photographic and filmed content is cut from the original; what matters for the rebuild is its box, its timing and how the frame around it moves.

## What a spec must say, or the rebuild gets it wrong

- **Identity across cuts.** An element that recurs, or changes role (a circle that becomes the O of a word), is named once in Objects and called by that name everywhere.
- **Construction of marks and logos.** Element count, shape, arrangement (`measure objects`: ring, grid, row, stack), sizes relative to each other, colour, the wordmark's weight, case and tracking.
- **Groups.** How many, arranged how, overlapping how, in what order they appear, how often they change, in which direction, and what stays still. "Cards shuffle" cannot be built; "5 cards, each 12% of the frame high, fanned 20° apart, dealt left to right one every 0.20 s, each sliding up 10% of the frame with power2.out" can.
- **Frame rhythm.** Smooth or stepped, once for the film when it holds throughout.
- **What each segment starts with.** Elements already on screen at a segment's first frame are there, not animated in from empty.
- **Exact copy.** Case, punctuation and line breaks as shown.
- **Relations that carry meaning.** Which end of a connector attaches to what, which caption belongs to which face, which mask follows which card.

## Reading the measurements

| Command                      | Answers                                                                                                | Read                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `measure events`             | when each region changes                                                                               | `frame` is exact; `appear`/`disappear` are steps between two steady looks; `change` is other motion; `hold` is stillness of 0.3 s or more |
| `measure cuts`               | where shots begin                                                                                      | `frames` > 1 is a multi-frame transition, not a one-frame shot                                                                            |
| `measure box`                | one graphic's box, colours, text lines, cap height; with `--track`, its moves                          | draw the ROI round the graphic with some ground around it; each move has an ease and an `rmse`                                            |
| `measure curve`              | one move's ease, overshoot and timing                                                                  | over 0.12 `rmse` the ease is unclear: say so rather than name one                                                                         |
| `measure ink`                | where text ink sits, first and last visible                                                            | font size: render a candidate at a known size, scan the same text there, size = candidate size × original height ÷ candidate height       |
| `measure objects`            | how many elements and their arrangement                                                                | positions (centres) and sizes are shares of the frame; touching elements count as one                                                     |
| `measure rhythm`             | moving share, holds, update rate, camera per shot                                                      | camera moves are a best whole-frame fit: confirm on frames                                                                                |
| `measure look`               | brightness, contrast, saturation, warmth                                                               | compare a rebuild's grade with `--compare`                                                                                                |
| `measure track`              | a cursor, hand or product followed frame by frame from its box at one moment                           | it stops at a cut or a lost match: give a new `--at` and `--roi` where it reappears                                                       |
| `measure flow`               | how a textured element or the camera moves, from optical flow, as tweens; `--compare` against a render | for footage and textured cards where `box` finds no flat colour                                                                           |
| `measure face`               | how big the face is and where                                                                          | a regenerated presenter keeps the likeness from 0.25 of the frame's height                                                                |
| `measure sync`               | whether the mouth and the voice line up                                                                | positive ms is a late picture; trust `high` confidence, repeat `medium` on another window                                                 |
| `measure continuity`         | jumps, flicker and extra shapes in yours that the original lacks                                       | for regenerated and chained shots                                                                                                         |
| `npx hyperframes transcribe` | words and their times                                                                                  | captions and anything timed to speech                                                                                                     |
| `npx hyperframes audio`      | onsets, beats, loudness                                                                                | graphics that land on hits; the map already lists onsets per window                                                                       |

## With a HeyGen draft

`npx hyperframes analyze .reverse/source.mp4 --preset reverse` has HeyGen's video model watch the film and writes a draft: segments with where their pixels come from, copy, actions with times, recurring elements, media boxes, risks, and the questions a frame check should settle. It sees about 6 frames a second at low resolution, so its times are within a few frames and fine detail is missing. Treat it as the first pass of steps 1–3: answer its questions with strips and trails, correct its times with the map, and write what you confirmed. Corrections are the most useful thing you produce.

## If you cannot see pictures

Every step here needs an agent that can look at images. Without that, `analyze` (`/media-use`) is the only way to watch; when it is not available either, say plainly that this video cannot be reversed in this environment.
