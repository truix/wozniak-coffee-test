/// <reference lib="dom" />
/**
 * Procedural Three.js scene for a coffee-test Snapshot, shared by the headless agent-frame renderer
 * (mode "agent": ceiling, first-person camera, held items) and the spectator dollhouse ("spectator").
 *
 * The server is authoritative for geometry: every thing is fitted to its world AABB. Models are authored
 * in a local frame where x = width, y = up from the box bottom, z = depth with the FRONT face at +d/2,
 * then the frame is rotated about y so local +z = `facing`.
 *
 * Agent frames carry no name overlays: everything the player must know (power, fill, printed labels,
 * notes, open/closed, on/off) is drawn as part of the objects themselves.
 */
import * as THREE from "three";
import { DOOR_HEIGHT, DRAWER_TRAVEL, EYE_HEIGHT, FOV_Y, HELD_POSE, heldSize, VIEW_H, VIEW_W, WALL_HEIGHT } from "../snapshot";
import type { SnapDoor, SnapFill, SnapRoom, SnapThing, Snapshot } from "../snapshot";

export type SceneMode = "agent" | "spectator";

/** Optional server fields read defensively (sink tap note, coffee-maker reservoir / basket). */
export type Thing = SnapThing & { noteText?: string; reservoirLevel?: number; basketFill?: SnapFill };

type P2 = [number, number];

/**
 * Each room draws its own wall slab of this thickness just inside its rectangle (thin, because the server
 * puts furniture backs flush on the rectangle edge).
 */
export const WALL_T = 0.012;
const DEG = Math.PI / 180;
const DOOR_SWING = 100 * DEG;

const C = {
  cab: "#93a88f",
  cabInside: "#a3896a",
  shelfBoard: "#c4ab88",
  top: "#3f3b38",
  steel: "#c3c8cd",
  darkSteel: "#7b8086",
  black: "#1e1e20",
  handle: "#9fa5ac",
  wood: "#9c6d46",
  darkWood: "#6a4a30",
  paper: "#f7f2e4",
  glass: "#d8ecf4",
  cardboard: "#c39a63",
  skin: "#d4a07f",
  sleeve: "#3b4d61",
  water: "#8cc2e2",
  cavity: "#0f0c0a",
};

// ---------------------------------------------------------------------------------------------------
// Caches: unit geometries and materials are shared across builds; per-build geometries are disposed.

const sharedGeos = new Set<THREE.BufferGeometry>();
const geoCache = new Map<string, THREE.BufferGeometry>();
function sgeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
    sharedGeos.add(g);
  }
  return g;
}

interface MO {
  /** emissive colour + intensity */
  e?: string;
  ei?: number;
  op?: number;
  ds?: boolean;
  back?: boolean;
  map?: THREE.Texture;
  basic?: boolean;
  shiny?: number;
  dw?: boolean;
  blend?: "add";
}
const matCache = new Map<string, THREE.Material>();
const sharedMats = new Set<THREE.Material>();
function M(color: string, o: MO = {}): THREE.Material {
  const key = [color, o.e, o.ei, o.op, o.ds, o.back, o.map?.uuid, o.basic, o.shiny, o.dw, o.blend].join("|");
  let m = matCache.get(key);
  if (m) return m;
  const side = o.back ? THREE.BackSide : o.ds ? THREE.DoubleSide : THREE.FrontSide;
  const opacity = o.op ?? 1;
  const transparent = opacity < 1 || o.blend === "add";
  const common = {
    color: new THREE.Color(color),
    side,
    transparent,
    opacity,
    map: o.map ?? null,
    depthWrite: o.dw ?? !transparent,
    blending: o.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
  };
  if (o.basic) m = new THREE.MeshBasicMaterial(common);
  else if (o.shiny)
    m = new THREE.MeshPhongMaterial({
      ...common,
      shininess: o.shiny,
      specular: new THREE.Color(0x4a4a4a),
      emissive: new THREE.Color(o.e ?? "#000000"),
      emissiveIntensity: o.ei ?? 1,
    });
  else m = new THREE.MeshLambertMaterial({ ...common, emissive: new THREE.Color(o.e ?? "#000000"), emissiveIntensity: o.ei ?? 1 });
  matCache.set(key, m);
  sharedMats.add(m);
  return m;
}

const texCache = new Map<string, THREE.Texture>();
let maxAniso = 4;
/** Call once with renderer.capabilities.getMaxAnisotropy() so printed text stays sharp at grazing angles. */
export function setMaxAnisotropy(n: number): void {
  maxAniso = Math.max(1, Math.min(16, n));
}

function ctex(key: string, cw: number, ch: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): THREE.Texture {
  let t = texCache.get(key);
  if (t) return t;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  draw(cv.getContext("2d")!, cw, ch);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  texCache.set(key, t);
  return t;
}

/** Text textures are keyed by content; drop them all (and their materials) when a long-running server piles them up. */
function trimCaches(): void {
  if (texCache.size < 300) return;
  for (const [k, m] of matCache) {
    if ("map" in m && m.map) {
      m.dispose();
      matCache.delete(k);
      sharedMats.delete(m);
    }
  }
  for (const t of texCache.values()) t.dispose();
  texCache.clear();
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function pick<T>(arr: readonly T[], key: string): T {
  return arr[hash(key) % arr.length]!;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------------------------------
// Primitive helpers (all positions in the parent's local frame).

type Obj = THREE.Object3D;
function mesh(geo: THREE.BufferGeometry, m: THREE.Material, p: Obj): THREE.Mesh {
  const x = new THREE.Mesh(geo, m);
  p.add(x);
  return x;
}
/** Box by centre. */
function box(p: Obj, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const b = mesh(sgeo("box", () => new THREE.BoxGeometry(1, 1, 1)), m, p);
  b.scale.set(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4));
  b.position.set(x, y, z);
  return b;
}
/** Box standing on y0. */
function boxUp(p: Obj, w: number, h: number, d: number, m: THREE.Material, x: number, y0: number, z: number): THREE.Mesh {
  return box(p, w, h, d, m, x, y0 + h / 2, z);
}
/** Cylinder standing on y0 (radii may differ). */
function cyl(p: Obj, rTop: number, rBot: number, h: number, m: THREE.Material, x: number, y0: number, z: number, seg = 24, open = false): THREE.Mesh {
  const r = Math.max(rTop, rBot, 1e-4);
  const a = (rTop / r).toFixed(3);
  const b = (rBot / r).toFixed(3);
  const geo = sgeo(`cyl|${a}|${b}|${seg}|${open}`, () => new THREE.CylinderGeometry(+a, +b, 1, seg, 1, open));
  const c = mesh(geo, m, p);
  c.scale.set(r, Math.max(h, 1e-4), r);
  c.position.set(x, y0 + h / 2, z);
  return c;
}
function sphere(p: Obj, r: number, m: THREE.Material, x: number, y: number, z: number, seg = 16): THREE.Mesh {
  const s = mesh(sgeo(`sph|${seg}`, () => new THREE.SphereGeometry(1, seg, Math.max(6, seg >> 1))), m, p);
  s.scale.setScalar(r);
  s.position.set(x, y, z);
  return s;
}
/** Horizontal disc facing up. */
function disc(p: Obj, r: number, m: THREE.Material, x: number, y: number, z: number, seg = 32): THREE.Mesh {
  const s = mesh(sgeo(`disc|${seg}`, () => new THREE.CircleGeometry(1, seg).rotateX(-Math.PI / 2)), m, p);
  s.scale.set(r, 1, r);
  s.position.set(x, y, z);
  return s;
}
/** Horizontal ring facing up. */
function ring(p: Obj, r0: number, r1: number, m: THREE.Material, x: number, y: number, z: number, seg = 32): THREE.Mesh {
  const k = (r0 / r1).toFixed(3);
  const s = mesh(sgeo(`ring|${k}|${seg}`, () => new THREE.RingGeometry(+k, 1, seg).rotateX(-Math.PI / 2)), m, p);
  s.scale.set(r1, 1, r1);
  s.position.set(x, y, z);
  return s;
}
/** Vertical plane facing +z. */
function plane(p: Obj, w: number, h: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const s = mesh(sgeo("plane", () => new THREE.PlaneGeometry(1, 1)), m, p);
  s.scale.set(w, h, 1);
  s.position.set(x, y, z);
  return s;
}
function lathe(p: Obj, pts: P2[], m: THREE.Material, seg = 32): THREE.Mesh {
  return mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y)), seg), m, p);
}
function tube(p: Obj, pts: THREE.Vector3[], r: number, m: THREE.Material, segs = 32): THREE.Mesh {
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, r, 6, false), m, p);
}
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Cylinder spanning two points. */
function limb(p: Obj, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, seg = 12): THREE.Mesh {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const c = mesh(sgeo(`limb|${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg)), m, p);
  c.scale.set(r, len, r);
  c.position.copy(a).addScaledVector(dir, 0.5);
  c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return c;
}
/** Curved cylinder band facing +z (for labels on round things). */
function band(p: Obj, r: number, h: number, arc: number, m: THREE.Material, x: number, y0: number, z: number): THREE.Mesh {
  const k = `band|${arc.toFixed(3)}`;
  const s = mesh(sgeo(k, () => new THREE.CylinderGeometry(1, 1, 1, 24, 1, true, -arc / 2, arc)), m, p);
  s.scale.set(r, h, r);
  s.position.set(x, y0 + h / 2, z);
  return s;
}

// ---------------------------------------------------------------------------------------------------
// Text textures

const SANS = `"Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const HAND = `"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;

function wrapText(c: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word;
      if (!line || c.measureText(t).width <= maxW) line = t;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Largest font size whose wrapped text fits the box. */
function fitText(c: CanvasRenderingContext2D, text: string, font: (px: number) => string, maxW: number, maxH: number, max: number, min = 10, lh = 1.25) {
  for (let px = max; px >= min; px -= 2) {
    c.font = font(px);
    const lines = wrapText(c, text, maxW);
    if (lines.length * px * lh <= maxH && lines.every((l) => c.measureText(l).width <= maxW)) return { px, lines };
  }
  c.font = font(min);
  return { px: min, lines: wrapText(c, text, maxW) };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/** Printed package label: "Brand - Roast - GROUND - 340g" becomes stacked lines, all-caps lines emphasised. */
function labelTex(label: string, bg: string, ink: string, aspect: number, panel = true): THREE.Texture {
  const H = 512;
  const W = clamp(Math.round(H * aspect), 160, 1024);
  return ctex(`label|${bg}|${ink}|${W}|${panel}|${label}`, W, H, (c) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    const pad = W * 0.07;
    let px0 = 0;
    let py0 = 0;
    let pw = W;
    let ph = H;
    if (panel) {
      px0 = pad;
      py0 = H * 0.1;
      pw = W - pad * 2;
      ph = H * 0.8;
      c.fillStyle = "#fbf7ee";
      roundRect(c, px0, py0, pw, ph, W * 0.04);
      c.fill();
      c.strokeStyle = ink;
      c.lineWidth = 3;
      c.stroke();
    }
    // one row per " - " segment; on narrow labels long segments break in two so the text stays big
    const rows: { text: string; emph: boolean; first: boolean }[] = [];
    label
      .split(/\s+-\s+/)
      .filter(Boolean)
      .forEach((seg, i) => {
        const emph = /[A-Z]/.test(seg) && seg === seg.toUpperCase() && seg.length <= 22;
        const words = seg.split(" ");
        if (W / H < 0.9 && words.length > 1 && seg.length > 9) {
          let cut = 1;
          const imbalance = (k: number) => Math.abs(words.slice(0, k).join(" ").length - words.slice(k).join(" ").length);
          for (let k = 2; k < words.length; k++) if (imbalance(k) < imbalance(cut)) cut = k;
          rows.push({ text: words.slice(0, cut).join(" "), emph, first: i === 0 });
          rows.push({ text: words.slice(cut).join(" "), emph, first: i === 0 });
        } else rows.push({ text: seg, emph, first: i === 0 });
      });
    const weights = rows.map((r) => (r.emph ? 1.45 : r.first ? 1.15 : 0.9));
    const maxW = pw * 0.88;
    const unit = (ph * 0.86) / weights.reduce((a, b) => a + b * 1.18, 0);
    const font = (r: (typeof rows)[number], px: number) => `${r.emph || r.first ? "bold " : ""}${px}px ${SANS}`;
    const sizes = rows.map((r, i) => {
      let px = Math.min(weights[i]! * unit, H * 0.3);
      c.font = font(r, px);
      const wd = c.measureText(r.text).width;
      if (wd > maxW) px *= maxW / wd;
      return px;
    });
    const total = sizes.reduce((a, b) => a + b * 1.18, 0);
    let y = py0 + (ph - total) / 2;
    c.textAlign = "center";
    c.textBaseline = "top";
    rows.forEach((r, i) => {
      const px = sizes[i]!;
      c.font = font(r, px);
      c.fillStyle = panel ? "#1b1714" : ink;
      c.fillText(r.text, W / 2, y + px * 0.09);
      y += px * 1.18;
    });
  });
}

function noteTex(text: string, aspect: number): THREE.Texture {
  const W = 512;
  const H = clamp(Math.round(W / aspect), 256, 1024);
  return ctex(`note|${H}|${text}`, W, H, (c) => {
    c.fillStyle = "#fbf6e2";
    c.fillRect(0, 0, W, H);
    c.strokeStyle = "#b9cbe3";
    c.lineWidth = 2;
    for (let y = 60; y < H; y += 34) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }
    c.strokeStyle = "#e6a3a3";
    c.beginPath();
    c.moveTo(44, 0);
    c.lineTo(44, H);
    c.stroke();
    const { px, lines } = fitText(c, text, (p) => `${p}px ${HAND}`, W - 80, H - 50, 64, 12, 1.22);
    c.fillStyle = "#16245e";
    c.textBaseline = "top";
    lines.forEach((l, i) => c.fillText(l, 56, 22 + i * px * 1.22));
  });
}

function printedTex(name: string, bg: string, aspect: number): THREE.Texture {
  const H = 256;
  const W = clamp(Math.round(H * aspect), 96, 768);
  return ctex(`printed|${bg}|${W}|${name}`, W, H, (c) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#ffffff30";
    c.fillRect(0, H * 0.68, W, H * 0.12);
    const title = name.replace(/^(box|bag|carton|tub|pack|packet|jar|bottle|tin|can) of /i, "").toUpperCase();
    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const { px, lines } = fitText(c, title, (p) => `bold ${p}px ${SANS}`, W * 0.88, H * 0.6, 120, 10, 1.1);
    lines.forEach((l, i) => c.fillText(l, W / 2, H * 0.36 + (i - (lines.length - 1) / 2) * px * 1.1));
  });
}

function stripesTex(): THREE.Texture {
  return ctex("stripes", 256, 128, (c) => {
    c.fillStyle = "#f5f2ec";
    c.fillRect(0, 0, 256, 128);
    c.fillStyle = "#24427a";
    for (const y of [18, 50, 82, 112]) c.fillRect(0, y, 256, 12);
  });
}
function speckleTex(): THREE.Texture {
  return ctex("speckle", 256, 128, (c) => {
    c.fillStyle = "#ece2cc";
    c.fillRect(0, 0, 256, 128);
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 420; i++) {
      c.fillStyle = rnd() < 0.5 ? "#5a4636" : "#8a6f55";
      c.beginPath();
      c.arc(rnd() * 256, rnd() * 128, 0.8 + rnd() * 1.6, 0, Math.PI * 2);
      c.fill();
    }
  });
}
function bossTex(): THREE.Texture {
  return ctex("boss", 512, 256, (c) => {
    c.fillStyle = "#f6f4ef";
    c.fillRect(0, 0, 512, 256);
    c.fillStyle = "#151515";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `bold 34px ${SANS}`;
    c.fillText("WORLD'S", 256, 80);
    c.font = `bold 52px ${SANS}`;
    c.fillText("BEST BOSS", 256, 130);
    c.fillStyle = "#c8a032";
    c.fillText("\u2605", 256, 190);
  });
}
function outletTex(): THREE.Texture {
  return ctex("outlet", 128, 192, (c) => {
    c.fillStyle = "#f2efe8";
    c.fillRect(0, 0, 128, 192);
    c.strokeStyle = "#c9c4b8";
    c.lineWidth = 4;
    c.strokeRect(2, 2, 124, 188);
    for (const cy of [55, 137]) {
      c.fillStyle = "#e4e0d6";
      roundRect(c, 30, cy - 34, 68, 68, 18);
      c.fill();
      c.fillStyle = "#1a1a1a";
      c.fillRect(46, cy - 18, 8, 22);
      c.fillRect(74, cy - 18, 8, 22);
      c.beginPath();
      c.arc(64, cy + 16, 6, Math.PI, 0);
      c.fill();
    }
  });
}
function floorTex(): THREE.Texture {
  const t = ctex("floor", 256, 256, (c) => {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = "#00000014";
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 64, 256, 2);
    for (let i = 0; i < 4; i++) c.fillRect(((i * 97) % 4) * 64 + (i % 2) * 32, i * 64, 2, 64);
    c.fillStyle = "#00000022";
    c.fillRect(0, 0, 256, 3);
    c.fillRect(0, 0, 3, 256);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function glowTex(): THREE.Texture {
  return ctex("glow", 64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });
}

// ---------------------------------------------------------------------------------------------------
// Context + frames

interface Ctx {
  snap: Snapshot;
  mode: SceneMode;
  byId: Map<string, Thing>;
  kids: Map<string, Thing[]>;
  rooms: Map<string, SnapRoom>;
}

interface Frame {
  g: THREE.Group;
  w: number;
  h: number;
  d: number;
}

/** Group at the AABB's bottom centre, rotated so local +z = facing; w/d swapped for side-facing things. */
function frameOf(t: Thing): Frame {
  let [fx, fz] = t.facing;
  if (!fx && !fz) fz = 1;
  const sx = t.max[0] - t.min[0];
  const sy = t.max[1] - t.min[1];
  const sz = t.max[2] - t.min[2];
  const side = Math.abs(fx) > Math.abs(fz);
  const g = new THREE.Group();
  g.position.set((t.min[0] + t.max[0]) / 2, t.min[1], (t.min[2] + t.max[2]) / 2);
  g.rotation.y = Math.atan2(fx, fz);
  g.updateMatrixWorld(true);
  return { g, w: Math.max(side ? sz : sx, 0.004), h: Math.max(sy, 0.002), d: Math.max(side ? sx : sz, 0.004) };
}

/**
 * Shelf-board heights (relative to t's bottom): the server's fixed slot heights plus wherever children
 * actually rest, so boards always sit exactly under the items.
 */
function boardLevels(t: Thing, ctx: Ctx, fixed: number[], lo: number, hi: number): number[] {
  const ys = [...fixed, ...(ctx.kids.get(t.id) ?? []).map((k) => k.min[1] - t.min[1])]
    .filter((y) => y > lo + 0.03 && y < hi - 0.04)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const y of ys) if (!out.length || y - out[out.length - 1]! > 0.03) out.push(y);
  return out;
}

function localCentre(t: Thing, g: THREE.Object3D): THREE.Vector3 {
  return g.worldToLocal(v3((t.min[0] + t.max[0]) / 2, t.min[1], (t.min[2] + t.max[2]) / 2));
}

// ---------------------------------------------------------------------------------------------------
// Shared furniture parts

/**
 * A row of cabinet doors on the front plane z = zf, spanning y0..y1. `fixed`: a single seamless panel with
 * no handle instead, for fronts that never open (under the counter, island and kitchen sink).
 */
function doorRow(g: Obj, w: number, y0: number, y1: number, zf: number, color: string, kind: "base" | "upper" | "tall", open: boolean, maxDoor = 0.6, fixed = false): void {
  if (fixed) {
    // one plain, seamless front: nothing about it looks like a door
    boxUp(g, w - 0.004, y1 - y0 - 0.004, 0.02, M(shade(color, -0.03)), 0, y0 + 0.002, zf + 0.01);
    return;
  }
  const n = Math.max(1, Math.round(w / maxDoor));
  const dw = w / n;
  const H = y1 - y0;
  const ft = 0.02;
  const doorM = M(color);
  const hM = M(C.handle, { shiny: 60 });
  for (let i = 0; i < n; i++) {
    const left = n === 1 || i % 2 === 0;
    const dir = left ? 1 : -1;
    const hx = -w / 2 + i * dw + (left ? 0 : dw);
    const pv = new THREE.Group();
    pv.position.set(hx, y0, zf);
    g.add(pv);
    boxUp(pv, dw - 0.005, H - 0.004, ft, doorM, (dir * dw) / 2, 0.002, ft / 2);
    // recessed panel line for a shaker look
    boxUp(pv, dw - 0.09, H - 0.09, 0.004, M(shade(color, -0.06)), (dir * dw) / 2, 0.045, ft + 0.002);
    const hl = Math.min(0.14, H * 0.4);
    const hy = kind === "upper" ? 0.05 + hl / 2 : kind === "base" ? H - 0.05 - hl / 2 : H / 2;
    box(pv, 0.012, hl, 0.012, hM, dir * (dw - 0.035), hy, ft + 0.016);
    if (open) pv.rotation.y = left ? -DOOR_SWING : DOOR_SWING;
  }
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, clamp(hsl.l + k, 0, 1));
  return `#${c.getHexString()}`;
}

