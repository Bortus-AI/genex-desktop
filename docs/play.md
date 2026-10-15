# Play and the Genex account

Play is genex.games inside the app: its games, tools and assets, the person's Genex account, their
friends, profiles and stats. The sidebar's Play/Create switch opens it; Create is the studio.
What Play sends is in [PRIVACY](../PRIVACY.md#play).

## The account belongs to the app

- Main owns it (`src/main/core/genex-account.ts`): one view the plate, Settings and Publish read
  (signed out, signing in, signed in, or ended), sign-in, cancel and sign-out. It rides on the
  bundled Genex plugin's account: the registry's `appAccount` keeps that account, its credential
  and the account and Publish actions (`GENEX_ACCOUNT_ACTIONS`) while Genex is off, and keeps its
  backend running. Off takes only the agent's tools, MCP servers and skills. Genex can be turned
  off, never removed.
- Sign-in opens genex.games in the browser; two presses open one page, and a cancel while it starts
  wins. When it finishes, Genex turns on unless the person turned it off themselves (the record's
  `turnedOff`).
- Only genex.games refusing the token (a 401 on any account call) ends a sign-in. Offline is never
  signed out: the last account and balance are remembered on this Mac (`studio.genex.me`,
  `studio.genex.credits`); signing out, which Studio asks first, forgets them.
- The sidebar plate: signed out (Sign in to Genex), finishing in the browser (× cancels), signed in
  (avatar, name, Pro, friends stack), offline (the last account with the offline mark), ended
  (dimmed, Sign in again). Its menu: Profile, Friends, Credits (the Genex plugin page's Credits
  tab), Account settings, Sign out.
- Settings › Genex account: avatar (generated or photo, Regenerate), name, credits with Buy credits,
  Sign out by the title. Signed out it is the sign-in stage, with the account-card drawing.
- Publish needs only the account: signed out it asks to sign in. Multiplayer needs the Genex plugin
  on, since the agent builds it with Genex's tools.

## The dashboard

- Games, Tools and Assets, each with tabs and search; Recent once something was played; Top
  creators (the last 30 days) above Games' tabs. The promo card shows until the first sign-in or
  its ×.
- Friends: requests, playing now (Join), friends, sent, people search, the invite link and whether
  friends see the game the account is in. Offline it shows the page as last read with nobody
  playing, and every press waits.
- Profiles: the avatar, name, chips, friends and games. The account's own adds a 7-day strip
  opening Stats (7, 30 or 90 days; tiles, plays per day, every game).
- Generated avatars come from the account's id (`src/shared/avatar-recipe.ts`, the same recipe
  genex.games draws): a WebGPU body with a 2D fallback, eyes and gear in 2D, 25 frames a second,
  at most 28 avatars a frame, still under Reduce Motion, while idle and under a modal.

## Playing a game

- A game plays full window in a sandboxed view (`persist:genex-play`) under the app's header: Like,
  Share, Invite, Remix, Exit; a held Esc gives the header the keyboard. A single-use ticket in the
  address's fragment signs the player in; a guest is offered sign-in. The rest of the app is inert
  until the game closes.
- The page stays on Genex games' addresses; a link it opens goes to the browser, at most one every
  few seconds.
- Voice chat: a game that asks for a microphone gets the header's mic switch, remembered per game.
  Main lets the page open the microphone only right after it asked it to, and only on the game's
  own origin.
- Remix clones the game's public source from Genex's git (https only, no hooks or filters, its Git
  LFS files from the same repository; a download fails only once it stalls for a minute) into a
  hidden folder, installs its packages with npm without running any of their scripts (a stale or
  another manager's lockfile: from package.json), moves it to `<slug>-remix`, adopts it without trusting its settings and builds it
  once, so it opens playing. One remix at a time. Remix (a card's, or the viewer's, which closes
  the viewer) switches to Create at once: a sidebar row with the cover in a ring (the adopted game
  stays off the list until it opens) and, over the workspace, the chat it will have (title, status
  line, a composer that takes nothing yet) beside the stage's loader with the step and a step bar
  (`UiEvent.PlayRemix`, the models with their bytes), fading out when the new game opens. Going
  elsewhere sets it aside and its row brings it back; one finished meanwhile is a toast, and its
  game takes the row. A failure is a toast, and Play comes back for a person still with it. A remix
  keeps its scripts off until a build fails and the person trusts it: the stage's Run setup scripts.

## Where to work

`src/renderer/play/`, `src/renderer/state/play.ts` and `people.ts`, `src/renderer/avatars/`,
`src/main/play/`, `src/main/core/genex-account.ts`; selectors in the
[feature map](agent/feature-map.md). Fixtures: `STUDIO_FIXTURE_GENEX_ACCOUNT=1|new|quiet|fresh`
signs a fixture launch in, `ended` gives it a refused one. Tests: `tests/conformance/play-*`,
`genex-account`, `app-account-plugin`.
