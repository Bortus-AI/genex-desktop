/**
 * The asset library on genex.games and a game's Save, Share and Add. What genex.games answers is
 * hostile input: a file off its asset hosts is never downloaded, a malformed row never reaches a
 * card, and a file name the renderer sends that is not one of the game's own assets is refused
 * before anything is read, sent or written.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { librarySharing, type LibrarySharingDeps } from "../../src/main/core/library-sharing.ts";
import { fixtureDownload, FixtureGenerationId } from "../../src/main/dev/fixture-asset-library.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import {
  assetLibrary,
  libraryFileUrl,
  libraryListRoute,
  LibraryRoute,
  networkDownload,
  toLibraryAsset,
} from "../../src/main/play/asset-library.ts";
import { type GalleryAnswer, type GalleryRequest, SignInNeeded } from "../../src/main/play/gallery.ts";
import { LibraryKind, shareNameOf, ShareMiss } from "../../src/shared/asset-library.ts";
import type { ProjectAsset, ProjectAssets } from "../../src/shared/game-assets.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const TOKEN = "genex-cli-token";
const GEN = "cmsp5jawj00532vo5aaj2xwz3";
const FILE_URL = `https://assets.genex.technology/generations/${GEN}/model.glb`;
const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });

/** Calls kept as they are made, answered by `answers`. */
function rig(answers: (route: string, init: Parameters<GalleryRequest>[1]) => GalleryAnswer, signedIn = true) {
  const calls: Array<{ route: string; method?: string; body?: unknown }> = [];
  const uploads: Array<{ url: string; bytes: number; type: string }> = [];
  const request: GalleryRequest = async (route, init) => {
    calls.push({ route, ...(init.method ? { method: init.method } : {}), ...(init.body ? { body: init.body } : {}) });
    return answers(route, init);
  };
  const library = assetLibrary({
    request,
    token: async () => (signedIn ? TOKEN : undefined),
    upload: async (url, bytes, type) => {
      uploads.push({ url, bytes: bytes.byteLength, type });
      return 200;
    },
  });
  return { library, calls, uploads };
}

describe("library rows", () => {
  it("keeps a row's kind, title, file and shared page", () => {
    const row = toLibraryAsset({
      id: GEN,
      kind: "sfx",
      prompt: "Stadium crowd erupting\nsecond line",
      thumbnailUrl: "https://assets.genex.technology/thumb.webp",
      files: [{ role: "audio-sfx", url: "https://assets.genex.technology/generations/x/audio.mp3" }],
      savedAt: "2026-10-17T00:00:00Z",
      createdAt: "2026-10-17T00:00:00Z",
      sharedAsset: { projectId: "p1", slug: "stadium-crowd", status: "draft" },
    });
    assert.deepEqual(row, {
      id: GEN,
      kind: LibraryKind.Sound,
      title: "Stadium crowd erupting",
      thumbnailUrl: "https://assets.genex.technology/thumb.webp",
      fileUrl: "https://assets.genex.technology/generations/x/audio.mp3",
      saved: true,
      shared: { projectId: "p1", slug: "stadium-crowd", live: false },
      createdAt: "2026-10-17T00:00:00Z",
    });
  });

  it("reads a held or taken-down page as not on Play, whatever its status says", () => {
    const shared = (sharedAsset: Record<string, unknown>) =>
      toLibraryAsset({ id: GEN, kind: "model", sharedAsset })?.shared;
    assert.equal(shared({ projectId: "p1", slug: "hut", status: "published", live: false })?.live, false);
    assert.equal(shared({ projectId: "p1", slug: "hut", status: "published", live: true })?.live, true);
    assert.equal(shared({ projectId: "p1", slug: "hut", status: "published" })?.live, true, "an older genex.games");
  });

  it("drops a row without a usable id and keeps no file off genex.games' hosts", () => {
    assert.equal(toLibraryAsset({ id: "../../etc", kind: "model" }), null);
    const row = toLibraryAsset({
      id: GEN,
      kind: "model",
      files: [{ role: "model-glb", url: "https://evil.example/x.glb" }],
    });
    assert.equal(row?.fileUrl, null);
    assert.equal(row?.kind, LibraryKind.Model);
  });

  for (const [label, url] of [
    ["another host", "https://evil.example/a.glb"],
    ["plain http", "http://assets.genex.technology/a.glb"],
    ["credentials", "https://u:p@assets.genex.technology/a.glb"],
    ["a port", "https://assets.genex.technology:8443/a.glb"],
    ["not a URL", "assets.genex.technology/a.glb"],
  ] as const) {
    it(`refuses a file address with ${label}`, () => assert.equal(libraryFileUrl(url), null));
  }

  it("asks only for what the query names, in genex.games' words", () => {
    const route = libraryListRoute({
      query: "  mushroom ",
      kind: LibraryKind.Sound,
      saved: true,
      ids: [GEN, "bad id"],
    });
    const query = new URL(route, "https://x").searchParams;
    assert.equal(query.get("scope"), "library");
    assert.equal(query.get("q"), "mushroom");
    assert.equal(query.get("type"), "sound");
    assert.equal(query.get("saved"), "1");
    assert.equal(query.get("ids"), GEN);
  });
});

