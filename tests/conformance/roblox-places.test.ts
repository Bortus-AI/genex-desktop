/**
 * The places a Roblox game can build in, through the plugin's backend over a fake Mac whose game
 * folders, storage and Documents are real temporary folders:
 * - Choose your place (`places`): the places open in Studio first, then place files from Studio's
 *   recent list and Documents › Roblox, read only on this press, one row per real path, at most 12;
 *   two Studios with one name are told apart.
 * - Use in this game (`use-place`): a local place links its file where it is; a published place
 *   writes `default.project.json` (recorded as Genex's own) and links it with its ids as strings; a
 *   place never saved links by its name in Studio. A place another live game builds in is refused,
 *   and is free again once that game is gone. Hostile place paths are refused with nothing linked.
 * - New Roblox game (`create`, `new-game`) writes the place, links it and opens it in Studio;
 *   Open Studio opens a game's own place, or brings Studio forward when the place is already open.
 * - The status, the toolbar and the steps card never read Documents.
 * - With the plugin on, the engine choice offers "Roblox game" from the plugin's scaffold.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { engineChoiceRule } from "../../src/harness-seed/loop/unreal-prompts.ts";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { createRobloxBackend, type RobloxDeps } from "../../src/plugins/roblox/backend.ts";
import {
  MAX_PLACES,
  type PlacesAnswer,
  PlaceError,
  PlaceRefusal,
  placeFile,
  SCAN_KEEP_MS,
  type UsePlaceAnswer,
} from "../../src/plugins/roblox/places.ts";
import { placeMatcher, readPlaceLink } from "../../src/plugins/roblox/studio-binding.ts";
import type { StudioClient, StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import type { Launch } from "../../src/plugins/roblox/studio-launch.ts";
import { type LocateStat, STUDIO_MAC_APP, systemLocateFs } from "../../src/plugins/roblox/studio-locate.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { makeResources } from "../helpers/resources.ts";
import { shippedHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SHIPPED_HELPER = await shippedHelper();
const CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const STUDIO_FILES = [`${CONTENTS}/MacOS/RobloxStudio`, `${CONTENTS}/MacOS/StudioMCP`, `${CONTENTS}/Info.plist`];
const PLACE_ID = "4483381587";
const UNIVERSE_ID = "1611231458";

/** An open Studio as StudioMCP lists it, and what its place says of itself. */
interface OpenStudio {
  id: string;
  name: string;
  placeId?: string;
  universeId?: string;
}

