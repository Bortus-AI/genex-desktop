/**
 * A game's assets and the person's genex.games library: where each file stands (saved, shared),
 * Save and Share on the game's own files, and bringing a library or shared asset into the game.
 *
 * A Genex asset is in the library already (its job names the generation). Saving any other file
 * sends it there first; the game remembers which generation each such file became in
 * `.studio/library-links.json` (ignored by git, builds and Publish). Nothing here trusts a file
 * name the renderer sends: each is checked against the game's own asset list first.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AddOutcome,
  type AddSource,
  type AssetLibraryState,
  type GameLibraryStates,
  isGenerationId,
  LIBRARY_IDS_MAX,
  type LibraryAsset,
  LibraryKind,
  libraryKindOf,
  type ShareItem,
  ShareMiss,
  type ShareOutcome,
} from "../../shared/asset-library.ts";
import { assetKind, type ProjectAsset, type ProjectAssets } from "../../shared/game-assets.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { atomicWriteJson, createFileInDir, ensureDirBelow, readJsonIfExists } from "../../substrate/fsx.ts";
import type { AssetLibrary, ShareAnswer } from "../play/asset-library.ts";
import { libraryFileUrl } from "../play/asset-library.ts";

/** Where a game keeps which generation each saved or added file is. */
const LINKS_FILE = ["library-links.json"] as const;
const STUDIO_DIR = ".studio";
/** The folders added assets land in, below `assets/`: one per source, one per add. */
export const AddFolder = { Library: "library", Community: "community" } as const;
/** The largest file Save sends or Add downloads. */
export const LIBRARY_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** A downloaded file's name: letters, digits, dot, dash, underscore, one extension. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A shared asset manifest's `media` by the library kind it is. */
const MEDIA_KIND: Readonly<Record<string, LibraryKind>> = {
  glb: LibraryKind.Model,
  image: LibraryKind.Image,
  audio: LibraryKind.Sound,
  video: LibraryKind.Video,
};

const MESSAGE = {
  notInGame: "That file isn't one of this game's assets.",
  notFound: "That asset isn't in your library.",
  noFile: "genex.games has no file for that asset.",
  notWebGame: "Code assets are for web games.",
} as const;

/** One file a link remembers: the generation it became, and whether Genex made it. */
interface LibraryLink {
  generationId: string;
  /** Sent from this Mac by Save: Genex did not make it, so it can't be shared. */
  sent: boolean;
}

/** `.studio/library-links.json`. */
interface LinksFile {
  version: 1;
  files: Record<string, LibraryLink>;
}

/** What the sharing needs from the core and the network. */
export interface LibrarySharingDeps {
  library(): AssetLibrary;
  /** A game's folder by its library name. */
  gameDir(project: string): string;
  /** Whether the game takes three.js code modules (a web game). */
  webGame(project: string): Promise<boolean>;
  /** The game's assets as the Assets tab lists them. */
  assets(project: string): Promise<ProjectAssets>;
  /** A game file's bytes, read without following links, at most `maxBytes`. */
  readFile(gameDir: string, file: string, maxBytes: number): Promise<{ mimeType: string; data: Uint8Array }>;
  /** A shared asset's manifest, as genex.games answers it. */
  manifest(slug: string): Promise<unknown>;
  /** A file from genex.games' asset hosts, at most `maxBytes`. */
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  /** Write a shared code asset's module into a web game; answers its path. */
  vendorModule(gameDir: string, manifest: unknown): Promise<string | null>;
}

/** The game's links, empty when there are none or the file is unreadable. */
async function readLinks(gameDir: string): Promise<LinksFile> {
  const read = await readJsonIfExists<LinksFile>(path.join(gameDir, STUDIO_DIR, ...LINKS_FILE)).catch(() => null);
  const files = read && typeof read === "object" && read.files && typeof read.files === "object" ? read.files : {};
  const kept: Record<string, LibraryLink> = {};
  for (const [file, link] of Object.entries(files)) {
    if (link && isGenerationId(link.generationId))
      kept[file] = { generationId: link.generationId, sent: link.sent === true };
  }
  return { version: 1, files: kept };
}

/** Remember `files` as their generations, beside the links already there. */
async function writeLinks(gameDir: string, added: Record<string, LibraryLink>): Promise<void> {
  const links = await readLinks(gameDir);
  const dir = await ensureDirBelow(gameDir, [STUDIO_DIR]);
  await atomicWriteJson(path.join(dir, ...LINKS_FILE), { version: 1, files: { ...links.files, ...added } });
}

