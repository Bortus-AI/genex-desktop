/**
 * After a publish, the game is linked to the place Roblox now has, by Genex itself.
 *
 * A first publish turns the place Studio has open into a new game on Roblox, and Studio may reopen
 * it under the game's name ("<name> (placeId: N)"), which the game's link (its place file, or its
 * name in Studio) no longer matches. So when Genex hands a first publish to the chat, or leaves it to
 * the person where it can't click, it notes it (`publish/<game>.json` in the plugin's storage: the
 * name, the linked project and the Studio the game was bound to). Until that note is
 * {@link PUBLISH_NOTE_MS} old, each look (the panel's status, Genex's moments, a publish call) asks
 * the Studios that could be the game's whether Roblox has their place now: the Studio the note
 * names, one whose place carries the published name, or, with no note, the Studio the game's helper
 * was last connected from: within {@link LOST_STUDIO_MS} once that connection is lost, and while it
 * still holds only when a publish call asks (`askBound`). Exactly one published place, held by no
 * other game, is linked with its ids, keeping the link's project; the chat shows the link with Undo.
 * Two candidates, or none, link nothing.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { PluginService } from "../../shared/plugins.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { agentFolder } from "./agent-marks.ts";
import { askPlace, listedStudios, type PlaceDeps, placeHeldBy } from "./places.ts";
import { BINDING_MAX_AGE_MS, isGameId, readLastBinding, readPlaceRecord, writePlaceRecord } from "./studio-binding.ts";
import type { StudioEntry } from "./studio-client.ts";

/** How long a publish's note is followed: a publish the chat or the person finishes later is a new one. */
export const PUBLISH_NOTE_MS = 30 * MINUTE_MS;
/** How long after the game's helper last spoke its Studio is still taken for the game's, with no note. */
export const LOST_STUDIO_MS = 10 * MINUTE_MS;
/** The folder of the notes in the plugin's storage. */
const NOTES_FOLDER = "publish";
const MAX_NOTE_BYTES = 4 * 1024;
/** What Studio adds after a published place's name: " (placeId: 129143288655360)". */
const PLACE_ID_SUFFIX = /\s*\(placeId:\s*\d+\)\s*$/i;
/** A place's published ids, never 0. */
const UNPUBLISHED = "0";
/** The longest name the chat's link line shows. */
const MAX_LINK_NAME_CHARS = 80;

/** A first publish Genex handed over or left to the person: when, under which name, from which Studio. */
export interface PublishNote {
  at: number;
  project: string;
  name?: string;
  studioId?: string;
}

/** What relinking needs: the computer's Studios, and the Studio the game's helper is bound to now. */
export interface RelinkDeps extends PlaceDeps {
  bound?(game: string): string | undefined;
}

/** How far a look reaches: a publish call also asks the Studio the game is still connected to. */
export interface RelinkOptions {
  askBound?: boolean;
}

/** A relink that happened: the published place's name and ids. */
export interface Relinked {
  name: string;
  placeId: string;
  universeId: string;
}

const noteFile = (storage: string, game: string) => path.join(storage, NOTES_FOLDER, `${game}.json`);

/** Notes a first publish for `game`, so the next looks link it to the published place. */
export async function notePublish(storage: string, game: string, note: PublishNote): Promise<void> {
  if (!isGameId(game)) return;
  await mkdir(path.join(storage, NOTES_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(noteFile(storage, game), note);
}

/** The game's note while it is fresh at `now`; undefined when there is none, it is old, or it isn't one. */
export async function readPublishNote(storage: string, game: string, now: number): Promise<PublishNote | undefined> {
  if (!isGameId(game)) return undefined;
  const value = await readRegularFile(noteFile(storage, game), MAX_NOTE_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value) || typeof value.project !== "string" || !Number.isSafeInteger(value.at)) return undefined;
  const at = value.at as number;
  if (now - at > PUBLISH_NOTE_MS || at - now > PUBLISH_NOTE_MS) return undefined;
  return {
    at,
    project: value.project,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.studioId === "string" ? { studioId: value.studioId } : {}),
  };
}

