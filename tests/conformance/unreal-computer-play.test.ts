/**
 * The Unreal plugin's play tools for the studio's `computer` tool (`plugins/unreal/computer-play.ts`),
 * against a stand-in editor that plays on a game clock of its own: a session starts play with the
 * background throttle off (or joins the play already running), holds keys in Unreal's names for game
 * seconds, takes the player's view, reads the player, and ends only a play it started, giving the
 * throttle back. While the editor queue still has a build to play, the editor is the queue's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { ENGINE_PLAY_VIEW, EnginePlayRefusal, EnginePlayTool } from "../../src/shared/engine-play.ts";
import { createComputerPlay, unrealKey } from "../../src/plugins/unreal/computer-play.ts";
import { createEditorQueue, LoopTool } from "../../src/plugins/unreal/editor-queue.ts";
import { playable, TEST, written } from "../helpers/unreal-editor-stand-in.ts";

const STORAGE = "/storage";
const CONTEXT: PluginContext = {
  project: "valley",
  directory: "/games/valley",
  signal: new AbortController().signal,
  callId: 1,
  // The play tools never ask the host anything.
  host: (async () => {
    throw new Error("the play tools never ask the host");
  }) as never,
};

/** The play tools over a stand-in editor that plays the game at `rate` game seconds per second. */
function playTools(options: { rate?: number } = {}) {
  const game = playable({ rate: options.rate ?? 1 });
  const queue = createEditorQueue(game.deps);
  const play = createComputerPlay({ queueDeps: () => game.deps, queue: () => queue, game: () => "valley" });
  const call = (tool: EnginePlayTool, args: Record<string, unknown> = {}) =>
    play.handlers[tool](args, CONTEXT, STORAGE);
  const tools = () => game.editor.calls.map(([tool]) => tool);
  return { ...game, queue, call, tools };
}

describe("the Unreal plugin's play tools for the computer", () => {
  it("starts play with the throttle off, and ends that play and gives the throttle back when it closes", async () => {
    const { call, editor, tools } = playTools();
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: false });
    assert.equal(editor.state.pie, true);
    assert.equal(editor.state.throttleAtPlay, false, "play ran unthrottled");
    // Looking again keeps the session: no second start, nothing owed twice.
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: true });
    assert.equal(tools().filter((tool) => tool === LoopTool.StartPlay).length, 1);
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: true });
    assert.equal(editor.state.pie, false, "the play it started ended");
    assert.deepEqual(written(editor.calls), [false, true], "the throttle went back as it was");
    assert.deepEqual(await call(EnginePlayTool.Close), { closed: false }, "nothing left to close");
  });

  it("joins a play the person started, and leaves it running when it closes", async () => {
    const { call, editor, tools } = playTools();
    editor.state.pie = true;
    assert.deepEqual(await call(EnginePlayTool.Open), { ...ENGINE_PLAY_VIEW, joined: true });
    await call(EnginePlayTool.Close);
    assert.equal(editor.state.pie, true, "the person's play goes on");
    assert.ok(!tools().includes(LoopTool.StartPlay) && !tools().includes(LoopTool.StopPlay));
  });

  it("holds keys together in Unreal's names for game seconds, however slowly the editor plays", async () => {
    const { call, editor, seconds } = playTools({ rate: 0.25 });
    await call(EnginePlayTool.Open);
    const before = seconds();
    const held = await call(EnginePlayTool.Input, { keys: "KeyW,ShiftLeft", seconds: 1.5 });
    assert.deepEqual(
      editor.calls.filter(([tool]) => tool === LoopTool.Hold).map(([, args]) => args),
      [
        { name: "W", x: 1, y: 0, seconds: 1.5 },
        { name: "LeftShift", x: 1, y: 0, seconds: 1.5 },
      ],
    );
    assert.ok(seconds() - before >= 1.5, "the call answered once 1.5 game seconds had passed");
    assert.deepEqual((held as { held: string[] }).held, ["W", "LeftShift"]);
  });

  it("refuses a key Unreal has no name for before holding anything, and any input once play has ended", async () => {
    const { call, editor } = playTools();
    await call(EnginePlayTool.Open);
    const unknown = await call(EnginePlayTool.Input, { keys: "KeyW,Fn", seconds: 1 });
    assert.equal((unknown as { refused: string }).refused, EnginePlayRefusal.UnknownKey);
    assert.equal(editor.calls.filter(([tool]) => tool === LoopTool.Hold).length, 0, "not even the known key");
    editor.state.pie = false;
    for (const tool of [EnginePlayTool.Input, EnginePlayTool.Shot, EnginePlayTool.State]) {
      const answer = await call(tool, { keys: "KeyW", seconds: 1 });
      assert.equal((answer as { refused: string }).refused, EnginePlayRefusal.NotPlaying, tool);
    }
  });

  it("takes the player's view as a PNG at the view's size, and reads the player", async () => {
    const { call, captures } = playTools();
    await call(EnginePlayTool.Open);
    const shot = (await call(EnginePlayTool.Shot)) as { png: string; width: number; height: number };
    assert.deepEqual([shot.width, shot.height], [ENGINE_PLAY_VIEW.width, ENGINE_PLAY_VIEW.height]);
    assert.match(captures[0]?.name ?? "", /^genex-computer-\d+$/);
    assert.equal(shot.png, `png:/p/Saved/Genex/captures/${captures[0]?.name}.png`);
    const state = (await call(EnginePlayTool.State)) as { pawn: string; gameSeconds: number };
    assert.equal(state.pawn, "OffroadCar_0");
  });

  it("leaves the editor to the queue while it has a build to play, and says why", async () => {
    const { call, queue, tools } = playTools();
    queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST });
    const before = tools().length;
    const answer = await call(EnginePlayTool.Open);
    assert.equal((answer as { refused: string }).refused, EnginePlayRefusal.Busy);
    assert.equal(tools().length, before, "nothing of the session reached the editor");
  });

  it("says when the game's editor is not open", async () => {
    const { call, editor } = playTools();
    editor.state.answering = false;
    assert.equal(((await call(EnginePlayTool.Open)) as { refused: string }).refused, EnginePlayRefusal.NoEditor);
  });

  it("names web key codes as Unreal does, and nothing it has no key for", () => {
    const table: Array<[string, string | null]> = [
      ["KeyW", "W"],
      ["Digit1", "One"],
      ["Space", "SpaceBar"],
      ["ArrowUp", "Up"],
      ["ShiftLeft", "LeftShift"],
      ["Enter", "Enter"],
      ["F5", "F5"],
      ["F13", null],
      ["Fn", null],
      ["keyw", null],
      ["", null],
    ];
    for (const [code, name] of table) assert.equal(unrealKey(code), name, code);
  });
});
