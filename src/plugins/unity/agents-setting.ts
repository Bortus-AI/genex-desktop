/**
 * Whether agents may use Unity while the person plays, for every game: the Unity panel's Agents
 * checkbox, on unless the person turned it off. While it is on, the editor lock's probe lets an
 * agent's call go ahead of the person's play (`editor-activity`), and a run's save point stops that
 * play to save; while it is off, they wait for the person, as any lock does.
 */
import { mkdir } from "node:fs/promises";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";
import path from "node:path";

/** The setting's file in the plugin's storage. */
const SETTING_FILE = "agents.json";

/** What the panel reads and sets: whether agents may use Unity while the person plays. */
export interface AgentsSetting {
  whilePlaying: boolean;
}

/** The setting as the person left it, on where they never turned it off. */
export async function agentsSetting(storage: string): Promise<AgentsSetting> {
  const saved = await readJsonIfExists<unknown>(path.join(storage, SETTING_FILE)).catch(() => null);
  return { whilePlaying: !(isJsonObject(saved) && saved.whilePlaying === false) };
}

/** The person's choice, kept for every game. */
export async function setAgentsSetting(storage: string, whilePlaying: boolean): Promise<AgentsSetting> {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  await atomicWriteJson(path.join(storage, SETTING_FILE), { whilePlaying });
  return { whilePlaying };
}
