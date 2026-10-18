/**
 * The open chat answers Keep building (`keep-building.ts`): a tap on its result card or on its
 * run's Builds card sends what is left as the person's message, with the chat's Loop switched on as
 * its composer's Mode would (`PromptBarHandle.loopOn`). A tap while that send is under way sends nothing.
 */
import { type RefObject, useEffect, useRef } from "react";
import { KEEP_BUILDING_EVENT, type KeepBuilding, keepBuildingAsk, oneAtATime } from "../keep-building.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import type { Send } from "./use-submit.ts";

export function useKeepBuilding(
  threadId: string | undefined,
  submit: Send,
  onNotice: Notify,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const latest = useRef({ threadId, submit, onNotice });
  latest.current = { threadId, submit, onNotice };
  useEffect(() => {
    const sendOnce = oneAtATime(async (notDone: string[]) => {
      const extras = composer.current?.loopOn();
      if (!extras) return;
      const { submit: send, onNotice: notify } = latest.current;
      await send(keepBuildingAsk(notDone), extras, true).catch(notifyProblem(notify));
    });
    const keep = (event: Event): void => {
      const detail = (event as CustomEvent<KeepBuilding>).detail;
      if (!detail?.threadId || detail.threadId !== latest.current.threadId || !detail.notDone.length) return;
      void sendOnce(detail.notDone);
    };
    window.addEventListener(KEEP_BUILDING_EVENT, keep);
    return () => window.removeEventListener(KEEP_BUILDING_EVENT, keep);
  }, [composer]);
}