/** Open carcass whose inner floor is at y0: outer panels + darker lining + shelf boards at `levels`. */
function hollow(g: Obj, w: number, y0: number, y1: number, d: number, zc: number, outer: string, inner: string, levels: number[], board: string, boardOp = 1): void {
  const s = 0.018;
  const fl = y0 <= 0.04 ? y0 : s;
  const H = y1 - y0 + fl;
  const oM = M(outer);
  boxUp(g, w, H, s, oM, 0, y0 - fl, zc - d / 2 + s / 2);
  boxUp(g, s, H, d, oM, -w / 2 + s / 2, y0 - fl, zc);
  boxUp(g, s, H, d, oM, w / 2 - s / 2, y0 - fl, zc);
  if (fl > 0) boxUp(g, w, fl, d, oM, 0, y0 - fl, zc);
  boxUp(g, w, s, d, oM, 0, y1 - s, zc);
  boxUp(g, w - 2 * s - 0.002, y1 - s - y0 - 0.002, d - s - 0.002, M(inner, { back: true }), 0, y0 + 0.001, zc + s / 2);
  const bM = boardOp < 1 ? M(board, { op: boardOp, shiny: 80 }) : M(board);
  for (const y of levels) boxUp(g, w - 2 * s - 0.004, 0.016, d - s - 0.012, bM, 0, y - 0.016, zc + s / 2 - 0.004);
}

// ---------------------------------------------------------------------------------------------------
// Furniture

function cabinet(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  if (/washing machine|washer|dryer/.test(n)) return washer(t, F);
  const upper = t.placement === "upper";
  const tall = t.placement === "tall";
  const base = !upper && !tall;
  const woody = /sideboard|shoe|dresser|chest|wardrobe/.test(n);
  const mirror = n.includes("mirror");
  const color = woody ? C.wood : C.cab;
  const slab = base && !woody && t.min[1] < 0.05 ? 0.035 : 0;
  const bh = h - slab;
  // server slot heights: base units 0.08 / 0.48, uppers +0.03 / +0.36, mirror cabinet +0.03 / +0.30
  const plinth = base || tall ? 0.08 : 0;
  const floorY = upper ? 0.03 : plinth;
  const fixed = upper ? [mirror ? 0.3 : 0.36] : base ? [0.48 - t.min[1]] : [];
  const ft = 0.02;
  const bd = d - ft;
  const zc = -ft / 2;
  if (slab) boxUp(g, w + 0.004, slab, d + 0.025, M(C.top, { shiny: 30 }), 0, bh, 0.012);
  if (plinth) boxUp(g, w - 0.02, plinth, bd - 0.05, M(woody ? C.darkWood : "#2a2622"), 0, 0, zc - 0.025);
  if (!t.open) boxUp(g, w, bh - plinth, bd, M(color), 0, plinth, zc);
  else hollow(g, w, floorY, bh, bd, zc, color, C.cabInside, boardLevels(t, ctx, fixed, floorY, bh), C.shelfBoard);
  if (mirror) {
    const pv = new THREE.Group();
    pv.position.set(-w / 2, plinth, d / 2 - ft);
    g.add(pv);
    boxUp(pv, w - 0.004, bh - plinth - 0.004, ft, M(color), w / 2, 0.002, ft / 2);
    plane(pv, w - 0.04, bh - plinth - 0.04, M("#cfdbe2", { shiny: 120 }), w / 2, (bh - plinth) / 2, ft + 0.001);
    if (t.open) pv.rotation.y = -DOOR_SWING;
    return;
  }
  doorRow(g, w, plinth, bh, d / 2 - ft, color, upper ? "upper" : tall ? "tall" : "base", !!t.open);
}

function washer(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const white = M("#eeeeec", { shiny: 30 });
  if (!t.open) boxUp(g, w, h, d, white, 0, 0, 0);
  else {
    // drum floor at the server's slot height (0.20)
    hollow(g, w, 0.2, h, d, 0, "#eeeeec", "#9aa0a6", [], "#ccc");
    boxUp(g, w, 0.2 - 0.018, d, white, 0, 0, 0);
  }
  boxUp(g, w - 0.02, 0.1, 0.01, M("#d8d8d4"), 0, h - 0.12, d / 2 + 0.004);
  plane(g, 0.12, 0.04, M("#203040", { e: "#3fb0ff", ei: 0.6 }), w * 0.15, h - 0.07, d / 2 + 0.01);
  cyl(g, 0.025, 0.025, 0.02, M(C.darkSteel), -w * 0.3, h - 0.07, d / 2 + 0.01).rotation.x = Math.PI / 2;
  const r = Math.min(w, h) * 0.32;
  const pv = new THREE.Group();
  pv.position.set(-r, h * 0.42, d / 2 + 0.01);
  g.add(pv);
  const door = new THREE.Group();
  door.position.set(r, 0, 0);
  door.rotation.x = Math.PI / 2;
  pv.add(door);
  cyl(door, r, r, 0.03, M(C.darkSteel, { shiny: 60 }), 0, -0.015, 0, 32);
  cyl(door, r * 0.78, r * 0.78, 0.032, M("#203038", { op: 0.75, shiny: 100 }), 0, -0.016, 0, 32);
  if (t.open) pv.rotation.y = -DOOR_SWING;
}

function drawer(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const ft = 0.02;
  boxUp(g, w - 0.004, h - 0.004, ft, M(C.cab), 0, 0.002, d / 2 - ft / 2);
  boxUp(g, w - 0.07, h - 0.06, 0.004, M(shade(C.cab, -0.06)), 0, 0.03, d / 2 + 0.001);
  const hM = M(C.handle, { shiny: 60 });
  box(g, Math.min(0.16, w * 0.45), 0.012, 0.012, hM, 0, h * 0.6, d / 2 + 0.016);
  if (!t.open) {
    boxUp(g, w, h, d - ft, M(C.cab), 0, 0, -ft / 2);
    return;
  }
  const s = 0.012;
  const tw = w - 0.03;
  const td = d - ft;
  const tz = -ft / 2;
  const sh = h * 0.72;
  const inM = M("#cdb48f");
  // tray floor at +0.03 (server slot height); the dark slot it came out of is drawn by drawerColumn
  boxUp(g, tw, s, td, inM, 0, 0.03 - s, tz);
  boxUp(g, s, sh, td, inM, -tw / 2 + s / 2, 0.018, tz);
  boxUp(g, s, sh, td, inM, tw / 2 - s / 2, 0.018, tz);
  boxUp(g, tw, sh, s, inM, 0, 0.018, -d / 2 + s / 2);
}

/**
 * Carcass + countertop for a column of drawers. The server gives each drawer only its own slice (slid out
 * along facing when open), so the column is reconstructed from the drawers' closed footprint.
 */
function drawerColumn(drawers: Thing[]): THREE.Group {
  const closed = drawers.map((t): Thing => {
    if (!t.open) return t;
    const dx = t.facing[0] * DRAWER_TRAVEL;
    const dz = t.facing[1] * DRAWER_TRAVEL;
    return { ...t, min: [t.min[0] - dx, t.min[1], t.min[2] - dz], max: [t.max[0] - dx, t.max[1], t.max[2] - dz] };
  });
  const first = closed[0]!;
  const top = Math.max(...closed.map((t) => t.max[1])) + 0.02;
  const F = frameOf({ ...first, min: [first.min[0], 0, first.min[2]], max: [first.max[0], top, first.max[2]] });
  const { g, w, h, d } = F;
  const slab = 0.03;
  const s = 0.018;
  const cab = M(C.cab);
  boxUp(g, w + 0.004, slab, d + 0.025, M(C.top, { shiny: 30 }), 0, h - slab, 0.012);
  boxUp(g, w - 0.02, 0.08, d - 0.07, M("#2a2622"), 0, 0, -0.045);
  boxUp(g, s, h - slab - 0.08, d - 0.02, cab, -w / 2 + s / 2, 0.08, -0.01);
  boxUp(g, s, h - slab - 0.08, d - 0.02, cab, w / 2 - s / 2, 0.08, -0.01);
  boxUp(g, w, h - slab - 0.08, s, cab, 0, 0.08, -d / 2 + s / 2);
  // front rails between the slices + dark slots for open drawers
  const slices = closed.map((t) => [t.min[1], t.max[1], t.open] as const).sort((a, b) => a[0] - b[0]);
  let y = 0.08;
  for (const [y0, y1, open] of slices) {
    if (y0 > y + 0.002) boxUp(g, w, y0 - y, 0.02, cab, 0, y, d / 2 - 0.01);
    if (open) boxUp(g, w - 2 * s - 0.002, y1 - y0, d - s - 0.004, M(C.cavity, { back: true }), 0, y0, s / 2);
    y = y1;
  }
  if (h - slab > y + 0.002) boxUp(g, w, h - slab - y, 0.02, cab, 0, y, d / 2 - 0.01);
  return g;
}

