// Render a snapshot fixture from several agent poses / examine cameras to tmp/*.png and print timings.
//   bun scripts/render-fixture.ts [fixture.json]
import renderPage from "../public/render.html";
import { Renderer3D } from "../src/renderer3d";
import type { Snapshot, SnapCamera, SnapAgent } from "../src/snapshot";

const file = process.argv[2] ?? "test/fixtures/kitchen.snapshot.json";
const base: Snapshot = await Bun.file(file).json();

interface Shot {
  name: string;
  agent?: SnapAgent;
  camera?: SnapCamera;
  hands?: (string | null)[];
}

const shots: Shot[] = [
  { name: "counter", agent: { x: 3.0, z: 9.6, yaw: Math.PI, pitch: -0.35 } },
  { name: "east-wall", agent: { x: 2.2, z: 8.5, yaw: Math.PI / 2, pitch: -0.25 } },
  { name: "uppers", agent: { x: 3.1, z: 9.9, yaw: Math.PI / 2, pitch: 0.15 } },
  { name: "doorway", agent: { x: 1.18, z: 4.2, yaw: Math.PI, pitch: -0.1 } },
  { name: "start", agent: base.agent },
  { name: "held", agent: { x: 3.0, z: 9.6, yaw: Math.PI, pitch: -0.35 }, hands: ["black_mug", "bag_of_ground_coffee"] },
  { name: "x-coffee-maker", camera: { eye: [2.075, 1.38, 10.3], target: [2.075, 1.02, 10.76], fovY: 42 } },
  { name: "x-bag", camera: { eye: [3.095, 1.06, 10.36], target: [3.095, 1.02, 10.69], fovY: 40 } },
  { name: "x-note", camera: { eye: [3.575, 1.26, 10.6], target: [3.575, 0.905, 10.7], fovY: 38 } },
  { name: "x-fridge", camera: { eye: [2.9, 1.25, 7.64], target: [3.9, 0.55, 7.64], fovY: 55 } },
  { name: "x-milk", camera: { eye: [3.35, 0.46, 7.97], target: [3.77, 0.41, 7.97], fovY: 40 } },
  { name: "x-sink-note", camera: { eye: [3.55, 1.25, 8.66], target: [4.4, 1.14, 8.66], fovY: 40 } },
  { name: "x-drawer", camera: { eye: [2.9, 1.45, 6.97], target: [4.0, 0.72, 6.97], fovY: 55 } },
  { name: "x-stove", camera: { eye: [3.1, 1.6, 9.12], target: [3.95, 0.95, 9.12], fovY: 50 } },
  { name: "x-sink", camera: { eye: [3.3, 1.55, 8.46], target: [4.1, 0.8, 8.46], fovY: 55 } },
];

// development: false: Bun's dev-mode HMR bundler fails to load HTML imports from a UNC path (for example a network share)
const server = Bun.serve({ port: 0, development: false, routes: { "/render": renderPage } });
const renderer = new Renderer3D(`http://localhost:${server.port}`);
await Bun.$`mkdir -p tmp`.quiet();
try {
  for (const [i, shot] of shots.entries()) {
    const snap: Snapshot = structuredClone(base);
    if (shot.agent) snap.agent = shot.agent;
    if (shot.camera) snap.camera = shot.camera;
    if (shot.hands) {
      snap.hands = shot.hands;
      for (const t of snap.things) if (shot.hands.includes(t.id)) t.parent = "hands";
    }
    const t0 = performance.now();
    const png = await renderer.render(snap);
    const ms = performance.now() - t0;
    await Bun.write(`tmp/${shot.name}.png`, png);
    console.log(`${String(i).padStart(2)} ${shot.name.padEnd(16)} ${ms.toFixed(0).padStart(5)} ms${i === 0 ? " (cold: browser launch + bundle)" : ""}  ${png.length} bytes`);
  }
  // warm timing: same pose repeatedly
  const snap: Snapshot = { ...base, agent: shots[0]!.agent! };
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await renderer.render(snap);
    times.push(performance.now() - t0);
  }
  console.log(`warm: ${times.map((t) => t.toFixed(0)).join(", ")} ms (median ${times.sort((a, b) => a - b)[2]!.toFixed(0)})`);
} finally {
  await renderer.close();
  server.stop(true);
}
