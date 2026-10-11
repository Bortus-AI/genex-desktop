/**
 * Play: the shelf shown, the shelves' counts and tabs, the pages of genex.games' catalog read so far,
 * Recent, and the game the viewer shows. A tab read once draws at once when it comes back, and is read again behind it once a
 * minute old. Opening a game shows its cover at once and remembers it in Recent; main's
 * `UiEvent.PlayViewer` then says how the viewer goes.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  PLAY_SHELF_TABS,
  PLAY_SHELVES,
  type PlayCategory,
  type PlayFeedPage,
  type PlayGame,
  PlayShelf,
  type PlayShelves,
  type PlayViewerEvent,
  PlayViewerPhase,
} from "../../shared/play.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import {
  countedSlugs,
  EMPTY_FEED,
  type FeedState,
  FeedStatus,
  type PlayRecentEntry,
  readRecent,
  type ViewerShown,
  viewerAfter,
  withOnline,
  withPage,
  withRecent,
  writeRecent,
} from "../play/play-model.ts";
import type { KeyValueStorage } from "../storage.ts";

/** A tab this old is read again behind what it shows. */
export const FEED_STALE_MS = MINUTE_MS;

/** What Play holds between visits. */
export interface PlayState {
  /** The shelf the sidebar has chosen: Games, Tools or Assets. */
  shelf: PlayShelf;
  /** Each shelf's size beside its name; null until it is read. */
  counts: PlayShelves["counts"];
  /** The tabs with something in them, shelf by shelf; each shelf's first alone until they are read. */
  categories: PlayCategory[];
  feeds: Partial<Record<PlayCategory, FeedState>>;
  recent: PlayRecentEntry[];
  /** The game the viewer shows, or null. */
  viewer: ViewerShown | null;
  /** A remix made from the viewer, waiting for the shell to open it in Create. */
  remixed: string | null;
  /** A remix failed after its viewer had closed: the shell says so once. */
  remixFailed: boolean;
  /** The viewer's guest card asked for the Genex plugin: the shell runs Install plugin once. */
  installAsked: boolean;
}

/** Play before anything is read: on Games, each shelf's first tab, and Recent as this profile remembers it. */
export const initialPlay = (recent: PlayRecentEntry[] = []): PlayState => ({
  shelf: PlayShelf.Games,
  counts: { [PlayShelf.Games]: null, [PlayShelf.Tools]: null, [PlayShelf.Assets]: null },
  categories: PLAY_SHELVES.map((shelf) => PLAY_SHELF_TABS[shelf][0]),
  feeds: {},
  recent,
  viewer: null,
  remixed: null,
  remixFailed: false,
  installAsked: false,
});

/** A tab's state, or the empty one. */
export const feedOf = (state: PlayState, category: PlayCategory): FeedState => state.feeds[category] ?? EMPTY_FEED;

const withFeed = (state: PlayState, category: PlayCategory, feed: FeedState): PlayState => ({
  ...state,
  feeds: { ...state.feeds, [category]: feed },
});

/** The shelves were read: their counts, and their tabs when the read named any. */
export const shelvesLoaded = (state: PlayState, shelves: PlayShelves): PlayState =>
  shelves.categories.length > 0 ? { ...state, counts: shelves.counts, categories: shelves.categories } : state;

/** The sidebar turned to `shelf`. */
export const shelfChosen = (state: PlayState, shelf: PlayShelf): PlayState =>
  state.shelf === shelf ? state : { ...state, shelf };

/** A page is on its way: a tab with nothing yet says it is loading; one with games keeps them. */
export function feedRequested(state: PlayState, category: PlayCategory, more: boolean): PlayState {
  const feed = feedOf(state, category);
  if (more) return withFeed(state, category, { ...feed, loadingMore: true, moreFailed: false });
  if (feed.games.length > 0) return state;
  return withFeed(state, category, { ...feed, status: FeedStatus.Loading });
}

/** A page arrived. */
export const feedLoaded = (
  state: PlayState,
  category: PlayCategory,
  page: PlayFeedPage,
  more: boolean,
  at: number,
): PlayState => withFeed(state, category, withPage(feedOf(state, category), page, more, at));

/**
 * A page could not be read: a tab with games keeps them (a further page's failure is said under
 * them), an empty one says it failed.
 */
export function feedFailed(state: PlayState, category: PlayCategory, more: boolean): PlayState {
  const feed = feedOf(state, category);
  if (more) return withFeed(state, category, { ...feed, loadingMore: false, moreFailed: true });
  if (feed.games.length > 0) return withFeed(state, category, { ...feed, loadingMore: false });
  return withFeed(state, category, { ...feed, status: FeedStatus.Failed, loadingMore: false });
}

/** A further page arrived for a list a newer first page has replaced: it lands nowhere. */
const moreDropped = (state: PlayState, category: PlayCategory): PlayState =>
  withFeed(state, category, { ...feedOf(state, category), loadingMore: false });

/** Players were counted for a tab's games. */
export function onlineCounted(state: PlayState, category: PlayCategory, counts: Record<string, number>): PlayState {
  const feed = feedOf(state, category);
  const games = withOnline(feed.games, counts);
  return games === feed.games ? state : withFeed(state, category, { ...feed, games });
}

/** A game was opened: its cover shows at once, and it leads Recent. */
export function gameOpened(state: PlayState, game: PlayRecentEntry): PlayState {
  return {
    ...state,
    recent: withRecent(state.recent, { slug: game.slug, title: game.title, coverUrl: game.coverUrl }),
    viewer: {
      slug: game.slug,
      title: game.title,
      coverUrl: game.coverUrl,
      phase: PlayViewerPhase.Loading,
      openId: null,
    },
  };
}

