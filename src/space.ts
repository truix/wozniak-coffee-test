// Everything spatial at runtime: where each item sits, what the agent can see, what a pixel points at,
// what's within reach, and walking. Pure maths over boxes, so the server stays authoritative and the
// renderer only draws the Snapshot.

import { footDistance, footprints, REACH, WalkGrid, type Rect } from "./layout";
import {
  DOOR_HEIGHT,
  DRAWER_TRAVEL,
  EYE_HEIGHT,
  FOV_Y,
  HELD_POSE,
  heldSize,
  VIEW_H,
  VIEW_W,
  WALL_HEIGHT,
  type SnapCamera,
  type SnapFill,
  type Snapshot,
  type SnapThing,
  type Vec3,
} from "./snapshot";
import { liquid, solid, volume, type Stuff, type Thing, type World } from "./world";

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** The slice of game state space needs; avoids a runtime import cycle with engine.ts. */
export interface Scene {
  world: World;
  pose: Pose;
  hands: (string | null)[];
  thing(id: string): Thing;
  children(id: string): Thing[];
}

export const PITCH_MIN = -1.3;
export const PITCH_MAX = 0.8;

// ---- item placement --------------------------------------------------------

const DIMS: Partial<Record<Thing["kind"], Vec3>> = {
  mug: [0.09, 0.1, 0.09],
  kettle: [0.17, 0.24, 0.15],
  kettle_base: [0.18, 0.03, 0.18],
  stovetop_kettle: [0.22, 0.22, 0.22],
  carafe: [0.14, 0.18, 0.14],
  french_press: [0.12, 0.25, 0.12],
  moka_pot: [0.11, 0.2, 0.11],
  coffee_maker: [0.25, 0.35, 0.25],
  grinder: [0.11, 0.2, 0.11],
  microwave: [0.48, 0.28, 0.36],
  filter: [0.1, 0.07, 0.1],
  box: [0.14, 0.08, 0.11],
  note: [0.15, 0.01, 0.1],
};

const MISC_DIMS: [RegExp, Vec3][] = [
  [/plates|china|bowls|casserole/, [0.24, 0.08, 0.24]],
  [/glasses/, [0.2, 0.12, 0.1]],
  [/spice rack/, [0.3, 0.2, 0.1]],
  [/toolbox/, [0.4, 0.2, 0.2]],
  [/laundry|cushion/, [0.4, 0.15, 0.35]],
  [/board game|placemats|tablecloth/, [0.3, 0.06, 0.3]],
  [/magazines|menus|junk mail|tea towels/, [0.25, 0.03, 0.2]],
  [/row of books/, [0.5, 0.24, 0.18]],
  [/paperback/, [0.13, 0.03, 0.2]],
  [/coffee-table book/, [0.3, 0.04, 0.25]],
  [/pan|baking tray/, [0.3, 0.1, 0.3]],
  [/umbrella/, [0.08, 0.6, 0.08]],
  [/shoes/, [0.3, 0.12, 0.28]],
  [/fruit bowl/, [0.28, 0.12, 0.28]],
  [/paper towels|bottle|oil|ketchup|detergent|cleaning spray|bottled water/, [0.08, 0.25, 0.08]],
];

export function itemDims(t: Thing): Vec3 {
  const known = DIMS[t.kind];
  if (known) return known;
  if (t.kind === "package") {
    if (t.name === "salt shaker") return [0.05, 0.1, 0.05];
    if (t.material === "paper") return [0.12, 0.2, 0.07];
    if (t.material === "glass") return [0.09, 0.13, 0.09];
    if (t.material === "cardboard") return [0.08, 0.22, 0.08];
    if (t.material === "ceramic") return [0.11, 0.15, 0.11];
    return [0.09, 0.12, 0.09];
  }
  for (const [re, d] of MISC_DIMS) if (re.test(t.name)) return d;
  return [0.14, 0.16, 0.1];
}

interface Shelf {
  y: number;
  uLo: number;
  uHi: number;
  vLo: number;
  vHi: number;
}

/** Local frame of a facing box: u along its width, v from the front face inward, absolute y. */
class Frame {
  readonly w: number;
  readonly d: number;
  readonly ax: number;
  readonly az: number;
  readonly fx: number;
  readonly fz: number;
  readonly frontX: number;
  readonly frontZ: number;

