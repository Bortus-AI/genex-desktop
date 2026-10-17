/**
 * The viewer's Comments: the comments of the game on screen, read, written and deleted for the bar's
 * layer, with the bar's count kept in step. They wait for the game's page facts, which carry its id
 * on genex.games; a game left before they answer gets no count from them.
 */
import type { PlayBarState } from "../../shared/play.ts";
import type { PlayComment, PlayCommentsPage } from "../../shared/play-comments.ts";
import type { PlayComments } from "./comments.ts";
import type { PlayWorld } from "./gallery.ts";

const MESSAGE = {
  NoGame: "No game is open",
} as const;

/** The session Comments acts in. */
interface CommentHolder {
  epoch: number;
  worldRead: Promise<PlayWorld | null>;
  state: PlayBarState;
}

/** What Comments needs of the viewer: the comments on genex.games, the session, and how to draw. */
export interface CommentsContext {
  deps: { comments: Pick<PlayComments, "list" | "post" | "remove"> };
  session(): CommentHolder | null;
  current(epoch: number): CommentHolder | null;
  draw(): void;
}

/** The viewer's Comments over `ctx`. */
export function viewerComments(ctx: CommentsContext) {
  /** The session asked about and its game's id, once the game's page facts are in. */
  const shownGame = async (): Promise<{ s: CommentHolder; id: string }> => {
    const s = ctx.session();
    if (!s) throw new Error(MESSAGE.NoGame);
    const world = await s.worldRead;
    if (!world || !ctx.current(s.epoch)) throw new Error(MESSAGE.NoGame);
    return { s, id: world.id };
  };
  /** The bar's count after a comment came or went, if it is still the game on screen. */
  const counted = (s: CommentHolder, change: number): void => {
    const count = s.state.comments;
    if (!ctx.current(s.epoch) || count === null) return;
    s.state = { ...s.state, comments: Math.max(0, count + change) };
    ctx.draw();
  };
  return {
    /** A page of the game's comments: the first, or the one after `cursor`. */
    comments: async (cursor: unknown): Promise<PlayCommentsPage> => {
      const { id } = await shownGame();
      return ctx.deps.comments.list(id, typeof cursor === "string" ? cursor : null);
    },
    /** Post a comment on the game as the Genex account. */
    comment: async (body: unknown): Promise<PlayComment> => {
      const { s, id } = await shownGame();
      const saved = await ctx.deps.comments.post(id, body);
      counted(s, 1);
      return saved;
    },
    /** Delete one of the account's comments on the game. */
    uncomment: async (commentId: unknown): Promise<void> => {
      const { s, id } = await shownGame();
      await ctx.deps.comments.remove(id, commentId);
      counted(s, -1);
    },
  };
}
