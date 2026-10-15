/**
 * Opening a place in Roblox Studio and quitting Studio, as argument lists on a Mac and on Windows:
 * a local place with `--task EditFile --localPlaceFile`, a published place with
 * `--task EditPlace --placeId --universeId` (ids of digits only), never a shell string, and a quit
 * that is always the normal one, never forced. A Starting note in the plugin's storage lets the
 * button say Starting while Studio comes up.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import {
  focusLaunch,
  LaunchRefusal,
  markStarting,
  openPlaceLaunch,
  quitLaunch,
  STARTING_MAX_MS,
  StudioLaunchError,
  startingNow,
  systemOpener,
} from "../../src/plugins/roblox/studio-launch.ts";
import type { StudioInstall } from "../../src/plugins/roblox/studio-locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MAC: StudioInstall = {
  app: "/Applications/RobloxStudio.app",
  studio: "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio",
  plugins: "/Users/maker/Documents/Roblox/Plugins",
};
const WINDOWS_EXE = "C:\\Users\\maker\\AppData\\Local\\Roblox\\Versions\\version-abc123\\RobloxStudioBeta.exe";
const WINDOWS: StudioInstall = { app: WINDOWS_EXE, studio: WINDOWS_EXE, plugins: "C:\\Users\\maker\\Plugins" };
const MAC_PLACE = "/Users/maker/AI Games/sky-race/sky-race.rbxlx";
const WINDOWS_PLACE = "C:\\Users\\maker\\AI Games\\sky-race\\sky-race.rbxlx";

describe("opening a place in Roblox Studio", () => {
  it("opens a local place with EditFile and its full path as one argument, on both systems", () => {
    assert.deepEqual(openPlaceLaunch("darwin", MAC, { file: MAC_PLACE }), {
      file: MAC.studio,
      args: ["--task", "EditFile", "--localPlaceFile", MAC_PLACE],
    });
    assert.deepEqual(openPlaceLaunch("win32", WINDOWS, { file: WINDOWS_PLACE }), {
      file: WINDOWS_EXE,
      args: ["--task", "EditFile", "--localPlaceFile", WINDOWS_PLACE],
    });
  });

  it("opens a published place with EditPlace and both of its ids, on both systems", () => {
    const ids = { placeId: "4483381587", universeId: "1611231458" };
    const args = ["--task", "EditPlace", "--placeId", "4483381587", "--universeId", "1611231458"];
    assert.deepEqual(openPlaceLaunch("darwin", MAC, ids), { file: MAC.studio, args });
    assert.deepEqual(openPlaceLaunch("win32", WINDOWS, ids), { file: WINDOWS_EXE, args });
  });

  /** Ids that are not a published place's: each is refused before anything is started. */
  const BAD_IDS: Array<[string, { placeId: string; universeId: string }]> = [
    ["a letter", { placeId: "12a", universeId: "1" }],
    ["a flag", { placeId: "--task", universeId: "1" }],
    ["a minus", { placeId: "-1", universeId: "1" }],
    ["zero", { placeId: "0", universeId: "1" }],
    ["a leading zero", { placeId: "0123", universeId: "1" }],
    ["empty", { placeId: "", universeId: "1" }],
    ["a space", { placeId: "1 2", universeId: "1" }],
    ["too long", { placeId: "1".repeat(21), universeId: "1" }],
    ["a bad universe", { placeId: "1", universeId: "1;open -a Calculator" }],
    ["a decimal", { placeId: "1.5", universeId: "1" }],
  ];
  for (const [name, ids] of BAD_IDS)
    it(`refuses EditPlace with ${name}`, () => {
      for (const platform of ["darwin", "win32"] as const)
        assert.throws(
          () => openPlaceLaunch(platform, platform === "darwin" ? MAC : WINDOWS, ids),
          (error: unknown) => error instanceof StudioLaunchError && error.code === LaunchRefusal.BadIds,
        );
    });

  /** Place files that are not a full path of the system Studio runs on. */
  const BAD_FILES: Array<[NodeJS.Platform, string]> = [
    ["darwin", "sky-race.rbxlx"],
    ["darwin", "--task"],
    ["darwin", WINDOWS_PLACE],
    ["darwin", "/Users/maker/../other/sky-race.rbxlx"],
    ["darwin", "/Users/maker/sky\u0000race.rbxlx"],
    ["win32", MAC_PLACE],
    ["win32", "\\\\server\\share\\sky-race.rbxlx"],
    ["win32", "C:\\Users\\..\\sky-race.rbxlx"],
  ];
  for (const [platform, file] of BAD_FILES)
    it(`refuses ${JSON.stringify(file)} on ${platform}`, () => {
      assert.throws(
        () => openPlaceLaunch(platform, platform === "darwin" ? MAC : WINDOWS, { file }),
        (error: unknown) => error instanceof StudioLaunchError && error.code === LaunchRefusal.BadFile,
      );
    });

  it("brings an open Studio forward on a Mac without starting anything new, and has nothing to do on Windows", () => {
    assert.deepEqual(focusLaunch("darwin", MAC), { file: "/usr/bin/open", args: ["-a", MAC.app] });
    assert.equal(focusLaunch("win32", WINDOWS), undefined);
  });
});

describe("quitting Roblox Studio", () => {
  it("is the normal quit on both systems: an Apple event on a Mac, taskkill without /F on Windows", () => {
    const mac = quitLaunch("darwin", {});
    assert.equal(mac.file, "/usr/bin/osascript");
    assert.ok(mac.args.join(" ").includes("to quit"), "a quit Apple event");
    assert.ok(!mac.args.join(" ").match(/kill|-9|force/i), "never a kill");
    const windows = quitLaunch("win32", { SystemRoot: "C:\\Windows" });
    assert.equal(windows.file, "C:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(windows.args, ["/IM", "RobloxStudioBeta.exe"]);
    assert.ok(!windows.args.some((arg) => /^\/[FT]$/i.test(arg)), "never /F or /T");
  });
});

describe("starting a program", () => {
  it("passes every argument as it is, through no shell", async () => {
    const dir = await tmpDir("roblox-launch-");
    // A shell would run these in the test's working folder; the name holds no folder of its own.
    const marker = path.join(process.cwd(), "pwned-by-a-shell");
    // Windows file names can't hold | > < or ", so its line keeps cmd's own: & ^ and %VAR%.
    const name =
      process.platform === "win32"
        ? "a b & echo %PATH% ^ ;$(x)"
        : 'a b;$(touch pwned-by-a-shell) `touch pwned-by-a-shell` | & > "q"';
    const odd = path.join(dir, name);
    const script = "require('node:fs').writeFileSync(process.argv[1], 'ok')";
    await systemOpener({ file: process.execPath, args: ["-e", script, odd] });
    for (let tries = 0; tries < 100 && !existsSync(odd); tries++) await wait(50);
    assert.ok(existsSync(odd), "the argument reached the program as one string");
    assert.equal(existsSync(marker), false, "nothing in it ran as a command");
  });
});

describe("the Starting note", () => {
  it("holds for a while after Genex opens Studio, then lapses", async () => {
    const storage = await tmpDir("roblox-launch-");
    assert.equal(await startingNow(storage, 1_000), false, "nothing opened yet");
    await markStarting(storage, 1_000);
    assert.equal(await startingNow(storage, 1_000 + STARTING_MAX_MS - 1), true);
    assert.equal(await startingNow(storage, 1_000 + STARTING_MAX_MS), false);
    assert.equal(await startingNow(storage, 0), false, "a note from the future is no note");
  });
});
