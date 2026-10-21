/**
 * The stage strip makes room in steps, never by hiding a control. Its first row holds the views,
 * Play/Stop, Reload, Sound and Full screen, then the plugin buttons (a plugin's, Make multiplayer,
 * Publish) at its end, always with their names. When that row would overflow, the views fold into
 * one button that names the current one; when it still would, the plugin buttons move to a second
 * row; and when even that is not enough, Sound and Full screen join them there. The step is always
 * the first one whose first row fits, however the strip reached its width: a strip that grows
 * starts again from one row. `nextFold` is the rule, `useStripFold` feeds it the first row's
 * widths, and theme.css lays each step out (`data-fold`).
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

/** Every step, in the order the strip takes them. */
export const STRIP_STEPS: readonly StripFoldStep[] = [
  StripFoldStep.Full,
  StripFoldStep.Views,
  StripFoldStep.Plugins,
  StripFoldStep.Game,
];

/** A first row this much past its room is rounding, not overflow: the free space between its ends is a fraction. */
const ROUNDING_PX = 1;

/** The first row's height in px (`h-12` less its border): a group whose top is below it sits on the second row. */
const FIRST_ROW_PX = 47;

/** The first row's widths: how far its controls reach (`row`) and how much it may take (`room`). */
export type StripWidths = { row: number; room: number };

/** The step after a measure: the next one while the first row overflows, the same one once it fits or none is left. */
export function nextFold(step: StripFoldStep, { row, room }: StripWidths): StripFoldStep {
  if (row - room < ROUNDING_PX) return step;
  return STRIP_STEPS[STRIP_STEPS.indexOf(step) + 1] ?? step;
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
 * The strip's step. One observer watches the strip (a window or pane resize, the room the window's
 * own controls leave) and the groups inside it (a button coming or going, a label changing). A
 * strip that narrowed only steps further; one that grew, or a group that changed size on its own
 * (not by a step this hook took), starts again from one row. Each step is drawn at once
 * (`flushSync`) so the next measure sees it, so a resize settles in one frame, and it lands one
 * frame after the resize that called for it: stepping inside the observer resizes the groups it
 * watches in the same frame, which Chromium reports as a renderer error ("ResizeObserver loop
 * completed with undelivered notifications").
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
    let current: StripFoldStep = StripFoldStep.Full;
    let room = Number.NEGATIVE_INFINITY;
    const widths = new Map<Element, number>();
    const apply = (next: StripFoldStep) => {
      if (next === current) return;
      current = next;
      flushSync(() => setStep(next));
    };
    // Each step changes the first row, so one measure may take several.
    const measure = () => {
      for (const _ of STRIP_STEPS) {
        const next = nextFold(current, firstRow(row, parts));
        if (next === current) return;
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
      const now = firstRow(row, parts).room;
      const reset = groupChanged || now > room;
      if (reset) apply(StripFoldStep.Full);
      groupChanged = false;
      room = now;
      const seen: unknown[] = [];
      for (const _ of STRIP_STEPS) {
        const w = firstRow(row, parts);
        seen.push([current, row.dataset.fold, Math.round(w.row), Math.round(w.room), getComputedStyle(row).paddingInlineEnd, getComputedStyle(document.documentElement).getPropertyValue("--window-controls-end"), window.innerWidth]);
        const next = nextFold(current, w);
        if (next === current) break;
        apply(next);
      }
      trail.push({ t: Math.round(performance.now()), reset, seen });
      row.dataset.foldDebug = JSON.stringify(trail.slice(-30));
      remember();
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
