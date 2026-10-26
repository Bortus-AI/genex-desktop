/**
 * What a build sells in its game's Genex store: each thing the user prices in Nex (Genex's
 * currency), named by the chat at the launch (`store_items`, tools/game-tools.ts) and listed by the
 * harness itself before the build starts (`listStoreItems`, chat-dispatch.ts `launchFromIntake`), so
 * each item's card is in the chat at once and no plan can cut it. Coins, gold or gems are a currency
 * the game keeps itself and never come here. The run's scope carries the listed items
 * (`storeScopeItems`), which scope-prompts.ts shows every agent that reads the goal.
 *
 * A new module, so a kept older sibling can never shadow these names.
 */
import { HostMethod } from "./host-methods.ts";
import { isPlainRecord } from "./json.ts";
import type { AnyRecord, Host } from "../types/harness.d.ts";

/** The most items one launch lists. */
export const STORE_ITEMS_MAX = 12;
/** The longest name one item keeps. */
const NAME_CHARS = 80;
/** The longest description one item keeps: what genex.games keeps. */
const DESCRIPTION_CHARS = 1000;
/** The longest reason an unlisted item keeps. */
const PROBLEM_CHARS = 160;
/** The price an item gets when the user named none: the store grid's first step. */
export const DEFAULT_ITEM_PRICE = 100;

/** The Genex tool that makes a store item's draft, asking nobody, and its command. */
export const GenexStoreCall = { Tool: "genex__cli", ShopAdd: "shop add" } as const;

/** One thing the user sells for Nex: its name, its price in whole Nex and what it is. */
export interface StoreItem {
  name: string;
  price: number;
  description?: string;
}

/** An item after its listing: its id in the store (a local draft's `local_…` or the store's), or why it has none. */
export interface ListedStoreItem extends StoreItem {
  id?: string;
  problem?: string;
}

const MESSAGE = {
  noAnswer: "the store answered nothing",
  notListed: (names: string, why: string) =>
    `These were not listed in the Genex store yet: ${names} (${why}). The build lists them with genex__cli shop add.`,
} as const;

/** One line of text, its whitespace folded, clipped to `max`; '' for anything else. */
function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A price in whole Nex as a model sends it (a number or its digits); the default for anything else. */
function priceOf(value: unknown): number {
  const price = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof price === "number" && Number.isInteger(price) && price >= 0 ? price : DEFAULT_ITEM_PRICE;
}

/** One item a launch named, or null when it has no name. */
function storeItemOf(entry: unknown): StoreItem | null {
  if (!isPlainRecord(entry)) return null;
  const name = oneLine(entry.name, NAME_CHARS);
  if (!name) return null;
  const description = oneLine(entry.description, DESCRIPTION_CHARS);
  return { name, price: priceOf(entry.price), ...(description ? { description } : {}) };
}

/** The list a model sent: an array, or that array as JSON text (an engine that sends every field as a string). */
function listOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A launch's `store_items`: each named item once (names compared without case), at most `STORE_ITEMS_MAX`. */
export function storeItemsOf(value: unknown): StoreItem[] {
  const list = listOf(value);
  if (!Array.isArray(list)) return [];
  const items: StoreItem[] = [];
  for (const entry of list) {
    const item = storeItemOf(entry);
    const named = item && items.some((kept) => kept.name.toLowerCase() === item.name.toLowerCase());
    if (item && !named) items.push(item);
  }
  return items.slice(0, STORE_ITEMS_MAX);
}

/** The id a `shop add` answer names: a local draft's, or the store's; '' when it made none. */
function listedId(answer: unknown): string {
  if (!isPlainRecord(answer) || answer.ok !== true || !isPlainRecord(answer.output)) return "";
  const { localId, id } = answer.output;
  if (typeof localId === "string" && localId) return localId;
  return typeof id === "string" ? id : "";
}

/** Why an answer made no item, in the words it gave. */
function problemOf(answer: unknown): string {
  const output = isPlainRecord(answer) ? answer.output : answer;
  return oneLine(typeof output === "string" ? output : "", PROBLEM_CHARS) || MESSAGE.noAnswer;
}

/** The text of a thrown error, as one clipped line. */
const errorText = (error: unknown): string =>
  oneLine(error instanceof Error ? error.message : String(error), PROBLEM_CHARS) || MESSAGE.noAnswer;

/** One item listed as the chat's own `genex__cli shop add`, whose card the host draws in `threadId`. */
async function listOne(
  host: Pick<Host, "call">,
  binding: { project: string; threadId: string },
  item: StoreItem,
): Promise<ListedStoreItem> {
  const options: AnyRecord = { price: item.price, ...(item.description ? { description: item.description } : {}) };
  const args = { command: GenexStoreCall.ShopAdd, args: item.name, options };
  try {
    const answer = await host.call(HostMethod.PluginsInvoke, { ...binding, name: GenexStoreCall.Tool, args });
    const id = listedId(answer);
    return id ? { ...item, id } : { ...item, problem: problemOf(answer) };
  } catch (error) {
    return { ...item, problem: errorText(error) };
  }
}

/**
 * Lists each item in the game's Genex store, one after another (each `shop add` writes the game's
 * local drafts): an item that could not be listed keeps why, and the build lists it later. Never throws.
 */
export async function listStoreItems(
  host: Pick<Host, "call">,
  binding: { project: string; threadId: string },
  items: readonly StoreItem[],
): Promise<ListedStoreItem[]> {
  const listed: ListedStoreItem[] = [];
  for (const item of items) listed.push(await listOne(host, binding, item));
  return listed;
}

/** The listed items as the run's scope keeps them: one line each, with its id or why it has none. */
export function storeScopeItems(items: readonly ListedStoreItem[]): string[] {
  return items.map((item) => {
    const sold = `${item.name} for ${item.price} Nex`;
    return item.id ? `${sold} (listed: ${item.id})` : `${sold} (not listed yet: ${item.problem ?? MESSAGE.noAnswer})`;
  });
}

/** What the chat is told when some items could not be listed; '' when every one was. */
export function notListedWords(items: readonly ListedStoreItem[]): string {
  const unlisted = items.filter((item) => !item.id);
  if (!unlisted.length) return "";
  return MESSAGE.notListed(unlisted.map((item) => item.name).join(", "), unlisted[0]?.problem ?? MESSAGE.noAnswer);
}
