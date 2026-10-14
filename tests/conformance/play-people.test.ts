/**
 * Play's people: main reads the signed-in Genex account, public profiles, friends and people search
 * from genex.games, and writes the account's name, picture, friendships and visibility with the
 * account's token. What the API answers is hostile input (a row without an id is dropped, a picture
 * off Genex's hosts is never handed on, nobody's email is), and a bad id, name, query or picture
 * from the renderer never reaches the network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIXTURE_ACCOUNT_TOKEN,
  FixtureAccount,
  fixtureAccountToken,
  fixturePeopleAnswer,
} from "../../src/main/dev/fixture-people.ts";
import { type GalleryAnswer, type GalleryRequest, PlayRoute, SignInNeeded } from "../../src/main/play/gallery.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { isAvatarWebp, PeopleRoute, playPeople, toPerson } from "../../src/main/play/people.ts";
import { AvatarStyle, FriendAction, FriendStatus, PresenceVisibility } from "../../src/shared/play-people.ts";

const TOKEN = "genex-cli-token";
const AVATAR = "https://api.genex.games/api/character-assets/avatars/u1/1.webp";

interface Call {
  route: string;
  method: string;
  token?: string;
  body?: unknown;
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const status = (code: number): GalleryAnswer => ({ status: code, body: null });

/** People over a scripted API: each call answers what `answers` says, and every call and upload is kept. */
function rig(answers: (call: Call) => GalleryAnswer, options: { token?: string | undefined; upload?: number } = {}) {
  const token = "token" in options ? options.token : TOKEN;
  const calls: Call[] = [];
  const refused: string[] = [];
  const uploads: Array<{ url: string; bytes: number; type: string }> = [];
  let clock = 1_000_000;
  const request: GalleryRequest = async (route, init) => {
    const call: Call = { route, method: init.method ?? "GET", ...init };
    calls.push(call);
    return answers(call);
  };
  const people = playPeople({
    request,
    token: async () => token,
    now: () => clock,
    upload: async (url, bytes, type) => {
      uploads.push({ url, bytes: bytes.length, type });
      return options.upload ?? 200;
    },
    refused: (value) => refused.push(value),
  });
  return { people, calls, uploads, refused, advance: (ms: number) => (clock += ms) };
}

/** The account as `/api/me` and the public profile answer it. */
function accountApi(call: Call): GalleryAnswer {
  if (call.route === PeopleRoute.Me)
    return ok({
      user: {
        id: "u1",
        name: "Rab Neba",
        email: "private@example.com",
        image: AVATAR,
        createdAt: "2026-07-18T10:53:42Z",
      },
      isAdmin: false,
    });
  if (call.route === PeopleRoute.user("u1")) return ok({ user: { id: "u1", name: "Rab Neba", pro: true }, games: [] });
  return status(404);
}

