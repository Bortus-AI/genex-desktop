/**
 * The stage strip makes room in steps, never by hiding a control. Its first row holds the views,
 * Play/Stop, Reload, Sound and Full screen, then the plugin buttons (a plugin's, Make multiplayer,
 * Publish) at its end, always with their names. When that row would overflow, the views fold into
 * one button that names the current one; when it still would, the plugin buttons move to a second
 * row; and when even that is not enough, Sound and Full screen join them there. A step undoes only
 * once the first row is as wide as it needed to be before taking it. `nextFold` is the rule,
 * `useStripFold` feeds it the first row's widths, and theme.css lays each step out (`data-fold`).
 */
import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/** The strip's steps, in the order it takes them (`data-fold` on the strip). */
export const StripFoldStep = {
  /** Everything on one row, each view a tab of its own. */
  Full: "full",
  /** The views folded into one button that names the current one. */
  Views: "views",
  /** The plugin buttons on a second row. */
  Plugins: "plugins",
  /** Sound and Full screen on the second row too. */
  Game: "game",
} as const;
export type StripFoldStep = (typeof StripFoldStep)[keyof typeof StripFoldStep];

const STEPS: readonly StripFoldStep[] = [
  StripFoldStep.Full,
  StripFoldStep.Views,
  StripFoldStep.Plugins,
  StripFoldStep.Game,
];

/** A first row this much past its room is rounding, not overflow: the free space between its ends is a fraction. */
const ROUNDING_PX = 1;

/** The first row's height in px (`h-12` less its border): a group whose top is below it sits on the second row. */
const FIRST_ROW_PX = 47;

/** How far the strip has folded, and how wide its first row needed to be before each step taken. */
export type StripFold = { step: number; needed: readonly number[] };

/** Nothing folded. */
export const UNFOLDED: StripFold = { step: 0, needed: [] };

/** The step a fold is at. */
export const foldStep = (fold: StripFold): StripFoldStep => STEPS[fold.step] ?? StripFoldStep.Full;

/** The first row's widths: how far its controls reach (`row`) and how much it may take (`room`). */
export type StripWidths = { row: number; room: number };

/**
 * The fold after a measure: one step further once the first row overflows (remembering how wide it
 * needed to be), one step back once the room is as wide as the row needed before the last step.
 */
export function nextFold(fold: StripFold, { row, room }: StripWidths): StripFold {
  if (row - room >= ROUNDING_PX) {
    if (fold.step >= STEPS.length - 1) return fold;
    return { step: fold.step + 1, needed: [...fold.needed, row] };
  }
  const needed = fold.needed.at(-1);
  if (needed === undefined || room < needed) return fold;
  return { step: fold.step - 1, needed: fold.needed.slice(0, -1) };
}

/** How far the first row's groups reach from its start, and how wide it may be. */
function firstRow(strip: HTMLElement, groups: readonly HTMLElement[]): StripWidths {
  const style = getComputedStyle(strip);
  const padStart = Number.parseFloat(style.paddingInlineStart) || 0;
  const padEnd = Number.parseFloat(style.paddingInlineEnd) || 0;
  const box = strip.getBoundingClientRect();
  const start = box.left + strip.clientLeft + padStart;
  // A group squeezed narrower than its controls still reaches as far as they do (`scrollWidth`).
  const reach = groups
    .map((group) => ({ rect: group.getBoundingClientRect(), width: group.scrollWidth }))
    .filter(({ rect }) => rect.top - box.top < FIRST_ROW_PX)
    .map(({ rect, width }) => Math.max(rect.right, rect.left + width) - start);
  return { row: Math.max(0, ...reach), room: strip.clientWidth - padStart - padEnd };
}

/**
 * The strip's step. One observer watches the strip (a window or pane resize) and the groups inside
 * it (a button coming or going, a label changing). A group that changed size on its own (not by a
 * step this hook took) measures afresh from the full row; otherwise only the room is compared. Each
 * step is drawn at once (`flushSync`) so the next measure sees it, so a resize settles in one frame,
 * and it lands one frame after the resize that called for it: stepping inside the observer resizes
 * the groups it watches in the same frame, which Chromium reports as a renderer error
 * ("ResizeObserver loop completed with undelivered notifications").
 */
export function useStripFold(
  strip: RefObject<HTMLElement | null>,
  groups: RefObject<HTMLElement | null>[],
): StripFoldStep {
  const [step, setStep] = useState<StripFoldStep>(StripFoldStep.Full);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable; their elements are read once mounted
  useLayoutEffect(() => {
    const row = strip.current;
    const parts = groups.map((group) => group.current).filter((part): part is HTMLElement => part !== null);
    if (!row) return;
    let fold = UNFOLDED;
    const widths = new Map<Element, number>();
    const apply = (next: StripFold) => {
      const moves = foldStep(next) !== foldStep(fold);
      fold = next;
      if (moves) flushSync(() => setStep(foldStep(next)));
    };
    // Each step changes the first row, so a resize may take or undo several; one per measure, at most both ways.
    const measure = () => {
      for (let turn = 0; turn < STEPS.length * 2; turn++) {
        const next = nextFold(fold, firstRow(row, parts));
        if (next === fold) return;
        apply(next);
      }
    };
    const remember = () => {
      for (const part of parts) widths.set(part, part.offsetWidth);
    };
    let frame = 0;
    let groupChanged = false;
    const trail: unknown[] = [];
    const settle = () => {
      const reset = groupChanged;
      if (groupChanged) apply(UNFOLDED);
      groupChanged = false;
      measure();
      remember();
      trail.push({ t: Math.round(performance.now()), reset, fold, widths: firstRow(row, parts), pad: getComputedStyle(row).paddingInlineEnd, parts: parts.map((p) => [p.offsetWidth, p.scrollWidth, Math.round(p.getBoundingClientRect().top)]) });
      row.dataset.foldDebug = JSON.stringify(trail.slice(-40));
    };
    const observer = new ResizeObserver((entries) => {
      // A group that changed on its own is kept until the frame settles, so a later resize can't drop it.
      groupChanged ||= entries.some(
        (entry) => entry.target !== row && widths.get(entry.target) !== (entry.target as HTMLElement).offsetWidth,
      );
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settle);
    });
    observer.observe(row);
    for (const part of parts) observer.observe(part);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return step;
}
