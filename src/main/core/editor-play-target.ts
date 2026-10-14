/**
 * A game played in its engine's editor (`TargetRuntime.Editor`): the `computer` tool's target over
 * the game's engine plugin's play tools (`shared/engine-play.ts`) — Unreal's Play In Editor first
 * (`plugins/unreal/computer-play.ts`). The target stays engine-agnostic: keys go out as web key
 * codes and the plugin names them in its engine; a picture is what the player sees; state is the
 * player as the plugin reads it, which the session checks goals against.
 *
 * Every play tool takes the plugin's editor lock for its call (the person first, another caller in
 * turn), and opening is refused while the engine's own queue plays a build. The lock is not held
 * between calls: the agent's own editor calls in the same turn go on as they would. The session's
 * release ends the play it started.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  ENGINE_PLAY_VIEW,
  EnginePlayTool,
  isEnginePlayRefused,
  MAX_PLAY_INPUT_SECONDS,
  playInputArgs,
} from "../../shared/engine-play.ts";
import { EDITOR_CAPABILITIES, InputRoute, type TargetCapabilities } from "../../shared/computer-target.ts";
import { errorMessage } from "../../shared/errors.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { ScreenAct } from "../../shared/agent-screen.ts";
import type { ComputerTarget, TargetLoad, TargetShot } from "../../substrate/computer-target.ts";
import { normalizeKey, parseCombo, type PreviewInputAction } from "../../substrate/preview-input.ts";
import type { TargetSource } from "./computer-session.ts";

/** How long a key pressed once is held, in game seconds: a tap. */
const TAP_SECONDS = 0.1;

/** Calls one of the game's engine plugin's play tools, under the session's hold on the editor. */
export type EnginePlayCall = (tool: EnginePlayTool, args: Record<string, unknown>) => Promise<unknown>;

const MESSAGE = {
  noAnswer: (tool: string) => `the engine's ${tool} answered nothing usable`,
  unreachable: "The game's editor could not be reached.",
} as const;

/** A play tool's answer, or the refusal's words as an error. */
async function answered(call: EnginePlayCall, tool: EnginePlayTool, args: Record<string, unknown> = {}) {
  const answer = await call(tool, args);
  if (isEnginePlayRefused(answer)) throw new Error(answer.message);
  return answer;
}

/** A field of a play tool's answer, when the answer is an object that has it. */
function field(answer: unknown, name: string): unknown {
  if (typeof answer !== "object" || answer === null || !Object.hasOwn(answer, name)) return undefined;
  const value: unknown = Reflect.get(answer, name);
  return value;
}

/** A size field of `play-open`'s answer, or the default view's. */
function sizeOf(answer: unknown, name: "width" | "height"): number {
  const value = field(answer, name);
  return typeof value === "number" && value > 0 ? value : ENGINE_PLAY_VIEW[name];
}

/** The web key codes of one combo (`shift+w`): its modifiers, then its key. */
function comboCodes(combo: string): string[] {
  const { modifiers, key } = parseCombo(combo);
  return [...modifiers.map((k) => k.code), ...(key ? [key.code] : [])];
}

/** The keys that type one character: Shift with an upper-case letter. */
function charCodes(char: string): string[] {
  const key = normalizeKey(char);
  if (!key) return [];
  return /[A-Z]/.test(char) ? ["ShiftLeft", key.code] : [key.code];
}

