/**
 * The chat's own session on an Unreal game gets the `computer` tool on the game's editor play
 * (`main/core/editor-play-session.ts`), through the real core and the real Unreal plugin's backend:
 * only where the Unreal plugin is on and holds the game's engine link, never on a web game's chat
 * through this path. With no Unreal Editor open, its first look answers the plugin's own words.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { workerChat } from "../helpers/worker-chat.ts";

/** How long one case may take: a real lite core, the Unreal plugin's backend and their sessions. */
const CASE_TIMEOUT_MS = 90_000;
const UNREAL_PLUGIN = "unreal";

const text = (result: LiveToolResult | null): string =>
  result === null ? "" : typeof result === "string" ? result : result.text;
const offered = (request: DelegateRequest | undefined) =>
  (request?.liveTools ?? []).some((tool) => tool.name === COMPUTER_TOOL_NAME);

/** A `.uproject` of the game's own, as a linked Unreal project needs one on disk. */
async function uproject(name: string): Promise<string> {
  const file = path.join(await realpath(await tmpDir("editor-play-uproject-")), name, `${name}.uproject`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"FileVersion":3}\n');
  return file;
}

describe("the computer on an Unreal game's editor play, for the chat's own session", () => {
  it("is offered where the Unreal plugin is on and holds the game's link, and answers the plugin's words with no editor open", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project, seen, delegate, personSays, whileRunning } = await workerChat();
    // A web game's chat: no editor play, whatever plugins are on.
    await core.plugins.setEnabled(UNREAL_PLUGIN, true);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a web game's chat gets no editor computer");

    await core.engineLinks.link(
      UNREAL_PLUGIN,
      { project: game, directory: project.dir },
      { project: await uproject("Valley") },
    );
    let looked: LiveToolResult | null = null;
    whileRunning(async (request) => {
      if (offered(request)) looked = await request.onLiveTool!(COMPUTER_TOOL_NAME, { action: "screenshot" });
    });
    await delegate({ chatTurn: { messageId: await personSays() } });
    const request = seen.at(-1);
    assert.equal(offered(request), true, "the linked Unreal game's chat plays its editor");
    const computer = request?.liveTools?.find((tool) => tool.name === COMPUTER_TOOL_NAME);
    assert.match(String(computer?.description), /engine's editor/);
    assert.doesNotMatch(String(computer?.description), /left_click/, "no pointer verbs");
    assert.match(text(looked), /Unreal Editor is not open/, "the plugin's own reason, through the real backend");

    // The plugin off: no editor computer, even on the linked game.
    await core.plugins.setEnabled(UNREAL_PLUGIN, false);
    whileRunning(async () => {});
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no engine plugin on: no editor computer");
  });
});
