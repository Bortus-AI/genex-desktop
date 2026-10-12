import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverAsk,
  coverCardPublish,
  isGenexPublish,
  offeredTitle,
  PublishGate,
  publishGate,
  publishSteps,
  publishView,
  stripEntries,
  studioPublishButton,
} from "../../src/renderer/panels/plugins/genex/genex-publish-view.ts";
import {
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  type GenexCoverRecord,
  GenexCoverOutcome,
  type GenexCoverSent,
  type GenexCoverShot,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";
import { CoreFact, type FactRef, FolderHolds } from "../../src/shared/project-facts.ts";

const state = (over: Partial<GenexPublishState> = {}): GenexPublishState => ({
  version: 1,
  project: "game",
  connected: true,
  ...over,
});
const job = (over: Partial<GenexPublishJob> = {}): GenexPublishJob => ({
  id: "j1",
  kind: "gallery",
  state: "running",
  phase: "exporting",
  startedAt: "2026-09-30T10:00:00Z",
  ...over,
});

test("the dialog names where the game is and offers one press from there", () => {
  const none = publishView(state());
  assert.equal(none.stage, "none");
  assert.equal(none.primary.label, "Publish");
  assert.equal(none.primary.ariaLabel, "Publish this game on Genex", "the smoke selector stays");
  assert.equal(none.canPublish, true);
  assert.ok(!("secondary" in none), "a draft is no second button beside Publish");

  const draft = publishView(state({ slug: "my-game", status: "draft", draftUrl: "https://x/draft" }));
  assert.equal(draft.stage, "draft");
  assert.equal(draft.primary.label, "Publish");

  const live = publishView(state({ slug: "my-game", status: "published", galleryUrl: "https://x/g" }));
  assert.equal(live.stage, "public");
  assert.equal(live.primary.label, "Publish update");

  const signedOut = publishView(state({ connected: false }));
  assert.equal(signedOut.canPublish, false);
  assert.deepEqual(signedOut.problems, [], "Connect Genex is offered in its place, not reported as a problem");
});

test("Publish asks for what is missing in order: Genex installed, turned on, then an account", () => {
  assert.equal(publishGate(undefined, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: true }, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: false }, undefined), PublishGate.TurnOn);
  assert.equal(publishGate({ enabled: true, removed: false }, false), PublishGate.Connect);
  assert.equal(publishGate({ enabled: true, removed: false }, true), PublishGate.Ready);
  assert.equal(
    publishGate({ enabled: true, removed: false }, undefined),
    PublishGate.Ready,
    "unread yet is not asked for",
  );
});

const genex = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: {
    apiVersion: 3,
    id: GENEX_PLUGIN_ID,
    version: "1.0.0",
    name: "Genex Tools",
    publisher: "Genex",
    description: "t",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [{ id: GENEX_PUBLISH_PANEL, title: "Publish", file: "publish.html", placement: "project" }],
    settings: [],
    actions: [],
    toolbar: [
      {
        id: "publish",
        label: "Publish",
        ariaLabel: "Publish game",
        target: { kind: "panel", id: GENEX_PUBLISH_PANEL },
      },
    ],
  },
  source: "bundled",
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  ...over,
});

test("every open web game has Publish on its stage strip, whether Genex is on, off, removed or missing", () => {
  const web: FactRef[] = [{ id: CoreFact.WebGame, path: "." }];
  assert.equal(studioPublishButton([genex()], "game", web), false, "Genex's own button is the one shown");
  assert.equal(studioPublishButton([genex({ enabled: false, state: "disabled" })], "game", web), true);
  assert.equal(studioPublishButton([genex({ enabled: false, removed: true, state: "disabled" })], "game", web), true);
  assert.equal(studioPublishButton([], "game", web), true);
  assert.equal(studioPublishButton([], null, web), false, "with no game open there is nothing to publish");
});

