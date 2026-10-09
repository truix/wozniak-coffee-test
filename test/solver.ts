import type { Game, Hand } from "../src/engine";
import { EYE_HEIGHT, VIEW_H, VIEW_W, type Vec3 } from "../src/snapshot";
import { geo, heldRects, inReach, layoutBoxes, pick, rootOf, View, type Box } from "../src/space";
import type { Thing } from "../src/world";

/**
 * A scripted embodied player. It "cheats" only to know WHERE things are (the generator's recipe and the
 * geometry). Every state change goes through the same actions an MCP agent uses: turning, tilting,
 * walking to pixels, and pointing at pixels that really resolve to the target in its current view.
 * A win therefore proves the house is solvable through the agent's interface.
 */
export class Solver {
  constructor(
    readonly g: Game,
    readonly opts: { skipMilk?: boolean; leaveStoveOn?: boolean } = {},
  ) {}

  do(name: string, fn: () => { text: string }, physical = true): string {
    const r = this.g.run(name, {}, physical, fn);
    if (!r.ok) throw new Error(`[${this.g.seed}] ${name} failed: ${r.text}\n${this.g.hud()} pose=${JSON.stringify(this.g.pose)} log=${this.g.log.slice(-6).map((l) => `${l.action}->${l.targets}`).join(" ; ")}`);
    return r.text;
  }

  t(id: string): Thing {
    return this.g.thing(id);
  }

  box(id: string): Box {
    return layoutBoxes(this.g).get(id)!;
  }

  hand(id: string): Hand {
    const i = this.g.hands.indexOf(id);
    if (i < 0) throw new Error(`[${this.g.seed}] not holding ${id}`);
    return i === 0 ? "right" : "left";
  }

  /** Turn and tilt (public actions) to look straight at a world point. */
  face(p: Vec3): void {
    const { pose } = this.g;
    const dx = p[0] - pose.x;
    const dz = p[2] - pose.z;
    const yaw = Math.atan2(dx, -dz);
    let dy = ((yaw - pose.yaw) * 180) / Math.PI;
    dy = ((dy + 540) % 360) - 180;
    if (Math.abs(dy) > 0.01) this.do("turn", () => this.g.turn(dy), false);
    const pitch = Math.atan2(p[1] - EYE_HEIGHT, Math.hypot(dx, dz));
    const dp = ((pitch - pose.pitch) * 180) / Math.PI;
    if (Math.abs(dp) > 0.01) this.do("tilt", () => this.g.tiltHead(dp), false);
  }

