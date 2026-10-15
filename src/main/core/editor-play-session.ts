/**
 * The `computer` tool on a game played in its engine's editor (an Unreal game): the target is the
 * game's engine plugin's play tools (`editor-play-target.ts`, `shared/engine-play.ts`). It is
 * offered only where an engine plugin that is on holds the game's engine link and provides every
 * play tool: to the chat's own session ({@link editorPlayTools}), and to any session the studio
 * hands a computer for that game, a judge's or a playtester's ({@link editorPlayComputer}). Nothing
 * starts until the agent first uses it, and the session's end lets go of the play it started.
 */
import path from "node:path";
import { ScreenRole } from "../../shared/agent-screen.ts";
import { ENGINE_PLAY_TOOLS, type EnginePlayTool } from "../../shared/engine-play.ts";
import { type PluginBinding, PluginCapability, PluginToolAudience } from "../../shared/plugins.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { type ComputerGrant, type ComputerTools, computerTools } from "./computer-tools.ts";
import { safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

/** Where the chat's editor sessions keep their frames and traces, one folder per chat, under scratch. */
const FRAMES_FOLDER = "editor-play";

/** Who the plugin's calls are recorded as when the session names no engine of its own (a judge's, a playtester's). */
const STUDIO_ENGINE = "studio";

const MESSAGE = {
  noWindow: "a game played in its editor has no browser window",
} as const;

/** The game a session's editor computer is for, and the session's own thread, engine and end where it has them. */
export interface EditorPlayGame {
  project: string;
  /** The game's folder. */
  directory: string;
  threadId?: string;
  engineId?: string;
  signal?: AbortSignal;
}

/** The chat's own session the editor computer is for. */
export interface EditorPlayPlace extends EditorPlayGame {
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
  const bound = await readEngineBinding(directory, core.plugins.engines()).catch(() => undefined);
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

/**
 * The editor computer for a session's `grant` (its role, goal and pacing), its frames in `outDir`
 * and its screen `session`; null where no engine plugin plays the game in its editor.
 */
export async function editorPlayComputer(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  game: EditorPlayGame,
  use: { grant: ComputerGrant; outDir: string; session: SessionPort },
): Promise<ComputerTools | null> {
  const plugin = await editorPlayPlugin(core, game.project).catch(() => null);
  if (!plugin) return null;
  const binding: PluginBinding = {
    project: game.project,
    directory: game.directory,
    ...(game.threadId ? { threadId: game.threadId } : {}),
  };
  // Each call takes the editor lock its tool needs, the person first, as any harness step does.
  const call = (tool: EnginePlayTool, args: Record<string, unknown>) =>
    x.pluginTools.invokePluginTool(`${plugin}__${tool}`, args, binding, game.signal, {
      engine: game.engineId ?? STUDIO_ENGINE,
      caller: PluginToolAudience.Harness,
    });
  return computerTools(x.previews, use.grant, game.directory, use.outDir, use.session, { editor: { call } });
}

/** The editor computer for the chat's own session, or null where no engine plugin plays the game. */
export async function editorPlayTools(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  place: EditorPlayPlace,
): Promise<ComputerTools | null> {
  const handle = `${FRAMES_FOLDER}:${place.threadId}`;
  const outDir = path.join(core.layout.scratch, FRAMES_FOLDER, safePathSegment(place.threadId));
  // The chat's own session builds the game: it plays it as a builder plays a web game's window.
  const grant = { project: place.project, root: place.directory, role: ScreenRole.Builder, label: place.project };
  return editorPlayComputer(core, x, place, { grant, outDir, session: windowless(handle) });
}
