# Opening and closing a Reverse

What the person reads at the start, when money stops the run, and at the end. Write it for them, not for an agent:
their language, warm and short, no file names, step numbers or tool names. Show any command they type as a code
block they can copy.

## Not signed in yet

Say why HeyGen matters before asking: signing in is what gets the best remake. HeyGen watches the whole video and
drafts its timeline, and can re-shoot the presenter when the video has one. For example:

> To rebuild this video at its best, I'll work with HeyGen: it watches the whole video, drafts the timeline, and can
> re-shoot the presenter. Sign in once by typing this in the prompt:
>
> ```
> ! npx hyperframes auth login
> ```
>
> Your browser opens the HeyGen sign-in. Once you're in, reply "done".
>
> Then it takes about 20–50 minutes: I study the video shot by shot, rebuild every layer as a project you can edit,
> and check it against the original until it matches.

## Signed in, no plan

A plan, Free included, comes before any work. Say it in one line, then run `npx hyperframes billing subscribe`
with a 10-minute timeout: it opens the plans page and returns once a plan is active. For example:

> You're signed in. Pick a plan to start (Free works); I've opened the page and I'll carry on as soon as you're done.

## Signed in with a plan

One line, then start. Keep the credits `npx hyperframes auth status` shows; the closing needs them.

> You're signed in on Pro with 25,000 credits. This takes about 20–50 minutes; I'll show you the project when it
> matches.

## Out of credits mid-run

A refused step prints what it needs and the balance. Tell the person, run the `npx hyperframes billing top-up
--needed <n>` it names (10-minute timeout; it opens the page and returns once the balance covers the step), then
run the same step again. Never trim the plan to fit.

> This step needs 180 credits and you have 30. I've opened the top-up page; I'll pick up right where I stopped
> once it's done.

## At the end

Run `npx hyperframes auth status` again and say what this run used and what is left, after where the project is.

> Your project is ready in `./goat`. This run used 180 credits; 24,820 are left.

## Time

Say 20–50 minutes for a clip under a minute; never invent a longer figure. A longer film is worked in sections, so
say so and give the number of sections.
