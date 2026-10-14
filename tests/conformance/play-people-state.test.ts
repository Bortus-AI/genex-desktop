/**
 * Play's people in the renderer: which page Play shows (a shelf, Friends, a profile and Back), and
 * what every list shows of a person after a press, a search typed over an older one, a refused
 * visibility change and a different account signing in. Driven through the pure transitions and
 * the store over a scripted API, with no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AvatarStyle,
  FriendAction,
  FriendStatus,
  type PlayFriendsPage,
  type PlayMe,
  type PlayPeopleResult,
  type PlayPerson,
  type PlayProfile,
  PresenceVisibility,
} from "../../src/shared/play-people.ts";
import { PlayShelf } from "../../src/shared/play.ts";
import type { StudioApi } from "../../src/shared/studio-api.ts";
import {
  createPeopleStore,
  initialPeople,
  meRead,
  pageAfter,
  primaryAction,
  relationshipChanged,
  waitingRequests,
} from "../../src/renderer/state/people.ts";
import {
  backFromProfile,
  friendsShown,
  initialPlay,
  PlayPage,
  profileShown,
  shelfChosen,
} from "../../src/renderer/state/play.ts";

const person = (id: string, name = id): PlayPerson => ({ id, name, imageUrl: null, avatarVariant: 0, pro: false });
const me = (id = "me"): PlayMe => ({
  ...person(id, "Rab Neba"),
  joinedAt: null,
  avatarStyle: AvatarStyle.Generated,
  photoUrl: null,
  avatarVariantKept: true,
});
/** A profile with nothing on it but its person. */
const profileOf = (who: PlayPerson, status: FriendStatus): PlayProfile => ({
  person: who,
  joinedAt: null,
  games: [],
  status,
  friends: null,
  players: null,
});

