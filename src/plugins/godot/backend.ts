/**
 * The Godot plugin's backend. Agents build a Godot game with Godot's own command line, run in
 * Genex's native-job sandbox (`godot-run.ts`): `new-game` makes the game's project from a template,
 * `check` imports it and loads every file so Godot names each problem, `run-scene` plays a scene
 * headless, `screenshot` takes stills, and `class-reference` answers the installed version's API.
 * Genex's moments use the same: a checkpoint notes what the check found, and a run's save points
 * and its reviewer get stills (`hero-shots`). The panel and the toolbar find Godot, make a game
 * and open it in the person's own Godot editor, which Genex never drives.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type HookAnswer, HookEvent } from "../../shared/plugin-hooks.ts";
import { OBSERVE_CALL_MS } from "../../shared/observers.ts";
import type { Activate, PluginActivation, PluginContext } from "../../plugin-sdk/index.d.ts";
import { answerQuery, createReference } from "./class-reference.ts";
import { editorOpen, type EditorEnv, getGodotLaunch, openEditorLaunch, systemEditorEnv } from "./editor.ts";
import {
  findGodots,
  type GodotEnv,
  type GodotInstall,
  GodotReadiness,
  godotReadiness,
  systemGodotEnv,
  usableGodot,
  versionName,
} from "./find-godot.ts";
import { checkedCount, isError, MAX_PROBLEMS, problemLines, readProblems } from "./godot-output.ts";
import {
  checkCall,
  confinedRunner,
  DEFAULT_RUN_SECONDS,
  type GodotRunner,
  importCall,
  MAX_RUN_SECONDS,
  runCall,
} from "./godot-run.ts";
import { findGameProject, GAME_PROJECT_FOLDER, projectScene, requireGameProject } from "./game-project.ts";
import { createProject, GodotTemplate } from "./new-project.ts";
import { MAX_STILLS, stillsAnswer, stillsForAgent, takeStills } from "./stills.ts";

/** The host services this backend calls, by their public SDK names. */
const HostService = { StorageRoot: "storage.root", GameCreate: "game.create" } as const;

/** The actions plugin.json declares. */
const GodotAction = {
  Status: "status",
  Create: "create",
  OpenEditor: "open-editor",
  GetGodot: "get-godot",
  ToolbarStatus: "toolbar-status",
} as const;
type GodotAction = (typeof GodotAction)[keyof typeof GodotAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(GodotAction));
const isGodotAction = (name: string): name is GodotAction => ACTION_NAMES.has(name);

/** The tools plugin.json declares: the agent's, then the harness's own (`audience: harness`). */
export const GodotTool = {
  NewGame: "new-game",
  Check: "check",
  RunScene: "run-scene",
  Screenshot: "screenshot",
  ClassReference: "class-reference",
  EngineStatus: "engine-status",
  CheckpointCheck: "checkpoint-check",
  HeroShots: "hero-shots",
} as const;
type GodotTool = (typeof GodotTool)[keyof typeof GodotTool];
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(GodotTool));
const isGodotTool = (name: string): name is GodotTool => TOOL_NAMES.has(name);

/** The folders shipped beside the backend: Genex's GDScript and the new-game templates. */
const SCRIPTS_FOLDER = "scripts";
const TEMPLATES_FOLDER = "templates";
/** What an observer's capture keeps free of the time Genex gives it: reading and handing back the pictures. */
const OBSERVE_MARGIN_MS = 5 * SECOND_MS;
/** The least an observer's capture is given, however little time is left: a shorter one could draw nothing. */
const MIN_OBSERVE_MS = SECOND_MS;
/** The most lines of a run's own printing an answer carries, from its end. */
const RUN_OUTPUT_LINES = 40;
/** How many problems a checkpoint's note names. */
const NOTED_PROBLEMS = 3;
/** The agent's name for the new-game tool, as the engine question reads it. */
const NEW_GAME = "godot__new-game";

