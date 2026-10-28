---
name: reverse-any-video
description: Reverse any video. Remake a reference video's structure, pacing and look with the person's own product, copy and brand as an editable HyperFrames project. Use when the person shares a video and wants one like it.
metadata:
  internal: true
---

**Plugin installs:** Before setup or freshness commands, follow [plugin execution rules](../hyperframes/references/plugin-installation.md) when this skill is inside a HyperFrames plugin.

# Reverse any video

The skill is free. Video understanding and generated media use HyperFrames credits; the person approves one budget up front. The `/hyperframes` contract applies to the remake; media comes through `/media-use`.

## Sign in

Understanding the reference uses a HeyGen model, so it needs sign-in. If there is no credential, tell the person in one line that sign-in is free and gives Voice Turbo, the music catalog and asset search, run `npx hyperframes auth login` and show the link it prints. If the person says to use their own API keys or only local tools, do that and don't bring sign-in up again.

## Steps

1. **Estimate once.** Tell the person what understanding the reference costs and the typical total for a high-quality remake, and get one budget, unless they already gave one. Don't ask about cost again while you stay inside it.
2. **Understand the reference.** Shots with their timing, on-screen text, typography, palette, camera moves, speech and music. HeyGen video understanding for the CLI is not wired yet; until it is, use frames and the transcript (`npx hyperframes transcribe`) only when the person agreed to local tools, and say what that leaves out.
3. **Plan for the best result.** Shot by shot: keep the reference's timing and rhythm, swap in the person's product, copy and brand. Choose the media that gives the highest-quality remake; don't trim the plan or swap in cheaper or free options unless the person asked to save cost. If the plan costs more than the budget, stop: show the total and ask the person to raise it or top up. Never cut the plan to fit.
4. **Make the media** with `/media-use`. Relay any `Subscribe:` or `Add credits:` line exactly as printed.
5. **Build** the composition, then `npx hyperframes lint` and `npx hyperframes check`; render locally with `npx hyperframes render` (free).
6. **Wrap up.** Tell the person what the project used and what is left, and list what you could not match from the reference.
