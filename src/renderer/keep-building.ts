/**
 * Keep building: after a Loop ended with something still to fix, the person's one tap starts the
 * chat's Loop again on what is left. The chat's result card calls its own send; the Builds card,
 * which has no composer, asks the chat that owns the run through this event.
 */
import { composerExtras, storedChatLoop } from "./loop-setting.ts";
import { browserStorage } from "./storage.ts";
import type { ComposerExtras } from "./ui/PromptBar.tsx";
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

/** The message Keep building sends: what is left, as the person's ask. */
export const keepBuildingAsk = (notDone: readonly string[]): string => STILL_TO_FIX_WORDS.ask(notDone);

/** The Loop Keep building starts: the chat's own Loop switched on, with the hours the person last picked. */
export function keepBuildingExtras(threadId: string): ComposerExtras {
  const own = storedChatLoop(browserStorage(), threadId);
  return composerExtras({
    gameMode: true,
    view: { shown: { on: true, hours: own.hours }, editable: true },
    reviewPlan: false,
    frames: [],
  });
}
