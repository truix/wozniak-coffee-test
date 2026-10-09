# Changelog

## 0.3.0 (2026-10-09)

Fixes for problems seen in real agent runs. Scoring rules are unchanged. See [docs/WRITEUP.md](docs/WRITEUP.md) for the background.

### Server

- Frames have a 30 s deadline. A failed or hung frame restarts Chromium and is retried once, and Chromium is recycled every 400 frames.
- Unhandled errors and promise rejections are logged instead of stopping the server.
- Each MCP session keeps a journal of its tool calls (`data/sessions/`). A client that returns after a restart with its old session id gets the session re-created and its run replayed. If there is nothing to restore, it is told to call `start_game` again.
- Idle sessions are closed after 6 hours and old finished runs are dropped from memory. A damaged line in `runs.jsonl` no longer stops the server from starting.
- New `DATA_DIR` setting for where the leaderboard and journals live.

### Pointing and hit-testing

- Pixels refer to the latest image: after `examine`, they point into the close-up.
- Held items can be pointed at where they are drawn in the lower corners of the view.
- Switches, plugs and the French press plunger accept clicks a little off target. A click on a carafe or a kettle reaches the appliance it stands on.
- The hood and buttons of a coffee maker resolve to the machine, not the carafe below.
- The raised French press knob counts as part of the press.
- `close` works when pointing at what's inside an open drawer or cabinet, or near it.
- A click that is really on an item beats one that only grazes the padding of its neighbor.
- `put` on the top of a closed base cabinet uses the worktop beside it instead of saying "That's closed."
- Examining a held note shows it upright and readable.

### Walking

- `walk_to` on the floor picks a reachable spot in the same room as the click, keeps the head tilt, and ends facing the way you walked.
- `walk_to` on a wall walks you up to that wall.

### Feedback

- Fixed fronts (under the counter, island and kitchen sink) are drawn as plain panels without handles and say they are fixed when you try to open them. The oven door says it is fixed shut.
- Pour and fill results report the new level and the capacity.
- Pouring without an amount stops at the brim. Pouring into something already full is refused before it spills. Explicit amounts that don't fit still overflow and are penalized.
- The status line shows the compass heading, head tilt, and whether a burner is still on.
- Stove warnings: lighting it under an empty pan, a hiss as things heat, two smells before a scorch, and a hint with the first kettle whistle.

### Docs and repo

- README: known design decisions, restart recovery, links to the write-up.
- Added `docs/WRITEUP.md`, this changelog, an MIT license, and regression tests in `test/fixes.test.ts`.
- `data/` is kept out of version control except for a placeholder.

## 0.1.0

First pixel-pointing version: procedurally generated houses, a Three.js first-person renderer in headless Chromium, the MCP tool surface, the spectator view and the scripted solver tests.
