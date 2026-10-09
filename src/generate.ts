// Procedural house generator. Every seed yields a solvable but unfamiliar house.

import {
  AGENT_RADIUS,
  footDistance,
  footprints,
  layoutRooms,
  placeFurniture,
  REACH,
  WalkGrid,
  type HouseShell,
  type RoomSpec,
} from "./layout";
import { Rng } from "./rng";
import type { Kind, Material, Method, Placement, Preference, Recipe, Room, Stuff, Thing, World } from "./world";

const BRANDS = ["Hillside Roasters", "Blue Kettle Co.", "Northern Lights", "Casa Morena", "Old Harbor", "Peak District"];
const ROASTS = ["Light Roast", "Medium Roast", "Dark Roast", "Breakfast Blend", "Espresso Roast", "House Blend"];
const OWNERS = ["Sam", "Robin", "Alex", "Jordan", "Morgan", "Casey"];
const MUG_NAMES = [
  "white mug",
  "blue mug",
  "striped mug",
  "chipped green mug",
  "'World's Best Boss' mug",
  "yellow mug",
  "speckled mug",
  "black mug",
];

const PREFS: readonly Preference[] = [
  { milk: false, sugar: false, phrase: "black, nothing in it" },
  { milk: true, sugar: false, phrase: "with a splash of milk, no sugar" },
  { milk: true, sugar: true, phrase: "with milk and one sugar" },
  { milk: false, sugar: true, phrase: "black with one sugar" },
];

type Clutter = readonly (readonly [string, Material])[];

const CLUTTER: Record<string, Clutter> = {
  upper: [
    ["stack of plates", "ceramic"],
    ["cereal bowls", "ceramic"],
    ["drinking glasses", "glass"],
    ["wine glasses", "glass"],
    ["box of cereal", "cardboard"],
    ["bag of pasta", "plastic"],
    ["canned tomatoes", "metal"],
    ["jar of peanut butter", "glass"],
    ["honey jar", "glass"],
    ["bottle of olive oil", "glass"],
    ["spice rack", "wood"],
    ["box of crackers", "cardboard"],
  ],
  drawer: [
    ["cutlery tray", "plastic"],
    ["spatula", "plastic"],
    ["tea towels", "fabric"],
    ["batteries", "metal"],
    ["scissors", "metal"],
    ["takeout menus", "paper"],
    ["roll of foil", "metal"],
    ["measuring spoons", "metal"],
    ["rubber bands", "plastic"],
    ["wooden spoons", "wood"],
  ],
  lower: [
    ["saucepan", "metal"],
    ["frying pan", "metal"],
    ["mixing bowls", "glass"],
    ["baking tray", "metal"],
    ["cleaning spray", "plastic"],
    ["trash bags", "plastic"],
    ["colander", "metal"],
    ["casserole dish", "ceramic"],
  ],
  fridge: [
    ["carton of eggs", "cardboard"],
    ["butter", "paper"],
    ["jam", "glass"],
    ["leftover lasagna", "glass"],
    ["orange juice", "cardboard"],
    ["block of cheese", "plastic"],
    ["ketchup", "plastic"],
  ],
  freezer: [
    ["frozen peas", "plastic"],
    ["ice cube tray", "plastic"],
    ["tub of ice cream", "cardboard"],
    ["frozen pizza", "cardboard"],
  ],
  pantry: [
    ["bag of flour", "paper"],
    ["tinned beans", "metal"],
    ["bag of chips", "plastic"],
    ["rice", "plastic"],
    ["rolled oats", "cardboard"],
    ["soup cans", "metal"],
    ["paper towels", "paper"],
    ["dog food", "plastic"],
    ["bottled water", "plastic"],
  ],
  living: [
    ["TV remote", "plastic"],
    ["magazines", "paper"],
    ["board game", "cardboard"],
    ["throw cushion", "fabric"],
    ["paperback novel", "paper"],
  ],
  hall: [
    ["house keys", "metal"],
    ["umbrella", "fabric"],
    ["pair of shoes", "fabric"],
    ["junk mail", "paper"],
  ],
  bath: [
    ["toothpaste", "plastic"],
    ["aspirin", "plastic"],
    ["hand soap", "plastic"],
    ["hand towel", "fabric"],
  ],
  laundry: [
    ["laundry detergent", "plastic"],
    ["clothespins", "wood"],
    ["iron", "metal"],
    ["pile of laundry", "fabric"],
  ],
  garage: [
    ["toolbox", "metal"],
    ["paint can", "metal"],
    ["bike pump", "metal"],
    ["extension cord", "plastic"],
  ],
  dining: [
    ["tablecloth", "fabric"],
    ["candles", "wood"],
    ["good china", "ceramic"],
    ["placemats", "fabric"],
  ],
};

