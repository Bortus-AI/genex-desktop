/**
 * A game page's Store section as read (marketplace plan 10.2): its Store tab, read when the page
 * opens; My items, read the first time it is chosen; both read again when the Genex account
 * changes and after a purchase or a claim. The page is the only reader, and it reads afresh on
 * every visit, so this stays the page's own state. A Store tab that cannot be read hides the
 * section, as one with nothing in it does.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreTab } from "../../shared/store-items.ts";
import { studio } from "../state/studio.ts";
import { MY_ITEMS_LOADING, type MyItemsRead, MyItemsStatus, myItemsRead, StoreView } from "./store-model.ts";

/** A game page's store: the tab shown, what was read, and a way to read it all again. */
export interface GameStoreRead {
  tab: StoreTab | null;
  mine: MyItemsRead;
  view: StoreView;
  choose(view: StoreView): void;
  /** Read the Store tab again, and My items once it has been chosen. */
  reread(): void;
}

/** The store of the game `slug`, as `account` (the Genex account's id, or null signed out) sees it. */
export function useGameStore(slug: string, account: string | null): GameStoreRead {
  const [tab, setTab] = useState<StoreTab | null>(null);
  const [mine, setMine] = useState<MyItemsRead>(MY_ITEMS_LOADING);
  const [view, setView] = useState<StoreView>(StoreView.Store);
  const wantsMine = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const readTab = useCallback(() => {
    void studio()
      .api.storeItems(slug)
      // An outage hides the section, as a store with nothing in it does; one read before stays.
      .then((read) => live.current && setTab(read))
      .catch(() => undefined);
  }, [slug]);
  const readMine = useCallback(() => {
    void studio()
      .api.storeMyItems(slug)
      .then((read) => live.current && setMine(myItemsRead(read)))
      .catch(() => live.current && setMine({ status: MyItemsStatus.Failed, items: [] }));
  }, [slug]);
  const reread = useCallback(() => {
    readTab();
    if (wantsMine.current) readMine();
  }, [readTab, readMine]);
  // The account signing in or out changes what is owned: read it all again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the account is what asks for the read.
  useEffect(() => reread(), [reread, account]);
  const choose = useCallback(
    (next: StoreView) => {
      setView(next);
      if (next !== StoreView.MyItems || wantsMine.current) return;
      wantsMine.current = true;
      readMine();
    },
    [readMine],
  );
  return { tab, mine, view, choose, reread };
}
