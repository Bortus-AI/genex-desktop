/**
 * What the Roblox Studio connection tells about the agent's own work in Studio, so the Studio
 * lock's probe can tell the agent's edits from the person's. While a write the agent asked for
 * runs (`execute_luau`, or a tool Genex has no class for), the connection keeps `agent-busy.json`
 * in its own folder (`<plugin storage>/mcp/<game>`): `{since}` while it runs, then
 * `{since, until}` once the last overlapping write ended. Changes Studio reports between `since`
 * and a little after `until` are the agent's. Writing the mark never fails a call.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../substrate/fsx.ts";

/** The busy mark's name in the connection's folder. */
export const AGENT_BUSY_FILE = "agent-busy.json";

/** The busy mark: when the agent's writes began, and when the last one ended. */
export interface AgentBusy {
  since: number;
  until?: number;
}

/** Runs the agent's writes with the busy mark kept around them. */
export interface BusyMarker {
  around<T>(write: () => Promise<T>): Promise<T>;
}

/** A busy mark kept in `folder`, stamped by `now`; overlapping writes share one mark. */
export function agentBusyMarker(folder: string, now: () => number): BusyMarker {
  const file = path.join(folder, AGENT_BUSY_FILE);
  let running = 0;
  let since = 0;
  const mark = async (value: AgentBusy) => {
    await mkdir(folder, { recursive: true }).catch(() => undefined);
    await atomicWriteJson(file, value).catch(() => undefined);
  };
  return {
    async around(write) {
      if (running++ === 0) {
        since = now();
        await mark({ since });
      }
      try {
        return await write();
      } finally {
        if (--running === 0) await mark({ since, until: now() });
      }
    },
  };
}
