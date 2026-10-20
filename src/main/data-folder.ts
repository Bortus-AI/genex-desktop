/**
 * Where the normal profile keeps its data, when the person moved it (Settings → Storage). Electron's
 * default data folder (`%APPDATA%\Genex`) then holds only a small record, `data-folder.json`:
 * `dir` is the folder in use, `moveTo` a move the next launch makes, `failed` the last move that did
 * not happen and why, `leftover` the entries a copy left in the old folder, still to be removed.
 *
 * `boot.ts` reads it first thing, before Electron opens any of its data, and points userData (and
 * the session's data with it) at the folder in use. A launch that moves the data, or cannot find
 * it, runs on a folder of its own in the temp folder instead, so nothing it starts holds a file in
 * the folder being moved. Developer, test and installer launches never move or wait for the data:
 * they only follow a finished move, so they still know where the normal profile's data is.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA_FOLDER_PROBLEMS, type DataFolderProblem, type DataMoveFailed } from "../shared/data-folder.ts";
import { atomicWriteJson } from "../substrate/fsx.ts";

/** The record in the default data folder. */
export const DATA_FOLDER_FILE = "data-folder.json";
/** The temp folder Electron keeps its own data in while a launch moves or waits for the real one. */
export const DATA_MOVE_SESSION = "genex-data-move";

/** What `data-folder.json` says; every field is optional, and an absent record is the default folder. */
export interface DataFolderRecord {
  /** The folder in use, when it is not the default one. */
  dir?: string;
  /** Where the next normal launch moves the data. */
  moveTo?: string;
  /** The entries a move set out to move, recorded before it changed anything, so a closed Genex carries on. */
  moving?: string[];
  /** The last move that did not happen. */
  failed?: DataMoveFailed;
  /** What the last move copied but could not remove yet: the old folder and those entries' names. */
  leftover?: DataLeftover;
}

/** Entries a move copied out of `dir` and could not remove yet. */
export interface DataLeftover {
  dir: string;
  entries: string[];
}

/** What this launch does about its data. */
export const DataLaunchKind = {
  /** The default folder: nothing moved. */
  Default: "default",
  /** The data is in a folder the person chose. */
  Moved: "moved",
  /** Move the data, then start again. */
  Move: "move",
  /** The chosen folder is not there (an unplugged drive): wait for it. */
  Missing: "missing",
} as const;
export type DataLaunchKind = (typeof DataLaunchKind)[keyof typeof DataLaunchKind];

export type DataLaunch =
  | { kind: typeof DataLaunchKind.Default; dir: string }
  | { kind: typeof DataLaunchKind.Moved; dir: string }
  | { kind: typeof DataLaunchKind.Move; from: string; to: string }
  | { kind: typeof DataLaunchKind.Missing; dir: string };

/** What deciding a launch needs to know besides the record. */
export interface DataLaunchContext {
  /** Electron's default data folder, where the record lives. */
  defaultDir: string;
  /** The person opening Genex, not a runner, a developer or the installer. */
  normal: boolean;
  exists(dir: string): boolean;
}

/** An absolute path, or undefined for anything else. */
function absolute(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : undefined;
}

/** A record read back from disk, keeping only fields of the right shape. */
export function parseDataFolderRecord(raw: unknown): DataFolderRecord {
  if (!raw || typeof raw !== "object") return {};
  const fields = raw as Record<string, unknown>;
  const record: DataFolderRecord = {};
  const dir = absolute(fields.dir);
  const moveTo = absolute(fields.moveTo);
  if (dir) record.dir = dir;
  if (moveTo) record.moveTo = moveTo;
  const moving = Array.isArray(fields.moving) ? fields.moving.filter(isEntryName) : [];
  if (moveTo && moving.length) record.moving = moving;
  const leftover = parseLeftover(fields.leftover);
  if (leftover) record.leftover = leftover;
  const failed = parseFailed(fields.failed);
  if (failed) record.failed = failed;
  return record;
}

/** A name of one entry of a folder: never empty, `.`, `..` or a path. */
function isEntryName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

function parseLeftover(raw: unknown): DataLeftover | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const fields = raw as Record<string, unknown>;
  const dir = absolute(fields.dir);
  const entries = Array.isArray(fields.entries) ? fields.entries.filter(isEntryName) : [];
  return dir && entries.length ? { dir, entries } : undefined;
}

