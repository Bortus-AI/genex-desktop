/**
 * A remix made in Play opens in Create: from a card's Remix (its answer) or from the viewer's menu
 * (main's `UiEvent.PlayViewer` names the new game once the viewer has closed). One that fails after
 * its viewer closed is told as a toast.
 */
import { useCallback, useEffect } from "react";
import type { Navigation } from "../shell/use-navigation.ts";
import { usePlay } from "../state/hooks.ts";
import { remixFailureTold, remixOpened } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { PLAY_WORDS } from "../words.ts";

/** Open a remix by its library name in Create; the viewer's remixes open as they arrive. */
export function usePlayRemixes(navigation: Pick<Navigation, "enterProject">): (name: string) => void {
  const { enterProject } = navigation;
  const open = useCallback((name: string) => void enterProject(name, true), [enterProject]);
  const remixed = usePlay((s) => s.remixed);
  const remixFailed = usePlay((s) => s.remixFailed);
  useEffect(() => {
    if (!remixed) return;
    studio().play.setState(remixOpened, true);
    open(remixed);
  }, [remixed, open]);
  useEffect(() => {
    if (!remixFailed) return;
    const app = studio();
    app.play.setState(remixFailureTold, true);
    app.notify(PLAY_WORDS.remixFailed, ToastTone.Error);
  }, [remixFailed]);
  return open;
}
