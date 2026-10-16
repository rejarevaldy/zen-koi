# Zen Koi

A quiet pixel-art koi pond for bb. It sits on top of a thread's chat input
while the agent works and runs on into the chat input itself, so your koi swim
under the text you type. Open the **Zen Pond** page from the navigation rail to
visit the pond any time, look after your koi, and set up the garden.

Zen Koi takes the chat-input placement from charpeni's
[Gone Fishing](https://github.com/charpeni/bb-plugins/tree/main/plugins/gone-fishing).
It has its own art and code.

## Watch or play

- **Watch.** Koi wander, rest, drift deeper and back up, keep each other
  company, and come over to look when your pointer rests on the water. Click
  to scatter a little food and the nearest koi come to eat it.
- **Koi-sukui.** The festival game of scooping fish with a paper *poi*, cut
  down to one timing tap so it fits a short wait. The poi moves and dips by
  itself and koi gather under it. When one is right over the paper a **!**
  shows: tap the water, or press Space or Enter, to scoop it. Tap too soon
  and the koi darts off.
  - wet paper weakens over time, and a big koi strains it until it tears
  - poi paper comes as No.4 (thick), No.5, or No.6 (thin)

  Every koi you scoop rests in a floating wooden bowl for a moment and then
  slips back into the pond. After 15 seconds without a tap the poi scoops by
  itself again, so you can just watch.

## Pixel or text

Settings → Display → **Look** switches the pond between pixel art and quiet
ASCII art in your theme's own text color, with no other colors. In ASCII art
each koi is a little fish that grows longer over its first two weeks (`><>`,
`><('>`, `><(('>`), faces the way it swims, and fades as it swims deeper. Open
water carries a few slow `~`, the bank a few `.` and `'`. In catch, the poi is
`( )`, a `!` shows when a koi is over it, and the bowl is `\___/`. ASCII art
redraws at a calmer 12.5 frames a second.

## The garden and the weather

- A shoreline of grass and mossy stones, water that deepens away from the bank,
  sunlight playing over the bed, and water plants swaying.
- An overhanging tree that follows the season: sakura in spring, green in
  summer, maple red in autumn, bare with snow in winter. Petals and leaves fall
  from it and float away; fireflies come out on summer evenings.
- A stone lantern on a rock in the shallows, lit from dusk to dawn and in the
  rain, with its light on the water. The moon shows on clear nights.
- Lily pads with lotus flowers in spring and summer.
- Rain, if you like, with rings all over the water.
- Sound, off until you turn it on: moving water, a wind chime in the
  miyako-bushi scale, the odd knock of a shishi-odoshi, rain, and small sounds
  for food and the poi.
- A breathing guide (in for 4, hold for 2, out for 6), with a slow ring across
  the pond on every in-breath.

## The Zen Pond page

- **Your koi.** Add up to nine koi from ten varieties (Kohaku, Tancho, Sanke,
  Showa, Ogon, Yamabuki, Asagi, Chagoi, Shiro Utsuri, Kumonryu), name them, and
  release them. Each koi's pattern is its own, and koi grow over their first
  two weeks. The page counts how often each one has been scooped.
- **Garden.** Lantern, tree, water plants, and none, few, or many lily pads.
- **Ambience.** Season and time of day (auto or pinned), weather, sound and
  volume, and the breathing guide.
- **Above the chat input.** Show the pond while the agent works, always, or
  only on the page.

Hover the strip's top-right corner (or focus the pond from the keyboard) for
its few controls: Catch or Watch, settings, and hide. In Catch, the only
text is a brief note after a catch or a miss. Sound lives in the settings
panel. Clicking the pond never
takes focus from the chat input. The pond honors reduced motion.

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
npm test          # simulation and koi-sukui tests (node:test)
npm run typecheck
bb plugin build
bb plugin dev     # rebuild and reload on save
```

| File                | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `config.ts`         | The saved pond: koi, garden, ambience, and defaults        |
| `koi.ts`            | The simulation: koi, food, ripples, rain, falling petals   |
| `sukui.ts`          | Koi-sukui: the poi, the paper, the bowl, and auto play     |
| `scene.ts`          | The pixel-art painter, one pond world per set of canvases  |
| `text.ts`           | The ASCII-art look                                         |
| `world.ts`          | Ties the config, simulation, painter, and poi together     |
| `composer-water.ts` | The pond's continuation behind the chat input              |
| `sound.ts`          | The soundscape, made with Web Audio                        |
| `app.tsx`           | The strip above the chat input and the Zen Pond page       |
| `server.ts`         | Stores the pond and scoop counts                           |

## Data

Your koi, garden, and ambience are saved in the plugin's key-value storage on
the bb server, so they follow you between the desktop app and the browser,
along with how often each koi has been scooped. Sound settings and whether the
strip is hidden stay in this browser.

bb has no plugin API for placing UI next to the chat input. Zen Koi finds the
chat input through bb's markup (`[data-app-composer]`,
`[data-follow-up-composer-anchor]`, `form[data-promptbox]`). If a bb update
changes that markup, the pond falls back to bb's banner position and the chat
input stays dry.
