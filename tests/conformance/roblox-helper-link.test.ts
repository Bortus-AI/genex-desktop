import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BIND_RETRY_MS,
  BIND_WAIT_MS,
  createHelperLink,
  HELPER_ANSWER_MS,
  HelperLinkError,
  HelperLinkFailure,
  type HelperLinkDeps,
  type ScriptChangeAt,
  startHelperLink,
} from "../../src/plugins/roblox/helper-link.ts";
import { HelperMessage } from "../../src/plugins/roblox/helper-protocol.ts";
import {
  BINDING_FILE,
  BINDING_MAX_AGE_MS,
  BINDING_REFRESH_MS,
  BindingState,
  readBinding,
  readPlaceLink,
} from "../../src/plugins/roblox/studio-binding.ts";
import type { StudioClient } from "../../src/plugins/roblox/studio-client.ts";
import { createStudioMcp } from "../../src/plugins/roblox/studio-mcp.ts";
import { StudioTool } from "../../src/plugins/roblox/studio-tools.ts";
import type { EngineDeclaration } from "../../src/shared/game-engine.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { engineCatalog } from "../../src/shared/plugins.ts";
import { createEngineLinks } from "../../src/substrate/plugins/engine-links.ts";
import { type FakeStudio, fakeStudio, manualClock, memoryHelper, socketHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ROBLOX = JSON.parse(await readFile(path.join(REPO, "src/plugins/roblox/plugin.json"), "utf8")) as {
  engine: EngineDeclaration;
};
const CATALOG = engineCatalog([{ engine: ROBLOX.engine }]);
const PLACE1 = { id: "studio-1", name: "Place1" };
const OBBY = { id: "studio-2", name: "Obby" };

/**
 * A plugin storage with games linked to place files the way the host links them (the real link
 * service writes `links/<game>.json`), and a games folder.
 */
async function world(places: Record<string, string> = { "game-1": "Place1.rbxl" }) {
  const root = await realpath(await tmpDir("roblox-helper-link-"));
  const storage = path.join(root, "plugins", "roblox");
  const games = path.join(root, "games");
  await mkdir(storage, { recursive: true });
  const links = createEngineLinks({
    root: () => storage,
    gameDir: (game) => path.join(games, game),
    append: async () => undefined,
    changed: () => undefined,
    gameThread: async (game) => `thread-${game}`,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    catalog: () => CATALOG,
  });
  for (const [game, file] of Object.entries(places)) {
    const dir = path.join(games, game);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "studio.json"), `${JSON.stringify({ name: game, title: game })}\n`);
    await writeFile(path.join(dir, file), "<roblox/>");
    const binding: PluginBinding = { project: game, directory: dir };
    await links.link("roblox", binding, { project: path.join(dir, file) });
  }
  return { root, storage, games };
}

let sessions = 0;
function linkOver(storage: string, studio: FakeStudio, extra: Partial<HelperLinkDeps> = {}) {
  const clock = manualClock();
  const link = createHelperLink({
    storage,
    studio: studio.client,
    clock,
    newSession: () => `session-${++sessions}`,
    ...extra,
  });
  return { link, clock };
}

const bindingIn = (storage: string, game: string) => path.join(storage, "mcp", game);
const readBound = async (storage: string, game: string, now: number) => readBinding(bindingIn(storage, game), now);

test("a link record as the host writes it is read, and an unlinked one is none", async () => {
  const { storage, games } = await world();
  assert.deepEqual(await readPlaceLink(storage, "game-1"), {
    project: path.join(games, "game-1", "Place1.rbxl"),
  });
  assert.equal(await readPlaceLink(storage, "game-2"), undefined);
});

