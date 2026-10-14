/**
 * Top creators at the top of Play's Games: the same row as a profile's friends, each creator with
 * their games and the hours people played them over the last 30 days ("this month"), ranked by
 * `creatorScore`. Read once; while genex.games does not rank creators the row is not there.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { PLAY_WORDS } from "../words.ts";
import { PeopleCarousel, PersonTile } from "./PeopleCarousel.tsx";
import { formatCount } from "./play-model.ts";

const WORDS = PLAY_WORDS.creators;

/** Play's Top creators row; nothing while there is nobody to show. */
export function TopCreators(): JSX.Element | null {
  const creators = usePeople((s) => s.creators.list);
  useEffect(() => {
    void studio().people.loadCreators();
  }, []);
  if (!creators || creators.length === 0) return null;
  return (
    <PeopleCarousel title={WORDS.title} note={WORDS.period} label={WORDS.title} hook={{ "data-top-creators": "" }}>
      {creators.map((creator) => (
        <PersonTile
          key={creator.id}
          person={creator}
          sub={WORDS.line(creator.games, formatCount(Math.round(creator.hours)))}
        />
      ))}
    </PeopleCarousel>
  );
}
