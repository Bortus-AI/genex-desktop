/**
 * The `grok` CLI's headless contract, as Grok Build documents it: one prompt from `--prompt-file`
 * (headless does not read the prompt from stdin), newline-delimited `streaming-json` events, and
 * device-code sign-in. Nothing here stores a token.
 */
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { childEnv } from "../child-env.ts";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { DelegateEventType, type DelegateEvent } from "./types.ts";
import type { Usage } from "../types.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";

/** How long a stopped `grok` gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5 * SECOND_MS;
/** The end of stderr kept when a run fails. */
const STDERR_TAIL_CHARS = 4_000;

/** Documented coding models. `grok models` has no published schema, so the picker starts from these. */
export const GrokModelId = {
  /** The id the settings reference uses as the session default. */
  Build: "grok-build",
  /** Grok 4.7, the model the Grok 4.7 page names as Grok Build's coding model. */
  Grok47: "grok-4.7",
} as const;

/** Grok 4.7's published context window. `grok-build` has no separate published window. */
export const GROK_47_CONTEXT = 500_000;

/**
 * Efforts Grok 4.7's model page advertises. The CLI also accepts `none`, `minimal` and `max`,
 * but a model only accepts the levels its own menu lists, so those are not sent.
 */
export const GROK_EFFORTS = [
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Xhigh,
] as const;

/** Grok 4.7's published default effort. */
export const GROK_DEFAULT_EFFORT = ReasoningEffort.High;

/** Where a Grok login keeps its session. Presence only: the file is never opened. */
export const GROK_AUTH_FILE = "auth.json";
/** Marks a home the in-app sign-in owns, so signing out does not fall through to `~/.grok`. */
export const GROK_STUDIO_MARKER = "studio-login.json";
/** The documented API-key variable. A session token in `auth.json` wins over it. */
export const GROK_API_KEY = "XAI_API_KEY";

/** Sandbox profiles the sandbox page names. `workspace` is the unattended build. */
export const GrokSandbox = {
  Off: "off",
  Workspace: "workspace",
  ReadOnly: "read-only",
} as const;
export type GrokSandbox = (typeof GrokSandbox)[keyof typeof GrokSandbox];

/** Flags Studio always passes. Discovery requires each of these to appear in `grok --help`. */
export const GROK_REQUIRED_FLAGS = [
  "--output-format",
  "--prompt-file",
  "--always-approve",
  "--sandbox",
  "--resume",
  "--no-auto-update",
] as const;

/** Headless output. `streaming-json` is the documented xAI-native event stream. */
export const GROK_STREAM_FORMAT = "streaming-json";

/** Built-in tools a judge must not use. Names are the ones the headless guide prints. */
export const GROK_JUDGE_TOOLS = [
  "read_file",
  "grep",
  "list_dir",
  "run_terminal_cmd",
  "web_search",
  "web_fetch",
  "search_replace",
  "write",
] as const;

/** `streaming-json` event names the headless guide lists. Further names are ignored. */
export const GrokEvent = {
  Text: "text",
  Thought: "thought",
  ToolCall: "tool_call",
  ToolCallUpdate: "tool_call_update",
  Usage: "usage",
  End: "end",
  Error: "error",
  MaxTurns: "max_turns_reached",
} as const;

/** Stop reasons the headless guide puts on the final `end` event. */
export const GrokStop = {
  EndTurn: "end_turn",
  MaxTokens: "max_tokens",
  MaxTurns: "max_turn_requests",
  Refusal: "refusal",
  Cancelled: "cancelled",
} as const;

/** Hosts a device-code sign-in may open. The guide names `auth.x.ai` and `grok.com`. */
const LOGIN_HOSTS = new Set(["x.ai", "auth.x.ai", "accounts.x.ai", "console.x.ai", "grok.com"]);

