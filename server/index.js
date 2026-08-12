// server/index.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const { crawlWebsite, chunkText } = require("./scraper");
const { embedBatch } = require("./embeddings");
const vectorStore = require("./vectorStore");
const { startBridge } = require("./liveSession");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());

if (!API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY সেট করা নেই। .env ফাইলে সেট করুন।");
}

// --- CORS (widget.js এবং /api/train কে যেকোনো ক্লায়েন্ট ওয়েবসাইট থেকে কল করার অনুমতি) ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/widget.js", express.static(path.join(__dirname, "..", "public", "widget.js")));

app.get("/", (_req, res) => {
  res.send("Realtime Voice Agent server চলছে ✅");
});

/**
 * POST /api/train
 * body: { websiteUrl, siteName?, maxPages?, systemPrompt? }
 * -> নতুন agentId বানায়, ওয়েবসাইট ক্রল করে, chunk+embed করে vector store এ সেভ করে।
 * -> রেসপন্সে agentId + embed script স্নিপেট রিটার্ন করে।
 */
app.post("/api/train", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Server GEMINI_API_KEY missing" });

    const { websiteUrl, siteName, maxPages, systemPrompt } = req.body || {};
    if (!websiteUrl) return res.status(400).json({ error: "websiteUrl আবশ্যক" });

    const agentId = uuidv4();
    console.log(`[train] শুরু: ${websiteUrl} -> agentId ${agentId}`);

    const { pages } = await crawlWebsite(websiteUrl, { maxPages: maxPages || 20 });
    if (!pages.length) {
      return res.status(422).json({ error: "কোনো কনটেন্ট বের করা গেল না, URL চেক করুন" });
    }

    const rawChunks = [];
    for (const page of pages) {
      const parts = chunkText(page.text);
      for (const text of parts) {
        rawChunks.push({ url: page.url, title: page.title, text });
      }
    }
    console.log(`[train] ${pages.length} পেজ থেকে ${rawChunks.length} chunk তৈরি হয়েছে, embedding শুরু...`);

    const embeddings = await embedBatch(
  API_KEY,
  rawChunks.map((c) => c.text),
  {
    batchSize: 50,
  }
);

    const chunks = rawChunks.map((c, i) => ({
      id: uuidv4(),
      url: c.url,
      title: c.title,
      text: c.text,
      embedding: embeddings[i],
    }));

    vectorStore.saveStore(agentId, {
      agentId,
      siteName: siteName || new URL(websiteUrl).hostname,
      siteUrl: websiteUrl,
      systemPrompt: systemPrompt || null,
      createdAt: new Date().toISOString(),
      pageCount: pages.length,
      chunks,
    });

    console.log(`[train] ✅ শেষ। agentId=${agentId}`);

    const host = req.get("host");
    const protocol = req.protocol;
    const embedSnippet = `<script src="${protocol}://${host}/widget.js" data-agent-id="${agentId}" data-server="${protocol}://${host}" async></script>`;

    res.json({
      agentId,
      pagesTrained: pages.length,
      chunksCreated: chunks.length,
      embedSnippet,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ট্রেইনিং স্ট্যাটাস চেক করার জন্য (ঐচ্ছিক)
app.get("/api/agent/:agentId", (req, res) => {
  const store = vectorStore.loadStore(req.params.agentId);
  if (!store) return res.status(404).json({ error: "agent পাওয়া যায়নি" });
  res.json({
    agentId: store.agentId,
    siteName: store.siteName,
    siteUrl: store.siteUrl,
    createdAt: store.createdAt,
    pageCount: store.pageCount,
    chunkCount: store.chunks.length,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agentId = url.searchParams.get("agentId");

  if (!agentId || !vectorStore.agentExists(agentId)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid or missing agentId" }));
    ws.close();
    return;
  }
  if (!API_KEY) {
    ws.send(JSON.stringify({ type: "error", message: "Server not configured" }));
    ws.close();
    return;
  }

  startBridge(ws, { agentId, apiKey: API_KEY, model: MODEL });
});

server.listen(PORT,"0.0.0.0", () => {
  console.log(`🚀 Server চলছে: http://localhost:${PORT}`);
  console.log(`   Train:  POST http://localhost:${PORT}/api/train`);
  console.log(`   Widget: GET  http://localhost:${PORT}/widget.js`);
  console.log(`   Voice:  WS   ws://localhost:${PORT}/ws/voice?agentId=...`);
});
