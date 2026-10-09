// Physical house layout: room rectangles, doorways, furniture boxes, and the walkable grid.

import type { Rng } from "./rng";
import type { Vec3 } from "./snapshot";
import type { Thing } from "./world";

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Door {
  id: string;
  rooms: [string, string];
  x: number;
  z: number;
  /** "x": wall runs along x (constant z). "z": wall runs along z (constant x). */
  axis: "x" | "z";
  width: number;
}

export interface RoomSpec {
  id: string;
  w: number;
  d: number;
  parent: string | null;
}

export const AGENT_RADIUS = 0.25;
/** Horizontal arm's reach from the body centre to the nearest point of a thing. */
export const REACH = 0.95;
const DOOR_W = 0.9;
const MIN_SHARED = 1.6;
const CORNER = 0.7;
const WALL_HALF = 0.05;
const EPS = 1e-6;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS;

function sharedEdge(a: Rect, b: Rect): { axis: "x" | "z"; at: number; lo: number; hi: number } | null {
  for (const [ax, bx] of [
    [a.x1, b.x0],
    [a.x0, b.x1],
  ] as const) {
    if (Math.abs(ax - bx) < EPS) {
      const lo = Math.max(a.z0, b.z0);
      const hi = Math.min(a.z1, b.z1);
      if (hi - lo > EPS) return { axis: "z", at: ax, lo, hi };
    }
  }
  for (const [az, bz] of [
    [a.z1, b.z0],
    [a.z0, b.z1],
  ] as const) {
    if (Math.abs(az - bz) < EPS) {
      const lo = Math.max(a.x0, b.x0);
      const hi = Math.min(a.x1, b.x1);
      if (hi - lo > EPS) return { axis: "x", at: az, lo, hi };
    }
  }
  return null;
}

function candidates(p: Rect, side: string, w: number, d: number, rng: Rng): Rect[] {
  const out: Rect[] = [];
  const horizontal = side === "n" || side === "s";
  const [plo, phi] = horizontal ? [p.x0, p.x1] : [p.z0, p.z1];
  const len = horizontal ? w : d;
  const lo = plo - len + MIN_SHARED;
  const hi = phi - MIN_SHARED;
  if (hi < lo) return out;
  const starts = [plo, phi - len, (plo + phi - len) / 2, lo + rng.next() * (hi - lo), lo + rng.next() * (hi - lo)];
  for (const s of starts) {
    if (s < lo - EPS || s > hi + EPS) continue;
    const r =
      side === "n"
        ? { x0: s, x1: s + w, z0: p.z0 - d, z1: p.z0 }
        : side === "s"
          ? { x0: s, x1: s + w, z0: p.z1, z1: p.z1 + d }
          : side === "w"
            ? { x0: p.x0 - w, x1: p.x0, z0: s, z1: s + d }
            : { x0: p.x1, x1: p.x1 + w, z0: s, z1: s + d };
    out.push(r);
  }
  return out;
}

function makeDoor(rng: Rng, a: string, b: string, e: { axis: "x" | "z"; at: number; lo: number; hi: number }): Door {
  const len = e.hi - e.lo;
  // Keep doors away from corners so wall-mounted furniture can't block them.
  const m = len >= DOOR_W + 2 * (CORNER + 0.1) ? DOOR_W / 2 + CORNER + 0.1 : DOOR_W / 2 + 0.15;
  const c = e.lo + m + rng.next() * Math.max(0, len - 2 * m);
  return {
    id: `door_${a}_${b}`,
    rooms: [a, b],
    x: e.axis === "x" ? c : e.at,
    z: e.axis === "x" ? e.at : c,
    axis: e.axis,
    width: DOOR_W,
  };
}

/** Rooms and the doorways between them, before furniture. */
export interface HouseShell {
  rects: Map<string, Rect>;
  doors: Door[];
}

