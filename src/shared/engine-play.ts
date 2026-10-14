/**
 * Playing a game inside its engine's editor (`TargetRuntime.Editor`): the harness tools an engine
 * plugin (capability `game-engine`) provides so the studio's `computer` tool can play its games the
 * way it plays a web game — a picture of what the player sees, keys held on the game's own clock,
 * and the game's state the studio checks goals against. The tools are the plugin's, by these names
 * after `<plugin>__`; the studio's target (`main/core/editor-play-target.ts`) stays engine-agnostic.
 * Unreal's are in `plugins/unreal/computer-play.ts` (Play In Editor, through the Genex editor helper).
 *
 * Every tool is a harness step (`audience: "harness"`) that needs the plugin's editor lock for its
 * call: the person first, any other caller in turn.
 */

/** The play tools, by their names after `<plugin>__`. Wire values: never rename. */
export const EnginePlayTool = {
  /** Start play (or join the play already running): answers the view's size. */
  Open: "play-open",
  /** Hold keys together for a time on the game's own clock, then let go: answers once that time has passed. */
  Input: "play-input",
  /** A picture of what the player sees: answers a PNG. */
  Shot: "play-shot",
  /** The game's state: the player and the game's own numbers, as the engine plugin reads them. */
  State: "play-state",
  /** Stand the play still (`paused: true`) or let it run: the studio holds a judge's game still between moves. */
  Pause: "play-pause",
  /** Let go of every key and end the play the session started. */
  Close: "play-close",
} as const;
export type EnginePlayTool = (typeof EnginePlayTool)[keyof typeof EnginePlayTool];

/** Every play tool an engine plugin must provide for its games to be played through `computer`. */
export const ENGINE_PLAY_TOOLS: readonly EnginePlayTool[] = Object.values(EnginePlayTool);

/** The view every play shot is taken at, unless the engine says otherwise. */
export const ENGINE_PLAY_VIEW = { width: 1280, height: 720 } as const;

/** The longest one `play-input` holds keys, in game seconds. */
export const MAX_PLAY_INPUT_SECONDS = 10;

/** What `play-open` answers: the view's size, and whether the play was already running. */
export interface EnginePlayOpened {
  width: number;
  height: number;
  joined: boolean;
}

/** The mouse buttons, as `play-input` names them among its keys (web key codes have none). Wire values: never rename. */
export const MouseButtonCode = { Left: "MouseLeft", Right: "MouseRight", Middle: "MouseMiddle" } as const;
export type MouseButtonCode = (typeof MouseButtonCode)[keyof typeof MouseButtonCode];

/** One frame of the player's mouse: motion in pixels (down the screen is +dy) and wheel notches (up is +). */
export interface EnginePlayMouse {
  dx?: number;
  dy?: number;
  wheel?: number;
}

/**
 * What `play-input` is asked: keys as web key codes (`KeyboardEvent.code`: `KeyW`, `Space`,
 * `ArrowUp`, `ShiftLeft`, `Digit1`) or mouse buttons ({@link MouseButtonCode}) joined by commas,
 * held together, after one frame of the mouse when it moves; the engine plugin names them in its
 * engine. Plugin tool parameters are scalars, so the keys are one string; none is a wait.
 */
export interface EnginePlayInputArgs extends EnginePlayMouse {
  keys: string;
  seconds: number;
}

/** The keys a `play-input` names, in order: `"KeyW,ShiftLeft"` is `["KeyW", "ShiftLeft"]`. */
export function playInputKeys(keys: unknown): string[] {
  return typeof keys === "string"
    ? keys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
}

/** A `play-input`'s arguments for keys held together for `seconds`, after one frame of `mouse` when it moves. */
export function playInputArgs(
  keys: readonly string[],
  seconds: number,
  mouse: EnginePlayMouse = {},
): EnginePlayInputArgs {
  return { keys: keys.join(","), seconds, ...mouse };
}

/** What `play-input` answers: the keys the engine took, and the game seconds that passed. */
export interface EnginePlayInputAnswer {
  held: string[];
  gameSeconds: number | null;
}

/** What `play-shot` answers: the picture as base64 PNG, at the view's size. */
export interface EnginePlayShot {
  png: string;
  width: number;
  height: number;
}

/** Why a play tool did not do what it was asked, as a code: the words the model reads are the target's. */
export const EnginePlayRefusal = {
  /** The editor is not open or does not answer. */
  NoEditor: "no-editor",
  /** The engine's own queue is playing a build now; try again when it has finished. */
  Busy: "busy",
  /** No play is running (it ended, or the person stopped it). */
  NotPlaying: "not-playing",
  /** A key the engine has no name for. */
  UnknownKey: "unknown-key",
} as const;
export type EnginePlayRefusal = (typeof EnginePlayRefusal)[keyof typeof EnginePlayRefusal];

/** A play tool's refusal, as every play tool answers one. */
export interface EnginePlayRefused {
  refused: EnginePlayRefusal;
  message: string;
}

/** Whether a play tool's answer is a refusal. */
export function isEnginePlayRefused(answer: unknown): answer is EnginePlayRefused {
  if (typeof answer !== "object" || answer === null) return false;
  return (
    "refused" in answer &&
    typeof answer.refused === "string" &&
    "message" in answer &&
    typeof answer.message === "string"
  );
}