const MESSAGE = {
  UnknownAction: (name: string) => `Unknown Godot action: ${name}`,
  UnknownTool: (name: string) => `Unknown Godot tool: ${name}`,
  NoGodot:
    "Godot 4 isn't installed on this Mac. Tell the user to press the Godot button above the game: it opens Godot's download page, and Genex finds Godot once it is in Applications.",
  NoGameOpen: "Open a game in Genex first: a Godot project is made in a game's folder.",
  NewGame: (template: string, version: string) =>
    `Made this game's Godot project in ${GAME_PROJECT_FOLDER}/ from the ${template.toUpperCase()} template, for Godot ${version}: main.tscn (a player that moves, and a HeroCamera in the genex_shot group) and player.gd. Build the game there in GDScript and scenes, never as a web page. After each change call godot__check; call godot__screenshot to see it. The person opens it in Godot from the Godot button.`,
  ImportFailed: (why: string) => `Godot's first import didn't finish (${why}); godot__check imports again.`,
  Checked: (count: number) => `Loaded ${count} scripts, scenes and resources.`,
  NotChecked: "Godot stopped before its check finished: the problems above are what it found.",
  TimedOut: "Godot didn't finish in time and was stopped.",
  NoStills: "Godot saved no stills: check that the scene loads (godot__check) and has a camera.",
  CheckNote: (count: number, lines: readonly string[]) =>
    `Godot's check found ${count} ${count === 1 ? "problem" : "problems"}: ${lines.slice(0, NOTED_PROBLEMS).join(" | ")}${count > NOTED_PROBLEMS ? ` (and ${count - NOTED_PROBLEMS} more)` : ""}`,
  BadSeconds: `seconds is a whole number from 1 to ${MAX_RUN_SECONDS}.`,
  Toolbar: {
    Get: "Get Godot 4",
    Old: (version: string) => `Godot ${version} is older than the 4.3 Genex builds with`,
    Ready: (version: string) => `Godot ${version}`,
    Open: (version: string) => `Godot ${version} has this game's project open`,
  },
} as const;

/** The toolbar button's badge while Godot is missing. */
const GET_BADGE = "Get";

/**
 * What the backend is given: how Godot is found and run, the person's editor, and the folders of
 * Genex's shipped scripts and templates. Tests hand in fakes for each.
 */
export type GodotBackendDeps = {
  env: GodotEnv;
  editor: EditorEnv;
  run: GodotRunner;
  scripts: string;
  templates: string;
};

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

const textArg = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" ? args[key].trim() : "");
const storageOf = (context: PluginContext) => context.host(HostService.StorageRoot);
/** The open game's folder, where New game makes its project; undefined outside a game. */
const gameFolderOf = (context: PluginContext): string | undefined =>
  context.project && context.directory ? context.directory : undefined;

/** The Godot Genex uses, or why there is none in the words an agent passes on. */
async function requireGodot(deps: GodotBackendDeps): Promise<GodotInstall> {
  const install = usableGodot(await findGodots(deps.env));
  if (!install) throw new Error(MESSAGE.NoGodot);
  return install;
}

/** The engine question's words for this Mac's Godot: ready to make a game with, or what it needs first. */
function readinessNote(readiness: GodotReadiness, version: string | null): string {
  const toButton =
    "If the user picks it, don't call godot__new-game, which would refuse: tell them to press the Godot button above the game, which opens Godot's free download, and to send a message once Godot is in Applications.";
  if (readiness === GodotReadiness.None)
    return `Godot isn't installed on this Mac yet, so offer it as "Godot" with the description "Free and open source; needs Godot 4 installed first, about 150 MB". ${toButton}`;
  if (readiness !== GodotReadiness.Ready)
    return `This Mac has Godot ${version ?? ""}, and Genex builds with Godot 4.3 or newer in the 4 line, so offer it as "Godot 4" with the description "Needs a current Godot 4 beside your ${version ?? "Godot"}". ${toButton}`;
  return `Offer "Godot ${version ?? "4"}: builds in the Godot editor on this computer"; when the answer (or the request) is Godot, call ${NEW_GAME} with a template (2d or 3d) and a name: it makes the game's Godot project in this folder's ${GAME_PROJECT_FOLDER}/; then build the game there with the Godot tools, never as a web page.`;
}

