# Rebuilding each layer

Every video is three kinds of layer: what can be drawn (text, shapes, UI, charts, transitions), pixels that cannot be drawn (photos, footage, AI shots, people), and sound. A motion graphic is nearly all the first; a talking head is a person with graphics over them; an AI film is nearly all the second. Mark each segment's `Pixels:` in `REVERSE.md` as you decide.

## Drawn layers

- Search the registry before hand-building a named effect, transition, caption style, chart or card (`/hyperframes-registry`); an installed item is source you restyle to the measured look.
- One sub-composition per segment, mounted at the segment's start; when one continuous camera carries several segments, they share one scene with a timeline label per segment. Each string is one element with its text bound to a variable; colours are `:root` variables named by role; fonts are variables too.
- Sizes and positions come from `measure box` and `measure objects` in source pixels: the canvas is the source's size, so they go in as measured.
- Times are multiples of one frame (`k / fps`), written rounded down: 67 / 24 is `2.791666`, since `2.791667` starts a frame late. An onset half a frame off lands on the wrong frame.
- Effects that a seeked timeline reproduces are in `check.md`.

### Fonts

Match the family by traits (geometry, contrast, x-height, terminals), then the weight. Prefer a bundled font (`/hyperframes` `references/format.md`), then a Google Fonts family downloaded into `assets/fonts/` with `@font-face`. Size it by measurement: render the candidate at a known size, `measure ink` the same text in the original and in a snapshot of yours, and scale by the ratio of their heights. A substituted font is approximate: say so in the report.

### Burned-in captions

Rebuild them as a caption track (`/hyperframes` `references/captions.md`) with the original's grouping, line breaks, position and style rather than the reference's defaults; take the words from the frames and their times from `npx hyperframes transcribe` (which can mishear names), and check each group's first and last frame against the original's with `measure events --roi` over the caption band.

### Logos

Draw simple marks as SVG from their measured geometry (`measure objects` for rings, grids and rows of parts). A photographic or textured logo is cut from the original as a still.

## Pixels from the original

Footage, photos, AI shots and people are cut from the original unless the person asks for new ones. Cut only what cannot be drawn, each piece on its own and cropped to its box: an album cover, a photo, a video window. A clip never carries drawn things along with it; an animated map, a chart, a title or a UI in the original is rebuilt even where it moves like footage.

```bash
npx hyperframes measure extract .reverse/source.mp4 --from 4.0 --to 9.5 --roi 0,0,1080,1350 --out assets/s03-presenter.mp4
npx hyperframes measure extract .reverse/source.mp4 --at 2.4 --roi 120,340,840,620 --out assets/s02-photo.png
```

Each file is recorded in the project's media ledger as cut from the original, with its window and region, and the output's `place` gives the `data-start`, `data-duration` and box to put it at. Place a clip as a muted `<video class="clip">` inside a wrapper at that box; it starts at the window's start, so it needs no trim.

- **Pictures that overlap** (popups, stacked cards): cut each at a moment it is whole and alone, before anything covers it, and cut a clip from the moment it first shows, or it plays out of step.
- **All footage, nothing drawn:** one clip per shot, cut at the cuts `diff` finds (`measure cuts`), in one scene, plus the sound.
- **Whole-frame footage with graphics over it:** one clip of the full frame only where a camera image fills the frame, the graphics rebuilt on top. A frame that is mostly drawn (a map, a chart, a UI) is rebuilt, and only its photos and video windows are cut, each to its own box.
- **Footage inside a moving frame** (a card that slides, a phone mock-up that zooms): when the content exists at rest, cut it where it is largest and least covered, and move it with your own transforms so the motion stays in your timeline. When it only appears while the frame moves, cut the union of its boxes over the move as one clip, place it unscaled outside your camera group, and clip it to the frame's box as your camera moves that box. Content that plays inside its frame is a clip, not a still.
- **A presenter talking to camera:** re-shot with HeyGen when a key is available (below), not cut: their frame carries the titles and captions burned over them. Without a key, cut them on their own and note the burned-in text.
- **Text burned into the footage:** crop around it when it sits outside the content. When it sits over the content, keep the footage and lay the rebuilt text exactly over the burned-in one: the render matches, but editing that text shows the old one underneath. Note it in the report, and that a clean plate can be regenerated on request.

## Sound

The original's sound is one file, `measure extract .reverse/source.mp4 --out assets/sound.m4a`, placed as one `<audio id="sound">` over the whole film. Reused clips then stay muted, or the voice plays twice. A film with no sound gets no `<audio>`. Graphics that land on hits are checked against `npx hyperframes audio` onsets.

## New pixels

Presenters are re-shot by default when HeyGen is available; anything else is regenerated only when the person asks. Regenerated media is made with `npx hyperframes media-use generate` (`/media-use`, `references/heygen.md`): price every piece with `--plan`, tell the person the total, and make them after they agree. Ground every generation in the original:

- **A still:** `--type image --reference <the original frame>`, asked to keep the composition and leave out what HeyGen should not draw: a clean plate.
- **A shot:** `--type video --first-frame <the shot's first frame>` at the shot's length, 5–15 s; a longer shot is chained shots, each starting from the last frame of the one before (`measure extract --at` cuts both).
- **A person speaking:** `--type video --reference <a still of them> --audio <their voice for that stretch> --prompt "…" --seconds <n> --aspect <the original's>`: the original words and timing, lips in sync, no burned-in text. Cut the voice at pauses into 5–15 s stretches (`transcribe` gives the word times), one shot per stretch at its start, then match each shot to the original:
  1. **Ask for the same shot.** The prompt names the shot size (from `measure face` height: close-up, medium, wide), what the person does (sits, walks toward the camera, turns), the camera (`measure rhythm`: still, push-in, pan, handheld), the place and the light.
  2. **Frame it.** `measure face` on the original's stretch and on the new shot: scale and move the shot so the face boxes line up. Shot, cutout and the text between them sit in one camera group, so everything moves together.
  3. **Move it like the original.** `measure rhythm --start a --end b` names each shot's camera (push in, pull out, pan, handheld) with its zoom and pan; the face heights from step 2 show its curve over time. Tween the camera group by that zoom and pan across the shot, on top of the framing. Handheld is a small seeded wiggle the size of rhythm's path, never per-frame positions.
  4. **Put text behind them where the original does.** Where the person covers the original's text, cut them out of the new shot (`npx hyperframes remove-background <shot> -o <cutout>.webm`) and stack shot, text, cutout. This only reads when the framing matches: a person framed smaller never reaches the text.
  5. **Check the motion.** `measure flow … --compare <render>` over the stretch: the energy ratio and timing say whether it moves like the original. Generated shots come out steadier than handheld footage, so the camera group carries the difference.

  `--type avatar` speaks a new script instead.

- **Music or voice:** `--type music` at the original's length and tempo (`npx hyperframes audio` gives both); `--type voice` for a voice-over in a chosen voice.

Pictures carry no text or logos: ask for clean plates and draw the words in HyperFrames. Mark the segment `Pixels: regenerated`; `diff` then judges how much and when it moves and its look, since its pixels cannot match.
