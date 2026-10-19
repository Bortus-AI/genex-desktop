/**
 * The native-games fixture: the fixture catalog's Mac apps built on this Mac (`fixture-native-app.ts`)
 * and zipped into the profile, so its build host serves real archives; then, in a fresh profile,
 * Frigate installed and Puck Rush installed one version behind the catalog, through the real
 * installer. A reused profile keeps what it has installed.
 */
import path from "node:path";
import type { PlayGameDetail } from "../../shared/play.ts";
import { type NativeHost, parseNativeBuilds } from "../../shared/play-native.ts";
import { diskBytes } from "../../substrate/storage-folders.ts";
import { nativeInstalls } from "../play/native-installs.ts";
import { runTool } from "../play/native-unpack.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { buildFixtureApp } from "./fixture-native-app.ts";
import {
  type FixtureBuildSpec,
  type FixtureNativeGame,
  fixtureBuildRow,
  fixtureNativeFetch,
  macApp,
  prepareFixtureArchives,
  SMALL,
} from "./fixture-native.ts";
import { buildHostsFor } from "../play/gallery.ts";

/** The made-up level data that gives a stand-in its size: not compressible, the same every launch. */
const LEVEL_FILE = "level.pak";
/** How long zipping one stand-in app may take. */
const ZIP_TIMEOUT_MS = MINUTE_MS;
/** Puck Rush as it was one version ago: what the fixture installs so an update waits. */
const PUCK_RUSH_BEFORE: FixtureBuildSpec = {
  ...macApp("Puck Rush", "1.2", SMALL),
  publishedAt: "2026-10-01T09:00:00.000Z",
};
/** The games a fresh native-games profile has installed. */
const INSTALLED_AT_START = ["frigate"] as const;

/** What preparing the fixture needs from the launch. */
export interface NativeGamesFixtureDeps {
  /** The profile's own folder for the made archives. */
  dir: string;
  /** The profile's installed-games folder. */
  root: string;
  host: NativeHost;
  games: readonly FixtureNativeGame[];
  /** A game's page from the fixture catalog. */
  page(slug: string): Promise<PlayGameDetail>;
}

/** Make the archives, then install what a fresh profile starts with. */
export async function prepareNativeGamesFixture(deps: NativeGamesFixtureDeps): Promise<void> {
  const cache = path.join(deps.dir, ".program");
  await prepareFixtureArchives(
    deps.dir,
    deps.games,
    {
      buildApp: (spec, into) =>
        buildFixtureApp(
          {
            title: spec.title,
            bundleId: `games.genex.fixture.${spec.slug}`,
            hue: spec.hue,
            version: spec.version,
            arch: "universal",
            data: { name: LEVEL_FILE, bytes: spec.level },
          },
          into,
          cache,
        ),
      zip: async (app, zip) => {
        const zipped = await runTool("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip], {
          timeoutMs: ZIP_TIMEOUT_MS,
        });
        if (zipped.code !== 0) throw new Error(`ditto: ${zipped.stderr}`);
      },
      diskBytes,
    },
    [{ slug: "puck-rush", build: PUCK_RUSH_BEFORE }],
  );
  await installAtStart(deps);
}

/** Install Frigate and the older Puck Rush in a profile that has neither yet. */
async function installAtStart(deps: NativeGamesFixtureDeps): Promise<void> {
  const before = async (slug: string): Promise<PlayGameDetail> => {
    const page = await deps.page(slug);
    if (slug !== "puck-rush" || !page.native) return page;
    const builds = parseNativeBuilds([fixtureBuildRow(slug, PUCK_RUSH_BEFORE)], buildHostsFor(true));
    return { ...page, native: { ...page.native, builds } };
  };
  const installer = nativeInstalls({
    root: deps.root,
    host: deps.host,
    hosts: buildHostsFor(true),
    game: before,
    fetch: fixtureNativeFetch,
    run: runTool,
    now: Date.now,
    publish: () => undefined,
  });
  for (const slug of [...INSTALLED_AT_START, "puck-rush"]) {
    if (await installer.record(slug)) continue;
    await installer.install(slug);
    await installer.idle();
  }
}
