/**
 * A judge that plays, asked for by the chat's own session (`judge_play`): the outcome its chat line
 * records (`chat_judge_result`, written by the host only), in the words of a build's checks list.
 */
import { InteractionObjective, InteractionStatus } from "./run-summary.ts";

/** The tool's name, as the chat's own session calls it and its tool row is worded. */
export const JUDGE_PLAY_TOOL_NAME = "judge_play";

/** What a chat's judge established, as its chat line keeps it. */
export type ChatJudgeResultPayload = {
  project: string;
  /** The question the judge was asked. */
  ask: string;
  status: InteractionStatus;
  answer: "yes" | "no" | null;
  /** The judge's own note, cut at a word. */
  note: string;
  /** Verified by the studio only for a trace the studio itself saw reach the goal. */
  objective: InteractionObjective;
  /** Why nothing was played, when nothing was. */
  refusal?: string;
};

const STATUSES: ReadonlySet<unknown> = new Set(Object.values(InteractionStatus));
const OBJECTIVES: ReadonlySet<unknown> = new Set(Object.values(InteractionObjective));

/** Is this one of the statuses an interaction ends with? */
const isStatus = (value: unknown): value is InteractionStatus => STATUSES.has(value);
/** Is this one of the things an interaction rests on? */
const isObjective = (value: unknown): value is InteractionObjective => OBJECTIVES.has(value);

/** A recorded line, read field by field; null for a record too old or partial to say what happened. */
export function readChatJudgeResult(payload: Partial<ChatJudgeResultPayload> | null): ChatJudgeResultPayload | null {
  if (!payload || !isStatus(payload.status) || typeof payload.ask !== "string") return null;
  const answer = payload.answer === "yes" || payload.answer === "no" ? payload.answer : null;
  return {
    project: typeof payload.project === "string" ? payload.project : "",
    ask: payload.ask,
    status: payload.status,
    answer,
    note: typeof payload.note === "string" ? payload.note : "",
    objective: isObjective(payload.objective) ? payload.objective : InteractionObjective.ModelSaid,
    ...(typeof payload.refusal === "string" && payload.refusal ? { refusal: payload.refusal } : {}),
  };
}