/** The files the library can take: a model, picture, sound or video of the game's own. */
function libraryFiles(inventory: ProjectAssets): ProjectAsset[] {
  return inventory.assets.filter((asset) => libraryKindOf(asset) !== null);
}

/** Whether a file name's kind is one the library takes (a model, picture, sound or video). */
export const isLibraryFileName = (name: string): boolean => assetKind(name) !== "other";

/** The extension a downloaded file of each kind gets when its address names none. */
const KIND_EXTENSION = {
  [LibraryKind.Model]: "glb",
  [LibraryKind.Image]: "png",
  [LibraryKind.Sound]: "mp3",
  [LibraryKind.Video]: "mp4",
} as const satisfies Record<LibraryKind, string>;

/** A file name safe to write: the URL's last part when it is a library file, else `stem` with its kind's extension. */
function downloadName(url: string, stem: string, kind: LibraryKind): string {
  const last = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  return SAFE_NAME.test(last) && isLibraryFileName(last) ? last : `${stem}.${KIND_EXTENSION[kind]}`;
}

/** One library file of a game: the asset, the generation it is (or null), and whether Save sent it. */
interface KnownFile {
  asset: ProjectAsset;
  generationId: string | null;
  sent: boolean;
}

/** Each library file of the game with the generation it is (or null). */
async function knownFiles(deps: LibrarySharingDeps, project: string): Promise<KnownFile[]> {
  const [inventory, links] = await Promise.all([deps.assets(project), readLinks(deps.gameDir(project))]);
  return libraryFiles(inventory).map((asset) => {
    const link = links.files[asset.file];
    const generationId = asset.generationId ?? link?.generationId ?? null;
    return { asset, generationId, sent: !asset.generationId && link?.sent === true };
  });
}

/** The library's word on these generations, by id. */
async function lookup(deps: LibrarySharingDeps, ids: readonly string[]): Promise<Map<string, LibraryAsset>> {
  const found = new Map<string, LibraryAsset>();
  for (let start = 0; start < ids.length; start += LIBRARY_IDS_MAX) {
    const page = await deps.library().list({ ids: ids.slice(start, start + LIBRARY_IDS_MAX) });
    for (const asset of page.assets) found.set(asset.id, asset);
  }
  return found;
}

/** Where each of the game's files stands with the library; every file only in the game when it can't be read. */
async function readStates(deps: LibrarySharingDeps, project: string): Promise<GameLibraryStates> {
  const files = await knownFiles(deps, project);
  const ids = [...new Set(files.map((file) => file.generationId).filter((id): id is string => id !== null))];
  const found = await lookup(deps, ids).catch(() => null);
  const states: AssetLibraryState[] = files.map(({ asset, generationId, sent }) => {
    const entry = generationId ? found?.get(generationId) : undefined;
    return {
      file: asset.file,
      generationId: entry ? entry.id : null,
      saved: entry?.saved ?? false,
      shared: entry?.shared ?? null,
      shareable: Boolean(entry) && !sent,
    };
  });
  return { project, states, unread: found === null };
}

/** Save files to the library (sending those Genex did not make), or take the Saved mark off. */
async function saveFiles(
  deps: LibrarySharingDeps,
  project: string,
  files: readonly string[],
  saved: boolean,
): Promise<GameLibraryStates> {
  const dir = deps.gameDir(project);
  const known = await knownFiles(deps, project);
  const sent: Record<string, LibraryLink> = {};
  for (const file of files) {
    const match = known.find((entry) => entry.asset.file === file);
    if (!match) throw new Error(MESSAGE.notInGame);
    if (match.generationId) await deps.library().setSaved(match.generationId, saved);
    else if (saved) sent[file] = { generationId: await sendFile(deps, dir, match.asset), sent: true };
  }
  if (Object.keys(sent).length > 0) await writeLinks(dir, sent);
  return readStates(deps, project);
}

/** A game file sent to the library, saved under what it was made from (else its name); its generation. */
async function sendFile(deps: LibrarySharingDeps, dir: string, asset: ProjectAsset): Promise<string> {
  const read = await deps.readFile(dir, asset.file, LIBRARY_FILE_MAX_BYTES);
  const filename = asset.file.split("/").at(-1) ?? asset.file;
  const title = asset.prompt ?? filename;
  return deps.library().send({ filename, contentType: read.mimeType, bytes: read.data, title });
}

