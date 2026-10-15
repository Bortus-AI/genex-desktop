import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHelperLink, type ScriptChangeAt } from "../../src/plugins/roblox/helper-link.ts";
import {
  createHelperInbox,
  HELPER_PROTOCOL,
  HelperMessage,
  HelperRefusal,
  isScriptPath,
  MAX_HELPER_FRAME_BYTES,
  MAX_SCRIPT_SOURCE_BYTES,
  type PendingType,
} from "../../src/plugins/roblox/helper-protocol.ts";
import { BINDING_FILE } from "../../src/plugins/roblox/studio-binding.ts";
import { fakeStudio, manualClock, memoryHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOTHING_PENDING: PendingType = () => undefined;
const frame = (id: number, type: string, body: unknown) => JSON.stringify({ v: HELPER_PROTOCOL, id, type, body });
const changed = (id: number, scriptPath: unknown, source: unknown = "print(1)") =>
  frame(id, HelperMessage.ScriptsChanged, { path: scriptPath, source });

test("a hello, a script change and an answer to a pending request are read with every field typed", () => {
  const inbox = createHelperInbox();
  const hello = inbox.read(
    frame(1, HelperMessage.Hello, { helper: 1, place: { id: "0", name: "Place1" } }),
    NOTHING_PENDING,
  );
  assert.deepEqual(hello, {
    ok: true,
    message: {
      kind: "event",
      id: 1,
      event: { type: "hello", body: { helper: 1, place: { id: "0", name: "Place1" } } },
    },
  });
  const change = inbox.read(changed(2, "ServerScriptService/Main.server.luau"), NOTHING_PENDING);
  assert.ok(change.ok && change.message.kind === "event");
  assert.deepEqual(change.message.event.body, { path: "ServerScriptService/Main.server.luau", source: "print(1)" });
  const removed = inbox.read(changed(3, "ReplicatedStorage/Shared.luau", null), NOTHING_PENDING);
  assert.ok(removed.ok);
  const pending: PendingType = (re) => (re === 7 ? HelperMessage.ScriptsList : undefined);
  const answer = JSON.stringify({
    v: HELPER_PROTOCOL,
    id: 4,
    type: "answer",
    re: 7,
    ok: true,
    result: { scripts: [{ path: "ServerScriptService/Main.server.luau", hash: "abc123" }] },
  });
  assert.deepEqual(inbox.read(answer, pending), {
    ok: true,
    message: {
      kind: "answer",
      id: 4,
      re: 7,
      answer: {
        ok: true,
        type: "scripts.list",
        result: { scripts: [{ path: "ServerScriptService/Main.server.luau", hash: "abc123" }] },
      },
    },
  });
});

const PATH_ROWS: Array<{ name: string; path: unknown }> = [
  { name: "a parent step", path: "../outside.server.luau" },
  { name: "a parent step inside", path: "ServerScriptService/../../x.luau" },
  { name: "an absolute path", path: "/etc/passwd.luau" },
  { name: "a Windows drive", path: "C:/Windows/x.luau" },
  { name: "a backslash", path: "ServerScriptService\\Main.luau" },
  { name: "a NUL", path: "Main\u0000.luau" },
  { name: "a control character", path: "Main\n.luau" },
  { name: "an empty segment", path: "ServerScriptService//Main.luau" },
  { name: "a dot segment", path: "./Main.luau" },
  { name: "not a script", path: "ServerScriptService/Main.lua" },
  { name: "only the ending", path: ".luau" },
  { name: "too long", path: `${"a/".repeat(600)}x.luau` },
  { name: "not text", path: 42 },
];

test("a script path that could leave src/ is refused by the reader", () => {
  for (const row of PATH_ROWS) {
    assert.equal(isScriptPath(row.path), false, row.name);
    const read = createHelperInbox().read(changed(1, row.path), NOTHING_PENDING);
    assert.deepEqual(read, { ok: false, refusal: HelperRefusal.BadPath }, row.name);
  }
});

const ROWS: Array<{ name: string; texts: string[]; refusal: HelperRefusal; pending?: PendingType }> = [
  { name: "malformed JSON", texts: ["{not json"], refusal: HelperRefusal.Malformed },
  { name: "a JSON array", texts: ["[1,2]"], refusal: HelperRefusal.Malformed },
  {
    name: "another protocol",
    texts: [JSON.stringify({ v: 99, id: 1, type: "activity", body: { editing: true } })],
    refusal: HelperRefusal.Version,
  },
  { name: "an unknown type", texts: [frame(1, "scripts.delete-everything", {})], refusal: HelperRefusal.UnknownType },
  {
    name: "a request type only the backend sends",
    texts: [frame(1, HelperMessage.ScriptsWrite, { path: "a.luau", source: "" })],
    refusal: HelperRefusal.UnknownType,
  },
  {
    name: "a missing id",
    texts: [JSON.stringify({ v: 1, type: "activity", body: { editing: true } })],
    refusal: HelperRefusal.BadId,
  },
  {
    name: "a fractional id",
    texts: [frame(1.5, HelperMessage.Activity, { editing: true })],
    refusal: HelperRefusal.BadId,
  },
  {
    name: "a repeated id",
    texts: [frame(5, HelperMessage.Activity, { editing: true }), changed(5, "ServerScriptService/Main.server.luau")],
    refusal: HelperRefusal.RepeatedId,
  },
  {
    name: "an older id",
    texts: [frame(5, HelperMessage.Activity, { editing: true }), changed(4, "ServerScriptService/Main.server.luau")],
    refusal: HelperRefusal.RepeatedId,
  },
  {
    name: "an answer to nothing asked",
    texts: [JSON.stringify({ v: 1, id: 1, type: "answer", re: 99, ok: true, result: {} })],
    refusal: HelperRefusal.UnknownAnswer,
  },
  {
    name: "a chunk of no export",
    texts: [frame(1, HelperMessage.DataChunk, { transfer: 3, index: 0, count: 1, data: "AAAA" })],
    refusal: HelperRefusal.UnknownAnswer,
  },
  {
    name: "an answer of the wrong shape",
    texts: [JSON.stringify({ v: 1, id: 1, type: "answer", re: 7, ok: true, result: { scripts: "all" } })],
    refusal: HelperRefusal.BadField,
    pending: (re) => (re === 7 ? HelperMessage.ScriptsList : undefined),
  },
  {
    name: "an extra field",
    texts: [frame(1, HelperMessage.ScriptsChanged, { path: "a.luau", source: "", write: "/etc/hosts" })],
    refusal: HelperRefusal.BadField,
  },
  {
    name: "a missing source",
    texts: [frame(1, HelperMessage.ScriptsChanged, { path: "a.luau" })],
    refusal: HelperRefusal.BadField,
  },
  {
    name: "an oversize source",
    texts: [changed(1, "ServerScriptService/Big.server.luau", "x".repeat(MAX_SCRIPT_SOURCE_BYTES + 1))],
    refusal: HelperRefusal.Oversize,
  },
  { name: "an oversize message", texts: [" ".repeat(MAX_HELPER_FRAME_BYTES + 1)], refusal: HelperRefusal.Oversize },
  ...PATH_ROWS.map((row) => ({
    name: `a script path with ${row.name}`,
    texts: [changed(1, row.path)],
    refusal: HelperRefusal.BadPath,
  })),
];

test("hostile messages are refused by the reader, each for its own reason", () => {
  for (const row of ROWS) {
    const inbox = createHelperInbox();
    const reads = row.texts.map((text) => inbox.read(text, row.pending ?? NOTHING_PENDING));
    assert.deepEqual(reads.at(-1), { ok: false, refusal: row.refusal }, row.name);
  }
});

const PLACE1 = { id: "studio-1", name: "Place1" };

/** A game linked to Place1, its helper bound, with a sink that writes what Studio changed. */
async function boundGame() {
  const root = await realpath(await tmpDir("roblox-helper-protocol-"));
  const storage = path.join(root, "storage");
  const game = path.join(root, "games", "game-1");
  const outside = path.join(root, "outside");
  await mkdir(path.join(storage, "links"), { recursive: true });
  await mkdir(path.join(game, "src", "ServerScriptService"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(game, "Place1.rbxl"), "<roblox/>");
  await writeFile(path.join(outside, "victim.luau"), "untouched");
  const link = { kind: "roblox", project: path.join(game, "Place1.rbxl"), linkedAt: "2026-10-15T12:00:00.000Z" };
  await writeFile(path.join(storage, "links", "game-1.json"), JSON.stringify(link));
  const studio = fakeStudio([PLACE1]);
  const written: ScriptChangeAt[] = [];
  const helperLink = createHelperLink({
    storage,
    studio: studio.client,
    clock: manualClock(),
    newSession: () => "session-1",
    scriptsRoot: async () => game,
    sinks: {
      scriptsChanged: async (_game, change) => {
        written.push(change);
        await writeFile(change.target, change.source ?? "");
      },
    },
  });
  const helper = memoryHelper(helperLink, { studio, studioId: PLACE1.id });
  helper.hello();
  await helperLink.idle();
  assert.equal(helperLink.bound("game-1"), PLACE1.id);
  await readFile(path.join(storage, "mcp", "game-1", BINDING_FILE));
  return { root, game, outside, studio, written, helper, helperLink };
}

/** Every file under `dir` with its contents, links not followed. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full);
    if (entry.isSymbolicLink()) out[key] = "<link>";
    else if (entry.isFile()) out[key] = await readFile(full, "utf8");
    else out[key] = "<dir>";
  }
  return out;
}

/** Makes a link, or says why this system can't (Windows without the right to make them). */
async function linkOrSkip(target: string, at: string, type: "file" | "dir"): Promise<string | undefined> {
  try {
    await symlink(target, at, type === "dir" ? "junction" : "file");
    return undefined;
  } catch (error) {
    return `links can't be made here: ${(error as NodeJS.ErrnoException).code}`;
  }
}

test("hostile messages from a bound helper write no file and call nothing in Studio", async () => {
  const world = await boundGame();
  const before = await tree(world.root);
  const callsBefore = world.studio.calls.length;
  const rows: Array<{ name: string; text: (id: number) => string }> = [
    { name: "malformed JSON", text: () => "{not json" },
    { name: "an unknown type", text: (id) => frame(id, "scripts.wipe", { path: "x.luau" }) },
    {
      name: "an answer to nothing asked",
      text: (id) => JSON.stringify({ v: 1, id, type: "answer", re: 999, ok: true, result: {} }),
    },
    {
      name: "an oversize source",
      text: (id) => changed(id, "ServerScriptService/Big.server.luau", "x".repeat(MAX_SCRIPT_SOURCE_BYTES + 1)),
    },
    ...PATH_ROWS.map((row) => ({
      name: `a path with ${row.name}`,
      text: (id: number) => changed(id, row.path, "pwned"),
    })),
  ];
  for (const row of rows) {
    world.helper.raw(row.text(world.helper.nextId()));
    world.helper.skipTo(world.helper.nextId());
    await world.helperLink.idle();
    assert.deepEqual(world.written, [], row.name);
  }
  // A repeated id: the same message twice, the second refused.
  const id = world.helper.nextId();
  world.helper.raw(changed(id, "ServerScriptService/Once.server.luau", "once"));
  world.helper.raw(changed(id, "ServerScriptService/Once.server.luau", "twice"));
  await world.helperLink.idle();
  assert.equal(world.written.length, 1, "only the first of two messages with one id is taken");
  assert.equal(await readFile(path.join(world.game, "src", "ServerScriptService", "Once.server.luau"), "utf8"), "once");
  const after = await tree(world.root);
  delete after[path.join("games", "game-1", "src", "ServerScriptService", "Once.server.luau")];
  // The binding file is refreshed by time, and no time passed.
  assert.deepEqual(after, before);
  assert.equal(world.studio.calls.length, callsBefore, "no call reached Studio");
  world.helperLink.close();
});

test("a script path through a link, or onto one, writes nothing anywhere", async (t) => {
  const world = await boundGame();
  const fileLink = path.join(world.game, "src", "ServerScriptService", "Evil.server.luau");
  const folderLink = path.join(world.game, "src", "Linked");
  const skipped =
    (await linkOrSkip(path.join(world.outside, "victim.luau"), fileLink, "file")) ??
    (await linkOrSkip(world.outside, folderLink, "dir"));
  if (skipped) return t.skip(skipped);
  const before = await tree(world.root);
  world.helper.say(HelperMessage.ScriptsChanged, { path: "ServerScriptService/Evil.server.luau", source: "pwned" });
  world.helper.say(HelperMessage.ScriptsChanged, { path: "Linked/victim.luau", source: "pwned" });
  world.helper.say(HelperMessage.ScriptsChanged, { path: "Linked/new.server.luau", source: "pwned" });
  await world.helperLink.idle();
  assert.deepEqual(world.written, []);
  assert.deepEqual(await tree(world.root), before);
  assert.equal(await readFile(path.join(world.outside, "victim.luau"), "utf8"), "untouched");
  assert.equal(world.studio.otherCalls().length, 0);
  world.helperLink.close();
});

test("a src folder that is a link refuses every script path", async (t) => {
  const world = await boundGame();
  const src = path.join(world.game, "src");
  const { rm } = await import("node:fs/promises");
  await rm(src, { recursive: true });
  const skipped = await linkOrSkip(world.outside, src, "dir");
  if (skipped) return t.skip(skipped);
  world.helper.say(HelperMessage.ScriptsChanged, { path: "victim.luau", source: "pwned" });
  await world.helperLink.idle();
  assert.deepEqual(world.written, []);
  assert.equal(await readFile(path.join(world.outside, "victim.luau"), "utf8"), "untouched");
  world.helperLink.close();
});

test("a plain script change from the bound helper reaches the sink with its file under src/", async () => {
  const world = await boundGame();
  world.helper.say(HelperMessage.ScriptsChanged, { path: "ServerScriptService/Main.server.luau", source: "print(2)" });
  await world.helperLink.idle();
  assert.deepEqual(world.written, [
    {
      path: "ServerScriptService/Main.server.luau",
      source: "print(2)",
      target: path.join(world.game, "src", "ServerScriptService", "Main.server.luau"),
    },
  ]);
  world.helperLink.close();
});
