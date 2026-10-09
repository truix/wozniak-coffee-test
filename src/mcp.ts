// MCP tool surface: one McpServer per client session, one active run per session.
// The player only ever gets first-person images and anonymous narration; it targets things by pointing
// at pixel coordinates in its latest image, or by naming one of its hands.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MAX_ACTIONS, type ActionResult, type Game, type Hand, type Ref, type Step } from "./engine";
import type { Journal } from "./journal";
import type { Registry } from "./registry";
import { randomSeed } from "./rng";
import { VIEW_H, VIEW_W } from "./snapshot";

const INSTRUCTIONS = `THE COFFEE TEST (after Steve Wozniak): you have just walked into a house you have never seen. Make the owner a cup of coffee.

You are embodied. Every tool returns a first-person ${VIEW_W}x${VIEW_H} image of what you see. Nothing is labeled for you: you must recognize rooms, furniture, appliances, packages and their state (open/closed, plugged in or not, lights, steam, how full things are) from the image itself. Read printed labels and notes by getting close and using examine.

- Call start_game first. Every seed is a different, randomized house.
- Point at things by pixel coordinates (x right, y down) in your MOST RECENT image, whatever it was: after examine, that is the close-up. Rulers along the top and left edges help you measure. Held items are referred to by hand ("right" or "left"), or by pointing at them where you hold them in the lower corners of your view.
- Move with turn (degrees, + = right), tilt_head (degrees, + = up), move (meters), or walk_to a pixel (walks up to whatever is there, or to that spot on the floor, including through doorways). The status line gives your compass heading and head tilt.
- You can only handle things within arm's reach (about 1 m). Cabinets, drawers, the fridge and appliances hide their contents until opened. Doors and drawers that open have handles; plain panels without handles are fixed and never open.
- You have two hands. Pouring, filling, washing and serving use what's in a hand. Results tell you how much a container holds.
- Appliances may be unplugged; things may be missing, empty, broken, spoiled or mislabeled. Taste is a sense too.
- Each physical action takes 30 s of game time; turning, tilting and examining are instant. Use wait to let water boil or coffee brew. Anything on a lit burner keeps heating until you switch the stove off.
- Find the owner's note: it says how they take their coffee. When the mug is ready, hold it and call serve.
- Score: up to 1000, minus 2 per physical action, 1 per look/turn/examine, and penalties for mess, hazards (stove left on, metal in the microwave) and getting their order wrong. ${MAX_ACTIONS} actions max.`;

const px = {
  x: z.number().min(0).max(VIEW_W).describe(`Pixel x (0-${VIEW_W}) in your latest image.`),
  y: z.number().min(0).max(VIEW_H).describe(`Pixel y (0-${VIEW_H}) in your latest image.`),
};
const hand = z.enum(["right", "left"]);
const optionalPoint = {
  x: px.x.optional(),
  y: px.y.optional(),
  hand: hand.optional().describe('Use what you\'re holding in this hand ("right" or "left") instead of pointing.'),
};

function ref(a: { x?: number; y?: number; hand?: Hand }): Ref | string {
  if (a.hand) return { hand: a.hand };
  if (a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y };
  return "Give either a pixel (x and y) or a hand.";
}

/** Per-session state the HTTP layer shares with the tool surface. */
export interface SessionContext {
  /** The MCP session id, once the client has initialized. */
  id?: string;
  journal?: Journal;
}

export interface CoffeeSession {
  server: McpServer;
  /**
   * Rebuild this session's run from its journal after a server restart. Returns how many tool calls were
   * replayed, or 0 if there was nothing to restore.
   */
  restore(): Promise<number>;
}

/** A tool implementation; each takes its own argument shape (already validated by the schema). */
type Handler = (a: any) => Promise<CallToolResult>;

