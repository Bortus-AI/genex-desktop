/**
 * The Publish dialog's view of Genex's publish record: where the game is (not online, draft only,
 * public), the running attempt's steps, how the last one ended, and the one press the next step
 * needs. What Publish asks for first (a Genex account; the plugin may be off), what Multiplayer asks
 * for (the plugin on), whether to ask the game's chat for a Genex cover, whether Studio puts Publish
 * on the strip itself, which games get none (an Unreal game) and whether the chat's cover card
 * offers Publish are decided here too.
 * Pure, so the dialog only draws it.
 */
import {
  cleanGenexTitle,
  defaultGenexTitle,
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  GenexAction,
  GenexCoverOutcome,
  type GenexCoverRecord,
  type GenexCoverSent,
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  GenexPublishStatusOperation,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import { type PluginToolbarEntry, toolbarItems } from "../../../../shared/plugin-toolbar.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import type { FactRef, FolderHolds } from "../../../../shared/project-facts.ts";
import { publishesAsWebGame } from "../../../../shared/project-workspace.ts";
import { relativeTime } from "../../../chat-labels.ts";
import { GENEX_WORDS } from "../../../words.ts";

const WORDS = GENEX_WORDS.publish;

/** Where the game is on Genex. */
export const PublishStage = { None: "none", Draft: "draft", Public: "public" } as const;
export type PublishStage = (typeof PublishStage)[keyof typeof PublishStage];

/** A step of a publish attempt as the progress bar names it: the draft is tested before it goes live. */
export const GenexPublishStep = {
  Prepare: "prepare",
  Upload: "upload",
  Test: "test",
  Live: "live",
} as const;
export type GenexPublishStep = (typeof GenexPublishStep)[keyof typeof GenexPublishStep];

/** Which step each phase belongs to; the finished phases belong to none. */
const PHASE_STEP: Partial<Record<GenexPublishPhase, GenexPublishStep>> = {
  [GenexPublishPhase.Checking]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Exporting]: GenexPublishStep.Prepare,
  [GenexPublishPhase.CreatingProject]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Uploading]: GenexPublishStep.Upload,
  [GenexPublishPhase.VerifyingDeployment]: GenexPublishStep.Test,
  [GenexPublishPhase.Promoting]: GenexPublishStep.Live,
  [GenexPublishPhase.Listing]: GenexPublishStep.Live,
};

/** Where a step stands on the progress bar. */
export const StepState = { Done: "done", Current: "current", Next: "next" } as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

/** One step on the progress bar. */
export interface StepView {
  step: GenexPublishStep;
  label: string;
  state: StepState;
}

/** How the last attempt ended, as the dialog tells it: nothing to tell, working, done, failed, or not known yet. */
export const PublishOutcome = {
  Idle: "idle",
  Running: "running",
  Failed: "failed",
  Unresolved: "unresolved",
} as const;
export type PublishOutcome = (typeof PublishOutcome)[keyof typeof PublishOutcome];

/** A button the dialog offers: its words, the action it runs, and its aria-label (kept for smoke checks). */
export interface PublishButton {
  label: string;
  action: string;
  args?: Record<string, unknown>;
  ariaLabel: string;
}

/** Everything the dialog draws. */
export interface PublishView {
  stage: PublishStage;
  intro: string;
  outcome: PublishOutcome;
  running: boolean;
  unresolved: boolean;
  phase: string;
  startedAt: string | null;
  steps: StepView[];
  /** The game's line under its name: not online, a test version, live since…, publishing. */
  status: string;
  primary: PublishButton;
  /** Check again and allow a new upload, while an upload's outcome is unknown. */
  extra: PublishButton[];
  /** Review Genex's terms in the browser: the one press while they are not accepted. */
  terms: PublishButton | null;
  canPublish: boolean;
  /** Something the person must do first (accept Genex's terms); never a failed attempt's raw error. */
  problems: string[];
  /** A failed or unknown attempt, said calmly, and the raw detail it keeps for support. */
  failure: { title: string; text: string; details: string } | null;
  /** The link anyone can play, once the game is public. */
  link: string | null;
  /** The game has no Genex cover to send and its owner chose none: offer to ask its chat for one. */
  coverAsk: boolean;
}

