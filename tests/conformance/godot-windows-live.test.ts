/**
 * Godot on Windows for real (probe): what Godot's Windows build does under Genex's process sandbox.
 * Windows with a provisioned sandbox and STUDIO_NETWORK_TESTS=1 only.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { killProcessTree } from "../../src/substrate/process-tree.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { windowsProcesses } from "../../src/substrate/windows-processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const SKIP =
  (process.platform !== "win32" ||
    process.env.GENEX_WINDOWS_SANDBOX !== "ready" ||
    process.env.STUDIO_NETWORK_TESTS !== "1") &&
  "Windows with a provisioned sandbox and STUDIO_NETWORK_TESTS=1 only";
const ZIP = "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_win64.exe.zip";
const EXE = "Godot_v4.7.2-stable_win64.exe";
const CONSOLE = "Godot_v4.7.2-stable_win64_console.exe";
const PROJECT = `config_version=5\n\n[application]\n\nconfig/name="Probe"\nrun/main_scene="res://main.tscn"\n`;
const SCENE = `[gd_scene format=3]\n\n[node name="Main" type="Node3D"]\n\n[node name="Camera3D" type="Camera3D" parent="."]\n`;
const SHOT = `extends SceneTree
var frames := 0
func _process(_d):
\tframes += 1
\tif frames == 20:
\t\tvar img := root.get_viewport().get_texture().get_image()
\t\tprint("SHOT ", img.get_width(), "x", img.get_height(), " ", img.save_png(OS.get_environment("SHOT_OUT")))
\t\tquit()
\treturn false
`;

let root: string;
let godot: string;
let game: string;
let project: string;
let sandbox: ProcessSandbox;

const log = (label: string, value: unknown) => console.log(`[probe] ${label}: ${JSON.stringify(value)}`);
const tail = (text: string) => text.slice(-1500);

before(async () => {
  if (SKIP) return;
  root = await tmpDir("gwin-");
  godot = path.join(root, "godot");
  game = path.join(root, "game");
  project = path.join(game, "godot");
  await mkdir(godot, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "project.godot"), PROJECT);
  await writeFile(path.join(project, "main.tscn"), SCENE);
  await writeFile(path.join(project, "shot.gd"), SHOT);
  const zip = path.join(root, "godot.zip");
  const response = await fetch(ZIP);
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  await run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", godot]);
  log("unpacked", await readdir(godot));
  sandbox = await ProcessSandbox.create({
    writableRoots: [game],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    readableRoots: [godot],
  });
});

after(async () => {
  if (SKIP) return;
  await sandbox?.dispose();
});

describe("Godot on Windows, facts", { skip: SKIP, timeout: 15 * 60_000 }, () => {
  it("signature and --version as the runner's user", async () => {
    const ps = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-AuthenticodeSignature '${path.join(godot, EXE)}' | Format-List Status,StatusMessage,SignerCertificate`,
    ]).catch((e: unknown) => ({ stdout: String(e), stderr: "" }));
    log("authenticode", ps.stdout);
    for (const exe of [EXE, CONSOLE]) {
      const out = await run(path.join(godot, exe), ["--version"], { timeout: 30_000 }).catch((e: unknown) => ({
        stdout: `ERR ${String(e)}`,
        stderr: "",
      }));
      log(`version ${exe}`, out);
    }
  });

  it("runs in the sandbox: env, version, import, check", async () => {
    const env = await sandbox.run({
      command: 'echo "APPDATA=$APPDATA LOCALAPPDATA=$LOCALAPPDATA USERPROFILE=$USERPROFILE HOME=$HOME"; whoami',
      cwd: game,
      timeoutMs: 60_000,
    });
    log("sandbox env", { out: env.stdout, err: env.stderr, code: env.code });
    for (const exe of [EXE, CONSOLE]) {
      const file = path.join(godot, exe).replaceAll("\\", "/");
      const version = await sandbox.run({ command: `'${file}' --headless --version`, cwd: game, timeoutMs: 60_000 });
      log(`sandbox version ${exe}`, { out: version.stdout, err: tail(version.stderr), code: version.code });
      const started = Date.now();
      const imported = await sandbox.run({
        command: `'${file}' --headless --path '${project.replaceAll("\\", "/")}' --import`,
        cwd: game,
        timeoutMs: 240_000,
      });
      log(`sandbox import ${exe}`, {
        ms: Date.now() - started,
        out: tail(imported.stdout),
        err: tail(imported.stderr),
        code: imported.code,
        timedOut: imported.timedOut,
      });
    }
    log("project after import", await readdir(project));
    const appdata = await sandbox.run({
      command: 'ls -la "$APPDATA/Godot" 2>&1 | head -20; ls -la "$LOCALAPPDATA/Godot" 2>&1 | head',
      cwd: game,
      timeoutMs: 60_000,
    });
    log("sandbox godot dirs", appdata.stdout);
  });

  it("draws a still in a window in the sandbox", async () => {
    const file = path.join(godot, EXE).replaceAll("\\", "/");
    for (const driver of ["", "--rendering-driver opengl3", "--rendering-driver d3d12"]) {
      const out = path.join(project, `shot${driver ? driver.split(" ")[1] : ""}.png`);
      const shot = await sandbox.run({
        command: `SHOT_OUT='${out.replaceAll("\\", "/")}' '${file}' ${driver} --position -10000,-10000 --resolution 320x180 --path '${project.replaceAll("\\", "/")}' -s res://shot.gd`,
        cwd: game,
        timeoutMs: 120_000,
      });
      const made = await stat(out).catch(() => null);
      log(`still ${driver || "default"}`, {
        size: made?.size ?? null,
        out: tail(shot.stdout),
        err: tail(shot.stderr),
        code: shot.code,
      });
    }
  });

  it("opens the editor as the runner's user and lists its command line", async () => {
    const exe = path.join(godot, EXE);
    const child = spawn(exe, ["--path", project, "--editor"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    await sleep(20_000);
    const rows = await windowsProcesses(["Godot%"]);
    log("processes", rows);
    for (const row of rows ?? []) await killProcessTree(row.pid);
    assert.ok(child.pid);
  });
});
