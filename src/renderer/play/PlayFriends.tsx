/**
 * Play's Friends page, the fourth row under Games, Tools and Assets: "Friends" with how many, a
 * search for people by name, then grids of cards in the order things need the account: requests
 * waiting for an answer, friends playing now (Join opens their game), every other friend, and
 * requests sent. Beside them, the invite card (its link, Copy, and the credits an invite earns) and
 * whether friends see the game the account is in. With nobody yet, the page is the invite.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";
import { type PlayFriendsPage, PresenceVisibility, peopleQuery } from "../../shared/play-people.ts";
import { usePeople, useShallow } from "../state/hooks.ts";
import { LoadStatus } from "../state/people.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { useCopy } from "../use-copy.ts";
import { PLAY_WORDS } from "../words.ts";
import { CreditsShard } from "./CreditsShard.tsx";
import { FriendCard, FriendCardKind } from "./FriendCard.tsx";
import { PlayPageFrame } from "./PlayPageFrame.tsx";

const WORDS = PLAY_WORDS.people;
/** A search waits this long after the last key before it asks. */
const SEARCH_DEBOUNCE_MS = 300;
/** How many card shapes stand in for the page on its way. */
const PLACEHOLDER_CARDS = 6;

/** A section of the page: its heading with how many, then its cards; `bare` leaves the heading to the page's title. */
function Section({
  label,
  count,
  bare = false,
  children,
}: {
  label: string;
  count: number;
  bare?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="people-section" aria-label={label}>
      {!bare && (
        <h2 className="people-section-head">
          {label} · {count}
        </h2>
      )}
      <div className="friend-grid">{children}</div>
    </section>
  );
}

/**
 * The account's people, in the order they need it. The friends need no heading of their own when
 * nothing comes before them: the page's title already says Friends and how many.
 */
function FriendSections({ page }: { page: PlayFriendsPage }): JSX.Element {
  const playing = page.friends.filter((friend) => friend.playing);
  const others = page.friends.filter((friend) => !friend.playing);
  const othersFirst = page.incoming.length === 0 && playing.length === 0;
  return (
    <>
      {page.incoming.length > 0 && (
        <Section label={WORDS.requests} count={page.incoming.length}>
          {page.incoming.map((person) => (
            <FriendCard key={person.id} kind={FriendCardKind.Request} person={person} />
          ))}
        </Section>
      )}
      {playing.length > 0 && (
        <Section label={WORDS.playingNow} count={playing.length}>
          {playing.map((friend) => (
            <FriendCard key={friend.id} kind={FriendCardKind.Playing} person={friend} />
          ))}
        </Section>
      )}
      {others.length > 0 && (
        <Section label={WORDS.allFriends} count={others.length} bare={othersFirst}>
          {others.map((friend) => (
            <FriendCard key={friend.id} kind={FriendCardKind.Friend} person={friend} />
          ))}
        </Section>
      )}
      {page.outgoing.length > 0 && (
        <Section label={WORDS.sentRequests} count={page.outgoing.length}>
          {page.outgoing.map((person) => (
            <FriendCard key={person.id} kind={FriendCardKind.Sent} person={person} />
          ))}
        </Section>
      )}
    </>
  );
}

/** What a search found, as cards, or why there is nothing to show. */
function SearchResults(): JSX.Element {
  const search = usePeople(useShallow((s) => s.search));
  const result = search.result;
  if (search.status === LoadStatus.Failed) return <p className="people-note">{WORDS.searchFailed}</p>;
  if (!result) return <p className="people-note">{WORDS.searching}</p>;
  if (result.unavailable) return <p className="people-note">{WORDS.searchUnavailable}</p>;
  if (result.people.length === 0) return <p className="people-note">{WORDS.nobody(search.query.trim())}</p>;
  return (
    <Section label={WORDS.found} count={result.people.length}>
      {result.people.map((person) => (
        <FriendCard key={person.id} kind={FriendCardKind.Found} person={person} />
      ))}
    </Section>
  );
}

/** The search box; a query long enough to send asks a moment after the last key. */
function PeopleSearchField({ query, onQuery }: { query: string; onQuery: (query: string) => void }): JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => void studio().people.search(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  return (
    <label className="people-search">
      <Icon name="search" />
      <input
        type="search"
        value={query}
        placeholder={WORDS.find}
        aria-label={WORDS.findLabel}
        spellCheck={false}
        data-people-search
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            onQuery("");
          }
        }}
      />
    </label>
  );
}

/** The account's invite link and its Copy. */
function InviteLink({ link }: { link: string }): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <div className="people-invite-link">
      <input readOnly value={link} aria-label={WORDS.inviteLinkLabel} onFocus={(event) => event.target.select()} />
      <button type="button" className="people-button" data-tone="tint" data-copy-invite onClick={() => copy(link)}>
        <Icon name={copied ? "check" : "copy"} size={15} />
        {copied ? WORDS.copied : WORDS.copy}
      </button>
    </div>
  );
}

