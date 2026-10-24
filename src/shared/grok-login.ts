/** Display-only state for Grok Build's device-code sign-in. The URL and the token stay in main. */
export interface GrokLoginState {
  revision: number;
  phase: "idle" | "starting" | "waiting" | "verifying" | "connected" | "failed" | "cancelled";
  lines: string[];
  hasBrowserUrl: boolean;
  /** The short code the CLI printed, when one was found. The page that opened asks for it. */
  deviceCode?: string;
  error?: string;
}

export function isGrokLoginActive(state: GrokLoginState): boolean {
  return state.phase === "starting" || state.phase === "waiting" || state.phase === "verifying";
}
