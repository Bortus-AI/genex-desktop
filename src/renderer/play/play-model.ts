/**
 * Play's decisions, pure: which tabs a shelf shows, how a tab's pages add up, how counts read, which games are Recent, when
 * the sidebar's Genex card shows and what its button does, what the viewer's cover says, which header
 * button wears a note, and when the window's drag regions give way to the viewer's native views. `PlayRoom.tsx`, `PlayRecent.tsx`,
 * `PlayPromo.tsx`, `PlayViewerLayer.tsx` and `App.tsx` draw what these decide.
 */
import {
  isPlaySlug,
  PLAY_SHELF_TABS,
  type PlayBarState,
  type PlayCategory,
  PlayControl,
  type PlayGame,
  PlayNote,
  type PlayShelf,
  type PlayViewerEvent,
  PlayViewerPhase,
  shelfOf,
} from "../../shared/play.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import {
  type KeyValueStorage,
  browserStorage,
  readJson,
  readText,
  STORAGE_KEYS,
  writeJson,
  writeText,
} from "../storage.ts";

/** `shelf`'s tabs among the ones shown, in order; its first tab when none of its are shown. */
export function shelfTabs(shown: readonly PlayCategory[], shelf: PlayShelf): PlayCategory[] {
  const tabs = shown.filter((category) => shelfOf(category) === shelf);
  return tabs.length > 0 ? tabs : [PLAY_SHELF_TABS[shelf][0]];
}

/** How many games Recent keeps. */
export const RECENT_MAX = 12;

/** A game in Recent: enough to draw its row and open it again. */
export interface PlayRecentEntry {
  slug: string;
  title: string;
  coverUrl: string | null;
}

/** `game` first in Recent, once, with the list kept to {@link RECENT_MAX}. */
export function withRecent(list: readonly PlayRecentEntry[], game: PlayRecentEntry): PlayRecentEntry[] {
  return [game, ...list.filter((entry) => entry.slug !== game.slug)].slice(0, RECENT_MAX);
}

const isRecentEntry = (value: unknown): value is PlayRecentEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const cover = entry.coverUrl;
  return (
    isPlaySlug(entry.slug) &&
    typeof entry.title === "string" &&
    entry.title.length > 0 &&
    (cover === null || typeof cover === "string")
  );
};

/** Recent as this profile remembers it: each game once; anything that does not read as a game is left out. */
export function readRecent(storage: KeyValueStorage | null = browserStorage()): PlayRecentEntry[] {
  const stored = readJson<unknown>(STORAGE_KEYS.playRecent, [], storage);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  return stored
    .filter(isRecentEntry)
    .filter((entry) => !seen.has(entry.slug) && Boolean(seen.add(entry.slug)))
    .slice(0, RECENT_MAX);
}

/** Remember Recent on this profile. */
export function writeRecent(
  list: readonly PlayRecentEntry[],
  storage: KeyValueStorage | null = browserStorage(),
): void {
  writeJson(STORAGE_KEYS.playRecent, list, storage);
}

