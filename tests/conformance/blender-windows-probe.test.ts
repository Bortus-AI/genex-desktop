// TEMPORARY probe for the Windows Blender work: what Blender does on a Windows runner, plain and
// under srt-win. Removed before the PR leaves draft.
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { it } from "node:test";
import { promisify } from "node:util";
import { BLENDER_WRAPPER_PY } from "../../src/plugins/blender/wrapper.ts";
import { mixedPath } from "../../src/substrate/windows-sandbox.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const exec = promisify(execFile);
const URL_ZIP = "https://download.blender.org/release/Blender5.2/blender-5.2.1-windows-x64.zip";

const MODEL_PY = `
import bpy
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.2, location=(0, 0, 0.6))
body = bpy.context.active_object
mat = bpy.data.materials.new("bark")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.25, 0.1, 1)
body.data.materials.append(mat)
`;
const GPU_PY = `
import gpu, sys
try:
    print("PROBE backend", gpu.platform.backend_type_get(), gpu.platform.renderer_get(), gpu.platform.version_get())
except Exception as e:
    print("PROBE gpu error", repr(e))
`;

const show = (label: string, r: { code?: unknown; stdout?: string; stderr?: string }) =>
  console.log(`=== ${label} code=${String(r.code)}\n--- stdout\n${(r.stdout ?? "").slice(-3000)}\n--- stderr\n${(r.stderr ?? "").slice(-3000)}`);

it("probe blender on windows", { skip: process.platform !== "win32", timeout: 20 * 60_000 }, async () => {
  const root = await tmpDir("bprobe-");
  const zip = path.join(root, "b.zip");
  const t0 = Date.now();
  const res = await fetch(URL_ZIP);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));
  console.log("downloaded", (await stat(zip)).size, Date.now() - t0, "ms");
  const t1 = Date.now();
  const unpacked = path.join(root, "rt");
  await mkdir(unpacked);
  await exec("C:\\Windows\\System32\\tar.exe", ["-xf", zip, "-C", unpacked], { maxBuffer: 1 << 26 });
  console.log("extracted", Date.now() - t1, "ms", await readdir(unpacked));
  const blender = path.join(unpacked, "blender-5.2.1-windows-x64", "blender.exe");
  const env = { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: "C:\\Windows\\System32" };
  const run = async (label: string, args: string[], options: object = {}) => {
    try {
      const r = await exec(blender, args, { timeout: 180_000, maxBuffer: 1 << 24, ...options });
      show(label, { code: 0, ...r });
    } catch (e) {
      show(label, e as never);
    }
  };
  await run("version minimal env", ["-b", "--version"], { env });
  await run("version empty env", ["-b", "--version"], { env: {} });
  await run("version full env", ["-b", "--version"]);
  const dir = path.join(root, "job");
  await mkdir(dir);
  await writeFile(path.join(dir, "wrapper.py"), BLENDER_WRAPPER_PY);
  await writeFile(path.join(dir, "model.py"), MODEL_PY);
  await writeFile(path.join(dir, "gpu.py"), GPU_PY);
  await run("gpu probe", ["-b", "--factory-startup", "--python", path.join(dir, "gpu.py")]);
  const jobArgs = (out: string) => [
    "-b",
    "--factory-startup",
    "-noaudio",
    "--python-exit-code",
    "1",
    "--python",
    path.join(dir, "wrapper.py"),
    "--",
    path.join(dir, "model.py"),
    path.join(dir, `${out}.glb`),
    path.join(dir, `${out}.png`),
    "tree",
    "--rig",
    "0",
  ];
  const t2 = Date.now();
  await run("wrapper plain", jobArgs("plain"));
  console.log("wrapper plain ms", Date.now() - t2, await readdir(dir));
  await run("wrapper plain vulkan", ["--gpu-backend", "vulkan", ...jobArgs("vk")]);
  console.log(await readdir(dir));

  const sandbox = await ProcessSandbox.create({
    writableRoots: [dir],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    readableRoots: [unpacked],
  });
  try {
    const q = (s: string) => shellQuote(s);
    const cmd = (args: string[]) => [q(mixedPath(blender)), ...args.map(q)].join(" ");
    let r = await sandbox.run({ command: cmd(["-b", "--version"]), cwd: dir, timeoutMs: 180_000 });
    show(`sandbox version sandboxed=${r.sandboxed}`, r);
    r = await sandbox.run({ command: cmd(["-b", "--factory-startup", "--python", path.join(dir, "gpu.py")]), cwd: dir, timeoutMs: 180_000 });
    show("sandbox gpu", r);
    const t3 = Date.now();
    r = await sandbox.run({ command: cmd(jobArgs("sbx")), cwd: dir, timeoutMs: 180_000 });
    show("sandbox wrapper", r);
    console.log("sandbox wrapper ms", Date.now() - t3, await readdir(dir));
    r = await sandbox.run({ command: `echo $HOME $TEMP $APPDATA; whoami; ls ${q(mixedPath(unpacked))}`, cwd: dir });
    show("sandbox env", r);
  } finally {
    await sandbox.dispose();
  }
});
