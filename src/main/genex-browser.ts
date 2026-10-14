/**
 * Genex's pages in the person's real browser: a sign-in to finish, the terms, a game's page. Only an
 * https address opens, tagged `s=desktop` with its code kept, and a fixture launch opens none.
 */
import { shell } from "electron";
import { tagGenexLink } from "../plugins/genex/http.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";

const MESSAGE = { invalidAuthUrl: "Invalid authentication URL" } as const;

/** Open `address` in the browser, unless this is a fixture launch (which throws instead). */
export async function openGenexPage(fixtureNativePolicy: boolean, address: string): Promise<void> {
  assertNativeActionAllowed(fixtureNativePolicy, "studio:open-url");
  const url = new URL(address);
  if (url.protocol !== "https:") throw new Error(MESSAGE.invalidAuthUrl);
  await shell.openExternal(tagGenexLink(url.href));
}
