/**
 * The items-store fixture (marketplace plan 10.3; screens 07–09): Create › Items over the fixture
 * store (`fixture-store.ts`, signed in with `STUDIO_FIXTURE_GENEX_ACCOUNT=1`). The fixture game is
 * the account's Snowball on Genex, as its Genex publish record says, so Browse's Add to and Selling's
 * New item reach its chat. That chat holds the ask, the agent's reply and the Listing draft card for
 * Frost Axe, the account's draft in the fixture store, recorded as Studio records a real
 * `genex shop add --json` result. Data only: nothing reaches genex.games or runs the CLI.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import type { ListingDraft } from "../../shared/item-draft.ts";
import { ItemState, ItemType } from "../../shared/store-items.ts";
import { isRecord, PlayRoute } from "../play/gallery.ts";
import type { StudioCore } from "../studio-core.ts";
import { fixturePlayRequest } from "./fixture-play.ts";
import { FixtureStoreItem } from "./fixture-store.ts";

/** The account's game on Genex the fixture game stands for. */
export const FIXTURE_ITEMS_GAME = "snowball";

/** What the person asked, and what the agent answered (screen 09). */
const ASK =
  "Add a Frost Axe to the store for 1,200 coin. Ice-blue head, freezes an enemy for a second on hit. Other games can use it too.";
const REPLY = "Done. The axe is in your store and freezes on hit. Try it in the preview, then put it on sale.";

/** The Frost Axe as the fixture store holds it: the account's draft, shared, with no picture Studio loads. */
const frostAxe = (project: string): ListingDraft => ({
  project,
  itemId: FixtureStoreItem.FrostAxe,
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  type: ItemType.Durable,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  iconUrl: null,
  state: ItemState.Draft,
  shareable: true,
});

/** Snowball's Genex project id in the fixture catalog. */
async function snowballId(): Promise<string> {
  const answer = await fixturePlayRequest(PlayRoute.world(FIXTURE_ITEMS_GAME), { method: "GET" });
  const game = isRecord(answer.body) ? answer.body.item : null;
  if (!isRecord(game) || typeof game.id !== "string") throw new Error("the fixture catalog has no Snowball");
  return game.id;
}

/** The fixture game made Snowball on Genex, and its chat's ask, reply and Listing draft card. */
export async function seedItemsStore(core: StudioCore, project: string, threadId: string): Promise<void> {
  const record = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", project, ".genex");
  await mkdir(record, { recursive: true, mode: 0o700 });
  const hosted = { id: await snowballId(), slug: FIXTURE_ITEMS_GAME, status: "published" };
  await writeFile(path.join(record, "project.json"), `${JSON.stringify(hosted)}\n`);
  await core.append(
    [
      { type: EventKind.Messages, messages: [{ role: "user", content: ASK }] },
      { type: EventKind.Messages, messages: [{ role: "assistant", content: REPLY }] },
      customEventData(CustomEvent.ItemDrafted, { ...frostAxe(project) }),
    ],
    threadId,
  );
}
