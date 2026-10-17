/**
 * The window's first screen when the process sandbox cannot start: "Set up the protected
 * workspace". It says why agents need it, names what is missing with the exact commands that
 * install it (or, where AppArmor blocks the isolation, the command that allows it), and offers Retry, which re-runs core startup in main (`state/boot.ts`). On Windows,
 * where the missing piece is a one-time install, the window runs it by itself instead: "Setting up
 * Genex" over the installer's animation while Windows asks for approval, then the studio.
 * `BootRoot` chooses between these, the studio itself, and nothing while main has not answered yet.
 */
import { type JSX, useState } from "react";
import { type InstallCommand, type SandboxProblem, toolPackage } from "../shared/boot.ts";
import { App } from "./App.tsx";
import { useAppLoaderDismissal } from "./app-loader.ts";
import { type Boot, BootView, bootView, canSetUp, SetupReport } from "./state/boot.ts";
import { useBoot } from "./state/hooks.ts";
import { Button } from "./ui/Button.tsx";
import { SANDBOX_SETUP_WORDS as WORDS } from "./words.ts";

/** The studio, the setup screen, or nothing until main says which. */
export function BootRoot({ boot }: { boot: Boot }): JSX.Element | null {
  const view = useBoot(boot.store, bootView);
  const problem = useBoot(boot.store, (s) => s.problem);
  const retrying = useBoot(boot.store, (s) => s.retrying);
  const error = useBoot(boot.store, (s) => s.error);
  const installable = useBoot(boot.store, canSetUp);
  const settingUp = useBoot(boot.store, (s) => s.settingUp);
  const report = useBoot(boot.store, (s) => s.report);
  // The studio dismisses the startup loader once its own first screen is drawn; the setup screen is drawn now.
  useAppLoaderDismissal(view === BootView.SandboxSetup);
  if (view === BootView.Studio) return <App />;
  if (view === BootView.Loading || !problem) return null;
  if (installable) {
    return (
      <WindowsSetup
        problem={problem}
        settingUp={settingUp}
        error={error}
        report={report}
        onSetUp={() => void boot.setUp()}
        onReport={() => void boot.report()}
      />
    );
  }
  return <SandboxSetup problem={problem} retrying={retrying} error={error} onRetry={() => void boot.retry()} />;
}

/** What the Windows card says: working through Set up, waiting for an OK it did not get, or failed. */
const WindowsStep = {
  SettingUp: "setting-up",
  NeedsOk: "needs-ok",
  Failed: "failed",
} as const;
type WindowsStep = (typeof WindowsStep)[keyof typeof WindowsStep];

/** The card's title and line for each step. */
const WINDOWS_CARD = {
  [WindowsStep.SettingUp]: WORDS.windows.settingUp,
  [WindowsStep.NeedsOk]: WORDS.windows.needsOk,
  [WindowsStep.Failed]: WORDS.windows.failed,
} satisfies Record<WindowsStep, { title: string; line: string }>;

/** The installer's animation (forge's Squirrel `loadingGif`), so setup looks like the installer's next moment. */
const INSTALLING_ANIMATION = { backgroundImage: "url(media/installing.gif)" } as const;

function windowsStep(settingUp: boolean, error: string | null): WindowsStep {
  if (settingUp) return WindowsStep.SettingUp;
  return error === null ? WindowsStep.NeedsOk : WindowsStep.Failed;
}

/**
 * Windows' first start: the installer's ripple animation fills the window and a card at the bottom
 * left says what is happening. Set up starts by itself (`Boot.start`), so the card first waits on
 * Windows' approval prompt; a declined prompt asks again with Set up, and a failure offers Try
 * again, a report to the team and the raw error under Details.
 */
