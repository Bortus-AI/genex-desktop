/**
 * Grok Build, the third subscription. The `grok` process is injected, so these tests cover the
 * studio's half: which login counts as signed in, the headless argv, and the streaming-json
 * events the headless guide documents.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { GrokEngine, type GrokEngineOptions } from "../../src/substrate/engines/grok.ts";
import {
  allowedGrokLoginUrl,
  deviceCodeFrom,
  grokEffortArgs,
  grokFailureKind,
  GrokSandbox,
  GrokStop,
  translateGrokEvent,
  type GrokExec,
} from "../../src/substrate/engines/grok-cli.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { DelegateEventType } from "../../src/substrate/engines/types.ts";

function scripted(events: unknown[]): {
  fn: GrokExec;
  seen: Array<{ argv: string[]; prompt: string; env: Record<string, string> }>;
} {
  const seen: Array<{ argv: string[]; prompt: string; env: Record<string, string> }> = [];
  const fn: GrokExec = (invocation) => {
    seen.push({ argv: invocation.argv, prompt: invocation.prompt, env: invocation.env });
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event as Record<string, unknown>;
      },
    };
  };
  return { fn, seen };
}

async function engine(options: Partial<GrokEngineOptions> & { execFn?: GrokExec } = {}): Promise<{
  engine: GrokEngine;
  root: string;
  home: string;
  system: string;
}> {
  const root = await tmpDir("studio-grok-");
  const home = path.join(root, "engine-home");
  const system = path.join(root, "system-home");
  await mkdir(home, { recursive: true });
  await mkdir(system, { recursive: true });
  return {
    root,
    home,
    system,
    engine: new GrokEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: system,
      executable: "/fake/grok",
      ...options,
    }),
  };
}

const missingCli: typeof fixtureCodingCli = async (provider) => ({
  path: "",
  env: {},
  status: {
    provider,
    state: "missing",
    selection: "automatic",
    detail: "Install this coding CLI, then check again.",
    guidanceUrl: "https://docs.x.ai/build/overview",
  },
});

describe("grok login", () => {
  it("is not installed when the CLI cannot be found", async () => {
    const { engine: grok } = await engine({ resolveCli: missingCli });
    const status = await grok.status();
    assert.equal(status.code, EngineStatusCode.NotInstalled);
    assert.match(status.detail, /Install/);
  });

  it("is ready from a session file and does not read it", async () => {
    const { engine: grok, system } = await engine();
    await writeFile(path.join(system, "auth.json"), '{"access_token":"secret-token"}', { mode: 0o600 });
    const status = await grok.status();
    assert.equal(status.code, EngineStatusCode.Ready);
    assert.match(status.detail, /existing Grok Build sign-in/);
    const account = await grok.account();
    assert.equal(account.source, "system");
    assert.equal(JSON.stringify(account).includes("secret-token"), false);
  });

  it("is ready from XAI_API_KEY when no session file exists", async () => {
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-test-key";
    try {
      const { engine: grok } = await engine();
      const status = await grok.status();
      assert.equal(status.code, EngineStatusCode.Ready);
      assert.equal((await grok.account()).variable, "XAI_API_KEY");
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });

  it("stays signed out of a studio profile even when an API key is set", async () => {
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-test-key";
    try {
      const { engine: grok, home } = await engine();
      await writeFile(path.join(home, "studio-login.json"), "{}\n");
      const status = await grok.status();
      assert.equal(status.code, EngineStatusCode.NeedsLogin);
      assert.equal((await grok.resolveLogin()).source, "isolated");
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });

  it("opens only xAI and grok.com sign-in links, and reads a device code", () => {
    assert.equal(allowedGrokLoginUrl("https://auth.x.ai/device"), "https://auth.x.ai/device");
    assert.equal(allowedGrokLoginUrl("https://evil.example/auth.x.ai"), null);
    assert.equal(allowedGrokLoginUrl("http://auth.x.ai/device"), null);
    assert.equal(deviceCodeFrom("Open https://auth.x.ai/device and enter code: ABCD-EF"), "ABCD-EF");
    assert.equal(deviceCodeFrom("still waiting"), null);
  });
});

describe("grok headless", () => {
  it("translates a streaming-json turn into the studio's log", () => {
    const text = translateGrokEvent({ type: "text", data: "Built" });
    assert.equal(text.text, "Built");
    assert.equal(text.events[0]?.type, DelegateEventType.Assistant);
    const tool = translateGrokEvent({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "read_file",
      status: "in_progress",
      rawInput: { path: "src/main.js" },
    });
    const event = tool.events[0];
    assert.ok(event);
    const part = (event.payload as { parts: Array<{ name?: string }> }).parts[0];
    assert.equal(part?.name, "read_file");
    const end = translateGrokEvent({
      type: "end",
      stopReason: "end_turn",
      sessionId: "sess-1",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 4, reasoning_tokens: 2 },
    });
    assert.equal(end.sessionId, "sess-1");
    assert.equal(end.completed, true);
    assert.equal(end.usage?.cache_read_tokens, 4);
    assert.equal(end.usage?.cost_usd, undefined);
    const failure = translateGrokEvent({ type: "error", message: "Authentication failed" });
    assert.equal(grokFailureKind(failure.failure ?? ""), "auth");
    assert.equal(translateGrokEvent({ type: "plan", entries: [] }).events.length, 0);
  });

  it("runs a headless session with the documented flags and keeps an API key for the system login", async () => {
    const { fn, seen } = scripted([
      { type: "text", data: "Pong is playable." },
      { type: "end", stopReason: GrokStop.EndTurn, sessionId: "sess-9", usage: { input_tokens: 8, output_tokens: 2 } },
    ]);
    const { engine: grok, system } = await engine({ execFn: fn });
    await writeFile(path.join(system, "auth.json"), "{}");
    process.env.XAI_API_KEY = "xai-should-stay";
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    try {
      const result = await grok.delegate({
        prompt: "Build a tiny pong.",
        cwd: system,
        model: "grok-4.7",
        effort: "max",
      });
      assert.equal(result.ok, true);
      assert.equal(result.summary, "Pong is playable.");
      assert.equal(result.sessionId, "sess-9");
      assert.equal(result.billing, "subscription");
      const argv = seen[0]?.argv ?? [];
      assert.ok(argv.includes("--output-format"));
      assert.ok(argv.includes("streaming-json"));
      assert.ok(argv.includes("--always-approve"));
      assert.ok(argv.includes("--prompt-file"));
      assert.ok(argv.includes("--no-auto-update"));
      assert.ok(argv.includes(GrokSandbox.Workspace));
      assert.ok(argv.includes("--model") && argv.includes("grok-4.7"));
      assert.deepEqual(grokEffortArgs("max"), ["--effort", "xhigh"]);
      assert.ok(argv.includes("--effort") && argv.includes("xhigh"));
      assert.equal(seen[0]?.prompt.includes("Build a tiny pong."), true);
      assert.equal(seen[0]?.env.XAI_API_KEY, "xai-should-stay");
      assert.equal(seen[0]?.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(seen[0]?.env.GROK_HOME, system);
    } finally {
      delete process.env.XAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("does not hand an API key to a studio-owned profile", async () => {
    const { fn, seen } = scripted([{ type: "end", stopReason: GrokStop.EndTurn, sessionId: "sess", usage: {} }]);
    const { engine: grok, home } = await engine({ execFn: fn });
    await writeFile(path.join(home, "studio-login.json"), "{}\n");
    await writeFile(path.join(home, "auth.json"), "{}");
    process.env.XAI_API_KEY = "xai-hidden";
    try {
      await grok.delegate({ prompt: "Look.", cwd: home });
      assert.equal(seen[0]?.env.XAI_API_KEY, undefined);
      assert.equal(seen[0]?.env.GROK_HOME, home);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});
