import type { Door, Rect } from "./layout";

// Core data model for a coffee-test house.

export type Substance =
  | "water"
  | "coffee"
  | "milk"
  | "sour_milk"
  | "sugar"
  | "salt"
  | "beans"
  | "grounds"
  | "instant"
  | "tea";

export const LIQUIDS: readonly Substance[] = ["water", "coffee", "milk", "sour_milk"];
export const SOLIDS: readonly Substance[] = ["sugar", "salt", "beans", "grounds", "instant", "tea"];

/** Liquids in ml, solids in grams. */
export type Stuff = Partial<Record<Substance, number>>;

export type Kind =
  // furniture (room-rooted, never portable)
  | "cabinet"
  | "drawer"
  | "fridge"
  | "shelf"
  | "surface"
  | "sink"
  | "stove"
  | "dishwasher"
  | "decor"
  // appliances (sit on a surface, not portable)
  | "coffee_maker"
  | "grinder"
  | "kettle_base"
  | "microwave"
  // portable things
  | "mug"
  | "kettle"
  | "stovetop_kettle"
  | "carafe"
  | "french_press"
  | "moka_pot"
  | "package"
  | "box"
  | "filter"
  | "note"
  | "misc";

export type Placement = "upper" | "base" | "tall" | "floor";
export type Material = "ceramic" | "glass" | "metal" | "plastic" | "paper" | "cardboard" | "wood" | "fabric";

export interface Container {
  open: boolean;
  openable: boolean;
  slots: number;
  /** "in" a cabinet vs "on" a counter. */
  prep: "in" | "on";
}

export interface Vessel {
  stuff: Stuff;
  /** °C of the liquid. */
  temp: number;
  /** ml of total volume (solids count at SOLID_VOLUME ml/g). */
  capacity: number;
  /** grams of coffee per litre that the brewed coffee in this vessel was made with. */
  strength: number;
}

export interface Thing {
  id: string;
  name: string;
  kind: Kind;
  desc: string;
  /** Printed text visible on the object. */
  label?: string;
  aliases?: string[];
  /** Parent thing id, "hands", or null for room-rooted furniture. */
  parent: string | null;
  /** Only set for room-rooted furniture. */
  room?: string;
  placement?: Placement;
  portable: boolean;
  material: Material;
  container?: Container;
  vessel?: Vessel;
  pluggable?: boolean;
  plugged?: boolean;
  on?: boolean;
  /** Why the appliance refuses to work. */
  broken?: string;
  dirty?: boolean;
  expired?: boolean;
  pressed?: boolean;
  steep?: number;
  /** Coffee maker: paper filter seated in the basket. */
  filter?: boolean;
  /** Coffee maker / moka pot: grounds basket. */
  basket?: Stuff;
  /** Coffee maker: water reservoir in ml. */
  reservoir?: number;
  brewStrength?: number;
  /** Coffee maker / moka: basket grounds already extracted. */
  spent?: boolean;
  /** Microwave ticks remaining. */
  runTicks?: number;
  /** Sink: water supply shut off, with the note explaining it. */
  waterOff?: string;
  /** Note text. */
  text?: string;
  /** Fridge / freezer interior temperature. */
  chill?: number;
  scorched?: boolean;
  /** Stovetop kettle: has already whistled once (later whistles get shorter narration). */
  whistled?: boolean;
  /** Room-rooted furniture only: world AABB (closed position) and front normal. Set by layout. */
  box?: { min: [number, number, number]; max: [number, number, number] };
  facing?: [number, number];
}

export interface Room {
  id: string;
  name: string;
  desc: string;
  exits: string[];
}

export type Method = "drip" | "press" | "moka" | "instant";

export interface Preference {
  milk: boolean;
  sugar: boolean;
  phrase: string;
}

/** Ground truth for tests and post-game reports; never shown to the player. */
export interface Recipe {
  method: Method;
  coffee: string;
  beans: boolean;
  grinder?: string;
  brewer?: string;
  filters?: string;
  heater?: string;
  sink: string;
  mugs: string[];
  mugsDirty: boolean;
  milk?: string;
  sugar?: string;
  twists: string[];
}

export interface World {
  seed: string;
  date: string;
  rooms: Map<string, Room>;
  things: Map<string, Thing>;
  start: string;
  owner: string;
  pref: Preference;
  recipe: Recipe;
  rects: Map<string, Rect>;
  doors: Door[];
  /** Where the agent starts: hallway, facing down its length. */
  spawn: { x: number; z: number; yaw: number };
}

export const SOLID_VOLUME = 2;
export const HAND_SLOTS = 2;

export function volume(s: Stuff): number {
  let v = 0;
  for (const k of LIQUIDS) v += s[k] ?? 0;
  for (const k of SOLIDS) v += (s[k] ?? 0) * SOLID_VOLUME;
  return v;
}

export function liquid(s: Stuff): number {
  let v = 0;
  for (const k of LIQUIDS) v += s[k] ?? 0;
  return v;
}

export function solid(s: Stuff): number {
  let v = 0;
  for (const k of SOLIDS) v += s[k] ?? 0;
  return v;
}

export function isEmpty(s: Stuff): boolean {
  for (const k in s) if ((s[k as Substance] ?? 0) > 0.01) return false;
  return true;
}

export function add(s: Stuff, k: Substance, n: number): void {
  const v = (s[k] ?? 0) + n;
  if (v <= 0.01) delete s[k];
  else s[k] = v;
}

const SUBSTANCE_NAMES: Record<Substance, string> = {
  water: "water",
  coffee: "coffee",
  milk: "milk",
  sour_milk: "milk",
  sugar: "white crystals",
  salt: "white crystals",
  beans: "coffee beans",
  grounds: "coffee grounds",
  instant: "instant coffee granules",
  tea: "tea leaves",
};

/** What a casual glance reveals: sugar and salt look identical, sour milk looks like milk. */
export function describeStuff(s: Stuff): string {
  const parts: string[] = [];
  const merged = new Map<string, number>();
  const unit = new Map<string, string>();
  for (const k of [...LIQUIDS, ...SOLIDS]) {
    const n = s[k] ?? 0;
    if (n <= 0.01) continue;
    const name = SUBSTANCE_NAMES[k];
    merged.set(name, (merged.get(name) ?? 0) + n);
    unit.set(name, LIQUIDS.includes(k) ? "ml" : "g");
  }
  for (const [name, n] of merged) parts.push(`${Math.round(n)}${unit.get(name)} ${name}`);
  return parts.length ? parts.join(", ") : "empty";
}
