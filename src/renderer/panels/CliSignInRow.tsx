/**
 * Settings → Model Providers: the rows of the CLIs that sign in in their own terminal, OpenCode and
 * Grok Build. One row, each CLI's words and sign-in: install, sign in (the terminal opens inside
 * the row, so Settings stays open), the Account menu once connected, and the picker's models.
 * Loaded when Settings shows it (`MeteredProviders.tsx`): it is not on the first screen.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { TerminalKind, type TerminalSession } from "../../shared/terminal.ts";
import { useCliInstall } from "../cli-install.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { Pending } from "../ui/Pending.tsx";
import { METERED_PROVIDER_WORDS } from "../words.ts";
import {
  AccountMenu,
  ItemWords,
  type MeteredProviderProps,
  ProviderCard,
  useRecheck,
  useRun,
} from "./MeteredProviders.tsx";
import { OpenCodeRowState, openCodeRowState } from "./opencode-row.ts";
import { type ProviderWords, RowTone, type RowView } from "./provider-row.tsx";
import { useSignInTerminal } from "./use-sign-in-terminal.ts";

const WORDS = METERED_PROVIDER_WORDS;
const TerminalView = lazy(() => import("./TerminalView.tsx"));

/** What OpenCode's and Grok Build's rows can do: install, recheck, sign in or stop signing in, update. */
type CliRowActions = {
  install: () => void;
  recheck: () => void;
  signIn: () => void;
  cancelSignIn: () => void;
  /** Open the sign-in page the CLI printed, when it printed one. */
  openSignInPage: (() => void) | null;
  update: () => void;
};

/** What a row whose CLI signs in in its own terminal says: OpenCode's words, or Grok Build's. */
interface CliRowWords {
  card: ProviderWords;
  install: string;
  installLine: string;
  installingLine: string;
  signIn: string;
  signInLine: string;
  signingIn: string;
  openSignInPage: string;
  cancelSignIn: string;
  update: string;
  connectedLine: string;
  unreachable: string;
  /** The Account menu's item that signs in again: OpenCode adds a provider, Grok switches accounts. */
  again: { title: string; line: string };
  /** OpenCode's own free models running with no provider signed in; Grok Build has none. */
  freeOnly?: { status: string; line: string };
}

/** Grok Build's row, in the person's language (the renderer loads it before this module). */
const GROK_WORDS = {
  name: "Grok Build",
  guide: "https://docs.x.ai/build/overview",
  install: t("Install Grok Build"),
  installLine: t("Install it to build games with your Grok account."),
  installingLine: t("Installing Grok Build. This can take a minute."),
  signIn: t("Sign in"),
  signInLine: t("Sign in with your Grok account. Grok Build keeps the sign-in."),
  signingIn: t("Finish signing in to Grok in your browser."),
  cancelSignIn: t("Cancel"),
  openSignInPage: t("Open sign-in page"),
  signInAgain: t("Sign in again…"),
  signInAgainLine: t("Switch to another Grok account"),
  update: t("Update Grok Build"),
  connectedLine: t("Runs on your Grok account"),
  unreachable: t("Grok Build didn't answer. Check the installation, then try again."),
} as const;

const OPEN_CODE_ROW: CliRowWords = {
  ...WORDS.openCode,
  card: { name: WORDS.openCode.name, plans: "", guide: WORDS.openCode.guide },
  again: { title: WORDS.openCode.addProvider, line: WORDS.openCode.addProviderLine },
  freeOnly: { status: WORDS.openCode.freeOnly, line: WORDS.openCode.freeOnlyLine },
};

const GROK_ROW: CliRowWords = {
  ...GROK_WORDS,
  card: { name: GROK_WORDS.name, plans: "", guide: GROK_WORDS.guide },
  again: { title: GROK_WORDS.signInAgain, line: GROK_WORDS.signInAgainLine },
};

/** The row by its state: installing, missing, signing in, free models only, connected or unreachable. */
function cliRowView(state: OpenCodeRowState, act: CliRowActions, words: CliRowWords): RowView {
  switch (state) {
    case OpenCodeRowState.Installing:
      return { tone: RowTone.Busy, status: WORDS.installing, line: words.installingLine, actions: null };
    case OpenCodeRowState.NotInstalled:
      return {
        tone: RowTone.Off,
        status: WORDS.notInstalled,
        line: words.installLine,
        actions: (
          <>
            <Button variant="default" onClick={act.install}>
              {words.install}
            </Button>
            <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
          </>
        ),
      };
    case OpenCodeRowState.SigningIn:
      return signingInView(act, words);
    case OpenCodeRowState.SignedOut:
      return {
        tone: RowTone.Off,
        status: WORDS.notConnected,
        line: words.signInLine,
        actions: (
          <Button variant="default" onClick={act.signIn}>
            {words.signIn}
          </Button>
        ),
      };
    case OpenCodeRowState.FreeOnly:
      return words.freeOnly ? freeOnlyView(act, words, words.freeOnly) : connectedView(act, words);
    case OpenCodeRowState.Connected:
      return connectedView(act, words);
    default:
      return {
        tone: RowTone.Danger,
        status: WORDS.couldNotCheck,
        line: words.unreachable,
        actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
      };
  }
}

