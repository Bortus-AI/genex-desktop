/**
 * What `publish-update` tells the agent that called it: that the publish is handed to the game's
 * chat, or why not and what to tell the person instead (Studio's own click path).
 */
import { PUBLISH_CLICK_PATH } from "./words.ts";

/** What the person can do in Studio themselves, as the agent passes it on. */
const YOURSELF = `Tell the person they can publish it themselves in Studio: ${PUBLISH_CLICK_PATH}.`;

export const PUBLISH_PROMPTS = {
  Started: `The person's OK is recorded: this chat's next message asks to publish the place, and that turn clicks ${PUBLISH_CLICK_PATH} in Roblox Studio with computer control. End this turn now; don't click anything yourself.`,
  Unavailable: `Genex can't click in Roblox Studio on this computer (computer control works on a Mac only), so nothing was published. ${YOURSELF}`,
  Declined: `The person said no to computer control, so nothing was published. ${YOURSELF}`,
  NoChat: `There's no chat to publish from, so nothing was published. ${YOURSELF}`,
  NotStarted: `Nothing was published. ${YOURSELF}`,
  FirstPublish: `This place has never been published, and its first publish is the person's own: Roblox asks for the game's details and may ask for an age check. Nothing was clicked. Tell them: in Studio, ${PUBLISH_CLICK_PATH}; then Choose another place and Use in this game in the Roblox Studio panel, so later updates can be published from here.`,
  NoPlace: "This game doesn't build in a Roblox place yet, so there's nothing to publish.",
} as const;
