// Regression tests for problems real agents ran into: pointing and hit-testing, fixed panels, pouring and
// filling feedback, stove warnings, and surviving a server restart. None of these need Chromium.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, heading } from "../src/engine";
import { Journal } from "../src/journal";
import { createSession, type SessionContext } from "../src/mcp";
import { Registry } from "../src/registry";
import type { Renderer3D } from "../src/renderer3d";
import { VIEW_H, VIEW_W } from "../src/snapshot";
import { heldRects, layoutBoxes, pick, View, type PickResult } from "../src/space";
import type { Thing } from "../src/world";
import { Solver } from "./solver";

const SEEDS = Array.from({ length: 300 }, (_, i) => `seed-${i}`);

function seedWhere(pred: (g: Game) => boolean): Game {
  for (const s of SEEDS) {
    const g = new Game("t", "tester", "script", s);
    if (pred(g)) return g;
  }
  throw new Error("no matching seed");
}

/** First pixel of the agent's own view (not covered by a held item) whose pick satisfies `want`. */
function findPixel(g: Game, want: (r: PickResult) => boolean, step = 8): { x: number; y: number } | undefined {
  const boxes = layoutBoxes(g);
  const held = heldRects(g);
  for (let y = 4; y < VIEW_H; y += step) {
    for (let x = 4; x < VIEW_W; x += step) {
      if (held.some((r) => r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) continue;
      if (want(pick(g, boxes, x, y))) return { x, y };
    }
  }
  return undefined;
}

const isThing = (r: PickResult, pred: (t: Thing) => boolean): boolean => r.kind === "thing" && pred(r.thing);

function act(g: Game, name: string, fn: () => { text: string }, physical = true) {
  return g.run(name, {}, physical, fn);
}

describe("status line", () => {
  test("shows a compass heading and head tilt, and follows turns", () => {
    expect(heading(0)).toBe("0° (north)");
    expect(heading(Math.PI / 2)).toBe("90° (east)");
    expect(heading(-Math.PI / 4)).toBe("315° (north-west)");
    const g = new Game("t", "tester", "script", "seed-1");
    const before = /Facing (\d+)°/.exec(g.hud())![1]!;
    act(g, "turn", () => g.turn(90), false);
    const after = /Facing (\d+)°/.exec(g.hud())![1]!;
    expect((Number(before) + 90) % 360).toBe(Number(after));
    expect(g.hud()).toContain("head tilted");
  });
});

describe("fixed panels are told apart from doors", () => {
  test("the panels under the counter say they are fixed, not just 'doesn't open'", () => {
    const g = new Game("t", "tester", "script", "seed-0");
    const s = new Solver(g);
    s.approach("counter");
    act(g, "tilt", () => g.tiltHead(-30), false);
    const p = findPixel(g, (r) => isThing(r, (t) => t.id === "counter") && r.kind === "thing" && r.point[1] < 0.7);
    expect(p).toBeDefined();
    const r = act(g, "open", () => g.open(p!));
    expect(r.ok).toBe(false);
    expect(r.text).toContain("fixed panel");
  });

  test("the oven door is fixed shut", () => {
    const g = new Game("t", "tester", "script", "seed-0");
    const s = new Solver(g);
    s.approach("stove");
    act(g, "tilt", () => g.tiltHead(-30), false);
    const p = findPixel(g, (r) => isThing(r, (t) => t.id === "stove") && r.kind === "thing" && r.point[1] < 0.6);
    expect(p).toBeDefined();
    const r = act(g, "open", () => g.open(p!));
    expect(r.text).toContain("fixed shut");
  });
});

describe("hit-testing", () => {
  test("switching on the coffee maker works when the pixel lands on the carafe standing in it", () => {
    const g = seedWhere((g) => g.world.recipe.method === "drip" && !g.world.recipe.twists.includes("carafe away from machine"));
    const s = new Solver(g);
    const cm = g.world.recipe.brewer!;
    s.approach(cm);
    const onCarafe = findPixel(g, (r) => isThing(r, (t) => t.kind === "carafe"), 4);
    expect(onCarafe).toBeDefined();
    const r = act(g, "switch_on", () => g.switchOn(onCarafe!));
    expect(r.text).not.toContain("can't find a switch");
    expect(r.text).toContain("power button");
  });

  test("the hood and buttons of a coffee maker are the machine, not the carafe below", () => {
    const g = seedWhere((g) => g.world.recipe.method === "drip" && !g.world.recipe.twists.includes("carafe away from machine"));
    const s = new Solver(g);
    const cm = g.world.recipe.brewer!;
    s.approach(cm);
    const box = layoutBoxes(g).get(cm)!;
    const top = box.min[1] + (box.max[1] - box.min[1]) * 0.7;
    const p = findPixel(g, (r) => r.kind === "thing" && r.point[1] > top && r.point[1] < box.max[1] - 0.02 && (r.thing.id === cm || r.thing.kind === "carafe"), 3);
    expect(p).toBeDefined();
    const r = pick(g, layoutBoxes(g), p!.x, p!.y);
    expect(r.kind === "thing" && r.thing.id).toBe(cm);
  });

  test("press_plunger accepts a click on the raised knob above the glass", () => {
    const g = seedWhere((g) => g.world.recipe.method === "press");
    const s = new Solver(g);
    const press = g.world.recipe.brewer!;
    s.take(press);
    s.stash(press);
    s.approach(press);
    const b = layoutBoxes(g).get(press)!;
    const knob = new View(g.pose).project([(b.min[0] + b.max[0]) / 2, b.max[1] + 0.11, (b.min[2] + b.max[2]) / 2])!;
    const r = act(g, "press_plunger", () => g.press({ x: knob.x, y: knob.y }));
    expect(r.ok).toBe(true);
    expect(g.thing(press).pressed).toBe(true);
  });

  test("close works when pointing at what's inside an open drawer", () => {
    const g = new Game("t", "tester", "script", "seed-2");
    const s = new Solver(g);
    const p = s.approach("drawer_1");
    act(g, "open", () => g.open(p));
    expect(g.thing("drawer_1").container!.open).toBe(true);
    let inside: { x: number; y: number } | undefined;
    for (let tilt = 0; tilt < 4 && !inside; tilt++) {
      inside = findPixel(g, (r) => isThing(r, (t) => t.parent === "drawer_1"), 4);
      if (!inside) act(g, "tilt", () => g.tiltHead(-10), false);
    }
    expect(inside).toBeDefined();
    const r = act(g, "close", () => g.close(inside!));
    expect(r.text).toBe("You close it.");
    expect(g.thing("drawer_1").container!.open).toBe(false);
  });

  test("pointing at a held item in your own view means that item", () => {
    const g = new Game("t", "tester", "script", "seed-4");
    const s = new Solver(g);
    const mug = g.world.recipe.mugs[0]!;
    s.take(mug);
    const rect = heldRects(g)[g.hands.indexOf(mug)]!;
    const r = act(g, "examine", () => g.examine({ x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + VIEW_H) / 2 }), false);
    expect(r.ok).toBe(true);
    expect(r.closeUp).toEqual({ inspect: mug });
    // ...and in the close-up it's held up in the middle of the frame
    const again = act(g, "examine", () => g.examine({ x: VIEW_W / 2, y: VIEW_H / 2 }), false);
    expect(again.closeUp).toEqual({ inspect: mug });
  });

  test("after examine, pixels refer to the close-up the agent was just shown", () => {
    const g = new Game("t", "tester", "script", "seed-5");
    const s = new Solver(g);
    const note = [...g.world.things.values()].find((t) => t.kind === "note")!;
    s.approach(note.id);
    // look a little to the side, so the middle of the agent's own view is not on the note
    act(g, "turn", () => g.turn(25), false);
    const middle = pick(g, layoutBoxes(g), VIEW_W / 2, VIEW_H / 2);
    expect(middle.kind === "thing" && middle.thing.id === note.id).toBe(false);
    const p = s.pixelFor(note.id)!;
    expect(p).toBeDefined();
    const shot = act(g, "examine", () => g.examine(p), false);
    expect(shot.closeUp && "camera" in shot.closeUp).toBe(true);
    // the close-up is centered on the note, wherever it sits in the agent's own view
    const r = act(g, "take", () => g.take({ x: VIEW_W / 2, y: VIEW_H / 2 }));
    expect(r.ok).toBe(true);
    expect(g.hands).toContain(note.id);
  });
});