const URL_IN_OUTPUT = /https:\/\/[^\s<>"']+/g;
/** The external-auth example prints `enter code: <code>`. The CLI's own wording is not published. */
const DEVICE_CODE = /\bcode[:\s]+([A-Za-z0-9-]{4,16})\b/i;

/** What a failed `grok` run is, from phrases the authentication guide and the CLI actually print. */
const AUTH_PATTERNS = [
  /authentication failed/i,
  /not logged in/i,
  /auth expired/i,
  /run `?grok login/i,
  /unauthori[sz]ed/i,
  /\b401\b/,
];
const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too many requests/i, /\b429\b/];
const USAGE_LIMIT_PATTERNS = [/usage limit/i, /quota exceeded/i];

export interface GrokTranslated {
  events: DelegateEvent[];
  /** A text chunk. The caller concatenates them; the guide's example treats `data` as a delta. */
  text?: string;
  sessionId?: string;
  usage?: Partial<Usage>;
  failure?: string;
  stopReason?: string;
  completed?: boolean;
  activity?: ChatActivityPhase;
  turns?: number;
}

/** One `grok` invocation, as an async stream of its own JSON events. Tests stand in for the process. */
export type GrokExec = (invocation: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  signal: AbortSignal;
  onStderr?: (chunk: string) => void;
}) => AsyncIterable<Record<string, unknown>>;

/** The environment a `grok` child starts with. `XAI_API_KEY` is kept only when this login is the key. */
export function grokEnv(extra: Record<string, string | undefined> = {}, keepApiKey = false): Record<string, string> {
  return childEnv(
    { ...process.env, ...extra },
    {
      base: "contractor",
      vendor: "grok",
      ...(keepApiKey ? { keep: [GROK_API_KEY] } : {}),
      set: { GROK_DISABLE_AUTOUPDATER: "1" },
    },
  );
}

/** An https URL on a host the sign-in guide names, or null. */
export function allowedGrokLoginUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed =
      url.protocol === "https:" && (LOGIN_HOSTS.has(host) || host.endsWith(".x.ai") || host.endsWith(".grok.com"));
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Every allow-listed sign-in URL in one line of login output. */
export function loginUrlsIn(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(URL_IN_OUTPUT)) {
    const url = allowedGrokLoginUrl(match[0] ?? "");
    if (url) found.push(url);
  }
  return found;
}

/** The device code a login line printed, or null when this line has none. */
export function deviceCodeFrom(line: string): string | null {
  return line.match(DEVICE_CODE)?.[1] ?? null;
}

/** `--effort` for an advertised level. `max` and `ultra` clamp to `xhigh`; anything else is omitted. */
export function grokEffortArgs(effort: string | undefined): string[] {
  if (!effort || effort === "auto") return [];
  const clamped = effort === ReasoningEffort.Max || effort === ReasoningEffort.Ultra ? ReasoningEffort.Xhigh : effort;
  const advertised = (GROK_EFFORTS as readonly string[]).includes(clamped);
  return advertised ? ["--effort", clamped] : [];
}

/** Repeatable `--deny` rules for paths the contractor must not read or write. A `)` would break the rule syntax. */
export function grokDenyArgs(dirs: readonly string[]): string[] {
  const args: string[] = [];
  for (const dir of dirs) {
    if (!dir || dir.includes(")")) continue;
    for (const prefix of ["Read", "Edit", "Write"]) args.push("--deny", `${prefix}(${dir}/**)`);
  }
  return args;
}

/** One JSON line, or null when it is not a JSON object. */
export function parseGrokLine(raw: string): Record<string, unknown> | null {
  const line = raw.trim();
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `streaming-json` → the studio's log vocabulary. Unknown types are ignored, as the guide asks. */
export function translateGrokEvent(event: Record<string, unknown>): GrokTranslated {
  const type = String(event.type ?? "");
  if (type === GrokEvent.Text) return textEvent(event);
  if (type === GrokEvent.Thought) return thoughtEvent(event);
  if (type === GrokEvent.ToolCall) return toolCallEvent(event);
  if (type === GrokEvent.ToolCallUpdate) return toolUpdateEvent(event);
  if (type === GrokEvent.End) return endEvent(event);
  if (type === GrokEvent.Error) return errorEvent(event);
  if (type === GrokEvent.MaxTurns) return { events: [], stopReason: GrokStop.MaxTurns, failure: "max turns reached" };
  if (type.startsWith("auto_compact"))
    return {
      events: [{ type: DelegateEventType.Context, payload: { compacted: true } }],
      activity: ChatActivityPhase.Compacting,
    };
  return { events: [] };
}

/** Which failure kind a `grok` message is, or null when it is an ordinary error. */
export function grokFailureKind(text: string): "auth" | "rate_limit" | "usage_limit" | null {
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) return "auth";
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return "usage_limit";
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return "rate_limit";
  return null;
}

/**
 * Spawn `grok` and yield its JSON events. The prompt is already in `--prompt-file`: the guide
 * says headless does not read a prompt from stdin.
 */
export function streamGrok(
  binary: string,
  invocation: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    signal: AbortSignal;
    onStderr?: (chunk: string) => void;
  },
): AsyncIterable<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const child = spawnCommand(binary, invocation.argv, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
    invocation.onStderr?.(chunk);
  });
  const onAbort = (): void => {
    void stopChild(child, { signal: "SIGTERM" });
    setTimeout(() => void stopChild(child), KILL_GRACE_MS).unref?.();
  };
  if (invocation.signal.aborted) onAbort();
  else invocation.signal.addEventListener("abort", onAbort, { once: true });
  return readStdout(child, invocation.signal, onAbort, () => stderr);
}

