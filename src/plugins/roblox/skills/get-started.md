# Get Roblox Studio connected

Use this when the Roblox Studio tools are missing from this chat, when a call answers that Roblox
Studio isn't open for this game, or when the person asks to set Roblox up. It gets the game to a
working connection and stops there. Once the tools answer, go back to what the person asked for.

Adapted for Genex from the `roblox-get-started` skill in Roblox's roblox-studio-agent-plugin (MIT
licence, notice at the end). In Genex the **Roblox Studio** button in the toolbar does the setup;
you guide the person through it and keep helping meanwhile.

## Rules

- **The button sets things up, not you.** Its panel has four steps: Roblox Studio on this computer,
  the Genex helper added, Studio's MCP server on, and the place chosen for this game. Every step
  that changes the person's computer asks them first. Don't download or install Studio, copy
  plugins or edit Studio's settings files yourself with commands.
- **Never touch the person's sign-in.** Never ask for, read or type their Roblox password, and
  never read cookies, tokens or Studio's sign-in files. The person signs in to Studio themselves.
- **Ask whether they are signed in.** Ask "Are you signed in to Roblox Studio?" and believe the
  answer; don't try to check it.
- **Never close or force-quit Studio.** Unsaved work could be lost. Ask the person to quit it, or
  point them to the panel's Restart Studio, which lets Studio ask to save first.
- **Switches only Studio's window offers** are clicked by the panel's **Do it for me**, which asks
  the person first and uses Genex's computer control for that click only, or by the person
  following the click path the panel shows. Never drive Studio with the desktop tool for anything
  else.
- **Plain asks, once.** Tell the person in one short list what is missing and which button does
  it. Ask again only for something that wasn't on the list.
- If a step fails, say which step and what you saw, then check the table below.

## 1. Read the button

The Roblox Studio button shows Studio's state; its panel shows each step with a tick.

| The button says | What it means | What the person does |
| --- | --- | --- |
| Not installed | Studio isn't on this computer | Open the panel and press Get Roblox Studio. Genex downloads it from Roblox, checks Roblox signed it, and installs it |
| Set up | Studio is there; the helper or the MCP server isn't | Open the panel and press Set up (best with Studio closed) |
| Not open | Everything is set up; Studio isn't running | Open the panel and open this game's place |
| Starting | Studio is open; Genex is waiting for it to answer | Wait a moment; open a place if none is open |
| Ready | Studio is open and answering | Nothing; the tools work |

If the person can't find the button, it sits in the toolbar above the game and reads "Roblox
Studio". The Roblox Studio plugin must be turned on in Plugins first; it is off until the person
turns it on.

## 2. Sign in

The first time, Studio asks the person to sign in. That is their step alone. Right after the first
sign-in, Studio may close by itself; that is expected: open it again from the panel.

## 3. The MCP server switch

Genex turns Studio's MCP server on during Set up while Studio is closed. If Studio was open, or the
switch is still off, the panel offers Do it for me, Restart Studio, and the click path:

**Assistant** (the toolbar icon at the top right of Studio, shown only with a place open) › **⋯** ›
**Settings** › **MCP Servers** › turn on **Enable Studio as MCP server**.

The switch is kept per Roblox account: after signing in with another account it may need turning on
again.

## 4. The place

Each game in Genex uses one place, chosen in the panel: a new Roblox game, a place file, or a place
already open in Studio. When several Studios are open, ask the person which place they mean by its
name before changing anything; Genex then keeps this game's calls to that place. A game with no
place yet gets one from `new-game` (a Baseplate in the game's folder, opened in Studio); `use-project`
switches to a place the person names, open in Studio or by its file. A place builds in one game
only: one another game uses is refused.

## 5. Check

Call a read tool of the Roblox Studio connection (`get_studio_state` or `search_game_tree`). An
answer means you are connected: say so in one line and get on with the request. Studio also has
its own guides behind its `skill` tool (debugging, the device emulator, its documentation); read
them for Roblox-specific questions.

## Troubleshooting

Match the symptom, give the person the single fix, then check again from step 1.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No Roblox Studio tools in this chat | The plugin is off, or the game holds no Roblox place yet | Turn the plugin on in Plugins; choose this game's place in the panel |
| A call answers that Roblox Studio isn't open for this game | Studio is closed, another place is open, or the MCP server is off | Open this game's place from the panel; check the MCP server step |
| Studio is open, but the button stays on Starting | No place is open, or the MCP switch is off | Open a place; turn the switch on (step 3) |
| The switch was on, now it's off | The person signed in with another Roblox account | Turn it on again for this account |
| Studio is installed, but the panel can't find its MCP server | Studio is out of date | Update Studio, then open it again |
| The connection fails right after the switch is turned on | Another app uses Studio's MCP port (13469) | Close the other app, then restart Studio |
| Calls go to the wrong place | Several Studios are open | Choose the place for this game in the panel |
| A Studio tool named in Roblox's docs is missing | Studio's tools differ by version | Use the tools that are there; suggest updating Studio |
| A dialog in Studio blocks every call | Studio is waiting for the person | Ask the person to answer it; never click it for them unless they press Do it for me |

If nothing matches, say which step failed and what you saw. Leave the person's places and files as
they are, and don't install other tools or MCP servers to work around it.

## Licence of the original

The original skill is from https://github.com/Roblox/roblox-studio-agent-plugin
(`skills/roblox-get-started`, plugin version 0.2.1), used under this licence:

MIT License

Copyright (c) 2026 Roblox Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