test("a helper is bound only once its session marker is read in a Studio, and the binding file is written", async () => {
  const { storage } = await world();
  const studio = fakeStudio([OBBY, PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  const helper = memoryHelper(link, { studio, studioId: PLACE1.id });
  assert.equal((await readBound(storage, "game-1", clock.now())).state, BindingState.None);
  helper.hello();
  await link.idle();
  const markRequest = helper.received.find((frame) => frame.type === HelperMessage.SessionMark);
  assert.ok(markRequest, "the backend asked the helper to mark its session");
  const read = await readBound(storage, "game-1", clock.now());
  assert.equal(read.state, BindingState.Bound);
  assert.ok(read.state === BindingState.Bound);
  assert.deepEqual(read.binding, { studioId: PLACE1.id, session: markRequest.body?.session, at: clock.now() });
  assert.equal(link.bound("game-1"), PLACE1.id);
  // Both Studios were asked; only the marker read was sent to them.
  assert.deepEqual(studio.otherCalls(), []);
  assert.deepEqual(new Set(studio.calls.map((call) => call.args.studio_id)), new Set([OBBY.id, PLACE1.id]));
  link.close();
});

test("a helper whose marker is in no Studio is never bound, and its messages write and call nothing", async () => {
  const { storage, games } = await world();
  const studio = fakeStudio([PLACE1]);
  const changes: ScriptChangeAt[] = [];
  const { link, clock } = linkOver(storage, studio, {
    scriptsRoot: async () => path.join(games, "game-1"),
    sinks: { scriptsChanged: (_game, change) => void changes.push(change) },
  });
  const helper = memoryHelper(link, { studio, studioId: PLACE1.id, mark: false });
  helper.hello();
  await link.idle();
  for (let waited = 0; waited < BIND_WAIT_MS + BIND_RETRY_MS; waited += BIND_RETRY_MS) {
    clock.advance(BIND_RETRY_MS);
    await link.idle();
  }
  assert.equal(clock.pending(), 0, "the search stops once its window has passed");
  helper.say(HelperMessage.ScriptsChanged, { path: "ServerScriptService/Main.server.luau", source: "print(1)" });
  helper.say(HelperMessage.Activity, { editing: true });
  await link.idle();
  assert.equal((await readBound(storage, "game-1", clock.now())).state, BindingState.None);
  assert.deepEqual(await readdir(path.join(games, "game-1")).then((names) => names.sort()), [
    "Place1.rbxl",
    "studio.json",
  ]);
  assert.deepEqual(changes, []);
  assert.deepEqual(studio.otherCalls(), []);
  assert.equal(link.bound("game-1"), undefined);
  await assert.rejects(link.request("game-1", HelperMessage.ScriptsList, {}), (error: unknown) => {
    return error instanceof HelperLinkError && error.code === HelperLinkFailure.NotBound;
  });
  link.close();
});

test("the binding is looked for again while Studio joins StudioMCP, on the injected clock", async () => {
  const { storage } = await world();
  const studio = fakeStudio([]);
  const { link, clock } = linkOver(storage, studio);
  memoryHelper(link, { studio, studioId: PLACE1.id }).hello();
  await link.idle();
  assert.equal(link.bound("game-1"), undefined);
  studio.list([PLACE1]);
  clock.advance(BIND_RETRY_MS - 1);
  await link.idle();
  assert.equal(link.bound("game-1"), undefined, "nothing happens before the retry falls due");
  clock.advance(1);
  await link.idle();
  assert.equal(link.bound("game-1"), PLACE1.id);
  link.close();
});

test("the binding file is refreshed while the helper stays and goes stale once it is gone", async () => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  const helper = memoryHelper(link, { studio, studioId: PLACE1.id });
  helper.hello();
  await link.idle();
  const first = await readBound(storage, "game-1", clock.now());
  assert.ok(first.state === BindingState.Bound);
  clock.advance(BINDING_REFRESH_MS);
  await link.idle();
  const refreshed = await readBound(storage, "game-1", clock.now());
  assert.ok(refreshed.state === BindingState.Bound);
  assert.equal(refreshed.binding.at, first.binding.at + BINDING_REFRESH_MS);
  helper.end();
  await link.idle();
  clock.advance(BINDING_MAX_AGE_MS + BINDING_REFRESH_MS);
  await link.idle();
  assert.equal((await readBound(storage, "game-1", clock.now())).state, BindingState.Stale);
  assert.equal(link.bound("game-1"), undefined);
  link.close();
});

test("after a Studio restart the helper's new connection rebinds the game to the new Studio", async () => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  const before = memoryHelper(link, { studio, studioId: PLACE1.id });
  before.hello();
  await link.idle();
  // Studio quits: the helper's connection ends, and the restarted Studio has a new id.
  before.end();
  const restarted = { id: "studio-restarted", name: "Place1" };
  studio.list([restarted]);
  clock.advance(5_000);
  const after = memoryHelper(link, { studio, studioId: restarted.id });
  after.hello();
  await link.idle();
  const read = await readBound(storage, "game-1", clock.now());
  assert.ok(read.state === BindingState.Bound);
  assert.equal(read.binding.studioId, restarted.id);
  assert.equal(read.binding.at, clock.now());
  assert.equal(link.bound("game-1"), restarted.id);
  link.close();
});

