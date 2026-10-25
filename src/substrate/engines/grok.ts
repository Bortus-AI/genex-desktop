import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../fsx.ts";
import { cliVersion, requireCodingCli, resolveCodingCli, invalidateCodingCli } from "./external-cli.ts";
import { credentialHomes } from "../credential-homes.ts";
import { bridgeTools } from "./codex.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { StudioBridge } from "./studio-bridge.ts";
import { lockUnowned, releaseLocks, releaseStaleLocks, ownershipBriefing, type LockRecord } from "./ownership-locks.ts";
import { CHECKPOINT_TOOL, intakeToolReply, StudioTool } from "./studio-tool-prompts.ts";
import {
  grokArgv,
  grokDenyArgs,
  grokEffortArgs,
  grokEnv,
  grokFailureKind,
  GROK_API_KEY,
  GROK_AUTH_FILE,
  GROK_DEFAULT_EFFORT,
  GROK_EFFORTS,
  GROK_47_CONTEXT,
  GROK_JUDGE_TOOLS,
  GROK_STREAM_FORMAT,
  GROK_STUDIO_MARKER,
  GrokModelId,
  GrokSandbox,
  GrokStop,
  streamGrok,
  translateGrokEvent,
  type GrokExec,
} from "./grok-cli.ts";
import {
  abortControllerFor,
  CHECKPOINT_NOTE_CHARS,
  COMPLETE_TIMEOUT_MS,
  CompletionStop,
  interruption,
  partialDelegateResult,
  STOPPED_BY_USER,
  type PartialDelegateState,
} from "./common.ts";
import {
  DelegateEventType,
  EngineError,
  ModelContextSource,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  type EngineAccount,
  type EngineModel,
  type EngineStatus,
  type LiveToolResult,
} from "./types.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { EngineId } from "../../shared/providers.ts";
import { EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import type { Usage } from "../types.ts";

/**
 * Delegated engine for Grok Build. The studio spawns the external `grok` CLI, which keeps its own
 * login in `GROK_HOME` (`~/.grok` by default) and its own `XAI_API_KEY`. Headless runs use
 * `--prompt-file` and `--output-format streaming-json`. Studio tools go through the same bridge
 * Codex uses: the CLI has no per-invocation MCP config that stays out of the user's own files.
 */

const AUTH_CACHE_MS = 15 * SECOND_MS;

const MESSAGE = {
  login: "Sign in to Grok Build, or set XAI_API_KEY.",
  install: "Install Grok Build, then check again.",
  missing: "Grok Build isn't installed.",
  isolated: "Grok Build connected for this studio",
  system: "Using your existing Grok Build sign-in on this Mac",
  apiKey: "Using XAI_API_KEY",
  homeEnv: "Using GROK_HOME",
  signedOut: "Grok Build isn't signed in.",
  noTools: "Grok Build answers a judge with one headless prompt; use delegate to build.",
  cliMissing: "Grok Build isn't installed. Install it, then check again.",
} as const;

export interface GrokLogin {
  source: LoginSource;
  home: string | null;
}

export interface GrokEngineOptions {
  engineHome: string;
  systemHome?: string;
  model?: string;
  protectedPaths?: string[];
  executable?: string;
  resolveCli?: typeof resolveCodingCli;
  execFn?: GrokExec;
}

interface GrokJob {
  cwd: string;
  scratch: string | null;
  runDir: string;
  locks: LockRecord | null;
  login: GrokLogin & { variable?: string };
  model: string | undefined;
  billing: "api" | "subscription";
  run: GrokRun;
  bridge: StudioBridge | null;
  controller: AbortController;
  startedAt: number;
  stopped: () => boolean;
  partial: () => PartialDelegateState;
  close: () => Promise<void>;
}

interface GrokRun {
  summary: string;
  usage: Usage;
  turns: number;
  sessionId?: string;
  modelUsed?: string;
  failure?: string;
  stopReason?: string;
  completed: boolean;
  cliPath?: string;
  cliVersion?: string;
  deadlineHit: boolean;
}

/** One Grok Build installation: status, device-code or API-key sign-in, and headless sessions. */
export class GrokEngine implements Engine {
  readonly id = EngineId.Grok;
  readonly label = "Grok Build";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  readonly engineHome: string;
  readonly systemHome: string;
  #model?: string;
  #protected: string[];
  #executable?: string;
  #resolveCli: typeof resolveCodingCli;
  #execFn?: GrokExec;
  #authFailure: string | null = null;
  #authCache: { at: number; status: EngineStatus } | null = null;
  #lockRecovery: string;

  constructor(options: GrokEngineOptions) {
    this.engineHome = options.engineHome;
    this.systemHome = options.systemHome ?? path.join(os.homedir(), ".grok");
    this.#model = options.model;
    this.#protected = options.protectedPaths ?? [];
    this.#executable = options.executable;
    this.#resolveCli = options.resolveCli ?? resolveCodingCli;
    this.#execFn = options.execFn;
    this.#lockRecovery = path.join(path.dirname(this.engineHome), "ownership-locks");
  }

  async account(): Promise<EngineAccount> {
    const found = await this.#resolveCli(EngineId.Grok, this.#executable).catch(() => null);
    const login = await this.resolveLogin();
    const version = cliVersion(found?.status.version);
    return {
      source: login.source,
      ...(login.source === LoginSource.Env ? { variable: login.variable } : {}),
      afterSignOut: "signed-out",
      cli: {
        state: found?.status.state ?? CodingCliState.Missing,
        ...(found?.status.path ? { path: found.status.path } : {}),
        ...(version ? { version } : {}),
      },
    };
  }

  /**
   * Which login a session uses. An in-app sign-in writes {@link GROK_STUDIO_MARKER} and then
   * stays on that home, signed out, instead of falling through to `~/.grok` or an API key.
   * Otherwise a session file beats `XAI_API_KEY`, which is the order the authentication guide gives.
   */
  async resolveLogin(): Promise<GrokLogin & { variable?: string }> {
    if (await pathExists(path.join(this.engineHome, GROK_STUDIO_MARKER)))
      return { source: LoginSource.Isolated, home: this.engineHome };
    const fromEnv = process.env.GROK_HOME;
    if (fromEnv) return { source: LoginSource.Env, home: fromEnv, variable: "GROK_HOME" };
    if (await signedIn(this.engineHome)) return { source: LoginSource.Isolated, home: this.engineHome };
    if (await signedIn(this.systemHome)) return { source: LoginSource.System, home: this.systemHome };
    if (process.env[GROK_API_KEY]?.trim()) return { source: LoginSource.Env, home: null, variable: GROK_API_KEY };
    return { source: LoginSource.None, home: null };
  }

  async status(): Promise<EngineStatus> {
    if (this.#authFailure)
      return { code: EngineStatusCode.NeedsLogin, detail: this.#authFailure, remedy: MESSAGE.login };
    if (this.#authCache && Date.now() - this.#authCache.at < AUTH_CACHE_MS) return this.#authCache.status;
    const status = await this.#readStatus();
    this.#authCache = { at: Date.now(), status };
    return status;
  }

  async recheckLogin(): Promise<EngineStatus> {
    invalidateCodingCli(EngineId.Grok);
    this.#authFailure = null;
    this.#authCache = null;
    return this.status();
  }

  async models(): Promise<EngineModel[]> {
    return [grokModel(GrokModelId.Build, "Grok Build", true), grokModel(GrokModelId.Grok47, "Grok 4.7", false)];
  }

  async defaultModel(): Promise<string> {
    return this.#model ?? GrokModelId.Build;
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    if (request.tools?.length) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.noTools);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "studio-grok-judge-"));
    const controller = abortControllerFor(request.signal);
    let ceilingHit = false;
    const ceiling = setTimeout(() => {
      ceilingHit = true;
      controller.abort();
    }, request.timeoutMs ?? COMPLETE_TIMEOUT_MS);
    const run = emptyRun(this.id);
    try {
      const images = await writeImages(
        cwd,
        request.messages.flatMap((message) => message.images ?? []),
      );
      const prompt = judgePrompt(request, images);
      const keepReads = images.length > 0;
      await this.#consume(request, run, {
        cwd,
        prompt,
        signal: controller.signal,
        argv: judgeArgv(request.model ?? this.#model, request.effort, keepReads),
      });
    } catch (err) {
      throw this.#judgeFailure(err, request, ceilingHit, run);
    } finally {
      clearTimeout(ceiling);
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
    if (run.failure) throw this.#classify(run.failure);
    return {
      message: { role: "assistant", content: run.summary },
      usage: run.usage,
      stopReason: CompletionStop.Stop,
      model: run.modelUsed ?? request.model ?? GrokModelId.Build,
      engine: this.id,
    };
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    const job = await this.#open(request);
    try {
      return await this.#run(request, job);
    } catch (err) {
      if (job.stopped()) return stoppedResult(this.id, request, job.partial());
      throw this.#failed(err, job.run);
    } finally {
      await job.close();
    }
  }

  async #open(request: DelegateRequest): Promise<GrokJob> {
    const startedAt = Date.now();
    const cwd = path.resolve(request.cwd);
    const model = requestedModel(request.model ?? this.#model);
    const controller = abortControllerFor(request.signal);
    const run = emptyRun(this.id, request.resume);
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const locks = request.ownership
      ? await lockUnowned(cwd, request.ownership, this.#lockRecovery).catch(() => null)
      : null;
    const scratch = startsElsewhere(request) ? await mkdtemp(path.join(os.tmpdir(), "studio-grok-read-")) : null;
    const login = await this.resolveLogin();
    const billing = login.variable === GROK_API_KEY ? "api" : "subscription";
    const deadline = armDeadline(request, run, controller);
    const job: GrokJob = {
      cwd,
      scratch,
      runDir: scratch ?? cwd,
      locks,
      login,
      model,
      billing,
      run,
      bridge: null,
      controller,
      startedAt,
      stopped: () => Boolean(request.signal?.aborted || run.deadlineHit),
      partial: () => partialState(run, { startedAt, model, billing }, job.bridge, request),
      close: async () => {
        if (deadline) clearTimeout(deadline);
        await job.bridge?.close().catch(() => {});
        await releaseLocks(cwd, locks, this.#lockRecovery).catch(() => {});
        if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      },
    };
    return job;
  }

  async #run(request: DelegateRequest, job: GrokJob): Promise<DelegateResult> {
    job.bridge = await openBridge(request, job.runDir, (name, args) => this.#bridgeCall(name, args, request));
    const prompt = await this.#prompt(request, {
      cwd: job.cwd,
      scratch: job.scratch,
      locks: job.locks,
      bridge: job.bridge,
      login: job.login,
    });
    await this.#consume(request, job.run, {
      cwd: job.runDir,
      prompt,
      signal: job.controller.signal,
      argv: delegateArgv(request, job.model, job.runDir, job.login),
    });
    return this.#result(request, job);
  }

  #result(request: DelegateRequest, job: GrokJob): DelegateResult {
    if (job.stopped()) return stoppedResult(this.id, request, job.partial());
    if (job.run.failure && job.run.stopReason !== GrokStop.MaxTokens) return this.#outcome(job.run, job.partial);
    this.#authFailure = null;
    return doneResult(
      this.id,
      job.run,
      { startedAt: job.startedAt, model: job.model, billing: job.billing },
      recordedCalls(job.bridge, request),
    );
  }

  async #readStatus(): Promise<EngineStatus> {
    const installation = await this.#resolveCli(EngineId.Grok, this.#executable);
    if (installation.status.state === CodingCliState.Missing)
      return {
        code: EngineStatusCode.NotInstalled,
        detail: installation.status.detail || MESSAGE.missing,
        remedy: MESSAGE.install,
      };
    if (installation.status.state !== CodingCliState.Ready)
      return { code: EngineStatusCode.Error, detail: installation.status.detail };
    const login = await this.resolveLogin();
    if (await loginReady(login)) {
      this.#authFailure = null;
      return { code: EngineStatusCode.Ready, detail: loginDetail(login) };
    }
    return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.signedOut, remedy: MESSAGE.login };
  }

  async #prompt(
    request: DelegateRequest,
    ctx: {
      cwd: string;
      scratch: string | null;
      locks: LockRecord | null;
      bridge: StudioBridge | null;
      login: GrokLogin;
    },
  ): Promise<string> {
    const offLimits = [
      ...this.#protected,
      ...credentialHomes(ctx.login.source === LoginSource.Isolated ? [] : [ctx.login.home]),
      ...(request.denyReads ?? []),
    ];
    const seam = request.ownership && (request.ownership.owns.length || ctx.locks?.files.length);
    const plan = chatMode(request) === PermissionMode.Plan ? ctx.scratch : null;
    return [
      request.prompt,
      ctx.bridge?.instructions() ?? "",
      seam && request.ownership ? ownershipBriefing(request.ownership) : "",
      plan
        ? planModeNote(ctx.cwd, plan)
        : readOnlyNote(ctx.cwd, ctx.scratch, request.director ? path.resolve(request.director.root) : null),
      offLimitsNote(offLimits),
    ]
      .filter((part) => part.trim())
      .join("\n\n");
  }

  async #consume(
    request: { onEvent?: DelegateRequest["onEvent"]; onDelta?: CompleteRequest["onDelta"] },
    run: GrokRun,
    stream: { cwd: string; prompt: string; signal: AbortSignal; argv: string[] },
  ): Promise<void> {
    const login = await this.resolveLogin();
    const installation = this.#execFn ? null : await requireCodingCli(EngineId.Grok, this.#executable, stream.signal);
    const env = sessionEnv(login, installation?.env);
    run.cliPath = installation?.status.path;
    run.cliVersion = cliVersion(installation?.status.version);
    const events = await openStream(this.#execFn, installation?.status.path, {
      argv: grokArgv(stream.argv, installation?.status.acceptedFlags),
      cwd: stream.cwd,
      env,
      prompt: stream.prompt,
      signal: stream.signal,
      onStderr: (chunk) => request.onEvent?.({ type: DelegateEventType.Stderr, payload: chunk }),
    });
    for await (const event of events) applyEvent(event, run, request);
  }

  #bridgeCall(name: string, args: Record<string, unknown>, request: DelegateRequest): Promise<LiveToolResult> {
    if (name === StudioTool.Checkpoint) {
      const note = String(args.note ?? "").slice(0, CHECKPOINT_NOTE_CHARS);
      request.onEvent?.({ type: DelegateEventType.Checkpoint, payload: { note } });
      return Promise.resolve(CHECKPOINT_TOOL.reply);
    }
    if (name === StudioTool.Capture && request.onCapture)
      return request.onCapture({ ...(args.cameras ? { cameras: String(args.cameras) } : {}) });
    if (request.onLiveTool && (request.liveTools ?? []).some((tool) => tool.name === name))
      return request.onLiveTool(name, args);
    if ((request.interviewTools ?? []).some((tool) => tool.name === name))
      return Promise.resolve(intakeToolReply(name));
    return Promise.resolve(`the studio has no tool called '${name}' in this session`);
  }

  #classify(text: string): EngineError {
    const kind = grokFailureKind(text);
    if (kind === "auth") {
      this.#authFailure = text;
      return new EngineError(EngineFailureKind.Auth, this.id, `${text} — ${MESSAGE.login}`);
    }
    if (kind === "usage_limit") return new EngineError(EngineFailureKind.UsageLimit, this.id, text);
    if (kind === "rate_limit") return new EngineError(EngineFailureKind.RateLimit, this.id, text);
    if (/ENOENT|not found/i.test(text))
      return new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.cliMissing);
    return new EngineError(EngineFailureKind.Other, this.id, text);
  }

  #failed(err: unknown, run: GrokRun): EngineError {
    const text = [run.failure, err instanceof Error ? err.message : String(err)].filter(Boolean).join("\n");
    return this.#classify(text || MESSAGE.missing);
  }

  #outcome(run: GrokRun, partial: () => PartialDelegateState): DelegateResult {
    const classified = this.#classify(run.failure ?? "");
    if (classified.kind !== EngineFailureKind.Other) throw classified;
    const stopReason = run.stopReason === GrokStop.MaxTurns ? StopReason.MaxTurns : StopReason.Error;
    return partialDelegateResult(this.id, { stopReason, errorText: run.failure ?? "" }, partial());
  }

  #judgeFailure(err: unknown, request: CompleteRequest, ceilingHit: boolean, run: GrokRun): EngineError {
    if (request.signal?.aborted) return new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
    if (ceilingHit) {
      const minutes = Math.round((request.timeoutMs ?? COMPLETE_TIMEOUT_MS) / MINUTE_MS);
      return new EngineError(EngineFailureKind.Timeout, this.id, `the judge did not answer within ${minutes} min`);
    }
    return this.#failed(err, run);
  }
}