/** A Mac with Roblox Studio installed and set up, whose home, storage and games are real folders. */
async function robloxMac(options: { running?: boolean; studios?: OpenStudio[]; recents?: string[] } = {}) {
  // By real path, as linked places come back (macOS: /var is a link to /private/var).
  const root = await realpath(await tmpDir("roblox-places-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const games = path.join(root, "games");
  for (const dir of [home, storage, games]) await mkdir(dir, { recursive: true });
  await mkdir(path.join(storage, "setup"));
  await writeFile(path.join(storage, "setup", "record.json"), "{}");
  const state = { running: options.running ?? true, studios: options.studios ?? [], recents: options.recents ?? [] };
  const touched: string[] = [];
  const ran: string[] = [];
  const launches: Launch[] = [];
  let clock = 1_000_000;
  const appDirs = new Set(["/Applications", STUDIO_MAC_APP]);
  const fakeStat = (file: string): LocateStat | undefined => {
    if (appDirs.has(file)) return { file: false, directory: true, link: false, mtimeMs: 0 };
    if (STUDIO_FILES.includes(file)) return { file: true, directory: false, link: false, mtimeMs: 0 };
    return undefined;
  };
  const isApp = (file: string) => appDirs.has(file) || STUDIO_FILES.includes(file);
  const recentsXml = () =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist><dict>",
      "<key>LoggedInUsersStore</key><string>not read</string>",
      ...state.recents.flatMap((file, at) => [
        `<key>9172881962rbxRecentFiles_v03.${at}name</key>`,
        `<string>${file.replaceAll("&", "&amp;")}</string>`,
      ]),
      "</dict></plist>",
    ].join("\n");
  const studio: Pick<StudioClient, "studios" | "callTool"> = {
    studios: async () => state.studios.map(({ id, name }) => ({ id, name })),
    callTool: async (name, args): Promise<StudioToolResult> => {
      const open = state.studios.find((entry) => entry.id === args.studio_id);
      if (name !== "execute_luau" || !open)
        return { content: [{ type: "text", text: "no such Studio" }], isError: true };
      const text = `genex-place ${open.placeId ?? "0"} ${open.universeId ?? "0"} ${open.name}`;
      return { content: [{ type: "text", text }] };
    },
  };
  const deps: RobloxDeps = {
    platform: "darwin",
    env: { HOME: home },
    home,
    run: async (file, args) => {
      ran.push(file);
      if (file === "/usr/bin/plutil") return { code: 0, stdout: "0.743.0.7431133\n" };
      if (file === "/usr/bin/pgrep") return state.running ? { code: 0, stdout: "8620\n" } : { code: 1, stdout: "" };
      if (file === "/usr/bin/defaults" && args[0] === "export") return { code: 0, stdout: recentsXml() };
      if (file === "/usr/bin/osascript") return { code: 0, stdout: "" };
      throw new Error(`spawn ${file} ENOENT`);
    },
    fs: {
      async lstat(file) {
        touched.push(file);
        return isApp(file) ? fakeStat(file) : systemLocateFs.lstat(file);
      },
      async realpath(file) {
        touched.push(file);
        return isApp(file) ? file : systemLocateFs.realpath(file);
      },
      async readdir(dir) {
        touched.push(dir);
        return systemLocateFs.readdir(dir);
      },
    },
    answers: async () => state.running,
    studio,
    helper: SHIPPED_HELPER,
    install: {
      fetch: (async () => {
        throw new TypeError("no network in this test");
      }) as typeof fetch,
      run: async (file) => {
        throw new Error(`spawn ${file} ENOENT`);
      },
      tempRoot: path.join(root, "temp"),
    },
    open: async (launch) => {
      launches.push(launch);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    deps,
    home,
    storage,
    games,
    state,
    touched,
    ran,
    launches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Mac = Awaited<ReturnType<typeof robloxMac>>;

/** A Genex game the host keeps: its name, title and folder. */
interface Game {
  project: string;
  title: string;
  directory: string;
}

async function makeGame(mac: Mac, project: string, title: string): Promise<Game> {
  const directory = path.join(mac.games, project);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "studio.json"), `${JSON.stringify({ title })}\n`);
  return { project, title, directory };
}

/** What the host was asked, by method, in order. */
type HostCall = { method: string; args: Record<string, unknown> };

/**
 * A plugin call's context in `game` (or none), over a host that keeps links as Genex does: the
 * record in the plugin's storage (`links/<game>.json`) and the mirror in the game's studio.json.
 */
function hostFor(mac: Mac, game: Game | undefined, options: { runs?: unknown[] } = {}) {
  const calls: HostCall[] = [];
  const made: Game[] = [];
  const linkIn = async (target: Game, args: Record<string, unknown>) => {
    const project = await systemLocateFs.realpath(String(args.project));
    const link = {
      kind: "roblox",
      project,
      linkedAt: new Date(0).toISOString(),
      ...(args.remote ? { remote: args.remote } : {}),
    };
    await mkdir(path.join(mac.storage, "links"), { recursive: true });
    await writeFile(path.join(mac.storage, "links", `${target.project}.json`), JSON.stringify(link));
    const meta = JSON.parse(await readFile(path.join(target.directory, "studio.json"), "utf8"));
    await writeFile(path.join(target.directory, "studio.json"), JSON.stringify({ ...meta, engine: link }));
    return { ...link, name: path.basename(project).replace(/\.(rbxlx?|project\.json)$/, "") };
  };
  const readLink = async (target: Game) => {
    const record = await readFile(path.join(mac.storage, "links", `${target.project}.json`), "utf8").catch(() => "");
    if (!record) return null;
    const link = JSON.parse(record);
    return existsSync(link.project) ? link : null;
  };
  const host = (async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "storage.root") return mac.storage;
    if (method === "game.snapshot") return { snapshotId: "snap-1" };
    if (method === "game.engine.steps") return Boolean(game);
    if (method === "game.engine.runs") return options.runs ?? [];
    if (method === "game.create") {
      const created = await makeGame(mac, `made-${made.length + 1}`, String(args.title));
      made.push(created);
      return { project: created.project, directory: created.directory };
    }
    if (method === "game.engine.link") {
      const target = typeof args.game === "string" ? made.find((g) => g.project === args.game) : game;
      if (!target) throw new Error("Project required");
      return linkIn(target, args);
    }
    if (method === "game.engine.read") {
      if (!game) throw new Error("Project required");
      return readLink(game);
    }
    throw new Error(`No ${method} here`);
  }) as PluginContext["host"];
  const context: PluginContext = {
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...(game ? { project: game.project, directory: game.directory } : {}),
  };
  return { context, calls, made, methods: () => calls.map((call) => call.method) };
}