/** `engine-status`: whether a new Godot game can be made here, and the engine card's words. */
async function engineStatus(deps: GodotBackendDeps) {
  const { readiness, version } = godotReadiness(await findGodots(deps.env));
  return {
    engine: readiness,
    version,
    ready: readiness === GodotReadiness.Ready,
    note: readinessNote(readiness, version),
  };
}

/** A first import, so the project's classes are known to the first check; one that fails is said, never thrown. */
async function firstImport(deps: GodotBackendDeps, install: GodotInstall, project: string, signal: AbortSignal) {
  try {
    const imported = await deps.run(install.binary, importCall(project), signal);
    return imported.timedOut ? MESSAGE.ImportFailed(MESSAGE.TimedOut) : null;
  } catch (error) {
    return MESSAGE.ImportFailed(errorMessage(error));
  }
}

/** The agent's `new-game`: the game's Godot project from a template, imported once. */
async function newGame(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  const install = await requireGodot(deps);
  const template = textArg(args, "template") || GodotTemplate.ThreeD;
  const project = await createProject(game, { template, name: textArg(args, "name") }, deps.templates);
  const note = await firstImport(deps, install, project, context.signal);
  const made = MESSAGE.NewGame(template.toLowerCase(), versionName(install.version));
  return note ? `${made}\n${note}` : made;
}

/** An import, then Genex's check: every problem Godot named, and how many files it loaded. */
async function runCheck(deps: GodotBackendDeps, install: GodotInstall, project: string, signal: AbortSignal) {
  const imported = await deps.run(install.binary, importCall(project), signal);
  const checked = await deps.run(install.binary, checkCall(project, deps.scripts), signal);
  const problems = readProblems(`${imported.output}\n${checked.output}`);
  return { problems, checked: checkedCount(checked.output), timedOut: imported.timedOut || checked.timedOut };
}

/** The agent's `check`: errors and warnings by file and line, at most {@link MAX_PROBLEMS} of each. */
async function check(deps: GodotBackendDeps, context: PluginContext) {
  const project = await requireGameProject(context.directory);
  const result = await runCheck(deps, await requireGodot(deps), project, context.signal);
  const errors = result.problems.filter(isError);
  const warnings = result.problems.filter((p) => !isError(p));
  return {
    ok: errors.length === 0 && result.checked !== null,
    errors: problemLines(errors.slice(0, MAX_PROBLEMS)),
    warnings: problemLines(warnings.slice(0, MAX_PROBLEMS)),
    ...(errors.length > MAX_PROBLEMS ? { moreErrors: errors.length - MAX_PROBLEMS } : {}),
    summary: checkSummary(result),
  };
}

/** One line on how a check went: cut off, stopped short, or how much it loaded. */
function checkSummary(result: { checked: number | null; timedOut: boolean }): string {
  if (result.timedOut) return MESSAGE.TimedOut;
  return result.checked === null ? MESSAGE.NotChecked : MESSAGE.Checked(result.checked);
}

/** `checkpoint-check`, Genex's check at a checkpoint: a note of what Godot found, never a block; nothing when all is well or Godot is missing. */
async function checkAtMoment(deps: GodotBackendDeps, context: PluginContext): Promise<HookAnswer> {
  if (context.hook?.on !== HookEvent.CheckpointBefore) return {};
  const project = context.directory ? await findGameProject(context.directory) : null;
  const install = usableGodot(await findGodots(deps.env));
  if (!project || !install) return {};
  const result = await runCheck(deps, install, project, context.signal).catch(() => null);
  const errors = result?.problems.filter(isError) ?? [];
  return errors.length ? { note: MESSAGE.CheckNote(errors.length, problemLines(errors)) } : {};
}

/** The seconds a run asks for: a whole number from 1 to {@link MAX_RUN_SECONDS}, or the default when absent. */
function runSeconds(args: Record<string, unknown>): number {
  if (args.seconds === undefined || args.seconds === "") return DEFAULT_RUN_SECONDS;
  const seconds = Number(args.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RUN_SECONDS) throw new Error(MESSAGE.BadSeconds);
  return seconds;
}