async function signedIn(home: string): Promise<boolean> {
  return pathExists(path.join(home, GROK_AUTH_FILE));
}

/** Ready when the selected home has a session file, or the login is the API key itself. */
async function loginReady(login: GrokLogin & { variable?: string }): Promise<boolean> {
  if (login.variable === GROK_API_KEY) return true;
  if (login.home && (await signedIn(login.home))) return true;
  return login.variable === "GROK_HOME" && Boolean(process.env[GROK_API_KEY]?.trim());
}

function loginDetail(login: GrokLogin & { variable?: string }): string {
  if (login.variable === GROK_API_KEY) return MESSAGE.apiKey;
  if (login.variable === "GROK_HOME") return MESSAGE.homeEnv;
  if (login.source === LoginSource.Isolated) return MESSAGE.isolated;
  return MESSAGE.system;
}

function grokModel(id: string, label: string, providerDefault: boolean): EngineModel {
  return {
    id,
    label,
    providerDefault,
    contextWindow: GROK_47_CONTEXT,
    contextSource: id === GrokModelId.Grok47 ? ModelContextSource.Catalog : ModelContextSource.Unknown,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: true,
    efforts: [...GROK_EFFORTS],
    defaultEffort: GROK_DEFAULT_EFFORT,
  };
}

function requestedModel(model: string | undefined): string | undefined {
  if (!model || model === "default") return undefined;
  return model;
}

