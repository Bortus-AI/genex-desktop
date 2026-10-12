/**
 * Harness RPC: the person's computer for the harness's own tool loop (Ollama), the same `desktop`
 * tool session engines are handed (`core/desktop-session.ts`). One session per chat, started afresh
 * on each describe — a turn's tool registry asks once — and asked about on that chat's card.
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { DESKTOP_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { desktopSessionTools } from "../core/desktop-session.ts";
import type { DesktopTools } from "../core/desktop-tools.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why there is no computer for this call. */
const MESSAGE = {
  noChat: "computer control is asked about in a chat, and this call names none",
  noProject: "open a project first",
  noDriver: "computer control is not set up on this computer (install cua-driver)",
} as const;

/** One registry of chat sessions per core: the harness's calls outlive any one `api()` table. */
const SESSIONS = new WeakMap<CoreInternals, Map<string, Promise<DesktopTools | null>>>();

function sessionsOf(x: CoreInternals): Map<string, Promise<DesktopTools | null>> {
  const known = SESSIONS.get(x);
  if (known) return known;
  const made = new Map<string, Promise<DesktopTools | null>>();
  SESSIONS.set(x, made);
  return made;
}

export function desktopRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.DesktopComputer]: async (p) => {
      if (!p.threadId) return { unavailable: MESSAGE.noChat };
      const threadId = p.threadId;
      const binding = await core.pluginBinding(p.project, threadId);
      if (!binding) return { unavailable: MESSAGE.noProject };
      const sessions = sessionsOf(x);
      const key = JSON.stringify([p.project, threadId]);
      if (p.describe) {
        const before = sessions.get(key);
        sessions.delete(key);
        await (await before?.catch(() => null))?.release();
      }
      let made = sessions.get(key);
      if (!made) {
        made = desktopSessionTools(core, x, { binding, threadId });
        sessions.set(key, made);
      }
      const tools = await made;
      if (!tools) {
        sessions.delete(key);
        return { unavailable: MESSAGE.noDriver };
      }
      const [tool] = tools.liveTools;
      if (p.describe && tool) return { tool };
      return { answer: await tools.onLiveTool(DESKTOP_TOOL_NAME, p.args ?? {}) };
    },
  } satisfies Partial<HarnessHostHandlers>;
}
