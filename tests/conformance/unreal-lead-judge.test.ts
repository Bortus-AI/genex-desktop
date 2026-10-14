/**
 * The Unreal lead's `judge_play` (loop/unreal/lead-judge.ts): a blind judge plays the game folder in
 * Unreal's editor and answers one yes/no question, which goes to the run's record and back to the
 * lead in words; a studio-verified yes says so. A question it can't take is refused before any play.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandsOnOutcome } from "../../src/harness-seed/loop/hands-on-judge.ts";
import { InteractionObjective } from "../../src/harness-seed/loop/interaction-words.ts";
import { askJudge, type JudgePlay } from "../../src/harness-seed/loop/unreal/lead-judge.ts";
import { LEAD_TOOLS } from "../../src/harness-seed/loop/unreal/lead-tools.ts";
import type { Lead } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const RUN = {
  runId: "run-lead",
  goal: "A lighthouse on a stormy coast",
  project: "night-spire",
  budgets: {},
} as unknown as Run;
const GAME_DIR = "/games/night-spire";

/** A lead whose judge plays as `outcome` says (or finds no window), recording what it was asked. */
function leadWithJudge(outcome: Partial<HandsOnOutcome> | { noWindow: string } | null) {
  const rec = ctxRecorder({ handlers: { "events.append": () => "e1" } });
  const asked: Array<Parameters<JudgePlay>[1]> = [];
  const play: JudgePlay = async (_ctx, options) => {
    asked.push(options);
    if (outcome && "noWindow" in outcome) return outcome;
    const id = options.questions[0]?.id ?? "";
    return {
      results: [{ id, answer: "yes", pass: true, note: "Climbed to the door in 14 s.", reason: "" }],
      objective: InteractionObjective.ModelSaid,
      objectives: { [id]: InteractionObjective.ModelSaid },
      trace: { path: "/runs/run-lead/trace.jsonl", actions: 12 },
      frames: {},
      report: {},
      ...outcome,
    } as unknown as HandsOnOutcome;
  };
  const lead = {
    ctx: rec.ctx as unknown as HarnessCtx,
    run: RUN,
    threadId: "t1",
    clock: { now: () => 1_000 },
    game: { dir: GAME_DIR, title: "Night Spire" },
  } as unknown as Lead;
  const recorded = () =>
    rec
      .paramsOf("events.append")
      .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>)
      .filter((event) => event.event_type === "run_interaction_evidence");
  return { lead, play, asked, recorded };
}

describe("the Unreal lead's judge_play", () => {
  it("is one of the lead's run tools, asking one yes/no question and an optional goal state", () => {
    const tool = LEAD_TOOLS.find((spec) => spec.name === "judge_play");
    assert.ok(tool, "offered to the lead");
    assert.match(tool.description, /blind judge plays the game in Unreal's editor/);
    assert.deepEqual((tool.parameters as { required?: string[] }).required, ["ask"]);
  });

  it("has the judge play the game folder blind, and writes its answer to the run's record", async () => {
    const { lead, play, asked, recorded } = leadWithJudge(null);
    const words = await askJudge(lead, { ask: "Can the player climb to the lighthouse door?" }, play);
    assert.equal(words, "The judge answered yes: Climbed to the door in 14 s.");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.root, GAME_DIR);
    assert.equal(asked[0]?.run, RUN);
    assert.equal(asked[0]?.questions[0]?.ask, "Can the player climb to the lighthouse door?");
    assert.equal(asked[0]?.quest, null);
    const [record] = recorded();
    assert.equal(record?.payload.label, "Can the player climb to the lighthouse door?");
  });

  it("plays to a goal state and says when Genex saw it reached", async () => {
    const id = "can-the-player-light-the-lamp";
    const { lead, play, asked } = leadWithJudge({
      objectives: { [id]: InteractionObjective.StudioVerified },
    });
    const words = await askJudge(
      lead,
      { ask: "Can the player light the lamp?", goal_state: '{"path":"lamp.lit","equals":true}' },
      play,
    );
    assert.ok(asked[0]?.quest, "the goal it plays to");
    assert.match(words, /^The judge answered yes \(studio-verified/);
  });

  it("refuses before any play: no question, or a goal state it can't read; and says when no judge could start", async () => {
    const { lead, play, asked } = leadWithJudge(null);
    assert.match(await askJudge(lead, {}, play), /needs ask/);
    assert.match(await askJudge(lead, { ask: "Win?", goal_state: "==" }, play), /^goal_state: /);
    assert.equal(asked.length, 0);
    const busy = leadWithJudge({ noWindow: "every window is taken" });
    assert.match(await askJudge(busy.lead, { ask: "Win?" }, busy.play), /every window is taken/);
    assert.deepEqual(busy.recorded(), []);
  });
});