/** The CLI's own sign-in runs in the row's terminal, below: finish it there, or stop it. */
function signingInView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Busy,
    status: WORDS.signingIn,
    line: words.signingIn,
    actions: (
      <>
        {act.openSignInPage && (
          <Button variant="default" onClick={act.openSignInPage}>
            {words.openSignInPage}
          </Button>
        )}
        <Button onClick={act.cancelSignIn}>{words.cancelSignIn}</Button>
      </>
    ),
  };
}

/** The sign-in's terminal inside the row, so Settings stays open while the CLI asks its questions. */
function SignInTerminal({ session, onError }: { session: TerminalSession; onError: (error: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // The row may sit below the fold: bring the sign-in's questions into view once it starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per sign-in session
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [session.id]);
  return (
    <div
      ref={box}
      data-keeps-escape
      data-sign-in-terminal
      className="h-[26rem] min-h-0 overflow-hidden rounded-lg border border-line bg-base pt-2"
    >
      <Suspense fallback={<Pending label={WORDS.signingIn} className="px-3 py-2" working />}>
        <TerminalView session={session} visible onError={onError} />
      </Suspense>
    </div>
  );
}

/** No provider signed in: OpenCode's free models run, and Sign in comes first. */
function freeOnlyView(act: CliRowActions, words: CliRowWords, free: { status: string; line: string }): RowView {
  return {
    tone: RowTone.Warning,
    status: free.status,
    line: free.line,
    actions: (
      <>
        <Button variant="default" onClick={act.signIn}>
          {words.signIn}
        </Button>
        <AccountMenu name={words.card.name} onCheck={act.recheck}>
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </AccountMenu>
      </>
    ),
  };
}

/** Signed in: OpenCode is billed by each provider and can add one; Grok Build can switch accounts. */
function connectedView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Connected,
    status: WORDS.connected,
    line: words.connectedLine,
    actions: (
      <AccountMenu name={words.card.name} onCheck={act.recheck}>
        <>
          <DropdownMenuItem onSelect={act.signIn}>
            <ItemWords title={words.again.title} line={words.again.line} />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </>
      </AccountMenu>
    ),
  };
}

/** The CLIs whose row this is. */
type CliProvider = typeof EngineId.OpenCode | typeof EngineId.Grok;

/** Each CLI's sign-in terminal, its sign-in call and its words. */
const CLI_ROWS: Record<
  CliProvider,
  { terminal: TerminalKind; signIn: () => Promise<{ started: boolean }>; words: CliRowWords }
> = {
  [EngineId.OpenCode]: {
    terminal: TerminalKind.OpenCodeLogin,
    signIn: () => window.studio.openCodeSignIn(),
    words: OPEN_CODE_ROW,
  },
  [EngineId.Grok]: { terminal: TerminalKind.GrokLogin, signIn: () => window.studio.grokSignIn(), words: GROK_ROW },
};

/** The row of one CLI that signs in in its own terminal. */
export default function CliSignInRow({
  engine,
  onEnginesRefresh,
  provider,
}: { engine: EngineDescriptor; provider: CliProvider } & Pick<MeteredProviderProps, "onEnginesRefresh">) {
  const { terminal: terminalKind, signIn: startSignIn, words } = CLI_ROWS[provider];
  const install = useCliInstall(provider);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(provider, onEnginesRefresh);
  // The sign-in runs in this row's terminal; when it exits, the host asks the CLI again.
  const terminal = useSignInTerminal(terminalKind);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const state = openCodeRowState(engine, { installing: install.installing, signingIn: Boolean(terminal) });
  const signIn = (): void =>
    void run(async () => {
      setTerminalError(null);
      const started = await startSignIn();
      if (!started.started) await recheck();
    });
  const cancelSignIn = (): void => {
    if (terminal) void run(() => window.studio.terminalStop(terminal.id));
  };
  const view = cliRowView(
    state,
    {
      install: () => void install.install(),
      recheck: () => void run(recheck),
      signIn,
      cancelSignIn,
      openSignInPage: terminal?.signInPage ? () => void run(() => window.studio.terminalOpenLink(terminal.id)) : null,
      update: () => void install.update(),
    },
    words,
  );
  return (
    <ProviderCard
      words={words.card}
      engine={engine}
      view={view}
      checking={checking}
      connected={ready && !install.installing}
      problem={error ?? terminalError ?? install.problem}
    >
      {terminal && <SignInTerminal session={terminal} onError={setTerminalError} />}
    </ProviderCard>
  );
}