test("two connections from one Studio: the newest wins and the older is closed", async () => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  const older = memoryHelper(link, { studio, studioId: PLACE1.id });
  older.hello();
  await link.idle();
  const newer = memoryHelper(link, { studio, studioId: PLACE1.id });
  newer.hello();
  await link.idle();
  assert.equal(older.state.open, false, "the older connection was closed");
  const newerSession = newer.received.find((frame) => frame.type === HelperMessage.SessionMark)?.body?.session;
  const read = await readBound(storage, "game-1", clock.now());
  assert.ok(read.state === BindingState.Bound);
  assert.equal(read.binding.session, newerSession);
  // A request reaches the newer helper only.
  const asked = link.request("game-1", HelperMessage.ScriptsList, {});
  await link.idle();
  assert.ok(newer.received.some((frame) => frame.type === HelperMessage.ScriptsList));
  assert.ok(!older.received.some((frame) => frame.type === HelperMessage.ScriptsList));
  const request = newer.received.find((frame) => frame.type === HelperMessage.ScriptsList);
  newer.raw(JSON.stringify({ v: 1, id: 50, type: "answer", re: request?.id, ok: true, result: { scripts: [] } }));
  assert.deepEqual(await asked, { scripts: [] });
  link.close();
});

test("a request's deadline comes from the injected clock, and the helper's own error is kept", async () => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  const helper = memoryHelper(link, { studio, studioId: PLACE1.id });
  helper.hello();
  await link.idle();
  let settled = false;
  const late = link.request("game-1", HelperMessage.PlayPause, { paused: true });
  void late
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  clock.advance(HELPER_ANSWER_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  clock.advance(1);
  await assert.rejects(
    late,
    (error: unknown) => error instanceof HelperLinkError && error.code === HelperLinkFailure.TimedOut,
  );
  const refused = link.request("game-1", HelperMessage.PlayPause, { paused: true });
  const asked = helper.received.filter((frame) => frame.type === HelperMessage.PlayPause).at(-1);
  helper.raw(
    JSON.stringify({
      v: 1,
      id: 60,
      type: "answer",
      re: asked?.id,
      ok: false,
      error: { code: "unsupported", message: "no pause" },
    }),
  );
  await assert.rejects(refused, (error: unknown) => {
    return (
      error instanceof HelperLinkError &&
      error.code === HelperLinkFailure.Answered &&
      error.helperCode === "unsupported"
    );
  });
  link.close();
});

test("with CoreGui out of reach everywhere, the helper's place alone binds it, and two such Studios bind none", async () => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1, OBBY]);
  studio.unreachable.add(PLACE1.id);
  studio.unreachable.add(OBBY.id);
  const { link } = linkOver(storage, studio);
  memoryHelper(link, { studio, studioId: PLACE1.id }).hello({ id: "0", name: "Place1" });
  await link.idle();
  assert.equal(link.bound("game-1"), PLACE1.id);
  link.close();

  const twin = fakeStudio([PLACE1, { id: "studio-3", name: "Place1" }]);
  twin.unreachable.add(PLACE1.id);
  twin.unreachable.add("studio-3");
  const second = linkOver(storage, twin);
  memoryHelper(second.link, { studio: twin, studioId: PLACE1.id }).hello({ id: "0", name: "Place1" });
  await second.link.idle();
  assert.equal(second.link.bound("game-1"), undefined);
  second.link.close();
});

