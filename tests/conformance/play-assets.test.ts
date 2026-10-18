/**
 * Play's Assets shelf as square tiles: Mine always reads the person's library, Everyone reads the
 * Assets feed for every kind, the whole catalog for one kind (so a kind is never empty because a
 * first page had none) and a search when words are typed. Tiles keep only the chosen kind, a library
 * asset wears Shared while it is on Play (its cover opens that page) and Saved when saved, and Use
 * lists the person's games, the most recently opened first. The store reads the library page by page
 * for one kind and search at a time, drops an answer for a list a newer read replaced, keeps what it
 * has when a read fails, and reads the catalog once until it is stale or forced.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssetScope, type LibraryAsset, LibraryKind, type LibraryPage } from "../../src/shared/asset-library.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import type { GenexCatalogItem } from "../../src/shared/mention-corpus.ts";
import { type PlayGame, PlayShelf } from "../../src/shared/play.ts";
import {
  ALL_ASSETS,
  addTargets,
  catalogTiles,
  EMPTY_LIBRARY,
  gameTiles,
  KindChoice,
  libraryTile,
  TileSource,
  tileSource,
  WAVE_BARS,
  waveDrawing,
  withLibraryPage,
} from "../../src/renderer/play/asset-tiles.ts";
import { CardTag } from "../../src/renderer/asset-library-view.ts";
import { FeedStatus } from "../../src/renderer/play/play-model.ts";
import { assetViewChosen, createPlayStore, FEED_STALE_MS, initialPlay } from "../../src/renderer/state/play.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

function catalogItem(over: Partial<GenexCatalogItem> & { slug: string }): GenexCatalogItem {
  return {
    title: over.slug,
    description: "",
    shelf: PlayShelf.Assets,
    authorId: null,
    authorName: "Threejs Community",
    thumbnailUrl: null,
    playsCount: 0,
    remixable: true,
    assetKind: LibraryKind.Model,
    ...over,
  };
}

function game(over: Partial<PlayGame> & { slug: string }): PlayGame {
  return {
    id: over.slug,
    title: over.slug,
    description: "",
    coverUrl: null,
    clipUrl: null,
    multiplayer: false,
    plays: 0,
    online: null,
    author: { id: null, name: "Gab", imageUrl: null },
    remixable: false,
    assetKind: LibraryKind.Model,
    ...over,
  };
}

function asset(over: Partial<LibraryAsset> & { id: string }): LibraryAsset {
  return {
    kind: LibraryKind.Model,
    title: over.id,
    thumbnailUrl: null,
    fileUrl: `https://assets.genex.technology/generations/${over.id}/file.glb`,
    saved: false,
    shared: null,
    createdAt: "2026-10-17T09:00:00.000Z",
    ...over,
  };
}

const keys = (tiles: readonly { key: string }[]): string[] => tiles.map((tile) => tile.key);

describe("Assets shelf: where the tiles come from", () => {
  it("reads Mine from the person's library whatever the kind or search", () => {
    for (const kind of [KindChoice.All, KindChoice.Sound])
      for (const query of ["", "crowd"])
        assert.equal(tileSource({ scope: AssetScope.Mine, kind }, query), TileSource.Library, `${kind} ${query}`);
  });

  it("reads Everyone from the feed for every kind, the whole catalog for one kind, and a search once words are typed", () => {
    assert.equal(tileSource(ALL_ASSETS, ""), TileSource.Feed);
    assert.equal(tileSource(ALL_ASSETS, "   "), TileSource.Feed, "blank words are no search");
    assert.equal(tileSource({ scope: AssetScope.Everyone, kind: KindChoice.Sound }, ""), TileSource.Catalog);
    assert.equal(tileSource({ scope: AssetScope.Everyone, kind: KindChoice.Sound }, "crowd"), TileSource.Search);
    assert.equal(tileSource(ALL_ASSETS, "crowd"), TileSource.Search);
  });

  it("opens on everyone's assets of every kind, and a switcher's same choice keeps the state", () => {
    const state = initialPlay();
    assert.deepEqual(state.assetView, ALL_ASSETS);
    assert.equal(assetViewChosen(state, { kind: KindChoice.All }), state);
    const mine = assetViewChosen(state, { scope: AssetScope.Mine });
    assert.deepEqual(mine.assetView, { scope: AssetScope.Mine, kind: KindChoice.All });
    assert.deepEqual(assetViewChosen(mine, { kind: KindChoice.Image }).assetView, {
      scope: AssetScope.Mine,
      kind: KindChoice.Image,
    });
  });
});

describe("Assets shelf: tiles", () => {
  const items = [
    catalogItem({ slug: "stone-fireplace" }),
    catalogItem({ slug: "crowd-cheer", assetKind: LibraryKind.Sound, authorName: "Rabneba" }),
    catalogItem({ slug: "mossy-wall", assetKind: LibraryKind.Image }),
    catalogItem({ slug: "lost-cathedral", shelf: PlayShelf.Games, assetKind: null }),
    catalogItem({ slug: "physics-sandbox", shelf: PlayShelf.Tools, assetKind: null }),
  ];

  it("keeps only the catalog's assets of the chosen kind, every asset for All, never a game or a tool", () => {
    assert.deepEqual(keys(catalogTiles(items, KindChoice.Sound)), ["crowd-cheer"]);
    assert.deepEqual(keys(catalogTiles(items, KindChoice.Video)), []);
    assert.deepEqual(keys(catalogTiles(items, KindChoice.All)), ["stone-fireplace", "crowd-cheer", "mossy-wall"]);
  });

  it("draws a shared asset with who made it, adds it by its slug and opens its page", () => {
    const [tile] = catalogTiles(items, KindChoice.Sound);
    assert.deepEqual(tile, {
      key: "crowd-cheer",
      title: "crowd-cheer",
      author: "Rabneba",
      coverUrl: null,
      kind: LibraryKind.Sound,
      fileUrl: null,
      source: { slug: "crowd-cheer" },
      slug: "crowd-cheer",
      tag: null,
    });
  });

  it("filters a page or a search by kind, and a card with no named maker has no author line", () => {
    const games = [
      game({ slug: "fireplace" }),
      game({ slug: "cheer", assetKind: LibraryKind.Sound, author: { id: null, name: "", imageUrl: null } }),
    ];
    assert.deepEqual(keys(gameTiles(games, KindChoice.All)), ["fireplace", "cheer"]);
    const [cheer] = gameTiles(games, KindChoice.Sound);
    assert.equal(cheer?.author, null);
    assert.deepEqual(cheer?.source, { slug: "cheer" });
  });

  it("tags a library asset Shared while it is on Play, else Saved when saved, else nothing", () => {
    const live = { projectId: "p1", slug: "chitin-hut", live: true };
    const shared = libraryTile(asset({ id: "gen-hut-0003", shared: live, saved: true }));
    assert.equal(shared.tag, CardTag.Shared);
    assert.equal(shared.slug, "chitin-hut", "a shared asset's cover opens its page on Play");
    const stopped = libraryTile(asset({ id: "gen-old-0007", shared: { ...live, live: false }, saved: true }));
    assert.equal(stopped.tag, CardTag.Saved);
    assert.equal(stopped.slug, null, "an asset taken off Play has no page to open");
    const plain = libraryTile(asset({ id: "gen-mush-0001" }));
    assert.equal(plain.tag, null);
    assert.equal(plain.author, null, "the person's own asset names nobody");
    assert.deepEqual(plain.source, { generationId: "gen-mush-0001" });
    assert.equal(plain.fileUrl, "https://assets.genex.technology/generations/gen-mush-0001/file.glb");
  });

  it("offers the person's games for Use, the most recently opened first, leaving the list it was given", () => {
    const games = [
      { name: "a", title: "A", createdAt: "2026-10-01", lastOpenedAt: "2026-10-10" },
      { name: "b", title: "B", createdAt: "2026-10-12" },
      { name: "c", title: "C", createdAt: "2026-09-01", lastOpenedAt: "2026-10-16" },
    ] as unknown as GameProject[];
    assert.deepEqual(
      addTargets(games).map((g) => g.name),
      ["c", "b", "a"],
    );
    assert.deepEqual(
      games.map((g) => g.name),
      ["a", "b", "c"],
    );
  });

  it("draws a sound the same way each time, louder in the middle, every bar within the tile", () => {
    const wave = waveDrawing("crowd-cheer");
    assert.equal(wave.length, WAVE_BARS);
    assert.deepEqual(waveDrawing("crowd-cheer"), wave);
    assert.notDeepEqual(waveDrawing("rain-loop"), wave);
    assert.ok(
      wave.every((bar) => bar >= 0.18 && bar <= 1),
      wave.join(","),
    );
    const middle = wave[Math.floor(WAVE_BARS / 2)] ?? 0;
    assert.ok(middle > (wave[0] ?? 1), "the middle is louder than the edge");
  });
});

describe("Assets shelf: the person's library, page by page", () => {
  const key = { kind: KindChoice.All, query: "" };
  const page = (assets: LibraryAsset[], nextCursor: string | null = null): LibraryPage => ({ assets, nextCursor });

  it("replaces the list with a first page under its key, and adds only the assets a further page does not have", () => {
    const first = withLibraryPage(
      EMPTY_LIBRARY,
      { kind: KindChoice.Sound, query: " crowd " },
      page([asset({ id: "gen-a-00001" })], "gen-a-00001"),
      false,
      5,
    );
    assert.equal(first.status, FeedStatus.Ready);
    assert.equal(first.kind, KindChoice.Sound);
    assert.equal(first.query, "crowd");
    assert.equal(first.at, 5);
    const more = withLibraryPage(
      first,
      key,
      page([asset({ id: "gen-a-00001" }), asset({ id: "gen-b-00002" })]),
      true,
      9,
    );
    assert.deepEqual(
      more.assets.map((a) => a.id),
      ["gen-a-00001", "gen-b-00002"],
    );
    assert.equal(more.nextCursor, null);
    assert.equal(more.at, 5, "a further page keeps when the list was first read");
  });

  it("reads the kind and words asked, then the page after the last one's cursor", async () => {
    const fake = fakeStudioApi();
    const pages = [page([asset({ id: "gen-a-00001" })], "gen-a-00001"), page([asset({ id: "gen-b-00002" })])];
    fake.stub("assetLibrary", async () => pages.shift() ?? page([]));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const sounds = { kind: KindChoice.Sound, query: "crowd" };
    await play.loadLibrary(sounds);
    await play.loadLibrary(sounds, { more: true });
    assert.deepEqual(fake.callsOf("assetLibrary"), [
      [{ kind: LibraryKind.Sound, query: "crowd" }],
      [{ kind: LibraryKind.Sound, query: "crowd", before: "gen-a-00001" }],
    ]);
    assert.deepEqual(
      play.getState().library.assets.map((a) => a.id),
      ["gen-a-00001", "gen-b-00002"],
    );
    await play.loadLibrary(sounds, { more: true });
    assert.equal(fake.callsOf("assetLibrary").length, 2, "no next page past the last");
  });

  it("asks every kind with no filter, reads a fresh list once, and again once stale or forced", async () => {
    const fake = fakeStudioApi();
    fake.stub("assetLibrary", async () => page([asset({ id: "gen-a-00001" })]));
    let now = 1_000;
    const play = createPlayStore(fake.api, null, () => now);
    await play.loadLibrary(key);
    await play.loadLibrary(key);
    assert.deepEqual(fake.callsOf("assetLibrary"), [[{}]]);
    await play.loadLibrary(key, { force: true });
    now += FEED_STALE_MS;
    await play.loadLibrary(key);
    assert.equal(fake.callsOf("assetLibrary").length, 3);
  });

  it("drops the answer for a list a newer read replaced", async () => {
    const fake = fakeStudioApi();
    const answers: Array<(page: LibraryPage) => void> = [];
    fake.stub("assetLibrary", () => new Promise<LibraryPage>((resolve) => answers.push(resolve)));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const all = play.loadLibrary(key);
    const sounds = play.loadLibrary({ kind: KindChoice.Sound, query: "" });
    answers[1]?.(page([asset({ id: "gen-snd-0001", kind: LibraryKind.Sound })]));
    await sounds;
    answers[0]?.(page([asset({ id: "gen-old-0001" })]));
    await all;
    const library = play.getState().library;
    assert.equal(library.kind, KindChoice.Sound);
    assert.deepEqual(
      library.assets.map((a) => a.id),
      ["gen-snd-0001"],
    );
  });

  it("shows the list asked for last when it comes back to one still on its way", async () => {
    const fake = fakeStudioApi();
    const answers: Array<(page: LibraryPage) => void> = [];
    fake.stub("assetLibrary", () => new Promise<LibraryPage>((resolve) => answers.push(resolve)));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const sounds = { kind: KindChoice.Sound, query: "" };
    const all = play.loadLibrary(key);
    const sound = play.loadLibrary(sounds);
    const back = play.loadLibrary(key);
    answers[1]?.(page([asset({ id: "gen-snd-0001", kind: LibraryKind.Sound })]));
    answers[0]?.(page([asset({ id: "gen-all-0001" })]));
    await Promise.all([all, sound, back]);
    const library = play.getState().library;
    assert.equal(library.kind, KindChoice.All);
    assert.equal(library.status, FeedStatus.Ready);
    assert.deepEqual(
      library.assets.map((a) => a.id),
      ["gen-all-0001"],
    );
  });

  it("says an empty list failed, keeps a list's assets when a read fails, and says a further page failed", async () => {
    const fake = fakeStudioApi();
    let fail = true;
    fake.stub("assetLibrary", async () => {
      if (fail) throw new Error("offline");
      return page([asset({ id: "gen-a-00001" })], "gen-a-00001");
    });
    const play = createPlayStore(fake.api, null, () => 1_000);
    await play.loadLibrary(key);
    assert.equal(play.getState().library.status, FeedStatus.Failed);
    fail = false;
    await play.loadLibrary(key, { force: true });
    fail = true;
    await play.loadLibrary(key, { force: true });
    assert.equal(play.getState().library.status, FeedStatus.Ready);
    assert.equal(play.getState().library.assets.length, 1);
    await play.loadLibrary(key, { more: true });
    assert.equal(play.getState().library.moreFailed, true);
    assert.equal(play.getState().library.assets.length, 1);
  });
});

describe("Assets shelf: the whole catalog for the kind switcher", () => {
  it("reads it once while fresh, and says it failed until a forced read brings it", async () => {
    const fake = fakeStudioApi();
    let fail = true;
    fake.stub("playCatalog", async () => {
      if (fail) throw new Error("offline");
      return [catalogItem({ slug: "stone-fireplace" })];
    });
    const play = createPlayStore(fake.api, null, () => 1_000);
    await play.loadAssetCatalog();
    assert.equal(play.getState().assetCatalog.status, FeedStatus.Failed);
    fail = false;
    await play.loadAssetCatalog({ force: true });
    await play.loadAssetCatalog();
    assert.equal(play.getState().assetCatalog.status, FeedStatus.Ready);
    assert.deepEqual(
      play.getState().assetCatalog.items.map((item) => item.slug),
      ["stone-fireplace"],
    );
    assert.equal(fake.callsOf("playCatalog").length, 2);
  });
});