export function layoutRooms(
  rng: Rng,
  specs: RoomSpec[],
  extras: readonly (readonly [string, string, number])[],
): HouseShell {
  const rects = new Map<string, Rect>();
  const doors: Door[] = [];
  for (const s of specs) {
    if (!s.parent) {
      rects.set(s.id, { x0: 0, z0: 0, x1: s.w, z1: s.d });
      continue;
    }
    const parents = [s.parent, ...rng.shuffle([...rects.keys()].filter((k) => k !== s.parent))];
    let placed = false;
    outer: for (const pid of parents) {
      const p = rects.get(pid)!;
      for (const side of rng.shuffle(["n", "s", "e", "w"])) {
        for (const [w, d] of rng.shuffle([
          [s.w, s.d],
          [s.d, s.w],
        ])) {
          for (const r of candidates(p, side, w!, d!, rng)) {
            if ([...rects.values()].some((o) => overlaps(o, r))) continue;
            rects.set(s.id, r);
            doors.push(makeDoor(rng, pid, s.id, sharedEdge(p, r)!));
            placed = true;
            break outer;
          }
        }
      }
    }
    if (!placed) throw new Error(`could not place room ${s.id}`);
  }
  for (const [a, b, p] of extras) {
    const ra = rects.get(a);
    const rb = rects.get(b);
    if (!ra || !rb || doors.some((d) => d.rooms.includes(a) && d.rooms.includes(b))) continue;
    const e = sharedEdge(ra, rb);
    if (e && e.hi - e.lo >= MIN_SHARED && rng.chance(p)) doors.push(makeDoor(rng, a, b, e));
  }
  return { rects, doors };
}

// ---- furniture -------------------------------------------------------------

interface Dims {
  w: number;
  d: number;
  h: number;
  y0: number;
  mode: "wall" | "upper" | "center";
}

const NAMED_DIMS: Record<string, Dims> = {
  counter: { w: 2.4, d: 0.6, h: 0.9, y0: 0, mode: "wall" },
  "kitchen sink": { w: 0.8, d: 0.6, h: 0.9, y0: 0, mode: "wall" },
  "bathroom sink": { w: 0.55, d: 0.45, h: 0.85, y0: 0, mode: "wall" },
  "utility sink": { w: 0.6, d: 0.55, h: 0.9, y0: 0, mode: "wall" },
  stove: { w: 0.76, d: 0.65, h: 0.92, y0: 0, mode: "wall" },
  fridge: { w: 0.8, d: 0.7, h: 1.85, y0: 0, mode: "wall" },
  freezer: { w: 0.7, d: 0.7, h: 1.8, y0: 0, mode: "wall" },
  "garage fridge": { w: 0.6, d: 0.6, h: 1.4, y0: 0, mode: "wall" },
  dishwasher: { w: 0.6, d: 0.6, h: 0.85, y0: 0, mode: "wall" },
  "shoe cabinet": { w: 0.8, d: 0.35, h: 0.9, y0: 0, mode: "wall" },
  sideboard: { w: 1.6, d: 0.45, h: 0.85, y0: 0, mode: "wall" },
  "washing machine": { w: 0.6, d: 0.6, h: 0.85, y0: 0, mode: "wall" },
  "mirror cabinet": { w: 0.6, d: 0.15, h: 0.6, y0: 1.3, mode: "upper" },
  "utility shelf": { w: 1.0, d: 0.3, h: 0.45, y0: 1.5, mode: "upper" },
  "console table": { w: 1.0, d: 0.35, h: 0.8, y0: 0, mode: "wall" },
  sofa: { w: 2.0, d: 0.9, h: 0.85, y0: 0, mode: "wall" },
  "coffee table": { w: 1.1, d: 0.6, h: 0.45, y0: 0, mode: "center" },
  "dining table": { w: 1.6, d: 0.9, h: 0.75, y0: 0, mode: "center" },
  "kitchen island": { w: 1.4, d: 0.8, h: 0.92, y0: 0, mode: "center" },
  workbench: { w: 1.8, d: 0.7, h: 0.9, y0: 0, mode: "wall" },
  "coat rack": { w: 0.45, d: 0.45, h: 1.8, y0: 0, mode: "wall" },
  television: { w: 1.2, d: 0.4, h: 1.1, y0: 0, mode: "wall" },
  bookshelf: { w: 1.0, d: 0.4, h: 1.9, y0: 0, mode: "wall" },
  "tool shelf": { w: 1.0, d: 0.4, h: 1.9, y0: 0, mode: "wall" },
};

