/**
 * Keeps what the app knows of the Genex account current: who it is signed in as (read at start,
 * whenever plugins or connections change, and when the window comes back to the front) and, while
 * signed in, the Friends page, so the plate's count of waiting requests stays true. The Friends page
 * reads more often while it is open.
 */
import { useEffect } from "react";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { usePeople, usePlay } from "../state/hooks.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";

/** How often the Friends page is read again in the background, for the plate's count. */
const FRIENDS_BACKGROUND_MS = 2 * MINUTE_MS;
/** How often it is read while the Friends page is open: what genex.games itself polls at. */
const FRIENDS_OPEN_MS = 20 * SECOND_MS;

/** Read the account and, while signed in, the Friends page; mounted once, by the sidebar. */
export function usePeopleSync(playOpen: boolean): void {
  const signedIn = usePeople((s) => s.me?.id ?? null);
  const friendsOpen = usePlay((s) => s.view.page === PlayPage.Friends) && playOpen;
  useEffect(() => {
    const people = studio().people;
    void people.loadMe();
    const reread = () => void people.loadMe();
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.ConnectionsChanged || event.type === UiEvent.PluginsChanged) reread();
    });
    window.addEventListener("focus", reread);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", reread);
    };
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    const people = studio().people;
    void people.loadFriends();
    const timer = window.setInterval(
      () => void people.loadFriends(),
      friendsOpen ? FRIENDS_OPEN_MS : FRIENDS_BACKGROUND_MS,
    );
    return () => window.clearInterval(timer);
  }, [signedIn, friendsOpen]);
}
