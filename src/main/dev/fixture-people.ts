/**
 * Play's people in a fixture profile: the API's answers for the account, profiles (and their
 * friends), friends, requests and people search, made here in the shapes the API serves, so the
 * profile plate, the profile page and the Friends page can be checked with no socket and no Genex
 * account. A launch is signed out unless it asks for a fixture account
 * (`STUDIO_FIXTURE_GENEX_ACCOUNT=1`, or `new`, `quiet` or `fresh` for a new account with no games and
 * nobody yet, with games nobody played this week, or with one game two days old); then every call carries that
 * account's token. State lives for the launch: adding a friend, renaming the account or choosing an
 * avatar shows at once and is gone at the next launch.
 */
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import type { GalleryAnswer } from "../play/gallery.ts";
import { PeopleRoute } from "../play/people.ts";

/** The fixture accounts a launch may sign in as: `STUDIO_FIXTURE_GENEX_ACCOUNT`'s values. */
export const FixtureAccount = {
  /** A creator with friends, games and a busy week. */
  Full: "1",
  /** A new account: no games and no friends yet. */
  New: "new",
  /** Games, but nobody played them this week. */
  Quiet: "quiet",
  /** One game, published two days ago. */
  Fresh: "fresh",
} as const;
export type FixtureAccount = (typeof FixtureAccount)[keyof typeof FixtureAccount];

/** The token the full fixture account's calls carry; nothing outside a fixture launch accepts it. */
export const FIXTURE_ACCOUNT_TOKEN = "fixture-genex-account";

/** The token a fixture account's calls carry. */
export const fixtureAccountToken = (account: FixtureAccount): string =>
  account === FixtureAccount.Full ? FIXTURE_ACCOUNT_TOKEN : `${FIXTURE_ACCOUNT_TOKEN}:${account}`;

/** The fixture account a token signs in as, or null for any other token. */
export function fixtureAccountOf(token: string | undefined): FixtureAccount | null {
  return Object.values(FixtureAccount).find((account) => fixtureAccountToken(account) === token) ?? null;
}

/** Whether a value names a fixture account. */
export const isFixtureAccount = (value: unknown): value is FixtureAccount =>
  typeof value === "string" && (Object.values(FixtureAccount) as string[]).includes(value);

/** A fixture person as the API serves one. */
interface FixturePerson {
  id: string;
  name: string;
  image: null;
  pro: boolean;
  createdAt: string;
  avatarStyle: "generated";
}

/** The id the fixture catalog gives an author: their name in lowercase words. */
export const fixtureAuthorId = (name: string): string =>
  `fx-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

const person = (name: string, pro = false, createdAt = "2026-08-12T10:00:00.000Z"): FixturePerson => ({
  id: fixtureAuthorId(name),
  name,
  image: null,
  pro,
  createdAt,
  avatarStyle: "generated",
});

/** Everyone the fixture knows, the account first. */
const ME = person("Rab Neba", true, "2026-05-18T10:53:42.000Z");
const PEOPLE = [
  person("Simeon M", true, "2026-07-18T10:53:42.000Z"),
  person("Mira Kovač"),
  person("Tomás Reyes"),
  person("Kenji Mori", true),
  person("Juno Park"),
  person("Lena Ahl"),
  person("Ola Nowak"),
  person("Milo Santos", true),
  person("Dmitri Minsky"),
  person("Gab"),
  person("Threejs Community"),
  person("Pia Sorensen"),
  person("Omar Haddad"),
  person("Yuki Tanaka", true),
];
const byName = (name: string): FixturePerson => PEOPLE.find((p) => p.name === name) ?? person(name);
const idOf = (name: string): string => byName(name).id;

/** A drawn square picture a fixture "upload" leaves as the account's photo. */
const FIXTURE_PHOTO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b3a67"/><circle cx="32" cy="26" r="12" fill="#f2c9a8"/><path d="M10 64c2-14 12-20 22-20s20 6 22 20z" fill="#e0a55a"/></svg>',
)}`;

/** The launch's own settings, changed by the fixture account's writes. */
const state = {
  name: ME.name,
  photo: null as string | null,
  avatarStyle: "generated" as "generated" | "photo",
  avatarVariant: 0,
  visibility: "game",
};

/** An account's friends and its requests both ways. */
interface Circle {
  friends: Set<string>;
  incoming: Set<string>;
  outgoing: Set<string>;
}