/** A small WebP: the RIFF/WEBP header and a little body. */
function webp(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

describe("the Genex account Play is signed in as", () => {
  it("is null signed out, without a call", async () => {
    const { people, calls } = rig(accountApi, { token: undefined });
    assert.equal(await people.me(), null);
    assert.equal(calls.length, 0);
  });

  it("is the account with its Pro flag and join date, never its email, and is read once a while", async () => {
    const { people, calls, advance } = rig(accountApi);
    const me = await people.me();
    assert.deepEqual(me, {
      id: "u1",
      name: "Rab Neba",
      imageUrl: null,
      avatarVariant: 0,
      pro: true,
      joinedAt: "2026-07-18T10:53:42.000Z",
      avatarStyle: null,
      photoUrl: null,
      avatarVariantKept: false,
    });
    assert.ok(!JSON.stringify(me).includes("example.com"), "no email crosses");
    await people.me();
    assert.equal(calls.filter((c) => c.route === PeopleRoute.Me).length, 1, "kept a while");
    advance(60_000);
    await people.me();
    assert.equal(calls.filter((c) => c.route === PeopleRoute.Me).length, 2, "read again later");
  });

  it("shows its photo only when it chose the photo, and keeps the photo it uploaded either way", async () => {
    const answer = (avatarStyle: string) => (call: Call) =>
      call.route === PeopleRoute.Me
        ? ok({ user: { id: "u1", name: "Rab Neba", image: AVATAR, photo: AVATAR, avatarStyle } })
        : accountApi(call);
    const photo = await rig(answer(AvatarStyle.Photo)).people.me();
    assert.equal(photo?.imageUrl, AVATAR);
    assert.equal(photo?.avatarStyle, AvatarStyle.Photo);
    const generated = await rig(answer(AvatarStyle.Generated)).people.me();
    assert.equal(generated?.imageUrl, null, "the generated avatar shows");
    assert.equal(generated?.photoUrl, AVATAR, "the uploaded photo is still there to switch back to");
    assert.equal((await rig(answer("sparkles")).people.me())?.avatarStyle, null, "an unknown style is no style");
  });

  it("switches between its generated avatar and its photo, everywhere at once", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    await people.setAvatarStyle(AvatarStyle.Photo);
    assert.deepEqual(
      calls.find((c) => c.method === "PATCH"),
      { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { avatarStyle: "photo" } },
    );
    const before = calls.length;
    await assert.rejects(people.setAvatarStyle("sparkles" as AvatarStyle), /avatar style/);
    assert.equal(calls.length, before, "a bad style never reaches the network");
  });

  it("draws the avatar variant it regenerated to, and knows when genex.games keeps one", async () => {
    const answer = (avatarVariant: unknown) => (call: Call) =>
      call.route === PeopleRoute.Me ? ok({ user: { id: "u1", name: "Rab Neba", avatarVariant } }) : accountApi(call);
    const kept = await rig(answer(917_204)).people.me();
    assert.equal(kept?.avatarVariant, 917_204);
    assert.equal(kept?.avatarVariantKept, true);
    for (const bad of [-1, 1.5, 2_147_483_648, "7", undefined]) {
      const me = await rig(answer(bad)).people.me();
      assert.equal(me?.avatarVariant, 0, `${String(bad)} draws the first avatar`);
      assert.equal(me?.avatarVariantKept, false, `${String(bad)} is not a kept variant`);
    }
  });

  it("regenerates to a variant everywhere at once, and never sends a bad one", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    await people.setAvatarVariant(42);
    assert.deepEqual(
      calls.find((c) => c.method === "PATCH"),
      { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { avatarVariant: 42 } },
    );
    const before = calls.length;
    for (const bad of [-1, 0.5, 2_147_483_648, Number.NaN])
      await assert.rejects(people.setAvatarVariant(bad), /avatar variant/, String(bad));
    assert.equal(calls.length, before, "a bad variant never reaches the network");
  });

  it("is null when Genex refuses the token, and says which token it refused", async () => {
    const { people, refused } = rig(() => status(401));
    assert.equal(await people.me(), null);
    assert.deepEqual(refused, [TOKEN], "the account reads as ended, not as signed out");
  });

  it("renames itself with a trimmed 2–20 character name, and sends nothing else", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    for (const bad of ["", " a ", "x".repeat(21), "   "]) await assert.rejects(people.rename(bad), /2 to 20/);
    assert.equal(calls.length, 0, "a bad name never reaches the network");
    await people.rename("  Rab  ");
    const patch = calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch, { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { name: "Rab" } });
  });

  it("changes its picture: an upload address, the bytes there, then the commit, in that order", async () => {
    const { people, calls, uploads } = rig((call) => {
      if (call.route === PeopleRoute.AvatarUpload)
        return ok({ uploadUrl: "https://r2.example/avatars/u1.webp?sig=1", key: "avatars/u1/1.webp" });
      if (call.route === PeopleRoute.AvatarCommit) return ok({ user: {} });
      return accountApi(call);
    });
    await people.setAvatar(webp());
    assert.deepEqual(
      calls.filter((c) => c.method === "POST").map((c) => [c.route, c.body]),
      [
        [PeopleRoute.AvatarUpload, { bytes: 64 }],
        [PeopleRoute.AvatarCommit, { key: "avatars/u1/1.webp" }],
      ],
    );
    assert.deepEqual(uploads, [{ url: "https://r2.example/avatars/u1.webp?sig=1", bytes: 64, type: "image/webp" }]);
  });

  it("shows an uploaded photo at once where genex.games keeps the choice, and only there", async () => {
    const slot = { uploadUrl: "https://r2.example/avatars/u1.webp?sig=1", key: "avatars/u1/1.webp" };
    const keeps = (style: string | null) => (call: Call) => {
      if (call.route === PeopleRoute.AvatarUpload) return ok(slot);
      if (call.route === PeopleRoute.AvatarCommit || call.method === "PATCH") return ok({ user: {} });
      if (call.route === PeopleRoute.Me)
        return ok({ user: { id: "u1", name: "Rab Neba", image: AVATAR, photo: AVATAR, avatarStyle: style } });
      return accountApi(call);
    };
    const choosing = rig(keeps(AvatarStyle.Generated));
    await choosing.people.setAvatar(webp());
    assert.deepEqual(
      choosing.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [{ avatarStyle: "photo" }],
    );
    const older = rig(keeps(null));
    await older.people.setAvatar(webp());
    assert.equal(older.calls.filter((c) => c.method === "PATCH").length, 0, "no choice to make where none is kept");
  });

  it("uploads nothing that is not a small WebP, and commits nothing that did not upload", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    const cases: Array<[string, Uint8Array]> = [
      ["a PNG", png],
      ["too large", webp(512 * 1024 + 1)],
      ["too short", new Uint8Array(4)],
    ];
    for (const [name, bytes] of cases) {
      const { people, calls, uploads } = rig(accountApi);
      await assert.rejects(people.setAvatar(bytes), /WebP/, name);
      assert.equal(calls.length + uploads.length, 0, `${name}: nothing sent`);
    }
    const plain = rig((call) =>
      call.route === PeopleRoute.AvatarUpload ? ok({ uploadUrl: "http://r2.example/x", key: "k" }) : accountApi(call),
    );
    await assert.rejects(plain.people.setAvatar(webp()), /upload/);
    assert.equal(plain.uploads.length, 0, "never to a plain-http address");
    const refused = rig(
      (call) =>
        call.route === PeopleRoute.AvatarUpload
          ? ok({ uploadUrl: "https://r2.example/x", key: "k" })
          : accountApi(call),
      { upload: 403 },
    );
    await assert.rejects(refused.people.setAvatar(webp()), /did not upload/);
    assert.equal(refused.calls.filter((c) => c.route === PeopleRoute.AvatarCommit).length, 0, "no commit");
  });

  it("knows a WebP by its header", () => {
    assert.equal(isAvatarWebp(webp()), true);
    assert.equal(isAvatarWebp(new Uint8Array(64)), false);
  });
});

