/** Play: genex.games' catalog for the dashboard, and the full-screen viewer a game opens in. */
import { isPlayShelf, isPlaySlug, PlayShelf, readPlayPoint } from "../../shared/play.ts";
import type { PlayGallery, PlayWorld } from "../play/gallery.ts";
import type { PlayViewer } from "../play/viewer.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = { badSlug: "not a game address", noWindow: "the window is not open" } as const;

/** What Play's channels answer from. */
export interface PlayIpcDeps {
  gallery: PlayGallery;
  /** Copy a game's public source into a new game; answers its library name. */
  remix(world: PlayWorld): Promise<string>;
  /** The viewer in the studio window; null while there is none. */
  viewer(): PlayViewer | null;
}

/** Register Play's channels: the catalog's reads, Remix and the viewer. */
export function registerPlayIpc(handle: IpcHandle, { gallery, remix, viewer }: PlayIpcDeps): void {
  handle("studio:play.feed", (payload) => gallery.feed({ category: payload?.category, cursor: payload?.cursor }));
  handle("studio:play.shelves", () => gallery.shelves());
  handle("studio:play.search", (payload) =>
    gallery.search(String(payload?.query ?? ""), isPlayShelf(payload?.shelf) ? payload.shelf : PlayShelf.Games),
  );
  // A card's Remix: main reads the game's own page for its source, never an address from the renderer.
  handle("studio:play.remix", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    return remix(await gallery.world(payload.slug));
  });
  handle("studio:play.online", (payload) => gallery.online(Array.isArray(payload?.slugs) ? payload.slugs : []));
  // The renderer names a game by its slug; main builds every address from it.
  handle("studio:play.open", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    const shown = viewer();
    if (!shown) throw new Error(MESSAGE.noWindow);
    shown.open(payload.slug);
  });
  handle("studio:play.close", async () => viewer()?.close());
  // The header names a control (and where it is, for a menu); the viewer acts only on one it knows.
  handle("studio:play.control", async (payload) => viewer()?.control(payload?.control, readPlayPoint(payload?.at)));
}