/** The fixture accounts' circles for the launch: a new account has nobody yet; the others share one. */
const CIRCLES = {
  shared: {
    friends: new Set(
      ["Simeon M", "Mira Kovač", "Tomás Reyes", "Kenji Mori", "Pia Sorensen", "Omar Haddad", "Yuki Tanaka"].map(idOf),
    ),
    incoming: new Set(["Juno Park", "Lena Ahl"].map(idOf)),
    outgoing: new Set([idOf("Ola Nowak")]),
  },
  new: { friends: new Set<string>(), incoming: new Set<string>(), outgoing: new Set<string>() },
} satisfies Record<string, Circle>;

/** The circle a fixture account has. */
const circleOf = (account: FixtureAccount): Circle => (account === FixtureAccount.New ? CIRCLES.new : CIRCLES.shared);

/** Who is in which fixture game right now. */
const PLAYING: Record<string, { slug: string; title: string }> = {
  [idOf("Tomás Reyes")]: { slug: "stick-steel", title: "Stick & Steel" },
  [idOf("Pia Sorensen")]: { slug: "sandstorm", title: "SANDSTORM" },
  [idOf("Kenji Mori")]: { slug: "lost-cathedral", title: "Lost Cathedral" },
};

/** Who else is friends with whom, besides the account (whose friends are its circle's). */
const FRIENDSHIPS: Record<string, string[]> = {
  [idOf("Simeon M")]: ["Mira Kovač", "Kenji Mori", "Gab", "Lena Ahl", "Juno Park", "Milo Santos"].map(idOf),
  [idOf("Gab")]: ["Simeon M", "Dmitri Minsky", "Threejs Community"].map(idOf),
  [idOf("Mira Kovač")]: ["Simeon M", "Juno Park"].map(idOf),
};
/** When two people became friends: a fixed date a little after the later of them joined. */
const SINCE = "2026-09-02T12:00:00.000Z";

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
const slim = (p: FixturePerson) => ({ id: p.id, name: p.name, image: p.image, pro: p.pro, avatarStyle: p.avatarStyle });
const me = (): FixturePerson => ({ ...ME, name: state.name });
/** The account as others see it: its photo only when it chose the photo. */
const meSlim = () => ({
  ...slim(me()),
  image: state.photo,
  avatarStyle: state.avatarStyle,
  avatarVariant: state.avatarVariant,
});

/** A fixture person's friends, the account among them where it is. */
function friendsOf(id: string, circle: Circle): string[] {
  const listed = FRIENDSHIPS[id] ?? [];
  const known = Object.entries(FRIENDSHIPS)
    .filter(([, ids]) => ids.includes(id))
    .map(([other]) => other);
  const ids = new Set([...listed, ...known]);
  if (circle.friends.has(id)) ids.add(ME.id);
  ids.delete(id);
  return [...ids];
}

/** The relationship the fixture account has with `id`. */
function statusOf(id: string, circle: Circle): string {
  if (id === ME.id) return "self";
  if (circle.friends.has(id)) return "friends";
  if (circle.outgoing.has(id)) return "outgoing";
  return circle.incoming.has(id) ? "incoming" : "none";
}

/** What the fixture's author answers need: each author's published games. */
export interface FixtureCatalog {
  /** The gallery items of an author's games, as a profile lists them. */
  games(authorId: string): unknown[];
}

/** The account's own games for a fixture account: none, one fresh game, or the catalog's "Simeon M" games. */
export function fixtureOwnGames(account: FixtureAccount, catalog: FixtureCatalog): unknown[] {
  const games = catalog.games(idOf("Simeon M"));
  if (account === FixtureAccount.New) return [];
  return account === FixtureAccount.Fresh ? games.slice(0, 1) : games;
}

/** The games one person published, the account's by its fixture account. */
const gamesOf = (id: string, account: FixtureAccount, catalog: FixtureCatalog): unknown[] =>
  id === ME.id ? fixtureOwnGames(account, catalog) : catalog.games(id);

/** The friends page's three reads. */
function friendsList(account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const friends = PEOPLE.filter((p) => circleOf(account).friends.has(p.id)).map((p) => ({
    ...slim(p),
    playing: PLAYING[p.id] ?? null,
    games: gamesOf(p.id, account, catalog).length,
  }));
  friends.sort((a, b) => Number(b.playing !== null) - Number(a.playing !== null) || a.name.localeCompare(b.name));
  return ok({ friends });
}
function requests(circle: Circle): GalleryAnswer {
  const rows = (ids: Set<string>) =>
    PEOPLE.filter((p) => ids.has(p.id)).map((p) => ({ ...slim(p), requestedAt: "2026-10-12T09:00:00.000Z" }));
  return ok({ incoming: rows(circle.incoming), outgoing: rows(circle.outgoing) });
}

