/**
 * Moving the contents of Genex's data folder to another folder (Settings → Storage). On one volume
 * each entry is renamed, and a failure renames the moved ones back. Across volumes everything is
 * copied first, with progress, and the originals are removed only once every copy is in place: a
 * failure part-way removes what was copied and leaves the old folder whole. Links are copied as
 * links and never followed, so a link out of the folder never pulls its target in or lets the move
 * write through it; a link the new drive cannot hold is left out, since Genex makes its links again.
 */
import { constants, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, statfs, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DataFolderProblem } from "../shared/data-folder.ts";
import { errorMessage } from "../shared/errors.ts";
import { isInside } from "./paths.ts";

/** How many files are copied at once: Windows copies small files faster several at a time. */
const COPY_CONCURRENCY = 16;
/** How often a rename or removal is tried while another program briefly holds the file. */
const BUSY_ATTEMPTS = 6;
/** The first wait after a busy file; each next wait doubles. */
const BUSY_FIRST_WAIT_MS = 100;
/** Space kept free on the new drive beyond the files themselves. */
export const SPARE_BYTES = 512 * 1024 * 1024;

/** Error codes that mean another program holds the file for now. */
const BUSY_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);

/** What to move: every entry of `from` but the ones it keeps, into `to`. */
export interface DataMovePlan {
  from: string;
  to: string;
  /** Names in `from` that stay where they are (the record saying where the data went). */
  keep: readonly string[];
  /** Names `to` may already hold (that record, when the data moves back into the default folder). */
  allowInTarget?: readonly string[];
  /**
   * The entries an earlier attempt set out to move and did not finish (Genex closed part-way): the
   * move carries on, keeping what that attempt renamed and copying again what it half copied.
   */
  resume?: readonly string[];
}

/** How the entries got there: renamed on one volume, or copied across volumes (originals still there). */
export const DataMoveMode = {
  Renamed: "renamed",
  Copied: "copied",
} as const;
export type DataMoveMode = (typeof DataMoveMode)[keyof typeof DataMoveMode];

/** A finished move: how, and the entries it moved. */
export interface DataMoved {
  mode: DataMoveMode;
  entries: string[];
  bytes: number;
}

/** Called as bytes are copied: `done` of `total`; `total` is 0 while the files are being counted. */
export type DataMoveProgressListener = (done: number, total: number) => void;

/** What a failed move could not put back: entries left only in the new folder, and copies there it could not remove. */
export interface DataMoveRemains {
  /** Entries only in the new folder: the old folder is not whole until the move carries on. */
  stranded: readonly string[];
  /** Copies in the new folder (their originals are whole) that could not be removed yet. */
  left: readonly string[];
}

/** A move that did not happen, with the problem Settings names, the error behind it and what it could not put back. */
export class DataMoveError extends Error {
  readonly problem: DataFolderProblem;
  readonly stranded: readonly string[];
  readonly left: readonly string[];
  constructor(problem: DataFolderProblem, detail: string, remains: DataMoveRemains = { stranded: [], left: [] }) {
    super(detail);
    this.name = "DataMoveError";
    this.problem = problem;
    this.stranded = remains.stranded;
    this.left = remains.left;
  }
}

/** The problem an operating system error is, for Settings. */
export function moveProblemOf(error: unknown): DataFolderProblem {
  if (error instanceof DataMoveError) return error.problem;
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  if (code === "ENOSPC") return DataFolderProblem.NoSpace;
  if (code === "ENOENT") return DataFolderProblem.Missing;
  if (BUSY_CODES.has(code)) return DataFolderProblem.InUse;
  return DataFolderProblem.Failed;
}

/** The entries `plan` moves, in name order. */
async function entriesToMove(plan: DataMovePlan): Promise<string[]> {
  const keep = new Set(plan.keep);
  return (await readdir(plan.from)).filter((name) => !keep.has(name)).sort();
}

/** Bytes of the files under `names` in `dir`; links count nothing and are not followed. */
async function measureEntries(dir: string, names: readonly string[]): Promise<number> {
  let bytes = 0;
  const walk = async (entry: string): Promise<void> => {
    const info = await lstat(entry).catch(() => null);
    if (!info) return;
    if (info.isFile()) bytes += info.size;
    if (!info.isDirectory()) return;
    for (const name of await readdir(entry).catch(() => [])) await walk(path.join(entry, name));
  };
  for (const name of names) await walk(path.join(dir, name));
  return bytes;
}

