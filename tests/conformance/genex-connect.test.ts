/**
 * The Genex page's Connect band: one press turns the plugin on and signs in when needed, and the
 * band's lines run from every routed tool into the action, faster while Connect is pointed at.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenexTool } from "../../src/shared/asset-making.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import {
  ConnectArtState,
  connectArtState,
  linePoint,
  pulseHead,
  pulseSpeed,
  pulsesPerLine,
  TOOL_SPOTS,
} from "../../src/renderer/panels/plugins/genex/connect-art.ts";
import { turnOnAndConnect } from "../../src/renderer/panels/plugins/genex/connect-genex.ts";
import { GenexAccountKind } from "../../src/renderer/panels/plugins/genex/genex-view.ts";
import { fakeStudioApi, installFakeStudio } from "../helpers/fake-studio-api.ts";

const genex = { manifest, enabled: false } as unknown as PluginInfo;

/** The page's one-action-at-a-time runner, keeping what failed as the page does. */
function pageRunner() {
  const failures: string[] = [];
  return {
    failures,
    act: async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(String(e));
      }
    },
  };
}

describe("Connect while the Genex plugin is off", () => {
  /** The app's account: signed in or not, with every sign-in it is asked for counted. */
  const account = (signedIn: boolean) => {
    const signIns: number[] = [];
    return { signedIn, signIns, signIn: async () => void signIns.push(signIns.length + 1) };
  };

  it("turns the plugin on, then signs in to Genex when the app is signed out", async () => {
    const studio = fakeStudioApi();
    const restore = installFakeStudio(studio);
    try {
      const page = pageRunner();
      const signedOut = account(false);
      await turnOnAndConnect(genex, page, signedOut);
      assert.deepEqual(studio.callsOf("pluginEnable"), [["genex", true]]);
      assert.equal(signedOut.signIns.length, 1);
      assert.deepEqual(page.failures, []);
    } finally {
      restore();
    }
  });

  it("only turns the plugin on when the app is already signed in: the account outlives the switch", async () => {
    const studio = fakeStudioApi();
    const restore = installFakeStudio(studio);
    try {
      const signedIn = account(true);
      await turnOnAndConnect(genex, pageRunner(), signedIn);
      assert.deepEqual(studio.callsOf("pluginEnable"), [["genex", true]]);
      assert.equal(signedIn.signIns.length, 0);
    } finally {
      restore();
    }
  });

  it("signs in to nothing when the plugin could not be turned on, and says why", async () => {
    const studio = fakeStudioApi();
    studio.stub("pluginEnable", async () => {
      throw new Error("Install the plugin first");
    });
    const restore = installFakeStudio(studio);
    try {
      const page = pageRunner();
      const signedOut = account(false);
      await turnOnAndConnect(genex, page, signedOut);
      assert.equal(signedOut.signIns.length, 0);
      assert.match(page.failures.join(), /Install the plugin first/);
    } finally {
      restore();
    }
  });
});

describe("the Connect band's lines", () => {
  it("light up for a sign-in in the browser and hold once connected; every other state waits", () => {
    assert.equal(connectArtState(GenexAccountKind.Connected), ConnectArtState.Connected);
    assert.equal(connectArtState(GenexAccountKind.SigningIn), ConnectArtState.SigningIn);
    for (const kind of [
      null,
      GenexAccountKind.Loading,
      GenexAccountKind.SignedOut,
      GenexAccountKind.Terms,
      GenexAccountKind.Checking,
      GenexAccountKind.Attention,
    ])
      assert.equal(connectArtState(kind), ConnectArtState.Waiting, String(kind));
  });

  it("give every routed tool its own place inside the logos' field", () => {
    const spots = Object.values(GenexTool).map((tool) => TOOL_SPOTS[tool]);
    for (const spot of spots) {
      assert.ok(spot.x > 0 && spot.x < 1 && spot.y > 0 && spot.y < 1, JSON.stringify(spot));
    }
    assert.equal(new Set(spots.map((spot) => `${spot.x},${spot.y}`)).size, spots.length);
  });

  it("run from the logo to the action", () => {
    const from = { x: 20, y: 40 };
    const to = { x: 500, y: 120 };
    assert.deepEqual(linePoint(from, to, 0), from);
    assert.deepEqual(linePoint(from, to, 1), to);
    const middle = linePoint(from, to, 0.5);
    assert.ok(middle.x > from.x && middle.x < to.x && middle.y > from.y && middle.y < to.y);
  });

  it("carry light faster while Connect is pointed at, quickest in the browser, steady once connected", () => {
    const resting = pulseSpeed(ConnectArtState.Waiting, 0);
    const pointed = pulseSpeed(ConnectArtState.Waiting, 1);
    assert.ok(pointed > resting);
    assert.equal(pulseSpeed(ConnectArtState.Waiting, 5), pointed, "heat stops at fully pointed at");
    assert.ok(pulseSpeed(ConnectArtState.SigningIn, 0) > resting);
    assert.ok(pulseSpeed(ConnectArtState.Connected, 0) > resting);
    assert.equal(pulsesPerLine(ConnectArtState.Connected), 2);
    assert.equal(pulsesPerLine(ConnectArtState.Waiting), 1);
  });

  it("never send two lines' light in step", () => {
    for (const seconds of [0, 1.6, 37.25]) {
      const heads = Object.values(GenexTool).map((_, index) => pulseHead(seconds, 0.3, index, 0, 1));
      for (const head of heads) assert.ok(head >= 0 && head < 1, String(head));
      assert.equal(new Set(heads.map((head) => head.toFixed(4))).size, heads.length);
    }
  });
});