function fridge(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const freezer = /freezer/.test(t.name.toLowerCase());
  const steel = M(C.steel, { shiny: 50 });
  const ft = 0.06;
  const bd = d - ft;
  const zc = -ft / 2;
  boxUp(g, w - 0.04, 0.06, bd - 0.04, M("#1c1c1c"), 0, 0, zc);
  if (!t.open) boxUp(g, w, h - 0.06, bd, steel, 0, 0.06, zc);
  else {
    // server shelf heights: fridge/freezer 0.30 / 0.70 / 1.10 / 1.45, garage fridge 0.30 / 0.75
    const fixed = /garage/.test(t.name.toLowerCase()) ? [0.3, 0.75] : [0.3, 0.7, 1.1, 1.45];
    const lv = boardLevels(t, ctx, fixed.map((y) => y - t.min[1]), 0.06, h - 0.06);
    const liner = freezer ? "#dbe9f2" : "#e8ecef";
    hollow(g, w, 0.06, h, bd, zc, C.steel, liner, lv, freezer ? "#ffffff" : "#e3f0f6", freezer ? 1 : 0.55);
    // interior light: emissive liner + bright strip at the top
    boxUp(g, w * 0.4, 0.02, 0.05, M("#ffffff", { basic: true }), 0, h - 0.05, zc);
    box(g, w - 0.05, h - 0.14, 0.004, M("#ffffff", { e: freezer ? "#cfe9ff" : "#fff6e0", ei: 0.2 }), 0, h / 2, zc - bd / 2 + 0.03);
    if (!freezer) boxUp(g, w - 0.08, 0.16, bd - 0.1, M("#e6f3f7", { op: 0.5, shiny: 60 }), 0, 0.09, zc + 0.02);
    if (freezer) for (const y of lv) boxUp(g, w - 0.06, 0.01, bd - 0.05, M("#f4fbff", { e: "#d8efff", ei: 0.3 }), 0, y, zc);
  }
  // door hinged on the right, handle on the left
  const pv = new THREE.Group();
  pv.position.set(w / 2, 0.06, d / 2 - ft);
  g.add(pv);
  const dh = h - 0.065;
  boxUp(pv, w - 0.004, dh, ft, steel, -w / 2, 0, ft / 2);
  box(pv, 0.025, dh * 0.5, 0.025, M(C.darkSteel, { shiny: 80 }), -w + 0.05, dh * (freezer ? 0.5 : 0.62), ft + 0.03);
  box(pv, 0.012, 0.012, 0.03, M(C.darkSteel), -w + 0.05, dh * (freezer ? 0.5 : 0.62) + dh * 0.22, ft + 0.012);
  box(pv, 0.012, 0.012, 0.03, M(C.darkSteel), -w + 0.05, dh * (freezer ? 0.5 : 0.62) - dh * 0.22, ft + 0.012);
  if (t.open) {
    const binM = M("#eef6fa", { op: 0.7, shiny: 40 });
    boxUp(pv, w - 0.04, dh - 0.04, 0.01, M(freezer ? "#e4f2fb" : "#f2f4f6"), -w / 2, 0.02, -0.005);
    for (const fy of [0.2, 0.45, 0.7]) boxUp(pv, w - 0.12, 0.08, 0.08, binM, -w / 2, dh * fy, -0.05);
    pv.rotation.y = DOOR_SWING;
  }
}

function sink(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  const kids = ctx.kids.get(t.id) ?? [];
  const bath = /bath|pedestal/.test(n) || t.material === "ceramic";
  // basin bottom: server slot 0.72 (bathroom sink 0.70) unless children say otherwise
  const kidLow = kids.length ? Math.min(...kids.map((k) => k.min[1] - t.min[1])) : (bath ? 0.7 : 0.72) - t.min[1];
  const steel = M(C.steel, { shiny: 70, ds: true });
  let topY = h;
  let backZ = -d / 2;
  if (bath) {
    // pedestal sink: column + bowl
    const white = M("#f4f4f2", { shiny: 60, ds: true });
    const r = Math.min(w, d) / 2;
    const by = h - clamp(h - kidLow, 0.08, 0.3);
    cyl(g, r * 0.25, r * 0.35, by, white, 0, 0, -d * 0.1);
    lathe(g, [[0, by - 0.012], [r * 0.6, by - 0.004], [r * 0.9, h - 0.04], [r, h], [r * 0.92, h], [r * 0.82, h - 0.04], [r * 0.52, by + 0.006], [0, by]], white);
    disc(g, 0.018, M("#333"), 0, by + 0.002, 0);
    backZ = -r * 0.95;
  } else {
    const slab = 0.035;
    const bh = h - slab;
    const plastic = t.material === "plastic";
    if (plastic) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxUp(g, 0.035, bh, 0.035, M("#d9d9d4"), sx * (w / 2 - 0.03), 0, sz * (d / 2 - 0.03));
    } else {
      boxUp(g, w - 0.02, 0.08, d - 0.07, M("#2a2622"), 0, 0, -0.045);
      // carcass stops under the basin so the bowl stays visible
      boxUp(g, w, h - clamp(h - kidLow, 0.12, 0.3) - 0.08 - 0.01, d - 0.02, M(C.cab), 0, 0.08, -0.01);
      doorRow(g, w, 0.08, bh, d / 2 - 0.02, C.cab, "base", false, 0.6, true);
    }
    const bw = Math.min(w - 0.14, 0.62);
    const bdp = Math.min(d - 0.2, 0.42);
    const bz = 0.02;
    const depth = clamp(h - kidLow, 0.12, 0.3);
    const topM = plastic ? M("#e3e3de") : M(C.top, { shiny: 30 });
    const sw = (w + 0.004 - bw) / 2;
    boxUp(g, sw, slab, d + 0.025, topM, -w / 2 + sw / 2 - 0.002, bh, 0.012);
    boxUp(g, sw, slab, d + 0.025, topM, w / 2 - sw / 2 + 0.002, bh, 0.012);
    const fz0 = bz + bdp / 2;
    const fz1 = d / 2 + 0.025;
    boxUp(g, bw, slab, fz1 - fz0, topM, 0, bh, (fz0 + fz1) / 2);
    const bz0 = -d / 2;
    const bz1 = bz - bdp / 2;
    boxUp(g, bw, slab, bz1 - bz0, topM, 0, bh, (bz0 + bz1) / 2);
    const bm = plastic ? M("#ecece6", { ds: true }) : steel;
    const by = h - depth;
    boxUp(g, bw, 0.004, bdp, bm, 0, by, bz);
    boxUp(g, 0.004, depth, bdp, bm, -bw / 2, by, bz);
    boxUp(g, 0.004, depth, bdp, bm, bw / 2, by, bz);
    boxUp(g, bw, depth, 0.004, bm, 0, by, bz - bdp / 2);
    boxUp(g, bw, depth, 0.004, bm, 0, by, bz + bdp / 2);
    disc(g, 0.03, M("#3a3a3a"), 0, by + 0.005, bz);
    ring(g, 0.02, 0.032, M(C.darkSteel), 0, by + 0.006, bz);
    topY = h;
    backZ = -d / 2;
  }
  // tap
  const fz = backZ + 0.07;
  const chrome = M("#d7dbe0", { shiny: 120 });
  cyl(g, 0.026, 0.03, 0.03, chrome, 0, topY, fz);
  cyl(g, 0.015, 0.015, 0.27, chrome, 0, topY + 0.03, fz);
  tube(g, [v3(0, topY + 0.29, fz), v3(0, topY + 0.34, fz + 0.06), v3(0, topY + 0.31, fz + 0.15), v3(0, topY + 0.24, fz + 0.19)], 0.012, chrome, 24);
  sphere(g, 0.0125, chrome, 0, topY + 0.29, fz, 12);
  limb(g, v3(0.02, topY + 0.06, fz), v3(0.09, topY + 0.1, fz), 0.007, chrome);
  const note = t.noteText ?? (t.waterOff ? "WATER OFF" : undefined);
  if (t.waterOff || t.noteText) {
    // a paper note taped to the wall right beside the tap
    const nw = 0.22;
    const nh = 0.17;
    const nx = 0.2;
    const ny = topY + 0.24;
    const nzz = -d / 2 + WALL_T + 0.004;
    const p = plane(g, nw, nh, M("#ffffff", { map: noteTex(note!, nw / nh) }), nx, ny, nzz);
    p.rotation.z = -0.04;
    const tape = M("#efe6b0", { op: 0.75 });
    for (const sx of [-1, 1]) {
      const tp = box(g, 0.05, 0.018, 0.002, tape, nx + sx * (nw / 2 - 0.02), ny + nh / 2 - 0.004, nzz + 0.002);
      tp.rotation.z = sx * 0.5;
    }
    // and a strip of tape across the tap handle
    box(g, 0.02, 0.05, 0.004, tape, 0.055, topY + 0.08, fz).rotation.z = 0.9;
  }
}

function stove(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const steel = M(C.steel, { shiny: 50 });
  boxUp(g, w - 0.02, 0.06, d - 0.07, M("#1d1d1d"), 0, 0, -0.04);
  boxUp(g, w, h - 0.08, d - 0.02, steel, 0, 0.06, -0.01);
  boxUp(g, w, 0.022, d, M("#121214", { shiny: 90 }), 0, h - 0.022, 0);
  // oven door with window and bar handle
  const odH = (h - 0.06) * 0.68;
  boxUp(g, w - 0.03, odH, 0.02, steel, 0, 0.08, d / 2 - 0.01);
  plane(g, w * 0.62, odH * 0.42, M("#121212", { shiny: 90 }), 0, 0.08 + odH * 0.5, d / 2 + 0.001);
  box(g, w * 0.75, 0.018, 0.018, M(C.darkSteel, { shiny: 80 }), 0, 0.08 + odH - 0.05, d / 2 + 0.04);
  // control strip with knobs
  const ky = h - 0.065;
  boxUp(g, w - 0.01, 0.07, 0.01, M("#2a2a2c"), 0, ky - 0.035, d / 2 - 0.004);
  const pos: [number, number][] = [
    [-w * 0.24, -d * 0.2],
    [w * 0.24, -d * 0.2],
    [-w * 0.24, d * 0.17],
    [w * 0.24, d * 0.17],
  ];
  const active = new Set<number>();
  if (t.on) {
    const kids = ctx.kids.get(t.id) ?? [];
    for (const k of kids) {
      const c = localCentre(k, g);
      let best = 0;
      let bd = Infinity;
      pos.forEach(([x, z], i) => {
        const dd = (x - c.x) ** 2 + (z - c.z) ** 2;
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      active.add(best);
    }
    if (!active.size) active.add(2);
  }
  const knobX = [-w * 0.36, -w * 0.12, w * 0.12, w * 0.36];
  const knobFor = [0, 2, 3, 1];
  knobX.forEach((x, i) => {
    const kn = cyl(g, 0.02, 0.022, 0.025, M("#d9d9d9", { shiny: 40 }), 0, -0.0125, 0, 16);
    const kg = new THREE.Group();
    kg.add(kn);
    kn.rotation.x = Math.PI / 2;
    box(kg, 0.004, 0.016, 0.004, M("#222"), 0, 0.008, 0.014);
    kg.position.set(x, ky, d / 2 + 0.013);
    if (active.has(knobFor[i]!)) kg.rotation.z = -2.2;
    g.add(kg);
  });
  if (active.size) sphere(g, 0.006, M("#ff3010", { basic: true }), w * 0.45, ky, d / 2 + 0.003, 8);
  pos.forEach(([x, z], i) => {
    const big = i % 3 === 0 ? 0.085 : 0.07;
    const on = active.has(i);
    const coilM = on ? M("#ff5a1a", { e: "#ff3a0a", ei: 1.6 }) : M("#38383a", { shiny: 30 });
    for (const k of [1, 0.66, 0.33]) ring(g, big * k - 0.009, big * k, coilM, x, h + 0.001, z, 40);
    if (on) {
      const glow = disc(g, big * 1.25, M("#ff4a10", { op: 0.4, blend: "add", dw: false }), x, h + 0.002, z);
      glow.renderOrder = 2;
    } else ring(g, big + 0.004, big + 0.008, M("#555"), x, h + 0.001, z, 40);
  });
}

function dishwasher(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const steel = M(C.steel, { shiny: 50 });
  const ft = 0.025;
  const bd = d - ft;
  boxUp(g, w, 0.035, d + 0.025, M(C.top, { shiny: 30 }), 0, h - 0.035, 0.012);
  const bh = h - 0.035;
  if (!t.open) boxUp(g, w, bh, bd, steel, 0, 0, -ft / 2);
  else {
    const lv = boardLevels(t, ctx, [0.2 - t.min[1], 0.5 - t.min[1]], 0.02, bh);
    hollow(g, w, 0, bh, bd, -ft / 2, C.steel, "#b8bec4", [], C.steel);
    const rack = M("#7d8790", { shiny: 30 });
    for (const y of lv) {
      const rw = w - 0.06;
      const rd = bd - 0.06;
      const z0 = -ft / 2;
      for (const sx of [-1, 1]) box(g, 0.008, 0.06, rd, rack, (sx * rw) / 2, y + 0.02, z0);
      for (const sz of [-1, 1]) box(g, rw, 0.06, 0.008, rack, 0, y + 0.02, z0 + (sz * rd) / 2);
      for (let i = 0; i <= 8; i++) box(g, 0.005, 0.005, rd, rack, -rw / 2 + (rw * i) / 8, y - 0.004, z0);
    }
  }
  const pv = new THREE.Group();
  pv.position.set(0, 0.06, d / 2 - ft);
  g.add(pv);
  const dh = bh - 0.06;
  boxUp(pv, w - 0.004, dh, ft, steel, 0, 0, ft / 2);
  boxUp(pv, w - 0.004, 0.07, 0.004, M("#26282b"), 0, dh - 0.075, ft + 0.001);
  for (let i = 0; i < 3; i++) sphere(pv, 0.004, M(i === 0 ? "#3bd16f" : "#444", { basic: i === 0 }), w * 0.25 + i * 0.03, dh - 0.04, ft + 0.004, 8);
  box(pv, w * 0.5, 0.015, 0.02, M(C.darkSteel, { shiny: 70 }), 0, dh - 0.12, ft + 0.015);
  if (t.open) {
    plane(pv, w - 0.04, dh - 0.04, M("#b8bec4"), 0, dh / 2, -0.001).rotation.y = Math.PI;
    pv.rotation.x = Math.PI / 2;
  }
}

function surface(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  if (/sofa|couch/.test(n)) return sofa(t, F, ctx);
  if (/counter|island|worktop/.test(n) || (t.placement === "base" && h > 0.7)) {
    const slab = 0.035;
    const island = n.includes("island");
    boxUp(g, w + 0.004, slab, d + (island ? 0.06 : 0.025), M(C.top, { shiny: 30 }), 0, h - slab, island ? 0 : 0.012);
    boxUp(g, w - 0.02, 0.08, d - 0.07, M("#2a2622"), 0, 0, -0.045);
    boxUp(g, w, h - slab - 0.08, d - 0.02, M(C.cab), 0, 0.08, -0.01);
    doorRow(g, w, 0.08, h - slab, d / 2 - 0.02, C.cab, "base", false, 0.6, true);
    return;
  }
  const bench = /workbench/.test(n);
  const slim = /console|side/.test(n);
  const coffee = /coffee table/.test(n);
  const top = bench ? 0.06 : 0.035;
  const woodC = bench ? "#b48a5a" : coffee ? "#7a5236" : C.wood;
  const wM = M(woodC, { shiny: 20 });
  boxUp(g, w, top, d, wM, 0, h - top, 0);
  const leg = slim ? 0.035 : bench ? 0.07 : 0.05;
  const inset = 0.03 + leg / 2;
  const legM = M(bench ? "#5a5a5e" : shade(woodC, -0.08));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxUp(g, leg, h - top, leg, legM, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
  if (bench || coffee) boxUp(g, w - 0.08, 0.025, d - 0.08, wM, 0, h * 0.18, 0);
  if (slim) boxUp(g, w - 0.06, 0.1, d - 0.04, wM, 0, h - top - 0.1, 0);
}

function sofa(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const kids = ctx.kids.get(t.id) ?? [];
  // server puts sofa items on the seat at y = 0.45
  const seat = clamp(kids.length ? Math.min(...kids.map((k) => k.min[1] - t.min[1])) : 0.45 - t.min[1], 0.3, h - 0.15);
  const fab = M(pick(["#5d6b7a", "#7a5d55", "#5f7564", "#6c6676"], t.id));
  const fabD = M(shade(pick(["#5d6b7a", "#7a5d55", "#5f7564", "#6c6676"], t.id), -0.07));
  const arm = Math.min(0.18, w * 0.1);
  const back = Math.min(0.22, d * 0.28);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, 0.02, 0.016, 0.07, M(C.darkWood), sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), 10);
  boxUp(g, w, seat - 0.13 - 0.07, d, fabD, 0, 0.07, 0);
  const nc = Math.max(1, Math.round((w - 2 * arm) / 0.65));
  const cw = (w - 2 * arm) / nc;
  for (let i = 0; i < nc; i++) boxUp(g, cw - 0.012, 0.13, d - back - 0.01, fab, -w / 2 + arm + cw * (i + 0.5), seat - 0.13, back / 2);
  boxUp(g, w, h - 0.07, back, fabD, 0, 0.07, -d / 2 + back / 2);
  for (let i = 0; i < nc; i++) boxUp(g, cw - 0.02, h - seat - 0.05, 0.1, fab, -w / 2 + arm + cw * (i + 0.5), seat, -d / 2 + back + 0.05);
  for (const sx of [-1, 1]) boxUp(g, arm, seat + 0.1 - 0.07, d, fabD, sx * (w / 2 - arm / 2), 0.07, 0);
}

function shelf(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  const metal = /tool|utility|garage|wire/.test(n);
  const col = metal ? "#8a9097" : n.includes("book") ? C.darkWood : C.wood;
  const m = M(col);
  const s = 0.02;
  // server board heights: tall shelves 0.05 / 0.50 / 0.95 / 1.40, wall shelves at their bottom
  const upper = t.placement === "upper";
  const lv = boardLevels(t, ctx, upper ? [0] : [0.05, 0.5, 0.95, 1.4].map((y) => y - t.min[1]), upper ? -0.04 : 0, h);
  boxUp(g, s, h, d, m, -w / 2 + s / 2, 0, 0);
  boxUp(g, s, h, d, m, w / 2 - s / 2, 0, 0);
  if (!metal) boxUp(g, w, h, 0.01, M(shade(col, -0.06)), 0, 0, -d / 2 + 0.005);
  for (const y of [...lv, h]) boxUp(g, w - 0.002, s, d, m, 0, y - s, 0);
  if (metal) for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxUp(g, 0.025, h, 0.025, M("#5c6168"), sx * (w / 2 - 0.0125), 0, sz * (d / 2 - 0.0125));
}

function decor(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  if (/tv|television/.test(n)) {
    const consH = h * 0.38;
    boxUp(g, w, consH, d, M(C.darkWood), 0, 0, 0);
    boxUp(g, w * 0.3, 0.02, d * 0.5, M(C.black), 0, consH, 0);
    boxUp(g, 0.06, h * 0.08, 0.04, M(C.black), 0, consH, -d * 0.1);
    const sh = h - consH - h * 0.08;
    boxUp(g, w * 0.96, sh, 0.05, M("#111214", { shiny: 60 }), 0, consH + h * 0.08, -d * 0.1);
    plane(g, w * 0.92, sh * 0.9, M("#0b0e14", { shiny: 120 }), 0, consH + h * 0.08 + sh / 2, -d * 0.1 + 0.026);
    return;
  }
  if (/coat|hat stand/.test(n)) {
    const r = Math.min(w, d) / 2;
    cyl(g, r * 0.7, r * 0.8, 0.03, M(C.darkWood), 0, 0, 0);
    cyl(g, 0.02, 0.025, h, M(C.darkWood), 0, 0, 0, 12);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + 0.4;
      limb(g, v3(0, h - 0.12, 0), v3(Math.sin(a) * 0.14, h - 0.04, Math.cos(a) * 0.14), 0.008, M(C.darkWood));
    }
    const jackets = ["#2d3e50", "#7a3b2e", "#4a5a3a"];
    jackets.forEach((jc, i) => {
      const a = i * 2.1;
      const j = new THREE.Group();
      j.position.set(Math.sin(a) * 0.09, h - 0.1, Math.cos(a) * 0.09);
      j.rotation.y = a;
      g.add(j);
      boxUp(j, 0.3, 0.06, 0.12, M(jc), 0, -0.06, 0.03);
      const coat = boxUp(j, 0.34, 0.7, 0.13, M(jc), 0, -0.76, 0.05);
      coat.rotation.x = 0.06;
    });
    return;
  }
  boxUp(g, w, h, d, M(C.wood), 0, 0, 0);
}

