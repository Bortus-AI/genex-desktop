/**
 * How Genex runs Godot: each job is a value (its arguments, what it may read and write, its
 * deadline), and one runner starts it in Genex's sandbox. On a Mac that is the sandbox Genex's
 * native jobs use (`runNativeProcess`): Godot gets a private home (so a game's `user://` files and
 * Godot's own caches stay out of the person's), no network, writes only to the project and the
 * job's own folders, and its whole process group is stopped at its deadline or the turn's Stop. On
 * Windows the job is the host's sandbox job (`sandbox.run`: ProcessSandbox, as the sandbox user,
 * no network), which reads and writes only inside the game: a folder the job writes outside it (a
 * capture's stills, the class reference) waits in the project's own `.godot` folder and is copied
 * out once the job ends, and a file it reads outside it (an export template) is copied in first. A deadline is a must: a script that awaits a frame that never draws (a headless
 * capture) would wait forever. Tests hand in their own runner and never start Godot.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  type PluginSandboxJob,
  type PluginSandboxRunArgs,
  PluginService,
  SandboxJobState,
} from "../../shared/plugins.ts";
import { isBelow } from "../../substrate/paths.ts";
import { NativeEndReason, runNativeProcess } from "../../substrate/plugins/native-process.ts";
import { type KeyPress, keysArg, PLAY_FPS, type ShotAt, shotsArg } from "./play-input.ts";

/** The jobs Genex runs Godot for. Never rename a value: records name them. */
export const GodotJob = {
  Import: "import",
  Check: "check",
  Run: "run",
  Capture: "capture",
  Play: "play",
  Reference: "reference",
  Export: "export",
  /** Windows: a file Genex staged put into Godot's own data folder (an export template). */
  Data: "data",
} as const;
export type GodotJob = (typeof GodotJob)[keyof typeof GodotJob];

/** Genex's own GDScript, shipped beside the backend in `scripts/`. */
export const GodotScript = { Check: "genex_check.gd", Play: "genex_play.gd", Data: "genex_data.gd" } as const;

/** An import of a big project's assets can take minutes the first time; later ones are quick. */
const IMPORT_TIMEOUT_MS = 5 * MINUTE_MS;
const CHECK_TIMEOUT_MS = 2 * MINUTE_MS;
const REFERENCE_TIMEOUT_MS = 2 * MINUTE_MS;
const DATA_TIMEOUT_MS = MINUTE_MS;
/** A run's own seconds play at a fixed 60 frames each, faster than real time headless; this covers its start and a slow game. */
const RUN_START_MS = 30 * SECOND_MS;
const RUN_SECOND_BUDGET_MS = 3 * SECOND_MS;
/** The frames a run plays each second of its game time (the play script's own rate). */
export const RUN_FPS = PLAY_FPS;
/** The longest a run plays and the default, in game seconds. */
export const MAX_RUN_SECONDS = 60;
export const DEFAULT_RUN_SECONDS = 5;
/** The size of a still, and where its window opens: off every screen, so it never covers the person's work. */
const STILL_SIZE = "1280x720";
const OFF_SCREEN = "-10000,-10000";
/** The most of Godot's output one job keeps, from its end. */
const OUTPUT_BYTES = 200_000;
const SCRATCH_PREFIX = "genex-godot-";
/** The private home the sandbox makes in a job's scratch folder (`runNativeProcess`). */
const HOME_FOLDER = "home";
/** How often a Windows job's record is read while it runs. */
const JOB_POLL_MS = SECOND_MS / 4;
/** Where a Windows job's folders and files outside the game wait while it runs: the project's own cache folder. */
const STAGING = [".godot", "genex-jobs"];
const INPUTS_FOLDER = "in";
/** A terminal's colour sequence, which Godot's Windows build prints into a file too. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what this removes
const COLOUR = /\x1b\[[0-9;]*m/g;

const MESSAGE = {
  Unsupported: "Genex runs Godot on a Mac and on Windows.",
  NeedsProject: "On Windows Genex runs Godot inside the game's Godot project: make one first (godot__new-game).",
  OutsideGame:
    "On Windows Genex runs Godot only on a project inside the game's folder; this game's project is linked from elsewhere.",
  NotStarted: (reason: string) => `Genex's sandbox didn't start Godot (${reason}).`,
  Lost: "Genex's sandbox lost Godot's job before it ended.",
} as const;

/** One job: Godot's arguments, the folder it runs in, what it may read and write, and its deadline. */
export type GodotCall = {
  job: GodotJob;
  args: string[];
  cwd: string;
  reads: string[];
  writes: string[];
  timeoutMs: number;
  /** A job that draws (a still) needs the GPU and a window. */
  gpu: boolean;
  /** Files written under names that only start so (a program's own temporary names), as real absolute paths. */
  writePrefixes?: string[];
  /** A Mac's: folders linked into the job's private home (`at`, relative to it), read-only: the person's export templates. */
  homeLinks?: ReadonlyArray<{ at: string; to: string }>;
  /** Windows's: files outside the game the job reads (an export template), copied in before it starts. */
  stagedInputs?: readonly string[];
};

