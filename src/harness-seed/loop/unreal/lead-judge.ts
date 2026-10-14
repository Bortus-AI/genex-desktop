/**
 * The Unreal lead's `judge_play`: a blind judge plays the game in Unreal's editor and answers one
 * yes/no question, the same judge a web Loop's build and a chat's `judge_play` use
 * (`hands-on-judge.ts`). The studio hands a judge's computer the editor play for an Unreal game, so
 * the leased window only names the judge's screen. Its answer goes to the run's record like any
 * judge's (`recordHandsOn`) and back to the lead in words. The judge never sees the lead's code.
 */
import { WINDOW_RETRIES_MS } from "../config.ts";
import { withLease } from "../evidence.ts";
import { type HandsOnOptions, type HandsOnOutcome, recordHandsOn, runHandsOnJudge } from "../hands-on-judge.ts";
import { HostMethod } from "../host-methods.ts";
import { InteractionObjective } from "../interaction-words.ts";
import { parseGoalState, questId, type Quest } from "../quest.ts";
import { type Check, CheckKind, CheckWeight } from "../spec.ts";
import { hasText } from "../text.ts";
import { MINUTE_MS } from "../time.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import { JUDGE_PLAY_WORDS } from "./lead-judge-prompts.ts";
import type { Lead } from "./lead-journal.ts";

/** How long the judge may play: a director's playtest's default. */
const JUDGE_MS = 5 * MINUTE_MS;
/** The longest question the judge is handed, in characters. */
const MAX_ASK_CHARS = 500;
/** Who put the question on the board, and the facet its frames are filed under. */
const ORIGIN = "unreal-lead";
const FACET = "unreal-judge";
/** The leased window's name in the window strip. */
const WINDOW_LABEL = "judge:unreal";

/** Plays one judge on a leased window: `runHandsOnJudge` there, or why no window came. */
export type JudgePlay = (
  ctx: HarnessCtx,
  options: Omit<HandsOnOptions, "handle">,
) => Promise<HandsOnOutcome | { noWindow: string }>;

/** The judge on a window of the pool, as the chat's judge leases one. */
export const leasedJudge: JudgePlay = async (ctx, options) => {
  const capacity = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  return withLease(ctx, WINDOW_LABEL, (handle) => runHandsOnJudge(ctx, { ...options, handle }), {
    pooled: capacity?.headless !== false,
    retriesMs: WINDOW_RETRIES_MS,
  });
};

/** The goal the judge plays to, or why the goal state cannot be one; null when none was named. */
function questOf(question: string, goalState: unknown): Quest | { error: string } | null {
  const until = parseGoalState(typeof goalState === "string" ? goalState : "");
  if (until === null) return null;
  if ("error" in until) return { error: JUDGE_PLAY_WORDS.goalState(until.error) };
  return { id: questId(question, "goal"), until: until.until };
}

/** The question as the judge's board takes it. */
function checkOf(question: string): Check {
  return {
    id: questId(question, ORIGIN),
    kind: CheckKind.Play,
    ask: question,
    expect: "yes",
    weight: CheckWeight.Normal,
    hard: false,
    note: "",
    origin: ORIGIN,
  };
}

/** The judge's answer in the lead's words. */
function answerWords(played: HandsOnOutcome, check: Check): string {
  const result = played.results[0];
  const note = String(result?.note || result?.reason || "");
  if (!played.trace) return JUDGE_PLAY_WORDS.notPlayed(note);
  const answer = result?.answer === "yes" || result?.answer === "no" ? result.answer : null;
  if (!answer) return JUDGE_PLAY_WORDS.noAnswer(note);
  const verified = played.objectives[check.id] === InteractionObjective.StudioVerified;
  return JUDGE_PLAY_WORDS.answered(answer, verified, note);
}

/** Asks a blind judge from `judge_play`'s arguments; answers what it found, in words. */
export async function askJudge(lead: Lead, args: AnyRecord, play: JudgePlay = leasedJudge): Promise<string> {
  const question = hasText(args.ask) ? args.ask.trim().slice(0, MAX_ASK_CHARS) : "";
  if (!question) return JUDGE_PLAY_WORDS.noAsk;
  const quest = questOf(question, args.goal_state);
  if (quest && "error" in quest) return quest.error;
  const check = checkOf(question);
  const played = await play(lead.ctx, {
    run: lead.run,
    root: lead.game.dir,
    questions: [check],
    quest,
    deadline: lead.clock.now() + JUDGE_MS,
    facetId: FACET,
  });
  if ("noWindow" in played) return JUDGE_PLAY_WORDS.noWindow(played.noWindow);
  await recordHandsOn(lead.ctx, lead.run, played, [check]);
  return answerWords(played, check);
}
