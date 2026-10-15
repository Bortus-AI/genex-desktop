/**
 * What the Roblox Studio plugin says to the person: the toolbar button's words for each state of
 * Studio, and its refusals. Plain words; never the Roblox logo or a promise for later.
 */

/** Studio's version as people read it: its first two parts (0.743 of 0.743.0.7431133). */
export const shortVersion = (version: string) => version.split(".").slice(0, 2).join(".");

/** Where Studio's own MCP switch is, as the person clicks it. */
export const MCP_SWITCH_CLICK_PATH = "Assistant › ⋯ › Settings › MCP Servers › Enable Studio as MCP server";

export const MESSAGE = {
  UnknownAction: (name: string) => `Unknown Roblox Studio action: ${name}`,
  UnknownTool: (name: string) => `Unknown Roblox Studio tool: ${name}`,
  Badge: {
    Get: "Not installed",
    SetUp: "Set up",
    NotOpen: "Not open",
    Starting: "Starting",
    Ready: "Ready",
  },
  Title: {
    Get: "Roblox Studio isn't on this computer. Open this to get it.",
    SetUp: "Add the Genex helper to Roblox Studio and turn on its MCP server.",
    NotOpen: (version: string | undefined) =>
      version
        ? `Roblox Studio ${shortVersion(version)} is set up but not open.`
        : "Roblox Studio is set up but not open.",
    Starting: "Roblox Studio is open. Genex is waiting for it to answer.",
    Ready: "Roblox Studio is open and answering Genex.",
  },
  Setup: {
    Confirm: "Add the Genex helper to Roblox Studio's Plugins folder and turn on Studio's MCP server?",
    StudioRunning:
      "Roblox Studio is open. Genex changes Studio's settings only while it is closed: press Restart Studio, let Genex click the switch for you, or click it yourself.",
    OtherSystem: "Genex can't find this computer's Roblox folders: its home folder isn't a full path of this system.",
    NoRobloxFolder: (folder: string) => `${folder} isn't there yet. Open Roblox Studio once, then press Set up again.`,
    Linked: (file: string) =>
      `${file} is a link, so Genex leaves it alone. Make it a real folder or file, then press Set up again.`,
    NotAFolder: (file: string) => `Something Genex doesn't expect is at ${file}, so Genex leaves it alone.`,
    Unreadable: (file: string) =>
      `Genex can't read ${file} as Roblox Studio's settings, so it changes no settings file. Turn Studio's MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    NotSettings: "These aren't Roblox Studio's settings: Studio keeps one JSON object.",
    TwiceNamed: (key: string) => `The settings name "${key}" twice, so Genex leaves them alone.`,
    NotSetUp: "Genex hasn't set up Roblox Studio on this computer, so there's nothing to undo.",
    DocumentsNote: "macOS may ask to let Genex use your Documents folder: Roblox keeps its plugins there.",
    PlanHelper: (folder: string) => `Add the Genex helper to ${folder}.`,
    PlanSwitch: (count: number) =>
      `Turn on Studio's MCP server in the settings of ${count} Roblox ${count === 1 ? "account" : "accounts"} on this computer.`,
    PlanNoSettings: `Studio hasn't saved its settings yet, so turn its MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    PlanUndo: "Genex keeps what was there first, and Undo Set up takes these changes back.",
    Done: "The Genex helper is in Studio's Plugins folder and Studio's MCP server is on.",
    DoneNoSettings: `The Genex helper is in Studio's Plugins folder. Turn Studio's MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    NewerHelper: "A newer Genex helper is already in Studio's Plugins folder, so Genex left it.",
    Undone: "Genex took back what it set up in Roblox Studio.",
    UndoneKept: (count: number) =>
      `Genex took back what it set up in Roblox Studio and left ${count} ${count === 1 ? "file" : "files"} changed since as they are.`,
    NotInstalled: "Roblox Studio isn't on this computer.",
    StillOpen:
      "Roblox Studio is still open. If it asked to save your place, answer it, then press Restart Studio again.",
    Reopened: "Roblox Studio is opening again with the Genex helper.",
  },
  Choice: {
    RestartStudio: "Restart Studio",
    DoItForMe: "Do it for me",
  },
  Assist: {
    /** The task the game's chat is asked to click, verbatim in the chat: plain words, then Studio's own click path. */
    Task: `Turn on Studio's MCP server: ${MCP_SWITCH_CLICK_PATH}`,
    Started: "This game's chat is turning on Studio's MCP server. Watch Roblox Studio.",
    Unavailable: `Genex can't click in Roblox Studio on this computer. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    Declined: `Nothing was clicked. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    NoChat: `Open a game first, so its chat can click it for you, or turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    NotStarted: `Genex didn't click anything. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
  },
} as const;
