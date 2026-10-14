/**
 * Computer control through a real delegation: the chat's own session — on any engine — is handed
 * the `desktop` tool when a desktop driver is installed, and nothing moves before the person
 * answers the consent card the studio puts in the chat. Sessions nobody answers (a playtester, a
 * read-only lead) never get it, and the driver stops with the session.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import type { DesktopDriver } from "../../src/substrate/desktop-driver.ts";
import { connectCuaDriver, driverEnv, GrantHolder } from "../../src/substrate/cua-driver-client.ts";
import { embeddedCuaDriver, HOST_BUNDLE_ID } from "../../src/substrate/cua-embedded.ts";
import { running } from "../helpers/processes.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A driver over one app in front, recording what reached it. */
function fakeDriver(calls: string[]): DesktopDriver {
  return {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 100,
      height: 100,
      screen: { width: 100, height: 100 },
    }),
    focus: async () => ({ app: { name: "Notes", bundleId: "com.apple.Notes", pid: 9 }, secure: false }),
    move: async () => {},
    click: async (x, y) => {
      calls.push(`click ${x},${y}`);
    },
    mouse: async () => {},
    drag: async () => {},
    scroll: async () => {},
    type: async () => {},
    press: async () => {},
    accessibility: async () => ({}),
    close: async () => {
      calls.push("close");
    },
  };
}

it("the chat's own session gets the desktop tool behind the person's consent; other sessions never do", async () => {
  const calls: string[] = [];
  const active: number[] = [];
  const desktop = desktopControl({
    findDriver: async () => "/fake/cua-driver",
    connect: async () => fakeDriver(calls),
    ownApp: () => false,
    onActive: (count) => active.push(count),
  });
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state === "pending") answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    const project = "desk";
    await core.games.scaffold(project);
    const threadId = await core.createGameThread(project);
    const seen: Array<{ tools: string[]; answers: string[] }> = [];
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const tools = (request.liveTools ?? []).map((tool) => tool.name);
        const answers: string[] = [];
        if (tools.includes("desktop")) {
          answers.push(text(await request.onLiveTool!("desktop", { action: "screenshot" })));
          answers.push(text(await request.onLiveTool!("desktop", { action: "left_click", coordinate: "10,20" })));
        }
        seen.push({ tools, answers });
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt: "tidy my notes" });
    assert.ok(seen[0]?.tools.includes("desktop"), "the chat's own session holds the desktop tool");
    assert.match(seen[0]!.answers[1]!, /OK — left click at 10,20/);
    assert.deepEqual(
      calls,
      ["click 10,20", "close"],
      "the click landed after both answers; the driver stopped with the session",
    );
    assert.deepEqual(active, [1, 0], "the stop shortcut was held only while the driver ran");
    const cards = (await core.store.listEvents(threadId))
      .filter((event) => event.data.type === "custom" && event.data.event_type === "plugin_consent")
      .map(
        (event) =>
          (event.data as { payload: { pluginId: string; pluginName: string; state: string; prompt: string } }).payload,
      );
    assert.equal(cards[0]?.pluginName, "Computer control", "the card names the studio's own ask, not an id");
    assert.deepEqual(
      cards.map((card) => [card.pluginId, card.state]),
      [
        ["studio-desktop", "pending"],
        ["studio-desktop", "approved"],
        ["studio-desktop", "pending"],
        ["studio-desktop", "approved"],
      ],
    );
    assert.match(cards[0]!.prompt, /see your screen/);
    assert.match(cards[2]!.prompt, /use Notes/);

    await api[HostMethod.EngineDelegate]!({
      engine: "fixture-delegate",
      project,
      threadId,
      prompt: "look only",
      readOnly: true,
      cwd: undefined,
    });
    assert.equal(seen[1]?.tools.includes("desktop"), false, "a read-only session is never handed the computer");
  } finally {
    await lite.close();
  }
});

