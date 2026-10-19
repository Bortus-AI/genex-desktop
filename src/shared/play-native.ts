/**
 * Native builds of a Play game: a Mac app or a Windows program the author built in Unity, Godot or
 * Unreal, which Genex installs and runs in its own window. This is the app's copy of the draft
 * contract genex.games serves (`docs/play.md`, "Native builds"): every field is optional on the
 * wire, and a game the API says nothing new about stays today's web game. Browser-safe: main parses
 * the API's answers with it and the renderer reads the same shapes.
 */

/** The systems a build runs on, in the API's spelling. Wire values: never rename one. */
export const NativePlatform = { Mac: "mac", Windows: "windows", Linux: "linux" } as const;
export type NativePlatform = (typeof NativePlatform)[keyof typeof NativePlatform];

/** A build's processor architecture; `universal` is a Mac app with both. Wire values: never rename one. */
export const NativeArch = { Arm64: "arm64", X64: "x64", Universal: "universal" } as const;
export type NativeArch = (typeof NativeArch)[keyof typeof NativeArch];

/** The platforms in the order cards and pages list them. */
export const NATIVE_PLATFORMS: readonly NativePlatform[] = Object.values(NativePlatform);

/**
 * Where Genex can run a native game today. Windows has no sandbox that gives a program a window
 * yet (`docs/windows-sandbox.md`), and no game runs outside one, so only the Mac launches.
 */
const LAUNCH_PLATFORMS: ReadonlySet<NativePlatform> = new Set([NativePlatform.Mac]);

/**
 * The hosts a build archive downloads from. genex.games has not named its build CDN yet, so the
 * set is empty and every row is dropped: Play stays as it is until the server and the app switch
 * native builds on together.
 */
export const NATIVE_BUILD_HOSTS: ReadonlySet<string> = new Set();

/**
 * The build host of a fixture launch's made-up games. `.invalid` never resolves, and a fixture
 * launch serves these archives from its own files, so no socket opens.
 */
export const FIXTURE_BUILD_HOST = "builds.genex.invalid";
/** The hosts a fixture launch's builds come from. */
export const FIXTURE_BUILD_HOSTS: ReadonlySet<string> = new Set([FIXTURE_BUILD_HOST]);

/** The largest archive the app downloads (32 GiB), and the largest unpacked game it installs (64 GiB). */
export const NATIVE_ARCHIVE_MAX_BYTES = 32 * 1024 ** 3;
export const NATIVE_INSTALL_MAX_BYTES = 64 * 1024 ** 3;
/** The most build rows one game keeps. */
export const NATIVE_BUILDS_MAX = 8;
/** The longest version and entry the app keeps. */
const VERSION_MAX = 64;
const ENTRY_MAX = 255;
/** The most folders a Windows entry may sit in. */
const ENTRY_DEPTH_MAX = 4;

/** One build of a game for one platform and architecture, as the API serves it. */
export interface NativeBuild {
  platform: NativePlatform;
  arch: NativeArch;
  /** The author's build id: what an update compares. */
  version: string;
  /** The archive's size: what the download is. */
  sizeBytes: number;
  /** The unpacked size: what the disk check asks for before the download starts. */
  installedBytes: number;
  /** The archive's sha256, lowercase hex: checked before anything is unpacked. */
  sha256: string;
  /** The archive's https address on a build host. */
  url: string;
  /** What runs, relative to the archive's root: `Dust Runners.app`, `Dust Runners/DustRunners.exe`. */
  entry: string;
  /** The oldest system it runs on: `13.0` (macOS), `10.0.19041` (Windows). */
  minOs?: string;
  /** When it was published, ISO 8601. */
  publishedAt: string;
}

/** What a game adds once the API names native builds for it. */
export interface PlayNative {
  /** It also has a web build: a card press plays that, and the native app is offered beside it. */
  web: boolean;
  /** The engine it was made with, as an engine id (`unity`, `godot`, `unreal`), or null. */
  engine: string | null;
  /** Its builds the app accepted; empty when every row was refused. */
  builds: NativeBuild[];
}