describe("the library's calls", () => {
  it("throws for a signed-out account and never calls genex.games", async () => {
    const { library, calls } = rig(() => ok({}), false);
    await assert.rejects(library.list(), SignInNeeded);
    assert.equal(calls.length, 0);
  });

  it("reads a 401 as a sign-in that ended", async () => {
    const { library } = rig(() => ({ status: 401, body: null }));
    await assert.rejects(library.setSaved(GEN, true), SignInNeeded);
  });

  it("shares under the name, and reads genex.games' refusals as misses", async () => {
    const answers: GalleryAnswer[] = [
      { status: 201, body: { slug: "giant-mushroom", projectId: "p9", title: "Giant mushroom" } },
      { status: 202, body: { error: "moderation_pending" } },
      { status: 403, body: { error: "moderation_refused", detail: "Not for Play." } },
      { status: 400, body: { error: "kind_not_publishable" } },
      { status: 429, body: null },
      { status: 409, body: { error: "asset_share_in_progress" } },
    ];
    const { library, calls } = rig(() => answers.shift() ?? ok({}));
    assert.deepEqual(await library.share(GEN, " Giant mushroom "), {
      shared: { projectId: "p9", slug: "giant-mushroom", live: true },
    });
    assert.deepEqual(calls[0]?.body, { name: "Giant mushroom" });
    assert.deepEqual(await library.share(GEN, "x"), { miss: ShareMiss.Checking });
    assert.deepEqual(await library.share(GEN, "x"), { miss: ShareMiss.Refused, detail: "Not for Play." });
    assert.deepEqual(await library.share(GEN, "x"), { miss: ShareMiss.KindNotShareable });
    assert.deepEqual(await library.share(GEN, "x"), { miss: ShareMiss.TooMany });
    assert.deepEqual(await library.share(GEN, "x"), { miss: ShareMiss.Checking }, "another share is on its way");
  });

  it("sends a file: asks for a place, uploads the bytes there, then marks it done", async () => {
    const { library, calls, uploads } = rig((route) =>
      route === LibraryRoute.Import ? ok({ id: GEN, uploadUrl: "https://r2.example/put" }) : ok({}),
    );
    const id = await library.send({
      filename: "a.png",
      contentType: "image/png",
      bytes: new Uint8Array(5),
      title: "A",
    });
    assert.equal(id, GEN);
    assert.deepEqual(uploads, [{ url: "https://r2.example/put", bytes: 5, type: "image/png" }]);
    assert.deepEqual(calls.at(-1)?.route, LibraryRoute.importDone(GEN));
    assert.equal((calls[0]?.body as { save?: boolean } | undefined)?.save, true);
  });
});

