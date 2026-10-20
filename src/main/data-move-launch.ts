/**
 * The launch that moves Genex's data (Settings → Storage asked for it, then restarted Genex). It
 * runs before any of Genex starts, on a temp folder of Electron's own (`data-folder.ts`), so no
 * file in the old folder is open: the data moves, what pointed into the old folder is pointed at
 * the new one, the record says where the data is now, and the caller starts Genex again.
 *
 * A move that fails is put back and recorded with why, for Storage to say. One that could not be
 * put back (entries left only in the new folder) stays recorded as a move, so starting Genex again
 * carries it on rather than opening on half the data.
 *
 * Copies a move leaves behind (an old folder's originals another program held, a failed move's
 * copies) are listed and removed later, except a file changed after the copy was made: someone
 * edited it there, and it stays.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { DataFolderProblem, DataMoveProgress } from "../shared/data-folder.ts";
import { errorMessage } from "../shared/errors.ts";
import {
  type DataMoved,
  DataMoveError,
  DataMoveMode,
  moveData,
  moveProblemOf,
  removeEntries,
} from "../substrate/data-move.ts";
import { moveClaudeProjects, rebaseDataFiles, relinkLinks, repairWorktrees } from "../substrate/data-relink.ts";
import { samePath } from "../substrate/paths.ts";
import {
  DATA_FOLDER_FILE,
  type DataFolderRecord,
  type DataLeftover,
  readDataFolderRecord,
  writeDataFolderRecord,
} from "./data-folder.ts";

/** What the moving launch needs; the moves and repairs default to the real ones. */
export interface DataMoveLaunchDeps {
  from: string;
  to: string;
  /** Electron's default data folder, which holds the record. */
  defaultDir: string;
  /** The start window's progress. */
  progress(progress: DataMoveProgress): void;
  log(line: string): void;
  /** Make Genex's own Git the host's before the copies are repaired (Windows); false when there is none. */
  hostGit?: () => Promise<boolean>;
  move?: typeof moveData;
  /** The clock a copy's leftovers are stamped with. */
  now?: () => number;
}

/**
 * How a moving launch ended: moved; not moved, with everything back where it was; or `stranded`,
 * entries left only in the new folder, which the next start carries on with.
 */
export type DataMoveOutcome =
  | { moved: true; mode: DataMoved["mode"] }
  | { moved: false; problem: DataFolderProblem; stranded?: string[] };

type Log = (line: string) => void;

/** A failed move's own copies in a folder nobody uses yet: no change to them is anyone's edit. */
const NOBODY_EDITS = Number.MAX_SAFE_INTEGER;

/** The record's folder field for `dir`: absent for the default folder. */
function chosen(dir: string, defaultDir: string): Pick<DataFolderRecord, "dir"> {
  return samePath(dir, defaultDir) ? {} : { dir };
}

/** The record's leftovers with `added`, the field left out when there are none. */
function withLeftovers(
  existing: DataLeftover[] | undefined,
  added: DataLeftover[],
): Pick<DataFolderRecord, "leftover"> {
  const leftover = [...(existing ?? []), ...added];
  return leftover.length ? { leftover } : {};
}

/** Move the data, record where it went (or why it did not go), and repair what pointed into the old folder. */
export async function runDataMove(deps: DataMoveLaunchDeps): Promise<DataMoveOutcome> {
  const { from, to, defaultDir } = deps;
  const now = deps.now ?? Date.now;
  const report = (done: number, total: number) => deps.progress({ to, done, total });
  report(0, 0);
  // Old copies an earlier move left in the target go first: they would clash with the data coming in.
  await settleLeftovers(defaultDir, (dir) => samePath(dir, to), deps.log);
  const record = readDataFolderRecord(defaultDir);
  // A file in the old folder changed after this is someone's edit made while the copy ran: it stays.
  const startedAt = now();
  let moved: DataMoved;
  try {
    moved = await (deps.move ?? moveData)(
      {
        from,
        to,
        keep: samePath(from, defaultDir) ? [DATA_FOLDER_FILE] : [],
        allowInTarget: samePath(to, defaultDir) ? [DATA_FOLDER_FILE] : [],
        ...(record.moving ? { resume: record.moving } : {}),
      },
      {
        onProgress: report,
        onPlanned: (entries) => writeDataFolderRecord(defaultDir, { ...record, moveTo: to, moving: [...entries] }),
      },
    );
  } catch (error) {
    return failedMove(deps, error);
  }
  const copied = moved.mode === DataMoveMode.Copied;
  // From here the data is in its new folder: the record says so before the originals go.
  const originals = copied ? [{ dir: from, entries: moved.entries, since: startedAt }] : [];
  await writeDataFolderRecord(defaultDir, {
    ...chosen(to, defaultDir),
    ...withLeftovers(readDataFolderRecord(defaultDir).leftover, originals),
  });
  deps.log(`data folder: moved ${from} to ${to} (${moved.mode}, ${moved.bytes} bytes)`);
  await relink(deps);
  if (copied) await settleLeftovers(defaultDir, (dir) => samePath(dir, from), deps.log);
  return { moved: true, mode: moved.mode };
}

