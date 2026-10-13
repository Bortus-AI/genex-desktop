# Workspace and games

## What the user sees

The sidebar contains Search, Notifications, Send feedback
([what it sends](../../PRIVACY.md#send-feedback)), the Play/Create switch, New game, Plugins,
Harness, Settings, Games and, once updates wait, **Update plugins** and **Relaunch to update**
(Linux: **Download**); only games scroll. Pinned games lead, then recent activity. Every launch
opens **home** (also the wordmark): one composer over an optional picture. A
game opens its conversation beside the stage (Live, Builds once planned, Assets); Harness opens
its conversation and Activity; Plugins fills the workspace.

Settings (a modal): Model Providers, Local Models, Appearance, Games, Harness, Permissions,
Privacy, About. Narrow windows use a drawer; wide ones remember the sidebar.

The bell keeps questions, plans and permission requests until answered, then build endings and
sign-outs; a count marks waiting work, a dot news. Rows open where the answer lives; unfocused,
macOS notifications and the Dock badge carry them.

**Play** shows genex.games' shelves, **Recent**, tabs and search. Games play full window under a
header (held Esc): Like, Share, Invite a friend, Remix
([what Play sends](../../PRIVACY.md#play)), Exit and, in voice chat, a mic switch. Guests are
offered Genex.

## First launch

An empty, never-welcomed profile opens a full-window welcome that ends connecting Claude Code,
ChatGPT, a local model, OpenRouter or OpenCode; Skip or Start building opens home, keeping a typed
idea.

Then a Genex Tools card offers **Connect Genex plugin** once.

A sandbox that cannot start opens **Set up the protected workspace**: what's missing or blocked,
commands to copy, Retry.

## Main actions

- **Home's first message** starts a game the model names, where the chip says
  ([its kind](projects-engines.md)). Duplicates never overwrite; a greeting stays **Untitled game** until an idea. **New game**, Games **+** and Command-N open home.
- **Settings → Games** moves new games to another empty folder (default `~/AI Games`);
  **Settings → Privacy** holds opt-in build metrics ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before writing (Claude settings and hooks trusted unless
  switched off); only a web folder gets starter files.
- A game's menu offers Rename (same folder), Pin/Unpin, Change image and Delete (only the
  library entry; active work blocks it; reopening restores it).
- The chat header shows the title, Show in Finder, Terminal and ⋯ (Export game…, Rename, Clear
  Rewind history…, keeping save points, history and paused builds); not for Harness or unbound
  drafts. Search reaches older and unbound chats.
- Command-B toggles navigation, Command-K searches, Command-2 Harness, Command-1 the last chat.

## State and appearance

A game's folder owns its identity. Commits and checkpoints skip engine scratch (`Saved/`,
`.godot/`, Blender backups). Rollback snapshots first, refusing changed branches, commits or
merges. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. Unsent text survives loading; hidden workspaces ignore keys.

The live game is a native view outside React that overlays occlude; desktop captures can't prove it.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage, [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch.
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md); [Feature Map](../agent/feature-map.md).