describe("downloads", () => {
  it("refuses an address off genex.games' hosts before any request", async () => {
    let fetched = 0;
    const download = networkDownload((async () => {
      fetched += 1;
      return new Response("x");
    }) as typeof fetch);
    await assert.rejects(download("https://evil.example/a.glb", 10));
    assert.equal(fetched, 0);
  });

  it("stops reading a body that passes the cap, whatever Content-Length said", async () => {
    const download = networkDownload((async () => new Response(new Uint8Array(64))) as typeof fetch);
    await assert.rejects(download(FILE_URL, 10), /too large/);
    assert.equal((await download(FILE_URL, 64)).byteLength, 64);
  });
});

describe("share names", () => {
  it("takes the first line of what it was made from, else the file's name", () => {
    assert.equal(shareNameOf("giant mushroom tree\nmore", "assets/x.glb"), "Giant mushroom tree");
    assert.equal(shareNameOf(undefined, "assets/genex/1/stone_wall-texture.png"), "Stone wall texture");
    assert.equal(shareNameOf("a".repeat(200), "x.glb").length, 80);
  });
});

/** What a test changes about a game's rig. */
interface RigOptions {
  /** Answers a library route itself first; null leaves it to the fixture. */
  request?: (route: string, init: Parameters<GalleryRequest>[1]) => Promise<GalleryAnswer> | null;
  /** The game's folder is refused, as the launch's project policy refuses one. */
  refused?: boolean;
}

/**
 * A game folder with an asset list the test controls, over the fixture's library; every library
 * route asked and every download is kept.
 */
async function gameRig(
  root: string,
  assets: ProjectAsset[],
  account: FixtureAccount | null = FixtureAccount.Full,
  { request, refused = false }: RigOptions = {},
) {
  const dir = path.join(root, `game-${Math.random().toString(36).slice(2)}`);
  await mkdir(path.join(dir, "assets"), { recursive: true });
  for (const asset of assets) {
    await mkdir(path.dirname(path.join(dir, asset.file)), { recursive: true });
    await writeFile(path.join(dir, asset.file), "bytes");
  }
  const routes: string[] = [];
  const library = assetLibrary({
    request: (route, init) => {
      routes.push(route);
      return request?.(route, init) ?? fixturePlayRequest(route, init);
    },
    token: async () => (account ? fixtureAccountToken(account) : undefined),
    upload: async () => 200,
    localImages: true,
  });
  const reads: string[] = [];
  const downloads: string[] = [];
  const deps: LibrarySharingDeps = {
    library: () => library,
    gameDir: async () => {
      if (refused) throw new Error("outside the owned games");
      return dir;
    },
    webGame: async () => true,
    assets: async (): Promise<ProjectAssets> => ({ project: "g", assets, truncated: false, skipped: [] }),
    readFile: async (_dir, file) => {
      reads.push(file);
      return { mimeType: "image/png", data: new Uint8Array(3) };
    },
    manifest: async () => ({ manifest: { asset: { media: "glb", fileUrl: FILE_URL } } }),
    download: (url, maxBytes) => {
      downloads.push(url);
      return fixtureDownload(url, maxBytes);
    },
    vendorModule: async () => null,
  };
  return { dir, sharing: librarySharing(deps), reads, routes, downloads };
}

const asset = (file: string, extra: Partial<ProjectAsset> = {}): ProjectAsset => ({
  file,
  kind: file.endsWith(".png") ? "image" : "model",
  bytes: 5,
  mtime: "2026-10-17T00:00:00Z",
  source: "genex",
  ...extra,
});

