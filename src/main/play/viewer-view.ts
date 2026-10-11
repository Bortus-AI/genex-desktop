/**
 * The Play viewer's game view in the studio window (`viewer.ts` decides what it does): a fresh
 * sandboxed view per game in Play's own session, under the app's own header (drawn by the renderer
 * above it). The game's page may move between Genex games' addresses and Genex's sign-in hop; any
 * other link opens in the browser. Play's session grants only mouse lock, full screen and clipboard
 * writes.
 */
import { type BrowserWindow, clipboard, type Session, session, type WebContents, WebContentsView } from "electron";
import { PLAY_BAR_HEIGHT, type PlayViewerEvent } from "../../shared/play.ts";
import type { FullScreenKey, Rect } from "../game-full-screen.ts";
import { GAME_DISABLED_BLINK_FEATURES } from "../game-view.ts";
import { linkGate, playAddress, playNavigationAllowed } from "./game-address.ts";
import type { PlayGallery, PlayWorld } from "./gallery.ts";
import { playViewer, type PlayViewer } from "./viewer.ts";

/** Sessions already given Play's rules: a window made again shares the session and its handlers. */
const prepared = new WeakSet<Session>();
/** Play's own storage: games keep their saves across launches, apart from the studio's. */
export const PLAY_PARTITION = "persist:genex-play";
/** The permissions a game in Play may have; everything else (camera, microphone, location…) is refused. */
const GRANTED = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);
/** What a game's page shows before it paints. */
const GAME_BACKGROUND = "#000000";
/** A navigation the browser itself aborted (a new one replaced it): not a failure. */
const ERR_ABORTED = -3;
/** HTTP answers that mean the game is not there to play. */
const GONE_STATUS = 404;
const SERVER_ERROR = 500;
/**
 * The Genex embed SDK's own guest popover on a game's page ("Playing as Guest … Sign in"). Its Sign in
 * goes to the website, which cannot sign the app in; the viewer's own guest card offers the Genex
 * plugin instead. A user-origin rule, so not even the popover's inline `!important` styles win.
 */
const HIDE_GUEST_POPOVER = "[data-genex-guest-popover]{display:none !important}";

/** The studio window and what the viewer reaches through it. */
export interface PlayViewDeps {
  win: BrowserWindow;
  gallery: PlayGallery;
  remix(world: PlayWorld): Promise<string>;
  emit(event: PlayViewerEvent): void;
  /** A link the game asked for that is not its own: to the browser. */
  openExternal(url: string): void;
  /** Fixture launches: a local stand-in page instead of the network. */
  offline: { gamePage(slug: string): string } | null;
}

/**
 * Play's session, granting only what Play allows and only to a game's own page (never to a frame
 * inside it), and refusing every download.
 */
function playSession(): Session {
  const play = session.fromPartition(PLAY_PARTITION);
  if (prepared.has(play)) return play;
  prepared.add(play);
  play.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(GRANTED.has(permission) && details.isMainFrame),
  );
  play.setPermissionCheckHandler(
    (_contents, permission, _origin, details) => GRANTED.has(permission) && details.isMainFrame,
  );
  play.on("will-download", (event) => event.preventDefault());
  return play;
}

/** What the game's view reports to the viewer: its keys, and how its page loads. */
interface ViewerEvents {
  key(input: FullScreenKey): void;
  loaded(): void;
  failed(): void;
}

/**
 * Keep a game's page on its own addresses. A link it follows or opens elsewhere goes to the browser
 * (without its fragment, at most one every few seconds); a server redirect elsewhere goes nowhere,
 * since it may carry the sign-in ticket. The game's own frames may go where they like.
 */
function guardNavigation(contents: WebContents, offline: boolean, openExternal: (url: string) => void): void {
  const sendOut = linkGate(openExternal);
  contents.on("will-navigate", (event, target) => {
    if (playNavigationAllowed(target, offline)) return;
    event.preventDefault();
    sendOut(target);
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || playNavigationAllowed(event.url, offline)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    sendOut(url);
    return { action: "deny" };
  });
}

