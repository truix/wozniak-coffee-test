// Game state, embodied player actions, per-tick physics and final scoring.
//
// The player never gets names: it points at pixels in its last first-person frame (or names a hand),
// and narration is anonymous. Everything it learns about *what* things are comes from the images.

import { generateHouse } from "./generate";
import { fixedFront, VIEW_H, VIEW_W, type SnapCamera, type Snapshot, type Vec3 } from "./snapshot";
import {
  buildSnapshot,
  closeUp,
  distanceTo,
  heldRects,
  inReach,
  inspectView,
  layoutBoxes,
  move,
  pickRay,
  PITCH_MAX,
  PITCH_MIN,
  rayHits,
  roomAt,
  rootOf,
  View,
  walkTo,
  type Box,
  type PickResult,
  type Pose,
  type Scene,
} from "./space";
import { add, isEmpty, liquid, LIQUIDS, SOLIDS, solid, volume, type Stuff, type Substance, type Thing, type Vessel, type World } from "./world";

export type Status = "playing" | "won" | "failed";
export type Hand = "right" | "left";
/** How the player refers to something: a hand, or a pixel in its latest view. */
export type Ref = { hand: Hand } | { x: number; y: number };

export interface Penalty {
  reason: string;
  points: number;
}

export interface LogEntry {
  n: number;
  clock: string;
  action: string;
  /** What the action actually touched (spectator-only; never shown to the player). */
  targets: string[];
  result: string;
  ok: boolean;
}

export interface Outcome {
  success: boolean;
  score: number;
  grade: string;
  verdict: string;
  notes: string[];
}

export interface ActionResult {
  text: string;
  ok: boolean;
  /** Close-up for examine: either a camera aimed at something in the room, or a held item to hold up. */
  closeUp?: CloseUp;
}

export type CloseUp = { camera: SnapCamera } | { inspect: string };

export interface Step {
  text: string;
  closeUp?: CloseUp;
}

export const MAX_ACTIONS = 400;
const TICK_SECONDS = 30;
const START_SECONDS = 7 * 3600 + 42 * 60;
const AMBIENT = 20;
const MIN_COFFEE_ML = 100;
const EXAMINE_RANGE = 4;

const FILLABLE = new Set(["mug", "kettle", "stovetop_kettle", "carafe", "french_press", "moka_pot"]);
/** Things with a power button, switch or dial. */
const SWITCHED = new Set(["kettle", "coffee_maker", "grinder", "microwave", "stove"]);
const BREW_EXCLUDED = new Set(["moka_pot", "package", "grinder"]);
const HAND_INDEX: Record<Hand, number> = { right: 0, left: 1 };

class ActionError extends Error {}

/** What a verb is looking for when the pixel isn't exactly on it (see Game.resolve). */
interface Want {
  accept: (t: Thing) => boolean;
  /** Also try things further along the same ray, behind what the pixel hit first. */
  scan?: boolean;
  /** Also try pixels up to this far from the one given (small buttons, knobs, drawer fronts). */
  radius?: number;
  /**
   * If the pixel is on something like this (or on what that sits in or on), use it as-is and let its state
   * decide the answer, rather than reaching for a neighbor (an "already on" coffee maker must not switch on
   * the grinder beside it).
   */
  stopAt?: (t: Thing) => boolean;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Compass heading for a yaw (0 = north, clockwise), e.g. "135° (south-east)". */
export function heading(yaw: number): string {
  const deg = Math.round(((((yaw * 180) / Math.PI) % 360) + 360) % 360) % 360;
  return `${deg}° (${COMPASS[Math.round(deg / 45) % 8]})`;
}

function fail(msg: string): never {
  throw new ActionError(msg);
}

function amountText(s: Stuff): string {
  const ml = liquid(s);
  const g = solid(s);
  const parts: string[] = [];
  if (ml > 0.5) parts.push(`about ${Math.round(ml)} ml`);
  if (g > 0.5) parts.push(`about ${Math.round(g)} g`);
  return parts.join(" and ") || "a trickle";
}

export class Game implements Scene {
  readonly world: World;
  pose: Pose;
  hands: (string | null)[] = [null, null];
  tick = 0;
  physical = 0;
  observations = 0;
  status: Status = "playing";
  penalties: Penalty[] = [];
  log: LogEntry[] = [];
  outcome?: Outcome;
  readonly startedAt = Date.now();
  endedAt?: number;
  /** Bumped on every action; lets viewers cache renders. */
  version = 0;
  /** Wall-clock time of the last action, for pruning abandoned runs. */
  lastActive = Date.now();
  /** Names of things touched by the current action, for the spectator log. */
  private touched: string[] = [];
  /**
   * The latest image, when it wasn't the agent's own view: an examine close-up. Pixels the agent gives next
   * refer to that image, so they are resolved through its camera.
   */
  private lastShot?: CloseUp;
  /** Where the ray of the last resolved pixel hit. */
  private lastPoint?: Vec3;

  constructor(
    readonly id: string,
    readonly player: string,
    readonly model: string,
    readonly seed: string,
  ) {
    this.world = generateHouse(seed);
    const s = this.world.spawn;
    this.pose = { x: s.x, z: s.z, yaw: s.yaw, pitch: -0.1 };
  }

  // ---- queries -------------------------------------------------------------

  get actions(): number {
    return this.physical + this.observations;
  }

  get room(): string {
    return roomAt(this.world, this.pose.x, this.pose.z, this.world.start);
  }

  clock(): string {
    const s = START_SECONDS + this.tick * TICK_SECONDS;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }

  thing(id: string): Thing {
    return this.world.things.get(id)!;
  }

  children(id: string): Thing[] {
    const out: Thing[] = [];
    for (const t of this.world.things.values()) if (t.parent === id) out.push(t);
    return out;
  }

  held(): Thing[] {
    return this.hands.filter((h): h is string => h !== null).map((id) => this.thing(id));
  }

  hud(): string {
    const hand = (i: number): string => (this.hands[i] ? "holding something" : "empty");
    const tilt = Math.round((this.pose.pitch * 180) / Math.PI);
    const head = Math.abs(tilt) < 3 ? "head level" : `head tilted ${Math.abs(tilt)}° ${tilt > 0 ? "up" : "down"}`;
    const stove = [...this.world.things.values()].some((t) => t.kind === "stove" && t.on) ? " A burner is still on." : "";
    return `[${this.world.date} ${this.clock()} | action ${this.actions}/${MAX_ACTIONS}] Facing ${heading(this.pose.yaw)}, ${head}. Right hand: ${hand(0)}. Left hand: ${hand(1)}.${stove}`;
  }

  snapshot(closeUp?: CloseUp): Snapshot {
    return buildSnapshot(this, closeUp && "camera" in closeUp ? closeUp.camera : undefined, closeUp && "inspect" in closeUp ? closeUp.inspect : undefined);
  }

