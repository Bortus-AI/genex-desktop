/**
 * A chat message's checkpoint (`main/core/rewind.ts`) runs the `checkpoint.before` steps that ask
 * for it (`messages: true`) before it saves the game folder, so a Rewind brings back the engine's
 * state as it was, not an older export. Only those steps run, never a `checkpoint.after` step, and
 * only within the message's own wait: a step that is late, held by Plan mode or by a lock is
 * skipped and logged, and the files are saved whatever the steps answered.
 *
 * A real core (`coreLite`) with the toy engine plugin, whose `save-scenes` asks to run for each
 * message, and the hook test plugin `hk`, whose checkpoint steps do not ask.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { CheckpointPhase, chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { CHAT_CHECKPOINT_WAIT_MS } from "../../src/main/core/rewind.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { type PluginBinding, PluginSourceKind } from "../../src/shared/plugins.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { HOOK_PLUGIN, type HookPackage, hookPackage } from "../helpers/hook-plugin.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;
type ToolCall = CoreLite["core"]["plugins"]["tool"];

/** How long a case waits for a checkpoint taken beside the queue (the after one) before failing. */
const REF_WAIT_MS = 20_000;
const REF_POLL_MS = 50;
const SAVE_SCENES = `${TOY_PLUGIN_ID}__save-scenes`;
const CAPTURE = `${TOY_PLUGIN_ID}__capture`;

/** One plugin step Genex called: its tool, the moment, and whether the message's checkpoint stood yet. */
interface Called {
  name: string;
  on: string | undefined;
  checkpointStood: boolean;
}

