import { describe, expect, test } from "bun:test";
import { Game } from "../src/engine";
import { generateHouse } from "../src/generate";
import { inReach, layoutBoxes } from "../src/space";
import { Solver } from "./solver";

const SEEDS = Array.from({ length: 300 }, (_, i) => `seed-${i}`);

describe("house generation", () => {
  test("same seed builds the same house", () => {
    const a = generateHouse("101-oak-lane");
    const b = generateHouse("101-oak-lane");
    expect(JSON.stringify([...a.things.values()])).toBe(JSON.stringify([...b.things.values()]));
    expect(a.recipe).toEqual(b.recipe);
    expect(JSON.stringify(a.doors)).toBe(JSON.stringify(b.doors));
  });

  test("every coffee method and twist shows up across seeds", () => {
    const methods = new Set<string>();
    const twists = new Set<string>();
    for (const s of SEEDS) {
      const r = generateHouse(s).recipe;
      methods.add(r.method + (r.beans ? "+beans" : ""));
      for (const t of r.twists) twists.add(t);
    }
    expect([...methods].sort()).toEqual(["drip", "drip+beans", "instant", "moka", "moka+beans", "press", "press+beans"]);
    for (const t of ["kitchen water off", "only dirty mugs", "spoiled milk", "unlabeled sugar/salt jars", "whole beans", "broken coffee maker decoy"]) {
      expect(twists).toContain(t);
    }
  });

  test("furniture never overlaps and stays inside its room", () => {
    for (const s of SEEDS) {
      const w = generateHouse(s);
      const floor = [...w.things.values()].filter((t) => !t.parent && t.box && t.box.min[1] < 1.0);
      for (const t of floor) {
        const r = w.rects.get(t.room!)!;
        expect(t.box!.min[0] >= r.x0 - 1e-6 && t.box!.max[0] <= r.x1 + 1e-6 && t.box!.min[2] >= r.z0 - 1e-6 && t.box!.max[2] <= r.z1 + 1e-6).toBe(true);
        for (const o of floor) {
          if (o === t || (o.kind === "drawer" && t.kind === "drawer")) continue;
          const overlap =
            t.box!.min[0] < o.box!.max[0] - 1e-6 && o.box!.min[0] < t.box!.max[0] - 1e-6 && t.box!.min[2] < o.box!.max[2] - 1e-6 && o.box!.min[2] < t.box!.max[2] - 1e-6;
          if (overlap) throw new Error(`${s}: ${t.name} overlaps ${o.name}`);
        }
      }
    }
  });
});

describe("every house is solvable through the embodied interface", () => {
  test.each(SEEDS)("%s", (seed) => {
    const g = new Solver(new Game("t", "solver", "script", seed)).play();
    expect(g.outcome?.verdict).toBe("A proper cup of coffee.");
    expect(g.outcome?.notes.filter((n) => !n.includes("physical actions"))).toEqual([]);
    expect(g.status).toBe("won");
  });
});

/** Finds a seed whose house satisfies a predicate. */
function seedWhere(pred: (g: Game) => boolean): Game {
  for (const s of SEEDS) {
    const g = new Game("t", "solver", "script", s);
    if (pred(g)) return g;
  }
  throw new Error("no matching seed");
}

describe("judging", () => {
  test("salt from the unlabeled jar ruins the cup", () => {
    const g = seedWhere((g) => g.world.pref.sugar && g.world.recipe.twists.includes("unlabeled sugar/salt jars"));
    const salt = [...g.world.things.values()].find((t) => t.name.startsWith("glass jar") && t.id !== g.world.recipe.sugar)!;
    g.world.recipe.sugar = salt.id;
    new Solver(g).play();
    expect(g.status).toBe("failed");
    expect(g.outcome!.verdict).toContain("SALTY");
  });

  test("spoiled milk ruins the cup", () => {
    const g = seedWhere((g) => g.world.pref.milk && g.world.recipe.twists.includes("spoiled milk"));
    g.world.recipe.milk = [...g.world.things.values()].find((t) => t.expired)!.id;
    new Solver(g).play();
    expect(g.status).toBe("failed");
    expect(g.outcome!.verdict).toContain("spoiled");
  });

  test("leaving the stove on costs points but the coffee still counts", () => {
    const g = seedWhere((g) => g.world.recipe.method === "moka");
    new Solver(g, { leaveStoveOn: true }).play();
    expect(g.status).toBe("won");
    expect(g.outcome!.notes).toContain("-150: left the stove on");
  });

  test("ignoring the owner's milk preference is penalized", () => {
    const g = seedWhere((g) => g.world.pref.milk);
    new Solver(g, { skipMilk: true }).play();
    expect(g.status).toBe("won");
    expect(g.outcome!.notes).toContain("-200: they asked for milk");
  });
});

describe("embodied constraints", () => {
  test("things you can see but can't reach can't be handled", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const g = new Game("t", "solver", "script", seed);
      const s = new Solver(g);
      let target: { x: number; y: number } | undefined;
      for (let turn = 0; turn < 4 && !target; turn++) {
        if (turn) g.run("turn", {}, false, () => g.turn(90));
        const boxes = layoutBoxes(g);
        for (const t of g.world.things.values()) {
          if (!t.portable || t.parent === "hands" || inReach(g, boxes, t)) continue;
          target = s.pixelFor(t.id);
          if (target) break;
        }
      }
      if (!target) continue;
      const r = g.run("take", {}, true, () => g.take(target!));
      expect(r.ok).toBe(false);
      expect(r.text).toContain("reach");
      expect(g.hands).toEqual([null, null]);
      return;
    }
    throw new Error("no seed had a visible, unreachable portable thing");
  });

  test("narration never names what you touched", () => {
    const g = seedWhere((g) => g.world.recipe.method === "drip");
    new Solver(g).play();
    const names = [...g.world.things.values()].map((t) => t.name).filter((n) => n.length > 4);
    for (const entry of g.log.filter((l) => !l.action.startsWith("serve"))) {
      for (const n of names) expect(entry.result.toLowerCase()).not.toContain(n.toLowerCase());
    }
  });
});
