// HTTP entry point: MCP over Streamable HTTP at /mcp, the spectator UI at /, the headless render page at
// /render (driven by our own Chromium), and a JSON API for spectators.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import spectatorPage from "../public/index.html";
import renderPage from "../public/render.html";
import { Journal, SESSION_ID } from "./journal";
import { createSession, type SessionContext } from "./mcp";
import { Registry } from "./registry";
import { Renderer3D } from "./renderer3d";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
const ROOT = join(import.meta.dir, "..");
/** Leaderboard (runs.jsonl) and session journals. */
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
/** Sessions nobody has used for this long are closed (they are re-created on demand, see recover()). */
const SESSION_IDLE_MS = 6 * 3600_000;

// A bad request or a crashed renderer must never take the whole server down mid-run: log it and keep serving.
process.on("unhandledRejection", (reason) => console.error("[server] unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[server] uncaught exception:", err));

const renderer = new Renderer3D(`http://127.0.0.1:${PORT}`);
const registry = new Registry(join(DATA_DIR, "runs.jsonl"), renderer);
const journal = new Journal(join(DATA_DIR, "sessions"));

interface Live {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}
const sessions = new Map<string, Live>();

function jsonRpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

/** A transport + MCP server pair. `fixedId` re-creates a session under the id the client already has. */
async function openSession(fixedId?: string): Promise<{ transport: WebStandardStreamableHTTPServerTransport; ctx: SessionContext; restore: () => Promise<number> }> {
  const ctx: SessionContext = { journal };
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => fixedId ?? crypto.randomUUID(),
    // Recovered sessions answer with plain JSON: the client is mid-conversation and expects nothing else.
    enableJsonResponse: !!fixedId,
    onsessioninitialized: (id) => {
      ctx.id = id;
      sessions.set(id, { transport, lastSeen: Date.now() });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      journal.drop(id);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.get(transport.sessionId)?.transport === transport) sessions.delete(transport.sessionId);
  };
  const session = createSession(registry, ctx);
  await session.server.connect(transport);
  return { transport, ctx, restore: session.restore };
}

/**
 * The client sent a session id we don't know: the server restarted (or the session idled out). Rather than
 * a 404 that many MCP clients can't recover from, re-create the session under the same id and rebuild its
 * run from the journal, so the agent carries on where it was.
 */
async function recover(sid: string, req: Request): Promise<WebStandardStreamableHTTPServerTransport> {
  const { transport, restore } = await openSession(sid);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await transport.handleRequest(
    new Request(req.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "recover",
        method: "initialize",
        params: {
          protocolVersion: req.headers.get("mcp-protocol-version") ?? LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "recovered-session", version: "0" },
        },
      }),
    }),
  );
  await init.text();
  await transport.handleRequest(
    new Request(req.url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid, "mcp-protocol-version": req.headers.get("mcp-protocol-version") ?? LATEST_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
  );
  const n = await restore();
  console.log(`[server] re-created session ${sid}${n ? `, replayed ${n} tool calls` : ", nothing to restore"}`);
  return transport;
}

/** Concurrent requests for the same lost session share one recovery. */
const recovering = new Map<string, Promise<WebStandardStreamableHTTPServerTransport>>();

async function handleMcp(req: Request): Promise<Response> {
  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    let live = sessions.get(sid);
    if (!live) {
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (!SESSION_ID.test(sid)) return jsonRpcError(404, "Unknown or expired session. Reconnect.");
      let pending = recovering.get(sid);
      if (!pending) {
        pending = recover(sid, req).finally(() => recovering.delete(sid));
        recovering.set(sid, pending);
      }
      try {
        await pending;
      } catch (err) {
        console.error("[server] session recovery failed:", err);
        return jsonRpcError(404, "Unknown or expired session. Reconnect.");
      }
      live = sessions.get(sid);
      if (!live) return jsonRpcError(404, "Unknown or expired session. Reconnect.");
    }
    live.lastSeen = Date.now();
    return live.transport.handleRequest(req);
  }
  if (req.method !== "POST") return jsonRpcError(400, "Missing mcp-session-id header.");
  const body: unknown = await req.json().catch(() => undefined);
  if (!isInitializeRequest(body)) return jsonRpcError(400, "First request must be initialize.");
  const { transport } = await openSession();
  return transport.handleRequest(req, { parsedBody: body });
}

// Housekeeping: close idle sessions and forget old finished runs, so a long-lived server stays small.
setInterval(() => {
  const now = Date.now();
  for (const [id, live] of sessions) {
    if (now - live.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(id);
      void live.transport.close().catch(() => undefined);
    }
  }
  registry.prune();
}, 10 * 60_000).unref();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  // Bun's dev-mode HTML bundler fails on UNC/network-share paths; production bundling works everywhere.
  development: false,
  routes: {
    "/": spectatorPage,
    "/render": renderPage,
    "/mcp": handleMcp,
    "/api/runs": () => {
      const runs = [...registry.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((g) => registry.summary(g));
      return Response.json(runs);
    },
    "/api/runs/:id": (req) => {
      const g = registry.runs.get(req.params.id);
      if (!g) return new Response("not found", { status: 404 });
      return Response.json({ ...registry.summary(g), log: g.log.slice(-200) });
    },
    "/api/runs/:id/snapshot": (req) => {
      const g = registry.runs.get(req.params.id);
      if (!g) return new Response("not found", { status: 404 });
      return Response.json(g.snapshot());
    },
    "/api/runs/:id/view.png": (req) => {
      const g = registry.runs.get(req.params.id);
      const png = g && registry.lastFrame(g);
      if (!png) return new Response("not found", { status: 404 });
      return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    },
    "/api/leaderboard": () => Response.json([...registry.records].sort((a, b) => b.score - a.score || a.actions - b.actions)),
  },
  fetch: () => new Response("not found", { status: 404 }),
  error: (err) => {
    console.error("[server] request failed:", err);
    return jsonRpcError(500, `Internal error: ${err.message}`);
  },
});

const shutdown = async (): Promise<void> => {
  await renderer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Coffee test running.\n  MCP endpoint: http://${server.hostname}:${server.port}/mcp\n  Spectate:     http://${server.hostname}:${server.port}/`);