  constructor(box: Box, facing: [number, number]) {
    [this.fx, this.fz] = facing;
    this.ax = -this.fz;
    this.az = this.fx;
    const ex = box.max[0] - box.min[0];
    const ez = box.max[2] - box.min[2];
    const alongX = Math.abs(this.fx) < 0.5;
    this.w = alongX ? ex : ez;
    this.d = alongX ? ez : ex;
    const cx = (box.min[0] + box.max[0]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    this.frontX = cx + this.fx * (this.d / 2);
    this.frontZ = cz + this.fz * (this.d / 2);
  }

  /** World box for an item centred at (u, v) standing on y. */
  place(u: number, v: number, y: number, dims: Vec3): Box {
    const cx = this.frontX + this.ax * u - this.fx * v;
    const cz = this.frontZ + this.az * u - this.fz * v;
    const alongX = Math.abs(this.fx) < 0.5;
    const hx = (alongX ? dims[0] : dims[2]) / 2;
    const hz = (alongX ? dims[2] : dims[0]) / 2;
    return { min: [cx - hx, y, cz - hz], max: [cx + hx, y + dims[1], cz + hz] };
  }
}

function shelvesOf(t: Thing, box: Box, f: Frame): Shelf[] {
  const full = (y: number, inset = 0.03): Shelf => ({ y, uLo: -f.w / 2 + inset, uHi: f.w / 2 - inset, vLo: inset, vHi: f.d - inset });
  const name = t.name;
  if (t.kind === "surface") {
    if (name === "sofa") return [{ ...full(0.45, 0.1), vHi: f.d - 0.35 }];
    return [full(box.max[1])];
  }
  if (t.kind === "stove") return [full(box.max[1], 0.08)];
  if (t.kind === "sink") return [full(name === "bathroom sink" ? 0.7 : 0.72, 0.1)];
  if (t.kind === "drawer") return [full(box.min[1] + 0.03)];
  if (t.kind === "dishwasher") return [0.2, 0.5].map((y) => full(y));
  if (t.kind === "fridge") return (name === "garage fridge" ? [0.3, 0.75] : [0.3, 0.7, 1.1, 1.45]).map((y) => full(y));
  if (t.kind === "shelf") return t.placement === "upper" ? [full(box.min[1])] : [0.05, 0.5, 0.95, 1.4].map((y) => full(y));
  if (name === "washing machine") return [full(0.2, 0.1)];
  if (name === "mirror cabinet") return [box.min[1] + 0.03, box.min[1] + 0.3].map((y) => full(y, 0.02));
  if (t.placement === "upper") return [box.min[1] + 0.03, box.min[1] + 0.36].map((y) => full(y));
  if (t.kind === "cabinet") return [0.08, 0.48].map((y) => full(y));
  if (t.kind === "microwave") return [full(box.min[1] + 0.03, 0.06)];
  if (t.kind === "kettle_base") return [{ y: box.max[1], uLo: -0.09, uHi: 0.09, vLo: 0, vHi: f.d }];
  if (t.kind === "box") return [{ y: box.min[1] + 0.01, uLo: -0.05, uHi: 0.05, vLo: 0.005, vHi: f.d }];
  return [full(box.max[1])];
}

/** Lay children out on shelves in centred rows: fill a shelf, then the next, then a row behind. */
function placeChildren(scene: Scene, parent: Thing, box: Box, facing: [number, number], out: Map<string, Box>): void {
  const kids = scene.children(parent.id);
  if (!kids.length) return;
  const f = new Frame(box, facing);
  const put = (k: Thing, b: Box): void => {
    out.set(k.id, b);
    placeChildren(scene, k, b, facing, out);
  };
  if (parent.kind === "coffee_maker") {
    for (const k of kids) {
      const dims = itemDims(k);
      put(k, f.place(0, dims[2] / 2 + 0.01, box.min[1] + 0.02, dims));
    }
    return;
  }
  const shelves = shelvesOf(parent, box, f);
  if (parent.kind === "box" || parent.kind === "kettle_base") {
    const shelf = shelves[0]!;
    for (const k of kids) {
      const dims = itemDims(k);
      put(k, f.place(0, Math.min(shelf.vLo + dims[2] / 2, shelf.vHi - dims[2] / 2), shelf.y, dims));
    }
    return;
  }
  // First pass: assign each child to a (shelf, row) and an offset along the row.
  const rows: { shelf: Shelf; v0: number; items: { k: Thing; dims: Vec3; u: number }[]; width: number }[] = [];
  let s = 0;
  let depthOffset = 0;
  let rowDepth = 0;
  let cur = { shelf: shelves[0]!, v0: 0, items: [] as { k: Thing; dims: Vec3; u: number }[], width: 0 };
  rows.push(cur);
  for (const k of kids) {
    const dims = itemDims(k);
    const span = cur.shelf.uHi - cur.shelf.uLo;
    if (cur.items.length && cur.width + dims[0] > span) {
      s++;
      if (s >= shelves.length) {
        s = 0;
        depthOffset += rowDepth + 0.02;
        rowDepth = 0;
      }
      cur = { shelf: shelves[s]!, v0: depthOffset, items: [], width: 0 };
      rows.push(cur);
    }
    cur.items.push({ k, dims, u: cur.width });
    cur.width += dims[0] + 0.03;
    rowDepth = Math.max(rowDepth, dims[2]);
  }
  // Second pass: centre each row on its shelf.
  for (const row of rows) {
    const { shelf } = row;
    const used = row.width - 0.03;
    const start = Math.max(shelf.uLo, (shelf.uLo + shelf.uHi) / 2 - used / 2);
    for (const { k, dims, u } of row.items) {
      const uc = Math.min(start + u + dims[0] / 2, shelf.uHi - dims[0] / 2);
      const v = Math.min(shelf.vLo + row.v0 + dims[2] / 2, shelf.vHi - dims[2] / 2);
      put(k, f.place(uc, v, shelf.y, dims));
    }
  }
}

/** World boxes of everything not in the agent's hands. */
export function layoutBoxes(scene: Scene): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const t of scene.world.things.values()) {
    if (t.parent || !t.box) continue;
    let box: Box = t.box;
    if (t.kind === "drawer" && t.container?.open) {
      const [fx, fz] = t.facing!;
      box = {
        min: [box.min[0] + fx * DRAWER_TRAVEL, box.min[1], box.min[2] + fz * DRAWER_TRAVEL],
        max: [box.max[0] + fx * DRAWER_TRAVEL, box.max[1], box.max[2] + fz * DRAWER_TRAVEL],
      };
    }
    out.set(t.id, box);
    placeChildren(scene, t, box, t.facing!, out);
  }
  return out;
}

