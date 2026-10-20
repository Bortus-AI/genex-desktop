/**
 * The launch that moves Genex's data: the files go to the new folder, the record says where they
 * are (or why they are not), and what pointed into the old folder points into the new one: the
 * library's absolute folders, and every build copy's Git worktree, whether its repository stayed
 * (a game in the games folder) or moved too (the harness's own). A move cut short carries on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_FOLDER_FILE, readDataFolderRecord, writeDataFolderRecord } from "../../src/main/data-folder.ts";
import { removeLeftover, runDataMove } from "../../src/main/data-move-launch.ts";
import { DataFolderProblem, type DataMoveProgress } from "../../src/shared/data-folder.ts";
import { moveData } from "../../src/substrate/data-move.ts";
import { rebasePaths } from "../../src/substrate/data-relink.ts";
import { samePath } from "../../src/substrate/paths.ts";
import { gitFile } from "../helpers/git.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const COMMITTER = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await gitFile(["-C", dir, ...args], { env: { ...process.env, ...COMMITTER } });
  return String(stdout);
}

/** Whether `repo` lists a worktree at `dir` (Git spells it with forward slashes on Windows). */
async function listsWorktree(repo: string, dir: string): Promise<boolean> {
  const listed = (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  return listed.some((at) => samePath(at, dir));
}

/** A repository with one commit, and a worktree of it at `worktree`. */
async function repoWithCopy(repo: string, worktree: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await writeFile(path.join(repo, "main.js"), "console.log(1)\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "first");
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, "worktree", "add", "-q", "--detach", worktree);
}

/** Genex's default data folder with the record, a library index, a game copy kept inside and two build copies. */
async function machine(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await tmpDir("data-launch-"));
  t.after(() => removeTree(root));
  const from = path.join(root, "AppData", "Genex");
  const to = path.join(root, "D", "Genex");
  const game = path.join(root, "AI Games", "Racer");
  const keptCopy = path.join(from, "opened-copies", "Puzzle");
  await mkdir(to, { recursive: true });
  await repoWithCopy(game, path.join(from, "scratch", "autopilot", "run-1"));
  await repoWithCopy(path.join(from, "workspaces", "harness"), path.join(from, "scratch", "self-edit", "check-1"));
  await mkdir(keptCopy, { recursive: true });
  await writeFile(
    path.join(from, "projects.json"),
    JSON.stringify({ version: 1, aliases: { Racer: game, Puzzle: keptCopy }, presentation: { [keptCopy]: {} } }),
  );
  await writeDataFolderRecord(from, { moveTo: to });
  return { root, from, to, game, keptCopy };
}

const ACROSS_VOLUMES: typeof moveData = (plan, options) =>
  moveData(plan, { ...options, sameVolume: async () => false, freeBytes: async () => Number.MAX_SAFE_INTEGER });

function deps(m: { from: string; to: string }, move?: typeof moveData) {
  const progress: DataMoveProgress[] = [];
  const log: string[] = [];
  return {
    progress,
    log,
    deps: {
      from: m.from,
      to: m.to,
      defaultDir: m.from,
      progress: (p: DataMoveProgress) => progress.push(p),
      log: (line: string) => log.push(line),
      ...(move ? { move } : {}),
    },
  };
}

for (const [label, move] of [
  ["on one volume", undefined],
  ["across volumes", ACROSS_VOLUMES],
] as const) {
  test(`a move ${label} records the new folder and leaves every build copy working`, async (t) => {
    const m = await machine(t);
    const run = deps(m, move);
    const outcome = await runDataMove(run.deps);
    assert.equal(outcome.moved, true);
    assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to });
    assert.deepEqual(await readdir(m.from), [DATA_FOLDER_FILE], "only the record stays behind");

    const index = JSON.parse(await readFile(path.join(m.to, "projects.json"), "utf8"));
    const movedCopy = path.join(m.to, "opened-copies", "Puzzle");
    assert.deepEqual(index.aliases, { Racer: m.game, Puzzle: movedCopy });
    assert.deepEqual(Object.keys(index.presentation), [movedCopy]);

    const runCopy = path.join(m.to, "scratch", "autopilot", "run-1");
    const selfEdit = path.join(m.to, "scratch", "self-edit", "check-1");
    assert.equal(await git(runCopy, "status", "--porcelain"), "");
    assert.equal(await git(selfEdit, "status", "--porcelain"), "");
    assert.ok(await listsWorktree(m.game, runCopy), "the game's repository knows where its copy is");
    assert.ok(await listsWorktree(path.join(m.to, "workspaces", "harness"), selfEdit), "so does the moved harness");
    // A prune (as a clean-up runs) must keep the moved copies: their repositories know where they are.
    await git(m.game, "worktree", "prune");
    assert.ok(await listsWorktree(m.game, runCopy), "the game's repository knows where its copy is");
  });
}

