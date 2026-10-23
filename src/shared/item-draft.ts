/**
 * A listing draft (marketplace P11, plan 8.3): an item the game's chat agent made with
 * `genex shop add --json`, or changed with `genex shop set --json`, through Studio's own
 * `genex__cli-paid`. Studio main recognises it in the real tool result (`main/core/item-draft.ts`),
 * never in anything the agent wrote, and records it in the chat as `item_drafted`, a record only
 * the host writes. The chat draws it as the Listing draft card, whose buttons call genex.games from
 * main (`itemSetShared`, `itemPutOnSale`): the agent never presses them (D40). Browser-safe.
 */
import {
  isItemId,
  isItemState,
  isItemType,
  ITEM_DESCRIPTION_MAX,
  ITEM_NAME_MAX,
  type ItemState,
  type ItemType,
} from "./store-items.ts";

/** What the CLI's `--json` draft calls itself (contract "CLI `--json` draft"). Wire value: never rename it. */
export const ITEM_DRAFT_KIND = "genex.item_draft";
/** The draft document's version Studio reads. */
export const ITEM_DRAFT_VERSION = 1;

/** The most coin an item may cost: what Studio confirms at most on its own sheet. */
const PRICE_MAX = 100_000;
/** The longest local game name a record may carry. */
const PROJECT_MAX = 200;

/** A listing draft as the chat's card shows it. */
export interface ListingDraft {
  /** The local game whose chat made it. */
  project: string;
  /** Its SKU id at genex.games: what Put on sale and the toggle act on. */
  itemId: string;
  name: string;
  description: string | null;
  type: ItemType;
  /** 0 is Free. */
  priceCoins: number;
  priceDisplayUsdCents: number;
  /** Its picture on a host the app loads images from, or null while it has none. */
  iconUrl: string | null;
  state: ItemState;
  /** "Other games can use it". */
  shareable: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Whether a document names itself a listing draft Studio reads: the CLI's kind and version, nothing else. */
export const isItemDraftDocument = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.kind === ITEM_DRAFT_KIND && value.version === ITEM_DRAFT_VERSION;

/** Text of at most `max` characters, or null. */
const textOf = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;

/** An https picture address, or null: the window's own policy decides which hosts it loads. */
function pictureOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The draft an `item_drafted` record carries, or null when anything the card needs is missing or is
 * not what it says. The host writes these records only, but old logs keep old shapes: every field
 * is read again here.
 */
export function listingDraftOf(payload: unknown): ListingDraft | null {
  if (!isRecord(payload)) return null;
  const { itemId, type, state, shareable, priceCoins, priceDisplayUsdCents } = payload;
  const project = textOf(payload.project, PROJECT_MAX);
  const name = textOf(payload.name, ITEM_NAME_MAX);
  const description = payload.description === null ? null : textOf(payload.description, ITEM_DESCRIPTION_MAX);
  const described = payload.description === null || description !== null;
  const priced = wholeIn(priceCoins, 0, PRICE_MAX) && wholeIn(priceDisplayUsdCents, 0, Number.MAX_SAFE_INTEGER);
  const known = isItemId(itemId) && isItemType(type) && isItemState(state) && typeof shareable === "boolean";
  if (!project || !name || !described || !priced || !known) return null;
  return {
    project,
    itemId,
    name,
    description,
    type,
    priceCoins,
    priceDisplayUsdCents,
    iconUrl: pictureOf(payload.iconUrl),
    state,
    shareable,
  };
}
