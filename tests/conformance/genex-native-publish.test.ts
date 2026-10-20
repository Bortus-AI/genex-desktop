/**
 * A publish's apps, sent with `genex native publish` once the web build is public. Only a CLI new
 * enough to have the command sends any. The builds come from the dialog by their place in the game
 * folder, which agents write: only a real `.app`, or a Windows program's folder, inside the folder is
 * ever handed to the CLI. One app that fails is kept as that app's failure, in the CLI's own words.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { realpath } from "node:fs/promises";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { hasNativeCommand, nativeUploads, sendNativeBuild, sentBuild } from "../../src/plugins/genex/native-publish.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("which CLI sends apps", () => {
  it("is 1.36.10 or newer, a prerelease of it included", () => {
    for (const version of ["1.36.10", "1.36.10-dev.4", "1.36.11", "1.37.0", "2.0.0"])
      assert.equal(hasNativeCommand(version), true, version);
    for (const version of ["1.36.9", "1.36.9-dev.949", "1.35.40", "0.99.99", "", "latest"])
      assert.equal(hasNativeCommand(version), false, version);
  });
});

/** A game folder with a Mac app, a Windows build and things that only look like builds. */
async function gameFolder() {
  const root = await realpath(await tmpDir("native-publish-"));
  const game = path.join(root, "game");
  await mkdir(path.join(game, "Builds", "Mac", "Dust Runners.app", "Contents"), { recursive: true });
  await mkdir(path.join(game, "Builds", "Windows"), { recursive: true });
  await writeFile(path.join(game, "Builds", "Windows", "Dust.exe"), "MZ");
  await writeFile(path.join(game, "Root.exe"), "MZ");
  await writeFile(path.join(game, "notes.txt"), "words");
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "Elsewhere.app"), { recursive: true });
  await symlink(path.join(outside, "Elsewhere.app"), path.join(game, "Builds", "Linked.app"));
  await mkdir(path.join(outside, "Win"), { recursive: true });
  await writeFile(path.join(outside, "Win", "Far.exe"), "MZ");
  await symlink(path.join(outside, "Win"), path.join(game, "Builds", "LinkedWin"));
  return { game, outside };
}

describe("the apps a publish hands the CLI", () => {
  it("takes a Mac app and a Windows program's folder from inside the game folder", async () => {
    const { game } = await gameFolder();
    const uploads = await nativeUploads(game, ["Builds/Mac/Dust Runners.app", "Builds/Windows/Dust.exe"]);
    assert.deepEqual(uploads, [
      { target: path.join(game, "Builds", "Mac", "Dust Runners.app"), platform: "mac" },
      { target: path.join(game, "Builds", "Windows"), platform: "windows" },
    ]);
  });

  it("hands over nothing that is not a build inside the game folder", async () => {
    const { game, outside } = await gameFolder();
    const hostile: unknown[] = [
      path.join(outside, "Elsewhere.app"),
      "../outside/Elsewhere.app",
      "Builds/../../outside/Elsewhere.app",
      "Builds/Linked.app",
      "Builds/LinkedWin/Far.exe",
      "Root.exe",
      "notes.txt",
      "Builds/Missing.app",
      "Builds/Mac",
      "",
      7,
      null,
    ];
    for (const entry of hostile) assert.deepEqual(await nativeUploads(game, [entry]), [], String(entry));
    assert.deepEqual(await nativeUploads(game, "Builds/Mac/Dust Runners.app"), [], "a list, not a string");
    assert.deepEqual(await nativeUploads(path.join(game, "nowhere"), ["Builds/Mac/Dust Runners.app"]), []);
  });

  it("sends each app once, and at most four", async () => {
    const { game } = await gameFolder();
    const twice = await nativeUploads(game, ["Builds/Mac/Dust Runners.app", "Builds/Mac/./Dust Runners.app"]);
    assert.equal(twice.length, 1);
  });
});

