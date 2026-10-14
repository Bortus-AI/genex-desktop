/**
 * Genex's pages in the person's real browser: a sign-in to finish, the terms, a game's page. Only an
 * https address opens, tagged `s=desktop` with its code kept, and a fixture launch opens none.
 */
import { shell } from "electron";
import { browserGenexLink } from "../plugins/genex/http.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";

/** Open `address` in the browser, unless this is a fixture launch (which throws instead). */
export async function openGenexPage(fixtureNativePolicy: boolean, address: string): Promise<void> {
  assertNativeActionAllowed(fixtureNativePolicy, "studio:open-url");
  await shell.openExternal(browserGenexLink(address));
}
