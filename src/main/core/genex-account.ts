/**
 * The app's Genex account in main: the one view the plate, Settings and Publish read, sign-in in the
 * browser, cancel, and sign-out (Studio's own UI asks first). It rides on the Genex plugin's account
 * (`pluginAccountPort`), which the registry keeps while Genex is off (`PluginRegistry.appAccount`),
 * or on a fixture launch's. Only genex.games refusing the token ends a sign-in (`refused`): going
 * offline never does. Electron-free; the browser comes in as a dep.
 */
import { GenexAccountStatus, type GenexAccountView } from "../../shared/genex-account.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { PluginAccountState, type PluginInfo } from "../../shared/plugins.ts";
import type { PluginRegistry } from "../../substrate/plugins/registry.ts";

/** What the app's Genex account rides on: the Genex plugin's account, or a fixture launch's. */
export interface GenexAccountPort {
  /** The account's state, or undefined while no Genex is installed. */
  state(): Promise<PluginAccountState | undefined>;
  /** The account's token while it is signed in. */
  token(): Promise<string | undefined>;
  /** Start a browser sign-in: the page that finishes it and the code it shows (none when already signed in). */
  connect(): Promise<{ verifyUrl?: unknown; userCode?: unknown }>;
  /** Stop a sign-in under way. */
  cancel(): Promise<void>;
  /** Forget the account on this Mac. */
  disconnect(): Promise<void>;
}

export interface GenexAccountDeps {
  port: GenexAccountPort;
  /** Open the page that finishes a sign-in in the person's browser. */
  openSignIn(url: string): Promise<void>;
}

/** The app's Genex account over `deps`. */
export function createGenexAccount(deps: GenexAccountDeps) {
  const { port } = deps;
  /** The token genex.games last refused: while it is the account's, the sign-in has ended. */
  let refusedToken: string | null = null;
  /** The code of the sign-in this account started, shown while it waits. */
  let code: string | undefined;

  const view = async (): Promise<GenexAccountView> => {
    const state = await port.state();
    if (state === PluginAccountState.Authorizing)
      return code ? { status: GenexAccountStatus.SigningIn, code } : { status: GenexAccountStatus.SigningIn };
    code = undefined;
    const token = state === PluginAccountState.Unlocked ? await port.token() : undefined;
    if (!token) return { status: GenexAccountStatus.SignedOut };
    return { status: token === refusedToken ? GenexAccountStatus.Ended : GenexAccountStatus.SignedIn };
  };

  /** Sign in in the browser; a refused token is forgotten first, or the sign-in would reuse it. */
  const signIn = async (): Promise<GenexAccountView> => {
    const token = await port.token();
    if (token && token === refusedToken) await port.disconnect();
    refusedToken = null;
    const answer = await port.connect();
    code = typeof answer.userCode === "string" ? answer.userCode : undefined;
    if (typeof answer.verifyUrl === "string") await deps.openSignIn(answer.verifyUrl);
    return view();
  };

  const cancel = async (): Promise<GenexAccountView> => {
    code = undefined;
    await port.cancel();
    return view();
  };

  const signOut = async (): Promise<GenexAccountView> => {
    refusedToken = null;
    await port.disconnect();
    return view();
  };

  return {
    view,
    signIn,
    cancel,
    signOut,
    /** The token Play's calls carry, while signed in. */
    token: (): Promise<string | undefined> => port.token(),
    /** genex.games answered 401 to `token`: the account reads as ended until it signs in again. */
    refused(token: string): void {
      refusedToken = token;
    },
  };
}

/** The app's Genex account as `createGenexAccount` makes it. */
export type GenexAccount = ReturnType<typeof createGenexAccount>;

/** What the plugin port reads and runs of the registry. */
type AccountRegistry = Pick<PluginRegistry, "accountState" | "hostCredential" | "action"> & {
  list(): Array<Pick<PluginInfo, "enabled" | "removed"> & { manifest: Pick<PluginInfo["manifest"], "id"> }>;
  restore(id: string): Promise<unknown>;
};

/**
 * The Genex plugin's account as the app's. Its actions run whether Genex is on or off; signing in
 * brings back a Genex that was removed (an older build let the person remove it), and leaves one
 * the person turned off as it is.
 */
export function pluginAccountPort(plugins: AccountRegistry): GenexAccountPort {
  const installed = (): boolean => plugins.list().some((p) => p.manifest.id === GENEX_PLUGIN_ID && !p.removed);
  const run = async (name: GenexAction): Promise<void> => {
    if (installed()) await plugins.action(GENEX_PLUGIN_ID, name, {});
  };
  return {
    state: async () => (installed() ? plugins.accountState(GENEX_PLUGIN_ID) : undefined),
    token: () => plugins.hostCredential(GENEX_PLUGIN_ID),
    connect: async () => {
      if (!installed()) await plugins.restore(GENEX_PLUGIN_ID);
      const answer: unknown = await plugins.action(GENEX_PLUGIN_ID, GenexAction.Connect, {});
      return answer && typeof answer === "object" ? answer : {};
    },
    cancel: () => run(GenexAction.CancelConnect),
    disconnect: () => run(GenexAction.Disconnect),
  };
}
