/**
 * Quitting and opening Roblox Studio, the person's own app: argument lists only, never a shell
 * string. Studio is not run in Genex's process sandbox, because its own connection and the
 * person's sign-in must work.
 *
 * - Quit is always a normal quit, so Studio asks to save an unsaved place as it does for the
 *   person: on a Mac an Apple event that never starts a Studio that isn't running, on Windows
 *   `taskkill` without `/F`. Genex never force-quits Studio.
 * - Open starts Studio on its own: `open -a` on a Mac, the program detached on Windows.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { envValue } from "../../substrate/toolchain.ts";
import {
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
