/**
 * Quitting and opening Roblox Studio, the person's own app: argument lists only, never a shell
 * string. Studio is not run in Genex's process sandbox, because its own connection and the
 * person's sign-in must work.
 *
 * - Quit is always a normal quit, so Studio asks to save an unsaved place as it does for the
 *   person: on a Mac an Apple event that never starts a Studio that isn't running, on Windows
 *   `taskkill` without `/F`. Genex never force-quits Studio.
 * - Open starts Studio on its own: `open -a` on a Mac, the program detached on Windows.
 * - A place opens through Studio's own command line: a local file with `--task EditFile
 *   --localPlaceFile`, a published place with `--task EditPlace --placeId --universeId`. Each
 *   starts a Studio of its own beside any already open, so a place that is already open is brought
 *   forward instead of opened twice (`focusLaunch`).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { envValue } from "../../substrate/toolchain.ts";
import {
  isMacPath,
  isWindowsPath,
  type LocateDeps,
  STUDIO_WINDOWS_EXE,
  type StudioInstall,
  studioRunning,
} from "./studio-locate.ts";

/** Studio's bundle id on a Mac. */
export const STUDIO_MAC_BUNDLE = "com.Roblox.RobloxStudio";
/** How long a quit waits for Studio to close: long enough for the person to answer its save question. */
export const QUIT_WAIT_MS = 2 * MINUTE_MS;
/** How often a quit looks whether Studio has closed. */
const QUIT_POLL_MS = SECOND_MS;
const OSASCRIPT = "/usr/bin/osascript";
const MAC_OPEN = "/usr/bin/open";
const WINDOWS_ROOT = "C:\\Windows";
/** How long after Genex opens Studio the button says Starting, before Studio's process is seen. */
export const STARTING_MAX_MS = 2 * MINUTE_MS;
/** The Starting note in the plugin's storage. */
const STARTING_FILE = "starting.json";
const MAX_STARTING_BYTES = 1024;
/** A published place's id, as Studio's command line takes it: decimal digits, no leading zero. */
const ROBLOX_ID = /^[1-9]\d{0,19}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Studio's command-line tasks Genex uses. Wire values: Studio's own spelling. */
export const StudioTask = {
  EditFile: "EditFile",
  EditPlace: "EditPlace",
} as const;
export type StudioTask = (typeof StudioTask)[keyof typeof StudioTask];

/** Why a place can't be opened. Wire values: never rename. */
export const LaunchRefusal = {
  /** The place file isn't a full path of the system Studio runs on. */
  BadFile: "bad-file",
  /** A published place's ids aren't digits. */
  BadIds: "bad-ids",
} as const;
export type LaunchRefusal = (typeof LaunchRefusal)[keyof typeof LaunchRefusal];

/** A place that can't be opened, and why. */
export class StudioLaunchError extends Error {
  readonly code: LaunchRefusal;
  constructor(code: LaunchRefusal, message: string) {
    super(message);
    this.name = "StudioLaunchError";
    this.code = code;
  }
}

/** A place to open: a local file, or a published place by its ids. */
export type PlaceTarget = { file: string } | { placeId: string; universeId: string };

/** A program and its arguments, started without a shell. */
export interface Launch {
  file: string;
  args: string[];
}

/** Starts a program on its own, never through a shell; resolves once it has started. */
export type Opener = (launch: Launch) => Promise<void>;

/** What quitting Studio needs: the locator's computer, a starter, and time. */
export interface LaunchDeps extends LocateDeps {
  open: Opener;
  sleep(ms: number): Promise<unknown>;
  now(): number;
}

/** The normal quit for this system; never a forced one. */
export function quitLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Launch {
  if (platform === "win32") {
    const root = envValue(env, "SystemRoot");
    const system = root && isWindowsPath(root) ? root : WINDOWS_ROOT;
    return { file: path.win32.join(system, "System32", "taskkill.exe"), args: ["/IM", STUDIO_WINDOWS_EXE] };
  }
  // "is running" asks without starting Studio; ignoring the answer leaves Studio's save question to the person.
  const script = [
    `if application id "${STUDIO_MAC_BUNDLE}" is running then`,
    "ignoring application responses",
    `tell application id "${STUDIO_MAC_BUNDLE}" to quit`,
    "end ignoring",
    "end if",
  ];
  return { file: OSASCRIPT, args: script.flatMap((line) => ["-e", line]) };
}

/** Whether `file` is a full place path of `platform`'s own spelling, with no control character. */
function placePathOf(platform: NodeJS.Platform, file: string): boolean {
  if (CONTROL.test(file)) return false;
  return platform === "win32" ? isWindowsPath(file) : isMacPath(file);
}

/** Studio's own command line for a place: its program with the task's arguments, never a shell. */
export function openPlaceLaunch(platform: NodeJS.Platform, install: StudioInstall, target: PlaceTarget): Launch {
  if ("file" in target) {
    if (!placePathOf(platform, target.file))
      throw new StudioLaunchError(LaunchRefusal.BadFile, `${target.file} isn't a full place path on this computer.`);
    return { file: install.studio, args: ["--task", StudioTask.EditFile, "--localPlaceFile", target.file] };
  }
  if (!ROBLOX_ID.test(target.placeId) || !ROBLOX_ID.test(target.universeId))
    throw new StudioLaunchError(LaunchRefusal.BadIds, "A published place's ids are whole numbers.");
  const ids = ["--placeId", target.placeId, "--universeId", target.universeId];
  return { file: install.studio, args: ["--task", StudioTask.EditPlace, ...ids] };
}

/** Brings the open Studio forward on a Mac without opening anything; Windows has no such step. */
export function focusLaunch(platform: NodeJS.Platform, install: StudioInstall): Launch | undefined {
  return platform === "darwin" ? { file: MAC_OPEN, args: ["-a", install.app] } : undefined;
}

/** Notes in the plugin's storage that Genex just opened Studio, so the button says Starting. */
export async function markStarting(storage: string, now: number): Promise<void> {
  await atomicWriteJson(path.join(storage, STARTING_FILE), { at: now });
}

/** Whether Genex opened Studio within {@link STARTING_MAX_MS} before `now`. */
export async function startingNow(storage: string, now: number): Promise<boolean> {
  const bytes = await readRegularFile(path.join(storage, STARTING_FILE), MAX_STARTING_BYTES).catch(() => undefined);
  if (!bytes) return false;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  const at = isJsonObject(value) ? value.at : undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at)) return false;
  return at <= now && now - at < STARTING_MAX_MS;
}

/** How this system opens the installed Studio. */
export function openLaunch(platform: NodeJS.Platform, install: StudioInstall): Launch {
  if (platform === "win32") return { file: install.studio, args: [] };
  return { file: MAC_OPEN, args: ["-a", install.app] };
}

/**
 * Asks Studio to quit normally and waits until it has closed; false when it is still open at the
 * end of the wait (the person kept it open, or is still answering its save question).
 */
export async function quitStudio(deps: LaunchDeps, waitMs = QUIT_WAIT_MS): Promise<boolean> {
  if (!(await studioRunning(deps))) return true;
  const quit = quitLaunch(deps.platform, deps.env);
  await deps.run(quit.file, quit.args).catch(() => undefined);
  const until = deps.now() + waitMs;
  while (deps.now() < until) {
    await deps.sleep(QUIT_POLL_MS);
    if (!(await studioRunning(deps))) return true;
  }
  return false;
}

/** Starts a program detached from the backend, with no window of its own on Windows and no shell. */
export const systemOpener: Opener = (launch) =>
  new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
