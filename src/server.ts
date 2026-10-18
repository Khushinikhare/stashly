// Stashly: an MCP server (Streamable HTTP) that remembers where things are kept.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/* ---------- tiny "database": one JSON file ---------- */
type Move = { box: string; by: string; at: string };
type Item = { name: string; box: string; history: Move[] };

const DATA_FILE = process.env.DATA_FILE ?? path.join(process.cwd(), "data.json");

function load(): Item[] {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function save(items: Item[]) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

/* ---------- fuzzy search (synonyms + word overlap) ---------- */
const SYNONYMS: string[][] = [
  ["nail cutter", "nail clipper", "nail trimmer", "nail clippers"],
  ["charger", "adapter", "power cable", "charging cable"],
  ["scissors", "shears"],
  ["torch", "flashlight"],
  ["earphones", "earbuds", "headphones"],
  ["comb", "hairbrush", "hair brush"],
];

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function expand(text: string): string {
  const t = norm(text);
  const extra: string[] = [];
  for (const group of SYNONYMS) {
    if (group.some((g) => t.includes(g))) extra.push(...group);
  }
  return [t, ...extra].join(" ");
}

function score(query: string, item: Item): number {
  const q = norm(query);
  const target = expand(item.name);
  if (norm(item.name) === q) return 1;
  if (target.includes(q) || q.includes(norm(item.name))) return 0.9;
  const qTokens = expand(query).split(" ").filter((w) => w.length > 2);
  if (!qTokens.length) return 0;
  const tTokens = new Set(target.split(" "));
  const hits = qTokens.filter((w) => tTokens.has(w)).length;
  return hits / qTokens.length;
}

function search(query: string): Item[] {
  return load()
    .map((i) => ({ i, s: score(query, i) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

/* ---------- the MCP server and its tools ---------- */
function buildServer(): McpServer {
  const server = new McpServer({ name: "stashly", version: "0.1.0" });

  server.registerTool(
    "find_item",
    {
      title: "Find an item",
      description:
        "Find where an item is kept in the shared wardrobe. Accepts the item name or a rough description, e.g. 'nail cutter' or 'the thing to cut nails'.",
      inputSchema: { query: z.string().describe("What the user is looking for") },
    },
    async ({ query }) => {
      const found = search(query);
      if (found.length === 0)
        return say(`I couldn't find anything like "${query}". Do you want to add it?`);
      const describe = (i: Item) => {
        const last = i.history[i.history.length - 1];
        return `${i.name} is in ${i.box}${last ? `, last moved by ${last.by} ${ago(last.at)}` : ""}.`;
      };
      if (found.length === 1) return say(describe(found[0]));
      const list = found.slice(0, 4).map((i) => `${i.name} in ${i.box}`).join("; ");
      return say(`I found ${found.length} matches: ${list}. Which one do you mean?`);
    }
  );

  server.registerTool(
    "put_item",
    {
      title: "Put or move an item",
      description:
        "Record that an item is now kept in a given box/section. Adds the item if new, or moves it if it already exists.",
      inputSchema: {
        name: z.string().describe("Item name, e.g. 'nail cutter'"),
        box: z.string().describe("Where it is kept, e.g. 'Box C'"),
        person: z.string().optional().describe("Who moved it, e.g. 'Riya'"),
      },
    },
    async ({ name, box, person }) => {
      const items = load();
      const by = person?.trim() || "someone";
      const move: Move = { box, by, at: new Date().toISOString() };
      const existing = items.find((i) => norm(i.name) === norm(name));
      if (existing) {
        existing.box = box;
        existing.history.push(move);
      } else {
        items.push({ name, box, history: [move] });
      }
      save(items);
      return say(`Okay, I've noted that the ${name} is in ${box}.`);
    }
  );

  server.registerTool(
    "list_box",
    {
      title: "List what is in a box",
      description: "List everything recorded inside one box/section.",
      inputSchema: { box: z.string().describe("Box or section name, e.g. 'Box A'") },
    },
    async ({ box }) => {
      const inside = load().filter((i) => norm(i.box) === norm(box));
      if (!inside.length) return say(`I have nothing recorded in ${box}.`);
      return say(`${box} has: ${inside.map((i) => i.name).join(", ")}.`);
    }
  );

  server.registerTool(
    "item_history",
    {
      title: "Item history",
      description: "Say where an item has been and who moved it recently.",
      inputSchema: { query: z.string().describe("Item name or description") },
    },
    async ({ query }) => {
      const [item] = search(query);
      if (!item) return say(`I don't know "${query}".`);
      const recent = item.history
        .slice(-3)
        .reverse()
        .map((m) => `${m.box} by ${m.by} ${ago(m.at)}`)
        .join("; ");
      return say(`${item.name} recently: ${recent}.`);
    }
  );

  return server;
}

/* ---------- HTTP wrapper (Streamable HTTP, stateless) ---------- */
const app = express();
app.use(express.json());

// Optional password: set API_KEY in your environment and callers must send "Authorization: Bearer <key>".
app.use("/mcp", (req, res, next) => {
  const key = process.env.API_KEY;
  if (key && req.header("authorization") !== `Bearer ${key}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.get("/", (_req, res) => res.send("Stashly MCP server is running. Endpoint: POST /mcp"));

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`Stashly MCP server listening on http://localhost:${PORT}/mcp`));
