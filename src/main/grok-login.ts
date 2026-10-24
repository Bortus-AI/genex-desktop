import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { commandLaunch } from "../substrate/command-launch.ts";
import { stopChild } from "../substrate/process-tree.ts";
import { pathExists } from "../substrate/fsx.ts";
import { requireCodingCli } from "../substrate/engines/external-cli.ts";
import {
  deviceCodeFrom,
  grokEnv,
  GROK_AUTH_FILE,
  GROK_STUDIO_MARKER,
  loginUrlsIn,
} from "../substrate/engines/grok-cli.ts";
import { isGrokLoginActive, type GrokLoginState } from "../shared/grok-login.ts";
import { errorMessage } from "../shared/errors.ts";
import { redactSecrets } from "../shared/redact.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";

/** A sign-in nobody finishes is cancelled after this. Device-code login waits on another device. */
const DEFAULT_TIMEOUT_MS = 10 * MINUTE_MS;
const KILL_GRACE_MS = 1500;
const MAX_LINES = 40;
const MAX_LINE_CHARS = 500;

const MESSAGE = {
  starting: "Starting Grok Build sign-in…",
  notInstalled: "Install Grok Build, then check again.",
  timedOut: "Sign-in timed out. Try again.",
  notFinished: "Grok Build could not finish signing in. Try again.",
  notVerified: "Grok Build could not verify the sign-in. Try again.",
  connected: "Grok Build connected. You can start building.",
  noLink: "No active sign-in link. Start sign-in again.",
} as const;

interface LoginAttempt {
  home: string;
  env?: NodeJS.ProcessEnv;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

export interface GrokLoginDependencies {
  resolveCli?: typeof requireCodingCli;
  spawn?: typeof spawn;
  openExternal: (url: string) => Promise<unknown>;
  onState: (state: GrokLoginState) => void;
  onConnected: () => Promise<unknown>;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Runs `grok login --device-auth` into a studio-owned `GROK_HOME`. This is not a shell. */
export class GrokLoginController {
  #state: GrokLoginState = { revision: 0, phase: "idle", lines: [], hasBrowserUrl: false };
  #attempt: LoginAttempt | null = null;
  #url: string | null = null;
  readonly #deps: GrokLoginDependencies;

  constructor(deps: GrokLoginDependencies) {
    this.#deps = deps;
  }

  snapshot(): GrokLoginState {
    return { ...this.#state, lines: [...this.#state.lines] };
  }

  async start(home: string): Promise<GrokLoginState> {
    if (isGrokLoginActive(this.#state)) return this.snapshot();
    const attempt: LoginAttempt = { home, cancelled: false };
    this.#attempt = attempt;
    this.#url = null;
    this.#update({
      phase: "starting",
      lines: [MESSAGE.starting],
      hasBrowserUrl: false,
      deviceCode: undefined,
      error: undefined,
    });
    try {
      const installation = await (this.#deps.resolveCli ?? requireCodingCli)(EngineId.Grok);
      attempt.env = installation.env;
      if (attempt.cancelled) return this.snapshot();
      await prepareHome(home);
      if (attempt.cancelled) return this.snapshot();
      this.#drive(attempt, installation.path);
    } catch (error) {
      if (!attempt.cancelled && this.#attempt === attempt) this.#fail(errorMessage(error) || MESSAGE.notInstalled);
    }
    return this.snapshot();
  }

  async cancel(): Promise<GrokLoginState> {
    const attempt = this.#attempt;
    if (!attempt) return this.snapshot();
    attempt.cancelled = true;
    clearTimeout(attempt.timer);
    if (attempt.child) {
      await stopChild(attempt.child, { signal: "SIGTERM" });
      setTimeout(() => void stopChild(attempt.child as ChildProcess), KILL_GRACE_MS).unref?.();
    }
    if (this.#attempt === attempt) this.#update({ phase: "cancelled", error: undefined });
    return this.snapshot();
  }

  async openBrowser(): Promise<void> {
    if (!this.#url) throw new Error(MESSAGE.noLink);
    await this.#deps.openExternal(this.#url);
  }

  #drive(attempt: LoginAttempt, binary: string): void {
    const launch = commandLaunch(binary, ["login", "--device-auth"], this.#deps.platform);
    const child = (this.#deps.spawn ?? spawn)(launch.file, launch.args, {
      cwd: attempt.home,
      env: grokEnv({ ...attempt.env, GROK_HOME: attempt.home }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    attempt.child = child;
    this.#update({ phase: "waiting" });
    const pending = { stdout: "", stderr: "" };
    const consume = (stream: "stdout" | "stderr", chunk: string, flush = false): void => {
      for (const line of takeLines(pending, stream, chunk, flush)) this.#readLine(line, attempt);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => consume(stream, chunk));
    }
    child.once("error", (error) => {
      clearTimeout(attempt.timer);
      if (!attempt.cancelled && this.#attempt === attempt) this.#fail(error.message);
    });
    child.once("close", (code) => {
      clearTimeout(attempt.timer);
      consume("stdout", "", true);
      consume("stderr", "", true);
      if (!attempt.cancelled && this.#attempt === attempt) void this.#finish(attempt, code);
    });
    attempt.timer = setTimeout(() => {
      void this.cancel().then(() => {
        if (this.#attempt === attempt) this.#fail(MESSAGE.timedOut);
      });
    }, this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    attempt.timer.unref?.();
  }

  #readLine(raw: string, attempt: LoginAttempt): void {
    if (this.#attempt !== attempt || attempt.cancelled) return;
    const plain = stripVTControlCharacters(raw);
    const urls = loginUrlsIn(plain);
    const url = urls[0];
    if (url && url !== this.#url) {
      this.#url = url;
      this.#update({ hasBrowserUrl: true });
      void this.#deps.openExternal(url).catch(() => {});
    }
    const code = deviceCodeFrom(plain);
    const safe = sanitize(plain);
    const lines = safe ? [...this.#state.lines, safe].slice(-MAX_LINES) : this.#state.lines;
    this.#update({ lines, ...(code ? { deviceCode: code } : {}) });
  }

  async #finish(attempt: LoginAttempt, code: number | null): Promise<void> {
    this.#update({ phase: "verifying" });
    const signedIn = code === 0 && (await pathExists(path.join(attempt.home, GROK_AUTH_FILE)));
    if (!signedIn) {
      this.#fail(code === 0 ? MESSAGE.notVerified : MESSAGE.notFinished);
      return;
    }
    this.#update({
      phase: "connected",
      lines: [...this.#state.lines, MESSAGE.connected].slice(-MAX_LINES),
      error: undefined,
    });
    await this.#deps.onConnected().catch(() => {});
  }

  #update(patch: Partial<GrokLoginState>): void {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 };
    this.#deps.onState(this.snapshot());
  }

  #fail(error: string): void {
    this.#update({ phase: "failed", error: sanitize(error) || MESSAGE.notFinished });
  }
}

async function prepareHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, GROK_STUDIO_MARKER), "{}\n", { mode: 0o600 });
}

function sanitize(line: string): string {
  return redactSecrets(stripVTControlCharacters(line)).replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
}

function takeLines(
  pending: { stdout: string; stderr: string },
  stream: "stdout" | "stderr",
  chunk: string,
  flush: boolean,
): string[] {
  const combined = `${pending[stream]}${chunk}`;
  const parts = combined.split(/\r?\n/);
  pending[stream] = flush ? "" : (parts.pop() ?? "");
  return parts;
}
