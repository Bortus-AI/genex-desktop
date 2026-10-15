// The toy engine does nothing: every tool answers which tool ran, for which project (its editor
// with nobody at it). Its play tools stand in for a play of up to three players, each with its own
// picture and state.

/** The smallest JPEG markers, base64, as a stand-in picture: start of image, then end of image. */
const SHOT = "/9j/2Q==";
const VIEW = { width: 1280, height: 720 };

/** A player's number from a call's arguments: player 1 when none is named. */
const playerOf = (args) => (typeof args?.player === "number" ? args.player : 1);

/** The toy play: how many players it opened, and what each one has held. */
function toyPlay() {
  let players = 0;
  const held = new Map();
  const tools = {
    "play-open": (args) => {
      const joined = players > 0;
      players = typeof args?.players === "number" ? Math.min(3, Math.max(1, args.players)) : 1;
      return { ...VIEW, joined, players };
    },
    "play-input": (args) => {
      const keys = String(args?.keys ?? "")
        .split(",")
        .filter(Boolean);
      held.set(playerOf(args), keys);
      return { held: keys, gameSeconds: Number(args?.seconds) || 0 };
    },
    "play-shot": () => ({ data: SHOT, mime: "image/jpeg", ...VIEW }),
    "play-state": (args) => ({ player: playerOf(args), players, held: held.get(playerOf(args)) ?? [] }),
    "play-pause": () => ({ refused: "unsupported", message: "The toy play cannot pause." }),
    "play-close": () => {
      const closed = players > 0;
      players = 0;
      held.clear();
      return { closed };
    },
  };
  return tools;
}

export async function activate() {
  const play = toyPlay();
  return {
    async tool(name, args, ctx) {
      if (Object.hasOwn(play, name)) return play[name](args);
      // Nobody uses the toy editor: its lock's person-first probe never waits on the person.
      if (name === "editor-state") return { tool: name, project: ctx.project, personActive: false };
      return { tool: name, project: ctx.project };
    },
  };
}
