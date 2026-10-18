/**
 * Pictures drawn from 3D library files for Play's asset tiles, pure: a few draw at a time in the order
 * the tiles asked, each is kept for the session (a file that could not be drawn is not tried again),
 * and the name the model viewer reads a file under. `use-tile-picture.ts` draws them.
 */
import { assetExtension, assetPreviewMode } from "../../shared/asset-preview.ts";

/** How many pictures draw at once: each holds a WebGL context and a decoded model while it draws. */
export const PICTURES_AT_ONCE = 2;
/** The most drawn pictures kept for the session; the oldest is forgotten first. */
export const PICTURES_KEPT = 120;

const MESSAGE = { undrawable: "This file could not be drawn." } as const;

/**
 * The name the model viewer reads a library file under, whose extension picks its loader: the file's
 * own model extension, else a GLB (genex.games keeps its 3D files as GLB under a role name).
 */
export function viewerFileOf(url: string): string {
  const name = URL.canParse(url) ? (new URL(url).pathname.split("/").at(-1) ?? "") : "";
  const own = name.toLowerCase();
  return assetPreviewMode(own) === "model" ? `model.${assetExtension(own)}` : "model.glb";
}

/** A session's drawn pictures, and the turns of those still to draw. */
export interface PictureQueue {
  /** The picture drawn for `url` this session, if it has one. */
  drawn(url: string): string | undefined;
  /**
   * `url`'s picture: kept, or drawn in its turn. Rejects for a file that could not be drawn, and when
   * `signal` aborts before its turn; a draw once started runs on and is kept.
   */
  request(url: string, signal: AbortSignal): Promise<string>;
}

/** Pictures made by `draw`, at most `atOnce` at a time, the last `kept` of them kept. */
export function pictureQueue(
  draw: (url: string) => Promise<string>,
  { atOnce = PICTURES_AT_ONCE, kept = PICTURES_KEPT }: { atOnce?: number; kept?: number } = {},
): PictureQueue {
  const pictures = new Map<string, string>();
  const failed = new Set<string>();
  const drawing = new Map<string, Promise<string>>();
  const waiting: Array<() => void> = [];
  let running = 0;

  /** A place to draw in: at once when one is free, else after the requests already waiting. */
  const turn = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (running < atOnce) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = (): void => {
        signal.removeEventListener("abort", leave);
        running += 1;
        resolve();
      };
      const leave = (): void => {
        const at = waiting.indexOf(go);
        if (at >= 0) waiting.splice(at, 1);
        reject(signal.reason);
      };
      waiting.push(go);
      signal.addEventListener("abort", leave, { once: true });
    });
  };

  /** Hand a place on to the request waiting longest. */
  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };

  const keep = (url: string, picture: string): void => {
    pictures.set(url, picture);
    if (pictures.size <= kept) return;
    const oldest = pictures.keys().next().value;
    if (oldest !== undefined) pictures.delete(oldest);
  };

  /** What is known of `url` already: its picture, its draw under way, or that it cannot be drawn. */
  const known = (url: string): Promise<string> | null => {
    const picture = pictures.get(url);
    if (picture !== undefined) return Promise.resolve(picture);
    if (failed.has(url)) return Promise.reject(new Error(MESSAGE.undrawable));
    return drawing.get(url) ?? null;
  };

  /** Draw `url` in the place it holds, keep what it makes, then hand the place on. */
  const drawIn = (url: string): Promise<string> => {
    const work = Promise.resolve()
      .then(() => draw(url))
      .then(
        (picture) => {
          keep(url, picture);
          return picture;
        },
        (error: unknown) => {
          failed.add(url);
          throw error;
        },
      )
      .finally(() => {
        drawing.delete(url);
        release();
      });
    drawing.set(url, work);
    return work;
  };

  const request = async (url: string, signal: AbortSignal): Promise<string> => {
    const before = known(url);
    if (before) return before;
    await turn(signal);
    // Another request for the same file may have drawn it, or started to, while this one waited.
    const meanwhile = known(url);
    if (!meanwhile) return drawIn(url);
    release();
    return meanwhile;
  };

  return { drawn: (url) => pictures.get(url), request };
}
