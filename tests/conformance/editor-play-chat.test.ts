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
import { TargetRuntime } from "../../src/shared/computer-target.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
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
    assert.match(String(computer?.description), /where the view is aimed/, "the mouse as a player has it");
    assert.doesNotMatch(String(computer?.description), /mouse_move coordinate/, "no point to put a pointer at");
    assert.match(text(looked), /Unreal Editor is not open/, "the plugin's own reason, through the real backend");

    // The plugin off: no editor computer, even on the linked game.
    await core.plugins.setEnabled(UNREAL_PLUGIN, false);
    whileRunning(async () => {});
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no engine plugin on: no editor computer");
  });
});

describe("the computer of a judge or playtester on an Unreal game", () => {
  it("plays its editor where the Unreal plugin holds the game's link, and a web game in its window", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    const outDir = await tmpDir("editor-play-judge-");
    const session = {
      loaded: null,
      handle: () => "pool:1",
      get: async () => assert.fail("no window"),
      release: async () => {},
    };
    const computer = (role: "judge" | "playtester") =>
      core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role },
        project.dir,
        outDir,
        session as never,
      );
    assert.notEqual((await computer("judge")).runtime, TargetRuntime.Editor, "a web game plays in its window");
    await core.plugins.setEnabled(UNREAL_PLUGIN, true);
    await core.engineLinks.link(
      UNREAL_PLUGIN,
      { project: game, directory: project.dir },
      { project: await uproject("Valley") },
    );
    try {
      for (const role of ["judge", "playtester"] as const) {
        const tools = await computer(role);
        assert.equal(tools.runtime, TargetRuntime.Editor, role);
        const looked = await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
        assert.match(text(looked), /Unreal Editor is not open/, `${role}: the plugin's own reason`);
        await tools.release();
      }
    } finally {
      // Turning the plugin off stops its backend's process.
      await core.plugins.setEnabled(UNREAL_PLUGIN, false);
    }
  });
});

/** A `.toyproj` of the game's own, as a linked toy project needs one on disk. */
async function toyProject(name: string): Promise<string> {
  const file = path.join(await realpath(await tmpDir("editor-play-toyproj-")), name, `${name}.toyproj`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "toy\n");
  return file;
}

describe("the computer on a game another engine plays in its editor", () => {
  it("is built from what the engine's plugin declares, and reaches each of the toy engine's three players", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    const outDir = await tmpDir("editor-play-toy-");
    const session = {
      loaded: null,
      handle: () => "pool:1",
      get: async () => assert.fail("no window"),
      release: async () => {},
    };
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    await core.engineLinks.link(
      TOY_PLUGIN_ID,
      { project: game, directory: project.dir },
      { project: await toyProject("Garden") },
    );
    try {
      const judge = await core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role: "judge" },
        project.dir,
        outDir,
        session as never,
      );
      assert.equal(judge.runtime, TargetRuntime.Editor);
      const judged = judge.liveTools.find((tool) => tool.name === COMPUTER_TOOL_NAME);
      assert.match(String(judged?.description), /clock cannot be held still/, "the toy declares no clock to hold");
      assert.equal(Object.hasOwn(judged?.parameters.properties ?? {}, "player"), false, "a judge asked for one player");
      await judge.release();

      const crowd = await core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role: "playtester", players: 3 },
        project.dir,
        outDir,
        session as never,
      );
      const tool = crowd.liveTools.find((t) => t.name === COMPUTER_TOOL_NAME);
      assert.match(String(tool?.description), /3 players/);
      for (const player of [1, 2, 3]) {
        const looked = await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot", player });
        assert.equal(typeof looked === "string" ? 0 : looked.images?.length, 1, `player ${player} is seen`);
        assert.match(
          text(await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "state" })),
          new RegExp(`"player":${player}`),
        );
      }
      assert.match(
        text(await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot", player: 4 })),
        /player 4 is not in this play/,
      );
      await crowd.release();
    } finally {
      await core.plugins.setEnabled(TOY_PLUGIN_ID, false);
    }
  });
});