export function rootOf(scene: Scene, t: Thing): Thing {
  let cur = t;
  while (cur.parent && cur.parent !== "hands") cur = scene.thing(cur.parent);
  return cur;
}

/** Inside something closed (a shut cabinet, a closed microwave...). */
export function hiddenInside(scene: Scene, t: Thing): boolean {
  for (let p = t.parent; p && p !== "hands"; p = scene.thing(p).parent) {
    if (!scene.thing(p).container?.open) return true;
  }
  return false;
}

export function isHeld(scene: Scene, t: Thing): boolean {
  for (let p: string | null = t.id; p; p = scene.thing(p).parent) {
    if (scene.thing(p).parent === "hands") return true;
  }
  return false;
}

// ---- geometry helpers ------------------------------------------------------

interface Geo {
  grid: WalkGrid;
  walls: Box[];
}

const geoCache = new WeakMap<World, Geo>();

export function geo(world: World): Geo {
  let g = geoCache.get(world);
  if (!g) {
    g = {
      grid: new WalkGrid([...world.rects.values()], world.doors, footprints(world.things.values())),
      walls: wallBoxes(world),
    };
    geoCache.set(world, g);
  }
  return g;
}

function wallBoxes(world: World): Box[] {
  const out: Box[] = [];
  const T = 0.05;
  for (const r of world.rects.values()) {
    const edges: { axis: "x" | "z"; at: number; lo: number; hi: number }[] = [
      { axis: "x", at: r.z0, lo: r.x0, hi: r.x1 },
      { axis: "x", at: r.z1, lo: r.x0, hi: r.x1 },
      { axis: "z", at: r.x0, lo: r.z0, hi: r.z1 },
      { axis: "z", at: r.x1, lo: r.z0, hi: r.z1 },
    ];
    for (const e of edges) {
      const gaps = world.doors
        .filter((d) => d.axis === e.axis && Math.abs((e.axis === "x" ? d.z : d.x) - e.at) < 1e-6)
        .map((d) => {
          const c = e.axis === "x" ? d.x : d.z;
          return [c - d.width / 2, c + d.width / 2] as const;
        })
        .filter(([a, b]) => b > e.lo && a < e.hi)
        .sort((a, b) => a[0] - b[0]);
      const push = (lo: number, hi: number, y0: number, y1: number): void => {
        if (hi - lo < 1e-3) return;
        out.push(
          e.axis === "x"
            ? { min: [lo, y0, e.at - T], max: [hi, y1, e.at + T] }
            : { min: [e.at - T, y0, lo], max: [e.at + T, y1, hi] },
        );
      };
      let cur = e.lo;
      for (const [a, b] of gaps) {
        push(cur, a, 0, WALL_HEIGHT);
        push(a, b, DOOR_HEIGHT, WALL_HEIGHT);
        cur = b;
      }
      push(cur, e.hi, 0, WALL_HEIGHT);
    }
  }
  return out;
}

export function roomAt(world: World, x: number, z: number, fallback: string): string {
  for (const [id, r] of world.rects) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return id;
  return fallback;
}

/** Slab-method ray/box intersection: [tEnter, tExit] or null. */
function rayBox(o: Vec3, d: Vec3, b: Box, pad = 0): [number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = b.min[i]! - pad;
    const hi = b.max[i]! + pad;
    if (Math.abs(d[i]!) < 1e-12) {
      if (o[i]! < lo || o[i]! > hi) return null;
      continue;
    }
    let a = (lo - o[i]!) / d[i]!;
    let c = (hi - o[i]!) / d[i]!;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : [t0, t1];
}

