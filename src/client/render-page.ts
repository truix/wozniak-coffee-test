/// <reference lib="dom" />
// Headless agent-frame renderer page (public/render.html). Puppeteer calls window.renderSnapshot(snap)
// and gets back a base64 PNG (no data: prefix) of the agent's first-person view with a pixel ruler and
// crosshair composited on top. Nothing else is overlaid: the player must recognise things by sight.
import * as THREE from "three";
import { VIEW_H, VIEW_W } from "../snapshot";
import type { Snapshot } from "../snapshot";
import { buildScene, disposeScene, setMaxAnisotropy } from "./scene";

declare global {
  // the contract with src/renderer3d.ts (which calls these through puppeteer)
  var renderSnapshot: (snap: Snapshot) => Promise<string>;
  var renderReady: boolean;
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(VIEW_W, VIEW_H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

const out = document.createElement("canvas");
out.width = VIEW_W;
out.height = VIEW_H;
document.body.appendChild(out);
const ctx = out.getContext("2d")!;

/** Pixel rulers along the top/left edges; the centre crosshair only for the agent's own eyes (not examine close-ups). */
function overlay(c: CanvasRenderingContext2D, crosshair: boolean): void {
  const top = 14;
  const left = 26;
  c.save();
  c.fillStyle = "rgba(0,0,0,0.55)";
  c.fillRect(0, 0, VIEW_W, top);
  c.fillRect(0, top, left, VIEW_H - top);
  c.strokeStyle = "#ffffff";
  c.fillStyle = "#ffffff";
  c.lineWidth = 1;
  c.font = "10px Consolas, 'Courier New', monospace";
  c.textBaseline = "alphabetic";
  c.beginPath();
  for (let x = 0; x <= VIEW_W; x += 50) {
    const px = Math.min(x, VIEW_W - 1) + 0.5;
    c.moveTo(px, 0);
    c.lineTo(px, x % 100 === 0 ? top : 5);
  }
  for (let y = 0; y <= VIEW_H; y += 50) {
    const py = Math.min(y, VIEW_H - 1) + 0.5;
    c.moveTo(0, py);
    c.lineTo(y % 100 === 0 ? left : 6, py);
  }
  c.stroke();
  c.textAlign = "left";
  for (let x = 100; x < VIEW_W; x += 100) c.fillText(String(x), x + 3, 11);
  c.textAlign = "right";
  c.fillText(String(VIEW_W), VIEW_W - 3, 11);
  c.textAlign = "left";
  c.fillText("0", 3, 11);
  for (let y = 100; y < VIEW_H; y += 100) c.fillText(String(y), 2, y + 11);
  c.fillText(String(VIEW_H), 2, VIEW_H - 3);
  if (!crosshair) {
    c.restore();
    return;
  }
  // crosshair
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  for (const [col, wd] of [
    ["rgba(0,0,0,0.75)", 3],
    ["#ffffff", 1],
  ] as const) {
    c.strokeStyle = col;
    c.lineWidth = wd;
    c.beginPath();
    c.moveTo(cx - 9, cy);
    c.lineTo(cx - 3, cy);
    c.moveTo(cx + 3, cy);
    c.lineTo(cx + 9, cy);
    c.moveTo(cx, cy - 9);
    c.lineTo(cx, cy - 3);
    c.moveTo(cx, cy + 3);
    c.lineTo(cx, cy + 9);
    c.stroke();
  }
  c.restore();
}

globalThis.renderSnapshot = async (snap: Snapshot): Promise<string> => {
  const scene = buildScene(snap, "agent");
  try {
    const cam: unknown = scene.userData.camera;
    if (!(cam instanceof THREE.PerspectiveCamera)) throw new Error("agent scene has no camera");
    renderer.clear();
    renderer.render(scene, cam);
    const held: unknown = scene.userData.held;
    if (held instanceof THREE.Scene) {
      renderer.clearDepth();
      renderer.render(held, cam);
    }
    ctx.drawImage(renderer.domElement, 0, 0);
    overlay(ctx, !snap.camera);
    return out.toDataURL("image/png").slice("data:image/png;base64,".length);
  } finally {
    disposeScene(scene);
  }
};
globalThis.renderReady = true;