/** Another plugin's stage-strip button, which no engine takes away. */
const other = (): PluginInfo => {
  const base = genex();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id: "demo",
      panels: [{ id: "demo", title: "Demo", file: "demo.html", placement: "project" }],
      toolbar: [{ id: "demo", label: "Demo", ariaLabel: "Demo panel", target: { kind: "panel", id: "demo" } }],
    },
  };
};

test("an Unreal game has no Publish on its strip: its folder holds an Unreal project, not a web build", () => {
  const unreal: FactRef[] = [{ id: CoreFact.UnrealProject, path: "unreal" }];
  const strip = (plugins: PluginInfo[], facts: FactRef[]) => ({
    genex: stripEntries(plugins, "game", facts).some(isGenexPublish),
    studio: studioPublishButton(plugins, "game", facts),
    others: stripEntries(plugins, "game", facts)
      .filter((entry) => !isGenexPublish(entry))
      .map((entry) => entry.key),
  });
  const genexStates: Array<[string, PluginInfo[]]> = [
    ["Genex on", [genex(), other()]],
    ["Genex off", [genex({ enabled: false, state: "disabled" }), other()]],
    ["Genex removed", [genex({ enabled: false, removed: true, state: "disabled" }), other()]],
    ["Genex missing", [other()]],
  ];
  for (const [name, plugins] of genexStates)
    assert.deepEqual(
      strip(plugins, unreal),
      { genex: false, studio: false, others: ["demo:demo"] },
      `${name}: no Publish, every other button stays`,
    );

  assert.deepEqual(strip([genex(), other()], []), {
    genex: true,
    studio: false,
    others: ["demo:demo"],
  });
  assert.deepEqual(strip([other()], [{ id: CoreFact.WebGame, path: "." }]), {
    genex: false,
    studio: true,
    others: ["demo:demo"],
  });
});

test("Publish sits on the strip only while the game is served as a web game at its root", () => {
  const strip = (facts: FactRef[], holds?: FolderHolds) => ({
    genex: stripEntries([genex(), other()], "game", facts, holds).some(isGenexPublish),
    studio: studioPublishButton([other()], "game", facts, holds),
  });
  const rows: Array<[string, FactRef[], FolderHolds | undefined, boolean]> = [
    ["a web game at the root", [{ id: CoreFact.WebGame, path: "." }], undefined, true],
    ["no kind yet, served as a web game", [], undefined, true],
    ["an empty folder, served as a web game", [], FolderHolds.Nothing, true],
    ["a folder of notes, served as a web game", [], FolderHolds.Notes, true],
    ["a folder of its own files of a kind no rule knows", [], FolderHolds.OwnFiles, false],
    ["a folder that can't be read", [], FolderHolds.Unreadable, false],
    ["a Godot project", [{ id: CoreFact.GodotProject, path: "." }], undefined, false],
    ["a web game only below the root", [{ id: CoreFact.WebGame, path: "site" }], undefined, false],
    ["a linked Unreal project", [{ id: CoreFact.UnrealProject, path: "unreal" }], undefined, false],
  ];
  for (const [name, facts, holds, shown] of rows)
    assert.deepEqual(
      strip(facts, holds),
      { genex: shown, studio: shown },
      `${name}: Publish ${shown ? "shown" : "hidden"}`,
    );
});

test("the chat's Genex cover card offers Publish while Genex's own Publish is on the strip and nothing publishes", () => {
  assert.equal(coverCardPublish([genex()], "game", state()), true);
  assert.equal(coverCardPublish([genex()], "game", null), true, "a record not read yet hides nothing");
  assert.equal(coverCardPublish([genex()], "game", state({ job: job() })), false, "a publish is running");
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "unresolved" }) })), false);
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "done", phase: "done" }) })), true);
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "failed", phase: "failed" }) })), true);
  assert.equal(coverCardPublish([genex({ enabled: false, state: "disabled" })], "game", state()), false, "Genex off");
  assert.equal(coverCardPublish([genex({ removed: true })], "game", state()), false, "Genex removed");
  assert.equal(coverCardPublish([], "game", state()), false, "Genex missing");
  assert.equal(coverCardPublish([genex()], null, state()), false, "no game to publish");
});