// ---- camera ----------------------------------------------------------------

export class View {
  readonly eye: Vec3;
  readonly f: Vec3;
  readonly r: Vec3;
  readonly u: Vec3;
  readonly tanY: number;
  readonly tanX: number;

  /** The agent's own eyes at a pose, or an examine close-up camera (aimed with up = +y, like Three.js lookAt). */
  constructor(src: Pose | SnapCamera, fovY = FOV_Y) {
    if ("eye" in src) {
      this.eye = [...src.eye];
      const d: Vec3 = [src.target[0] - src.eye[0], src.target[1] - src.eye[1], src.target[2] - src.eye[2]];
      const len = Math.hypot(...d) || 1;
      this.f = [d[0] / len, d[1] / len, d[2] / len];
      // r = f x up
      const rl = Math.hypot(this.f[0], this.f[2]);
      this.r = rl > 1e-6 ? [-this.f[2] / rl, 0, this.f[0] / rl] : [1, 0, 0];
      fovY = src.fovY;
    } else {
      const { yaw, pitch } = src;
      this.eye = [src.x, EYE_HEIGHT, src.z];
      const cp = Math.cos(pitch);
      this.f = [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
      this.r = [Math.cos(yaw), 0, Math.sin(yaw)];
    }
    // u = r x f
    const [rx, ry, rz] = this.r;
    const [fx, fy, fz] = this.f;
    this.u = [ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx];
    this.tanY = Math.tan(((fovY / 2) * Math.PI) / 180);
    this.tanX = this.tanY * (VIEW_W / VIEW_H);
  }

  /** Pixel position of a world point, or null if behind the camera. */
  project(p: Vec3): { x: number; y: number; depth: number } | null {
    const rel: Vec3 = [p[0] - this.eye[0], p[1] - this.eye[1], p[2] - this.eye[2]];
    const depth = dot(rel, this.f);
    if (depth < 0.05) return null;
    const nx = dot(rel, this.r) / (depth * this.tanX);
    const ny = dot(rel, this.u) / (depth * this.tanY);
    return { x: ((nx + 1) / 2) * VIEW_W, y: ((1 - ny) / 2) * VIEW_H, depth };
  }

  ray(px: number, py: number): Vec3 {
    const nx = (2 * px) / VIEW_W - 1;
    const ny = 1 - (2 * py) / VIEW_H;
    const d: Vec3 = [
      this.f[0] + this.r[0] * nx * this.tanX + this.u[0] * ny * this.tanY,
      this.f[1] + this.r[1] * nx * this.tanX + this.u[1] * ny * this.tanY,
      this.f[2] + this.r[2] * nx * this.tanX + this.u[2] * ny * this.tanY,
    ];
    const len = Math.hypot(...d);
    return [d[0] / len, d[1] / len, d[2] / len];
  }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const center = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** Things whose boxes can block a line of sight to `t` (closed bodies of furniture). */
function blocked(scene: Scene, boxes: Map<string, Box>, eye: Vec3, p: Vec3, t: Thing): boolean {
  const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const dist = Math.hypot(...d);
  const dir: Vec3 = [d[0] / dist, d[1] / dist, d[2] / dist];
  for (const w of geo(scene.world).walls) {
    const hit = rayBox(eye, dir, w);
    if (hit && hit[0] > 0 && hit[0] < dist - 0.02) return true;
  }
  const ancestors = new Set<string>();
  for (let q = t.parent; q && q !== "hands"; q = scene.thing(q).parent) ancestors.add(q);
  for (const f of scene.world.things.values()) {
    if (f.parent || f.id === t.id || ancestors.has(f.id) || f.placement === undefined) continue;
    const b = boxes.get(f.id);
    if (!b) continue;
    const hit = rayBox(eye, dir, b);
    if (hit && hit[0] > 0 && hit[0] < dist - 0.02) return true;
  }
  return false;
}

/** On screen and not hidden behind walls or furniture. Returns the visible pixel, if any. */
export function visiblePoint(scene: Scene, boxes: Map<string, Box>, view: View, t: Thing): { x: number; y: number } | null {
  if (hiddenInside(scene, t) || isHeld(scene, t)) return null;
  const b = boxes.get(t.id);
  if (!b) return null;
  const c = center(b);
  const samples: Vec3[] = [
    c,
    [c[0], b.max[1] - 0.01, c[2]],
    [c[0], b.min[1] + 0.02, c[2]],
    [b.min[0] + 0.02, c[1], b.min[2] + 0.02],
    [b.max[0] - 0.02, c[1], b.max[2] - 0.02],
  ];
  for (const s of samples) {
    const p = view.project(s);
    if (!p || p.x < 2 || p.y < 2 || p.x > VIEW_W - 2 || p.y > VIEW_H - 2) continue;
    if (!blocked(scene, boxes, view.eye, s, t)) return { x: p.x, y: p.y };
  }
  return null;
}

export type PickResult =
  | { kind: "thing"; thing: Thing; point: Vec3 }
  | { kind: "floor"; point: Vec3 }
  | { kind: "wall"; point: Vec3 }
  | { kind: "ceiling" }
  | { kind: "nothing" };

/**
 * The box a pointing ray is tested against. Usually the layout box; parts drawn outside it are added so a
 * click on them still counts (the raised plunger knob of a French press sticks up well above its body).
 */
function hitBox(t: Thing, b: Box): Box {
  if (t.kind === "french_press" && !t.pressed) return { min: b.min, max: [b.max[0], b.max[1] + 0.14, b.max[2]] };
  return b;
}

/**
 * Looking at a coffee maker, only the open space in front of its tower (the warming plate, below the hood)
 * shows what stands on it. A ray entering higher up is on the hood, buttons or basket: that's the machine.
 */
function seesInto(parent: Thing, box: Box, entryY: number): boolean {
  if (parent.kind === "coffee_maker") return entryY < box.min[1] + (box.max[1] - box.min[1]) * 0.6;
  return true;
}

interface RayHit {
  t: Thing;
  enter: number;
  exit: number;
  /** The ray is on the item itself, not just in the padding around it. */
  exact: boolean;
}

/**
 * What is under pixel (px, py), seen through `view` (the agent's eyes by default), plus every visible thing
 * the ray passes through before a wall, nearest first (for "the thing behind it" fallbacks).
 */
export function pickRay(scene: Scene, boxes: Map<string, Box>, px: number, py: number, view = new View(scene.pose)): { result: PickResult; along: Thing[] } {
  const o = view.eye;
  const d = view.ray(px, py);
  let tWall = Infinity;
  for (const w of geo(scene.world).walls) {
    const hit = rayBox(o, d, w);
    if (hit && hit[0] > 0 && hit[0] < tWall) tWall = hit[0];
  }
  const hits: RayHit[] = [];
  for (const t of scene.world.things.values()) {
    if (hiddenInside(scene, t) || isHeld(scene, t)) continue;
    const b = boxes.get(t.id);
    if (!b) continue;
    const hb = hitBox(t, b);
    // Small items get a little padding, but a ray that's really on an item beats one that only grazes the
    // padding of its neighbor.
    const pad = t.parent ? 0.015 : 0;
    const hit = rayBox(o, d, hb, pad);
    if (!hit || hit[0] >= tWall) continue;
    hits.push({ t, enter: Math.max(0, hit[0]), exit: hit[1], exact: pad === 0 || rayBox(o, d, hb) !== null });
  }
  hits.sort((a, b) => a.enter + (a.exact ? 0 : 0.03) - (b.enter + (b.exact ? 0 : 0.03)));
  const along = hits.map((h) => h.t);
  if (hits[0]) {
    let best: RayHit = hits[0];
    // Looking into an open cabinet / onto a counter: prefer the thing inside or on it.
    for (;;) {
      const cur: RayHit = best;
      if (!seesInto(cur.t, boxes.get(cur.t.id)!, o[1] + d[1] * cur.enter)) break;
      const inner: RayHit | undefined = hits
        .filter((h) => h !== cur && h.enter <= cur.exit + 0.05 && descends(scene, h.t, cur.t))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.enter - b.enter)[0];
      if (!inner) break;
      best = inner;
    }
    const tHit = best.enter;
    return { result: { kind: "thing", thing: best.t, point: [o[0] + d[0] * tHit, o[1] + d[1] * tHit, o[2] + d[2] * tHit] }, along };
  }
  if (d[1] < 0) {
    const tFloor = -o[1] / d[1];
    if (tFloor < tWall) return { result: { kind: "floor", point: [o[0] + d[0] * tFloor, 0, o[2] + d[2] * tFloor] }, along };
  }
  if (d[1] > 0 && (WALL_HEIGHT - o[1]) / d[1] < tWall) return { result: { kind: "ceiling" }, along };
  if (!Number.isFinite(tWall)) return { result: { kind: "nothing" }, along };
  return { result: { kind: "wall", point: [o[0] + d[0] * tWall, o[1] + d[1] * tWall, o[2] + d[2] * tWall] }, along };
}

/** What is under pixel (px, py) in the agent's current view (or through `view`). */
export function pick(scene: Scene, boxes: Map<string, Box>, px: number, py: number, view?: View): PickResult {
  return pickRay(scene, boxes, px, py, view).result;
}

/**
 * Screen rectangle of what's in each hand in the agent's own first-person view (the held overlay is drawn on
 * top of everything, so these pixels always mean the held item). Index 0 = right hand, 1 = left.
 */
export function heldRects(scene: Scene): ({ x0: number; y0: number; x1: number; y1: number } | null)[] {
  const tanY = Math.tan(((FOV_Y / 2) * Math.PI) / 180);
  const tanX = tanY * (VIEW_W / VIEW_H);
  return scene.hands.map((id, i) => {
    if (!id) return null;
    const [w, h, d] = heldSize(scene.thing(id));
    const side = i === 0 ? 1 : -1;
    // Three.js Euler "XYZ": v' = Rx(pitch) * Ry(yaw) * v
    const a = HELD_POSE.pitch;
    const b = -side * HELD_POSE.yaw;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    for (const lx of [-w / 2, w / 2]) {
      for (const ly of [-h * HELD_POSE.drop, h * (1 - HELD_POSE.drop)]) {
        for (const lz of [-d / 2, d / 2]) {
          const yx = lx * Math.cos(b) + lz * Math.sin(b);
          const yz = -lx * Math.sin(b) + lz * Math.cos(b);
          const cx = side * HELD_POSE.x + yx;
          const cy = HELD_POSE.y + ly * Math.cos(a) - yz * Math.sin(a);
          const cz = HELD_POSE.z + ly * Math.sin(a) + yz * Math.cos(a);
          const px = ((cx / (-cz * tanX) + 1) / 2) * VIEW_W;
          const py = ((1 - cy / (-cz * tanY)) / 2) * VIEW_H;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
        }
      }
    }
    // a few pixels of slack; the hand and forearm below the item count too
    return { x0: Math.max(0, x0 - 6), y0: Math.max(0, y0 - 6), x1: Math.min(VIEW_W, x1 + 6), y1: VIEW_H };
  });
}

/**
 * The camera and stand-in box for holding an item up in front of your eyes (examine with a hand). The box
 * has the item's in-hand size, so flat things like the note are held upright, facing you, and readable.
 */
export function inspectView(scene: Scene, id: string): { camera: SnapCamera; box: Box } {
  const view = new View({ ...scene.pose, pitch: -0.15 });
  const [w, h, d] = heldSize(scene.thing(id));
  const c: Vec3 = [view.eye[0] + view.f[0] * 0.42, view.eye[1] - 0.05, view.eye[2] + view.f[2] * 0.42];
  // Its width runs across your view: along z when you face mostly along x.
  const [hx, hz] = Math.abs(view.f[0]) > Math.abs(view.f[2]) ? [d / 2, w / 2] : [w / 2, d / 2];
  return {
    camera: { eye: view.eye, target: c, fovY: 40 },
    box: { min: [c[0] - hx, c[1] - h / 2, c[2] - hz], max: [c[0] + hx, c[1] + h / 2, c[2] + hz] },
  };
}

/** Does the ray through pixel (px, py) of `view` pass through `box`? */
export function rayHits(view: View, px: number, py: number, box: Box): boolean {
  return rayBox(view.eye, view.ray(px, py), box) !== null;
}

function descends(scene: Scene, t: Thing, ancestor: Thing): boolean {
  for (let p = t.parent; p && p !== "hands"; p = scene.thing(p).parent) if (p === ancestor.id) return true;
  return false;
}

export function inReach(scene: Scene, boxes: Map<string, Box>, t: Thing): boolean {
  if (isHeld(scene, t)) return true;
  const b = boxes.get(t.id);
  if (!b) return false;
  return footDistance(scene.pose.x, scene.pose.z, b.min, b.max) <= REACH && b.min[1] <= 2.3;
}

export function distanceTo(scene: Scene, boxes: Map<string, Box>, t: Thing): number {
  const b = boxes.get(t.id);
  if (!b) return 0;
  return footDistance(scene.pose.x, scene.pose.z, b.min, b.max);
}

// ---- movement --------------------------------------------------------------

/** Straight-line step with collision. Returns metres actually moved. */
export function move(scene: Scene, forward: number, right: number): number {
  const { grid } = geo(scene.world);
  const { yaw } = scene.pose;
  const dx = Math.sin(yaw) * forward + Math.cos(yaw) * right;
  const dz = -Math.cos(yaw) * forward + Math.sin(yaw) * right;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return 0;
  const steps = Math.ceil(dist / 0.05);
  let moved = 0;
  for (let i = 1; i <= steps; i++) {
    const x = scene.pose.x + (dx / steps);
    const z = scene.pose.z + (dz / steps);
    if (!grid.free(x, z)) break;
    scene.pose.x = x;
    scene.pose.z = z;
    moved += dist / steps;
  }
  return moved;
}

function face(scene: Scene, p: Vec3): void {
  const dx = p[0] - scene.pose.x;
  const dz = p[2] - scene.pose.z;
  scene.pose.yaw = Math.atan2(dx, -dz);
  scene.pose.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.atan2(p[1] - EYE_HEIGHT, Math.hypot(dx, dz))));
}