function page(overrides: Partial<PlayFriendsPage> = {}): PlayFriendsPage {
  return {
    friends: [{ ...person("ann"), playing: { slug: "stick-steel", title: "Stick & Steel" }, games: 2 }],
    incoming: [{ ...person("juno"), requestedAt: "2026-10-12T09:00:00.000Z" }],
    outgoing: [{ ...person("ola"), requestedAt: "2026-10-12T09:00:00.000Z" }],
    visibility: PresenceVisibility.Game,
    inviteLink: "https://genex.games/?ref=abc",
    inviteBonus: 100,
    ...overrides,
  };
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PeopleApi = Parameters<typeof createPeopleStore>[0];

/** The people calls, each answering what the test says, every call kept. */
function fakeApi(handlers: Partial<PeopleApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const record = <K extends keyof PeopleApi>(name: K, fallback: StudioApi[K]): StudioApi[K] =>
    ((...args: unknown[]) => {
      calls.push([name, args[0]]);
      return ((handlers[name] ?? fallback) as (...a: unknown[]) => unknown)(...args);
    }) as StudioApi[K];
  const api: PeopleApi = {
    playMe: record("playMe", async () => me()),
    playRename: record("playRename", async () => me()),
    playAvatar: record("playAvatar", async () => me()),
    playProfile: record("playProfile", async () => profileOf(person("x"), FriendStatus.None)),
    playFriends: record("playFriends", async () => page()),
    playFriend: record("playFriend", async () => FriendStatus.Friends),
    playPeople: record("playPeople", async () => ({ people: [], unavailable: false })),
    playVisibility: record("playVisibility", async (v: PresenceVisibility) => v),
    playAvatarStyle: record("playAvatarStyle", async () => me()),
    playAvatarVariant: record("playAvatarVariant", async (variant: number) => ({ ...me(), avatarVariant: variant })),
    playStats: record("playStats", async () => null),
    playCreators: record("playCreators", async () => null),
  };
  return { api, calls };
}

describe("Play's pages", () => {
  it("opens Friends and profiles from the sidebar, and Back goes where the profile was opened from", () => {
    let state = initialPlay();
    assert.equal(state.view.page, PlayPage.Shelf);
    state = friendsShown(state);
    state = profileShown(state, "ann");
    assert.deepEqual(state.view, { page: PlayPage.Profile, userId: "ann", from: PlayPage.Friends });
    // A profile opened from a profile goes back to where the first one came from.
    state = profileShown(state, "juno");
    assert.deepEqual(state.view, { page: PlayPage.Profile, userId: "juno", from: PlayPage.Friends });
    assert.equal(backFromProfile(state).view.page, PlayPage.Friends);
    const fromShelf = profileShown(initialPlay(), "ann");
    assert.equal(backFromProfile(fromShelf).view.page, PlayPage.Shelf);
  });

  it("goes back to a shelf's dashboard whenever a shelf is chosen, the same one too", () => {
    const onFriends = friendsShown(initialPlay());
    const games = shelfChosen(onFriends, PlayShelf.Games);
    assert.equal(games.view.page, PlayPage.Shelf);
    assert.equal(games.shelf, PlayShelf.Games);
    assert.equal(shelfChosen(games, PlayShelf.Games), games, "nothing changes on the shelf already shown");
  });
});

describe("what every list shows of a person after a press", () => {
  it("moves an accepted request into Friends, and a withdrawn one out of the requests", () => {
    const accepted = pageAfter(page(), person("juno"), FriendStatus.Friends);
    assert.deepEqual(ids(accepted.friends), ["ann", "juno"]);
    assert.deepEqual(ids(accepted.incoming), []);
    const withdrawn = pageAfter(page(), person("ola"), FriendStatus.None);
    assert.deepEqual(ids(withdrawn.outgoing), []);
    const removed = pageAfter(page(), person("ann"), FriendStatus.None);
    assert.deepEqual(ids(removed.friends), []);
    const asked = pageAfter(page(), person("milo"), FriendStatus.Outgoing);
    assert.deepEqual(ids(asked.outgoing), ["ola", "milo"]);
  });

  it("changes the profile and the search results showing them as well", () => {
    const result: PlayPeopleResult = {
      people: [{ ...person("milo"), status: FriendStatus.None, games: null }],
      unavailable: false,
    };
    const state = {
      ...initialPeople(),
      friends: page(),
      profiles: {
        milo: {
          status: "ready" as const,
          profile: profileOf(person("milo"), FriendStatus.None),
        },
      },
      search: { query: "mi", status: "ready" as const, result },
    };
    const after = relationshipChanged(state, person("milo"), FriendStatus.Outgoing);
    assert.equal(after.profiles.milo?.profile?.status, FriendStatus.Outgoing);
    assert.equal(after.search.result?.people[0]?.status, FriendStatus.Outgoing);
    assert.deepEqual(ids(after.friends?.outgoing ?? []), ["ola", "milo"]);
  });

  it("offers the one action that fits where someone stands", () => {
    assert.equal(primaryAction(FriendStatus.None), FriendAction.Add);
    assert.equal(primaryAction(FriendStatus.Incoming), FriendAction.Accept);
    assert.equal(primaryAction(FriendStatus.Outgoing), FriendAction.Withdraw);
    assert.equal(primaryAction(FriendStatus.Self), null);
    assert.equal(primaryAction(FriendStatus.Unavailable), null);
  });
});

describe("the people store", () => {
  it("forgets the last account's friends and profiles when another signs in, or nobody", () => {
    const signedIn = { ...meRead(initialPeople(), me("a")), friends: page() };
    assert.equal(waitingRequests(signedIn), 1);
    const other = meRead(signedIn, me("b"));
    assert.equal(other.friends, null);
    const out = meRead(signedIn, null);
    assert.equal(out.me, null);
    assert.equal(out.meKnown, true);
    assert.equal(waitingRequests(out), 0);
  });

  it("reads the Friends page only while signed in", async () => {
    const { api, calls } = fakeApi({ playMe: async () => null });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    assert.deepEqual(
      calls.map(([name]) => name),
      ["playMe"],
    );
  });

  it("moves a person at once on a press, then reads the Friends page again behind it", async () => {
    const reread = deferred<PlayFriendsPage>();
    const answers = [Promise.resolve(page()), reread.promise];
    const { api, calls } = fakeApi({ playFriends: (() => answers.shift()) as StudioApi["playFriends"] });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await store.act(FriendAction.Accept, person("juno"));
    assert.deepEqual(ids(store.getState().friends?.friends ?? []), ["ann", "juno"], "at once, before Genex re-reads");
    reread.resolve(page({ friends: [], incoming: [] }));
    await reread.promise;
    await Promise.resolve();
    assert.deepEqual(ids(store.getState().friends?.friends ?? []), [], "then as Genex reads it");
    assert.deepEqual(calls.find(([name]) => name === "playFriend")?.[1], { action: "accept", userId: "juno" });
    assert.equal(calls.filter(([name]) => name === "playFriends").length, 2, "read again behind the press");
    assert.deepEqual(store.getState().busy, {}, "nobody waits once Genex answered");
  });

  it("keeps every list as it was when Genex refuses a press", async () => {
    const { api } = fakeApi({
      playFriend: async () => {
        throw new Error("403");
      },
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await assert.rejects(store.act(FriendAction.Accept, person("juno")));
    assert.deepEqual(ids(store.getState().friends?.incoming ?? []), ["juno"]);
    assert.deepEqual(store.getState().busy, {});
  });

  it("lets an older search's late answer land nowhere", async () => {
    const slow = deferred<PlayPeopleResult>();
    const answers = [
      slow.promise,
      Promise.resolve({ people: [{ ...person("mira"), status: FriendStatus.None, games: 3 }], unavailable: false }),
    ];
    const { api } = fakeApi({ playPeople: (() => answers.shift()) as StudioApi["playPeople"] });
    const store = createPeopleStore(api);
    const first = store.search("mi");
    await store.search("mira");
    slow.resolve({ people: [{ ...person("milo"), status: FriendStatus.None, games: null }], unavailable: false });
    await first;
    assert.deepEqual(ids(store.getState().search.result?.people ?? []), ["mira"]);
    assert.equal(store.getState().search.query, "mira");
  });

  it("sends no search for a query too short to send", async () => {
    const { api, calls } = fakeApi();
    const store = createPeopleStore(api);
    await store.search(" m ");
    assert.equal(calls.length, 0);
    assert.equal(store.getState().search.result, null);
  });

  it("puts the visibility back when Genex refuses the change", async () => {
    const { api } = fakeApi({
      playVisibility: async () => {
        throw new Error("offline");
      },
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await assert.rejects(store.setVisibility(PresenceVisibility.Hidden));
    assert.equal(store.getState().friends?.visibility, PresenceVisibility.Game);
  });

  it("keeps the account's own profile in step with a rename", async () => {
    const renamed = { ...me(), name: "Rab" };
    const { api } = fakeApi({
      playProfile: async () => profileOf(person("me", "Rab Neba"), FriendStatus.Self),
      playRename: async () => renamed,
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadProfile("me");
    await store.rename("Rab");
    assert.equal(store.getState().me?.name, "Rab");
    assert.equal(store.getState().profiles.me?.profile?.person.name, "Rab");
  });
});

describe("regenerating the account's avatar", () => {
  it("shows the new avatar at once, then as Genex keeps it", async () => {
    const kept = deferred<PlayMe | null>();
    const { api, calls } = fakeApi({ playAvatarVariant: () => kept.promise });
    const store = createPeopleStore(api);
    await store.loadMe();
    const pressed = store.setAvatarVariant(42);
    assert.equal(store.getState().me?.avatarVariant, 42, "at once, before Genex answers");
    kept.resolve({ ...me(), avatarVariant: 42 });
    await pressed;
    assert.equal(store.getState().me?.avatarVariant, 42);
    assert.deepEqual(calls.at(-1), ["playAvatarVariant", 42]);
  });

  it("shows what Genex kept when it refuses, and says so", async () => {
    const { api, calls } = fakeApi({ playAvatarVariant: async () => Promise.reject(new Error("refused")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    await assert.rejects(store.setAvatarVariant(42), /refused/);
    assert.equal(store.getState().me?.avatarVariant, 0);
    assert.deepEqual(calls.at(-1)?.[0], "playMe", "read again, not guessed");
  });

  it("saves fast presses one after another, so the last press is what shows and what is kept", async () => {
    const first = deferred<PlayMe | null>();
    const second = deferred<PlayMe | null>();
    const answers = [first.promise, second.promise];
    const { api, calls } = fakeApi({ playAvatarVariant: () => answers.shift() ?? Promise.reject(new Error("extra")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    const one = store.setAvatarVariant(1);
    const two = store.setAvatarVariant(2);
    assert.equal(store.getState().me?.avatarVariant, 2, "the newest press shows at once");
    await Promise.resolve();
    const saves = () => calls.filter(([name]) => name === "playAvatarVariant").map(([, variant]) => variant);
    assert.deepEqual(saves(), [1], "the second waits for the first");
    first.resolve({ ...me(), avatarVariant: 1 });
    await one;
    assert.equal(store.getState().me?.avatarVariant, 2, "an older answer never puts its face back");
    assert.deepEqual(saves(), [1, 2]);
    second.resolve({ ...me(), avatarVariant: 2 });
    await two;
    assert.equal(store.getState().me?.avatarVariant, 2);
  });
});
