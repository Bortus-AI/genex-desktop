# Genex multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's multiplayer card,
unchanged. Where it disagrees with this preface, this preface wins.

## Multiplayer works only on the published Genex draft

- Studio's preview is single-player. It opens a game that uses `@genex-ai/embed-sdk` in local
  test mode (`?genex_local_test=1`): the relay gets no credential there, so `connect()` and
  `matchmake()` fail by design. Rendering, controls and feel can still be checked in the preview.
- Check prerequisites before building online features: the pinned SDKs and an authorized hosted
  test route. Request both SDKs in one approval with
  `genex__package {"package":"@genex-ai/multiplayer"}` (it includes embed-sdk). After approval,
  build the game; publish a draft with
  `genex__publish {"operation":"draft"}`; wait with `genex__publish-status`; then test on the draft
  link. Only the owner can open a draft, so hand the link to the user to try in two tabs; a friend
  can join only once the game is published to the gallery. Until someone has played the draft,
  say plainly that multiplayer was not exercised.
- Studio installs the version it pins, which satisfies the card's `^0.16.0`. Never run
  `npm i` for these packages yourself.
- A game made from Studio's template has no `package.json`: it loads three.js through an import
  map, and the same `genex__package` call maps Studio's built-in copies of both SDKs into that map,
  with nothing downloaded. Import them exactly as the card shows, in plain JavaScript (the template
  has no TypeScript build, so leave out the card's type annotations). Its settings go in
  `genex.json` at the game's root (`{"matchmaking": {...}}`) wherever the card says package.json's
  `genex` field. Never copy the SDK into the game by hand.
- A game with its own build but no `package.json` needs one first: give it one, then call
  `genex__package`. A game's shape is never a reason to refuse multiplayer: restructure what you
  must, and keep its single-player play working.

- If approval is declined or times out, or the hosted test route is unavailable, report the
  specific blocker. Preserve local play; do not retry without changed authorization or claim
  multiplayer works. Finish independent required work before optional visual polish.

## Config without `genex init`

Studio never runs `genex init`, so the game starts without `src/genex.config.ts` or `.env`. After
the first draft, `genex__publish-status` reports the game's `slug`. Write the config yourself,
then publish a new draft (a template game: `src/genex.config.js`, the same object without
`as const`, imported as `./genex.config.js`):

```ts
// src/genex.config.ts
export const GENEX = {
  slug: "<the slug genex__publish-status reported>",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
} as const;
```

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed:

- `skills/genex-threejs-multiplayer/references/realtime-patterns.md`
- `skills/genex-threejs-multiplayer/references/genre-recipes.md`
- `skills/genex-threejs-multiplayer/references/host-physics.md`
- `skills/genex-threejs-multiplayer/references/genex-netcode-feel-checklist.md`

For example: `genex__skill {"name":"genex-threejs-multiplayer","file":"skills/genex-threejs-multiplayer/references/genre-recipes.md"}`.

## Commands

`npx genex controller chat`, `npx genex controller voice` and `genex controller character` are not
available in Studio: build chat, voice and the character from the SDK calls the card shows.
Commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
