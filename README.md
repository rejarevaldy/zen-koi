# Zen Koi

A quiet pixel-art koi pond that sits on top of a thread's chat input while the
agent works. There is no score, no timer, and nothing to lose. Koi drift
around, and you can watch them while you wait.

Zen Koi takes the idea, and the chat-input placement, from charpeni's
[Gone Fishing](https://github.com/charpeni/bb-plugins/tree/main/plugins/gone-fishing).
It is a calmer take on that idea, with its own art and code.

## What it does

- **Opens with the agent.** The pond appears when a turn starts and closes a
  few seconds after it ends.
- **Koi.** Three to six koi swim slowly, rest, and drift deeper and back up.
  The varieties include Kohaku, Tancho, Sanke, Showa, Ogon, Yamabuki, Asagi,
  Chagoi, Shiro Utsuri, and Kumonryu.
- **Feeding.** Click the water, or focus the pond and press Enter, to scatter a
  little food. The nearest koi come over to eat it.
- **Breathing guide.** A dot fills and empties at five breaths a minute (in 4s,
  hold 2s, out 6s), and each in-breath sends one slow ring across the pond.
  Turn the guide off to get short reminders to rest instead.
- **Seasons and time of day.** Spring petals, summer fireflies at dusk and
  night, autumn leaves, and winter snow. The water and light follow your clock,
  and a stone lantern lights up from dusk to dawn. Click the season label to
  pin a season.
- **Flooded chat input.** While the pond is open, pale water rises behind the
  text in the chat input, with two faint koi of its own. Typing works as usual.

Clicking the pond never takes focus from the chat input. Hide the pond with
its chevron to keep just a one-line breathing guide. On compact layouts the
pond always shows as that one line. The pond honors reduced motion: the koi
hold still and nothing animates.

## Install

```sh
bb plugin install git:https://github.com/rejarevaldy/zen-koi.git
```

Or from a local checkout:

```sh
bb plugin install .
```

## Develop

```sh
npm install
npm test          # simulation tests (node:test)
npm run typecheck
bb plugin build
bb plugin dev     # rebuild and reload on save
```

`koi.ts` is the simulation, `scene.ts` draws it, `underwater.ts` floods the
chat input, and `app.tsx` places the pond.

## Data

Nothing leaves the browser. The hidden, breathing, and season preferences are
stored in `localStorage`. The server entry is empty.

bb has no plugin API for placing UI next to the chat input. Zen Koi finds the
chat input through bb's markup (`[data-app-composer]`,
`[data-follow-up-composer-anchor]`, `form[data-promptbox]`). If a bb update
changes that markup, the pond falls back to bb's banner position and the chat
input stays dry.