describe("profiles", () => {
  const api = (call: Call): GalleryAnswer => {
    if (call.route === PeopleRoute.user("u2"))
      return ok({
        user: {
          id: "u2",
          name: "Mira",
          image: "https://evil.example/x.png",
          createdAt: "2026-08-01T00:00:00Z",
          pro: false,
        },
        games: [
          {
            id: "g1",
            slug: "glass-orchard",
            title: "Glass Orchard",
            playsCount: 3,
            author: { id: "u2", name: "Mira" },
          },
          { id: "g2", title: "no slug" },
        ],
      });
    if (call.route === PeopleRoute.status("u2")) return ok({ status: FriendStatus.Incoming });
    if (call.route === PeopleRoute.userFriends("u2"))
      return ok({
        friends: [
          { id: "u9", name: "Zed", image: null, pro: false, games: 2, since: "2026-09-01T00:00:00Z", mutual: false },
          {
            id: "u8",
            name: "Ama",
            image: AVATAR,
            avatarStyle: "photo",
            playing: { slug: "stick-steel", title: "Stick & Steel" },
            games: 4,
            since: "2026-09-02T00:00:00Z",
            mutual: true,
          },
          { id: "../bad", name: "Path" },
        ],
      });
    return accountApi(call);
  };

  it("draws anyone's public profile, its games, and the viewer's relationship", async () => {
    const { people } = rig(api);
    const profile = await people.profile("u2");
    assert.equal(profile.person.imageUrl, null, "a picture off Genex's hosts is not handed on");
    assert.deepEqual(
      profile.games.map((g) => [g.slug, g.author.id]),
      [["glass-orchard", "u2"]],
    );
    assert.equal(profile.status, FriendStatus.Incoming);
    assert.equal((await people.profile("u1")).status, FriendStatus.Self);
  });

  it("lists their friends, people the viewer knows first, each with their game, games and since when", async () => {
    const { people } = rig(api);
    const { friends } = await people.profile("u2");
    assert.deepEqual(
      friends?.map((f) => [f.id, f.mutual, f.playing?.slug ?? null, f.games, f.since, f.imageUrl]),
      [
        ["u8", true, "stick-steel", 4, "2026-09-02T00:00:00.000Z", AVATAR],
        ["u9", false, null, 2, "2026-09-01T00:00:00.000Z", null],
      ],
    );
  });

  it("counts players when genex.games does, and says nothing it does not", async () => {
    const counted = rig((call) =>
      call.route === PeopleRoute.user("u2")
        ? ok({ user: { id: "u2", name: "Mira" }, games: [], players: 9600 })
        : api(call),
    );
    assert.equal((await counted.people.profile("u2")).players, 9600);
    assert.equal((await rig(api).people.profile("u2")).players, null);
  });

  it("has no friends row for someone else while genex.games does not list them, and the account's own on its own", async () => {
    const own = [{ id: "u5", name: "Juno", image: null, pro: false, playing: null, games: 1 }];
    const older = (call: Call): GalleryAnswer => {
      if (call.route === PeopleRoute.userFriends("u2") || call.route === PeopleRoute.userFriends("u1"))
        return status(404);
      if (call.route === PeopleRoute.Friends) return ok({ friends: own });
      return api(call);
    };
    const { people } = rig(older);
    assert.equal((await people.profile("u2")).friends, null);
    assert.deepEqual(
      (await people.profile("u1")).friends?.map((f) => [f.id, f.games, f.mutual]),
      [["u5", 1, false]],
    );
  });

  it("is None signed out, read without a token", async () => {
    const { people, calls } = rig(api, { token: undefined });
    assert.equal((await people.profile("u2")).status, FriendStatus.None);
    assert.ok(calls.every((c) => c.token === undefined));
  });

  it("refuses an id that is not an account's before any call", async () => {
    const { people, calls } = rig(api);
    for (const id of ["", "../me", "a/b", "x".repeat(65), "u 2"])
      await assert.rejects(people.profile(id), /Not a Genex account/, JSON.stringify(id));
    assert.equal(calls.length, 0);
  });
});

