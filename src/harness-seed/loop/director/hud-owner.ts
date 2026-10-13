/**
 * Which part draws the HUD, and so answers for its layout (`HUD_LAYOUT_CHECKS`): a new module, so a
 * kept older workers.ts or screen-owner.ts never hides it from the other.
 */
import { runningScreenOwner, SCREEN_CRITIC, type ScreenSpec } from "../screen-owner.ts";

/** A part as the HUD rule reads it: its critic, whether it owns the entry, and the part it restarts. */
interface HudPart {
  critic: string | null;
  ownsMain: boolean;
  replaces: string | null;
}

/**
 * Does this part draw the HUD: it is the screen's owner (critic=screen), or a restart of the part
 * that owned it (screen-owner.ts `linkScreenOwner` makes it the owner), or, while no other running
 * part owns the screen, it owns the entry. Another part's HUD is never its coverage to answer for.
 */
export function drawsTheHud(
  part: HudPart,
  run: { running: ReadonlyArray<{ id: string; spec?: ScreenSpec | null }>; specs: readonly ScreenSpec[] },
): boolean {
  if (part.critic === SCREEN_CRITIC) return true;
  const restartsOwner = run.specs.some((spec) => spec.id === part.replaces && spec.ownsScreen === true);
  if (part.replaces && restartsOwner) return true;
  return !runningScreenOwner(run.running) && part.ownsMain;
}
