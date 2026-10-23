/**
 * The store's channels (marketplace plan 10.2): a game's Store and My items tabs, "Works in N
 * games", buying (main starts the purchase and draws Play's sheet for it, `play/store-sheet.ts`)
 * and its sheet's answers, claiming a Free item, the profile shelf, a complaint, and Create › Items
 * (Browse, adding a shared item to a game, Selling, Put on sale, Take off sale and Other games can
 * use it). Every id, game, reason and flag is checked here before the store client or the sheet hears
 * of it: the renderer is a browser, and genex.games' routes are built from these.
 */
import { isPlaySlug } from "../../shared/play.ts";
import { isPlayGameId } from "../../shared/play-manage.ts";
import { isAccountId } from "../../shared/play-people.ts";
import { type PlayPurchaseAnswer, readPurchaseAnswer } from "../../shared/play-purchase.ts";
import {
  BROWSE_QUERY_MAX,
  ITEM_REPORT_MESSAGE_MAX,
  ITEM_TAG_LENGTH_MAX,
  ITEM_TAGS_MAX,
  type ItemReportReason,
  isItemId,
  isItemReportReason,
} from "../../shared/store-items.ts";
import { isCursor } from "../play/gallery.ts";
import type { BrowseRequest, PlayStore } from "../play/store.ts";
import type { StoreSheetControl } from "../play/store-sheet.ts";
import type { IpcHandle } from "./registrar.ts";

/**
 * The longest Browse search and tag the renderer may send before they are cleaned (`store.ts` keeps
 * at most {@link BROWSE_QUERY_MAX} and {@link ITEM_TAG_LENGTH_MAX} of them): anything longer is no
 * search a person typed.
 */
const QUERY_SENT_MAX = 4 * BROWSE_QUERY_MAX;
const TAG_SENT_MAX = 4 * ITEM_TAG_LENGTH_MAX;

/** Why a store call from the renderer is refused: only a malformed call from our own renderer reads these. */
const MESSAGE = {
  badItem: "not an item on genex.games",
  badGame: "not a game address",
  badProject: "not a game on genex.games",
  badPerson: "not a Genex account",
  badReason: "not a reason an item is reported for",
  badMessage: "not a complaint's message",
  badSearch: "not a Browse search",
  badAnswer: "not an answer to the purchase sheet",
  badFlag: "not a yes or no",
} as const;

/** What the store's channels answer from. */
export interface StoreIpcDeps {
  /** The store client as the app's Genex account; a purchase starts only through `sheet`. */
  store: Omit<PlayStore, "purchase">;
  /** The purchase sheet in the studio window. */
  sheet: Pick<StoreSheetControl, "buy" | "answer">;
}

/** A field of a payload, or undefined when the payload is no object. */
const field = (payload: unknown, key: string): unknown =>
  typeof payload === "object" && payload !== null && Object.hasOwn(payload, key)
    ? Reflect.get(payload, key)
    : undefined;

function itemIdIn(payload: unknown): string {
  const itemId = field(payload, "itemId");
  if (!isItemId(itemId)) throw new Error(MESSAGE.badItem);
  return itemId;
}

function slugIn(payload: unknown): string {
  const slug = field(payload, "slug");
  if (!isPlaySlug(slug)) throw new Error(MESSAGE.badGame);
  return slug;
}

function projectIdIn(payload: unknown): string {
  const projectId = field(payload, "projectId");
  if (!isPlayGameId(projectId)) throw new Error(MESSAGE.badProject);
  return projectId;
}

/** A complaint's reason and message: a message is text no longer than genex.games takes, or none. */
function complaintIn(payload: unknown): { reason: ItemReportReason; message: string | null } {
  const reason = field(payload, "reason");
  const message = field(payload, "message") ?? null;
  if (!isItemReportReason(reason)) throw new Error(MESSAGE.badReason);
  const text = message === null || (typeof message === "string" && message.length <= ITEM_REPORT_MESSAGE_MAX);
  if (!text) throw new Error(MESSAGE.badMessage);
  return { reason, message };
}

/** A Browse page's search: words, a cursor genex.games handed out (or none), and at most ten tags. */
function browseIn(payload: unknown): BrowseRequest {
  const query = field(payload, "query");
  const cursor = field(payload, "cursor") ?? null;
  const tags = field(payload, "tags");
  const words = typeof query === "string" && query.length <= QUERY_SENT_MAX;
  const page = cursor === null || isCursor(cursor);
  const tagged =
    Array.isArray(tags) &&
    tags.length <= ITEM_TAGS_MAX &&
    tags.every((tag) => typeof tag === "string" && tag.length <= TAG_SENT_MAX);
  if (!words || !page || !tagged) throw new Error(MESSAGE.badSearch);
  return { query, cursor, tags };
}

function answerIn(payload: unknown): PlayPurchaseAnswer {
  const answer = readPurchaseAnswer(payload);
  if (!answer) throw new Error(MESSAGE.badAnswer);
  return answer;
}

/** Register the store's channels: a player's on a game's page and profile, a creator's in Create › Items. */
export function registerStoreIpc(handle: IpcHandle, deps: StoreIpcDeps): void {
  const { store, sheet } = deps;
  handle("studio:store.items", (payload) => store.items(slugIn(payload)));
  handle("studio:store.my-items", (payload) => store.myItems(slugIn(payload)));
  handle("studio:store.item-games", (payload) => store.itemGames(itemIdIn(payload)));
  // Main starts the purchase itself and shows its own sheet: the page names the item and the game, never a purchase.
  handle("studio:store.buy", (payload) => sheet.buy(itemIdIn(payload), slugIn(payload)));
  handle("studio:store.answer", async (payload) => sheet.answer(answerIn(payload)));
  handle("studio:store.claim", (payload) => store.claim(itemIdIn(payload), slugIn(payload)));
  handle("studio:store.shelf", (payload) => {
    const userId = field(payload, "userId");
    if (!isAccountId(userId)) throw new Error(MESSAGE.badPerson);
    return store.shelf(userId);
  });
  handle("studio:store.report", (payload) => {
    const { reason, message } = complaintIn(payload);
    return store.report(itemIdIn(payload), reason, message);
  });
  registerCreatorIpc(handle, store);
}

/** Create › Items: Browse, a shared item in one of the account's games, Selling and the author's actions. */
function registerCreatorIpc(handle: IpcHandle, store: StoreIpcDeps["store"]): void {
  handle("studio:items.browse", (payload) => store.browse(browseIn(payload)));
  handle("studio:items.detail", (payload) => store.browseDetail(itemIdIn(payload)));
  handle("studio:items.add", (payload) => store.addToGame(itemIdIn(payload), projectIdIn(payload)));
  handle("studio:items.remove", (payload) => store.removeFromGame(itemIdIn(payload), projectIdIn(payload)));
  handle("studio:items.selling", () => store.selling());
  // Only Studio's own button puts an item on sale: the agent never reaches this (D40, P11).
  handle("studio:items.put-on-sale", (payload) => store.putOnSale(itemIdIn(payload)));
  handle("studio:items.take-off-sale", (payload) => store.takeOffSale(itemIdIn(payload)));
  handle("studio:items.shared", (payload) => {
    const shared = field(payload, "shared");
    if (typeof shared !== "boolean") throw new Error(MESSAGE.badFlag);
    return store.setShared(itemIdIn(payload), shared);
  });
}
