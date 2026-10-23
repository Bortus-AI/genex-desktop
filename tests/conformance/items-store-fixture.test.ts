/**
 * The `items-store` dev fixture: the fixture game stands for the account's Snowball on Genex (its
 * Genex publish record names Snowball's project, which the fixture store treats as the account's),
 * and its chat ends with the ask, the agent's reply and the Listing draft card for Frost Axe, through
 * a real core.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { FIXTURE_ITEMS_GAME, seedItemsStore } from "../../src/main/dev/fixture-items.ts";
import { FIXTURE_NAMES, FixtureName } from "../../src/main/dev/fixture-kit.ts";
import { FixtureStoreItem } from "../../src/main/dev/fixture-store.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { coreLite } from "../helpers/core-lite.ts";

it("is a named fixture", () => {
  assert.equal(FixtureName.ItemsStore, "items-store");
  assert.ok((FIXTURE_NAMES as readonly string[]).includes("items-store"));
});

it("makes the fixture game Snowball on Genex and ends its chat with Frost Axe's Listing draft card", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    const threadId = await core.threadForGame(project.name);
    await seedItemsStore(core, project.name, threadId);

    const record = path.join(
      core.pluginServices.root(GENEX_PLUGIN_ID),
      "publish",
      project.name,
      ".genex",
      "project.json",
    );
    const hosted = JSON.parse(await readFile(record, "utf8")) as { id: unknown; slug: unknown };
    assert.equal(hosted.slug, FIXTURE_ITEMS_GAME);
    assert.match(String(hosted.id), /^fx\d{4}$/, "Snowball's id in the fixture catalog");

    const entries = toEntries(await core.store.listEvents(threadId));
    const last = entries.at(-1);
    assert.equal(last?.kind, EntryKind.ListingDraft);
    assert.equal(last?.kind === EntryKind.ListingDraft ? last.draft.itemId : null, FixtureStoreItem.FrostAxe);
    assert.equal(entries.at(-2)?.kind, EntryKind.Assistant);
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});
