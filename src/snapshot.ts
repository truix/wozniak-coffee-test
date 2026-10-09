// Contract between the game server (authoritative geometry + state) and the Three.js renderer.
// The server computes every world-space box; the renderer only draws what it is given.
//
// Coordinate system (matches Three.js): metres, +x east, +y up, +z south. Floor is y = 0.
// Agent yaw: radians, 0 = facing north (-z), positive = turned right (clockwise seen from above).
//   forward = (sin(yaw), 0, -cos(yaw)). In Three.js: camera.rotation.order = "YXZ",
//   camera.rotation.y = -yaw, camera.rotation.x = pitch (positive pitch = looking up).

import type { Kind, Material, Placement } from "./world";

export const VIEW_W = 960;
export const VIEW_H = 600;
/** Vertical field of view in degrees for the agent camera. */
export const FOV_Y = 60;
export const EYE_HEIGHT = 1.6;
export const WALL_HEIGHT = 2.6;
export const DOOR_HEIGHT = 2.05;
/** How far an open drawer slides out along its facing direction. */
export const DRAWER_TRAVEL = 0.35;

export type Vec3 = [number, number, number];

/**
 * Where a held item is drawn in front of the agent's eyes, in camera space (+x right, +y up, -z forward):
 * the holder sits at (±x, y, z), tilted by `pitch` about x and turned by ∓`yaw` about y, and the item
 * hangs `drop` of its height below the holder. Shared so the server can tell when a pixel is on a held item.
 */
export const HELD_POSE = { x: 0.25, y: -0.27, z: -0.55, pitch: 0.32, yaw: 0.18, drop: 0.35 } as const;

/** Nominal [w, h, d] for drawing a held item (its server box is meaningless while held). */
export function heldSize(t: { kind: Kind; material: Material }): Vec3 {
  switch (t.kind) {
    case "mug":
      return [0.12, 0.1, 0.085];
    case "kettle":
      return [0.24, 0.24, 0.16];
    case "stovetop_kettle":
      return [0.26, 0.22, 0.2];
    case "carafe":
      return [0.2, 0.2, 0.14];
    case "french_press":
      return [0.17, 0.23, 0.11];
    case "moka_pot":
      return [0.15, 0.2, 0.1];
    case "grinder":
      return [0.12, 0.22, 0.12];
    case "box":
      return [0.14, 0.08, 0.1];
    case "filter":
      return [0.12, 0.08, 0.12];
    case "note":
      return [0.16, 0.2, 0.004];
    case "package":
      return t.material === "paper" ? [0.13, 0.24, 0.08] : t.material === "cardboard" ? [0.09, 0.24, 0.09] : t.material === "glass" ? [0.09, 0.13, 0.09] : [0.11, 0.15, 0.11];
    default:
      return [0.12, 0.12, 0.1];
  }
}

/**
 * Furniture drawn with cabinet-style fronts that are not real doors: the panels under the counter, island
 * and kitchen sink (drawn flush, without handles), and the oven door on the stove. None of them open.
 */
export function fixedFront(t: { kind: Kind; name: string; material: Material }): "panels" | "oven" | null {
  if (t.kind === "stove") return "oven";
  if (t.kind === "surface" && /counter|island|worktop/.test(t.name.toLowerCase())) return "panels";
  if (t.kind === "sink" && t.material === "metal") return "panels";
  return null;
}

export interface SnapRoom {
  id: string;
  name: string;
  /** Interior rectangle (walls sit on its edges). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  floor: string; // css color
  wall: string; // css color
}

export interface SnapDoor {
  id: string;
  name: string; // e.g. "doorway (Kitchen)"
  rooms: [string, string];
  /** Centre of the opening on the wall line. */
  x: number;
  z: number;
  /** Axis the wall runs along: "x" = wall is horizontal (constant z), "z" = wall is vertical (constant x). */
  axis: "x" | "z";
  width: number;
}

export interface SnapFill {
  /** 0..1 of the vessel's visible height. */
  level: number;
  color: string; // css color of the contents
  /** Liquid (flat surface) vs heaped solids (grounds, beans, sugar). */
  solid: boolean;
  steam: boolean;
}

export interface SnapThing {
  id: string;
  name: string;
  kind: Kind;
  material: Material;
  placement?: Placement;
  /** Parent thing id, "hands", or null for room-rooted furniture. */
  parent: string | null;
  room: string;
  /**
   * World AABB. For furniture this is the closed body. For a drawer, the box is where the drawer *is*
   * (already slid out by DRAWER_TRAVEL when open). For held items it is meaningless: draw them in the hands.
   */
  min: Vec3;
  max: Vec3;
  /** Unit front normal in xz (doors, labels, appliance fronts face this way). */
  facing: [number, number];
  /** Inside a closed container: do not draw. */
  hidden: boolean;
  label?: string;
  /** Note text (render legibly on the paper). */
  text?: string;
  /** Hint for the model colour, e.g. mug colours ("white", "blue", "striped", ...). */
  color?: string;
  open?: boolean;
  on?: boolean;
  plugged?: boolean;
  broken?: boolean;
  dirty?: boolean;
  pressed?: boolean;
  expired?: boolean;
  waterOff?: boolean;
  /** Coffee maker: paper filter seated. */
  filter?: boolean;
  fill?: SnapFill;
  /** Coffee maker: water reservoir 0..1. */
  reservoirLevel?: number;
  /** Coffee maker / moka pot: what's in the grounds basket. */
  basketFill?: SnapFill;
  /** Sink with water shut off: text of the note taped to the tap. */
  noteText?: string;
}

export interface SnapAgent {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Camera override for close-up "examine" shots. When present, render from here instead of the agent's eyes. */
export interface SnapCamera {
  eye: Vec3;
  target: Vec3;
  fovY: number;
}

export interface Snapshot {
  version: number;
  seed: string;
  player: string;
  rooms: SnapRoom[];
  doors: SnapDoor[];
  things: SnapThing[];
  agent: SnapAgent;
  camera?: SnapCamera;
  /** Held thing ids: [0] = right hand, [1] = left hand (either may be absent). */
  hands: (string | null)[];
  clock: string;
  status: "playing" | "won" | "failed";
}
