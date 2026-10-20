/**
 * The Publish dialog's platforms (canvas board "Publish"): the web, Mac and Windows rows read from
 * the game folder, each with what its build runs on, when it was built and its size. An app not made
 * yet offers "Make with agent", which sends the ask through the game's chat at once and keeps the
 * dialog open, the row then saying it was asked; a built app genex.games does not take yet says
 * "Coming soon", and the line under the rows says its players get the web version. A web game with
 * no app shows none of this.
 */
import type { JSX } from "react";
import { useState } from "react";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import {
  listsPlatforms,
  makeAppAsk,
  PlatformEnd,
  type PlatformRow,
  platformRows,
  reachLine,
} from "./publish-platforms-view.ts";

const WORDS = PUBLISH_PLATFORM_WORDS;

/** Each platform's mark. */
const MARK: Readonly<Record<PublishTarget, IconName>> = {
  [PublishTarget.Web]: "globe",
  [PublishTarget.Mac]: "apple",
  [PublishTarget.Windows]: "windows",
};

/** The game folder's platforms, read once as the dialog opens; null until read or when unreadable. */
function usePublishPlatforms(project: string): PublishPlatform[] | null {
  const [platforms, setPlatforms] = useState<PublishPlatform[] | null>(null);
  useAsyncEffect(
    (alive) => {
      void window.studio
        .genexPublishPlatforms(project)
        .then((read) => {
          if (alive()) setPlatforms(read);
        })
        .catch(() => {});
      return undefined;
    },
    [project],
  );
  return platforms;
}

/** What a row offers at its end: "Coming soon", Make with agent, or that the agent was asked. */
function End({
  row,
  asked,
  onMake,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget) => void;
}): JSX.Element | null {
  if (row.end === PlatformEnd.Soon)
    return (
      <span className="genex-publish-platform-note" role="note" aria-label={WORDS.soonLabel(row.name)}>
        {WORDS.soon}
      </span>
    );
  if (row.end !== PlatformEnd.Make) return null;
  if (asked)
    return (
      <span className="genex-publish-platform-note" role="status" data-publish-platform-asked={row.target}>
        {WORDS.asked}
      </span>
    );
  return (
    <button
      type="button"
      className="genex-publish-platform-make"
      aria-label={WORDS.makeLabel(row.name)}
      data-publish-platform-make={row.target}
      onClick={() => onMake(row.target)}
    >
      {WORDS.make}
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

/** One platform: its mark, name and detail, then its size or what it offers. */
function Row({
  row,
  asked,
  onMake,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget) => void;
}): JSX.Element {
  return (
    <li className="genex-publish-platform" data-publish-platform={row.target} data-state={row.state}>
      <Icon name={MARK[row.target]} size={18} />
      <span className="genex-publish-platform-text">
        <span>{row.name}</span>
        <span className="genex-publish-platform-detail">{row.detail}</span>
      </span>
      {row.size && <span className="genex-publish-platform-size">{row.size}</span>}
      <End row={row} asked={asked} onMake={onMake} />
    </li>
  );
}

/**
 * The platform rows and who plays what, or nothing for a web game with no app. Read once while the
 * dialog is open: hidden while it celebrates, they are not read again after.
 */
export function PublishPlatforms({ project, shown }: { project: string; shown: boolean }): JSX.Element | null {
  const engineGame = useLibrary((s) => Boolean(s.games.find((g) => g.name === project)?.engine));
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const platforms = usePublishPlatforms(project);
  const [asked, setAsked] = useState<ReadonlySet<PublishTarget>>(() => new Set());
  if (!shown || !platforms || !listsPlatforms(platforms, engineGame)) return null;
  const reach = reachLine(platforms);
  const make = (target: PublishTarget): void => {
    composeInChat({ project, text: makeAppAsk(target, title), send: true });
    setAsked((before) => new Set(before).add(target));
  };
  return (
    <div className="genex-publish-platforms" data-genex-publish-platforms>
      <ul aria-label={WORDS.label}>
        {platformRows(platforms, Date.now()).map((row) => (
          <Row key={row.target} row={row} asked={asked.has(row.target)} onMake={make} />
        ))}
      </ul>
      {reach && <p className="genex-publish-reach">{reach}</p>}
    </div>
  );
}