test("a copy reports its progress toward the new folder", async (t) => {
  const m = await machine(t);
  const run = deps(m, ACROSS_VOLUMES);
  await runDataMove(run.deps);
  assert.ok(run.progress.every((p) => p.to === m.to));
  const last = run.progress.at(-1);
  assert.ok(last && last.total > 0 && last.done === last.total);
});

test("a move that cannot happen leaves the data where it was and records why", async (t) => {
  const m = await machine(t);
  await writeFile(path.join(m.to, "someone-else.txt"), "x");
  const before = await readdir(m.from);
  const run = deps(m, ACROSS_VOLUMES);
  assert.deepEqual(await runDataMove(run.deps), { moved: false, problem: DataFolderProblem.NotEmpty });
  assert.deepEqual(readDataFolderRecord(m.from), { failed: { to: m.to, problem: DataFolderProblem.NotEmpty } });
  assert.deepEqual(await readdir(m.from), before);
  assert.deepEqual(await readdir(m.to), ["someone-else.txt"]);
});

test("a copy cut short carries on: half-copied entries are copied again, the rest copied once", async (t) => {
  const m = await machine(t);
  // The earlier attempt recorded its entries, copied part of `scratch`, then Genex closed.
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
  });
  await mkdir(path.join(m.to, "scratch", "autopilot"), { recursive: true });
  await writeFile(path.join(m.to, "scratch", "autopilot", "half.bin"), "partial");
  await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to });
  assert.deepEqual((await readdir(m.to)).sort(), ["opened-copies", "projects.json", "scratch", "workspaces"]);
  assert.deepEqual(await readdir(path.join(m.to, "scratch", "autopilot")), ["run-1"], "the half copy is gone");
});

test("renames cut short carry on: what was renamed stays, the rest follows", async (t) => {
  const m = await machine(t);
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
  });
  const { rename } = await import("node:fs/promises");
  await rename(path.join(m.from, "opened-copies"), path.join(m.to, "opened-copies"));
  await runDataMove(deps(m).deps);
  assert.deepEqual((await readdir(m.to)).sort(), ["opened-copies", "projects.json", "scratch", "workspaces"]);
  assert.deepEqual(await readdir(m.from), [DATA_FOLDER_FILE]);
});

test("a later launch removes only the entries the move recorded and could not remove", async (t) => {
  const m = await machine(t);
  await writeFile(path.join(m.from, "not-ours.txt"), "keep");
  await writeDataFolderRecord(m.from, { dir: m.to, leftover: { dir: m.from, entries: ["scratch", "../escape"] } });
  const log: string[] = [];
  await removeLeftover(m.from, m.to, (line) => log.push(line));
  const left = (await readdir(m.from)).sort();
  assert.ok(!left.includes("scratch"));
  assert.ok(left.includes("not-ours.txt") && left.includes("workspaces"));
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to }, "a name that is a path is never read back");
});

test("paths keep their place when the data moves: inside the old folder only, keys too", () => {
  const from = path.resolve("/old/Genex");
  const to = path.resolve("/new/Genex");
  assert.deepEqual(
    rebasePaths(
      {
        a: path.join(from, "x"),
        b: path.resolve("/old/GenexOther/y"),
        c: "relative/x",
        list: [from, 3, null],
        [path.join(from, "k")]: true,
      },
      from,
      to,
    ),
    {
      a: path.join(to, "x"),
      b: path.resolve("/old/GenexOther/y"),
      c: "relative/x",
      list: [to, 3, null],
      [path.join(to, "k")]: true,
    },
  );
});
