/**
 * Every tool Roblox Studio's own MCP server (StudioMCP 0.743) offers, and what Genex does with it.
 *
 * - Reads pass through the Roblox Studio connection with no card; `execute_luau` passes as a write.
 * - Play-lane tools stay hidden: only Genex's six play tools drive Studio's one play session.
 * - `multi_edit` stays hidden because scripts are the game's `.luau` files, kept in step by Genex.
 * - `http_get` stays hidden: Studio would fetch any address for the agent, a path for leaking data
 *   and for instructions planted on a page. Agents use Genex's own web tools.
 * - `list_roblox_studios` is the connection's own: it pins every call to this game's Studio.
 * - Inserts, uploads and Roblox's AI tools are plugin tools that ask the person every time, so
 *   they never reach the connection, whose cards Auto and Bypass skip.
 *
 * A tool this table doesn't know (a newer Studio's) passes as a write, never as a read.
 */

/** What Genex does with a Studio tool. Wire values: never rename. */
export const StudioToolClass = {
  /** Passed through with no card. */
  Read: "read",
  /** Passed through as a write: the connection's card rules apply, and the agent's work is marked. */
  Write: "write",
  /** Only Genex's play tools use them. */
  PlayLane: "play-lane",
  /** Scripts change through the `.luau` files. */
  CodeIsFiles: "code-is-files",
  /** Studio fetching any address for the agent. */
  Network: "network",
  /** The connection's own, for pinning the Studio. */
  Bridge: "bridge",
  /** A plugin tool that asks first: a Creator Store insert. */
  ConfirmedInsert: "confirmed-insert",
  /** A plugin tool that asks first: Roblox's AI tools, run on the person's account. */
  ConfirmedAi: "confirmed-ai",
  /** A plugin tool that asks first: an upload to the person's account. */
  ConfirmedUpload: "confirmed-upload",
} as const;
export type StudioToolClass = (typeof StudioToolClass)[keyof typeof StudioToolClass];

/** Studio's tool names, as StudioMCP 0.743 lists them. Wire values: never rename. */
export const StudioTool = {
  SearchGameTree: "search_game_tree",
  InspectInstance: "inspect_instance",
  ScriptRead: "script_read",
  ScriptSearch: "script_search",
  ScriptGrep: "script_grep",
  GetConsoleOutput: "get_console_output",
  GetStudioState: "get_studio_state",
  ScreenCapture: "screen_capture",
  ListPluginGuis: "list_plugin_guis",
  CapturePluginGui: "capture_plugin_gui",
  SearchAsset: "search_asset",
  Skill: "skill",
  WaitJobFinished: "wait_job_finished",
  ExecuteLuau: "execute_luau",
  StartStopPlay: "start_stop_play",
  UserKeyboardInput: "user_keyboard_input",
  UserMouseInput: "user_mouse_input",
  CharacterNavigation: "character_navigation",
  MultiEdit: "multi_edit",
  HttpGet: "http_get",
  ListRobloxStudios: "list_roblox_studios",
  InsertAsset: "insert_asset",
  GenerateMesh: "generate_mesh",
  GenerateProceduralModel: "generate_procedural_model",
  GenerateTexture: "generate_texture",
  GenerateMaterial: "generate_material",
  SegmentMesh: "segment_mesh",
  Subagent: "subagent",
  UploadImage: "upload_image",
  StoreImage: "store_image",
} as const;
export type StudioTool = (typeof StudioTool)[keyof typeof StudioTool];

/** The arguments every Studio tool but the list takes: which open Studio the call is for. */
export const STUDIO_ID_ARG = "studio_id";
/** The data model a call runs in (Edit, Client or Server), on the tools that take one. */
export const DATAMODEL_ARG = "datamodel_type";
/** The data model a connection call runs in unless the agent names another: the person's place. */
export const EDIT_DATAMODEL = "Edit";
/** A picture's name on `screen_capture`, which StudioMCP requires. */
export const CAPTURE_ID_ARG = "capture_id";

