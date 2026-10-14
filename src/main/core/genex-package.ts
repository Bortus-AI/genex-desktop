/**
 * `genex__package`: the bundled Genex plugin's consented install of one of its two SDK packages
 * into the game a call is bound to. The agent names the package; the version comes from
 * `GENEX_GAME_PACKAGES` and the command from the game's lockfile (`GameBuilds.addPackages`), and
 * the folder must be, by real path, the game's own or a Studio worktree git registers for it.
 *
 * A game made from Studio's template has no package manager: there the call maps Studio's own
 * copies (`GENEX_VENDORED_SDK`, built at the same pins) into its page's import map instead, and
 * nothing is downloaded.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { InstallResult } from "../../shared/build-problem.ts";
import {
  GENEX_GAME_PACKAGES,
  type GenexGamePackage,
  genexPackageSet,
  isGenexGamePackage,
  vendoredSdkEntries,
} from "../../shared/genex.ts";
import type { PluginBinding } from "../../shared/plugins.ts";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { withImportMapEntries } from "../../substrate/game-page.ts";
import { containedReal, isBelow } from "../../substrate/paths.ts";
import { detectProjectShape } from "../../substrate/project-shape.ts";
import { git } from "../../substrate/snapshots.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

const WORKTREE_LINE = "worktree ";

/** What an install needs from Studio. */
export interface GenexPackageDeps {
  /** `GameBuilds.addPackages`: the one command, with the registry opened for it alone. */
  addPackages: (source: { project: string; dir: string }, names: readonly string[]) => Promise<InstallResult>;
  /** The game's folder in the library; throws for a name that is not a game. */
  gameDir: (project: string) => string;
  /** Studio's scratch, where its worktrees of a game live. */
  scratch: string;
}

/** What the agent reads back after an install ran. */
export interface GenexPackageAnswer {
  package: string;
  version: string;
  ok: boolean;
  lines: string[];
}

/** Where a call's packages go: the game's own package manager, or a template page's import map. */
export const PackageTarget = { Manager: "manager", ImportMap: "import-map" } as const;
export type PackageTarget = (typeof PackageTarget)[keyof typeof PackageTarget];

/** The folder a call is bound to, and how its packages get there. */
export interface PackageFolder {
  dir: string;
  target: PackageTarget;
}

/** The page a template game's import map lives in. */
const TEMPLATE_PAGE = "index.html";

/** The package a call names, checked against Studio's pins; anything else is refused. */
function genexPackageOf(args: Record<string, unknown>): GenexGamePackage {
  const name = args.package;
  if (isGenexGamePackage(name)) return name;
  throw new Error(GENEX_CLI_PROMPT.UnknownPackage(String(name), Object.keys(GENEX_GAME_PACKAGES)));
}

/** What the consent card shows for a `genex__package` call: the package and the version Studio pins. */
export function genexPackageConsentArgs(args: Record<string, unknown>): { package: string; version: string } {
  const name = genexPackageOf(args);
  return {
    package: genexPackageSet(name).join(", "),
    version: genexPackageSet(name)
      .map((item) => GENEX_GAME_PACKAGES[item])
      .join(", "),
  };
}

/**
 * Whether a folder is Studio's own template: a page of its own that shape detection recognises by
 * what only Studio writes (its contract stamp and the vendored-three import map).
 */
async function isTemplateGame(dir: string): Promise<boolean> {
  const page = await stat(path.join(dir, TEMPLATE_PAGE)).catch(() => null);
  return page?.isFile() === true && (await detectProjectShape(dir)) === null;
}

/**
 * Where Genex packages go in a game folder: its package.json's manager, a template page's import
 * map, or nowhere yet (a game with its own page and no package.json).
 */
export async function genexPackageTarget(dir: string): Promise<PackageTarget | null> {
  const manifest = await stat(path.join(dir, "package.json")).catch(() => null);
  if (manifest?.isFile()) return PackageTarget.Manager;
  return (await isTemplateGame(dir)) ? PackageTarget.ImportMap : null;
}

/** Adds a pinned Genex SDK package to the game a call is bound to, and nowhere else. */
export class GenexPackageService {
  readonly #deps: GenexPackageDeps;
  constructor(deps: GenexPackageDeps) {
    this.#deps = deps;
  }

  /** Check the package and the folder, then install or map; nothing runs when either is refused. */
  async add(args: Record<string, unknown>, binding: PluginBinding): Promise<GenexPackageAnswer> {
    const name = genexPackageOf(args);
    const folder = await this.preflight(args, binding);
    if (folder.target === PackageTarget.ImportMap) return mapVendoredSdk(folder.dir, name);
    const result = await this.#deps.addPackages({ project: binding.project, dir: folder.dir }, genexPackageSet(name));
    return { package: name, version: GENEX_GAME_PACKAGES[name], ...result };
  }

  /**
   * Refuse unsupported or foreign folders before asking for approval, and say where the packages
   * go: a package.json's manager, or a template game's import map. No process is started.
   */
  async preflight(args: Record<string, unknown>, binding: PluginBinding): Promise<PackageFolder> {
    genexPackageOf(args);
    const dir = await this.#boundFolder(binding);
    const target = await genexPackageTarget(dir);
    if (!target) throw new Error(GENEX_CLI_PROMPT.NoPackageJson);
    return { dir, target };
  }

  /** The binding's folder by real path: the game's own, or a worktree of it under Studio's scratch. */
  async #boundFolder(binding: PluginBinding): Promise<string> {
    const game = await this.#gameFolder(binding.project);
    const real = await realpath(binding.directory).catch(() => null);
    if (real && game && (real === game || (await this.#isWorktreeOf(game, real)))) return real;
    throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
  }

  async #gameFolder(project: string): Promise<string | null> {
    try {
      return await realpath(this.#deps.gameDir(project));
    } catch {
      return null;
    }
  }

  /** Whether git lists `dir` as a worktree of `game`, and it lies under Studio's scratch. */
  async #isWorktreeOf(game: string, dir: string): Promise<boolean> {
    const scratch = await realpath(this.#deps.scratch).catch(() => null);
    if (!scratch || !isBelow(scratch, dir)) return false;
    const listing = await git(game, ["worktree", "list", "--porcelain"]).catch(() => "");
    const worktrees = listing.split("\n").filter((line) => line.startsWith(WORKTREE_LINE));
    const real = await Promise.all(worktrees.map((line) => realpath(line.slice(WORKTREE_LINE.length)).catch(() => "")));
    return real.includes(dir);
  }
}

/**
 * Map Studio's own copies of `name` and what it needs into a template game's page, keeping what
 * the map already holds; refused, with nothing written, when the page has no import map to add to.
 */
async function mapVendoredSdk(dir: string, name: GenexGamePackage): Promise<GenexPackageAnswer> {
  const page = await containedReal(dir, TEMPLATE_PAGE);
  const entries = vendoredSdkEntries(name);
  const html = withImportMapEntries(await readFile(page, "utf8"), entries);
  if (html === null) throw new Error(GENEX_CLI_PROMPT.NoImportMap);
  await atomicWriteText(page, html);
  const lines = [
    ...entries.map(([specifier, url]) => GENEX_CLI_PROMPT.Mapped(specifier, url)),
    GENEX_CLI_PROMPT.MappedNext,
  ];
  return { package: name, version: GENEX_GAME_PACKAGES[name], ok: true, lines };
}
