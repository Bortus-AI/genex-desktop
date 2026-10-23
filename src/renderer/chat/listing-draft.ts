/**
 * The Listing draft card's model (marketplace P11, plan 8.3; screen 09): what the card shows for a
 * store item the game's agent made, and which presses it offers. Its words are the draft's (the
 * agent's latest `genex shop add|set`); whether it is on sale and shared is what genex.games last
 * answered a press with, else the draft's. Put on sale shows while the item is a draft or off sale;
 * an item an admin took off sale offers nothing (D14); "Other games can use it" is for a durable
 * only (P3). The presses themselves are the items store's (`state/items.ts`), carried out by main.
 */
import type { ListingDraft } from "../../shared/item-draft.ts";
import { type CreatorItem, ItemState, ItemType, type StoreRefusal } from "../../shared/store-items.ts";
import { ItemAction, type ItemChange } from "../state/items.ts";

/** Where the card's sale stands. */
export const ListingSale = {
  /** Put on sale is offered: the item is a draft, or its author took it off sale. */
  Offer: "offer",
  /** Put on sale was pressed and genex.games has not answered yet. */
  Pressing: "pressing",
  OnSale: "on-sale",
  /** An admin took it off sale after a complaint: nothing to press (D14). */
  TakenDown: "taken-down",
} as const;
export type ListingSale = (typeof ListingSale)[keyof typeof ListingSale];

/** What the card draws. */
export interface ListingCardView {
  itemId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  priceCoins: number;
  sale: ListingSale;
  /** Put on sale can be pressed now: offered, with no other press under way. */
  canPutOnSale: boolean;
  /** "Other games can use it", as it stands. */
  shared: boolean;
  /** The toggle can be pressed now. */
  canShare: boolean;
  /** A press on the toggle is under way. */
  sharing: boolean;
  /** Why genex.games refused the last press, if it did. */
  refusal: StoreRefusal | null;
}

/** Where the sale stands for an item in `state`, with `busy` the press under way. */
function saleOf(state: ItemState, busy: ItemAction | undefined): ListingSale {
  if (busy === ItemAction.PutOnSale) return ListingSale.Pressing;
  if (state === ItemState.OnSale) return ListingSale.OnSale;
  if (state === ItemState.TakenDown) return ListingSale.TakenDown;
  return ListingSale.Offer;
}

/**
 * The card for `draft`, with `latest` the item as genex.games last answered a press on it, `busy`
 * the press under way and `refusal` why the last one was refused.
 */
export function listingCardView(
  draft: ListingDraft,
  latest: Pick<CreatorItem, "state" | "shareable"> | undefined,
  busy: ItemAction | undefined,
  refusal: StoreRefusal | undefined,
): ListingCardView {
  const state = latest?.state ?? draft.state;
  const sharing = busy === ItemAction.Share || busy === ItemAction.Unshare;
  const shareable = draft.type === ItemType.Durable && state !== ItemState.TakenDown;
  const sale = saleOf(state, busy);
  return {
    itemId: draft.itemId,
    name: draft.name,
    description: draft.description,
    iconUrl: draft.iconUrl,
    priceCoins: draft.priceCoins,
    sale,
    canPutOnSale: sale === ListingSale.Offer && busy === undefined,
    shared: latest?.shareable ?? draft.shareable,
    canShare: shareable && busy === undefined,
    sharing,
    refusal: refusal ?? null,
  };
}

/** The press the toggle makes when set to `on`. */
export const shareChange = (on: boolean): ItemChange => (on ? ItemAction.Share : ItemAction.Unshare);