function emptyRun(engine: string, resume?: string): GrokRun {
  return {
    summary: "",
    usage: { engine },
    turns: 0,
    completed: false,
    deadlineHit: false,
    ...(resume ? { sessionId: resume } : {}),
  };
}

function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Grok, request.permissions.mode) : null;
}

function startsElsewhere(request: DelegateRequest): boolean {
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan;
}

function sessionEnv(login: GrokLogin & { variable?: string }, base?: NodeJS.ProcessEnv): Record<string, string> {
  const keepKey = login.variable === GROK_API_KEY || login.source === LoginSource.System;
  return grokEnv({ ...base, ...(login.home ? { GROK_HOME: login.home } : {}) }, keepKey);
}

function armDeadline(
  request: DelegateRequest,
  run: GrokRun,
  controller: AbortController,
): ReturnType<typeof setTimeout> | null {
  if (!request.timeoutMs) return null;
  return setTimeout(() => {
    run.deadlineHit = true;
    controller.abort();
  }, request.timeoutMs);
}

function stoppedResult(engine: string, request: DelegateRequest, partial: PartialDelegateState): DelegateResult {
  return partialDelegateResult(engine, interruption(request.signal?.aborted), partial);
}

function partialState(
  run: GrokRun,
  asked: { startedAt: number; model: string | undefined; billing: "api" | "subscription" },
  bridge: StudioBridge | null,
  request: DelegateRequest,
): PartialDelegateState {
  return {
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    startedAt: asked.startedAt,
    sessionId: run.sessionId,
    model: run.modelUsed,
    requestedModel: asked.model,
    cliPath: run.cliPath,
    cliVersion: run.cliVersion,
    billing: asked.billing,
    studioToolCalls: recordedCalls(bridge, request),
  };
}