/** One tool's class and the arguments StudioMCP 0.743 requires of it. */
export interface StudioToolEntry {
  class: StudioToolClass;
  required: readonly string[];
}

const C = StudioToolClass;
const T = StudioTool;
const ID = STUDIO_ID_ARG;
const DM = DATAMODEL_ARG;

/** Decision table: every recorded tool with its class and required arguments. */
export const STUDIO_TOOLS = {
  [T.SearchGameTree]: { class: C.Read, required: [DM, ID] },
  [T.InspectInstance]: { class: C.Read, required: ["path", ID] },
  [T.ScriptRead]: { class: C.Read, required: ["target_file", ID] },
  [T.ScriptSearch]: { class: C.Read, required: ["keywords", ID] },
  [T.ScriptGrep]: { class: C.Read, required: ["query", ID] },
  [T.GetConsoleOutput]: { class: C.Read, required: [ID] },
  [T.GetStudioState]: { class: C.Read, required: [ID] },
  [T.ScreenCapture]: { class: C.Read, required: [CAPTURE_ID_ARG, ID] },
  [T.ListPluginGuis]: { class: C.Read, required: [ID] },
  [T.CapturePluginGui]: { class: C.Read, required: ["plugin_gui_id", ID] },
  [T.SearchAsset]: { class: C.Read, required: [ID] },
  [T.Skill]: { class: C.Read, required: ["skill_name", ID] },
  [T.WaitJobFinished]: { class: C.Read, required: ["jobId", ID] },
  [T.ExecuteLuau]: { class: C.Write, required: ["code", DM, ID] },
  [T.StartStopPlay]: { class: C.PlayLane, required: ["is_start", ID] },
  [T.UserKeyboardInput]: { class: C.PlayLane, required: ["actions", DM, ID] },
  [T.UserMouseInput]: { class: C.PlayLane, required: ["actions", DM, ID] },
  [T.CharacterNavigation]: { class: C.PlayLane, required: [DM, ID] },
  [T.MultiEdit]: { class: C.CodeIsFiles, required: ["file_path", "edits", DM, ID] },
  [T.HttpGet]: { class: C.Network, required: ["url", ID] },
  [T.ListRobloxStudios]: { class: C.Bridge, required: [] },
  [T.InsertAsset]: { class: C.ConfirmedInsert, required: ["assetId", ID] },
  [T.GenerateMesh]: { class: C.ConfirmedAi, required: ["textPrompt", ID] },
  [T.GenerateProceduralModel]: { class: C.ConfirmedAi, required: ["prompt", ID] },
  [T.GenerateTexture]: { class: C.ConfirmedAi, required: ["textPrompt", ID] },
  [T.GenerateMaterial]: {
    class: C.ConfirmedAi,
    required: ["materialPattern", "materialId", "baseMaterial", "materialDescription", ID],
  },
  [T.SegmentMesh]: { class: C.ConfirmedAi, required: ["parts", ID] },
  [T.Subagent]: { class: C.ConfirmedAi, required: ["task", "description", "subagent_type", ID] },
  [T.UploadImage]: { class: C.ConfirmedUpload, required: ["imagePaths", ID] },
  [T.StoreImage]: { class: C.ConfirmedUpload, required: ["filePath", ID] },
} as const satisfies Record<StudioTool, StudioToolEntry>;

const KNOWN: ReadonlyMap<string, StudioToolEntry> = new Map(Object.entries(STUDIO_TOOLS));

/** A tool's class; one the table doesn't know is a write. */
export function classOf(name: string): StudioToolClass {
  return KNOWN.get(name)?.class ?? StudioToolClass.Write;
}

/** Whether the connection offers a tool of this class: reads and writes only. */
export function passesThrough(kind: StudioToolClass): boolean {
  return kind === StudioToolClass.Read || kind === StudioToolClass.Write;
}

/** The read tools by name, as the manifest's `reads` lists them. */
export const READ_TOOLS: readonly StudioTool[] = (Object.keys(STUDIO_TOOLS) as StudioTool[]).filter(
  (name) => STUDIO_TOOLS[name].class === StudioToolClass.Read,
);
