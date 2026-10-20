/**
 * The launch that moves Genex's data (Settings → Storage asked for it, then restarted Genex). It
 * runs before any of Genex starts, on a temp folder of Electron's own (`data-folder.ts`), so no
 * file in the old folder is open: the data moves, what pointed into the old folder is pointed at
 * the new one, the record says where the data is now, and the caller starts Genex again. A move
 * that fails leaves everything where it was and records why, for Storage to say.
 */
import type { DataFolderProblem, DataMoveProgress } from "../shared/data-folder.ts";
import { errorMessage } from "../shared/errors.ts";
import { type DataMoved, DataMoveMode, moveData, moveProblemOf, removeEntries } from "../substrate/data-move.ts";
import { rebaseDataFiles, repairWorktrees } from "../substrate/data-relink.ts";
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
}

/** How a moving launch ended. */
export type DataMoveOutcome = { moved: true; mode: DataMoved["mode"] } | { moved: false; problem: DataFolderProblem };

/** The record's folder field for `dir`: absent for the default folder. */
function chosen(dir: string, defaultDir: string): Pick<DataFolderRecord, "dir"> {
  return samePath(dir, defaultDir) ? {} : { dir };
}

/** Move the data, record where it went (or why it did not go), and repair what pointed into the old folder. */
export async function runDataMove(deps: DataMoveLaunchDeps): Promise<DataMoveOutcome> {
  const { from, to, defaultDir } = deps;
  const report = (done: number, total: number) => deps.progress({ to, done, total });
  report(0, 0);
  const record = readDataFolderRecord(defaultDir);
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
    const problem = moveProblemOf(error);
    deps.log(`data folder: could not move ${from} to ${to} (${problem}): ${errorMessage(error)}`);
    await writeDataFolderRecord(defaultDir, { ...chosen(from, defaultDir), failed: { to, problem } });
    return { moved: false, problem };
  }
  const copied = moved.mode === DataMoveMode.Copied;
  // From here the data is in its new folder: the record says so before the originals go.
  const leftover = copied ? { leftover: { dir: from, entries: moved.entries } } : {};
  await writeDataFolderRecord(defaultDir, { ...chosen(to, defaultDir), ...leftover });
  deps.log(`data folder: moved ${from} to ${to} (${moved.mode}, ${moved.bytes} bytes)`);
  await relink(deps);
  if (copied) await removeOriginals(deps, moved.entries);
  return { moved: true, mode: moved.mode };
}

/** Point the library and the build copies at the new folder; a failure is logged, the data stays moved. */
async function relink(deps: DataMoveLaunchDeps): Promise<void> {
  try {
    const rebased = await rebaseDataFiles(deps.to, deps.from);
    if (rebased.length) deps.log(`data folder: pointed ${rebased.join(", ")} at ${deps.to}`);
    if (deps.hostGit && !(await deps.hostGit())) {
      deps.log("data folder: no Git to repair the build copies with");
      return;
    }
    const unrepaired = await repairWorktrees(deps.to, deps.from);
    if (unrepaired.length) deps.log(`data folder: Git could not repair ${unrepaired.length} build copies`);
  } catch (error) {
    deps.log(`data folder: repairing links after the move failed: ${errorMessage(error)}`);
  }
}

/** Remove the copied originals; ones another program still holds stay listed for the next launch. */
async function removeOriginals(deps: DataMoveLaunchDeps, entries: readonly string[]): Promise<void> {
  await settleLeftover(deps.defaultDir, { dir: deps.from, entries: [...entries] }, deps.log);
}

/** Remove what the last move left, keeping in the record only the entries still held. */
async function settleLeftover(defaultDir: string, leftover: DataLeftover, log: (line: string) => void): Promise<void> {
  const left = await removeEntries(leftover.dir, leftover.entries);
  const record = readDataFolderRecord(defaultDir);
  if (left.length) {
    log(`data folder: ${left.length} old entries in ${leftover.dir} are still in use`);
    record.leftover = { dir: leftover.dir, entries: left };
  } else delete record.leftover;
  await writeDataFolderRecord(defaultDir, record);
}

/**
 * A later launch removes the entries a move copied but could not remove then. Only the names the
 * move recorded go, and never the folder now in use.
 */
export async function removeLeftover(defaultDir: string, dataDir: string, log: (line: string) => void): Promise<void> {
  const leftover = readDataFolderRecord(defaultDir).leftover;
  if (!leftover || samePath(leftover.dir, dataDir)) return;
  await settleLeftover(defaultDir, leftover, log);
}
