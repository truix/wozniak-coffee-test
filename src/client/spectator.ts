/// <reference lib="dom" />
// Spectator UI: runs list + leaderboard, a live orbitable 3D dollhouse of the selected run (cutaway walls,
// agent avatar with view cone, optional floating labels), the agent's latest first-person frame, outcome
// and action log. Polls /api/runs every second and refetches a run when its `version` changes.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Snapshot } from "../snapshot";
import { buildScene, disposeScene } from "./scene";

interface Outcome {
  success: boolean;
  score: number;
  grade: string;
  verdict: string;
  notes: string[];
}
interface RunSummary {
  id: string;
  player: string;
  model: string;
  seed: string;
  status: "playing" | "won" | "failed";
  room: string;
  clock: string;
  actions: number;
  version: number;
  startedAt: number | string;
  outcome: Outcome | null;
  recipe: { method: string; twists: string[] } | null;
  lastAction: string | null;
}
interface LogEntry {
  n: number;
  clock: string;
  action: string;
  /** What the action actually touched (spectator-only). */
  targets: string[];
  result: string;
  ok: boolean;
}
interface RunDetail extends RunSummary {
  log: LogEntry[];
}
interface BoardRow {
  player: string;
  model: string;
  seed: string;
  success: boolean;
  score: number;
  grade: string;
  verdict: string;
  actions: number;
  method: string;
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

$("ep").textContent = `${location.origin}/mcp`;

// ---- 3D view -------------------------------------------------------------------------------------

const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);
const labelRenderer = new CSS2DRenderer({ element: $("labels") });
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
camera.position.set(6, 14, 18);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 1;
controls.maxDistance = 60;

let scene: THREE.Scene | null = null;
let walls: { obj: THREE.Object3D; outward: THREE.Vector3; point: THREE.Vector3 }[] = [];
let snap: Snapshot | null = null;
let followAgent = false;
let showLabels = true;
let framedRun: string | null = null;

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function houseBounds(s: Snapshot): THREE.Box3 {
  const b = new THREE.Box3();
  for (const r of s.rooms) {
    b.expandByPoint(new THREE.Vector3(r.x0, 0, r.z0));
    b.expandByPoint(new THREE.Vector3(r.x1, 2.6, r.z1));
  }
  return b;
}

function frameHouse(): void {
  if (!snap) return;
  const b = houseBounds(snap);
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.5 + 1;
  const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
  controls.target.copy(c).setY(0.6);
  camera.position.set(c.x + dist * 0.25, dist * 0.85, c.z + dist * 0.62);
  controls.update();
}

function addLabels(sc: THREE.Scene, s: Snapshot): void {
  const root = new THREE.Group();
  root.name = "labels";
  const held = new Set(s.hands.filter((h): h is string => !!h));
  for (const r of s.rooms) {
    const el = document.createElement("div");
    el.className = "lbl room";
    el.textContent = r.name;
    const o = new CSS2DObject(el);
    o.position.set((r.x0 + r.x1) / 2, 0.05, (r.z0 + r.z1) / 2);
    root.add(o);
  }
  for (const t of s.things) {
    // things inside closed containers are not drawn, so they get no label either
    if (t.hidden || t.parent === "hands" || held.has(t.id)) continue;
    const el = document.createElement("div");
    el.className = `lbl${t.parent ? "" : " furn"}`;
    el.textContent = t.name;
    const o = new CSS2DObject(el);
    o.position.set((t.min[0] + t.max[0]) / 2, t.max[1], (t.min[2] + t.max[2]) / 2);
    root.add(o);
  }
  sc.add(root);
}

function setScene(s: Snapshot, runId: string): void {
  const next = buildScene(s, "spectator");
  addLabels(next, s);
  const old = scene;
  scene = next;
  snap = s;
  walls = [];
  next.traverse((o) => {
    const cut: unknown = o.userData.cutaway;
    if (cut && typeof cut === "object" && "outward" in cut && "point" in cut && cut.outward instanceof THREE.Vector3 && cut.point instanceof THREE.Vector3)
      walls.push({ obj: o, outward: cut.outward, point: cut.point });
  });
  if (old) {
    // CSS2D label elements live in the DOM until their objects are removed
    old.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
    });
    disposeScene(old);
  }
  $("stageEmpty").style.display = "none";
  if (framedRun !== runId) {
    framedRun = runId;
    frameHouse();
  }
}

const tmp = new THREE.Vector3();
function animate(): void {
  requestAnimationFrame(animate);
  if (!scene) return;
  const av = scene.getObjectByName("avatar");
  if (av && followAgent) {
    // glide the orbit target toward the agent, carrying the camera along
    tmp.set(av.position.x, 1.0, av.position.z).sub(controls.target).multiplyScalar(0.08);
    controls.target.add(tmp);
    camera.position.add(tmp);
  }
  controls.update();
  for (const w of walls) w.obj.visible = tmp.copy(camera.position).sub(w.point).dot(w.outward) <= 0;
  renderer.render(scene, camera);
  labelRenderer.domElement.style.display = showLabels ? "" : "none";
  if (showLabels) labelRenderer.render(scene, camera);
}
animate();

const followBtn = $("follow");
followBtn.onclick = () => {
  followAgent = !followAgent;
  followBtn.classList.toggle("on", followAgent);
};
const labelsBtn = $("labelsBtn");
labelsBtn.onclick = () => {
  showLabels = !showLabels;
  labelsBtn.classList.toggle("on", showLabels);
};
$("resetBtn").onclick = () => {
  followAgent = false;
  followBtn.classList.remove("on");
  frameHouse();
};

