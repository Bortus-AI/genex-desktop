import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Activate,
  PluginActivation,
  PluginContext,
  PluginEngineAssistRefusal,
  PluginReview,
  PluginToolbarStatus,
} from "../../plugin-sdk/index.d.ts";
import { readSwitches } from "./mcp-switch.ts";
import {
  HELPER_FILE,
  HelperChange,
  planSetup,
  type SetupDone,
  type SetupOptions,
  setUp,
  setupPaths,
  undoSetup,
} from "./setup.ts";
import { RobloxSetupError, SetupRefusal } from "./setup-refusal.ts";
import { createStudioClient, studioAnswers, systemStudioClientDeps } from "./studio-client.ts";
import { type LaunchDeps, openLaunch, quitStudio, systemOpener } from "./studio-launch.ts";
import {
  type LocateDeps,
  locateStudio,
  type StudioInstall,
  studioRunning,
  systemLocateFs,
  systemRun,
} from "./studio-locate.ts";
import { MCP_SWITCH_CLICK_PATH, MESSAGE } from "./words.ts";

/**
 * The Roblox Studio plugin's backend: the "Roblox Studio" toolbar button's word
 * (`toolbar-status`), the panel's status (`status`), and the Studio lock's probe
 * (`studio-activity`). It reads where Studio is, whether Genex set it up (a record in the plugin's
 * own storage) and whether it runs; never the person's Documents folder, which macOS guards with
 * a prompt that only the person's own press may raise.
 */

/** The host services this backend calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  EngineAssist: "game.engine.assist",
} as const;

/** The actions plugin.json declares. Wire values: never rename. */
export const RobloxAction = {
  Status: "status",
  ToolbarStatus: "toolbar-status",
  Setup: "setup",
  UndoSetup: "undo-setup",
  RestartStudio: "restart-studio",
  DoItForMe: "do-it-for-me",
} as const;
export type RobloxAction = (typeof RobloxAction)[keyof typeof RobloxAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(RobloxAction));
const isRobloxAction = (name: string): name is RobloxAction => ACTION_NAMES.has(name);

/** The tools plugin.json declares. Wire values: never rename. */
export const RobloxTool = {
  StudioActivity: "studio-activity",
} as const;
export type RobloxTool = (typeof RobloxTool)[keyof typeof RobloxTool];
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(RobloxTool));
const isRobloxTool = (name: string): name is RobloxTool => TOOL_NAMES.has(name);

/** Where Studio stands for Genex, as the toolbar button and the panel name it. Wire values: never rename. */
export const StudioStatus = {
  /** Studio isn't on this computer. */
  Get: "get",
  /** Studio is here, but Genex hasn't added its helper or turned on Studio's MCP server. */
  SetUp: "set-up",
  NotOpen: "not-open",
  /** Studio runs but doesn't answer Genex yet. */
  Starting: "starting",
  Ready: "ready",
} as const;
export type StudioStatus = (typeof StudioStatus)[keyof typeof StudioStatus];

/** The Set up panel's steps, each its own block. Wire values: never rename. */
export const PanelStep = {
  Studio: "studio",
  Helper: "helper",
  Mcp: "mcp",
  Place: "place",
} as const;
export type PanelStep = (typeof PanelStep)[keyof typeof PanelStep];

/** Genex's record of what its setup wrote, in the plugin's own storage: its presence means set up. */
const SETUP_RECORD = path.join("setup", "record.json");

/** Why Set up didn't go on, beyond setup's own refusals. Wire values: never rename. */
export const SetupMiss = {
  NotInstalled: "not-installed",
  /** Restart Studio asked Studio to quit, and it was still open at the end of the wait. */
  StillOpen: "still-open",
} as const;
export type SetupMiss = (typeof SetupMiss)[keyof typeof SetupMiss];