/** What a job printed (errors first, then the rest), and how it ended. */
export type GodotResult = { output: string; timedOut: boolean; cancelled: boolean };

/**
 * What a job runs under: the call's stop, the plugin's host (a Windows job is the host's sandbox
 * job), the open game's folder, and its Godot project, where a Windows job's folders outside the
 * game wait while it runs.
 */
export type GodotJobScope = {
  signal: AbortSignal;
  host: PluginContext["host"];
  game: string | undefined;
  project: string | null;
};

/** Starts one job with a Godot binary; the scope's signal stops it. */
export type GodotRunner = (binary: string, call: GodotCall, job: GodotJobScope) => Promise<GodotResult>;

/** An import: Godot reads the project's assets and scripts into `.godot/`, which a check and a run need first. */
export function importCall(project: string): GodotCall {
  return {
    job: GodotJob.Import,
    args: ["--headless", "--path", project, "--import"],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: IMPORT_TIMEOUT_MS,
    gpu: false,
  };
}

/** A check: Genex's check script loads every script, scene and resource, so Godot names each problem. */
export function checkCall(project: string, scripts: string): GodotCall {
  return {
    job: GodotJob.Check,
    args: ["--headless", "--path", project, "-s", path.join(scripts, GodotScript.Check)],
    cwd: project,
    reads: [scripts],
    writes: [project],
    timeoutMs: CHECK_TIMEOUT_MS,
    gpu: false,
  };
}

/** A headless run of a scene (the main scene when `scene` is empty) for `seconds` of game time at a fixed frame rate. */
export function runCall(project: string, scene: string, seconds: number): GodotCall {
  return {
    job: GodotJob.Run,
    args: [
      "--headless",
      "--path",
      project,
      "--fixed-fps",
      String(RUN_FPS),
      "--quit-after",
      String(seconds * RUN_FPS),
      ...(scene ? ["--scene", scene] : []),
    ],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: RUN_START_MS + seconds * RUN_SECOND_BUDGET_MS,
    gpu: false,
  };
}

/**
 * A play of a scene (the main scene when `scene` is empty) through Genex's play script: `frames` at
 * 60 a second, `keys` pressed on their timeline, and `shots` saved as `<out>-<frame>-<n>.png`. With
 * stills it draws, in a window off every screen; without, it runs headless. `hero` lets the game's
 * own project settings move its hero shot (`genex/shot_seconds`, `genex/shot_keys`).
 */
export type PlayRequest = {
  scene: string;
  frames: number;
  keys: readonly KeyPress[];
  shots: readonly ShotAt[];
  out: string | null;
  most: number;
  hero: boolean;
};

/** The play script's arguments for a request, each one `key=value`. */
function playArgs(request: PlayRequest): string[] {
  return [
    `scene=${request.scene}`,
    `frames=${request.frames}`,
    `keys=${keysArg(request.keys)}`,
    `shots=${shotsArg(request.shots)}`,
    ...(request.out ? [`out=${request.out}`] : []),
    `most=${request.most}`,
    ...(request.hero ? ["hero=1"] : []),
  ];
}

