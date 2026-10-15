/**
 * The steps card for Roblox Studio: what the person can still do so agents can build in Studio,
 * read live so a step they finish is ticked without being told. The rows are Studio on this
 * computer, signing in, the Genex helper, Studio's MCP server and the game's place. Signing in is
 * only ever the person's: Genex shows where, never does it, and never sees their password. A
 * Studio that answers Genex has a place open, which it opens only signed in, so that ticks it.
 */
import { RobloxAction } from "./actions.ts";
import { MESSAGE } from "./words.ts";

/** Each step's id on the card. Wire values: the renderer keys its rows by them. */
export const RobloxStepId = {
  Studio: "studio",
  SignIn: "sign-in",
  Helper: "helper",
  Mcp: "mcp",
  Place: "place",
} as const;
export type RobloxStepId = (typeof RobloxStepId)[keyof typeof RobloxStepId];

/** A step's button: the plugin action it runs with its arguments, and its label. */
export type RobloxStepAction = { name: RobloxAction; args: Record<string, string>; label: string };
/** One row of the card. */
export type RobloxStep = { id: RobloxStepId; label: string; detail: string; done: boolean; action?: RobloxStepAction };
/** The card: its heading, one line under it, its rows, and whether any step is still open. */
export type RobloxSteps = { title: string; intro: string; steps: RobloxStep[]; open: boolean };

/** What the card is read from. */
export interface RobloxStepFacts {
  installed: boolean;
  version?: string;
  /** Get Roblox Studio is under way, with what it is doing now. */
  getting?: { detail: string };
  setUp: boolean;
  running: boolean;
  answering: boolean;
  /** The game the card is in builds in a Roblox place. */
  linked: boolean;
}

const button = (name: RobloxAction, label: string): RobloxStepAction => ({ name, args: {}, label });

function studioStep(facts: RobloxStepFacts): RobloxStep {
  const W = MESSAGE.Steps;
  if (facts.installed)
    return { id: RobloxStepId.Studio, label: W.StudioDone(facts.version), detail: W.StudioDoneDetail, done: true };
  if (facts.getting)
    return {
      id: RobloxStepId.Studio,
      label: W.Getting,
      detail: facts.getting.detail,
      done: false,
      action: button(RobloxAction.CancelGetStudio, W.Stop),
    };
  return {
    id: RobloxStepId.Studio,
    label: W.GetStudio,
    detail: W.GetStudioDetail,
    done: false,
    action: button(RobloxAction.GetStudio, W.GetStudio),
  };
}

function signInStep(facts: RobloxStepFacts): RobloxStep {
  const W = MESSAGE.Steps;
  const step: RobloxStep = {
    id: RobloxStepId.SignIn,
    label: facts.answering ? W.SignedIn : W.SignIn,
    detail: W.SignInDetail,
    done: facts.answering,
  };
  const canOpen = facts.installed && !facts.running && !facts.getting;
  return canOpen ? { ...step, action: button(RobloxAction.OpenStudio, W.OpenStudio) } : step;
}

function helperStep(facts: RobloxStepFacts): RobloxStep {
  const W = MESSAGE.Steps;
  if (facts.setUp) return { id: RobloxStepId.Helper, label: W.HelperDone, detail: W.HelperDetail, done: true };
  const step: RobloxStep = { id: RobloxStepId.Helper, label: W.Helper, detail: W.HelperDetail, done: false };
  return facts.installed && !facts.getting ? { ...step, action: button(RobloxAction.Setup, W.SetUp) } : step;
}

function mcpStep(facts: RobloxStepFacts): RobloxStep {
  const W = MESSAGE.Steps;
  if (facts.answering) return { id: RobloxStepId.Mcp, label: W.McpDone, detail: W.McpDetail, done: true };
  const step: RobloxStep = { id: RobloxStepId.Mcp, label: W.Mcp, detail: W.McpDetail, done: false };
  const canClick = facts.setUp && facts.running;
  return canClick ? { ...step, action: button(RobloxAction.DoItForMe, MESSAGE.Choice.DoItForMe) } : step;
}

function placeStep(facts: RobloxStepFacts): RobloxStep {
  const W = MESSAGE.Steps;
  return facts.linked
    ? { id: RobloxStepId.Place, label: W.PlaceDone, detail: W.PlaceDetail, done: true }
    : { id: RobloxStepId.Place, label: W.Place, detail: W.PlaceDetail, done: false };
}

/** The card for where Studio stands now. */
export function robloxSteps(facts: RobloxStepFacts): RobloxSteps {
  const steps = [studioStep(facts), signInStep(facts), helperStep(facts), mcpStep(facts), placeStep(facts)];
  const left = steps.filter((step) => !step.done).length;
  const intro = left === 0 ? MESSAGE.Steps.AllDone : MESSAGE.Steps.Intro(left);
  return { title: MESSAGE.Steps.Title, intro, steps, open: left > 0 };
}
