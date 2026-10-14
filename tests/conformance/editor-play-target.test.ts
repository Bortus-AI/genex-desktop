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
import {
  ENGINE_PLAY_VIEW,
  EnginePlayRefusal,
  EnginePlayTool,
  MouseButtonCode,
  playInputKeys,
} from "../../src/shared/engine-play.ts";
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
  const game = { heldW: 0, playing: false, paused: false, pausedAtInput: [] as boolean[] };
  const call = async (tool: EnginePlayTool, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    switch (tool) {
      case EnginePlayTool.Open:
        if (options.refuseOpen)
          return { refused: EnginePlayRefusal.Busy, message: "Unreal is playing a build for the Loop right now." };
        game.playing = true;
        return { ...ENGINE_PLAY_VIEW, joined: false };
      case EnginePlayTool.Input: {
        game.pausedAtInput.push(game.paused);
        const keys = playInputKeys(args.keys);
        if (keys.includes("KeyW")) game.heldW += Number(args.seconds);
        return { held: keys, gameSeconds: 1 };
      }
      case EnginePlayTool.Shot:
        return { png: PIXEL, ...ENGINE_PLAY_VIEW };
      case EnginePlayTool.State:
        return { pawn: "Hero_0", phase: game.heldW >= 2 ? "won" : "playing" };
      case EnginePlayTool.Pause:
        game.paused = Boolean(args.paused);
        return { paused: game.paused };
      case EnginePlayTool.Close:
        game.playing = false;
        game.paused = false;
        return { closed: true };
    }
  };
  const source = editorPlaySource({ call });
  const inputs = () => calls.filter(([tool]) => tool === EnginePlayTool.Input).map(([, args]) => args);
  return { source, calls, game, inputs };
}

describe("the computer on a game played in its engine's editor", () => {
  it("offers keys, the mouse as a player has it, waits, pictures and the player's state, never a point to click at", () => {
    const { source } = standInEngine();
    assert.deepEqual(computerActionsFor(source.caps), [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "scroll",
      "type",
      "key",
      "hold_key",
      "look",
      "screenshot",
      "wait",
      "state",
      "batch",
    ]);
    const tool = computerToolDefinition({ role: "builder", capabilities: source.caps, observeByDefault: false });
    assert.match(tool.description, /engine's editor/);
  });

  it("stands the game still between a judge's moves and runs it only while a move lasts; a builder's game runs on", async () => {
    const judged = standInEngine();
    const judge = computerSession(judged.source, "/game", {
      pacing: "stepped",
      frameDir: await tmpDir("editor-play-"),
    });
    await judge.run("computer", { action: "screenshot" });
    assert.equal(judged.game.paused, true, "still while the judge looks");
    await judge.run("computer", { action: "hold_key", text: "w", duration: 1 });
    assert.deepEqual(judged.game.pausedAtInput, [false], "running while the key is held");
    assert.equal(judged.game.paused, true, "still again after the move");
    const built = standInEngine();
    const builder = computerSession(built.source, "/game", {
      pacing: "running",
      frameDir: await tmpDir("editor-play-"),
    });
    await builder.run("computer", { action: "hold_key", text: "w", duration: 1 });
    assert.equal(
      built.calls.some(([tool]) => tool === EnginePlayTool.Pause),
      false,
      "a builder's game is never paused",
    );
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

  it("carries mouse-look, clicks and the wheel as one frame of the player's mouse, the buttons as keys", async () => {
    const { source, inputs } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "look", dx: 40, dy: -10 });
    await session.run("computer", { action: "left_click" });
    await session.run("computer", { action: "right_click" });
    await session.run("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 2 });
    assert.deepEqual(inputs(), [
      { keys: "", seconds: 0.05, dx: 40, dy: -10 },
      { keys: MouseButtonCode.Left, seconds: 0.1 },
      { keys: MouseButtonCode.Right, seconds: 0.1 },
      { keys: "", seconds: 0.05, wheel: -2 },
    ]);
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
