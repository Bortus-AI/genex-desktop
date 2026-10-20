/**
 * Which studio tools a Claude Code session sees from its first turn.
 *
 * Claude Code (2.1.304 on) defers MCP tools behind its tool search: the first request carries
 * their names but not their schemas, so a tool the session is expected to call unprompted would
 * cost a search first, or never be called. The tools a session's prompt relies on — `checkpoint`,
 * `capture` where granted, and a chat's interview tools (`ask_user`, the Loop's launch) — load with
 * the prompt. Live and connector tools, a large and varied set, stay deferred, and a blind judge
 * still brings its live tools in through tool search alone. The SDK's `query()` is injected: what
 * is proven is what the engine registered.
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { LiveToolSpec, StudioToolSpec } from "../../src/shared/engine-requests.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { alwaysLoaded, type ScriptedClaude, scriptedClaude } from "../helpers/scripted-claude.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

/** A tool declared as the harness declares its interview and live tools: one string field. */
function spec(name: string): StudioToolSpec & LiveToolSpec {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };
}

/** One delegation with the request's extras; what the studio's MCP server registered. */
async function session(request: Record<string, unknown>): Promise<ScriptedClaude> {
  const root = await realpath(await tmpDir("studio-claude-tool-loading-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd, { recursive: true });
  const scripted = scriptedClaude([]);
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: path.join(root, "engine-home"),
    systemHome: path.join(root, "no-system-login"),
    queryFn: scripted.queryFn,
  });
  await engine.delegate({ prompt: "build it", cwd, ...request } as never);
  assert.ok(scripted.options, "a session started");
  return scripted;
}

const LIVE_TOOLS = [spec("press_key"), spec("connector__search")];

describe("a Claude session sees the studio tools it is expected to call from its first turn", () => {
  it("a builder's checkpoint, and its capture where granted, load with the prompt", async () => {
    const granted = await session({ onCapture: async () => "captured" });
    for (const tool of ["checkpoint", "capture"]) {
      assert.ok(granted.tools.includes(tool), `${tool} is registered`);
      assert.equal(alwaysLoaded(granted, tool), true, `${tool} is never deferred behind tool search`);
    }
    const plain = await session({});
    assert.equal(alwaysLoaded(plain, "checkpoint"), true, "checkpoint loads without capture too");
    assert.equal(plain.tools.includes("capture"), false, "no capture where none was granted");
  });

  it("a Loop chat's interview tools, its launch and ask_user, load with the prompt", async () => {
    const interviewTools = [spec("launch_build"), spec("ask_user")];
    const chat = await session({ interviewTools });
    for (const { name } of interviewTools) {
      assert.ok(chat.tools.includes(name), `${name} is registered`);
      assert.equal(alwaysLoaded(chat, name), true, `${name} is never deferred behind tool search`);
    }
  });

  it("live and connector tools stay deferred, for a builder and for a blind judge", async () => {
    const live = { liveTools: LIVE_TOOLS, onLiveTool: async () => "ok" };
    const builder = await session(live);
    const judge = await session({ ...live, readOnly: true, blind: true });
    for (const [label, record] of [
      ["builder", builder],
      ["blind judge", judge],
    ] as const) {
      for (const { name } of LIVE_TOOLS) {
        assert.ok(record.tools.includes(name), `${label}: ${name} is registered`);
        assert.equal(alwaysLoaded(record, name), false, `${label}: ${name} waits for tool search`);
      }
    }
    assert.deepEqual(judge.options?.tools, ["ToolSearch"], "the blind judge loads them through tool search alone");
  });
});
