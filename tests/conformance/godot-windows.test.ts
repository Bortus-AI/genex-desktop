/**
 * The Godot plugin on Windows through its backend's interface, on a fake PC: Genex's own Godot
 * (the host's pinned download, confirmed by the person) offered to the agent once it is in place;
 * the setup card and the panel following the host's install; every Godot job a sandbox job of the
 * host's, with what it reads and writes named, its folders outside the game staged in the
 * project's `.godot` and copied out, its stop passed on and Godot's Windows output read as a
 * Mac's; and the person's editor opened and recognized by its Windows command line. Nothing here
 * starts Godot; `godot-windows-live.test.ts` does, on a Windows runner.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginSetupCard } from "../../src/plugin-sdk/index.d.ts";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { GodotSetupAction } from "../../src/plugins/godot/godot-setup.ts";
import { unzipCall } from "../../src/plugins/godot/multiplayer.ts";
import { InstallPhase, type RuntimeInstallPhase } from "../../src/shared/model-install.ts";
import type { PluginSandboxRunArgs } from "../../src/shared/plugins.ts";
import {
  capturing,
  GODOT_472,
  godotOutput,
  godotWindowsFixture,
  OWN_GODOT,
  playArg,
  SCRIPTS,
} from "../helpers/godot-fake-engine.ts";

type Answer = Record<string, unknown>;
type Fixture = Awaited<ReturnType<typeof godotWindowsFixture>>;
const tool = async (fixture: Fixture, name: string, args = {}, more = {}) =>
  (await fixture.backend.tool?.(name, args, fixture.context(more))) as Answer;
const action = async (fixture: Fixture, name: string, args = {}) =>
  (await fixture.backend.action?.(name, args, fixture.context())) as Answer;
const card = async (fixture: Fixture) => (await action(fixture, GodotSetupAction.Steps)) as unknown as PluginSetupCard;
const MB = 2 ** 20;
/** Godot's Windows build writes CRLF lines and colours its progress even into a file. */
const windowsWords = (text: string) => `\u001b[92m[ DONE ]\u001b[39m\r\n${text.replaceAll("\n", "\r\n")}`;

/** A game whose Godot project New Godot game made on the fake PC, its sandbox requests since cleared. */
async function windowsProject(options: Parameters<typeof godotWindowsFixture>[0] = {}) {
  const fixture = await godotWindowsFixture({ installed: true, ...options });
  await tool(fixture, GodotTool.NewGame, { template: "3d", name: "Valley" });
  fixture.requests.length = 0;
  return { ...fixture, project: path.join(fixture.gameDir, "godot") };
}

