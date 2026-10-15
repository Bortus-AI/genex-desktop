# Projects and engines

## What a folder holds

A project is any folder: a web game, an Unreal game or plugin, Godot, Unity, Blender assets or a
plugin's kind, several at once. These facts suggest; the first message or the person decides.
The sidebar names a non-game's kind (**Unreal plugin**, **Blender assets**).

New game makes an empty folder; the first message picks its kind. A vague ask builds a web game;
with an engine plugin on, a game with no kind asks which engine until picked. A port (an Unreal
game from a web folder) snapshots first, keeping the web files as reference; the chat continues in
the new kind.

## Plugins on or off

Engine buttons show only on their games. Asked for an engine whose plugin is off, the chat shows its
card (**Turn on** or **Install…**; a cross puts it away), which only your click acts on. On your
word agents continue without it, as for Godot: the lead and workers run its programs as background
jobs in the chat's mode, look at its windows with `app_look` (never clicking), read its docs, or
write you a plugin.

A plugin loaded from a folder on this Mac starts off and runs with your access. Each tool
asks before an agent runs it; Always allow lists that tool on its page under **Runs without
asking**, with **Ask every time**. New code or turning it off clears those; its steps at Genex's
moments never ask.

## Loops in place

Except for web games at the folder's root (Blender files beside them allowed), the chat leads the
Loop in place on Claude Code, Codex or OpenCode. It keeps save points, starts workers and claims
finish; a reviewer checks (three no's stop it). Plugins add reviewer pictures and editor locks:
while you use an editor, agents wait. Unity makes, sets up and opens the project; agents and judges
play through Pipeline, with Input System required for keyboard and mouse control.

## Unreal

The lead works in the open editor through Genex's editor helper, one holder at a time; while you
play there the chat reads “Waiting for you to finish in Unreal”. A turn snapshots editor work;
Rewind saves, closes and reopens Unreal. Agents and blind judges play it with keys and the
mouse. Mac games skip hardware ray tracing (it hung the GPU). An **Unreal plugin**
project is a host project with the plugin in `Plugins/`; its tools build, test and package it.

## Live's views

Live shows what the folder holds: the web preview, the Unreal card (setup step, latest shot,
**Open in Unreal**) or a run's pictures; only the preview has web controls. A web game plus Unreal
project gets **Web game** and **Unreal** tabs, the last chosen remembered per game; a web build
shown from the chat brings Web game forward.

## Where to work

[project-kind](../../src/renderer/project-kind.ts) labels the sidebar;
[live-views](../../src/renderer/live-views.ts) and
[stage-tabs](../../src/renderer/panels/stage/stage-tabs.ts) pick Live's views. Mechanisms:
[plugins](../plugins.md#project-facts),
[tool permissions](../tool-permissions.md#workers) and [harness runtime](../harness-runtime.md).