/** People whose name holds the query, starts-with first, as the API answers. */
function search(query: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const q = query.trim().toLowerCase();
  const found = PEOPLE.filter((p) => p.id !== ME.id && p.name.toLowerCase().includes(q));
  found.sort(
    (a, b) =>
      Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) ||
      a.name.localeCompare(b.name),
  );
  const people = found.slice(0, 20).map((p) => ({
    ...slim(p),
    status: statusOf(p.id, circleOf(account)),
    games: gamesOf(p.id, account, catalog).length,
  }));
  return ok({ people });
}

/** A friend write by the fixture account, as the API answers it. */
function friendWrite(method: string, pathname: string, body: unknown, circle: Circle): GalleryAnswer {
  const userId = typeof (body as { userId?: unknown })?.userId === "string" ? (body as { userId: string }).userId : "";
  if (method === "POST" && pathname === PeopleRoute.Requests) {
    if (circle.incoming.delete(userId)) circle.friends.add(userId);
    else circle.outgoing.add(userId);
    const user = PEOPLE.find((p) => p.id === userId) ?? person(userId);
    return ok({ status: circle.friends.has(userId) ? "friends" : "outgoing", user: slim(user) });
  }
  const id = decodeURIComponent(pathname.split("/").at(pathname.endsWith("/accept") ? -2 : -1) ?? "");
  if (pathname.endsWith("/accept") && circle.incoming.delete(id)) circle.friends.add(id);
  else if (pathname.startsWith(PeopleRoute.request(""))) {
    circle.incoming.delete(id);
    circle.outgoing.delete(id);
  } else circle.friends.delete(id);
  return ok({ status: circle.friends.has(id) ? "friends" : "none", userId: id });
}

/** How many different people played a fixture person's games: about a third of their plays. */
function playersOf(games: unknown[]): number {
  const plays = games.reduce<number>((sum, game) => sum + Number((game as { playsCount?: number }).playsCount ?? 0), 0);
  return Math.round(plays * 0.36);
}

/** A profile: the person, their fixture games and how many people played them. */
function profile(id: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const found = id === ME.id ? meSlim() : PEOPLE.find((p) => p.id === id);
  if (!found) return NOT_FOUND;
  const createdAt = id === ME.id ? ME.createdAt : (PEOPLE.find((p) => p.id === id)?.createdAt ?? ME.createdAt);
  const games = gamesOf(id, account, catalog);
  const user = { ...found, createdAt, githubUrl: null };
  return ok({ user, games, avatar: null, players: playersOf(games) });
}

/**
 * Someone's friends as the viewer sees them: the viewer's own friends first-class (`mutual`), and
 * a game shown only where the viewer is that friend's friend too.
 */
function profileFriends(id: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  if (id !== ME.id && !PEOPLE.some((p) => p.id === id)) return NOT_FOUND;
  const circle = circleOf(account);
  const ids = id === ME.id ? [...circle.friends] : friendsOf(id, circle);
  const friends = ids.map((friendId) => {
    const mutual = circle.friends.has(friendId);
    const shown = friendId === ME.id ? meSlim() : slim(byName(PEOPLE.find((p) => p.id === friendId)?.name ?? ""));
    return {
      ...shown,
      playing: mutual || id === ME.id ? (PLAYING[friendId] ?? null) : null,
      games: gamesOf(friendId, account, catalog).length,
      since: SINCE,
      mutual,
    };
  });
  return ok({ friends });
}

/** An own-profile edit, refused whole as genex.games refuses it: nothing changes when one field is wrong. */
function patchAccount(body: unknown): GalleryAnswer {
  const { name, avatarStyle, avatarVariant } = (body ?? {}) as {
    name?: unknown;
    avatarStyle?: unknown;
    avatarVariant?: unknown;
  };
  if (avatarStyle === "photo" && !state.photo) return { status: 400, body: { error: "no photo uploaded" } };
  if (avatarVariant !== undefined && !isAvatarVariant(avatarVariant))
    return { status: 400, body: { error: "not an avatar variant" } };
  if (typeof name === "string") state.name = name;
  if (avatarStyle === "generated" || avatarStyle === "photo") state.avatarStyle = avatarStyle;
  if (isAvatarVariant(avatarVariant)) state.avatarVariant = avatarVariant;
  return ok({ user: meSlim() });
}

