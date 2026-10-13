/**
 * A worker's stopped round goes into the build only once a judge prefers it to the integration
 * branch (`judge target=<id> against=integration`): what `integrate` takes, what it says it left
 * out, and what a judge's verdict on that round decides. A new module, so a kept older kept-work.ts
 * or integrate.ts never stands between it and its callers.
 */
import { isRunning } from "../outcomes.ts";
import { isCommit } from "../shell.ts";
import { KEPT_WORDS } from "./kept-work-prompts.ts";
import type { Worker } from "./loop-run.ts";

/** An ended worker's stopped round not in the build yet: its kept commit, or null. */
function keptOutside(worker: Pick<Worker, "state" | "keptCommit" | "keptInBuild">): string | null {
  if (isRunning(worker as Worker) || !isCommit(worker.keptCommit) || worker.keptInBuild) return null;
  return String(worker.keptCommit);
}

/** The stopped round `integrate` takes for `worker`: its kept commit, once a judge preferred it to the integration branch. */
export function keptToMerge(
  worker: Pick<Worker, "state" | "keptCommit" | "keptInBuild" | "keptJudged">,
): string | null {
  const kept = keptOutside(worker);
  return kept && worker.keptJudged === kept ? kept : null;
}

/** What `integrate` says of a stopped round it left out because no judge let it in, or null. */
export function keptLeftOut(
  worker: Pick<Worker, "id" | "state" | "keptCommit" | "keptInBuild" | "keptJudged">,
): string | null {
  const kept = keptOutside(worker);
  return kept && worker.keptJudged !== kept ? KEPT_WORDS.leftOut(worker.id, kept) : null;
}

/**
 * A judge looked at a worker's kept work (`head`): preferred to the integration branch, it may go
 * into the build (`keptToMerge`); preferred to any other build, or not preferred, it may not. A look
 * that reached no verdict (`null`: the build could not be observed) leaves the last one standing.
 */
export function noteKeptJudged(
  worker: Pick<Worker, "keptCommit" | "keptJudged">,
  head: string | null,
  preferredToIntegration: boolean | null,
): void {
  if (!head || head !== worker.keptCommit || preferredToIntegration === null) return;
  worker.keptJudged = preferredToIntegration ? head : null;
}