/**
 * The game's view: a fresh one per game in Play's session, under the app's header, reporting how its
 * page loads, with the embed SDK's guest popover hidden on every page it shows.
 */
function gameView(win: BrowserWindow, deps: PlayViewDeps, events: ViewerEvents) {
  const play = playSession();
  let current: WebContentsView | null = null;
  const close = (): void => {
    const view = current;
    current = null;
    if (!view) return;
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (win.isDestroyed()) return;
    win.contentView.removeChildView(view);
    // The keyboard comes back to the app the game took it from.
    win.webContents.focus();
  };
  const open = (url: string): void => {
    close();
    const view = new WebContentsView({
      webPreferences: {
        session: play,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        autoplayPolicy: "no-user-gesture-required",
        disableBlinkFeatures: GAME_DISABLED_BLINK_FEATURES.join(","),
      },
    });
    view.setBackgroundColor(GAME_BACKGROUND);
    view.setVisible(false);
    // The page boots at the size it plays at, under the header, so a game that sizes its canvas once starts right.
    const [width = 0, height = 0] = win.getContentSize();
    view.setBounds({ x: 0, y: PLAY_BAR_HEIGHT, width, height: Math.max(0, height - PLAY_BAR_HEIGHT) });
    win.contentView.addChildView(view);
    current = view;
    const contents = view.webContents;
    const mine = () => current === view;
    guardNavigation(contents, deps.offline !== null, deps.openExternal);
    contents.on("did-finish-load", () => mine() && events.loaded());
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (mine() && isMainFrame && code !== ERR_ABORTED) events.failed();
    });
    contents.on("did-navigate", (_event, _url, status) => {
      if (mine() && (status === GONE_STATUS || status >= SERVER_ERROR)) events.failed();
    });
    contents.on("render-process-gone", () => mine() && events.failed());
    contents.on("dom-ready", () => {
      if (!contents.isDestroyed()) void contents.insertCSS(HIDE_GUEST_POPOVER, { cssOrigin: "user" }).catch(() => {});
    });
    contents.on("before-input-event", (_event, input) => events.key(input));
    void contents.loadURL(url).catch(() => {});
  };
  return {
    open,
    show: (bounds: Rect): void => {
      current?.setBounds(bounds);
      current?.setVisible(true);
    },
    hide: (): void => current?.setVisible(false),
    focus: (): void => current?.webContents.focus(),
    close,
  };
}

/** Wire the viewer into `win`. */
export function wirePlayViewer(deps: PlayViewDeps): PlayViewer {
  const { win, offline } = deps;
  // The views are made before the viewer that answers them: their events reach it once it exists.
  let viewer: PlayViewer | null = null;
  const events: ViewerEvents = {
    key: (input) => viewer?.key(input),
    loaded: () => viewer?.loaded(),
    failed: () => viewer?.failed(),
  };
  const game = gameView(win, deps, events);
  const made = playViewer({
    gallery: deps.gallery,
    gameUrl: (slug, ticket) => (offline ? offline.gamePage(slug) : playAddress(slug, ticket)),
    window: {
      contentSize: () => {
        if (win.isDestroyed()) return { width: 0, height: 0 };
        const [width = 0, height = 0] = win.getContentSize();
        return { width, height };
      },
    },
    game,
    // The game's view loses the keyboard, and with it any mouse lock it held.
    focusApp: () => {
      if (!win.isDestroyed()) win.webContents.focus();
    },
    clipboard: (text) => clipboard.writeText(text),
    remix: deps.remix,
    emit: deps.emit,
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  viewer = made;
  win.on("resize", () => made.resized());
  // A hidden or closed window takes its game with it: no sound, no timers on a window that is gone.
  win.on("hide", () => made.close());
  win.on("closed", () => made.close());
  return made;
}