/** The account's own writes: its name, its avatar style and variant, and a photo "upload" that stays in memory. */
function accountWrite(method: string, pathname: string, body: unknown): GalleryAnswer | null {
  if (method === "PATCH" && pathname === PeopleRoute.MyAccount) return patchAccount(body);
  if (method === "POST" && pathname === PeopleRoute.AvatarUpload)
    return ok({ uploadUrl: "https://fixture.invalid/avatar", key: `avatars/${ME.id}/fixture.webp` });
  if (method === "POST" && pathname === PeopleRoute.AvatarCommit) {
    state.photo = FIXTURE_PHOTO;
    return ok({ user: meSlim() });
  }
  return null;
}

/** The routes under /api/users and /api/friends that need the account. */
const needsAccount = (pathname: string): boolean =>
  pathname === PeopleRoute.Me || pathname.startsWith("/api/friends") || pathname.startsWith("/api/users/me");

/** A public read under /api/users: a profile or a profile's friends. */
function publicRead(pathname: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer | null {
  const prefix = PeopleRoute.user("");
  if (!pathname.startsWith(prefix) || pathname.startsWith(PeopleRoute.MyAccount)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.endsWith("/friends"))
    return profileFriends(decodeURIComponent(rest.slice(0, -"/friends".length)), account, catalog);
  return rest.includes("/") ? NOT_FOUND : profile(decodeURIComponent(rest), account, catalog);
}

/**
 * The fixture account's answer to a people route, or null when the route is not one of them (the
 * gallery's fixture answers it). Signed out, every people route but a public read is a 401.
 */
export function fixturePeopleAnswer(
  route: string,
  init: { method?: string; body?: unknown; token?: string },
  catalog: FixtureCatalog,
): GalleryAnswer | null {
  const [pathname = "", query = ""] = route.split("?");
  const method = init.method ?? "GET";
  const account = fixtureAccountOf(init.token);
  if (method === "GET") {
    const shown = publicRead(pathname, account ?? FixtureAccount.Full, catalog);
    if (shown) return shown;
  }
  if (!needsAccount(pathname)) return null;
  if (!account) return { status: 401, body: null };
  if (pathname === PeopleRoute.Me)
    return ok({
      user: {
        ...me(),
        image: state.photo,
        photo: state.photo,
        avatarStyle: state.avatarStyle,
        avatarVariant: state.avatarVariant,
      },
      isAdmin: false,
    });
  const write = accountWrite(method, pathname, init.body);
  if (write) return write;
  if (method === "GET") return peopleRead(pathname, query, account, catalog);
  if (method === "PATCH" && pathname === PeopleRoute.Visibility) {
    const visibility = (init.body as { presenceVisibility?: unknown })?.presenceVisibility;
    if (visibility === "game" || visibility === "hidden") state.visibility = visibility;
    return ok({ presenceVisibility: state.visibility });
  }
  return friendWrite(method, pathname, init.body, circleOf(account));
}

/** The fixture account's reads under /api/friends. */
function peopleRead(pathname: string, query: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  if (pathname === PeopleRoute.Friends) return friendsList(account, catalog);
  if (pathname === PeopleRoute.Requests) return requests(circleOf(account));
  if (pathname === PeopleRoute.Visibility) return ok({ presenceVisibility: state.visibility });
  if (pathname === PeopleRoute.Search) return search(new URLSearchParams(query).get("q") ?? "", account, catalog);
  if (pathname.startsWith(PeopleRoute.status("")))
    return ok({ status: statusOf(pathname.split("/").at(-1) ?? "", circleOf(account)) });
  return NOT_FOUND;
}

/** The fixture account's invite link, as `/api/referrals/me` answers it. */
export const FIXTURE_REFERRAL = {
  code: "fixture1",
  link: "https://genex.games/?ref=fixture1",
  inviterBonus: 100,
} as const;

/** The fixture account's own id, for the fixture's creator numbers. */
export const FIXTURE_ME_ID = ME.id;
/** Fixture people as the API names a person, for Top creators. */
export const fixturePeople = () => PEOPLE.map(slim);