describe("friends", () => {
  const api = (call: Call): GalleryAnswer => {
    if (call.route === PeopleRoute.Friends)
      return ok({
        friends: [
          {
            id: "u2",
            name: "Mira",
            image: null,
            pro: false,
            playing: { slug: "stick-steel", title: "Stick & Steel" },
            games: 3,
          },
          { id: "u3", name: "Tomás", image: AVATAR, pro: true, playing: { slug: "../x", title: "bad" } },
          { id: "../evil", name: "Path" },
          { id: "u4", name: "" },
          { id: "u2", name: "Mira again" },
        ],
      });
    if (call.route === PeopleRoute.Requests)
      return ok({
        incoming: [{ id: "u5", name: "Juno", requestedAt: "2026-10-12T09:00:00Z" }],
        outgoing: [{ id: "u6", name: "Ola", requestedAt: "not a date" }],
      });
    if (call.route === PeopleRoute.Visibility) return ok({ presenceVisibility: "hidden" });
    if (call.route === PlayRoute.Referral)
      return ok({ code: "abc", link: "https://genex.games/?ref=abc", inviterBonus: 100 });
    return status(404);
  };

  it("reads the whole Friends page at once, keeping only rows that name a person", async () => {
    const { people } = rig(api);
    const page = await people.friends();
    assert.deepEqual(
      page.friends.map((f) => [f.id, f.playing?.slug ?? null, f.games]),
      [
        ["u2", "stick-steel", 3],
        ["u3", null, null],
      ],
    );
    assert.deepEqual(
      page.incoming.map((r) => r.id),
      ["u5"],
    );
    assert.deepEqual(page.outgoing, [], "a request without a date is dropped");
    assert.equal(page.visibility, PresenceVisibility.Hidden);
    assert.equal(page.inviteLink, "https://genex.games/?ref=abc");
    assert.equal(page.inviteBonus, 100);
  });

  it("hands on an invite link only on genex.games itself", async () => {
    for (const link of ["http://genex.games/?ref=a", "https://evil.example/?ref=a", "javascript:alert(1)"]) {
      const { people } = rig((call) => (call.route === PlayRoute.Referral ? ok({ link }) : api(call)));
      assert.equal((await people.friends()).inviteLink, null, link);
    }
  });

  it("needs the account", async () => {
    const { people, calls } = rig(api, { token: undefined });
    await assert.rejects(people.friends(), SignInNeeded);
    assert.equal(calls.length, 0);
  });

  it("sends each action to its route, and answers the relationship after it", async () => {
    const { people, calls } = rig((call) =>
      call.route === PeopleRoute.Requests ? ok({ status: "friends", user: {} }) : ok({}),
    );
    assert.equal(await people.act(FriendAction.Add, "u7"), FriendStatus.Friends, "a reciprocal ask accepts");
    assert.equal(await people.act(FriendAction.Accept, "u7"), FriendStatus.Friends);
    assert.equal(await people.act(FriendAction.Withdraw, "u7"), FriendStatus.None);
    assert.equal(await people.act(FriendAction.Remove, "u7"), FriendStatus.None);
    assert.deepEqual(
      calls.map((c) => [c.method, c.route, c.body ?? null]),
      [
        ["POST", PeopleRoute.Requests, { userId: "u7" }],
        ["POST", PeopleRoute.accept("u7"), null],
        ["DELETE", PeopleRoute.request("u7"), null],
        ["DELETE", PeopleRoute.friend("u7"), null],
      ],
    );
  });

  it("reads a refused token as signed out, and refuses a bad id before any call", async () => {
    const refused = rig(() => status(401));
    await assert.rejects(refused.people.act(FriendAction.Add, "u7"), SignInNeeded);
    const { people, calls } = rig(() => ok({}));
    await assert.rejects(people.act(FriendAction.Add, "../u7"), /Not a Genex account/);
    assert.equal(calls.length, 0);
  });

  it("sets who sees the game the account is in", async () => {
    const { people, calls } = rig(() => ok({ presenceVisibility: "hidden" }));
    assert.equal(await people.setVisibility(PresenceVisibility.Hidden), PresenceVisibility.Hidden);
    assert.deepEqual(calls[0], {
      route: PeopleRoute.Visibility,
      method: "PATCH",
      token: TOKEN,
      body: { presenceVisibility: "hidden" },
    });
  });
});

