/**
 * The gate between an agent and Unity's Pipeline commands. The editor connector carries every
 * command the editor lists by name, so this decides what never goes through: commands that run C#
 * text nobody keeps (`eval`, `eval_file`), any menu item, ending the editor, building or switching
 * the build target, changing the project's packages, widening Pipeline's own authoring root, or
 * its server in built players. `run_script` stays: it runs a C# file of the game's own folder,
 * which the game's checkpoints keep, and is how a scene is built with code. Project settings and
 * the build's scene list stay too: a game needs its tags, layers, input and scenes.
 *
 * A file a command names must stay inside the game's folder by real path (the Unity project, and
 * beside it the game's own assets an import reads). Which parameters name files comes from the
 * editor's own catalogue: a text parameter with a file's name is one, while an object reference
 * (`ObjectRef`: an asset path, a GUID or a hierarchy path such as `/Player`) is resolved by Unity
 * inside the project and is not. Every operation of a `batch` is held to the same rules.
 *
 * These are guardrails for the person's open editor, not a sandbox: code an agent writes into the
 * project compiles and runs in that editor, as it does when the person writes it.
 */
import path from "node:path";
import { isJsonObject, realpathNearest } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { COMMAND_NAME, type PipelineCommand } from "./pipeline.ts";

/** Commands no agent runs, by name. */
const DENIED_COMMANDS: ReadonlySet<string> = new Set([
  "eval",
  "eval_file",
  "menu",
  "quit",
  "build",
  "switch_build_target",
  "set_authoring_root",
  "set_runtime_pipeline_settings",
  // What Pipeline called its package commands before 0.8.
  "add_package",
  "remove_package",
]);
/** Package commands change what the project depends on; the ones that only read stay. */
const PACKAGE_PREFIX = "package_";
const PACKAGE_READS: ReadonlySet<string> = new Set(["package_list", "package_search", "package_status"]);

/** The command that runs several, and the fields of one of its operations. */
const BATCH = "batch";
const BatchField = { Operations: "operations", Command: "command", Params: "params" } as const;
/** The most operations Pipeline takes in one batch. */
const MAX_BATCH_OPERATIONS = 200;
/** How a batch operation's value names an earlier operation's answer; `$$` is a literal `$`. */
const REFERENCE = "$";

/** The parameters that name a file or folder on disk when the catalogue types them as text. */
const FILE_PARAMETERS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "save_path",
  "output",
  "outputPath",
  "file",
  "filename",
  "assemblyDir",
  "source",
  "destination",
  "scene_path",
]);
/** The catalogue's types for text and for a list of it. */
const TEXT_TYPES: ReadonlySet<string> = new Set(["String", "String[]"]);

/** A control character: never part of a path a command may name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

/** Why the gate refused a call. Wire values: never rename one. */
export const GateRefusal = {
  NotACommand: "not-a-command",
  NotParameters: "not-parameters",
  Denied: "denied",
  PathOutside: "path-outside",
} as const;
export type GateRefusal = (typeof GateRefusal)[keyof typeof GateRefusal];

/** Where a call's files may be: the Unity project relative paths start from, inside the game's folder. Real paths. */
export interface GatePlace {
  root: string;
  game: string;
}

/**
 * A refused call: why, with the parameter that named a file outside the game, or the command agents
 * never run (in a batch, the operation's).
 */
export type GateRefused = { ok: false; refusal: GateRefusal; parameter?: string; command?: string };
/** A call that passed, as it goes to the editor, or why it does not. */
export type GateAnswer = { ok: true; command: string; parameters: Record<string, unknown> } | GateRefused;

const refused = (refusal: GateRefusal, named: Pick<GateRefused, "parameter" | "command"> = {}): GateRefused => ({
  ok: false,
  refusal,
  ...named,
});

/** Whether an agent may run the command the editor lists under `name`. */
export function commandAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED_COMMANDS.has(lower)) return false;
  return !lower.startsWith(PACKAGE_PREFIX) || PACKAGE_READS.has(lower);
}

