---
name: reverse-any-video
description: Rebuild any video file as an editable HyperFrames project - motion graphics, talking heads, live action or AI-generated footage. Measure and watch it, rebuild every layer, then check the render against the original frame by frame. Use to reverse, recreate, replicate or copy a video.
metadata:
  internal: true
---

**Plugin installs:** Before setup or freshness commands, follow [plugin execution rules](../hyperframes/references/plugin-installation.md) when this skill is inside a HyperFrames plugin.

# Reverse a video

The result is a HyperFrames project whose render matches the original and stays editable: text is text, graphics are elements with named colours, and every media file records where it came from. It is done when `npx hyperframes check` passes and `diff` against the original passes every segment. Build to the `/hyperframes` contract; this skill adds how to read a video you only have as pixels. Reverse videos the person has the right to use.

## 0. Prepare

Sign in first; start only when `npx hyperframes auth status` shows a sign-in and a plan. Open and close with `references/start.md`.

```bash
npx hyperframes init <project>
npx hyperframes measure probe <video> --normalize <project>/.reverse/source.mp4
```

`.reverse/source.mp4` is the evidence: measured and compared, never published. Give the root composition the original's size and render at its frame rate (the probe's `canvas`; NTSC rates stay fractions such as `30000/1001`). Over 60 s, work in sections split at cuts.

## 1. Analyse: measure first, then look

You see stills, not motion, and evenly spaced frames turn cuts into dissolves and drop one-frame flashes. Let measurement decide where to look (`references/watch.md`):

1. `npx hyperframes measure events .reverse/source.mp4 --map`: cuts, flashes, what appears where, holds and the sound's hits, grouped into windows.
2. `measure frames --every 1` for the overview, `measure frames --events` for each window's consecutive frames, `measure trail` to see a move in one picture.
3. Numbers from `measure box | ink | curve | objects | rhythm | look`; words from `npx hyperframes transcribe`; beats from `npx hyperframes audio`.

Start with `npx hyperframes analyze .reverse/source.mp4 --preset reverse`: HeyGen drafts the same timeline; correct it against the frames.

Write `REVERSE.md` (`references/spec.md`): the brief, the recurring objects, then one section per segment with its copy, actions, times and where its pixels come from. Every number comes from a measurement; tag each claim observed, measured or hypothesis.

## 2. Rebuild by layer

| Layer | Signed in (default) | Offline, or asked local only |
| --- | --- | --- |
| Text, shapes, UI, charts, transitions | HTML + GSAP, registry first | — |
| Burned-in captions | a caption track styled like the original, timed from the transcript | — |
| Logos | SVG geometry; cut from the original when photographic | — |
| Photos, footage, AI shots | generated from its frame (`/media-use`) | cut on its own (`measure extract --roi`) |
| A presenter | re-shot with HeyGen from a still and their voice | cut from the original |
| Sound | original voice (`measure extract --out assets/sound.m4a`), generated music | the original's track |

`references/layers.md` covers placement, burned-in text over reused footage, fonts and regeneration. One sub-composition per segment (one scene when a single camera spans several); each string one element bound to a variable; colours as `:root` variables.

## 3. Check, cheapest first

| Step | Command | Cost |
| --- | --- | --- |
| 1 | `npx hyperframes check`, with a `*.motion.json` of the measured onsets | no render |
| 2 | `npx hyperframes diff .reverse/source.mp4 . --at <t,…>` at onsets, mid-moves and both sides of cuts | stills |
| 3 | `npx hyperframes diff .reverse/source.mp4 . --range <a,b>` for the segment you changed | its frames |
| 4 | `npx hyperframes render`, then `diff .reverse/source.mp4 <render> --segments REVERSE.md --sbs` | one render |

Fix what `worst.jpg` shows: missing elements, then position and size, then timing, then colour. Stop when every segment passes, or after two rounds without gain on the worst segment, and write what is left in the report (`references/check.md`).

Segments handed to subagents: wait for every one in the same turn, then assemble `REVERSE.md` and run step 4 yourself. A headless run (`claude -p`) ends with your turn and drops background work; a segment left empty still scores high on a plain background, which `diff` flags as missing content.

## Rules

- What cannot be drawn is generated with HeyGen when signed in, cut only offline. A clip carrying a chart, title or UI is a copy, not a reverse.
- Build mechanisms, not traced paths: no coordinate lists or per-frame positions.
- Copy every string exactly: case, punctuation, line breaks.
- Keep hard cuts hard, holds held and one-frame flashes one frame long.
- What is on screen at a segment's first frame starts there; it does not animate in.
- Generated pictures carry no text or logos; HyperFrames draws those.
