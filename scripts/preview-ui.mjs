// Local, read-only MCP Apps development host. Never expose the full Ledger toolset over HTTP.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp.js";
import { loadConfig } from "../dist/store.js";
import { EVIDENCE_URI } from "../dist/evidence.js";

const port = Number(process.env.LEDGER_UI_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("LEDGER_UI_PORT must be a port from 1024 to 65535");
const origin = `http://127.0.0.1:${port}`;
const root = new URL("../", import.meta.url);
const allowed = new Set(["ledger_search", "ledger_get", "ledger_show_contribution"]);
const server = createMcpServer({ ...loadConfig(), git_sync: false });
const client = new Client({ name: "ledger-local-apps-preview", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const bundle = await build({ entryPoints: [new URL("ui/preview.ts", root).pathname], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false });
const nonce = randomBytes(24).toString("base64");
const html = (await readFile(new URL("ui/preview.html", root), "utf8")).replaceAll("__LEDGER_NONCE__", nonce);

const host = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Loopback binding alone does not stop a hostile website from making requests.
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403).end("Forbidden origin"); return;
  }
  const url = new URL(req.url, origin);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html); return;
    }
    if (req.method === "GET" && url.pathname === "/preview.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text); return;
    }
    if (req.method === "POST" && url.pathname === "/api") {
      if (!req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(415).end(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 128_000) { res.writeHead(413).end(); return; }
      }
      const request = JSON.parse(body);
      let result;
      if (request.action === "resource") result = await client.readResource({ uri: EVIDENCE_URI });
      else if (request.action === "call" && allowed.has(request.name)) result = await client.callTool({ name: request.name, arguments: request.arguments || {} });
      else { res.writeHead(403).end("Only evidence reads are available in this preview"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result)); return;
    }
    res.writeHead(404).end("Not found");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(error.message || error) }));
  }
});
host.listen(port, "127.0.0.1", () => console.log(`Ledger MCP Apps preview: ${origin}\nLocal ledger reads only; git sync and recording are disabled in this preview.`));
async function close() { host.close(); await client.close(); await server.close(); }
process.once("SIGINT", close);
process.once("SIGTERM", close);
