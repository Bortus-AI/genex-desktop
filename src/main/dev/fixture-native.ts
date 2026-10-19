/**
 * The native builds of a fixture launch's made-up games, as genex.games would serve their rows. Each
 * build's archive is on the fixture's `.invalid` build host, which never resolves: a fixture launch
 * never reaches the network for them.
 */
import { createHash } from "node:crypto";
import { FIXTURE_BUILD_HOST, NativeArch, NativePlatform } from "../../shared/play-native.ts";

/** One build a fixture game has. */
export interface FixtureBuildSpec {
  platform: NativePlatform;
  arch: NativeArch;
  version: string;
  /** What runs, inside the archive. */
  entry: string;
  /** The archive's and the unpacked game's sizes, as the catalog states them. */
  sizeBytes: number;
  installedBytes: number;
  /** Its oldest macOS or Windows version. */
  minOs?: string;
  publishedAt: string;
}

/** A fixture game's native side. */
export interface FixtureNative {
  /** It has a web build too: its card plays that. */
  web: boolean;
  engine: string;
  builds: FixtureBuildSpec[];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A Mac app of `title` at `version`, built for both kinds of Mac. */
export const macApp = (
  title: string,
  version: string,
  sizes: { archive: number; unpacked: number },
): FixtureBuildSpec => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version,
  entry: `${title}.app`,
  sizeBytes: sizes.archive,
  installedBytes: sizes.unpacked,
  minOs: "13.0",
  publishedAt: "2026-10-18T09:00:00.000Z",
});

/** A Windows program of `title` at `version`, in a folder of its own. */
export const windowsApp = (
  title: string,
  version: string,
  sizes: { archive: number; unpacked: number },
): FixtureBuildSpec => ({
  platform: NativePlatform.Windows,
  arch: NativeArch.X64,
  version,
  entry: `${title}/${title.replace(/\s+/g, "")}.exe`,
  sizeBytes: sizes.archive,
  installedBytes: sizes.unpacked,
  minOs: "10.0.19041",
  publishedAt: "2026-10-18T09:00:00.000Z",
});

/** Sizes the canvas shows: a 1.4 GB game, its 1.2 GB download. */
export const LARGE = { archive: Math.round(1.2 * GB), unpacked: Math.round(1.4 * GB) };
export const MEDIUM = { archive: 900 * MB, unpacked: Math.round(1.1 * GB) };
export const SMALL = { archive: 310 * MB, unpacked: 420 * MB };

/** Where a fixture build's archive is: the fixture build host, never a real one. */
export const fixtureBuildUrl = (slug: string, build: FixtureBuildSpec): string =>
  `https://${FIXTURE_BUILD_HOST}/${slug}/${build.version}/${build.platform}-${build.arch}.zip`;

/** A fixture build's row as genex.games serves it; its checksum a stand-in made from its address. */
export function fixtureBuildRow(slug: string, build: FixtureBuildSpec): Record<string, unknown> {
  const url = fixtureBuildUrl(slug, build);
  return { ...build, url, sha256: createHash("sha256").update(url).digest("hex") };
}

/** A fixture game's native fields on its gallery item: its builds, whether it has a web build and its engine. */
export const fixtureNativeFields = (slug: string, native: FixtureNative): Record<string, unknown> => ({
  builds: native.builds.map((build) => fixtureBuildRow(slug, build)),
  web: native.web,
  engine: native.engine,
});
