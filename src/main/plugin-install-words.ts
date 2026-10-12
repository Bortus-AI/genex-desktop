/**
 * What the plugin trust dialog says, built from the package alone, and what an action's approval
 * shows under its question: pure, so the words are tested without Electron.
 * `plugin-install-dialog.ts` and the plugins IPC show them.
 */
import {
  PluginCapability,
  PluginHostTool,
  type PluginManifest,
  type PluginManifestTool,
  type PluginMcpServer,
  type PluginScan,
  type PluginSkill,
  type PluginSkillChange,
  type PluginSource,
  pluginSkillChange,
} from "../shared/plugins.ts";
import { type PluginInstallReview, pluginOriginWords } from "./plugin-local-install.ts";

/** How many scan findings the dialog names. */
const SCAN_FINDINGS_NAMED = 6;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The dialog's words; the names, versions and lists in them come from the package. */
const MESSAGE = {
  install: (name: string, version: string) => `Install ${name} ${version}?`,
  update: (name: string, version: string) => `Update ${name} to ${version}?`,
  replace: (old: string, name: string, version: string) => `Replace ${old} with ${name} ${version}?`,
  installButton: "Install",
  updateButton: "Update",
  replaceButton: "Replace and erase data",
  replaces: (name: string, publisher: string, origin: string) =>
    `This replaces ${name} by ${publisher} (from ${origin}). Its saved account, settings and data will be erased.`,
  source: (origin: string, publisher: string) => `From ${origin}\nPublisher: ${publisher}`,
  unsandboxed: "Its code runs on your computer like an app you install. It isn't sandboxed.",
  asks: "It asks to:",
  servers: (count: number) => `Starts ${plural(count, "program")} for agents:`,
  hostTools: (count: number) => `Genex runs ${plural(count, "tool")} for it:`,
  skills: (count: number, named: string) => `Adds ${plural(count, "skill")} for agents: ${named}.`,
  noSkills: "Adds no skills for agents.",
  removedSkills: (named: string) => ` Removes: ${named}.`,
  notScanned: "Not scanned.",
  scan: (verdict: string, found: string) => `Scan: ${verdict}, ${found}.`,
  noFindings: "no findings",
  finding: (rule: string, file: string, line: number) => `${rule} in ${file}:${line}`,
  genexCli: "the Genex CLI",
  given: (program: string, env: string) => `${program}, given ${env}`,
  withConsent: (does: string) => `${does}, asks you each time`,
  new: "new",
  changed: "changed",
} as const;

/** What each capability lets a plugin do, as a line under "It asks to:". */
const CAPABILITY_WORDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    [PluginCapability.Settings]: "keep its own settings",
    [PluginCapability.ProjectRead]: "read files in your games",
    [PluginCapability.ProjectWrite]: "change files in your games",
    [PluginCapability.Jobs]: "run long jobs and report their progress",
    [PluginCapability.Observe]: "load and capture your games as they run",
    [PluginCapability.Credentials]: "save a sign-in for its own account",
    [PluginCapability.ExternalAuth]: "open sign-in pages in your browser",
    [PluginCapability.Network]: "reach the internet",
    [PluginCapability.Export]: "export your games",
    [PluginCapability.NativeRuntime]: "install and run the apps it names, such as Blender",
  } satisfies Record<PluginCapability, string>),
);

/** What each tool Genex runs itself does, as the dialog names it. */
const HOST_TOOL_WORDS = {
  [PluginHostTool.GenexCli]: "runs the Genex CLI",
  [PluginHostTool.GenexCliPaid]: "runs the Genex CLI",
  [PluginHostTool.GenexPackage]: "installs Genex packages in the game",
} as const satisfies Record<PluginHostTool, string>;

const bulleted = (heading: string, lines: string[]): string =>
  [heading, ...lines.map((line) => `• ${line}`)].join("\n");

/** A name with its marks in brackets, or the bare name when it has none. */
const marked = (name: string, marks: readonly string[]): string =>
  marks.length ? `${name} (${marks.join(", ")})` : name;

/** What it asks to do, each capability new since the installed version marked. */
function capabilityBlock(manifest: PluginManifest, before: PluginManifest | undefined): string | undefined {
  if (!manifest.capabilities.length) return undefined;
  const had = before ? new Set(before.capabilities) : null;
  const lines = manifest.capabilities.map((c) =>
    marked(CAPABILITY_WORDS.get(c) ?? c, had && !had.has(c) ? [MESSAGE.new] : []),
  );
  return bulleted(MESSAGE.asks, lines);
}

/**
 * A plugin's MCP servers are trusted by this dialog and by nothing else — there is no second
 * connector trust prompt for a server the host owns on the plugin's behalf. So the dialog has to
 * say that installing also means letting Genex start those programs, and name what each is given.
 */
function serverBlock(manifest: PluginManifest, previous: PluginManifest | undefined): string | undefined {
  const servers = manifest.mcpServers ?? [];
  if (!servers.length) return undefined;
  const before = previous ? new Map((previous.mcpServers ?? []).map((s) => [s.id, JSON.stringify(s)])) : null;
  const lines = servers.map((s) => `${marked(s.id, serverChange(before, s))} — ${serverLaunch(s)}`);
  return bulleted(MESSAGE.servers(servers.length), lines);
}

/**
 * A server that is new, or that now runs something else, somewhere else, or on a different
 * environment, is an expansion of exactly the kind a new capability is — so it is marked the
 * same way rather than arriving inside a dialog that reads like the last one. A first install
 * (no `before`) marks nothing.
 */
function serverChange(before: ReadonlyMap<string, string> | null, server: PluginMcpServer): string[] {
  if (!before) return [];
  const was = before.get(server.id);
  if (was === undefined) return [MESSAGE.new];
  return was !== JSON.stringify(server) ? [MESSAGE.changed] : [];
}