export const isListed = (state: GenexPublishState): boolean => state.status === GenexHostedStatus.Published;

/** Whether an attempt is still going, including one whose upload outcome is not known yet. */
export const isLive = (job: GenexPublishJob | undefined): boolean =>
  job?.state === GenexPublishJobState.Running || job?.state === GenexPublishJobState.Unresolved;

/** The steps an attempt takes: a publish prepares, uploads, tests and goes live; a draft stops after its test. */
export function publishSteps(job: GenexPublishJob): GenexPublishStep[] {
  const steps = [GenexPublishStep.Prepare, GenexPublishStep.Upload, GenexPublishStep.Test];
  return job.kind === GenexPublishKind.Draft ? steps : [...steps, GenexPublishStep.Live];
}

/** The progress bar: the steps before the running one done, the running one current. */
function stepViews(job: GenexPublishJob | undefined, running: boolean): StepView[] {
  if (!job || !running) return [];
  const steps = publishSteps(job);
  const current = PHASE_STEP[job.phase];
  const at = current ? steps.indexOf(current) : -1;
  return steps.map((step, index) => ({
    step,
    label: WORDS.step[step],
    state: (index < at && StepState.Done) || (index === at && StepState.Current) || StepState.Next,
  }));
}

/** Where the game is: public once listed, a draft once it has a page, else not online. */
function stageOf(state: GenexPublishState): PublishStage {
  if (isListed(state)) return PublishStage.Public;
  return state.slug ? PublishStage.Draft : PublishStage.None;
}

const INTRO: Record<PublishStage, string> = {
  none: WORDS.intro,
  draft: WORDS.intro,
  public: WORDS.published,
};

/** How the record's last attempt ended, for the dialog. */
function outcomeOf(job: GenexPublishJob | undefined, running: boolean): PublishOutcome {
  if (running) return PublishOutcome.Running;
  if (job?.state === GenexPublishJobState.Unresolved) return PublishOutcome.Unresolved;
  if (job?.state === GenexPublishJobState.Failed) return PublishOutcome.Failed;
  return PublishOutcome.Idle;
}

/** The game's line under its name. */
function statusLine(state: GenexPublishState, stage: PublishStage, running: boolean, now: number): string {
  if (running) return WORDS.statusPublishing;
  if (stage === PublishStage.Public)
    return state.lastPublishAt ? WORDS.statusLive(relativeTime(state.lastPublishAt, now)) : WORDS.statusLiveUndated;
  return stage === PublishStage.Draft ? WORDS.statusDraft : WORDS.statusNone;
}

/** Check again and allow a new upload, while an upload's outcome is unknown. */
function unresolvedButtons(job: GenexPublishJob | undefined): PublishButton[] {
  if (job?.phase !== GenexPublishPhase.Unresolved) return [];
  return [
    {
      label: WORDS.checkAgain,
      action: GenexAction.PublishStatus,
      args: { operation: GenexPublishStatusOperation.Check },
      ariaLabel: "Check deployment availability without uploading",
    },
    {
      label: WORDS.allowUpload,
      action: GenexAction.PublishAllowUpload,
      args: { jobId: job.id },
      ariaLabel: "Allow a new upload after checking the deployment page",
    },
  ];
}

/** A failed or unknown attempt in plain words; the raw error and check stay as details for support. */
function failureOf(outcome: PublishOutcome, state: GenexPublishState, job: GenexPublishJob | undefined) {
  const details = [job?.error ?? state.lastError, job?.checkError].filter(Boolean).join("\n");
  if (outcome === PublishOutcome.Unresolved)
    return { title: WORDS.unresolvedTitle, text: WORDS.unresolvedText, details };
  if (outcome !== PublishOutcome.Failed) return null;
  return { title: WORDS.failedTitle, text: isListed(state) ? WORDS.failedKept : WORDS.failedText, details };
}

