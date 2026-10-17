/**
 * Paints every Pro nameplate on screen from one clock, at most 30 frames a second. A plate is one
 * canvas: its piece drawn on the GPU, or a 2D still where the GPU cannot draw. A plate moves while
 * it is on screen; out of sight, under a modal, while the app's motion rests, or under Reduce
 * Motion it holds one frame.
 */
import type { PlateRecipe } from "../../shared/plate-recipe.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { Motion } from "../motion-rest.ts";
import { REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import {
  drawPlates,
  type GpuPlateCanvas,
  gpuPlateCanvas,
  onPlateGpuLost,
  type PlateDraw,
  type PlateGpu,
  plateGpu,
  plateGpuPipeline,
  releasePlateCanvas,
} from "./plate-gpu.ts";
import { drawStillPlate } from "./plate-still.ts";

/** A frame at most this often: 30 a second. */
const FRAME_MS = SECOND_MS / 30;
/**
 * How long plates wait for the GPU before they draw in 2D. Longer than the avatars' wait: a cold
 * start (a new build, an empty shader cache) can take seconds to answer, a 2D still would hold for
 * the whole session, and until the answer the plate shows its own colour, which reads fine. A Mac
 * without WebGPU answers at once.
 */
const GPU_ANSWER_MS = 8 * SECOND_MS;
/** The moment a still plate shows, in seconds. */
const STILL_TIME = 6;
/** A frame's clock step at most, so a stall does not jump a plate ahead. */
const MAX_STEP_SECONDS = 0.2;
/** Pixels per point at most. */
const MAX_DENSITY = 2;

type Surface = { gpu: GpuPlateCanvas } | { ctx: CanvasRenderingContext2D } | null;

interface Entry {
  canvas: HTMLCanvasElement;
  recipe: PlateRecipe;
  /** The plate's own clock, in seconds. */
  t: number;
  visible: boolean;
  dirty: boolean;
  surface: Surface;
}

/** A plate on the painter. */
export interface PlateHandle {
  /** Show another plate (a new roll). */
  set(recipe: PlateRecipe): void;
  dispose(): void;
}

const entries = new Set<Entry>();
const byCanvas = new Map<Element, Entry>();
let frame = 0;
let lastFrame = 0;
/** The plate GPU: undefined until asked, then the GPU or null for 2D. */
let gpu: PlateGpu | null | undefined;
let asking = false;
let observer: IntersectionObserver | null = null;
let reduced = typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;

/** Ask for the GPU once; the frame waits for the answer, or draws in 2D if it never comes. */
function askGpu(): void {
  if (asking) return;
  asking = true;
  const late = setTimeout(() => {
    if (gpu !== undefined) return;
    gpu = null;
    wake();
  }, GPU_ANSWER_MS);
  void plateGpu()
    .catch(() => null)
    .then((answer) => {
      clearTimeout(late);
      if (gpu === undefined) gpu = answer;
      asking = false;
      wake();
    });
}

/** Whether the app's motion rests: the window idle or out of sight (`motion-rest.ts`). */
const resting = (): boolean => document.documentElement.dataset.motion === Motion.Rest;

/** Whether a plate's clock runs: on screen, nothing modal covers it, and motion is neither reduced nor resting. */
const moves = (entry: Entry): boolean => entry.visible && !reduced && !resting() && !entry.canvas.closest("[inert]");

/** Whether a plate paints this frame: on screen, and waiting to be drawn or moving. */
const isDue = (entry: Entry): boolean => entry.visible && (entry.dirty || moves(entry));

onPlateGpuLost(() => {
  gpu = undefined;
  for (const entry of entries)
    if (entry.surface && "gpu" in entry.surface) {
      entry.surface = null;
      entry.dirty = true;
    }
  wake();
});

/** The canvas sized to its box at this screen's density; returns its pixel size. */
function fit(canvas: HTMLCanvasElement): { width: number; height: number; density: number } {
  const density = Math.min(MAX_DENSITY, Math.max(1, globalThis.devicePixelRatio || 1));
  const width = Math.max(2, Math.round(canvas.clientWidth * density));
  const height = Math.max(2, Math.round(canvas.clientHeight * density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height, density };
}

/** The surface a plate draws on, made the first time it paints. */
function surfaceOf(entry: Entry, context: PlateGpu | null): Surface {
  if (entry.surface) return entry.surface;
  const made = context ? gpuPlateCanvas(context, entry.canvas) : null;
  if (made) entry.surface = { gpu: made };
  else {
    const ctx = entry.canvas.getContext("2d");
    entry.surface = ctx ? { ctx } : null;
  }
  return entry.surface;
}

/** Paint one plate: a still now, or its GPU draw for this frame's submission. */
function paint(entry: Entry, context: PlateGpu | null): PlateDraw | null {
  const size = fit(entry.canvas);
  const surface = surfaceOf(entry, context);
  if (!surface) return null;
  if ("ctx" in surface) {
    drawStillPlate(surface.ctx, entry.recipe, size.width, size.height);
    entry.dirty = false;
    return null;
  }
  if (!context) return null;
  const pipeline = plateGpuPipeline(context, entry.recipe.sceneIndex, wake);
  if (!pipeline) return null;
  entry.dirty = false;
  return { canvas: surface.gpu, pipeline, recipe: entry.recipe, seconds: entry.t, ...size };
}

/** One frame: move the clocks of plates that run, then paint the ones that are due. */
function tick(now: number): void {
  frame = 0;
  const due = [...entries].filter(isDue);
  if (!due.length) {
    lastFrame = 0;
    return;
  }
  frame = requestAnimationFrame(tick);
  if (gpu === undefined) {
    askGpu();
    return;
  }
  if (lastFrame && now - lastFrame < FRAME_MS) return;
  const step = lastFrame ? Math.min(MAX_STEP_SECONDS, (now - lastFrame) / SECOND_MS) : 0;
  lastFrame = now;
  for (const entry of due) if (moves(entry)) entry.t += step;
  const context = gpu;
  const draws = due.map((entry) => paint(entry, context)).filter((draw): draw is PlateDraw => draw !== null);
  if (context && draws.length) drawPlates(context, draws);
}

/** Start the clock if it sleeps. */
function wake(): void {
  if (!frame && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
}

/** The observer that tells the painter which plates are on screen; the first time, it also watches motion and modals. */
function visibility(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver((seen) => {
    for (const { target, isIntersecting } of seen) {
      const entry = byCanvas.get(target);
      if (entry) entry.visible = isIntersecting;
    }
    wake();
  });
  new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  new MutationObserver(wake).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  return observer;
}

if (typeof matchMedia === "function")
  matchMedia(REDUCED_MOTION_QUERY).addEventListener("change", (event) => {
    reduced = event.matches;
    wake();
  });

/** Put a plate on the painter: it paints when it comes into view. */
export function mountPlate(canvas: HTMLCanvasElement, recipe: PlateRecipe): PlateHandle {
  const entry: Entry = { canvas, recipe, t: STILL_TIME, visible: false, dirty: true, surface: null };
  entries.add(entry);
  byCanvas.set(canvas, entry);
  visibility().observe(canvas);
  return {
    set(next) {
      entry.recipe = next;
      entry.dirty = true;
      wake();
    },
    dispose() {
      entries.delete(entry);
      byCanvas.delete(canvas);
      observer?.unobserve(canvas);
      if (entry.surface && "gpu" in entry.surface) releasePlateCanvas(entry.surface.gpu);
    },
  };
}
