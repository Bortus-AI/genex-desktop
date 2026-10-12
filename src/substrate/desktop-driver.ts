/**
 * What the studio needs from a desktop driver: the plug between the desktop target
 * (`main/core/desktop-target.ts`) and whatever moves the real pointer — cua-driver on this Mac
 * (`cua-driver-client.ts`), or the computer server inside a VM. Coordinates are the driver's own
 * screen space (points on macOS); the target scales the model's screenshot pixels to it.
 *
 * Electron-free; tests satisfy it with a plain object.
 */

/** An app on the desktop, as the driver names it. */
export interface DesktopApp {
  name: string;
  /** The app's bundle identifier (macOS), when the driver knows it. */
  bundleId: string | null;
  pid: number | null;
}

/** What has the keyboard: the app in front, and whether the focused field is a secure (password) one. */
export interface DesktopFocus {
  app: DesktopApp | null;
  secure: boolean;
}

/** A picture of the whole screen, and the screen's size in the driver's coordinate space. */
export interface DesktopShot {
  image: Buffer;
  mime: "image/png" | "image/jpeg";
  /** The picture's own pixels. */
  width: number;
  height: number;
  /** The screen in the driver's coordinates (points), which pointer actions use. */
  screen: { width: number; height: number };
}

/** A mouse button the driver presses. */
export type DesktopButton = "left" | "right" | "middle";

/** Keys as the driver spells them: `cmd`, `shift`, `return`, `a`. */
export type DesktopKeys = string[];

/** The driver: one connection, held for a session and closed when it ends. */
export interface DesktopDriver {
  screenshot(): Promise<DesktopShot>;
  focus(): Promise<DesktopFocus>;
  /** The app under a screen point, so a click is checked against the app it lands in. */
  appAt?(x: number, y: number): Promise<DesktopApp | null>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, options: { button: DesktopButton; count: number; modifiers: DesktopKeys }): Promise<void>;
  mouse(x: number, y: number, options: { button: DesktopButton; down: boolean }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, button: DesktopButton): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  /** A key or chord pressed and let go: `["cmd", "s"]`. */
  press(keys: DesktopKeys): Promise<void>;
  /** Keys held down or let go, where the driver can (a game on the desktop that reads held keys). */
  keys?(keys: DesktopKeys, down: boolean): Promise<void>;
  /** The accessibility tree of the app in front, as the driver reports it. */
  accessibility(): Promise<unknown>;
  close(): Promise<void>;
}