/** The computer a game would run on. */
export interface NativeHost {
  platform: NativePlatform;
  arch: typeof NativeArch.Arm64 | typeof NativeArch.X64;
  /** The system's version, dotted (`15.1`). */
  osVersion: string;
  /** An Apple silicon Mac that runs Intel apps (Rosetta is installed). */
  rosetta?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PLATFORMS: ReadonlySet<unknown> = new Set(NATIVE_PLATFORMS);
const ARCHES: ReadonlySet<unknown> = new Set(Object.values(NativeArch));
const isPlatform = (value: unknown): value is NativePlatform => PLATFORMS.has(value);
const isArch = (value: unknown): value is NativeArch => ARCHES.has(value);

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const OS_VERSION = /^\d{1,4}(\.\d{1,6}){0,3}$/;
const ENGINE = /^[a-z][a-z0-9-]{1,39}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const UNSAFE_ENTRY_CHARACTER = /[\0-\x1f\x7f\\:*?"<>|]/;

/** A size the wire may name: a whole number of bytes above zero, at most `max`. */
const isSize = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;

/** An https address on one of `hosts`, with no port and no credentials, else null. */
function buildUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain && hosts.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether `entry` stays inside the archive, spelled plainly: `/`-separated, no absolute path, drive,
 * backslash or control character, and no empty, `.` or `..` part.
 */
function isPlainEntry(entry: string): boolean {
  if (entry.length > ENTRY_MAX || entry.startsWith("/") || UNSAFE_ENTRY_CHARACTER.test(entry)) return false;
  return entry.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Whether `entry` is what `platform` launches: a Mac app bundle at the archive's root, a Windows `.exe`. */
function launchesOn(platform: NativePlatform, entry: string): boolean {
  if (!isPlainEntry(entry)) return false;
  const parts = entry.split("/");
  if (platform === NativePlatform.Mac) return parts.length === 1 && entry.toLowerCase().endsWith(".app");
  if (platform === NativePlatform.Windows)
    return parts.length <= ENTRY_DEPTH_MAX && entry.toLowerCase().endsWith(".exe");
  return parts.length <= ENTRY_DEPTH_MAX;
}

/** Whether `arch` exists for `platform`: only a Mac app is universal. */
const archOn = (platform: NativePlatform, arch: NativeArch): boolean =>
  arch !== NativeArch.Universal || platform === NativePlatform.Mac;

/** A date the wire names, as ISO 8601, or null. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** What a row builds: its platform, architecture, version and entry, when each is one the app accepts. */
function identityOf(
  value: Record<string, unknown>,
): Pick<NativeBuild, "platform" | "arch" | "version" | "entry"> | null {
  const { platform, arch, version, entry } = value;
  if (!isPlatform(platform) || !isArch(arch) || !archOn(platform, arch)) return null;
  if (typeof version !== "string" || version.length > VERSION_MAX || !VERSION.test(version)) return null;
  if (typeof entry !== "string" || !launchesOn(platform, entry)) return null;
  return { platform, arch, version, entry };
}

/** One build row, or null when anything in it is off. */
function parseBuild(value: unknown, hosts: ReadonlySet<string>): NativeBuild | null {
  if (!isRecord(value)) return null;
  const identity = identityOf(value);
  const { minOs, sizeBytes, installedBytes } = value;
  if (!identity) return null;
  if (!isSize(sizeBytes, NATIVE_ARCHIVE_MAX_BYTES) || !isSize(installedBytes, NATIVE_INSTALL_MAX_BYTES)) return null;
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  const url = buildUrl(value.url, hosts);
  const publishedAt = isoDate(value.publishedAt);
  if (!SHA256.test(sha256) || !url || !publishedAt) return null;
  if (minOs !== undefined && (typeof minOs !== "string" || !OS_VERSION.test(minOs))) return null;
  return {
    ...identity,
    sizeBytes,
    installedBytes,
    sha256,
    url,
    ...(typeof minOs === "string" ? { minOs } : {}),
    publishedAt,
  };
}

/**
 * A game's build rows as the API serves them: each one kept only when every field is sane and its
 * archive is on one of `hosts`, one per platform and architecture (the first), at most
 * {@link NATIVE_BUILDS_MAX}. Anything that is not a list is no builds.
 */
export function parseNativeBuilds(value: unknown, hosts: ReadonlySet<string>): NativeBuild[] {
  if (!Array.isArray(value)) return [];
  const builds: NativeBuild[] = [];
  const seen = new Set<string>();
  for (const row of value.slice(0, NATIVE_BUILDS_MAX * 4)) {
    const build = parseBuild(row, hosts);
    const key = build ? `${build.platform}/${build.arch}` : "";
    if (!build || seen.has(key)) continue;
    seen.add(key);
    builds.push(build);
    if (builds.length === NATIVE_BUILDS_MAX) break;
  }
  return builds;
}

/**
 * What a gallery item says about its native side, or undefined for an item that names no builds:
 * today's web game. A game whose rows were all refused keeps an empty list, so a native-only game is
 * never mistaken for a web one.
 */
export function nativeOf(item: Record<string, unknown>, hosts: ReadonlySet<string>): PlayNative | undefined {
  if (!Array.isArray(item.builds) || item.builds.length === 0) return undefined;
  const engine = typeof item.engine === "string" ? item.engine.toLowerCase() : "";
  return {
    web: item.web !== false,
    engine: ENGINE.test(engine) ? engine : null,
    builds: parseNativeBuilds(item.builds, hosts),
  };
}

/** Anything that may carry a native side: a card, a game's page. */
interface WithNative {
  native?: PlayNative;
}

/** Whether a game has a web build: every game the API names no builds for, and a native one that says so. */
export const hasWebBuild = (game: WithNative): boolean => game.native?.web !== false;

/** The platforms a game was built for, in {@link NATIVE_PLATFORMS} order; none for a web-only game. */
export function platformsOf(game: WithNative): NativePlatform[] {
  const built = new Set(game.native?.builds.map((build) => build.platform));
  return NATIVE_PLATFORMS.filter((platform) => built.has(platform));
}

/** `a` against `b`, dotted system versions compared number by number (`13` equals `13.0`). */
export function compareOsVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Whether `host` meets a build's minimum system. */
const runsOn = (build: NativeBuild, host: NativeHost): boolean =>
  !build.minOs || compareOsVersions(host.osVersion, build.minOs) >= 0;

/** Whether `host` runs an Intel-only Mac app: an Apple silicon Mac with Rosetta. */
const translatesIntel = (host: NativeHost): boolean => host.arch === NativeArch.Arm64 && host.rosetta === true;

/**
 * The build this computer installs, or null: this platform's build for its own architecture first,
 * then a universal Mac app, then (an Apple silicon Mac with Rosetta) an Intel-only one, each only
 * where its minimum system is met. Nothing is offered where Genex cannot launch a game yet.
 */
export function buildFor(builds: readonly NativeBuild[], host: NativeHost): NativeBuild | null {
  if (!LAUNCH_PLATFORMS.has(host.platform)) return null;
  const fits = builds.filter((build) => build.platform === host.platform && runsOn(build, host));
  const own = fits.find((build) => build.arch === host.arch);
  const universal = fits.find((build) => build.arch === NativeArch.Universal);
  const intel = translatesIntel(host) ? fits.find((build) => build.arch === NativeArch.X64) : undefined;
  return own ?? universal ?? intel ?? null;
}

/** Whether a game plays on `host` at all: in the viewer, or as a build this computer installs. */
export const playableHere = (game: WithNative, host: NativeHost): boolean =>
  hasWebBuild(game) || buildFor(game.native?.builds ?? [], host) !== null;