describe("Godot on Windows: Genex's own Godot", () => {
  it("offers Godot to the agent once the host's pinned Godot is in place, and not before", async () => {
    const fixture = await godotWindowsFixture();
    const before = await tool(fixture, GodotTool.EngineStatus);
    assert.equal(before.ready, false);
    assert.match(String(before.note), /godot__show-steps/);
    await fixture.runtime.install();
    const after = await tool(fixture, GodotTool.EngineStatus);
    assert.deepEqual([after.ready, after.version], [true, "4.7.2"]);
    assert.match(String(after.note), /godot__new-game/);
  });

  it("leaves out a Godot the person keeps in their profile: Genex's sandbox can't run it", async () => {
    const fixture = await godotWindowsFixture({
      exes: [{ where: "Users/Ada/Downloads/Godot_v4.7.2-stable_win64.exe", version: GODOT_472 }],
    });
    assert.equal((await tool(fixture, GodotTool.EngineStatus)).ready, false);
  });

  it("puts the confirmed download on the card's Do it for me, and the card closes once Godot is in place", async () => {
    const fixture = await godotWindowsFixture();
    const open = await card(fixture);
    assert.equal(open.primary?.name, GodotSetupAction.Download);
    assert.equal(open.primary?.label, "Do it for me");
    assert.match(String(open.steps[0]?.detail), /about 86 MB\. Genex keeps it in its own folder/);
    await action(fixture, GodotSetupAction.Download);
    assert.equal(fixture.hostCalls.filter((call) => call.method === "runtime.install").length, 1);
    const done = await card(fixture);
    assert.equal(done.open, false);
    assert.match(String(done.doneSays), /Godot 4\.7 is installed on this computer/);
  });

  it("shows the host's install as it goes: the download, the unpacking, a stop and a failure", async () => {
    const fixture = await godotWindowsFixture();
    const at = (phase: RuntimeInstallPhase, more = {}) => {
      fixture.runtime.record = {
        runtime: "godot",
        phase,
        completed: 0,
        total: 0,
        active: true,
        updatedAt: "",
        ...more,
      };
    };
    at(InstallPhase.Downloading, { completed: 40 * MB, total: 82 * MB });
    const downloading = await card(fixture);
    assert.deepEqual(
      [downloading.steps[0]?.label, downloading.steps[0]?.detail],
      ["Downloading Godot 4", "40 of 82 MB"],
    );
    assert.equal(downloading.primary, undefined);
    assert.equal(downloading.secondary?.name, GodotSetupAction.Stop);
    at(InstallPhase.Extracting);
    assert.equal((await card(fixture)).steps[0]?.label, "Installing Godot 4");
    at(InstallPhase.Cancelled, { active: false });
    const stopped = await card(fixture);
    assert.deepEqual([stopped.primary?.label, stopped.stuckSays], ["Try again", undefined]);
    at(InstallPhase.Failed, { active: false, error: "Runtime digest mismatch" });
    const failed = await card(fixture);
    assert.equal(failed.primary?.name, GodotSetupAction.Download);
    assert.match(String(failed.steps[0]?.detail), /Couldn't install Godot \(Runtime digest mismatch\)/);
    assert.match(String(failed.stuckSays), /Try again is on the card\.$/);
    assert.equal((await action(fixture, "status")).installing !== null, true);
  });

  it("stops the host's install with Stop and with Don't use Godot", async () => {
    const fixture = await godotWindowsFixture();
    await action(fixture, GodotSetupAction.Stop);
    await action(fixture, GodotSetupAction.Skip);
    const cancels = fixture.hostCalls.filter((call) => call.method === "runtime.cancelInstall");
    assert.equal(cancels.length, 2);
    assert.equal((await card(fixture)).open, false);
  });

  it("never runs a Mac's install or opens a download page on Windows", async () => {
    const fixture = await godotWindowsFixture();
    await assert.rejects(action(fixture, GodotSetupAction.Install), /On Windows, Genex downloads Godot itself/);
    await assert.rejects(action(fixture, "get-godot"), /On Windows, Genex downloads Godot itself/);
    assert.deepEqual(fixture.editor.opened, []);
    assert.equal((await action(fixture, "status")).windows, true);
  });
});

describe("Godot on Windows: jobs in Genex's sandbox", () => {
  it("imports and checks as sandbox jobs of Genex's own Godot, reading Godot's Windows output", async () => {
    const check = windowsWords(await godotOutput("check-parse-errors.log"));
    const fixture = await windowsProject({
      sandbox: (request) => ({ stderr: request.args.includes("-s") ? check : "" }),
    });
    const answer = await tool(fixture, GodotTool.Check);
    assert.equal(answer.ok, false);
    assert.equal(
      (answer.errors as string[])[0],
      'bad.gd:3: Parse Error: Cannot assign a value of type "String" as "int".',
    );
    assert.match(String(answer.summary), /Loaded 6/);
    const own = path.join(fixture.root, OWN_GODOT);
    const [imported, checked] = fixture.requests;
    assert.deepEqual(imported, {
      program: own,
      args: ["--headless", "--path", fixture.project, "--import"],
      reads: [path.dirname(own)],
      writes: [fixture.project],
      timeoutMs: imported?.timeoutMs,
    });
    assert.deepEqual(checked?.reads, [path.dirname(own), SCRIPTS]);
    assert.deepEqual(checked?.args.slice(-2), ["-s", path.join(SCRIPTS, "genex_check.gd")]);
  });

  it("stages a capture's stills in the project's .godot, copies them out and removes the stage", async () => {
    let staged = "";
    const fixture = await windowsProject({
      sandbox: async (request) => {
        if (!request.args.includes("--position")) return {};
        staged = path.dirname(playArg({ args: request.args } as never, "out"));
        return { stdout: windowsWords(await capturing(["HeroCamera"])({ args: request.args } as never)) };
      },
    });
    const answer = await tool(fixture, GodotTool.Screenshot);
    assert.deepEqual(answer.shots, ["HeroCamera"]);
    assert.equal((answer.images as unknown[]).length, 1);
    assert.equal(
      path.dirname(path.dirname(staged)).startsWith(path.join(fixture.project, ".godot", "genex-jobs")),
      true,
    );
    const capture = fixture.requests.find((request) => request.args.includes("--position"));
    assert.deepEqual(capture?.writes, [fixture.project]);
    assert.deepEqual(await readdir(path.join(fixture.project, ".godot", "genex-jobs")), []);
  });

  it("makes the class reference in a staged folder and keeps it in the plugin's storage", async () => {
    const fixture = await windowsProject({
      sandbox: async (request) => {
        const at = request.args.indexOf("--doctool");
        if (at < 0) return {};
        const classes = path.join(request.args[at + 1] ?? "", "doc", "classes");
        await mkdir(classes, { recursive: true });
        await writeFile(path.join(classes, "Node.xml"), '<class name="Node" inherits="Object"></class>');
        return {};
      },
    });
    assert.match(String(await tool(fixture, GodotTool.ClassReference, { query: "Node" })), /class Node extends Object/);
    const doctool = fixture.requests.find((request) => request.args.includes("--doctool"));
    assert.deepEqual(doctool?.writes, [fixture.project]);
    assert.ok((await readdir(path.join(fixture.storage, "reference"))).length > 0);
  });

  it("puts the person's Web template in the sandbox user's own Godot data folder before a web export", async () => {
    const seen: string[] = [];
    const fixture = await windowsProject({
      sandbox: async (asked) => {
        const copy = asked.args.find((arg) => arg.startsWith("from="));
        if (copy) seen.push(await readFile(copy.slice("from=".length), "utf8"));
        if (!asked.args.includes("--export-release")) return {};
        const page = asked.args.at(-1) ?? "";
        for (const name of ["index.html", "index.pck"]) await writeFile(path.join(path.dirname(page), name), name);
        return {};
      },
    });
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    await mkdir(templates, { recursive: true });
    await writeFile(path.join(templates, "web_nothreads_release.zip"), "zip");
    assert.match(String(await tool(fixture, GodotTool.WebExport)), /Exported the game for the web/);
    const copy = fixture.requests.find((request) => request.args.some((arg) => arg.startsWith("from=")));
    const exported = fixture.requests.find((request) => request.args.includes("--export-release"));
    assert.deepEqual(seen, ["zip"], "the template was in the project's stage while the copy ran");
    assert.equal(copy?.args.at(-1), "to=Godot/export_templates/4.7.2.stable/web_nothreads_release.zip");
    assert.equal(copy?.args[copy.args.indexOf("-s") + 1], path.join(SCRIPTS, "genex_data.gd"));
    assert.equal(
      fixture.requests.indexOf(copy as PluginSandboxRunArgs) <
        fixture.requests.indexOf(exported as PluginSandboxRunArgs),
      true,
    );
    assert.deepEqual(exported?.writes, [fixture.project, path.join(fixture.gameDir, "web")]);
    assert.deepEqual(await readdir(path.join(fixture.project, ".godot", "genex-jobs")), []);
  });

  it("passes a Stop on to the sandbox and starts nothing after it", async () => {
    const stop = new AbortController();
    let holding = false;
    const fixture = await windowsProject({
      sandbox: () => {
        if (!holding) return {};
        stop.abort();
        return { state: "running" };
      },
    });
    holding = true;
    await assert.rejects(tool(fixture, GodotTool.RunScene, {}, { signal: stop.signal }));
    assert.deepEqual(fixture.stopped, ["job-1"]);
    assert.equal(fixture.requests.length, 1);
  });

  it("names why the sandbox didn't start Godot", async () => {
    const fixture = await windowsProject({ sandbox: () => ({ state: "failed", reason: "ENOENT" }) });
    await assert.rejects(tool(fixture, GodotTool.RunScene), /Genex's sandbox didn't start Godot \(ENOENT\)/);
  });
});

describe("Godot on Windows: the person's editor", () => {
  it("opens the project in Genex's own Godot as a window of its own", async () => {
    const fixture = await windowsProject();
    await action(fixture, "open-editor");
    assert.deepEqual(fixture.editor.opened, [
      {
        command: path.join(fixture.root, OWN_GODOT),
        args: ["--path", fixture.project, "--editor"],
        detached: true,
      },
    ]);
  });

  it("knows the editor that has the project open by its Windows command line, whatever its slashes and case", async () => {
    const fixture = await windowsProject();
    const project = fixture.project.replaceAll(path.sep, "/").toUpperCase();
    fixture.editor.lines.push(`Godot_v4.7.2-stable_win64.exe --path ${project} --editor`);
    assert.equal((await action(fixture, "status")).editorOpen, true);
    fixture.editor.lines.splice(0, 1, `Godot_v4.7.2-stable_win64.exe --headless --path ${project} --import`);
    assert.equal((await action(fixture, "status")).editorOpen, false);
  });
});

describe("Godot on Windows: Genex multiplayer's native part", () => {
  it("unpacks the Colyseus release with Windows's own tar, never one on the PATH", () => {
    const entries = ["addons/colyseus/plugin.cfg"];
    assert.deepEqual(unzipCall("C:\\s\\release.zip", entries, "C:\\s\\unpacked", "win32", { SystemRoot: "D:\\Win" }), {
      command: "D:\\Win\\System32\\tar.exe",
      args: ["-xf", "C:\\s\\release.zip", "-C", "C:\\s\\unpacked", ...entries],
    });
    for (const env of [{}, { SystemRoot: "Windows" }])
      assert.equal(unzipCall("z", entries, "u", "win32", env).command, "C:\\Windows\\System32\\tar.exe");
    assert.deepEqual(unzipCall("/s/release.zip", entries, "/s/unpacked", "darwin"), {
      command: "/usr/bin/unzip",
      args: ["-q", "-o", "/s/release.zip", ...entries, "-d", "/s/unpacked"],
    });
  });
});