/** A count as a card shows it: 999, 2.7k, 12k, 1.4M. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.floor(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? trimmed(thousands) : Math.floor(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? trimmed(millions) : Math.floor(millions)}M`;
}

/** One decimal, rounded down and dropped when it is zero: 2.7, 6, 9.9. */
const trimmed = (value: number): string => {
  const tenths = Math.floor(value * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
};

/** A tab as the dashboard has it. */
export interface FeedState {
  games: PlayGame[];
  nextCursor: string | null;
  /** The first page is on its way (nothing to show yet), here, or failed. */
  status: FeedStatus;
  /** A further page is on its way. */
  loadingMore: boolean;
  /** The last further page could not be read: the grid says so under its cards until it is asked again. */
  moreFailed: boolean;
  /** When the first page arrived; a tab older than a minute is read again behind what it shows. */
  at: number;
}

/** Where a tab's first page stands. Never rename a value. */
export const FeedStatus = { Loading: "loading", Ready: "ready", Failed: "failed" } as const;
export type FeedStatus = (typeof FeedStatus)[keyof typeof FeedStatus];

/** A tab before its first page. */
export const EMPTY_FEED: FeedState = {
  games: [],
  nextCursor: null,
  status: FeedStatus.Loading,
  loadingMore: false,
  moreFailed: false,
  at: 0,
};

/** A tab after a page: the first one replaces what was there, a further one adds the games it does not have yet. */
export function withPage(
  state: FeedState,
  page: { games: readonly PlayGame[]; nextCursor: string | null },
  more: boolean,
  at: number,
): FeedState {
  if (!more)
    return {
      games: [...page.games],
      nextCursor: page.nextCursor,
      status: FeedStatus.Ready,
      loadingMore: false,
      moreFailed: false,
      at,
    };
  const seen = new Set(state.games.map((game) => game.id));
  const added = page.games.filter((game) => !seen.has(game.id));
  return {
    ...state,
    games: [...state.games, ...added],
    nextCursor: page.nextCursor,
    loadingMore: false,
    moreFailed: false,
  };
}

/** How far the cards move before the dashboard's bar answers, so a trackpad's jitter does not flicker it. */
const BAR_SCROLL_SLACK = 4;

/** The dashboard's bar as the cards scroll: where they were last answered, and whether the bar is away. */
export interface BarScroll {
  top: number;
  hidden: boolean;
}

/** The bar with the cards at the top. */
export const BAR_AT_TOP: BarScroll = { top: 0, hidden: false };

/**
 * The bar once the cards scrolled to `top`: there while they are within its own height of the top,
 * away while they move on down, back as soon as they move up. A move inside the slack changes
 * nothing (the same object comes back).
 */
export function barAfterScroll(before: BarScroll, top: number, barHeight: number): BarScroll {
  if (top <= barHeight) return before.hidden ? { top, hidden: false } : before;
  const moved = top - before.top;
  if (Math.abs(moved) < BAR_SCROLL_SLACK) return before;
  return { top, hidden: moved > 0 };
}

/** The games with players counted now; a game whose count did not change stays the same object. */
export function withOnline(games: readonly PlayGame[], counts: Readonly<Record<string, number>>): PlayGame[] {
  let changed = false;
  const next = games.map((game) => {
    const online = counts[game.slug];
    if (!game.multiplayer || online === undefined || online === game.online) return game;
    changed = true;
    return { ...game, online };
  });
  return changed ? next : (games as PlayGame[]);
}

/** The slugs of the multiplayer games a page shows, whose players are worth counting. */
export const countedSlugs = (games: readonly PlayGame[]): string[] =>
  games.filter((game) => game.multiplayer).map((game) => game.slug);

/** The Genex card's stored value once it is dismissed. Persisted: never rename it. */
export const PLAY_PROMO_DONE = "done";

/** Whether the Genex card was dismissed for good on this profile. */
export const playPromoDismissed = (storage: KeyValueStorage | null = browserStorage()): boolean =>
  readText(STORAGE_KEYS.playPromo, storage) === PLAY_PROMO_DONE;

/** Dismiss the Genex card for good. */
export function dismissPlayPromo(storage: KeyValueStorage | null = browserStorage()): void {
  writeText(STORAGE_KEYS.playPromo, PLAY_PROMO_DONE, storage);
}

/** The Genex plugin as the plugins store has it: installed (not removed or unlisted) and switched on. */
export type GenexPluginState = { installed: boolean; enabled: boolean } | undefined;

/** Whether the Genex plugin is there and on. */
const genexLive = (plugin: GenexPluginState): boolean => Boolean(plugin?.installed && plugin.enabled);

/**
 * Whether the sidebar's Genex card shows: never once dismissed; otherwise until Genex is installed,
 * on and its account connected, which is what publishing to Play takes.
 */
export function playPromoVisible(input: {
  dismissed: boolean;
  plugin: GenexPluginState;
  account: PluginAccountState | undefined;
}): boolean {
  if (input.dismissed) return false;
  return !(genexLive(input.plugin) && input.account === PluginAccountState.Unlocked);
}

/** What the card's button does: connect the account, or open Plugins to install or switch Genex on. */
export const PlayInstall = { Connect: "connect", OpenPlugins: "open-plugins" } as const;
export type PlayInstall = (typeof PlayInstall)[keyof typeof PlayInstall];

/** What Install plugin does for the Genex plugin as it is. */
export const playInstallAction = (plugin: GenexPluginState): PlayInstall =>
  genexLive(plugin) ? PlayInstall.Connect : PlayInstall.OpenPlugins;

/** The game the viewer's cover shows while the game itself is not on screen. */
export interface ViewerShown {
  slug: string;
  title: string;
  coverUrl: string | null;
  phase: PlayViewerPhase;
  /** Main's id for this opening, once its first news has come; null while only the renderer has opened it. */
  openId: number | null;
  /** The header as main last drew it; none until it has. */
  bar?: PlayBarState;
  /** How many times an Esc held in the game has asked for the header to take the keyboard. */
  focusAsks?: number;
}

/**
 * The viewer's cover after main's news. Only news of the opening shown counts: until main has
 * answered an opening the renderer made, the closing of an earlier one (Try again closes the game it
 * replaces) is not about it, and the first other news names it. A closed viewer shows nothing.
 */
export function viewerAfter(shown: ViewerShown | null, event: PlayViewerEvent): ViewerShown | null {
  if (!shown || event.slug !== shown.slug) return shown;
  if (shown.openId === null) {
    if (event.phase === PlayViewerPhase.Closed) return shown;
    return withHeader({ ...shown, openId: event.openId, phase: event.phase }, event);
  }
  if (event.openId !== shown.openId) return shown;
  if (event.phase === PlayViewerPhase.Closed) return null;
  const changed = event.phase !== shown.phase || event.bar !== undefined || event.focusBar === true;
  return changed ? withHeader({ ...shown, phase: event.phase }, event) : shown;
}

/** `shown` with the header the news draws, and one more ask for its keyboard when the news asks. */
function withHeader(shown: ViewerShown, event: PlayViewerEvent): ViewerShown {
  const drawn = event.bar === undefined ? shown : { ...shown, bar: event.bar };
  return event.focusBar ? { ...drawn, focusAsks: (drawn.focusAsks ?? 0) + 1 } : drawn;
}

/**
 * Whether the game's native view lies over the window under the header: once it plays. Not while it
 * loads (the view is not shown yet), once it failed (main hides it), nor with no game open.
 */
export const nativeViewsUp = (viewer: ViewerShown | null): boolean => viewer?.phase === PlayViewerPhase.Playing;

/**
 * Whether Esc in the app leaves the viewer: while the cover or the failure is up. Never once the game
 * plays: a tap of Esc is the game's (pause menus, mouse lock), and holding it opens the game's menu.
 */
export const escapeLeaves = (viewer: ViewerShown | null): boolean =>
  viewer !== null && viewer.phase !== PlayViewerPhase.Playing;

/** How a header button wears a note in place of its label: confirming (a check), at work, or just saying it. */
export const NoteLook = { Done: "done", Busy: "busy", Said: "said" } as const;
export type NoteLook = (typeof NoteLook)[keyof typeof NoteLook];

/** Which button each note is about, and how that button wears it. */
const NOTE_PLACE = {
  [PlayNote.Copied]: { control: PlayControl.Share, look: NoteLook.Done },
  [PlayNote.InviteCopied]: { control: PlayControl.Invite, look: NoteLook.Done },
  [PlayNote.SignIn]: { control: PlayControl.Like, look: NoteLook.Said },
  [PlayNote.LikeFailed]: { control: PlayControl.Like, look: NoteLook.Said },
  [PlayNote.Remixing]: { control: PlayControl.Remix, look: NoteLook.Busy },
  [PlayNote.RemixFailed]: { control: PlayControl.Remix, look: NoteLook.Said },
} as const satisfies Record<PlayNote, { control: PlayControl; look: NoteLook }>;

/** The note `control`'s button says now in place of its label, if the header's note is about it. */
export function noteOn(bar: PlayBarState | undefined, control: PlayControl): { note: PlayNote; look: NoteLook } | null {
  const note = bar?.note;
  if (!note || NOTE_PLACE[note].control !== control) return null;
  return { note, look: NOTE_PLACE[note].look };
}

/** Whether the header just went from not liked to liked: the player's own like, worth a burst. */
export const justLiked = (before: PlayBarState | undefined, after: PlayBarState | undefined): boolean =>
  before?.liked === false && after?.liked === true;
