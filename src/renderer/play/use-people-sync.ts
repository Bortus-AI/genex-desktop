/**
 * Keeps what the app knows of the Genex account current: who it is signed in as (read at start,
 * whenever plugins or connections change, when the window comes back to the front, when the Mac is
 * back online, and every few seconds while a sign-in waits in the browser) and, while signed in,
 * the Friends page, so the plate's count of waiting requests stays true. The Friends page reads more
 * often while it is open. The first sign-in retires Play's Genex card for good.
 */
import { useEffect } from "react";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { usePeople, usePlay } from "../state/hooks.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { useBackOnline } from "../ui/use-online.ts";
import { dismissPlayPromo, playPromoRetires } from "./play-model.ts";

/** How often the Friends page is read again in the background, for the plate's count. */
const FRIENDS_BACKGROUND_MS = 2 * MINUTE_MS;
/** How often it is read while the Friends page is open: what genex.games itself polls at. */
const FRIENDS_OPEN_MS = 20 * SECOND_MS;
/** How often the account is read while a sign-in waits in the browser, so the plate fills in by itself. */
const SIGN_IN_POLL_MS = 2 * SECOND_MS;

/** Read the account and, while signed in, the Friends page; mounted once, by the sidebar. */
export function usePeopleSync(playOpen: boolean): void {
  const signedIn = usePeople((s) => s.me?.id ?? null);
  const account = usePeople((s) => s.account);
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
  // Back online, everything the account shows reads again by itself.
  useBackOnline(() => {
    const people = studio().people;
    void people.loadMe().then(() => people.loadFriends());
  });
  useEffect(() => {
    if (account !== GenexAccountStatus.SigningIn) return;
    const timer = window.setInterval(() => void studio().people.loadMe(), SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [account]);
  useEffect(() => {
    if (playPromoRetires(account)) dismissPlayPromo();
  }, [account]);
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
