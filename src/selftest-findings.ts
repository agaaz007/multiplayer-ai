import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initLedger, record, recordDraft, getById, loadAll, proposeFinding, reviewFinding, parseWindow, type Config } from "./store.js";
import { objectVersion, resolveAccepted } from "./authority.js";
import { brief, renderFull, search } from "./query.js";
import { pendingDrafts } from "./extract.js";
import { handleHook, loadJournal } from "./hooks.js";
import { createMcpServer } from "./mcp.js";

/**
 * Query-grain findings (dec-20260917 bind-or-new): an agent proposes a finding at query grain as a
 * PROPOSED draft; a person accepts (a new stable finding supersedes it) or discards (kept as a
 * discarded cut). Git ledger in a temp dir, LEDGER_CONFIG_DIR temp, no Postgres: session binding is
 * exercised through the explicit investigation_record_id path; the bound-session path needs the
 * continuity database and is covered by the investigations selftest.
 */
if (!process.env.LEDGER_SELFTEST) process.env.LEDGER_SELFTEST = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-findings-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";
delete process.env.LEDGER_CONTINUITY_DB;
const cfg: Config = { ledger_dir: path.join(tmp, "ledger"), author: "agaaz", git_sync: false };
initLedger(cfg.ledger_dir, "agaaz");

const get = (id: string) => { const o = getById(cfg, id); assert.ok(o, `missing ${id}`); return o; };
const sid = "findings-selftest-session";
const RID = "3f2a9c1e-4b7d-4e8f-9a01-2b3c4d5e6f70";
// three data-tool calls this session ran, journalled exactly as the PostToolUse hook does
for (const call of ["callA", "callB", "callC"]) {
  handleHook("PostToolUse", { session_id: sid, tool_name: "mcp__mixpanel__query", tool_use_id: call, tool_input: { sql: `select '${call}'` }, tool_response: { result: [] } });
}
const qA = "q:callA", qB = "q:callB", qC = "q:callC";
assert.ok(loadJournal(sid).entries.some((e) => e.kind === "query" && e.evidence_id === qA), "journal has the query evidence");

