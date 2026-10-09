// Tracks live runs for spectators, renders agent frames, and persists finished runs to the leaderboard.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Game, type CloseUp } from "./engine";
import type { Renderer3D } from "./renderer3d";

export interface RunRecord {
  id: string;
  player: string;
  model: string;
  seed: string;
  method: string;
  twists: string[];
  success: boolean;
  score: number;
  grade: string;
  verdict: string;
  notes: string[];
  actions: number;
  physical: number;
  observations: number;
  gameClock: string;
  wallSeconds: number;
  finishedAt: string;
}

export class Registry {
  readonly runs = new Map<string, Game>();
  readonly records: RunRecord[] = [];
  private readonly recorded = new Set<string>();
  /** The last frame each agent was shown, for spectators. */
  private readonly frames = new Map<string, { version: number; png: Uint8Array<ArrayBuffer> }>();

  constructor(
    private readonly file: string,
    private readonly renderer: Renderer3D,
  ) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.records.push(JSON.parse(line) as RunRecord);
        } catch {
          console.error(`[registry] skipping a damaged line in ${file}`);
        }
      }
    }
  }

  /**
   * Forget runs spectators no longer need: finished ones after an hour (their records stay on the
   * leaderboard) and abandoned ones after a day, keeping at most 100 in memory.
   */
  prune(now = Date.now()): void {
    const drop = (g: Game): void => {
      this.runs.delete(g.id);
      this.frames.delete(g.id);
    };
    for (const g of this.runs.values()) {
      const idle = now - g.lastActive;
      if ((g.status !== "playing" && idle > 3600_000) || idle > 24 * 3600_000) drop(g);
    }
    const oldest = [...this.runs.values()].sort((a, b) => a.lastActive - b.lastActive);
    while (oldest.length > 100) drop(oldest.shift()!);
  }

  start(player: string, model: string, seed: string): Game {
    this.prune();
    const game = new Game(crypto.randomUUID().slice(0, 8), player, model, seed);
    this.runs.set(game.id, game);
    return game;
  }

  /** Render what the agent sees now (or a close-up) and remember it for spectators. */
  async frame(game: Game, closeUp?: CloseUp): Promise<Uint8Array<ArrayBuffer>> {
    const png = await this.renderer.render(game.snapshot(closeUp));
    this.frames.set(game.id, { version: game.version, png });
    return png;
  }

  lastFrame(game: Game): Uint8Array<ArrayBuffer> | undefined {
    return this.frames.get(game.id)?.png;
  }

  /** Call after every action; persists the run once it has ended. */
  settle(game: Game): void {
    if (game.status === "playing" || this.recorded.has(game.id) || !game.outcome) return;
    this.recorded.add(game.id);
    const o = game.outcome;
    const rec: RunRecord = {
      id: game.id,
      player: game.player,
      model: game.model,
      seed: game.seed,
      method: game.world.recipe.method,
      twists: game.world.recipe.twists,
      success: o.success,
      score: o.score,
      grade: o.grade,
      verdict: o.verdict,
      notes: o.notes,
      actions: game.actions,
      physical: game.physical,
      observations: game.observations,
      gameClock: game.clock(),
      wallSeconds: Math.round(((game.endedAt ?? Date.now()) - game.startedAt) / 1000),
      finishedAt: new Date().toISOString(),
    };
    this.records.push(rec);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(rec) + "\n");
    } catch (err) {
      console.error("[registry] could not save the run:", err);
    }
  }

  summary(game: Game): Record<string, unknown> {
    return {
      id: game.id,
      player: game.player,
      model: game.model,
      seed: game.seed,
      status: game.status,
      room: game.world.rooms.get(game.room)!.name,
      clock: game.clock(),
      actions: game.actions,
      version: game.version,
      startedAt: game.startedAt,
      outcome: game.outcome ?? null,
      // Spoilers only once the run is over.
      recipe: game.status === "playing" ? null : { method: game.world.recipe.method, twists: game.world.recipe.twists },
      lastAction: game.log.at(-1) ?? null,
    };
  }
}
