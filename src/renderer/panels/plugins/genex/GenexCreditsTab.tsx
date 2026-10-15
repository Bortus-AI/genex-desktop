/**
 * The Genex plugin's Credits tab: the balance band (the shard, the balance, the Pro allowance and
 * when it comes, Invite a friend with what it earns, Get credits, which opens genex.games' plans in
 * the browser), what credits pay for with each kind's live price ("from N", never typed into the
 * app) and that building games costs nothing, and the recent spending: the last few spends and
 * refunds with their game. Both lists sit under a heading and a line, so their rows start level.
 */
import type { JSX, ReactNode } from "react";
import { useState } from "react";
import {
  type CreditEntry,
  CreditKind,
  CREDITS_PLANS_URL,
  PRICED_KINDS,
  type PlayCredits,
} from "../../../../shared/play-credits.ts";
import { CreditsShard, ScrambleNumber } from "../../../play/CreditsShard.tsx";
import { openPlayFriends } from "../../../play/open-play.ts";
import { usePeople } from "../../../state/hooks.ts";
import { studio } from "../../../state/studio.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { GENEX_WORDS } from "../../../words.ts";
import { accountCreditsOf, CreditsKind } from "./genex-view.ts";

const WORDS = GENEX_WORDS.creditsTab;
/** Credits read with the reader's own digit grouping. */
const NUMBER = new Intl.NumberFormat();
/** "Nov 1": when the Pro allowance comes. */
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Each kind's mark in both lists. */
const KIND_ICONS: Record<CreditKind, IconName> = {
  [CreditKind.Model]: "box",
  [CreditKind.Character]: "character",
  [CreditKind.ModelAnimation]: "motion",
  [CreditKind.Image]: "image",
  [CreditKind.Texture]: "tiles",
  [CreditKind.Video]: "video",
  [CreditKind.Music]: "music",
  [CreditKind.Sound]: "sound",
  [CreditKind.Voice]: "mic",
  [CreditKind.ModelRig]: "character",
  [CreditKind.CoverRegenerate]: "image",
};

/** Where the tab's read stands, and whose credits it holds. */
type CreditsRead = { credits: PlayCredits | null; failed: boolean; account: string | null };

/** The account's credits, read when the tab opens and again for another account. */
function useCredits(accountId: string | null): Omit<CreditsRead, "account"> & { reload: () => void } {
  const [read, setRead] = useState<CreditsRead>({ credits: null, failed: false, account: null });
  const [attempt, setAttempt] = useState(0);
  useAsyncEffect(
    (alive) => {
      if (!accountId) return;
      // Another account's credits never show under this one, even for the moment its read takes.
      setRead((before) => ({
        credits: before.account === accountId ? before.credits : null,
        failed: false,
        account: accountId,
      }));
      studio()
        .api.playCredits()
        .then(
          (credits) => alive() && setRead({ credits, failed: false, account: accountId }),
          () => alive() && setRead((before) => ({ ...before, failed: true })),
        );
    },
    [accountId, attempt],
  );
  const mine = read.account === accountId;
  return {
    credits: mine ? read.credits : null,
    failed: mine && read.failed,
    reload: () => setAttempt((count) => count + 1),
  };
}

/** The line under the balance: the Pro allowance and when it comes, and that one balance covers every tool. */
function planLine(credits: PlayCredits): string {
  if (!credits.plan) return WORDS.shared;
  const when = credits.plan.resetsAt ? DAY.format(new Date(credits.plan.resetsAt)) : null;
  const plan = when ? WORDS.plan(NUMBER.format(credits.plan.allowance), when) : null;
  return [plan, WORDS.shared].filter(Boolean).join(" · ");
}

/** The balance itself: Unlimited, the count with its unit, or a dash when genex.games couldn't say. */
function BalanceAmount({ credits }: { credits: PlayCredits }): JSX.Element {
  const shown = accountCreditsOf(credits);
  if (shown.kind === CreditsKind.Unlimited)
    return (
      <span className="credits-band-number" data-unlimited>
        {WORDS.unlimited}
      </span>
    );
  if (shown.kind === CreditsKind.Unknown)
    return (
      <span className="credits-band-amount" data-balance-unknown>
        <span className="credits-band-number">{WORDS.noBalance}</span>
        <span className="credits-note">{WORDS.balanceUnread}</span>
      </span>
    );
  return (
    <span className="credits-band-amount">
      <ScrambleNumber className="credits-band-number" text={NUMBER.format(shown.count)} />
      <span className="credits-note">{WORDS.unit(shown.count)}</span>
    </span>
  );
}