/** What the panel can offer while Studio is open and its MCP switch still has to be turned on. */
const OPEN_STUDIO_CHOICES = [
  { action: RobloxAction.RestartStudio, label: MESSAGE.Choice.RestartStudio },
  { action: RobloxAction.DoItForMe, label: MESSAGE.Choice.DoItForMe },
] as const;

/** The panel's answer to Set up, Undo and Restart Studio: done, or why not and what to do instead. */
export interface SetupAnswer {
  done: boolean;
  message: string;
  reason?: SetupRefusal | SetupMiss;
  /** The actions the panel offers instead; with them, Studio's own click path. */
  choices?: ReadonlyArray<{ action: RobloxAction; label: string }>;
  clickPath?: string;
  setup?: SetupDone;
  removed?: string[];
  kept?: string[];
  /** Restart Studio opened Studio again. */
  reopened?: boolean;
}

/** The answer to Do it for me: whether the game's chat took the click, else why not and the click path. */
export interface AssistAnswer {
  started: boolean;
  message: string;
  reason?: PluginEngineAssistRefusal;
  clickPath?: string;
}

/** The computer the backend works on; tests hand in a fake one. */
export interface RobloxDeps extends LaunchDeps {
  /** Whether the open Studio answers Genex. */
  answers(): Promise<boolean>;
  /** The shipped Genex helper file. */
  helper: string;
}

/** What the status is made of. */
export interface StudioFacts {
  installed: boolean;
  setUp: boolean;
  running: boolean;
  answering: boolean;
}

/** The panel's answer to `status`. */
export interface RobloxStatus {
  studio: StudioStatus;
  version?: string;
  steps: Record<PanelStep, boolean>;
}

/**
 * Where Studio stands: missing first, then setup, then whether it runs, then whether it answers.
 * An answer counts only while Studio runs: without it, whatever answers is not this Studio.
 */
export function studioStatusOf(facts: StudioFacts): StudioStatus {
  if (!facts.installed) return StudioStatus.Get;
  if (!facts.setUp) return StudioStatus.SetUp;
  if (!facts.running) return StudioStatus.NotOpen;
  return facts.answering ? StudioStatus.Ready : StudioStatus.Starting;
}

/** Each status as the toolbar shows it: a dot in its tone, its word leading the tooltip. */
const BADGE = {
  [StudioStatus.Get]: { badge: MESSAGE.Badge.Get, tone: "info", dot: true },
  [StudioStatus.SetUp]: { badge: MESSAGE.Badge.SetUp, tone: "warn", dot: true },
  [StudioStatus.NotOpen]: { badge: MESSAGE.Badge.NotOpen, tone: "info", dot: true },
  [StudioStatus.Starting]: { badge: MESSAGE.Badge.Starting, tone: "warn", dot: true },
  [StudioStatus.Ready]: { badge: MESSAGE.Badge.Ready, tone: "ok", dot: true },
} as const satisfies Record<StudioStatus, PluginToolbarStatus>;

function titleOf(status: StudioStatus, install: StudioInstall | undefined): string {
  if (status === StudioStatus.Get) return MESSAGE.Title.Get;
  if (status === StudioStatus.SetUp) return MESSAGE.Title.SetUp;
  if (status === StudioStatus.NotOpen) return MESSAGE.Title.NotOpen(install?.version);
  return status === StudioStatus.Starting ? MESSAGE.Title.Starting : MESSAGE.Title.Ready;
}

/** The toolbar button's word, dot and title for a status. */
export function toolbarStatusOf(status: StudioStatus, install?: StudioInstall): PluginToolbarStatus {
  return { ...BADGE[status], title: titleOf(status, install) };
}

/** Whether Genex's setup record is a plain file in the plugin's storage. */
async function setUpIn(deps: RobloxDeps, storage: string): Promise<boolean> {
  const stat = await deps.fs.lstat(path.join(storage, SETUP_RECORD));
  return Boolean(stat?.file && !stat.link);
}

