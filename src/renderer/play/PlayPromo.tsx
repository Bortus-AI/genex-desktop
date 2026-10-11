/**
 * Play's Genex card at the foot of the sidebar, for someone who cannot publish to Play yet: a short
 * film of a game going live on Play, three things the Genex plugin gives, Learn, and Install plugin,
 * which connects the Genex account (or opens Plugins when Genex is not installed or is off), the same
 * path as a game's guest card (`use-play-install.ts`). It goes for good once dismissed, and stays
 * away while Genex is connected.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { PLAY_ORIGIN } from "../../shared/play.ts";
import { PromoPhase, promoPhase } from "../genex-promo.ts";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { PLAY_WORDS } from "../words.ts";
import { dismissPlayPromo, playPromoDismissed, playPromoVisible } from "./play-model.ts";
import { usePlayInstall } from "./use-play-install.ts";

const WORDS = PLAY_WORDS.promo;
/** Where Learn goes: what the Genex plugin's tools are. */
const LEARN_URL = `${PLAY_ORIGIN.web}/tools`;
/** The film and its still, copied beside the renderer by the build (`design/play-publish-video/`). */
const FILM = "media/play-publish.mp4";
const FILM_POSTER = "media/play-publish-poster.jpg";
/** How long Learn says the link was copied, when the browser could not be opened. */
const COPIED_NOTE_MS = 2 * SECOND_MS;

const FEATURES: ReadonlyArray<[IconName, string]> = [
  ["globe", WORDS.publish],
  ["users", WORDS.multiplayer],
  ["box", WORDS.tools],
];

/** The film, still under Reduce Motion, and paused while the window is hidden or a game is being played over it. */
function Film(): JSX.Element {
  const still = useRef(prefersReducedMotion()).current;
  const video = useRef<HTMLVideoElement>(null);
  const playing = usePlay((s) => s.viewer !== null);
  useEffect(() => {
    const film = video.current;
    if (!film) return;
    const sync = () => {
      if (playing || document.visibilityState !== "visible") film.pause();
      else void film.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [playing]);
  return (
    <div className="genex-promo-media play-promo-media" aria-hidden="true">
      {still ? (
        <img src={FILM_POSTER} alt="" />
      ) : (
        <video
          ref={video}
          src={FILM}
          poster={FILM_POSTER}
          preload="auto"
          muted
          loop
          playsInline
          disablePictureInPicture
        />
      )}
    </div>
  );
}

/** Opens what the Genex plugin is in the browser; copies the address where the browser may not open. */
function Learn(): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const open = async (): Promise<void> => {
    try {
      await studio().api.openUrl(LEARN_URL);
    } catch {
      await navigator.clipboard.writeText(LEARN_URL).then(
        () => setCopied(true),
        () => undefined,
      );
    }
  };
  return (
    <button type="button" className="genex-promo-link" aria-label={WORDS.learnLabel} onClick={() => void open()}>
      {copied ? WORDS.linkCopied : WORDS.learn}
      {copied && <Icon name="check" size={14} />}
    </button>
  );
}

/** Learn and Install plugin (or Try again), or the browser wait with Cancel. */
function Footer({
  phase,
  busy,
  onInstall,
  onCancel,
}: {
  phase: PromoPhase;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
}): JSX.Element {
  if (phase === PromoPhase.Waiting)
    return (
      <div className="genex-promo-footer">
        <span className="genex-promo-status" role="status">
          <LoaderGrid />
          {WORDS.waiting}
        </span>
        <Button onClick={onCancel}>{WORDS.cancel}</Button>
      </div>
    );
  const failed = phase === PromoPhase.Failed;
  return (
    <div className="genex-promo-footer">
      <Learn />
      <Button variant="default" disabled={busy} title={failed ? WORDS.failed : undefined} onClick={onInstall}>
        {failed && <Icon name="reload" />}
        {failed ? WORDS.retry : WORDS.install}
      </Button>
    </div>
  );
}

/** The Genex card at the sidebar's foot in Play, or nothing once it has no reason to show. */
export function PlayPromo({ project }: { project: string | null }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => playPromoDismissed());
  const { installed, connectable, account, attempt, signIn, install } = usePlayInstall(project, !dismissed);
  // Until the account is read, a connected person's card would flash: it waits for the answer.
  const known = !connectable || account !== undefined;
  if (!known || !playPromoVisible({ dismissed, plugin: installed, account })) return null;
  const phase = connectable ? promoPhase(account, attempt) : PromoPhase.Offer;
  const dismiss = (): void => {
    dismissPlayPromo();
    setDismissed(true);
  };
  return (
    <aside
      className="play-promo"
      aria-label={WORDS.label}
      data-play-promo={phase}
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
    >
      <Film />
      <button type="button" className="genex-promo-close" aria-label={WORDS.dismiss} onClick={dismiss}>
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
      <div className="genex-promo-body">
        <p className="genex-promo-eyebrow">{WORDS.eyebrow}</p>
        <h2 className="genex-promo-title">{WORDS.title}</h2>
        <ul className="play-promo-features">
          {FEATURES.map(([icon, title]) => (
            <li key={title}>
              <Icon name={icon} size={18} className="play-promo-feature-icon" />
              <span>{title}</span>
            </li>
          ))}
        </ul>
      </div>
      <Footer phase={phase} busy={signIn.busy} onInstall={install} onCancel={() => void signIn.cancel()} />
    </aside>
  );
}
