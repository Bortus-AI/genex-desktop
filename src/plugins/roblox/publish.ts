/**
 * Publish an update: the one Do it for me that isn't a setup click. No Studio or plugin API publishes
 * a place, and Open Cloud's place publishing takes API keys Genex never asks for, so the person's own
 * computer control clicks File › Publish to Roblox in their Studio: Genex hands the game's chat that
 * task through `game.engine.assist`. Only the person starts it, by the panel's action they pressed or
 * by the agent's `publish-update` call whose card they approved; the host refuses anything else.
 * Computer control is a Mac's only: on Windows, or with no driver, the answer gives Studio's click
 * path. A place never published (its link has no `remote` ids) gets the first publish's click path
 * and no assist: Roblox asks for the game's details and an age check there, which stay the person's.
 */
import type {
  PluginEngineAssistAnswer,
  PluginEngineAssistRefusal,
  PluginEngineLink,
  PluginReview,
} from "../../plugin-sdk/index.d.ts";
import { PUBLISH_PROMPTS } from "./publish-prompts.ts";
import { MESSAGE, PUBLISH_CLICK_PATH } from "./words.ts";

export { PUBLISH_CLICK_PATH };

/** A place name at most this long goes into the task whole; a longer one is cut, so the task stays one short line. */
const MAX_TASK_NAME_CHARS = 60;
/** The last character code of the ASCII controls, and DEL. */
const LAST_CONTROL = 0x1f;
const DELETE = 0x7f;

/** Who asked to publish, which decides the answer's words. Wire values: never rename. */
export const PublishAsker = {
  /** The person pressed Publish an update in the panel. */
  Person: "person",
  /** An agent called `publish-update` and the person approved its card. */
  Agent: "agent",
} as const;
export type PublishAsker = (typeof PublishAsker)[keyof typeof PublishAsker];

/** Why nothing was handed to the chat, before the host was asked. Wire values: never rename. */
export const PublishMiss = {
  NoPlace: "no-place",
  /** The place was never published: its first publish is the person's. */
  FirstPublish: "first-publish",
} as const;
export type PublishMiss = (typeof PublishMiss)[keyof typeof PublishMiss];

/** The game's place as publishing sees it: its link (ids when published) and its name. */
export interface PublishPlace {
  link: PluginEngineLink | null;
  name?: string;
}

/** What publishing asks of the host and of the game's helper. */
export interface PublishDeps {
  assist(task: string): Promise<PluginEngineAssistAnswer>;
  /** Sends the script files changed and not yet in Studio, so the update holds them. */
  flush?(): Promise<void>;
}

/** Publish an update's answer: handed to the chat, or why not and Studio's own click path. */
export interface PublishAnswer {
  started: boolean;
  message: string;
  reason?: PublishMiss | PluginEngineAssistRefusal;
  clickPath?: string;
}

/** A place's name as one plain line, cut to its length: control characters become spaces. */
function plainName(name: string | undefined): string {
  const plain = [...(name ?? "")]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= LAST_CONTROL || code === DELETE ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAX_TASK_NAME_CHARS ? `${plain.slice(0, MAX_TASK_NAME_CHARS - 1)}…` : plain;
}

/**
 * The task the game's chat is asked, shown verbatim in the chat: the place, Studio's own clicks, and
 * where the turn stops (anything Roblox asks beyond the publish is the person's).
 */
export function publishTask(name: string | undefined): string {
  const place = plainName(name) || "this place";
  return `Publish ${place} to Roblox: ${PUBLISH_CLICK_PATH} in its Roblox Studio window. If Roblox asks for the game's details, an age check or a sign-in, stop and tell the person.`;
}

/** Each asker's words for each answer. */
const WORDS = {
  [PublishAsker.Person]: MESSAGE.Publish,
  [PublishAsker.Agent]: PUBLISH_PROMPTS,
} as const satisfies Record<PublishAsker, Record<keyof typeof PUBLISH_PROMPTS, string>>;

/** The host's refusals that have words of their own; any other gets "nothing was published". */
const REFUSAL_WORDS = {
  unavailable: "Unavailable",
  declined: "Declined",
  "no-chat": "NoChat",
} as const satisfies Partial<Record<PluginEngineAssistRefusal, keyof typeof PUBLISH_PROMPTS>>;

const hasWords = (reason: PluginEngineAssistRefusal): reason is keyof typeof REFUSAL_WORDS => reason in REFUSAL_WORDS;

/** What the host's refusal says to whoever asked, with Studio's click path. */
function refusedAnswer(answer: PluginEngineAssistAnswer, asker: PublishAsker): PublishAnswer {
  const reason = answer.reason;
  const words = reason && hasWords(reason) ? REFUSAL_WORDS[reason] : "NotStarted";
  const refused: PublishAnswer = { started: false, message: WORDS[asker][words], clickPath: PUBLISH_CLICK_PATH };
  if (reason) refused.reason = reason;
  return refused;
}

/**
 * Publish an update of the game's place: a published place's task goes to the game's chat once its
 * changed script files are in Studio; a place never published, or no place, asks the host nothing.
 */
export async function publishUpdate(
  place: PublishPlace,
  deps: PublishDeps,
  asker: PublishAsker,
): Promise<PublishAnswer> {
  const words = WORDS[asker];
  if (!place.link) return { started: false, message: words.NoPlace, reason: PublishMiss.NoPlace };
  if (!place.link.remote)
    return {
      started: false,
      message: words.FirstPublish,
      reason: PublishMiss.FirstPublish,
      clickPath: PUBLISH_CLICK_PATH,
    };
  // Studio holds the scripts it last had when a send fails; the publish goes on with those.
  await deps.flush?.().catch(() => undefined);
  const answer = await deps.assist(publishTask(place.name));
  return answer.started ? { started: true, message: words.Started } : refusedAnswer(answer, asker);
}

/** The panel's card for a published place: its name and what publishing does; a first publish keeps the manifest's. */
export function reviewPublish(place: PublishPlace): PluginReview {
  if (!place.link?.remote) return {};
  const name = plainName(place.name) || plainName(place.link.name) || "this game's place";
  return { message: MESSAGE.Publish.Confirm(name), detail: MESSAGE.Publish.Plan };
}
