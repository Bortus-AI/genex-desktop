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
} as const;
