/**
 * cua-driver as the studio's desktop driver: each studio call becomes the driver's own MCP tool,
 * aimed at the whole display in the foreground (background canvas clicks are rerouted, cua #4350).
 * A fake connection records the calls; nothing touches this Mac. The command lines are checked as
 * a hostile table: a VM address can never become an ssh option or a shell word.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type CuaAnswer,
  type CuaConnection,
  cuaDriver,
  findCuaDriver,
  localDriverCommand,
  vmDriverCommand,
} from "../../src/substrate/cua-driver-client.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const json = (value: unknown): CuaAnswer => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** A connection answering the driver's tools from a table, recording every call. */
function fakeConnection(overrides: Record<string, CuaAnswer> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const answers: Record<string, CuaAnswer> = {
    get_desktop_state: {
      content: [{ type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" }],
      structuredContent: { width: 1366, height: 854 },
    },
    get_screen_size: json({ width: 1512, height: 945 }),
    list_apps: json({
      apps: [
        { name: "Notes", bundle_id: "com.apple.Notes", pid: 7, active: true },
        { name: "Finder", bundle_id: "com.apple.finder", pid: 3, active: false },
      ],
    }),
    list_windows: json({
      windows: [
        { pid: 7, window_id: 70, z_index: 0, bounds: { x: 0, y: 0, width: 756, height: 945 } },
        { pid: 3, window_id: 30, z_index: 1, bounds: { x: 0, y: 0, width: 1512, height: 945 } },
      ],
    }),
    get_window_state: { content: [{ type: "text", text: "- AXWindow Notes\n  - AXTextArea body" }] },
    ...overrides,
  };
  const connection: CuaConnection = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return answers[tool] ?? json({ ok: true });
    },
    close: async () => {},
  };
  return { connection, calls, actions: () => calls.filter((c) => !READS.has(c.tool)) };
}

/** The driver's read-only tools, apart from the actions a test looks for. */
const READS = new Set(["get_desktop_state", "get_screen_size", "list_apps", "list_windows", "get_window_state"]);

describe("cua-driver as the desktop driver", () => {
  it("takes the whole display's picture, at the size the driver drew it", async () => {
    const fake = fakeConnection();
    const shot = await cuaDriver(fake.connection).screenshot();
    assert.deepEqual([shot.width, shot.height], [1366, 854]);
    assert.deepEqual(
      shot.screen,
      { width: 1366, height: 854 },
      "actions use the picture's pixels; the driver maps them",
    );
    assert.equal(shot.mime, "image/png");
    assert.deepEqual(fake.calls[0], { tool: "get_desktop_state", args: { max_image_dimension: 1366 } });
  });

  it("sends every action to the whole display, in the foreground, in the driver's words", async () => {
    const fake = fakeConnection();
    const driver = cuaDriver(fake.connection);
    await driver.click(10, 20, { button: "left", count: 2, modifiers: ["cmd"] });
    await driver.type("hello");
    await driver.press(["cmd", "shift", "s"]);
    await driver.press(["return"]);
    await driver.scroll(5, 6, 0, -4);
    await driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, "left");
    const desktop = { target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground" };
    assert.deepEqual(fake.actions(), [
      { tool: "click", args: { ...desktop, x: 10, y: 20, button: "left", count: 2, modifier: ["cmd"] } },
      { tool: "type_text", args: { ...desktop, text: "hello" } },
      { tool: "press_key", args: { ...desktop, key: "s", modifiers: ["cmd", "shift"] } },
      { tool: "press_key", args: { ...desktop, key: "return" } },
      { tool: "scroll", args: { ...desktop, x: 5, y: 6, direction: "up", amount: 4 } },
      { tool: "drag", args: { ...desktop, from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: "left" } },
    ]);
  });

  it("knows the app in front, the app under a point, and a password field in front", async () => {
    const fake = fakeConnection();
    const driver = cuaDriver(fake.connection);
    await driver.screenshot();
    assert.deepEqual((await driver.focus()).app, { name: "Notes", bundleId: "com.apple.Notes", pid: 7 });
    assert.equal((await driver.focus()).secure, false);
    assert.equal((await driver.appAt?.(100, 100))?.name, "Notes", "the front window holds the left half");
    assert.equal((await driver.appAt?.(1200, 100))?.name, "Finder", "the right half is Finder's window behind it");
    const login = fakeConnection({
      get_window_state: { content: [{ type: "text", text: "- AXWindow Sign in\n  - AXSecureTextField Password" }] },
    });
    assert.equal((await cuaDriver(login.connection).focus()).secure, true);
  });

  it("says why a call failed, with the driver's own words", async () => {
    const fake = fakeConnection({
      click: { isError: true, content: [{ type: "text", text: "background_unavailable" }] },
    });
    await assert.rejects(
      cuaDriver(fake.connection).click(1, 1, { button: "left", count: 1, modifiers: [] }),
      /cua-driver click failed: background_unavailable/,
    );
  });

  it("starts this Mac's driver as `cua-driver mcp`, and finds it where its installer puts it", async () => {
    assert.deepEqual(localDriverCommand("/Users/me/.local/bin/cua-driver"), {
      command: "/Users/me/.local/bin/cua-driver",
      args: ["mcp"],
    });
    const home = await tmpDir("cua-home-");
    assert.equal(await findCuaDriver(home).then((found) => found?.startsWith(home) ?? false), false);
    const wrapper = path.join(home, ".local", "bin", "cua-driver");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "#!/bin/sh\n");
    await chmod(wrapper, 0o755);
    assert.equal(await findCuaDriver(home), wrapper);
  });

  it("reaches a VM's driver over ssh, with the address as one plain word", () => {
    assert.deepEqual(vmDriverCommand("lume@192.168.64.5"), {
      command: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "--", "lume@192.168.64.5", "/Users/lume/.local/bin/cua-driver", "mcp"],
    });
    const hostile = [
      "-oProxyCommand=sh -c 'id'",
      "lume@host -oProxyCommand=x",
      "lume@host;rm -rf ~",
      "lume@$(whoami)",
      "@host",
      "lume@",
      "Lume@host",
      "lume@host\nx",
      "",
    ];
    for (const address of hostile) assert.equal(vmDriverCommand(address), null, address);
  });
});
