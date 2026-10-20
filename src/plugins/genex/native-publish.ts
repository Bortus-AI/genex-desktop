/**
 * A publish's apps: the Mac and Windows builds in the game folder, sent with `genex native publish`
 * once the web build is public. Each goes on its own, and one that fails is said on its row: it never
 * fails the publish, whose web build is already live. Studio's dialog names the builds by their place
 * in the game folder; that folder is written by agents, so each is resolved here by its real path and
 * sent only from inside the folder.
 */
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { GenexNativeFailure, GenexNativeSent } from "../../shared/genex.ts";

const require = createRequire(import.meta.url);

/** The first Genex CLI with `genex native`: an older pin sends no app. */
const NATIVE_CLI = [1, 36, 10] as const;
/** The most apps one publish sends: a Mac app and a Windows program, each at most twice over. */
const NATIVE_UPLOADS_MAX = 4;
/** What a failure keeps of the CLI's words. */
const FAILURE_CHARS = 400;

const MESSAGE = { NotABuild: "Genex answered without the build it published" } as const;

/** Whether CLI `version` has `genex native`: a prerelease of the first such version counts as it. */
export function hasNativeCommand(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  for (const [at, wanted] of NATIVE_CLI.entries()) {
    const part = parts[at] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return true;
}

/** Whether the CLI Studio ships can send apps; none found (a plugin package without it) sends none. */
export function pinnedCliSendsApps(): boolean {
  try {
    const { version } = require("@genex-ai/cli-demo/package.json") as { version?: unknown };
    return typeof version === "string" && hasNativeCommand(version);
  } catch {
    return false;
  }
}

/** One app to send: what the CLI is handed (a `.app`, or a Windows program's folder) and its platform. */
export interface NativeUpload {
  target: string;
  platform: "mac" | "windows";
}

/** Whether `entry` is a plain path inside a folder: relative, no `..`, no empty part. */
const isPlainEntry = (entry: string): boolean =>
  !path.isAbsolute(entry) && entry.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");

/** `entry` of the game folder as the CLI takes it, or null when it is not a build inside the folder. */
async function uploadOf(base: string, entry: string): Promise<NativeUpload | null> {
  if (!isPlainEntry(entry)) return null;
  const real = await realpath(path.join(base, entry)).catch(() => null);
  if (!real?.startsWith(base + path.sep)) return null;
  const info = await lstat(real).catch(() => null);
  const lower = real.toLowerCase();
  if (lower.endsWith(".app") && info?.isDirectory()) return { target: real, platform: "mac" };
  // A Windows program is sent with its folder: the game's data sits beside it.
  if (lower.endsWith(".exe") && info?.isFile() && path.dirname(real) !== base)
    return { target: path.dirname(real), platform: "windows" };
  return null;
}

/**
 * The apps among `entries` (the dialog's builds, relative to the game folder `directory`) that are
 * real builds inside it, each once. Anything else is dropped: a link out of the folder, a path with
 * `..`, a file that is not a program, a program at the folder's root (its folder would be the game).
 */
export async function nativeUploads(directory: string, entries: unknown): Promise<NativeUpload[]> {
  if (!Array.isArray(entries)) return [];
  const base = await realpath(directory).catch(() => null);
  if (!base) return [];
  const uploads: NativeUpload[] = [];
  for (const entry of entries.slice(0, NATIVE_UPLOADS_MAX)) {
    if (typeof entry !== "string") continue;
    const upload = await uploadOf(base, entry);
    if (upload && !uploads.some((known) => known.target === upload.target)) uploads.push(upload);
  }
  return uploads;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The build `genex native publish --json` says it published, or null when its answer names none. */
export function sentBuild(answer: unknown): GenexNativeSent | null {
  const build = isRecord(answer) ? answer.build : undefined;
  if (!isRecord(build)) return null;
  const { platform, arch, version, sizeBytes, publishedAt } = build;
  const words = [platform, arch, version, publishedAt].every((value) => typeof value === "string");
  if (!words || typeof sizeBytes !== "number") return null;
  return {
    platform: String(platform),
    arch: String(arch),
    version: String(version),
    sizeBytes,
    publishedAt: String(publishedAt),
  };
}

/** The CLI's own words for a failure: its last `✗` line, else its last line, kept short. */
function failureWords(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const marked = lines.filter((line) => line.startsWith("✗")).at(-1);
  return (marked ?? lines.at(-1) ?? "").replace(/^✗\s*/, "").slice(0, FAILURE_CHARS);
}

/** What became of one app. */
export type NativeOutcome = { sent: GenexNativeSent } | { failed: GenexNativeFailure };

/** Send one app with `send` (the CLI run), as an outcome: a failure is kept, never thrown. */
export async function sendNativeBuild(
  upload: NativeUpload,
  send: (target: string) => Promise<unknown>,
): Promise<NativeOutcome> {
  try {
    const sent = sentBuild(await send(upload.target));
    if (sent) return { sent };
    return { failed: { platform: upload.platform, arch: "", error: MESSAGE.NotABuild } };
  } catch (error) {
    return { failed: { platform: upload.platform, arch: "", error: failureWords(error) } };
  }
}
