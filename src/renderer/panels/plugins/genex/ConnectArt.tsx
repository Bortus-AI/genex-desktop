/**
 * The Genex page's Connect band: the routed tools' logos float on its left and a thin line runs
 * from each into the band's action on the right, with light running along them toward it (faster
 * while Connect is pointed at, steady once connected). One canvas under the logos, 30 fps while
 * the band is on screen in a visible window someone is using (`watchRepaints`); one still frame
 * under Reduce Motion. The canvas' CSS colours (`.genex-connect-lines`) are read back and
 * refreshed on theme change.
 */
import { type FocusEvent, type JSX, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { Motion } from "../../../motion-rest.ts";
import { watchRepaints } from "../../../ui/art-repaints.ts";
import { DARK_SCHEME_QUERY, REDUCED_MOTION_QUERY } from "../../../ui/media-queries.ts";
import { toRgb } from "../../../ui/WireArt.tsx";
import {
  type ArtPoint,
  ConnectArtState,
  linePoint,
  PULSE_LENGTH,
  pulseHead,
  pulseSpeed,
  pulsesPerLine,
  STILL_TRAVEL,
  TOOL_SPOTS,
  travelAfter,
} from "./connect-art.ts";
import { markIsLight, ROUTED_TOOLS } from "./routed-tools.ts";

/** The lines move at most this many frames a second. */
const FRAME_MS = SECOND_MS / 30;
/** How often a running band measures its logos and action again (a resize, a new state's words). */
const MEASURE_EVERY_FRAMES = 15;
/** Steps a line or a pulse is drawn in. */
const LINE_STEPS = 24;
const PULSE_STEPS = 8;
/** How strongly a line shows over the band while it waits: the canvas reads its colour without alpha. */
const LINE_ALPHA = 0.16;
/** How far short of the action the lines stop, in CSS pixels. */
const TARGET_GAP = 6;
/** Stacked under the logos, how far in from the words' left edge the lines meet, in CSS pixels. */
const STACKED_INSET = 16;
/** How quickly the pulses speed up or settle when Connect is pointed at or left, per frame. */
const HEAT_EASE = 0.08;
/** What marks the band's action, which the lines run into. */
const TARGET = "[data-connect-target]";

type Rgb = [number, number, number];
type Lines = { from: ArtPoint[]; to: ArtPoint };
/** What the loop paints from: the state, how far Connect is pointed at (eased), and how far the light has run. */
type LoopInput = { state: ConnectArtState; heat: number; travel: number };

const rgba = ([r, g, b]: Rgb, alpha: number): string => `rgb(${r} ${g} ${b} / ${alpha})`;

/** The line's colour (`color`) and the light's (`outline-color`), as the theme sets them. */
function readColors(canvas: HTMLCanvasElement): { line: Rgb; flow: Rgb } {
  const style = getComputedStyle(canvas);
  return { line: toRgb(style.color), flow: toRgb(style.outlineColor) };
}

/**
 * Where each logo sits and where its line ends: beside the action when the band is two columns,
 * just above the words when they stack under the logos (a line never crosses them).
 */
function measure(band: HTMLElement): Lines {
  const box = band.getBoundingClientRect();
  const local = (x: number, y: number): ArtPoint => ({ x: x - box.left, y: y - box.top });
  const from = [...band.querySelectorAll<HTMLElement>("[data-connect-mark]")].map((mark) => {
    const rect = mark.getBoundingClientRect();
    return local(rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  const side = band.querySelector<HTMLElement>(".genex-connect-side");
  const first = side?.firstElementChild;
  if (!side || !first) return { from, to: { x: box.width, y: box.height / 2 } };
  const field = band.querySelector<HTMLElement>(".genex-connect-field")?.getBoundingClientRect();
  const words = first.getBoundingClientRect();
  if (field !== undefined && words.top >= field.bottom - 1)
    return { from, to: local(words.left + STACKED_INSET, words.top - TARGET_GAP) };
  const anchor = (side.querySelector<HTMLElement>(TARGET) ?? first).getBoundingClientRect();
  return { from, to: local(anchor.left - TARGET_GAP, anchor.top + anchor.height / 2) };
}

/** Traces the stretch of a line from `start` to `end` (0 at the logo, 1 at the action) in `steps` segments. */
function trace(ctx: CanvasRenderingContext2D, from: ArtPoint, to: ArtPoint, start: number, end: number, steps: number) {
  ctx.beginPath();
  for (let step = 0; step <= steps; step++) {
    const at = linePoint(from, to, start + ((end - start) * step) / steps);
    if (step === 0) ctx.moveTo(at.x, at.y);
    else ctx.lineTo(at.x, at.y);
  }
}

/** One frame: every line, then the light running along it. */
function paint(ctx: CanvasRenderingContext2D, lines: Lines, input: LoopInput, colors: { line: Rgb; flow: Rgb }) {
  const connected = input.state === ConnectArtState.Connected;
  const pulses = pulsesPerLine(input.state);
  const lit = connected || input.state === ConnectArtState.SigningIn;
  const line = connected ? rgba(colors.flow, 0.55) : rgba(colors.line, LINE_ALPHA);
  const light = rgba(colors.flow, lit ? 0.9 : 0.35 + input.heat * 0.6);
  ctx.lineCap = "round";
  for (const [index, from] of lines.from.entries()) {
    trace(ctx, from, lines.to, 0, 1, LINE_STEPS);
    ctx.lineWidth = 1;
    ctx.strokeStyle = line;
    ctx.stroke();
    for (let pulse = 0; pulse < pulses; pulse++) {
      const head = pulseHead(input.travel, index, pulse, pulses);
      trace(ctx, from, lines.to, Math.max(0, head - PULSE_LENGTH), head, PULSE_STEPS);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = light;
      ctx.stroke();
    }
  }
}

/** The paint loop: a frame every FRAME_MS while the band should move, one frame otherwise. Returns the stop. */
function startLoop(
  canvas: HTMLCanvasElement,
  band: HTMLElement,
  input: RefObject<LoopInput>,
  heat: RefObject<number>,
  redraw: RefObject<() => void>,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let last = performance.now();
  const reduced = matchMedia(REDUCED_MOTION_QUERY);
  const dark = matchMedia(DARK_SCHEME_QUERY);
  let colors = readColors(canvas);
  let lines: Lines = { from: [], to: { x: 0, y: 0 } };
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let frames = 0;
  const live = () =>
    visible &&
    !reduced.matches &&
    !document.hidden &&
    document.documentElement.dataset.motion !== Motion.Rest &&
    !canvas.closest("[inert]");
  const fit = () => {
    const box = band.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(box.width * ratio);
    const height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    lines = measure(band);
  };
  const draw = () => {
    if (frames++ % MEASURE_EVERY_FRAMES === 0) fit();
    const now = performance.now();
    const state = input.current;
    if (reduced.matches) {
      state.heat = 0;
      state.travel = STILL_TRAVEL;
    } else {
      state.heat += (heat.current - state.heat) * HEAT_EASE;
      state.travel = travelAfter(state.travel, pulseSpeed(state.state, state.heat), (now - last) / SECOND_MS);
    }
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paint(ctx, lines, state, colors);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const tick = () => {
    frame = 0;
    if (!live()) return;
    draw();
    timer = setTimeout(() => {
      frame = requestAnimationFrame(tick);
    }, FRAME_MS);
  };
  const schedule = () => {
    stop();
    frames = 0;
    draw();
    if (live()) tick();
  };
  redraw.current = schedule;
  // The band's size, and the words beside the logos: a new state's line or button moves the action.
  const resize = new ResizeObserver(schedule);
  resize.observe(band);
  const side = band.querySelector(".genex-connect-side");
  if (side) resize.observe(side);
  const unwatch = watchRepaints(
    canvas,
    {
      visible: (value) => {
        visible = value;
      },
      schedule,
      recolor: () => {
        colors = readColors(canvas);
        schedule();
      },
    },
    { reduced, dark },
  );
  schedule();
  return () => {
    stop();
    redraw.current = () => {};
    resize.disconnect();
    unwatch();
  };
}

/** Whether a pointer or focus event is on the band's action. */
const onTarget = (target: EventTarget | null): boolean => target instanceof Element && target.closest(TARGET) !== null;

/**
 * Keeps keyboard focus in the band when its words change under it: the action that had focus goes
 * with its state, so focus moves to the next state's action (or its words) instead of the page.
 */
function useKeptFocus(band: RefObject<HTMLElement | null>) {
  const inside = useRef(false);
  useLayoutEffect(() => {
    const root = band.current;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!root || !inside.current || !lost) return;
    const action = root.querySelector<HTMLElement>(`${TARGET}:enabled`);
    (action ?? root.querySelector<HTMLElement>(".genex-connect-side"))?.focus();
  });
  return {
    focused: () => {
      inside.current = true;
    },
    blurred: (event: FocusEvent<HTMLElement>) => {
      const left = event.target;
      // Focus settles after the blur; an action removed with its state keeps the band's claim.
      setTimeout(() => {
        if (left.isConnected) inside.current = band.current?.contains(document.activeElement) ?? false;
      });
    },
  };
}

/**
 * The band, with `children` (the state's words and actions) on its right. Mark the one action the
 * lines run into with `data-connect-target`; without one they run into the first line.
 */
export function ConnectBand({
  state,
  label,
  hooks,
  children,
}: {
  state: ConnectArtState;
  /** What the band is, for assistive tech; its changes are announced politely. */
  label: string;
  hooks?: Record<`data-${string}`, string>;
  children: ReactNode;
}): JSX.Element {
  const band = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<LoopInput>({ state, heat: 0, travel: 0 });
  input.current.state = state;
  // Where the pulses are heading: 1 while Connect is pointed at or focused.
  const heat = useRef(0);
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    if (!band.current || !canvas.current) return;
    return startLoop(canvas.current, band.current, input, heat, redraw);
  }, []);

  // A new state moves the action and changes the light: measure and paint it now, moving or still.
  // Its action is new too, so nothing is pointed at until the pointer or focus says so again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state is what repaints
  useEffect(() => {
    heat.current = 0;
    redraw.current();
  }, [state]);

  const warm = (on: boolean) => (event: { target: EventTarget | null }) => {
    if (onTarget(event.target)) heat.current = on ? 1 : 0;
  };
  const kept = useKeptFocus(band);
  return (
    <section
      ref={band}
      className="genex-connect"
      aria-label={label}
      aria-live="polite"
      data-art={state}
      onPointerOver={warm(true)}
      onPointerOut={warm(false)}
      onFocus={(event) => {
        warm(true)(event);
        kept.focused();
      }}
      onBlur={(event) => {
        warm(false)(event);
        kept.blurred(event);
      }}
      {...hooks}
    >
      <canvas ref={canvas} className="genex-connect-lines" aria-hidden="true" />
      <div className="genex-connect-grid">
        <div className="genex-connect-field" aria-hidden="true">
          {ROUTED_TOOLS.map(({ id, mark }) => (
            <img
              key={id}
              src={mark}
              alt=""
              draggable={false}
              data-connect-mark={id}
              data-light-mark={markIsLight(id) || undefined}
              style={{ left: `${TOOL_SPOTS[id].x * 100}%`, top: `${TOOL_SPOTS[id].y * 100}%` }}
            />
          ))}
        </div>
        <div className="genex-connect-side" tabIndex={-1}>
          {children}
        </div>
      </div>
    </section>
  );
}
