/**
 * The finish check in the chat: while the Loop works its rounds say nothing; once the run ends
 * without the reviewer's yes, its result card lists what the last no found done and still to fix.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { EntryKind, StopWhy, stopWhyLine, toEntries } from "../../src/renderer/chat-entries.ts";
import { morningWords } from "../../src/renderer/morning-words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../../src/shared/finish-check.ts";

const RUN = "r-loop";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, eventType: string, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: eventType, payload });
const check = (id: number, round: number, step: string, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.FinishCheck, { runId: RUN, project: "valley", round, step, ...extra });

const NO_FINISH_LINE = "The track has no finish line, so a lap never ends.";
const NO_TIMER = "The lap timer isn't on screen in any shot.";

/** The result card's still-to-fix lists, when the log ends with one. */
const stillToFixOf = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.Morning ? [entry.stillToFix ?? null] : []));
const finished = (id: number, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.RunFinished, { runId: RUN, project: "valley", ...extra });

it("a round of the finish check says nothing in the chat while the Loop works", () => {
  const log = [
    check(1, 1, FinishCheckStep.Checking, { claim: "Done." }),
    check(2, 1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE], notDone: [NO_TIMER], rejections: 1 }),
    check(3, 2, FinishCheckStep.Checking),
    check(4, 2, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 1 }),
    check(5, 3, FinishCheckStep.Checking),
    check(6, 3, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: MAX_FINISH_REJECTIONS, timeLeft: true }),
  ];
  assert.deepEqual(toEntries(log), [], "no line, no card, no activity row");
});

it("a run that ends without a yes lists its last no's done and still to fix on its result card", () => {
  const met = "The laps run, as accepted before.";
  const log = [
    check(1, 1, FinishCheckStep.Rejected, {
      reasons: [met],
      done: ["Laps run"],
      notDone: [NO_FINISH_LINE],
      rejections: 1,
    }),
    check(2, 2, FinishCheckStep.Rejected, {
      reasons: [met],
      done: ["Laps run", "Finish line"],
      notDone: [NO_TIMER],
      rejections: 2,
      stopped: true,
    }),
    finished(3, { victory: false }),
  ];
  assert.deepEqual(stillToFixOf(log), [
    { done: ["Laps run", "Finish line"], notDone: [NO_TIMER], why: StopWhy.Stuck, hours: null },
  ]);
  const said = JSON.stringify(toEntries(log));
  assert.ok(!said.includes(met), "what the reviewer checked is never listed");

  const yes = [
    check(1, 1, FinishCheckStep.Rejected, { reasons: [met], notDone: [NO_TIMER], rejections: 1 }),
    check(2, 2, FinishCheckStep.Accepted, { reasons: ["Laps run and the timer shows."] }),
    finished(3, { victory: true }),
  ];
  assert.deepEqual(stillToFixOf(yes), [null], "a yes leaves nothing to fix");
  const older = [
    check(1, 1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 3, stopped: true }),
    finished(2),
  ];
  assert.deepEqual(stillToFixOf(older), [null], "an older record that names nothing not done keeps the card as it was");
  assert.deepEqual(stillToFixOf([finished(1)]), [null], "a run no reviewer checked has no list");
});

it("a reopened run's next close starts clean: an earlier ask's no is not listed again", () => {
  const log = [
    check(1, 1, FinishCheckStep.Rejected, { reasons: [], notDone: [NO_TIMER], rejections: 3, stopped: true }),
    finished(2),
    finished(3),
  ];
  assert.deepEqual(stillToFixOf(log), [{ done: [], notDone: [NO_TIMER], why: StopWhy.Stuck, hours: null }, null]);
});

it("the card says why the Loop stopped: its hours ran out, the person stopped it, or it ended another way", () => {
  const HOUR = 3_600_000;
  const started = custom(1, CustomEvent.RunStarted, {
    runId: RUN,
    project: "valley",
    budgets: { wallClockMs: 5 * HOUR },
  });
  const no = (id: number) =>
    check(id, 1, FinishCheckStep.Rejected, { reasons: [], notDone: [NO_TIMER], rejections: 1, timeLeft: true });
  const whyOf = (events: EventEnvelope[]) => stillToFixOf(events).map((card) => card && [card.why, card.hours]);
  assert.deepEqual(whyOf([started, no(2), finished(5 * HOUR)]), [[StopWhy.Time, 5]], "it ended at its five hours");
  assert.deepEqual(
    whyOf([started, no(2), finished(HOUR)]),
    [[StopWhy.Ended, 5]],
    "an hour in, it ended some other way",
  );
  assert.deepEqual(
    whyOf([started, no(2), finished(HOUR, { executionStatus: "cancelled" })]),
    [[StopWhy.Person, 5]],
    "the person's Stop",
  );
  assert.equal(stopWhyLine(StopWhy.Time, 5), "Your 5 hours ran out before this was fixed.");
  assert.equal(stopWhyLine(StopWhy.Time, 0.5), "Your 30 minutes ran out before this was fixed.");
  assert.match(stopWhyLine(StopWhy.Stuck, null), /kept getting this wrong/);
});

it("a record it cannot place says nothing", () => {
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["no run", { round: 1, step: FinishCheckStep.Rejected, notDone: [NO_TIMER] }],
    ["an unknown step", { runId: RUN, round: 1, step: "maybe", notDone: [NO_TIMER] }],
    ["reasons that are not strings", { runId: RUN, round: 1, step: FinishCheckStep.Rejected, reasons: [3] }],
  ];
  for (const [name, payload] of hostile)
    assert.deepEqual(stillToFixOf([custom(1, CustomEvent.FinishCheck, payload), finished(2)]), [null], name);
});

it("a run paused while the reviewer is checking reads in the graph as not yet: no reviewer is at work", async () => {
  const { buildRunGraph, GraphNodeKind } = await import("../../src/renderer/run-graph.ts");
  const paused = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", goal: "a racer" }),
    custom(2, CustomEvent.AutopilotStarted, { runId: RUN, director: true, facets: [], workerRecords: true }),
    check(3, 1, FinishCheckStep.Checking),
    custom(4, CustomEvent.RunFinished, { runId: RUN, paused: true, executionStatus: "paused" }),
  ];
  const node = buildRunGraph(paused, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((node as { state?: string } | undefined)?.state, "not_yet");
  const resumed = [...paused, custom(5, CustomEvent.AutopilotResumed, { runId: RUN })];
  const again = buildRunGraph(resumed, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((again as { state?: string } | undefined)?.state, "not_yet", "nor after the run resumes");
});

it("a run_finished of an in-place Loop gives its result card the profile, so the card says kept in your project before the summary loads", () => {
  const closed = (profile?: string) =>
    toEntries([
      custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", goal: "A valley" }),
      custom(2, CustomEvent.RunFinished, {
        runId: RUN,
        project: "valley",
        landed: true,
        executionStatus: "completed",
        ...(profile ? { profile } : {}),
      }),
    ]).find((entry) => entry.kind === EntryKind.Morning);
  const card = closed("open");
  assert.ok(card && card.kind === EntryKind.Morning);
  assert.equal(card.profile, "open");
  // The card's words before its run summary loads: the entry's own fields, nothing else.
  const words = morningWords({ ...card, paused: false, hasBuild: false, profile: card.profile });
  assert.doesNotMatch(words.because, /open Live/);
  assert.match(words.because, /kept in your project/);
  const web = closed();
  assert.ok(web && web.kind === EntryKind.Morning);
  assert.equal(web.profile, null, "a close that names no profile carries none");
});
