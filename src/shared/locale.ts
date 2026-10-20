/**
 * The languages Genex speaks and how a computer's language list picks one. Browser-safe: main
 * resolves the menus' language with it, the renderer the window's.
 */

/** Every language the app is translated into, by its BCP 47 tag. English is the source. */
export const Locale = {
  English: "en",
  Russian: "ru",
  Spanish: "es",
  PortugueseBrazil: "pt-BR",
  German: "de",
  French: "fr",
  Japanese: "ja",
  Korean: "ko",
  ChineseSimplified: "zh-Hans",
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];

/** The languages in the order the switcher lists them. */
export const LOCALES: readonly Locale[] = Object.values(Locale);

/** Each language's own name, as the switcher shows it to a person who reads only that language. */
export const LOCALE_NAMES = {
  [Locale.English]: "English",
  [Locale.Russian]: "Русский",
  [Locale.Spanish]: "Español",
  [Locale.PortugueseBrazil]: "Português (Brasil)",
  [Locale.German]: "Deutsch",
  [Locale.French]: "Français",
  [Locale.Japanese]: "日本語",
  [Locale.Korean]: "한국어",
  [Locale.ChineseSimplified]: "简体中文",
} as const satisfies Record<Locale, string>;

/** The choice that follows the computer's own language. */
export const SYSTEM_LANGUAGE = "system" as const;
/** What Settings remembers: a language, or the computer's. */
export type LanguageChoice = Locale | "system";

/** Whether a stored value is a choice this version understands. */
export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return value === SYSTEM_LANGUAGE || LOCALES.includes(value as Locale);
}

/** Traditional Chinese tags: Simplified would read as foreign there, so they fall through to the next language. */
const TRADITIONAL_CHINESE = /^zh-(?:hant|tw|hk|mo)\b/;

/** The supported language one tag names ("ru-RU" → ru, "pt-PT" → pt-BR, "zh-CN" → zh-Hans), or none. */
function localeForTag(tag: string): Locale | undefined {
  const lower = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!lower) return undefined;
  const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  if (TRADITIONAL_CHINESE.test(lower)) return undefined;
  const language = lower.split("-")[0];
  if (language === "zh") return Locale.ChineseSimplified;
  if (language === "pt") return Locale.PortugueseBrazil;
  return LOCALES.find((locale) => locale === language);
}

/** The first supported language in a computer's preference list; English when none is. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const locale = localeForTag(tag);
    if (locale) return locale;
  }
  return Locale.English;
}

/** The language a choice means on this computer: a set language, or the computer's own. */
export function resolveLanguage(choice: unknown, systemTags: readonly string[]): Locale {
  if (isLanguageChoice(choice) && choice !== SYSTEM_LANGUAGE) return choice;
  return matchLocale(systemTags);
}
