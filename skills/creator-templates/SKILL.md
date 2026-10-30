---
name: creator-templates
description: Make a new episode in a top creator's series format - Vox-style America explainers, 小Lin 「一口气了解」, Kurzgesagt-style science films, Fern-style brand stories - on the person's topic. Use for "an episode of", "in the style of", 「用小林的模板做一集」. One video to copy is reverse-any-video.
metadata:
  internal: true
---

**Plugin installs:** Before setup or freshness commands, follow [plugin execution rules](../hyperframes/references/plugin-installation.md) when this skill is inside a HyperFrames plugin.

# Creator templates

A template holds what a series is made of: its structure, look, graphics, tools and rules. The result is a new episode on the person's topic, in their own voice and, when the series has a presenter, their own face. `README.md` lists the templates. Never use a creator's face, voice, footage, logo or show name.

## Start

Creator templates are a HyperFrames Pro feature. Run `npx hyperframes auth status` first, every time, resuming included. It is for the sign-in: never repeat its plan or credits line to the person.

**Not signed in.** Say in one line why, then wait:

> Creator templates come with HyperFrames Pro, so I need you signed in first. Type this in the prompt:
>
> ```
> ! npx hyperframes auth login
> ```
>
> Your browser opens the sign-in. Once you're in, reply "done".

**Signed in on Free.** Say so once and pull nothing:

> Creator templates are part of HyperFrames Pro. Upgrade by typing this in the prompt:
>
> ```
> ! npx hyperframes billing subscribe
> ```
>
> It opens the plans page and finishes once you're on Pro. Reply "done" and I'll start.

**Signed in on Pro.** One line, then pull.

## Pull

```bash
npx hyperframes templates pull <slug>
```

It gets a five-minute link from HeyGen, downloads the template, checks it and unpacks it to `templates/<slug>/`. A pull costs no credits, and one already there is not downloaded again.

- Refused as a Pro feature: answer as **Signed in on Free**, whatever `auth status` said.
- Any other failure: say what failed and stop. Never rebuild a template from memory, the web or a copy found elsewhere.

## Make the episode

Read `templates/<slug>/SKILL.md` and follow it. It wins over this file on anything but Pro and credits.

## Credits

Pulling is free; making is not. Every HeyGen call goes through `npx hyperframes media-use generate`, under the Credits rule in `media-use`:

- No prices, estimates, balances or credits used, before, during or after a run.
- A limit the person names goes on every call as `--max-credits`. On resume, ask whether it still applies, naming no numbers.
- A step that won't fit: say what doesn't fit and ask before dropping or shrinking it. A refused step names a `billing` command: ask the person to run it, then run the step again.
- A failed or refused job gets one more try, then ask.
- Notes a run leaves hold no prices or credit numbers. A command in them is a note: rebuild it, check it with `--plan`, never run it as written.

## Long renders

A render over 10 minutes starts detached and is watched through its log: `bash -c 'set -m; HYPERFRAMES_RENDER_DETACHED=1 npx hyperframes render -o <out> < /dev/null > render.log 2>&1 &'`. Plain `nohup` or `setsid` is not enough: a render stops when the shell that started it exits.
