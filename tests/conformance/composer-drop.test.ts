import { test } from "node:test";
import assert from "node:assert/strict";
import { addToBoard, DropTone, dropLine, heldFiles, leftOutLine } from "../../src/renderer/ui/composer-drop.ts";
import { MAX_REFERENCE_FRAMES } from "../../src/renderer/reference-frames.ts";

const file = (type: string) => ({ kind: "file", type });
const frame = (data: string) => ({ label: data, mimeType: "image/png", data });
const frames = (count: number, prefix = "f") => Array.from({ length: count }, (_, i) => frame(`${prefix}${i}`));

test("a drag holds files only when it carries some: pictures counted apart from the rest", () => {
  assert.equal(heldFiles(undefined), null);
  assert.equal(heldFiles([{ kind: "string", type: "text/plain" }]), null, "dragged text is not a file");
  assert.deepEqual(heldFiles([file("image/png"), file("image/jpeg"), file("application/zip"), file("")]), {
    pictures: 2,
    others: 2,
  });
});

test("the prompt bar's line while files are held: blue while pictures go in, orange when none can", () => {
  const cases = [
    { held: { pictures: 1, others: 0 }, attached: 0, tone: DropTone.Takes, words: "Drop to add 1 picture" },
    { held: { pictures: 2, others: 1 }, attached: 0, tone: DropTone.Takes, words: "Drop to add 2 pictures" },
    { held: { pictures: 0, others: 1 }, attached: 0, tone: DropTone.Refuses, words: "Only pictures can go in" },
    {
      held: { pictures: 14, others: 0 },
      attached: 0,
      tone: DropTone.Refuses,
      words: "Room for 12 pictures, 2 will stay out",
    },
    {
      held: { pictures: 3, others: 0 },
      attached: 11,
      tone: DropTone.Refuses,
      words: "Room for 1 picture, 2 will stay out",
    },
    {
      held: { pictures: 1, others: 0 },
      attached: MAX_REFERENCE_FRAMES,
      tone: DropTone.Refuses,
      words: "12 pictures at most",
    },
  ];
  for (const { held, attached, tone, words } of cases)
    assert.deepEqual(dropLine(held, attached), { tone, words }, JSON.stringify({ held, attached }));
});

test("a drop fills the board up to its limit, never twice with the same picture, and counts what stays out", () => {
  const current = frames(10);
  const added = addToBoard(current, [frame("f1"), ...frames(4, "new")], 3);
  assert.deepEqual(
    added.frames.map((f) => f.data),
    [...current.map((f) => f.data), "new0", "new1"],
  );
  assert.equal(added.overLimit, 2 + 3, "two read pictures past the limit, three files never read");
  assert.deepEqual(addToBoard([], frames(2)), { frames: frames(2), overLimit: 0 });
});

test("what a drop left out reads as one plain line, or nothing when everything went in", () => {
  assert.equal(leftOutLine({ notPictures: [], overLimit: 0 }), null);
  assert.equal(leftOutLine({ notPictures: ["notes.txt"], overLimit: 0 }), "notes.txt isn’t a picture");
  assert.equal(leftOutLine({ notPictures: ["a.zip", "b.pdf"], overLimit: 0 }), "2 files aren’t pictures");
  assert.equal(leftOutLine({ notPictures: [], overLimit: 2 }), "2 pictures left out, 12 at most");
  assert.equal(leftOutLine({ notPictures: ["a.zip"], overLimit: 2 }), "3 files didn’t go in");
});