// ---------------------------------------------------------------------------------------------------
// Power cords (pluggable appliances)

function addCord(t: Thing, F: Frame, ctx: Ctx): void {
  if (t.plugged === undefined) return;
  const { g, w, d } = F;
  const cordM = M("#1a1a1a");
  const startY = 0.03;
  const parent = t.parent ? ctx.byId.get(t.parent) : undefined;
  if (parent && /island/i.test(parent.name)) {
    // free-standing island: the outlet sits on the island's nearer end panel, 15 cm below the top
    const a = g.worldToLocal(v3(parent.min[0], 0, parent.min[2]));
    const b = g.worldToLocal(v3(parent.max[0], 0, parent.max[2]));
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const side = x1 <= -x0 ? 1 : -1;
    const ex = side > 0 ? x1 : x0;
    const oy = -0.15;
    const face = plane(g, 0.075, 0.115, M("#ffffff", { map: outletTex() }), ex + side * 0.009, oy, 0);
    face.rotation.y = (side * Math.PI) / 2;
    box(g, 0.008, 0.115, 0.075, M("#f2efe8"), ex + side * 0.004, oy, 0);
    if (t.plugged) {
      const plugY = oy - 0.027;
      tube(g, [v3(side * w * 0.2, startY, -d / 2 + 0.01), v3(side * w * 0.3, 0.008, -d / 2 - 0.03), v3(ex - side * 0.03, 0.008, -0.02), v3(ex + side * 0.02, -0.01, -0.01), v3(ex + side * 0.035, plugY - 0.04, 0), v3(ex + side * 0.03, plugY - 0.02, 0)], 0.004, cordM);
      box(g, 0.03, 0.042, 0.034, M("#222"), ex + side * 0.024, plugY, 0);
      return;
    }
  }
  const room = ctx.rooms.get(t.room);
  let [fx, fz] = t.facing;
  if (!fx && !fz) fz = 1;
  let dist = Infinity;
  if (room && !(parent && /island/i.test(parent.name))) {
    if (Math.abs(fz) >= Math.abs(fx)) dist = fz > 0 ? t.min[2] - (room.z0 + WALL_T) : room.z1 - WALL_T - t.max[2];
    else dist = fx > 0 ? t.min[0] - (room.x0 + WALL_T) : room.x1 - WALL_T - t.max[0];
  }
  const wall = dist >= -0.02 && dist < 0.6;
  const ox = w * 0.28;
  // outlet on the backsplash just above the appliance so it is visible from the front
  const oy = Math.max(0.2, F.h + 0.08);
  const wz = -d / 2 - Math.max(dist, 0);
  if (wall) {
    plane(g, 0.075, 0.115, M("#ffffff", { map: outletTex() }), ox, oy, wz + 0.009);
    boxUp(g, 0.075, 0.115, 0.008, M("#f2efe8"), ox, oy - 0.0575, wz + 0.004);
  }
  if (t.plugged && wall) {
    const plugY = oy - 0.027;
    tube(g, [v3(w * 0.2, startY, -d / 2 + 0.01), v3(w * 0.2, 0.008, -d / 2 - 0.015), v3(ox - 0.01, 0.008, wz + 0.04), v3(ox, plugY - 0.05, wz + 0.035), v3(ox, plugY - 0.02, wz + 0.03)], 0.004, cordM);
    boxUp(g, 0.034, 0.042, 0.03, M("#222"), ox, plugY - 0.021, wz + 0.024);
  } else if (t.plugged) {
    tube(g, [v3(w * 0.2, startY, -d / 2 + 0.01), v3(w * 0.2, 0.01, -d / 2 - 0.03), v3(w * 0.2, -0.04, -d / 2 - 0.06), v3(w * 0.2, -0.5, -d / 2 - 0.08)], 0.004, cordM);
  } else {
    // unplugged: plug lies on the counter behind the appliance, prongs towards the empty outlet
    const gap = Math.max(0.06, Math.min(Number.isFinite(dist) ? dist : 0.12, 0.2));
    const px = w * 0.32;
    const pz = -d / 2 - gap / 2;
    tube(g, [v3(w * 0.2, startY, -d / 2 + 0.01), v3(w * 0.22, 0.008, -d / 2 - 0.02), v3(w * 0.4, 0.01, pz + 0.035), v3(px, 0.012, pz + 0.02)], 0.004, cordM);
    const plug = new THREE.Group();
    plug.position.set(px, 0.012, pz);
    plug.rotation.y = Math.PI + 0.3;
    g.add(plug);
    box(plug, 0.032, 0.024, 0.042, M("#222"), 0, 0.001, 0);
    const prong = M("#d8c27a", { shiny: 90 });
    box(plug, 0.004, 0.012, 0.02, prong, -0.008, 0.001, 0.03);
    box(plug, 0.004, 0.012, 0.02, prong, 0.008, 0.001, 0.03);
  }
}

/** Small power LED: lit colour when `lit`, otherwise a dark lens. */
function led(p: Obj, lit: string | null, x: number, y: number, z: number, r = 0.006): void {
  if (lit) {
    sphere(p, r, M(lit, { basic: true }), x, y, z, 10);
    const halo = sphere(p, r * 2.6, M(lit, { op: 0.35, blend: "add", dw: false, basic: true }), x, y, z, 10);
    halo.renderOrder = 3;
  } else sphere(p, r, M("#2a2a2a", { shiny: 80 }), x, y, z, 10);
}

function powerLed(t: Thing): string | null {
  if (t.plugged === false) return null;
  if (t.broken) return "#ff2a1a";
  return t.on ? "#33ff66" : null;
}

// ---------------------------------------------------------------------------------------------------
// Fill + steam

function addFill(g: Obj, inner: P2[], fill: SnapFill | undefined, x = 0, z = 0, seg = 28): void {
  if (!fill || fill.level <= 0.003 || inner.length < 2) return;
  const y0 = inner[0]![1];
  const y1 = inner[inner.length - 1]![1];
  const ly = y0 + clamp(fill.level, 0, 1) * (y1 - y0);
  const pts: P2[] = [[0, y0 + 0.001]];
  let rl = inner[0]![0];
  for (let i = 0; i < inner.length; i++) {
    const [r, y] = inner[i]!;
    if (y < ly) {
      pts.push([r * 0.985, Math.max(y, y0 + 0.001)]);
      rl = r;
    } else {
      const [pr, py] = inner[Math.max(0, i - 1)]!;
      rl = py === y ? r : pr + ((r - pr) * (ly - py)) / (y - py);
      break;
    }
  }
  pts.push([rl * 0.985, ly]);
  if (fill.solid) {
    pts.push([rl * 0.65, ly + rl * 0.2]);
    pts.push([0, ly + rl * 0.3]);
  } else pts.push([0, ly]);
  const m = lathe(g, pts, M(fill.color, { shiny: fill.solid ? 0 : 70, ds: true }), seg);
  m.position.set(x, 0, z);
  if (fill.steam) addSteam(g, x, y1 + 0.01, z, Math.max(rl, 0.02));
}

function addSteam(g: Obj, x: number, y: number, z: number, r: number): void {
  const m = new THREE.SpriteMaterial({ map: glowTex(), color: 0xffffff, opacity: 0.38, transparent: true, depthWrite: false });
  sharedMats.add(m);
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(m);
    const k = 0.7 + i * 0.35;
    s.scale.set(r * 1.6 * k, r * 2.2 * k, 1);
    s.position.set(x + Math.sin(i * 2.3) * r * 0.5, y + i * r * 0.9, z + Math.cos(i * 1.7) * r * 0.3);
    s.renderOrder = 4;
    g.add(s);
  }
}

// ---------------------------------------------------------------------------------------------------
// Appliances

function coffeeMaker(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const body = M("#1d1d1f", { shiny: 40 });
  const towerD = d * 0.38;
  const tz = -d / 2 + towerD / 2;
  const frontD = d - towerD;
  const fzc = d / 2 - frontD / 2;
  // base 2 cm tall: the server stands the carafe on the plate at maker.min.y + 0.02
  boxUp(g, w, 0.02, d, body, 0, 0, 0);
  boxUp(g, w, h * 0.62, towerD, body, 0, 0, tz);
  // warming plate
  const pr = Math.min(w, frontD) * 0.38;
  const warm = t.on && t.plugged !== false && !t.broken;
  disc(g, pr, warm ? M("#4a1a10", { e: "#ff3a10", ei: 0.35 }) : M("#2c2c2e", { shiny: 30 }), 0, 0.0205, fzc);
  // hood with control strip
  const hoodY = h * 0.62;
  const hoodH = h * 0.16;
  boxUp(g, w, hoodH, frontD, body, 0, hoodY, fzc);
  plane(g, w * 0.7, hoodH * 0.5, M("#2e2f33", { shiny: 60 }), 0, hoodY + hoodH * 0.5, d / 2 + 0.001);
  led(g, powerLed(t), w * 0.22, hoodY + hoodH * 0.5, d / 2 + 0.004);
  box(g, 0.03, 0.014, 0.008, M("#555"), -w * 0.12, hoodY + hoodH * 0.5, d / 2 + 0.004);
  box(g, 0.03, 0.014, 0.008, M("#555"), w * 0.02, hoodY + hoodH * 0.5, d / 2 + 0.004);
  // open filter basket on top of the hood, lid flipped up against the reservoir
  const top = hoodY + hoodH;
  const br = Math.min(w, frontD) * 0.36;
  const bh = h * 0.1;
  const bz = fzc + 0.005;
  const basketM = M("#2a2a2c", { ds: true });
  cyl(g, br, br * 0.8, bh, basketM, 0, top, bz, 28, true);
  disc(g, br * 0.8, M("#131313"), 0, top + 0.002, bz);
  ring(g, br, br + 0.008, M("#3a3a3c"), 0, top + bh, bz);
  if (t.filter) {
    const fm = M("#f7f3ea", { ds: true });
    cyl(g, br * 0.95, br * 0.45, bh * 0.95, fm, 0, top + 0.006, bz, 24, true);
    // crimped rim so the paper reads as a paper filter
    ring(g, br * 0.9, br * 0.97, M("#ece6d6", { ds: true }), 0, top + 0.006 + bh * 0.95, bz, 24);
  }
  if (t.basketFill) addFill(g, [[br * (t.filter ? 0.42 : 0.78), top + 0.008], [br * 0.9, top + bh * 0.85]], t.basketFill, 0, bz);
  const lid = new THREE.Group();
  lid.position.set(0, top + bh, bz - br - 0.004);
  lid.rotation.x = -1.35;
  g.add(lid);
  cyl(lid, br + 0.01, br + 0.01, 0.012, body, 0, 0, br + 0.01, 28);
  // reservoir: translucent tank at the back, water visible at its level
  const rY = h * 0.62;
  const rH = h - rY - 0.015;
  const tank = M("#cfe2ea", { op: 0.32, shiny: 90, dw: false });
  const lvl = clamp(t.reservoirLevel ?? 0, 0, 1);
  if (lvl > 0.01) boxUp(g, w * 0.86, rH * 0.95 * lvl, towerD * 0.8, M(C.water, { op: 0.85, shiny: 60 }), 0, rY + 0.004, tz);
  boxUp(g, w * 0.92, rH, towerD * 0.9, tank, 0, rY, tz).renderOrder = 1;
  for (let i = 1; i <= 4; i++) box(g, w * 0.08, 0.003, 0.002, M("#ffffff", { basic: true }), w * 0.38, rY + (rH * i) / 5, tz + towerD * 0.45 + 0.002);
  boxUp(g, w, 0.015, towerD, body, 0, h - 0.015, tz);
  addCord(t, F, ctx);
}

