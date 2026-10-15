/**
 * The Unity setup card a game's chat shows while this computer can't make Unity games yet: Unity
 * Hub, a signed-in Unity account with its license, and a Unity 6 editor. Its rows are read live,
 * so a step done in Hub itself is ticked without being told, and while Genex installs Hub or Unity
 * for the person the row says how far it got. Signing in is the one step only the person can do.
 * Reading the card only looks: which apps and license files exist, and the install under way.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { type EditorsEnv, findEditors, findHub, type UnityEditor } from "./editors.ts";
import { newestUnity6 } from "./readiness.ts";

/** Each row's id on the card. Wire values: the chat keys its rows by them. */
export const SetupStepId = { GetHub: "get-hub", SignIn: "sign-in", InstallUnity: "install-unity" } as const;
export type SetupStepId = (typeof SetupStepId)[keyof typeof SetupStepId];

/** The plugin actions the card's buttons run. Wire values: the manifest declares them. */
export const SetupAction = {
  Steps: "steps",
  GetHub: "get-hub",
  OpenHub: "open-hub",
  InstallUnity: "install-unity",
  SetUp: "set-up",
} as const;
export type SetupAction = (typeof SetupAction)[keyof typeof SetupAction];

/** What Genex is installing for the person: Unity Hub, or a Unity editor through Hub. Wire values. */
export const JobKind = { Hub: "hub", Editor: "editor" } as const;
export type JobKind = (typeof JobKind)[keyof typeof JobKind];

/** Where an install stands. Wire values: kept in the plugin's storage. */
export const JobState = { Running: "running", Failed: "failed" } as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

/** An install Genex started for the person: what, how far (bytes or percent), or why it stopped. */
export interface InstallJob {
  kind: JobKind;
  state: JobState;
  /** The Unity version an editor install installs. */
  version?: string;
  done?: number;
  total?: number;
  percent?: number;
  /** Why it stopped, in the person's words. */
  why?: string;
}

/** What the card reads about this computer. */
export interface SetupFacts {
  hub: string | undefined;
  /** Unity's license is on this computer, which signing in to Hub adds. */
  signedIn: boolean;
  /** The newest Unity 6 installed, the one new games are made with. */
  editor: UnityEditor | undefined;
  /** The install under way, or the last one that stopped. */
  job: InstallJob | null;
}

/** A row's button: the plugin action it runs and its label. */
type Button = { name: SetupAction; args: Record<string, string>; label: string };
/** One row as the chat's steps card reads it (`renderer/chat/engine-steps.ts`). */
export type SetupRow = {
  id: SetupStepId;
  label: string;
  detail: string;
  done: boolean;
  you?: true;
  action?: Button;
};
/** The card as the chat reads it. */
export type SetupCard = {
  title: string;
  intro: string;
  open: boolean;
  steps: SetupRow[];
  primary?: Button;
  doneSays?: string;
};

/** About how much room a Unity 6 editor takes once installed. */
export const UNITY_SIZE_GB = 12;
const MEGABYTE = 1024 * 1024;

/** How the intro counts the open steps: in words up to three, which is all the card ever holds. */
const COUNT_WORDS = ["", "One step", "Two steps", "Three steps"] as const;

const WORDS = {
  Title: "Unity setup",
  Intro: (open: number) => `${COUNT_WORDS[open] ?? `${open} steps`} before the agent can build in Unity.`,
  Working: "Genex is doing this. You'll only be asked to sign in.",
  GetHub: "Get Unity Hub",
  GetHubDetail: "Unity's free app that installs Unity.",
  HubReady: "Unity Hub is installed",
  Download: "Download",
  DownloadingHub: "Downloading Unity Hub",
  InstallingHub: "Installing Unity Hub",
  Megabytes: (done: number, total: number) => `${Math.round(done / MEGABYTE)} of ${Math.round(total / MEGABYTE)} MB`,
  SignIn: "Sign in to Unity",
  SignInDetail: "In Unity Hub, sign in and add the free Personal license. Only you type your password.",
  SignedIn: "Signed in to Unity",
  OpenHub: "Open Unity Hub",
  InstallUnity: "Install Unity 6",
  InstallDetail: `About ${UNITY_SIZE_GB} GB. Genex installs it through Unity Hub.`,
  Install: "Install",
  Installing: (version: string) => `Installing Unity ${version}`,
  Percent: (percent: number) => `${Math.round(percent)}%`,
  Starting: "Starting…",
  Installed: (version: string) => `Unity ${version} is installed`,
  TryAgain: "Try again",
  DoItForMe: "Do it for me",
  Done: (version: string) =>
    `Unity ${version} is installed on this Mac and the person is signed in. Go on with their game in Unity: call unity__new-game if it has no Unity project yet.`,
} as const;

const button = (name: SetupAction, label: string): Button => ({ name, args: {}, label });