/** What is known of Studio now, asking each thing only when the one before it holds. */
async function readStudio(deps: RobloxDeps, context: PluginContext) {
  const location = await locateStudio(deps);
  const install = location.installed ? location.install : undefined;
  const facts: StudioFacts = { installed: location.installed, setUp: false, running: false, answering: false };
  if (!install) return { install, facts };
  facts.setUp = await setUpIn(deps, await context.host(HostService.StorageRoot));
  if (!facts.setUp) return { install, facts };
  facts.running = await studioRunning(deps);
  facts.answering = facts.running && (await deps.answers());
  return { install, facts };
}

async function status(deps: RobloxDeps, context: PluginContext): Promise<RobloxStatus> {
  const { install, facts } = await readStudio(deps, context);
  const steps = {
    [PanelStep.Studio]: facts.installed,
    [PanelStep.Helper]: facts.setUp,
    [PanelStep.Mcp]: facts.answering,
    [PanelStep.Place]: false,
  };
  const answer: RobloxStatus = { studio: studioStatusOf(facts), steps };
  if (install?.version) answer.version = install.version;
  return answer;
}

async function toolbarStatus(deps: RobloxDeps, context: PluginContext): Promise<PluginToolbarStatus> {
  const { install, facts } = await readStudio(deps, context);
  return toolbarStatusOf(studioStatusOf(facts), install);
}

async function setupOptions(deps: RobloxDeps, context: PluginContext): Promise<SetupOptions> {
  return {
    paths: setupPaths(deps.platform, deps.env, deps.home),
    helper: deps.helper,
    storage: await context.host(HostService.StorageRoot),
    running: () => studioRunning(deps),
    now: deps.now,
  };
}

/** A refusal as the panel shows it; Studio being open comes with what to do instead. */
function refusedAnswer(error: unknown): SetupAnswer {
  if (!(error instanceof RobloxSetupError)) throw error;
  const answer: SetupAnswer = { done: false, reason: error.code, message: error.message };
  if (error.code !== SetupRefusal.StudioRunning) return answer;
  return { ...answer, choices: OPEN_STUDIO_CHOICES, clickPath: MCP_SWITCH_CLICK_PATH };
}

function setupDoneAnswer(setup: SetupDone): SetupAnswer {
  if (setup.switches.files === 0)
    return {
      done: true,
      setup,
      message: MESSAGE.Setup.DoneNoSettings,
      choices: OPEN_STUDIO_CHOICES.filter((choice) => choice.action === RobloxAction.DoItForMe),
      clickPath: MCP_SWITCH_CLICK_PATH,
    };
  const newer = setup.helper === HelperChange.Kept && setup.switches.turnedOn === 0;
  return { done: true, setup, message: newer ? MESSAGE.Setup.NewerHelper : MESSAGE.Setup.Done };
}

/** Runs Set up, answering its refusals in plain words. Studio is checked first: nothing is read while it runs. */
async function runSetup(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  try {
    return setupDoneAnswer(await setUp(await setupOptions(deps, context)));
  } catch (error) {
    return refusedAnswer(error);
  }
}

async function setupAction(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { done: false, reason: SetupMiss.NotInstalled, message: MESSAGE.Setup.NotInstalled };
  return runSetup(deps, context);
}

async function undoAction(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  try {
    const { removed, kept } = await undoSetup(await setupOptions(deps, context));
    const message = kept.length > 0 ? MESSAGE.Setup.UndoneKept(kept.length) : MESSAGE.Setup.Undone;
    return { done: true, message, removed, kept };
  } catch (error) {
    return refusedAnswer(error);
  }
}

/**
 * Restart Studio: a normal quit (Studio asks the person to save, as it always does), Set up while
 * it is closed, then Studio opened again, whatever Set up answered: Genex closed it.
 */
async function restartStudio(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { done: false, reason: SetupMiss.NotInstalled, message: MESSAGE.Setup.NotInstalled };
  if (!(await quitStudio(deps))) return { done: false, reason: SetupMiss.StillOpen, message: MESSAGE.Setup.StillOpen };
  const answer = await runSetup(deps, context);
  await deps.open(openLaunch(deps.platform, location.install));
  return { ...answer, reopened: true, message: `${answer.message} ${MESSAGE.Setup.Reopened}` };
}