describe("a game's files and the library", () => {
  let root = "";
  before(async () => {
    root = await realpath(await tmpDir("asset-library-"));
  });
  after(async () => {
    await removeTree(root);
  });

  it("reads where each Genex file stands, and a file Genex did not make as only in the game", async () => {
    const game = await gameRig(root, [
      asset("assets/genex/a/hut.glb", { generationId: FixtureGenerationId.Hut }),
      asset("assets/genex/b/strider.glb", { generationId: FixtureGenerationId.Strider }),
      asset("assets/drop.png", { source: "imported" }),
    ]);
    const { states, unread } = await game.sharing.states("g");
    assert.equal(unread, false);
    const byFile = Object.fromEntries(states.map((state) => [state.file, state]));
    assert.equal(byFile["assets/genex/a/hut.glb"]?.shared?.live, true);
    assert.equal(byFile["assets/genex/b/strider.glb"]?.saved, true);
    assert.deepEqual(byFile["assets/drop.png"], {
      file: "assets/drop.png",
      generationId: null,
      saved: false,
      shared: null,
      saveable: true,
      shareable: false,
    });
  });

  it("reads every file as only in the game when signed out, and says so", async () => {
    const game = await gameRig(
      root,
      [asset("assets/genex/a/hut.glb", { generationId: FixtureGenerationId.Hut })],
      null,
    );
    const { states, unread } = await game.sharing.states("g");
    assert.equal(unread, true);
    assert.equal(states[0]?.generationId, null);
  });

  it("sends a dropped file to the library on Save, and it reads saved but not shareable after", async () => {
    const game = await gameRig(root, [asset("assets/drop.png", { source: "imported" })]);
    const after = await game.sharing.save("g", ["assets/drop.png"], true);
    assert.deepEqual(game.reads, ["assets/drop.png"]);
    assert.equal(after.states[0]?.saved, true);
    assert.equal(after.states[0]?.shareable, false);
    const links = JSON.parse(await readFile(path.join(game.dir, ".studio", "library-links.json"), "utf8"));
    assert.equal(links.files["assets/drop.png"].sent, true);
    const [outcome] = await game.sharing.share("g", [{ file: "assets/drop.png", name: "Drop" }]);
    assert.deepEqual(outcome, { file: "assets/drop.png", miss: ShareMiss.NotShareable });
  });

  it("refuses a file that is not one of the game's assets before reading or sending anything", async () => {
    const game = await gameRig(root, [asset("assets/genex/a/hut.glb", { generationId: FixtureGenerationId.Hut })]);
    for (const file of ["../../etc/passwd", "/etc/passwd", "assets/other.png", "src/main.js"]) {
      await assert.rejects(game.sharing.save("g", [file], true), /isn't one of this game's assets/);
      await assert.rejects(game.sharing.share("g", [{ file, name: "x" }]), /isn't one of this game's assets/);
    }
    assert.deepEqual(game.reads, []);
    assert.deepEqual(await readdir(game.dir), ["assets"]);
  });

  it("shares a Genex file, then stops sharing it", async () => {
    const file = "assets/genex/a/mushroom.glb";
    const game = await gameRig(root, [asset(file, { generationId: FixtureGenerationId.Mushroom })]);
    const [shared] = await game.sharing.share("g", [{ file, name: "Giant mushroom tree" }]);
    assert.ok(shared && "shared" in shared && shared.shared.live);
    const after = await game.sharing.unshare("g", file);
    assert.equal(after.states[0]?.shared?.live, false);
    const [again] = await game.sharing.share("g", [{ file, name: "Giant mushroom tree" }]);
    assert.ok(again && "shared" in again && again.shared.live);
    assert.equal(again.shared.projectId, shared.shared.projectId, "the same page comes back, not a second one");
  });

  it("offers Save only for a file genex.games takes, and nothing while signed out", async () => {
    const game = await gameRig(root, [asset("assets/notes.fbx", { source: "imported", kind: "model" })]);
    assert.equal((await game.sharing.states("g")).states[0]?.saveable, false);
    const out = await gameRig(root, [asset("assets/genex/a/hut.glb", { generationId: FixtureGenerationId.Hut })], null);
    assert.equal((await out.sharing.states("g")).states[0]?.saveable, false);
  });

  it("adds a library generation into a folder of its own and links it", async () => {
    const game = await gameRig(root, []);
    const { files } = await game.sharing.add("g", { generationId: FixtureGenerationId.Lantern });
    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /^assets\/library\/[0-9a-f-]{36}\/[a-z0-9-]+\.glb$/);
    const links = JSON.parse(await readFile(path.join(game.dir, ".studio", "library-links.json"), "utf8"));
    assert.equal(links.files[files[0] ?? ""].generationId, FixtureGenerationId.Lantern);
  });

  it("never writes through a link planted where the added assets go", async () => {
    const game = await gameRig(root, []);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(game.dir, "assets", "library"));
    await assert.rejects(game.sharing.add("g", { generationId: FixtureGenerationId.Lantern }));
    assert.deepEqual(await readdir(outside), []);
  });

  it("adds a shared Genex asset's file under the community folder", async () => {
    const game = await gameRig(root, []);
    const { files } = await game.sharing.add("g", { slug: "giant-mushroom" });
    assert.match(files[0] ?? "", /^assets\/community\/[0-9a-f-]{36}\/model\.glb$/);
  });
});

