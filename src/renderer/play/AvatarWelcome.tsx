/**
 * The first time a Genex account is signed in on this Mac, it meets its generated avatar: a beam
 * scans up over a wireframe sphere and builds it, then the mix it was made of (body, eyes, how block
 * eyes look, gear) and one Continue. The avatar is already the account's, in the app and on
 * genex.games; Settings is where it changes. Shown once per account; never over the welcome.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { GenexPromoState, storedGenexPromo } from "../genex-promo.ts";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import type { PlayMe } from "../../shared/play-people.ts";
import { AvatarMotion, GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";
import { usePeople } from "../state/hooks.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { AVATAR_WORDS } from "../words.ts";
import { mixOf } from "./avatar-mix.ts";

const WORDS = AVATAR_WORDS;
/** The avatar's stage, and where its body sits on it (`avatar-painter.ts`'s geometry with gear). */
const STAGE = 240;
const BODY = { cx: STAGE / 2, cy: STAGE * 0.55, r: STAGE * 0.4 } as const;
/** The wireframe's latitude rings: how far from the middle each sits, and how wide it is, as shares of the radius. */
const LATITUDES = [
  [0, 1],
  [-0.38, 0.88],
  [0.38, 0.88],
  [-0.7, 0.58],
  [0.7, 0.58],
] as const;
const LONGITUDES = [0.3, 0.66] as const;
/** How often a waiting welcome looks again whether the Genex promo card has settled. */
const PROMO_CHECK_MS = 2 * SECOND_MS;

/** Whether the Genex promo card is still out (connecting, or saying it connected): the welcome waits for it. */
function usePromoOut(active: boolean): boolean {
  const [out, setOut] = useState(() => storedGenexPromo() === GenexPromoState.Pending);
  useEffect(() => {
    if (!active || !out) return;
    const timer = window.setInterval(() => setOut(storedGenexPromo() === GenexPromoState.Pending), PROMO_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [active, out]);
  return out;
}

/** The sphere's wireframe the beam builds the avatar over. */
function Wireframe(): JSX.Element {
  const { cx, cy, r } = BODY;
  return (
    <svg className="avatar-welcome-wire" viewBox={`0 0 ${STAGE} ${STAGE}`} fill="none" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} />
      {LATITUDES.map(([at, width]) => (
        <ellipse key={at} cx={cx} cy={cy + at * r} rx={r * width} ry={r * width * 0.3} />
      ))}
      {LONGITUDES.map((width) => (
        <ellipse key={width} cx={cx} cy={cy} rx={r * width} ry={r} />
      ))}
    </svg>
  );
}

/** The dialog for an account meeting its avatar. */
function Welcome({ me, onDone }: { me: PlayMe; onDone: () => void }): JSX.Element {
  const recipe = useMemo(() => avatarRecipe(me.id, me.avatarVariant), [me.id, me.avatarVariant]);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <DialogSurface
      title={WORDS.welcomeTitle}
      headerHidden
      size="sm"
      testId="avatar-welcome"
      className="avatar-welcome"
      initialFocus={button}
      onDismiss={onDone}
    >
      <div className="avatar-welcome-body" data-avatar-welcome>
        <div className="avatar-welcome-stage">
          <Wireframe />
          <div className="avatar-welcome-built">
            <GeneratedAvatar recipe={recipe} size={STAGE} full={false} motion={AvatarMotion.Live} />
          </div>
          <span className="avatar-welcome-beam" aria-hidden="true" />
        </div>
        <div className="avatar-welcome-copy">
          <h2 className="avatar-welcome-title">{WORDS.welcomeTitle}</h2>
          <p className="avatar-welcome-text">{WORDS.welcomeText}</p>
        </div>
        <ul className="avatar-welcome-mix" aria-label={WORDS.mixLabel}>
          {mixOf(recipe).map((part) => (
            <li key={part}>{part}</li>
          ))}
        </ul>
        <button
          ref={button}
          type="button"
          className="people-button avatar-welcome-continue"
          data-tone="primary"
          data-avatar-welcome-continue
          onClick={onDone}
        >
          {WORDS.continue}
        </button>
        <span className="avatar-welcome-note">{WORDS.welcomeNote}</span>
      </div>
    </DialogSurface>
  );
}

/** Shows the welcome once for each account signed in on this Mac, when nothing else is in front. */
export function AvatarWelcome({ blocked }: { blocked: boolean }): JSX.Element | null {
  const me = usePeople((s) => s.me);
  const [done, setDone] = useState<string | null>(null);
  const promoOut = usePromoOut(me !== null && !blocked);
  if (!me || blocked || promoOut || done === me.id) return null;
  if (readText(storageKeyFor.avatarWelcomed(me.id)) === "1") return null;
  const finish = () => {
    writeText(storageKeyFor.avatarWelcomed(me.id), "1");
    setDone(me.id);
  };
  return <Welcome me={me} onDone={finish} />;
}
