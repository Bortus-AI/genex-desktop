#!/usr/bin/env node
/**
 * A stand-in for `cua-driver mcp`: a stdio MCP server answering the driver's tools with fixed data,
 * so the studio's client is exercised over a real MCP connection (the SDK's transport, the
 * handshake, the permission check) without touching this Mac. Settings come as arguments, since the
 * studio hands its driver only a minimal environment: `--log <file>` appends every tool call as one
 * JSON line, `--denied` answers that a grant is missing, `--fail-start` exits the way the real
 * driver does when its daemon never comes up.
 */
import { appendFileSync } from "node:fs";
import readline from "node:readline";

/** A 1×1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const argv = process.argv.slice(2);
const denied = argv.includes("--denied");
const logFile = argv.includes("--log") ? argv[argv.indexOf("--log") + 1] : null;
if (argv.includes("--fail-start")) {
  process.stderr.write("cua-driver-rs: daemon did not appear on /tmp/cua.sock within 10s. If this is the first launch, grant Accessibility + Screen Recording\n");
  process.exit(1);
}

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

const ANSWERS = {
  check_permissions: () => json({ accessibility: !denied, screen_recording: !denied }),
  get_desktop_state: () => ({
    content: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
    structuredContent: { screenshot_width: 1366, screenshot_height: 854, screen_width: 1512, screen_height: 945 },
  }),
  list_apps: () => json({ apps: [{ name: "Notes", bundle_id: "com.apple.Notes", pid: 7, active: true }] }),
  list_windows: () =>
    json({ windows: [{ pid: 7, window_id: 70, z_index: 0, bounds: { x: 0, y: 0, width: 1512, height: 945 } }] }),
  get_window_state: () => ({ content: [{ type: "text", text: "- AXWindow Notes\n  - AXTextArea body" }] }),
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-cua-driver", version: "0" },
      },
    });
  }
  if (method === "tools/list") return send({ id, result: { tools: [] } });
  if (method === "tools/call") {
    const name = params?.name;
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ name, args: params?.arguments ?? {} })}\n`);
    const answer = ANSWERS[name]?.() ?? json({ effect: "confirmed" });
    return send({ id, result: answer });
  }
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: `method not found: ${method}` } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    // Not JSON: a real server would ignore it too.
  }
});
lines.on("close", () => process.exit(0));
