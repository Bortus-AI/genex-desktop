/**
 * After Genex's data moved to another folder: what named a place in the old folder names the same
 * place in the new one. The library's index and the games folder setting keep absolute folders
 * (a game Genex keeps a copy of lives in its data); and every build copy is a Git worktree whose
 * `.git` file names its repository's folder, while that repository names the copy's folder back.
 * Git's own `worktree repair` mends the second link once the first is right.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readJsonIfExists } from "./fsx.ts";
import { isInside } from "./paths.ts";
import { gitOrNull } from "./snapshots.ts";

/** The files at the data folder's top that keep absolute folders. */
export const PATH_KEEPING_FILES: readonly string[] = ["projects.json", "games-root.json"];
/** How deep under the data folder a build copy can sit (`scratch/autopilot/<run>/<seat>/…`). */
const WORKTREE_DEPTH = 6;
/** Folders a build copy never sits in, and which can hold many thousand entries. */
const NOT_WORKTREE_HOMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);
/** How a worktree's `.git` file names its repository's folder. */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/** `value` with every absolute path inside `from` moved to the same place inside `to`, keys included. */
export function rebasePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return rebasePath(value, from, to);
  if (Array.isArray(value)) return value.map((item) => rebasePaths(item, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [rebasePath(key, from, to), rebasePaths(item, from, to)]),
  );
}

function rebasePath(text: string, from: string, to: string): string {
  if (!path.isAbsolute(text) || !isInside(from, text)) return text;
  return path.join(to, path.relative(from, text));
}

/** Rewrite each path-keeping file in `dir` (the new data folder) whose paths pointed into `from`. */
export async function rebaseDataFiles(dir: string, from: string): Promise<string[]> {
  const changed: string[] = [];
  for (const name of PATH_KEEPING_FILES) {
    const file = path.join(dir, name);
    const value = await readJsonIfExists<unknown>(file).catch(() => null);
    if (value === null) continue;
    const rebased = rebasePaths(value, from, dir);
    if (JSON.stringify(rebased) === JSON.stringify(value)) continue;
    await atomicWriteText(file, `${JSON.stringify(rebased, null, 2)}\n`);
    changed.push(name);
  }
  return changed;
}

/** The build copies under `dir`: folders holding a `.git` file, not descending into one. */
export async function findWorktrees(dir: string, depth = WORKTREE_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, left: number): Promise<void> => {
    const names = await readdir(folder).catch((): string[] => []);
    if (
      names.includes(".git") &&
      (await lstat(path.join(folder, ".git")).then(
        (info) => info.isFile(),
        () => false,
      ))
    ) {
      found.push(folder);
      return;
    }
    if (left === 0) return;
    for (const name of names) {
      if (NOT_WORKTREE_HOMES.has(name)) continue;
      const child = path.join(folder, name);
      const isFolder = await lstat(child).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (isFolder) await walk(child, left - 1);
    }
  };
  await walk(dir, depth);
  return found.sort();
}

/**
 * Point each build copy under `dir` back at its repository: a `.git` file naming a repository that
 * moved too (the harness's own, a game Genex keeps a copy of) is rewritten to the new folder, then
 * Git repairs the repository's link to the copy. The copies Git could not repair.
 */
export async function repairWorktrees(dir: string, from: string): Promise<string[]> {
  const failed: string[] = [];
  for (const worktree of await findWorktrees(dir)) {
    const dotGit = path.join(worktree, ".git");
    const text = await readFile(dotGit, "utf8").catch(() => "");
    const named = GITDIR_LINE.exec(text)?.[1];
    if (!named) continue;
    const rebased = rebasePath(named, from, dir);
    if (rebased !== named) await atomicWriteText(dotGit, `gitdir: ${rebased}\n`);
    if ((await gitOrNull(worktree, ["worktree", "repair"])) === null) failed.push(worktree);
  }
  return failed;
}