async function* readStdout(
  child: ReturnType<typeof spawnCommand>,
  signal: AbortSignal,
  onAbort: () => void,
  stderr: () => string,
): AsyncGenerator<Record<string, unknown>> {
  const exit = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
  child.stdout?.setEncoding("utf8");
  try {
    yield* jsonEvents(child.stdout as AsyncIterable<string>);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const { code } = await exit;
  if (code !== 0 && !signal.aborted) throw new Error(stderr().trim() || `grok exited with ${code}`);
}

async function* jsonEvents(stdout: AsyncIterable<string>): AsyncGenerator<Record<string, unknown>> {
  let buffer = "";
  for await (const chunk of stdout) {
    const lines = `${buffer}${chunk}`.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseGrokLine(line);
      if (event) yield event;
    }
  }
}

function textEvent(event: Record<string, unknown>): GrokTranslated {
  const text = String(event.data ?? "");
  if (!text) return { events: [] };
  return {
    events: [assistant([{ type: "text", text }])],
    text,
    activity: ChatActivityPhase.Responding,
  };
}

function thoughtEvent(event: Record<string, unknown>): GrokTranslated {
  const text = String(event.data ?? "");
  if (!text.trim()) return { events: [], activity: ChatActivityPhase.Thinking };
  return {
    events: [assistant([{ type: "thinking", text }])],
    activity: ChatActivityPhase.Thinking,
  };
}

function toolCallEvent(event: Record<string, unknown>): GrokTranslated {
  const id = String(event.toolCallId ?? "");
  const name = String(event.toolName ?? event.title ?? "tool");
  return {
    events: [assistant([{ type: "tool_use", id, name, input: event.rawInput ?? {} }])],
    activity: ChatActivityPhase.Tool,
    turns: 1,
  };
}

function toolUpdateEvent(event: Record<string, unknown>): GrokTranslated {
  const status = String(event.status ?? "");
  const finished = status === "completed" || status === "failed";
  if (!finished) return { events: [], activity: ChatActivityPhase.Tool };
  return {
    events: [
      {
        type: DelegateEventType.User,
        payload: {
          role: "user",
          parts: [
            {
              type: "tool_result",
              tool_use_id: String(event.toolCallId ?? ""),
              is_error: status === "failed",
              content: clipOutput(event.rawOutput),
            },
          ],
        },
      },
    ],
    activity: ChatActivityPhase.Thinking,
  };
}

function endEvent(event: Record<string, unknown>): GrokTranslated {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  const stopReason = typeof event.stopReason === "string" ? event.stopReason : GrokStop.EndTurn;
  const usage = usageFrom(event.usage);
  const completed = stopReason === GrokStop.EndTurn || stopReason === GrokStop.MaxTokens;
  return {
    events: [
      {
        type: DelegateEventType.System,
        payload: { subtype: "init", ...(sessionId ? { session_id: sessionId } : {}) },
      },
    ],
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
    stopReason,
    ...(completed ? { completed: true } : {}),
    ...(!completed ? { failure: stopReason } : {}),
    ...(typeof event.num_turns === "number" ? { turns: event.num_turns } : {}),
  };
}

function errorEvent(event: Record<string, unknown>): GrokTranslated {
  const message = String(event.message ?? "Grok Build reported an error");
  return {
    events: [{ type: DelegateEventType.Result, payload: { subtype: "error", result: message } }],
    failure: message,
    ...(usageFrom(event.usage) ? { usage: usageFrom(event.usage) } : {}),
  };
}

function assistant(parts: unknown[]): DelegateEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function usageFrom(raw: unknown): Partial<Usage> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const usage: Partial<Usage> = {};
  copyCount(usage, "input_tokens", record.input_tokens);
  copyCount(usage, "output_tokens", record.output_tokens);
  copyCount(usage, "cache_read_tokens", record.cache_read_input_tokens);
  copyCount(usage, "cache_write_tokens", record.cache_creation_input_tokens);
  copyCount(usage, "reasoning_tokens", record.reasoning_tokens);
  if (record.cost_is_partial !== true) copyCount(usage, "cost_usd", record.total_cost_usd);
  return Object.keys(usage).length ? usage : undefined;
}

function copyCount(
  usage: Partial<Usage>,
  key: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens" | "cost_usd",
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
}

function clipOutput(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}…`;
}
