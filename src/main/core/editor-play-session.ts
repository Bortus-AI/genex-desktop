/**
 * The `computer` tool for the chat's own session on a game played in its engine's editor (an Unreal
 * game): the target is the game's engine plugin's play tools (`editor-play-target.ts`,
 * `shared/engine-play.ts`). It is offered only where an engine plugin that is on holds the game's
 * engine link and provides every play tool; nothing starts until the agent first uses it, and the
 * session's end lets go of the play it started.
 */
import path from "node:path";
import { ScreenRole } from "../../shared/agent-screen.ts";
import { ENGINE_PLAY_TOOLS, type EnginePlayTool } from "../../shared/engine-play.ts";
import { type PluginBinding, PluginCapability, PluginToolAudience } from "../../shared/plugins.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { type ComputerTools, computerTools } from "./computer-tools.ts";
import { safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

/** Where the chat's editor sessions keep their frames and traces, one folder per chat, under scratch. */
const FRAMES_FOLDER = "editor-play";

const MESSAGE = {
  noWindow: "a game played in its editor has no browser window",
} as const;

/** The chat's own session the editor computer is for. */
export interface EditorPlayPlace {
  project: string;
  /** The game's folder, as the session's seat resolved it. */
  directory: string;
  threadId: string;
  engineId: string;
  signal: AbortSignal;
}

/**
 * The engine plugin that plays this game in its editor: on, an engine plugin, holding the game's
 * current engine link (the one its studio.json mirrors), and providing every play tool. Null for a
 * web game, or when no such plugin is on.
 */
export async function editorPlayPlugin(core: StudioCore, project: string): Promise<string | null> {
  const directory = core.games.dirFor(project);
  const bound = await readEngineBinding(directory).catch(() => undefined);
  if (!bound) return null;
  for (const { manifest } of core.plugins.list()) {
    const engine = manifest.capabilities.includes(PluginCapability.GameEngine);
    if (!engine || !core.plugins.enabled(manifest.id)) continue;
    const names = new Set(manifest.tools.filter((t) => t.audience === PluginToolAudience.Harness).map((t) => t.name));
    if (!ENGINE_PLAY_TOOLS.every((tool) => names.has(tool))) continue;
    const link = await core.engineLinks.read(manifest.id, { project, directory }).catch(() => null);
    if (link?.project === bound.project) return manifest.id;
  }
  return null;
}

/** A session port with no window: it only names the session's screen. */
function windowless(handle: string): SessionPort {
  return {
    loaded: null,
    handle: () => handle,
    get: async () => {
      throw new Error(MESSAGE.noWindow);
    },
    release: async () => {},
  };
}

/** The editor computer for the chat's own session, or null where no engine plugin plays the game. */
export async function editorPlayTools(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  place: EditorPlayPlace,
): Promise<ComputerTools | null> {
  const plugin = await editorPlayPlugin(core, place.project);
  if (!plugin) return null;
  const binding: PluginBinding = { project: place.project, directory: place.directory, threadId: place.threadId };
  // Each call takes the editor lock its tool needs, the person first, as any harness step does.
  const call = (tool: EnginePlayTool, args: Record<string, unknown>) =>
    x.pluginTools.invokePluginTool(`${plugin}__${tool}`, args, binding, place.signal, {
      engine: place.engineId,
      caller: PluginToolAudience.Harness,
    });
  const handle = `${FRAMES_FOLDER}:${place.threadId}`;
  const outDir = path.join(core.layout.scratch, FRAMES_FOLDER, safePathSegment(place.threadId));
  // The chat's own session builds the game: it plays it as a builder plays a web game's window.
  const grant = { project: place.project, root: place.directory, role: ScreenRole.Builder, label: place.project };
  return computerTools(x.previews, grant, place.directory, outDir, windowless(handle), { editor: { call } });
}
