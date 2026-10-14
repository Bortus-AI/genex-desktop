/**
 * Which engine a game builds in. A game is a web game unless Genex linked it to an engine project;
 * `studio.json` then records `engine`, and everything that would treat the game as a web page (the
 * chat brief, the preview health check, the Live tab, the Loop) asks this record first. Words
 * never decide it: a game asked for "in Unreal" in a web-template folder is still a web game until
 * linked.
 *
 * studio.json sits in the folder agents write, so this module only checks the record's shape;
 * `substrate/game-engine-binding.ts` checks the project file itself by its real path.
 */

import type { EnginePlayDeclaration } from "./engine-play.ts";

/** The engines a game can build in, by their wire names. */
export const GameEngine = { Web: "web", Unreal: "unreal" } as const;
export type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];

/** Whether `value` names an engine Genex knows. */
export const isGameEngine = (value: unknown): value is GameEngine =>
  value === GameEngine.Web || value === GameEngine.Unreal;

/** The extension of an Unreal project file. */
export const UPROJECT_EXTENSION = ".uproject";

/**
 * An engine's id: the id of the plugin that declares it (`engine.id`), so the host, not the
 * plugin, decides which engine a link names. Lowercase letters, digits and dashes, 2–40, a letter
 * first. `GameEngine` stays the closed vocabulary of skills' `engines`; this one is open.
 */
export const ENGINE_ID = /^[a-z][a-z0-9-]{1,39}$/;
export type EngineId = string;

/** Whether `value` is spelled as an engine id. */
export const isEngineId = (value: unknown): value is EngineId => typeof value === "string" && ENGINE_ID.test(value);

/** A project file's extension as an engine declares it: one or two dotted parts (`.uproject`, `.project.json`). */
export const PROJECT_FILE_EXTENSION = /^(\.[a-z0-9]{1,16}){1,2}$/;

/** The apps an engine's editor runs as, which computer use never drives to build or play: Mac bundle ids, Windows `.exe` names. */
export interface EngineApps {
  mac?: string[];
  windows?: string[];
}

/**
 * The engine a `game-engine` plugin declares (`engine` in its manifest, API 3): its id (the
 * plugin's own), the name the person reads, the project files a game links, the fact a linked
 * game holds, whether the Loop needs the project inside the game folder (its save points hold it),
 * what its editor can do in play and the apps its editor runs as.
 */
export interface EngineDeclaration {
  id: EngineId;
  /** 1–40 characters: "Unreal". */
  label: string;
  /** 1–4 extensions (`PROJECT_FILE_EXTENSION`), each once. */
  projectFiles: string[];
  /** A fact the plugin's `detect` declares, or one of Genex's own (`CoreFact`). */
  fact: string;
  projectInFolder: boolean;
  play?: EnginePlayDeclaration;
  apps?: EngineApps;
}

/** The engines installed plugins declare, by id. */
export type EngineCatalog = ReadonlyMap<EngineId, EngineDeclaration>;

/**
 * A published game's ids at its engine's service, kept beside a link when the project lives there
 * rather than in a file on this computer: decimal strings, never numbers, which would lose digits.
 */
export interface EngineRemote {
  placeId: string;
  universeId: string;
}

/** A positive decimal id of at most 20 digits, with no leading zero. */
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;

/** A published game's ids, by shape: both decimal ids, else none. */
export function parseEngineRemote(raw: unknown): EngineRemote | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { placeId, universeId } = raw as Record<string, unknown>;
  const valid = typeof placeId === "string" && typeof universeId === "string";
  if (!valid || !DECIMAL_ID.test(placeId) || !DECIMAL_ID.test(universeId)) return undefined;
  return { placeId, universeId };
}

/** A game linked to an Unreal project: its `.uproject` (absolute, real path) and when Genex linked it. */
export type EngineBinding = {
  kind: typeof GameEngine.Unreal;
  project: string;
  linkedAt: string;
};

/** The longest project path Genex records; Unreal itself refuses far shorter ones. */
const MAX_PROJECT_PATH = 1024;

const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

/**
 * Whether `value` is an absolute path to a project file with one of `extensions` (Unreal's
 * `.uproject` when none are given), spelled plainly: no `..` part, no control characters.
 */
export function isProjectPath(value: unknown, extensions: readonly string[] = [UPROJECT_EXTENSION]): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PROJECT_PATH) return false;
  if (!isAbsolute(value) || CONTROL.test(value)) return false;
  const lower = value.toLowerCase();
  if (!extensions.some((extension) => lower.endsWith(extension))) return false;
  return !value.split(/[\\/]/).some((part) => part === "..");
}

/**
 * The binding a studio.json records, by shape only: the Unreal kind, a plain absolute `.uproject`
 * path and a date. Anything else, including a record for an engine Genex does not know, is no
 * binding: the game stays a web game.
 */
export function parseEngineBinding(raw: unknown): EngineBinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== GameEngine.Unreal || !isProjectPath(record.project)) return undefined;
  const linkedAt =
    typeof record.linkedAt === "string" && !Number.isNaN(Date.parse(record.linkedAt)) ? record.linkedAt : "";
  return { kind: GameEngine.Unreal, project: record.project, linkedAt };
}

/** The engine a game builds in: its binding's, else the web. */
export const engineOf = (binding: EngineBinding | undefined | null): GameEngine => binding?.kind ?? GameEngine.Web;

/** The project's name as Unreal shows it: the `.uproject` file name without its extension. */
export function projectName(project: string): string {
  const file = project.split(/[\\/]/).pop() ?? project;
  return file.slice(0, file.length - UPROJECT_EXTENSION.length);
}

/**
 * The chat's record that a game now builds in an engine project ("Lantern now builds in Unreal ·
 * Lantern", with Undo): the plugin that linked it, the game, the project file and its
 * name, when, and the project it replaced. `auto` marks a link the plugin made by itself rather
 * than at the person's word (older hosts linked a game at its first call; none does now).
 */
export type EngineLinkedPayload = {
  pluginId?: string;
  project?: string;
  /** The game's title as studio.json named it then. */
  title?: string;
  engine?: GameEngine;
  file?: string;
  name?: string;
  linkedAt?: string;
  previous?: string;
  auto?: boolean;
};

/** The chat's record that Undo took a link back: the link it undid, and the project it restored (none: a web game again). */
export type EngineLinkUndonePayload = { pluginId?: string; project?: string; linkedAt?: string; restored?: string };

/** The chat line's Undo: which plugin's link of which game, made when, asked from which chat. */
export type EngineLinkUndo = { project: string; pluginId: string; linkedAt: string; threadId?: string };

/** The chat's record that an engine plugin offers its steps card here (its steps are read live from the plugin). */
export type EngineStepsPayload = { pluginId?: string; project?: string };
