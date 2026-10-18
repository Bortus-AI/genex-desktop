/**
 * What an Auto chat (Loop off) is told of the Loop it may start: only when the user asks in words, for
 * the hours they named. One once said "The 3-hour loop starts now" with no way to start one. A module
 * of its own, so a launch-prompts.ts an agent edited and kept still loads beside it.
 */
import { toolCall } from "./model-roles.ts";

/** The brief's line for an Auto chat handed `tool`, spelled the way `engine` calls it. */
export function autoLoopRule(engine: string | undefined, tool: string): string {
  const launch = toolCall(engine, tool);
  return `Loop is off. When the user asks in words for a Loop (a build that runs on its own for hours, or until it's done), call ${launch} last, with the hours they named (leave hours out for until done), then say in one line that it starts. Never say a Loop started unless that call answered that it did.`;
}