function delegateArgv(request: DelegateRequest, model: string | undefined, runDir: string, login: GrokLogin): string[] {
  const mode = chatMode(request);
  const sandbox = sandboxFor(request, mode);
  const offLimits = credentialHomes(login.source === LoginSource.Isolated ? [] : [login.home]);
  return [
    "--no-auto-update",
    "--no-alt-screen",
    "--output-format",
    GROK_STREAM_FORMAT,
    "--always-approve",
    "--sandbox",
    sandbox,
    "--cwd",
    runDir,
    ...(request.resume ? ["--resume", request.resume] : []),
    ...(model ? ["--model", model] : []),
    ...grokEffortArgs(request.effort),
    ...(request.maxTurns ? ["--max-turns", String(request.maxTurns)] : []),
    ...grokDenyArgs([...offLimits, ...(request.denyReads ?? [])]),
  ];
}

function sandboxFor(request: DelegateRequest, mode: PermissionMode | null): GrokSandbox {
  if (mode === PermissionMode.Bypass) return GrokSandbox.Off;
  if (request.readOnly || mode === PermissionMode.Plan) return GrokSandbox.ReadOnly;
  return GrokSandbox.Workspace;
}

function judgeArgv(model: string | undefined, effort: string | undefined, keepReads: boolean): string[] {
  const denied = keepReads ? GROK_JUDGE_TOOLS.filter((tool) => tool !== "read_file") : GROK_JUDGE_TOOLS;
  return [
    "--no-auto-update",
    "--no-alt-screen",
    "--output-format",
    GROK_STREAM_FORMAT,
    "--always-approve",
    "--sandbox",
    GrokSandbox.ReadOnly,
    "--disable-web-search",
    "--no-subagents",
    "--max-turns",
    "1",
    "--disallowed-tools",
    denied.join(","),
    ...(requestedModel(model) ? ["--model", requestedModel(model) as string] : []),
    ...grokEffortArgs(effort),
  ];
}

