import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Activate,
  PluginActivation,
  PluginContext,
  PluginEngineAssistRefusal,
  PluginEngineLink,
  PluginReview,
  PluginToolbarStatus,
} from "../../plugin-sdk/index.d.ts";
import { errorMessage } from "../../shared/errors.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { SYSTEM_CLOCK } from "../../substrate/job-process.ts";
import { RobloxAction } from "./actions.ts";
import { type HelperLink, startHelperLink } from "./helper-link.ts";
import type { ScriptChange } from "./helper-protocol.ts";
import {
  nowStep,
  type RobloxRow,
  type RobloxStepFacts,
  type RobloxStepId,
  type RobloxSteps,
  robloxRows,
  robloxSteps,
} from "./engine-steps.ts";
import { readLiveData } from "./live-data.ts";
import { planSwitches, readSwitches } from "./mcp-switch.ts";
import {
  HELPER_FILE,
  HelperChange,
  planSetup,
  recordedHelper,
  type SetupDone,
  type SetupOptions,
  setUp,
  setupPaths,
  undoSetup,
} from "./setup.ts";
import { RobloxSetupError, SetupRefusal } from "./setup-refusal.ts";
import { createScriptSyncs, type ScriptSyncs, systemWatch } from "./script-sync.ts";
import { createStudioClient, type StudioClient, studioAnswers, systemStudioClientDeps } from "./studio-client.ts";
import {
  ALLOWED_HOST,
  afterInstall,
  INSTALLER,
  type InstallDeps,
  InstallError,
  InstallPhase,
  type InstallRefusal,
  installStudio,
  systemInstallRun,
} from "./studio-install.ts";
import {
  createGame,
  engineStatus,
  newGameTool,
  openStudio,
  type PlaceActionDeps,
  quitStudioAction,
  showSteps,
} from "./place-actions.ts";
import { linkedPlace, listPlaces, type ScanCache, usePlace, usePlaceNamed } from "./places.ts";
import { openLaunch, quitStudio, startingNow, systemOpener } from "./studio-launch.ts";
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
 * a prompt that only the person's own press may raise. Once Studio is set up it also serves the
 * helper link (`helper-link.ts`), which tells each game's connection which Studio is the game's.
 */