it("the harness's own loop (Ollama) gets the same desktop tool through desktop.computer, behind the same consent", async () => {
  const calls: string[] = [];
  const desktop = desktopControl({
    findDriver: async () => "/fake/cua-driver",
    connect: async () => fakeDriver(calls),
    ownApp: () => false,
  });
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state === "pending") answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    const project = "desk-local";
    await core.games.scaffold(project);
    const threadId = await core.createGameThread(project);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<Record<string, unknown>>>;
    const call = api[HostMethod.DesktopComputer]!;
    assert.deepEqual(
      Object.keys(await call({ project, args: { action: "screenshot" } })),
      ["unavailable"],
      "no chat to ask in",
    );
    const described = (await call({ project, threadId, describe: true })) as { tool: { name: string } };
    assert.equal(described.tool.name, "desktop");
    await call({ project, threadId, args: { action: "screenshot" } });
    const clicked = (await call({ project, threadId, args: { action: "left_click", coordinate: "3,4" } })) as {
      answer: { text: string };
    };
    assert.match(clicked.answer.text, /OK — left click at 3,4/);
    assert.deepEqual(calls, ["click 3,4"]);

    // The seed's tool module, as the registry loads it, calls the same host method.
    const { tools } = await import("../../src/harness-seed/tools/desktop-tools.ts");
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const ctx = {
      project,
      threadId,
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params });
        return { answer: { text: "looked", images: [{ mimeType: "image/png", data: "AAAA" }] } };
      },
    };
    const outcome = (await tools[0]!.execute({ action: "screenshot" }, ctx as never)) as {
      content: string;
      images: unknown[];
    };
    assert.equal(outcome.content, "looked");
    assert.equal(outcome.images.length, 1, "the picture goes back to the model");
    assert.deepEqual(seen, [
      { method: "desktop.computer", params: { project, threadId, args: { action: "screenshot" } } },
    ]);
  } finally {
    await lite.close();
  }
});

it("without a desktop driver, nothing is offered and desktop.computer says why", async () => {
  const desktop = desktopControl({
    findDriver: async () => null,
    connect: async () => {
      throw new Error("never");
    },
    ownApp: () => false,
  });
  const lite = await coreLite({ desktop });
  try {
    const { core } = lite;
    await core.games.scaffold("no-driver");
    const threadId = await core.createGameThread("no-driver");
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<Record<string, unknown>>>;
    const answered = await api[HostMethod.DesktopComputer]!({ project: "no-driver", threadId, describe: true });
    assert.match(String(answered.unavailable), /no cua-driver is bundled or installed/);
  } finally {
    await lite.close();
  }
});

it("end to end: a chat's click goes through consent, the cua client and a real MCP driver process", async () => {
  const fake = fileURLToPath(new URL("../fixtures/fake-cua-driver.mjs", import.meta.url));
  const log = path.join(await tmpDir("desktop-e2e-"), "calls.jsonl");
  const desktop = desktopControl({
    findDriver: async () => process.execPath,
    connect: (binary) => connectCuaDriver({ command: binary, args: [fake, "--log", log] }, { local: false }),
    ownApp: () => false,
  });
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state === "pending") answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    await core.games.scaffold("desk-e2e");
    const threadId = await core.createGameThread("desk-e2e");
    let said = "";
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        await request.onLiveTool!("desktop", { action: "screenshot" });
        said = text(await request.onLiveTool!("desktop", { action: "left_click", coordinate: "100,200" }));
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project: "desk-e2e", threadId, prompt: "go" });
    assert.match(said, /OK — left click at 100,200/);
    assert.match(said, /AXTextArea/, "the answer carries the app's accessibility tree");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
    const click = calls.find((call) => call.name === "click");
    assert.deepEqual(click?.args, {
      target: { kind: "desktop", display_id: "primary" },
      delivery_mode: "foreground",
      x: 100,
      y: 200,
      button: "left",
      count: 1,
    });
  } finally {
    await lite.close();
  }
});

