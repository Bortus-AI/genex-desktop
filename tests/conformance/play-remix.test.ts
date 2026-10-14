/**
 * Remix from Play: a published game's public source becomes a new game of the person's own. Only an
 * https repository on Genex's git is cloned, into a fresh folder of the games folder, under a git
 * that runs nothing of the copy; the author's history is dropped, the folder is adopted without
 * trusting its Claude settings, and a failed copy leaves no folder behind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayWorld } from "../../src/main/play/gallery.ts";
import { claimFolder, cloneArgs, isRemixSource, lfsPullArgs, remixGame, tracksLfs } from "../../src/main/play/remix.ts";
import { tmpDir } from "../helpers/tmp.ts";

const WORLD: PlayWorld = {
  id: "cm1",
  slug: "lost-cathedral",
  title: "Lost Cathedral",
  multiplayer: false,
  likes: 0,
  liked: false,
  remixable: true,
  cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
  author: "Simeon M",
  authorId: null,
  plays: 0,
  online: null,
};

const exists = async (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

describe("Play remix", () => {
  it("clones only an https repository on Genex's git", () => {
    const cases: Array<[unknown, boolean]> = [
      ["https://git.genex.games/u-1/lost-cathedral.git", true],
      ["https://git.genex.games/u-1/lost-cathedral", false],
      ["http://git.genex.games/u-1/lost-cathedral.git", false],
      ["https://github.com/u-1/lost-cathedral.git", false],
      ["https://git.genex.games.evil.example/u-1/x.git", false],
      ["https://user:pass@git.genex.games/u-1/x.git", false],
      ["https://git.genex.games/u-1/x.git?upload-pack=touch", false],
      ["https://git.genex.games/../../x.git", false],
      ["ext::sh -c touch% /tmp/pwned", false],
      ["file:///etc/x.git", false],
      ["--upload-pack=touch /tmp/pwned", false],
      [null, false],
    ];
    for (const [url, ok] of cases) assert.equal(isRemixSource(url), ok, String(url));
  });

  it("clones shallowly, https only, with no filters, links or hooks, after `--`", () => {
    const args = cloneArgs(WORLD.cloneUrl as string, "/games/lost-cathedral-remix");
    for (const setting of [
      "protocol.allow=never",
      "protocol.https.allow=always",
      "core.symlinks=false",
      "filter.lfs.smudge=",
      "core.hooksPath=/dev/null",
    ])
      assert.ok(args.includes(setting), setting);
    const clone = args.indexOf("clone");
    assert.ok(clone > 0 && args.includes("--depth=1"));
    assert.deepEqual(args.slice(-3), ["--", WORLD.cloneUrl, "/games/lost-cathedral-remix"]);
  });

  it("brings a copy's Git LFS files from the game's own repository, never where a file in it points", async () => {
    const url = WORLD.cloneUrl as string;
    const args = lfsPullArgs(url);
    assert.ok(args.includes(`lfs.url=${url}/info/lfs`), "the repository's own LFS, whatever its .lfsconfig says");
    for (const setting of ["protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null"])
      assert.ok(args.includes(setting), setting);
    assert.deepEqual(args.slice(-2), ["lfs", "pull"]);
    const dir = await tmpDir("studio-remix-lfs-");
    assert.equal(await tracksLfs(dir), false, "no attributes");
    await writeFile(path.join(dir, ".gitattributes"), "# models: filter=lfs\n*.txt text\n");
    assert.equal(await tracksLfs(dir), false, "a comment turns nothing on");
    await writeFile(path.join(dir, ".gitattributes"), "*.txt text\n*.glb filter=lfs diff=lfs merge=lfs -text\n");
    assert.equal(await tracksLfs(dir), true);
  });

  it("claims the first free remix folder by making it, so two remixes never share one", async () => {
    const root = await tmpDir("play-remix-claim");
    await mkdir(path.join(root, "x-remix"));
    const [first, second] = await Promise.all([claimFolder(root, "x"), claimFolder(root, "x")]);
    assert.notEqual(first, second);
    assert.deepEqual([first, second].map((dir) => path.basename(dir)).sort(), ["x-remix-2", "x-remix-3"]);
    const always = async () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    await assert.rejects(claimFolder(root, "x", always), /no free folder/);
    const denied = async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    await assert.rejects(claimFolder(root, "y", denied), /denied/);
  });

  it("makes a new game without the author's history and without trusting its settings", async () => {
    const root = await tmpDir("play-remix");
    const adopted: Array<{ dir: string; title: string }> = [];
    const name = await remixGame(WORLD, {
      gamesRoot: () => root,
      clone: async (_url, dest) => {
        await mkdir(path.join(dest, ".git"), { recursive: true });
        await writeFile(path.join(dest, "index.html"), "<h1>game</h1>");
      },
      adopt: async (dir, title) => {
        adopted.push({ dir, title });
        return "lost-cathedral-remix";
      },
    });
    assert.equal(name, "lost-cathedral-remix");
    const dest = path.join(root, "lost-cathedral-remix");
    assert.deepEqual(adopted, [{ dir: dest, title: "Lost Cathedral remix" }]);
    assert.deepEqual(await readdir(dest), ["index.html"]);
  });

  it("leaves nothing behind when the copy fails", async () => {
    const root = await tmpDir("play-remix-fail");
    await assert.rejects(
      remixGame(WORLD, {
        gamesRoot: () => root,
        clone: async (_url, dest) => {
          await mkdir(dest, { recursive: true });
          await writeFile(path.join(dest, "half"), "x");
          throw new Error("network went away");
        },
        adopt: async () => "never",
      }),
      /network went away/,
    );
    assert.equal(await exists(path.join(root, "lost-cathedral-remix")), false);
  });

  it("refuses a game that may not be remixed before touching the disk", async () => {
    const root = await tmpDir("play-remix-refused");
    let cloned = 0;
    const deps = {
      gamesRoot: () => root,
      clone: async () => {
        cloned += 1;
      },
      adopt: async () => "never",
    };
    for (const world of [
      { ...WORLD, remixable: false },
      { ...WORLD, cloneUrl: "https://github.com/a/b.git" },
      { ...WORLD, slug: "../escape" },
    ])
      await assert.rejects(remixGame(world, deps), /can’t be remixed/);
    assert.equal(cloned, 0);
    assert.deepEqual(await readdir(root), []);
  });
});