/** How far a running install got, in one line. */
function progressOf(job: InstallJob): string {
  if (job.done !== undefined && job.total) return WORDS.Megabytes(job.done, job.total);
  if (job.percent !== undefined) return WORDS.Percent(job.percent);
  return WORDS.Starting;
}

/** The job of one kind, when it is the current one. */
const jobOf = (facts: SetupFacts, kind: JobKind): InstallJob | undefined =>
  facts.job?.kind === kind ? facts.job : undefined;

/** Unity Hub's row: installed, being installed, stopped, or to get. */
function hubRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.GetHub;
  if (facts.hub) return { id, label: WORDS.HubReady, detail: "", done: true };
  const job = jobOf(facts, JobKind.Hub);
  if (job?.state === JobState.Running) {
    const downloading = job.total !== undefined && (job.done ?? 0) < job.total;
    const label = downloading ? WORDS.DownloadingHub : WORDS.InstallingHub;
    return { id, label, detail: downloading ? progressOf(job) : "", done: false };
  }
  if (job?.state === JobState.Failed)
    return {
      id,
      label: WORDS.GetHub,
      detail: job.why ?? "",
      done: false,
      you: true,
      action: button(SetupAction.GetHub, WORDS.TryAgain),
    };
  return {
    id,
    label: WORDS.GetHub,
    detail: WORDS.GetHubDetail,
    done: false,
    action: button(SetupAction.GetHub, WORDS.Download),
  };
}

/** Signing in: the person's own step, which Hub can't be opened for until it is installed. */
function signInRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.SignIn;
  if (facts.signedIn) return { id, label: WORDS.SignedIn, detail: "", done: true };
  const open = facts.hub ? { action: button(SetupAction.OpenHub, WORDS.OpenHub) } : {};
  return { id, label: WORDS.SignIn, detail: WORDS.SignInDetail, done: false, you: true, ...open };
}

/** The editor's row: installed, being installed, stopped, or to install once Hub is there. */
function editorRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.InstallUnity;
  if (facts.editor) return { id, label: WORDS.Installed(facts.editor.version), detail: "", done: true };
  const job = jobOf(facts, JobKind.Editor);
  const version = job?.version ?? "6";
  if (job?.state === JobState.Running)
    return { id, label: WORDS.Installing(version), detail: progressOf(job), done: false };
  const action = facts.hub ? { action: button(SetupAction.InstallUnity, job ? WORDS.TryAgain : WORDS.Install) } : {};
  if (job?.state === JobState.Failed)
    return { id, label: WORDS.InstallUnity, detail: job.why ?? "", done: false, you: true, ...action };
  return { id, label: WORDS.InstallUnity, detail: WORDS.InstallDetail, done: false, ...action };
}

/**
 * The card for where this computer stands: three rows, the intro counting what is left (or saying
 * Genex is at it), Do it for me while nothing runs, and what the agent hears once all is done.
 */
export function setupCard(facts: SetupFacts): SetupCard {
  const steps = [hubRow(facts), signInRow(facts), editorRow(facts)];
  const left = steps.filter((row) => !row.done).length;
  const running = facts.job?.state === JobState.Running;
  const doneSays = facts.editor ? { doneSays: WORDS.Done(facts.editor.version) } : {};
  return {
    title: WORDS.Title,
    intro: running ? WORDS.Working : WORDS.Intro(left),
    open: left > 0,
    steps,
    ...(left > 0 && !running ? { primary: button(SetupAction.SetUp, WORDS.DoItForMe) } : {}),
    ...doneSays,
  };
}

/** The license files signing in to Hub leaves on a Mac (or Windows): the account's, and an older machine-wide one. */
export function licenseFiles(env: EditorsEnv): string[] {
  if (env.platform === "win32")
    return [
      path.win32.join(env.home, "AppData", "Local", "Unity", "licenses", "UnityEntitlementLicense.xml"),
      path.win32.join(path.win32.parse(env.applications).root, "ProgramData", "Unity", "Unity_lic.ulf"),
    ];
  // Applications and Library sit side by side: /Applications beside /Library.
  const machine = path.posix.join(path.posix.dirname(env.applications), "Library", "Application Support", "Unity");
  return [
    path.posix.join(env.home, "Library", "Unity", "licenses", "UnityEntitlementLicense.xml"),
    path.posix.join(machine, "Unity_lic.ulf"),
  ];
}

/** Whether Unity's license is on this computer: one of its files exists. Its contents are never read. */
export async function hasLicense(env: EditorsEnv): Promise<boolean> {
  for (const file of licenseFiles(env)) if ((await stat(file).catch(() => null))?.isFile()) return true;
  return false;
}

/** What the card reads now, with the install the backend has under way. */
export async function readFacts(env: EditorsEnv, job: InstallJob | null): Promise<SetupFacts> {
  const [hub, signedIn, editors] = await Promise.all([findHub(env), hasLicense(env), findEditors(env)]);
  return { hub, signedIn, editor: newestUnity6(editors), job };
}
