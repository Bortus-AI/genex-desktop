/**
 * The Roblox Studio plugin's backend through its plugin interface, over a fake Mac: the toolbar
 * button's word and dot for each state of Studio (not installed, not set up, not open, starting,
 * ready), the panel's status, the lock's probe, and that none of it reads the person's Documents
 * folder. Then the built package: it builds, seeds off, shows no button while off, and shows the
 * "Roblox Studio" button with the box glyph and a status word once turned on.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext, PluginToolbarStatus } from "../../src/plugin-sdk/index.d.ts";
import {
  createRobloxBackend,
  PanelStep,
  type RobloxDeps,
  StudioStatus,
  studioStatusOf,
} from "../../src/plugins/roblox/backend.ts";
import type { LocateStat, Run } from "../../src/plugins/roblox/studio-locate.ts";
import { STUDIO_MAC_APP } from "../../src/plugins/roblox/studio-locate.ts";
import { toolbarItems } from "../../src/shared/plugin-toolbar.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOME = "/Users/maker";
const STORAGE = "/Genex/plugins/roblox/storage";
/** Joined as the backend joins it, so the fake disk matches on Windows too. */
const SETUP_RECORD = path.join(STORAGE, "setup", "record.json");
const CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const STUDIO_FILES = [`${CONTENTS}/MacOS/RobloxStudio`, `${CONTENTS}/MacOS/StudioMCP`, `${CONTENTS}/Info.plist`];
const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;

/** A Mac as the backend sees it: which files exist, whether Studio runs and answers. */
interface Mac {
  installed: boolean;
  setUp: boolean;
  running: boolean;
  answering: boolean;
}

function fakeMac(state: Mac) {
  const touched: string[] = [];
  const ran: string[] = [];
  const dirs = new Set(["/Applications", ...(state.installed ? [STUDIO_MAC_APP] : [])]);
  const files = new Set([...(state.installed ? STUDIO_FILES : []), ...(state.setUp ? [SETUP_RECORD] : [])]);
  const run: Run = async (file) => {
    ran.push(file);
    if (file === "/usr/bin/plutil") return { code: 0, stdout: "0.743.0.7431133\n" };
    if (file === "/usr/bin/pgrep") return state.running ? { code: 0, stdout: "4530\n" } : { code: 1, stdout: "" };
    throw new Error(`spawn ${file} ENOENT`);
  };
  const deps: RobloxDeps = {
    platform: "darwin",
    env: { HOME },
    home: HOME,
    run,
    fs: {
      async lstat(file): Promise<LocateStat | undefined> {
        touched.push(file);
        if (dirs.has(file)) return { file: false, directory: true, link: false, mtimeMs: 0 };
        if (files.has(file)) return { file: true, directory: false, link: false, mtimeMs: 0 };
        return undefined;
      },
      async realpath(file) {
        touched.push(file);
        return file;
      },
      async readdir(dir) {
        touched.push(dir);
        return [];
      },
    },
    answers: async () => state.answering,
  };
  return { deps, touched, ran };
}

function context(): PluginContext {
  const host = (async (method: string) => {
    if (method === "storage.root") return STORAGE;
    throw new Error(`No ${method} here`);
  }) as PluginContext["host"];
  return { signal: new AbortController().signal, callId: 1, host };
}

const MISSING: Mac = { installed: false, setUp: false, running: false, answering: false };
const NOT_SET_UP: Mac = { installed: true, setUp: false, running: true, answering: false };
const CLOSED: Mac = { installed: true, setUp: true, running: false, answering: false };
const STARTING: Mac = { installed: true, setUp: true, running: true, answering: false };
const READY: Mac = { installed: true, setUp: true, running: true, answering: true };

/** Each state, the status it is, and the badge and tone its dot shows. */
const STATES: Array<[Mac, StudioStatus, string, NonNullable<PluginToolbarStatus["tone"]>]> = [
  [MISSING, StudioStatus.Get, "Not installed", "info"],
  [NOT_SET_UP, StudioStatus.SetUp, "Set up", "warn"],
  [CLOSED, StudioStatus.NotOpen, "Not open", "info"],
  [STARTING, StudioStatus.Starting, "Starting", "warn"],
  [READY, StudioStatus.Ready, "Ready", "ok"],
];