const ROOMS: Record<string, { name: string; desc: string }> = {
  hallway: { name: "Hallway", desc: "A narrow entrance hallway. Coats hang by the door." },
  living_room: { name: "Living Room", desc: "A lived-in living room with a sagging sofa." },
  kitchen: { name: "Kitchen", desc: "The kitchen. Someone else's system of organization." },
  dining_room: { name: "Dining Room", desc: "A small dining room with a wooden table." },
  pantry: { name: "Pantry", desc: "A walk-in pantry lined with shelves." },
  bathroom: { name: "Bathroom", desc: "A compact bathroom with a pedestal sink." },
  laundry: { name: "Laundry Room", desc: "A cramped laundry room that smells of detergent." },
  garage: { name: "Garage", desc: "A cold garage with a concrete floor." },
};

const DATE = "Thu 9 Oct";

/** Interior size in metres (width x depth; the layout may rotate rooms). */
const ROOM_SIZE: Record<string, { w: number; d: number }> = {
  hallway: { w: 2.2, d: 6.0 },
  living_room: { w: 5.0, d: 4.5 },
  kitchen: { w: 5.2, d: 4.4 },
  dining_room: { w: 3.8, d: 3.6 },
  pantry: { w: 2.4, d: 2.2 },
  bathroom: { w: 2.4, d: 2.2 },
  laundry: { w: 2.8, d: 2.4 },
  garage: { w: 5.5, d: 5.0 },
};

class Builder {
  readonly things = new Map<string, Thing>();
  readonly rooms = new Map<string, Room>();
  private readonly names = new Set<string>();

  constructor(readonly rng: Rng) {}

  room(id: string): Room {
    const def = ROOMS[id]!;
    const r: Room = { id, name: def.name, desc: def.desc, exits: [] };
    this.rooms.set(id, r);
    return r;
  }


  private add(t: Omit<Thing, "id" | "name"> & { name: string }): Thing {
    let name = t.name;
    for (let n = 2; this.names.has(name); n++) name = `${t.name} ${n}`;
    this.names.add(name);
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    const thing: Thing = { ...t, id, name };
    this.things.set(id, thing);
    return thing;
  }

  furniture(room: string, kind: Kind, name: string, placement: Placement, extra: Partial<Thing> = {}): Thing {
    return this.add({
      kind,
      name,
      desc: extra.desc ?? `A ${name}.`,
      parent: null,
      room,
      placement,
      portable: false,
      material: "wood",
      ...extra,
    });
  }

  cabinet(room: string, name: string, placement: Placement, slots = 8): Thing {
    return this.furniture(room, "cabinet", name, placement, {
      container: { open: false, openable: true, slots, prep: "in" },
    });
  }

  shelf(room: string, name: string, placement: Placement, slots = 8): Thing {
    return this.furniture(room, "shelf", name, placement, {
      container: { open: true, openable: false, slots, prep: "on" },
    });
  }

  surface(room: string, name: string, placement: Placement, slots = 10): Thing {
    return this.furniture(room, "surface", name, placement, {
      container: { open: true, openable: false, slots, prep: "on" },
    });
  }

  item(parent: Thing, kind: Kind, name: string, extra: Partial<Thing> = {}): Thing {
    return this.add({
      kind,
      name,
      desc: extra.desc ?? `A ${name}.`,
      parent: parent.id,
      portable: true,
      material: "plastic",
      ...extra,
    });
  }