/** The holds one input action is carried out as, each keys and game seconds; null when the editor has no way to do it. */
function holdsOf(action: PreviewInputAction): Array<{ keys: string[]; seconds: number }> | null {
  switch (action.type) {
    case "tap":
      return [{ keys: action.keys, seconds: action.stepMs ? action.stepMs / SECOND_MS : TAP_SECONDS }];
    case "press": {
      const keys = comboCodes(action.combo);
      return Array.from({ length: Math.max(1, action.repeat ?? 1) }, () => ({ keys, seconds: TAP_SECONDS }));
    }
    case "hold": {
      // A long hold goes out in turns of the longest one call holds.
      let left = (action.ms ?? TAP_SECONDS * SECOND_MS) / SECOND_MS;
      const turns: Array<{ keys: string[]; seconds: number }> = [];
      while (left > 0) {
        turns.push({ keys: action.keys, seconds: Math.min(left, MAX_PLAY_INPUT_SECONDS) });
        left -= MAX_PLAY_INPUT_SECONDS;
      }
      return turns;
    }
    case "type":
      return [...action.text].map((char) => ({ keys: charCodes(char), seconds: TAP_SECONDS }));
    case "wait":
      return [{ keys: [], seconds: action.ms / SECOND_MS }];
    default:
      return null;
  }
}

/** The target over a play that is open: its view, its keys, its picture and its state. */
export interface EditorPlayTarget extends ComputerTarget {
  readonly caps: TargetCapabilities;
}

function editorPlayTarget(call: EnginePlayCall, view: { width: number; height: number }): EditorPlayTarget {
  return {
    caps: EDITOR_CAPABILITIES,
    viewSize: () => view,
    pointer: () => null,
    screenshot: async (): Promise<TargetShot> => {
      const png = field(await answered(call, EnginePlayTool.Shot), "png");
      if (typeof png !== "string") throw new Error(MESSAGE.noAnswer(EnginePlayTool.Shot));
      return { jpeg: Buffer.from(png, "base64"), mime: StillMimeType.Png, stats: null, surface: null };
    },
    input: async (actions) => {
      let applied = 0;
      for (const action of actions) {
        const holds = holdsOf(action);
        if (!holds) break;
        for (const hold of holds)
          await answered(call, EnginePlayTool.Input, { ...playInputArgs(hold.keys, hold.seconds) });
        applied += 1;
      }
      return { applied, route: InputRoute.Editor };
    },
    state: () => answered(call, EnginePlayTool.State),
  };
}

/** A target that answers nothing: what the session holds when the editor could not be reached. */
function unreachableTarget(): EditorPlayTarget {
  const refuse = async (): Promise<never> => {
    throw new Error(MESSAGE.unreachable);
  };
  return {
    caps: EDITOR_CAPABILITIES,
    viewSize: () => ENGINE_PLAY_VIEW,
    pointer: () => null,
    screenshot: refuse,
    input: refuse,
    state: refuse,
  };
}

/** A source of the editor target: its capabilities, its loads, and its release. */
export interface EditorPlaySource extends TargetSource<EditorPlayTarget> {
  release(): Promise<void>;
}

/**
 * The editor target's source. `call` reaches the plugin's play tools (each under the editor lock);
 * `frame` puts a picture on the agent's screen.
 */
export function editorPlaySource(options: {
  call: EnginePlayCall;
  frame?: (target: EditorPlayTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
}): EditorPlaySource {
  let open: EditorPlayTarget | null = null;
  const load = async (_root: string, force: boolean): Promise<TargetLoad<EditorPlayTarget> & { fresh: boolean }> => {
    if (open && !force) return { target: open, problem: null, note: null, fresh: false };
    try {
      const opened = await answered(options.call, EnginePlayTool.Open);
      const view = { width: sizeOf(opened, "width"), height: sizeOf(opened, "height") };
      open = editorPlayTarget(options.call, view);
      return { target: open, problem: null, note: null, fresh: true };
    } catch (error) {
      return { target: unreachableTarget(), problem: errorMessage(error), note: null, fresh: true };
    }
  };
  return {
    caps: EDITOR_CAPABILITIES,
    load,
    frame: (target, jpeg, caption, act) => options.frame?.(target, jpeg, caption, act) ?? Promise.resolve(),
    release: async () => {
      if (!open) return;
      open = null;
      await options.call(EnginePlayTool.Close, {}).catch(() => undefined);
    },
  };
}
