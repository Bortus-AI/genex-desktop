/**
 * The frames a video is rendered from, found in a game folder before Genex commits it. An agent
 * that renders a flythrough writes hundreds of numbered pictures beside the video; committed, each
 * save point and chat checkpoint copies gigabytes into the game's history for a video of a few
 * megabytes. A folder of enough numbered pictures, large enough together, that the game does not
 * track yet reads as such a dump, and its numbered pictures become an ignore rule: they stay on
 * disk, out of every commit after, while the video and every other file beside them stay in.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assetFormat } from "../shared/game-assets.ts";
import type { PlacedRule } from "../shared/project-workspace.ts";
import { pathExists } from "./fsx.ts";
import { ownIgnoreFile } from "./nested-repos.ts";
import { gitOrNull } from "./snapshots.ts";

/** The fewest numbered pictures in one folder that read as a render's frames (five seconds at 24 fps). */
export const RENDER_DUMP_MIN_FILES = 120;
/** The fewest bytes those pictures hold together: a sprite animation's small frames stay in history. */
export const RENDER_DUMP_MIN_BYTES = 32 * 1024 * 1024;
/** How many files are looked at at once. */
const FILES_AT_ONCE = 64;

/** A frame's name ends in its number: `frame_0001.png`, `Shot.0001.exr`, `12.jpg`. */
const NUMBERED_STEM = /\d+$/;
/** A picture's extension as an ignore line can say it. */
const PLAIN_EXTENSION = /^[A-Za-z0-9]+$/;
/** An ignore line a frames rule writes: `<folder>/*[0-9].<extension>`. */
const FRAMES_LINE = /^(.+)\/\*\[0-9\]\.([^./]+)$/;
/**
 * A folder name an ignore line says as itself: letters, digits, `.`, `_`, `-` and inner spaces.
 * Anything else (a glob, `!`, `#`, a backslash, a line break, an edge space) git would read as
 * more than the name, so such a folder is never named.
 */
const PLAIN_SEGMENT = /^[\p{L}\p{N}._-](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u;

/** Whether a game-relative file is a numbered picture. */
function isNumberedPicture(rel: string): boolean {
  if (assetFormat(rel)?.kind !== "image") return false;
  const name = path.posix.basename(rel);
  return NUMBERED_STEM.test(name.slice(0, name.lastIndexOf(".")));
}

/**
 * The untracked, unignored files of a repository, game-relative and POSIX; none when git cannot say,
 * or when `dir` has no repository of its own (git would answer for one around it).
 */
async function untrackedFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(path.join(dir, ".git")))) return [];
  const out = await gitOrNull(dir, ["ls-files", "-z", "-o", "--exclude-standard"]);
  return (out ?? "").split("\0").filter(Boolean);
}

/** The bytes the regular files of `files` hold at `dir`, never through a link. */
async function bytesOf(dir: string, files: readonly string[]): Promise<number> {
  let total = 0;
  for (let at = 0; at < files.length; at += FILES_AT_ONCE) {
    const batch = files.slice(at, at + FILES_AT_ONCE);
    const infos = await Promise.all(batch.map((rel) => lstat(path.join(dir, rel)).catch(() => null)));
    for (const info of infos) if (info?.isFile()) total += info.size;
  }
  return total;
}

/**
 * The rule leaving out a folder's numbered pictures of one extension, as spelled (`*[0-9].png`),
 * placed at the folder; null for a folder or extension an ignore line cannot name as itself.
 */
function framesRule(folder: string, extension: string): PlacedRule | null {
  if (!PLAIN_EXTENSION.test(extension)) return null;
  if (!folder.split("/").every((segment) => PLAIN_SEGMENT.test(segment))) return null;
  return { base: folder, pattern: `*[0-9].${extension}` };
}

/** `items` grouped by `keyOf`, in the order each key first appears. */
function groupBy(items: readonly string[], keyOf: (item: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** A file's extension as spelled (`EXR` in `beauty.0001.EXR`). */
const extensionOf = (rel: string): string => rel.slice(rel.lastIndexOf(".") + 1);

/** Whether one folder's numbered pictures are enough, and large enough together, to be a render's frames. */
async function isRenderDump(dir: string, frames: readonly string[]): Promise<boolean> {
  return frames.length >= RENDER_DUMP_MIN_FILES && (await bytesOf(dir, frames)) >= RENDER_DUMP_MIN_BYTES;
}

/**
 * The rules for the frames of each folder of `dir` that holds a render's dump the repository does
 * not track and does not ignore yet.
 */
async function newFramesRules(dir: string): Promise<PlacedRule[]> {
  const pictures = (await untrackedFiles(dir)).filter(
    (rel) => isNumberedPicture(rel) && path.posix.dirname(rel) !== ".",
  );
  const rules: PlacedRule[] = [];
  for (const [folder, frames] of groupBy(pictures, (rel) => path.posix.dirname(rel))) {
    if (!(await isRenderDump(dir, frames))) continue;
    for (const extension of groupBy(frames, extensionOf).keys()) {
      const rule = framesRule(folder, extension);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/**
 * The frames rules the folder's `.gitignore` already holds. Their frames are ignored now, so no
 * walk finds them again; a restore cleans what the rules it is answered leave out, and an older
 * save point's ignore file may not have the line yet, so these are answered for as long as it stays.
 */
async function keptFramesRules(dir: string): Promise<PlacedRule[]> {
  const text = (await ownIgnoreFile(dir)) ?? "";
  return text.split("\n").flatMap((line) => {
    const [, folder, extension] = FRAMES_LINE.exec(line.trim()) ?? [];
    const rule = folder && extension ? framesRule(folder, extension) : null;
    return rule ? [rule] : [];
  });
}

/**
 * The rules leaving out the numbered pictures of each folder of `dir` that holds a render's frames:
 * one rule per folder and extension, placed at the folder, for frames found now and for those a
 * rule already leaves out. The folder's other files (the video, a poster) stay in history. None for
 * a folder that is no repository.
 */
export async function renderDumpRules(dir: string): Promise<PlacedRule[]> {
  if (!(await pathExists(path.join(dir, ".git")))) return [];
  const rules = [...(await keptFramesRules(dir)), ...(await newFramesRules(dir))];
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.base}/${rule.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
