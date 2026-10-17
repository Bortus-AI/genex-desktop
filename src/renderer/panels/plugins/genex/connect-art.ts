/**
 * The Genex page's Connect band art as data: where each routed tool's logo floats in the band, the
 * curve a line takes from a logo into the band's action, and how fast light runs along the lines
 * for each state. Pure: `ConnectArt.tsx` measures the band and paints these.
 */
import { GenexTool } from "../../../../shared/asset-making.ts";
import { GenexAccountKind } from "./genex-view.ts";

/** What the lines show: waiting for Connect, a sign-in in the browser, or connected. */
export const ConnectArtState = { Waiting: "waiting", SigningIn: "signing-in", Connected: "connected" } as const;
export type ConnectArtState = (typeof ConnectArtState)[keyof typeof ConnectArtState];

/** A point in the band, in CSS pixels from its top-left corner. */
export interface ArtPoint {
  x: number;
  y: number;
}

/**
 * Each tool's place in the logos' field, as fractions of its width and height: a loose cloud whose
 * lines fan into the action without two logos sharing a line.
 */
export const TOOL_SPOTS: Record<GenexTool, ArtPoint> = {
  [GenexTool.Tripo]: { x: 0.08, y: 0.3 },
  [GenexTool.Meshy]: { x: 0.2, y: 0.72 },
  [GenexTool.Uthana]: { x: 0.27, y: 0.2 },
  [GenexTool.GptImage]: { x: 0.38, y: 0.5 },
  [GenexTool.NanoBanana]: { x: 0.12, y: 0.55 },
  [GenexTool.MiniMax]: { x: 0.47, y: 0.18 },
  [GenexTool.Blender]: { x: 0.52, y: 0.8 },
  [GenexTool.ElevenLabs]: { x: 0.34, y: 0.86 },
  [GenexTool.Publishing]: { x: 0.6, y: 0.42 },
};

/** How much of a line one pulse of light covers, as a share of the line. */
export const PULSE_LENGTH = 0.16;
/** How far toward the action a line's bend sits, as a share of the height between them. */
const BEND = 0.1;
/** Lines a second, each state's pulses: slow while waiting (faster as Connect is pointed at), quick in the browser. */
const WAITING_SPEED = 0.06;
const HEATED_SPEED = 0.5;
const SIGNING_IN_SPEED = 0.45;
const CONNECTED_SPEED = 0.12;
/** Each line's own pace, from 0.82× to about 0.95× of the state's speed, and its starting phase. */
const PACE_BASE = 0.82;
const PACE_STRIDE = 37;
const PACE_STEPS = 9;
const PACE_STEP = 1 / 60;
const PHASE_STRIDE = 0.137;

/** The art's state for the account card's state; anything short of connected or signing in waits. */
export function connectArtState(kind: GenexAccountKind | null): ConnectArtState {
  if (kind === GenexAccountKind.Connected) return ConnectArtState.Connected;
  return kind === GenexAccountKind.SigningIn ? ConnectArtState.SigningIn : ConnectArtState.Waiting;
}

/** A point `t` (0 at the logo, 1 at the action) along the line from `from` to `to`. */
export function linePoint(from: ArtPoint, to: ArtPoint, t: number): ArtPoint {
  const bend = { x: (from.x + to.x) / 2, y: from.y + (to.y - from.y) * BEND };
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * bend.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * bend.y + t * t * to.y,
  };
}

/** How fast pulses run, in lines a second; `heat` (0 to 1) is how far Connect is pointed at. */
export function pulseSpeed(state: ConnectArtState, heat: number): number {
  if (state === ConnectArtState.SigningIn) return SIGNING_IN_SPEED;
  if (state === ConnectArtState.Connected) return CONNECTED_SPEED;
  return WAITING_SPEED + Math.min(1, Math.max(0, heat)) * HEATED_SPEED;
}

/** Pulses on each line: two once connected, so the lines read as steady; one otherwise. */
export const pulsesPerLine = (state: ConnectArtState): number => (state === ConnectArtState.Connected ? 2 : 1);

/**
 * Where a pulse's head is at `seconds`, from 0 to 1 along its line: each line runs at its own pace
 * and phase (by `index`), so the pulses never arrive together.
 */
export function pulseHead(seconds: number, speed: number, index: number, pulse: number, pulses: number): number {
  const pace = PACE_BASE + ((index * PACE_STRIDE) % PACE_STEPS) * PACE_STEP;
  const phase = (index * PHASE_STRIDE) % 1;
  const head = (seconds * speed * pace + phase + pulse / pulses) % 1;
  return head < 0 ? head + 1 : head;
}