const action = async <T>(mac: Mac, name: string, args: Record<string, PluginScalar>, context: PluginContext) =>
  (await createRobloxBackend(mac.deps).action?.(name, args, context)) as T;

const tool = async <T>(mac: Mac, name: string, args: Record<string, PluginScalar>, context: PluginContext) =>
  (await createRobloxBackend(mac.deps).tool?.(name, args, context)) as T;

const linkCalls = (calls: HostCall[]) => calls.filter((call) => call.method === "game.engine.link");

describe("a place file named for Use in this game", () => {
  const refusal = (code: PlaceRefusal) => (error: unknown) => error instanceof PlaceError && error.code === code;

  it("is the real path of a plain .rbxl or .rbxlx file", async () => {
    const dir = await tmpDir("roblox-place-file-");
    for (const name of ["a.rbxl", "b.rbxlx"]) {
      await writeFile(path.join(dir, name), "");
      const real = await systemLocateFs.realpath(path.join(dir, name));
      assert.equal(await placeFile(systemLocateFs, process.platform, path.join(dir, name)), real);
    }
  });

  /** Paths that aren't one plain place file, each refused before anything is linked. */
  const HOSTILE: Array<[string, (dir: string) => Promise<string>, PlaceRefusal, NodeJS.Platform?]> = [
    ["a relative path", async () => "place.rbxlx", PlaceRefusal.BadFile],
    ["a step up", async (dir) => `${dir}/x/../place.rbxlx`, PlaceRefusal.BadFile],
    ["a NUL", async (dir) => `${dir}/pla\u0000ce.rbxlx`, PlaceRefusal.BadFile],
    ["a Windows path on a Mac", async () => "C:\\Users\\maker\\place.rbxlx", PlaceRefusal.BadFile, "darwin"],
    [
      "another extension",
      async (dir) => {
        await writeFile(path.join(dir, "place.rbxm"), "");
        return path.join(dir, "place.rbxm");
      },
      PlaceRefusal.BadFile,
    ],
    ["a missing file", async (dir) => path.join(dir, "gone.rbxlx"), PlaceRefusal.NotPlace],
    [
      "a folder",
      async (dir) => {
        await mkdir(path.join(dir, "folder.rbxlx"));
        return path.join(dir, "folder.rbxlx");
      },
      PlaceRefusal.NotPlace,
    ],
    [
      "a link to a place",
      async (dir) => {
        await writeFile(path.join(dir, "real.rbxlx"), "");
        await symlink(path.join(dir, "real.rbxlx"), path.join(dir, "link.rbxlx"));
        return path.join(dir, "link.rbxlx");
      },
      PlaceRefusal.Linked,
    ],
  ];
  for (const [name, make, code, platform] of HOSTILE)
    it(`refuses ${name}, linking nothing`, {
      skip: name.includes("link") && process.platform === "win32",
    }, async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = await make(await tmpDir("roblox-place-hostile-"));
      await assert.rejects(placeFile(systemLocateFs, platform ?? process.platform, file), refusal(code));
      const { context, calls } = hostFor(mac, game);
      const answer = await action<UsePlaceAnswer>(mac, "use-place", { file }, context);
      assert.equal(answer.linked, false);
      assert.equal(answer.reason, platform && platform !== process.platform ? PlaceRefusal.BadFile : code);
      assert.deepEqual(linkCalls(calls), [], "nothing linked");
      assert.equal(existsSync(path.join(game.directory, "default.project.json")), false, "nothing written");
    });
});

