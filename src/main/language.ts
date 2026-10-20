/**
 * Main's language: the menus, dialogs and notifications speak the one chosen in Settings, else
 * the computer's. The window loads its own copy before main answers (`renderer/language.ts`); both
 * resolve System from the same list, the one Chromium was started with.
 */
import { app } from "electron";
import { currentLocale, setLocale } from "../shared/i18n.ts";
import { Locale, resolveLanguage } from "../shared/locale.ts";
import { loadCatalog } from "../shared/locales/index.ts";
import type { ChromiumSwitch } from "./dev/launch-flags.ts";

/** The language a test or fixture launch pins, so its checks read the English they were written in. */
const TEST_LANGUAGE = "en-US";

/** `--lang` for a launch whose checks read English words; a normal launch keeps the computer's. */
export function englishLaunchSwitches(english: boolean): ChromiumSwitch[] {
  return english ? [["lang", TEST_LANGUAGE]] : [];
}

/** The computer's languages in order, or the one a launch pinned with `--lang`. */
export function systemLanguages(): string[] {
  const pinned = app.commandLine.getSwitchValue("lang");
  return pinned ? [pinned] : app.getPreferredSystemLanguages();
}

/**
 * Speak `choice` from now on; true when the language changed, so the caller rebuilds what it drew
 * in the old one (the menu). A catalog that cannot load leaves English.
 */
export async function applyMainLanguage(choice: unknown): Promise<boolean> {
  const before = currentLocale();
  const locale = resolveLanguage(choice, systemLanguages());
  try {
    setLocale(locale, await loadCatalog(locale));
  } catch {
    setLocale(Locale.English, {});
  }
  return currentLocale() !== before;
}