describe("a chat message's checkpoint and the engine's steps that save first", () => {
  let lite: CoreLite;
  let api: Api;
  let hk: HookPackage;
  /** What the core logged. */
  const logged: string[] = [];
  /** Every plugin step called, in order. */
  const called: Called[] = [];
  /** Every shared limit a moment asked for; the test may end one at once, as its time running out. */
  const limits: Array<{ ms: number; end: () => void }> = [];
  /** How far the steps' clock runs ahead of the wall clock: a message's wait already spent. */
  let spent = 0;
  /** A save-scenes that never answers until its call is cut, when set. */
  let hangs = false;
  /** The checkpoint the next step is checked against. */
  let watching: { dir: string; ref: string } | null = null;
  let messages = 0;

  const call = (method: string, params: unknown) => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(params);
  };
  const refOf = (dir: string, ref: string) =>
    git(dir, ["rev-parse", "--verify", "-q", ref]).then(
      (out) => out.trim(),
      () => "",
    );

  /** A game chat on a fresh game; `make` adds the game's own files before it is opened. */
  async function chatOn(name: string, make?: (dir: string) => Promise<void>) {
    const { core } = lite;
    const dir = (await core.games.scaffold(name)).dir;
    await make?.(dir);
    return { dir, threadId: await core.threadForGame(name) };
  }

  /**
   * The queue starts answering one message, and its answer begins (which waits for the checkpoint);
   * then the message is handled and the after checkpoint lands. Answers the message's id.
   */
  async function sendMessage(chat: { dir: string; threadId: string }): Promise<string> {
    messages += 1;
    const messageId = `msg_steps_${messages}`;
    watching = { dir: chat.dir, ref: chatCheckpointRef(chat.threadId, messageId) };
    const record = (type: string) => ({ type: "custom", event_type: type, payload: { messageId } });
    await call(HostMethod.EventsAppend, {
      threadId: chat.threadId,
      batch: [record(CustomEvent.CoordinatorMessageProcessing)],
    });
    const { turnId } = (await call(HostMethod.TurnBegin, { threadId: chat.threadId })) as { turnId: string };
    assert.ok(await refOf(chat.dir, watching.ref), "the folder before the answer was saved once its turn began");
    called.push({ name: "<answer>", on: undefined, checkpointStood: true });
    await call(HostMethod.TurnEnd, { turnId });
    await call(HostMethod.EventsAppend, {
      threadId: chat.threadId,
      batch: [record(CustomEvent.CoordinatorMessageHandled)],
    });
    const afterRef = chatCheckpointRef(chat.threadId, messageId, CheckpointPhase.After);
    for (const ends = Date.now() + REF_WAIT_MS; !(await refOf(chat.dir, afterRef)); ) {
      assert.ok(Date.now() < ends, "the folder after the answer was saved");
      await pause(REF_POLL_MS);
    }
    return messageId;
  }

  /** The steps called since `from`, as `<moment> <tool>`, with the answer's begin among them. */
  const trail = (from: number) => called.slice(from).map((c) => (c.on ? `${c.on} ${c.name}` : c.name));

  before(async () => {
    lite = await coreLite({
      onLog: (line: string) => {
        logged.push(line);
      },
      hooks: {
        now: () => Date.now() + spent,
        timeout: (ms: number) => {
          const ended = new AbortController();
          limits.push({ ms, end: () => ended.abort(new Error("the message's wait ran out")) });
          return AbortSignal.any([ended.signal, AbortSignal.timeout(ms)]);
        },
      },
    });
    const { core } = lite;
    api = lite.api() as unknown as Api;
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    hk = await hookPackage();
    await core.plugins.installLocal(hk.dir, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(HOOK_PLUGIN, true);
    const real = core.plugins.tool.bind(core.plugins);
    core.plugins.tool = (async (name, args, binding: PluginBinding, signal, ...rest) => {
      const stood = watching ? Boolean(await refOf(watching.dir, watching.ref)) : false;
      called.push({ name, on: binding.hook?.on, checkpointStood: stood });
      if (name === SAVE_SCENES && hangs) {
        // Cut already (its limit ended while this step was being called), or once it is.
        await new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      }
      return real(name, args, binding, signal, ...rest);
    }) as ToolCall;
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("runs the toy's save-scenes once before the folder is saved, and no step after it or after the answer", async () => {
    const projects = await realpath(await tmpDir("message-steps-toyproj-"));
    const file = path.join(projects, "Garden", "Garden.toyproj");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "toy\n");
    const chat = await chatOn("garden");
    await lite.core.engineLinks.link(TOY_PLUGIN_ID, { project: "garden", directory: chat.dir }, { project: file });
    const from = called.length;
    await sendMessage(chat);
    assert.deepEqual(trail(from), [`${HookEvent.CheckpointBefore} ${SAVE_SCENES}`, "<answer>"]);
    assert.equal(called[from]?.checkpointStood, false, "save-scenes ran before the snapshot");
    assert.ok(!called.some((c) => c.name === CAPTURE), "a checkpoint.after step never runs for a message");
    assert.ok(limits.at(-1)!.ms <= CHAT_CHECKPOINT_WAIT_MS, "the step runs within the message's wait");
  });

  it("runs none of a plugin's checkpoint steps that do not ask for each message", async () => {
    const chat = await chatOn("desk", (dir) => writeFile(path.join(dir, "Desk.hkproj"), "{}\n"));
    await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, false);
    try {
      const from = called.length;
      await sendMessage(chat);
      assert.deepEqual(trail(from), ["<answer>"], "the hk plugin hooks checkpoint.before, not for each message");
      assert.deepEqual(await hk.trail(), []);
    } finally {
      await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    }
  });

  it("cuts a step slower than the message's wait, logs it, and still saves the folder", async () => {
    const chat = await chatOn("slow-garden");
    const from = called.length;
    const asked = limits.length;
    hangs = true;
    try {
      const sent = sendMessage(chat);
      for (const ends = Date.now() + REF_WAIT_MS; limits.length === asked; await pause(REF_POLL_MS))
        assert.ok(Date.now() < ends, "the step's limit was asked for");
      const limit = limits.at(-1)!;
      assert.ok(
        limit.ms > 0 && limit.ms <= CHAT_CHECKPOINT_WAIT_MS,
        `the limit is what is left of the wait: ${limit.ms}`,
      );
      limit.end();
      await sent;
    } finally {
      hangs = false;
    }
    assert.deepEqual(trail(from), [`${HookEvent.CheckpointBefore} ${SAVE_SCENES}`, "<answer>"]);
    assert.ok(
      logged.some((line) => line.includes("slow-garden") && line.includes("didn't answer in time")),
      logged.join("\n"),
    );
  });

  it("runs no step when the message's wait is already spent, logs it, and still saves the folder", async () => {
    const chat = await chatOn("late-garden");
    const from = called.length;
    spent = CHAT_CHECKPOINT_WAIT_MS;
    try {
      await sendMessage(chat);
    } finally {
      spent = 0;
    }
    assert.deepEqual(trail(from), ["<answer>"]);
    assert.ok(
      logged.some((line) => line.includes("late-garden") && /skipped/.test(line)),
      logged.join("\n"),
    );
  });

  it("in Plan mode runs no step, logs it, and still saves the folder", async () => {
    const chat = await chatOn("plan-garden");
    await lite.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const from = called.length;
    await sendMessage(chat);
    assert.deepEqual(trail(from), ["<answer>"]);
    assert.ok(
      logged.some((line) => line.includes("plan-garden") && /Plan mode/.test(line)),
      logged.join("\n"),
    );
  });
});