/** A play job: drawn with stills to take, headless without. */
export function playCall(project: string, scripts: string, request: PlayRequest): GodotCall {
  const draws = request.out !== null && request.shots.length > 0;
  const window = draws ? ["--position", OFF_SCREEN, "--resolution", STILL_SIZE, "--disable-vsync"] : ["--headless"];
  const seconds = request.frames / PLAY_FPS;
  return {
    job: draws ? GodotJob.Capture : GodotJob.Play,
    args: [
      ...window,
      "--path",
      project,
      "--fixed-fps",
      String(PLAY_FPS),
      "-s",
      path.join(scripts, GodotScript.Play),
      "--",
      ...playArgs(request),
    ],
    cwd: project,
    reads: [scripts],
    writes: [project, ...(draws && request.out ? [path.dirname(request.out)] : [])],
    timeoutMs: RUN_START_MS + Math.ceil(seconds) * RUN_SECOND_BUDGET_MS,
    gpu: draws,
  };
}

/**
 * Windows's: the person's file (an export template) put at `to` in Godot's own data folder as the
 * sandbox user sees it, where an export looks for templates; that user can't read the person's.
 */
export function dataCopyCall(project: string, scripts: string, file: string, to: string): GodotCall {
  return {
    job: GodotJob.Data,
    args: [
      "--headless",
      "--path",
      project,
      "-s",
      path.join(scripts, GodotScript.Data),
      "--",
      `from=${file}`,
      `to=${to.split(path.sep).join("/")}`,
    ],
    cwd: project,
    reads: [scripts],
    writes: [project],
    stagedInputs: [file],
    timeoutMs: DATA_TIMEOUT_MS,
    gpu: false,
  };
}

/** Godot's class reference as XML (`<folder>/doc/classes/*.xml`, its modules' beside), for one version. */
export function referenceCall(folder: string): GodotCall {
  return {
    job: GodotJob.Reference,
    args: ["--headless", "--doctool", folder],
    cwd: folder,
    reads: [],
    writes: [folder],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    gpu: false,
  };
}

/** The job's home (`<scratch>/home`, as the sandbox makes it) with each link in place before Godot starts. */
async function linkIntoHome(scratch: string, links: NonNullable<GodotCall["homeLinks"]>): Promise<void> {
  for (const { at, to } of links) {
    const where = path.join(scratch, HOME_FOLDER, at);
    await mkdir(path.dirname(where), { recursive: true });
    await symlink(to, where);
  }
}

/** The runner Genex uses on this computer: a Mac's native-job sandbox, Windows's host sandbox jobs. */
export function confinedRunner(platform: NodeJS.Platform = process.platform): GodotRunner {
  if (platform === "darwin") return macRunner;
  if (platform === "win32") return windowsRunner();
  return async () => {
    throw new Error(MESSAGE.Unsupported);
  };
}

