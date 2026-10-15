/**
 * A game linked to an engine project (`shared/game-engine.ts`): an Unreal `.uproject` or a Godot
 * project's `project.godot`, recorded by its real path. A project inside the game folder is the
 * game's like any other file; one outside it is reached by chats only: Rewind's checkpoints hold
 * only the game folder, so a Loop (which Rewind must be able to undo step by step) needs the
 * project inside, and Rewind says what it can't undo outside. The engine's name in every sentence
 * is its own (`GAME_ENGINE_WORDS`).
 */
import { engineOf, GameEngine, projectName } from "../shared/game-engine.ts";
import type { GameProject } from "./types.ts";
import { ENGINE_LINK_WORDS, GAME_ENGINE_WORDS } from "./words.ts";

/** The part of a game these rules read: its folder and its engine record. */
type LinkedGame = Pick<GameProject, "engine"> & Partial<Pick<GameProject, "dir">>;

const SEPARATOR = /[\\/]/;
const TRAILING_SEPARATORS = /[\\/]+$/;
/** How many folders above the project's own a place names: "Documents › Godot Projects". */
const PLACE_FOLDERS = 2;

/** The project file a linked game builds in, or null for a web game (or no game). */
export function linkedProjectOf(game: LinkedGame | null | undefined): string | null {
  const engine = game?.engine;
  if (!engine || engineOf(engine) === GameEngine.Web) return null;
  return engine.project;
}

/** Whether `file` lies under `folder`, by spelling: `/a/game-copy` is not under `/a/game`. */
function under(file: string, folder: string): boolean {
  const base = folder.replace(TRAILING_SEPARATORS, "");
  if (!base || !file.startsWith(base)) return false;
  return SEPARATOR.test(file.charAt(base.length));
}

/** Whether a linked game's project lies inside its own folder; a spelling mismatch reads as outside. */
export function linkedProjectInFolder(game: LinkedGame | null | undefined): boolean {
  const project = linkedProjectOf(game);
  return Boolean(project && game?.dir && under(project, game.dir));
}

/** The engine's name as the chat says it, for a linked game. */
const engineName = (game: LinkedGame | null | undefined): string => GAME_ENGINE_WORDS[engineOf(game?.engine)];

/** What Rewind adds for a game whose linked project lies outside its folder; null for any other game. */
export function linkRewindNote(game: LinkedGame | null | undefined): string | null {
  const project = linkedProjectOf(game);
  if (!project || linkedProjectInFolder(game)) return null;
  return ENGINE_LINK_WORDS.rewindNote(engineName(game), projectName(project));
}

/** Where a project's folder sits, as the panels name places: the folders above it, joined by ›. */
function placeOf(project: string): string {
  const folders = project.split(SEPARATOR).filter(Boolean).slice(0, -2);
  return folders.slice(-PLACE_FOLDERS).join(" › ");
}

/** Why Mode has no Loop for a game whose linked project lies outside its folder. */
export function linkLoopGate(game: LinkedGame | null | undefined): string {
  const project = linkedProjectOf(game);
  if (!project) return ENGINE_LINK_WORDS.loopUnavailable(GAME_ENGINE_WORDS.unreal, null, "");
  return ENGINE_LINK_WORDS.loopUnavailable(engineName(game), projectName(project), placeOf(project));
}
