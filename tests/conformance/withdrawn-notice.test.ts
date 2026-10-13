/**
 * What a resumed builder session is told about plugins and skills it was handed before and is not
 * now. A plugin switched off takes its tools and skills with it; a skill that no longer applies to
 * the game (a web-only skill once the game is an Unreal project) leaves its plugin's tools in place,
 * and the notice must never read as that plugin being off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withdrawnNotice, withdrawnSince } from "../../src/main/core/delegation-prompts.ts";

test("a skill that no longer applies to the game is withdrawn alone: its plugin stays on", () => {
  const before = {
    plugins: ["blender", "genex"],
    skills: ["blender/local-modeling", "genex/publishing", "genex/genex"],
  };
  const now = { plugins: ["blender", "genex", "unreal"], skills: ["genex/genex", "unreal/unreal-editor"] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  assert.match(notice, /blender\/local-modeling/);
  assert.match(notice, /genex\/publishing/);
  assert.doesNotMatch(notice, /no longer enabled|they are gone|do not call/i, notice);
  assert.match(notice, /still (on|enabled)/i, notice);
  assert.match(notice, /\bblender\b.*\bgenex\b|\bgenex\b.*\bblender\b/, "names the plugins that stay on");
  assert.doesNotMatch(notice, /\n\n/, "one paragraph");
});

test("a plugin switched off takes its tools and its skills with it", () => {
  const before = { plugins: ["blender", "genex"], skills: ["blender/local-modeling", "genex/genex"] };
  const now = { plugins: ["genex"], skills: ["genex/genex"] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  assert.match(notice, /no longer enabled/);
  assert.match(notice, /\bblender\b/);
  assert.match(notice, /blender\/local-modeling/);
  assert.match(notice, /do not call their tools/);
  assert.doesNotMatch(notice, /genex/, "nothing of a plugin still handed");
});

test("both at once: the plugin switched off, and another plugin's skill out of this game, in one paragraph", () => {
  const before = { plugins: ["blender", "genex"], skills: ["blender/local-modeling", "genex/publishing"] };
  const now = { plugins: ["genex"], skills: [] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  const [off, out] = [notice.indexOf("no longer enabled"), notice.indexOf("genex/publishing")];
  assert.ok(off >= 0 && out >= 0, notice);
  assert.doesNotMatch(notice, /\n\n/);
  assert.match(notice, /\bgenex\b[^.]*still/i, "the skill's plugin is still on");
});
