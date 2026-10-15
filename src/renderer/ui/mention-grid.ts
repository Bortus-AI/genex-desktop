/**
 * Moving the @ picker's outline with the arrow keys: cards sit in a grid of `columns`, and the
 * plugin rows under them form one column. Pure, so it is tested without a window.
 */

/** The picker's shape: how many cards, how many rows after them, and the cards' columns. */
export interface MentionGridShape {
  cards: number;
  rows: number;
  columns: number;
}

/** The arrow keys the picker takes from the text box. */
export const GRID_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Where an arrow key moves the outline from `active`, clamped to the list; null for other keys. */
export function gridTarget(key: string, active: number, shape: MentionGridShape): number | null {
  const total = shape.cards + shape.rows;
  if (!GRID_KEYS.has(key) || total === 0) return null;
  const last = total - 1;
  const inCards = active < shape.cards;
  if (key === "ArrowLeft") return Math.max(0, active - 1);
  if (key === "ArrowRight") return Math.min(last, active + 1);
  if (key === "ArrowDown") {
    if (!inCards) return Math.min(last, active + 1);
    const below = active + shape.columns;
    if (below < shape.cards) return below;
    // From the last line of cards, down goes to the first row, or to the last card.
    return shape.rows > 0 ? shape.cards : Math.min(last, below);
  }
  if (!inCards) return active === shape.cards ? lastLineStart(shape) : active - 1;
  return active - shape.columns >= 0 ? active - shape.columns : active;
}

/** The first card of the cards' last line, where Up from the first row lands. */
function lastLineStart(shape: MentionGridShape): number {
  if (shape.cards === 0) return 0;
  return Math.floor((shape.cards - 1) / shape.columns) * shape.columns;
}
