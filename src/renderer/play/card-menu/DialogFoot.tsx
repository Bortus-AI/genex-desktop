/**
 * The bottom of every card-menu dialog: what went wrong (one orange line), an underlined action on
 * the left when there is one, and Cancel beside the dialog's own button on the right.
 */
import type { JSX, ReactNode } from "react";
import { Button } from "../../ui/Button.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** The dialog's footer; `problem` replaces nothing, it sits above the buttons until the next try. */
export function DialogFoot({
  problem,
  aside,
  busy,
  onCancel,
  children,
}: {
  /** Why the last try failed; the dialog's own button then reads as Try again. */
  problem: string | null;
  /** An underlined action at the left edge (Remove from Featured). */
  aside?: ReactNode;
  busy: boolean;
  onCancel: () => void;
  /** The dialog's own button, when it can act. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="play-dialog-foot">
      {problem && (
        <p className="play-dialog-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="play-dialog-actions">
        {aside}
        <span className="flex-1" />
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {WORDS.cancel}
        </Button>
        {children}
      </div>
    </div>
  );
}

/** The label of a dialog's own button: `working` (Saving…) while it works, Try again after a failure, else `label`. */
export const actionLabel = (label: string, busy: boolean, failed: boolean, working: string = WORDS.saving): string => {
  if (busy) return working;
  return failed ? WORDS.tryAgain : label;
};
