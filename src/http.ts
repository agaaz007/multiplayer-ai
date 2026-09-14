import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initLedger, loadConfig } from "./store.js";
import { createMcpServer } from "./mcp.js";

/**
 * Ledger's MCP server over Streamable HTTP, for clients that cannot launch a local process: ChatGPT web
 * (Developer mode apps) and claude.ai custom connectors (2026-09-14).
 *
 * Stateless: every POST builds its own server and transport, so nothing about a conversation lives in the
 * process and any replica can answer. This first version has no login, so it serves only a scratch ledger
 * behind an unguessable path; it exists to test whether a ChatGPT Plus account can call Ledger's save tools.
 * The team version adds OAuth and per-person authors before any real ledger is served.
 */

export interface HttpMcpOpts {
  port: number;
  host?: string;
  /** the endpoint is /mcp/<secret>; without one it is /mcp */
  secret?: string;
  /** serve a disposable ledger, never the machine's configured one or the team database */
  scratch: true;
  log?: (m: string) => void;
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function mcpPath(secret?: string): string {
  return secret ? `/mcp/${secret}` : "/mcp";
}

/**
 * Point every Ledger path at a scratch directory before the config is read. The config dir is forced, not
 * defaulted: an HTTP test must never read or rewrite ~/.ledger/config.json (2026-09-09: a test that did
 * repointed the machine's ledger for hours), and the team database is dropped.
 */
export function prepareScratch(log: (m: string) => void = () => {}): { root: string; ledger: string; author: string } {
  const root = process.env.LEDGER_SCRATCH_DIR || path.join(os.tmpdir(), "ledger-http-scratch");
  const ledger = path.join(root, "ledger");
  const author = process.env.LEDGER_AUTHOR || "chatgpt-test";
  process.env.LEDGER_CONFIG_DIR = path.join(root, "config");
  process.env.LEDGER_DIR = ledger;
  process.env.LEDGER_AUTHOR = author;
  process.env.LEDGER_GIT_SYNC = "0";
  delete process.env.LEDGER_CONTINUITY_DB;
  fs.mkdirSync(process.env.LEDGER_CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(path.join(ledger, "LEDGER.md"))) {
    initLedger(ledger, author);
    log(`scratch ledger created at ${ledger}`);
  }
  return { root, ledger, author };
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error(`body over ${MAX_BODY_BYTES} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e: any) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

/**
 * Web clients get text-only tool results. In the first ChatGPT Plus test (2026-09-15) the plain-text tool
 * (ledger_brief) worked, while every tool returning structuredContent or result _meta (ledger_search, the save
 * tools) showed "Unexpected response type", even though the saves themselves went through and ChatGPT retried
 * them into duplicates. Structured receipts and evidence-card metadata serve local hosts and hooks; the text
 * content carries the same facts. Tool definitions lose _meta (the MCP Apps card) and outputSchema to match.
 */
export function webSafeMessage(message: any): any {
  const result = message?.result;
  if (!result || typeof result !== "object") return message;
  if (Array.isArray(result.content)) {
    const { structuredContent: _sc, _meta: _m, ...rest } = result;
    return { ...message, result: { ...rest, content: result.content.map((c: any) => (c?.type === "text" ? { type: "text", text: String(c.text ?? "") } : c)) } };
  }
  if (Array.isArray(result.tools)) {
    return { ...message, result: { ...result, tools: result.tools.map(({ _meta: _m, outputSchema: _o, ...tool }: any) => tool) } };
  }
  return message;
}

export async function startHttpMcp(opts: HttpMcpOpts): Promise<http.Server> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  prepareScratch(log);
  const cfg = loadConfig();
  if (cfg.continuity) throw new Error("scratch HTTP server refuses to start with a continuity database configured");
  if (!opts.secret) log("WARNING: LEDGER_HTTP_SECRET is not set; the endpoint is /mcp and anyone who finds the URL can read and write this scratch ledger");
  const endpoint = mcpPath(opts.secret);

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") return sendJson(res, 200, { ok: true, service: "ledger-mcp", mode: "scratch" });
    if (pathname !== endpoint) return sendJson(res, 404, { error: "not found" });
    if (req.method !== "POST") return sendJson(res, 405, rpcError(-32000, "Method not allowed: this server is stateless; send MCP requests with POST"), { Allow: "POST" });
    let body: unknown;
    try { body = await readJson(req); } catch (e: any) { return sendJson(res, 400, rpcError(-32700, `Parse error: ${e.message}`)); }
    const mcp = createMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const send = transport.send.bind(transport);
    transport.send = ((message: any, options?: any) => send(webSafeMessage(message), options)) as typeof transport.send;
    res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      log(`mcp request failed: ${String(e?.message ?? e).slice(0, 300)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
    }
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve()); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`ledger MCP over HTTP (scratch) on port ${port} at ${opts.secret ? "/mcp/<secret>" : "/mcp"}; ledger ${cfg.ledger_dir}; author ${cfg.author}`);
  return server;
}
