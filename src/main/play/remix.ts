/**
 * Remix: a published game's public source becomes a new game of the person's own. Its repository is
 * cloned shallowly over https from Genex's git into a fresh folder in the games folder, its history
 * is dropped (the copy starts its own), and the folder is adopted as a game without trusting the
 * Claude settings or hooks it came with. Nothing of the copy runs while it is made: no hooks, no
 * content filters, and links come out as plain files. Files the game keeps in Git LFS (its models
 * and textures) come next, by the host's git-lfs, from that same repository only.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { HOST_GIT_CONFIG, hostGitEnv } from "../../substrate/git-policy.ts";
import type { PlayWorld } from "./gallery.ts";

const exec = promisify(execFile);

/** The longest a clone may take before it is given up. */
export const REMIX_CLONE_TIMEOUT_MS = 3 * MINUTE_MS;
/** How many numbered folders are tried before giving up on a free name. */
const MAX_FOLDER_TRIES = 50;
/** The most a clone may print before it is cut off. */
const CLONE_OUTPUT_MAX_BYTES = 1024 * 1024;
/** The only host a remix clones from. */
const GIT_HOST = "git.genex.games";

const MESSAGE = {
  NotRemixable: "This game can’t be remixed",
  NeedsLfs:
    "This game keeps its files in Git LFS. Install git-lfs on this Mac (brew install git-lfs), then remix it again.",
  NoFolder: "There is no free folder for the copy",
  Title: (title: string) => `${title} remix`,
} as const;

/**
 * Settings a clone runs under, after the host's own: https only (no `ext::` or `file://`
 * transports), no LFS or other content filter, and symbolic links written as plain files.
 */
const CLONE_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "core.symlinks=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
] as const;

/** Whether `url` is a repository on Genex's git, over https, that a remix may clone. */
export function isRemixSource(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === GIT_HOST &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      /^\/[a-z0-9-]+\/[a-z0-9-]+\.git$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** The git command line that clones `url` into `dest`. */
export function cloneArgs(url: string, dest: string): string[] {
  return [
    ...HOST_GIT_CONFIG,
    ...CLONE_CONFIG,
    "clone",
    "--depth=1",
    "--single-branch",
    "--no-tags",
    "--no-recurse-submodules",
    "--",
    url,
    dest,
  ];
}

/**
 * The git command line that brings a clone's Git LFS files, run in the clone: from the repository it
 * was cloned from (`lfs.url` set here outranks any `.lfsconfig` in the copy), https only, no hooks.
 */
export function lfsPullArgs(url: string): string[] {
  return [
    ...HOST_GIT_CONFIG,
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    `lfs.url=${url}/info/lfs`,
    "lfs",
    "pull",
  ];
}

/** Whether a clone keeps files in Git LFS: a line of its `.gitattributes` (not a comment) names the lfs filter. */
export async function tracksLfs(dir: string): Promise<boolean> {
  const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8").catch(() => "");
  return attributes
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && line.split(/\s+/).includes("filter=lfs"));
}

/** Where a remix goes and how it is cloned and adopted. */
export interface RemixDeps {
  /** Where new games go. */
  gamesRoot(): string;
  /** Clone `url` into `dest`, an empty folder this remix made. */
  clone(url: string, dest: string): Promise<void>;
  /** Adopt a folder as a game with this title; answers its library name. */
  adopt(dir: string, title: string): Promise<string>;
}

/** Whether an error says the folder is there already. */
const exists = (error: unknown): boolean => (error as { code?: string } | null)?.code === "EEXIST";

/**
 * Claim the first free `<slug>-remix`, `<slug>-remix-2`, … folder in `root` by making it: two
 * remixes at once can never pick the same folder, and the folder is this remix's to remove.
 */
export async function claimFolder(
  root: string,
  slug: string,
  make: (dir: string) => Promise<unknown> = (dir) => mkdir(dir),
): Promise<string> {
  for (let n = 1; n <= MAX_FOLDER_TRIES; n += 1) {
    const candidate = path.join(root, n === 1 ? `${slug}-remix` : `${slug}-remix-${n}`);
    try {
      await make(candidate);
      return candidate;
    } catch (error) {
      if (!exists(error)) throw error;
    }
  }
  throw new Error(MESSAGE.NoFolder);
}

/** Make `world` a new game of the person's own; answers its library name. A failed copy leaves nothing behind. */
export async function remixGame(world: PlayWorld, deps: RemixDeps): Promise<string> {
  if (!world.remixable || !isRemixSource(world.cloneUrl) || !isPlaySlug(world.slug))
    throw new Error(MESSAGE.NotRemixable);
  const root = deps.gamesRoot();
  await mkdir(root, { recursive: true });
  const dest = await claimFolder(root, world.slug);
  try {
    await deps.clone(world.cloneUrl, dest);
    // The copy starts its own history; the author's stays theirs.
    await rm(path.join(dest, ".git"), { recursive: true, force: true });
    return await deps.adopt(dest, MESSAGE.Title(world.title));
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}

/** How the host runs git for a remix: its policy's environment, a deadline and bounded output. */
const GIT_RUN = { timeout: REMIX_CLONE_TIMEOUT_MS, windowsHide: true, maxBuffer: CLONE_OUTPUT_MAX_BYTES } as const;

/** The host's git clone under the host's git policy and a deadline, then its Git LFS files if it has any. */
export async function gitClone(url: string, dest: string): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await exec("git", cloneArgs(url, dest), { ...GIT_RUN, env: hostGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" }) });
  if (!(await tracksLfs(dest))) return;
  const lfs = await exec("git", ["lfs", "version"], { ...GIT_RUN, env: hostGitEnv() }).catch(() => null);
  if (!lfs) throw new Error(MESSAGE.NeedsLfs);
  await exec("git", lfsPullArgs(url), { ...GIT_RUN, cwd: dest, env: hostGitEnv() });
}

/** A fixture launch's clone: a one-page stand-in game, so a remix can be followed with no network. */
export async function fixtureClone(url: string, dest: string): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await mkdir(dest, { recursive: true });
  const name = path.basename(new URL(url).pathname, ".git");
  await writeFile(
    path.join(dest, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1></body></html>\n`,
  );
}