export function WindowsSetup({
  problem,
  settingUp,
  error,
  report,
  onSetUp,
  onReport,
}: {
  problem: SandboxProblem;
  settingUp: boolean;
  error: string | null;
  report: SetupReport;
  onSetUp: () => void;
  onReport: () => void;
}): JSX.Element {
  const step = windowsStep(settingUp, error);
  const words = WINDOWS_CARD[step];
  return (
    <div
      data-sandbox-setup={problem.code}
      data-windows-setup={step}
      style={INSTALLING_ANIMATION}
      className="relative h-full overflow-hidden bg-canvas bg-cover bg-center [image-rendering:pixelated]"
    >
      {/* The window has no title bar of its own: the top strip moves it, as the headers do. */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />
      <section
        aria-labelledby="windows-setup-title"
        aria-live="polite"
        className="absolute right-6 bottom-8 left-6 flex max-w-[360px] flex-col gap-2 rounded-[14px] bg-surface px-5 py-[18px] shadow-raised [image-rendering:auto]"
      >
        <h1 id="windows-setup-title" className="text-lg font-medium text-ink">
          {words.title}
        </h1>
        <p className={step === WindowsStep.Failed ? "text-orange" : "text-ink-2"}>{words.line}</p>
        {step === WindowsStep.SettingUp && (
          <p className="flex items-center gap-2 font-mono text-sm text-ink-3">
            <span className="size-[7px] rounded-full bg-accent-primary animate-[records-pulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none" />
            {WORDS.windows.settingUp.step}
          </p>
        )}
        {step === WindowsStep.NeedsOk && (
          <div className="pt-2">
            <Button variant="default" data-sandbox-set-up onClick={onSetUp}>
              {WORDS.windows.needsOk.setUp}
            </Button>
          </div>
        )}
        {step === WindowsStep.Failed && error !== null && (
          <SetupFailed error={error} report={report} onSetUp={onSetUp} onReport={onReport} />
        )}
      </section>
    </div>
  );
}

/** A failed Set up's actions: Try again, the report (sent, it is a bare ✓), and the raw error. */
function SetupFailed({
  error,
  report,
  onSetUp,
  onReport,
}: {
  error: string;
  report: SetupReport;
  onSetUp: () => void;
  onReport: () => void;
}): JSX.Element {
  const words = WORDS.windows.failed;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button variant="default" data-sandbox-set-up onClick={onSetUp}>
          {words.tryAgain}
        </Button>
        {report === SetupReport.Sent ? (
          <span data-setup-report={report} className="px-2 text-sm text-ink">
            {words.sent}
          </span>
        ) : (
          <Button
            variant="secondary"
            data-setup-report={report}
            aria-busy={report === SetupReport.Sending}
            disabled={report === SetupReport.Sending}
            onClick={onReport}
          >
            {report === SetupReport.Sending ? words.sending : words.report}
          </Button>
        )}
      </div>
      {report === SetupReport.Failed && <p className="text-sm text-orange">{words.reportFailed}</p>}
      <details className="settings-disclosure text-sm text-ink-3">
        <summary>{WORDS.details}</summary>
        <pre className="mt-2 max-h-24 overflow-auto font-mono text-micro whitespace-pre-wrap break-words select-text">
          {error}
        </pre>
      </details>
    </>
  );
}

/** One command, with who it is for and a Copy button; `selector` names the row for the smoke runners. */
function CommandRow({
  system,
  command,
  selector,
}: {
  system: string;
  command: string;
  selector: Record<`data-${string}`, string>;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div {...selector} className="flex items-center gap-3 rounded-[var(--radius-control)] bg-field py-1.5 ps-3 pe-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-micro text-ink-3">{system}</div>
        <code className="block select-text break-all font-mono text-sm text-ink">{command}</code>
      </div>
      <Button aria-label={WORDS.copyCommand(system)} onClick={copy}>
        {copied ? WORDS.copied : WORDS.copy}
      </Button>
    </div>
  );
}

/** One install command, for the systems its package manager serves. */
function InstallCommandRow({ install }: { install: InstallCommand }): JSX.Element {
  return (
    <CommandRow
      system={WORDS.system[install.manager]}
      command={install.command}
      selector={{ "data-install-command": install.manager }}
    />
  );
}

export function SandboxSetup({
  problem,
  retrying,
  error,
  onRetry,
}: {
  problem: SandboxProblem;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div data-sandbox-setup={problem.code} className="relative flex h-full overflow-auto bg-canvas">
      {/* The window has no title bar of its own: the top strip moves it, as the headers do. */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />
      <section
        aria-labelledby="sandbox-setup-title"
        className="m-auto flex w-full max-w-[520px] flex-col gap-4 px-6 py-16"
      >
        <h1 id="sandbox-setup-title" className="text-lg font-medium text-ink">
          {WORDS.title}
        </h1>
        <p className="text-ink-2">{WORDS.intro}</p>
        <p className="text-ink-2">{WORDS.why[problem.code]}</p>
        {problem.missingTools.length > 0 && (
          <ul className="flex flex-wrap gap-2 font-mono text-sm text-ink">
            {problem.missingTools.map((tool) => (
              <li key={tool} className="rounded-[var(--radius-control)] bg-field px-2 py-0.5">
                {toolPackage(tool)}
              </li>
            ))}
          </ul>
        )}
        {problem.installCommands.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-3">{WORDS.installThenRetry}</p>
            {problem.installCommands.map((install) => (
              <InstallCommandRow key={install.manager} install={install} />
            ))}
          </div>
        )}
        {problem.allowCommand && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-3">{WORDS.allowThenReopen}</p>
            <CommandRow
              system={WORDS.allowFor}
              command={problem.allowCommand}
              selector={{ "data-allow-command": problem.code }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm break-words text-orange">
            {WORDS.stillFailing} {error}
          </p>
        )}
        <div>
          <Button variant="default" data-sandbox-retry aria-busy={retrying} disabled={retrying} onClick={onRetry}>
            {retrying ? WORDS.retrying : WORDS.retry}
          </Button>
        </div>
        {problem.details.length > 0 && (
          <details className="settings-disclosure text-sm text-ink-3">
            <summary>{WORDS.details}</summary>
            <pre className="mt-2 font-mono text-micro whitespace-pre-wrap break-words">
              {problem.details.join("\n")}
            </pre>
          </details>
        )}
      </section>
    </div>
  );
}
