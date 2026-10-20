/**
 * The Publish dialog's platform rows for one game (`studio:publish.platforms`): the web build as
 * Publish already sends it, and the Mac and Windows apps the game folder holds, each ready, built
 * before the game's last change, or not built yet. Read from the folder only; nothing is built or
 * uploaded here.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { NativePlatform } from "../../shared/play-native.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../shared/publish-platforms.ts";
import type { StudioCore } from "../studio-core.ts";
import { type FoundBuild, findNativeBuilds } from "./native-builds.ts";

/** How much newer than a build the game's last change must be before the build counts as old. */
const STALE_AFTER_MS = MINUTE_MS;
/** How many entries the look for the game's last change reads at most. */
const CHANGE_ENTRIES_MAX = 20_000;
/** Folders whose changes are not the game's: history, packages, caches, builds and exports. */
const NOT_SOURCE = new Set([
  ".git",
  "node_modules",
  "Library",
  "Temp",
  "Logs",
  "obj",
  ".godot",
  ".import",
  ".studio",
  "Builds",
  "Build",
  "build",
  "dist",
  "export",
  "exports",
  "web",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  "Binaries",
]);

const MESSAGE = { NoGame: "not a game in the library" } as const;

/** Whether a folder holds the game's sources: not a cache, an export, a bundle or a found build's folder. */
const isSource = (name: string, at: string, builds: ReadonlySet<string>): boolean =>
  !NOT_SOURCE.has(name) && !name.endsWith(".app") && !builds.has(at);

/** When the game's sources last changed, ms since the epoch, outside its builds and caches. */
async function lastChange(root: string, builds: readonly FoundBuild[]): Promise<number> {
  const inBuild = new Set(builds.map((build) => path.join(root, build.entry.split("/").slice(0, -1).join("/") || ".")));
  let newest = 0;
  let seen = 0;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined && seen < CHANGE_ENTRIES_MAX; dir = pending.pop()) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    seen += entries.length;
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory() && isSource(entry.name, at, inBuild)) pending.push(at);
      if (entry.isFile()) newest = Math.max(newest, (await stat(at).catch(() => null))?.mtimeMs ?? 0);
    }
  }
  return newest;
}

/** A platform's row from its newest build, or its missing row. */
function nativeRow(
  target: typeof PublishTarget.Mac | typeof PublishTarget.Windows,
  build: FoundBuild | undefined,
  changed: number,
): PublishPlatform {
  if (!build)
    return { target, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null, uploads: false };
  const stale = changed - build.builtAt > STALE_AFTER_MS;
  return {
    target,
    state: stale ? PublishPlatformState.Stale : PublishPlatformState.Ready,
    arch: build.arch,
    bytes: build.bytes,
    builtAt: new Date(build.builtAt).toISOString(),
    // genex.games does not take native builds yet: the row shows its state and publishes nothing.
    uploads: false,
  };
}

/** The web, Mac and Windows rows for `project`, from its folder. */
export async function publishPlatforms(
  core: Pick<StudioCore, "games" | "pluginBinding">,
  project: unknown,
): Promise<PublishPlatform[]> {
  if (typeof project !== "string" || !project) throw new Error(MESSAGE.NoGame);
  const game = (await core.games.list()).find((listed) => listed.name === project);
  const binding = game ? await core.pluginBinding(project) : undefined;
  if (!game || !binding) throw new Error(MESSAGE.NoGame);
  const builds = await findNativeBuilds(binding.directory);
  const changed = await lastChange(binding.directory, builds);
  const web = publishesAsWebGame(game);
  const newest = (platform: NativePlatform) => builds.find((build) => build.platform === platform);
  return [
    {
      target: PublishTarget.Web,
      state: web ? PublishPlatformState.Ready : PublishPlatformState.Missing,
      arch: null,
      bytes: 0,
      builtAt: null,
      uploads: web,
    },
    nativeRow(PublishTarget.Mac, newest(NativePlatform.Mac), changed),
    nativeRow(PublishTarget.Windows, newest(NativePlatform.Windows), changed),
  ];
}