  // ---- reference resolution -------------------------------------------------

  private handItem(hand: Hand): Thing {
    const id = this.hands[HAND_INDEX[hand]];
    if (!id) fail(`Your ${hand} hand is empty.`);
    const t = this.thing(id);
    this.touched.push(t.name);
    return t;
  }

  /** The camera of the latest image the agent was shown. */
  private view(): View {
    const shot = this.lastShot;
    if (shot && "camera" in shot) return new View(shot.camera);
    if (shot && "inspect" in shot) return new View(inspectView(this, shot.inspect).camera);
    return new View(this.pose);
  }

  /**
   * What a pixel of the latest image is on: an item held in a hand (drawn in the lower corners of your own
   * view, or held up for a close-up), or whatever the ray through it hits in the room.
   */
  private pointAt(x: number, y: number): { held: Hand } | { boxes: Map<string, Box>; view: View; result: PickResult; along: Thing[] } {
    if (!(x >= 0 && x <= VIEW_W && y >= 0 && y <= VIEW_H)) fail(`Point inside the image: x 0-${VIEW_W}, y 0-${VIEW_H}.`);
    const shot = this.lastShot;
    const view = this.view();
    if (shot && "inspect" in shot) {
      const i = this.hands.indexOf(shot.inspect);
      if (i >= 0 && rayHits(view, x, y, inspectView(this, shot.inspect).box)) return { held: i === 0 ? "right" : "left" };
    } else if (!shot) {
      const i = heldRects(this).findIndex((r) => r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      if (i >= 0) return { held: i === 0 ? "right" : "left" };
    }
    const boxes = layoutBoxes(this);
    return { boxes, view, ...pickRay(this, boxes, x, y, view) };
  }

  /**
   * Resolve a hand or a pixel to a thing. With `want`, a pixel that isn't exactly on a suitable thing is
   * forgiven: the thing it's on, what that sits in or on, things behind it along the same ray, and pixels
   * close by are tried in that order, preferring one within reach. If nothing suitable turns up, the thing
   * under the pixel is returned so the verb can say why it won't work.
   */
  private resolve(ref: Ref, need: "reach" | "see", want?: Want): Thing {
    this.lastPoint = undefined;
    if ("hand" in ref) return this.handItem(ref.hand);
    const at = this.pointAt(ref.x, ref.y);
    if ("held" in at) return this.handItem(at.held);
    const hit = at.result;
    let t = hit.kind === "thing" ? hit.thing : undefined;
    if (hit.kind === "thing") this.lastPoint = hit.point;
    if (want) {
      const found = this.search(ref, at, want);
      if (found && found !== t) {
        t = found;
        this.lastPoint = undefined;
      }
    }
    if (!t) {
      if (hit.kind === "floor") fail("You're pointing at the floor.");
      if (hit.kind === "ceiling") fail("You're pointing at the ceiling.");
      fail("You're pointing at a bare wall. Nothing there to interact with.");
    }
    this.touched.push(t.name);
    if (need === "reach") this.mustReach(t, at.boxes);
    if (need === "see" && distanceTo(this, at.boxes, t) > EXAMINE_RANGE) fail("That's too far away to make out. Get closer.");
    return t;
  }

  private mustReach(t: Thing, boxes = layoutBoxes(this)): void {
    if (!inReach(this, boxes, t)) fail("That's out of arm's reach. Walk closer first.");
  }

  private search(ref: { x: number; y: number }, at: { boxes: Map<string, Box>; view: View; result: PickResult; along: Thing[] }, want: Want): Thing | undefined {
    const primary = at.result.kind === "thing" ? at.result.thing : undefined;
    // the thing itself, then what it sits in or on, and a kettle standing on a base you pointed at
    const chainOf = (c: Thing): Thing[] => {
      const out: Thing[] = [];
      for (let p: Thing | undefined = c; p; p = p.parent && p.parent !== "hands" ? this.thing(p.parent) : undefined) out.push(p);
      if (c.kind === "kettle_base") out.push(...this.children(c.id));
      return out;
    };
    const cands: Thing[] = [];
    const chain = (c: Thing): void => {
      cands.push(...chainOf(c));
    };
    if (primary) {
      const own = chainOf(primary);
      const ok = own.find((c) => want.accept(c));
      if (ok) return ok;
      const stop = want.stopAt && own.find(want.stopAt);
      if (stop) return stop;
      chain(primary);
    }
    if (want.scan) for (const c of at.along) chain(c);
    const radius = want.radius ?? 0;
    for (let r = 6; r <= radius; r += 6) {
      for (let k = 0; k < 12; k++) {
        const x = ref.x + r * Math.cos((k * Math.PI) / 6);
        const y = ref.y + r * Math.sin((k * Math.PI) / 6);
        if (x < 0 || y < 0 || x > VIEW_W || y > VIEW_H) continue;
        const near = pickRay(this, at.boxes, x, y, at.view).result;
        if (near.kind === "thing") chain(near.thing);
      }
    }
    const ok = cands.filter((c) => want.accept(c));
    return ok.find((c) => inReach(this, at.boxes, c)) ?? ok[0];
  }

  private freeHand(): number {
    const i = this.hands.indexOf(null);
    if (i < 0) fail("Both your hands are full. Put something down first.");
    return i;
  }

  private dropFromHands(t: Thing): void {
    this.hands = this.hands.map((h) => (h === t.id ? null : h));
  }

  // ---- action dispatch -----------------------------------------------------

  run(action: string, args: Record<string, unknown>, physical: boolean, fn: () => Step): ActionResult {
    if (this.status !== "playing") {
      return { text: `This run is over (${this.status}). Call start_game to play another house.`, ok: false };
    }
    if (physical) this.physical++;
    else this.observations++;
    this.touched = [];
    this.lastActive = Date.now();
    const label = `${action}(${Object.entries(args)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")})`;
    let text: string;
    let ok = true;
    let closeUp: CloseUp | undefined;
    try {
      const r = fn();
      text = r.text;
      closeUp = r.closeUp;
      if (physical && this.status === "playing") {
        const events = this.advance(1);
        if (events.length) text += `\n${events.join("\n")}`;
      }
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
      text = e.message;
      ok = false;
    }
    // The image the agent gets back is this close-up, or else its own view: its next pixels refer to that.
    this.lastShot = closeUp;
    if (this.status === "playing" && this.actions >= MAX_ACTIONS) {
      this.finish({ success: false, verdict: `Out of time: ${MAX_ACTIONS} actions used without serving coffee.` });
      text += `\n\n${this.outcome!.verdict}`;
    }
    this.log.push({ n: this.actions, clock: this.clock(), action: label, targets: [...new Set(this.touched)], result: text, ok });
    this.version++;
    return { text, ok, closeUp };
  }

  // ---- looking and moving --------------------------------------------------

  look(): Step {
    return { text: "You look around." };
  }

  turn(degrees: number): Step {
    if (!Number.isFinite(degrees)) fail("Turn by a number of degrees.");
    this.pose.yaw = Math.atan2(Math.sin(this.pose.yaw + (degrees * Math.PI) / 180), Math.cos(this.pose.yaw + (degrees * Math.PI) / 180));
    return { text: degrees === 0 ? "You stay facing the same way." : `You turn ${Math.abs(Math.round(degrees))}° to the ${degrees > 0 ? "right" : "left"}.` };
  }

  tiltHead(degrees: number): Step {
    if (!Number.isFinite(degrees)) fail("Tilt by a number of degrees.");
    const before = this.pose.pitch;
    this.pose.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, before + (degrees * Math.PI) / 180));
    const clamped = Math.abs(this.pose.pitch - before - (degrees * Math.PI) / 180) > 1e-6;
    return { text: `You look ${degrees > 0 ? "up" : "down"}${clamped ? " as far as you comfortably can" : ""}.` };
  }