describe("Use in this game", () => {
  it("links a local place file where it is, by its real path", async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(mac.home, "Documents", "Roblox", "Sky Race.rbxl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { file }, context);
    assert.equal(answer.linked, true, answer.message);
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: await systemLocateFs.realpath(file) }],
    );
    assert.equal(existsSync(path.join(game.directory, "default.project.json")), false);
  });

  it("links a published place through default.project.json, recorded as Genex's, with its ids as strings", async () => {
    const mac = await robloxMac({
      studios: [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }],
    });
    const game = await makeGame(mac, "obby", "Obby");
    const { context, calls, methods } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    const project = path.join(game.directory, "default.project.json");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project, remote: { placeId: PLACE_ID, universeId: UNIVERSE_ID } }],
    );
    const rojo = JSON.parse(await readFile(project, "utf8"));
    assert.equal(rojo.tree.$className, "DataModel");
    const record = JSON.parse(await readFile(path.join(game.directory, ".genex", "roblox.json"), "utf8"));
    assert.ok(record.written.includes("default.project.json"), "Genex's own, so the script sync stays on");
    assert.ok(methods().indexOf("game.snapshot") < methods().indexOf("game.engine.link"), "a snapshot first");
    assert.deepEqual(await readPlaceLink(mac.storage, game.project), { project, placeId: PLACE_ID });
  });

  it("links a place never saved by its name in Studio, which then finds that Studio and no other", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    const project = path.join(game.directory, "default.project.json");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project }],
    );
    const link = await readPlaceLink(mac.storage, game.project);
    assert.deepEqual(link, { project, name: "Place1" });
    const matches = placeMatcher(link as NonNullable<typeof link>);
    assert.equal(matches({ id: "x", name: "Place1" }), true);
    assert.equal(matches({ id: "y", name: "Place2" }), false);
    assert.equal(matches({ id: "z", name: "default.project.json" }), false);
  });

  it("links a saved place open in Studio to its file, found in Studio's recent list", async () => {
    const mac = await robloxMac();
    const file = path.join(mac.home, "Places", "p18-cli.rbxlx");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    mac.state.recents = [file];
    mac.state.studios = [{ id: "studio-a", name: "p18-cli.rbxlx" }];
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: await systemLocateFs.realpath(file) }],
    );
  });

  it("tells two Studios with one name apart in the list, and won't link either by that name", async () => {
    const mac = await robloxMac({
      studios: [
        { id: "studio-a", name: "Place1" },
        { id: "studio-b", name: "Place1" },
      ],
    });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const places = await action<PlacesAnswer>(mac, "places", {}, context);
    assert.deepEqual(
      places.open.map((row) => [row.studio, row.label]),
      [
        ["studio-a", "Place1"],
        ["studio-b", "Place1 (2)"],
      ],
    );
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-b" }, context);
    assert.equal(answer.linked, false);
    assert.equal(answer.reason, PlaceRefusal.SameName);
    assert.match(answer.message, /Place1/);
    assert.deepEqual(linkCalls(calls), []);
    assert.equal(existsSync(path.join(game.directory, "default.project.json")), false);
  });

  it("refuses a place another live game builds in, and frees it once that game is gone", async () => {
    const mac = await robloxMac();
    const file = path.join(mac.home, "Places", "shared.rbxlx");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    mac.state.recents = [file];
    const first = await makeGame(mac, "sky-race", "Sky Race");
    const second = await makeGame(mac, "rally", "Rally");
    const one = hostFor(mac, first);
    assert.equal((await action<UsePlaceAnswer>(mac, "use-place", { file }, one.context)).linked, true);
    const two = hostFor(mac, second);
    const refused = await action<UsePlaceAnswer>(mac, "use-place", { file }, two.context);
    assert.equal(refused.linked, false);
    assert.equal(refused.reason, PlaceRefusal.Taken);
    assert.equal(refused.message, "shared already builds in Sky Race.");
    assert.deepEqual(linkCalls(two.calls), []);
    const listed = await action<PlacesAnswer>(mac, "places", {}, two.context);
    assert.equal(listed.files.find((row) => row.name === "shared.rbxlx")?.linkedTo, "Sky Race");
    // Linking it again in the game that has it is no conflict.
    assert.equal((await action<UsePlaceAnswer>(mac, "use-place", { file }, hostFor(mac, first).context)).linked, true);
    await rm(first.directory, { recursive: true, force: true });
    const freed = await action<UsePlaceAnswer>(mac, "use-place", { file }, hostFor(mac, second).context);
    assert.equal(freed.linked, true, freed.message);
  });

  it("refuses a published place another live game builds in, by its id", async () => {
    const studios = [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }];
    const mac = await robloxMac({ studios });
    const first = await makeGame(mac, "obby", "Obby");
    const second = await makeGame(mac, "obby-two", "Obby Two");
    assert.equal(
      (await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, hostFor(mac, first).context)).linked,
      true,
    );
    const two = hostFor(mac, second);
    const refused = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, two.context);
    assert.equal(refused.reason, PlaceRefusal.Taken);
    assert.equal(existsSync(path.join(second.directory, "default.project.json")), false, "nothing written");
  });

  it("refuses a Studio that is no longer open", async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "gone" }, hostFor(mac, game).context);
    assert.equal(answer.reason, PlaceRefusal.NotListed);
  });

  it("needs an open game", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const answer = await action<UsePlaceAnswer>(
      mac,
      "use-place",
      { studio: "studio-a" },
      hostFor(mac, undefined).context,
    );
    assert.equal(answer.reason, PlaceRefusal.NoGame);
  });
});

