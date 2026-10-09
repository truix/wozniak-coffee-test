// Per-session action journal, so a run survives a server restart. A house is fully determined by its seed
// and the actions taken in it, so replaying the tool calls of the current run rebuilds it exactly.
//
// One file per MCP session (data/sessions/<session id>.jsonl): the start_game call, then every tool call
// after it. It is cleared when a new game starts and deleted when the run ends.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface JournalEntry {
  tool: string;
  args: Record<string, unknown>;
}

/** Session ids come from the client's mcp-session-id header: only accept what we hand out (UUIDs). */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Journal {
  constructor(private readonly dir: string) {}

  private file(sid: string): string | undefined {
    return SESSION_ID.test(sid) ? join(this.dir, `${sid.toLowerCase()}.jsonl`) : undefined;
  }

  /** Start the journal over with this entry (a new start_game). */
  reset(sid: string, entry: JournalEntry): void {
    const f = this.file(sid);
    if (!f) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(f, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("[journal] write failed:", err);
    }
  }

  append(sid: string, entry: JournalEntry): void {
    const f = this.file(sid);
    if (!f || !existsSync(f)) return;
    try {
      appendFileSync(f, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("[journal] write failed:", err);
    }
  }

  load(sid: string): JournalEntry[] {
    const f = this.file(sid);
    if (!f || !existsSync(f)) return [];
    const out: JournalEntry[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalEntry);
      } catch {
        // a line cut short by a crash: everything before it still replays
        break;
      }
    }
    return out;
  }

  drop(sid: string): void {
    const f = this.file(sid);
    if (f) rmSync(f, { force: true });
  }
}
