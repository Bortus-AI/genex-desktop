/**
 * What the Roblox plugin's place tools tell agents: the engine question's words for Roblox (the
 * `engine-status` note) and the answers of `new-game`, `use-project` and `show-steps`.
 */
import { shortVersion } from "./words.ts";

/** The tool that makes a new Roblox game, as the host serves it to agents. */
const NEW_GAME = "roblox__new-game";
const OPTION = `"Roblox game: builds in Roblox Studio on this computer"`;

export const PLACE_PROMPTS = {
  /** The engine question's words while Studio is on this computer. */
  Ready: (version: string | undefined) =>
    `${version ? `Roblox Studio ${shortVersion(version)} is on this computer. ` : ""}Offer ${OPTION}; when the answer (or the request) is Roblox, call ${NEW_GAME}: it makes the game's place in this folder, links this game to it and opens it in Roblox Studio; then build the game there through the Roblox Studio tools, never as a web page.`,
  /** The engine question's words while Studio isn't on this computer. */
  NotInstalled: `Roblox Studio isn't on this computer yet, so offer it as ${OPTION} with the description "Needs Roblox Studio and a Roblox account". If the user picks it, don't call ${NEW_GAME}, which would refuse: tell them to press the Roblox Studio button above the game, which gets Studio from Roblox and sets it up, and to send a message once it's ready.`,
  NewGame: (name: string) =>
    `Made ${name} in this game's folder from Genex's Baseplate, linked this game to it and opened it in Roblox Studio. Studio takes a moment to start; once the Roblox Studio tools answer, build the game there.`,
  NewGameNotOpened: (name: string, why: string) =>
    `Made ${name} in this game's folder and linked this game to it, but Roblox Studio didn't open: ${why}`,
  NoGame: "New Roblox games are made in an open game: there is none here.",
  NoStudio:
    "Roblox Studio isn't on this computer. Tell the person to press the Roblox Studio button above the game to get it.",
  StepsDone: "Every Roblox Studio step is done.",
  StepsShown: "The Roblox Studio setup card is in the chat now. Tell the person which step is left.",
  StepsNoChat: "There is no chat to show the Roblox Studio setup card in.",
} as const;