describe("Choose your place", () => {
  it("lists open Studios first, then place files from Studio's recent list and Documents, one row each", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const documents = path.join(mac.home, "Documents", "Roblox");
    const elsewhere = path.join(mac.home, "Places");
    await mkdir(documents, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(documents, "server.rbxl"), "");
    await writeFile(path.join(documents, "notes.txt"), "");
    await writeFile(path.join(elsewhere, "race.rbxlx"), "");
    mac.state.recents = [path.join(elsewhere, "race.rbxlx"), path.join(documents, "server.rbxl"), "/nowhere/x.rbxl"];
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const places = await action<PlacesAnswer>(mac, "places", {}, hostFor(mac, game).context);
    assert.deepEqual(
      places.open.map((row) => [row.label, row.kind]),
      [["Place1", "unsaved"]],
    );
    assert.deepEqual(places.files.map((row) => row.name).sort(), ["race.rbxlx", "server.rbxl"]);
    assert.ok(
      mac.touched.some((file) => file.startsWith(documents)),
      "the press reads Documents › Roblox",
    );
    assert.ok(mac.ran.includes("/usr/bin/defaults"), "and Studio's recent list");
  });

  it("lists at most 12 place files, and keeps a scan for a while", async () => {
    const mac = await robloxMac();
    const documents = path.join(mac.home, "Documents", "Roblox");
    await mkdir(documents, { recursive: true });
    for (let n = 0; n < 20; n++) await writeFile(path.join(documents, `place-${n}.rbxl`), "");
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const backend = createRobloxBackend(mac.deps);
    const list = async () => (await backend.action?.("places", {}, hostFor(mac, game).context)) as PlacesAnswer;
    assert.equal((await list()).files.length, MAX_PLACES);
    const reads = mac.touched.filter((file) => file === documents).length;
    await list();
    assert.equal(mac.touched.filter((file) => file === documents).length, reads, "kept: no second scan");
    mac.advance(SCAN_KEEP_MS);
    await list();
    assert.equal(mac.touched.filter((file) => file === documents).length, reads + 1, "scanned again once it lapsed");
  });

  it("is never read by the status, the toolbar or the steps card", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    for (const name of ["status", "toolbar-status", "steps"]) await action(mac, name, {}, hostFor(mac, game).context);
    assert.deepEqual(
      mac.touched.filter((file) => file.includes(`${path.sep}Documents`)),
      [],
      "macOS would ask the person for Documents",
    );
    assert.equal(mac.ran.includes("/usr/bin/defaults"), false, "nor Studio's recent list");
  });
});