  move(forward: number, right: number): Step {
    const want = Math.hypot(forward, right);
    if (!(want > 0) || want > 4) fail("Step between 0 and 4 meters.");
    const moved = move(this, forward, right);
    if (moved < 0.01) fail("Something is in the way; you can't move in that direction.");
    return { text: moved < want - 0.04 ? `You move ${moved.toFixed(1)} m and bump into something.` : `You move ${moved.toFixed(1)} m.` };
  }

  walkTo(ref: { x: number; y: number }): Step {
    const at = this.pointAt(ref.x, ref.y);
    if ("held" in at) fail("That's in your hand. Point at the floor or at something in the room.");
    const hit = at.result;
    let walked: number | null;
    let text = "You walk over there";
    if (hit.kind === "thing") {
      this.touched.push(hit.thing.name);
      walked = walkTo(this, { box: at.boxes.get(hit.thing.id)!, facing: rootOf(this, hit.thing).facing ?? [0, 1] });
      text = "You walk up to it";
    } else if (hit.kind === "floor") walked = walkTo(this, { point: hit.point });
    else if (hit.kind === "wall") {
      // Pointing at a wall means "go over to that wall": stop on the floor a step short of it.
      const dx = hit.point[0] - this.pose.x;
      const dz = hit.point[2] - this.pose.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.6) fail("You're already right up against that wall.");
      const k = (len - 0.45) / len;
      walked = walkTo(this, { point: [this.pose.x + dx * k, 0, this.pose.z + dz * k] });
      text = "You walk over toward the wall";
    } else fail("Point at the floor where you want to go, or at something to walk up to it.");
    if (walked === null) fail("You can't find a way to get there.");
    return { text: walked < 0.05 ? "You're already there." : `${text} (${walked.toFixed(1)} m).` };
  }

  examine(ref: Ref): Step {
    const t = this.resolve(ref, "see");
    if (this.hands.includes(t.id)) {
      return {
        text: "You hold it up in front of your eyes and look at it closely. (Pointing at this close-up works too: your next pixels refer to it.)",
        closeUp: { inspect: t.id },
      };
    }
    const box = layoutBoxes(this).get(t.id)!;
    return { text: "You lean in for a closer look. (Pointing at this close-up works too: your next pixels refer to it.)", closeUp: { camera: closeUp(this, box) } };
  }

  // ---- hands-on actions ----------------------------------------------------

  /** Why something you tried to open or close won't budge. */
  private noHinges(t: Thing, verb: "open" | "close"): never {
    const front = fixedFront(t);
    if (front === "panels") fail("That's a fixed panel with no handle. It doesn't open. The doors and drawers that open all have handles.");
    if (front === "oven") fail("That door is fixed shut. You only need the dial and the burners on top.");
    fail(verb === "open" ? "That doesn't open." : "That doesn't close.");
  }

  open(ref: Ref): Step {
    const t = this.resolve(ref, "see", { accept: (c) => !!c.container?.openable && !c.container.open, radius: 12, stopAt: (c) => !!c.container?.openable || !!fixedFront(c) });
    if (!t.container?.openable) this.noHinges(t, "open");
    if (t.container.open) fail("It's already open.");
    this.mustReach(t);
    if (t.kind === "microwave" && t.on) fail("It's running. Switch it off first.");
    t.container.open = true;
    const chill = t.chill !== undefined ? (t.chill < 0 ? " A cloud of frost rolls out." : " Cold air spills out.") : "";
    return { text: `${t.kind === "drawer" ? "It slides open." : "It swings open."}${chill}` };
  }

  close(ref: Ref): Step {
    const want: Want = { accept: (c) => !!c.container?.openable && c.container.open, scan: true, radius: 30 };
    let t = this.resolve(ref, "see", want);
    if (!want.accept(t)) {
      // Last resort: the open door or drawer in reach whose middle is nearest the pixel.
      const near = "hand" in ref ? undefined : this.nearestOpenOnScreen(ref);
      if (near) t = near;
    }
    if (!t.container?.openable) this.noHinges(t, "close");
    if (!t.container.open) fail("It's already closed.");
    this.mustReach(t);
    t.container.open = false;
    return { text: "You close it." };
  }

  private nearestOpenOnScreen(ref: { x: number; y: number }): Thing | undefined {
    const boxes = layoutBoxes(this);
    const view = this.view();
    let best: Thing | undefined;
    let bestD = 160;
    for (const t of this.world.things.values()) {
      if (!t.container?.openable || !t.container.open || !inReach(this, boxes, t)) continue;
      const b = boxes.get(t.id);
      const p = b && view.project([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]);
      if (!p) continue;
      const d = Math.hypot(p.x - ref.x, p.y - ref.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best) this.touched.push(best.name);
    return best;
  }

  take(ref: Ref): Step {
    if ("hand" in ref) fail("You're already holding that.");
    const t = this.resolve(ref, "reach");
    if (this.hands.includes(t.id)) fail("You're already holding that.");
    if (!t.parent) fail("That's part of the house; you can't carry it.");
    if (!t.portable) fail("That's too awkward to carry around. Use it where it is.");
    const i = this.freeHand();
    const verbs: string[] = [];
    if (t.plugged) {
      t.plugged = false;
      verbs.push("unplug it");
    }
    if (t.kind === "kettle" && t.on) {
      t.on = false;
      verbs.push("switch it off");
    }
    t.parent = "hands";
    this.hands[i] = t.id;
    const hand = i === 0 ? "right" : "left";
    return { text: verbs.length ? `You ${verbs.join(" and ")}, then pick it up with your ${hand} hand.` : `You pick it up with your ${hand} hand.` };
  }

  /** The nearest worktop within reach with room on it (for things set down on top of a closed base unit). */
  private nearestWorktop(boxes: Map<string, Box>): Thing | undefined {
    let best: Thing | undefined;
    let bestD = Infinity;
    for (const t of this.world.things.values()) {
      if (t.kind !== "surface" || t.parent || !inReach(this, boxes, t)) continue;
      if ((t.box?.max[1] ?? 0) < 0.6 || this.children(t.id).length >= t.container!.slots) continue;
      const d = distanceTo(this, boxes, t);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  put(hand: Hand, dest: Ref): Step {
    const t = this.handItem(hand);
    if ("hand" in dest) fail("You can't put something into your own hand; use the other hand to take it.");
    let d = this.resolve(dest, "reach");
    if (this.hands.includes(d.id)) fail("You can't put something into your own hand; use the other hand to take it.");
    if (t.kind === "filter" && (d.kind === "coffee_maker" || (d.parent && d.parent !== "hands" && this.thing(d.parent).kind === "coffee_maker"))) {
      const cm = d.kind === "coffee_maker" ? d : this.thing(d.parent!);
      if (cm.filter) fail("There's already a paper filter in that basket.");
      cm.filter = true;
      this.dropFromHands(t);
      this.world.things.delete(t.id);
      return { text: "It slots neatly into the filter basket." };
    }
    // Pointing at something sitting on a surface means "put it down there too".
    if (!d.container && d.parent && d.parent !== "hands") d = this.thing(d.parent);
    if (!d.container) fail("There's nowhere to put it there.");
    let note = "";
    if (!d.container.open) {
      // The top of a closed base unit (a cabinet, drawers, a dishwasher) looks like worktop but holds nothing:
      // set it down on the worktop beside it instead. Its front still means "it's closed".
      const boxes = layoutBoxes(this);
      const box = boxes.get(d.id);
      const onTop = !d.parent && d.placement === "base" && box && this.lastPoint && this.lastPoint[1] >= box.max[1] - 0.02;
      const top = onTop ? this.nearestWorktop(boxes) : undefined;
      if (!top) {
        fail(onTop ? "That's the top of something closed; nothing can stay there. Open it to put things inside, or use an open stretch of worktop." : "That's closed. Open it first.");
      }
      d = top;
      this.touched.push(top.name);
      note = " (That spot is the top of something closed, so you use the worktop beside it.)";
    }
    if (d.kind === "kettle_base" && t.kind !== "kettle") fail("It doesn't sit on that.");
    if (d.kind === "coffee_maker" && !t.vessel) fail("That doesn't go on the warming plate.");
    if (d.kind === "stove" && !t.vessel) fail("Putting that on a burner seems like a bad idea.");
    const into = d.container!;
    if (this.children(d.id).length >= into.slots) fail("There's no room for it there.");
    this.dropFromHands(t);
    t.parent = d.id;
    let warn = "";
    if (d.kind === "stove" && d.on) warn = liquid(t.vessel!.stuff) < 1 ? " The burner is lit and it's empty: it will scorch." : " The burner is lit: it starts heating.";
    return { text: `${into.prep === "on" ? "You set it down." : "You put it inside."}${note}${warn}` };
  }

  /** What would come out if you tipped this vessel. */
  private pourable(t: Thing): Stuff {
    const s = t.vessel!.stuff;
    if (t.kind === "moka_pot") return (s.coffee ?? 0) > 0 ? { coffee: s.coffee } : { water: s.water };
    if (t.kind === "french_press" && t.pressed) {
      const { grounds: _g, beans: _b, ...rest } = s;
      return rest;
    }
    return { ...s };
  }

  /** "It now holds about 280 ml; it takes about 350 ml." */
  private levelText(v: Vessel): string {
    const now = volume(v.stuff);
    const full = now >= v.capacity - 2;
    return `It now holds ${amountText(v.stuff)}${full ? " and is full to the brim" : `; it takes about ${Math.round(v.capacity)} ml`}.`;
  }

  /**
   * Pour from a hand into what's at a pixel. Without `amount` you pour until the source is empty or the
   * target is full, and stop there. An explicit amount that doesn't fit overflows and spills (the mess
   * is scored). Pouring into something already full to the brim is refused before anything spills.
   */
  pour(hand: Hand, dest: Ref, amount?: number): Step {
    const src = this.handItem(hand);
    if (!src.vessel) fail("There's nothing in that to pour.");
    const dst = this.resolve(dest, "reach");
    if (dst === src) fail("You can't pour something into itself.");
    const avail = this.pourable(src);
    const total = liquid(avail) + solid(avail);
    if (total <= 0.01) fail("Nothing comes out. It's empty.");
    if (amount !== undefined && !(amount > 0)) fail("Pour a positive amount (ml for liquids, grams for solids).");
    const brim = amount === undefined;
    const scaled = (f: number): Stuff => {
      const out: Stuff = {};
      for (const k of [...LIQUIDS, ...SOLIDS]) {
        const n = (avail[k] ?? 0) * f;
        if (n > 0.01) out[k] = n;
      }
      return out;
    };
    let moved = scaled(brim ? 1 : Math.min(1, amount / total));
    const temp = src.vessel.temp;
    const strength = src.vessel.strength;
    const take = (): void => {
      for (const k in moved) add(src.vessel!.stuff, k as Substance, -(moved[k as Substance] ?? 0));
    };
    const full = (what: string, cap: string): never => fail(`${what} is already full (it takes about ${cap}). Pouring more would only spill.`);

    if (dst.kind === "sink") {
      take();
      return { text: `You pour ${amountText(moved)} down the drain.` };
    }

    if (dst.kind === "coffee_maker") {
      const others = Object.keys(moved).filter((k) => !["water", "grounds", "beans", "instant"].includes(k));
      if (others.length) fail("You stop yourself. That would gum up the machine.");
      const waterRoom = Math.max(0, 1800 - (dst.reservoir ?? 0));
      const basket = dst.basket!;
      const solidRoom = Math.max(0, 100 - solid(basket));
      const solids = (moved.grounds ?? 0) + (moved.beans ?? 0) + (moved.instant ?? 0);
      if (moved.water && waterRoom < 1) full("The water reservoir", "1800 ml");
      if (solids > 0 && solidRoom < 0.5) full("The filter basket", "100 g");
      if (brim) {
        if (moved.water) moved.water = Math.min(moved.water, waterRoom);
        const k = solids > 0 ? Math.min(1, solidRoom / solids) : 1;
        for (const s of ["grounds", "beans", "instant"] as const) if (moved[s]) moved[s] = moved[s]! * k;
      }
      take();
      const notes: string[] = [];
      if (moved.water) {
        const into = Math.min(waterRoom, moved.water);
        dst.reservoir = (dst.reservoir ?? 0) + into;
        notes.push(`about ${Math.round(into)} ml into the water reservoir (now about ${Math.round(dst.reservoir)} of 1800 ml)`);
        if (moved.water - into > 1) notes.push(this.spill("overfilled a coffee maker reservoir"));
      }
      const poured = (moved.grounds ?? 0) + (moved.beans ?? 0) + (moved.instant ?? 0);
      if (poured > 0) {
        const k = Math.min(1, solidRoom / poured);
        for (const s of ["grounds", "beans", "instant"] as const) if (moved[s]) add(basket, s, moved[s]! * k);
        notes.push(`about ${Math.round(poured * k)} g into the filter basket`);
        if (k < 1) notes.push(this.spill("overflowed a coffee maker basket"));
      }
      return { text: `You pour ${notes.join("; ")}.` };
    }

    if (dst.kind === "moka_pot") {
      const others = Object.keys(moved).filter((k) => !["water", "grounds", "beans"].includes(k));
      if (others.length) fail("That doesn't belong in there.");
      const waterRoom = Math.max(0, 200 - (dst.vessel!.stuff.water ?? 0));
      const solidRoom = Math.max(0, 22 - solid(dst.basket!));
      const solids = (moved.grounds ?? 0) + (moved.beans ?? 0);
      if (moved.water && waterRoom < 1) full("The bottom chamber", "200 ml");
      if (solids > 0 && solidRoom < 0.5) full("The funnel basket", "22 g");
      if (brim) {
        if (moved.water) moved.water = Math.min(moved.water, waterRoom);
        const k = solids > 0 ? Math.min(1, solidRoom / solids) : 1;
        if (moved.grounds) moved.grounds *= k;
        if (moved.beans) moved.beans *= k;
      }
      take();
      const notes: string[] = [];
      if (moved.water) {
        const into = Math.min(waterRoom, moved.water);
        this.mix(dst.vessel!, { water: into }, temp, 0);
        notes.push(`about ${Math.round(into)} ml into the bottom chamber (it takes about 200 ml)`);
        if (moved.water - into > 1) notes.push(this.spill("overfilled a moka pot"));
      }
      const poured = (moved.grounds ?? 0) + (moved.beans ?? 0);
      if (poured > 0) {
        const k = Math.min(1, solidRoom / poured);
        if (moved.grounds) add(dst.basket!, "grounds", moved.grounds * k);
        if (moved.beans) add(dst.basket!, "beans", moved.beans * k);
        notes.push(`about ${Math.round(poured * k)} g into the funnel basket (it takes about 22 g)`);
        if (k < 1) notes.push(this.spill("heaped too much into a moka basket"));
      }
      return { text: `You pour ${notes.join("; ")}.` };
    }

    if (dst.kind === "grinder") {
      if (Object.keys(moved).some((k) => k !== "beans")) fail("That's not something you put in there.");
      const room = Math.max(0, 120 - solid(dst.vessel!.stuff));
      if (room < 0.5) full("It", "120 g");
      const into = Math.min(room, moved.beans!);
      add(src.vessel.stuff, "beans", -into);
      add(dst.vessel!.stuff, "beans", into);
      return { text: `You pour about ${Math.round(into)} g in.${into < moved.beans! - 1 ? " It's full, so you stop." : ""}` };
    }

    if (!dst.vessel) fail("You can't pour into that.");
    if (dst.kind === "package" && !isEmpty(dst.vessel.stuff) && !Object.keys(moved).every((k) => k in dst.vessel!.stuff)) {
      fail("You'd ruin what's already in there.");
    }
    const room = Math.max(0, dst.vessel.capacity - volume(dst.vessel.stuff));
    if (room < 2) full("It", `${Math.round(dst.vessel.capacity)} ml`);
    let stopped = false;
    if (brim && volume(moved) > room) {
      moved = scaled(room / volume(avail));
      stopped = true;
    }
    take();
    const vol = volume(moved);
    let text = `You pour ${amountText(moved)}${stopped ? " and stop at the brim; the rest stays in your hand" : ""}.`;
    if (vol > room + 1) {
      const k = room / vol;
      const spilled = vol - room;
      for (const key in moved) moved[key as Substance] = moved[key as Substance]! * k;
      text = `You pour ${amountText(moved)} and it overflows: about ${Math.round(spilled)} ml goes over the side. ${this.spill("overfilled a container")}`;
    }
    this.mix(dst.vessel, moved, temp, strength);
    if (dst.kind === "french_press" && dst.pressed && (moved.grounds ?? 0) > 0) dst.pressed = false;
    return { text: `${text} ${this.levelText(dst.vessel)}` };
  }

  private mix(v: Vessel, moved: Stuff, temp: number, strength: number): void {
    const prevL = liquid(v.stuff);
    const addL = liquid(moved);
    if (addL > 0) v.temp = prevL > 0 ? (v.temp * prevL + temp * addL) / (prevL + addL) : temp;
    const prevC = v.stuff.coffee ?? 0;
    const addC = moved.coffee ?? 0;
    if (addC > 0) v.strength = (v.strength * prevC + strength * addC) / (prevC + addC);
    for (const k in moved) add(v.stuff, k as Substance, moved[k as Substance]!);
  }

  private spill(reason: string): string {
    this.penalties.push({ reason: `spill: ${reason}`, points: 30 });
    return "Some spills everywhere. (Mess!)";
  }

  private tap(ref: Ref): Thing {
    let sink = this.resolve(ref, "reach");
    // Pointing at a dish sitting in the basin still means "this sink".
    if (sink.kind !== "sink" && sink.parent && sink.parent !== "hands" && this.thing(sink.parent).kind === "sink") sink = this.thing(sink.parent);
    if (sink.kind !== "sink") fail("There's no tap there.");
    if (sink.waterOff) fail("You turn the tap. It coughs, and nothing comes out.");
    return sink;
  }

  fill(hand: Hand, at: Ref, amount?: number): Step {
    const t = this.handItem(hand);
    if (!FILLABLE.has(t.kind)) fail("That's not something you fill with water.");
    this.tap(at);
    const v = t.vessel!;
    const moka = t.kind === "moka_pot";
    const takes = moka ? 200 : v.capacity;
    const cap = moka ? 200 - (v.stuff.water ?? 0) : v.capacity - volume(v.stuff);
    if (cap <= 1) fail(`It's already full (it takes about ${takes} ml).`);
    if (amount !== undefined && !(amount > 0)) fail("Fill a positive number of ml.");
    const ml = Math.min(cap, amount ?? cap);
    this.mix(v, { water: ml }, 15, 0);
    const after = moka ? `The bottom chamber now holds about ${Math.round(v.stuff.water ?? 0)} ml; it takes about 200 ml.` : this.levelText(v);
    return { text: `Cold water runs from the tap. You fill it with about ${Math.round(ml)} ml. ${after}` };
  }

  wash(hand: Hand, at: Ref): Step {
    const t = this.handItem(hand);
    if (!t.vessel) fail("Washing that won't help.");
    if (t.kind === "package") fail("Washing that would ruin what's in it.");
    this.tap(at);
    t.vessel.stuff = {};
    t.vessel.strength = 0;
    t.vessel.temp = AMBIENT;
    t.dirty = false;
    if (t.basket) t.basket = {};
    t.spent = false;
    t.pressed = false;
    t.steep = 0;
    return { text: "You empty it, scrub it under the tap and rinse it. Clean." };
  }

  plugIn(ref: Ref): Step {
    let t = this.resolve(ref, "reach", { accept: (c) => (!!c.pluggable && !c.plugged) || c.kind === "kettle", radius: 24, stopAt: (c) => !!c.pluggable });
    if (t.kind === "kettle") {
      if (!t.parent || t.parent === "hands" || this.thing(t.parent).kind !== "kettle_base") fail("It's cordless. There's no plug on it.");
      t = this.thing(t.parent);
    }
    if (!t.pluggable) fail("That doesn't have a plug.");
    if (t.plugged) fail("It's already plugged in.");
    if (t.parent === "hands") fail("Set it down first; the cord won't reach.");
    if (this.thing(t.parent!).container?.prep !== "on") fail("It needs to be standing on a surface near an outlet.");
    t.plugged = true;
    return { text: "You push the plug into the wall outlet." };
  }

  switchOn(ref: Ref): Step {
    const t = this.resolve(ref, "reach", { accept: (c) => SWITCHED.has(c.kind) && !c.on, radius: 24, stopAt: (c) => SWITCHED.has(c.kind) });
    switch (t.kind) {
      case "kettle": {
        if (t.on) fail("It's already on.");
        const base = t.parent && t.parent !== "hands" ? this.thing(t.parent) : undefined;
        if (base?.kind !== "kettle_base") fail("You flick the switch. Nothing: it has to sit on its power base.");
        if (!base.plugged) fail("You flick the switch. Nothing. The light stays dark.");
        if (liquid(t.vessel!.stuff) < 1) fail("You stop: it's empty. Boiling it dry would wreck it.");
        t.on = true;
        return { text: "Click. A light comes on and it starts to rumble. (It switches itself off when it boils.)" };
      }
      case "coffee_maker":
        if (t.on) fail("It's already on.");
        if (!t.plugged) fail("You press the power button. Nothing happens. The display stays dark.");
        if (t.broken) fail(`You press the power button. ${t.broken}`);
        t.on = true;
        return { text: (t.reservoir ?? 0) > 0 ? "You press the power button. It hums and starts to gurgle." : "You press the power button. It hums, but nothing else happens." };
      case "grinder": {
        if (t.parent === "hands") fail("Set it down first; you need a hand to hold the lid.");
        if (!t.plugged) fail("You press the button. Nothing happens.");
        const s = t.vessel!.stuff;
        if (!s.beans) return { text: "It whirs loudly, but nothing much happens inside." };
        const b = s.beans;
        add(s, "beans", -b);
        add(s, "grounds", b);
        return { text: "BRRRRRR. It whirs for twenty seconds. The rattling inside turns to a soft hiss, then stops." };
      }
      case "microwave":
        if (t.on) fail("It's already running.");
        if (!t.plugged) fail("You press START. Nothing. The display is dark.");
        if (t.container!.open) fail("You press START. Nothing: the door is open.");
        t.on = true;
        t.runTicks = 2;
        return { text: "You press START. It hums and the light comes on. (It runs for one minute.)" };
      case "stove": {
        if (t.on) fail("It's already on.");
        t.on = true;
        const pans = this.children(t.id).filter((c) => c.vessel);
        const empty = pans.some((c) => liquid(c.vessel!.stuff) < 1);
        const tail = !pans.length
          ? " Nothing is sitting on the burners yet."
          : empty
            ? " Careful: something on the burners is empty, and it will scorch if it stays there."
            : " What's on top starts to heat.";
        return { text: `You turn the dial. Click-click-whoomph: the burners light. They stay on until you switch them off.${tail}` };
      }
      default:
        fail("You can't find a switch on that.");
    }
  }

  switchOff(ref: Ref): Step {
    const t = this.resolve(ref, "reach", { accept: (c) => SWITCHED.has(c.kind) && !!c.on, radius: 24, stopAt: (c) => SWITCHED.has(c.kind) });
    if (!t.on) fail(SWITCHED.has(t.kind) ? "It isn't on." : "You can't find a switch on that.");
    t.on = false;
    if (t.kind === "microwave") t.runTicks = 0;
    return { text: "You switch it off." };
  }

  press(ref: Ref): Step {
    const t = this.resolve(ref, "reach", { accept: (c) => c.kind === "french_press", radius: 30 });
    if (t.kind !== "french_press") fail("There's nothing to press there.");
    if (t.pressed) fail("The plunger is already all the way down.");
    t.pressed = true;
    return { text: (t.vessel!.stuff.grounds ?? 0) > 0 ? "You push the plunger down slowly, trapping the grounds at the bottom." : "You push the plunger down." };
  }

  taste(ref: Ref): Step {
    const t = this.resolve(ref, "reach");
    if (!t.vessel) fail("You lick it. That told you nothing.");
    const s = t.kind === "moka_pot" ? { coffee: t.vessel.stuff.coffee } : t.vessel.stuff;
    if (isEmpty(s)) fail("There's nothing in it to taste.");
    const notes: string[] = [];
    if (s.sour_milk) notes.push("Blech! Sour. That milk has gone off.");
    if (s.salt) notes.push("Salty!");
    if (s.sugar && !s.salt) notes.push("Sweet.");
    if (s.coffee) {
      const conc = (t.vessel.strength * s.coffee) / Math.max(1, liquid(s));
      notes.push(conc < 15 ? "Basically hot brown water." : conc < 30 ? "Weak coffee." : conc > 160 ? "Extremely strong coffee." : "Proper coffee.");
    } else if (s.water && !s.instant && !s.grounds) notes.push("Plain water.");
    if (s.instant) notes.push(s.water ? "Undissolved granules float in it; the water isn't hot enough." : "Bitter, dry coffee granules.");
    if (s.grounds && liquid(s) > 0 && !(t.kind === "french_press" && t.pressed)) notes.push("Gritty! Loose coffee grounds.");
    else if (s.grounds && !liquid(s)) notes.push("Dry, bitter coffee grounds.");
    if (s.beans) notes.push(liquid(s) > 0 ? "Whole beans bob around in it." : "Crunchy roasted coffee beans.");
    if (s.milk && !s.coffee) notes.push("Fresh milk.");
    if (s.tea) notes.push("Dry tea leaves.");
    if (liquid(s) > 0) {
      const temp = Math.round(t.vessel.temp);
      notes.push(temp >= 90 ? "Scalding hot!" : temp >= 60 ? "Hot." : temp >= 40 ? "Warm." : temp <= 8 ? "Fridge-cold." : "Room temperature.");
    }
    return { text: `You taste a little. ${notes.join(" ")}` };
  }

  wait(minutes: number): Step {
    const ticks = Math.max(1, Math.min(20, Math.round(minutes * (60 / TICK_SECONDS))));
    const events = this.advance(ticks - 1);
    return { text: `You wait ${(ticks * TICK_SECONDS) / 60} minute(s).${events.length ? `\n${[...new Set(events)].join("\n")}` : ""}` };
  }

  serve(hand: Hand): Step {
    const t = this.handItem(hand);
    if (t.kind !== "mug") fail("You'd serve coffee in a mug, not in that.");
    this.judge(t);
    const o = this.outcome!;
    return {
      text: `You hand over the mug.\n\n${o.success ? "SUCCESS" : "FAILED"}: ${o.verdict}\n${o.notes.map((n) => `- ${n}`).join("\n")}\nScore: ${o.score} (grade ${o.grade}) in ${this.actions} actions, ${this.clock()}.`,
    };
  }

  giveUp(): Step {
    this.finish({ success: false, verdict: "Gave up." });
    return { text: "You give up. The owner makes their own coffee." };
  }

  // ---- simulation ----------------------------------------------------------

  /** Advance time; returns narration for anything noticeable (sounds and smells, never names). */
  advance(ticks: number): string[] {
    const events: string[] = [];
    for (let i = 0; i < ticks; i++) this.step(events);
    return events;
  }

  private chillOf(t: Thing): number {
    for (let p = t.parent; p && p !== "hands"; p = this.thing(p).parent) {
      const c = this.thing(p).chill;
      if (c !== undefined && !this.thing(p).container?.open) return c;
    }
    return AMBIENT;
  }

  private step(events: string[]): void {
    this.tick++;
    const heat = new Map<string, number>();
    const warm = new Set<string>();
    const all = [...this.world.things.values()];

    for (const t of all) {
      if (t.kind === "stove" && t.on) {
        for (const c of this.children(t.id)) if (c.vessel) heat.set(c.id, 20);
      }
      if (t.kind === "kettle" && t.on) {
        const base = t.parent && t.parent !== "hands" ? this.thing(t.parent) : undefined;
        if (base?.kind === "kettle_base" && base.plugged) heat.set(t.id, 25);
        else t.on = false;
      }
      if (t.kind === "microwave" && t.on) {
        const inside = this.children(t.id);
        if (inside.some((c) => c.material === "metal")) {
          t.on = false;
          t.runTicks = 0;
          this.penalties.push({ reason: "put metal in the microwave (sparks!)", points: 300 });
          events.push("BZZT! Sparks crackle and flash. It shuts itself off with a smell of ozone.");
          continue;
        }
        for (const c of inside) if (c.vessel) heat.set(c.id, 35);
        t.runTicks = (t.runTicks ?? 1) - 1;
        if (t.runTicks <= 0) {
          t.on = false;
          events.push("Beep beep beep! Something has finished running.");
        }
      }
      if (t.kind === "coffee_maker" && t.on && t.plugged && !t.broken) this.brewDrip(t, events, warm);
    }

    for (const t of all) {
      const v = t.vessel;
      if (!v) continue;
      const rate = heat.get(t.id);
      const liq = liquid(v.stuff);
      if (rate !== undefined) {
        const onStove = !!t.parent && t.parent !== "hands" && this.thing(t.parent).kind === "stove";
        if (liq > 0) {
          const before = v.temp;
          v.temp = Math.min(100, v.temp + rate);
          if (onStove && before < 60 && v.temp >= 60 && v.temp < 100) events.push("A low hiss and ticking from the burners: something on them is heating up.");
          if (v.temp >= 100 && t.kind !== "moka_pot") {
            if (onStove && v.stuff.water) add(v.stuff, "water", -25);
            if (t.kind === "kettle" && t.on) {
              t.on = false;
              events.push("A rolling boil, then a loud click as something switches itself off.");
            } else if (t.kind === "stovetop_kettle") {
              const left = v.stuff.water ?? 0;
              if (!t.whistled) events.push("A shrill whistle! The water is boiling, and it keeps boiling away for as long as the burner stays on.");
              else if (left < 150) events.push("The whistle turns ragged and sputters: the water is running low.");
              else events.push("The whistle keeps shrieking.");
              t.whistled = true;
            } else if (before < 100) events.push("You hear something come to a rolling boil.");
          }
          if (t.kind !== "moka_pot") t.runTicks = 0;
        } else if (onStove && t.kind !== "moka_pot") {
          this.dryHeat(t, events);
        }
        if (t.kind === "moka_pot") this.brewMoka(t, events);
      } else if (warm.has(t.id)) {
        v.temp = Math.max(v.temp, 80);
      } else {
        const target = this.chillOf(t);
        v.temp = target + (v.temp - target) * 0.98;
      }
      this.extract(t);
    }
  }

  private dryHeat(t: Thing, events: string[]): void {
    t.runTicks = (t.runTicks ?? 0) + 1;
    // Two warnings before the damage is done.
    if (t.runTicks === 1 && !t.scorched) events.push("A dry, hot smell from the burners: something on them is empty.");
    if (t.runTicks === 2 && !t.scorched) events.push("The hot-metal smell gets stronger. Something empty on the burners is about to scorch.");
    if (t.runTicks >= 3 && !t.scorched) {
      t.scorched = true;
      this.penalties.push({ reason: `scorched an empty ${t.name} on the stove`, points: 100 });
      events.push("A burning smell! Something empty is scorching on a hot burner.");
    }
  }

  private brewDrip(cm: Thing, events: string[], warm: Set<string>): void {
    const plate = this.children(cm.id).find((c) => c.vessel);
    if (plate && liquid(plate.vessel!.stuff) > 0) warm.add(plate.id);
    const res = cm.reservoir ?? 0;
    if (res <= 0) return;
    const basket = cm.basket!;
    if (!cm.steep) {
      const g = (basket.grounds ?? 0) + (basket.beans ?? 0) * 0.08 + (basket.instant ?? 0) * 7.5;
      cm.brewStrength = (g / (res / 1000)) * (cm.spent ? 0.15 : 1);
      cm.steep = 1;
    }
    const out = Math.min(300, res);
    cm.reservoir = res - out;
    const produced = out * 0.95;
    const grit = cm.filter ? 0 : (basket.grounds ?? 0) * 0.05;
    if (grit > 0) add(basket, "grounds", -grit);
    if (!plate) {
      this.penalties.push({ reason: "brewed onto an empty warming plate", points: 60 });
      events.push("Hot liquid streams onto a bare warming plate and floods across the counter! (Mess!)");
    } else {
      const v = plate.vessel!;
      const room = Math.max(0, v.capacity - volume(v.stuff));
      const keep = Math.min(1, room / (produced + grit * 2));
      this.mix(v, { coffee: produced * keep, ...(grit ? { grounds: grit * keep } : {}) }, 88, cm.brewStrength!);
      if (keep < 1) {
        this.penalties.push({ reason: `${plate.name} overflowed under the coffee maker`, points: 40 });
        events.push("Liquid overflows and runs across the counter! (Mess!)");
      } else events.push("Gurgle, hiss, drip-drip-drip.");
      warm.add(plate.id);
    }
    if (cm.reservoir <= 0) {
      cm.steep = 0;
      if ((basket.grounds ?? 0) > 0 || (basket.beans ?? 0) > 0) cm.spent = true;
      events.push("A long sigh of steam, and the dripping stops.");
    }
  }

  private brewMoka(t: Thing, events: string[]): void {
    const v = t.vessel!;
    const water = v.stuff.water ?? 0;
    if (v.temp < 100) return;
    if (water <= 0) {
      this.dryHeat(t, events);
      return;
    }
    const basket = t.basket!;
    if (!t.steep) {
      const g = (basket.grounds ?? 0) + (basket.beans ?? 0) * 0.08;
      t.brewStrength = (g / (water / 1000)) * (t.spent ? 0.15 : 1);
      t.steep = 1;
    }
    const out = Math.min(water, 70);
    add(v.stuff, "water", -out);
    const prevC = v.stuff.coffee ?? 0;
    const made = out * 0.95;
    v.strength = (v.strength * prevC + t.brewStrength! * made) / (prevC + made);
    add(v.stuff, "coffee", made);
    t.runTicks = 0;
    if ((v.stuff.water ?? 0) <= 0) {
      t.steep = 0;
      if (solid(basket) > 0) t.spent = true;
      events.push("Sputtering and hissing from a burner.");
    } else events.push("A gurgling sound from a burner.");
  }

  /** Instant dissolving and immersion brewing (French press, cowboy coffee). */
  private extract(t: Thing): void {
    const v = t.vessel!;
    const s = v.stuff;
    if ((s.instant ?? 0) > 0 && (s.water ?? 0) > 0 && v.temp >= 70) {
      const water = s.water!;
      const strength = (s.instant! * 7.5) / (water / 1000);
      const prevC = s.coffee ?? 0;
      v.strength = (v.strength * prevC + strength * water) / (prevC + water);
      add(s, "coffee", water);
      delete s.water;
      delete s.instant;
    }
    if (BREW_EXCLUDED.has(t.kind)) return;
    const grounds = (s.grounds ?? 0) + (s.beans ?? 0) * 0.08;
    const liq = (s.water ?? 0) + (s.coffee ?? 0);
    if (grounds <= 0 || liq <= 0 || t.pressed) return;
    t.steep = (t.steep ?? 0) + (v.temp >= 80 ? 1 : v.temp >= 60 ? 0.5 : 0.15);
    // Added water dilutes what's already brewed; immersion can only strengthen it from there.
    const coffee = s.coffee ?? 0;
    if (s.water) {
      v.strength = (v.strength * coffee) / (coffee + s.water);
      add(s, "coffee", s.water);
      delete s.water;
    }
    v.strength = Math.max(v.strength, (grounds / (liq / 1000)) * Math.min(1, t.steep / 4));
  }

  // ---- judging -------------------------------------------------------------

  private judge(mug: Thing): void {
    const v = mug.vessel!;
    const s = v.stuff;
    const pref = this.world.pref;
    const coffee = s.coffee ?? 0;
    const liq = liquid(s);
    const conc = liq > 0 ? (v.strength * coffee) / liq : 0;
    const deduct = (points: number, reason: string): void => {
      this.penalties.push({ reason, points });
    };

    let failure: string | undefined;
    if (coffee <= 0) {
      failure = s.instant ? "Instant granules sitting in lukewarm water. It never dissolved: the water wasn't hot." : "There's no coffee in the mug.";
    } else if (liq < MIN_COFFEE_ML) failure = `Only ${Math.round(liq)}ml. That's a sip, not a cup.`;
    else if (conc < 15) failure = "That's hot brown water, not coffee.";
    else if ((s.salt ?? 0) > 0.5) failure = "One sip and they spit it out: it's SALTY. The salt and sugar got mixed up.";
    else if ((s.sour_milk ?? 0) > 0.5) failure = "The milk was spoiled. Curdled lumps float on top.";
    else if (v.temp < 40) failure = `It's stone cold (${Math.round(v.temp)}°C).`;

    if (!failure) {
      if (v.temp < 55) deduct(100, `lukewarm (${Math.round(v.temp)}°C)`);
      if (conc < 30) deduct(100, "weak coffee");
      if (conc > 160) deduct(100, "punishingly strong");
      if ((s.grounds ?? 0) > 0.5) deduct(120, "gritty: coffee grounds in the cup");
      if ((s.beans ?? 0) > 0.5) deduct(100, "whole beans floating in the cup");
      if ((s.tea ?? 0) > 0.5) deduct(150, "tea leaves in the coffee");
      if (mug.dirty) deduct(150, "served in a dirty mug");
      const milk = s.milk ?? 0;
      if (pref.milk && milk < 10) deduct(200, "they asked for milk");
      if (!pref.milk && milk > 0.5) deduct(200, "they wanted it without milk");
      if (pref.milk && milk > liq * 0.6) deduct(80, "more milk than coffee");
      const sugar = s.sugar ?? 0;
      if (pref.sugar && sugar < 2) deduct(150, "they asked for sugar");
      if (pref.sugar && sugar > 20) deduct(100, `way too sweet (${Math.round(sugar)}g of sugar)`);
      if (!pref.sugar && sugar > 0.5) deduct(150, "they didn't want sugar");
    }

    for (const t of this.world.things.values()) {
      if (t.kind === "stove" && t.on) deduct(150, "left the stove on");
    }

    this.finish({ success: !failure, verdict: failure ?? "A proper cup of coffee." });
  }

  private finish(r: { success: boolean; verdict: string }): void {
    const penalty = this.penalties.reduce((a, p) => a + p.points, 0);
    const efficiency = this.physical * 2 + this.observations;
    const score = r.success ? Math.max(50, 1000 - efficiency - penalty) : 0;
    const grade = !r.success ? "F" : score >= 800 ? "S" : score >= 650 ? "A" : score >= 500 ? "B" : score >= 350 ? "C" : "D";
    const notes = this.penalties.map((p) => `-${p.points}: ${p.reason}`);
    if (r.success) notes.push(`-${efficiency}: ${this.physical} physical actions x2 + ${this.observations} looks/turns x1`);
    this.outcome = { success: r.success, score, grade, verdict: r.verdict, notes };
    this.status = r.success ? "won" : "failed";
    this.endedAt = Date.now();
  }
}