/**
 * Walk to stand within reach of a box, preferably square in front of it (along `facing`), then face it;
 * or walk to a floor point. Returns metres walked, or null if there's no way there.
 */
export function walkTo(scene: Scene, target: { box: Box; facing: [number, number] } | { point: Vec3 }): number | null {
  const { grid } = geo(scene.world);
  const start = grid.isOpen(grid.index(scene.pose.x, scene.pose.z))
    ? grid.index(scene.pose.x, scene.pose.z)
    : grid.nearestOpen(scene.pose.x, scene.pose.z, 5);
  let dest = -1;
  if ("box" in target) {
    const { min, max } = target.box;
    const dist = grid.distances(start);
    const c = center(target.box);
    const [fx, fz] = target.facing;
    const halfDepth = Math.abs(fx) > 0.5 ? (max[0] - min[0]) / 2 : (max[2] - min[2]) / 2;
    const ideal = [c[0] + fx * (halfDepth + 0.45), c[2] + fz * (halfDepth + 0.45)] as const;
    let best = Infinity;
    for (let idx = 0; idx < dist.length; idx++) {
      if (dist[idx]! < 0) continue;
      const [x, z] = grid.center(idx);
      if (footDistance(x, z, min, max) > REACH - 0.2) continue;
      // Mostly "stand in front of it", a little "don't walk further than needed".
      const score = Math.hypot(x - ideal[0], z - ideal[1]) + dist[idx]! * WalkGrid.CELL * 0.15;
      if (score < best) {
        best = score;
        dest = idx;
      }
    }
  } else {
    // The open cell nearest the spot that you can actually get to, preferring the room the spot is in (the
    // straight-line nearest open cell can be on the far side of a wall).
    const dist = grid.distances(start);
    const [tx, , tz] = target.point;
    const room = roomAt(scene.world, tx, tz, "");
    const R = 10;
    const ci = Math.floor((tx - grid.x0) / WalkGrid.CELL);
    const cj = Math.floor((tz - grid.z0) / WalkGrid.CELL);
    let best = Infinity;
    for (let j = cj - R; j <= cj + R; j++) {
      for (let i = ci - R; i <= ci + R; i++) {
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) continue;
        const idx = i + j * grid.nx;
        if (dist[idx]! < 0) continue;
        const [x, z] = grid.center(idx);
        const away = Math.hypot(x - tx, z - tz);
        if (away > R * WalkGrid.CELL) continue;
        const score = away + (room && roomAt(scene.world, x, z, "") !== room ? 1.5 : 0);
        if (score < best) {
          best = score;
          dest = idx;
        }
      }
    }
  }
  if (dest < 0) return null;
  const path = grid.path(start, (idx) => idx === dest);
  if (!path) return null;
  let walked = 0;
  let [px, pz] = [scene.pose.x, scene.pose.z];
  for (const idx of path.slice(1)) {
    const [x, z] = grid.center(idx);
    walked += Math.hypot(x - px, z - pz);
    [px, pz] = [x, z];
  }
  // End up facing the way you were heading overall (the last grid step is often a diagonal jog).
  const [sx, sz] = [scene.pose.x, scene.pose.z];
  if (Math.hypot(px - sx, pz - sz) > 0.2) scene.pose.yaw = Math.atan2(px - sx, -(pz - sz));
  scene.pose.x = px;
  scene.pose.z = pz;
  if ("box" in target) {
    // Look at the working height: the top of low things (counters, tables), the middle of tall ones.
    const c = center(target.box);
    face(scene, [c[0], Math.min(target.box.max[1], Math.max(c[1], 0.9)), c[2]]);
  }
  // Walking to a spot on the floor keeps your head tilt: you go on looking the way you were looking.
  return walked;
}