describe("New Roblox game", () => {
  it("writes the place into the open game, links it and opens it in Studio with EditFile", async () => {
    const mac = await robloxMac({ running: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls, methods } = hostFor(mac, game);
    const answer = await action<{ created: boolean; file: string }>(mac, "create", {}, context);
    assert.equal(answer.created, true);
    const file = path.join(game.directory, "sky-race.rbxlx");
    assert.equal(answer.file, file);
    assert.ok(existsSync(file));
    assert.ok(methods().indexOf("game.snapshot") < methods().indexOf("game.engine.link"), "a snapshot first");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: file }],
    );
    assert.deepEqual(mac.launches, [
      { file: `${CONTENTS}/MacOS/RobloxStudio`, args: ["--task", "EditFile", "--localPlaceFile", file] },
    ]);
    const ignore = await readFile(path.join(game.directory, ".gitignore"), "utf8");
    assert.match(ignore, /^\*\.rbxl\.lock$/m);
    assert.match(ignore, /^\*\.rbxlx\.lock$/m);
  });

  it("with no game open makes a Genex game for it and links the place there", async () => {
    const mac = await robloxMac({ running: false });
    const { context, calls, made } = hostFor(mac, undefined);
    const answer = await action<{ created: boolean; game?: { project: string } }>(mac, "create", {}, context);
    assert.equal(answer.created, true);
    assert.equal(made.length, 1);
    assert.deepEqual(answer.game, { project: made[0]?.project });
    const link = linkCalls(calls)[0]?.args;
    assert.equal(link?.game, made[0]?.project);
    assert.equal(path.dirname(String(link?.project)), made[0]?.directory);
  });

  it("is the agent's new-game in an open game, and refused outside one", async () => {
    const mac = await robloxMac({ running: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const words = await tool<string>(mac, "new-game", {}, hostFor(mac, game).context);
    assert.match(words, /sky-race\.rbxlx/);
    assert.equal(mac.launches.length, 1);
    await assert.rejects(tool(mac, "new-game", {}, hostFor(mac, undefined).context), /game/i);
  });

  it("says whether a new Roblox game can be made here", async () => {
    const mac = await robloxMac();
    const answer = await tool<{ ready: boolean; note: string }>(
      mac,
      "engine-status",
      {},
      hostFor(mac, undefined).context,
    );
    assert.equal(answer.ready, true);
    assert.match(answer.note, /Roblox Studio 0\.743/);
  });
});

describe("Open in Studio and Quit Studio", () => {
  it("opens the game's published place with EditPlace, and brings Studio forward when it is already open", async () => {
    const mac = await robloxMac({
      studios: [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }],
    });
    const game = await makeGame(mac, "obby", "Obby");
    await action(mac, "use-place", { studio: "studio-a" }, hostFor(mac, game).context);
    await action(mac, "open-studio", {}, hostFor(mac, game).context);
    assert.deepEqual(mac.launches, [{ file: "/usr/bin/open", args: ["-a", STUDIO_MAC_APP] }], "already open: forward");
    mac.state.studios = [];
    await action(mac, "open-studio", {}, hostFor(mac, game).context);
    assert.deepEqual(mac.launches[1], {
      file: `${CONTENTS}/MacOS/RobloxStudio`,
      args: ["--task", "EditPlace", "--placeId", PLACE_ID, "--universeId", UNIVERSE_ID],
    });
  });

  it("quits Studio normally, and not while a Loop uses it", async () => {
    const mac = await robloxMac();
    const busy = hostFor(mac, undefined, { runs: [{ game: "sky-race", title: "Sky Race", project: "/x.rbxlx" }] });
    const refused = await action<{ quit: boolean; message: string }>(mac, "quit-studio", {}, busy.context);
    assert.equal(refused.quit, false);
    assert.match(refused.message, /Sky Race/);
    assert.equal(mac.ran.includes("/usr/bin/osascript"), false, "nothing asked of Studio");
    mac.deps.run = (async (file: string, args: readonly string[]) => {
      if (file === "/usr/bin/osascript") mac.state.running = false;
      if (file === "/usr/bin/pgrep") return mac.state.running ? { code: 0, stdout: "1\n" } : { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    }) as RobloxDeps["run"];
    const done = await action<{ quit: boolean }>(mac, "quit-studio", {}, hostFor(mac, undefined).context);
    assert.equal(done.quit, true);
  });
});

describe("the engine choice", () => {
  it('offers "Roblox game" from the plugin\'s scaffold while the plugin is on', async () => {
    const resources = await makeResources({ tsc: false });
    const root = await tmpDir("roblox-scaffold-");
    const plugins = path.join(resources, "plugins");
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      plugins,
      path.join(resources, "plugin-sdk", "backend.mjs"),
      async () => null,
    );
    await registry.init();
    try {
      const web = [{ id: CoreFact.WebGame, path: "." }];
      const offered = () => registry.snapshot(web).kinds?.filter((kind) => kind.plugin === "roblox") ?? [];
      // Genex seeds the plugin off; a bare registry turns bundled plugins on, so it is turned off here.
      await registry.setEnabled("roblox", false);
      assert.deepEqual(offered(), [], "off: not offered");
      await registry.setEnabled("roblox", true);
      const kinds = offered();
      assert.deepEqual(
        kinds.map((kind) => [kind.tool, kind.label, kind.asksReady]),
        [["roblox__new-game", "Roblox game", true]],
      );
      assert.match(engineChoiceRule("claude-code", null, kinds), /"Roblox game"/);
    } finally {
      registry.cancel();
    }
  });
});