function judgePrompt(request: CompleteRequest, images: string[]): string {
  const body = [request.systemPrompt, ...request.messages.map((message) => message.content), ...JUDGE_RULES];
  if (images.length) body.push(`Attached stills. Read only these image files:\n${images.join("\n")}`);
  return body.filter(Boolean).join("\n\n");
}

async function writeImages(
  dir: string,
  images: Array<{ mimeType?: string; data?: string; label?: string } | undefined>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    if (!image?.data) continue;
    const file = path.join(dir, `still-${index}.${imageExtension(image.mimeType)}`);
    await writeFile(file, Buffer.from(image.data, "base64"));
    paths.push(file);
  }
  return paths;
}

function imageExtension(mime: string | undefined): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

async function openBridge(
  request: DelegateRequest,
  runDir: string,
  onCall: (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>,
): Promise<StudioBridge | null> {
  const tools = bridgeTools(request);
  if (!tools.length) return null;
  return StudioBridge.open({ cwd: runDir, tools, onCall });
}

function recordedCalls(
  bridge: StudioBridge | null,
  request: DelegateRequest,
): NonNullable<DelegateResult["studioToolCalls"]> {
  return (bridge?.calls ?? [])
    .filter((call) => call.name !== StudioTool.Checkpoint && call.name !== StudioTool.Capture)
    .filter((call) => (request.interviewTools ?? []).some((tool) => tool.name === call.name));
}

async function openStream(
  execFn: GrokExec | undefined,
  binary: string | undefined,
  invocation: Parameters<GrokExec>[0],
): Promise<AsyncIterable<Record<string, unknown>>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-grok-prompt-"));
  const file = path.join(dir, "prompt.txt");
  await writeFile(file, invocation.prompt, { mode: 0o600 });
  const argv = [...invocation.argv, "--prompt-file", file];
  const events = execFn ? execFn({ ...invocation, argv }) : streamGrok(binary ?? "", { ...invocation, argv });
  return withCleanup(events, () => rm(dir, { recursive: true, force: true }));
}

