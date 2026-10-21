/**
 * The Web game tab shows the game's web game: a game whose web game sits in a folder (a Godot or
 * Unity export in web/) and whose Live still holds another page of it, as when the game was opened
 * before the export existed, gets that page loaded when the tab is on the stage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { holdsOtherPage } from "../../src/renderer/panels/stage/live-load.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";

const fact = (id: string, path: string) => ({ id, path });
const GODOT = { facts: [fact(CoreFact.GodotProject, "godot"), fact(CoreFact.WebGame, "web")] };
const UNITY = { facts: [fact(CoreFact.UnityProject, "unity"), fact(CoreFact.WebGame, "Web")] };
const WEB = { facts: [fact(CoreFact.WebGame, ".")] };
const holding = (entry: string | null, project = "star-dodger", navigating = false) => ({ project, entry, navigating });

test("Live holding another page of a game with a web export loads the export", () => {
  const rows: Array<[string, Parameters<typeof holdsOtherPage>[0], ReturnType<typeof holding> | null, boolean]> = [
    ["a Godot game opened before its export existed", GODOT, holding("index.html"), true],
    ["a Godot game whose export Live plays", GODOT, holding("web/index.html"), false],
    ["a Godot game Live has loaded no page of", GODOT, holding(null), true],
    ["a Unity game opened before its WebGL build", UNITY, holding("index.html"), true],
    ["a Unity game whose build in Web/ Live plays", UNITY, holding("Web/index.html"), false],
    ["a page still loading", GODOT, holding("index.html", "star-dodger", true), false],
    ["Live holding another game", GODOT, holding("index.html", "pong"), false],
    ["a web game at the root", WEB, holding("index.html"), false],
    ["no Live status yet", GODOT, null, false],
  ];
  for (const [title, game, live, loads] of rows) assert.equal(holdsOtherPage(game, "star-dodger", live), loads, title);
  assert.equal(holdsOtherPage(null, "star-dodger", holding("index.html")), false, "no game on the stage");
});