function grinder(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const r = Math.min(w, d) / 2 * 0.85;
  const body = M(t.material === "metal" ? C.steel : "#24242a", { shiny: 50 });
  cyl(g, r * 0.95, r, h * 0.55, body, 0, 0, 0, 28);
  box(g, r * 0.9, h * 0.18, 0.01, M("#3a3a40", { shiny: 70 }), 0, h * 0.22, r * 0.98);
  const hb = h * 0.55;
  const hop = M("#d6e6ee", { op: 0.3, ds: true, shiny: 100, dw: false });
  addFill(g, [[r * 0.82, hb], [r * 0.88, h * 0.9]], t.fill);
  cyl(g, r * 0.88, r * 0.82, h * 0.36, hop, 0, hb, 0, 28, true).renderOrder = 1;
  cyl(g, r * 0.9, r * 0.9, h * 0.08, M("#2e3640", { op: 0.75, shiny: 100 }), 0, h * 0.91, 0, 28);
  led(g, powerLed(t), r * 0.45, h * 0.45, r * 0.95);
  cyl(g, 0.014, 0.014, 0.012, M("#666"), -r * 0.4, h * 0.45, r * 0.94, 12).rotation.x = Math.PI / 2;
  addCord(t, F, ctx);
}

function kettleBase(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const r = Math.min(w, d) / 2;
  cyl(g, r * 0.92, r, Math.max(h, 0.02), M("#2a2a2c", { shiny: 30 }), 0, 0, 0, 32);
  cyl(g, r * 0.22, r * 0.25, Math.max(h, 0.02) + 0.008, M("#555"), 0, 0, 0, 16);
  led(g, t.plugged ? "#2f7dff" : null, 0, Math.max(h, 0.02) * 0.5, r * 0.98, 0.004);
  addCord(t, F, ctx);
}

function microwave(t: Thing, F: Frame, ctx: Ctx): void {
  const { g, w, h, d } = F;
  const body = M("#2a2b2e", { shiny: 40 });
  const powered = t.plugged !== false;
  const lit = !!t.on && powered;
  const panelW = w * 0.27;
  const cavW = w - panelW - 0.04;
  const cx = -w / 2 + 0.02 + cavW / 2;
  const s = 0.02;
  boxUp(g, w, s, d, body, 0, 0, 0);
  boxUp(g, w, s, d, body, 0, h - s, 0);
  boxUp(g, s, h, d, body, -w / 2 + s / 2, 0, 0);
  boxUp(g, w, h, s, body, 0, 0, -d / 2 + s / 2);
  boxUp(g, panelW + 0.02, h, d - 0.01, body, w / 2 - (panelW + 0.02) / 2, 0, -0.005);
  const inner = lit ? M("#fff1c4", { e: "#ffd27a", ei: 0.75, back: true }) : M("#9c9c98", { back: true });
  boxUp(g, cavW, h - 2 * s, d - s - 0.02, inner, cx, s, s / 2 - 0.01);
  // turntable top at +0.03 (server slot height)
  cyl(g, cavW * 0.38, cavW * 0.38, 0.006, M("#e6eef2", { op: 0.6, shiny: 90 }), cx, 0.024, 0, 32);
  // control panel: clock display + keypad
  const px = w / 2 - panelW / 2;
  const disp = ctex(`mwdisp|${powered ? ctx.snap.clock : ""}|${lit}`, 256, 96, (c) => {
    c.fillStyle = "#0a0d0a";
    c.fillRect(0, 0, 256, 96);
    if (!powered) return;
    c.fillStyle = lit ? "#7dff9a" : "#46d36a";
    c.font = `bold 64px Consolas, monospace`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    const m = /(\d{1,2}):(\d{2})/.exec(ctx.snap.clock);
    c.fillText(lit ? "0:42" : m ? `${m[1]}:${m[2]}` : "--:--", 128, 50);
  });
  plane(g, panelW * 0.8, h * 0.13, M("#ffffff", { map: disp, basic: true }), px, h * 0.82, d / 2 + 0.001);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) box(g, panelW * 0.2, h * 0.07, 0.006, M("#4a4b50"), px + (c - 1) * panelW * 0.27, h * (0.62 - r * 0.11), d / 2 + 0.002);
  // door hinged left, dark see-through window
  const pv = new THREE.Group();
  pv.position.set(-w / 2, 0, d / 2);
  g.add(pv);
  const dw = w - panelW - 0.005;
  const frame = M("#1d1e20", { shiny: 60 });
  boxUp(pv, dw, 0.05, 0.02, frame, dw / 2, 0.005, 0.0);
  boxUp(pv, dw, 0.05, 0.02, frame, dw / 2, h - 0.055, 0.0);
  boxUp(pv, 0.05, h - 0.01, 0.02, frame, 0.025, 0.005, 0.0);
  boxUp(pv, 0.07, h - 0.01, 0.02, frame, dw - 0.035, 0.005, 0.0);
  const win = boxUp(pv, dw - 0.12, h - 0.1, 0.012, M("#141414", { op: lit ? 0.35 : 0.55, shiny: 100, dw: false }), dw / 2 - 0.01, 0.05, 0);
  win.renderOrder = 1;
  box(pv, 0.02, h * 0.6, 0.02, M(C.darkSteel, { shiny: 70 }), dw - 0.035, h / 2, 0.025);
  if (t.open) pv.rotation.y = -DOOR_SWING;
  addCord(t, F, ctx);
}

// ---------------------------------------------------------------------------------------------------
// Portable items

const MUG_COLORS: Record<string, string> = {
  white: "#f4f2ee",
  blue: "#3263b5",
  green: "#5d8f58",
  yellow: "#ecc537",
  black: "#202022",
  red: "#b33b2e",
};

function mug(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(d / 2, w / 2.6);
  const cx = -0.3 * r;
  const hint = (t.color ?? t.name).toLowerCase();
  let outer: THREE.Material;
  let col = "#f4f2ee";
  if (hint.includes("boss")) outer = M("#ffffff", { map: bossTex(), shiny: 40 });
  else if (hint.includes("stripe")) outer = M("#ffffff", { map: stripesTex(), shiny: 40 });
  else if (hint.includes("speckle")) {
    outer = M("#ffffff", { map: speckleTex(), shiny: 20 });
    col = "#ece2cc";
  } else {
    for (const [k, v] of Object.entries(MUG_COLORS)) if (hint.includes(k)) col = v;
    outer = M(col, { shiny: 40 });
  }
  const tex = hint.includes("boss") || hint.includes("stripe") || hint.includes("speckle");
  const wall = Math.max(0.004, r * 0.08);
  const ri = r - wall;
  const om = mesh(new THREE.CylinderGeometry(r, r * 0.96, h, 32, 1, true, Math.PI, Math.PI * 2), outer, g);
  om.position.set(cx, h / 2, 0);
  const innerC = col === "#202022" ? "#2a2a2c" : tex ? "#f4f2ee" : col;
  cyl(g, ri, ri * 0.96, h - 0.008, M(innerC, { back: true, shiny: 30 }), cx, 0.008, 0, 32, true);
  disc(g, ri * 0.96, M(innerC), cx, 0.009, 0);
  ring(g, ri, r, M(innerC, { shiny: 30 }), cx, h, 0);
  disc(g, r * 0.96, M(innerC), cx, 0.0005, 0).rotation.x = Math.PI;
  const handleM = tex ? M(hint.includes("stripe") ? "#24427a" : "#f2efe8", { shiny: 40 }) : outer;
  const hdl = mesh(sgeo("mugHandle", () => new THREE.TorusGeometry(1, 0.17, 8, 20, Math.PI)), handleM, g);
  hdl.scale.setScalar(h * 0.3);
  hdl.rotation.z = -Math.PI / 2;
  hdl.position.set(cx + r * 0.92, h * 0.52, 0);
  if (hint.includes("chip")) box(g, r * 0.35, h * 0.06, wall * 1.5, M("#e9e1cf"), cx + r * 0.2, h - h * 0.02, r * 0.97).rotation.z = 0.4;
  if (t.dirty) {
    disc(g, ri * 0.9, M("#4a2c17", { op: 0.85 }), cx, 0.0105, 0);
    cyl(g, ri * 0.985, ri * 0.985, h * 0.05, M("#5a3820", { back: true }), cx, h * 0.5, 0, 32, true);
    cyl(g, ri * 0.99, ri * 0.99, h * 0.25, M("#8a6a4e", { back: true, op: 0.5 }), cx, h * 0.25, 0, 32, true);
  }
  addFill(g, [[ri * 0.95, 0.01], [ri, h - 0.006]], t.fill, cx, 0);
}

function kettle(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w / 2.7, d / 2);
  const body = M(t.material === "metal" ? C.steel : "#eceae4", { shiny: 60 });
  const dark = M("#2a2a2c", { shiny: 30 });
  cyl(g, r * 0.98, r, h * 0.06, dark, 0, 0, 0, 32);
  cyl(g, r * 0.8, r * 0.98, h * 0.76, body, 0, h * 0.06, 0, 32);
  cyl(g, r * 0.62, r * 0.8, h * 0.06, body, 0, h * 0.82, 0, 32);
  cyl(g, r * 0.6, r * 0.62, h * 0.03, dark, 0, h * 0.88, 0, 32);
  boxUp(g, r * 0.35, h * 0.05, r * 0.2, dark, 0, h * 0.91, 0);
  // spout (left)
  const sp = cyl(g, r * 0.12, r * 0.22, h * 0.25, body, -r * 0.92, h * 0.68, 0, 12);
  sp.rotation.z = 0.75;
  // handle (right)
  boxUp(g, r * 0.18, h * 0.66, r * 0.28, dark, r * 1.22, h * 0.16, 0);
  box(g, r * 0.4, r * 0.18, r * 0.28, dark, r * 1.02, h * 0.82, 0);
  box(g, r * 0.3, r * 0.18, r * 0.28, dark, r * 1.05, h * 0.2, 0);
  // water-level window on the front
  const wy0 = h * 0.14;
  const wh = h * 0.6;
  const zf = r * 0.9 + 0.004;
  boxUp(g, r * 0.32, wh + 0.012, 0.008, dark, 0, wy0 - 0.006, zf - 0.002);
  plane(g, r * 0.24, wh, M("#d9e7ee", { shiny: 80 }), 0, wy0 + wh / 2, zf + 0.0025);
  const lvl = t.fill ? clamp(t.fill.level, 0, 1) : 0;
  if (lvl > 0.01) plane(g, r * 0.24, wh * lvl, M(t.fill!.color, { shiny: 80 }), 0, wy0 + (wh * lvl) / 2, zf + 0.003);
  for (let i = 1; i < 5; i++) box(g, r * 0.08, 0.002, 0.001, M("#333"), -r * 0.08, wy0 + (wh * i) / 5, zf + 0.004);
  led(g, t.on ? "#ff2a1a" : null, r * 1.22, h * 0.12, r * 0.18, 0.006);
  if (t.fill?.steam) addSteam(g, -r * 1.15, h * 0.85, 0, r * 0.35);
}

function stovetopKettle(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w / 2.6, d / 2);
  const m = M(C.steel, { shiny: 90, ds: true });
  const prof: P2[] = [[0, 0], [r * 0.95, 0], [r, h * 0.05], [r, h * 0.35], [r * 0.82, h * 0.55], [r * 0.45, h * 0.68], [r * 0.4, h * 0.7]];
  lathe(g, prof, m, 36);
  const fillProf: P2[] = [[r * 0.93, 0.004], [r * 0.97, h * 0.05], [r * 0.97, h * 0.35], [r * 0.79, h * 0.55], [r * 0.43, h * 0.68]];
  addFill(g, fillProf, t.fill ? { ...t.fill, steam: false } : undefined);
  ring(g, r * 0.3, r * 0.42, M("#222"), 0, h * 0.7, 0);
  tube(g, [v3(-r * 0.8, h * 0.3, 0), v3(-r * 1.1, h * 0.42, 0), v3(-r * 1.3, h * 0.6, 0)], r * 0.09, m, 12);
  cyl(g, r * 0.1, r * 0.1, r * 0.12, M("#222"), -r * 1.32, h * 0.6, 0, 12);
  tube(g, [v3(-r * 0.4, h * 0.66, 0), v3(-r * 0.35, h * 0.98, 0), v3(r * 0.35, h * 0.98, 0), v3(r * 0.4, h * 0.66, 0)], r * 0.07, M("#1a1a1a"), 24);
  if (t.fill?.steam) addSteam(g, -r * 1.35, h * 0.7, 0, r * 0.3);
}

function carafe(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w / 2.6, d / 2);
  const cx = -r * 0.2;
  const prof: P2[] = [[0, 0], [r * 0.9, 0], [r, h * 0.06], [r, h * 0.42], [r * 0.78, h * 0.6], [r * 0.64, h * 0.7], [r * 0.64, h * 0.95]];
  const glass = M(C.glass, { op: 0.28, ds: true, shiny: 110, dw: false });
  addFill(g, prof.slice(1).map(([pr, py]) => [pr * 0.95, Math.max(py, 0.004)] as P2), t.fill, cx, 0);
  lathe(g, prof, glass, 32).position.x = cx;
  g.children[g.children.length - 1]!.renderOrder = 1;
  const black = M("#1b1b1d", { shiny: 40 });
  cyl(g, r * 0.68, r * 0.68, h * 0.16, black, cx, h * 0.72, 0, 32, true);
  cyl(g, r * 0.66, r * 0.66, h * 0.05, black, cx, h * 0.95, 0, 32);
  boxUp(g, r * 0.18, h * 0.55, r * 0.3, black, cx + r * 1.15, h * 0.28, 0);
  box(g, r * 0.5, h * 0.08, r * 0.3, black, cx + r * 0.9, h * 0.8, 0);
  box(g, r * 0.45, h * 0.07, r * 0.3, black, cx + r * 0.95, h * 0.3, 0);
}

