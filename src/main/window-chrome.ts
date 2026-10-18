/**
 * The studio window's title bar by platform. macOS keeps `hiddenInset`: the traffic lights sit in
 * the app's own header, which leaves them room (`theme.css`, `[data-platform="darwin"]`), centred
 * on the same line as the sidebar toggle and the header's title. Windows
 * and Linux have no such controls in a frameless window, so they get `titleBarOverlay`: the
 * system's minimise, maximise and close drawn over the top-right corner, as tall as the headers,
 * in the theme's colours (the renderer repaints them through `studio:window.controls`). On Windows
 * their box is see-through, as the space around macOS's lights is: Home's background runs under them.
 */
import type { WindowControlColors } from "../shared/studio-api.ts";
import { StudioPlatform } from "../shared/boot.ts";

/** The app's header height in px (`h-12`); the overlay controls match it. */
export const TITLEBAR_HEIGHT = 48;

/** macOS's traffic-light circles, in points. */
const TRAFFIC_LIGHT_SIZE = 14;
/**
 * Where the lights sit: AppKit's inset from the left edge, and down so their centre is the
 * headers' middle rather than AppKit's 18pt.
 */
const TRAFFIC_LIGHTS = { x: 12, y: (TITLEBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2 } as const;

/** The dark fallback theme's canvas and ink (`theme.css` `:root`), until the renderer sends its own. */
const FALLBACK_COLORS: WindowControlColors = { color: "#0e0d0f", symbolColor: "#dee0e2" };

/** The overlay's options: its fill, its symbols' colour and its height. */
export type TitleBarOverlay = WindowControlColors & { height: number };

/** What the window's options say about its title bar. */
export type WindowChrome =
  | { titleBarStyle: "hiddenInset"; trafficLightPosition: { x: number; y: number } }
  | { titleBarStyle: "hidden"; titleBarOverlay: TitleBarOverlay };

/**
 * `#rrggbb` at zero alpha. Windows then paints only the symbols and their hover, and reads the
 * hover's dark or light tint from this hue, so it stays the theme's.
 */
function seeThrough(hex: string): string {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${red}, ${green}, ${blue}, 0)`;
}

/** The overlay on `platform` in the theme's `colors`: see-through on Windows, filled on Linux. */
export function titleBarOverlay(platform: string, colors: WindowControlColors): TitleBarOverlay {
  const color = platform === StudioPlatform.Windows ? seeThrough(colors.color) : colors.color;
  return { color, symbolColor: colors.symbolColor, height: TITLEBAR_HEIGHT };
}

/** The title-bar options for a window on `platform`. */
export function windowChrome(platform: string, colors: WindowControlColors = FALLBACK_COLORS): WindowChrome {
  if (platform === StudioPlatform.Mac)
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { ...TRAFFIC_LIGHTS } };
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(platform, colors) };
}
