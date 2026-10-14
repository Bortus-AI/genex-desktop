/**
 * The `computer` tool on a game played in its engine's editor (`main/core/editor-play-target.ts`),
 * driven through the real computer session against a stand-in engine plugin's play tools: the tool
 * offers keys, not a pointer; each key verb becomes holds on the game's own time; play opens once
 * for the whole session and the play it started ends with it; and a goal
 * the studio reads in the player's state is studio-verified as on any other target.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computerSession } from "../../src/main/core/computer-session.ts";
import { editorPlaySource } from "../../src/main/core/editor-play-target.ts";
import { InputRoute } from "../../src/shared/computer-target.ts";
import { ENGINE_PLAY_VIEW, EnginePlayRefusal, EnginePlayTool, playInputKeys } from "../../src/shared/engine-play.ts";
import { computerActionsFor, computerToolDefinition } from "../../src/substrate/computer-tool.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const images = (result: LiveToolResult): number => (typeof result === "string" ? 0 : (result.images?.length ?? 0));
/** A 1×1 PNG, as an engine's play shot. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A stand-in engine plugin: its play tools, recorded, and a game whose player wins once W was held 2 s. */
function standInEngine(options: { refuseOpen?: boolean } = {}) {
  const calls: Array<[EnginePlayTool, Record<string, unknown>]> = [];
  const game = { heldW: 0, playing: false };
  const call = async (tool: EnginePlayTool, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    switch (tool) {
      case EnginePlayTool.Open:
        if (options.refuseOpen)
          return { refused: EnginePlayRefusal.Busy, message: "Unreal is playing a build for the Loop right now." };
        game.playing = true;
        return { ...ENGINE_PLAY_VIEW, joined: false };
      case EnginePlayTool.Input: {
        const keys = playInputKeys(args.keys);
        if (keys.includes("KeyW")) game.heldW += Number(args.seconds);
        return { held: keys, gameSeconds: 1 };
      }
      case EnginePlayTool.Shot:
        return { png: PIXEL, ...ENGINE_PLAY_VIEW };
      case EnginePlayTool.State:
        return { pawn: "Hero_0", phase: game.heldW >= 2 ? "won" : "playing" };
      case EnginePlayTool.Close:
        game.playing = false;
        return { closed: true };
    }
  };
  const source = editorPlaySource({ call });
  const inputs = () => calls.filter(([tool]) => tool === EnginePlayTool.Input).map(([, args]) => args);
  return { source, calls, game, inputs };
}

describe("the computer on a game played in its engine's editor", () => {
  it("offers keys, waits, pictures and the player's state, never a pointer the editor play cannot take", () => {
    const { source } = standInEngine();
    assert.deepEqual(computerActionsFor(source.caps), [
      "type",
      "key",
      "hold_key",
      "screenshot",
      "wait",
      "state",
      "batch",
    ]);
    const tool = computerToolDefinition({ role: "builder", capabilities: source.caps, observeByDefault: false });
    assert.match(tool.description, /engine's editor/);
  });

  it("carries each key verb as holds on the game's own time", async () => {
    const { source, inputs } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "key", text: "shift+w" });
    await session.run("computer", { action: "hold_key", text: "d", duration: 25 });
    await session.run("computer", { action: "type", text: "Hi" });
    assert.deepEqual(inputs(), [
      { keys: "ShiftLeft,KeyW", seconds: 0.1 },
      { keys: "KeyD", seconds: 10 },
      { keys: "KeyD", seconds: 10 },
      { keys: "KeyD", seconds: 5 },
      { keys: "ShiftLeft,KeyH", seconds: 0.1 },
      { keys: "KeyI", seconds: 0.1 },
    ]);
    assert.equal(session.trace().routes?.includes(InputRoute.Editor), true, "recorded as the editor's own input");
  });

  it("never names a cursor the editor play has none of", async () => {
    const { source } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const answers = [
      await session.run("computer", { action: "screenshot" }),
      await session.run("computer", { action: "hold_key", text: "w", duration: 1 }),
      await session.run("computer", { action: "batch", actions: [{ action: "key", text: "d" }] }),
    ];
    for (const answer of answers) assert.doesNotMatch(text(answer), /cursor/);
  });

  it("looks with the player's view, as a picture the model sees", async () => {
    const { source } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const looked = await session.run("computer", { action: "screenshot" });
    assert.equal(images(looked), 1);
    assert.match(text(looked), /1280×720/);
  });

  it("opens play once for the whole session, and ends the play it started when the session is let go", async () => {
    const { source, game, calls } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    await session.run("computer", { action: "key", text: "w" });
    await session.run("computer", { action: "screenshot" });
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Open).length, 1, "play opened once");
    await source.release();
    assert.equal(game.playing, false, "the play it started ended");
    await source.release();
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Close).length, 1, "closed once");
  });

  it("says the engine's reason when play cannot open, and has nothing to close", async () => {
    const { source, calls } = standInEngine({ refuseOpen: true });
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    assert.match(text(await session.run("computer", { action: "screenshot" })), /playing a build for the Loop/);
    await source.release();
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Close).length, 0);
  });

  it("verifies a goal it reads in the player's state, as on any target", async () => {
    const { source } = standInEngine();
    const reached: string[] = [];
    const session = computerSession(source, "/game", {
      pacing: "running",
      frameDir: await tmpDir("editor-play-"),
      quest: { id: "reach-the-end", until: { path: "phase", equals: "won" } },
      onReached: (trace) => reached.push(trace),
    });
    await session.run("computer", { action: "screenshot" });
    const held = text(await session.run("computer", { action: "hold_key", text: "w", duration: 2 }));
    assert.match(held, /GOAL REACHED \(studio-verified\): reach-the-end/);
    assert.equal(reached.length, 1);
  });
});
