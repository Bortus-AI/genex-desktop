/**
 * Files dragged over a chat and dropped on its prompt bar: what is held, the one line the prompt
 * bar says about it, and what a drop leaves out. Pure, so each line is tested without a drag.
 */
import { MAX_REFERENCE_FRAMES, type PickedFrame } from "../reference-frames.ts";
import { COMPOSER_DROP_WORDS } from "../words.ts";

/** What a drag carries: how many of its files are pictures, and how many are not. */
export interface HeldFiles {
  pictures: number;
  others: number;
}

/** How the prompt bar takes what is held: blue while pictures can go in, orange when none can. */
export const DropTone = { Takes: "takes", Refuses: "refuses" } as const;
export type DropTone = (typeof DropTone)[keyof typeof DropTone];

/** What a drop left off the board: files that are not pictures, and pictures past the limit. */
export interface LeftOut {
  notPictures: string[];
  overLimit: number;
}

/** A drag item, as `DataTransferItem` describes it while the drag is still over the page. */
interface DragItem {
  kind: string;
  type: string;
}

const isPictureType = (type: string): boolean => type.startsWith("image/");

/** The files a drag carries, from its items; null when it carries none (text, a link, a tab). */
export function heldFiles(items: ArrayLike<DragItem> | undefined): HeldFiles | null {
  const files = Array.from(items ?? []).filter((item) => item.kind === "file");
  if (!files.length) return null;
  const pictures = files.filter((item) => isPictureType(item.type)).length;
  return { pictures, others: files.length - pictures };
}

/** The prompt bar's one line while files are held over the chat, given the pictures already on its board. */
export function dropLine(held: HeldFiles, attached: number): { tone: DropTone; words: string } {
  const room = Math.max(0, MAX_REFERENCE_FRAMES - attached);
  if (!held.pictures) return { tone: DropTone.Refuses, words: COMPOSER_DROP_WORDS.onlyPictures };
  if (!room) return { tone: DropTone.Refuses, words: COMPOSER_DROP_WORDS.boardFull(MAX_REFERENCE_FRAMES) };
  if (held.pictures > room)
    return { tone: DropTone.Refuses, words: COMPOSER_DROP_WORDS.someStayOut(room, held.pictures - room) };
  return { tone: DropTone.Takes, words: COMPOSER_DROP_WORDS.dropToAdd(held.pictures) };
}

/**
 * The board after adding pictures: new ones join in order up to the limit, a picture already on
 * it is not added twice, and `overLimit` counts the new ones that did not fit, with the files a
 * drop carried past the limit that were never read.
 */
export function addToBoard(
  current: PickedFrame[],
  picked: PickedFrame[],
  unread = 0,
): { frames: PickedFrame[]; overLimit: number } {
  const seen = new Set(current.map((frame) => frame.data));
  const fresh = picked.filter((frame) => !seen.has(frame.data));
  const room = Math.max(0, MAX_REFERENCE_FRAMES - current.length);
  return { frames: [...current, ...fresh.slice(0, room)], overLimit: Math.max(0, fresh.length - room) + unread };
}

/** The orange line under a drop that left something out, or null when everything went in. */
export function leftOutLine(left: LeftOut): string | null {
  const { notPictures, overLimit } = left;
  if (notPictures.length && overLimit) return COMPOSER_DROP_WORDS.filesLeftOut(notPictures.length + overLimit);
  if (notPictures.length === 1) return COMPOSER_DROP_WORDS.notAPicture(notPictures[0] ?? "");
  if (notPictures.length) return COMPOSER_DROP_WORDS.notPictures(notPictures.length);
  if (overLimit) return COMPOSER_DROP_WORDS.overLimit(overLimit, MAX_REFERENCE_FRAMES);
  return null;
}