export function createSession(registry: Registry, ctx: SessionContext = {}): CoffeeSession {
  const server = new McpServer({ name: "coffee-test", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  let game: Game | undefined;
  /** Replaying the journal: no rendering, no journaling. */
  let replaying = false;
  /** Shown once, at the top of the next result. */
  let notice: string | undefined;
  /** This session was re-created after a restart and its run could not be restored. */
  let lost = false;
  const handlers = new Map<string, Handler>();

  const record = (tool: string, args: Record<string, unknown>, g: Game): void => {
    if (replaying || !ctx.id || !ctx.journal) return;
    if (g.status !== "playing") ctx.journal.drop(ctx.id);
    else if (tool === "start_game") ctx.journal.reset(ctx.id, { tool, args });
    else ctx.journal.append(ctx.id, { tool, args });
  };

  const respond = async (g: Game, r: Pick<ActionResult, "text" | "closeUp">): Promise<CallToolResult> => {
    registry.settle(g);
    let text = `${r.text}\n\n${g.hud()}`;
    if (replaying) return { content: [{ type: "text", text }] };
    if (notice) {
      text = `${notice}\n\n${text}`;
      notice = undefined;
    }
    const content: CallToolResult["content"] = [{ type: "text", text }];
    try {
      const png = await registry.frame(g, r.closeUp);
      content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    } catch (e) {
      console.error("[mcp] frame failed:", e);
      content.push({
        type: "text",
        text: `(No image this time: the renderer failed (${(e as Error).message}) and restarts on the next call. The action itself went through. Call look for a fresh view before pointing at anything.)`,
      });
    }
    return { content };
  };

  const noGame = (): CallToolResult => ({
    content: [
      {
        type: "text",
        text: lost
          ? "No game in progress: the game server restarted and this run could not be restored. Call start_game again (the same seed gives the same house)."
          : "No game in progress. Call start_game first.",
      },
    ],
    isError: true,
  });

  const tool = (name: string, config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations?: ToolAnnotations }, handler: Handler): void => {
    handlers.set(name, handler);
    server.registerTool(name, config, handler);
  };

  /** Run one action; `fn` returns a Step from the game, or a string to reject bad arguments up front. */
  const act =
    <A extends Record<string, unknown>>(name: string, physical: boolean, fn: (g: Game, a: A) => (() => Step) | string) =>
    async (a: A): Promise<CallToolResult> => {
      if (!game) return noGame();
      const g = game;
      const step = fn(g, a);
      if (typeof step === "string") return { content: [{ type: "text", text: step }], isError: true };
      const r = g.run(name, a, physical, step);
      record(name, a, g);
      return respond(g, r);
    };

  tool(
    "start_game",
    {
      title: "Start a coffee test",
      description: "Enter a new, unfamiliar house. Starting again abandons the current run.",
      inputSchema: {
        player_name: z.string().min(1).max(40).describe("Name shown on the leaderboard."),
        model: z.string().max(60).optional().describe("Model / agent identifier, e.g. 'my-agent-1'."),
        seed: z.string().max(60).optional().describe("House seed. Reuse a seed to compare agents on the same house. Random if omitted."),
      },
    },
    async ({ player_name, model, seed }: { player_name: string; model?: string; seed?: string }) => {
      if (game?.status === "playing") {
        game.run("give_up", {}, false, () => game!.giveUp());
        registry.settle(game);
      }
      lost = false;
      const g = registry.start(player_name, model ?? "unknown", seed?.trim() || randomSeed());
      game = g;
      g.version++;
      // Journal the seed actually used, so a replay builds the same house even when it was random.
      record("start_game", { player_name, model, seed: g.seed }, g);
      return respond(g, {
        text: `House "${g.seed}". You step through the front door of a house you've never been in. The owner has gone out and left you a note somewhere nearby. Make them a coffee.`,
      });
    },
  );

  tool(
    "look",
    { title: "Look", description: "See what's in front of you right now.", inputSchema: {}, annotations: { readOnlyHint: true } },
    act("look", false, (g) => () => g.look()),
  );
  tool(
    "turn",
    {
      title: "Turn",
      description: "Turn your body on the spot. Positive = right (clockwise), negative = left. The status line shows your compass heading afterwards.",
      inputSchema: { degrees: z.number().min(-360).max(360) },
    },
    act("turn", false, (g, a: { degrees: number }) => () => g.turn(a.degrees)),
  );
  tool(
    "tilt_head",
    {
      title: "Tilt head",
      description: "Look up (positive degrees) or down (negative). Useful for cabinets above the counter or things low down.",
      inputSchema: { degrees: z.number().min(-120).max(120) },
    },
    act("tilt_head", false, (g, a: { degrees: number }) => () => g.tiltHead(a.degrees)),
  );
  tool(
    "move",
    {
      title: "Step",
      description: "Walk in a straight line relative to where you face: forward (negative = back up) and right (negative = left), in meters. Stops if you bump into something.",
      inputSchema: { forward: z.number().min(-4).max(4), right: z.number().min(-4).max(4).optional() },
    },
    act("move", true, (g, a: { forward: number; right?: number }) => () => g.move(a.forward, a.right ?? 0)),
  );
  tool(
    "walk_to",
    {
      title: "Walk to",
      description:
        "Walk to what's at a pixel in your latest image: up to a piece of furniture or object (ending within arm's reach, facing it), to a spot on the floor (e.g. through a doorway; your head tilt is kept), or up to a wall you point at.",
      inputSchema: px,
    },
    act("walk_to", true, (g, a: { x: number; y: number }) => () => g.walkTo(a)),
  );
  tool(
    "examine",
    {
      title: "Examine",
      description:
        'Get a close-up image to read labels, dates and notes. Either point at something (x, y; within a few meters), or look at an item you hold: pass hand ("right" or "left"), or point at it in the lower corner of your view where you hold it. Your next pixels refer to the close-up.',
      inputSchema: optionalPoint,
      annotations: { readOnlyHint: true },
    },
    act("examine", false, (g, a: { x?: number; y?: number; hand?: Hand }) => {
      const r = ref(a);
      return typeof r === "string" ? r : () => g.examine(r);
    }),
  );
  tool(
    "open",
    { title: "Open", description: "Open the door, drawer or lid at a pixel (within reach). Plain panels without a handle are fixed and don't open.", inputSchema: px },
    act("open", true, (g, a: { x: number; y: number }) => () => g.open(a)),
  );
  tool(
    "close",
    { title: "Close", description: "Close the door, drawer or lid at a pixel (within reach). Pointing at something inside an open drawer or cabinet closes it too.", inputSchema: px },
    act("close", true, (g, a: { x: number; y: number }) => () => g.close(a)),
  );
  tool(
    "take",
    { title: "Take", description: "Pick up the object at a pixel (within reach) into a free hand (right first).", inputSchema: px },
    act("take", true, (g, a: { x: number; y: number }) => () => g.take(a)),
  );
  tool(
    "put",
    {
      title: "Put",
      description:
        "Put what's in a hand onto or into what's at a pixel (within reach): a counter, a shelf, an open cabinet, the stove, a kettle base, a coffee maker's warming plate or filter basket.",
      inputSchema: { hand, ...px },
    },
    act("put", true, (g, a: { hand: Hand; x: number; y: number }) => () => g.put(a.hand, { x: a.x, y: a.y })),
  );
  tool(
    "pour",
    {
      title: "Pour",
      description:
        "Pour from the container in a hand into what's at a pixel (within reach), or into the container in your other hand (into_other_hand: true). Pouring into a sink empties it. Omit amount to pour until the source is empty or the target is full (you stop at the brim). An explicit amount that doesn't fit overflows and spills. The result says how much the target now holds.",
      inputSchema: {
        hand: hand.describe("Hand holding the container to pour from."),
        x: px.x.optional(),
        y: px.y.optional(),
        into_other_hand: z.boolean().optional(),
        amount: z.number().positive().optional().describe("ml for liquids, grams for solids."),
      },
    },
    act("pour", true, (g, a: { hand: Hand; x?: number; y?: number; into_other_hand?: boolean; amount?: number }) => {
      const dest: Ref | string = a.into_other_hand ? { hand: a.hand === "right" ? "left" : "right" } : ref({ x: a.x, y: a.y });
      return typeof dest === "string" ? "Give a pixel (x and y) to pour into, or into_other_hand: true." : () => g.pour(a.hand, dest, a.amount);
    }),
  );
  tool(
    "fill",
    {
      title: "Fill with water",
      description:
        "Hold a container under the tap of the sink at a pixel (within reach) and fill it with cold water. The result says how much it now holds and how much it takes. A mug of coffee is about 250 ml.",
      inputSchema: { hand, ...px, amount: z.number().positive().optional().describe("ml. Omit to fill it to the brim (a big carafe or kettle takes 1.5 litres or more).") },
    },
    act("fill", true, (g, a: { hand: Hand; x: number; y: number; amount?: number }) => () => g.fill(a.hand, { x: a.x, y: a.y }, a.amount)),
  );
  tool(
    "wash",
    {
      title: "Wash",
      description: "Empty and wash what's in a hand under the tap of the sink at a pixel (within reach).",
      inputSchema: { hand, ...px },
    },
    act("wash", true, (g, a: { hand: Hand; x: number; y: number }) => () => g.wash(a.hand, { x: a.x, y: a.y })),
  );
  tool(
    "plug_in",
    { title: "Plug in", description: "Plug the appliance at a pixel (within reach) into the wall.", inputSchema: px },
    act("plug_in", true, (g, a: { x: number; y: number }) => () => g.plugIn(a)),
  );
  tool(
    "switch_on",
    {
      title: "Switch on",
      description: "Press the power button / turn the dial of what's at a pixel (within reach). Pointing anywhere on the appliance, or at what stands on it, is enough.",
      inputSchema: px,
    },
    act("switch_on", true, (g, a: { x: number; y: number }) => () => g.switchOn(a)),
  );
  tool(
    "switch_off",
    { title: "Switch off", description: "Switch off what's at a pixel (within reach).", inputSchema: px },
    act("switch_off", true, (g, a: { x: number; y: number }) => () => g.switchOff(a)),
  );
  tool(
    "press_plunger",
    { title: "Press plunger", description: "Push down the plunger of what's at a pixel (within reach): the knob, the lid or the glass all count.", inputSchema: px },
    act("press_plunger", true, (g, a: { x: number; y: number }) => () => g.press(a)),
  );
  tool(
    "taste",
    { title: "Taste", description: "Taste a little of what's in a hand, or in the container at a pixel (within reach).", inputSchema: optionalPoint },
    act("taste", true, (g, a: { x?: number; y?: number; hand?: Hand }) => {
      const r = ref(a);
      return typeof r === "string" ? r : () => g.taste(r);
    }),
  );
  tool(
    "wait",
    {
      title: "Wait",
      description: "Let time pass (water boiling, coffee brewing or steeping). 30-second steps.",
      inputSchema: { minutes: z.number().min(0.5).max(10) },
    },
    act("wait", true, (g, a: { minutes: number }) => () => g.wait(a.minutes)),
  );
  tool(
    "serve",
    {
      title: "Serve the coffee",
      description: "Hand the mug you're holding to the owner. Ends the run and scores it.",
      inputSchema: { hand },
    },
    act("serve", true, (g, a: { hand: Hand }) => () => g.serve(a.hand)),
  );
  tool(
    "give_up",
    { title: "Give up", description: "Abandon this run (scores zero).", inputSchema: {} },
    act("give_up", false, (g) => () => g.giveUp()),
  );

  const restore = async (): Promise<number> => {
    const entries = ctx.id && ctx.journal ? ctx.journal.load(ctx.id) : [];
    if (!entries.length || entries[0]!.tool !== "start_game") {
      lost = true;
      return 0;
    }
    replaying = true;
    let n = 0;
    try {
      for (const e of entries) {
        const h = handlers.get(e.tool);
        if (!h) continue;
        await h(e.args);
        n++;
      }
    } catch (err) {
      console.error("[mcp] journal replay failed:", err);
      game = undefined;
    } finally {
      replaying = false;
    }
    if (game?.status !== "playing") {
      game = undefined;
      lost = true;
      return 0;
    }
    notice = `(The game server restarted. Your run was restored by replaying it: same house, same spot, ${game.actions} actions so far.)`;
    return n;
  };

  return { server, restore };
}
