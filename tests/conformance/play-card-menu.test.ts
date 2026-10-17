/**
 * A Play card's ⋯ menu on the renderer's side: what a change does to the cards on screen, what the
 * mobile row reads, and the store's `manage` over a fake API.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedGame, curationOf, MobileShown, mobileShown } from "../../src/renderer/play/card-menu/manage-model.ts";
import { EMPTY_FEED, FeedStatus } from "../../src/renderer/play/play-model.ts";
import { createPlayStore, gameChanged, initialPlay } from "../../src/renderer/state/play.ts";
import {
  type PlayChangeResult,
  PlayChangeKind,
  PlayChangeOutcome,
  type PlayCuration,
  type PlayGameChange,
  PlayMobileSupport,
} from "../../src/shared/play-manage.ts";
import { PlayCategory, type PlayFeedPage, type PlayGame } from "../../src/shared/play.ts";

const CURATION: PlayCuration = { mobileSupport: null, mobileAuto: null, categories: ["arcade"], remixOff: false };

function game(slug: string, remixOff = false): PlayGame {
  return {
    id: `id-${slug}`,
    slug,
    title: slug.toUpperCase(),
    description: "",
    coverUrl: null,
    clipUrl: null,
    multiplayer: false,
    plays: 0,
    online: null,
    author: { id: "owner", name: "Owner", imageUrl: null },
    remixable: !remixOff,
    curation: { ...CURATION, remixOff },
  };
}

const DONE: PlayChangeResult = { outcome: PlayChangeOutcome.Done };
const ready = (games: PlayGame[]) => ({ ...EMPTY_FEED, games, status: FeedStatus.Ready, at: 1 });
const slugs = (games: readonly PlayGame[] | undefined) => games?.map((g) => g.slug);

describe("Play card menu: a change on the cards", () => {
  it("takes a game off every card once it is unpublished or deleted", () => {
    for (const kind of [PlayChangeKind.Unpublish, PlayChangeKind.Delete] as const)
      assert.equal(changedGame(game("skate"), { kind }, DONE), null);
  });

  it("turns remixing off and on with the card's Remix button", () => {
    const off = changedGame(game("skate"), { kind: PlayChangeKind.Remixing, allowed: false }, DONE) as PlayGame;
    assert.equal(off.remixable, false);
    assert.equal(curationOf(off).remixOff, true);
    const on = changedGame(off, { kind: PlayChangeKind.Remixing, allowed: true }, DONE) as PlayGame;
    assert.equal(on.remixable, true);
    assert.equal(curationOf(on).remixOff, false);
  });

  it("keeps genex.games' stored tags, the asked ones when it gives none, and sets the mobile flag", () => {
    const tags: PlayGameChange = { kind: PlayChangeKind.Tags, categories: ["sports"] };
    const stored = changedGame(game("skate"), tags, { ...DONE, categories: ["racing"] }) as PlayGame;
    assert.deepEqual(curationOf(stored).categories, ["racing"]);
    assert.deepEqual(curationOf(changedGame(game("skate"), tags, DONE) as PlayGame).categories, ["sports"]);
    const mobile = changedGame(
      game("skate"),
      { kind: PlayChangeKind.Mobile, mobileSupport: PlayMobileSupport.DesktopOnly },
      DONE,
    ) as PlayGame;
    assert.equal(curationOf(mobile).mobileSupport, PlayMobileSupport.DesktopOnly);
  });

  it("reads the mobile row as the admin's choice, else Auto's flag, else nothing", () => {
    const table: Array<[Partial<PlayCuration>, MobileShown | null]> = [
      [
        { mobileSupport: PlayMobileSupport.Supported, mobileAuto: PlayMobileSupport.DesktopOnly },
        MobileShown.Supported,
      ],
      [{ mobileSupport: null, mobileAuto: PlayMobileSupport.DesktopOnly }, MobileShown.AutoFlagged],
      [{ mobileSupport: null, mobileAuto: null }, null],
    ];
    for (const [curation, shown] of table) assert.equal(mobileShown({ ...CURATION, ...curation }), shown);
  });

  it("changes the game in every tab that shows it and leaves the others alone", () => {
    const state = {
      ...initialPlay(),
      feeds: {
        [PlayCategory.Featured]: ready([game("a"), game("b")]),
        [PlayCategory.Arcade]: ready([game("b")]),
        [PlayCategory.Sports]: ready([game("c")]),
      },
    };
    const next = gameChanged(state, "id-b", null);
    assert.deepEqual(slugs(next.feeds[PlayCategory.Featured]?.games), ["a"]);
    assert.deepEqual(slugs(next.feeds[PlayCategory.Arcade]?.games), []);
    assert.equal(next.feeds[PlayCategory.Sports], state.feeds[PlayCategory.Sports]);
    const renamed = gameChanged(state, "id-a", { ...game("a"), title: "NEW" });
    assert.deepEqual(
      renamed.feeds[PlayCategory.Featured]?.games.map((g) => g.title),
      ["NEW", "B"],
    );
  });
});

describe("Play card menu: the store's manage", () => {
  /** A store over a fake API whose tabs show `games`; every feed read and change is recorded. */
  function storeWith(games: PlayGame[], answer: () => Promise<PlayChangeResult>) {
    const reads: PlayCategory[] = [];
    const changes: Array<{ gameId: string; change: PlayGameChange }> = [];
    const page = (shown: PlayGame[]): PlayFeedPage => ({ games: shown, nextCursor: null });
    const store = createPlayStore(
      {
        playFeed: async ({ category }) => {
          reads.push(category);
          return page(games);
        },
        playShelves: async () => ({ counts: { games: null, tools: null, assets: null }, categories: [] }),
        playOnline: async () => ({}),
        playOpen: async () => {},
        playClose: async () => {},
        playRemix: async (slug) => slug,
        playManage: (gameId, change) => {
          changes.push({ gameId, change });
          return answer();
        },
      },
      null,
      () => 1_000,
    );
    return { store, reads, changes };
  }

  it("sends the change once, drops a deleted game from the tab and reads nothing again", async () => {
    const shown = [game("a"), game("b")];
    const { store, reads, changes } = storeWith(shown, async () => DONE);
    await store.loadFeed(PlayCategory.Featured);
    reads.length = 0;
    await store.manage(shown[1] as PlayGame, { kind: PlayChangeKind.Delete });
    assert.deepEqual(changes, [{ gameId: "id-b", change: { kind: PlayChangeKind.Delete } }]);
    assert.deepEqual(slugs(store.getState().feeds[PlayCategory.Featured]?.games), ["a"]);
    assert.deepEqual(reads, []);
  });

  it("changes nothing on screen when genex.games refuses, and passes the failure on", async () => {
    const shown = [game("a")];
    const { store } = storeWith(shown, () => Promise.reject(new Error("HTTP 403")));
    await store.loadFeed(PlayCategory.Featured);
    const before = store.getState();
    await assert.rejects(store.manage(shown[0] as PlayGame, { kind: PlayChangeKind.Delete }));
    assert.equal(store.getState(), before);
  });

  it("keeps the card when remixing can't be turned on from here", async () => {
    const shown = [game("a", true)];
    const { store } = storeWith(shown, async () => ({ outcome: PlayChangeOutcome.OwnRepo }));
    await store.loadFeed(PlayCategory.Featured);
    const before = store.getState();
    const result = await store.manage(shown[0] as PlayGame, { kind: PlayChangeKind.Remixing, allowed: true });
    assert.equal(result.outcome, PlayChangeOutcome.OwnRepo);
    assert.equal(store.getState(), before);
  });
});
