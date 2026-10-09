# ☕ The Coffee Test

Steve Wozniak's test for general AI: *walk into an unfamiliar house and make a cup of coffee.*

This version is an **embodied, first-person 3D game served over MCP**. Each run is a procedurally generated house the agent has never seen. The agent:
- walks, turns and tilts its head;
- gets a rendered first-person image after every action;
- handles only what is within arm's reach.

The agent gets **no names or labels**. It works out what everything is from the images: rooms, cabinets, the kettle, a bag of whole beans versus ground coffee, an unplugged cord, an expiry date. It acts by pointing at pixel coordinates in its latest image.

## Run it

```sh
bun install          # on SMB/network drives: bun install --no-save --backend=copyfile
bun start            # MCP at http://127.0.0.1:3333/mcp, live 3D spectator view at http://127.0.0.1:3333/
```

- Rendering uses a headless Chromium managed by Puppeteer. It downloads on first install and launches on the first frame.
- `PORT` and `HOST` override the bind address. `DATA_DIR` moves the leaderboard and session journals (default `data/`).
- Run `bun start` in its own terminal and leave it open. Wrappers that kill long-running commands (for example after 300 s) will take the server down with them.
- If the server does restart mid-run, the agent can carry on: every session keeps a small journal of its tool calls, and a client that comes back with its old session id gets its run rebuilt by replaying them (same house, same spot, same action count).

## Connect an agent

The server speaks MCP **Streamable HTTP** at `/mcp`. Each client session gets its own run. The agent must accept image tool results, so you need a vision-capable model.

| Client | Setup |
|---|---|
| Claude Code | `claude mcp add --transport http coffee-test http://127.0.0.1:3333/mcp` |
| Cursor | `.cursor/mcp.json`: `{"mcpServers":{"coffee-test":{"url":"http://127.0.0.1:3333/mcp"}}}` |
| VS Code (Copilot) | `.vscode/mcp.json`: `{"servers":{"coffee-test":{"type":"http","url":"http://127.0.0.1:3333/mcp"}}}` |
| Gemini CLI | `settings.json`: `{"mcpServers":{"coffee-test":{"httpUrl":"http://127.0.0.1:3333/mcp"}}}` |
| Claude Desktop / stdio-only clients | `{"mcpServers":{"coffee-test":{"command":"bunx","args":["mcp-remote","http://127.0.0.1:3333/mcp"]}}}` |

Prompt it:

> Use the coffee-test tools. Call `start_game` with `player_name` set to your model name. You're in a house you've never seen; make the owner a cup of coffee the way their note asks, then `serve` it.

The server's MCP `instructions` explain the controls. To compare agents fairly, pass the same `seed` to `start_game`.

## Controls

Every tool returns a 960×600 first-person PNG, plus short anonymous narration ("You pick it up with your right hand", "A shrill whistle!") and a status line with the clock, the action count, the compass heading and head tilt, and what's in each hand. Rulers along the top and left edges help with pointing. Pixels always refer to the latest image, so right after `examine` they point into the close-up.

| Tool | What it does |
|---|---|
| `look` | Fresh view, no time passes |
| `turn` `{degrees}` | Rotate on the spot (+ = right) |
| `tilt_head` `{degrees}` | Look up (+) / down (−) |
| `move` `{forward, right}` | Step in meters; stops if you bump into something |
| `walk_to` `{x, y}` | Walk up to whatever is at that pixel (ending within reach, facing it), to that spot on the floor (including through doorways; head tilt is kept), or up to a wall |
| `examine` `{x, y}` or `{hand}` | Close-up image: read labels, dates and the note. A held item can be named by hand or pointed at in the lower corner where you hold it |
| `open` / `close` / `take` `{x, y}` | Doors, drawers, the fridge; pick up into a free hand |
| `put` `{hand, x, y}` | Onto a counter or shelf, into a cabinet, onto the stove, kettle base or warming plate, a filter into the basket |
| `pour` `{hand, x, y \| into_other_hand, amount?}` | ml for liquids, g for solids; omit `amount` to pour until the source is empty or the target is full. The result reports the new level and capacity |
| `fill` / `wash` `{hand, x, y}` | At the sink you point at; `fill` takes an optional `amount` and reports the level and capacity |
| `plug_in` / `switch_on` / `switch_off` / `press_plunger` `{x, y}` | Appliances, the stove, a French press |
| `taste` `{hand}` or `{x, y}` | Sweet or salty? Sour milk? Hot or cold? |
| `wait` `{minutes}` | Let water boil, coffee brew or steep |
| `serve` `{hand}` | Hand over the mug; ends and scores the run |
| `give_up` | Abandon the run |

Rules:
- You have two hands.
- You can only reach about 1 m; pointing at something across the room tells you to walk closer.
- Closed cabinets, drawers, the fridge and appliances hide their contents until opened. Doors and drawers that open have handles; the plain panels under the counter, island and kitchen sink are fixed.

## How a house works

Each seed lays out a real floor plan: hallway, living room and kitchen, plus some of dining room, pantry, bathroom, laundry and garage. Rooms are joined by doorways, and furniture stands against the walls.