describe("walking", () => {
  test("walking to a floor spot keeps the head tilt", () => {
    const g = new Game("t", "tester", "script", "seed-6");
    act(g, "tilt", () => g.tiltHead(-20), false);
    const pitch = g.pose.pitch;
    const p = findPixel(g, (r) => r.kind === "floor" && Math.hypot(r.point[0] - g.pose.x, r.point[2] - g.pose.z) > 1.2);
    expect(p).toBeDefined();
    const r = act(g, "walk_to", () => g.walkTo(p!));
    expect(r.ok).toBe(true);
    expect(g.pose.pitch).toBeCloseTo(pitch, 6);
  });

  test("pointing at a wall walks you up to it instead of refusing", () => {
    const g = new Game("t", "tester", "script", "seed-7");
    let p: { x: number; y: number } | undefined;
    for (let turn = 0; turn < 4 && !p; turn++) {
      if (turn) act(g, "turn", () => g.turn(90), false);
      p = findPixel(g, (r) => r.kind === "wall" && r.point[1] < 1.2 && Math.hypot(r.point[0] - g.pose.x, r.point[2] - g.pose.z) > 1.5);
    }
    expect(p).toBeDefined();
    const before = { ...g.pose };
    const r = act(g, "walk_to", () => g.walkTo(p!));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("toward the wall");
    expect(Math.hypot(g.pose.x - before.x, g.pose.z - before.z)).toBeGreaterThan(0.5);
  });
});