describe("a game's Save, Share and Add when things overlap or break", () => {
  let root = "";
  before(async () => {
    root = await realpath(await tmpDir("asset-library-edges-"));
  });
  after(async () => {
    await removeTree(root);
  });

  it("reads a game with no Genex file as unread while signed out, so Save is not offered", async () => {
    const game = await gameRig(root, [asset("assets/drop.png", { source: "imported" })], null);
    const { states, unread } = await game.sharing.states("g");
    assert.equal(unread, true);
    assert.equal(states[0]?.saveable, false);
  });

  it("sends a file once when Save is pressed twice before the first answers", async () => {
    const game = await gameRig(root, [asset("assets/twice.png", { source: "imported" })]);
    await Promise.all([
      game.sharing.save("g", ["assets/twice.png"], true),
      game.sharing.save("g", ["assets/twice.png"], true),
    ]);
    assert.equal(game.routes.filter((route) => route === LibraryRoute.Import).length, 1);
  });

  it("keeps the link of each of two assets added at once", async () => {
    const game = await gameRig(root, []);
    const added = await Promise.all([
      game.sharing.add("g", { generationId: FixtureGenerationId.Lantern }),
      game.sharing.add("g", { generationId: FixtureGenerationId.Crowd }),
    ]);
    const links = JSON.parse(await readFile(path.join(game.dir, ".studio", "library-links.json"), "utf8"));
    assert.deepEqual(Object.keys(links.files).sort(), added.flatMap((outcome) => outcome.files).sort());
  });

  it("answers each share of a batch when one of them cannot reach genex.games", async () => {
    const strider = "assets/genex/b/strider.glb";
    const lantern = "assets/genex/c/lantern.glb";
    const game = await gameRig(
      root,
      [
        asset(strider, { generationId: FixtureGenerationId.Strider }),
        asset(lantern, { generationId: FixtureGenerationId.Lantern }),
      ],
      FixtureAccount.Full,
      {
        request: (route) =>
          route === LibraryRoute.share(FixtureGenerationId.Lantern) ? Promise.reject(new Error("offline")) : null,
      },
    );
    const outcomes = await game.sharing.share("g", [
      { file: strider, name: "Silt strider" },
      { file: lantern, name: "Iron lantern" },
    ]);
    assert.ok(outcomes[0] && "shared" in outcomes[0] && outcomes[0].shared.live, "the first went live");
    assert.deepEqual(outcomes[1], { file: lantern, miss: ShareMiss.Failed });
  });

  it("refuses to send a file whose type genex.games does not take, before reading it", async () => {
    const file = "assets/notes.fbx";
    const game = await gameRig(root, [asset(file, { source: "imported", kind: "model" })]);
    await assert.rejects(game.sharing.save("g", [file], true), /genex.games doesn't take/);
    assert.deepEqual(game.reads, []);
    assert.equal(game.routes.includes(LibraryRoute.Import), false);
  });

  it("neither reads, sends, downloads nor writes for a game the launch's policy refuses", async () => {
    const file = "assets/refused.png";
    const game = await gameRig(root, [asset(file, { source: "imported" })], FixtureAccount.Full, { refused: true });
    await assert.rejects(game.sharing.save("g", [file], true));
    await assert.rejects(game.sharing.add("g", { generationId: FixtureGenerationId.Lantern }));
    await assert.rejects(game.sharing.add("g", { slug: "giant-mushroom" }));
    assert.deepEqual(game.reads, []);
    assert.deepEqual(game.downloads, []);
    assert.equal(game.routes.includes(LibraryRoute.Import), false);
    assert.deepEqual(await readdir(game.dir), ["assets"]);
    assert.deepEqual(await readdir(path.join(game.dir, "assets")), ["refused.png"]);
  });

  it("adds a library file whose address names it with a broken escape under its own name", async () => {
    const broken = "https://assets.genex.technology/generations/x/%E0%A4%A.glb";
    const game = await gameRig(root, [], FixtureAccount.Full, {
      request: (route) =>
        route.startsWith(`${LibraryRoute.List}?`)
          ? Promise.resolve(
              ok({ generations: [{ id: GEN, kind: "model", files: [{ role: "model-glb", url: broken }] }] }),
            )
          : null,
    });
    const { files } = await game.sharing.add("g", { generationId: GEN });
    assert.match(files[0] ?? "", new RegExp(`^assets/library/[0-9a-f-]{36}/${GEN}\\.glb$`));
  });
});

describe("a game's library links are the game's own file", () => {
  let root = "";
  before(async () => {
    root = await realpath(await tmpDir("asset-links-"));
  });
  after(async () => {
    await removeTree(root);
  });

  const DROPPED = "assets/linked.png";
  const LINKS = JSON.stringify({
    version: 1,
    files: { [DROPPED]: { generationId: FixtureGenerationId.Moss, sent: false } },
  });

  /** A links file whose link to the fixture's moss picture must not be honored. */
  const hostile: ReadonlyArray<readonly [string, (dir: string) => Promise<void>]> = [
    [
      "a link to a file outside the game",
      async (dir) => {
        const outside = path.join(root, `outside-${Math.random().toString(36).slice(2)}.json`);
        await writeFile(outside, LINKS);
        await symlink(outside, path.join(dir, ".studio", "library-links.json"));
      },
    ],
    [
      "a .studio folder that links outside the game",
      async (dir) => {
        const outside = await mkdtempIn(root);
        await writeFile(path.join(outside, "library-links.json"), LINKS);
        await rm(path.join(dir, ".studio"), { recursive: true });
        await symlink(outside, path.join(dir, ".studio"));
      },
    ],
    [
      "a file far larger than any links file",
      async (dir) => {
        await writeFile(path.join(dir, ".studio", "library-links.json"), LINKS + " ".repeat(2 * 1024 * 1024));
      },
    ],
    [
      "a named pipe",
      async (dir) => {
        execFileSync("mkfifo", [path.join(dir, ".studio", "library-links.json")]);
      },
    ],
  ];

  for (const [label, plant] of hostile) {
    it(`ignores ${label}, and Save and Share read the file as only in the game`, { timeout: 10_000 }, async () => {
      const game = await gameRig(root, [asset(DROPPED, { source: "imported" })]);
      await mkdir(path.join(game.dir, ".studio"), { recursive: true });
      await plant(game.dir);
      const { states } = await game.sharing.states("g");
      assert.equal(states[0]?.generationId, null);
      assert.equal(states[0]?.shareable, false);
    });
  }

  it("honors a plain links file in the game's own .studio folder", async () => {
    const game = await gameRig(root, [asset(DROPPED, { source: "imported" })]);
    await mkdir(path.join(game.dir, ".studio"), { recursive: true });
    await writeFile(path.join(game.dir, ".studio", "library-links.json"), LINKS);
    const { states } = await game.sharing.states("g");
    assert.equal(states[0]?.generationId, FixtureGenerationId.Moss);
  });
});

/** A fresh folder under `root`. */
const mkdtempIn = (root: string): Promise<string> => mkdtemp(path.join(root, "outside-"));