Each house also picks a **brewing method**: drip machine, French press with kettle, moka pot on the stove, or instant. Coffee comes pre-ground, or as whole beans that need the grinder.

Possible twists:
- appliances left unplugged (a loose cord on the counter);
- the kitchen water shut off, with a note taped to the tap;
- only dirty mugs;
- mugs in the dishwasher or sideboard;
- coffee in the freezer;
- an empty coffee bag as a decoy;
- a broken coffee maker when the real method is something else;
- spoiled milk;
- unlabeled jars of salt and sugar.

The owner's note says how they take it: black, milk, milk and one sugar, or sugar.

Simulated physics:
- Kettles and burners heat water, and coffee cools in the mug.
- Brew strength follows the grounds-to-water ratio. French press strength depends on steep time, and grounds end up in the cup until you press the plunger.
- Instant dissolves only in hot water.
- Overfilling spills. Metal in the microwave sparks. Empty pans on a lit burner scorch.

## Scoring

`serve` ends the run.

**Instant fail:**
- no coffee, or under 100 ml
- hot brown water (too weak)
- below 40 °C
- salt in it
- spoiled milk in it

**Penalties from 1000:**
- −2 per physical action, −1 per look/turn/tilt/examine
- −100 lukewarm, −100 weak, −100 punishingly strong
- −120 grounds in the cup
- −150 dirty mug
- −200 milk preference wrong; −150 / −100 sugar wrong or too sweet
- −30 to −60 per spill
- −150 stove left on, −100 scorch, −300 metal in the microwave

Grades: S ≥ 800, A ≥ 650, B ≥ 500, C ≥ 350, D otherwise. Runs end at 400 actions.

Finished runs are appended to `data/runs.jsonl`. The spectator page shows a live orbitable 3D dollhouse of the house with the agent's avatar, the agent's own first-person frame, the action log (with what each pointing action actually hit) and the leaderboard.

## Known design decisions

Some things that look like bugs to an agent are deliberate:

- **Fixed panels and the oven door.** The fronts under the counter, the island and the kitchen sink are not doors, and the oven door on the stove never opens. They are drawn as plain panels without handles (real doors and drawers have handles), and trying to open one says so plainly instead of a bare "That doesn't open."
- **Decoys.** A house can have an empty bag labeled GROUND on the counter while the real coffee is somewhere else (sometimes as whole beans that still need grinding), a broken coffee maker when the real method is something else, spoiled milk in the kitchen fridge with a fresh carton elsewhere (sometimes a garage fridge), and unlabeled jars of salt and sugar. Reading labels and dates, and tasting, is part of the test.
- **Hazards.** A lit burner heats whatever stands on it until you switch the stove off. Water boils away, and an empty pan or kettle scorches after a minute and a half. The narration warns on the way (a hiss as it heats, a whistle with a hint the first time, two warning smells before a scorch), and the status line says when a burner is still on, but walking away is still penalized.
- **Spills.** Pouring without an amount stops at the brim. Pouring an explicit amount that doesn't fit overflows and costs points. Pouring into something already full is refused before anything spills.
- **What the agent is told.** Narration never names things, and the status line gives no room names or positions. It does give a compass heading, because blank walls in a narrow hallway look the same from several directions.

## Results and write-up

[docs/WRITEUP.md](docs/WRITEUP.md) describes the problems real agents hit, what was changed, and the scores from the runs so far. [CHANGELOG.md](CHANGELOG.md) lists the changes by version.

## Development

```sh
bun test          # layout invariants, judging rules, 300 houses solved through the embodied pixel interface, and regression tests for problems agents hit
bun run typecheck
bun scripts/render-fixture.ts     # render test/fixtures/kitchen.snapshot.json from several poses into tmp/
bun scripts/spectator-mock.ts     # spectator UI backed by the fixture, no agent needed
```

`test/solver.ts` is a scripted embodied player. It knows *where* things are, but acts only through the agent's actions:
- turning and tilting to face things;
- walking to pixels;
- pointing at pixels that really resolve to the target in its current view.

A win means the house is solvable through the interface the agents get.

| File | Role |
|---|---|
| `src/generate.ts` | Seeded house contents; `recipe` is the hidden ground truth |
| `src/layout.ts` | Floor plan, doorways, furniture placement, walk grid |
| `src/space.ts` | Item placement on shelves, camera maths, line of sight, pixel picking, reach, walking, snapshot building |
| `src/engine.ts` | Actions, per-tick physics, judging |
| `src/snapshot.ts` | Contract between the server and the Three.js renderer |
| `src/client/scene.ts` | Three.js scene built from a snapshot |
| `src/renderer3d.ts` | Headless Chromium that renders agent frames |
| `src/mcp.ts` | MCP tool surface |
| `src/server.ts` | Bun HTTP server: `/mcp`, `/render`, `/api/*`, spectator UI |
| `src/registry.ts` | Live runs, frames, leaderboard persistence |
| `src/journal.ts` | Per-session action journal used to restore a run after a server restart |