/** A close-up camera for examining a thing from where the agent stands. */
export function closeUp(scene: Scene, box: Box): SnapCamera {
  const c = center(box);
  const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  let dx = scene.pose.x - c[0];
  let dz = scene.pose.z - c[2];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const dist = Math.min(1.8, Math.max(0.3, size * 1.7));
  return { eye: [c[0] + dx * dist, c[1] + dist * 0.35, c[2] + dz * dist], target: c, fovY: 42 };
}

// ---- snapshot --------------------------------------------------------------

const ROOM_COLORS: Record<string, { floor: string; wall: string }> = {
  hallway: { floor: "#8a6a4a", wall: "#e8e0d0" },
  living_room: { floor: "#9b7652", wall: "#dfe6dc" },
  kitchen: { floor: "#cfc8bb", wall: "#f3ecdc" },
  dining_room: { floor: "#8e6a48", wall: "#ecdcc8" },
  pantry: { floor: "#b9b2a4", wall: "#efe8d8" },
  bathroom: { floor: "#dfe5e8", wall: "#e4eef2" },
  laundry: { floor: "#c4c4c0", wall: "#e9e9e2" },
  garage: { floor: "#9a9a96", wall: "#cfcfca" },
};

export function contentsColor(s: Stuff): string {
  const coffee = s.coffee ?? 0;
  const milk = (s.milk ?? 0) + (s.sour_milk ?? 0);
  const water = s.water ?? 0;
  const total = coffee + milk + water;
  if (total > 0) {
    if (coffee / total > 0.15) return milk / total > 0.08 ? "#a0744c" : "#3f2412";
    if (milk >= water) return s.sour_milk && !s.milk ? "#f1ecd2" : "#f6f3ea";
    return "#9fd0ee";
  }
  if (s.grounds || s.instant) return "#3b2614";
  if (s.beans) return "#5a341a";
  if (s.tea) return "#556b2f";
  if (s.sugar || s.salt) return "#fafafa";
  return "#999999";
}