/** Record a move that did not happen: put back (with any copies it left listed), or stranded and still to finish. */
async function failedMove(deps: DataMoveLaunchDeps, error: unknown): Promise<DataMoveOutcome> {
  const { from, to, defaultDir } = deps;
  const failure = error instanceof DataMoveError ? error : new DataMoveError(moveProblemOf(error), errorMessage(error));
  const { problem } = failure;
  deps.log(`data folder: could not move ${from} to ${to} (${problem}): ${failure.message}`);
  const record = readDataFolderRecord(defaultDir);
  const failed = { to, problem };
  if (failure.stranded.length) {
    deps.log(
      `data folder: ${failure.stranded.join(", ")} could not be put back in ${from}; the move carries on next start`,
    );
    await writeDataFolderRecord(defaultDir, { ...record, moveTo: to, failed });
    return { moved: false, problem, stranded: [...failure.stranded] };
  }
  const copies = failure.left.length ? [{ dir: to, entries: [...failure.left], since: NOBODY_EDITS }] : [];
  await writeDataFolderRecord(defaultDir, {
    ...chosen(from, defaultDir),
    failed,
    ...withLeftovers(record.leftover, copies),
  });
  return { moved: false, problem };
}

/**
 * Point what named a place in the old folder at the new one: the library's folders, links, Claude
 * Code's sessions of the moved folders and the build copies' Git links. A failure is logged; the
 * data stays moved.
 */
async function relink(deps: DataMoveLaunchDeps): Promise<void> {
  const { from, to, log } = deps;
  try {
    const rebased = await rebaseDataFiles(to, from);
    if (rebased.length) log(`data folder: pointed ${rebased.join(", ")} at ${to}`);
    const links = await relinkLinks(to, from);
    if (links.failed.length) log(`data folder: ${links.failed.length} links still point at ${from}`);
    if (deps.hostGit && !(await deps.hostGit())) {
      log("data folder: no Git to repair the build copies with");
      return;
    }
    const unrepaired = await repairWorktrees(to, from);
    if (unrepaired.length) log(`data folder: Git could not repair ${unrepaired.length} build copies`);
    const sessions = await moveClaudeProjects(to, from);
    if (sessions) log(`data folder: moved Claude Code's sessions of ${sessions} folders`);
  } catch (error) {
    log(`data folder: repairing links after the move failed: ${errorMessage(error)}`);
  }
}

/** Whether a file under `entry` changed after `since` (links not followed): someone edited the copy left there. */
async function changedSince(entry: string, since: number): Promise<boolean> {
  const info = await lstat(entry).catch(() => null);
  if (!info) return false;
  if (info.isFile()) return info.mtimeMs > since;
  if (!info.isDirectory()) return false;
  for (const name of await readdir(entry).catch((): string[] => [])) {
    if (await changedSince(path.join(entry, name), since)) return true;
  }
  return false;
}

/** Remove one leftover's entries nobody changed since the copy; what stays (changed or held), or null. */
async function settleLeftover(leftover: DataLeftover, log: Log): Promise<DataLeftover | null> {
  const changed: string[] = [];
  const stale: string[] = [];
  for (const name of leftover.entries) {
    if (await changedSince(path.join(leftover.dir, name), leftover.since)) changed.push(name);
    else stale.push(name);
  }
  if (changed.length) log(`data folder: kept ${changed.join(", ")} in ${leftover.dir}: changed after the move`);
  const held = await removeEntries(leftover.dir, stale);
  if (held.length) log(`data folder: ${held.length} old entries in ${leftover.dir} are still in use`);
  const entries = [...changed, ...held];
  return entries.length ? { ...leftover, entries } : null;
}

/** Settle the leftovers in the folders `which` picks; the record keeps the others and what stays of these. */
async function settleLeftovers(defaultDir: string, which: (dir: string) => boolean, log: Log): Promise<void> {
  const leftovers = readDataFolderRecord(defaultDir).leftover ?? [];
  if (!leftovers.some((item) => which(item.dir))) return;
  const settled: DataLeftover[] = [];
  for (const item of leftovers) {
    const stays = which(item.dir) ? await settleLeftover(item, log) : item;
    if (stays) settled.push(stays);
  }
  const record = readDataFolderRecord(defaultDir);
  delete record.leftover;
  await writeDataFolderRecord(defaultDir, { ...record, ...withLeftovers([], settled) });
}

/**
 * A later launch removes what moves copied but could not remove then: only the names a move
 * recorded, never in the folder now in use, and never a file changed after the copy.
 */
export async function removeLeftover(defaultDir: string, dataDir: string, log: Log): Promise<void> {
  await settleLeftovers(defaultDir, (dir) => !samePath(dir, dataDir), log);
}
