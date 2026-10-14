/**
 * `judge_play` on the host: what it forwards to the harness, what it records in the chat, and that
 * "verified by the studio" holds only for a trace the studio itself saw reach the goal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatJudgeResultPayload } from "../../src/shared/chat-judge.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import { type DispatchAction, HarnessCapability } from "../../src/shared/protocol.ts";
import { type JudgePlayHost, runJudgePlay } from "../../src/main/core/judge-play-tool.ts";
import { markVerified } from "../../src/main/core/verified-traces.ts";

const CALLER = {
  project: "star-dash",
  threadId: "thread-7",
  root: "/games/star-dash",
  engine: "claude-code",
  model: "sonnet",
} as const;

/** A host with the chat's judge, answering every dispatch with `answer`, recording every line. */
function fakeHost(answer: unknown, options: { capable?: boolean; throws?: Error } = {}) {
  const sent: DispatchAction[] = [];
  const lines: Array<{ threadId: string; payload: ChatJudgeResultPayload }> = [];
  const host: JudgePlayHost = {
    hasCapability: (capability) => capability === HarnessCapability.ChatJudge && options.capable !== false,
    dispatch: async (action) => {
      sent.push(action);
      if (options.throws) throw options.throws;
      return answer;
    },
    record: async (threadId, payload) => {
      lines.push({ threadId, payload });
    },
  };
  return { host, sent, lines };
}

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

describe("judge_play on the host", () => {
  it("forwards one question and its goal state to the harness for the chat's game, as the host resolved it", async () => {
    const { host, sent } = fakeHost({
      status: "passed",
      answer: "yes",
      note: "",
      objective: "model-said",
      trace: null,
    });
    await runJudgePlay(
      host,
      { ask: "  Can you reach the star?  ", goal_state: { path: "flow.phase", equals: "won" } },
      CALLER,
    );
    assert.deepEqual(sent, [
      {
        type: "chat_judge",
        threadId: "thread-7",
        project: "star-dash",
        root: "/games/star-dash",
        engine: "claude-code",
        model: "sonnet",
        ask: "Can you reach the star?",
        goalState: '{"path":"flow.phase","equals":"won"}',
      },
    ]);
  });

  it("forwards nothing to a harness without the chat's judge, or for a call with no question", async () => {
    const old = fakeHost({}, { capable: false });
    assert.match(text(await runJudgePlay(old.host, { ask: "Can you win?" }, CALLER)), /not available/);
    const empty = fakeHost({});
    assert.match(text(await runJudgePlay(empty.host, { ask: "  " }, CALLER)), /needs ask/);
    assert.deepEqual([old.sent.length, empty.sent.length, old.lines.length, empty.lines.length], [0, 0, 0, 0]);
  });

  it("keeps 'verified by the studio' only for the trace the studio itself saw reach the goal, once", async () => {
    const trace = `/runs/adhoc/facet_chat-judge/playtest/iter_000/trace-${Date.now()}.jsonl`;
    markVerified(trace, "can-you-reach-the-star");
    const claim = {
      status: "passed",
      answer: "yes",
      note: "Went round the bottom.",
      objective: "studio-verified",
      trace,
    };
    const seen = fakeHost(claim);
    const result = text(await runJudgePlay(seen.host, { ask: "Can you reach the star?" }, CALLER));
    assert.match(result, /verified by the studio/);
    assert.deepEqual(seen.lines, [
      {
        threadId: "thread-7",
        payload: {
          project: "star-dash",
          ask: "Can you reach the star?",
          status: "passed",
          answer: "yes",
          note: "Went round the bottom.",
          objective: "studio-verified",
        },
      },
    ]);
    // The same claim again: the trace vouched once already, so this is the judge's word.
    const again = fakeHost(claim);
    assert.match(text(await runJudgePlay(again.host, { ask: "Can you reach the star?" }, CALLER)), /judge's word/);
    assert.equal(again.lines[0]?.payload.objective, "model-said");
    // A claim on a trace the studio never marked is the judge's word too.
    const forged = fakeHost({ ...claim, trace: "/runs/adhoc/forged.jsonl" });
    await runJudgePlay(forged.host, { ask: "Can you reach the star?" }, CALLER);
    assert.equal(forged.lines[0]?.payload.objective, "model-said");
  });

  it("says why nothing was played, and records that in the chat", async () => {
    const refused = fakeHost({
      status: "incomplete",
      answer: null,
      note: "",
      objective: "model-said",
      trace: null,
      refusal: "No hidden window is free to play in right now.",
    });
    const result = text(await runJudgePlay(refused.host, { ask: "Can you win?" }, CALLER));
    assert.match(result, /did not play: No hidden window/);
    assert.equal(refused.lines[0]?.payload.status, "incomplete");
    assert.equal(refused.lines[0]?.payload.refusal, "No hidden window is free to play in right now.");
  });

  it("answers a failed or unreadable dispatch as an error, and records no outcome it does not have", async () => {
    const failed = fakeHost(null, { throws: new Error("harness restarted") });
    const result = await runJudgePlay(failed.host, { ask: "Can you win?" }, CALLER);
    assert.equal(typeof result === "string" ? false : result.isError, true);
    assert.match(text(result), /harness restarted/);
    const garbled = fakeHost("not an outcome");
    assert.match(text(await runJudgePlay(garbled.host, { ask: "Can you win?" }, CALLER)), /failed/);
    assert.deepEqual([failed.lines.length, garbled.lines.length], [0, 0]);
  });
});