const clearNote = (storage: string, game: string) => rm(noteFile(storage, game), { force: true });

/** Whether a Studio's place name is `name`, as Studio shows it before or after its published id. */
const namedAs = (studio: StudioEntry, name: string) => studio.name.replace(PLACE_ID_SUFFIX, "") === name;

/**
 * The Studio the game's helper was last connected from, when a look with no note may ask it: a lost
 * connection within {@link LOST_STUDIO_MS}, or one that still holds when the look asks for it.
 */
async function lastStudio(deps: RelinkDeps, storage: string, game: string, options: RelinkOptions) {
  const folder = agentFolder(storage, game);
  const last = folder ? await readLastBinding(folder) : undefined;
  if (!last) return undefined;
  const age = deps.now() - last.at;
  if (age <= BINDING_MAX_AGE_MS) return options.askBound ? last.studioId : undefined;
  return age <= LOST_STUDIO_MS ? last.studioId : undefined;
}

/** The Studios that may hold the game's published place, and the name it was published under. */
async function candidatesOf(deps: RelinkDeps, storage: string, game: string, project: string, options: RelinkOptions) {
  const note = await readPublishNote(storage, game, deps.now());
  const ids = new Set<string>();
  const followed = note?.project === project ? note : undefined;
  if (followed) {
    if (followed.studioId) ids.add(followed.studioId);
    const bound = deps.bound?.(game);
    if (bound) ids.add(bound);
  } else {
    const last = await lastStudio(deps, storage, game, options);
    if (last) ids.add(last);
  }
  const name = followed?.name;
  if (ids.size === 0 && !name) return { studios: [], name };
  const studios = (await listedStudios(deps)).filter(
    (entry) => ids.has(entry.id) || (name !== undefined && namedAs(entry, name)),
  );
  return { studios, name };
}

/** The one published place among `studios`, with the Studio it is in; undefined for none or several. */
async function onePublished(deps: RelinkDeps, storage: string, studios: readonly StudioEntry[]) {
  const found = new Map<string, { entry: StudioEntry; ids: { placeId: string; universeId: string } }>();
  for (const entry of studios) {
    const ids = await askPlace(deps, storage, entry);
    if (ids && ids.placeId !== UNPUBLISHED) found.set(ids.placeId, { entry, ids });
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}

/**
 * Links the game a call is bound to with the place Roblox has now, after a publish (module comment).
 * Answers what was linked, or undefined when nothing was: no game, a link that has its ids already,
 * no publish to follow, or no single published place that is free.
 */
export async function relinkPublished(
  deps: RelinkDeps,
  context: PluginContext,
  options: RelinkOptions = {},
): Promise<Relinked | undefined> {
  const game = context.project;
  if (!game || !isGameId(game)) return undefined;
  const link = await context.host(PluginService.GameEngineRead).catch(() => null);
  if (!link || link.remote) return undefined;
  const storage = await context.host(PluginService.StorageRoot);
  const { studios, name } = await candidatesOf(deps, storage, game, link.project, options);
  const found = await onePublished(deps, storage, studios);
  if (!found || (await placeHeldBy(storage, game, found.ids.placeId))) return undefined;
  const published = (name ?? (found.entry.name.replace(PLACE_ID_SUFFIX, "") || link.name)).slice(
    0,
    MAX_LINK_NAME_CHARS,
  );
  const record = await readPlaceRecord(storage, game);
  const folder = record?.folder ?? context.directory;
  // Recorded before the link: the helper link finds this game's Studio by its ids as soon as the link has them.
  if (folder) await writePlaceRecord(storage, game, { folder, project: link.project, name: published, ...found.ids });
  await context.host(PluginService.GameEngineLink, { project: link.project, remote: found.ids, name: published });
  await clearNote(storage, game);
  return { name: published, ...found.ids };
}