/** Whether a batch value stands for an earlier operation's answer, which no check can read ahead of time. */
const isReference = (value: string): boolean => value.startsWith(REFERENCE) && !value.startsWith(REFERENCE.repeat(2));

/** Whether a file a command names lies in the game's folder once every link on the way is resolved. */
async function staysInside(at: GatePlace, value: unknown, inBatch: boolean): Promise<boolean> {
  if (typeof value !== "string" || !value || CONTROL.test(value)) return false;
  if (inBatch && isReference(value)) return false;
  // Unity reads a backslash as a separator on every platform.
  const spelled = value.replaceAll("\\", "/");
  const real = await realpathNearest(path.resolve(at.root, spelled)).catch(() => undefined);
  return real !== undefined && isInside(at.game, real);
}

/** Whether the editor reads the parameter `key` of `listed` as a file's name: text, or one it does not list. */
function namesFile(listed: PipelineCommand, key: string): boolean {
  if (!FILE_PARAMETERS.has(key)) return false;
  const type = listed.parameters.find((parameter) => parameter.name === key)?.type;
  return type === undefined || TEXT_TYPES.has(type);
}

/** The first parameter of a call that names a file outside the game, if any does. */
async function fileOutside(
  at: GatePlace,
  listed: PipelineCommand,
  parameters: Record<string, unknown>,
  inBatch: boolean,
): Promise<string | undefined> {
  for (const [key, value] of Object.entries(parameters)) {
    if (!namesFile(listed, key)) continue;
    for (const file of Array.isArray(value) ? value : [value]) {
      if (!(await staysInside(at, file, inBatch))) return key;
    }
  }
  return undefined;
}

/** Checks one command: its name, that the editor has it and agents may run it, its parameters and their files. */
async function gateOne(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  command: unknown,
  parameters: unknown,
  inBatch = false,
): Promise<GateAnswer> {
  if (typeof command !== "string" || !COMMAND_NAME.test(command)) return refused(GateRefusal.NotACommand);
  if (!commandAllowed(command)) return refused(GateRefusal.Denied, { command });
  const listed = catalogue.find((entry) => entry.name === command);
  if (!listed) return refused(GateRefusal.NotACommand);
  if (parameters !== undefined && !isJsonObject(parameters)) return refused(GateRefusal.NotParameters);
  const given = parameters ?? {};
  const parameter = await fileOutside(at, listed, given, inBatch);
  return parameter ? refused(GateRefusal.PathOutside, { parameter }) : { ok: true, command, parameters: given };
}

/** An operation's parameters: none, an object, or JSON text of one; `null` for anything else. */
function operationParams(params: unknown): Record<string, unknown> | undefined | null {
  if (params === undefined) return undefined;
  if (isJsonObject(params)) return params;
  if (typeof params !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(params);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Why a batch does not go through, if one of its operations would not on its own. */
async function batchRefused(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  parameters: Record<string, unknown>,
): Promise<GateRefused | undefined> {
  const operations = parameters[BatchField.Operations];
  if (!Array.isArray(operations) || operations.length > MAX_BATCH_OPERATIONS) return refused(GateRefusal.NotParameters);
  for (const operation of operations) {
    if (!isJsonObject(operation)) return refused(GateRefusal.NotParameters);
    if (operation[BatchField.Command] === BATCH) return refused(GateRefusal.Denied, { command: BATCH });
    const params = operationParams(operation[BatchField.Params]);
    if (params === null) return refused(GateRefusal.NotParameters);
    const answer = await gateOne(at, catalogue, operation[BatchField.Command], params, true);
    if (!answer.ok) return answer;
  }
  return undefined;
}

/**
 * Checks one call against the editor's catalogue for the game at `at`: the command's name, that
 * agents may run it, its parameters' shape and every file they name; for a batch, each operation.
 */
export async function gateCall(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  command: unknown,
  parameters: unknown,
): Promise<GateAnswer> {
  const call = await gateOne(at, catalogue, command, parameters);
  if (!call.ok || call.command !== BATCH) return call;
  return (await batchRefused(at, catalogue, call.parameters)) ?? call;
}
