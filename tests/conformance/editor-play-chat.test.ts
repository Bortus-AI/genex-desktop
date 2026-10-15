/**
 * The chat's own session, judges and playtesters get `computer` on an Unreal or Unity game's editor
 * play (`main/core/editor-play-session.ts`), through the real core and each plugin's backend. Unreal
 * is selected by its engine link; Unity by the project's facts. With no editor open, the first look
 * answers the selected plugin's own words. Disabling the plugin removes the editor computer.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TargetRuntime } from "../../src/shared/computer-target.ts";
import { HarnessCapability } from "../../src/shared/protocol.ts";
import type { SessionPort } from "../../src/main/core/session-port.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { closeWorkerChats, workerChat } from "../helpers/worker-chat.ts";

/** How long one case may take: a real lite core, the Unreal plugin's backend and their sessions. */
const CASE_TIMEOUT_MS = 90_000;
const UNREAL_PLUGIN = "unreal";
const UNITY_PLUGIN = "unity";

after(closeWorkerChats);

const text = (result: LiveToolResult | null): string => {
  if (result === null) return "";
  return typeof result === "string" ? result : result.text;
};
const offered = (request: DelegateRequest | undefined, name = COMPUTER_TOOL_NAME) =>
  (request?.liveTools ?? []).some((tool) => tool.name === name);

/** A Unity project in the game, without an editor open or any connection to a real editor. */
async function unityProject(directory: string): Promise<string> {
  const root = path.join(directory, "unity");
  const settings = path.join(root, "ProjectSettings");
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, "ProjectVersion.txt"), "m_EditorVersion: 6000.6.0f1\n");
  return root;
}

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
      if (!offered(request)) return;
      assert.ok(request.onLiveTool);
      looked = await request.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
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

describe("the computer on a Unity game's editor play", () => {
  it("offers the chat's computer and judge_play only while Unity is enabled and the game holds its project", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, seen, delegate, personSays, whileRunning } = await workerChat();
    core.host.hasCapability = (capability) => capability === HarnessCapability.ChatJudge;
    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no Unity project: no editor computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);

    const root = await unityProject(project.dir);
    let looked: LiveToolResult | null = null;
    whileRunning(async (request) => {
      if (!offered(request)) return;
      assert.ok(request.onLiveTool);
      looked = await request.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
    });
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), true, "the project's facts select Unity's editor play");
    assert.equal(offered(seen.at(-1), "judge_play"), true, "the editor computer enables the chat's judge");
    assert.match(text(looked), /Unity.*not open/i, "the real Unity backend explains why it cannot play");

    whileRunning(async () => {});
    await core.plugins.setEnabled(UNITY_PLUGIN, false);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a disabled plugin offers no computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);

    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    await rename(path.join(root, "ProjectSettings", "ProjectVersion.txt"), path.join(root, "version.txt"));
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a removed Unity project no longer offers the computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);
    await core.plugins.setEnabled(UNITY_PLUGIN, false);
  });

  it("gives judges and playtesters the Unity editor target through the real backend", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    await unityProject(project.dir);
    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    const outDir = await tmpDir("unity-editor-play-judge-");
    const session: SessionPort = {
      loaded: null,
      handle: () => "pool:unity",
      get: async () => assert.fail("Unity play must not open a browser window"),
      release: async () => {},
    };
    try {
      for (const role of ["judge", "playtester"] as const) {
        const tools = await core._computerToolsFor(
          { project: game, root: project.dir, handle: "pool:unity", role },
          project.dir,
          outDir,
          session,
        );
        try {
          assert.equal(tools.runtime, TargetRuntime.Editor, role);
          const looked = await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
          assert.match(text(looked), /Unity.*not open/i, `${role}: the real Unity backend's refusal`);
        } finally {
          await tools.release();
        }
      }
    } finally {
      await core.plugins.setEnabled(UNITY_PLUGIN, false);
    }
  });
});
