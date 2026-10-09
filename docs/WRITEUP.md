# The Coffee Test: what agents got wrong, and what we changed

## The test

Steve Wozniak once suggested a practical test for general AI: walk into a house you have never seen and make a cup of coffee.

The Coffee Test turns that into a game served over MCP. Every run is a procedurally generated house with its own brewing method (drip machine, French press, moka pot or instant) and a few twists, and the owner leaves a note saying how they take their coffee. The agent sees a 960x600 first-person image after every action, with nothing labeled, and acts by pointing at pixel coordinates: open what's at (512, 210), take what's at (300, 380). A run is scored out of 1000, with points off for every action, for mess and hazards, and for getting the order wrong.

## Why pointing at pixels is hard

Our first prototype described the room in text and let the agent name objects. An agent finished it with 901 points in 35 actions. The pixel version is a different game. The agent has to recognize a kettle from a few hundred pixels and then hit it with a coordinate, and every miss costs an action. Our pixel runs took between 100 and 250 actions.

Most of that gap is the task itself, which is what we want to measure. Some of it was the game being unclear or unfair, and that part we can fix.

## Four kinds of problems

**The server.** It stopped responding twice mid-run, once around action 65. The likely cause was the headless Chromium that renders frames: a hung frame had no deadline, so every later tool call waited behind it. A restart then lost the run, and the agent's old MCP session id got a 404 that most clients don't recover from.

**Pointing.** Clicks often landed on something other than what the agent meant. The coffee maker's power button sits just above the carafe, and the hit test preferred the carafe, so switching it on took four tries. The French press knob sticks up outside its hit box. An item inside an open drawer swallowed clicks meant for the drawer. After `examine`, agents pointed at the close-up they had just been shown, but the server read the click against the normal view, so `take` grabbed the wrong package. `walk_to` on the floor could snap to a spot behind a wall, and it reset the head tilt.

**Feedback.** The panels under the counter look like cabinet doors but never open, and the game said only "That doesn't open", which reads the same as a miss. Agents kept retrying them. `fill` with no amount filled a carafe to 1.5 liters without saying so, and pouring that into a mug overflowed and cost points. In a narrow hallway, two views 90 degrees apart can both be a blank wall, so agents could not tell whether a turn had happened.

**Hazards and decoys.** These are deliberate, but the warnings were thin. One agent lit the stove under an empty kettle and went looking for coffee. The first signal came after the penalty.

## What we changed

- Every frame has a 30 second deadline. A failed or hung frame restarts the browser and is retried once, and the browser is recycled every 400 frames. Unhandled errors are logged instead of ending the process.
- Each session keeps a journal of its tool calls. When a client comes back after a restart with its old session id, the server re-creates the session and replays the journal, so the run continues from the same spot.
- Pointing forgives near misses where the intent is clear. Switches, plugs and the plunger accept clicks within 24 to 30 pixels, a click on the carafe reaches the coffee maker, `close` finds the open drawer you were pointing into, and a click that only grazes an item's padding loses to one that is really on its neighbor. Pixels after `examine` refer to the close-up, and held items can be pointed at.
- Fixed fronts are drawn as plain panels without handles, and opening one says it is a fixed panel. The oven door says it is fixed shut.
- Pour and fill results report the new level and the capacity. Pouring with no amount stops at the brim, and pouring into something already full is refused. An explicit amount that doesn't fit still overflows and is still penalized.
- The status line shows a compass heading, head tilt, and whether a burner is on. Lighting the stove under an empty pan warns at once, two smells come before the scorch, and the first whistle explains that the water keeps boiling away.
- `walk_to` on the floor picks a reachable spot in the same room and keeps the head tilt. Pointing at a wall walks you up to it.

The scoring rules are unchanged.

## Results so far

All of these AI agent runs were played before the changes above. Players are identified only by run number, and the table does not say which agent played which run.

| Run | Version | Score (grade) | Actions | Notes |
|---|---|---|---|---|
| n/a | Text-label prototype | 901 (S) | 35 | Objects named in text |
| 1 | Pixel, moka pot house, no twists | 845 (S) | 102 | Clean run |
| 2 | Pixel, press | 649 (B) | 159 | Lukewarm coffee (48 C) |
| 3 | Pixel, press | 442 (C) | 250 | Two overfills, lukewarm coffee (54 C) |
| 4 | Pixel, press | 704 (A) | 123 | Scorched an empty stovetop kettle |
| 5 | Pixel, instant, kitchen water off | 0 (F) | 14 | Gave up |
| 6 | Pixel, drip | 773 (A) | 146 | Got hints during the run, so not a clean result |

The text prototype run happened before runs were logged, so it has no run number.

## Two decoys that worked

In one house, the counter had a bag labeled GROUND next to an empty grinder. The bag was empty except for a few stray grounds. The real coffee was a bag of whole beans stored elsewhere, so the grinder mattered after all, just not with that bag.

In another, the milk in the kitchen fridge was past its date, and a fresh carton sat in an old fridge in the garage. Serving the old milk fails the run outright.

## Lessons for agent builders

- Read the note first. Getting milk or sugar wrong costs up to 200 points.
- Check labels and expiry dates with `examine` before using anything, and taste unlabeled jars.
- Don't leave the stove on while you look for something else. Fill the pan first and switch the burner off when you're done.
- If something doesn't open after one clear attempt, believe the message. Retrying a fixed panel only costs actions.
- Keep a map. Note the compass heading of each room and where you saw useful things, so you don't search the same cabinets twice.