test("a Studio whose place two games link binds neither game", async () => {
  const { storage } = await world({ "game-1": "Place1.rbxl", "game-2": "Place1.rbxl" });
  const studio = fakeStudio([PLACE1]);
  const { link, clock } = linkOver(storage, studio);
  memoryHelper(link, { studio, studioId: PLACE1.id }).hello();
  await link.idle();
  assert.equal((await readBound(storage, "game-1", clock.now())).state, BindingState.None);
  assert.equal((await readBound(storage, "game-2", clock.now())).state, BindingState.None);
  link.close();
});

/** A StudioClient for the game's connection, on the same stand-in Studio. */
function bridgeClient(studio: FakeStudio): StudioClient {
  return {
    listTools: async () => [
      {
        name: StudioTool.GetStudioState,
        inputSchema: { type: "object", properties: { studio_id: { type: "string" } }, required: ["studio_id"] },
      },
    ],
    studios: studio.client.studios,
    callTool: studio.client.callTool,
    waitForStudio: async (match) => {
      const found = (await studio.client.studios()).filter(match);
      if (found.length !== 1) throw new Error("not one Studio");
      return found[0] as { id: string; name: string };
    },
    restart: async () => undefined,
    close: async () => undefined,
  };
}

test("acceptance: a fake helper binds over the real socket, and the game's connection reads the bound Studio from the file", async (t) => {
  const { storage } = await world();
  // Two Studios with the same place open: by name alone, the connection couldn't tell them apart.
  const twin = { id: "studio-twin", name: "Place1" };
  const studio = fakeStudio([twin, PLACE1]);
  const clock = manualClock(Date.now());
  const ports = await freePorts(1);
  const running = await startHelperLink(
    { storage, studio: studio.client, clock, newSession: () => "session-acceptance" },
    { ports },
  );
  t.after(() => running.close());
  const helper = await socketHelper(running.port, { studio, studioId: PLACE1.id });
  await until(async () => (await readBound(storage, "game-1", clock.now())).state === BindingState.Bound);
  await running.link.idle();

  const folder = bindingIn(storage, "game-1");
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, BINDING_FILE), "utf8")), {
    studioId: PLACE1.id,
    session: "session-acceptance",
    at: clock.now(),
  });
  const bridge = createStudioMcp({
    client: bridgeClient(studio),
    folder,
    link: () => readPlaceLink(storage, "game-1"),
    running: async () => true,
    shrink: async (bytes) => bytes,
    now: clock.now,
  });
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "test", version: "0" });
  await Promise.all([bridge.server.connect(theirs), agent.connect(ours)]);
  await agent.callTool({ name: StudioTool.GetStudioState, arguments: {} });
  const sent = studio.otherCalls().find((call) => call.name === StudioTool.GetStudioState);
  assert.equal(sent?.args.studio_id, PLACE1.id);
  await agent.close();
  await bridge.close();
  await helper.end();
  await running.close();
});

/** Ports nothing listens on now. */
async function freePorts(count: number): Promise<number[]> {
  const { createServer } = await import("node:net");
  const servers = await Promise.all(
    Array.from({ length: count }, () => {
      const server = createServer();
      return new Promise<import("node:net").Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
    }),
  );
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/** Waits for something the socket delivers; it fails the test past a few seconds. */
async function until(check: () => Promise<boolean>): Promise<void> {
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail("the helper never bound");
}

test("the link stops listening once its backend is stopped", async (t) => {
  const { storage } = await world();
  const studio = fakeStudio([PLACE1]);
  const stopped = new AbortController();
  const ports = await freePorts(1);
  const running = await startHelperLink(
    { storage, studio: studio.client, clock: manualClock(), newSession: () => "session-stop" },
    { ports, signal: stopped.signal },
  );
  t.after(() => running.close());
  const helper = await socketHelper(running.port, { studio, studioId: PLACE1.id });
  stopped.abort();
  await helper.closed;
  const { connect } = await import("node:net");
  const refused = await new Promise<boolean>((resolve) => {
    const probe = connect(running.port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
  assert.equal(refused, true, "nothing listens on the port any more");
});
