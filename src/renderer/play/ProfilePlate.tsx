/**
 * The Genex account at the foot of the sidebar, in Play and in Create: its avatar, its name (and
 * Pro), and beside it the friends themselves: up to two faces, people playing first in a green
 * ring, with the count of requests waiting on their corner (two grey placeholders and a "+" while
 * there are no friends). The name opens a menu: Profile, Friends, Credits, Account settings and
 * Sign out. Shown only while Genex is signed in; Profile and Friends open Play at that page.
 */
import type { JSX } from "react";
import { GENEX_PLUGIN_ID, GenexAction, type GenexStatus } from "../../shared/genex.ts";
import type { PlayMe } from "../../shared/play-people.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { GenexTab, openGenexPage } from "../panels/plugins/genex/genex-tab.ts";
import { useGenexStatus } from "../panels/plugins/genex/use-genex-status.ts";
import { runPluginAction } from "../plugin-actions.ts";
import { usePeople, usePlugins, useShallow } from "../state/hooks.ts";
import { stackFaces, waitingRequests } from "../state/people.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PLAY_WORDS } from "../words.ts";
import { CreditsShard } from "./CreditsShard.tsx";
import { formatCount } from "./play-model.ts";
import { GhostAvatar, PersonAvatar } from "./PersonAvatar.tsx";

const WORDS = PLAY_WORDS.people;
/** The size of the stack's faces. */
const STACK_FACE = 24;
/** The placeholders' ids: each draws its own grey face. */
const GHOSTS = ["ghost-a", "ghost-b"] as const;

/** "July 2026": when an account was made, as a profile says it. */
export const joinedWhen = (iso: string | null): string | null =>
  iso ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso)) : null;

/** Sign out of Genex through the plugin's own action, its confirmation asked natively first. */
async function signOut(genex: PluginInfo | undefined): Promise<void> {
  if (!genex) return;
  try {
    await runPluginAction({
      plugin: genex,
      name: GenexAction.Disconnect,
      args: {},
      project: null,
      // Signing out shows no pictures: the review that would is refused, not shown.
      review: (request) => request.resolve(false),
    });
  } catch {
    // Declined in the confirmation: still signed in, nothing to say.
  }
  await studio().people.loadMe();
}

/** The credits as the menu shows them, or null while the plugin has not said. */
function creditsWords(status: GenexStatus | null): string | null {
  if (!status?.connected) return null;
  if (status.unlimited) return WORDS.creditsUnlimited;
  return status.balance === null ? null : formatCount(status.balance);
}

/** The account's credits, read while the menu is open; they open the Genex plugin's Credits tab. */
function Credits({ genex }: { genex: PluginInfo }): JSX.Element {
  const { status } = useGenexStatus(genex, null);
  const amount = creditsWords(status);
  return (
    <DropdownMenuItem data-profile-menu="credits" onSelect={() => openGenexPage(GenexTab.Credits)}>
      <CreditsShard size={16} />
      <span className="flex-1">{WORDS.credits}</span>
      {amount !== null && <span className="profile-menu-value">{amount}</span>}
    </DropdownMenuItem>
  );
}

/** The menu the name opens. */
function PlateMenu({
  me,
  waiting,
  genex,
  onOpen,
}: {
  me: PlayMe;
  waiting: number;
  genex: PluginInfo | undefined;
  onOpen: (page: typeof PlayPage.Profile | typeof PlayPage.Friends) => void;
}): JSX.Element {
  const joined = joinedWhen(me.joinedAt);
  return (
    <DropdownMenuContent side="top" align="start" sideOffset={8} className="profile-menu" aria-label={WORDS.menuLabel}>
      <div className="profile-menu-head">
        <PersonAvatar person={me} size={36} />
        <div className="min-w-0">
          <div className="truncate">{me.name}</div>
          <div className="profile-menu-sub">
            {[me.pro ? WORDS.pro : null, joined ? WORDS.joined(joined) : null].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-profile-menu="profile" onSelect={() => onOpen(PlayPage.Profile)}>
        <Icon name="character" />
        {WORDS.profile}
      </DropdownMenuItem>
      <DropdownMenuItem data-profile-menu="friends" onSelect={() => onOpen(PlayPage.Friends)}>
        <Icon name="users" />
        <span className="flex-1">{WORDS.friends}</span>
        {waiting > 0 && <span className="sidebar-badge">{waiting}</span>}
      </DropdownMenuItem>
      {genex && <Credits genex={genex} />}
      <DropdownMenuSeparator />
      <DropdownMenuItem data-profile-menu="account" onSelect={() => openGenexPage(GenexTab.Tools)}>
        <Icon name="settings" />
        {WORDS.accountSettings}
      </DropdownMenuItem>
      <DropdownMenuItem data-profile-menu="sign-out" onSelect={() => void signOut(genex)}>
        <Icon name="sign-out" />
        {WORDS.signOut}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

/** The friends beside the name: their faces and the requests waiting; it opens Friends. */
function FriendsStack({ onOpen }: { onOpen: () => void }): JSX.Element {
  const friends = usePeople(useShallow((s) => s.friends?.friends ?? []));
  const waiting = usePeople(waitingRequests);
  const faces = stackFaces(friends);
  const playing = friends.filter((friend) => friend.playing).length;
  const summary =
    friends.length > 0 ? WORDS.stackSummary({ friends: friends.length, playing, waiting }) : WORDS.noFriendsYet;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="friends-stack"
          data-profile-friends
          data-avatar-host
          aria-label={summary}
          onClick={onOpen}
        >
          {faces.map((friend) => (
            <span key={friend.id} className="friends-stack-face" data-live={friend.playing ? true : undefined}>
              <PersonAvatar person={friend} size={STACK_FACE} />
            </span>
          ))}
          {faces.length === 0 &&
            GHOSTS.map((id) => (
              <span key={id} className="friends-stack-face">
                <GhostAvatar id={id} size={STACK_FACE} />
              </span>
            ))}
          {faces.length === 0 && (
            <span className="friends-stack-plus" aria-hidden="true">
              <Icon name="plus" size={12} strokeWidth={2} />
            </span>
          )}
          {waiting > 0 && (
            <span className="friends-stack-count" aria-hidden="true">
              {waiting}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{summary}</TooltipContent>
    </Tooltip>
  );
}

/** The plate: nothing while Genex is signed out. */
export function ProfilePlate({ onPlayMode }: { onPlayMode: (play: boolean) => void }): JSX.Element | null {
  const me = usePeople((s) => s.me);
  const waiting = usePeople(waitingRequests);
  const genex = usePlugins((s) => s.list.find((p) => p.manifest.id === GENEX_PLUGIN_ID));
  if (!me) return null;
  const open = (page: typeof PlayPage.Profile | typeof PlayPage.Friends): void => {
    onPlayMode(true);
    if (page === PlayPage.Friends) studio().play.showFriends();
    else studio().play.showProfile(me.id);
  };
  return (
    <div className="profile-plate" data-profile-plate>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="profile-plate-main" aria-label={WORDS.plateLabel(me.name)} data-avatar-host>
            <PersonAvatar person={me} size={28} />
            <span className="profile-plate-name">
              <span className="profile-plate-name-text">{me.name}</span>
              {me.pro && <span className="profile-plate-plan"> · {WORDS.pro}</span>}
            </span>
            <Icon name="chevrons" size={14} className="profile-plate-chevrons" />
          </button>
        </DropdownMenuTrigger>
        <PlateMenu me={me} waiting={waiting} genex={genex} onOpen={open} />
      </DropdownMenu>
      <FriendsStack onOpen={() => open(PlayPage.Friends)} />
    </div>
  );
}