async function* withCleanup(
  events: AsyncIterable<Record<string, unknown>>,
  cleanup: () => Promise<unknown>,
): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* events;
  } finally {
    await cleanup().catch(() => {});
  }
}

function applyEvent(
  event: Record<string, unknown>,
  run: GrokRun,
  request: { onEvent?: DelegateRequest["onEvent"]; onDelta?: (delta: string) => void },
): void {
  const translated = translateGrokEvent(event);
  if (translated.text) {
    run.summary += translated.text;
    request.onDelta?.(translated.text);
    request.onEvent?.({
      type: DelegateEventType.TextDelta,
      payload: { streamId: EngineId.Grok, delta: translated.text },
    });
  }
  if (translated.sessionId) run.sessionId = translated.sessionId;
  if (translated.usage) mergeUsage(run.usage, translated.usage);
  if (translated.turns) run.turns = Math.max(run.turns, translated.turns);
  if (translated.failure) run.failure = translated.failure;
  if (translated.stopReason) run.stopReason = translated.stopReason;
  if (translated.completed) run.completed = true;
  if (translated.activity)
    request.onEvent?.({
      type: DelegateEventType.Activity,
      payload: { phase: translated.activity, engine: EngineId.Grok, sessionId: run.sessionId },
    });
  for (const item of translated.events) request.onEvent?.(item);
}

function mergeUsage(into: Usage, from: Partial<Usage>): void {
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "cost_usd",
  ] as const) {
    if (typeof from[key] === "number") into[key] = from[key];
  }
}

function doneResult(
  engine: string,
  run: GrokRun,
  asked: { startedAt: number; model: string | undefined; billing: "api" | "subscription" },
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  const length = run.stopReason === GrokStop.MaxTokens;
  return {
    ok: !length,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    billing: asked.billing,
    engine,
    durationMs: Date.now() - asked.startedAt,
    ...(run.modelUsed ? { model: run.modelUsed } : {}),
    ...(run.cliPath ? { cliPath: run.cliPath } : {}),
    ...(run.cliVersion ? { cliVersion: run.cliVersion } : {}),
    ...(length
      ? { stopReason: StopReason.Length, errorText: "The reply hit its length limit." }
      : { stopReason: StopReason.Completed }),
    ...(asked.model ? { requestedModel: asked.model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(studioToolCalls.length ? { studioToolCalls } : {}),
  };
}