function frenchPress(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w / 2.7, d / 2);
  const cx = -r * 0.15;
  const metal = M(C.steel, { shiny: 100 });
  const gh = h * 0.78;
  const g0 = h * 0.05;
  addFill(g, [[r * 0.93, g0 + 0.004], [r * 0.95, g0 + gh]], t.fill, cx, 0);
  cyl(g, r, r, gh, M(C.glass, { op: 0.25, ds: true, shiny: 110, dw: false }), cx, g0, 0, 32, true).renderOrder = 1;
  cyl(g, r * 1.06, r * 1.06, g0, metal, cx, 0, 0, 32);
  cyl(g, r * 1.05, r * 1.05, h * 0.06, metal, cx, g0 + gh - h * 0.06, 0, 32, true);
  for (const a of [Math.PI / 2, -Math.PI / 2]) boxUp(g, 0.006, gh, 0.012, metal, cx + Math.sin(a) * r * 1.03, g0, Math.cos(a) * r * 1.03);
  const lidY = g0 + gh;
  cyl(g, r * 1.02, r * 1.04, h * 0.05, metal, cx, lidY, 0, 32);
  const black = M("#1b1b1d", { shiny: 40 });
  boxUp(g, r * 0.2, gh * 0.7, r * 0.35, black, cx + r * 1.32, g0 + gh * 0.12, 0);
  box(g, r * 0.4, h * 0.06, r * 0.3, black, cx + r * 1.15, g0 + gh * 0.82, 0);
  box(g, r * 0.4, h * 0.06, r * 0.3, black, cx + r * 1.15, g0 + gh * 0.14, 0);
  const rodLen = gh * 0.95;
  const discY = t.pressed ? g0 + 0.012 : lidY - h * 0.08;
  cyl(g, r * 0.92, r * 0.92, 0.006, M("#9aa0a6", { shiny: 60 }), cx, discY, 0, 32);
  cyl(g, 0.004, 0.004, rodLen, metal, cx, discY, 0, 8);
  sphere(g, Math.max(0.012, r * 0.18), black, cx, discY + rodLen + 0.008, 0, 12);
}

function mokaPot(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w / 2.8, d / 2);
  const cx = -r * 0.2;
  const alu = M("#b9bcc0", { shiny: 70, ds: true });
  const black = M("#1b1b1d", { shiny: 30 });
  cyl(g, r * 0.74, r, h * 0.42, alu, cx, 0, 0, 8);
  cyl(g, r * 0.74, r * 0.74, h * 0.05, M("#8d9196", { shiny: 60 }), cx, h * 0.42, 0, 8);
  // upper chamber: open octagonal cup so contents show from above
  cyl(g, r * 0.95, r * 0.74, h * 0.42, alu, cx, h * 0.47, 0, 8, true);
  disc(g, r * 0.74, M("#55585c"), cx, h * 0.49, 0, 8);
  addFill(g, [[r * 0.7, h * 0.49], [r * 0.9, h * 0.88]], t.fill ? { ...t.fill, steam: false } : undefined, cx, 0, 8);
  // central spout column
  cyl(g, r * 0.12, r * 0.14, h * 0.32, alu, cx, h * 0.49, 0, 8);
  // pouring lip
  const lip = boxUp(g, r * 0.35, h * 0.05, r * 0.2, alu, cx - r * 0.95, h * 0.84, 0);
  lip.rotation.z = 0.4;
  // lid hinged at the handle side, flipped open
  const lid = new THREE.Group();
  lid.position.set(cx + r * 0.95, h * 0.89, 0);
  lid.rotation.z = 1.75;
  g.add(lid);
  const lm = cyl(lid, r * 0.95, r * 0.9, h * 0.06, alu, -r * 0.95, 0, 0, 8);
  lm.rotation.y = Math.PI / 8;
  sphere(lid, r * 0.16, black, -r * 0.95, h * 0.08, 0, 10);
  // handle
  const hd = boxUp(g, r * 0.18, h * 0.42, r * 0.3, black, cx + r * 1.3, h * 0.5, 0);
  hd.rotation.z = -0.15;
  box(g, r * 0.4, r * 0.15, r * 0.28, black, cx + r * 1.05, h * 0.86, 0);
  // safety valve
  cyl(g, r * 0.08, r * 0.08, r * 0.1, M("#c9a24a", { shiny: 80 }), cx, h * 0.22, r * 0.86, 10).rotation.x = Math.PI / 2;
  if (t.fill?.steam) addSteam(g, cx - r, h * 0.95, 0, r * 0.35);
}

const BAG_COLORS = ["#6e3326", "#2d4a3a", "#2a3d5c", "#58395f", "#83542a", "#333336", "#7a6a2a"];

function pkg(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  // only the server's printed `label` goes on the package; unlabeled twins (sugar vs salt) must look identical
  const label = t.label;
  const key = label?.split(/\s+-\s+/)[0] ?? t.material;
  switch (t.material) {
    case "paper": {
      const empty = !t.fill || t.fill.level < 0.02;
      const bg = pick(BAG_COLORS, key);
      const bagM = M(bg, { shiny: 25 });
      const bodyH = h * 0.8;
      const inner = new THREE.Group();
      g.add(inner);
      if (empty) {
        inner.scale.set(1.04, 0.72, 0.55);
        inner.rotation.z = 0.06;
        inner.rotation.x = -0.12;
      }
      boxUp(inner, w, bodyH, d, bagM, 0, 0, 0);
      if (label) plane(inner, w * 0.9, bodyH * 0.86, M("#ffffff", { map: labelTex(label, bg, "#fff", (w * 0.9) / (bodyH * 0.86)) }), 0, bodyH * 0.5, d / 2 + 0.001);
      // folded, clipped top
      const tp = boxUp(inner, w, h - bodyH, d * 0.35, bagM, 0, bodyH, 0);
      tp.scale.z = d * (empty ? 0.6 : 0.35);
      box(inner, w * 1.02, 0.012, d * 0.4, M("#c9a64a", { shiny: 60 }), 0, bodyH + (h - bodyH) * 0.55, 0);
      return;
    }
    case "glass": {
      const r = Math.min(w, d) / 2;
      const shaker = /salt|pepper|shaker/i.test(`${label} ${t.name}`);
      const capH = shaker ? h * 0.22 : h * 0.14;
      const bodyH = h - capH;
      addFill(g, [[r * 0.88, 0.006], [r * 0.9, bodyH - 0.004]], t.fill ? { ...t.fill, steam: false } : undefined);
      const jar = cyl(g, r, r, bodyH, M(C.glass, { op: 0.28, ds: true, shiny: 110, dw: false }), 0, 0, 0, 32, true);
      jar.renderOrder = 1;
      disc(g, r, M(C.glass, { op: 0.4 }), 0, 0.001, 0);
      const capC = shaker ? C.steel : pick(["#b2302a", "#1f2a3a", "#e1b12c", "#2f5d3a"], key);
      if (shaker) {
        lathe(g, [[r * 1.01, bodyH - 0.01], [r * 1.01, bodyH + capH * 0.4], [r * 0.6, bodyH + capH * 0.9], [0, bodyH + capH]], M(capC, { shiny: 90 }), 24);
      } else cyl(g, r * 1.03, r * 1.03, capH, M(capC, { shiny: 40 }), 0, bodyH - 0.004, 0, 32);
      const bh = bodyH * (shaker ? 0.42 : 0.5);
      if (label) band(g, r * 1.005, bh, Math.PI * 0.9, M("#ffffff", { map: labelTex(label, "#f5efe1", "#222", (r * Math.PI * 0.9) / bh, false) }), 0, bodyH * 0.22, 0);
      return;
    }
    case "cardboard": {
      const swell = t.expired ? 1.035 : 1;
      const bodyH = h * 0.8;
      const milk = /milk/i.test(label ?? t.name);
      const bg = milk ? (/oat/i.test(label ?? "") ? "#d9c7a0" : "#2f65b0") : pick(["#e08a1e", "#3a7d44", "#a8322d", "#6b4aa0"], key);
      const cm = M(bg);
      const bodyG = new THREE.Group();
      bodyG.scale.set(swell, 1, swell);
      g.add(bodyG);
      boxUp(bodyG, w, bodyH, d, M("#f4f2ec"), 0, 0, 0);
      boxUp(bodyG, w * 1.002, bodyH * 0.18, d * 1.002, cm, 0, 0, 0);
      if (label) plane(bodyG, w * 0.94, bodyH * 0.74, M("#ffffff", { map: labelTex(label, bg, "#fff", (w * 0.94) / (bodyH * 0.74)) }), 0, bodyH * 0.56, d / 2 + 0.002);
      // gable top
      const rh = h - bodyH - 0.012;
      const slant = Math.hypot(d / 2, rh);
      const ang = Math.atan2(rh, d / 2);
      for (const sz of [1, -1]) {
        const p = box(g, w, 0.003, slant, cm, 0, bodyH + rh / 2, (sz * d) / 4);
        p.rotation.x = sz * ang;
      }
      const tri = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rh)]);
      for (const sx of [1, -1]) {
        const s = mesh(new THREE.ShapeGeometry(tri), M("#f4f2ec", { ds: true }), g);
        s.rotation.y = Math.PI / 2;
        s.position.set((sx * w) / 2, bodyH, 0);
      }
      boxUp(g, w, 0.012, 0.006, M("#f4f2ec"), 0, bodyH + rh, 0);
      cyl(g, 0.012, 0.012, 0.01, M("#2f65b0"), w * 0.2, bodyH + rh * 0.45, d * 0.15, 12).rotation.x = ang;
      return;
    }
    default: {
      // canister (ceramic), tin (metal) or tub (plastic)
      const r = Math.min(w, d) / 2;
      const ceramic = t.material === "ceramic";
      const metal = t.material === "metal";
      const bodyC = ceramic ? "#f2efe7" : metal ? pick(["#2b4f6e", "#7a2b2b", "#2f5a3a", "#b08a3a"], key) : "#e8e8e2";
      const bodyH = h * 0.84;
      cyl(g, r, r, bodyH, M(bodyC, { shiny: ceramic ? 60 : metal ? 80 : 20 }), 0, 0, 0, 32);
      const lidC = ceramic ? "#c9b48a" : metal ? C.steel : "#3a7ab0";
      cyl(g, r * 1.02, r * 1.02, h - bodyH, M(lidC, { shiny: 40 }), 0, bodyH, 0, 32);
      if (ceramic) sphere(g, r * 0.18, M(lidC), 0, h + r * 0.06, 0, 12);
      const bh = bodyH * 0.55;
      const arc = Math.PI * 0.85;
      const ink = ceramic ? "#1d3f7a" : "#fff";
      if (label) band(g, r * 1.004, bh, arc, M("#ffffff", { map: labelTex(label, ceramic ? "#f2efe7" : bodyC, ink, (r * arc) / bh, !ceramic) }), 0, bodyH * 0.2, 0);
    }
  }
}

function filterBox(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const cm = M(C.cardboard);
  const inner = M("#a98352", { back: true });
  const s = 0.004;
  boxUp(g, w, 0.01, d, cm, 0, 0, 0);
  boxUp(g, s, h, d, cm, -w / 2, 0, 0);
  boxUp(g, s, h, d, cm, w / 2, 0, 0);
  boxUp(g, w, h, s, cm, 0, 0, -d / 2);
  boxUp(g, w, h, s, cm, 0, 0, d / 2);
  boxUp(g, w - 0.01, h - 0.005, d - 0.01, inner, 0, 0.004, 0);
  plane(g, w * 0.96, h * 0.9, M("#ffffff", { map: labelTex(t.label ?? t.name, "#c97f2a", "#fff", (w * 0.96) / (h * 0.9)) }), 0, h / 2, d / 2 + s / 2 + 0.001);
  // flap folded back
  const flap = boxUp(g, w, h * 0.5, s, cm, 0, h, -d / 2);
  flap.rotation.x = -0.3;
}

function paperFilter(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const r = Math.min(w, d) / 2;
  cyl(g, r, r * 0.45, h, M("#f7f3ea", { ds: true }), 0, 0, 0, 20, true);
  ring(g, r * 0.88, r, M("#ece6d6", { ds: true }), 0, h, 0, 20);
  disc(g, r * 0.45, M("#f1ece0"), 0, 0.001, 0, 16);
}

function note(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const text = t.text ?? t.label ?? "";
  const vertical = h > Math.max(w, d) * 0.6;
  if (vertical) {
    const nw = w * 0.96;
    const nh = h * 0.96;
    plane(g, nw, nh, M("#ffffff", { map: noteTex(text, nw / nh) }), 0, h / 2, d / 2 + 0.001);
    boxUp(g, nw, nh, 0.001, M(C.paper), 0, h * 0.02, d / 2 - 0.0005);
    return;
  }
  const nw = w * 0.96;
  const nd = d * 0.96;
  const p = plane(g, nw, nd, M("#ffffff", { map: noteTex(text, nw / nd) }), 0, 0.0025, 0);
  p.rotation.x = -Math.PI / 2;
  p.rotation.z = 0.03;
  const under = plane(g, nw, nd, M("#e8e2d0"), 0, 0.0015, 0);
  under.rotation.x = Math.PI / 2;
}

// ---- misc clutter ----------------------------------------------------------------------------------

