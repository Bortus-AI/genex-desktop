# Projects and engines

## What a folder holds

A project is any folder, several kinds at once: a web game, an Unreal game or plugin, Godot, Unity,
Blender assets or a plugin's kind. These facts suggest; the first message or the person decides.
The sidebar names a non-game's kind (**Unreal plugin**, **Blender assets**).

New game makes an empty folder; the first message picks its kind. A vague ask builds a web game;
with an engine plugin on, a game with no kind asks which engine (Web, Unreal, Godot). A port
snapshots first, keeps the web files as reference and goes on in the new kind.

## Plugins on or off

Asked for an engine whose plugin is off, the chat shows its card (**Turn on** or **Install…**; a
cross hides it), which only your click acts on. On your word agents go on without it (as for
Unity): background jobs, `app_look` at its windows (never clicking), its docs, or a plugin they write.

A plugin loaded from a folder on this Mac starts off and runs with your access. Each tool asks
before it runs; Always allow lists it under **Runs without asking**, with **Ask every
time**. New code or turning it off clears those; its steps at Genex's moments never ask.

## Loops in place

Any folder but a web game at its root (Blender files beside it allowed): the chat's session leads
the Loop in place, on Claude Code, Codex or OpenCode (others refuse). The lead keeps save points,
starts workers (of its plugins' types, if any) and claims finish; a reviewer checks (three no's
stop it). Plugins add steps at Genex's moments, reviewer pictures and locks: while you work in a
plugin's editor, agents wait.

## Unreal

The lead works in the open editor through the Genex editor helper, one holder at a time; while you
play there the chat reads “Waiting for you to finish in Unreal” (a build waits 10 minutes). A
turn saves unsaved editor work. Rewind saves, closes and reopens Unreal; if it can't, files stay
and the chat says why. An **Unreal plugin** project hosts the plugin in `Plugins/`, where its tools
build, test headless and package it.

## Godot

It ships off and needs Godot 4.3+. Its button gets Godot, makes a **New Godot game** (2D or
3D, in `godot/`) and opens your editor. Agents never drive it (they check, run and shoot in a
sandbox); it saves before save points and reloads after Rewind.

## Live's views

Live shows the web preview, an engine's card (latest shot, its one step: **Open in Unreal**, **Set
up for Genex**, **Open in Godot**) or run pictures; only the preview has web controls. A web game
plus an engine project gets a tab each, the last chosen kept per game; a chat's web build brings
Web game forward.

## Where to work

[project-kind](../../src/renderer/project-kind.ts) labels the sidebar;
[live-views](../../src/renderer/live-views.ts) and
[stage-tabs](../../src/renderer/panels/stage/stage-tabs.ts) pick Live's views. Mechanisms:
[plugins](../plugins.md#project-facts),
[tool permissions](../tool-permissions.md#workers) and [harness runtime](../harness-runtime.md).
