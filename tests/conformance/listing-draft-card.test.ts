/**
 * The chat's Listing draft card (marketplace P11, plan 8.3; screen 09). It comes from a host record
 * only (`item_drafted`), never from the agent's words, and goes up after the turn's reply; a newer
 * draft of the same item takes the earlier card's place. Its presses call genex.games through main
 * (Put on sale, Other games can use it), and it offers only what the item's state allows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listingCardView, ListingSale, shareChange } from "../../src/renderer/chat/listing-draft.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { composedInChat, composeInChatWhenOpen, takeWaitingCompose } from "../../src/renderer/compose-in-chat.ts";
import { chatPlaceholder, COMPOSER_LINE_CHARS, ITEM_PLACEHOLDER } from "../../src/renderer/composer-placeholder.ts";
import { createItemsStore, ItemAction } from "../../src/renderer/state/items.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import type { ListingDraft } from "../../src/shared/item-draft.ts";
import { type CreatorItem, ItemState, ItemType, StoreRefusal } from "../../src/shared/store-items.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const FROST_AXE: ListingDraft = {
  project: "snowball",
  itemId: "sku_frost",
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  type: ItemType.Durable,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  iconUrl: null,
  state: ItemState.Draft,
  shareable: true,
};

let seq = 0;
const at = (data: EventData, turn: string | null = "turn-1"): EventEnvelope => {
  seq += 1;
  return {
    id: String(seq).padStart(6, "0"),
    thread_id: "t1",
    turn_id: turn,
    session_id: null,
    created_at: new Date(seq * 1000).toISOString(),
    data,
  };
};
const said = (role: "user" | "assistant", content: string) =>
  at({ type: "messages", messages: [{ role, content }] } as EventData);
const drafted = (payload: Record<string, unknown>) =>
  at({ type: "custom", event_type: CustomEvent.ItemDrafted, payload } as EventData);
const turn = (ended = false) =>
  at((ended ? { type: "turn_ended", status: "completed" } : { type: "turn_started" }) as EventData);

const kinds = (events: EventEnvelope[]) => toEntries(events).map((entry) => entry.kind);
const cards = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.ListingDraft ? [entry.draft] : []));

describe("the Listing draft card in the chat", () => {
  it("goes up after the agent's reply, once the turn that made the item ends", () => {
    const working = [turn(), said("user", "Add a Frost Axe to the store for 1,200 coin."), drafted({ ...FROST_AXE })];
    assert.deepEqual(cards(working), [], "held while the turn runs");
    const done = [...working, said("assistant", "Done. The axe is in your store."), turn(true)];
    assert.deepEqual(kinds(done).slice(-2), [EntryKind.Assistant, EntryKind.ListingDraft]);
    assert.deepEqual(cards(done), [FROST_AXE]);
    const askedOn = [...done, said("user", "Make it shine.")];
    assert.deepEqual(kinds(askedOn).slice(-3), [EntryKind.Assistant, EntryKind.ListingDraft, EntryKind.User]);
  });

  it("shows a record from a log with no turn open at once", () => {
    assert.deepEqual(cards([drafted({ ...FROST_AXE })]), [FROST_AXE]);
  });

  it("keeps one card per item: the latest draft, where it was made", () => {
    const changed = { ...FROST_AXE, priceCoins: 800, priceDisplayUsdCents: 800 };
    const events = [
      drafted({ ...FROST_AXE }),
      said("user", "Make it 800."),
      turn(),
      drafted(changed),
      said("assistant", "It costs 800 now."),
      turn(true),
    ];
    assert.deepEqual(cards(events), [changed]);
    assert.equal(kinds(events).at(-1), EntryKind.ListingDraft);
  });

  it("is never drawn from the agent's words, and not from a record that does not read", () => {
    const echoed = JSON.stringify({ kind: "genex.item_draft", version: 1, id: "sku_frost", name: "Frost Axe" });
    assert.deepEqual(cards([said("assistant", echoed), drafted({ ...FROST_AXE, itemId: "../x" }), drafted({})]), []);
  });
});

describe("what the card offers", () => {
  const view = (latest?: Partial<CreatorItem>, busy?: ItemAction, refusal?: StoreRefusal) =>
    listingCardView(
      FROST_AXE,
      latest ? { state: FROST_AXE.state, shareable: FROST_AXE.shareable, ...latest } : undefined,
      busy,
      refusal,
    );

  it("offers Put on sale and the toggle for a draft", () => {
    const card = view();
    assert.equal(card.sale, ListingSale.Offer);
    assert.equal(card.canPutOnSale, true);
    assert.equal(card.canShare, true);
    assert.equal(card.shared, true);
  });

  it("follows genex.games' answer once a press came back", () => {
    assert.equal(view({ state: ItemState.OnSale }).sale, ListingSale.OnSale);
    assert.equal(view({ shareable: false }).shared, false);
    assert.equal(view({ state: ItemState.OffSale }).sale, ListingSale.Offer, "its author took it off: offered again");
  });

  it("says On sale, with no Put on sale, for an item a store that is off put on sale as it was made (D7)", () => {
    const card = listingCardView({ ...FROST_AXE, state: ItemState.OnSale }, undefined, undefined, undefined);
    assert.equal(card.sale, ListingSale.OnSale);
    assert.equal(card.canPutOnSale, false);
    assert.equal(card.canShare, true, "sharing stays the author's to change");
  });

  it("offers Put on sale for a draft and an item its author took off sale, and for nothing else", () => {
    const offered = Object.values(ItemState).filter(
      (state) => listingCardView({ ...FROST_AXE, state }, undefined, undefined, undefined).canPutOnSale,
    );
    assert.deepEqual(offered.sort(), [ItemState.Draft, ItemState.OffSale].sort());
  });

  it("offers nothing for an item an admin took off sale", () => {
    const card = view({ state: ItemState.TakenDown });
    assert.equal(card.sale, ListingSale.TakenDown);
    assert.equal(card.canPutOnSale, false);
    assert.equal(card.canShare, false);
  });

  it("offers sharing for a durable only", () => {
    const potion = listingCardView({ ...FROST_AXE, type: ItemType.Consumable }, undefined, undefined, undefined);
    assert.equal(potion.canShare, false);
  });

  it("takes no second press while one is under way, and says why the last was refused", () => {
    const pressing = view(undefined, ItemAction.PutOnSale);
    assert.equal(pressing.sale, ListingSale.Pressing);
    assert.equal(pressing.canShare, false);
    const sharing = view(undefined, ItemAction.Unshare);
    assert.equal(sharing.sharing, true);
    assert.equal(sharing.canPutOnSale, false);
    assert.equal(view(undefined, undefined, StoreRefusal.PictureMissing).refusal, StoreRefusal.PictureMissing);
  });
});

describe("the card's presses", () => {
  it("Put on sale and the toggle call main for this item, and the card shows the answer", async () => {
    // genex.games keeps the item: each answer is the item as it stands after the press.
    let held = item(FROST_AXE.itemId);
    const fake = fakeStudioApi({
      itemPutOnSale: async () => {
        held = { ...held, state: ItemState.OnSale };
        return held;
      },
      itemSetShared: async (_itemId, shared) => {
        held = { ...held, shareable: shared };
        return held;
      },
    });
    const items = createItemsStore(fake.api);
    await items.change(FROST_AXE.itemId, shareChange(false));
    await items.change(FROST_AXE.itemId, ItemAction.PutOnSale);
    assert.deepEqual(fake.callsOf("itemSetShared"), [["sku_frost", false]]);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), [["sku_frost"]]);
    const { changed, busy, refused } = items.getState();
    const card = listingCardView(FROST_AXE, changed.sku_frost, busy.sku_frost, refused.sku_frost);
    assert.equal(card.sale, ListingSale.OnSale);
    assert.equal(card.shared, false);
  });
});

/** The item as genex.games answers its author. */
function item(id: string): CreatorItem {
  return {
    id,
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
  };
}