function misc(t: Thing, F: Frame): void {
  const { g, w, h, d } = F;
  const n = t.name.toLowerCase();
  const r = Math.min(w, d) / 2;
  const key = t.id + n;
  if (/plate|china/.test(n)) {
    const k = 6;
    for (let i = 0; i < k; i++) {
      cyl(g, r * 0.98, r * 0.8, h / k - 0.002, M(i % 2 ? "#f3f1ec" : "#e9e6de", { shiny: 60 }), 0, (i * h) / k, 0, 32);
      ring(g, r * 0.7, r * 0.75, M("#c9c3b4"), 0, ((i + 1) * h) / k - 0.001, 0);
    }
    return;
  }
  if (/fruit bowl/.test(n)) {
    lathe(g, [[0, 0], [r * 0.5, 0], [r * 0.9, h * 0.35], [r, h * 0.5], [r * 0.95, h * 0.5], [r * 0.85, h * 0.36], [r * 0.45, h * 0.04], [0, h * 0.04]], M("#e9e3d6", { shiny: 50, ds: true }));
    for (let i = 0; i < 4; i++) sphere(g, r * 0.3, M(i % 2 ? "#b8322a" : "#8fae3a", { shiny: 50 }), Math.sin(i * 1.6) * r * 0.42, h * 0.38 + (i === 3 ? r * 0.3 : 0), Math.cos(i * 1.6) * r * 0.42, 12);
    return;
  }
  if (/bowl|colander|casserole/.test(n)) {
    const k = /bowls/.test(n) ? 3 : 1;
    const col = /colander/.test(n) ? C.steel : /casserole/.test(n) ? "#d06b3a" : pick(["#f1ede4", "#6b8fb5", "#d9c39a"], key);
    for (let i = 0; i < k; i++) {
      const y = (i * h) / (k + 1);
      const bh = h - y;
      lathe(g, [[0, y], [r * 0.5, y], [r * 0.95, y + bh * 0.85], [r, y + bh], [r * 0.93, y + bh], [r * 0.45, y + 0.006], [0, y + 0.006]], M(col, { shiny: 60, ds: true }));
    }
    return;
  }
  if (/glasses/.test(n)) {
    const gm = M(C.glass, { op: 0.3, ds: true, shiny: 110, dw: false });
    const gr = r * 0.42;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const x = sx * r * 0.5;
      const z = sz * r * 0.5;
      if (/wine/.test(n)) {
        cyl(g, gr * 0.7, gr * 0.7, 0.003, gm, x, 0, z, 16);
        cyl(g, 0.003, 0.003, h * 0.45, gm, x, 0, z, 6);
        lathe(g, [[0, h * 0.45], [gr, h * 0.62], [gr * 0.85, h]], gm, 16).position.set(x, 0, z);
      } else cyl(g, gr, gr * 0.85, h, gm, x, 0, z, 16, true).renderOrder = 1;
    }
    return;
  }
  if (/can|tinned|tomato|soup|beans|paint/.test(n)) {
    const k = /cans|beans|tomatoes/.test(n) && w > r * 2.4 ? 2 : 1;
    const cr = Math.min(r, w / (2 * k));
    const bg = /paint/.test(n) ? "#e6e1d6" : pick(["#b8322a", "#2d6a3a", "#c47a1e", "#2a4a7a"], key);
    for (let i = 0; i < k; i++) {
      const x = k === 1 ? 0 : (i - 0.5) * cr * 2.05;
      cyl(g, cr, cr, h, M(C.steel, { shiny: 80 }), x, 0, 0, 24);
      band(g, cr * 1.005, h * 0.8, Math.PI * 2, M("#ffffff", { map: printedTex(t.name, bg, 2.2) }), x, h * 0.1, 0);
    }
    return;
  }
  if (/jar|jam|honey|peanut/.test(n)) {
    const fillC = /honey/.test(n) ? "#d8941c" : /peanut/.test(n) ? "#b07a3c" : "#8a1f2c";
    const bodyH = h * 0.84;
    cyl(g, r * 0.88, r * 0.88, bodyH * 0.82, M(fillC, { shiny: 60 }), 0, 0.004, 0, 24);
    cyl(g, r, r, bodyH, M(C.glass, { op: 0.3, ds: true, shiny: 110, dw: false }), 0, 0, 0, 24, true).renderOrder = 1;
    cyl(g, r * 1.02, r * 1.02, h - bodyH, M(pick(["#d4a42c", "#b8322a", "#2a2a2a"], key), { shiny: 60 }), 0, bodyH, 0, 24);
    band(g, r * 1.01, bodyH * 0.45, Math.PI * 0.9, M("#ffffff", { map: labelTex(n.replace(/\b(jar|of)\b/g, "").trim().toUpperCase(), "#f5efe1", "#222", 1.2, false) }), 0, bodyH * 0.25, 0);
    return;
  }
  if (/bottle|oil|ketchup|water|spray|soap|detergent|toothpaste|aspirin|juice/.test(n)) {
    const col = /oil/.test(n) ? "#9aa236" : /ketchup/.test(n) ? "#b8221a" : /water/.test(n) ? "#a8d4ef" : pick(["#3a8fd0", "#e2e2e2", "#5bbf6a", "#f0a030"], key);
    const k = /bottled water/.test(n) ? 2 : 1;
    const br = Math.min(r, w / (2 * k)) * 0.9;
    for (let i = 0; i < k; i++) {
      const x = k === 1 ? 0 : (i - 0.5) * br * 2.1;
      const pts: P2[] = [[0, 0], [br, 0], [br, h * 0.62], [br * 0.4, h * 0.8], [br * 0.36, h * 0.9], [0, h * 0.9]];
      lathe(g, pts, M(col, { shiny: 80, op: /water|oil/.test(n) ? 0.75 : 1 }), 20).position.x = x;
      cyl(g, br * 0.4, br * 0.4, h * 0.1, M(/oil/.test(n) ? "#d4b23a" : "#f2f2f2"), x, h * 0.9, 0, 12);
      band(g, br * 1.01, h * 0.35, Math.PI, M("#ffffff", { map: printedTex(t.name, shade(col, -0.2), 1.4) }), x, h * 0.15, 0);
    }
    return;
  }
  if (/book|novel|magazine|menu|mail/.test(n)) {
    const k = /row of books/.test(n) ? 0 : /magazines|menus|mail/.test(n) ? 4 : 1;
    if (k === 0) {
      const nb = Math.max(3, Math.round(w / 0.035));
      for (let i = 0; i < nb; i++) {
        const bh = h * (0.75 + ((hash(key + i) % 25) / 100));
        boxUp(g, w / nb - 0.002, bh, d * 0.9, M(pick(["#7a2b2b", "#2b4f6e", "#2f5a3a", "#b08a3a", "#4a3a5a", "#d8d0c0"], key + i)), -w / 2 + (w / nb) * (i + 0.5), 0, 0);
      }
      return;
    }
    const sh = h / k;
    for (let i = 0; i < k; i++) {
      const b = boxUp(g, w * 0.96, sh - 0.001, d * 0.96, M(i === k - 1 ? "#ffffff" : pick(["#f2f2f2", "#d8e2ec", "#f0e0c8"], key + i)), 0, i * sh, 0);
      b.rotation.y = (i - k / 2) * 0.08;
    }
    const cover = plane(g, w * 0.92, d * 0.92, M("#ffffff", { map: printedTex(t.label ?? t.name, pick(["#7a2b2b", "#2b4f6e", "#2f5a3a"], key), w / d) }), 0, h + 0.001, 0);
    cover.rotation.x = -Math.PI / 2;
    cover.rotation.z = ((k - 1) / 2) * 0.08;
    return;
  }
  if (/towel|cloth|cushion|laundry|placemat|tablecloth|shoes|umbrella|blanket/.test(n)) {
    const col = pick(["#c95a4a", "#4a7ab0", "#e0c060", "#6a9a6a", "#eeeeee"], key);
    if (/cushion/.test(n)) {
      const c = sphere(g, 1, M(col), 0, h / 2, 0, 16);
      c.scale.set(w / 2, h / 2, d / 2);
      return;
    }
    const k = Math.max(2, Math.round(h / 0.02));
    for (let i = 0; i < k; i++) boxUp(g, w * (0.94 + (i % 2) * 0.04), h / k - 0.001, d * 0.94, M(i % 2 ? col : shade(col, -0.06)), 0, (i * h) / k, 0);
    return;
  }
  if (/spice rack/.test(n)) {
    boxUp(g, w, h * 0.1, d, M(C.wood), 0, 0, 0);
    boxUp(g, w, h, 0.01, M(C.wood), 0, 0, -d / 2 + 0.005);
    const k = Math.max(3, Math.round(w / 0.05));
    for (let i = 0; i < k; i++) {
      const x = -w / 2 + (w / k) * (i + 0.5);
      cyl(g, w / k / 2.3, w / k / 2.3, h * 0.6, M(C.glass, { op: 0.6, shiny: 90 }), x, h * 0.1, 0, 12);
      cyl(g, w / k / 2.3, w / k / 2.3, h * 0.6 * 0.7, M(pick(["#b8322a", "#c47a1e", "#6a8a3a", "#8a5a2a"], key + i)), x, h * 0.1, 0, 12);
      cyl(g, w / k / 2.2, w / k / 2.2, h * 0.12, M("#222"), x, h * 0.7, 0, 12);
    }
    return;
  }
  if (/pan|tray|baking/.test(n) && !/cutlery/.test(n)) {
    const steel = M("#4a4a4e", { shiny: 60, ds: true });
    if (/frying|sauce/.test(n)) {
      const pr = Math.min(r, w / 2.6);
      lathe(g, [[0, 0], [pr * 0.9, 0], [pr, h * 0.9], [pr * 0.96, h * 0.9], [pr * 0.86, 0.006], [0, 0.006]], steel, 28).position.x = -w / 2 + pr;
      const hx = -w / 2 + pr * 2;
      box(g, w - pr * 2, 0.015, 0.025, M("#1a1a1a"), hx + (w - pr * 2) / 2, h * 0.7, 0);
      return;
    }
    boxUp(g, w, 0.005, d, steel, 0, 0, 0);
    for (const sx of [-1, 1]) boxUp(g, 0.005, h, d, steel, (sx * w) / 2, 0, 0);
    for (const sz of [-1, 1]) boxUp(g, w, h, 0.005, steel, 0, 0, (sz * d) / 2);
    return;
  }
  if (/cutlery|utensil/.test(n)) {
    boxUp(g, w, h * 0.2, d, M("#e8e8e2"), 0, 0, 0);
    for (let i = 0; i < 4; i++) boxUp(g, 0.004, h, d, M("#e8e8e2"), -w / 2 + (w * i) / 3, 0, 0);
    for (let i = 0; i < 9; i++) boxUp(g, 0.008, 0.006, d * 0.85, M(C.steel, { shiny: 90 }), -w / 2 + (w * (i + 0.5)) / 9, h * 0.2, 0);
    return;
  }
  if (/egg/.test(n)) {
    const base = M("#cfc6b4");
    boxUp(g, w, h * 0.5, d, base, 0, 0, 0);
    boxUp(g, w, h * 0.12, d, base, 0, h * 0.5, 0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const b = sphere(g, 1, base, -w / 3 + (i * w) / 3, h * 0.62, -d / 4 + (j * d) / 2, 10);
      b.scale.set(w / 7, h * 0.3, d / 5);
    }
    return;
  }
  if (/butter|cheese/.test(n)) {
    const butter = n.includes("butter");
    const bh = h * 0.45;
    boxUp(g, w, bh, d * 0.8, M(butter ? "#f3d877" : "#f0c13a", { shiny: butter ? 10 : 30 }), 0, 0, 0);
    if (butter) plane(g, w * 0.96, bh * 0.9, M("#ffffff", { map: printedTex("BUTTER", "#c8962a", w / bh) }), 0, bh / 2, d * 0.4 + 0.001);
    return;
  }
  if (/lasagna|leftover/.test(n)) {
    const dh = h * 0.45;
    boxUp(g, w * 0.9, dh * 0.45, d * 0.9, M("#d9a441"), 0, 0.004, 0);
    boxUp(g, w * 0.9, dh * 0.2, d * 0.9, M("#b8432a"), 0, 0.004 + dh * 0.45, 0);
    boxUp(g, w * 0.9, dh * 0.15, d * 0.9, M("#f2d27a"), 0, 0.004 + dh * 0.65, 0);
    boxUp(g, w, dh, d, M(C.glass, { op: 0.3, shiny: 110, dw: false }), 0, 0, 0).renderOrder = 1;
    boxUp(g, w * 1.02, 0.006, d * 1.02, M("#d8dde2", { shiny: 90 }), 0, dh, 0);
    return;
  }
  if (/bag of|chips|peas|rice|flour|pasta|dog food|oats/.test(n)) {
    const bg = /flour/.test(n) ? "#efe7d6" : pick(["#c0392b", "#d68910", "#1f618d", "#117a65", "#7d3c98"], key);
    const bh = h * 0.86;
    const body = boxUp(g, w, bh, d * 0.75, M(bg, { shiny: 30 }), 0, 0, 0);
    body.scale.z = d * 0.75;
    boxUp(g, w * 1.02, h - bh, d * 0.2, M(shade(bg, -0.1)), 0, bh, 0);
    plane(g, w * 0.9, bh * 0.8, M("#ffffff", { map: printedTex(t.name, /flour/.test(n) ? "#7a5a2a" : bg, (w * 0.9) / (bh * 0.8)) }), 0, bh / 2, d * 0.375 + 0.001);
    return;
  }
  if (/spatula|spoon|scissors|keys|whisk|ladle|knife|clothespin/.test(n)) {
    const k = /spoons|clothespins|keys/.test(n) ? 3 : 1;
    const len = Math.max(w, d) * 0.95;
    const col = /wooden|clothespin/.test(n) ? C.wood : /scissors|keys|measuring/.test(n) ? C.steel : "#2a2a2c";
    for (let i = 0; i < k; i++) {
      const s = new THREE.Group();
      s.position.set((i - (k - 1) / 2) * Math.min(w, d) * 0.3, 0.006 + i * 0.004, 0);
      s.rotation.y = (w > d ? 0 : Math.PI / 2) + (i - 1) * 0.15;
      g.add(s);
      box(s, len * 0.6, 0.008, 0.016, M(col, { shiny: 60 }), -len * 0.2, 0, 0);
      box(s, len * 0.35, 0.01, /spatula/.test(n) ? 0.06 : 0.03, M(/scissors/.test(n) ? "#c0392b" : col, { shiny: 60 }), len * 0.3, 0, 0);
    }
    return;
  }
  if (/remote/.test(n)) {
    boxUp(g, Math.min(w, d) * 0.4, 0.02, Math.max(w, d) * 0.9, M("#1c1c1e", { shiny: 50 }), 0, 0, 0);
    sphere(g, 0.006, M("#c0392b"), 0, 0.022, Math.max(w, d) * 0.3, 8);
    return;
  }
  if (/candle/.test(n)) {
    for (let i = 0; i < 3; i++) cyl(g, r * 0.22, r * 0.22, h * (0.6 + i * 0.15), M("#f3ead2"), (i - 1) * r * 0.55, 0, 0, 12);
    return;
  }
  if (/umbrella/.test(n)) {
    cyl(g, r * 0.12, r * 0.45, h * 0.8, M("#2b3e5c"), 0, h * 0.05, 0, 8);
    cyl(g, 0.006, 0.006, h * 0.2, M("#555"), 0, h * 0.8, 0, 6);
    return;
  }
  if (/toolbox/.test(n)) {
    boxUp(g, w, h * 0.75, d, M("#b8322a", { shiny: 40 }), 0, 0, 0);
    boxUp(g, w * 0.5, 0.015, 0.02, M("#222"), 0, h * 0.92, 0);
    for (const sx of [-1, 1]) boxUp(g, 0.015, h * 0.17, 0.02, M("#222"), (sx * w) / 4, h * 0.75, 0);
    return;
  }
  if (/extension cord/.test(n)) {
    const tor = mesh(sgeo("coil", () => new THREE.TorusGeometry(1, 0.12, 8, 24)), M("#e07a1e"), g);
    tor.scale.setScalar(r * 0.8);
    tor.rotation.x = Math.PI / 2;
    tor.position.y = r * 0.1;
    return;
  }
  // default: a printed box/package with its name on it
  const bg = pick(["#c0392b", "#d68910", "#1f618d", "#117a65", "#7d3c98", "#a04000", "#2e4053"], key);
  boxUp(g, w, h, d, M(shade(bg, -0.05)), 0, 0, 0);
  plane(g, w * 0.98, h * 0.98, M("#ffffff", { map: printedTex(t.label ?? t.name, bg, w / h) }), 0, h / 2, d / 2 + 0.001);
}

// ---------------------------------------------------------------------------------------------------
// Dispatcher

