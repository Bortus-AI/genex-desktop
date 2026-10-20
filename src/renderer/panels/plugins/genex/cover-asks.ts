/**
 * A game's asks for another Genex cover or clip, kept on this Mac so Publish still says one is on
 * its way after it closes into the chat, and how long the last ask of each kind took, from the ask
 * to the new frame's own time, which the banner's "~2 min left" comes from. Pure, but for the
 * storage reads and writes, which never throw.
 */
import { MINUTE_MS } from "../../../../shared/duration.ts";
import type { GenexCoverRecord } from "../../../../shared/genex.ts";
import { browserStorage, type KeyValueStorage, readJson, storageKeyFor, writeJson } from "../../../storage.ts";
import { COVER_MAKING_MS, type CoverAskRecord } from "./genex-publish-view.ts";

/** What Another asks the game's chat for: a new cover picture, or a new clip. */
export const CoverKind = { Picture: "picture", Clip: "clip" } as const;
export type CoverKind = (typeof CoverKind)[keyof typeof CoverKind];

const KINDS: readonly string[] = Object.values(CoverKind);

/** An ask still waiting: which kind, besides the frame it was asked over and when. */
export interface CoverAsk extends CoverAskRecord {
  kind: CoverKind;
}

/** One game's asks: the one still waiting, and how long the last answered ask of each kind took (ms). */
export interface CoverAskMemory {
  ask: CoverAsk | null;
  took: Partial<Record<CoverKind, number>>;
}

const NOTHING_ASKED: CoverAskMemory = { ask: null, took: {} };

/** A time the banner can count down from: after the ask, and inside the wait. */
const measurable = (ms: number): boolean => Number.isFinite(ms) && ms > 0 && ms < COVER_MAKING_MS;

/**
 * The memory once the game's cover record is read at `now`: a new frame of the asked kind answers
 * the ask, timed by when that frame was taken (so a late read still times it right); an ask no frame
 * answered within the wait is dropped untimed. Unchanged, it is the same object.
 */
export function settleCoverAsk(memory: CoverAskMemory, record: GenexCoverRecord, now: number): CoverAskMemory {
  const ask = memory.ask;
  if (!ask) return memory;
  const current = ask.kind === CoverKind.Clip ? record.clip : record.shot;
  if (current && current.sha256 !== ask.from) {
    const took = Date.parse(current.takenAt) - ask.at;
    return { ask: null, took: measurable(took) ? { ...memory.took, [ask.kind]: took } : memory.took };
  }
  if (now - ask.at >= COVER_MAKING_MS) return { ask: null, took: memory.took };
  return memory;
}

/** Whole minutes left, rounded up, when the last ask of this kind took `took` and `elapsed` has passed; null untimed or overrun. */
export function coverMinutesLeft(took: number | undefined, elapsed: number): number | null {
  if (took === undefined) return null;
  const left = took - elapsed;
  return left > 0 ? Math.ceil(left / MINUTE_MS) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readAsk(value: unknown): CoverAsk | null {
  if (!isRecord(value)) return null;
  const { kind, from, at } = value;
  const sound = typeof kind === "string" && KINDS.includes(kind) && typeof at === "number" && Number.isFinite(at);
  if (!sound || !(from === null || typeof from === "string")) return null;
  return { kind: kind as CoverKind, from, at };
}

function readTook(value: unknown): CoverAskMemory["took"] {
  if (!isRecord(value)) return {};
  const took: CoverAskMemory["took"] = {};
  for (const kind of Object.values(CoverKind)) {
    const ms = value[kind];
    if (typeof ms === "number" && measurable(ms)) took[kind] = ms;
  }
  return took;
}

/** The game's kept asks; anything unsound in storage reads as nothing asked. */
export function readCoverAsks(project: string, storage: KeyValueStorage | null = browserStorage()): CoverAskMemory {
  const kept: unknown = readJson(storageKeyFor.coverAsks(project), null, storage);
  if (!isRecord(kept)) return NOTHING_ASKED;
  return { ask: readAsk(kept.ask), took: readTook(kept.took) };
}

/** Keep the game's asks; a write that fails leaves the last kept ones. */
export function writeCoverAsks(
  project: string,
  memory: CoverAskMemory,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  writeJson(storageKeyFor.coverAsks(project), memory, storage);
}
