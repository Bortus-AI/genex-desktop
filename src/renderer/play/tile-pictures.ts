/**
 * Pictures drawn from 3D library files for Play's asset tiles, pure: a few draw at a time in the order
 * the tiles asked, each is kept for the session (a file that itself cannot be drawn is not tried
 * again; one whose draw failed for a reason that may pass is, after a short rest), and the name the
 * model viewer reads a file under. `use-tile-picture.ts` draws them.
 */
import { assetExtension, assetPreviewMode } from "../../shared/asset-preview.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { fileUndrawable } from "../asset-snapshot.ts";

/** How many pictures draw at once: each holds a WebGL context and a decoded model while it draws. */
export const PICTURES_AT_ONCE = 2;
/** The most drawn pictures kept for the session; the oldest is forgotten first. */
export const PICTURES_KEPT = 120;
/**
 * How long a picture whose draw failed for a reason that may pass (offline, a slow host, a lost
 * graphics context) waits before its tile, next on screen, asks for it again.
 */
export const PICTURE_RETRY_MS = 30 * SECOND_MS;

const MESSAGE = {
  undrawable: "This file could not be drawn.",
  resting: "This file's picture is tried again shortly.",
} as const;

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
   * `url`'s picture: kept, or drawn in its turn. Rejects for a file that cannot be drawn, for one
   * resting after a draw that failed for a reason that may pass, and when `signal` aborts before its
   * turn; a draw once started runs on and is kept.
   */
  request(url: string, signal: AbortSignal): Promise<string>;
}

/** Places to draw in, at most `atOnce` taken at a time. */
interface DrawPlaces {
  /** A place: at once when one is free, else after the requests already waiting; rejects when `signal` aborts first. */
  take(signal: AbortSignal): Promise<void>;
  /** Hand a place on to the request waiting longest. */
  release(): void;
}

/** `atOnce` places to draw in, handed out in the order they were asked for. */
function drawPlaces(atOnce: number): DrawPlaces {
  const waiting: Array<() => void> = [];
  let running = 0;
  const take = (signal: AbortSignal): Promise<void> => {
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
  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  return { take, release };
}

/**
 * Pictures made by `draw`, at most `atOnce` at a time, the last `kept` of them kept. A draw that
 * rejects with a file that itself cannot be drawn ({@link fileUndrawable}) is not tried again; any
 * other failure rests the file for {@link PICTURE_RETRY_MS} by `now`.
 */
export function pictureQueue(
  draw: (url: string) => Promise<string>,
  {
    atOnce = PICTURES_AT_ONCE,
    kept = PICTURES_KEPT,
    now = Date.now,
  }: { atOnce?: number; kept?: number; now?: () => number } = {},
): PictureQueue {
  const pictures = new Map<string, string>();
  const failed = new Set<string>();
  /** When each file whose last draw failed for a reason that may pass may be drawn again. */
  const resting = new Map<string, number>();
  const drawing = new Map<string, Promise<string>>();
  const places = drawPlaces(atOnce);

  const keep = (url: string, picture: string): void => {
    pictures.set(url, picture);
    if (pictures.size <= kept) return;
    const oldest = pictures.keys().next().value;
    if (oldest !== undefined) pictures.delete(oldest);
  };

  /** What is known of `url` already: its picture, its draw under way, that it cannot be drawn or that it rests. */
  const known = (url: string): Promise<string> | null => {
    const picture = pictures.get(url);
    if (picture !== undefined) return Promise.resolve(picture);
    if (failed.has(url)) return Promise.reject(new Error(MESSAGE.undrawable));
    if (now() < (resting.get(url) ?? 0)) return Promise.reject(new Error(MESSAGE.resting));
    return drawing.get(url) ?? null;
  };

  /** Remember why `url` was not drawn: never again for the file itself, else after a rest. */
  const miss = (url: string, error: unknown): void => {
    if (fileUndrawable(error)) failed.add(url);
    else resting.set(url, now() + PICTURE_RETRY_MS);
  };

  /** Draw `url` in the place it holds, keep what it makes, then hand the place on. */
  const drawIn = (url: string): Promise<string> => {
    const work = Promise.resolve()
      .then(() => draw(url))
      .then(
        (picture) => {
          resting.delete(url);
          keep(url, picture);
          return picture;
        },
        (error: unknown) => {
          miss(url, error);
          throw error;
        },
      )
      .finally(() => {
        drawing.delete(url);
        places.release();
      });
    drawing.set(url, work);
    return work;
  };

  const request = async (url: string, signal: AbortSignal): Promise<string> => {
    const before = known(url);
    if (before) return before;
    await places.take(signal);
    // Another request for the same file may have drawn it, or started to, while this one waited.
    const meanwhile = known(url);
    if (!meanwhile) return drawIn(url);
    places.release();
    return meanwhile;
  };

  return { drawn: (url) => pictures.get(url), request };
}
