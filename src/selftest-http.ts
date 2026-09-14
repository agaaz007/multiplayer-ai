import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ledger's MCP server over Streamable HTTP (the ChatGPT / claude.ai test endpoint). Localhost only, a scratch
 * ledger in a temp dir, no database. Checks the unguessable path, that read tools carry readOnlyHint (so
 * ChatGPT asks for approval only on saves), that continuity tools are absent without a database, and a full
 * save-then-search round trip through the official MCP client.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-http-"));
process.env.LEDGER_SCRATCH_DIR = tmp;
process.env.LEDGER_CONTINUITY_DB = "postgresql://team-db.invalid/must-be-dropped";
const configBefore = process.env.HOME ? fs.existsSync(path.join(process.env.HOME, ".ledger", "config.json")) && fs.statSync(path.join(process.env.HOME, ".ledger", "config.json")).mtimeMs : null;

const { startHttpMcp, mcpPath } = await import("./http.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

let step = 0;
const ok = (m: string) => console.log(`  ok ${++step}. ${m}`);
const textOf = (r: any) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

const secret = crypto.randomBytes(16).toString("hex");
const logs: string[] = [];
const server = await startHttpMcp({ port: 0, host: "127.0.0.1", secret, scratch: true, log: (m) => logs.push(m) });
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// ---------- 1. scratch isolation and routing ----------
assert.equal(process.env.LEDGER_CONTINUITY_DB, undefined, "scratch mode drops the team database");
assert.equal(process.env.LEDGER_CONFIG_DIR, path.join(tmp, "config"), "config dir forced into the scratch dir");
assert.ok(fs.existsSync(path.join(tmp, "ledger", "LEDGER.md")), "scratch ledger initialised");
if (configBefore) assert.equal(fs.statSync(path.join(process.env.HOME!, ".ledger", "config.json")).mtimeMs, configBefore, "the machine config is untouched");
assert.ok(logs.some((l) => l.includes("on port") && l.includes("/mcp/<secret>")) && !logs.join("\n").includes(secret), "the secret is never logged");
assert.equal((await fetch(`${base}/healthz`)).status, 200);
assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "without the secret path");
assert.equal((await fetch(`${base}${mcpPath(secret)}`)).status, 405, "GET on a stateless server");
assert.equal((await fetch(`${base}${mcpPath(secret)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status, 400);
ok("scratch isolation (no team database, forced config dir, secret not logged); health 200, wrong path 404, GET 405, bad JSON 400");

// ---------- 2. tools and annotations over HTTP ----------
const client = new Client({ name: "selftest-http", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${mcpPath(secret)}`)));
const tools = (await client.listTools()).tools;
const byName = new Map(tools.map((t) => [t.name, t]));
for (const n of ["ledger_brief", "ledger_search", "ledger_get", "ledger_stats", "ledger_investigation", "ledger_show_contribution"]) {
  assert.equal(byName.get(n)?.annotations?.readOnlyHint, true, `${n} is marked read-only`);
}
for (const n of ["ledger_record_finding", "ledger_record_decision", "ledger_record_definition", "ledger_record_change", "ledger_skip_record"]) {
  assert.ok(byName.has(n), `${n} is exposed`);
  assert.notEqual(byName.get(n)?.annotations?.readOnlyHint, true, `${n} is a save, so ChatGPT asks before calling it`);
}
assert.ok(!byName.has("ledger_threads") && !byName.has("ledger_record_update"), "continuity tools need a database and are absent");
assert.ok(tools.every((t: any) => t._meta === undefined && t.outputSchema === undefined), "web clients get no MCP Apps card metadata or output schemas");
ok(`${tools.length} tools over HTTP; read tools carry readOnlyHint, save tools do not; no continuity tools without a database`);

// ---------- 3. save, then find it, through the MCP client ----------
const saved = textOf(await client.callTool({
  name: "ledger_record_decision",
  arguments: {
    title: "Keep the annual plan until the pricing test reads out",
    decision: "Keep the annual plan until the pricing test reads out",
    context: "HTTP transport selftest: a PM decides in ChatGPT and saves through Ledger.",
    options_considered: [{ option: "Keep the annual plan", chosen: true, rationale: "the test is still running" }, { option: "Drop it now", rationale: "no data yet" }],
    rationale: "Changing the lineup mid-test would contaminate the readout.",
    assumptions: [{ statement: "The pricing test ends on schedule", kind: "implicit", if_wrong: "weakens_conclusion" }],
    valid_from: "2026-09-14",
    owner: "chatgpt-test",
  },
}));
const id = saved.match(/Recorded decision (dec-[a-z0-9-]+)/)?.[1];
assert.ok(id, saved);
assert.ok(fs.existsSync(path.join(tmp, "ledger", "decisions", `${id}.md`)), "the decision file is in the scratch ledger");
const rawSearch: any = await client.callTool({ name: "ledger_search", arguments: { query: "annual plan pricing test" } });
const found = textOf(rawSearch);
assert.ok(found.includes(id!), found);
// 2026-09-15 ChatGPT Plus test: results carrying structuredContent or _meta failed with "Unexpected response type"
assert.ok(!("structuredContent" in rawSearch) && !("_meta" in rawSearch), `search result is text-only: ${Object.keys(rawSearch).join(",")}`);
assert.ok(rawSearch.content.every((c: any) => Object.keys(c).sort().join(",") === "text,type"), "content items carry only type and text");
const brief = textOf(await client.callTool({ name: "ledger_brief", arguments: {} }));
assert.ok(brief.includes("Keep the annual plan"), "the brief lists the new decision");
ok(`ledger_record_decision over HTTP saved ${id} to the scratch ledger; ledger_search and ledger_brief return it`);

// ---------- 4. rich mode keeps the evidence card's data; content items are still reduced to type and text ----------
{
  const { webSafeMessage, webResultMode } = await import("./http.js");
  const call = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "found", annotations: { audience: ["user"] } }], structuredContent: { schema: "ledger-evidence/v1" }, _meta: { "ledger/fullRecords": { a: "# A" } } } };
  const rich = webSafeMessage(call, "rich");
  assert.deepEqual(rich.result.content, [{ type: "text", text: "found" }]);
  assert.deepEqual({ sc: rich.result.structuredContent, meta: rich.result._meta }, { sc: call.result.structuredContent, meta: call.result._meta }, "rich keeps the card data");
  const text = webSafeMessage(call, "text");
  assert.ok(!("structuredContent" in text.result) && !("_meta" in text.result));
  const list = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ledger_search", _meta: { ui: { resourceUri: "ui://ledger/evidence-v1.html" } } }] } };
  assert.equal(webSafeMessage(list, "rich").result.tools[0]._meta.ui.resourceUri, "ui://ledger/evidence-v1.html", "rich keeps the card on the tool");
  assert.equal(webSafeMessage(list, "text").result.tools[0]._meta, undefined);
  assert.equal(webResultMode({ LEDGER_HTTP_RESULTS: "rich" } as any), "rich");
  assert.equal(webResultMode({} as any), "text", "text-only is the default");
  ok("LEDGER_HTTP_RESULTS=rich keeps the evidence card (tool _meta, structuredContent, result _meta) and reduces content items to type and text; text-only stays the default");
}

await client.close();
await new Promise<void>((r) => server.close(() => r()));
console.log(`selftest-http: ok (${step} checks) — tmp ${tmp}`);