/** The balance band. */
function Balance({ credits }: { credits: PlayCredits }): JSX.Element {
  return (
    <div className="credits-band" data-credits-balance>
      <CreditsShard size={44} />
      <div className="credits-band-copy">
        <BalanceAmount credits={credits} />
        <span className="credits-note">{planLine(credits)}</span>
      </div>
      <span className="credits-band-actions">
        <button type="button" className="people-button" data-tone="tint" data-credits-invite onClick={openPlayFriends}>
          {WORDS.inviteFriend}
          {credits.inviteBonus !== null && credits.inviteBonus > 0 && (
            <span className="credits-invite-bonus">
              {WORDS.bonus(credits.inviteBonus)}
              <CreditsShard size={13} />
            </span>
          )}
        </button>
        <button
          type="button"
          className="people-button"
          data-tone="primary"
          data-credits-get
          onClick={() => void window.studio.openUrl(CREDITS_PLANS_URL)}
        >
          {WORDS.getCredits}
        </button>
      </span>
    </div>
  );
}

/** One row of either list: the kind's mark, its name with a line under it, and credits at the end. */
function CreditRow({
  icon,
  name,
  sub,
  hook,
  children,
}: {
  icon: IconName;
  name: string;
  sub: string;
  hook: Record<`data-${string}`, string>;
  children: ReactNode;
}): JSX.Element {
  return (
    <li className="credits-row" {...hook}>
      <span className="credits-row-mark" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="credits-row-name">
        {name}
        <span className="credits-row-sub">{sub}</span>
      </span>
      {children}
    </li>
  );
}

/**
 * What credits pay for: only assets, each kind with the tool Genex routes it to and its price from
 * genex.games; building the game itself runs on the person's own subscription and costs nothing.
 */
function PriceList({ credits }: { credits: PlayCredits }): JSX.Element {
  const priced = PRICED_KINDS.filter((kind) => credits.prices[kind] !== undefined);
  return (
    <section className="credits-column" aria-label={WORDS.payFor} data-credits-prices>
      <h2 className="credits-heading">{WORDS.payFor}</h2>
      <p className="credits-note credits-subtitle">
        <span>{WORDS.payForLine}</span>
        <span data-credits-free>{WORDS.freeBuilding}</span>
        <span>{WORDS.refunds}</span>
        <span>{WORDS.outOfCredits}</span>
      </p>
      <div className="credits-body">
        {priced.length === 0 && <p className="credits-note">{WORDS.pricesUnavailable}</p>}
        <ul className="credits-rows">
          {priced.map((kind) => (
            <CreditRow
              key={kind}
              icon={KIND_ICONS[kind]}
              name={WORDS.kinds[kind].name}
              sub={WORDS.kinds[kind].tool}
              hook={{ "data-credits-kind": kind }}
            >
              <span className="credits-row-amount">
                {WORDS.from} <b>{NUMBER.format(credits.prices[kind] ?? 0)}</b>
                <CreditsShard size={12} />
              </span>
            </CreditRow>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** One spend or refund: what it was, its game, and how many credits went or came back. */
function RecentRow({ entry }: { entry: CreditEntry }): JSX.Element {
  const kind = entry.kind ? WORDS.kinds[entry.kind].name : WORDS.otherKind;
  const sub = [entry.game, entry.refund ? WORDS.refundedNote : null].filter(Boolean).join(" · ");
  return (
    <CreditRow
      icon={entry.kind ? KIND_ICONS[entry.kind] : "sparkle"}
      name={entry.refund ? WORDS.failedKind(kind) : kind}
      sub={sub}
      hook={{ "data-credits-entry": entry.refund ? "refund" : "spend" }}
    >
      <span className="credits-row-amount" data-refund={entry.refund || undefined}>
        <b>{entry.refund ? WORDS.refunded(entry.amount) : WORDS.spent(entry.amount)}</b>
        <CreditsShard size={12} />
      </span>
    </CreditRow>
  );
}

/** The recent spends and refunds, under a line that is there with or without them. */
function RecentSpending({ credits }: { credits: PlayCredits }): JSX.Element {
  const none = credits.recent.length === 0;
  return (
    <section className="credits-column" aria-label={WORDS.recent} data-credits-recent>
      <h2 className="credits-heading">{WORDS.recent}</h2>
      <p className="credits-note credits-subtitle">{none ? WORDS.noRecent : WORDS.recentLine}</p>
      <div className="credits-body">
        {!none && (
          <ul className="credits-rows">
            {credits.recent.map((entry) => (
              <RecentRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        <span className="credits-note credits-cent">{WORDS.centNote}</span>
      </div>
    </section>
  );
}

/** The Credits tab. */
export function GenexCreditsTab(): JSX.Element {
  const accountId = usePeople((s) => s.me?.id ?? null);
  const { credits, failed, reload } = useCredits(accountId);
  if (!accountId) return <p className="genex-off">{WORDS.signedOut}</p>;
  if (!credits && failed)
    return (
      <div className="people-note">
        {WORDS.failed}
        <Button variant="secondary" onClick={reload}>
          {GENEX_WORDS.account.tryAgain}
        </Button>
      </div>
    );
  if (!credits) return <Pending label={WORDS.loading} className="genex-checking" spinner />;
  return (
    <div className="credits-tab" data-credits-tab>
      <Balance credits={credits} />
      <div className="credits-columns">
        <PriceList credits={credits} />
        <RecentSpending credits={credits} />
      </div>
    </div>
  );
}
