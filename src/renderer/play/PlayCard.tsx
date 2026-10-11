/**
 * One game on the dashboard, as genex.games draws it: the 16:9 cover (pressing it plays), its
 * players now and its plays over the cover's corner, the title, who made it, and Remix when its
 * source is public. A card still on its way is the same shape with nothing in it.
 */
import type { JSX } from "react";
import { memo, useState } from "react";
import type { PlayGame } from "../../shared/play.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";
import { formatCount } from "./play-model.ts";

const WORDS = PLAY_WORDS;

/** Where a cover's picture stands. */
const CoverState = { Loading: "loading", Shown: "shown", Failed: "failed" } as const;
type CoverState = (typeof CoverState)[keyof typeof CoverState];

/** The cover: the picture fades in once decoded; a missing or broken one leaves the plain tile. */
function Cover({ src }: { src: string | null }): JSX.Element | null {
  const [state, setState] = useState<CoverState>(CoverState.Loading);
  if (!src || state === CoverState.Failed) return null;
  return (
    <img
      className="play-card-image"
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      data-shown={state === CoverState.Shown || undefined}
      onLoad={() => setState(CoverState.Shown)}
      onError={() => setState(CoverState.Failed)}
    />
  );
}

/** Players now (multiplayer games with someone in them) and plays so far. */
function Stats({ game }: { game: PlayGame }): JSX.Element {
  const online = game.online ?? 0;
  return (
    <span className="play-card-stats">
      {online > 0 && (
        <span className="play-card-online" aria-label={WORDS.online(online)}>
          <span className="play-card-dot" aria-hidden="true" />
          {formatCount(online)}
        </span>
      )}
      <span aria-label={WORDS.plays(formatCount(game.plays))}>
        <Icon name="play" size={12} className="play-card-play" />
        {formatCount(game.plays)}
      </span>
    </span>
  );
}

/** One game on the dashboard; pressing its cover plays it. */
export const PlayCard = memo(function PlayCard({
  game,
  remixing,
  onPlay,
  onRemix,
}: {
  game: PlayGame;
  remixing: boolean;
  onPlay: (game: PlayGame) => void;
  onRemix: (game: PlayGame) => void;
}): JSX.Element {
  return (
    <article className="play-card" data-play-game={game.slug}>
      <button
        type="button"
        className="play-card-cover"
        aria-label={WORDS.play(game.title)}
        onClick={() => onPlay(game)}
      >
        <Cover src={game.coverUrl} />
        <span className="play-card-shade" aria-hidden="true" />
        <Stats game={game} />
      </button>
      <div className="play-card-meta">
        <div className="min-w-0 flex-1">
          <h3 className="play-card-title" title={game.title}>
            {game.title}
          </h3>
          {game.author.name && <p className="play-card-author">{WORDS.by(game.author.name)}</p>}
        </div>
        {game.remixable && (
          <Button
            variant="secondary"
            className="play-card-remix"
            aria-label={WORDS.remixLabel(game.title)}
            disabled={remixing}
            onClick={() => onRemix(game)}
          >
            <Icon name="remix" size={14} />
            {remixing ? WORDS.remixing : WORDS.remix}
          </Button>
        )}
      </div>
    </article>
  );
});

/** A card still on its way: the cover's tile and the title's and author's lines, shimmering. */
export function PlayCardPlaceholder(): JSX.Element {
  return (
    <div className="play-card play-card-placeholder" aria-hidden="true">
      <span className="play-card-cover" />
      <span className="play-card-meta">
        <span className="play-bar play-bar-title" />
        <span className="play-bar play-bar-author" />
      </span>
    </div>
  );
}
