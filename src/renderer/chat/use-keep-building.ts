/**
 * The open chat answers Keep building (`keep-building.ts`): a tap on its result card or on its
 * run's Builds card sends what is left as the person's message, with the chat's Loop on.
 */
import { useEffect, useRef } from "react";
import { KEEP_BUILDING_EVENT, type KeepBuilding, keepBuildingAsk, keepBuildingExtras } from "../keep-building.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import type { Send } from "./use-submit.ts";

export function useKeepBuilding(threadId: string | undefined, submit: Send, onNotice: Notify): void {
  const latest = useRef({ threadId, submit, onNotice });
  latest.current = { threadId, submit, onNotice };
  useEffect(() => {
    const keep = (event: Event): void => {
      const detail = (event as CustomEvent<KeepBuilding>).detail;
      const { threadId: open, submit: send, onNotice: notify } = latest.current;
      if (!detail?.threadId || detail.threadId !== open || !detail.notDone.length) return;
      void send(keepBuildingAsk(detail.notDone), keepBuildingExtras(detail.threadId), true).catch(
        notifyProblem(notify),
      );
    };
    window.addEventListener(KEEP_BUILDING_EVENT, keep);
    return () => window.removeEventListener(KEEP_BUILDING_EVENT, keep);
  }, []);
}
