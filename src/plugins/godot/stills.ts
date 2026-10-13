/**
 * Stills of a Godot game: Genex's capture script plays a scene for a moment in a window off every
 * screen and saves what each camera in the `genex_shot` group sees (else the scene's own camera),
 * into a folder of the job's own that is removed once the pictures are read. They answer the
 * agent's `screenshot`, a run's save point (`checkpoint.after`) and the viewport observer the
 * reviewer and Live read.
 */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { HOOK_IMAGE_MAX_BYTES, HOOK_IMAGES_MAX, type HookAnswer } from "../../shared/plugin-hooks.ts";
import { isInside } from "../../substrate/paths.ts";
import type { GodotInstall } from "./find-godot.ts";
import { savedShots } from "./godot-output.ts";
import { captureCall, type GodotRunner } from "./godot-run.ts";

/** The most stills one capture takes: a moment's pictures are capped at Genex's, and an agent needs few. */
export const MAX_STILLS = Math.min(4, HOOK_IMAGES_MAX);
const STILLS_FOLDER = "stills";
const SHOT_PREFIX = "shot";
const PNG = "image/png";
/** A picture's name as Genex keeps it: plain characters, at most 80. */
const NAME_CHARS = 80;
const NOT_NAME = /[^A-Za-z0-9 ._-]+/g;

/** One still: its camera's name and the PNG's bytes as base64. */
export type Still = { name: string; data: string };

/** What a capture needs: how Godot runs, Genex's scripts and the plugin's storage, where its folder goes. */
export type StillsDeps = { run: GodotRunner; scripts: string; storage: string };

/** A still's PNG, read only when it is a plain file inside the job's own folder and small enough to hand back. */
async function readStill(folder: string, file: string): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  if (!real || !isInside(folder, real)) return null;
  const found = await lstat(real).catch(() => null);
  if (!found?.isFile() || found.size > HOOK_IMAGE_MAX_BYTES) return null;
  return (await readFile(real)).toString("base64");
}

/**
 * Stills of `scene` (the main scene when empty) in the game's project, at most `most`: each one the
 * capture says it saved, in order.
 */
export async function takeStills(
  deps: StillsDeps,
  install: GodotInstall,
  project: string,
  request: { scene: string; most: number },
  signal: AbortSignal,
): Promise<Still[]> {
  const parent = path.join(deps.storage, STILLS_FOLDER);
  await mkdir(parent, { recursive: true });
  const folder = await realpath(await mkdtemp(path.join(parent, `${SHOT_PREFIX}-`)));
  try {
    const most = Math.max(1, Math.min(MAX_STILLS, request.most));
    const call = captureCall(project, deps.scripts, path.join(folder, SHOT_PREFIX), request.scene, most);
    const { output } = await deps.run(install.binary, call, signal);
    const stills: Still[] = [];
    for (const shot of savedShots(output).slice(0, most)) {
      const data = await readStill(folder, shot.file);
      if (data) stills.push({ name: shot.name.replace(NOT_NAME, "-").slice(0, NAME_CHARS) || "shot", data });
    }
    return stills;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Stills as a moment's or an observer's pictures; nothing when there are none. */
export const stillsAnswer = (stills: readonly Still[]): HookAnswer =>
  stills.length ? { images: stills.map(({ name, data }) => ({ name, data })) } : {};

/** Stills as the agent's answer: the cameras' names, and the pictures the model sees. */
export function stillsForAgent(stills: readonly Still[]) {
  return {
    shots: stills.map((still) => still.name),
    images: stills.map((still) => ({ mimeType: PNG, data: still.data, label: still.name })),
  };
}