describe("people search", () => {
  it("sends a query of 2–40 characters, and answers each person with the viewer's relationship", async () => {
    const { people, calls } = rig(() =>
      ok({
        people: [{ id: "u8", name: "Milo", image: null, pro: true, status: "outgoing", games: 7 }, { name: "no id" }],
      }),
    );
    assert.deepEqual(await people.search(" m "), { people: [], unavailable: false });
    assert.deepEqual(await people.search("x".repeat(41)), { people: [], unavailable: false });
    assert.equal(calls.length, 0, "too short or too long sends nothing");
    const found = await people.search(" mi ");
    assert.deepEqual(found.people, [
      { id: "u8", name: "Milo", imageUrl: null, avatarVariant: 0, pro: true, status: "outgoing", games: 7 },
    ]);
    assert.equal(calls[0]?.route, `${PeopleRoute.Search}?q=mi`);
  });

  it("says search is not there yet when genex.games has no such route", async () => {
    const { people } = rig(() => status(404));
    assert.deepEqual(await people.search("mira"), { people: [], unavailable: true });
  });
});

describe("the fixture launch's people", () => {
  const noGames = { games: () => [] };

  it("answers a public profile signed out, and nothing else", () => {
    assert.equal(fixturePeopleAnswer(PeopleRoute.user("fx-mira-kova"), { method: "GET" }, noGames)?.status, 200);
    assert.equal(fixturePeopleAnswer(PeopleRoute.user("fx-nobody"), {}, noGames)?.status, 404);
    assert.equal(fixturePeopleAnswer(PeopleRoute.Friends, {}, noGames)?.status, 401);
    assert.equal(fixturePeopleAnswer(PeopleRoute.Me, { token: "someone-else" }, noGames)?.status, 401);
    assert.equal(fixturePeopleAnswer(PlayRoute.Feed, {}, noGames), null, "the gallery's routes are not its");
  });

  it("is a signed-in account with friends, requests and search under its token", async () => {
    const request: GalleryRequest = async (route, init) =>
      fixturePeopleAnswer(route, init, noGames) ?? { status: 404, body: null };
    const people = playPeople({
      request,
      token: async () => FIXTURE_ACCOUNT_TOKEN,
      now: () => 0,
      upload: async () => 200,
    });
    assert.equal((await people.me())?.name, "Rab Neba");
    const page = await people.friends();
    assert.ok(page.friends.length > 0 && page.incoming.length > 0 && page.outgoing.length > 0);
    assert.ok(page.friends[0]?.playing, "whoever is playing comes first");
    const juno = page.incoming[0]?.id ?? "";
    assert.equal(await people.act(FriendAction.Accept, juno), FriendStatus.Friends);
    assert.ok(
      (await people.friends()).friends.some((f) => f.id === juno),
      "the accepted request is a friend now",
    );
    assert.ok((await people.search("mi")).people.length > 0);
  });
});

