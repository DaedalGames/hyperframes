---
name: media-use
description: Get or make any media for a HyperFrames video - music, sound effects, images, icons, logos, voiceover, avatar and generated video, transcripts, cutouts, colour grades and looks - with HeyGen or free local tools, and mix placed audio. Also for footage that looks dark, flat or dull, or should be stylized or hidden.
---

**Plugin installs:** Before setup or freshness commands, follow [plugin execution rules](../hyperframes/references/plugin-installation.md) when this skill is inside a HyperFrames plugin.

# Media in HyperFrames

Media lands as a local file in the project's `assets/` with a ledger record; renders never fetch. One verb finds or makes it:

```bash
npx hyperframes media-use resolve --type <type> --intent "<what you need>" --project <dir>
```

It prints one line, `resolved <id> → <path> (<type>, <metadata>)`. List reusable assets first with `--candidates` and judge the fit yourself; reuse, ingest (`--from`) and adopt are in `references/resolve.md`.

## Where it comes from

| Need | Free | HyperFrames credits | Local or the person's own key (only when they ask) |
| --- | --- | --- | --- |
| Music (`bgm`) | HeyGen catalog of 10k+ tracks (signed in) | Generated track | Local MusicGen (`audio/references/bgm.md`) |
| Sound effects (`sfx`) | Openverse; 21 bundled offline | | |
| Images, icons | HeyGen asset search, 75k+ (signed in) | Generated images | Local FLUX (mflux), if installed |
| Logos (`logo`) | theSVG, GitHub avatar, favicon; never redrawn | | |
| Voiceover (`voice`) | HeyGen Voice Turbo (signed in) | Other HeyGen voices, voice cloning | `npx hyperframes tts` (Kokoro on device; Python 3.10+ with `pip install kokoro-onnx soundfile`) |
| A presenter speaking | | Avatar video (`--type video`) | Local LTX for generic clips, if installed |
| Transcripts | `npx hyperframes transcribe` (Parakeet or whisper) | | |
| Cutouts | | `heygen background-removal` | `npx hyperframes remove-background` |
| Grades, LUTs, looks | `npx hyperframes media-treatment` | | |

**Sign in.** When a request needs a HeyGen model or the catalog and there is no credential, tell the person in one line that sign-in is free and gives Voice Turbo, the music catalog and asset search, then run `npx hyperframes auth login` and show the link it prints. Check setup with `npx hyperframes media-use resolve --doctor`. Don't fall back to local models on your own; use local tools or the person's own keys only when they ask for that.

**Host apps.** Inside an app that gives you its own media tools, use those first. When `HEYGEN_API_BASE` is set, the host pays for HeyGen: don't ask for a sign-in, and when a call is refused, relay the host's message as written and stop.

**Credits.** Plan for the best result; don't swap in cheaper or free options, or drop items, to save credits unless the person asks to save cost. Before the first paid item, tell the person the total for everything you intend to make and get one yes for that budget; inside it, don't ask again. When a call answers with a `Subscribe:` or `Add credits:` line, show it to the person exactly as printed and stop paid steps until they are done. `--provider <name>` pins one generator when the person names it. `--local-only` skips every network provider.

**More HeyGen recipes.** The [`heygen` CLI](https://developers.heygen.com/cli) makes text-to-video (`heygen video-agent create`), avatar videos with a recorded track (`heygen video create`), cloned voices (`heygen voice clone create`), dubbing (`heygen lipsync`), translated videos (`heygen video-translate`) and short clips from a long video (`heygen ai-clipping`): recipes in `references/operations.md`. Credit CC BY sounds (`audio/references/sfx.md`).

## Looks on real footage

Feedback that footage is dark, flat or dull, should feel retro or printed, needs a face hidden, or needs a reveal is media intent: read `references/media-treatments.md`. Inspect the real `<img>`/`<video>`, pick one intent, start from `npx hyperframes media-treatment --capabilities --json`, then `--capability <id>`; never `--all`. Persist the final treatment with `npx hyperframes media-treatment`; no CSS or SVG stand-ins for supported effects, and no generated `.cube` just to encode exposure or warmth.

## Offer once, never add silently

When you build or review a piece, scan once for concrete gaps (on-screen text with no voiceover, emoji standing in for icons, placeholder images, silent cuts, 10 s+ with no music, a colour cast) and offer the specific fixes in one ask. No signal, no suggestion; respect "leave it".

## Where to look

| Task | Read |
| --- | --- |
| Resolve, reuse, adopt, ingest, flags | `references/resolve.md` |
| Grading, LUTs, `grade-compare` | `references/grading.md` |
| Voiceover, music, sound effects, captions, transcription | `references/audio.md` |
| Cut, reframe or transform media; HeyGen recipes | `references/operations.md` |
| Treatments, realtime effects, overlays, reveals | `references/media-treatments.md` |
| Install, sign-in, providers, RAM ladders | `references/setup-providers.md` |
| Fades, gain, ducking, automation, effects, buses on placed tracks | `references/mixing.md` |
| Local commands: grade, cutout, loudness, beats | `references/local.md` |
| Remembered preferences | `references/memory.md` |
