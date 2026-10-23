/**
 * Create › Items' state (marketplace plan 10.3; screens 07–08): Browse's search, pages and the item
 * on show; Selling and its strip; which local games are on Genex and the game Add to acts on; and
 * the presses Selling and the Listing draft card share, each carried out by main and shown as
 * genex.games answered it. Numbers are genex.games' own: nothing here computes a price or a share.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addTarget,
  askedForItem,
  BROWSE_TYPING_MS,
  browseAnswered,
  browseAsked,
  browseQuery,
  createItemsStore,
  hostedGames,
  initialItems,
  ItemAction,
  itemChanged,
  itemChosen,
  ItemsRead,
  type ItemsState,
  localGameOf,
  sellingAnswered,
  targetChosen,
} from "../../src/renderer/state/items.ts";
import { rowMenu, SellingStatus, sellingStatus } from "../../src/renderer/panels/items/selling-model.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../src/shared/genex.ts";
import {
  type BrowseItem,
  type CreatorItem,
  ItemState,
  ItemType,
  type Selling,
  StoreRefusal,
} from "../../src/shared/store-items.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";
import { fakeClock, settle } from "../helpers/play-viewer-rig.ts";

const browseItem = (id: string, fields: Partial<BrowseItem> = {}): BrowseItem => ({
  id,
  name: id,
  description: null,
  iconUrl: null,
  modelUrl: null,
  type: ItemType.Durable,
  priceCoins: 8000,
  priceDisplayUsdCents: 8000,
  tags: [],
  author: { id: "u_mira", name: "mira_makes", handle: "mira_makes" },
  homeGame: { slug: "skate-dog", title: "Skate Dog" },
  gamesCount: 7,
  youGetPerSale: 1200,
  ...fields,
});

const page = (ids: string[], nextCursor: string | null = null) => ({
  items: ids.map((id) => browseItem(id)),
  nextCursor,
});

const creatorItem = (fields: Partial<CreatorItem> = {}): CreatorItem => ({
  id: "sku_frost",
  projectId: "proj_snow",
  type: ItemType.Durable,
  name: "Frost Axe",
  description: null,
  tags: [],
  iconUrl: null,
  modelUrl: null,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  state: ItemState.Draft,
  shareable: true,
  publishedAt: null,
  takenDownAt: null,
  ...fields,
});

const selling = (): Selling => ({
  earnedReady: 48_200,
  earnedHeld: 36_800,
  nextReleaseAt: null,
  holdDays: 7,
  items: [
    {
      id: "sku_frost",
      name: "Frost Axe",
      iconUrl: null,
      type: ItemType.Durable,
      game: { id: "proj_snow", slug: "snowball", title: "Snowball" },
      gamesCount: 1,
      state: ItemState.Draft,
      underReview: false,
      shareable: false,
      priceCoins: 1200,
      priceDisplayUsdCents: 1200,
      sold: 0,
      earned: 0,
    },
  ],
});

describe("Browse", () => {
  it("shows the first item of a search, and keeps the item on show while the next search still lists it", () => {
    const first = browseAnswered(browseAsked(initialItems(), "wings"), "wings", page(["a", "b"]));
    assert.equal(first.browse.read, ItemsRead.Ready);
    assert.equal(first.browse.selectedId, "a");
    const chosen = itemChosen(first, "b");
    const again = browseAnswered(browseAsked(chosen, "w"), "w", page(["b", "c"]));
    assert.equal(again.browse.selectedId, "b");
    const gone = browseAnswered(browseAsked(again, "crown"), "crown", page(["d"]));
    assert.equal(gone.browse.selectedId, "d");
  });

  it("drops the answer to a search the person already typed past", () => {
    const typedOn = browseAsked(browseAsked(initialItems(), "w"), "wings");
    assert.equal(browseAnswered(typedOn, "w", page(["late"])), typedOn);
  });

  it("adds a later page under the first, without listing an item twice", () => {
    const first = browseAnswered(browseAsked(initialItems(), ""), "", page(["a", "b"], "next"));
    const both = browseAnswered(first, "", page(["b", "c"]), true);
    assert.deepEqual(
      both.browse.items.map((item) => item.id),
      ["a", "b", "c"],
    );
    assert.equal(both.browse.nextCursor, null);
  });

  it("says signed out or store off from genex.games' refusal, and failed otherwise", () => {
    const asked = browseAsked(initialItems(), "");
    const read = (refused: StoreRefusal) => browseAnswered(asked, "", { refused }).browse.read;
    assert.equal(read(StoreRefusal.Unauthorized), ItemsRead.SignedOut);
    assert.equal(read(StoreRefusal.NotFound), ItemsRead.Off);
    assert.equal(read(StoreRefusal.Unknown), ItemsRead.Failed);
  });

  it("sends a search trimmed and no longer than Studio sends one", () => {
    assert.equal(browseQuery("  wings  "), "wings");
    assert.equal(browseQuery("x".repeat(500)).length, 120);
  });
});

describe("the games items go to", () => {
  const hosted = { snowball: "proj_snow", "fixture-game": null, "claude-of-duty": "proj_cod" };

  it("offers the local games that are on Genex, in the order given", () => {
    assert.deepEqual(hostedGames(hosted, ["fixture-game", "claude-of-duty", "snowball", "unread"]), [
      "claude-of-duty",
      "snowball",
    ]);
  });

  it("adds to the chosen game when it is on Genex, else to the first that is", () => {
    const games = ["fixture-game", "snowball", "claude-of-duty"];
    assert.equal(addTarget({ hosted, target: "claude-of-duty" }, games), "claude-of-duty");
    assert.equal(addTarget({ hosted, target: "fixture-game" }, games), "snowball");
    assert.equal(addTarget({ hosted: {}, target: null }, games), null);
    assert.equal(targetChosen(initialItems(), "snowball").target, "snowball");
  });

  it("finds the local game an item's Genex project is", () => {
    assert.equal(localGameOf(hosted, "proj_cod"), "claude-of-duty");
    assert.equal(localGameOf(hosted, "proj_elsewhere"), null);
    assert.equal(localGameOf(hosted, undefined), null);
  });
});

describe("a press on an item", () => {
  it("shows the item as genex.games answered it, in its Selling row too", () => {
    const shown = sellingAnswered(initialItems(), selling());
    const changed = itemChanged(shown, creatorItem({ state: ItemState.OnSale, shareable: true }));
    const [row] = changed.selling.selling?.items ?? [];
    assert.equal(row?.state, ItemState.OnSale);
    assert.equal(row?.shareable, true);
    assert.equal(changed.changed.sku_frost?.state, ItemState.OnSale);
  });

  it("New item's ask lasts until it is cleared, one game at a time", () => {
    const asking = askedForItem(initialItems(), "snowball");
    assert.equal(asking.askingIn, "snowball");
    assert.equal(askedForItem(asking, null).askingIn, null);
  });
});

describe("the items store over Studio's calls", () => {
  it("Put on sale asks main to publish exactly that item, and shows what genex.games answered", async () => {
    const fake = fakeStudioApi({ itemPutOnSale: async () => creatorItem({ state: ItemState.OnSale }) });
    const items = createItemsStore(fake.api);
    const outcome = await items.change("sku_frost", ItemAction.PutOnSale);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), [["sku_frost"]]);
    assert.deepEqual(outcome, { item: creatorItem({ state: ItemState.OnSale }) });
    assert.equal(items.getState().changed.sku_frost?.state, ItemState.OnSale);
    assert.deepEqual(items.getState().busy, {});
  });

  it("Other games can use it sets sharing on and off, and Take off sale unpublishes", async () => {
    const fake = fakeStudioApi({
      itemSetShared: async (_id, shared) => creatorItem({ shareable: shared }),
      itemTakeOffSale: async () => creatorItem({ state: ItemState.OffSale }),
    });
    const items = createItemsStore(fake.api);
    await items.change("sku_frost", ItemAction.Share);
    await items.change("sku_frost", ItemAction.Unshare);
    await items.change("sku_frost", ItemAction.TakeOffSale);
    assert.deepEqual(fake.callsOf("itemSetShared"), [
      ["sku_frost", true],
      ["sku_frost", false],
    ]);
    assert.deepEqual(fake.callsOf("itemTakeOffSale"), [["sku_frost"]]);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), []);
  });

  it("keeps genex.games' refusal on the item, and reads an outage as one it cannot name", async () => {
    const fake = fakeStudioApi({ itemPutOnSale: async () => ({ refused: StoreRefusal.PictureMissing }) });
    const items = createItemsStore(fake.api);
    await items.change("sku_frost", ItemAction.PutOnSale);
    assert.equal(items.getState().refused.sku_frost, StoreRefusal.PictureMissing);
    fake.stub("itemPutOnSale", async () => {
      throw new Error("offline");
    });
    assert.deepEqual(await items.change("sku_frost", ItemAction.PutOnSale), { refused: StoreRefusal.Unknown });
  });

  it("adds an item to a local game by that game's Genex project, read from its publish record", async () => {
    const fake = fakeStudioApi({
      pluginAction: async (_id, _name, _args, project) => (project === "snowball" ? { projectId: "proj_snow" } : {}),
      itemsAddToGame: async () => ({
        allowance: { itemId: "a", projectId: "proj_snow", state: "active", addedAt: 1, liveAt: null },
        replayed: false,
      }),
    });
    const items = createItemsStore(fake.api);
    await items.readHosted(["snowball", "fixture-game"]);
    assert.deepEqual(items.getState().hosted, { snowball: "proj_snow", "fixture-game": null });
    assert.deepEqual(
      fake.callsOf("pluginAction").map(([id, name, , project]) => [id, name, project]),
      [
        [GENEX_PLUGIN_ID, GenexAction.PublishStatus, "snowball"],
        [GENEX_PLUGIN_ID, GenexAction.PublishStatus, "fixture-game"],
      ],
    );
    await items.addToGame("a", "snowball");
    assert.deepEqual(fake.callsOf("itemsAddToGame"), [["a", "proj_snow"]]);
    const refused = await items.addToGame("a", "fixture-game");
    assert.deepEqual(refused, { refused: StoreRefusal.ProjectNotFound });
    assert.equal(fake.callsOf("itemsAddToGame").length, 1);
  });

  it("searches Browse once the person pauses typing, not at every key", async () => {
    const { clock, advance } = fakeClock();
    const fake = fakeStudioApi({ itemsBrowse: async () => page(["a"]) });
    const items = createItemsStore(fake.api, clock);
    items.searchTyped("w");
    items.searchTyped("wi");
    advance(BROWSE_TYPING_MS - 1);
    items.searchTyped(" wings ");
    assert.equal(items.getState().browse.query, "wings", "the field shows what was typed at once");
    advance(BROWSE_TYPING_MS - 1);
    assert.deepEqual(fake.callsOf("itemsBrowse"), [], "no read while the keys keep coming");
    advance(1);
    await settle();
    assert.deepEqual(fake.callsOf("itemsBrowse"), [["wings", null]]);
    assert.deepEqual(
      items.getState().browse.items.map((item) => item.id),
      ["a"],
    );
  });

  it("reads Browse page by page, and the next page only once", async () => {
    const fake = fakeStudioApi({
      itemsBrowse: async (_query, cursor) => (cursor ? page(["c"]) : page(["a", "b"], "next")),
    });
    const items = createItemsStore(fake.api);
    await items.search(" wings ");
    await Promise.all([items.more(), items.more()]);
    assert.deepEqual(fake.callsOf("itemsBrowse"), [
      ["wings", null],
      ["wings", "next"],
    ]);
    const state: ItemsState = items.getState();
    assert.deepEqual(
      state.browse.items.map((item) => item.id),
      ["a", "b", "c"],
    );
  });
});

describe("a Selling row", () => {
  const row = (state: ItemState, fields: { underReview?: boolean; type?: ItemType } = {}) => ({
    state,
    underReview: fields.underReview ?? false,
    type: fields.type ?? ItemType.Durable,
  });

  it("says Draft, Report under review or Off sale, and nothing for an item on sale", () => {
    assert.equal(sellingStatus(row(ItemState.Draft)), SellingStatus.Draft);
    assert.equal(sellingStatus(row(ItemState.OnSale, { underReview: true })), SellingStatus.UnderReview);
    assert.equal(sellingStatus(row(ItemState.OffSale)), SellingStatus.OffSale);
    assert.equal(
      sellingStatus(row(ItemState.TakenDown)),
      SellingStatus.OffSale,
      "an admin's take-down reads as off sale",
    );
    assert.equal(sellingStatus(row(ItemState.OnSale)), null);
  });

  it("offers Put on sale for a draft or an item off sale, Take off sale otherwise, and sharing for a durable", () => {
    assert.deepEqual(rowMenu(row(ItemState.Draft), true), { putOnSale: true, share: true, ask: true });
    assert.deepEqual(rowMenu(row(ItemState.OffSale), false), { putOnSale: true, share: true, ask: false });
    assert.deepEqual(rowMenu(row(ItemState.OnSale, { type: ItemType.Consumable }), true), {
      putOnSale: false,
      share: false,
      ask: true,
    });
  });

  it("offers nothing on an item an admin took off sale", () => {
    assert.equal(rowMenu(row(ItemState.TakenDown), true), null);
  });
});