// ---- runs, leaderboard, side panel ---------------------------------------------------------------

let selected: string | null = null;
let autoFollowNewest = true;
let shownVersion = -1;
let tab: "runs" | "board" = "runs";
let refreshing = false;

$("tRuns").onclick = () => {
  tab = "runs";
  $("tRuns").className = "on";
  $("tBoard").className = "";
  $("runs").hidden = false;
  $("board").hidden = true;
};
$("tBoard").onclick = () => {
  tab = "board";
  $("tBoard").className = "on";
  $("tRuns").className = "";
  $("runs").hidden = true;
  $("board").hidden = false;
  void loadBoard();
};

async function loadBoard(): Promise<void> {
  const rows: BoardRow[] = await (await fetch("/api/leaderboard")).json();
  $("board").innerHTML = rows.length
    ? `<table><tr><th>#</th><th>Player</th><th>Score</th><th>Acts</th><th>Method</th></tr>${rows
        .map(
          (r, i) =>
            `<tr title="${esc(r.verdict)}\nhouse ${esc(r.seed)}"><td>${i + 1}</td><td>${esc(r.player)}<br><small style="color:var(--muted)">${esc(r.model)}</small></td><td class="${r.success ? "won" : "failed"}">${r.success ? `${r.score} ${esc(r.grade)}` : "fail"}</td><td>${r.actions}</td><td>${esc(r.method)}</td></tr>`,
        )
        .join("")}</table>`
    : `<div class="empty">No finished runs yet.</div>`;
}

function pill(r: RunSummary): string {
  const text = r.status === "won" && r.outcome ? `${r.outcome.score} ${r.outcome.grade}` : r.status;
  return `<span class="pill ${r.status}">${esc(text)}</span>`;
}

async function tick(): Promise<void> {
  const runs: RunSummary[] = await (await fetch("/api/runs")).json();
  const newest = runs[0];
  if (autoFollowNewest && newest && newest.id !== selected) select(newest.id, true);
  $("runs").innerHTML =
    runs
      .map(
        (r) =>
          `<div class="run ${r.id === selected ? "sel" : ""}" data-id="${esc(r.id)}"><b>${esc(r.player)} ${pill(r)}</b><small>${esc(r.model)} · ${esc(r.room)} · ${r.actions} actions · ${esc(r.clock)}<br>house ${esc(r.seed)}</small></div>`,
      )
      .join("") || `<div class="empty">No runs yet.</div>`;
  for (const el of document.querySelectorAll<HTMLElement>(".run")) {
    el.onclick = () => {
      if (el.dataset.id) select(el.dataset.id, false);
    };
  }
  const cur = runs.find((r) => r.id === selected);
  if (cur && cur.version !== shownVersion) await refresh();
  if (tab === "board") await loadBoard();
}

function select(id: string, auto: boolean): void {
  if (id !== selected) shownVersion = -1;
  selected = id;
  autoFollowNewest = auto;
  for (const el of document.querySelectorAll<HTMLElement>(".run")) el.classList.toggle("sel", el.dataset.id === id);
  void refresh();
}

async function refresh(): Promise<void> {
  if (!selected || refreshing) return;
  refreshing = true;
  try {
    const id = selected;
    const [detailRes, snapRes] = await Promise.all([fetch(`/api/runs/${id}`), fetch(`/api/runs/${id}/snapshot`)]);
    if (!detailRes.ok || !snapRes.ok || id !== selected) return;
    const r: RunDetail = await detailRes.json();
    const s: Snapshot = await snapRes.json();
    shownVersion = r.version;
    $("viewTitle").innerHTML = `<b>${esc(r.player)}</b> (${esc(r.model)}) · house ${esc(r.seed)} · ${esc(r.room)} · ${esc(r.clock)} ${pill(r)}`;
    setScene(s, id);
    const img = $("img");
    if (img instanceof HTMLImageElement) img.src = `/api/runs/${id}/view.png?v=${r.version}`;
    $("fpCap").textContent = `after action #${r.actions}${s.camera ? " · examining" : ""}`;
    const o = r.outcome;
    const box = $("outcome");
    box.style.display = o ? "block" : "none";
    if (o) {
      box.innerHTML = `<div class="score ${o.success ? "won" : "failed"}" style="background:none">${o.success ? `Served! ${o.score} pts · grade ${esc(o.grade)}` : "Failed"}</div>
        <div>${esc(o.verdict)}</div>
        <ul>${o.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        ${r.recipe ? `<small>The house's way: ${esc(r.recipe.method)}${r.recipe.twists.length ? ` · twists: ${esc(r.recipe.twists.join(", "))}` : ""}</small>` : ""}`;
    }
    $("log").innerHTML =
      r.log
        .slice()
        .reverse()
        .map((e) => `<div class="log ${e.ok ? "" : "err"}"><span class="t">#${e.n} ${esc(e.clock)}</span><div class="a">${esc(e.action)}${e.targets.length ? ` <span class="hit">→ ${esc(e.targets.join(", "))}</span>` : ""}</div><div class="r">${esc(e.result)}</div></div>`)
        .join("") || `<div class="empty">No actions yet.</div>`;
  } catch (err) {
    console.error("refresh failed", err);
  } finally {
    refreshing = false;
  }
}

async function loop(): Promise<void> {
  try {
    await tick();
  } catch (err) {
    console.error("poll failed", err);
  }
  setTimeout(loop, 1000);
}
void loop();