/** Bytes of the files under `dir`, leaving out `keep` at its top; links count nothing. */
export async function measureData(dir: string, keep: readonly string[] = []): Promise<number> {
  const skip = new Set(keep);
  return measureEntries(
    dir,
    (await readdir(dir)).filter((name) => !skip.has(name)),
  );
}

/** Refuse a plan whose folders overlap, or whose target holds anything but what it may and what an earlier attempt left. */
async function checkPlan(plan: DataMovePlan, entries: readonly string[]): Promise<void> {
  if (isInside(plan.from, plan.to) || isInside(plan.to, plan.from))
    throw new DataMoveError(DataFolderProblem.Overlaps, `${plan.to} overlaps ${plan.from}`);
  const allowed = new Set(plan.allowInTarget ?? []);
  const earlier = new Set(plan.resume ?? []);
  const there = await readdir(plan.to);
  const clash = there.find((name) => !earlier.has(name) && (!allowed.has(name) || entries.includes(name)));
  if (clash !== undefined) throw new DataMoveError(DataFolderProblem.NotEmpty, `${plan.to} already holds ${clash}`);
}

/** Whether `file` exists, links included. */
async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/**
 * The entries still to move after an earlier attempt: one only in the new folder was renamed and
 * is done; one in both was half copied, and its copy goes so it is copied again.
 */
async function stillToMove(plan: DataMovePlan, entries: readonly string[]): Promise<string[]> {
  if (!plan.resume?.length) return [...entries];
  const pending: string[] = [];
  for (const name of entries) {
    if (!(await present(path.join(plan.from, name)))) continue;
    if (await present(path.join(plan.to, name))) {
      const [left] = await removeEntries(plan.to, [name]);
      if (left !== undefined) throw new DataMoveError(DataFolderProblem.InUse, `${path.join(plan.to, left)} is in use`);
    }
    pending.push(name);
  }
  return pending;
}

/** Run `step` again while the file is busy, waiting longer each time. */
async function whenFree<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!BUSY_CODES.has(code) || attempt >= BUSY_ATTEMPTS) throw error;
      await sleep(BUSY_FIRST_WAIT_MS * 2 ** (attempt - 1));
    }
  }
}

/** Whether `from` and `to` are on one volume, where a rename moves an entry. */
async function sameVolume(from: string, to: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(from), stat(to)]);
  return a.dev === b.dev;
}

/** Rename each pending entry into the new folder; a failure is put back by {@link putBack}. */
async function renameAll(plan: DataMovePlan, pending: readonly string[]): Promise<void> {
  for (const name of pending) await whenFree(() => rename(path.join(plan.from, name), path.join(plan.to, name)));
}

/**
 * After a failure, put the old folder back together for every entry the move owns (`owned`: the
 * ones it set out to move once the target was checked, or an earlier attempt's): one only in the
 * new folder is renamed back, a copy beside its original is removed. Names what it could not.
 */
async function putBack(plan: DataMovePlan, owned: readonly string[]): Promise<DataMoveRemains> {
  const stranded: string[] = [];
  const left: string[] = [];
  for (const name of owned) {
    const moved = path.join(plan.to, name);
    const original = path.join(plan.from, name);
    if (!(await present(moved))) continue;
    if (await present(original)) {
      left.push(...(await removeEntries(plan.to, [name])));
      continue;
    }
    await whenFree(() => rename(moved, original)).catch(() => {});
    if (!(await present(original))) stranded.push(name);
  }
  return { stranded, left };
}