describe("the chat's composer while it makes an item", () => {
  it("asks for an item or a change, on one line", () => {
    const words = chatPlaceholder({ revisingPlan: false, studio: false, draft: false, item: true });
    assert.equal(words, ITEM_PLACEHOLDER);
    assert.equal(ITEM_PLACEHOLDER, "Ask for an item or a change…");
    assert.ok(words.length <= COMPOSER_LINE_CHARS);
    assert.equal(
      chatPlaceholder({ revisingPlan: true, studio: false, draft: false, item: true }),
      "Describe the changes to the plan…",
    );
  });
});

describe("words left for a game's chat before it opens", () => {
  it("wait for that game's chat, are taken once, and go once a chat took them", () => {
    const scope = globalThis as { window?: EventTarget };
    const hadWindow = "window" in scope;
    scope.window ??= new EventTarget();
    try {
      const request = { project: "snowball", text: "Add the shared item", send: true };
      composeInChatWhenOpen(request);
      assert.equal(takeWaitingCompose("claude-of-duty"), null, "another game's chat leaves them");
      assert.equal(takeWaitingCompose("snowball"), request);
      assert.equal(takeWaitingCompose("snowball"), null, "taken once");
      composeInChatWhenOpen(request);
      composedInChat(request);
      assert.equal(takeWaitingCompose("snowball"), null, "an open chat took them already");
    } finally {
      if (!hadWindow) delete scope.window;
    }
  });
});
