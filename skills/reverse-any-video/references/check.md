# Checking the rebuild against the original

Check from cheapest to most expensive, and fix only the segment that fails. Each step passes before the next runs; after a fix, start again from the step that failed.

| Step | Command                                                                                                                    | What it catches                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `npx hyperframes check --json`                                                                                             | contract and layout errors, and the measured onsets and order in `*.motion.json`; no render |
| 2    | `npx hyperframes diff .reverse/source.mp4 . --at <t,…>`                                                                    | stills at chosen moments, captured from the project without rendering                       |
| 3    | `npx hyperframes diff .reverse/source.mp4 . --range <a,b>`                                                                 | every frame of one segment, captured the same way                                           |
| 4    | `npx hyperframes render --fps <fps>`, then `npx hyperframes diff .reverse/source.mp4 <render> --segments REVERSE.md --sbs` | every frame, cuts, duration, a verdict per segment, `sbs.mp4`                               |

## Motion assertions from the measurements

Put what you measured where `check` can hold you to it: one `index.motion.json` beside `index.html`, its selectors reaching into every scene, its times in film seconds.

```json
{
  "assertions": [
    { "kind": "appearsBy", "selector": "#headline", "bySec": 0.57 },
    { "kind": "before", "a": "#headline", "b": "#cta" },
    { "kind": "staysInFrame", "selector": ".card" }
  ]
}
```

`check` samples the timeline about every 0.05 s, so `bySec` is the measured onset plus 0.05. Leave `keepsMoving` out: the original's holds are part of what you copy. A contrast or text-size finding on an element the original shows the same way is the original's look: keep it and mark the element `data-layout-ignore`.

## Moments to compare at

At each event's first frame and the frame before it, mid-move, at the settle, and on both sides of every cut; `measure events --map` lists them. A still pass at a quiet moment says little.

## Reading `diff`

- `ssim.mean` and `ssim.p05`: the whole frame, averaged and at its worst 5%.
- `ssim.cell_p05`: each frame's worst cell of a 4x4 grid. A missing, late or misplaced element drags one cell and barely moves the whole-frame score, so read this first.
- `missing_content`: the share of frames where a cell the original fills is flat in yours, and the longest such stretches (`spans`, seconds). Two near-blank patches score alike, so an empty scene on a plain background passes SSIM and the cell gate; over 2% fails.
- `frames`: the path of a tab-separated table of every compared frame's time, SSIM and worst cell, to find the stretches that fail.
- `worst`: the lowest moments, at least 0.5 s apart, each with the failing cell (`roi`, in source pixels) and `cell.picture`, that cell at full size, original beside yours. `worst.jpg` shows the whole frames with the cell boxed: look at these before changing anything.
- `cuts`: the original's cuts with no cut within a frame in yours (`missing`), and yours with none in the original (`extra`).
- `sound`: how far yours' sound sits from the original's (positive is late).
- `segments`: a verdict per `REVERSE.md` segment. `regenerated` segments are judged by `energy.mean_ratio` (how much it moves, 0.8–1.25) and `look`. On a project folder, `--segments` alone compares the segments' whole span.

Passing, provisional until more films calibrate it: mean ≥ 0.92, p05 ≥ 0.85, worst cell p05 ≥ 0.75 for rebuilt and reused segments; reused pixels should land near 1. Short fades and flights of small elements are where the worst cells end up. A regenerated person also gets `measure sync` (within +45 / −125 ms) and `measure face` on the render, and chained shots `measure continuity`. Every cut within a frame, the same duration, and the sound within a frame. Override with `--min-mean`, `--min-p05` and `--min-cell` only for a reason you write in the report.

## Fixing

Biggest difference first: a missing element, then position and size, then timing, then colour and texture.

| What `diff` shows                   | Likely cause                                     | Fix                                                             |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| low everywhere from the first frame | canvas size, aspect or background differ         | match the probe's size; check the root's fill                   |
| fine at first, drifting later       | frame rate or durations differ                   | render at the original's `fps`; times as multiples of one frame |
| one cell low during a move only     | ease or timing                                   | `measure curve` on both, compare ease, start and duration       |
| one cell low throughout a segment   | an element missing, misplaced or mis-sized       | `measure box` on both at that time                              |
| low only in text cells              | font, size, weight or tracking                   | see Fonts in `layers.md`                                        |
| cut missing or one frame off        | a clip's `data-start` off a frame boundary       | start clips at `k / fps`                                        |
| colour only                         | palette or grade                                 | `measure look --compare`; colours from `measure box`            |
| reused segment not near 1           | wrong window or crop, or a transform on the clip | re-extract with the window and box from the map                 |

Stop when every segment passes, or when two rounds in a row leave the worst segment no better. Write what is left, and why, in the report.

## Effects a seeked timeline reproduces

- **Directional motion blur** (a whip, words sliding in): CSS `blur()` is symmetric and wrong. An SVG `<filter>` with `<feGaussianBlur stdDeviation="0 0">` on the moving wrapper, its `stdDeviation` tweened (`"24 0"` is a horizontal smear); for another angle, rotate an outer wrapper and counter-rotate the inner one.
- **Ghost trail:** 2–4 clones behind the element, offset along the motion by a growing distance, opacity about 0.5, 0.3, 0.15.
- **Zoom blur:** a few scaled clones (1.02–1.15) with falling opacity around the zoom's origin.
- **Chromatic fringe:** red and cyan clones offset 2–4 px opposite ways, `mix-blend-mode: screen`.
- **Glow:** stacked `text-shadow` or `drop-shadow`, tweening radius and alpha, not a blur of the core.
- **Grain:** over drawn layers, SVG `feTurbulence` with a fixed seed, stepped per frame for moving grain; on footage, `npx hyperframes media-treatment` (`/media-use`).
- **Glass type over footage:** a second copy of the shot (the same `src` and timing) inside the letters: an inline SVG `<clipPath>` holding the `<text>` clips it, and an SVG filter of `feTurbulence` (`baseFrequency` about 0.02, a fixed seed) into `feDisplacementMap` (scale 40–60) bends it. A darker copy of the text multiplied over it (15–35%, tinted toward the original's), a 2–3 px dark stroke, a light top edge (a gradient copy at 30–50% opacity, `mix-blend-mode: screen`) and a soft shadow make it read as glass. The copy sits in the same camera group as the shot, so it moves with it.
- **Masks and wipes:** `clip-path` or `mask-image` with a tweened gradient stop.
- **Flash:** a full-frame layer for exactly the measured frames.
