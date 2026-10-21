/** The stage strip, narrowed step by step in both themes: no control past the strip or under the window's own controls. */
import { app, BrowserWindow, desktopCapturer, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The window's widths, from the usual 1440 to the narrowest the studio allows (index.ts `MAIN_WINDOW`). */
const WIDTHS = [1440, 1320, 1200, 1080];
/** Short enough for a CI runner's 1024×768 screen, above the studio's 680 minimum. */
const HEIGHT = 700;
/** A rect this far past a bound is rounding, not overflow. */
const ROUNDING_PX = 0.5;
const SETTLE_MS = 400;

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("strip-out");
const main = arg("strip-main");
const profile = path.dirname(arg("studio-dev-launch"));
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [];
const steps = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wc;
const js = (code) => wc.executeJavaScript(code, true);
async function until(code) {
  for (let n = 0; n < 300; n++) {
    if (await js(code).catch(() => false)) return true;
    await wait(50);
  }
  return false;
}
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

const ready = `!!document.querySelector('[data-stage-strip] [data-stage-full-screen]')`;
/** The strip's step, its box, the title bar area the window's controls leave, and every visible control's box. */
const MEASURE = `(() => {
  const strip = document.querySelector('[data-stage-strip]');
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const overlay = navigator.windowControlsOverlay;
  const area = overlay && overlay.visible ? overlay.getTitlebarAreaRect() : null;
  const controls = [...strip.querySelectorAll('button')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), ...box(el) }));
  return {
    fold: strip.dataset.fold,
    strip: box(strip),
    titlebar: area && { left: area.x, right: area.x + area.width, bottom: area.y + area.height },
    window: window.innerWidth,
    controls,
  };
})()`;

/** Controls past the strip's sides or the window's edge. */
const outside = (m) =>
  m.controls.filter(
    (c) =>
      c.left < m.strip.left - ROUNDING_PX ||
      c.right > Math.min(m.strip.right, m.window) + ROUNDING_PX ||
      c.bottom > m.strip.bottom + ROUNDING_PX,
  );
/** First-row controls reaching under the window's own controls. */
const underControls = (m) =>
  m.titlebar ? m.controls.filter((c) => c.top < m.titlebar.bottom && c.right > m.titlebar.right + ROUNDING_PX) : [];

/** The window with its frame (its own controls included) where the system lets it be captured, else its page. */
async function photograph(win, name) {
  const [width, height] = win.getSize();
  const sources = await desktopCapturer
    .getSources({ types: ["window"], thumbnailSize: { width, height } })
    .catch(() => []);
  const own = sources.find((source) => source.id === win.getMediaSourceId());
  const framed = own && !own.thumbnail.isEmpty();
  const image = framed ? own.thumbnail : await wc.capturePage();
  fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  return framed ? "window" : "page";
}

await import(pathToFileURL(main).href);
async function acceptance() {
  try {
    for (let n = 0; n < 300 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    for (let n = 0; n < 300 && !BrowserWindow.getAllWindows().length; n++) await wait(100);
    const win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    win.setPosition(0, 0);
    // It opens at the narrowest width, as on a small screen, before it ever measures a strip.
    win.setContentSize(WIDTHS.at(-1), HEIGHT);
    win.show();
    const up = await until(ready);
    steps.push({ name: "start", ...(await js(MEASURE).catch(() => null)), size: win.getContentSize() });
    check("a game's strip is on the stage", up);
    if (!up) return;
    // Light narrows from the widest; dark widens from the narrowest, so each width is reached both ways.
    for (const [theme, widths] of [
      ["light", WIDTHS],
      ["dark", [...WIDTHS].reverse()],
    ]) {
      nativeTheme.themeSource = theme;
      for (const width of widths) {
        win.setContentSize(width, HEIGHT);
        await wait(SETTLE_MS);
        const measured = await js(MEASURE);
        const name = `${theme}-${width}`;
        const picture = await photograph(win, name);
        steps.push({ name, picture, ...measured });
        check(
          `${name} (${measured.fold}): every control inside the strip`,
          !outside(measured).length,
          outside(measured),
        );
        check(
          `${name} (${measured.fold}): no control under the window's own controls`,
          !underControls(measured).length,
          underControls(measured),
        );
      }
    }
    // Diagnostic only: how wide the window must grow before each step undoes.
    const growth = [];
    for (let width = 1440; width <= 2400; width += 40) {
      win.setContentSize(width, HEIGHT);
      await wait(SETTLE_MS);
      const measured = await js(MEASURE);
      growth.push({ width, fold: measured.fold, titlebar: measured.titlebar, window: measured.window });
    }
    steps.push({ name: "growth", growth });
    win.setContentSize(WIDTHS[0], HEIGHT);
    for (const width of WIDTHS) {
      const [light, dark] = ["light", "dark"].map(
        (theme) => steps.find((step) => step.name === `${theme}-${width}`)?.fold,
      );
      check(`${width}: the same step narrowing and widening (${light}, ${dark})`, light === dark, { light, dark });
    }
  } catch (error) {
    check("stage strip fit completed", false, String(error.stack));
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          profile: path.basename(profile),
          providers: "fixture",
          platform: process.platform,
          electron: process.versions.electron,
          checks,
          steps,
        },
        null,
        2,
      ),
    );
    app.quit();
  }
}
void acceptance();