  /** Pixels covered by what the agent is holding (drawn on top of the room in its view). */
  covered(p: { x: number; y: number }): boolean {
    return heldRects(this.g).some((r) => r && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
  }

  /** A pixel in the current view that resolves to `id` (or, if loose, to anything inside it). */
  pixelFor(id: string, loose = false): { x: number; y: number } | undefined {
    const boxes = layoutBoxes(this.g);
    const b = boxes.get(id);
    if (!b) return undefined;
    const view = new View(this.g.pose);
    const pts: { x: number; y: number }[] = [];
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      const p = view.project([x, y, z]);
      if (p) pts.push(p);
    }
    if (!pts.length) return undefined;
    const x0 = Math.max(1, Math.min(...pts.map((p) => p.x)));
    const x1 = Math.min(VIEW_W - 1, Math.max(...pts.map((p) => p.x)));
    const y0 = Math.max(1, Math.min(...pts.map((p) => p.y)));
    const y1 = Math.min(VIEW_H - 1, Math.max(...pts.map((p) => p.y)));
    if (x0 > x1 || y0 > y1) return undefined;
    const cands: { x: number; y: number }[] = [];
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) cands.push({ x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * j) / 8 });
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    cands.sort((a, c) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(c.x - cx, c.y - cy));
    const hits = cands.filter((c) => !this.covered(c)).map((c) => ({ c, hit: pick(this.g, boxes, c.x, c.y) }));
    for (const { c, hit } of hits) if (hit.kind === "thing" && hit.thing.id === id) return c;
    if (!loose) return undefined;
    for (const { c, hit } of hits) {
      if (hit.kind !== "thing") continue;
      for (let p = hit.thing.parent; p && p !== "hands"; p = this.t(p).parent) if (p === id) return c;
    }
    return undefined;
  }

  /** Walk to the first of `spots` (floor points) that is actually visible as floor inside `room`. */
  walkFloor(spots: Vec3[], room: string): boolean {
    const r = this.g.world.rects.get(room)!;
    for (const s of spots) {
      this.face(s);
      const p = new View(this.g.pose).project(s);
      if (!p || p.x < 0 || p.y < 0 || p.x > VIEW_W || p.y > VIEW_H || this.covered(p)) continue;
      const hit = pick(this.g, layoutBoxes(this.g), p.x, p.y);
      if (hit.kind !== "floor") continue;
      const [hx, , hz] = hit.point;
      if (hx < r.x0 || hx > r.x1 || hz < r.z0 || hz > r.z1) continue;
      this.do("walk_to", () => this.g.walkTo({ x: p.x, y: p.y }));
      return true;
    }
    return false;
  }

  /**
   * Follow the walkable path toward a floor point by repeatedly walking to the furthest point along it
   * that's actually visible as floor (like rounding a kitchen island).
   */
  hopToward(target: Vec3): void {
    const { grid } = geo(this.g.world);
    for (let hop = 0; hop < 6; hop++) {
      if (Math.hypot(this.g.pose.x - target[0], this.g.pose.z - target[2]) < 0.4) return;
      const goal = grid.nearestOpen(target[0], target[2], 8);
      const path = grid.path(grid.nearestOpen(this.g.pose.x, this.g.pose.z, 5), (idx) => idx === goal);
      if (!path) return;
      let moved = false;
      for (let k = path.length - 1; k > 0 && !moved; k -= 2) {
        const [x, z] = grid.center(path[k]!);
        const room = this.g.world.rects.entries().find(([, r]) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)?.[0];
        if (room) moved = this.walkFloor([[x, 0, z]], room);
      }
      if (!moved) return;
    }
  }

  /** Face a thing and find a pixel on it, tilting a little if needed. */
  aim(id: string, loose = false): { x: number; y: number } {
    const b = this.box(id);
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    for (const dy of [0, 0.08, -0.08, 0.2, -0.2]) {
      this.face([c[0], c[1] + dy, c[2]]);
      const p = this.pixelFor(id, loose);
      if (p) return p;
    }
    throw new Error(`[${this.g.seed}] can't get a clear view of ${id} from ${JSON.stringify(this.g.pose)}`);
  }

  roomOf(id: string): string {
    return rootOf(this.g, this.t(id)).room!;
  }

  /** Walk through doorways (pointing at the floor beyond each one) until we're in `room`. */
  travel(room: string): void {
    const w = this.g.world;
    const prev = new Map<string, string>([[this.g.room, ""]]);
    const q = [this.g.room];
    while (q.length) {
      const r = q.shift()!;
      for (const d of w.doors) {
        if (!d.rooms.includes(r)) continue;
        const o = d.rooms[0] === r ? d.rooms[1] : d.rooms[0];
        if (!prev.has(o)) {
          prev.set(o, r);
          q.push(o);
        }
      }
    }
    const path: string[] = [];
    for (let r = room; r !== this.g.room; r = prev.get(r)!) path.unshift(r);
    for (const next of path) {
      const d = w.doors.find((d) => d.rooms.includes(this.g.room) && d.rooms.includes(next))!;
      const rect = w.rects.get(next)!;
      // Floor spots just past the doorway, inside the next room (and, as a fallback, just before it).
      const spots = (sign: number): Vec3[] => {
        const out: Vec3[] = [];
        for (const depth of [1.0, 1.4, 0.7, 1.9]) {
          for (const lat of [0, 0.2, -0.2]) {
            out.push(d.axis === "x" ? [d.x + lat, 0, d.z + sign * depth] : [d.x + sign * depth, 0, d.z + lat]);
          }
        }
        return out;
      };
      const inward = d.axis === "x" ? (rect.z0 >= d.z - 1e-6 ? 1 : -1) : rect.x0 >= d.x - 1e-6 ? 1 : -1;
      if (!this.walkFloor(spots(inward), next)) {
        const [first] = spots(inward);
        this.hopToward(first!);
        if (this.g.room !== next && !this.walkFloor(spots(inward), next)) {
          throw new Error(`[${this.g.seed}] couldn't see a way through the doorway to ${next} from ${JSON.stringify(this.g.pose)}`);
        }
      }
      if (this.g.room !== next) throw new Error(`[${this.g.seed}] walked toward ${next} but ended in ${this.g.room}`);
    }
  }

  /** Get within reach of a thing and return a pixel on it. */
  approach(id: string, loose = false): { x: number; y: number } {
    if (this.g.hands.includes(id)) throw new Error("approach() on a held item");
    if (this.roomOf(id) !== this.g.room) this.travel(this.roomOf(id));
    const tryAim = (target: string, isLoose: boolean): { x: number; y: number } | undefined => {
      try {
        return this.aim(target, isLoose);
      } catch {
        return undefined;
      }
    };
    const root = rootOf(this.g, this.t(id));
    for (let attempt = 0; attempt < 3 && !inReach(this.g, layoutBoxes(this.g), this.t(id)); attempt++) {
      // Walk up to the thing itself if it's in view, else to the furniture it's in or on.
      const p = tryAim(id, loose) ?? (root.id !== id ? tryAim(root.id, true) : undefined);
      if (p) {
        this.do("walk_to", () => this.g.walkTo(p));
        continue;
      }
      // Nothing in view: step to the middle of the room and look again.
      const r = this.g.world.rects.get(this.g.room)!;
      const { grid } = geo(this.g.world);
      const [mx, mz] = grid.center(grid.nearestOpen((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2));
      if (!this.walkFloor([[mx, 0, mz]], this.g.room)) break;
    }
    const first = (() => {
      try {
        return this.aim(id, loose);
      } catch {
        return undefined;
      }
    })();
    if (first) return first;
    // In reach but hidden behind a neighbour from this angle: step to just in front of the item itself.
    const b = this.box(id);
    const [fx, fz] = root.facing ?? [0, 1];
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const rb = this.box(root.id);
    const toFront = Math.abs(fx) > 0.5 ? (fx > 0 ? rb.max[0] - cx : cx - rb.min[0]) : fz > 0 ? rb.max[2] - cz : cz - rb.min[2];
    this.hopToward([cx + fx * (toFront + 0.5), 0, cz + fz * (toFront + 0.5)]);
    return this.aim(id, loose);
  }

  /** Open every closed container hiding a thing, then return a pixel on it. */
  reveal(id: string): void {
    const chain: Thing[] = [];
    for (let p = this.t(id).parent; p && p !== "hands"; p = this.t(p).parent) chain.unshift(this.t(p));
    for (const c of chain) {
      if (c.container?.openable && !c.container.open) {
        const p = this.approach(c.id);
        this.do("open", () => this.g.open(p));
      }
    }
  }

  take(id: string): void {
    if (this.g.hands.includes(id)) return;
    this.reveal(id);
    const p = this.approach(id);
    this.do("take", () => this.g.take(p));
  }

  put(id: string, dest: string): void {
    this.reveal(dest);
    const p = this.approach(dest, true);
    this.do("put", () => this.g.put(this.hand(id), p));
  }

  stash(id: string): void {
    this.put(id, "counter");
  }

  pour(src: string, dst: string, amount?: number): void {
    const dest = this.g.hands.includes(dst) ? { hand: this.hand(dst) } : this.approach(dst);
    this.do("pour", () => this.g.pour(this.hand(src), dest, amount));
  }

  plug(id: string): void {
    if (this.t(id).plugged) return;
    // Pointing at a kettle sitting on its base is fine: the base is what gets plugged in.
    const p = this.approach(id, true);
    this.do("plug_in", () => this.g.plugIn(p));
  }

  switchOn(id: string): void {
    const p = this.approach(id);
    this.do("switch_on", () => this.g.switchOn(p));
  }

  switchOff(id: string): void {
    const p = this.approach(id);
    this.do("switch_off", () => this.g.switchOff(p));
  }

  fillAtSink(id: string, ml?: number): void {
    this.take(id);
    const sink = this.g.world.recipe.sink;
    const p = this.approach(sink, true);
    this.do("fill", () => this.g.fill(this.hand(id), p, ml));
  }

  wait(minutes: number): void {
    this.do("wait", () => this.g.wait(minutes));
  }

  /** Produces ground coffee in a held container; returns its id. */
  grounds(grams: number): string {
    const r = this.g.world.recipe;
    if (!r.beans) {
      this.take(r.coffee);
      return r.coffee;
    }
    const grinder = r.grinder!;
    this.take(grinder);
    this.stash(grinder);
    this.plug(grinder);
    this.take(r.coffee);
    this.pour(r.coffee, grinder, grams);
    this.stash(r.coffee);
    this.switchOn(grinder);
    this.take(grinder);
    return grinder;
  }

  lightStove(keep: string): void {
    for (const c of this.g.children("stove")) {
      if (c.id === keep) continue;
      this.take(c.id);
      this.stash(c.id);
    }
    this.switchOn("stove");
  }

  hotWater(ml: number): string {
    const r = this.g.world.recipe;
    const h = this.t(r.heater!);
    this.fillAtSink(h.id, ml);
    if (h.kind === "kettle") {
      const base = [...this.g.world.things.values()].find((t) => t.kind === "kettle_base")!;
      this.put(h.id, base.id);
      this.plug(base.id);
      this.switchOn(h.id);
    } else {
      this.put(h.id, "stove");
      this.lightStove(h.id);
    }
    while (h.vessel!.temp < 95) this.wait(0.5);
    if (h.kind === "stovetop_kettle") this.switchOff("stove");
    this.take(h.id);
    return h.id;
  }

  mug(): string {
    const r = this.g.world.recipe;
    const mug = r.mugs[0]!;
    if (r.mugsDirty) {
      this.take(mug);
      const p = this.approach(r.sink, true);
      this.do("wash", () => this.g.wash(this.hand(mug), p));
    } else this.take(mug);
    this.stash(mug);
    return mug;
  }

  play(): Game {
    const g = this.g;
    const r = g.world.recipe;
    const note = [...g.world.things.values()].find((t) => t.kind === "note")!;
    const np = this.approach(note.id);
    this.do("examine", () => g.examine(np), false);
    const mug = this.mug();
    if (g.world.pref.milk && !this.opts.skipMilk) {
      this.take(r.milk!);
      this.stash(r.milk!);
    }
    if (g.world.pref.sugar) {
      this.take(r.sugar!);
      this.stash(r.sugar!);
    }

    if (r.method === "drip") {
      const cm = r.brewer!;
      const carafe = [...g.world.things.values()].find((t) => t.kind === "carafe")!;
      this.fillAtSink(carafe.id, 600);
      this.pour(carafe.id, cm);
      this.put(carafe.id, cm);
      this.plug(cm);
      const filter = g.children(r.filters!)[0]!;
      this.take(filter.id);
      this.put(filter.id, cm);
      const src = this.grounds(36);
      this.pour(src, cm, 36);
      this.stash(src);
      this.switchOn(cm);
      this.wait(2);
      this.take(carafe.id);
      this.pour(carafe.id, mug, 250);
      this.stash(carafe.id);
    } else if (r.method === "press") {
      const press = r.brewer!;
      this.take(press);
      this.stash(press);
      const src = this.grounds(30);
      this.pour(src, press, 30);
      this.stash(src);
      const kettle = this.hotWater(500);
      this.pour(kettle, press, 500);
      this.stash(kettle);
      this.wait(4);
      const p = this.approach(press);
      this.do("press_plunger", () => g.press(p));
      this.take(press);
      this.pour(press, mug, 250);
      this.stash(press);
    } else if (r.method === "moka") {
      const moka = r.brewer!;
      this.fillAtSink(moka);
      const src = this.grounds(18);
      this.pour(src, moka, 18);
      this.stash(src);
      this.put(moka, "stove");
      this.lightStove(moka);
      const v = this.t(moka).vessel!;
      while ((v.stuff.water ?? 0) > 0) this.wait(0.5);
      if (!this.opts.leaveStoveOn) this.switchOff("stove");
      this.take(moka);
      this.pour(moka, mug);
      this.stash(moka);
    } else {
      const kettle = this.hotWater(300);
      this.pour(kettle, mug, 250);
      this.stash(kettle);
      this.take(r.coffee);
      this.pour(r.coffee, mug, 2);
      this.stash(r.coffee);
    }

    if (g.world.pref.milk && !this.opts.skipMilk) {
      this.take(r.milk!);
      this.pour(r.milk!, mug, 30);
      this.stash(r.milk!);
    }
    if (g.world.pref.sugar) {
      this.take(r.sugar!);
      this.pour(r.sugar!, mug, 5);
      this.stash(r.sugar!);
    }
    this.take(mug);
    this.do("serve", () => g.serve(this.hand(mug)));
    return g;
  }
}