/** A small pool: at most `size` of the calls it runs are in flight at once. */
function pool(size: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (run) => {
    if (active >= size) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** What one copy shares: the pool, and the bytes done so far. */
interface CopyRun {
  slot: <T>(run: () => Promise<T>) => Promise<T>;
  copied(bytes: number): void;
}

/** Copy one link as a link (its target as it was, repointed after the move); the new drive may refuse one, which Genex makes again. */
async function copyLink(source: string, target: string): Promise<void> {
  const to = await readlink(source);
  const pointsAtFolder = await stat(source).then(
    (info) => info.isDirectory(),
    () => false,
  );
  await symlink(to, target, pointsAtFolder ? "junction" : "file").catch(() => {});
}

/** Copy a file, keeping when it last changed (Git reads that to tell a changed file). */
async function copyOneFile(source: string, target: string, info: Stats, run: CopyRun): Promise<void> {
  await run.slot(async () => {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await utimes(target, info.atime, info.mtime);
  });
  run.copied(info.size);
}

/**
 * Copy `source` to `target`, which does not exist yet. Folders are walked one at a time and each
 * folder's files copied through the pool, so a deep tree never opens more than the pool's files;
 * sockets and pipes carry nothing and are left out.
 */
async function copyTree(source: string, target: string, run: CopyRun): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) return copyLink(source, target);
  if (info.isFile()) return copyOneFile(source, target, info, run);
  if (!info.isDirectory()) return;
  await mkdir(target);
  const files: Promise<void>[] = [];
  const walked = await copyChildren(source, target, run, files).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  // Every started copy settles before this folder reports, so a failure never races a removal.
  const failed = (await Promise.allSettled(files)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (walked) throw walked.error;
  if (failed) throw failed.reason;
}

/** Walk `source`'s entries: folders and links in turn, files handed to the pool through `files`. */
async function copyChildren(source: string, target: string, run: CopyRun, files: Promise<void>[]): Promise<void> {
  for (const name of await readdir(source)) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const child = await lstat(from);
    if (child.isFile()) files.push(copyOneFile(from, to, child, run));
    else await copyTree(from, to, run);
  }
}

/** Free bytes on the volume holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

/** Copy each entry with progress; a failure's copies are removed by {@link putBack}. */
async function copyAll(
  plan: DataMovePlan,
  entries: readonly string[],
  total: number,
  onProgress: DataMoveProgressListener,
): Promise<void> {
  let done = 0;
  const run: CopyRun = {
    slot: pool(COPY_CONCURRENCY),
    copied(bytes) {
      done += bytes;
      onProgress(done, total);
    },
  };
  for (const name of entries) await copyTree(path.join(plan.from, name), path.join(plan.to, name), run);
}

/** How a move reports and sees the disk; each default is the real one. */
export interface DataMoveOptions {
  onProgress?: DataMoveProgressListener;
  /** Whether a rename can move an entry from one folder to the other. */
  sameVolume?: (from: string, to: string) => Promise<boolean>;
  /** Free bytes where the copies go. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Told the entries the move sets out to move before it changes anything, to record them (see `resume`). */
  onPlanned?: (entries: readonly string[]) => Promise<void>;
}

/**
 * Move every entry of `plan.from` but the kept ones into `plan.to`. Copied entries leave their
 * originals for {@link removeEntries}, once the caller has recorded that the data is in its new
 * folder. Throws {@link DataMoveError} after putting back what it can: `plan.from` is whole again
 * unless the error names entries `stranded` in the new folder, which a later attempt carries on
 * with (`resume`), and copies it could not remove are named `left`.
 */
export async function moveData(plan: DataMovePlan, options: DataMoveOptions = {}): Promise<DataMoved> {
  let owned: readonly string[] = plan.resume ?? [];
  try {
    const entries = plan.resume?.length ? [...plan.resume] : await entriesToMove(plan);
    await checkPlan(plan, entries);
    // From here the target was checked: everything the move sets out to move is its own to put back.
    owned = entries;
    await options.onPlanned?.(entries);
    return await carryOut(plan, entries, options);
  } catch (error) {
    throw new DataMoveError(moveProblemOf(error), errorMessage(error), await putBack(plan, owned));
  }
}

/** Rename or copy what an earlier attempt left to move; the caller puts back after a failure. */
async function carryOut(plan: DataMovePlan, entries: readonly string[], options: DataMoveOptions): Promise<DataMoved> {
  const onProgress = options.onProgress ?? (() => {});
  const pending = await stillToMove(plan, entries);
  if (await (options.sameVolume ?? sameVolume)(plan.from, plan.to)) {
    await renameAll(plan, pending);
    return { mode: DataMoveMode.Renamed, entries: [...entries], bytes: 0 };
  }
  onProgress(0, 0);
  const total = await measureEntries(plan.from, pending);
  if ((await (options.freeBytes ?? freeBytes)(plan.to)) < total + SPARE_BYTES)
    throw new DataMoveError(DataFolderProblem.NoSpace, `${total} bytes do not fit in ${plan.to}`);
  onProgress(0, total);
  await copyAll(plan, pending, total, onProgress);
  return { mode: DataMoveMode.Copied, entries: [...entries], bytes: total };
}

/** Remove `entries` from `dir`, waiting out busy files; the names it could not remove. */
export async function removeEntries(dir: string, entries: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const name of entries) {
    await whenFree(() => rm(path.join(dir, name), { recursive: true, force: true })).catch(() => left.push(name));
  }
  return left;
}