describe("the Roblox Studio toolbar button's word", () => {
  for (const [mac, status, badge, tone] of STATES)
    it(`says ${badge} (${status}) as a ${tone} dot, in plain words, without reading Documents`, async () => {
      const { deps, touched } = fakeMac(mac);
      const backend = createRobloxBackend(deps);
      const answer = (await backend.action?.("toolbar-status", {}, context())) as PluginToolbarStatus;
      assert.deepEqual([answer.badge, answer.tone, answer.dot], [badge, tone, true]);
      assert.ok(answer.title && answer.title.length > 0, "a title says what the state means");
      assert.doesNotMatch(`${answer.badge} ${answer.title}`, BANNED_WORDS);
      assert.deepEqual(
        touched.filter((file) => file.includes("/Documents")),
        [],
        "the button never reads Documents: macOS would ask the person for it",
      );
    });

  it("names the installed version while Studio is closed", async () => {
    const answer = (await createRobloxBackend(fakeMac(CLOSED).deps).action?.(
      "toolbar-status",
      {},
      context(),
    )) as PluginToolbarStatus;
    assert.match(answer.title ?? "", /0\.743/);
  });

  it("asks nothing further than it needs: no process check before setup, no answer check while closed", async () => {
    const missing = fakeMac(MISSING);
    await createRobloxBackend(missing.deps).action?.("toolbar-status", {}, context());
    assert.deepEqual(missing.ran, [], "nothing runs when Studio isn't there");
    const notSetUp = fakeMac(NOT_SET_UP);
    await createRobloxBackend(notSetUp.deps).action?.("toolbar-status", {}, context());
    assert.ok(!notSetUp.ran.includes("/usr/bin/pgrep"), "whether Studio runs doesn't matter before setup");
  });

  it("orders the states: missing first, then setup, then open, then answering", () => {
    const facts = { installed: true, setUp: true, running: true, answering: true };
    assert.equal(studioStatusOf({ ...facts, installed: false }), StudioStatus.Get);
    assert.equal(studioStatusOf({ ...facts, setUp: false }), StudioStatus.SetUp);
    assert.equal(studioStatusOf({ ...facts, running: false }), StudioStatus.NotOpen);
    assert.equal(studioStatusOf({ ...facts, answering: false }), StudioStatus.Starting);
    assert.equal(studioStatusOf(facts), StudioStatus.Ready);
    assert.equal(
      studioStatusOf({ ...facts, running: false, answering: true }),
      StudioStatus.NotOpen,
      "an answer without a running Studio is not Studio's",
    );
  });
});

describe("the Roblox Studio panel's status and the lock's probe", () => {
  it("answers the status, the version and which panel steps are done", async () => {
    const backend = createRobloxBackend(fakeMac(STARTING).deps);
    assert.deepEqual(await backend.action?.("status", {}, context()), {
      studio: StudioStatus.Starting,
      version: "0.743.0.7431133",
      steps: { [PanelStep.Studio]: true, [PanelStep.Helper]: true, [PanelStep.Mcp]: false, [PanelStep.Place]: false },
    });
    const missing = createRobloxBackend(fakeMac(MISSING).deps);
    assert.deepEqual(await missing.action?.("status", {}, context()), {
      studio: StudioStatus.Get,
      steps: { [PanelStep.Studio]: false, [PanelStep.Helper]: false, [PanelStep.Mcp]: false, [PanelStep.Place]: false },
    });
  });

  it("the probe sees nobody using Studio, and an unknown action or tool is refused", async () => {
    const backend = createRobloxBackend(fakeMac(READY).deps);
    assert.deepEqual(await backend.tool?.("studio-activity", {}, context()), { personActive: false });
    await assert.rejects(() => backend.action!("publish", {}, context()), /Unknown Roblox Studio action: publish/);
    await assert.rejects(() => backend.tool!("insert", {}, context()), /Unknown Roblox Studio tool: insert/);
  });
});

describe("the built Roblox Studio plugin", () => {
  it("builds its backend, manifest, icon and panel with the panel SDK inlined", async () => {
    const resources = await makeResources({ tsc: false });
    const roblox = path.join(resources, "plugins", "roblox");
    for (const file of ["plugin.json", "icon.svg", "backend.mjs", "panel.html"])
      await access(path.join(roblox, file)).catch(() => assert.fail(`the package has ${file}`));
    const panel = await readFile(path.join(roblox, "panel.html"), "utf8");
    assert.doesNotMatch(panel, /<!-- STUDIO_PANEL_(SDK|FONTS) -->/, "the panel SDK and fonts are inlined");
    assert.match(panel, /window\.studioPlugin/);
    assert.match(panel, /Not affiliated with Roblox Corporation\. For people 18 and over\./);
  });

  it("is seeded off: no Roblox button until it is turned on, then Roblox Studio with the box glyph and a word", async () => {
    const lite = await coreLite();
    const roblox = lite.core.plugins.list().find((p) => p.manifest.id === "roblox");
    assert.equal(roblox?.enabled, false, "the plugin ships turned off");
    const keys = (plugins: ReturnType<PluginRegistry["list"]>) => toolbarItems(plugins, null).map((entry) => entry.key);
    assert.ok(!keys(lite.core.plugins.list()).some((key) => key.startsWith("roblox:")), "off shows nothing Roblox");

    try {
      await lite.core.plugins.setEnabled("roblox", true);
      const entry = toolbarItems(lite.core.plugins.list(), null).find((e) => e.key === "roblox:studio");
      assert.deepEqual([entry?.item.label, entry?.item.icon], ["Roblox Studio", "box"]);
      const status = (await lite.core.plugins.action("roblox", "toolbar-status", {})) as PluginToolbarStatus;
      const words = STATES.map(([, , badge]) => badge);
      assert.ok(words.includes(status.badge ?? ""), `a status word: ${JSON.stringify(status)}`);
      assert.equal(status.dot, true);
    } finally {
      // A core that was never started leaves its plugins' processes to the test.
      lite.core.plugins.cancel();
      await lite.close();
    }
  });

  it("is listed with the engine it declares while off", async () => {
    const root = await tmpDir("roblox-registry-");
    const resources = await makeResources({ tsc: false });
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      path.join(resources, "plugins"),
      path.join(resources, "plugin-sdk", "backend.mjs"),
      async () => null,
    );
    registry.seedEnabled = { roblox: false };
    await registry.init();
    try {
      assert.equal(registry.engines().get("roblox")?.label, "Roblox Studio");
      assert.equal(registry.enabled("roblox"), false);
    } finally {
      registry.cancel();
    }
  });
});
