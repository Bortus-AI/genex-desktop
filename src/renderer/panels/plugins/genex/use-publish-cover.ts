/**
 * The Publish banner's cover: Studio takes one as the dialog opens when the game has none, the
 * arrows make one of the recent frames the kept one, and Another cover asks the game's chat for a
 * new one. That ask is kept on this Mac (`cover-asks.ts`), so the banner still says it is on its
 * way after the dialog closes into the chat and opens again, until the new frame arrives.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { GenexAction, type GenexCoverRecord, type GenexPublishState } from "../../../../shared/genex.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { runPluginAction } from "../../../plugin-actions.ts";
import { GENEX_WORDS } from "../../../words.ts";
import { type CoverAskMemory, CoverKind, readCoverAsks, settleCoverAsk, writeCoverAsks } from "./cover-asks.ts";
import { coverChoices, coverMaking, flipCover, needsCover } from "./genex-publish-view.ts";

const WORDS = GENEX_WORDS.publish;

/** Seconds since `startedAt` (an ISO time), ticking each second while there is one. */
export function useElapsed(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / SECOND_MS));
}

/**
 * The game's kept asks, settled against its cover record each time that is read, and a way to keep
 * new ones. The stored asks are read once per game.
 */
function useCoverAsks(
  project: string,
  record: GenexCoverRecord | undefined,
): [CoverAskMemory, (next: CoverAskMemory) => void] {
  const stored = useMemo(() => readCoverAsks(project), [project]);
  const [kept, setKept] = useState<{ project: string; memory: CoverAskMemory } | null>(null);
  const memory = kept?.project === project ? kept.memory : stored;
  const keep = useCallback(
    (next: CoverAskMemory) => {
      writeCoverAsks(project, next);
      setKept({ project, memory: next });
    },
    [project],
  );
  useEffect(() => {
    if (!record) return;
    const settled = settleCoverAsk(memory, record, Date.now());
    if (settled !== memory) keep(settled);
  }, [record, memory, keep]);
  return [memory, keep];
}

/** What the banner's cover controls read and do. */
export interface PublishCover {
  /** Studio is taking the game's first cover right now. */
  taking: boolean;
  /**
   * Another picture or clip was asked for and none has arrived yet: which, since when (ISO), and how
   * long this game's last one of that kind took (ms; undefined before one was timed).
   */
  making: { kind: CoverKind; since: string; took: number | undefined } | null;
  /** The recent frames and which is kept. */
  choices: { shas: string[]; index: number };
  /** Make the frame an arrow lands on the kept one. */
  flip: (step: 1 | -1) => void;
  /** Ask the game's chat for another picture or clip showing `want`; null while nobody there can make one. */
  ask: ((kind: CoverKind, want: string) => void) | null;
}

/** The cover controls for one game's Publish dialog; `refresh` re-reads its record. */
export function usePublishCover({
  plugin,
  project,
  state,
  refresh,
}: {
  plugin: PluginInfo;
  project: string;
  state: GenexPublishState | null;
  refresh: () => Promise<void>;
}): PublishCover {
  const [taking, setTaking] = useState(false);
  const [asks, keepAsks] = useCoverAsks(project, state?.cover);
  const tried = useRef(false);
  const kept = state?.cover?.shot?.sha256 ?? null;
  const clip = state?.cover?.clip?.sha256 ?? null;
  const wanted = state ? needsCover(state) : false;
  useEffect(() => {
    if (!wanted || tried.current || !project) return;
    // Once per opening: a game whose cover could not be taken is not asked again on every read.
    tried.current = true;
    setTaking(true);
    void runPluginAction({ plugin, name: GenexAction.CoverAuto, args: {}, project, review: () => {} })
      .catch(() => {})
      .finally(() => {
        setTaking(false);
        void refresh();
      });
  }, [wanted, plugin, project, refresh]);
  const asked = asks.ask;
  const making = coverMaking(asked, asked?.kind === CoverKind.Clip ? clip : kept, Date.now());
  const choices = coverChoices(state?.cover);
  const flip = useCallback(
    (step: 1 | -1) => {
      const sha256 = flipCover(choices, step);
      if (!sha256) return;
      void runPluginAction({ plugin, name: GenexAction.CoverPick, args: { sha256 }, project, review: () => {} })
        .catch(() => {})
        .finally(() => void refresh());
    },
    [choices, plugin, project, refresh],
  );
  const ask = (kind: CoverKind, want: string): void => {
    const text =
      kind === CoverKind.Clip ? WORDS.coverAnotherClipPrompt(want.trim()) : WORDS.coverAnotherPrompt(want.trim());
    composeInChat({ project, text, send: true });
    keepAsks({ ...asks, ask: { kind, from: kind === CoverKind.Clip ? clip : kept, at: Date.now() } });
  };
  return {
    taking,
    making:
      making && asked
        ? { kind: asked.kind, since: new Date(asked.at).toISOString(), took: asks.took[asked.kind] }
        : null,
    choices,
    flip,
    // A cover is the Genex plugin's to make: with it off, nobody in the chat can.
    ask: plugin.enabled ? ask : null,
  };
}
