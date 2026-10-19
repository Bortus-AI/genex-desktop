/**
 * What Windows itself says about the desktop, for computer control on a PC: the app that holds the
 * keyboard (the foreground window's process) and whether its focused field is a password field
 * (UI Automation's `IsPassword`), and the app a click at a screen point reaches (the root of
 * `WindowFromPoint`'s window, which is how cua-driver resolves its own desktop click). cua's window
 * list cannot say either: it lists windows on other virtual desktops and transparent overlays (a
 * game overlay over the whole screen) as on screen, and its app listing rescans every installed app.
 *
 * A host helper like the driver: Windows PowerShell (Microsoft's, on every Windows 10 and 11) runs a
 * fixed script outside the ProcessSandbox. The script compiles one small C# class, says it is ready,
 * then answers one JSON line for each request line on its stdin: `front`, `at <x> <y>` (physical
 * screen pixels, as cua's desktop pictures map them) or `pid <n>`. An app is its executable's name
 * and its file description (the name the person knows it by); a window no process can be read for
 * answers pid 0, which the caller refuses. A request that does not answer in time ends the helper,
 * and the next request starts a fresh one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";

/** How long the helper has to compile its class and say it is ready. */
const START_MS = 30 * SECOND_MS;
/** How long one request may take: UI Automation waits on the focused app, which can hang. */
const REQUEST_MS = 5 * SECOND_MS;
/** How long a helper whose output closed has to exit, so its own words say why. */
const EXIT_WAIT_MS = 2 * SECOND_MS;
/** How much of the helper's stderr is kept to say why it stopped. */
const MAX_STDERR_CHARS = 2_000;
/** The helper's script file in its private folder. */
const SCRIPT_NAME = "window-probe.ps1";
/** The line the helper says once its class is compiled. */
const READY = '{"ready":true}';

const MESSAGE = {
  notStarted: (why: string) => `the Windows window probe did not start: ${why}`,
  ended: (why: string) => `the Windows window probe stopped: ${why}`,
  timedOut: (request: string) => `the Windows window probe did not answer "${request}" in time`,
  closed: "the Windows window probe was closed",
  badAnswer: (line: string) => `the Windows window probe answered something unreadable: ${line.slice(0, 200)}`,
} as const;

/**
 * The helper's script: a C# class for the Win32 and UI Automation calls, compiled once, serving
 * request lines. Its answers are ASCII (every other character escaped), so no console code page
 * can garble them.
 */