test("a running attempt shows its steps: every publish tests the draft before it goes live", () => {
  assert.deepEqual(publishSteps(job({ phase: "creating-project" })), ["prepare", "upload", "test", "live"]);
  assert.deepEqual(publishSteps(job({ kind: "draft", phase: "uploading" })), ["prepare", "upload", "test"]);

  const testing = publishView(state({ slug: "g", job: job({ phase: "verifying-deployment" }) }));
  assert.equal(testing.running, true);
  assert.equal(testing.canPublish, false, "nothing else starts while one runs");
  assert.equal(testing.phase, "Making sure it plays");
  assert.equal(testing.status, "Publishing…");
  assert.deepEqual(
    testing.steps.map((s) => [s.step, s.state]),
    [
      ["prepare", "done"],
      ["upload", "done"],
      ["test", "current"],
      ["live", "next"],
    ],
  );
  const promoting = publishView(state({ slug: "g", status: "published", job: job({ phase: "promoting" }) }));
  assert.equal(promoting.phase, "Going live");
  assert.equal(promoting.steps.at(-1)?.state, "current");
});

test("a live game shows its link and when it was updated", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const live = publishView(
    state({
      slug: "g",
      status: "published",
      galleryUrl: "https://genex.games/g",
      lastPublishAt: "2026-10-06T11:58:00Z",
      job: job({ state: "done", phase: "ready" }),
    }),
    now,
  );
  assert.equal(live.link, "https://genex.games/g");
  assert.equal(live.status, "Live · updated 2m ago");
  assert.equal(live.failure, null);
  assert.equal(
    publishView(state({ slug: "g", galleryUrl: "https://genex.games/g" })).link,
    null,
    "a draft has no public link",
  );
});

test("a failed attempt is said calmly, its raw error kept only as details for support", () => {
  const failed = publishView(
    state({ job: job({ state: "failed", phase: "failed", error: "fixture: HTTP 502 at /api" }) }),
  );
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.problems, [], "the raw error is no problem line");
  assert.equal(failed.failure?.title, "It didn't go online this time");
  assert.match(failed.failure?.text ?? "", /Your game is safe and nothing changed/);
  assert.equal(failed.failure?.details, "fixture: HTTP 502 at /api");
  assert.equal(failed.primary.label, "Try again");
  assert.equal(failed.canPublish, true, "a failed attempt can be tried again");

  const listedFailed = publishView(
    state({ slug: "g", status: "published", job: job({ state: "failed", phase: "failed", error: "x" }) }),
  );
  assert.match(listedFailed.failure?.text ?? "", /players still get the version they had/);
});

test("an upload whose outcome is unknown offers Check again and the person's own word, never a silent retry", () => {
  const unknown = publishView(
    state({ slug: "g", job: job({ state: "unresolved", phase: "unresolved", kind: "draft", error: "lost" }) }),
  );
  assert.equal(unknown.running, false);
  assert.equal(unknown.unresolved, true);
  assert.equal(unknown.outcome, "unresolved");
  assert.deepEqual(
    unknown.extra.map((b) => [b.label, b.action]),
    [
      ["Check again", "publish-status"],
      ["I checked — allow a new upload", "publish-allow-upload"],
    ],
  );
  assert.equal(unknown.canPublish, false);
  assert.match(unknown.failure?.text ?? "", /couldn’t tell whether the upload reached Genex/);

  const terms = publishView(state({ terms: { accepted: false, acceptUrl: "https://x/terms" } }));
  assert.deepEqual(terms.problems, ["Review the updated Genex terms in your browser before publishing."]);
  assert.equal(terms.terms?.action, "terms", "the one press is reviewing them");
  assert.equal(publishView(state()).terms, null);
});

