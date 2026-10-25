import { EngineId } from "./providers.ts";

/** The external coding CLIs Studio can install and launch, in provider-table order. */
export const CODING_PROVIDERS = [EngineId.ClaudeCode, EngineId.Codex, EngineId.Grok] as const;
export type CodingProvider = (typeof CODING_PROVIDERS)[number];

export function isCodingProvider(value: unknown): value is CodingProvider {
  return typeof value === "string" && (CODING_PROVIDERS as readonly string[]).includes(value);
}
export interface CodingCliStatus {
  provider: CodingProvider;
  state: "ready" | "missing" | "invalid_path" | "missing_runtime" | "incompatible";
  selection: "automatic" | "manual";
  path?: string;
  version?: string;
  /**
   * Optional flags this CLI's `--help` listed. Absent when discovery did not record them.
   * An empty list means the probe ran and none of those flags were listed.
   */
  acceptedFlags?: string[];
  detail: string;
  guidanceUrl: string;
}

/** Where an external coding CLI stands (`CodingCliStatus.state`). Shown in Settings: never rename a value. */
export const CodingCliState = {
  Ready: "ready",
  Missing: "missing",
  InvalidPath: "invalid_path",
  MissingRuntime: "missing_runtime",
  Incompatible: "incompatible",
} as const satisfies Record<string, CodingCliStatus["state"]>;
export type CodingCliState = (typeof CodingCliState)[keyof typeof CodingCliState];
