/**
 * The Publish dialog's platform rows as words (canvas board "Publish"): what each platform's build
 * is, how big, and what the row offers, "Coming soon" for an app genex.games does not take yet and
 * "Make with agent" for one not made. Pure: the dialog draws it, tests read it.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { NATIVE_WORDS, PUBLISH_PLATFORM_WORDS } from "../../../words.ts";

const WORDS = PUBLISH_PLATFORM_WORDS;

/** What a row offers at its end. Display only: never stored. */
export const PlatformEnd = {
  /** Nothing: the web row, or an app Publish sends. */
  None: "none",
  /** Built, but genex.games does not take it yet. */
  Soon: "soon",
  /** Not made: the agent can make it. */
  Make: "make",
} as const;
export type PlatformEnd = (typeof PlatformEnd)[keyof typeof PlatformEnd];

/** One platform's row as the dialog draws it. */
export interface PlatformRow {
  target: PublishTarget;
  name: string;
  detail: string;
  /** The build's size; none for the web or a missing build. */
  size: string | null;
  state: PublishPlatform["state"];
  end: PlatformEnd;
}

type NativeTarget = typeof PublishTarget.Mac | typeof PublishTarget.Windows;

const isNative = (row: PublishPlatform): row is PublishPlatform & { target: NativeTarget } =>
  row.target !== PublishTarget.Web;

/** A native row's second line: what it runs on and when it was built, or why it is not ready. */
function nativeDetail(row: PublishPlatform & { target: NativeTarget }, now: number): string {
  if (row.state === PublishPlatformState.Missing) return WORDS.missing;
  if (row.state === PublishPlatformState.Stale) return WORDS.stale;
  const runsOn = row.arch ? WORDS.arch[row.target][row.arch] : "";
  const built = row.builtAt ? WORDS.built(row.builtAt, now) : "";
  return [runsOn, built].filter(Boolean).join(" · ");
}

/** What a native row offers: making it while missing, else "Coming soon" until Publish sends it. */
function nativeEnd(row: PublishPlatform): PlatformEnd {
  if (row.state === PublishPlatformState.Missing) return PlatformEnd.Make;
  return row.uploads ? PlatformEnd.None : PlatformEnd.Soon;
}

/** The rows in the order they come, each as words. */
export function platformRows(platforms: readonly PublishPlatform[], now: number): PlatformRow[] {
  return platforms.map((row) => {
    if (!isNative(row)) {
      const ready = row.state === PublishPlatformState.Ready;
      return {
        target: row.target,
        name: WORDS.name[row.target],
        detail: ready ? WORDS.webReady : WORDS.webMissing,
        size: null,
        state: row.state,
        end: PlatformEnd.None,
      };
    }
    return {
      target: row.target,
      name: WORDS.name[row.target],
      detail: nativeDetail(row, now),
      size: row.bytes > 0 && row.state !== PublishPlatformState.Missing ? sizeWords(row.bytes) : null,
      state: row.state,
      end: nativeEnd(row),
    };
  });
}

/**
 * Whether the dialog lists platforms: for a game made in an engine, which can be built as an app,
 * or one whose folder already holds an app. A web game with no app keeps the dialog as it was.
 */
export const listsPlatforms = (platforms: readonly PublishPlatform[], engineGame: boolean): boolean =>
  engineGame || platforms.some((row) => isNative(row) && row.state !== PublishPlatformState.Missing);

/** The line under the rows: whose players get the web version, while Publish sends the web build. */
export function reachLine(platforms: readonly PublishPlatform[]): string | null {
  const web = platforms.find((row) => row.target === PublishTarget.Web);
  if (web?.state !== PublishPlatformState.Ready) return null;
  const players = platforms.filter((row) => isNative(row) && !row.uploads).map((row) => playersOf(row.target));
  return players.length > 0 ? WORDS.reach(NATIVE_WORDS.platforms(players)) : null;
}

/** The players a native row is for: "Mac", "Windows". */
const playersOf = (target: PublishTarget): string => (target === PublishTarget.Web ? "" : WORDS.players[target]);

/** What "Make with agent" sends through the game's chat for a platform. */
export const makeAppAsk = (target: PublishTarget, title: string): string => WORDS.makeAsk(playersOf(target), title);
