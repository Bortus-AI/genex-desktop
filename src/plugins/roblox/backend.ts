import os from "node:os";
import path from "node:path";
import type { Activate, PluginActivation, PluginContext, PluginToolbarStatus } from "../../plugin-sdk/index.d.ts";
import {
  type LocateDeps,
  locateStudio,
  type StudioInstall,
  studioRunning,
  systemLocateFs,
  systemRun,
} from "./studio-locate.ts";
import { createStudioClient, studioAnswers, systemStudioClientDeps } from "./studio-client.ts";
import { MESSAGE } from "./words.ts";

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
} as const;

/** The actions plugin.json declares. Wire values: never rename. */
export const RobloxAction = {
  Status: "status",
  ToolbarStatus: "toolbar-status",
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

/** The computer the backend works on; tests hand in a fake one. */
export interface RobloxDeps extends LocateDeps {
  /** Whether the open Studio answers Genex. */
  answers(): Promise<boolean>;
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

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

/** The backend over the computer it is given; tests hand in fakes. */
export function createRobloxBackend(deps: RobloxDeps): PluginActivation {
  const actions: Record<RobloxAction, Handler> = {
    [RobloxAction.Status]: (_args, context) => status(deps, context),
    [RobloxAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
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
  return { ...locate, answers: () => studioAnswers(client) };
}

export const activate: Activate = () => createRobloxBackend(systemDeps());