function fillOf(stuff: Stuff, capacity: number, temp: number): SnapFill | undefined {
  const vol = volume(stuff);
  if (vol <= 0.5) return undefined;
  const liq = liquid(stuff) > 0;
  return {
    level: Math.min(1, vol / capacity),
    color: contentsColor(stuff),
    solid: !liq,
    steam: liq && temp >= 60,
  };
}

const MUG_COLORS = ["white", "blue", "striped", "chipped green", "World's Best Boss", "yellow", "speckled", "black"];

export interface SnapshotSource extends Scene {
  version: number;
  seed: string;
  player: string;
  status: Snapshot["status"];
  clock(): string;
}

/**
 * Build what the renderer draws. `camera` aims a close-up at something in the room; `inspect` holds a
 * carried item up in front of the agent's eyes (drawn as a free object with parent "inspect").
 */
export function buildSnapshot(scene: SnapshotSource, camera?: SnapCamera, inspect?: string): Snapshot {
  const boxes = layoutBoxes(scene);
  const w = scene.world;
  let hands = scene.hands;
  if (inspect) {
    const iv = inspectView(scene, inspect);
    boxes.set(inspect, iv.box);
    camera = iv.camera;
    hands = hands.map((h) => (h === inspect ? null : h));
  }
  const things: SnapThing[] = [];
  for (const t of w.things.values()) {
    const b = boxes.get(t.id) ?? { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
    const root = rootOf(scene, t);
    const inspected = t.id === inspect;
    const st: SnapThing = {
      id: t.id,
      name: t.name,
      kind: t.kind,
      material: t.material,
      placement: t.placement,
      parent: inspected ? "inspect" : t.parent,
      room: root.room ?? roomAt(w, scene.pose.x, scene.pose.z, "hallway"),
      min: b.min,
      max: b.max,
      facing: inspected ? [-Math.sin(scene.pose.yaw), Math.cos(scene.pose.yaw)] : (root.facing ?? [0, 1]),
      hidden: hiddenInside(scene, t),
    };
    if (t.label) st.label = t.label;
    if (t.text) st.text = t.text;
    if (t.kind === "mug") st.color = MUG_COLORS.find((c) => t.name.includes(c)) ?? "white";
    if (t.container?.openable) st.open = t.container.open;
    if (t.on !== undefined) st.on = t.on;
    if (t.pluggable) st.plugged = !!t.plugged;
    if (t.broken) st.broken = true;
    if (t.dirty) st.dirty = true;
    if (t.kind === "french_press") st.pressed = !!t.pressed;
    if (t.expired) st.expired = true;
    if (t.waterOff) {
      st.waterOff = true;
      st.noteText = t.waterOff.replace(/^Note taped to the tap: "|"$/g, "");
    }
    if (t.kind === "coffee_maker") {
      st.filter = !!t.filter;
      st.reservoirLevel = Math.min(1, (t.reservoir ?? 0) / 1800);
      const bf = fillOf(t.basket ?? {}, 100 * 2, 20);
      if (bf) st.basketFill = bf;
    }
    if (t.kind === "moka_pot") {
      const bf = fillOf(t.basket ?? {}, 22 * 2, 20);
      if (bf) st.basketFill = bf;
    }
    if (t.vessel) {
      const fill = fillOf(t.vessel.stuff, t.vessel.capacity, t.vessel.temp);
      if (fill) st.fill = fill;
    }
    things.push(st);
  }
  return {
    version: scene.version,
    seed: scene.seed,
    player: scene.player,
    rooms: [...w.rects].map(([id, r]: [string, Rect]) => ({
      id,
      name: w.rooms.get(id)!.name,
      ...r,
      floor: ROOM_COLORS[id]?.floor ?? "#a08060",
      wall: ROOM_COLORS[id]?.wall ?? "#eeeeee",
    })),
    doors: w.doors.map((d) => ({
      id: d.id,
      name: `doorway (${d.rooms.map((r) => w.rooms.get(r)!.name).join(" / ")})`,
      rooms: d.rooms,
      x: d.x,
      z: d.z,
      axis: d.axis,
      width: d.width,
    })),
    things,
    agent: { ...scene.pose },
    ...(camera ? { camera } : {}),
    hands,
    clock: scene.clock(),
    status: scene.status,
  };
}

