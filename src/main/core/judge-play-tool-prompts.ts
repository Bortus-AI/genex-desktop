/**
 * What the chat's own session reads of `judge_play` (`judge-play-tool.ts`): the tool, and the
 * sentences it answers with.
 */
import { JUDGE_PLAY_TOOL_NAME } from "../../shared/chat-judge.ts";
import type { LiveToolSpec } from "../../shared/engine-requests.ts";

/** The tool: an independent, blind check of the game as it is now, by playing it. */
export const JUDGE_PLAY_TOOL: LiveToolSpec = {
  name: JUDGE_PLAY_TOOL_NAME,
  description:
    "Have an independent judge play this game and answer one yes/no question about it. Use it when the person asks for a change to be checked by someone other than you (a judge, a playtest, “make sure someone can win”). The judge is blind: it sees only the game's screen, never the code, and plays the folder as it is now in a hidden window of its own. When the question has a state the game reaches, pass goal_state: the studio checks it after every move, and a yes is verified by the studio. It takes a few minutes; play the game yourself for your own checks.",
  parameters: {
    type: "object",
    properties: {
      ask: {
        type: "string",
        description: "One yes/no question the judge can settle by playing, e.g. “Can you reach the star and win?”",
      },
      goal_state: {
        type: "string",
        description:
          'Optional JSON: the state the game reaches when the answer is yes, e.g. {"path":"flow.phase","equals":"won"} or {"path":"level.cleared","truthy":true}.',
      },
    },
    required: ["ask"],
  },
};

/** What the session is told. */
export const JUDGE_PLAY_ANSWER = {
  unavailable: "judge_play is not available in this studio right now: play the game yourself.",
  noAsk: "judge_play needs ask: one yes/no question the judge can settle by playing.",
  notPlayed: (why: string) => `The judge did not play: ${why}`,
  failed: (why: string) => `judge_play failed: ${why}`,
  verified: "verified by the studio: it saw the goal state reached",
  modelSaid: "on the judge's word: the studio did not see a goal state reached",
  answered: (status: string, answer: string, rests: string, note: string) =>
    `${status}. The judge answered ${answer}, ${rests}.${note ? ` Its note: ${note}` : ""}`,
} as const;
