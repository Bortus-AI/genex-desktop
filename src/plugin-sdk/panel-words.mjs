/**
 * A panel's words, on the build's side. A plugin keeps its panel's translations in its own
 * `locales/` folder: `messages.json` lists every English message the panel asks for (its
 * `t("…")` calls and its `data-t` marks), and `<lang>.json` maps each English message to that
 * language, `{}` until it is translated. `inline-panel-sdk.mjs` pastes the translated languages
 * into the panel beside the SDK (`words.js` reads them there); a panel's frame can load nothing.
 * Plain Node, no Studio imports.
 *
 *   node panel-words.mjs panel.html [more.html…]   writes locales/messages.json beside the first
 *                                                  panel and an empty catalog per missing language
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The languages Genex speaks besides English, by the tag the host names in a panel's context. */
export const PANEL_LOCALES = ["ru", "es", "pt-BR", "de", "fr", "ja", "ko", "zh-Hans"];
/** The folder beside a panel that holds its words, and the list of messages in it. */
export const LOCALES_FOLDER = "locales";
export const MESSAGES_FILE = "messages.json";
/** The id of the element the translations are pasted into; `words.js` reads it. */
export const CATALOGS_ID = "studio-panel-locales";

/** Code-unit order, so the list reads the same on every machine. */
function compareKeys(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** HTML's own escapes a panel's marked words may use. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Marked text as the frame reads it: entities decoded, runs of white space one space, trimmed. */
function decodedWords(text, problems) {
  const decoded = text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      return String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    problems.push(`unknown entity ${entity} in "${text.trim()}"`);
    return entity;
  });
  return decoded.replace(/\s+/g, " ").trim();
}

/** A JavaScript string literal's value; undefined when it is not a plain one. */
function literalValue(literal) {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === "`") return body.includes("${") || body.includes("\\") ? undefined : body;
  const json = quote === '"' ? body : body.replace(/\\'/g, "'").replace(/"/g, '\\"');
  try {
    return JSON.parse(`"${json}"`);
  } catch {
    return undefined;
  }
}

/** A `t(` call and its first argument: a string literal, or whatever else comes first. */
const T_CALL = /(?<![\w$])t\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)?/g;
/** A start tag and its attributes; one marked `data-t` names what of it is words. */
const START_TAG = /<([a-z][\w-]*)(\s[^>]*)?>/gi;
const MARK = /\sdata-t(?:\s*=\s*"([^"]*)")?(?=[\s/>]|$)/i;
const SCRIPT = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;

/** An element's contents from `from` up to its own closing tag; undefined when it has none. */
function textOf(markup, element, from) {
  const close = new RegExp(`</${element}\\s*>`, "i").exec(markup.slice(from));
  return close ? markup.slice(from, from + close.index) : undefined;
}

/** The value of one attribute in an element's attribute text. */
function attribute(attributes, name) {
  const escaped = name.replace(/[-]/g, "\\-");
  return new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)?.[1];
}

/**
 * Every English message a panel asks for, in code-unit order, and what could not be read: a `t(`
 * whose first argument is not a plain string literal, or a mark on something that is not plain text.
 * @param {string} html
 * @returns {{ messages: string[], problems: string[] }}
 */
export function panelMessages(html) {
  const found = new Set();
  const problems = [];
  const markup = html.replace(SCRIPT, (_whole, attributes = "", code) => {
    if (!/\btype\s*=\s*"application\/json"/i.test(attributes)) readCalls(code, found, problems);
    return "";
  });
  for (const tag of markup.matchAll(START_TAG)) readMark(markup, tag, found, problems);
  const messages = [...found].sort(compareKeys);
  return { messages, problems };
}

/** The messages of a script's `t(` calls. */
function readCalls(code, found, problems) {
  for (const call of code.matchAll(T_CALL)) {
    const value = call[1] === undefined ? undefined : literalValue(call[1]);
    if (value === undefined) problems.push(`t() needs a plain string first: ${call[0].trim()}…`);
    else found.add(value);
  }
}

/** The messages one start tag's `data-t` mark names: its text, or the attributes listed. */
function readMark(markup, tag, found, problems) {
  const [whole, element, attributes = ""] = tag;
  const mark = MARK.exec(attributes);
  if (!mark) return;
  const names = (mark[1] ?? "").split(/\s+/).filter(Boolean);
  for (const name of names.length > 0 ? names : ["text"]) {
    const raw = name === "text" ? textOf(markup, element, tag.index + whole.length) : attribute(attributes, name);
    const words = markedWords(element, name, raw, problems);
    if (words) found.add(words);
  }
}

/** The words of one marked text or attribute, or nothing when it cannot be read as words. */
function markedWords(element, name, raw, problems) {
  if (raw === undefined) problems.push(`<${element} data-t> has no ${name} to translate`);
  else if (name === "text" && raw.includes("<")) problems.push(`data-t marks text with markup: ${raw.trim()}`);
  else return decodedWords(raw, problems);
  return "";
}

/**
 * The translated languages in a `locales/` folder: each `<lang>.json` with at least one translation,
 * its empty strings left out. A folder that is missing has none; a file that is not a JSON object
 * of strings throws, naming it, so a build never ships a panel that silently lost a language.
 * @param {string} dir
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
export async function readPanelLocales(dir) {
  const catalogs = {};
  for (const locale of PANEL_LOCALES) {
    const said = await readCatalog(path.join(dir, `${locale}.json`));
    if (Object.keys(said).length > 0) catalogs[locale] = said;
  }
  return catalogs;
}

/** One language's translations, its empty strings left out; none when the file is missing. */
async function readCatalog(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "{}";
    throw error;
  });
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  const said = {};
  for (const [english, translation] of Object.entries(value)) {
    if (typeof translation !== "string") throw new Error(`${file}: "${english}" is not a string`);
    if (translation) said[english] = translation;
  }
  return said;
}

/**
 * The element that carries a panel's translations, for `words.js`; nothing when there are none.
 * Data, not code: the frame never runs it, and `<` is escaped so no text can close the element.
 * @param {Record<string, Record<string, string>>} catalogs
 */
export function panelLocalesScript(catalogs) {
  if (Object.keys(catalogs).length === 0) return "";
  const json = JSON.stringify(catalogs).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${CATALOGS_ID}">${json}</script>`;
}

/**
 * Writes `messages.json` for the panels into `dir`, and an empty catalog for each language that has
 * none yet. Answers the problems `panelMessages` found; nothing is written while there are any.
 * @param {string[]} panels the panel files
 * @param {string} dir the plugin's locales folder
 */
export async function writePanelMessages(panels, dir) {
  const found = new Set();
  const problems = [];
  for (const panel of panels) {
    const read = panelMessages(await readFile(panel, "utf8"));
    for (const message of read.messages) found.add(message);
    problems.push(...read.problems.map((problem) => `${panel}: ${problem}`));
  }
  if (problems.length > 0) return problems;
  await mkdir(dir, { recursive: true });
  const messages = [...found].sort(compareKeys);
  await writeFile(path.join(dir, MESSAGES_FILE), `${JSON.stringify(messages, null, 2)}\n`);
  for (const locale of PANEL_LOCALES)
    await writeFile(path.join(dir, `${locale}.json`), "{}\n", { flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  return [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const panels = process.argv.slice(2);
  if (panels.length === 0) {
    console.error("usage: node panel-words.mjs panel.html [more.html…]");
    process.exit(1);
  }
  const problems = await writePanelMessages(panels, path.join(path.dirname(panels[0]), LOCALES_FOLDER));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
