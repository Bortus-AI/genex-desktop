/**
 * A listing draft in a Genex CLI answer (marketplace plan 8.3, 10.3; contract "CLI `--json`
 * draft"). The game's agent makes a store item with `genex shop add … --json`, or changes one with
 * `genex shop set <id> … --json`, through Studio's `genex__cli-paid`; the pinned CLI prints one JSON
 * document, a CreatorSku with `kind: "genex.item_draft"` and `version: 1`. Studio draws the Listing
 * draft card from that document only: a real, successful run of one of those two commands, read as
 * hostile input like any genex.games answer (`play/store.ts`), naming the game's own hosted project.
 * Anything else, words the agent wrote included, draws no card (D40).
 */
import { isItemDraftDocument, type ListingDraft } from "../../shared/item-draft.ts";
import { creatorItemOf } from "../play/store.ts";
import { GenexCliCommand } from "./genex-cli-policy.ts";

/** The commands whose answer may be a draft. */
const DRAFT_COMMANDS: ReadonlySet<string> = new Set<GenexCliCommand>([
  GenexCliCommand.ShopAdd,
  GenexCliCommand.ShopSet,
]);

/** What a CLI run answered, as `GenexCliService` hands it back. */
export interface DraftAnswer {
  command: string;
  ok: boolean;
  output: unknown;
}

/**
 * The listing draft a CLI answer carries, for the game `project` whose hosted Genex project is
 * `hostedProjectId`; null for any other command, a failed run, output that is not a whole draft,
 * or a draft of another project.
 */
export function draftInCliAnswer(
  answer: DraftAnswer,
  project: string,
  hostedProjectId: string | null,
): ListingDraft | null {
  if (!answer.ok || !DRAFT_COMMANDS.has(answer.command) || !hostedProjectId) return null;
  if (!isItemDraftDocument(answer.output)) return null;
  const item = creatorItemOf(answer.output, false);
  if (!item || item.projectId !== hostedProjectId) return null;
  return {
    project,
    itemId: item.id,
    name: item.name,
    description: item.description,
    type: item.type,
    priceCoins: item.priceCoins,
    priceDisplayUsdCents: item.priceDisplayUsdCents,
    iconUrl: item.iconUrl,
    state: item.state,
    shareable: item.shareable,
  };
}