/** Answers that mean the owner chose the game's cover on genex.games: that choice stands, so nobody asks for another. */
const OWNER_CHOSE = new Set<GenexCoverOutcome>([GenexCoverOutcome.KeptOwner, GenexCoverOutcome.Outranked]);

/** Whether the last send found the owner's own cover, then or when these bytes were first sent. */
function ownerChose(last: GenexCoverSent | null): boolean {
  if (!last) return false;
  return [last.kind, last.settled].some((kind) => kind !== undefined && OWNER_CHOSE.has(kind));
}

/**
 * Whether the dialog offers to ask the game's chat for a Genex cover: the plugin reports its cover
 * (an older one does not), no shot is kept to send, none is being sent, no publish is running (it
 * shoots the cover itself), and the owner chose none on genex.games.
 */
export function coverAsk(state: GenexPublishState): boolean {
  const cover = state.cover;
  if (!cover || cover.shot) return false;
  if (cover.sending || isLive(state.job)) return false;
  return !ownerChose(cover.last);
}

/** The dialog's view of a publish record, at `now`. */
export function publishView(state: GenexPublishState, now = Date.now()): PublishView {
  const job = state.job;
  const live = isLive(job);
  const unresolved = job?.phase === GenexPublishPhase.Unresolved;
  const running = live && !unresolved;
  const stage = stageOf(state);
  const listed = stage === PublishStage.Public;
  const outcome = outcomeOf(job, running);
  const failed = outcome === PublishOutcome.Failed;
  return {
    stage,
    intro: INTRO[stage],
    outcome,
    running,
    unresolved,
    phase: job && running ? WORDS.phase[job.phase] : "",
    startedAt: running && job ? job.startedAt : null,
    steps: stepViews(job, running),
    status: statusLine(state, stage, running, now),
    primary: {
      label: (failed && WORDS.tryAgain) || (listed && WORDS.updatePublic) || WORDS.publish,
      action: GenexAction.PublishGallery,
      ariaLabel: "Publish this game on Genex",
    },
    extra: unresolvedButtons(job),
    terms:
      state.terms?.accepted === false
        ? { label: WORDS.reviewTerms, action: GenexAction.Terms, ariaLabel: WORDS.reviewTerms }
        : null,
    canPublish: state.connected && !live,
    problems: state.terms?.accepted === false ? [WORDS.termsNote] : [],
    failure: failureOf(outcome, state, job),
    link: listed ? (state.galleryUrl ?? null) : null,
    coverAsk: coverAsk(state),
  };
}

/** The name the dialog offers: the one the game is listed under, else Studio's title for it, else its folder. */
export function offeredTitle(state: GenexPublishState | null, gameTitle: string | undefined, project: string): string {
  return state?.title ?? cleanGenexTitle(gameTitle) ?? defaultGenexTitle(project);
}

/** What Publish asks for before it can publish: a Genex account, or nothing. */
export const PublishGate = { SignIn: "sign-in", Ready: "ready" } as const;
export type PublishGate = (typeof PublishGate)[keyof typeof PublishGate];

/**
 * What stands between the person and Publish: only a Genex account. Publish is the account's, so
 * the Genex plugin being off asks nothing; a Genex that is missing or removed is brought back by
 * signing in. A record not read yet asks for nothing.
 */
export function publishGate(
  genex: Pick<PluginInfo, "enabled" | "removed"> | undefined,
  connected: boolean | undefined,
): PublishGate {
  if (!genex || genex.removed) return PublishGate.SignIn;
  return connected === false ? PublishGate.SignIn : PublishGate.Ready;
}

/** What Multiplayer asks for while the Genex plugin is not on: installed, then turned on. */
export const GenexSetup = { Install: "install", TurnOn: "turn-on" } as const;
export type GenexSetup = (typeof GenexSetup)[keyof typeof GenexSetup];

/** Install a missing or removed Genex, else turn it on. */
export const genexSetup = (genex: Pick<PluginInfo, "enabled" | "removed"> | undefined): GenexSetup =>
  !genex || genex.removed ? GenexSetup.Install : GenexSetup.TurnOn;

