/**
 * The Listing draft card (marketplace P11, plan 8.3; screen 09): a store item the game's agent made,
 * as its own `genex shop add --json` answered (`item_drafted`, a record only the host writes). It
 * shows the item's picture, name and description, its price, the "Other games can use it" toggle
 * and Put on sale, "or ask for changes below". Its presses go to genex.games through main
 * (`itemSetShared`, `itemPutOnSale`) as the person's own: the agent can neither press them nor draw
 * the card (D40). Once on sale it says so; an item an admin took off sale offers nothing (D14).
 */
import type { JSX } from "react";
import { useId } from "react";
import type { ListingDraft } from "../../shared/item-draft.ts";
import { CoinMark } from "../play/CoinMark.tsx";
import { ItemRender } from "../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../play/purchase-model.ts";
import { useItems } from "../state/hooks.ts";
import { ItemAction } from "../state/items.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/switch.tsx";
import { ITEMS_WORDS, itemRefusalWords, PLAY_STORE_WORDS } from "../words.ts";
import { type ListingCardView, ListingSale, listingCardView, shareChange } from "./listing-draft.ts";

const WORDS = ITEMS_WORDS;

/** The price chip: the coin and the amount, or Free. */
function Price({ coins }: { coins: number }): JSX.Element {
  if (coins === 0) return <span className="listing-chip">{PLAY_STORE_WORDS.free}</span>;
  return (
    <span className="listing-chip listing-price">
      <CoinMark size={14} />
      <span aria-hidden="true">{coinNumber(coins)}</span>
      <span className="sr-only">{coinText(coins)}</span>
    </span>
  );
}

/** Put on sale and what follows it, or where the sale stands once it is past. */
function Sale({ view }: { view: ListingCardView }): JSX.Element {
  if (view.sale === ListingSale.OnSale)
    return (
      <p className="listing-sale-state" data-listing-on-sale>
        {WORDS.onSale}
      </p>
    );
  if (view.sale === ListingSale.TakenDown) return <p className="listing-sale-state">{WORDS.offSale}</p>;
  return (
    <div className="listing-actions">
      <Button
        variant="default"
        data-listing-put-on-sale={view.itemId}
        busy={view.sale === ListingSale.Pressing}
        disabled={!view.canPutOnSale && view.sale !== ListingSale.Pressing}
        onClick={() => void studio().items.change(view.itemId, ItemAction.PutOnSale)}
      >
        {WORDS.putOnSale}
      </Button>
      <span className="listing-or">{WORDS.orAsk}</span>
    </div>
  );
}

/** The card for one draft. */
export function ListingDraftCard({ draft }: { draft: ListingDraft }): JSX.Element {
  const latest = useItems((s) => s.changed[draft.itemId]);
  const busy = useItems((s) => s.busy[draft.itemId]);
  const refusal = useItems((s) => s.refused[draft.itemId]);
  const view = listingCardView(draft, latest, busy, refusal);
  const shareId = useId();
  const name = gameText(view.name);
  return (
    <section
      className="listing-card"
      data-listing-draft={view.itemId}
      data-listing-sale={view.sale}
      aria-label={WORDS.listingLabel(name)}
    >
      <div className="listing-head">
        <ItemRender item={{ id: view.itemId, iconUrl: view.iconUrl, modelUrl: null }} className="listing-render" />
        <div className="listing-words">
          <h3 className="listing-name" dir="auto">
            {name}
          </h3>
          {view.description && (
            <p className="listing-description" dir="auto">
              {gameText(view.description)}
            </p>
          )}
        </div>
      </div>
      <div className="listing-chips">
        <Price coins={view.priceCoins} />
        <span className="listing-chip listing-share">
          <Switch
            id={shareId}
            data-listing-share={view.itemId}
            checked={view.shared}
            disabled={!view.canShare}
            aria-busy={view.sharing || undefined}
            onCheckedChange={(on) => void studio().items.change(view.itemId, shareChange(on))}
          />
          <label htmlFor={shareId}>{WORDS.shared}</label>
        </span>
      </div>
      <Sale view={view} />
      {view.refusal && (
        <p role="alert" className="listing-refusal">
          {itemRefusalWords(view.refusal)}
        </p>
      )}
    </section>
  );
}
