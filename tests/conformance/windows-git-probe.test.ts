/** Temporary Windows probe for W13/W14/W23; removed before the PR leaves draft. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { hostGitEnv } from "../../src/substrate/git-policy.ts";
import { SnapshotEngine } from "../../src/substrate/snapshots.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { sessionFileResolver } from "../../src/substrate/engines/local-session-tools.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { tmpDir } from "../helpers/tmp.ts";

const flip = (p: string) => p.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));

it("probe: git config the host sees", async () => {
  const dir = await tmpDir();
  const env = hostGitEnv();
  const run = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" });
    } catch (e) {
      return `ERR ${(e as Error).message}`;
    }
  };
  console.log("PROBE git version", run(["--version"]));
  console.log("PROBE config (host env)", run(["config", "--show-origin", "--show-scope", "--list"]));
  console.log(
    "PROBE config (ambient)",
    execFileSync("git", ["config", "--show-origin", "--show-scope", "--list"], { encoding: "utf8" }),
  );
  console.log("PROBE cwd", process.cwd(), "tmp", dir);
});

it("probe W14: a restore puts an LF file back as LF", async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, "a.js"), "one\ntwo\n");
  const engine = new SnapshotEngine([{ name: "game", dir }]);
  await engine.init();
  const before = await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" });
  await writeFile(path.join(dir, "a.js"), "changed\n");
  await engine.restore(before, { gameWorkspace: "game" });
  const bytes = await readFile(path.join(dir, "a.js"), "utf8");
  console.log("PROBE W14 restored", JSON.stringify(bytes));
  assert.equal(bytes, "one\ntwo\n");
});

it("probe W14b: a repo with text=auto", async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, ".gitattributes"), "* text=auto\n");
  await writeFile(path.join(dir, "a.js"), "one\ntwo\n");
  const engine = new SnapshotEngine([{ name: "game", dir }]);
  await engine.init();
  const before = await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" });
  await writeFile(path.join(dir, "a.js"), "changed\n");
  await engine.restore(before, { gameWorkspace: "game" });
  console.log("PROBE W14b restored", JSON.stringify(await readFile(path.join(dir, "a.js"), "utf8")));
});

it("probe W23: a snapshot of a path over 260 characters restores", async () => {
  const dir = await tmpDir();
  const deep = path.join(dir, ...Array.from({ length: 8 }, (_, i) => `folder-with-a-long-name-${i}-xxxxxxxx`));
  await mkdir(deep, { recursive: true });
  const file = path.join(deep, "a-file-name-that-pushes-the-path-past-max-path.js");
  console.log("PROBE W23 length", file.length);
  await writeFile(file, "deep\n");
  const engine = new SnapshotEngine([{ name: "game", dir }]);
  await engine.init();
  const before = await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" });
  await writeFile(file, "changed\n");
  await engine.restore(before, { gameWorkspace: "game" });
  assert.equal(await readFile(file, "utf8"), "deep\n");
});

it("probe W13: containment of a differently cased spelling", async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, "a.js"), "x");
  console.log("PROBE W13 realpath of flipped", await realpath(flip(dir)).catch((e) => `ERR ${e.code}`));
  console.log("PROBE W13 isInside", isInside(dir, path.join(flip(dir), "a.js")));
  const resolve = sessionFileResolver({
    cwd: dir,
    readRoots: [dir],
    forbidden: [],
    deniedWrites: [],
    readonly: false,
    ownership: undefined,
  });
  const written = await resolve(path.join(flip(dir), "a.js"), true).catch((e) => `ERR ${(e as Error).message}`);
  console.log("PROBE W13 write via flipped", written);
  assert.equal(written, path.join(dir, "a.js"));
});