/** What a server runs, then the names of the environment it is given. */
function serverLaunch(server: PluginMcpServer): string {
  const program = server.command === "host-cli" ? MESSAGE.genexCli : (server.args[0] ?? "node");
  const env = Object.keys(server.env ?? {});
  return env.length ? MESSAGE.given(program, env.join(", ")) : program;
}

/** Tools Genex runs itself rather than the plugin's code, named with what each does. */
function hostToolBlock(manifest: PluginManifest, before: PluginManifest | undefined): string | undefined {
  const tools = manifest.tools.filter((t) => t.host);
  if (!tools.length) return undefined;
  const had = before ? new Set(before.tools.filter((t) => t.host).map((t) => t.name)) : null;
  const lines = tools.map((t) => `${marked(t.name, had && !had.has(t.name) ? [MESSAGE.new] : [])} — ${hostToolUse(t)}`);
  return bulleted(MESSAGE.hostTools(tools.length), lines);
}

function hostToolUse(tool: PluginManifestTool): string {
  const does = tool.host ? HOST_TOOL_WORDS[tool.host] : "";
  return tool.confirmation ? MESSAGE.withConsent(does) : does;
}

/**
 * Skills reach every agent's brief, so they are disclosed like the servers are: by name, and on an
 * update each new or changed one marked and each withdrawn one named. A skill is changed when its
 * manifest entry differs or, when both versions were scanned, the bytes of its files do.
 */
function skillBlock(facts: PluginInstallFacts): string | undefined {
  const { manifest, before } = facts;
  const change = before
    ? pluginSkillChange({ manifest: before, scan: facts.previousScan }, { manifest, scan: facts.scan })
    : undefined;
  const removed = change?.removed.length ? MESSAGE.removedSkills(change.removed.join(", ")) : "";
  if (!manifest.skills.length) return removed ? `${MESSAGE.noSkills}${removed}` : undefined;
  const named = manifest.skills.map((s) => marked(s.name, skillMarks(s, change))).join(", ");
  return `${MESSAGE.skills(manifest.skills.length, named)}${removed}`;
}

function skillMarks(skill: PluginSkill, change: PluginSkillChange | undefined): string[] {
  return [
    ...(change?.added.includes(skill.name) ? [MESSAGE.new] : []),
    ...(change?.changed.includes(skill.name) ? [MESSAGE.changed] : []),
  ];
}

function scanBlock(scan: PluginScan | undefined): string {
  if (!scan) return MESSAGE.notScanned;
  const named = scan.findings
    .slice(0, SCAN_FINDINGS_NAMED)
    .map((f) => MESSAGE.finding(f.rule, f.file, f.line))
    .join(", ");
  const found = scan.findings.length ? `${plural(scan.findings.length, "finding")}: ${named}` : MESSAGE.noFindings;
  return MESSAGE.scan(scan.verdict, found);
}

/** What the dialog says about the id a replacement erases, or nothing for a plain install. */
function replacementBlock(replaces: PluginInstallReview["replaces"]): string | undefined {
  if (!replaces) return undefined;
  return MESSAGE.replaces(replaces.name, replaces.publisher, pluginOriginWords(replaces.origin));
}

/** What the trust dialog is built from. */
export interface PluginInstallFacts {
  manifest: PluginManifest;
  origin?: PluginSource;
  /** The static scan of this package; absent for bundled code. */
  scan?: PluginScan;
  /** The installed version this package updates; absent on a first install or a replacement. */
  before?: PluginManifest;
  /** The installed version's scan, which a scanned update's skill digests are compared with. */
  previousScan?: PluginScan;
  replaces?: PluginInstallReview["replaces"];
  /** Anything the user must weigh besides the package itself. */
  note?: string;
}

/**
 * The trust dialog's body, one block per fact with a blank line between: what a replacement erases,
 * where the code came from, that it is not sandboxed, what it asks to do, what it starts, which
 * skills it adds, what the scan saw, and the note. A block with nothing to say is left out.
 */
export function installDetail(facts: PluginInstallFacts): string {
  const { manifest, origin, scan, before, replaces, note } = facts;
  return [
    replacementBlock(replaces),
    MESSAGE.source(pluginOriginWords(origin), manifest.publisher),
    MESSAGE.unsandboxed,
    capabilityBlock(manifest, before),
    serverBlock(manifest, before),
    hostToolBlock(manifest, before),
    skillBlock(facts),
    scanBlock(scan),
    note,
  ]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}

/** The trust dialog: its question, its body and the button that agrees. */
export interface InstallPrompt {
  message: string;
  detail: string;
  confirm: string;
}

/** Install, update (another version of the installed plugin) or replace (another plugin's id). */
export function installPrompt(facts: PluginInstallFacts): InstallPrompt {
  const { manifest, before, replaces } = facts;
  const detail = installDetail(facts);
  if (replaces)
    return {
      message: MESSAGE.replace(replaces.name, manifest.name, manifest.version),
      detail,
      confirm: MESSAGE.replaceButton,
    };
  if (before && before.version !== manifest.version)
    return { message: MESSAGE.update(manifest.name, manifest.version), detail, confirm: MESSAGE.updateButton };
  return { message: MESSAGE.install(manifest.name, manifest.version), detail, confirm: MESSAGE.installButton };
}

/** The arguments an approved action runs with, under its question; none, and nothing shows (never `{}`). */
export function actionApprovalDetail(args: unknown): string | undefined {
  const empty = args === undefined || args === null || (typeof args === "object" && Object.keys(args).length === 0);
  return empty ? undefined : JSON.stringify(args, null, 2);
}