function parseFailed(raw: unknown): DataMoveFailed | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const fields = raw as Record<string, unknown>;
  const to = absolute(fields.to);
  const problem = fields.problem;
  if (!to || typeof problem !== "string" || !DATA_FOLDER_PROBLEMS.has(problem)) return undefined;
  return { to, problem: problem as DataFolderProblem };
}

/** The record in `defaultDir`; an empty one when there is none or it cannot be read. */
export function readDataFolderRecord(defaultDir: string): DataFolderRecord {
  try {
    return parseDataFolderRecord(JSON.parse(readFileSync(path.join(defaultDir, DATA_FOLDER_FILE), "utf8")));
  } catch {
    return {};
  }
}

/** Write the record in `defaultDir`. */
export async function writeDataFolderRecord(defaultDir: string, record: DataFolderRecord): Promise<void> {
  await atomicWriteJson(path.join(defaultDir, DATA_FOLDER_FILE), record);
}

/**
 * What a launch does about its data. Only the person's own launch moves it or waits for a missing
 * folder; any other launch uses a chosen folder that is there, or the default.
 */
export function dataLaunchFor(record: DataFolderRecord, context: DataLaunchContext): DataLaunch {
  const chosen = record.dir;
  if (!context.normal) {
    return chosen && context.exists(chosen)
      ? { kind: DataLaunchKind.Moved, dir: chosen }
      : { kind: DataLaunchKind.Default, dir: context.defaultDir };
  }
  if (chosen && !context.exists(chosen)) return { kind: DataLaunchKind.Missing, dir: chosen };
  const current = chosen ?? context.defaultDir;
  if (record.moveTo && path.resolve(record.moveTo) !== path.resolve(current))
    return { kind: DataLaunchKind.Move, from: current, to: record.moveTo };
  return chosen
    ? { kind: DataLaunchKind.Moved, dir: chosen }
    : { kind: DataLaunchKind.Default, dir: context.defaultDir };
}

/** Electron's default data folder: its app-data folder and the app's name, as Electron makes it. */
export function defaultDataDir(appData: string, appName: string): string {
  return path.join(appData, appName);
}

/** The folder Electron should use for its data this launch, or null to keep its default. */
export function electronDataDir(launch: DataLaunch, temp: string): string | null {
  switch (launch.kind) {
    case DataLaunchKind.Moved:
      return launch.dir;
    case DataLaunchKind.Move:
    case DataLaunchKind.Missing:
      return path.join(temp, DATA_MOVE_SESSION);
    default:
      return null;
  }
}

/** What `boot.ts` needs from Electron to point its data at the folder in use. */
export interface DataPathsHost {
  appData: string;
  appName: string;
  temp: string;
  argvNormal: boolean;
  setPath(name: "userData" | "sessionData", dir: string): void;
}

/** Where `boot.ts` leaves this launch's decision for the app bundle, which is built apart from it. */
const LAUNCH_KEY = Symbol.for("genex.data-launch");

/**
 * Decide this launch's data folder and point Electron at it, before anything reads userData. A
 * chosen folder Electron cannot be pointed at (a drive that went away since the check) is a missing
 * one, never a silent fall back to the default folder, which would start an empty Genex.
 */
export function pointElectronAtData(host: DataPathsHost): DataLaunch {
  const defaultDir = defaultDataDir(host.appData, host.appName);
  const decided = dataLaunchFor(readDataFolderRecord(defaultDir), {
    defaultDir,
    normal: host.argvNormal,
    exists: existsSync,
  });
  const launch = pointAt(host, decided);
  (globalThis as Record<symbol, unknown>)[LAUNCH_KEY] = launch;
  return launch;
}

function pointAt(host: DataPathsHost, launch: DataLaunch): DataLaunch {
  const dir = electronDataDir(launch, host.temp);
  if (!dir) return launch;
  try {
    mkdirSync(dir, { recursive: true });
    host.setPath("userData", dir);
    host.setPath("sessionData", dir);
    return launch;
  } catch {
    if (launch.kind !== DataLaunchKind.Moved || !host.argvNormal)
      return { kind: DataLaunchKind.Default, dir: defaultDataDir(host.appData, host.appName) };
    return pointAt(host, { kind: DataLaunchKind.Missing, dir: launch.dir });
  }
}

/** The decision `boot.ts` made for this launch, or the default folder when it made none. */
export function thisDataLaunch(defaultDir: string): DataLaunch {
  const launch = (globalThis as Record<symbol, unknown>)[LAUNCH_KEY] as DataLaunch | undefined;
  return launch ?? { kind: DataLaunchKind.Default, dir: defaultDir };
}