/** The host services this backend calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  EngineAssist: "game.engine.assist",
  EngineRead: "game.engine.read",
} as const;

export { RobloxAction };
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(RobloxAction));
const isRobloxAction = (name: string): name is RobloxAction => ACTION_NAMES.has(name);

/** The tools plugin.json declares. Wire values: never rename. */
export const RobloxTool = {
  StudioActivity: "studio-activity",
  CheckScripts: "check-scripts",
  UseProject: "use-project",
  ShowSteps: "show-steps",
  NewGame: "new-game",
  EngineStatus: "engine-status",
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
/** Where Get Roblox Studio last stood, in the plugin's own storage. */
const INSTALL_RECORD = path.join("install", "state.json");

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
export interface RobloxDeps extends PlaceActionDeps {
  /** Whether the open Studio answers Genex. */
  answers(): Promise<boolean>;
  /** The shipped Genex helper file. */
  helper: string;
  /** The network, the programs and the temporary folder Get Roblox Studio uses. */
  install: Pick<InstallDeps, "fetch" | "run" | "tempRoot">;
  /**
   * Starts the helper link in the plugin's storage, once however often it is called. It is called
   * only once Genex has set Studio up: before that no helper exists to connect.
   */
  helperLink?(storage: string): void;
}

/** Get Roblox Studio as the panel shows it: where it stands, in plain words, and why it stopped. */
export interface InstallStatus {
  phase: InstallPhase;
  message: string;
  reason?: InstallRefusal;
}

/** Get Roblox Studio under way or last finished in this backend, with the person's Stop. */
interface InstallJob extends InstallStatus {
  controller: AbortController;
  /** The record's writes, one after another, so an earlier phase never lands over a later one. */
  writes: Promise<void>;
}

/** The answer to Get Roblox Studio and its Stop. */
export interface GetStudioAnswer {
  started: boolean;
  message: string;
}

const isFinished = (job: InstallJob | undefined) =>
  !job || job.phase === InstallPhase.Done || job.phase === InstallPhase.Failed;

/** What the status is made of. */
export interface StudioFacts {
  installed: boolean;
  setUp: boolean;
  running: boolean;
  answering: boolean;
}

/** Studio's MCP switch in its settings: how many accounts' settings files there are, and how many have it on. */
export interface McpSwitchState {
  settings: number;
  on: number;
}

/** The panel's answer to `status`. */
export interface RobloxStatus {
  studio: StudioStatus;
  version?: string;
  steps: Record<PanelStep, boolean>;
  /** Get Roblox Studio, while it runs and after it has finished. */
  install?: InstallStatus;
  /** Studio's MCP switch, read from its settings (never Documents); absent when they can't be read. */
  mcp?: McpSwitchState;
  /** The helper Genex's record says it added. */
  helper?: { version: number; current: boolean };
  /** The panel's rows: the chat's steps card's, with the panel's extras on the step that is next. */
  rows: RobloxRow[];
  /** The step that is next; absent once every step is done. */
  now?: RobloxStepId;
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
  const storage = await context.host(HostService.StorageRoot);
  facts.setUp = await setUpIn(deps, storage);
  if (!facts.setUp) return { install, facts, storage };
  deps.helperLink?.(storage);
  // Studio Genex just opened counts as running (Starting) before its process is seen.
  facts.running = (await studioRunning(deps)) || (await startingNow(storage, deps.now()));
  facts.answering = facts.running && (await deps.answers());
  return { install, facts, storage };
}

/** What the panel shows of a Get Roblox Studio job. */
const installStatusOf = (job: InstallJob): InstallStatus => {
  const answer: InstallStatus = { phase: job.phase, message: job.message };
  if (job.reason) answer.reason = job.reason;
  return answer;
};

/** The link of the game this call is bound to, or null when it builds in no Roblox place. */
async function linkHere(context: PluginContext): Promise<PluginEngineLink | null> {
  if (!context.project) return null;
  return context.host(HostService.EngineRead).catch(() => null);
}

/** Studio's MCP switch across the accounts' settings files; undefined when they can't be read. */
async function mcpSwitch(deps: RobloxDeps): Promise<McpSwitchState | undefined> {
  try {
    const plan = await planSwitches(setupPaths(deps.platform, deps.env, deps.home).settings);
    return { settings: plan.files, on: plan.alreadyOn };
  } catch {
    return undefined;
  }
}

/** What the game's place adds to the rows: its name, the person's own Rojo project, and live saved data. */
async function placeFacts(context: PluginContext, storage: string | undefined) {
  const link = await linkHere(context);
  if (!link || !storage || !context.project) return { linked: Boolean(link) };
  const game = { project: context.project, ...(context.directory ? { directory: context.directory } : {}) };
  const place = await linkedPlace(storage, game, link);
  const live = await readLiveData(storage, context.project);
  return { linked: true, place: place.name, rojo: place.rojo, liveData: live?.reachable === true };
}

/** Where Get Roblox Studio stands, as the rows read it: under way, or stopped and why. */
function installFacts(job: InstallJob | undefined): Pick<RobloxStepFacts, "getting" | "failed"> {
  if (!job) return {};
  if (!isFinished(job)) return { getting: { detail: job.message } };
  return job.phase === InstallPhase.Failed ? { failed: { detail: job.message } } : {};
}

/**
 * Everything the rows are read from, now. Unlike the toolbar, the rows ask whether Studio runs
 * before setup too: Set up waits for Studio to close, and Open Studio is offered only while it is.
 */
async function stepFacts(deps: RobloxDeps, context: PluginContext, job: InstallJob | undefined) {
  const { install, facts, storage } = await readStudio(deps, context);
  const running = facts.running || (facts.installed && (await studioRunning(deps)));
  const mcp = facts.installed ? await mcpSwitch(deps) : undefined;
  const helper = facts.setUp && storage ? await recordedHelper(storage) : undefined;
  const rows: RobloxStepFacts = {
    ...facts,
    running,
    ...(install?.version ? { version: install.version } : {}),
    ...installFacts(job),
    ...(await placeFacts(context, storage)),
    mac: deps.platform === "darwin",
    ...(mcp ? { mcpOn: mcp.on > 0 } : {}),
  };
  return { install, facts, rows, mcp, helper };
}

async function status(deps: RobloxDeps, context: PluginContext, job: InstallJob | undefined): Promise<RobloxStatus> {
  const { install, facts, rows, mcp, helper } = await stepFacts(deps, context, job);
  const steps = {
    [PanelStep.Studio]: facts.installed,
    [PanelStep.Helper]: facts.setUp,
    [PanelStep.Mcp]: facts.answering,
    [PanelStep.Place]: rows.linked,
  };
  const answer: RobloxStatus = { studio: studioStatusOf(facts), steps, rows: robloxRows(rows) };
  if (install?.version) answer.version = install.version;
  if (job) answer.install = installStatusOf(job);
  if (mcp) answer.mcp = mcp;
  if (helper) answer.helper = helper;
  const now = nowStep(rows);
  if (now) answer.now = now;
  return answer;
}

/** The steps card, read now: the panel's rows, so a Studio already here is ticked with its version. */
async function steps(deps: RobloxDeps, context: PluginContext, job: InstallJob | undefined): Promise<RobloxSteps> {
  return robloxSteps((await stepFacts(deps, context, job)).rows);
}

async function toolbarStatus(deps: RobloxDeps, context: PluginContext): Promise<PluginToolbarStatus> {
  const { install, facts } = await readStudio(deps, context);
  return toolbarStatusOf(studioStatusOf(facts), install);
}

function setupOptionsIn(deps: RobloxDeps, storage: string): SetupOptions {
  return {
    paths: setupPaths(deps.platform, deps.env, deps.home),
    helper: deps.helper,
    storage,
    running: () => studioRunning(deps),
    now: deps.now,
  };
}

async function setupOptions(deps: RobloxDeps, context: PluginContext): Promise<SetupOptions> {
  return setupOptionsIn(deps, await context.host(HostService.StorageRoot));
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
async function runSetupWith(options: SetupOptions): Promise<SetupAnswer> {
  try {
    return setupDoneAnswer(await setUp(options));
  } catch (error) {
    return refusedAnswer(error);
  }
}

async function runSetup(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  return runSetupWith(await setupOptions(deps, context));
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

/** Writes where Get Roblox Studio stands into storage, after any earlier write, so the record keeps the newest. */
function writePhase(job: InstallJob, storage: string, phase: InstallPhase, now: number): Promise<void> {
  const record: Record<string, unknown> = { phase, at: new Date(now).toISOString() };
  if (job.reason) record.reason = job.reason;
  const write = () => atomicWriteJson(path.join(storage, INSTALL_RECORD), record).catch(() => undefined);
  job.writes = job.writes.then(write);
  return job.writes;
}

/** A step on the way: the panel sees it at once, the record follows. */
function notePhase(job: InstallJob, storage: string, phase: InstallPhase, now: number): void {
  job.phase = phase;
  job.message = MESSAGE.Install.Phase[phase];
  void writePhase(job, storage, phase, now);
}

/** The end: recorded first, then shown, so whoever sees it finished finds the record finished too. */
async function finish(job: InstallJob, storage: string, end: { phase: InstallPhase; message: string; now: number }) {
  await writePhase(job, storage, end.phase, end.now);
  job.message = end.message;
  job.phase = end.phase;
}

/**
 * Get Roblox Studio, start to end: Roblox's installer downloaded, checked and run; Studio waited
 * for; the person's sign-in in the installer's Studio; Set up while that Studio is closed; Studio
 * opened again once.
 */
async function getStudioJob(deps: RobloxDeps, job: InstallJob, storage: string): Promise<void> {
  const signal = job.controller.signal;
  const onPhase = (phase: InstallPhase) => notePhase(job, storage, phase, deps.now());
  try {
    await installStudio({ ...deps.install, platform: deps.platform, env: deps.env }, { signal, onPhase });
    const setUpStep = async () => (await runSetupWith(setupOptionsIn(deps, storage))).message;
    const done = await afterInstall({ ...deps, setUp: setUpStep }, { signal, onPhase });
    await finish(job, storage, { phase: InstallPhase.Done, message: done.message, now: deps.now() });
  } catch (error) {
    if (error instanceof InstallError) job.reason = error.code;
    const message = error instanceof InstallError ? error.message : MESSAGE.Install.Phase.failed;
    await finish(job, storage, { phase: InstallPhase.Failed, message, now: deps.now() });
  }
}

/** The one Get Roblox Studio this backend runs at a time. */
interface InstallSlot {
  job?: InstallJob;
}

/**
 * Get Roblox Studio: starts the install and answers at once, so the panel follows it through
 * `status`. A Studio already here, or an install already going, is answered in words, not run.
 */
async function getStudio(deps: RobloxDeps, context: PluginContext, slot: InstallSlot): Promise<GetStudioAnswer> {
  if (!isFinished(slot.job)) return { started: false, message: MESSAGE.Install.AlreadyGetting };
  const location = await locateStudio(deps);
  if (location.installed)
    return { started: false, message: MESSAGE.Install.AlreadyInstalled(location.install.version) };
  if (!(deps.platform in INSTALLER)) return { started: false, message: MESSAGE.Install.Refused.unsupported };
  const storage = await context.host(HostService.StorageRoot);
  const job: InstallJob = {
    phase: InstallPhase.Downloading,
    message: MESSAGE.Install.Phase.downloading,
    controller: new AbortController(),
    writes: Promise.resolve(),
  };
  slot.job = job;
  void getStudioJob(deps, job, storage);
  return { started: true, message: MESSAGE.Install.Started };
}

/** Stop: ends the download or the wait under way. Roblox's installer, once running, finishes on its own. */
function cancelGetStudio(slot: InstallSlot): GetStudioAnswer {
  const job = slot.job;
  if (!job || isFinished(job)) return { started: false, message: MESSAGE.Install.NothingToStop };
  job.controller.abort();
  return { started: false, message: MESSAGE.Install.Stopped };
}

/** Get Roblox Studio's confirmation: this computer's download, where it comes from, and the sign-in. */
function reviewGetStudio(deps: RobloxDeps): PluginReview {
  if (!(deps.platform in INSTALLER)) return {};
  const installer = INSTALLER[deps.platform as keyof typeof INSTALLER];
  return { message: MESSAGE.Install.Confirm(installer.megabytes), detail: MESSAGE.Install.Plan(ALLOWED_HOST) };
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

/** Hands the script sync the folder of the game a call is for; a call with none is left alone. */
async function noteGame(deps: RobloxDeps, context: PluginContext): Promise<void> {
  if (!deps.gameSeen || !context.project || !context.directory) return;
  const storage = await context.host(HostService.StorageRoot);
  await deps.gameSeen(storage, context.project, context.directory);
}

/** The backend over the computer it is given; tests hand in fakes. */
export function createRobloxBackend(deps: RobloxDeps): PluginActivation {
  const slot: InstallSlot = {};
  const scan: ScanCache = {};
  const actions: Record<RobloxAction, Handler> = {
    [RobloxAction.Status]: (_args, context) => status(deps, context, slot.job),
    [RobloxAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
    [RobloxAction.Steps]: (_args, context) => steps(deps, context, slot.job),
    [RobloxAction.GetStudio]: (_args, context) => getStudio(deps, context, slot),
    [RobloxAction.CancelGetStudio]: async () => cancelGetStudio(slot),
    [RobloxAction.OpenStudio]: (_args, context) => openStudio(deps, context),
    [RobloxAction.QuitStudio]: (_args, context) => quitStudioAction(deps, context),
    [RobloxAction.Places]: (_args, context) => listPlaces(deps, context, scan),
    [RobloxAction.UsePlace]: (args, context) => usePlace(deps, context, args, scan),
    [RobloxAction.Create]: (args, context) =>
      createGame(deps, context, { snapshot: true, ...(typeof args.title === "string" ? { title: args.title } : {}) }),
    [RobloxAction.Setup]: (_args, context) => setupAction(deps, context),
    [RobloxAction.UndoSetup]: (_args, context) => undoAction(deps, context),
    [RobloxAction.RestartStudio]: (_args, context) => restartStudio(deps, context),
    [RobloxAction.DoItForMe]: (_args, context) => doItForMe(context),
  };
  const tools: Record<RobloxTool, Handler> = {
    // Nothing here watches Studio's own edits yet, so the person is never seen using it.
    [RobloxTool.StudioActivity]: async () => ({ personActive: false }),
    [RobloxTool.CheckScripts]: async () => ({ checked: false, message: MESSAGE.Checks.NotAdded }),
    [RobloxTool.UseProject]: async (args, context) => (await usePlaceNamed(deps, context, args.project)).message,
    [RobloxTool.ShowSteps]: async (_args, context) => showSteps(context, (await steps(deps, context, slot.job)).open),
    [RobloxTool.NewGame]: (_args, context) => newGameTool(deps, context),
    [RobloxTool.EngineStatus]: () => engineStatus(deps),
  };
  return {
    async action(name, args, context) {
      if (!isRobloxAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      await noteGame(deps, context).catch(() => undefined);
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (!isRobloxTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      await noteGame(deps, context).catch(() => undefined);
      return tools[name](args, context);
    },
    async review(name) {
      if (name === RobloxAction.GetStudio) return reviewGetStudio(deps);
      return name === RobloxAction.Setup ? reviewSetup(deps) : {};
    },
  };
}

/** The helper link and the script sync on this computer, as the backend's process runs them. */
interface HelperServices {
  helperLink(storage: string): void;
  gameSeen(storage: string, game: string, folder: string): Promise<void>;
  noteWritten(storage: string, game: string, folder: string, name: string): Promise<void>;
}

/**
 * The helper link on this computer, started once: the Genex helper in Studio connects to it, and it
 * reads the helper's marker through the backend's own StudioMCP. A range with every port taken is
 * logged and left; the link starts again with the backend. Each game's scripts are reconciled when
 * its helper binds, before agents can reach that Studio, and kept in step while it stays bound.
 */
function helperServices(client: StudioClient, stopped: AbortSignal): HelperServices {
  let link: HelperLink | undefined;
  let syncs: ScriptSyncs | undefined;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const syncsIn = (storage: string) => {
    syncs ??= createScriptSyncs({
      storage,
      ask: (game) => (type, body, options) =>
        link ? link.request(game, type, body, options) : Promise.reject(new Error("The helper link isn't started")),
      bound: (game) => link?.bound(game) !== undefined,
      clock: SYSTEM_CLOCK,
      watch: systemWatch(log),
      log,
    });
    return syncs;
  };
  stopped.addEventListener("abort", () => syncs?.stop(), { once: true });
  let started = false;
  return {
    helperLink(storage) {
      if (started) return;
      started = true;
      const scripts = syncsIn(storage);
      const deps = {
        storage,
        studio: client,
        clock: SYSTEM_CLOCK,
        newSession: randomUUID,
        log,
        beforeBind: (game: string) => scripts.bind(game),
        sinks: { scriptsChanged: (game: string, change: ScriptChange) => scripts.changed(game, change) },
      };
      startHelperLink(deps, { signal: stopped }).then(
        (running) => {
          link = running.link;
        },
        (error: unknown) => log(`helper link: ${errorMessage(error)}`),
      );
    },
    gameSeen: (storage, game, folder) => syncsIn(storage).seen(game, folder),
    noteWritten: (storage, game, folder, name) => syncsIn(storage).written(game, folder, name),
  };
}

/**
 * Aborts when Genex lets go of this backend (its IPC channel closes: Genex quit or ended). The
 * helper link and the backend's StudioMCP then end, so nothing keeps the process, or the port.
 */
function backendGone(): AbortSignal {
  const gone = new AbortController();
  process.once("disconnect", () => gone.abort());
  return gone.signal;
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
  const gone = backendGone();
  gone.addEventListener("abort", () => void client.close(), { once: true });
  const services = helperServices(client, gone);
  return {
    ...locate,
    answers: () => studioAnswers(client),
    helperLink: services.helperLink,
    gameSeen: services.gameSeen,
    noteWritten: services.noteWritten,
    studio: client,
    helper: path.join(path.dirname(fileURLToPath(import.meta.url)), HELPER_FILE),
    install: { fetch: globalThis.fetch, run: systemInstallRun, tempRoot: os.tmpdir() },
    open: systemOpener,
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
  };
}

export const activate: Activate = () => createRobloxBackend(systemDeps());