/** The lines a run printed itself, without Godot's own banner and problems, from the end. */
function ownOutput(output: string): string[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("Godot Engine v"));
  return lines.filter((line) => !/^\s/.test(line) && !/^[A-Z ]*(ERROR|WARNING): /.test(line)).slice(-RUN_OUTPUT_LINES);
}

/** The agent's `run-scene`: a headless play of a scene, what it printed and what went wrong. */
async function runScene(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const project = await requireGameProject(context.directory);
  const seconds = runSeconds(args);
  const scene = await projectScene(project, textArg(args, "scene"));
  const install = await requireGodot(deps);
  await deps.run(install.binary, importCall(project), context.signal);
  const ran = await deps.run(install.binary, runCall(project, scene, seconds), context.signal);
  const errors = readProblems(ran.output).filter(isError);
  return {
    scene: scene || "main scene",
    seconds,
    errors: problemLines(errors.slice(0, MAX_PROBLEMS)),
    output: ownOutput(ran.output),
    ...(ran.timedOut ? { summary: MESSAGE.TimedOut } : {}),
  };
}

/** The most stills an agent asks for: a whole number from 1 to {@link MAX_STILLS}, else all of them. */
const stillCount = (args: Record<string, unknown>) => {
  const asked = Number(args.max);
  return Number.isInteger(asked) && asked >= 1 ? Math.min(asked, MAX_STILLS) : MAX_STILLS;
};

/** The agent's `screenshot`: the stills, which the model sees, and their cameras' names. */
async function screenshot(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const project = await requireGameProject(context.directory);
  const scene = await projectScene(project, textArg(args, "scene"));
  const install = await requireGodot(deps);
  const storage = await storageOf(context);
  await deps.run(install.binary, importCall(project), context.signal);
  const stills = await takeStills(
    { ...deps, storage },
    install,
    project,
    { scene, most: stillCount(args) },
    context.signal,
  );
  if (stills.length === 0) throw new Error(MESSAGE.NoStills);
  return stillsForAgent(stills);
}

/**
 * `hero-shots`: the main scene's stills as pictures. At a checkpoint only a run's save point takes
 * them (a chat's checkpoint keeps none); as the viewport observer they must land within the time
 * Genex gives; a plain call answers them as the agent's screenshot does. Nothing when the game has
 * no project or this Mac no Godot.
 */
async function heroShots(deps: GodotBackendDeps, context: PluginContext): Promise<unknown> {
  if (context.hook && (context.hook.on !== HookEvent.CheckpointAfter || !context.hook.runId)) return {};
  const project = context.directory ? await findGameProject(context.directory) : null;
  const install = usableGodot(await findGodots(deps.env));
  if (!project || !install) return {};
  const signal = context.observe ? observeSignal(context.signal, context.observe.withinMs) : context.signal;
  const storage = await storageOf(context);
  // A fresh project's assets are imported first, or its stills would show them missing.
  await deps.run(install.binary, importCall(project), signal);
  const stills = await takeStills({ ...deps, storage }, install, project, { scene: "", most: MAX_STILLS }, signal);
  return context.hook || context.observe ? stillsAnswer(stills) : stillsForAgent(stills);
}

/** An observer's call ends with the turn or once the time Genex gives it, less what keeping the pictures takes, runs out. */
function observeSignal(turn: AbortSignal, withinMs: number | undefined): AbortSignal {
  const left = Math.max(MIN_OBSERVE_MS, (withinMs ?? OBSERVE_CALL_MS) - OBSERVE_MARGIN_MS);
  return AbortSignal.any([turn, AbortSignal.timeout(left)]);
}

/** The agent's `class-reference`: the installed Godot's API for a class, or the names that hold a word. */
function classReference(deps: GodotBackendDeps): Handler {
  const reference = createReference(deps.run);
  return async (args, context) => {
    const install = await requireGodot(deps);
    const index = await reference(install, await storageOf(context), context.signal);
    return answerQuery(index, textArg(args, "query"), versionName(install.version));
  };
}