/** Drawers stack in one 0.5 m column: drawer 1 on top. */
const DRAWER_Y: readonly (readonly [number, number])[] = [
  [0.62, 0.88],
  [0.36, 0.6],
  [0.1, 0.34],
];

function dimsOf(t: Thing): Dims {
  const named = NAMED_DIMS[t.name];
  if (named) return named;
  if (t.kind === "drawer") return { w: 0.5, d: 0.6, h: 0.26, y0: 0, mode: "wall" };
  if (t.name.startsWith("upper cabinet")) return { w: 0.7, d: 0.35, h: 0.7, y0: 1.45, mode: "upper" };
  if (t.name.startsWith("lower cabinet")) return { w: 0.6, d: 0.6, h: 0.9, y0: 0, mode: "wall" };
  if (t.name.startsWith("pantry shelf")) return { w: 1.0, d: 0.4, h: 1.9, y0: 0, mode: "wall" };
  throw new Error(`no dimensions for furniture "${t.name}"`);
}

interface WallLine {
  /** Origin of the wall line and unit direction along it. */
  ox: number;
  oz: number;
  dx: number;
  dz: number;
  length: number;
  facing: [number, number];
  free: [number, number][];
}

/** `corner`: depth of the deepest wall piece in the room; side walls leave that much clear at each end. */
function walls(r: Rect, doors: Door[], corner: number): WallLine[] {
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const lines: WallLine[] = [
    { ox: r.x0, oz: r.z0, dx: 1, dz: 0, length: w, facing: [0, 1], free: [[0, w]] },
    { ox: r.x0, oz: r.z1, dx: 1, dz: 0, length: w, facing: [0, -1], free: [[0, w]] },
    { ox: r.x0, oz: r.z0, dx: 0, dz: 1, length: d, facing: [1, 0], free: [[corner, d - corner]] },
    { ox: r.x1, oz: r.z0, dx: 0, dz: 1, length: d, facing: [-1, 0], free: [[corner, d - corner]] },
  ];
  const block = (line: WallLine, lo: number, hi: number): void => {
    const next: [number, number][] = [];
    for (const [a, b] of line.free) {
      if (hi <= a || lo >= b) next.push([a, b]);
      else {
        if (lo > a) next.push([a, lo]);
        if (hi < b) next.push([hi, b]);
      }
    }
    line.free = next.filter(([a, b]) => b - a > 0.05);
  };
  for (const door of doors) {
    for (const line of lines) {
      const horizontal = line.dz === 0;
      if (horizontal && door.axis === "x" && Math.abs(door.z - line.oz) < EPS && door.x > r.x0 && door.x < r.x1) {
        block(line, door.x - r.x0 - door.width / 2 - 0.15, door.x - r.x0 + door.width / 2 + 0.15);
      }
      if (!horizontal && door.axis === "z" && Math.abs(door.x - line.ox) < EPS && door.z > r.z0 && door.z < r.z1) {
        block(line, door.z - r.z0 - door.width / 2 - 0.15, door.z - r.z0 + door.width / 2 + 0.15);
        // A door near a corner: keep the perpendicular wall's corner clear too.
        const lowEdge = door.z - door.width / 2 - r.z0;
        const highEdge = r.z1 - (door.z + door.width / 2);
        const west = Math.abs(door.x - r.x0) < EPS;
        for (const other of lines) {
          if (other.dz !== 0) continue;
          const atNorth = Math.abs(other.oz - r.z0) < EPS;
          if ((atNorth && lowEdge < corner + 0.05) || (!atNorth && highEdge < corner + 0.05)) {
            if (west) block(other, 0, corner + 0.05);
            else block(other, w - corner - 0.05, w);
          }
        }
      }
    }
  }
  return lines;
}

