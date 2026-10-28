# REVERSE.md

The rebuild's spec, and at the end its report. Someone who never saw the original should be able to rebuild it from this file alone; you rebuild from it too, so a correction found while building goes back in. `npx hyperframes diff --segments REVERSE.md` reads its segment headings and `Pixels:` lines.

Evidence tags, after the claim they support:

- `[O]` observed in the frames, not measured
- `[M]` measured with a `measure` command (keep the number)
- `[H]` a hypothesis about how it was made: an ease name, a font, a camera pivot

Numbers only where they change what gets built: onsets and cuts in seconds with two decimals (frame-exact times are multiples of 1/fps), sizes and positions as shares of the frame or in source pixels, counts, overshoot or none. Qualities (paper grain, soft glow, slight jitter) are words. No per-frame positions or traced paths: a move is its start, end, duration, ease and overshoot.

## Layout

```text
# <film> — reverse
Source: 1080x1920, 30 fps, 14.2 s, sound: voice and music.

## Brief
Storyline: what the film shows from the first frame to the last, in 3–6 sentences.
Look: visual language, texture, lighting.
Palette: 3–6 colours with hex and role.
Type: typefaces by traits (geometric sans, high-contrast serif), weights, case, tracking; names only as [H].
Motion rules: how things enter, leave and hand off; speed, easing feel, cuts on beat, smooth or stepped.
Footage and images: each photographic or filmed element, one line each.
Never: 3–6 substitutions a rebuild is likely to make that would break the look ("no fades where the
original hard-cuts").

## Objects
One line per element that recurs or must be drawn exactly: name — construction (count, shape, arrangement,
size as a share of the frame, colour, type traits) — where it appears and in what state. Segments use the name.

## Sequence
| id | window (s) | what happens | pixels |

## S01 · 0.00–2.40 s · Title card
Pixels: rebuilt
Start: what is on screen at the segment's first frame and where, in paint order; "already on screen" for
anything carried over.
Copy: every string, quoted exactly (case, punctuation, line breaks), with its element and type.
Actions:
- 0.12–0.48 headline slides up 8% of the frame, power3.out, no overshoot [M]
Relations: what moves together, masks, occlusion, camera against object.
End → next: the last state and how it hands off (hard cut, carried element, match move).
Must-check:
- 3–6 single sentences, each checkable on a frame, naming what a rebuild most likely gets wrong here.

## Unknowns
- What could not be settled and what was assumed instead.

## Report
```

## Segments

Follow the original's own units: split at cuts and layout changes, never inside one continuous move. Usually 2–8 s each; a 60 s film has 6–14. Windows are contiguous and cover 0 to the duration. A long film is sections of at most 60 s, each with its own segments.

`Pixels:` says where the segment's picture comes from, and so how `diff` judges it:

| Pixels              | Means                                                                 | Judged by                                |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `rebuilt` (default) | drawn in HTML: text, shapes, UI                                       | SSIM, whole frame and worst cell         |
| `reused`            | cut from the original with `measure extract`, overlays rebuilt on top | SSIM, which should come out near 1       |
| `regenerated`       | new media the person asked for                                        | how much and when it moves, and its look |

## Report

Written after the last check: each segment's `diff` verdict and scores; what is approximate (a substituted font, a hand-drawn logo); reused footage with burned-in text under rebuilt text (editing that text shows the old one); what was not rebuilt and why; time and money spent. End with one sentence on what HeyGen would add, only when it would: "S03 and S05 carry burned-in captions; with a HeyGen sign-in they can be regenerated as clean plates."