/** The invite card: its title with the credits an invite earns, what it does, and the link. */
function InviteCard({ link, bonus }: { link: string; bonus: number | null }): JSX.Element {
  return (
    <section className="people-invite" aria-label={WORDS.invite} data-invite-card>
      <div className="people-invite-head">
        <h2 className="people-invite-title">{WORDS.invite}</h2>
        {bonus !== null && bonus > 0 && (
          <span className="people-invite-bonus" title={WORDS.inviteBonusLabel(bonus)}>
            <CreditsShard size={15} />
            {WORDS.inviteBonus(bonus)}
          </span>
        )}
      </div>
      <p className="people-invite-text">{WORDS.inviteText}</p>
      <InviteLink link={link} />
    </section>
  );
}

/** Whether friends see the game the account is in; a refusal puts the switch back and says so. */
function VisibilityCard({ visibility }: { visibility: PresenceVisibility }): JSX.Element {
  const shown = visibility === PresenceVisibility.Game;
  const change = (on: boolean): void => {
    studio()
      .people.setVisibility(on ? PresenceVisibility.Game : PresenceVisibility.Hidden)
      .catch(() => studio().notify(WORDS.actionFailed, ToastTone.Error));
  };
  return (
    <div className="people-visibility" data-visibility-card>
      <div className="min-w-0 flex-1">
        <div className="people-visibility-title">{WORDS.showPlaying}</div>
        <p className="people-visibility-text">{WORDS.showPlayingOff}</p>
      </div>
      <Toggle on={shown} onChange={change} ariaLabel={WORDS.showPlaying} />
    </div>
  );
}

/** Nobody yet: the page is the invite, with search under it. */
function EmptyFriends({
  page,
  query,
  onQuery,
}: {
  page: PlayFriendsPage;
  query: string;
  onQuery: (q: string) => void;
}) {
  return (
    <div className="people-empty" data-friends-empty>
      <h1 className="people-empty-title">{WORDS.empty}</h1>
      {page.inviteLink && <InviteCard link={page.inviteLink} bonus={page.inviteBonus} />}
      <div className="people-or" aria-hidden="true">
        {WORDS.or}
      </div>
      <PeopleSearchField query={query} onQuery={onQuery} />
      {peopleQuery(query) && <SearchResults />}
    </div>
  );
}

/** Whether the account has nobody at all: no friends, and no request either way. */
const nobody = (page: PlayFriendsPage): boolean =>
  page.friends.length + page.incoming.length + page.outgoing.length === 0;

/** The page with people on it: the grids, and the invite and visibility cards beside them. */
function FriendsLayout({
  page,
  query,
  onQuery,
}: {
  page: PlayFriendsPage;
  query: string;
  onQuery: (q: string) => void;
}) {
  const searching = peopleQuery(query) !== null;
  return (
    <div className="people-layout" data-friends-page>
      <div className="people-main">
        <h1 className="people-title">
          {WORDS.friends} <span className="people-title-count">{page.friends.length}</span>
        </h1>
        <PeopleSearchField query={query} onQuery={onQuery} />
        {searching ? <SearchResults /> : <FriendSections page={page} />}
      </div>
      <aside className="people-aside">
        {page.inviteLink && <InviteCard link={page.inviteLink} bonus={page.inviteBonus} />}
        <VisibilityCard visibility={page.visibility} />
      </aside>
    </div>
  );
}

/** The Friends page. */
export function PlayFriends({
  sidebarHidden,
  onToggleSidebar,
}: {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}): JSX.Element {
  const signedIn = usePeople((s) => s.me !== null);
  const page = usePeople((s) => s.friends);
  const status = usePeople((s) => s.friendsStatus);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void studio().people.loadFriends();
  }, []);
  return (
    <PlayPageFrame label={WORDS.friends} sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar}>
      {!signedIn && <p className="people-note">{WORDS.signedOut}</p>}
      {signedIn && !page && status === LoadStatus.Failed && (
        <div className="people-note">
          {WORDS.friendsFailed}
          <Button variant="secondary" onClick={() => void studio().people.loadFriends()}>
            {PLAY_WORDS.retry}
          </Button>
        </div>
      )}
      {signedIn && page && nobody(page) && <EmptyFriends page={page} query={query} onQuery={setQuery} />}
      {signedIn && page && !nobody(page) && <FriendsLayout page={page} query={query} onQuery={setQuery} />}
      {signedIn && !page && status !== LoadStatus.Failed && <FriendsPlaceholder />}
    </PlayPageFrame>
  );
}

/** Cards still on their way. */
function FriendsPlaceholder(): JSX.Element {
  return (
    <div className="people-main" aria-hidden="true">
      <span className="play-bar people-placeholder-title" />
      <div className="friend-grid">
        {Array.from({ length: PLACEHOLDER_CARDS }, (_, card) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and only counted
          <span key={card} className="friend-card friend-card-placeholder">
            <span className="people-placeholder-avatar" />
            <span className="play-bar play-bar-title" />
          </span>
        ))}
      </div>
    </div>
  );
}
