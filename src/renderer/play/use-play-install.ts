/**
 * Play's Install plugin, one path for each place that offers it: the sidebar's Genex card and the
 * guest card in a game's viewer. With Genex installed and on it connects the Genex account through
 * the plugin's own sign-in; otherwise it opens Plugins at Genex, to install it or switch it on.
 */
import { useEffect, useState } from "react";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { PromoAttempt } from "../genex-promo.ts";
import { IDLE_ATTEMPT, useGenexAccount, useSignIn } from "../panels/GenexPromo.tsx";
import { usePlay, usePlugins } from "../state/hooks.ts";
import { installAnswered } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { OPEN_PLUGINS_EVENT } from "../ui/ComposerAddMenu.tsx";
import { PlayInstall, playInstallAction } from "./play-model.ts";

/**
 * Install plugin for the Genex plugin as it is now, with the sign-in it started. `watching` keeps the
 * account read as it changes, for a card that shows where the sign-in stands.
 */
export function usePlayInstall(project: string | null, watching: boolean) {
  const plugin = usePlugins((s) => s.list.find((p) => p.manifest.id === GENEX_PLUGIN_ID));
  const installed = plugin ? { installed: !plugin.removed && !plugin.unlisted, enabled: plugin.enabled } : undefined;
  const connectable = playInstallAction(installed) === PlayInstall.Connect;
  const [attempt, setAttempt] = useState<PromoAttempt>(IDLE_ATTEMPT);
  const { account, read } = useGenexAccount(project, watching && connectable, attempt.started);
  const signIn = useSignIn(plugin, project, read, setAttempt);
  useEffect(() => {
    if (attempt.started && account === PluginAccountState.Authorizing && !attempt.sawSignIn)
      setAttempt((a) => ({ ...a, sawSignIn: true }));
  }, [attempt.started, attempt.sawSignIn, account]);
  const install = (): void => {
    if (connectable) void signIn.connect();
    else window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: GENEX_PLUGIN_ID } }));
  };
  return { installed, connectable, account, attempt, signIn, install };
}

/** Runs Install plugin once for each time a viewer's guest card asked for it (its viewer has closed by then). */
export function usePlayInstallAsked(): void {
  const asked = usePlay((s) => s.installAsked);
  const { install } = usePlayInstall(null, false);
  useEffect(() => {
    if (!asked) return;
    studio().play.setState(installAnswered, true);
    install();
  }, [asked, install]);
}