  appliance(parent: Thing, kind: Kind, name: string, extra: Partial<Thing> = {}): Thing {
    return this.item(parent, kind, name, {
      portable: false,
      pluggable: true,
      plugged: !this.rng.chance(0.35),
      on: false,
      material: "metal",
      ...extra,
    });
  }

  clutter(parent: Thing, pool: string, n: number): void {
    const options = this.rng.shuffle([...CLUTTER[pool]!]);
    for (const [name, material] of options.slice(0, n)) {
      if (this.names.has(name)) continue;
      this.item(parent, "misc", name, { material, desc: `A ${name}. Not useful for coffee.` });
    }
  }

  childCount(id: string): number {
    let n = 0;
    for (const t of this.things.values()) if (t.parent === id) n++;
    return n;
  }

  /** Pick a container that still has free slots. */
  roomy(candidates: Thing[]): Thing {
    const open = candidates.filter((c) => this.childCount(c.id) < c.container!.slots);
    return this.rng.pick(open.length ? open : candidates);
  }
}

function vessel(capacity: number, stuff: Stuff = {}, temp = 20): Thing["vessel"] {
  return { stuff, temp, capacity, strength: 0 };
}

export function generateHouse(seed: string): World {
  const rng = new Rng(seed);
  const b = new Builder(rng);
  const twists: string[] = [];

  const method = rng.weighted<Method>([
    ["drip", 35],
    ["press", 30],
    ["moka", 20],
    ["instant", 15],
  ]);
  const beans = method !== "instant" && rng.chance(0.4);
  const kitchenWaterOff = rng.chance(0.12);
  const owner = rng.pick(OWNERS);
  const pref = rng.pick(PREFS);

  // ---- rooms ---------------------------------------------------------------
  b.room("hallway");
  b.room("living_room");
  b.room("kitchen");
  const hasDining = rng.chance(0.5);
  const hasPantry = rng.chance(0.6);
  const hasBath = kitchenWaterOff || rng.chance(0.7);
  const hasLaundry = rng.chance(0.4);
  const hasGarage = rng.chance(0.35);
  if (hasDining) b.room("dining_room");
  if (hasPantry) b.room("pantry");
  if (hasBath) b.room("bathroom");
  if (hasLaundry) b.room("laundry");
  if (hasGarage) b.room("garage");

  // Physical placement happens at the end (layoutHouse); here we only say which room each one hangs off.
  const specs: RoomSpec[] = [{ id: "hallway", ...ROOM_SIZE.hallway!, parent: null }];
  const spec = (id: string, parent: string): void => {
    specs.push({ id, ...ROOM_SIZE[id]!, parent });
  };
  spec("living_room", "hallway");
  if (hasDining) spec("dining_room", "hallway");
  spec("kitchen", hasDining ? "dining_room" : "hallway");
  if (hasPantry) spec("pantry", "kitchen");
  if (hasBath) spec("bathroom", "hallway");
  if (hasLaundry) spec("laundry", rng.chance(0.5) ? "kitchen" : "hallway");
  if (hasGarage) spec("garage", hasLaundry ? "laundry" : "hallway");
  const extraDoors = [
    ["hallway", "kitchen", hasDining ? 0.4 : 0],
    ["living_room", "kitchen", 0.3],
  ] as const;

  // ---- kitchen furniture ---------------------------------------------------
  const uppers: Thing[] = [];
  const nUpper = rng.int(3, 4);
  for (let i = 1; i <= nUpper; i++) uppers.push(b.cabinet("kitchen", `upper cabinet ${i}`, "upper", 6));

  const counter = b.surface("kitchen", "counter", "base", 30);
  counter.desc = "A long stretch of countertop with power outlets along the backsplash.";
  const sink = b.furniture("kitchen", "sink", "kitchen sink", "base", {
    container: { open: true, openable: false, slots: 6, prep: "in" },
    material: "metal",
    desc: "A stainless-steel kitchen sink with a mixer tap.",
  });
  if (kitchenWaterOff) {
    sink.waterOff = `Note taped to the tap: "Kitchen water is OFF - leak under the sink. Plumber Tuesday. Use the bathroom tap! - ${owner}"`;
    twists.push("kitchen water off");
  }
  const stove = b.furniture("kitchen", "stove", "stove", "base", {
    container: { open: true, openable: false, slots: 2, prep: "on" },
    material: "metal",
    on: false,
    desc: "A four-burner stove. A single dial lights the front burners: everything sitting on the stove gets heated.",
  });

  const lowers: Thing[] = [];
  const drawers: Thing[] = [];
  const nLower = rng.int(2, 3);
  for (let i = 1; i <= nLower; i++) lowers.push(b.cabinet("kitchen", `lower cabinet ${i}`, "base", 8));
  for (let i = 1; i <= 3; i++) {
    const d = b.furniture("kitchen", "drawer", `drawer ${i}`, "base", {
      container: { open: false, openable: true, slots: 6, prep: "in" },
    });
    drawers.push(d);
  }
  const fridge = b.furniture("kitchen", "fridge", "fridge", "tall", {
    container: { open: false, openable: true, slots: 10, prep: "in" },
    chill: 4,
    material: "metal",
    desc: "A humming fridge covered in magnets and takeout menus.",
  });
  const freezer = rng.chance(0.5)
    ? b.furniture("kitchen", "fridge", "freezer", "tall", {
        container: { open: false, openable: true, slots: 6, prep: "in" },
        chill: -18,
        material: "metal",
        desc: "A tall freezer, frosty inside.",
      })
    : undefined;
  const dishwasher = rng.chance(0.7)
    ? b.furniture("kitchen", "dishwasher", "dishwasher", "base", {
        container: { open: false, openable: true, slots: 12, prep: "in" },
        material: "metal",
        desc: "A dishwasher. The light says CLEAN.",
      })
    : undefined;
  const island = rng.chance(0.3) ? b.surface("kitchen", "kitchen island", "floor", 6) : undefined;

  // ---- other rooms ---------------------------------------------------------
  const consoleTable = b.surface("hallway", "console table", "floor", 5);
  b.furniture("hallway", "decor", "coat rack", "tall", { desc: "A coat rack, heavy with jackets." });
  const shoeCab = b.cabinet("hallway", "shoe cabinet", "base", 4);
  b.clutter(shoeCab, "hall", 2);
  b.clutter(consoleTable, "hall", 1);

  const sofa = b.surface("living_room", "sofa", "floor", 3);
  const coffeeTable = b.surface("living_room", "coffee table", "floor", 4);
  coffeeTable.desc = "A low coffee table. Despite the name, there is no coffee on it.";
  const bookshelf = b.shelf("living_room", "bookshelf", "tall", 6);
  b.furniture("living_room", "decor", "television", "floor", { desc: "A large TV. It is off." });
  b.clutter(sofa, "living", 1);
  b.clutter(coffeeTable, "living", 2);
  b.item(coffeeTable, "misc", "coffee-table book", {
    material: "paper",
    label: "The World Atlas of Coffee",
    desc: "A glossy coffee-table book about coffee. Inspirational, but not drinkable.",
  });
  b.item(bookshelf, "misc", "row of books", { material: "paper", desc: "Cookbooks, novels, a manual for a bread machine." });
  b.clutter(bookshelf, "living", 1);

  const pantryShelves: Thing[] = [];
  if (hasPantry) {
    for (let i = 1; i <= 3; i++) pantryShelves.push(b.shelf("pantry", `pantry shelf ${i}`, "tall", 8));
    for (const s of pantryShelves) b.clutter(s, "pantry", rng.int(2, 3));
  }

  let sideboard: Thing | undefined;
  if (hasDining) {
    const table = b.surface("dining_room", "dining table", "floor", 6);
    b.item(table, "misc", "fruit bowl", { material: "ceramic", desc: "A bowl of slightly bruised apples." });
    sideboard = b.cabinet("dining_room", "sideboard", "base", 8);
    b.clutter(sideboard, "dining", 2);
  }

  let bathSink: Thing | undefined;
  if (hasBath) {
    bathSink = b.furniture("bathroom", "sink", "bathroom sink", "base", {
      container: { open: true, openable: false, slots: 3, prep: "in" },
      material: "ceramic",
      desc: "A small pedestal sink. The tap works.",
    });
    const mirror = b.cabinet("bathroom", "mirror cabinet", "upper", 5);
    b.clutter(mirror, "bath", 2);
  }

  if (hasLaundry) {
    const washer = b.furniture("laundry", "cabinet", "washing machine", "base", {
      container: { open: false, openable: true, slots: 4, prep: "in" },
      material: "metal",
      desc: "A front-loading washing machine.",
    });
    b.clutter(washer, "laundry", 1);
    const laundryShelf = b.shelf("laundry", "utility shelf", "upper", 6);
    b.clutter(laundryShelf, "laundry", 2);
    if (rng.chance(0.5)) {
      b.furniture("laundry", "sink", "utility sink", "base", {
        container: { open: true, openable: false, slots: 4, prep: "in" },
        material: "plastic",
        desc: "A deep plastic utility sink.",
      });
    }
  }

  let garageFridge: Thing | undefined;
  if (hasGarage) {
    const bench = b.surface("garage", "workbench", "floor", 6);
    b.clutter(bench, "garage", 2);
    const toolShelf = b.shelf("garage", "tool shelf", "tall", 6);
    b.clutter(toolShelf, "garage", 1);
    if (rng.chance(0.6)) {
      garageFridge = b.furniture("garage", "fridge", "garage fridge", "tall", {
        container: { open: false, openable: true, slots: 6, prep: "in" },
        chill: 4,
        material: "metal",
        desc: "An old beer fridge.",
      });
    }
  }

  // ---- water ----------------------------------------------------------------
  // hasBath is forced when the kitchen water is off.
  const waterSink = kitchenWaterOff ? bathSink! : sink;

  // ---- brewer --------------------------------------------------------------
  let brewer: Thing | undefined;
  let heater: Thing | undefined;

  const makeCoffeeMaker = (broken?: string): Thing => {
    const cm = b.appliance(counter, "coffee_maker", "coffee maker", {
      container: { open: true, openable: false, slots: 1, prep: "on" },
      reservoir: 0,
      basket: {},
      filter: false,
      broken,
      desc: "A drip coffee maker: water reservoir at the back, a swing-out filter basket, and a warming plate for the carafe.",
    });
    const carafeHome =
      broken || rng.chance(0.8) ? cm : rng.pick([dishwasher ?? sink, sink, rng.pick(uppers)].filter(Boolean) as Thing[]);
    if (carafeHome !== cm) twists.push("carafe away from machine");
    b.item(carafeHome, "carafe", "glass carafe", {
      material: "glass",
      vessel: vessel(1500),
      desc: "A glass coffee carafe with a plastic handle.",
    });
    return cm;
  };

  if (method === "drip") {
    brewer = makeCoffeeMaker();
  } else if (rng.chance(0.4)) {
    makeCoffeeMaker("The display flashes 'E:04 DESCALE' and the machine refuses to do anything.");
    twists.push("broken coffee maker decoy");
  }

  if (method === "press") {
    const home = rng.pick([counter, ...uppers, ...(sideboard ? [sideboard] : [])]);
    brewer = b.item(home, "french_press", "french press", {
      material: "glass",
      vessel: vessel(1000),
      pressed: false,
      steep: 0,
      desc: "A glass French press with a metal mesh plunger. Add coarse grounds and hot water, steep about 4 minutes, then press.",
    });
  }
  if (method === "moka") {
    const home = rng.pick([stove, rng.pick(uppers), rng.pick(lowers), counter]);
    brewer = b.item(home, "moka_pot", "moka pot", {
      material: "metal",
      vessel: vessel(200),
      basket: {},
      steep: 0,
      desc: "An aluminum stovetop moka pot. Water goes in the bottom chamber, grounds in the funnel basket; heat it on the stove and coffee rises into the top.",
    });
  }

  // Hot water: needed for press/instant, decorative otherwise.
  const needsHotWater = method === "press" || method === "instant";
  const electric = rng.chance(0.6);
  if (needsHotWater || rng.chance(0.5)) {
    if (electric) {
      const base = b.appliance(counter, "kettle_base", "kettle base", {
        container: { open: true, openable: false, slots: 1, prep: "on" },
        desc: "The power base for an electric kettle.",
      });
      const inSink = rng.chance(0.25);
      if (inSink) twists.push("kettle left in sink");
      heater = b.item(inSink ? sink : base, "kettle", "electric kettle", {
        material: "plastic",
        vessel: vessel(1500),
        on: false,
        desc: "A cordless electric kettle. It only works sitting on its base.",
      });
    } else {
      heater = b.item(rng.chance(0.6) ? stove : rng.pick(lowers), "stovetop_kettle", "stovetop kettle", {
        material: "metal",
        vessel: vessel(1800),
        desc: "A whistling stovetop kettle.",
      });
    }
  }
  if (rng.chance(0.6)) {
    b.appliance(counter, "microwave", "microwave", {
      container: { open: false, openable: true, slots: 1, prep: "in" },
      runTicks: 0,
      desc: "A microwave. Switching it on runs it for one minute. Never put metal inside.",
    });
  }

  // ---- coffee --------------------------------------------------------------
  const brand = rng.pick(BRANDS);
  const roast = rng.pick(ROASTS);
  const coffeeSpots: Thing[] = [...uppers, ...uppers, counter, ...lowers, ...pantryShelves, ...pantryShelves];
  if (beans && freezer) coffeeSpots.push(freezer, freezer, freezer);
  const coffeeHome = b.roomy(coffeeSpots);
  let coffee: Thing;
  if (method === "instant") {
    coffee = b.item(coffeeHome, "package", "jar of instant coffee", {
      material: "glass",
      label: `${brand} - INSTANT COFFEE - 100g`,
      vessel: vessel(300, { instant: 100 }),
      desc: "A jar of freeze-dried instant coffee granules. About 2 g per cup, dissolve in hot water.",
    });
  } else if (beans) {
    coffee = b.item(coffeeHome, "package", "bag of coffee beans", {
      material: "paper",
      label: `${brand} - ${roast} - WHOLE BEAN - 340g`,
      vessel: vessel(900, { beans: 340 }),
      desc: "A resealable bag of whole roasted coffee beans. These need grinding before brewing.",
    });
    twists.push("whole beans");
  } else {
    coffee = b.item(coffeeHome, "package", "bag of ground coffee", {
      material: "paper",
      label: `${brand} - ${roast} - GROUND - 340g`,
      vessel: vessel(900, { grounds: 340 }),
      desc: "A resealable bag of pre-ground coffee. A typical cup takes 15-20 g.",
    });
  }
  if (coffeeHome === freezer) twists.push("coffee in freezer");

  if (rng.chance(0.5) && coffeeHome !== counter) {
    b.item(counter, "package", "coffee bag", {
      material: "paper",
      label: `${rng.pick(BRANDS)} - Morning Blend - GROUND - 340g`,
      vessel: vessel(900, {}),
      desc: "A crumpled coffee bag. It's empty except for a few stray grounds.",
    });
    twists.push("empty coffee bag decoy");
  }

  let grinder: Thing | undefined;
  if (beans) {
    const onCounter = rng.chance(0.6);
    const home = onCounter ? counter : b.roomy([...lowers, ...pantryShelves]);
    grinder = b.appliance(home, "grinder", "coffee grinder", {
      portable: true,
      plugged: onCounter ? !rng.chance(0.35) : false,
      vessel: vessel(240),
      desc: "A blade coffee grinder. Pour beans in, switch it on. It needs to sit on a surface near an outlet.",
    });
  }

  let filterBox: Thing | undefined;
  if (method === "drip") {
    const home = b.roomy([...drawers, ...uppers, counter, ...pantryShelves]);
    filterBox = b.item(home, "box", "box of paper filters", {
      material: "cardboard",
      label: "No. 4 cone coffee filters",
      container: { open: true, openable: false, slots: 10, prep: "in" },
      desc: "An open box of paper coffee filters.",
    });
    for (let i = 0; i < 4; i++) {
      b.item(filterBox, "filter", "paper filter", { material: "paper", desc: "A paper cone coffee filter." });
    }
  }

  // ---- mugs ----------------------------------------------------------------
  const mugVariant = rng.weighted<"cabinet" | "sideboard" | "dishwasher" | "dirty">([
    ["cabinet", 55],
    ["sideboard", sideboard ? 10 : 0],
    ["dishwasher", dishwasher ? 15 : 0],
    ["dirty", 20],
  ]);
  const mugHome =
    mugVariant === "cabinet"
      ? b.roomy(uppers)
      : mugVariant === "sideboard"
        ? sideboard!
        : mugVariant === "dishwasher"
          ? dishwasher!
          : sink;
  if (mugVariant === "dirty") twists.push("only dirty mugs");
  else if (mugVariant !== "cabinet") twists.push(`mugs in ${mugHome.name}`);
  const mugNames = rng.shuffle([...MUG_NAMES]).slice(0, rng.int(2, 3));
  const mugs = mugNames.map((n) =>
    b.item(mugHome, "mug", n, {
      material: "ceramic",
      vessel: vessel(350),
      dirty: mugVariant === "dirty",
      desc: mugVariant === "dirty" ? `A ${n} with a dried coffee ring inside. It needs washing.` : `A clean ${n}.`,
    }),
  );

  // ---- milk & sugar --------------------------------------------------------
  const spoiled = rng.chance(0.3);
  let milk: Thing;
  if (spoiled) {
    b.item(fridge, "package", "milk carton", {
      material: "cardboard",
      label: "Whole Milk - BEST BEFORE 02 OCT",
      vessel: vessel(1000, { sour_milk: 600 }, 4),
      expired: true,
      desc: "A carton of whole milk. The carton is slightly swollen.",
    });
    const freshHome = garageFridge ?? fridge;
    milk = b.item(freshHome, "package", "oat milk", {
      material: "cardboard",
      label: "Oat Milk - BEST BEFORE 21 OCT",
      vessel: vessel(1000, { milk: 900 }, 4),
      desc: "A carton of oat milk, mostly full.",
    });
    twists.push(freshHome === garageFridge ? "spoiled milk (fresh in garage)" : "spoiled milk");
  } else {
    milk = b.item(fridge, "package", "milk carton", {
      material: "cardboard",
      label: "Whole Milk - BEST BEFORE 16 OCT",
      vessel: vessel(1000, { milk: 700 }, 4),
      desc: "A carton of whole milk.",
    });
  }

  const sugarHome = b.roomy([...uppers, counter, ...pantryShelves]);
  let sugar: Thing;
  if (rng.chance(0.3)) {
    const jars = rng.shuffle([
      { sugar: 300 } as Stuff,
      { salt: 300 } as Stuff,
    ]);
    const made = jars.map((stuff) =>
      b.item(sugarHome, "package", "glass jar", {
        material: "glass",
        vessel: vessel(800, stuff),
        desc: "An unlabeled glass jar of fine white crystals.",
      }),
    );
    sugar = made[jars.findIndex((s) => s.sugar)]!;
    twists.push("unlabeled sugar/salt jars");
  } else {
    sugar = b.item(sugarHome, "package", "sugar canister", {
      material: "ceramic",
      label: "SUGAR",
      vessel: vessel(800, { sugar: 400 }),
      desc: "A ceramic canister labeled SUGAR.",
    });
    b.item(b.roomy([...uppers, counter]), "package", "salt shaker", {
      material: "glass",
      label: "SALT",
      vessel: vessel(100, { salt: 80 }),
      desc: "A glass salt shaker.",
    });
  }

  b.item(b.roomy([...uppers, ...pantryShelves]), "package", "tea caddy", {
    material: "metal",
    label: "Earl Grey",
    vessel: vessel(400, { tea: 120 }),
    desc: "A tin of loose-leaf Earl Grey tea.",
  });

  // ---- clutter -------------------------------------------------------------
  for (const u of uppers) b.clutter(u, "upper", rng.int(1, 2));
  for (const d of drawers) b.clutter(d, "drawer", rng.int(1, 3));
  for (const l of lowers) b.clutter(l, "lower", rng.int(1, 2));
  b.clutter(fridge, "fridge", rng.int(2, 4));
  if (freezer) b.clutter(freezer, "freezer", rng.int(1, 3));
  if (garageFridge) b.clutter(garageFridge, "fridge", 1);
  if (island) b.clutter(island, "upper", 1);
  if (dishwasher && mugVariant !== "dishwasher") b.clutter(dishwasher, "upper", 1);

  // ---- the note ------------------------------------------------------------
  b.item(consoleTable, "note", "handwritten note", {
    material: "paper",
    text:
      `Hi there! Thanks so much for watching the house.\n` +
      `Could you make me a cup of coffee? I take it ${pref.phrase}.\n` +
      `Everything should be in the kitchen somewhere... I'm not the most organized. ` +
      `Help yourself to anything.\n- ${owner}, ${DATE}`,
    desc: "A note written on the back of an envelope.",
  });

  const recipe: Recipe = {
    method,
    coffee: coffee.id,
    beans,
    grinder: grinder?.id,
    brewer: brewer?.id,
    filters: filterBox?.id,
    heater: heater?.id,
    sink: waterSink.id,
    mugs: mugs.map((m) => m.id),
    mugsDirty: mugVariant === "dirty",
    milk: milk.id,
    sugar: sugar.id,
    twists,
  };

  const geo = buildGeometry(rng, b, specs, extraDoors);
  for (const d of geo.doors) {
    b.rooms.get(d.rooms[0])!.exits.push(d.rooms[1]);
    b.rooms.get(d.rooms[1])!.exits.push(d.rooms[0]);
  }

  return {
    seed,
    date: DATE,
    rooms: b.rooms,
    things: b.things,
    start: "hallway",
    owner,
    pref,
    recipe,
    rects: geo.rects,
    doors: geo.doors,
    spawn: geo.spawn,
  };
}