/** Share files to Play, each under its name; a file that can't be shared says why. */
async function shareFiles(
  deps: LibrarySharingDeps,
  project: string,
  items: readonly ShareItem[],
): Promise<ShareOutcome[]> {
  const current = await readStates(deps, project);
  const outcomes: ShareOutcome[] = [];
  for (const item of items) {
    const state = current.states.find((entry) => entry.file === item.file);
    if (!state) throw new Error(MESSAGE.notInGame);
    outcomes.push({ file: item.file, ...(await shareOne(deps, state, item.name)) });
  }
  return outcomes;
}

/** One file's share: refused when Genex did not make it, its page when it is on Play already. */
async function shareOne(deps: LibrarySharingDeps, state: AssetLibraryState, name: string): Promise<ShareAnswer> {
  if (!state.generationId || !state.shareable) return { miss: ShareMiss.NotShareable };
  if (state.shared?.live) return { shared: state.shared };
  return deps.library().share(state.generationId, name, state.shared);
}

/** Take a file's shared page off Play. */
async function unshareFile(deps: LibrarySharingDeps, project: string, file: string): Promise<GameLibraryStates> {
  const state = (await readStates(deps, project)).states.find((entry) => entry.file === file);
  if (!state) throw new Error(MESSAGE.notInGame);
  if (state.shared?.live) await deps.library().unshare(state.shared.projectId);
  return readStates(deps, project);
}

/** Write `bytes` into a fresh folder under `assets/<folder>/`; answers the game-relative path. */
async function place(dir: string, folder: string, name: string, bytes: Uint8Array): Promise<string> {
  const job = randomUUID();
  const target = await ensureDirBelow(dir, ["assets", folder, job]);
  await createFileInDir(target, name, bytes);
  return ["assets", folder, job, name].join("/");
}

/** A library generation's file, copied into the game and linked to its generation. */
async function addGeneration(deps: LibrarySharingDeps, project: string, generationId: string): Promise<AddOutcome> {
  const entry = (await lookup(deps, [generationId])).get(generationId);
  if (!entry) throw new Error(MESSAGE.notFound);
  if (!entry.fileUrl) throw new Error(MESSAGE.noFile);
  const dir = deps.gameDir(project);
  const bytes = await deps.download(entry.fileUrl, LIBRARY_FILE_MAX_BYTES);
  const file = await place(dir, AddFolder.Library, downloadName(entry.fileUrl, entry.id, entry.kind), bytes);
  await writeLinks(dir, { [file]: { generationId, sent: false } });
  return { files: [file] };
}

/** A shared asset: its file when it has one (Genex made it), else its code module (web games). */
async function addShared(deps: LibrarySharingDeps, project: string, slug: string): Promise<AddOutcome> {
  const manifest = await deps.manifest(slug);
  const asset = fieldOf(fieldOf(manifest, "manifest"), "asset");
  const fileUrl = libraryFileUrl(fieldOf(asset, "fileUrl"));
  const dir = deps.gameDir(project);
  if (fileUrl) {
    const bytes = await deps.download(fileUrl, LIBRARY_FILE_MAX_BYTES);
    const name = downloadName(fileUrl, slug, MEDIA_KIND[String(fieldOf(asset, "media"))] ?? LibraryKind.Model);
    return { files: [await place(dir, AddFolder.Community, name, bytes)] };
  }
  if (!(await deps.webGame(project))) throw new Error(MESSAGE.notWebGame);
  const written = await deps.vendorModule(dir, manifest);
  if (!written) throw new Error(MESSAGE.noFile);
  return { files: [written] };
}

/** Bring a library generation or a shared asset into the game. */
function addToGame(deps: LibrarySharingDeps, project: string, source: AddSource): Promise<AddOutcome> {
  if ("generationId" in source && isGenerationId(source.generationId)) {
    return addGeneration(deps, project, source.generationId);
  }
  if ("slug" in source && isPlaySlug(source.slug)) return addShared(deps, project, source.slug);
  return Promise.reject(new Error(MESSAGE.notFound));
}

/** A game's library sharing over `deps`. */
export function librarySharing(deps: LibrarySharingDeps) {
  return {
    states: (project: string) => readStates(deps, project),
    save: (project: string, files: readonly string[], saved: boolean) => saveFiles(deps, project, files, saved),
    share: (project: string, items: readonly ShareItem[]) => shareFiles(deps, project, items),
    unshare: (project: string, file: string) => unshareFile(deps, project, file),
    add: (project: string, source: AddSource) => addToGame(deps, project, source),
  };
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The game's library sharing as `librarySharing` makes it. */
export type LibrarySharing = ReturnType<typeof librarySharing>;