const ASSIST_WORDS: Partial<Record<PluginEngineAssistRefusal, string>> = {
  unavailable: MESSAGE.Assist.Unavailable,
  declined: MESSAGE.Assist.Declined,
  "no-chat": MESSAGE.Assist.NoChat,
};

/**
 * Do it for me: setup clicks only. Genex's own computer control, in this game's chat, clicks
 * Studio's MCP switch the person asked for; it never builds or play-tests. Where it can't (Windows,
 * no driver, no game open, the person said no), the answer carries Studio's own click path.
 */
async function doItForMe(context: PluginContext): Promise<AssistAnswer> {
  const answer = await context.host(HostService.EngineAssist, { task: MESSAGE.Assist.Task });
  if (answer.started) return { started: true, message: MESSAGE.Assist.Started };
  const message = (answer.reason && ASSIST_WORDS[answer.reason]) || MESSAGE.Assist.NotStarted;
  const refused: AssistAnswer = { started: false, message, clickPath: MCP_SWITCH_CLICK_PATH };
  if (answer.reason) refused.reason = answer.reason;
  return refused;
}

/**
 * Set up's confirmation: what it will do on this computer, read from Studio's settings folder only.
 * It never reads Documents: macOS would ask the person before they have confirmed.
 */
async function reviewSetup(deps: RobloxDeps): Promise<PluginReview> {
  try {
    const paths = setupPaths(deps.platform, deps.env, deps.home);
    const settings = (await readSwitches(paths.settings)).length;
    const detail = planSetup({ platform: deps.platform, paths, settings }).join("\n");
    return { message: MESSAGE.Setup.Confirm, detail };
  } catch {
    return {};
  }
}

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

/** The backend over the computer it is given; tests hand in fakes. */
export function createRobloxBackend(deps: RobloxDeps): PluginActivation {
  const actions: Record<RobloxAction, Handler> = {
    [RobloxAction.Status]: (_args, context) => status(deps, context),
    [RobloxAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
    [RobloxAction.Setup]: (_args, context) => setupAction(deps, context),
    [RobloxAction.UndoSetup]: (_args, context) => undoAction(deps, context),
    [RobloxAction.RestartStudio]: (_args, context) => restartStudio(deps, context),
    [RobloxAction.DoItForMe]: (_args, context) => doItForMe(context),
  };
  const tools: Record<RobloxTool, Handler> = {
    // Nothing here watches Studio's own edits yet, so the person is never seen using it.
    [RobloxTool.StudioActivity]: async () => ({ personActive: false }),
  };
  return {
    async action(name, args, context) {
      if (!isRobloxAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (!isRobloxTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      return tools[name](args, context);
    },
    async review(name) {
      return name === RobloxAction.Setup ? reviewSetup(deps) : {};
    },
  };
}

/**
 * This computer, as the backend's process sees it. Studio answers when its own MCP server lists it,
 * asked through one StudioMCP the backend keeps for its life (StudioMCP ends with its stdin, so it
 * ends with the backend). It starts only once Studio is set up and running.
 */
export function systemDeps(): RobloxDeps {
  const locate: LocateDeps = {
    platform: process.platform,
    env: process.env,
    home: os.userInfo().homedir,
    fs: systemLocateFs,
    run: systemRun,
  };
  const client = createStudioClient(
    systemStudioClientDeps(async () => {
      const location = await locateStudio(locate);
      return location.installed ? location.install.mcp : undefined;
    }),
  );
  return {
    ...locate,
    answers: () => studioAnswers(client),
    helper: path.join(path.dirname(fileURLToPath(import.meta.url)), HELPER_FILE),
    open: systemOpener,
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
  };
}

export const activate: Activate = () => createRobloxBackend(systemDeps());