/**
 * Lay out rooms, doorways and furniture, retrying until every doorway and every piece of furniture
 * can be walked up to from the spawn point.
 */
function buildGeometry(
  rng: Rng,
  b: Builder,
  specs: RoomSpec[],
  extras: readonly (readonly [string, string, number])[],
): Pick<World, "rects" | "doors" | "spawn"> {
  const furniture = [...b.things.values()].filter((t) => !t.parent);
  for (let attempt = 0; attempt < 80; attempt++) {
    let laid: HouseShell;
    try {
      laid = layoutRooms(rng, specs, extras);
    } catch {
      continue;
    }
    const { rects, doors } = laid;
    const placed = [...rects].every(([id, rect]) =>
      placeFurniture(
        rng,
        rect,
        doors.filter((d) => d.rooms.includes(id)),
        furniture.filter((t) => t.room === id),
      ),
    );
    if (!placed) continue;

    const grid = new WalkGrid([...rects.values()], doors, footprints(furniture));
    const hall = rects.get("hallway")!;
    const alongZ = hall.z1 - hall.z0 >= hall.x1 - hall.x0;
    const fromStart = rng.chance(0.5);
    const cx = (hall.x0 + hall.x1) / 2;
    const cz = (hall.z0 + hall.z1) / 2;
    const inset = AGENT_RADIUS + 0.35;
    const [sx, sz] = alongZ ? [cx, fromStart ? hall.z0 + inset : hall.z1 - inset] : [fromStart ? hall.x0 + inset : hall.x1 - inset, cz];
    const startCell = grid.nearestOpen(sx, sz, 8);
    if (startCell < 0) continue;
    const [x, z] = grid.center(startCell);
    // Face down the length of the hallway.
    const yaw = alongZ ? (fromStart ? Math.PI : 0) : fromStart ? Math.PI / 2 : -Math.PI / 2;

    const reachableCells = grid.reachable(startCell);
    const doorsOk = doors.every((d) => reachableCells[grid.index(d.x, d.z)] === 1);
    const furnitureOk = furniture.every((t) => {
      if (t.kind === "decor") return true;
      const { min, max } = t.box!;
      for (let idx = 0; idx < reachableCells.length; idx++) {
        if (!reachableCells[idx]) continue;
        const [px, pz] = grid.center(idx);
        if (footDistance(px, pz, min, max) <= REACH - 0.2) return true;
      }
      return false;
    });
    if (doorsOk && furnitureOk) return { rects, doors, spawn: { x, z, yaw } };
  }
  throw new Error(`could not lay out house ${b.things.size}`);
}