try {
  // ---------- parseWindow ----------
  assert.deepEqual(parseWindow({ from: "2026-08-01", to: "2026-08-31" }), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(parseWindow("2026-08-01..2026-08-31"), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(parseWindow("2026-08-31 to 2026-08-01"), { from: "2026-08-01", to: "2026-08-31" }, "dates are ordered");
  assert.deepEqual(parseWindow("2026-08-15"), { from: "2026-08-15", to: "2026-08-15" }, "one date is a one-day window");
  assert.equal(parseWindow("last 7 days"), null, "no dates are never invented");

  // ---------- propose: a PROPOSED draft with the mapped fields ----------
  record(cfg, { type: "definition", fields: { title: "Trial-start conversion", metric: "trial_start_cvr", formula: "trial starts / paywall impressions", source: "mixpanel", owner: "agaaz", valid_from: "2026-08-01" } });
  const p = proposeFinding(cfg, { population: "Android IN users shown subscription_paywall", metric: "trial_start_cvr", window: "2026-08-20..2026-08-31", result: "12.4% (n=41,200)", query_ref: qA, investigation_record_id: RID, caveats: ["single pull"], source: "mcp__mixpanel__query" }, { session: sid });
  const draft = get(p.id);
  assert.equal(draft.status, "draft");
  assert.equal(draft.author, "agaaz");
  assert.equal(draft.fields.stance, "PROPOSED");
  assert.equal(draft.fields.query_ref, qA);
  assert.equal(draft.fields.investigation_record_id, RID);
  assert.equal(draft.fields.population, "Android IN users shown subscription_paywall");
  assert.equal(draft.fields.metric, "trial_start_cvr");
  assert.equal(draft.fields.window, "2026-08-20..2026-08-31");
  assert.deepEqual(draft.fields.data_window, { from: "2026-08-20", to: "2026-08-31" }, "free-text window mapped into data_window");
  assert.equal(draft.fields.result, "12.4% (n=41,200)");
  assert.equal((draft.fields.inputs as any[])[0].population, "Android IN users shown subscription_paywall");
  assert.equal((draft.fields.inputs as any[])[0].source, "mcp__mixpanel__query");
  assert.deepEqual(draft.fields.definitions_used, ["trial_start_cvr"], "metric matching a definition fills definitions_used");
  assert.deepEqual(draft.fields.caveats, ["single pull"]);
  assert.deepEqual(draft.fields.capture_coverage, [{ session_id: sid, evidence_ids: [qA] }]);
  assert.equal(draft.fields.capture_method, "query_grain_proposal");
  assert.match(String(draft.fields.capture_reason), new RegExp(`${qA}.*${RID}`));
  assert.equal(draft.title, `trial_start_cvr · Android IN users shown subscription_paywall · 2026-08-20..2026-08-31: 12.4% (n=41,200)`);
  assert.equal(p.content_version, objectVersion(draft), "propose hands back the draft's content_version");
  assert.ok(pendingDrafts(cfg).some((d) => d.id === p.id), "ledger drafts lists the proposal");
  const rendered = renderFull(draft);
  assert.match(rendered, /\*\*stance\*\*: PROPOSED/); assert.match(rendered, new RegExp(`\\*\\*query_ref\\*\\*: ${qA}`)); assert.match(rendered, new RegExp(`\\*\\*investigation_record_id\\*\\*: ${RID}`));
  const b = brief(cfg, { days: 14 });
  assert.match(b, /\[proposed\] finding fnd-/); assert.ok(b.includes(`investigation ${RID}, query ${qA}`), "brief names the investigation and query_ref");
  assert.throws(() => proposeFinding(cfg, { population: "x", metric: "m", window: "w", result: "r", query_ref: "callA", investigation_record_id: RID }, { session: sid }), /exactly as printed/);
  assert.throws(() => proposeFinding(cfg, { population: "x", metric: "m", window: "w", result: "r", query_ref: qA }, { session: "" }), /caller session/);

  // ---------- accept: a NEW stable finding by cfg.author; the draft ends superseded ----------
  const fakeArtifact = { artifact_id: "9d5a1c2e-7f30-4b6a-8c9d-0e1f2a3b4c5d", sha256: "a".repeat(64) };
  assert.throws(() => reviewFinding(cfg, p.id, "accept", { actor: "claude-agent" }), /person's act/);
  const acc = reviewFinding(cfg, p.id, "accept", { actor: "agaaz", queryEvidence: fakeArtifact });
  assert.equal(acc.action, "accept"); assert.equal(acc.by, "agaaz"); assert.ok(acc.id && acc.id !== p.id);
  const accepted = get(acc.id!);
  assert.equal(accepted.status, "stable"); assert.equal(accepted.author, "agaaz");
  assert.equal(accepted.fields.stance, "accepted"); assert.equal(accepted.supersedes, p.id);
  assert.equal(accepted.fields.query_ref, qA); assert.equal(accepted.fields.investigation_record_id, RID);
  assert.deepEqual(accepted.fields.data_window, { from: "2026-08-20", to: "2026-08-31" });
  const a = accepted.fields.acceptance as any;
  assert.equal(a.actor, "agaaz");
  assert.deepEqual(a.expected_predecessor, { id: p.id, version: p.content_version });
  assert.deepEqual(a.evidence_refs[0], { artifact_id: p.id, sha256: p.content_version, role: "review" });
  assert.deepEqual(a.evidence_refs[1], { ...fakeArtifact, role: "query" }, "a located query artifact is pinned with role query");
  assert.equal(acc.content_version, objectVersion(accepted));
  const superseded = get(p.id);
  assert.equal(superseded.status, "deprecated"); assert.equal(superseded.superseded_by, acc.id); assert.equal(superseded.previous_status, "draft");
  assert.equal(objectVersion(superseded), p.content_version, "supersession never changes the draft's content_version");
  assert.deepEqual(resolveAccepted(loadAll(cfg), p.id).current.map((o) => o.id), [acc.id]);
  assert.ok(!pendingDrafts(cfg).some((d) => d.id === p.id), "an accepted proposal leaves the review queue");
  assert.equal(search(cfg, "trial_start_cvr Android", { includeSuperseded: true }).find((h) => h.id === p.id)?.authority_label, `superseded by ${acc.id}`);

  // ---------- accept refuses anything that is not a PROPOSED draft ----------
  assert.throws(() => reviewFinding(cfg, acc.id!, "accept", { actor: "agaaz" }), /not a PROPOSED draft/);
  assert.throws(() => reviewFinding(cfg, p.id, "accept", { actor: "agaaz" }), /not a PROPOSED draft.*already superseded/);
  const plain = recordDraft(cfg, { type: "finding", fields: { title: "Hand-written draft", question: "Anything?", result: "Nothing yet" }, capture: { method: "transcript_fallback", session: sid, reason: "fixture" } });
  assert.throws(() => reviewFinding(cfg, plain.id, "accept", { actor: "agaaz" }), /not a PROPOSED draft/);
  assert.throws(() => reviewFinding(cfg, plain.id, "discard", { actor: "agaaz", reason: "fixture" }), /not a PROPOSED draft/);
  assert.throws(() => reviewFinding(cfg, "fnd-missing", "accept", { actor: "agaaz" }), /not found/);

  // ---------- discard: reason required; kept as a discarded cut ----------
  const p2 = proposeFinding(cfg, { population: "iOS IN users", metric: "trial_start_cvr", window: { from: "2026-08-20", to: "2026-08-31" }, result: "9.1%", query_ref: qB, investigation_record_id: RID }, { session: sid });
  assert.throws(() => reviewFinding(cfg, p2.id, "discard", { actor: "agaaz" }), /non-empty reason/);
  assert.throws(() => reviewFinding(cfg, p2.id, "discard", { actor: "agaaz", reason: "   " }), /non-empty reason/);
  const dis = reviewFinding(cfg, p2.id, "discard", { actor: "agaaz", reason: "duplicate of the Android pull with a wrong platform filter" });
  assert.equal(dis.reason, "duplicate of the Android pull with a wrong platform filter"); assert.equal(dis.by, "agaaz");
  const cut = get(p2.id);
  assert.equal(cut.status, "deprecated"); assert.equal(cut.fields.stance, "discarded"); assert.equal(cut.superseded_by, undefined);
  assert.equal((cut.fields.discarded as any).reason, "duplicate of the Android pull with a wrong platform filter");
  assert.equal((cut.fields.discarded as any).by, "human:agaaz");
  assert.ok(!pendingDrafts(cfg).some((d) => d.id === p2.id), "a discarded cut is not a pending draft");
  assert.ok(!brief(cfg, { days: 14 }).includes(p2.id), "a discarded cut is not in the brief's drafts");
  const hits = search(cfg, "iOS IN users trial_start_cvr", { includeSuperseded: true });
  assert.equal(hits.find((h) => h.id === p2.id)?.authority_label, "discarded cut");
  assert.ok(!search(cfg, "iOS IN users trial_start_cvr").some((h) => h.id === p2.id), "and never a current result");
  assert.throws(() => reviewFinding(cfg, p2.id, "discard", { actor: "agaaz", reason: "again" }), /not a PROPOSED draft/);
  assert.throws(() => reviewFinding(cfg, p2.id, "accept", { actor: "agaaz" }), /stance discarded/);

  // ---------- an unparseable window is kept, and accept asks the person for {from,to} ----------
  const p3 = proposeFinding(cfg, { population: "all users", metric: "dau", window: "last 7 days", result: "184k", query_ref: qC, investigation_record_id: RID }, { session: sid });
  assert.equal(get(p3.id).fields.window, "last 7 days"); assert.equal(get(p3.id).fields.data_window, undefined);
  assert.throws(() => reviewFinding(cfg, p3.id, "accept", { actor: "agaaz" }), /did not map to data_window/);
  assert.equal(get(p3.id).status, "draft", "a refused accept changes nothing");
  const acc3 = reviewFinding(cfg, p3.id, "accept", { actor: "agaaz", window: { from: "2026-09-10", to: "2026-09-16" } });
  assert.deepEqual(get(acc3.id!).fields.data_window, { from: "2026-09-10", to: "2026-09-16" });
  assert.equal(get(acc3.id!).fields.window, "last 7 days", "the stated window travels with the accepted finding");

  // ---------- MCP surface: propose + review, capture_ack shapes, refusals ----------
  const server = createMcpServer(cfg);
  const client = new Client({ name: "findings-test", version: "1" });
  const [t1, t2] = InMemoryTransport.createLinkedPair(); await server.connect(t1); await client.connect(t2);
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const n of ["ledger_propose_finding", "ledger_review_finding"]) assert.ok(names.has(n), `${n} is exposed without a continuity database`);
  for (const n of ["ledger_investigations", "ledger_investigation_bind", "ledger_investigation_new"]) assert.ok(!names.has(n), `${n} needs the continuity database`);

  // a fourth call for the MCP round trip
  handleHook("PostToolUse", { session_id: sid, tool_name: "mcp__mixpanel__query", tool_use_id: "callD", tool_input: { sql: "select 'D'" }, tool_response: { result: [] } });
  const unbound = await client.callTool({ name: "ledger_propose_finding", arguments: { population: "x", metric: "m", window: "2026-09-01..2026-09-02", result: "1", query_ref: "q:callD", session_id: sid } }) as any;
  assert.ok(unbound.isError, "an unbound session is refused"); assert.match(unbound.content[0].text, /Bind or declare new first/);
  assert.equal(loadAll(cfg).filter((o) => o.fields.query_ref === "q:callD").length, 0, "no orphan finding was created");
  const unknownRef = await client.callTool({ name: "ledger_propose_finding", arguments: { population: "x", metric: "m", window: "2026-09-01..2026-09-02", result: "1", query_ref: "q:never-ran", investigation_record_id: RID, session_id: sid } }) as any;
  assert.ok(unknownRef.isError); assert.match(unknownRef.content[0].text, /unknown evidence IDs|no retained source/);
  const noSession = await client.callTool({ name: "ledger_propose_finding", arguments: { population: "x", metric: "m", window: "2026-09-01..2026-09-02", result: "1", query_ref: "q:callD", investigation_record_id: RID } }) as any;
  assert.ok(noSession.isError); assert.match(noSession.content[0].text, /session/);

  const proposed = await client.callTool({ name: "ledger_propose_finding", arguments: { population: "Android IN users", metric: "paywall_impressions", window: "2026-09-01..2026-09-07", result: "118,900", query_ref: "q:callD", investigation_record_id: RID, session_id: sid } }) as any;
  assert.ok(!proposed.isError, JSON.stringify(proposed));
  const sc = proposed.structuredContent;
  assert.equal(sc.receipt.action, "saved"); assert.match(sc.receipt.message, /Saved draft finding/);
  assert.equal(sc.stance, "PROPOSED"); assert.equal(sc.investigation_record_id, RID); assert.equal(sc.record_id, undefined, "no top-level record_id: that key marks an investigation bind");
  assert.deepEqual(sc.capture_ack, { schema: "ledger-capture/v1", action: "record", status: "pending_review", coverage: [{ session_id: sid, evidence_ids: ["q:callD"] }], record_id: sc.receipt.record_id });
  assert.equal(sc.content_version, objectVersion(get(sc.receipt.record_id)));
  assert.match(proposed.content[0].text, /Not accepted: a person accepts/);
  assert.equal((get(sc.receipt.record_id).fields.inputs as any[])[0].source, "mcp__mixpanel__query", "source read from the session journal");
  assert.ok(loadJournal(sid).entries.some((e) => e.kind === "record" && e.id === sc.receipt.record_id && e.capture_status === "pending_review"), "the journal shows q:callD as pending_review");

  const reviewed = await client.callTool({ name: "ledger_review_finding", arguments: { id: sc.receipt.record_id, action: "accept" } }) as any;
  assert.ok(!reviewed.isError, JSON.stringify(reviewed));
  assert.match(reviewed.content[0].text, /Accepted by agaaz/); assert.match(reviewed.content[0].text, /not the agent/);
  assert.match(reviewed.content[0].text, /pins the reviewed draft's content_version only/, "without a continuity database the query artifact is not claimed");
  const rs = reviewed.structuredContent;
  assert.equal(rs.review.by, "agaaz"); assert.equal(rs.review.stance, "accepted"); assert.equal(rs.review.acceptance.evidence_refs.length, 1);
  assert.equal(rs.capture_ack.status, "recorded"); assert.equal(rs.capture_ack.record_id, rs.review.id);
  assert.equal(get(rs.review.id).status, "stable"); assert.equal(get(sc.receipt.record_id).superseded_by, rs.review.id);
  assert.ok(loadJournal(sid).entries.some((e) => e.kind === "record" && e.id === rs.review.id && e.capture_status === "recorded"), "acceptance settles q:callD as recorded");

  const again = await client.callTool({ name: "ledger_review_finding", arguments: { id: sc.receipt.record_id, action: "accept" } }) as any;
  assert.ok(again.isError); assert.match(again.content[0].text, /not a PROPOSED draft/);
  const noReason = await client.callTool({ name: "ledger_review_finding", arguments: { id: p3.id, action: "discard" } }) as any;
  assert.ok(noReason.isError, "discard without a reason is refused before touching anything");

  handleHook("PostToolUse", { session_id: sid, tool_name: "mcp__mixpanel__query", tool_use_id: "callE", tool_input: { sql: "select 'E'" }, tool_response: { result: [] } });
  const p5 = proposeFinding(cfg, { population: "web users", metric: "dau", window: "2026-09-01..2026-09-07", result: "3k", query_ref: "q:callE", investigation_record_id: RID }, { session: sid });
  const discarded = await client.callTool({ name: "ledger_review_finding", arguments: { id: p5.id, action: "discard", reason: "exploration only; the web population is out of scope" } }) as any;
  assert.ok(!discarded.isError, JSON.stringify(discarded));
  assert.match(discarded.content[0].text, /^Discarded cut kept: exploration only; the web population is out of scope/);
  assert.equal(discarded.structuredContent.review.stance, "discarded");
  assert.equal(discarded.structuredContent.capture_ack.status, "dismissed");
  assert.equal(get(p5.id).fields.stance, "discarded");
  assert.equal(search(cfg, "web users dau", { includeSuperseded: true }).find((h) => h.id === p5.id)?.authority_label, "discarded cut");

  await client.close();
  console.log("findings: propose (mapped fields, PROPOSED, query_ref, investigation, pending_review ack), accept (new stable by the person, supersedes + acceptance, draft superseded), refusals, discard (reason required, discarded cut kept and labelled), drafts listing and MCP round trip passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
