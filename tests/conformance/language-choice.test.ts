/**
 * The window's language choice: remembered on this computer, shared with main for its menus, and a
 * switch reloads the window (the app's words are read when it loads). Main missing the news still
 * switches the window.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Locale, SYSTEM_LANGUAGE } from "../../src/shared/locale.ts";
import type { StudioSettingsView } from "../../src/shared/studio-api.ts";
import { languageChoice, shareLanguage, switchLanguage, windowLanguage } from "../../src/renderer/language.ts";

const holder = globalThis as { localStorage?: unknown };
let original: unknown;

beforeEach(() => {
  original = holder.localStorage;
  const values = new Map<string, string>();
  holder.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
});
afterEach(() => {
  holder.localStorage = original;
});

function fakeApi(saved: StudioSettingsView["language"] = SYSTEM_LANGUAGE, fail = false) {
  const sent: unknown[] = [];
  const view = { learning: true, selfImproving: false, language: saved } as StudioSettingsView;
  return {
    sent,
    settings: async () => view,
    setSettings: async (patch: { language?: StudioSettingsView["language"] }) => {
      if (fail) throw new Error("main is busy");
      sent.push(patch);
      return { ...view, ...patch };
    },
  };
}

describe("the window's language", () => {
  it("is System until one is chosen, and an unknown stored value reads as System", () => {
    assert.equal(languageChoice(), SYSTEM_LANGUAGE);
    (holder.localStorage as Storage).setItem("studio.language", "tlh");
    assert.equal(languageChoice(), SYSTEM_LANGUAGE);
    assert.equal(windowLanguage(Locale.Korean), Locale.Korean);
  });

  it("a switch remembers the choice, tells main and reloads", async () => {
    const api = fakeApi();
    let reloads = 0;
    await switchLanguage(api, Locale.Russian, () => reloads++);
    assert.equal(languageChoice(), Locale.Russian);
    assert.deepEqual(api.sent, [{ language: Locale.Russian }]);
    assert.equal(reloads, 1);
  });

  it("still switches the window when main cannot be told", async () => {
    let reloads = 0;
    await switchLanguage(fakeApi(SYSTEM_LANGUAGE, true), Locale.Japanese, () => reloads++);
    assert.equal(languageChoice(), Locale.Japanese);
    assert.equal(reloads, 1);
  });

  it("tells main only when it holds another choice", async () => {
    (holder.localStorage as Storage).setItem("studio.language", Locale.German);
    const behind = fakeApi(SYSTEM_LANGUAGE);
    await shareLanguage(behind);
    assert.deepEqual(behind.sent, [{ language: Locale.German }]);
    const same = fakeApi(Locale.German);
    await shareLanguage(same);
    assert.deepEqual(same.sent, []);
  });
});
