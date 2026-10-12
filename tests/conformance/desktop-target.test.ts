/**
 * The desktop as a computer target: a fake driver records every call, so what the studio lets an
 * agent do on the person's computer is tested without touching it. Input lands only in an app the
 * person allowed; the studio itself, password managers and system settings are never driven;
 * nothing is typed into a password field; and the model's pixels are scaled to the screen's points.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InputRoute, TargetRuntime } from "../../src/shared/computer-target.ts";
import { desktopTarget, driverKey } from "../../src/main/core/desktop-target.ts";
import type { DesktopApp, DesktopDriver, DesktopFocus } from "../../src/substrate/desktop-driver.ts";
import type { PreviewInputAction } from "../../src/substrate/preview-input.ts";

const EDITOR: DesktopApp = { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 11 };
const STUDIO: DesktopApp = { name: "Genex", bundleId: "ai.genex.studio", pid: 22 };

/** A driver that records each call; a 2880×1800 picture of a 1440×900-point screen. */
function fakeDriver(options: { focus?: DesktopFocus; under?: DesktopApp | null } = {}) {
  const calls: string[] = [];
  const driver: DesktopDriver = {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 2880,
      height: 1800,
      screen: { width: 1440, height: 900 },
    }),
    focus: async () => options.focus ?? { app: EDITOR, secure: false },
    ...(options.under !== undefined ? { appAt: async () => options.under ?? null } : {}),
    move: async (x, y) => {
      calls.push(`move ${x},${y}`);
    },
    click: async (x, y, o) => {
      calls.push(`click ${x},${y} ${o.button}×${o.count}${o.modifiers.length ? ` +${o.modifiers.join("+")}` : ""}`);
    },
    mouse: async (x, y, o) => {
      calls.push(`mouse ${o.down ? "down" : "up"} ${x},${y}`);
    },
    drag: async (from, to) => {
      calls.push(`drag ${from.x},${from.y}→${to.x},${to.y}`);
    },
    scroll: async (x, y, dx, dy) => {
      calls.push(`scroll ${x},${y} ${dx},${dy}`);
    },
    type: async (text) => {
      calls.push(`type ${text}`);
    },
    press: async (keys) => {
      calls.push(`press ${keys.join("+")}`);
    },
    accessibility: async () => ({ role: "AXWindow", title: "Untitled" }),
    close: async () => {},
  };
  return { driver, calls };
}

/** A target over the fake driver, the person allowing exactly `allowed`, the studio's own app known. */
async function targetOver(fake: ReturnType<typeof fakeDriver>, allowed: string[] = ["com.apple.TextEdit"]) {
  const asked: string[] = [];
  const target = desktopTarget({
    driver: fake.driver,
    allowApp: async (app) => {
      asked.push(app.name);
      return allowed.includes(app.bundleId ?? "");
    },
    ownApp: (app) => app.bundleId === STUDIO.bundleId,
  });
  await target.screenshot({ quality: 80, surface: "auto" as never });
  return { target, asked };
}

describe("desktop target", () => {
  it("is a desktop: absolute pointer, no clock, the accessibility tree, input by OS events", async () => {
    const fake = fakeDriver();
    const { target } = await targetOver(fake);
    assert.equal(target.caps.runtime, TargetRuntime.Desktop);
    assert.deepEqual(target.viewSize(), { width: 2880, height: 1800 });
    const done = await target.input([{ type: "click", x: 200, y: 100, px: true }]);
    assert.deepEqual(done, { applied: 1, route: InputRoute.OsForeground });
    assert.deepEqual(fake.calls, ["click 100,50 left×1"], "screenshot pixels are scaled to the screen's points");
    assert.deepEqual(await target.state?.(), { app: "TextEdit", tree: { role: "AXWindow", title: "Untitled" } });
  });

  it("carries out keys, chords, text, drags and scrolls in the driver's words", async () => {
    const fake = fakeDriver();
    const { target } = await targetOver(fake);
    await target.input([
      { type: "press", combo: "cmd+s" },
      { type: "type", text: "hello" },
      { type: "drag", fromX: 20, fromY: 20, x: 200, y: 200, px: true },
      { type: "scroll", x: 400, y: 400, dy: 3 },
      { type: "click", x: 10, y: 10, px: true, clicks: 2, modifiers: ["shift"] },
    ]);
    assert.deepEqual(fake.calls, [
      "press cmd+s",
      "type hello",
      "drag 10,10→100,100",
      "scroll 200,200 0,3",
      "click 5,5 left×2 +shift",
    ]);
    assert.equal(driverKey("KeyA"), "a");
    assert.equal(driverKey("Enter"), "return");
    assert.equal(driverKey("MetaLeft"), "cmd");
  });

  const hostile: Array<{
    name: string;
    focus?: DesktopFocus;
    under?: DesktopApp | null;
    actions: PreviewInputAction[];
    why: RegExp;
  }> = [
    {
      name: "a click on the studio's own window (an agent answering its own consent card)",
      under: STUDIO,
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "keys while the studio is in front",
      focus: { app: STUDIO, secure: false },
      actions: [{ type: "press", combo: "Return" }],
      why: /never driven/,
    },
    {
      name: "typing into a password manager",
      focus: { app: { name: "1Password", bundleId: "com.1password.1password", pid: 3 }, secure: false },
      actions: [{ type: "type", text: "x" }],
      why: /never driven/,
    },
    {
      name: "a click in System Settings",
      under: { name: "System Settings", bundleId: "com.apple.systempreferences", pid: 4 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "a password typed into a secure field of an allowed app",
      focus: { app: EDITOR, secure: true },
      actions: [{ type: "type", text: "hunter2" }],
      why: /password field/,
    },
    {
      name: "a key pressed into a secure field",
      focus: { app: EDITOR, secure: true },
      actions: [{ type: "press", combo: "Return" }],
      why: /password field/,
    },
    {
      name: "a click in an app the person did not allow",
      under: { name: "Mail", bundleId: "com.apple.mail", pid: 5 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /did not allow Mail/,
    },
    {
      name: "a click where no app can be found",
      focus: { app: null, secure: false },
      under: null,
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /no app/,
    },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name}, and nothing reaches the screen`, async () => {
      const fake = fakeDriver({
        ...(row.focus ? { focus: row.focus } : {}),
        ...(row.under !== undefined ? { under: row.under } : {}),
      });
      const { target } = await targetOver(fake);
      const done = await target.input([...row.actions, { type: "click", x: 1, y: 1, px: true }]);
      assert.equal(done.applied, 0);
      assert.deepEqual(fake.calls, [], "no input reached the driver, and the plan stopped at the refusal");
      const refused = target.refusals?.() ?? [];
      assert.equal(refused.length, 1);
      assert.match(refused[0]!.message, row.why);
      assert.deepEqual(target.refusals?.(), [], "reading the refusals clears them");
    });
  }

  it("asks the person about each app the agent reaches, and a later refusal stops the rest of the plan", async () => {
    const fake = fakeDriver({ under: EDITOR });
    const { target, asked } = await targetOver(fake);
    const done = await target.input([
      { type: "click", x: 10, y: 10, px: true },
      { type: "type", text: "ok" },
    ]);
    assert.equal(done.applied, 2);
    assert.deepEqual(asked, ["TextEdit", "TextEdit"], "the host's allow-list answers; the target asks every time");
  });

  it("never reads the accessibility tree of an app the studio never drives", async () => {
    const fake = fakeDriver({ focus: { app: STUDIO, secure: false } });
    const { target } = await targetOver(fake);
    const state = (await target.state?.()) as Record<string, unknown>;
    assert.equal("tree" in state, false);
  });
});