function boxOnWall(line: WallLine, at: number, dims: Dims): { min: Vec3; max: Vec3 } {
  // `at` = distance along the wall to the near edge of the piece.
  const ax = line.ox + line.dx * at;
  const az = line.oz + line.dz * at;
  const bx = ax + line.dx * dims.w + line.facing[0] * dims.d;
  const bz = az + line.dz * dims.w + line.facing[1] * dims.d;
  return {
    min: [Math.min(ax, bx), dims.y0, Math.min(az, bz)],
    max: [Math.max(ax, bx), dims.y0 + dims.h, Math.max(az, bz)],
  };
}

/** Place every room-rooted piece of furniture. Returns false if something didn't fit. */
export function placeFurniture(rng: Rng, rect: Rect, doors: Door[], furniture: Thing[]): boolean {
  const deepest = Math.max(0.35, ...furniture.filter((t) => dimsOf(t).mode === "wall").map((t) => dimsOf(t).d));
  // Side walls stop short of the corners by the deepest piece plus a body's width, so you can still stand
  // square in front of whatever sits in the corner.
  const lines = rng.shuffle(walls(rect, doors, deepest + 0.55));
  const cursor = new Map<WallLine, { seg: number; at: number }>();
  for (const l of lines) cursor.set(l, { seg: 0, at: l.free[0]?.[0] ?? 0 });
  const baseSpans: { line: WallLine; lo: number; hi: number; tall: boolean }[] = [];

  const placeOnWall = (dims: Dims): { line: WallLine; at: number } | undefined => {
    for (const line of lines) {
      const c = cursor.get(line)!;
      while (c.seg < line.free.length) {
        const [a, b] = line.free[c.seg]!;
        const at = Math.max(c.at, a);
        if (at + dims.w <= b + EPS) {
          c.at = at + dims.w + 0.02;
          return { line, at };
        }
        c.seg++;
        c.at = line.free[c.seg]?.[0] ?? 0;
      }
    }
    return undefined;
  };

  const drawers = furniture.filter((t) => t.kind === "drawer").sort((a, b) => a.name.localeCompare(b.name));
  const wallItems: (Thing | "drawers")[] = rng.shuffle(furniture.filter((t) => t.kind !== "drawer" && dimsOf(t).mode === "wall"));
  // Big pieces first so they find room; keep the counter first in the kitchen for a natural run.
  wallItems.sort((a, b) => (b === "drawers" ? 0.5 : dimsOf(b).w) - (a === "drawers" ? 0.5 : dimsOf(a).w));
  if (drawers.length) wallItems.splice(1, 0, "drawers");

  for (const item of wallItems) {
    const dims = item === "drawers" ? { w: 0.5, d: 0.6, h: 0.9, y0: 0, mode: "wall" as const } : dimsOf(item);
    const spot = placeOnWall(dims);
    if (!spot) return false;
    const box = boxOnWall(spot.line, spot.at, dims);
    baseSpans.push({ line: spot.line, lo: spot.at, hi: spot.at + dims.w, tall: dims.h > 1.3 });
    if (item === "drawers") {
      drawers.forEach((dr, i) => {
        const [y0, y1] = DRAWER_Y[i] ?? DRAWER_Y[2]!;
        dr.box = { min: [box.min[0], y0, box.min[2]], max: [box.max[0], y1, box.max[2]] };
        dr.facing = spot.line.facing;
      });
    } else {
      item.box = box;
      item.facing = spot.line.facing;
    }
  }

  // Wall-mounted pieces: above low base units first, else any free wall stretch.
  const uppers = furniture.filter((t) => dimsOf(t).mode === "upper");
  const used: { line: WallLine; lo: number; hi: number }[] = [];
  const clear = (line: WallLine, lo: number, hi: number): boolean =>
    lo >= -EPS &&
    hi <= line.length + EPS &&
    !used.some((u) => u.line === line && lo < u.hi && hi > u.lo) &&
    !baseSpans.some((s) => s.line === line && s.tall && lo < s.hi && hi > s.lo) &&
    line.free.some(([a, b]) => lo >= a - EPS && hi <= b + EPS);
  for (const u of uppers) {
    const dims = dimsOf(u);
    let spot: { line: WallLine; at: number } | undefined;
    for (const s of rng.shuffle(baseSpans.filter((s) => !s.tall))) {
      const at = (s.lo + s.hi) / 2 - dims.w / 2;
      for (const a of [at, s.lo, s.hi - dims.w]) {
        if (clear(s.line, a, a + dims.w)) {
          spot = { line: s.line, at: a };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) {
      for (const line of lines) {
        for (const [a, b] of line.free) {
          for (let at = a; at + dims.w <= b + EPS && !spot; at += 0.1) if (clear(line, at, at + dims.w)) spot = { line, at };
        }
      }
    }
    if (!spot) return false;
    used.push({ line: spot.line, lo: spot.at, hi: spot.at + dims.w });
    u.box = boxOnWall(spot.line, spot.at, dims);
    u.facing = spot.line.facing;
  }

  // Free-standing tables go in the middle of the room.
  const centers = furniture.filter((t) => dimsOf(t).mode === "center");
  for (const c of centers) {
    const dims = dimsOf(c);
    const cx = (rect.x0 + rect.x1) / 2;
    const cz = (rect.z0 + rect.z1) / 2;
    const alongX = rect.x1 - rect.x0 >= rect.z1 - rect.z0;
    const [hw, hd] = alongX ? [dims.w / 2, dims.d / 2] : [dims.d / 2, dims.w / 2];
    c.box = { min: [cx - hw, 0, cz - hd], max: [cx + hw, dims.h, cz + hd] };
    c.facing = alongX ? [0, 1] : [1, 0];
  }
  return true;
}

// ---- walking ---------------------------------------------------------------

/** Footprints that block walking (everything standing on the floor). */
export function footprints(things: Iterable<Thing>): Rect[] {
  const out: Rect[] = [];
  for (const t of things) {
    if (t.parent || !t.box || t.box.min[1] > 1.0) continue;
    out.push({ x0: t.box.min[0], z0: t.box.min[2], x1: t.box.max[0], z1: t.box.max[2] });
  }
  return out;
}

export class WalkGrid {
  static readonly CELL = 0.1;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  private readonly open: Uint8Array;

  constructor(
    private readonly rects: Rect[],
    private readonly doors: Door[],
    private readonly blocks: Rect[],
  ) {
    this.x0 = Math.min(...rects.map((r) => r.x0)) - 0.5;
    this.z0 = Math.min(...rects.map((r) => r.z0)) - 0.5;
    this.nx = Math.ceil((Math.max(...rects.map((r) => r.x1)) + 0.5 - this.x0) / WalkGrid.CELL);
    this.nz = Math.ceil((Math.max(...rects.map((r) => r.z1)) + 0.5 - this.z0) / WalkGrid.CELL);
    this.open = new Uint8Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const [x, z] = this.center(i + j * this.nx);
        this.open[i + j * this.nx] = this.free(x, z) ? 1 : 0;
      }
    }
  }

  /** Exact test: can the agent's body centre stand here? */
  free(x: number, z: number): boolean {
    const R = AGENT_RADIUS;
    let inside = this.rects.some((r) => x >= r.x0 + R && x <= r.x1 - R && z >= r.z0 + R && z <= r.z1 - R);
    if (!inside) {
      inside = this.doors.some((d) =>
        d.axis === "x"
          ? Math.abs(x - d.x) <= d.width / 2 - R && Math.abs(z - d.z) <= WALL_HALF + R + 0.02
          : Math.abs(z - d.z) <= d.width / 2 - R && Math.abs(x - d.x) <= WALL_HALF + R + 0.02,
      );
    }
    if (!inside) return false;
    return !this.blocks.some((b) => x > b.x0 - R && x < b.x1 + R && z > b.z0 - R && z < b.z1 + R);
  }

  index(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / WalkGrid.CELL);
    const j = Math.floor((z - this.z0) / WalkGrid.CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return i + j * this.nx;
  }

  center(idx: number): [number, number] {
    const i = idx % this.nx;
    const j = Math.floor(idx / this.nx);
    return [this.x0 + (i + 0.5) * WalkGrid.CELL, this.z0 + (j + 0.5) * WalkGrid.CELL];
  }

  isOpen(idx: number): boolean {
    return idx >= 0 && this.open[idx] === 1;
  }

  /** Flood fill: 1 for every open cell connected to `from`. */
  reachable(from: number): Uint8Array {
    const seen = new Uint8Array(this.nx * this.nz);
    this.path(from, (idx) => {
      seen[idx] = 1;
      return false;
    });
    return seen;
  }

  /** Steps (8-connected, no corner cutting) from `from` to every open cell; -1 if unreachable. */
  distances(from: number): Int32Array {
    const dist = new Int32Array(this.nx * this.nz).fill(-1);
    if (!this.isOpen(from)) return dist;
    dist[from] = 0;
    const queue = [from];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q]!;
      const i = cur % this.nx;
      const j = Math.floor(cur / this.nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
          const n = ni + nj * this.nx;
          if (dist[n] !== -1 || !this.open[n]) continue;
          if (di && dj && (!this.open[i + di + j * this.nx] || !this.open[i + (j + dj) * this.nx])) continue;
          dist[n] = dist[cur]! + 1;
          queue.push(n);
        }
      }
    }
    return dist;
  }

  /** Nearest open cell to a point (spiral search). */
  nearestOpen(x: number, z: number, maxR = 15): number {
    const i0 = Math.floor((x - this.x0) / WalkGrid.CELL);
    const j0 = Math.floor((z - this.z0) / WalkGrid.CELL);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= maxR && best < 0; r++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
          const idx = i + j * this.nx;
          if (!this.open[idx]) continue;
          const [cx, cz] = this.center(idx);
          const dd = (cx - x) ** 2 + (cz - z) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = idx;
          }
        }
      }
    }
    return best;
  }

  /** Breadth-first search (8-connected) from a cell to the first goal cell; returns the path of cells. */
  path(from: number, goal: (idx: number) => boolean): number[] | undefined {
    if (!this.isOpen(from)) return undefined;
    const prev = new Int32Array(this.nx * this.nz).fill(-2);
    prev[from] = -1;
    const queue = [from];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q]!;
      if (goal(cur)) {
        const out: number[] = [];
        for (let c = cur; c !== -1; c = prev[c]!) out.unshift(c);
        return out;
      }
      const i = cur % this.nx;
      const j = Math.floor(cur / this.nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
          const n = ni + nj * this.nx;
          if (prev[n] !== -2 || !this.open[n]) continue;
          // No corner cutting.
          if (di && dj && (!this.open[i + di + j * this.nx] || !this.open[i + (j + dj) * this.nx])) continue;
          prev[n] = cur;
          queue.push(n);
        }
      }
    }
    return undefined;
  }
}

/** Horizontal distance from a point to a box footprint. */
export function footDistance(x: number, z: number, min: Vec3, max: Vec3): number {
  const dx = Math.max(min[0] - x, 0, x - max[0]);
  const dz = Math.max(min[2] - z, 0, z - max[2]);
  return Math.hypot(dx, dz);
}