export const WINDOW_PROBE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = [AppDomain]::CurrentDomain.GetAssemblies() |
  Where-Object { $_.GetName().Name -in 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase' } |
  ForEach-Object { $_.Location }
Add-Type -ReferencedAssemblies $references -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class GenexWindowProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct Point { public int X; public int Y; }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool IsProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  const uint RootWindow = 2;
  const uint QueryLimitedInformation = 0x1000;
  static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);
  static bool physicalPoints;

  public static void Serve() {
    // Physical pixels, as cua-driver's own clicks use; a Windows before 10 1703 has no such call.
    try { SetProcessDpiAwarenessContext(PerMonitorAwareV2); } catch (EntryPointNotFoundException) { }
    // A process Windows still scales sees other points than the driver clicks: then no point is read.
    try { physicalPoints = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) > 0; }
    catch (EntryPointNotFoundException) { physicalPoints = IsProcessDPIAware(); }
    Console.Out.WriteLine("{\"ready\":true}");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string answer;
      try { answer = Ask(line.Trim()); }
      catch (Exception error) { answer = "{\"error\":" + Json(error.Message) + "}"; }
      Console.Out.WriteLine(answer);
      Console.Out.Flush();
    }
  }

  static string Ask(string line) {
    string[] parts = line.Split(' ');
    if (parts[0] == "front" && parts.Length == 1) return OfWindow(GetForegroundWindow(), true);
    if (parts[0] == "at" && parts.Length == 3) {
      if (!physicalPoints) return "{\"error\":\"Windows scales this process's screen points\"}";
      Point point = new Point {
        X = int.Parse(parts[1], CultureInfo.InvariantCulture),
        Y = int.Parse(parts[2], CultureInfo.InvariantCulture)
      };
      IntPtr window = WindowFromPoint(point);
      IntPtr root = window == IntPtr.Zero ? IntPtr.Zero : GetAncestor(window, RootWindow);
      return OfWindow(root == IntPtr.Zero ? window : root, false);
    }
    if (parts[0] == "pid" && parts.Length == 2) return OfProcess(uint.Parse(parts[1], CultureInfo.InvariantCulture), null);
    return "{\"error\":\"unknown request\"}";
  }

  static string OfWindow(IntPtr window, bool focus) {
    if (window == IntPtr.Zero) return "{\"pid\":0}";
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    return OfProcess(pid, focus ? FocusIsPassword() : null);
  }

  static string OfProcess(uint pid, string secure) {
    string image = ImagePath(pid);
    if (image.Length == 0) return "{\"pid\":0}";
    string name = "";
    try { name = FileVersionInfo.GetVersionInfo(image).FileDescription ?? ""; } catch (Exception) { }
    string answer = "{\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
      ",\"exe\":" + Json(Path.GetFileName(image)) + ",\"name\":" + Json(name.Trim());
    return secure == null ? answer + "}" : answer + ",\"secure\":" + secure + "}";
  }

  // Whether the focused element is a password field; null when focus is on no text field (an app
  // whose accessibility wakes on first asking may still say its window), so the caller reads the tree.
  static string FocusIsPassword() {
    try {
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused == null || focused.Current.ControlType != ControlType.Edit) return "null";
      return focused.Current.IsPassword ? "true" : "false";
    } catch (Exception) { return "null"; }
  }

  static string ImagePath(uint pid) {
    if (pid == 0) return "";
    IntPtr process = OpenProcess(QueryLimitedInformation, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      StringBuilder name = new StringBuilder(1024);
      uint size = (uint)name.Capacity;
      return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : "";
    } finally { CloseHandle(process); }
  }

  static string Json(string text) {
    StringBuilder json = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') json.Append('\\').Append(c);
      else if (c < 0x20 || c > 0x7e) json.Append("\\u").Append(((int)c).ToString("x4"));
      else json.Append(c);
    }
    return json.Append('"').ToString();
  }
}
'@
[GenexWindowProbe]::Serve()
`;

/** An app as Windows names it: its process, its executable, its file description, and (for the one in front) whether its focused field is a password field, when UI Automation could say. */
export interface ProbedApp {
  pid: number;
  exe: string;
  name: string;
  secure: boolean | null;
}

/** What the helper answers. */
export interface WindowsProbe {
  /** The app that holds the keyboard, with its focused field's password flag; null when none can be read. */
  front(): Promise<ProbedApp | null>;
  /** The app a click at this physical screen point reaches; null when none can be read. */
  at(x: number, y: number): Promise<ProbedApp | null>;
  /** A running process as an app; null when it cannot be read. */
  process(pid: number): Promise<ProbedApp | null>;
  /** Stop the helper. */
  close(): Promise<void>;
}

/** How the helper is started: Windows PowerShell and the environment it may see. */
export interface ProbeCommand {
  command: string;
  /** The arguments before the script's path. */
  args: string[];
  env: Record<string, string>;
}

/** Windows PowerShell by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
export function windowsPowerShell(env: Record<string, string | undefined>): ProbeCommand["command"] {
  return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The helper as Windows PowerShell runs it: no profile, no prompt, the script file as given. */
export function probeCommand(env: Record<string, string>): ProbeCommand {
  return {
    command: windowsPowerShell(env),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"],
    env,
  };
}

/** One answer line as an app, or null for none; throws on an answer that is neither. */
export function parseProbeAnswer(line: string): ProbedApp | null {
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    throw new Error(MESSAGE.badAnswer(line));
  }
  if (!body || typeof body !== "object") throw new Error(MESSAGE.badAnswer(line));
  const answer = body as Record<string, unknown>;
  if (typeof answer.error === "string") throw new Error(answer.error);
  const pid = typeof answer.pid === "number" && Number.isSafeInteger(answer.pid) ? answer.pid : null;
  if (pid === null) throw new Error(MESSAGE.badAnswer(line));
  const exe = typeof answer.exe === "string" ? answer.exe : "";
  if (pid === 0 || !exe) return null;
  const secure = typeof answer.secure === "boolean" ? answer.secure : null;
  return { pid, exe, name: typeof answer.name === "string" ? answer.name : "", secure };
}

/** A started helper: its process, its answers in order, and why it ended if it did. */
interface Running {
  child: ChildProcess;
  dir: string;
  lines: AsyncIterator<string>;
  exited: Promise<void>;
  ended: () => string | null;
}

/** Start the helper and wait for it to say it is ready. */
async function startProbe(command: ProbeCommand, startMs: number): Promise<Running> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-probe-"));
  const script = path.join(dir, SCRIPT_NAME);
  await writeFile(script, WINDOW_PROBE_SCRIPT);
  const child = spawn(command.command, [...command.args, script], {
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A helper that ended while idle makes the next write fail: that request answers why instead.
  child.stdin.on("error", () => {});
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
  });
  let ended: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      ended ??= errorMessage(error);
      resolve();
    });
    child.once("exit", (code) => {
      ended ??= `it exited (${code ?? "signal"})`;
      resolve();
    });
  });
  const running: Running = {
    child,
    dir,
    lines: readline.createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    exited,
    ended: () => (ended === null ? null : said.trim() || ended),
  };
  try {
    await untilReady(running, startMs);
    return running;
  } catch (error) {
    await stopProbe(running);
    throw new Error(MESSAGE.notStarted(errorMessage(error)));
  }
}

/**
 * Wait for the helper's ready line. PowerShell may say something first (a compiler warning), which
 * is passed over, and its first line may carry a byte-order mark.
 */
async function untilReady(running: Running, startMs: number): Promise<void> {
  const deadline = Date.now() + startMs;
  for (;;) {
    const line = await nextLine(running, Math.max(1, deadline - Date.now()), MESSAGE.timedOut("ready"));
    if (line.replace(/^\uFEFF/, "").trim() === READY) return;
  }
}

/** The helper's next line, within `ms`; refuses with `late` when it says nothing in time, or why it ended. */
async function nextLine(running: Running, ms: number, late: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(late)), ms);
  });
  try {
    const next = await Promise.race([running.lines.next(), deadline]);
    if (!next.done) return next.value;
    // Its output closes before its exit is seen: wait for that, so its own words are the reason.
    await Promise.race([running.exited, sleep(EXIT_WAIT_MS)]);
    throw new Error(MESSAGE.ended(running.ended() ?? "its output closed"));
  } finally {
    clearTimeout(timer);
  }
}

/** Stop the helper and remove its script. */
async function stopProbe(running: Running): Promise<void> {
  running.child.stdin?.end();
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
  await rm(running.dir, { recursive: true, force: true });
}

/**
 * The helper, started on its first request (or by `ready`) and kept for the next ones. Requests
 * go one at a time; one that fails or does not answer in `requestMs` stops the helper, so a hung
 * one never answers a later request.
 */
export function windowsProbe(
  command: ProbeCommand,
  options: { startMs?: number; requestMs?: number } = {},
): WindowsProbe & { ready(): Promise<void> } {
  const startMs = options.startMs ?? START_MS;
  const requestMs = options.requestMs ?? REQUEST_MS;
  let running: Promise<Running> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const live = (): Promise<Running> => {
    if (closed) return Promise.reject(new Error(MESSAGE.closed));
    running ??= startProbe(command, startMs).catch((error: unknown) => {
      running = null;
      throw error;
    });
    return running;
  };
  const drop = async (): Promise<void> => {
    const current = await running?.catch(() => null);
    running = null;
    if (current) await stopProbe(current);
  };
  /** One request to the live helper; a failed one ends it, so a late answer never meets a later request. */
  const askOnce = async (
    request: string,
  ): Promise<{ answer: ProbedApp | null } | { error: unknown; died: boolean }> => {
    const probe = await live();
    try {
      probe.child.stdin?.write(`${request}\n`);
      return { answer: parseProbeAnswer(await nextLine(probe, requestMs, MESSAGE.timedOut(request))) };
    } catch (error) {
      const died = probe.ended() !== null;
      await drop();
      return { error, died };
    }
  };
  // A helper that ended while idle (its end not yet seen) fails the request it is sent: that request
  // is asked once more of a fresh helper. One that is alive but late is not asked again.
  const answerOf = async (request: string): Promise<ProbedApp | null> => {
    const first = await askOnce(request);
    if ("answer" in first) return first.answer;
    if (!first.died) throw first.error;
    const second = await askOnce(request);
    if ("answer" in second) return second.answer;
    throw second.error;
  };
  const ask = (request: string): Promise<ProbedApp | null> => {
    const answer = queue.then(() => answerOf(request));
    queue = answer.catch(() => {});
    return answer;
  };
  return {
    ready: async () => {
      await live();
    },
    front: () => ask("front"),
    at: (x, y) => ask(`at ${Math.round(x)} ${Math.round(y)}`),
    process: (pid) => ask(`pid ${Math.trunc(pid)}`),
    close: async () => {
      closed = true;
      await drop();
    },
  };
}
