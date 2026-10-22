/**
 * The new Loop a user's ask to finish carries ("stop it and start a new one"), as the lead passes it
 * to `wrap_up` (wrap-up.ts) and the `run_control` record keeps it; next-loop.ts starts it once the
 * run has closed. Pure: no launch here, so the lead's tools can read it without the chat's dispatch.
 */
import { EventKind, RunEvent } from "./run-events.ts";
import { RunControlAction } from "./run-inbox.ts";
import type { AnyRecord, HarnessEvent } from "../types/harness.d.ts";

/** The new Loop a finish ask carries: what to build, the bar, and its hours (null: until done). */
export interface NextLoop {
  goal: string;
  direction: string;
  hours: number | null;
}

/** A finish ask's new Loop from what the lead passed, or null when it names no goal. */
export function nextLoopFrom(args: AnyRecord): NextLoop | null {
  const goal = typeof args.next_goal === "string" ? args.next_goal.trim() : "";
  if (!goal) return null;
  const direction = typeof args.next_direction === "string" ? args.next_direction.trim() : "";
  const hours = Number.parseFloat(String(args.next_hours ?? ""));
  return { goal, direction: direction || goal, hours: hours > 0 ? hours : null };
}

/** The new Loop the latest finish ask of `runId` carries in `events`, or null. */
export function nextLoopOf(events: readonly HarnessEvent[], runId: string): NextLoop | null {
  let next: NextLoop | null = null;
  for (const event of events) {
    const data = event?.data;
    if (data?.type !== EventKind.Custom || data.event_type !== RunEvent.RunControl) continue;
    const payload = data.payload ?? {};
    if (payload.runId !== runId || payload.action !== RunControlAction.Finish) continue;
    next = isNextLoop(payload.next) ? payload.next : null;
  }
  return next;
}

/** Whether a recorded value is a new Loop as `nextLoopFrom` writes it. */
function isNextLoop(value: unknown): value is NextLoop {
  const next = value as Partial<NextLoop> | null;
  return typeof next?.goal === "string" && next.goal.length > 0 && typeof next.direction === "string";
}
