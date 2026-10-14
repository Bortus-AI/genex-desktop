/**
 * The Godot plugin against the real Godot on this Mac, in Genex's native-job sandbox: a new game
 * from each template checks clean, a broken script is named by file and line, a scene runs, the
 * stills are real PNGs and the class reference is the installed version's. Machine-dependent, so
 * skipped unless asked for: `STUDIO_GODOT_LIVE=1 node --test tests/conformance/godot-live.test.ts`
 * with Godot 4.3 or newer in Applications.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createGodotBackend, GodotTool } from "../../src/plugins/godot/backend.ts";
import { systemEditorEnv } from "../../src/plugins/godot/editor.ts";
import { systemGodotEnv } from "../../src/plugins/godot/find-godot.ts";
import { confinedRunner } from "../../src/plugins/godot/godot-run.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { ADDON, SCRIPTS, TEMPLATES } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_GODOT_LIVE === "1";
const PNG_SIGNATURE = "iVBORw0KGgo";
/** A first import and a first capture compile shaders: generous for a cold Mac. */
const LIVE_TIMEOUT_MS = 5 * 60 * 1000;

type Answer = Record<string, unknown>;

/** The real backend in a fresh game folder, its storage beside it. */
async function liveGame() {
  const root = await realpath(await tmpDir("studio-godot-live-"));
  const game = path.join(root, "game");
  const storage = path.join(root, "storage");
  await mkdir(game);
  await mkdir(storage);
  const backend = createGodotBackend({
    env: systemGodotEnv(),
    editor: systemEditorEnv(),
    run: confinedRunner(),
    scripts: SCRIPTS,
    templates: TEMPLATES,
    addon: ADDON,
  });
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    project: "live",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string) => {
      if (method === "storage.root") return storage;
      throw new Error(`unexpected host call ${method}`);
    }) as PluginContext["host"],
    ...more,
  });
  const call = async (name: string, args = {}, more = {}) =>
    (await backend.tool?.(name, args, context(more))) as Answer;
  return { game, project: path.join(game, "godot"), call };
}

describe("the Godot plugin on this Mac's Godot", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, () => {
  for (const template of ["3d", "2d"]) {
    it(`makes a ${template} game that checks clean and shows its hero camera`, async () => {
      const { call } = await liveGame();
      assert.equal((await call(GodotTool.EngineStatus)).ready, true);
      await call(GodotTool.NewGame, { template, name: "Live Probe" });
      const checked = await call(GodotTool.Check);
      assert.deepEqual(checked.errors, [], JSON.stringify(checked));
      assert.equal(checked.ok, true);
      const seen = await call(GodotTool.Screenshot);
      assert.deepEqual(seen.shots, ["HeroCamera"]);
      const [image] = seen.images as Array<{ mimeType: string; data: string }>;
      assert.ok(image?.data.startsWith(PNG_SIGNATURE));
    });
  }

  it("names a broken script by file and line, runs a scene, and notes it at a checkpoint", async () => {
    const { project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "3d", name: "Live Probe" });
    await writeFile(path.join(project, "broken.gd"), 'extends Node\nfunc _ready():\n\tvar x: int = "no"\n');
    const checked = await call(GodotTool.Check);
    assert.equal(checked.ok, false);
    assert.ok(
      (checked.errors as string[]).some((line) => line.startsWith("broken.gd:3:")),
      JSON.stringify(checked),
    );
    const note = await call(GodotTool.CheckpointCheck, {}, { hook: { on: HookEvent.CheckpointBefore } });
    assert.match(String(note.note), /broken\.gd:3/);
    const ran = await call(GodotTool.RunScene, { seconds: 1 });
    assert.deepEqual(ran.errors, []);
  });

  it("answers the installed version's API", async () => {
    const { call } = await liveGame();
    const api = String(await call(GodotTool.ClassReference, { query: "CharacterBody3D" }));
    assert.match(api, /^class CharacterBody3D extends PhysicsBody3D/);
    assert.match(api, /move_and_slide\(\) -> bool/);
  });
});