function buildThing(t: Thing, ctx: Ctx): THREE.Group {
  const F = frameOf(t);
  switch (t.kind) {
    case "cabinet":
      cabinet(t, F, ctx);
      break;
    case "drawer":
      drawer(t, F);
      break;
    case "fridge":
      fridge(t, F, ctx);
      break;
    case "shelf":
      shelf(t, F, ctx);
      break;
    case "surface":
      surface(t, F, ctx);
      break;
    case "sink":
      sink(t, F, ctx);
      break;
    case "stove":
      stove(t, F, ctx);
      break;
    case "dishwasher":
      dishwasher(t, F, ctx);
      break;
    case "decor":
      decor(t, F);
      break;
    case "coffee_maker":
      coffeeMaker(t, F, ctx);
      break;
    case "grinder":
      grinder(t, F, ctx);
      break;
    case "kettle_base":
      kettleBase(t, F, ctx);
      break;
    case "microwave":
      microwave(t, F, ctx);
      break;
    case "mug":
      mug(t, F);
      break;
    case "kettle":
      kettle(t, F);
      break;
    case "stovetop_kettle":
      stovetopKettle(t, F);
      break;
    case "carafe":
      carafe(t, F);
      break;
    case "french_press":
      frenchPress(t, F);
      break;
    case "moka_pot":
      mokaPot(t, F);
      break;
    case "package":
      pkg(t, F);
      break;
    case "box":
      filterBox(t, F);
      break;
    case "filter":
      paperFilter(t, F);
      break;
    case "note":
      note(t, F);
      break;
    case "misc":
      misc(t, F);
      break;
  }
  F.g.userData.thingId = t.id;
  return F.g;
}

// ---------------------------------------------------------------------------------------------------
// Rooms

function buildRoom(scene: THREE.Scene, room: SnapRoom, doors: SnapDoor[], mode: SceneMode): void {
  const rg = new THREE.Group();
  rg.name = `room:${room.id}`;
  scene.add(rg);
  const w = room.x1 - room.x0;
  const d = room.z1 - room.z0;
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  const fgeo = new THREE.PlaneGeometry(w, d);
  const uv = fgeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
  const floor = mesh(fgeo, M(room.floor, { map: floorTex() }), rg);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  if (mode === "agent") {
    const ceil = mesh(sgeo("plane", () => new THREE.PlaneGeometry(1, 1)), M("#f3efe8", { e: "#6a655e" }), rg);
    ceil.scale.set(w, d, 1);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, WALL_HEIGHT, cz);
    const lamp = disc(rg, 0.18, M("#fff8e8", { basic: true }), cx, WALL_HEIGHT - 0.01, cz);
    lamp.rotation.x = Math.PI;
  }
  const wallM = M(room.wall);
  const skirtM = M(shade(room.wall, -0.25));
  const trimM = M("#f4f1ea");
  const edges: { axis: "x" | "z"; fixed: number; a: number; b: number; nx: number; nz: number }[] = [
    { axis: "x", fixed: room.z0, a: room.x0, b: room.x1, nx: 0, nz: 1 },
    { axis: "x", fixed: room.z1, a: room.x0, b: room.x1, nx: 0, nz: -1 },
    { axis: "z", fixed: room.x0, a: room.z0, b: room.z1, nx: 1, nz: 0 },
    { axis: "z", fixed: room.x1, a: room.z0, b: room.z1, nx: -1, nz: 0 },
  ];
  for (const e of edges) {
    const wg = new THREE.Group();
    wg.userData.cutaway = {
      outward: v3(-e.nx, 0, -e.nz),
      point: e.axis === "x" ? v3((e.a + e.b) / 2, 0, e.fixed) : v3(e.fixed, 0, (e.a + e.b) / 2),
    };
    rg.add(wg);
    const gaps = doors
      .filter((dr) => dr.axis === e.axis && Math.abs((e.axis === "x" ? dr.z : dr.x) - e.fixed) < 0.25)
      .map((dr) => {
        const c = e.axis === "x" ? dr.x : dr.z;
        return [c - dr.width / 2, c + dr.width / 2] as [number, number];
      })
      .filter(([s0, s1]) => s1 > e.a && s0 < e.b)
      .sort((p, q) => p[0] - q[0]);
    const off = WALL_T / 2;
    const place = (s0: number, s1: number, y0: number, y1: number, m: THREE.Material, t = WALL_T, inset = off) => {
      const len = s1 - s0;
      if (len <= 0.001 || y1 <= y0) return;
      const mid = (s0 + s1) / 2;
      if (e.axis === "x") boxUp(wg, len, y1 - y0, t, m, mid, y0, e.fixed + e.nz * inset);
      else boxUp(wg, t, y1 - y0, len, m, e.fixed + e.nx * inset, y0, mid);
    };
    let s = e.a;
    for (const [g0, g1] of gaps) {
      place(s, g0, 0, WALL_HEIGHT, wallM);
      place(s, g0, 0, 0.08, skirtM, 0.012, WALL_T + 0.006);
      place(Math.max(g0, e.a), Math.min(g1, e.b), DOOR_HEIGHT, WALL_HEIGHT, wallM);
      // door casing
      place(g0 - 0.06, g0, 0, DOOR_HEIGHT + 0.06, trimM, 0.015, WALL_T + 0.0075);
      place(g1, g1 + 0.06, 0, DOOR_HEIGHT + 0.06, trimM, 0.015, WALL_T + 0.0075);
      place(g0 - 0.06, g1 + 0.06, DOOR_HEIGHT, DOOR_HEIGHT + 0.06, trimM, 0.015, WALL_T + 0.0075);
      s = g1;
    }
    place(s, e.b, 0, WALL_HEIGHT, wallM);
    place(s, e.b, 0, 0.08, skirtM, 0.012, WALL_T + 0.006);
  }
}

// ---------------------------------------------------------------------------------------------------
// Cameras, held items, avatar

/** The camera the server's geometry maths assumes: agent eyes, or the close-up examine camera. */
export function makeCamera(snap: Snapshot): THREE.PerspectiveCamera {
  let cam: THREE.PerspectiveCamera;
  if (snap.camera) {
    const { eye, target, fovY } = snap.camera;
    cam = new THREE.PerspectiveCamera(fovY, VIEW_W / VIEW_H, 0.01, 60);
    cam.position.set(eye[0], eye[1], eye[2]);
    const dir = v3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]).normalize();
    // looking straight down/up: keep the agent's forward as screen-up
    if (Math.abs(dir.y) > 0.999) cam.up.set(Math.sin(snap.agent.yaw), 0, -Math.cos(snap.agent.yaw));
    cam.lookAt(target[0], target[1], target[2]);
  } else {
    cam = new THREE.PerspectiveCamera(FOV_Y, VIEW_W / VIEW_H, 0.05, 60);
    cam.rotation.order = "YXZ";
    cam.position.set(snap.agent.x, EYE_HEIGHT, snap.agent.z);
    cam.rotation.y = -snap.agent.yaw;
    cam.rotation.x = snap.agent.pitch;
  }
  cam.updateMatrixWorld(true);
  return cam;
}

function heldModel(t: Thing, ctx: Ctx): THREE.Group {
  const [w, h, d] = heldSize(t);
  const fake: Thing = { ...t, min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2], facing: [0, 1] };
  const g = buildThing(fake, ctx);
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  return g;
}

/** First-person held items in a separate overlay scene (rendered after a depth clear, so they never clip into walls). */
function buildHeld(snap: Snapshot, ctx: Ctx, cam: THREE.PerspectiveCamera): THREE.Scene {
  const hs = new THREE.Scene();
  hs.add(new THREE.HemisphereLight(0xfff6e8, 0x40342c, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2);
  dl.position.set(0.5, 1, 0.6);
  hs.add(dl);
  const rig = new THREE.Group();
  rig.position.copy(cam.position);
  rig.quaternion.copy(cam.quaternion);
  hs.add(rig);
  const skin = M(C.skin);
  const sleeve = M(C.sleeve);
  snap.hands.forEach((id, i) => {
    if (!id) return;
    const t = ctx.byId.get(id);
    if (!t) return;
    const side = i === 0 ? 1 : -1;
    const [, h] = heldSize(t);
    const item = heldModel(t, ctx);
    const holder = new THREE.Group();
    holder.position.set(side * HELD_POSE.x, HELD_POSE.y, HELD_POSE.z);
    holder.rotation.set(HELD_POSE.pitch, -side * HELD_POSE.yaw, 0);
    holder.add(item);
    item.position.y = -h * HELD_POSE.drop;
    rig.add(holder);
    // hand under the item, forearm running out of frame
    const palm = new THREE.Group();
    palm.position.set(side * 0.25, -0.27 - h * 0.35 - 0.025, -0.55);
    palm.rotation.set(0.32, -side * 0.18, 0);
    rig.add(palm);
    const p = box(palm, 0.09, 0.035, 0.1, skin, 0, 0, 0);
    p.rotation.z = side * 0.1;
    for (let f = 0; f < 4; f++) box(palm, 0.018, 0.05, 0.02, skin, -0.033 + f * 0.022, 0.03, 0.06);
    box(palm, 0.022, 0.05, 0.022, skin, -side * 0.055, 0.035, 0.0);
    const a = v3(side * 0.25, -0.3 - h * 0.35, -0.5);
    const b = v3(side * 0.42, -0.62, -0.18);
    limb(rig, a, b, 0.045, sleeve);
    limb(rig, a.clone().lerp(b, -0.08), a.clone().lerp(b, 0.12), 0.038, skin);
  });
  return hs;
}

function addAvatar(scene: THREE.Scene, snap: Snapshot, ctx: Ctx): void {
  const av = new THREE.Group();
  av.name = "avatar";
  av.position.set(snap.agent.x, 0, snap.agent.z);
  scene.add(av);
  const body = mesh(sgeo("capsule", () => new THREE.CapsuleGeometry(0.17, 0.95, 6, 16)), M("#e0a458", { shiny: 40 }), av);
  body.position.y = 0.17 + 0.95 / 2 + 0.02;
  const head = new THREE.Group();
  head.position.y = EYE_HEIGHT;
  head.rotation.order = "YXZ";
  head.rotation.y = -snap.agent.yaw;
  head.rotation.x = snap.agent.pitch;
  av.add(head);
  sphere(head, 0.13, M("#f1d6b8", { shiny: 30 }), 0, 0.02, 0.04, 20);
  box(head, 0.2, 0.05, 0.06, M("#1a1a1a", { shiny: 90 }), 0, 0.02, -0.09);
  const coneLen = 1.6;
  const coneR = coneLen * Math.tan((FOV_Y / 2) * DEG);
  const cone = mesh(
    sgeo("viewcone", () => new THREE.ConeGeometry(1, 1, 4, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2).rotateZ(Math.PI / 4)),
    M("#ffd27a", { op: 0.16, ds: true, dw: false }),
    head,
  );
  cone.scale.set(coneR * (VIEW_W / VIEW_H) * Math.SQRT1_2 * 1.414, coneR * 1.414, coneLen);
  cone.renderOrder = 5;
  const ray = limb(head, v3(0, 0, 0), v3(0, 0, -coneLen), 0.006, M("#ffd27a", { basic: true }));
  ray.renderOrder = 5;
  // held items float beside the avatar
  snap.hands.forEach((id, i) => {
    if (!id) return;
    const t = ctx.byId.get(id);
    if (!t) return;
    const item = heldModel(t, ctx);
    const side = i === 0 ? 1 : -1;
    const holder = new THREE.Group();
    holder.rotation.y = -snap.agent.yaw;
    holder.position.y = 1.0;
    av.add(holder);
    item.position.set(side * 0.3, 0, -0.15);
    holder.add(item);
  });
}

// ---------------------------------------------------------------------------------------------------
// Entry points

/** Things that live in someone's hands (directly or nested inside a held thing). */
function heldSet(snap: Snapshot, byId: Map<string, Thing>): Set<string> {
  const out = new Set<string>();
  for (const t of snap.things) {
    let cur: Thing | undefined = t;
    for (let i = 0; cur && i < 12; i++) {
      if (cur.parent === "hands" || snap.hands.includes(cur.id)) {
        out.add(t.id);
        break;
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return out;
}

function roomOf(snap: Snapshot, x: number, z: number): SnapRoom | undefined {
  return snap.rooms.find((r) => x >= r.x0 - 0.05 && x <= r.x1 + 0.05 && z >= r.z0 - 0.05 && z <= r.z1 + 0.05);
}

/**
 * Build the scene. Agent mode: `scene.userData.camera` is the frame camera and, when the agent holds
 * something (and no examine camera is set), `scene.userData.held` is an overlay scene to render after
 * clearing depth. Spectator mode: walls carry `userData.cutaway = { outward, point }` and the avatar
 * group is named "avatar".
 */
export function buildScene(snap: Snapshot, mode: SceneMode): THREE.Scene {
  trimCaches();
  const things = snap.things as Thing[];
  const byId = new Map(things.map((t) => [t.id, t]));
  const kids = new Map<string, Thing[]>();
  for (const t of things) {
    if (!t.parent || t.parent === "hands") continue;
    let arr = kids.get(t.parent);
    if (!arr) kids.set(t.parent, (arr = []));
    arr.push(t);
  }
  const ctx: Ctx = { snap, mode, byId, kids, rooms: new Map(snap.rooms.map((r) => [r.id, r])) };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(mode === "agent" ? "#0e0c0b" : "#17120f");

  scene.add(new THREE.HemisphereLight(0xfff4e4, 0x7a6a5c, mode === "agent" ? 1.3 : 1.6));
  const sun = new THREE.DirectionalLight(0xfff2dd, 0.7);
  sun.position.set(3, 8, 5);
  scene.add(sun);
  // point lights: every room for the spectator, the camera's room and its door neighbours for the agent
  const cam = mode === "agent" ? makeCamera(snap) : null;
  let lit = snap.rooms;
  if (cam) {
    const here = roomOf(snap, cam.position.x, cam.position.z);
    if (here) {
      const near = new Set([here.id]);
      for (const dr of snap.doors) if (dr.rooms.includes(here.id)) dr.rooms.forEach((r) => near.add(r));
      lit = snap.rooms.filter((r) => near.has(r.id));
    }
  }
  for (const r of lit) {
    const area = (r.x1 - r.x0) * (r.z1 - r.z0);
    const pl = new THREE.PointLight(0xfff0dc, 3 + area * 0.35, 0, 1.6);
    pl.position.set((r.x0 + r.x1) / 2, WALL_HEIGHT - 0.3, (r.z0 + r.z1) / 2);
    scene.add(pl);
  }

  for (const r of snap.rooms) buildRoom(scene, r, snap.doors, mode);
  const held = heldSet(snap, byId);
  const columns = new Map<string, Thing[]>();
  for (const t of things) {
    if (t.kind === "drawer" && !t.parent) {
      // drawers sharing a closed footprint form one column
      const dx = t.open ? t.facing[0] * DRAWER_TRAVEL : 0;
      const dz = t.open ? t.facing[1] * DRAWER_TRAVEL : 0;
      const key = `${(t.min[0] - dx).toFixed(2)},${(t.min[2] - dz).toFixed(2)}`;
      let col = columns.get(key);
      if (!col) columns.set(key, (col = []));
      col.push(t);
    }
    if (t.hidden || held.has(t.id)) continue;
    scene.add(buildThing(t, ctx));
  }
  for (const col of columns.values()) scene.add(drawerColumn(col));

  if (cam) {
    scene.userData.camera = cam;
    if (!snap.camera && snap.hands.some(Boolean)) scene.userData.held = buildHeld(snap, ctx, cam);
  } else addAvatar(scene, snap, ctx);
  return scene;
}

/** Free per-build GPU resources (shared unit geometries, cached materials and text textures are kept). */
export function disposeScene(scene: THREE.Object3D): void {
  const extra: unknown = scene.userData.held;
  if (extra instanceof THREE.Object3D) disposeScene(extra);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !sharedGeos.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) if (!sharedMats.has(mat)) mat.dispose();
  });
}
