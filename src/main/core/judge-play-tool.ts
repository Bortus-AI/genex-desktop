/**
 * `judge_play` for the chat's own session: an independent, blind judge plays the chat's game and
 * answers one yes/no question, the same judge a Loop's build uses. The host forwards the call to the
 * harness (`chat_judge`, gated on `HarnessCapability.ChatJudge`), which plays it on a hidden window
 * (`harness-seed/loop/chat-judge.ts`), and records the outcome as one line in the chat.
 *
 * The harness is agent-editable, so its "studio-verified" is kept only for a trace the studio itself
 * saw reach the goal (`verified-traces.ts`), once; any other claim is recorded as the judge's word.
 */
import type { ChatJudgeResultPayload } from "../../shared/chat-judge.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import type { LiveToolResult, LiveToolSpec } from "../../shared/engine-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type DispatchAction, DispatchActionType, HarnessCapability } from "../../shared/protocol.ts";
import { InteractionObjective, InteractionStatus } from "../../shared/run-summary.ts";
import { JUDGE_PLAY_ANSWER, JUDGE_PLAY_TOOL } from "./judge-play-tool-prompts.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";
import { takeVerified } from "./verified-traces.ts";

/** How long the session waits for the judge: its five minutes of play, a window, and its start. */
const JUDGE_PLAY_TIMEOUT_MS = 8 * MINUTE_MS;
/** The longest question forwarded, and the longest note recorded, in characters. */
const MAX_ASK_CHARS = 500;
const MAX_NOTE_CHARS = 600;
/** What the harness answers with when it played and came back with nothing readable. */
const UNREADABLE = "the judge's answer could not be read";

const STATUSES: ReadonlySet<unknown> = new Set(Object.values(InteractionStatus));

/** Is this one of the statuses an interaction ends with? */
const isStatus = (value: unknown): value is InteractionStatus => STATUSES.has(value);

/** What the tool needs of the studio: the harness's capability, its dispatch, and the chat's record. */
export interface JudgePlayHost {
  hasCapability(capability: HarnessCapability): boolean;
  dispatch(action: DispatchAction, timeoutMs: number): Promise<unknown>;
  record(threadId: string, payload: ChatJudgeResultPayload): Promise<void>;
}

/** Whose call it is: the game, its folder as the host resolved it, the chat its line goes to, and the chat's model. */
export interface JudgePlayCaller {
  project: string;
  root: string;
  threadId: string;
  engine: string;
  model?: string | undefined;
  effort?: string | undefined;
}

/** The harness's answer, read field by field: nothing it sent is taken on trust. */
interface JudgeAnswer {
  status: InteractionStatus;
  answer: "yes" | "no" | null;
  note: string;
  claimsVerified: boolean;
  trace: string | null;
  refusal: string | null;
}

/** `judge_play` for the chat's own session where the harness serves it; nothing for any other. */
export function judgePlayFor(chatsOwn: boolean, capable: boolean): LiveToolSpec[] {
  return chatsOwn && capable ? [JUDGE_PLAY_TOOL] : [];
}

/** A string field, or "". */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The harness's answer as an outcome, or null when it sent nothing that reads as one. */
function readAnswer(value: unknown): JudgeAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  if (!isStatus(status)) return null;
  const answer = row.answer === "yes" || row.answer === "no" ? row.answer : null;
  return {
    status,
    answer,
    note: text(row.note).slice(0, MAX_NOTE_CHARS),
    claimsVerified: row.objective === InteractionObjective.StudioVerified,
    trace: text(row.trace) || null,
    refusal: text(row.refusal) || null,
  };
}

/** The goal state as the harness reads it: a JSON string, whatever shape the session sent it in. */
function goalStateOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The line the chat keeps, with the objective the studio vouches for. */
function lineOf(caller: JudgePlayCaller, ask: string, read: JudgeAnswer, verified: boolean): ChatJudgeResultPayload {
  return {
    project: caller.project,
    ask,
    status: read.status,
    answer: read.answer,
    note: read.note,
    objective: verified ? InteractionObjective.StudioVerified : InteractionObjective.ModelSaid,
    ...(read.refusal && !read.answer ? { refusal: read.refusal } : {}),
  };
}

/** What the session reads back: the outcome in words, or why nothing was played. */
function answerWords(read: JudgeAnswer, verified: boolean): string {
  if (read.refusal && !read.answer) return JUDGE_PLAY_ANSWER.notPlayed(read.refusal);
  const rests = verified ? JUDGE_PLAY_ANSWER.verified : JUDGE_PLAY_ANSWER.modelSaid;
  const status = read.status.charAt(0).toUpperCase() + read.status.slice(1);
  return JUDGE_PLAY_ANSWER.answered(status, read.answer ?? "nothing", rests, read.note);
}

/** One judge's play of the chat's game, recorded in its chat, answered to the session. */
export async function runJudgePlay(
  host: JudgePlayHost,
  args: Record<string, unknown>,
  caller: JudgePlayCaller,
): Promise<LiveToolResult> {
  if (!host.hasCapability(HarnessCapability.ChatJudge)) return JUDGE_PLAY_ANSWER.unavailable;
  const ask = text(args.ask).trim().slice(0, MAX_ASK_CHARS);
  if (!ask) return JUDGE_PLAY_ANSWER.noAsk;
  const goalState = goalStateOf(args.goal_state);
  const action: DispatchAction = {
    type: DispatchActionType.ChatJudge,
    threadId: caller.threadId,
    project: caller.project,
    root: caller.root,
    engine: caller.engine,
    ...(caller.model ? { model: caller.model } : {}),
    ...(caller.effort ? { effort: caller.effort } : {}),
    ask,
    ...(goalState ? { goalState } : {}),
  };
  let read: JudgeAnswer | null;
  try {
    read = readAnswer(await host.dispatch(action, JUDGE_PLAY_TIMEOUT_MS));
  } catch (error) {
    return { text: JUDGE_PLAY_ANSWER.failed(errorMessage(error)), isError: true };
  }
  if (!read) return { text: JUDGE_PLAY_ANSWER.failed(UNREADABLE), isError: true };
  // The studio's word, not the harness's: a trace it saw reach the goal vouches once.
  const verified = read.claimsVerified && takeVerified(read.trace) !== null;
  await host.record(caller.threadId, lineOf(caller, ask, read, verified));
  return answerWords(read, verified);
}

/** The studio as `judge_play` reaches it: the harness's capability and dispatch, and the chat's line. */
export function studioJudgeHost(core: Pick<StudioCore, "host" | "append" | "emit">): JudgePlayHost {
  return {
    hasCapability: (capability) => core.host.hasCapability(capability),
    dispatch: (action, timeoutMs) => core.host.dispatch(action, timeoutMs),
    record: async (threadId, payload) => {
      await core.append([customEventData(CustomEvent.ChatJudgeResult, payload)], threadId);
      core.emit(UiEvent.ThreadUpdated, { threadId, project: payload.project });
    },
  };
}