/** The panel's status: the Godot Genex uses, every Godot found, and the open game's project. */
async function status(deps: GodotBackendDeps, context: PluginContext) {
  const installs = await findGodots(deps.env);
  const install = usableGodot(installs);
  const project = context.directory ? await findGameProject(context.directory) : null;
  return {
    ...godotReadiness(installs),
    godot: install
      ? { version: versionName(install.version), binary: install.binary, mono: install.version.mono }
      : null,
    installs: installs.map((i) => ({ version: i.version.text, binary: i.binary, supported: i.supported })),
    game: Boolean(gameFolderOf(context)),
    project: project && context.directory ? path.relative(context.directory, project) || "." : null,
    editorOpen: project ? await editorOpen(deps.editor, project) : false,
  };
}

/** The toolbar button's word: get Godot, too old, or its version and whether it has this game open. */
async function toolbarStatus(deps: GodotBackendDeps, context: PluginContext) {
  const installs = await findGodots(deps.env);
  const install = usableGodot(installs);
  if (!install) {
    const older = installs[0];
    const title = older ? MESSAGE.Toolbar.Old(versionName(older.version)) : MESSAGE.Toolbar.Get;
    return { badge: GET_BADGE, tone: "warn", title };
  }
  const version = versionName(install.version);
  const project = context.directory ? await findGameProject(context.directory) : null;
  const open = project ? await editorOpen(deps.editor, project) : false;
  return open ? { tone: "ok", title: MESSAGE.Toolbar.Open(version) } : { title: MESSAGE.Toolbar.Ready(version) };
}

/** The panel's Create: the open game's project, or a new Genex game for it when none is open. */
async function create(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const install = await requireGodot(deps);
  const name = textArg(args, "name");
  const request = { template: textArg(args, "template") || GodotTemplate.ThreeD, name };
  const made = gameFolderOf(context) ? null : await context.host(HostService.GameCreate, { title: name });
  const game = gameFolderOf(context) ?? made?.directory;
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  const project = await createProject(game, request, deps.templates);
  const note = await firstImport(deps, install, project, context.signal);
  return { project, game: made ? { project: made.project } : null, ...(note ? { note } : {}) };
}

/** The panel's Open in Godot: the open game's project in the person's own editor. */
async function openInEditor(deps: GodotBackendDeps, context: PluginContext) {
  const project = await requireGameProject(context.directory);
  await deps.editor.open(openEditorLaunch(await requireGodot(deps), project));
  return { opened: project };
}

/** The backend with the computer, runner and editor it is given; tests hand in fakes. */
export function createGodotBackend(deps: GodotBackendDeps): PluginActivation {
  const actions: Record<GodotAction, Handler> = {
    [GodotAction.Status]: (_args, context) => status(deps, context),
    [GodotAction.Create]: (args, context) => create(deps, args, context),
    [GodotAction.OpenEditor]: (_args, context) => openInEditor(deps, context),
    [GodotAction.GetGodot]: async () => {
      await deps.editor.open(getGodotLaunch());
      return { opened: true };
    },
    [GodotAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
  };
  const tools: Record<GodotTool, Handler> = {
    [GodotTool.NewGame]: (args, context) => newGame(deps, args, context),
    [GodotTool.Check]: (_args, context) => check(deps, context),
    [GodotTool.RunScene]: (args, context) => runScene(deps, args, context),
    [GodotTool.Screenshot]: (args, context) => screenshot(deps, args, context),
    [GodotTool.ClassReference]: classReference(deps),
    [GodotTool.EngineStatus]: () => engineStatus(deps),
    [GodotTool.CheckpointCheck]: (_args, context) => checkAtMoment(deps, context),
    [GodotTool.HeroShots]: (_args, context) => heroShots(deps, context),
  };
  return {
    async action(name, args, context) {
      if (!isGodotAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (!isGodotTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      return tools[name](args, context);
    },
  };
}

export const activate: Activate = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return createGodotBackend({
    env: systemGodotEnv(),
    editor: systemEditorEnv(),
    run: confinedRunner(),
    scripts: path.join(here, SCRIPTS_FOLDER),
    templates: path.join(here, TEMPLATES_FOLDER),
  });
};
