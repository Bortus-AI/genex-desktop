/**
 * The `desktop` tool: the same computer vocabulary and the same session referee as a game's
 * `computer` (`computer-session.ts`), on the person's desktop or a VM. It is offered to the
 * sessions the person is answering, on every engine — Claude Code, Codex, OpenCode, the local
 * sessions and the harness's own loop all receive it as one more live tool.
 *
 * Nothing moves before the person says so: the first call asks whether the agent may see the
 * screen and use the computer this session, and each app it then reaches is asked for once
 * (`desktop-target.ts`). A no is the answer the model reads, never a failure. The driver starts
 * on the first call and stops with the session.
 */
import type { ScreenAct } from "../../shared/agent-screen.ts";
import { ScreenRole } from "../../shared/agent-screen.ts";
import { ComputerPacing, type ComputerTraceSummary } from "../../shared/computer-target.ts";
import { errorMessage } from "../../shared/errors.ts";
import { DESKTOP_TOOL_NAME, computerToolDefinition } from "../../substrate/computer-tool.ts";
import type { DesktopApp, DesktopDriver, DesktopShot } from "../../substrate/desktop-driver.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import { computerSession, type TargetSource } from "./computer-session.ts";
import { type DesktopTarget, desktopTarget } from "./desktop-target.ts";

/** The most moves one desktop session makes unless the grant says otherwise. */
const DESKTOP_MAX_ACTIONS = 200;

/** What the person is asked, in the consent card. */
export const DesktopQuestion = {
  /** May the agent see the screen and use the computer this session? */
  Session: "session",
  /** May the agent use this app? */
  App: "app",
} as const;
export type DesktopQuestion = (typeof DesktopQuestion)[keyof typeof DesktopQuestion];

/** What the model reads when the desktop cannot be used. */
const MESSAGE = {
  declined: "the person did not allow computer control this session — ask them in words what to do instead",
  noDriver: (why: string) => `computer control is not available: ${why}`,
} as const;

/** What a desktop session is built from. */
export interface DesktopToolsDeps {
  /** Start the driver: cua-driver on this Mac, or the computer server inside a VM. Throws when it cannot. */
  connect: () => Promise<DesktopDriver>;
  /** Ask the person, in the chat, and wait for their answer. */
  ask: (question: DesktopQuestion, app?: DesktopApp) => Promise<boolean>;
  /** Whether an app is the studio itself, which no agent ever drives. */
  ownApp: (app: DesktopApp) => boolean;
  /** The folder the session's frames and trace go into. */
  frameDir: string;
  /** Show a frame on the agent's screen. */
  frame?: (target: DesktopTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  downscale?: (
    shot: DesktopShot,
  ) => Promise<{ image: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number }>;
  /** A VM's desktop rather than this Mac's: its apps are all the VM's, so the session's yes covers them. */
  vm?: boolean;
  maxActions?: number;
}

/** The desktop tool for one session, and how to stop it. */
export interface DesktopTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: NonNullable<DelegateRequest["onLiveTool"]>;
  trace: () => ComputerTraceSummary;
  /** Stop the driver; later calls start nothing until asked again. */
  release: () => Promise<void>;
}

/** The apps the person allowed this session, asked for once each. */
function appAllowance(deps: DesktopToolsDeps) {
  const allowed = new Set<string>();
  const declined = new Set<string>();
  return async (app: DesktopApp): Promise<boolean> => {
    if (deps.vm) return true;
    const key = app.bundleId ?? app.name;
    if (allowed.has(key)) return true;
    if (declined.has(key)) return false;
    const yes = await deps.ask(DesktopQuestion.App, app);
    (yes ? allowed : declined).add(key);
    return yes;
  };
}

/** The desktop as the session's target source: asked for, then connected, on the first call. */
function desktopSource(deps: DesktopToolsDeps): TargetSource<DesktopTarget> & { release(): Promise<void> } {
  let driver: DesktopDriver | null = null;
  let target: DesktopTarget | null = null;
  let refusedSession = false;
  const allowApp = appAllowance(deps);
  const unusable = (problem: string) => ({
    target: desktopTarget({ driver: deadDriver(problem), allowApp: async () => false }),
    problem,
    note: null,
    fresh: true,
  });
  return {
    caps: desktopTarget({ driver: deadDriver(""), allowApp: async () => false, vm: deps.vm === true }).caps,
    load: async () => {
      if (target) return { target, problem: null, note: null, fresh: false };
      if (refusedSession) return unusable(MESSAGE.declined);
      if (!(await deps.ask(DesktopQuestion.Session))) {
        refusedSession = true;
        return unusable(MESSAGE.declined);
      }
      const connected = await deps.connect().catch((error: unknown) => errorMessage(error));
      if (typeof connected === "string") return unusable(MESSAGE.noDriver(connected));
      driver = connected;
      target = desktopTarget({
        driver,
        allowApp,
        ownApp: deps.ownApp,
        vm: deps.vm === true,
        ...(deps.downscale ? { downscale: deps.downscale } : {}),
      });
      return { target, problem: null, note: null, fresh: true };
    },
    frame: (shown, jpeg, caption, act) => deps.frame?.(shown, jpeg, caption, act) ?? Promise.resolve(),
    release: async () => {
      const open = driver;
      driver = null;
      target = null;
      await open?.close().catch(() => {});
    },
  };
}

/** A driver that refuses everything: what a target without a connection holds. */
function deadDriver(why: string): DesktopDriver {
  const refuse = () => Promise.reject(new Error(why || "not connected"));
  return {
    screenshot: refuse,
    focus: refuse,
    move: refuse,
    click: refuse,
    mouse: refuse,
    drag: refuse,
    scroll: refuse,
    type: refuse,
    press: refuse,
    accessibility: refuse,
    close: async () => {},
  };
}

/** The `desktop` tool over one session on the desktop (or a VM). */
export function desktopTools(deps: DesktopToolsDeps): DesktopTools {
  const source = desktopSource(deps);
  const session = computerSession(source, deps.vm ? "vm" : "desktop", {
    pacing: ComputerPacing.Running,
    frameDir: deps.frameDir,
    observeByDefault: true,
    maxActions: deps.maxActions ?? DESKTOP_MAX_ACTIONS,
    toolName: DESKTOP_TOOL_NAME,
  });
  const tool = computerToolDefinition({
    name: DESKTOP_TOOL_NAME,
    role: ScreenRole.Operator,
    capabilities: source.caps,
    observeByDefault: true,
  });
  return {
    liveTools: [tool],
    onLiveTool: (name, args) => session.run(name, args),
    trace: () => session.trace(),
    release: () => source.release(),
  };
}