/** Whether a stage-strip button is Genex's Publish. */
export const isGenexPublish = (entry: PluginToolbarEntry): boolean =>
  entry.plugin.manifest.id === GENEX_PLUGIN_ID &&
  entry.item.target.kind === "panel" &&
  entry.item.target.id === GENEX_PUBLISH_PANEL;

/**
 * Whether Publish can put a game holding these facts (and, with none, `holds`) on Genex. Publish uploads the game folder as a
 * web game, so only a game served as one at its root, or with its web game in a folder of it (an
 * engine's web export), has Publish; an Unreal game's folder holds an
 * Unreal project and no web build, and any other kind of project none either. The host refuses the
 * same games (`main/core/genex-publish.ts`).
 */
const publishable = (facts: readonly FactRef[], holds: FolderHolds | undefined): boolean =>
  publishesAsWebGame({ facts, holds });

/** Whether a plugin is the Genex plugin, installed but switched off. */
const isGenexOff = (plugin: PluginInfo): boolean =>
  plugin.manifest.id === GENEX_PLUGIN_ID && !plugin.enabled && !plugin.removed && !plugin.unlisted;

/**
 * Each plugin's buttons in list order: an enabled plugin's all, and an off Genex's Publish alone,
 * since Publish belongs to the account and not to the agent's tools.
 */
function toolbarEntries(plugins: readonly PluginInfo[], project: string | null): PluginToolbarEntry[] {
  return plugins.flatMap((plugin) => {
    if (!isGenexOff(plugin)) return toolbarItems([plugin], project);
    if (!project) return [];
    return (plugin.manifest.toolbar ?? [])
      .map((item) => ({ key: `${plugin.manifest.id}:${item.id}`, plugin, item }))
      .filter(isGenexPublish);
  });
}

/**
 * The plugin buttons on the open game's stage strip: every enabled plugin's and Genex's Publish, on
 * or off, less that Publish for a game it can't put online (`publishable`).
 */
export function stripEntries(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): PluginToolbarEntry[] {
  const entries = toolbarEntries(plugins, project);
  return publishable(facts, holds) ? entries : entries.filter((entry) => !isGenexPublish(entry));
}

/**
 * Whether Studio puts Publish on the strip itself: a web game is open and no Genex is installed to
 * add its own (signing in from it brings Genex back).
 */
export function studioPublishButton(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): boolean {
  return Boolean(project) && publishable(facts, holds) && !toolbarEntries(plugins, project).some(isGenexPublish);
}

/**
 * Answers that leave nothing for a publish to do about a frame: Genex took it, already had it, or
 * the owner's own pick stands over it. A failed send or no hosted project is retried by the next
 * publish, and a refused frame is replaced by the shot it takes.
 */
const FRAME_ANSWERED = new Set<GenexCoverOutcome>([
  GenexCoverOutcome.Applied,
  GenexCoverOutcome.Unchanged,
  GenexCoverOutcome.Outranked,
  GenexCoverOutcome.KeptOwner,
]);

/** Whether Genex has answered for the kept frame itself, then or when these bytes were first sent. */
function keptFrameAnswered(cover: GenexCoverRecord | undefined): boolean {
  const shot = cover?.shot;
  const last = cover?.last;
  if (!shot || last?.sha256 !== shot.sha256) return false;
  return FRAME_ANSWERED.has(last.settled ?? last.kind);
}

/**
 * Whether the chat's Genex cover card offers Publish: Genex's own Publish is on the strip (Genex
 * installed, on or off), no publish of this game runs, and Genex has not yet answered for the kept
 * frame (a publish re-shoots and sends it, so once one has, the cover's next step is done). A
 * record not read yet hides nothing.
 */
export function coverCardPublish(
  plugins: readonly PluginInfo[],
  project: string | null,
  state: GenexPublishState | null,
): boolean {
  if (!project || !toolbarEntries(plugins, project).some(isGenexPublish)) return false;
  return !isLive(state?.job) && !keptFrameAnswered(state?.cover);
}
