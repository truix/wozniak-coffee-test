// Serve the spectator UI with a fake API backed by a snapshot fixture, for browser testing.
//   bun scripts/spectator-mock.ts [fixture.json] [port]
// A simulated agent wanders the house every 2 s (version bumps, log grows, one failure in four), then
// finishes with an outcome so the post-game box shows up.
import indexPage from "../public/index.html";
import renderPage from "../public/render.html";
import { Renderer3D } from "../src/renderer3d";
import type { Snapshot } from "../src/snapshot";

const file = process.argv[2] ?? "test/fixtures/kitchen.snapshot.json";
const port = Number(process.argv[3] ?? 3311);
const snap: Snapshot = await Bun.file(file).json();

const path = [
  { x: 1.18, z: 4.2, yaw: Math.PI, pitch: -0.1 },
  { x: 1.18, z: 6.8, yaw: Math.PI * 0.85, pitch: -0.2 },
  { x: 2.4, z: 8.5, yaw: Math.PI / 2, pitch: -0.25 },
  { x: 3.0, z: 9.6, yaw: Math.PI, pitch: -0.35 },
  { x: 3.1, z: 9.9, yaw: Math.PI / 2, pitch: 0.15 },
  { x: 2.6, z: 7.6, yaw: Math.PI / 2, pitch: -0.4 },
];
const actions = ["look", "walk_to {x: 480, y: 420}", "turn {degrees: 90}", "open {x: 512, y: 210}", "take {x: 300, y: 380}", "examine {x: 430, y: 380}"];
const startedAt = Date.now();
const run = {
  id: "mock-1",
  player: "MockBot",
  model: "mock-model-1",
  seed: snap.seed,
  status: "playing" as "playing" | "won" | "failed",
  room: "Kitchen",
  clock: snap.clock,
  actions: 0,
  version: snap.version,
  startedAt,
  outcome: null as null | { success: boolean; score: number; grade: string; verdict: string; notes: string[] },
  recipe: null as null | { method: string; twists: string[] },
  lastAction: null as string | null,
};
const log: { n: number; clock: string; action: string; result: string; ok: boolean }[] = [];
const older = {
  ...run,
  id: "mock-0",
  player: "EarlierBot",
  status: "failed" as const,
  actions: 41,
  version: 41,
  outcome: { success: false, score: 0, grade: "F", verdict: "Gave up after microwaving the moka pot.", notes: ["Never found the filters."] },
  recipe: { method: "moka", twists: ["filters in drawer"] },
  lastAction: "give_up",
};

const timer = setInterval(() => {
  if (run.status !== "playing") return;
  const i = run.actions;
  snap.agent = path[i % path.length]!;
  snap.version++;
  run.version = snap.version;
  run.actions++;
  const ok = i % 4 !== 3;
  const action = actions[i % actions.length]!;
  run.lastAction = action;
  log.push({ n: run.actions, clock: run.clock, action, result: ok ? `You ${action.split(" ")[0]}. The kitchen smells faintly of coffee.` : "Nothing there to interact with at that point.", ok });
  if (run.actions >= 14) {
    run.status = "won";
    run.outcome = { success: true, score: 82, grade: "B", verdict: "A decent cup, milk and one sugar as asked.", notes: ["Left the stove on.", "Used a dirty mug? No - rinsed it first."] };
    run.recipe = { method: "moka", twists: ["water off at kitchen sink", "dirty mugs"] };
  }
}, 2000);

const server = Bun.serve({
  port,
  // development: false: Bun's dev-mode HTML bundler fails on UNC project paths (for example a network share)
  development: false,
  routes: {
    "/": indexPage,
    "/render": renderPage,
    "/api/runs": () => Response.json([run, older]),
    "/api/leaderboard": () =>
      Response.json([
        { player: "MockBot", model: "mock-model-1", seed: snap.seed, success: true, score: 82, grade: "B", verdict: "A decent cup.", actions: 14, method: "moka" },
        { player: "EarlierBot", model: "mock-model-1", seed: snap.seed, success: false, score: 0, grade: "F", verdict: "Gave up.", actions: 41, method: "moka" },
      ]),
    "/api/runs/:id": (req) => (req.params.id === run.id ? Response.json({ ...run, log }) : Response.json({ ...older, log: [] })),
    "/api/runs/:id/snapshot": () => Response.json(snap),
    "/api/runs/:id/view.png": async () => new Response(await frame(), { headers: { "content-type": "image/png", "cache-control": "no-store" } }),
  },
});

const renderer = new Renderer3D(`http://localhost:${server.port}`);
let cached: { version: number; png: Promise<Uint8Array<ArrayBuffer>> } | null = null;
function frame(): Promise<Uint8Array<ArrayBuffer>> {
  if (cached?.version !== snap.version) cached = { version: snap.version, png: renderer.render(structuredClone(snap)) };
  return cached.png;
}

console.log(`spectator mock on http://localhost:${server.port}/`);
process.on("SIGINT", async () => {
  clearInterval(timer);
  await renderer.close();
  server.stop(true);
  process.exit(0);
});