describe("pouring and filling", () => {
  function twoVessels(): { g: Game; s: Solver; mug: string; jug: string } {
    const g = seedWhere((g) => !!g.world.recipe.heater);
    const s = new Solver(g);
    const mug = g.world.recipe.mugs[0]!;
    const jug = g.world.recipe.heater!;
    s.take(mug);
    s.take(jug);
    return { g, s, mug, jug };
  }

  test("pouring without an amount stops at the brim, with no spill", () => {
    const { g, s, mug, jug } = twoVessels();
    g.thing(jug).vessel!.stuff = { water: 1000 };
    g.thing(mug).vessel!.stuff = {};
    const r = act(g, "pour", () => g.pour(s.hand(jug), { hand: s.hand(mug) }));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("stop at the brim");
    expect(r.text).toContain("full to the brim");
    expect(g.penalties).toEqual([]);
    expect(g.thing(jug).vessel!.stuff.water).toBeCloseTo(650, 0);
  });

  test("pouring into a container that is already full is refused, not spilled", () => {
    const { g, s, mug, jug } = twoVessels();
    g.thing(jug).vessel!.stuff = { water: 500 };
    g.thing(mug).vessel!.stuff = { water: 350 };
    const r = act(g, "pour", () => g.pour(s.hand(jug), { hand: s.hand(mug) }, 100));
    expect(r.ok).toBe(false);
    expect(r.text).toContain("already full");
    expect(r.text).toContain("350 ml");
    expect(g.penalties).toEqual([]);
    expect(g.thing(jug).vessel!.stuff.water).toBe(500);
  });

  test("an explicit amount that doesn't fit still overflows, and says so", () => {
    const { g, s, mug, jug } = twoVessels();
    g.thing(jug).vessel!.stuff = { water: 1000 };
    g.thing(mug).vessel!.stuff = { water: 300 };
    const r = act(g, "pour", () => g.pour(s.hand(jug), { hand: s.hand(mug) }, 200));
    expect(r.text).toContain("overflows");
    expect(r.text).toContain("150 ml goes over the side");
    expect(g.penalties.map((p) => p.reason)).toEqual(["spill: overfilled a container"]);
  });

  test("pour and fill results report the level and the capacity", () => {
    const { g, s, mug, jug } = twoVessels();
    g.thing(jug).vessel!.stuff = { water: 600 };
    g.thing(mug).vessel!.stuff = {};
    const r = act(g, "pour", () => g.pour(s.hand(jug), { hand: s.hand(mug) }, 100));
    expect(r.text).toContain("It now holds about 100 ml; it takes about 350 ml.");
    s.stash(mug);
    g.thing(jug).vessel!.stuff = {};
    const sink = g.world.recipe.sink;
    const p = s.approach(sink, true);
    const f = act(g, "fill", () => g.fill(s.hand(jug), p, 500));
    expect(f.text).toMatch(/It now holds about 500 ml; it takes about \d+ ml\./);
  });
});

