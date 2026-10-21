/**
 * The stage strip makes room in steps instead of letting its first row run under the window's
 * controls: the views fold into one button, then the plugin buttons move to a second row, then
 * Sound and Full screen join them. Each step undoes only once the first row is as wide as it needed
 * to be before taking it (`nextFold`, which `useStripFold` feeds with the first row's widths).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldStep,
  nextFold,
  type StripFold,
  StripFoldStep,
  UNFOLDED,
} from "../../src/renderer/panels/stage/strip-fold.ts";

test("a first row that fits takes no step", () => {
  assert.equal(nextFold(UNFOLDED, { row: 600, room: 600 }), UNFOLDED);
  assert.equal(nextFold(UNFOLDED, { row: 320, room: 900 }), UNFOLDED);
  assert.equal(nextFold(UNFOLDED, { row: 600.6, room: 600 }), UNFOLDED, "a fraction past the room is rounding");
});

test("a first row that would overflow folds the views first, remembering how wide it needed to be", () => {
  const views = nextFold(UNFOLDED, { row: 721, room: 600 });
  assert.equal(foldStep(views), StripFoldStep.Views);
  assert.deepEqual(views.needed, [721]);
});

test("each further overflow takes the next step: the plugin buttons, then Sound and Full screen, to a second row", () => {
  const views = nextFold(UNFOLDED, { row: 721, room: 482 });
  const plugins = nextFold(views, { row: 576, room: 482 });
  assert.equal(foldStep(plugins), StripFoldStep.Plugins);
  const game = nextFold(plugins, { row: 288, room: 272 });
  assert.equal(foldStep(game), StripFoldStep.Game);
  assert.deepEqual(game.needed, [721, 576, 288]);
});

test("the last step stays when even its first row overflows", () => {
  const game = { step: 3, needed: [721, 576, 288] };
  assert.equal(nextFold(game, { row: 220, room: 200 }), game);
});

test("a step undoes only once the room is as wide as the first row needed before it", () => {
  const plugins = { step: 2, needed: [721, 576] };
  assert.equal(nextFold(plugins, { row: 300, room: 575 }), plugins, "one pixel short keeps the second row");
  const views = nextFold(plugins, { row: 300, room: 576 });
  assert.equal(foldStep(views), StripFoldStep.Views);
  assert.deepEqual(views.needed, [721]);
  assert.equal(nextFold(views, { row: 576, room: 720 }), views, "the views stay folded one pixel short");
  assert.equal(foldStep(nextFold(views, { row: 576, room: 721 })), StripFoldStep.Full);
});

test("a widening window undoes the steps one at a time, never past what fits", () => {
  let fold: StripFold = { step: 3, needed: [721, 576, 288] };
  const steps: StripFoldStep[] = [];
  for (let turn = 0; turn < 8; turn++) {
    const next = nextFold(fold, { row: 0, room: 600 });
    if (next === fold) break;
    fold = next;
    steps.push(foldStep(fold));
  }
  assert.deepEqual(steps, [StripFoldStep.Plugins, StripFoldStep.Views]);
});