it("end to end: a chat opens a web page, reads it and types into it by ref, through consent and a real MCP driver", async () => {
  const fake = fileURLToPath(new URL("../fixtures/fake-cua-driver.mjs", import.meta.url));
  const log = path.join(await tmpDir("desktop-web-e2e-"), "calls.jsonl");
  const desktop = desktopControl({
    findDriver: async () => process.execPath,
    connect: (binary) => connectCuaDriver({ command: binary, args: [fake, "--log", log] }, { local: false }),
    ownApp: () => false,
  });
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state === "pending") answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    await core.games.scaffold("desk-web");
    const threadId = await core.createGameThread("desk-web");
    const said: string[] = [];
    const pictures: number[] = [];
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const seen = (result: LiveToolResult) => (typeof result === "string" ? 0 : (result.images?.length ?? 0));
        said.push(text(await request.onLiveTool!("desktop", { action: "web_open", text: "javascript:alert(1)" })));
        const opened = await request.onLiveTool!("desktop", { action: "web_open", text: "https://example.com/" });
        said.push(text(opened));
        pictures.push(seen(opened));
        pictures.push(seen(await request.onLiveTool!("desktop", { action: "web_read", observe: "screenshot" })));
        said.push(
          text(await request.onLiveTool!("desktop", { action: "web_type", ref: "p1:0", text: "Godot", submit: true })),
        );
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project: "desk-web", threadId, prompt: "web" });
    assert.match(said[0]!, /web_open did not happen: only http/);
    assert.match(said[1]!, /Search — https:\/\/example\.com\//);
    assert.match(said[1]!, /\[p1:0\] searchbox "Search"/, "the page comes back with its controls' refs");
    // The page's text is what a web verb answers with; its picture costs a small model's context, so
    // it rides the answer only when the call asks for it.
    assert.deepEqual(pictures, [0, 1]);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
    const prepared = calls.find((call) => call.name === "browser_prepare");
    assert.deepEqual(prepared?.args.profile, { mode: "isolated_new" });
    const typed = calls.find((call) => call.name === "browser_type");
    assert.deepEqual([typed?.args.ref, typed?.args.text, typed?.args.mode], ["p1:0", "Godot\n", "keystrokes"]);
    const sessions = new Set(calls.filter((call) => call.name.startsWith("browser_")).map((call) => call.args.session));
    assert.equal(sessions.size, 1, "one session label for the whole connection");
  } finally {
    await lite.close();
  }
});

it("end to end: a chat's click goes through the app's own embedded daemon, which the stop shortcut ends", async () => {
  const fake = fileURLToPath(new URL("../fixtures/fake-cua-driver.mjs", import.meta.url));
  const dir = await tmpDir("desktop-embedded-");
  const log = path.join(dir, "calls.jsonl");
  const serveLog = path.join(dir, "serve.jsonl");
  // Wired as the app wires it (desktop-control-host.ts): one embedded daemon, a restart, and its stop.
  const daemon = embeddedCuaDriver(
    { command: process.execPath, args: [fake, "--log", log, "--serve-log", serveLog] },
    { hostBundleId: HOST_BUNDLE_ID, env: driverEnv() },
  );
  const desktop = desktopControl({
    findDriver: async () => process.execPath,
    connect: () =>
      connectCuaDriver(() => daemon.command(), {
        local: false,
        holder: GrantHolder.Host,
        restart: () => daemon.restart(),
      }),
    ownApp: () => false,
    shutdown: () => daemon.stop(),
  });
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state === "pending") answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    await core.games.scaffold("desk-embedded");
    const threadId = await core.createGameThread("desk-embedded");
    let said = "";
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        said = text(await request.onLiveTool!("desktop", { action: "left_click", coordinate: "100,200" }));
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({
      engine: "fixture-delegate",
      project: "desk-embedded",
      threadId,
      prompt: "go",
    });
    assert.match(said, /OK — left click at 100,200/);
    const [served] = (await readFile(serveLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pid: number; env: Record<string, string> });
    assert.equal(served?.env.CUA_DRIVER_EMBEDDED, "1", "the click went through the app's own embedded daemon");
    assert.equal(running(served!.pid), true, "the daemon stays up between sessions");
    await desktop.stopAll();
    assert.equal(running(served!.pid), false, "⌃⌥⌘Esc and quitting stop it");
  } finally {
    await daemon.stop();
    await lite.close();
  }
});

it("tells the embedded driver the release app's bundle id", async () => {
  const require = createRequire(import.meta.url);
  const { APP_BUNDLE_ID } = require("../../scripts/package-signing.cjs") as { APP_BUNDLE_ID: string };
  assert.equal(HOST_BUNDLE_ID, APP_BUNDLE_ID);
});