describe("stove warnings", () => {
  test("lighting the stove under an empty pan warns, and the smell comes before the scorch", () => {
    const g = seedWhere((g) => {
      const h = g.world.recipe.heater;
      return !!h && g.thing(h).kind === "stovetop_kettle" && g.thing(h).parent === "stove";
    });
    const s = new Solver(g);
    const p = s.approach("stove");
    const on = act(g, "switch_on", () => g.switchOn(p));
    expect(on.ok).toBe(true);
    expect(on.text).toContain("Careful");
    expect(g.hud()).toContain("A burner is still on.");
    // switching on takes 30 s too: the first whiff arrives with it
    expect(on.text).toContain("dry, hot smell");
    const w1 = act(g, "wait", () => g.wait(0.5));
    expect(w1.text).toContain("about to scorch");
    expect(g.penalties).toEqual([]);
    const w2 = act(g, "wait", () => g.wait(0.5));
    expect(w2.text).toContain("burning smell");
    expect(g.penalties.length).toBe(1);
  });

  test("a stovetop kettle whistles with a clear hint the first time it boils", () => {
    const g = seedWhere((g) => {
      const h = g.world.recipe.heater;
      return !!h && g.thing(h).kind === "stovetop_kettle";
    });
    const s = new Solver(g);
    const k = g.world.recipe.heater!;
    s.fillAtSink(k, 600);
    s.put(k, "stove");
    s.lightStove(k);
    let text = "";
    for (let i = 0; i < 12 && !text.includes("whistle"); i++) text = act(g, "wait", () => g.wait(0.5)).text;
    expect(text).toContain("A shrill whistle! The water is boiling");
  });
});

describe("surviving a server restart", () => {
  const fakeRenderer = { render: async () => new Uint8Array([137, 80, 78, 71]), close: async () => undefined } as unknown as Renderer3D;

  async function connect(registry: Registry, ctx: SessionContext) {
    const session = createSession(registry, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await session.server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    };
    return { session, call };
  }

  test("a session that comes back after a restart gets its run replayed exactly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coffeetest-"));
    const journal = new Journal(join(dir, "sessions"));
    const sid = crypto.randomUUID();
    const before = new Registry(join(dir, "runs.jsonl"), fakeRenderer);
    const a = await connect(before, { id: sid, journal });
    await a.call("start_game", { player_name: "tester", seed: "seed-3" });
    await a.call("turn", { degrees: 75 });
    await a.call("tilt_head", { degrees: -20 });
    await a.call("move", { forward: 0.6 });
    const ga = [...before.runs.values()][0]!;

    // A fresh process: new registry, new MCP server, same session id and journal on disk.
    const after = new Registry(join(dir, "runs.jsonl"), fakeRenderer);
    const b = await connect(after, { id: sid, journal });
    expect(await b.session.restore()).toBe(4);
    const gb = [...after.runs.values()][0]!;
    expect(gb.seed).toBe("seed-3");
    expect(gb.pose).toEqual(ga.pose);
    expect(gb.actions).toBe(ga.actions);
    expect(gb.tick).toBe(ga.tick);

    const text = await b.call("look");
    expect(text).toContain("The game server restarted. Your run was restored");
    expect(await b.call("look")).not.toContain("restarted");

    await b.call("give_up");
    expect(journal.load(sid)).toEqual([]);
  });

  test("a session with nothing to restore is told plainly to start again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coffeetest-"));
    const registry = new Registry(join(dir, "runs.jsonl"), fakeRenderer);
    const c = await connect(registry, { id: crypto.randomUUID(), journal: new Journal(join(dir, "sessions")) });
    expect(await c.session.restore()).toBe(0);
    const text = await c.call("look");
    expect(text).toContain("server restarted");
    expect(text).toContain("start_game");
  });

  test("the journal only accepts session ids it could have handed out", () => {
    const dir = mkdtempSync(join(tmpdir(), "coffeetest-"));
    const journal = new Journal(join(dir, "sessions"));
    journal.reset("../../escape", { tool: "start_game", args: {} });
    expect(journal.load("../../escape")).toEqual([]);
    const sid = crypto.randomUUID();
    journal.reset(sid, { tool: "start_game", args: { seed: "x" } });
    journal.append(sid, { tool: "look", args: {} });
    expect(journal.load(sid).map((e) => e.tool)).toEqual(["start_game", "look"]);
  });
});
