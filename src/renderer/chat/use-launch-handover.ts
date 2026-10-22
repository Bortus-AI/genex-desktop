/**
 * A game started from home sends its first message from its own chat, once that chat is open and
 * loaded: as if it had been typed there, so a plan to review, a Loop and pictures take the chat's
 * own routes. Until it can go, the message stays in the chat as the person's bubble, held: while
 * the models are still being read it waits, a signed-out subscription asks for its sign-in and
 * sends once it is back, and a send that failed offers Try again. It never vanishes.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { useLaunch } from "../state/hooks.ts";
import { LaunchPhase } from "../state/launch.ts";
import { studio } from "../state/studio.ts";
import type { ComposerExtras, PromptBarHandle } from "../ui/PromptBar.tsx";
import type { SendAnswered } from "./use-submit.ts";

/** Where a held first message stands. */
export const HeldState = {
  /** The models and sign-ins are still being read: it sends once they are. */
  Waiting: "waiting",
  /** The chosen subscription is signed out: it sends once the sign-in is back. */
  SignedOut: "signed_out",
  /** The send failed: Try again sends it once more. */
  Failed: "failed",
} as const;
export type HeldState = (typeof HeldState)[keyof typeof HeldState];

/** What the chat knows about whether a send can go now. */
export interface HandoverReadiness {
  /** The engines have been read at least once. */
  enginesRead: boolean;
  /** The chat has a model to send with (a pick, or the one it falls back to). */
  hasModel: boolean;
  /** The chosen subscription is signed out (or its CLI is missing): a send would start a sign-in. */
  needsSignIn: boolean;
}

/** What a held first message does next. */
export const HandoverStep = {
  Wait: "wait",
  SignIn: "sign_in",
  Send: "send",
  /** No model at all: the words go to the composer, which offers Connect AI model. */
  ToComposer: "to_composer",
} as const;
export type HandoverStep = (typeof HandoverStep)[keyof typeof HandoverStep];

/** The next step for a held message in `state`, given what the chat knows now. */
export function handoverStep(state: HeldState, ready: HandoverReadiness): HandoverStep {
  if (state === HeldState.Failed || !ready.enginesRead) return HandoverStep.Wait;
  if (!ready.hasModel) return HandoverStep.ToComposer;
  if (ready.needsSignIn) return HandoverStep.SignIn;
  return HandoverStep.Send;
}

/** The first message while it is held, as the chat draws it. */
export interface HeldFirstSend {
  text: string;
  frames?: ReferenceFrame[];
  state: HeldState;
}

interface Held extends HeldFirstSend {
  extras: ComposerExtras | undefined;
}

export interface LaunchHandover {
  held: HeldFirstSend | null;
  /** The held block's one action: Sign in again, or Try again. */
  act(): void;
}

export function useLaunchHandover({
  threadId,
  loading,
  send,
  composer,
  ready,
  signIn,
}: {
  threadId: string | undefined;
  loading: boolean;
  send: SendAnswered;
  composer: RefObject<PromptBarHandle | null>;
  ready: HandoverReadiness;
  signIn: () => Promise<void>;
}): LaunchHandover {
  const launch = useLaunch((s) => s.launch);
  const handing = useRef<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const latest = useRef({ send, composer, ready });
  latest.current = { send, composer, ready };

  // The launch's message becomes this chat's held message, and home fades onto it.
  useEffect(() => {
    const opened = launch?.phase === LaunchPhase.Opened && launch.threadId === threadId && !loading;
    if (!launch || !opened || handing.current === launch.id) return;
    handing.current = launch.id;
    const frames = launch.extras?.frames;
    setHeld({
      text: launch.text,
      ...(frames?.length ? { frames } : {}),
      extras: launch.extras,
      state: HeldState.Waiting,
    });
    studio().launchHanded(launch.id);
  }, [launch, threadId, loading]);

  // A thread switch leaves the held message with its own chat's launch, never with the next chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: forgets on a thread change only
  useEffect(() => setHeld(null), [threadId]);

  const step = held ? handoverStep(held.state, ready) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: acts when the step changes, with the held words then
  useEffect(() => {
    if (!held || !step) return;
    if (step === HandoverStep.SignIn) {
      if (held.state !== HeldState.SignedOut) setHeld({ ...held, state: HeldState.SignedOut });
      return;
    }
    if (step === HandoverStep.ToComposer) {
      setHeld(null);
      latest.current.composer.current?.compose(held.text);
      return;
    }
    if (step !== HandoverStep.Send) return;
    // The send's own bubble takes over from the held one while it goes.
    setHeld(null);
    latest.current
      .send(held.text, held.extras)
      .then((sent) => {
        if (sent) return;
        // Not sent, and not an error: a sign-in came first, or there was nothing to send with.
        if (latest.current.ready.needsSignIn) setHeld({ ...held, state: HeldState.SignedOut });
        else latest.current.composer.current?.compose(held.text);
      })
      .catch(() => setHeld({ ...held, state: HeldState.Failed }));
  }, [step]);

  const act = (): void => {
    if (!held) return;
    if (held.state === HeldState.Failed) setHeld({ ...held, state: HeldState.Waiting });
    else if (held.state === HeldState.SignedOut) void signIn().catch(() => {});
  };
  const shown = held ? { text: held.text, ...(held.frames ? { frames: held.frames } : {}), state: held.state } : null;
  return { held: shown, act };
}
