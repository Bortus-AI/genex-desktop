/**
 * The stage's Shop tab: every item the game sells, as its chat's cards show them, beside Live and
 * Builds. The person reviews them here and changes one through the game's agent: Ask for changes
 * leaves the change prompt in the game's chat, beside the stage. Studio puts every item on sale
 * when the game is published (`core/local-items.ts`), so the cards press nothing on genex.games but
 * "Other games can use it".
 */
import type { JSX } from "react";
import { useEffect, useMemo } from "react";
import { type ListingRecord, listingKey } from "../../../shared/item-draft.ts";
import { ListingDraftCard } from "../../chat/ListingDraftCard.tsx";
import { chatPrompt, composeInChat } from "../../compose-in-chat.ts";
import { useItems } from "../../state/hooks.ts";
import { studio } from "../../state/studio.ts";
import { changeItemPrompt } from "../items/items-prompts.ts";
import { shopItemId, shopItems } from "./shop-model.ts";

/** The game's items, read from main and, once the game is on Genex, from genex.games' Selling. */
export function useShopItems(project: string | null): ListingRecord[] {
  const local = useItems((s) => (project ? s.local[project] : undefined));
  const hosted = useItems((s) => (project ? s.hosted[project] : undefined));
  const rows = useItems((s) => s.selling.selling?.items);
  useEffect(() => {
    if (!project) return;
    void studio().items.readLocal(project);
    void studio().items.readHosted([project]);
  }, [project]);
  useEffect(() => {
    if (hosted) void studio().items.readSelling();
  }, [hosted]);
  return useMemo(() => (project ? shopItems(project, local, hosted, rows) : []), [project, local, hosted, rows]);
}

/** The Shop tab: the game's items, each with Ask for changes. */
export function ShopStage({ project, items }: { project: string; items: readonly ListingRecord[] }): JSX.Element {
  const local = useItems((s) => s.local[project]);
  const ask = (record: ListingRecord) => {
    composeInChat({ project, text: changeItemPrompt(record.name, shopItemId(record, local)) });
    requestAnimationFrame(() => chatPrompt()?.focus());
  };
  return (
    <div data-shop-stage="" className="shop-stage absolute inset-0 overflow-y-auto">
      <div className="shop-grid">
        {items.map((record) => (
          <ListingDraftCard key={listingKey(record)} draft={record} onAsk={() => ask(record)} />
        ))}
      </div>
    </div>
  );
}