describe("a person's avatar", () => {
  it("is their photo only when they chose one on a host the app loads from; everyone else is generated", () => {
    const person = (fields: Record<string, unknown>) => toPerson({ id: "u1", name: "Ann", image: AVATAR, ...fields });
    assert.equal(person({ avatarStyle: "photo" })?.imageUrl, AVATAR);
    assert.equal(person({ avatarStyle: "generated" })?.imageUrl, null);
    assert.equal(person({})?.imageUrl, null, "while genex.games does not say, the generated avatar shows");
    assert.equal(person({ avatarStyle: "photo", image: "https://evil.example/a.png" })?.imageUrl, null);
  });
});

describe("the fixture accounts", () => {
  const catalog = {
    games: (authorId: string) => (authorId === "fx-simeon-m" ? [{ id: "g", slug: "s", title: "S" }] : []),
  };
  const me = (account: (typeof FixtureAccount)[keyof typeof FixtureAccount]) =>
    fixturePeopleAnswer(PeopleRoute.user("fx-rab-neba"), { token: fixtureAccountToken(account) }, catalog)?.body as {
      games: unknown[];
    };

  it("sign in under their own tokens, with no games, one, or the full set", () => {
    assert.equal(fixtureAccountToken(FixtureAccount.Full), FIXTURE_ACCOUNT_TOKEN);
    assert.equal(me(FixtureAccount.New).games.length, 0);
    assert.equal(me(FixtureAccount.Fresh).games.length, 1);
    assert.equal(me(FixtureAccount.Full).games.length, 1);
    assert.equal(
      fixturePeopleAnswer(PeopleRoute.Me, { token: fixtureAccountToken(FixtureAccount.Quiet) }, catalog)?.status,
      200,
    );
  });

  it("starts a new account with nobody: no friends and no requests", () => {
    const token = fixtureAccountToken(FixtureAccount.New);
    const friends = fixturePeopleAnswer(PeopleRoute.Friends, { token }, catalog)?.body as { friends: unknown[] };
    const asks = fixturePeopleAnswer(PeopleRoute.Requests, { token }, catalog)?.body as { incoming: unknown[] };
    assert.equal(friends.friends.length, 0);
    assert.equal(asks.incoming.length, 0);
    const full = fixtureAccountToken(FixtureAccount.Full);
    const theirs = fixturePeopleAnswer(PeopleRoute.Friends, { token: full }, catalog)?.body as { friends: unknown[] };
    assert.ok(theirs.friends.length > 0, "the other accounts keep theirs");
  });

  it("keeps a photo it uploaded, and refuses Photo before there is one", async () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const before = fixturePeopleAnswer(
      PeopleRoute.MyAccount,
      { method: "PATCH", token, body: { avatarStyle: "photo" } },
      catalog,
    );
    assert.equal(before?.status, 400);
    fixturePeopleAnswer(PeopleRoute.AvatarCommit, { method: "POST", token, body: { key: "k" } }, catalog);
    const after = fixturePeopleAnswer(PeopleRoute.Me, { token }, catalog)?.body as {
      user: { avatarStyle: string; photo: string };
    };
    assert.equal(after.user.avatarStyle, "generated", "the upload keeps the picture; the choice is its own write");
    assert.match(after.user.photo, /^data:image\/svg\+xml/);
    fixturePeopleAnswer(PeopleRoute.MyAccount, { method: "PATCH", token, body: { avatarStyle: "generated" } }, catalog);
  });

  it("keeps a regenerated avatar for the next read, in a new session as in the one that chose it", async () => {
    const session = () =>
      playPeople({
        request: fixturePlayRequest,
        token: async () => fixtureAccountToken(FixtureAccount.Full),
        now: () => 0,
        upload: async () => 200,
      });
    const chosen = await session().setAvatarVariant(917_204);
    assert.equal(chosen?.avatarVariant, 917_204, "the session that chose it reads it back");
    const next = await session().me();
    assert.equal(next?.avatarVariant, 917_204, "a new session reads what was kept");
    assert.equal(next?.avatarVariantKept, true);
    await session().setAvatarVariant(0);
  });

  it("keeps a regenerated avatar, and a refused write changes nothing beside it", () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const patch = (body: unknown) =>
      fixturePeopleAnswer(PeopleRoute.MyAccount, { method: "PATCH", token, body }, catalog)?.status;
    const account = () => {
      const answer = fixturePeopleAnswer(PeopleRoute.Me, { token }, catalog);
      assert.ok(answer, "the fixture answers /api/me");
      return (answer.body as { user: { name: string; avatarVariant: number } }).user;
    };
    assert.equal(account().avatarVariant, 0);
    assert.equal(patch({ avatarVariant: 917_204 }), 200);
    assert.equal(account().avatarVariant, 917_204);
    assert.equal(patch({ avatarVariant: -1, name: "Renamed" }), 400);
    assert.notEqual(account().name, "Renamed", "a refused write keeps the name too");
    assert.equal(account().avatarVariant, 917_204);
    assert.equal(patch({ avatarVariant: 0 }), 200);
  });
});
