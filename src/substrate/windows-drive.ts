/**
 * What Windows says about the drive a folder is on, and a new folder's access limited to this
 * account, for moving Genex's data (Settings → Storage). The sandbox keeps agents to their folders
 * with NTFS permissions, so Genex's data needs a fixed drive whose file system keeps them, and a
 * new folder there must start as closed as the profile is: a second drive's root lets every
 * signed-in user (the sandbox's own included) change what is in it, and folders made under it
 * inherit that.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { windowsPowerShell } from "./windows-folder-ace.ts";

const run = promisify(execFile);

/** How long PowerShell may take to describe a drive; its own start is most of it. */
const DRIVE_TIMEOUT_MS = 30 * SECOND_MS;
/** How long `whoami` and `icacls` may take on a new, empty folder. */
const TOOL_TIMEOUT_MS = 30 * SECOND_MS;
/** A drive letter's root, as `path.win32.parse` spells it. */
const DRIVE_ROOT = /^[A-Za-z]:\\$/;
/** File systems that keep NTFS permissions. */
const PERMISSION_FILE_SYSTEMS: ReadonlySet<string> = new Set(["NTFS", "REFS"]);
/** The well-known SIDs of LocalSystem and the Administrators group, which the profile's folders grant too. */
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** A user SID in `whoami /user /fo csv /nh`'s line. */
const USER_SID = /"(S-1-[\d-]+)"\s*$/m;

/** What kind of drive a folder is on, from `Win32_LogicalDisk.DriveType`. */
export const DriveKind = {
  Fixed: "fixed",
  Removable: "removable",
  Network: "network",
  Other: "other",
} as const;
export type DriveKind = (typeof DriveKind)[keyof typeof DriveKind];

/** `Win32_LogicalDisk.DriveType`'s numbers. */
const DRIVE_TYPE: Readonly<Record<number, DriveKind>> = {
  2: DriveKind.Removable,
  3: DriveKind.Fixed,
  4: DriveKind.Network,
};

/** A drive's kind and file system (`NTFS`, `exFAT`, `FAT32`). */
export interface DriveFacts {
  kind: DriveKind;
  fileSystem: string;
}

/** A path that reaches its folder through the network: `\\server\share\…` or `\\?\UNC\…`. */
export function isSharePath(dir: string): boolean {
  return /^[\\/]{2}/.test(dir) && !/^[\\/]{2}\?[\\/][A-Za-z]:/.test(dir);
}

/** The drive letter (`D:`) of a folder on one, or null. */
export function driveOf(dir: string): string | null {
  const root = path.win32.parse(path.win32.resolve(dir)).root;
  return DRIVE_ROOT.test(root) ? root.slice(0, 2).toUpperCase() : null;
}

/** Whether a drive's file system keeps the permissions the sandbox relies on. */
export function keepsPermissions(facts: DriveFacts): boolean {
  return PERMISSION_FILE_SYSTEMS.has(facts.fileSystem.toUpperCase());
}

/** `Get-CimInstance`'s JSON for one drive, or null when it is not one. */
export function parseDriveFacts(stdout: string): DriveFacts | null {
  try {
    const row = JSON.parse(stdout) as { DriveType?: unknown; FileSystem?: unknown } | null;
    if (!row || typeof row.DriveType !== "number") return null;
    return {
      kind: DRIVE_TYPE[row.DriveType] ?? DriveKind.Other,
      fileSystem: typeof row.FileSystem === "string" ? row.FileSystem : "",
    };
  } catch {
    return null;
  }
}

/** The drive `dir` is on, as Windows describes it; null when it cannot say. */
export async function windowsDriveFacts(dir: string): Promise<DriveFacts | null> {
  const drive = driveOf(dir);
  if (!drive) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object DriveType, FileSystem | ConvertTo-Json -Compress`,
  ].join("\n");
  try {
    const { stdout } = await run(
      windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: DRIVE_TIMEOUT_MS, windowsHide: true },
    );
    return parseDriveFacts(stdout.trim());
  } catch {
    return null;
  }
}

/** This account's SID from `whoami /user /fo csv /nh`, or null. */
export function parseUserSid(stdout: string): string | null {
  return USER_SID.exec(stdout.trim())?.[1] ?? null;
}

/** The `icacls` arguments that leave `dir` to this account, LocalSystem and Administrators alone. */
export function lockDownArgs(dir: string, userSid: string): string[] {
  const full = "(OI)(CI)F";
  return [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:${full}`,
    `*${SYSTEM_SID}:${full}`,
    `*${ADMINISTRATORS_SID}:${full}`,
    "/q",
  ];
}

/**
 * Give `dir`, a new empty folder, the access a folder in the profile has: this account,
 * LocalSystem and Administrators, nothing inherited from the drive. Throws when Windows refuses,
 * as on a file system that keeps no permissions.
 */
export async function lockDownFolder(dir: string): Promise<void> {
  const { stdout } = await run("whoami", ["/user", "/fo", "csv", "/nh"], {
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  const sid = parseUserSid(stdout);
  if (!sid) throw new Error(`whoami named no account: ${stdout.trim()}`);
  await run("icacls", lockDownArgs(dir, sid), { timeout: TOOL_TIMEOUT_MS, windowsHide: true });
}
