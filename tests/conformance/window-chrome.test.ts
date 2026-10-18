/**
 * The studio window's title bar by platform. macOS keeps its inset traffic lights, in line with the
 * headers; Windows and
 * Linux get a hidden title bar with the system's minimise, maximise and close drawn as an overlay
 * the height of the app's headers, so a frameless window never loses its controls. On Windows the
 * overlay paints no box of its own: what the window draws under the corner shows through it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TITLEBAR_HEIGHT, titleBarOverlay, windowChrome } from "../../src/main/window-chrome.ts";

const THEME = { color: "#fafafa", symbolColor: "#111111" };

describe("window chrome", () => {
  it("macOS keeps the inset traffic lights, centred on the headers' line, and no overlay", () => {
    const chrome = windowChrome("darwin");
    assert.equal(chrome.titleBarStyle, "hiddenInset");
    assert.ok("trafficLightPosition" in chrome, "the lights are placed, not left where AppKit puts them");
    // The lights are 14pt circles; their centre is half the header's height down.
    assert.equal(chrome.trafficLightPosition.y + 7, TITLEBAR_HEIGHT / 2);
    assert.equal(chrome.trafficLightPosition.x, 12, "as far from the left edge as AppKit's inset puts them");
    assert.ok(!("titleBarOverlay" in chrome));
  });

  for (const platform of ["win32", "linux"]) {
    it(`${platform} draws the window controls over a hidden title bar, as tall as the headers`, () => {
      const chrome = windowChrome(platform);
      assert.equal(chrome.titleBarStyle, "hidden");
      assert.ok(typeof chrome.titleBarOverlay === "object", "an overlay, not a bare flag");
      assert.equal(chrome.titleBarOverlay.height, TITLEBAR_HEIGHT);
      assert.match(chrome.titleBarOverlay.symbolColor ?? "", /^#[0-9a-f]{6}$/i);
    });
  }

  it("on Windows the controls' box is see-through, in the theme's hue, so Home's background runs under them", () => {
    assert.deepEqual(windowChrome("win32", THEME), {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "rgba(250, 250, 250, 0)", symbolColor: "#111111", height: TITLEBAR_HEIGHT },
    });
  });

  it("Linux fills the controls' box with the theme's canvas", () => {
    assert.deepEqual(windowChrome("linux", THEME), {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#fafafa", symbolColor: "#111111", height: TITLEBAR_HEIGHT },
    });
  });

  for (const platform of ["win32", "linux"]) {
    it(`${platform}: a theme change repaints the controls as the window first drew them`, () => {
      const dark = { color: "#0e0d0f", symbolColor: "#dee0e2" };
      const opened = windowChrome(platform, dark);
      assert.ok("titleBarOverlay" in opened);
      assert.deepEqual(titleBarOverlay(platform, dark), opened.titleBarOverlay);
    });
  }
});
