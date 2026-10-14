/**
 * Studio's own copy of the Genex game SDKs (`scripts/vendor-genex-sdk.ts`): what a template game's
 * import map points at must exist after a build, at the versions Studio tells the agent and Genex,
 * with every bundled package's license beside it.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { vendorGenexSdk } from "../../scripts/vendor-genex-sdk.ts";
import {
  GENEX_GAME_PACKAGES,
  GENEX_VENDORED_SDK,
  genexPackageSet,
  vendoredSdkEntries,
  vendoredSdkPackages,
} from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");

describe("Studio's vendored Genex SDKs", () => {
  it("builds every file a template game maps, at Studio's pins, licenses beside them", async () => {
    const vendor = await tmpDir("studio-genex-sdk-");
    const built = await vendorGenexSdk(repo, vendor);
    const files = await readdir(path.join(vendor, "genex"));
    for (const served of Object.values(GENEX_VENDORED_SDK))
      assert.ok(files.includes(path.posix.basename(served)), `${served} is built`);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(vendor, "genex", "VERSION.json"), "utf8")),
      GENEX_GAME_PACKAGES,
    );
    const licenses = await readFile(path.join(vendor, "genex", "LICENSES.md"), "utf8");
    for (const name of ["@genex-ai/multiplayer", "@genex-ai/embed-sdk", "@colyseus/sdk", "@colyseus/schema"])
      assert.match(licenses, new RegExp(`## ${name.replace("/", "\\/")} `), `${name}'s license ships`);
    assert.ok(built.inputs.some((input) => input.includes("node_modules/@colyseus/schema/")));
    // One copy of Colyseus's schema, shared: a state class one entry defines must be the other's.
    const multiplayer = await readFile(path.join(vendor, "genex", "multiplayer.js"), "utf8");
    const schema = await readFile(path.join(vendor, "genex", "multiplayer-schema.js"), "utf8");
    const chunks = (text: string) => [...text.matchAll(/from "\.\/(chunk-[^"]+\.js)"/g)].map(([, name]) => name);
    assert.ok(
      chunks(schema).some((chunk) => chunks(multiplayer).includes(chunk)),
      "the schema entry imports a chunk the multiplayer entry also imports",
    );
  });

  it("is the version package.json pins, so the agent, Genex and the game agree", async () => {
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(GENEX_GAME_PACKAGES))
      assert.equal(pkg.devDependencies[name], version, `${name} is pinned exactly`);
  });

  it("maps each package with what it needs, and counts only Studio's own copies as turned on", () => {
    assert.deepEqual(genexPackageSet("@genex-ai/multiplayer"), ["@genex-ai/multiplayer", "@genex-ai/embed-sdk"]);
    assert.deepEqual(
      vendoredSdkEntries("@genex-ai/multiplayer").map(([specifier]) => specifier),
      ["@genex-ai/multiplayer", "@genex-ai/multiplayer/schema", "@genex-ai/embed-sdk"],
    );
    assert.deepEqual(vendoredSdkEntries("@genex-ai/embed-sdk"), [
      ["@genex-ai/embed-sdk", "/vendor/genex/embed-sdk.js"],
    ]);
    assert.deepEqual(vendoredSdkPackages(Object.fromEntries(vendoredSdkEntries("@genex-ai/multiplayer"))), [
      "@genex-ai/multiplayer",
      "@genex-ai/embed-sdk",
    ]);
    const hostile: Array<[string, Record<string, string>]> = [
      ["a CDN copy", { "@genex-ai/embed-sdk": "https://esm.sh/@genex-ai/embed-sdk" }],
      ["the game's own file", { "@genex-ai/multiplayer": "/src/multiplayer.js" }],
      ["a path that only starts like Studio's", { "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk.js?x" }],
      ["an inherited key", Object.create({ "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk.js" })],
    ];
    for (const [name, imports] of hostile) assert.deepEqual(vendoredSdkPackages(imports), [], name);
  });
});
