/**
 * The turn-it-on card a session showed in the chat for a Genex plugin (`plugins_suggest`): the
 * plugin, why the agent suggests it, and one button from the live plugin list (Turn on, Install…,
 * or On once it is). Built like the chat's question cards; only this click turns a plugin on.
 */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { usePlugins } from "../state/hooks.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { PLUGIN_SUGGESTION_WORDS } from "../words.ts";
import { Icon } from "../ui/icons.tsx";
import { PluginIcon } from "../ui/PluginIcon.tsx";
import {
  SuggestionState,
  suggestionFolders,
  suggestionLocalAccess,
  suggestionShown,
  suggestionState,
} from "./plugin-suggestion.ts";

/**
 * The card's one button, or the word On once the plugin is on. Turn on names, on hover, the folders
 * outside the game its programs may then write to.
 */
function SuggestionButton({ pluginId, onNotice }: { pluginId: string; onNotice: Notify }): JSX.Element {
  const state = usePlugins((s) => suggestionState(s.list, pluginId));
  const folders = usePlugins((s) => suggestionFolders(s.list, pluginId));
  const [busy, setBusy] = useState(false);
  if (state === SuggestionState.On)
    return <span className="text-chat-sub text-ink-3">{PLUGIN_SUGGESTION_WORDS.on}</span>;
  const press = () => {
    if (busy) return;
    setBusy(true);
    // Install asks the person to review the plugin first, in Genex's own dialog.
    const act =
      state === SuggestionState.TurnOn
        ? window.studio.pluginEnable(pluginId, true)
        : window.studio.pluginInstall(pluginId);
    void act.catch(notifyProblem(onNotice)).finally(() => setBusy(false));
  };
  return (
    // The chat's own cards' button, as their Send answer: one face for every card's main action.
    <button
      type="button"
      className="chat-question-submit"
      disabled={busy}
      onClick={press}
      {...(folders ? { title: folders } : {})}
    >
      {state === SuggestionState.TurnOn ? PLUGIN_SUGGESTION_WORDS.turnOn : PLUGIN_SUGGESTION_WORDS.install}
    </button>
  );
}

/** Cards the person closed, by entry: the transcript remounts rows as it scrolls, and a closed one stays closed. */
const closedCards = new Set<string>();

/**
 * A session's suggestion of a Genex plugin, in the transcript: the plugin, why the agent wants it,
 * Turn on (or Install…), and a cross that puts the card away. A plugin loaded from a folder on this
 * Mac also says it runs with your access.
 */
export function PluginSuggestionCard({
  entry,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.PluginSuggestion }>;
  onNotice: Notify;
}): JSX.Element | null {
  const { suggestion } = entry;
  const [closed, setClosed] = useState(() => closedCards.has(entry.id));
  // String reads: a selector answering a new object each time would never settle.
  const name = usePlugins((s) => suggestionShown(s.list, suggestion).name);
  const icon = usePlugins((s) => s.list.find((plugin) => plugin.manifest.id === suggestion.pluginId)?.iconUrl);
  const localAccess = usePlugins((s) => suggestionLocalAccess(s.list, suggestion.pluginId));
  if (closed) return null;
  const titleId = `plugin-suggestion-${entry.id}`;
  const close = () => {
    closedCards.add(entry.id);
    setClosed(true);
  };
  return (
    <section data-plugin-suggestion={suggestion.pluginId} aria-labelledby={titleId} className="chat-question">
      <div className="flex flex-col gap-1 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <PluginIcon name={name} src={icon} size="menu" />
          <h3 id={titleId} className="min-w-0 flex-1 truncate text-chat font-medium">
            {name}
          </h3>
          <button
            type="button"
            aria-label={PLUGIN_SUGGESTION_WORDS.close}
            onClick={close}
            className="-me-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-3 hover:bg-control-hover hover:text-control-text-hover"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        {suggestion.reason ? <p className="text-chat-sub text-ink-2">{suggestion.reason}</p> : null}
        {localAccess ? <p className="text-chat-sub text-ink-3">{localAccess}</p> : null}
        <div className="mt-1 flex justify-end">
          <SuggestionButton pluginId={suggestion.pluginId} onNotice={onNotice} />
        </div>
      </div>
    </section>
  );
}