/** A Mac's: each job in the native-job sandbox, in a scratch folder removed after it. */
const macRunner: GodotRunner = async (binary, call, { signal }) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  try {
    await linkIntoHome(scratch, call.homeLinks ?? []);
    const ended = await runNativeProcess({
      binary,
      args: call.args,
      cwd: call.cwd,
      scratch,
      reads: call.reads,
      writes: call.writes,
      ...(call.writePrefixes ? { writePrefixes: call.writePrefixes } : {}),
      denyRead: [],
      gpu: call.gpu,
      signal,
      timeoutMs: call.timeoutMs,
      maxOutputBytes: OUTPUT_BYTES,
    });
    return {
      output: `${ended.stderr}\n${ended.stdout}`,
      timedOut: ended.reason === NativeEndReason.Timeout,
      cancelled: ended.reason === NativeEndReason.Cancelled,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** A folder a Windows job writes outside the game, and where it waits inside the project while the job runs. */
type Staged = { folder: string; staged: string };

/** Whether a Windows job may name `folder` as one it writes: a folder inside the game, in none of its hidden folders. */
function writableInGame(game: string, folder: string): boolean {
  if (!isBelow(game, folder)) return false;
  return !path
    .relative(game, folder)
    .split(path.sep)
    .some((part) => part.startsWith("."));
}

/**
 * A Windows job's folders: those inside the game it names as it writes them, each other one staged
 * in the project's `.godot` (the project named in their place), and each file it reads from
 * outside the game staged there too.
 */
async function windowsFolders(call: GodotCall, job: GodotJobScope) {
  if (!job.project || !job.game) throw new Error(MESSAGE.NeedsProject);
  const game = await realpath(job.game);
  const project = await realpath(job.project);
  if (!writableInGame(game, project)) throw new Error(MESSAGE.OutsideGame);
  const root = path.join(project, ...STAGING, randomUUID());
  const writes: string[] = [];
  const staged: Staged[] = [];
  for (const folder of call.writes) {
    const real = await realpath(folder).catch(() => folder);
    if (writableInGame(game, real)) writes.push(real);
    else staged.push({ folder, staged: path.join(root, String(staged.length)) });
  }
  const inputs = (call.stagedInputs ?? []).map((file, index) => ({
    folder: file,
    staged: path.join(root, INPUTS_FOLDER, String(index), path.basename(file)),
  }));
  return { root, writes: writes.length ? writes : [project], staged, inputs };
}

/** Each staged folder made, and each file read from outside the game copied in, before the job starts. */
async function stageFolders(staged: readonly Staged[], inputs: readonly Staged[]): Promise<void> {
  for (const { staged: folder } of staged) await mkdir(folder, { recursive: true });
  for (const { folder: file, staged: copy } of inputs) {
    await mkdir(path.dirname(copy), { recursive: true });
    await cp(file, copy);
  }
}

/** A text with each staged folder's path put in place of its folder's (`toStaged`), or back. */
function swapFolders(text: string, staged: readonly Staged[], toStaged: boolean): string {
  return staged.reduce(
    (swapped, { folder, staged: inProject }) =>
      toStaged ? swapped.replaceAll(folder, inProject) : swapped.replaceAll(inProject, folder),
    text,
  );
}

/** The sandbox job a Godot call is: Godot itself, reading its own folder and the call's, writing the folders named. */
function sandboxRequest(binary: string, call: GodotCall, folders: Awaited<ReturnType<typeof windowsFolders>>) {
  const reads = [...new Set([path.dirname(binary), ...call.reads])];
  const request: PluginSandboxRunArgs = {
    program: binary,
    args: call.args.map((arg) => swapFolders(arg, [...folders.inputs, ...folders.staged], true)),
    reads,
    writes: folders.writes,
    timeoutMs: call.timeoutMs,
  };
  return request;
}

/** Follows a sandbox job until it ends; a stop of the call stops it. */
async function jobEnd(job: GodotJobScope, id: string, wait: (ms: number) => Promise<unknown>) {
  let stopping = false;
  for (;;) {
    if (job.signal.aborted && !stopping) {
      stopping = true;
      await job.host(PluginService.SandboxStop, { id }).catch(() => undefined);
    }
    const record: PluginSandboxJob | null = await job.host(PluginService.SandboxResult, { id });
    if (!record) throw new Error(MESSAGE.Lost);
    if (record.state !== SandboxJobState.Running) return record;
    await wait(JOB_POLL_MS);
  }
}

/** A job's end as a Godot result: what it printed (as a Mac's lines read), staged paths named as their folders, and how it ended. */
function resultOf(record: PluginSandboxJob, staged: readonly Staged[]): GodotResult {
  if (record.state === SandboxJobState.Failed) throw new Error(MESSAGE.NotStarted(record.reason ?? ""));
  const printed = `${record.stderr ?? ""}\n${record.stdout ?? ""}`.replaceAll("\r\n", "\n").replace(COLOUR, "");
  return {
    output: swapFolders(printed.slice(-OUTPUT_BYTES), staged, false),
    timedOut: record.state === SandboxJobState.TimedOut,
    cancelled: record.state === SandboxJobState.Stopped,
  };
}

/**
 * Windows's: each job a sandbox job of the host's (ProcessSandbox, as the sandbox user), followed
 * until it ends; what it wrote in a staged folder is copied out to the folder the call named, and
 * the staged folders are removed either way. `wait` is the pause between two reads of its record.
 */
export function windowsRunner(wait: (ms: number) => Promise<unknown> = sleep): GodotRunner {
  return async (binary, call, job) => {
    job.signal.throwIfAborted();
    const folders = await windowsFolders(call, job);
    try {
      await stageFolders(folders.staged, folders.inputs);
      const { id } = await job.host(PluginService.SandboxRun, sandboxRequest(binary, call, folders));
      const result = resultOf(await jobEnd(job, id, wait), folders.staged);
      for (const { folder, staged } of folders.staged) await cp(staged, folder, { recursive: true });
      return result;
    } finally {
      await rm(folders.root, { recursive: true, force: true });
    }
  };
}