describe("one app sent", () => {
  const MAC = { target: "/game/Builds/Mac/Dust Runners.app", platform: "mac" as const };
  const BUILD = {
    platform: "mac",
    arch: "universal",
    version: "1.0+3f2a9c1d0e4b",
    sizeBytes: 1_400_000_000,
    sha256: "a".repeat(64),
    url: "https://cdn.genex.technology/games/dust-runners/native/mac-universal/aaaa.zip",
    entry: "Dust Runners.app",
    installedBytes: 2_000_000_000,
    publishedAt: "2026-10-20T08:00:00.000Z",
  };

  it("keeps the build the CLI says it published", async () => {
    const sent: string[] = [];
    const outcome = await sendNativeBuild(MAC, async (target) => {
      sent.push(target);
      return { build: BUILD, engine: "unity" };
    });
    assert.deepEqual(sent, [MAC.target]);
    assert.deepEqual(outcome, {
      sent: {
        platform: "mac",
        arch: "universal",
        version: "1.0+3f2a9c1d0e4b",
        sizeBytes: 1_400_000_000,
        publishedAt: "2026-10-20T08:00:00.000Z",
      },
    });
  });

  it("keeps a failure in the CLI's own last words, and an answer without a build as a failure", async () => {
    const failed = await sendNativeBuild(MAC, async () => {
      throw new Error(
        "› Zipping…\n› Hashing the archive…\n✗ Couldn't get an upload token (HTTP 413).\n  over the limit",
      );
    });
    assert.deepEqual(failed, {
      failed: { platform: "mac", arch: "", error: "Couldn't get an upload token (HTTP 413)." },
    });
    const odd = await sendNativeBuild(MAC, async () => ({ engine: "unity" }));
    assert.ok("failed" in odd);
    assert.equal(sentBuild({ build: { ...BUILD, sizeBytes: "big" } }), null);
  });
});

/**
 * Genex's tools with a stand-in for the CLI: a preload that answers `genex native publish` itself,
 * as the real command does under `--json`, and logs each run's arguments. An app whose path names
 * "Broken" fails the way the CLI does, on stderr with a non-zero exit.
 */
async function toolsWithStandIn(sendsApps = true) {
  const root = await realpath(await tmpDir("genex-native-tools-"));
  const log = path.join(root, "runs.jsonl");
  const standIn = path.join(root, "native-cli.mjs");
  const answer = {
    platform: "mac",
    arch: "universal",
    version: "1.0+3f2a9c1d0e4b",
    sizeBytes: 10,
    publishedAt: "2026-10-20T08:00:00.000Z",
  };
  await writeFile(
    standIn,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME }) + "\\n");
const target = args[args.indexOf("publish") + 1] ?? "";
if (target.includes("Broken")) {
  process.stderr.write("› Zipping…\\n✗ Couldn't get an upload token (HTTP 413).\\n");
  process.exit(1);
}
const windows = !target.endsWith(".app");
process.stdout.write(JSON.stringify({ build: { ...${JSON.stringify(answer)}, ...(windows ? { platform: "windows", arch: "x64" } : {}) }, engine: "unity" }));
process.exit(0);
`,
  );
  const genex = new GenexTools(path.join(root, "host"), "http://127.0.0.1:9", {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    preload: standIn,
    sendsApps,
  });
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string });
  return { genex, runs };
}

describe("a publish's apps sent through the CLI", () => {
  const MAC_APP = { target: "/game/Builds/Mac/Dust Runners.app", platform: "mac" as const };
  const BROKEN = { target: "/game/Builds/Windows Broken", platform: "windows" as const };

  it("sends each app with `genex native publish` in the publish workspace and records how it went", async () => {
    const { genex, runs } = await toolsWithStandIn();
    await genex.publishApps("dust", "job-1", [MAC_APP, BROKEN]);
    const calls = await runs();
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 3)),
      [
        ["native", "publish", MAC_APP.target],
        ["native", "publish", BROKEN.target],
      ],
    );
    assert.ok(calls.every((call) => call.args.includes("--json")));
    const workspace = path.join(genex.root, "publish", "dust");
    assert.ok(calls.every((call) => call.cwd === workspace && call.home === path.join(workspace, "home")));
    const { native } = await genex.publishView("dust");
    assert.equal(native?.supported, true);
    assert.equal(native?.sending, false);
    assert.equal(native?.jobId, "job-1");
    assert.deepEqual(
      native?.sent.map((sent) => [sent.platform, sent.version]),
      [["mac", "1.0+3f2a9c1d0e4b"]],
    );
    assert.deepEqual(native?.failed, [
      { platform: "windows", arch: "", error: "Couldn't get an upload token (HTTP 413)." },
    ]);
  });

  it("sends nothing while the CLI has no `genex native`, and says so", async () => {
    const { genex, runs } = await toolsWithStandIn(false);
    await genex.publishApps("dust", "job-1", [MAC_APP]);
    assert.deepEqual(await runs(), []);
    const { native } = await genex.publishView("dust");
    assert.deepEqual(native, { supported: false, sending: false, sent: [], failed: [] });
  });
});