test("the name offered is the listed one, else Studio's title for the game, else its folder name as words", () => {
  assert.equal(offeredTitle(state({ title: "Rain Circuit" }), "Racing", "racing-demo"), "Rain Circuit");
  assert.equal(
    offeredTitle(state(), "Hyper-Realistic Racing", "hyper-realistic-racing-demo"),
    "Hyper-Realistic Racing",
  );
  assert.equal(offeredTitle(null, undefined, "hyper-realistic-racing-demo"), "Hyper Realistic Racing Demo");
  assert.equal(offeredTitle(null, "   ", "rain_circuit"), "Rain Circuit");
});

const shot: GenexCoverShot = {
  sha256: "a".repeat(64),
  width: 1920,
  height: 1080,
  mimeType: StillMimeType.Png,
  bytes: 1024,
  source: CaptureSource.Page,
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.9 },
  takenAt: "2026-10-09T10:00:00Z",
};
const cover = (over: Partial<GenexCoverRecord> = {}): GenexCoverRecord => ({
  shot: null,
  last: null,
  sending: false,
  ...over,
});
const last = (kind: GenexCoverOutcome) => ({ kind, at: "2026-10-09T10:05:00Z" });

test("the dialog asks for a cover only while the game has none to send and its owner chose none", () => {
  const live = { slug: "g", status: "published", lastPublishAt: "2026-10-09T10:05:00Z" } as const;
  const rows: Array<[string, GenexPublishState, boolean]> = [
    ["a game with no cover shot", state({ cover: cover() }), true],
    [
      "a published game whose last publish had no shot to send",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.None) }) }),
      true,
    ],
    ["a cover shot kept to send", state({ cover: cover({ shot }) }), false],
    ["a cover being sent now", state({ ...live, cover: cover({ sending: true }) }), false],
    [
      "the owner chose the cover on genex.games",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.KeptOwner) }) }),
      false,
    ],
    [
      "the owner's pick outranked a frame",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.Outranked) }) }),
      false,
    ],
    [
      "the same frame sent again, where the owner's pick held",
      state({
        ...live,
        cover: cover({ last: { ...last(GenexCoverOutcome.Unchanged), settled: GenexCoverOutcome.KeptOwner } }),
      }),
      false,
    ],
    ["a Genex plugin that answers no cover", state(live), false],
    ["a publish running", state({ cover: cover(), job: job() }), false],
  ];
  for (const [label, record, asks] of rows) {
    assert.equal(coverAsk(record), asks, label);
    assert.equal(publishView(record).coverAsk, asks, `${label}: the view`);
  }
});

test("the chat's cover card leaves Publish out once Genex has answered for the kept frame", () => {
  const sent = (kind: GenexCoverOutcome, over: Partial<GenexCoverSent> = {}): GenexCoverSent => ({
    ...last(kind),
    sha256: shot.sha256,
    ...over,
  });
  const { Applied, Outranked, KeptOwner, Unchanged, Failed, NotHosted, Rejected } = GenexCoverOutcome;
  const rows: Array<[string, GenexCoverRecord, boolean]> = [
    ["a kept frame never sent", cover({ shot }), true],
    ["Genex took this frame (a publish re-shoots and sends it)", cover({ shot, last: sent(Applied) }), false],
    ["the owner's pick outranked this frame", cover({ shot, last: sent(Outranked) }), false],
    ["the owner's pick held, nothing uploaded", cover({ shot, last: sent(KeptOwner) }), false],
    ["this frame again, Genex took it before", cover({ shot, last: sent(Unchanged, { settled: Applied }) }), false],
    [
      "a newer frame kept since the last one went",
      cover({ shot, last: sent(Applied, { sha256: "b".repeat(64) }) }),
      true,
    ],
    ["this frame did not reach Genex: the next publish tries again", cover({ shot, last: sent(Failed) }), true],
    ["no hosted project yet: the first publish takes it", cover({ shot, last: sent(NotHosted) }), true],
    ["Genex refused this frame", cover({ shot, last: sent(Rejected) }), true],
    ["this frame again, refused before", cover({ shot, last: sent(Unchanged, { settled: Rejected }) }), true],
  ];
  for (const [label, record, offers] of rows)
    assert.equal(coverCardPublish([genex()], "game", state({ cover: record })), offers, label);
});
