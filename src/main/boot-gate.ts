/**
 * Where startup stands, for the window. Normally the core starts and the gate stays Ready. When
 * the process sandbox cannot start, main holds the gate on the setup screen with the problem and
 * the step that re-runs core startup; Retry runs that step once (presses while it runs share it)
 * and the gate opens, or shows the problem the new attempt found. Any other failure is the
 * caller's: it rejects and leaves the setup state as it was.
 *
 * On Windows the missing piece is a one-time install behind an administrator prompt, which Set up
 * runs (`installSandbox`); once installed it retries, and a dismissed prompt changes nothing.
 */
import {
  BootPhase,
  type BootState,
  type SandboxProblem,
  SandboxProblemCode,
  SandboxSetupOutcome,
  type SandboxSetupResult,
} from "../shared/boot.ts";
import { SandboxUnavailableError } from "../substrate/sandbox-unavailable.ts";

/** What installing the sandbox answered: `cancelled` when the administrator prompt was dismissed. */
export interface SandboxInstall {
  cancelled: boolean;
}

export interface BootGateOptions {
  /** Install the Windows sandbox (one administrator prompt); throws when the install fails. */
  installSandbox?: () => Promise<SandboxInstall>;
  /** Told why a Set up failed (the install, or the startup after it), for the log. */
  setUpFailed?: (error: unknown) => void;
}

/** The boot state main answers `studio:boot` with, and the Retry behind `studio:boot.retry`. */
export interface BootGate {
  state(): BootState;
  /** Show the setup screen for `problem`; `attempt` re-runs startup and throws while the sandbox is still unavailable. */
  hold(problem: SandboxProblem, attempt: () => Promise<void>): void;
  /** Run the held attempt; the state after it. */
  retry(): Promise<BootState>;
  /** Install the sandbox, then retry; throws when there is nothing to set up or the install fails. */
  setUp(): Promise<SandboxSetupResult>;
}

const MESSAGE = {
  nothingToSetUp: "There is nothing to set up: the protected workspace is not waiting on an install.",
} as const;

/** What a Set up runs instead of the install once one has gone through this launch. */
const ALREADY_INSTALLED = async (): Promise<SandboxInstall> => ({ cancelled: false });

/** Held on the problem Set up fixes: a sandbox that has not been provisioned yet. */
function waitsOnInstall(state: BootState): boolean {
  return state.phase === BootPhase.SandboxSetup && state.sandbox?.code === SandboxProblemCode.NotProvisioned;
}

/** A gate for this launch's `platform`, starting Ready. */
export function createBootGate(platform: string, options: BootGateOptions = {}): BootGate {
  let state: BootState = { platform, phase: BootPhase.Ready, sandbox: null };
  let attempt: (() => Promise<void>) | null = null;
  let running: Promise<BootState> | null = null;
  let installing: Promise<SandboxSetupResult> | null = null;
  // The install went through but the startup after it failed: the sandbox is there, so the next
  // Set up only starts again, without another administrator prompt.
  let installed = false;

  const settle = async (run: () => Promise<void>): Promise<BootState> => {
    try {
      await run();
      attempt = null;
      state = { platform, phase: BootPhase.Ready, sandbox: null };
    } catch (error) {
      if (!(error instanceof SandboxUnavailableError)) throw error;
      state = { platform, phase: BootPhase.SandboxSetup, sandbox: error.problem };
    }
    return state;
  };

  const retry = (): Promise<BootState> => {
    if (!attempt) return Promise.resolve(state);
    running ??= settle(attempt).finally(() => {
      running = null;
    });
    return running;
  };

  const install = async (run: () => Promise<SandboxInstall>): Promise<SandboxSetupResult> => {
    const { cancelled } = await (installed ? ALREADY_INSTALLED : run)();
    if (cancelled) return { outcome: SandboxSetupOutcome.Cancelled, state };
    installed = true;
    const after = await retry();
    // Still waiting on its install after one: the next Set up installs again.
    installed = !waitsOnInstall(after);
    return { outcome: SandboxSetupOutcome.Installed, state: after };
  };

  // Set once Set up first runs: a window that loads again does not run it by itself again.
  let tried = false;
  return {
    state: () => (tried ? { ...state, setupTried: true } : state),
    hold(problem, next) {
      state = { platform, phase: BootPhase.SandboxSetup, sandbox: problem };
      attempt = next;
    },
    retry,
    setUp() {
      if (installing) return installing;
      const run = options.installSandbox;
      if (!run || !waitsOnInstall(state)) return Promise.reject(new Error(MESSAGE.nothingToSetUp));
      tried = true;
      installing = install(run)
        .catch((error: unknown) => {
          options.setUpFailed?.(error);
          throw error;
        })
        .finally(() => {
          installing = null;
        });
      return installing;
    },
  };
}