/**
 * Main's news about the viewer; a finished remix, a late remix's failure, or the guest card's
 * Install plugin waits for the shell.
 */
export function viewerReported(state: PlayState, event: PlayViewerEvent): PlayState {
  const viewer = viewerAfter(state.viewer, event);
  const remixed = event.remixed ?? state.remixed;
  const remixFailed = state.remixFailed || event.remixFailed === true;
  const installAsked = state.installAsked || event.install === true;
  const same =
    viewer === state.viewer &&
    remixed === state.remixed &&
    remixFailed === state.remixFailed &&
    installAsked === state.installAsked;
  return same ? state : { ...state, viewer, remixed, remixFailed, installAsked };
}

/** Main never answered the opening shown: its cover says it failed, with Try again. */
export function openRefused(state: PlayState, slug: string): PlayState {
  const shown = state.viewer;
  if (shown?.slug !== slug || shown.openId !== null) return state;
  return { ...state, viewer: { ...shown, phase: PlayViewerPhase.Failed } };
}

/** The shell opened the remix in Create. */
export const remixOpened = (state: PlayState): PlayState =>
  state.remixed === null ? state : { ...state, remixed: null };

/** The shell told a late remix's failure. */
export const remixFailureTold = (state: PlayState): PlayState =>
  state.remixFailed ? { ...state, remixFailed: false } : state;

/** The shell ran the guest card's Install plugin. */
export const installAnswered = (state: PlayState): PlayState =>
  state.installAsked ? { ...state, installAsked: false } : state;

/** Play's store and the reads and actions it runs. */
export interface PlayStore extends StoreApi<PlayState> {
  /** Read the shelves' counts and which tabs have something in them. */
  loadShelves(): Promise<void>;
  /** Show another shelf. */
  chooseShelf(shelf: PlayShelf): void;
  /** Read a tab's first page (when it has none or is stale), or with `more` its next one. */
  loadFeed(category: PlayCategory, options?: { more?: boolean; force?: boolean }): Promise<void>;
  /** Count the players in a tab's multiplayer games. */
  countOnline(category: PlayCategory): Promise<void>;
  /** Open a game in the viewer. */
  open(game: PlayRecentEntry): Promise<void>;
  close(): Promise<void>;
  retry(): Promise<void>;
  /** Copy a card's game into a new game of the person's own; answers its library name. */
  remix(game: PlayGame): Promise<string>;
}

type PlayApi = Pick<StudioApi, "playFeed" | "playShelves" | "playOnline" | "playOpen" | "playClose" | "playRemix">;

/** Play's store over `api`, remembering Recent in `storage`. */
export function createPlayStore(
  api: PlayApi,
  storage: KeyValueStorage | null,
  now: () => number = Date.now,
): PlayStore {
  const store = createStore<PlayState>()(() => initialPlay(readRecent(storage)));
  const set = (change: (state: PlayState) => PlayState) => store.setState(change, true);
  const inFlight = new Map<string, Promise<void>>();
  /** Each tab's first-page reads so far: a further page read before the latest one lands nowhere. */
  const firstReads = new Map<PlayCategory, number>();

  const loadShelves = async (): Promise<void> => {
    try {
      const shelves = await api.playShelves();
      set((state) => shelvesLoaded(state, shelves));
    } catch {
      // Each shelf's first tab stays; the next visit asks again.
    }
  };

  const read = async (category: PlayCategory, more: boolean): Promise<void> => {
    const cursor = more ? feedOf(store.getState(), category).nextCursor : null;
    if (!more) firstReads.set(category, (firstReads.get(category) ?? 0) + 1);
    const generation = firstReads.get(category) ?? 0;
    // A further page continues the list it was asked for; a first page read since replaced that list.
    const stale = () => more && firstReads.get(category) !== generation;
    set((state) => feedRequested(state, category, more));
    try {
      const page = await api.playFeed({ category, cursor });
      set((state) => (stale() ? moreDropped(state, category) : feedLoaded(state, category, page, more, now())));
    } catch {
      set((state) => feedFailed(state, category, more));
    }
  };

  const loadFeed = (category: PlayCategory, options: { more?: boolean; force?: boolean } = {}): Promise<void> => {
    const more = options.more === true;
    const feed = feedOf(store.getState(), category);
    if (more && (!feed.nextCursor || feed.loadingMore)) return Promise.resolve();
    const fresh = feed.status === FeedStatus.Ready && now() - feed.at < FEED_STALE_MS;
    if (!more && fresh && !options.force) return Promise.resolve();
    const key = `${category}:${more ? "more" : "first"}`;
    const running = inFlight.get(key);
    if (running) return running;
    const started = read(category, more).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  const countOnline = async (category: PlayCategory): Promise<void> => {
    const slugs = countedSlugs(feedOf(store.getState(), category).games);
    if (slugs.length === 0) return;
    try {
      const counts = await api.playOnline(slugs);
      set((state) => onlineCounted(state, category, counts));
    } catch {
      // The last counts stay.
    }
  };

  const open = async (game: PlayRecentEntry): Promise<void> => {
    set((state) => gameOpened(state, game));
    writeRecent(store.getState().recent, storage);
    try {
      await api.playOpen(game.slug);
    } catch {
      set((state) => openRefused(state, game.slug));
    }
  };

  return Object.assign(store, {
    loadShelves,
    chooseShelf: (shelf: PlayShelf) => set((state) => shelfChosen(state, shelf)),
    loadFeed,
    countOnline,
    open,
    close: () => api.playClose(),
    retry: async () => {
      const shown = store.getState().viewer;
      if (shown) await open(shown);
    },
    remix: (game: PlayGame) => api.playRemix(game.slug),
  });
}
