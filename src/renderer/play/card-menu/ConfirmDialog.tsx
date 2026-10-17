/**
 * Unpublish and Delete game, confirmed in one sentence each, with the game's own name in the
 * title. Unpublish is undone by publishing again; Delete is not, so its button is the red one.
 */
import type { JSX } from "react";
import { PlayCardAction, PlayChangeKind } from "../../../shared/play-manage.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** Confirm taking a game off Play: unpublishing it, or deleting it for good. */
export function ConfirmDialog({
  action,
  game,
  onClose,
  returnFocus,
}: CardDialogProps & { action: typeof PlayCardAction.Unpublish | typeof PlayCardAction.Delete }): JSX.Element {
  const remove = action === PlayCardAction.Delete;
  const words = remove ? WORDS.remove : WORDS.unpublish;
  const save = useChange(game, onClose, words.failed);
  const confirm = () =>
    void save.run({ kind: remove ? PlayChangeKind.Delete : PlayChangeKind.Unpublish }, () => words.done(game.title));
  return (
    <DialogSurface
      title={words.title(game.title)}
      description={words.body}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!save.busy}
    >
      <DialogFoot problem={save.problem} busy={save.busy} onCancel={onClose}>
        <Button
          variant={remove ? "destructive" : "play-fill"}
          disabled={save.busy}
          onClick={confirm}
          data-play-dialog-save
        >
          {actionLabel(words.confirm, save.busy, save.failed, words.working)}
        </Button>
      </DialogFoot>
    </DialogSurface>
  );
}
