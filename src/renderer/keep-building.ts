/**
 * Keep building: after a Loop ended with something still to fix, the person's one tap starts the
 * chat's Loop again on what is left. The chat's result card and the Builds card both ask the chat
 * that owns the run through this event; the chat sends it through its composer (`loopOn`).
 */
import { RunState } from "../shared/run-state.ts";
import type { HistoryEntry } from "./build-progress.ts";
import { STILL_TO_FIX_WORDS } from "./words.ts";

export const KEEP_BUILDING_EVENT = "studio:keep-building";

/** A Keep building tap: the chat whose run it was, and what that run left to fix. */
export interface KeepBuilding {
  threadId: string;
  notDone: string[];
}

/** Ask the chat that owns the run to keep building on what is left. */
export function keepBuilding(detail: KeepBuilding): void {
  window.dispatchEvent(new CustomEvent<KeepBuilding>(KEEP_BUILDING_EVENT, { detail }));
}

/**
 * Whether a chat's result card offers Keep building: only its newest one (`latest`), and only while
 * nothing of the chat runs or waits paused (a Resume belongs to that run).
 */
export function keepsBuildingIn(
  card: { latest?: true },
  chat: { activeRunId: string | null; pausedRunId: string | null },
): boolean {
  return card.latest === true && !chat.activeRunId && !chat.pausedRunId;
}

/** A send that runs one at a time: a call while the last one is under way does nothing. */
export function oneAtATime<Args extends unknown[]>(
  send: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let busy = false;
  return async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await send(...args);
    } finally {
      busy = false;
    }
  };
}

/**
 * Whether the Builds card offers Keep building on a run: only on the chat's newest build, once it
 * ended (a paused one keeps Resume, and a newer build or chat turn makes this one history).
 */
export function keepsBuildingOn(builds: readonly HistoryEntry[], runId: string | null | undefined): boolean {
  const newest = builds.at(-1);
  if (!runId || !newest || newest.chat) return false;
  return newest.runId === runId && newest.state === RunState.Finished;
}

/** The message Keep building sends: what is left, as the person's ask. */
export const keepBuildingAsk = (notDone: readonly string[]): string => STILL_TO_FIX_WORDS.ask(notDone);
