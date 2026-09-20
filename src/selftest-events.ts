import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamTranscript, claudeCompactSummaryText, samePath, COMPACTION_TEXT_MAX, type NormEvent } from "./continuity/events.js";

/**
 * Transcript emitter tests. Fixtures only: hand-built JSONL lines in a temp
 * directory, streamed from a byte offset the way the helper does it. No
 * database, no network. Covers compaction summaries in both harnesses, Codex
 * structured completion events (patch_apply_end, exec_command_end,
 * mcp_tool_call_end) and their dedupe / late-arrival rules, split-line and
 * rotation handling, and the behaviors that were already there.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-events-"));
const cl = (o: unknown) => JSON.stringify(o);
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const kinds = (evs: NormEvent[], k: string) => evs.filter((e) => e.kind === k);
const ids = (evs: NormEvent[]) => evs.map((e) => e.producer_event_id);
const codexFile = (name: string) => path.join(tmp, `rollout-2026-09-08T02-00-00-${name}.jsonl`);
const claudeFile = (name: string) => path.join(tmp, `${name}.jsonl`);

// ---------- 1. Claude compact summary → one compaction event, never an instruction ----------
{
  const f = claudeFile("11111111-1111-1111-1111-111111111111");
  const body = "1. **Primary Request and Intent:** ship the banner\n2. **Pending:** run the 360px check\nkey token sk-abcdefghijklmnopqrstuvwxyz0123";
  const tagged = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<summary>\n${body}\n</summary>\n\nContinue the conversation from where it left off without asking the user any further questions.`;
  const plain = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${body}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.`;
  fs.writeFileSync(f, [
    cl({ type: "system", subtype: "compact_boundary", timestamp: "2026-09-08T02:00:00Z", sessionId: "s1", cwd: "/x", gitBranch: "main", compactMetadata: { trigger: "auto", preTokens: 947102, postTokens: 14515, durationMs: 1440 }, content: "Conversation compacted" }),
    cl({ type: "user", isCompactSummary: true, timestamp: "2026-09-08T02:00:01Z", sessionId: "s1", message: { role: "user", content: tagged } }),
    cl({ type: "user", isCompactSummary: true, timestamp: "2026-09-08T02:00:02Z", sessionId: "s1", message: { role: "user", content: [{ type: "text", text: plain }] } }),
    cl({ type: "user", timestamp: "2026-09-08T02:00:03Z", sessionId: "s1", message: { role: "user", content: plain } }), // flag missing: prefix rule must still catch it
    cl({ type: "user", timestamp: "2026-09-08T02:00:04Z", sessionId: "s1", message: { role: "user", content: "now fix the 360px layout" } }),
  ].join("\n") + "\n");
  const r = streamTranscript(f, 0, "claude");
  const comp = kinds(r.events, "compaction");
  assert.equal(comp.length, 3, `boundary + two summaries: ${ids(comp).join(",")}`);
  const [boundary, fromTag, fromPlain] = comp;
  assert.equal(boundary.payload.source, "claude_compact_boundary");
  assert.equal(boundary.payload.text, undefined, "boundary carries no text");
  assert.equal(boundary.payload.trigger, "auto");
  assert.equal(boundary.payload.pre_tokens, 947102);
  assert.equal(fromTag.payload.source, "claude_compact_summary");
  assert.equal(fromTag.producer_event_id, `L${Buffer.byteLength(cl({ type: "system", subtype: "compact_boundary", timestamp: "2026-09-08T02:00:00Z", sessionId: "s1", cwd: "/x", gitBranch: "main", compactMetadata: { trigger: "auto", preTokens: 947102, postTokens: 14515, durationMs: 1440 }, content: "Conversation compacted" })) + 1}`, "summary id is the byte offset of its line");
  assert.ok(String(fromTag.payload.text).startsWith("1. **Primary Request") && String(fromTag.payload.text).endsWith("[REDACTED_API_KEY]"), `text is the inside of <summary>, redacted: ${String(fromTag.payload.text).slice(0, 60)}…`);
  assert.equal(fromTag.payload.chars, body.length, "chars is the extracted summary length before redaction");
  assert.equal(fromTag.payload.raw_chars, tagged.length);
  assert.ok(String(fromPlain.payload.text).startsWith("1. **Primary Request") && !String(fromPlain.payload.text).includes("Continue the conversation"), "preamble and trailer stripped when there is no <summary> block");
  const instr = kinds(r.events, "instruction.added");
  assert.equal(instr.length, 1, `only the human prompt is an instruction: ${JSON.stringify(instr.map((e) => e.payload.text))}`);
  assert.equal(instr[0].payload.text, "now fix the 360px layout");
  assert.equal(r.cwd, "/x"); assert.equal(r.branch, "main"); assert.equal(r.session_id, "s1");
  ok("Claude compact summary → one compaction event (source, text from <summary>, chars); zero instruction.added for it");
  ok("Claude compact_boundary → compaction with source and metadata, no text");
}

// ---------- 1b. unit: summary extraction and the cap ----------
{
  assert.equal(claudeCompactSummaryText("<summary>\n a \n</summary>"), "a");
  assert.equal(claudeCompactSummaryText("This session is being continued…\n\nSummary:\nBODY\n\nContinue the conversation from where it left off."), "BODY");
  assert.equal(claudeCompactSummaryText("no markers at all"), "no markers at all");
  const f = claudeFile("22222222-2222-2222-2222-222222222222");
  const huge = "y".repeat(COMPACTION_TEXT_MAX + 5000);
  fs.writeFileSync(f, cl({ type: "user", isCompactSummary: true, timestamp: "2026-09-08T02:00:01Z", message: { role: "user", content: `<summary>${huge}</summary>` } }) + "\n");
  const c = kinds(streamTranscript(f, 0, "claude").events, "compaction")[0];
  assert.equal(String(c.payload.text).length, COMPACTION_TEXT_MAX, "capped at COMPACTION_TEXT_MAX");
  assert.equal(c.payload.chars, huge.length, "chars reports the uncapped length");
  ok(`compaction text capped at ${COMPACTION_TEXT_MAX} chars; chars keeps the original length`);
}

// ---------- 2. Codex compacted: text from replacement_history, or empty with item count ----------
{
  const f = codexFile("aaaaaaaa-0000-0000-0000-000000000001");
  const withSummary = { type: "compacted", timestamp: "2026-09-08T02:00:01Z", payload: { message: "", window_number: 1, replacement_history: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "<system_instruction>injected</system_instruction>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "add the banner" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Banner added; the 360px test still fails." }] },
    { type: "summary", text: "Next: fix the 360px CTA overlap." },
    { type: "compaction", encrypted_content: "opaque==", id: "cmp_1" },
  ] } };
  const empty = { type: "compacted", timestamp: "2026-09-08T02:00:02Z", payload: { message: "", replacement_history: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "add the banner" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "AGENTS.md" }] },
    { type: "compaction", encrypted_content: "opaque==" },
  ] } };
  const withMessage = { type: "compacted", timestamp: "2026-09-08T02:00:03Z", payload: { message: "Summary written by the harness.", replacement_history: [] } };
  fs.writeFileSync(f, [
    cl({ type: "session_meta", timestamp: "2026-09-08T02:00:00Z", payload: { id: "aaaaaaaa-0000-0000-0000-000000000001", cwd: "/repo" } }),
    cl(withSummary), cl({ type: "event_msg", timestamp: "2026-09-08T02:00:01Z", payload: { type: "context_compacted" } }), cl(empty), cl(withMessage),
  ].join("\n") + "\n");
  const r = streamTranscript(f, 0, "codex");
  const comp = kinds(r.events, "compaction");
  assert.equal(comp.length, 4, ids(comp).join(","));
  assert.equal(comp[0].payload.source, "codex_compacted");
  assert.equal(comp[0].payload.text, "Banner added; the 360px test still fails.\n\nNext: fix the 360px CTA overlap.");
  assert.equal(comp[0].payload.text_source, "replacement_history");
  assert.equal(comp[0].payload.items, 5);
  assert.equal(comp[0].payload.window_number, 1);
  assert.equal(comp[1].payload.source, "codex_context_compacted");
  assert.equal(comp[2].payload.text, ""); assert.equal(comp[2].payload.chars, 0); assert.equal(comp[2].payload.items, 3); assert.equal(comp[2].payload.text_source, "none");
  assert.equal(comp[3].payload.text, "Summary written by the harness."); assert.equal(comp[3].payload.text_source, "message");
  assert.equal(kinds(r.events, "instruction.added").length, 0, "prompts inside replacement_history are not re-emitted as instructions");
  assert.deepEqual(r.unknown, {}, "compacted / context_compacted are known shapes");
  ok("Codex compacted → compaction with text from assistant/summary items; empty → text \"\", chars 0, items count; message wins when present");
}

// ---------- 3. Codex patch_apply_end: one file.changed per path; no duplicate with apply_patch input ----------
{
  const f = codexFile("aaaaaaaa-0000-0000-0000-000000000002");
  const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch";
  fs.writeFileSync(f, [
    cl({ type: "session_meta", timestamp: "2026-09-08T02:00:00Z", payload: { id: "aaaaaaaa-0000-0000-0000-000000000002", cwd: "/repo" } }),
    // direct apply_patch: request (fallback names both files) → patch_apply_end (same call_id, names both) → output
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:01.000Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call_p1", input: patch } }),
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:01.050Z", payload: { type: "patch_apply_end", call_id: "call_p1", turn_id: "t1", success: true, status: "completed", stdout: "Success.", stderr: "", changes: {
      "/repo/src/app.ts": { type: "update", unified_diff: "-a\n+b", move_path: null },
      "/repo/src/new.ts": { type: "add", content: "x" },
    } } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:01.060Z", payload: { type: "custom_tool_call_output", call_id: "call_p1", output: "Success. Updated the following files:\nM src/app.ts\nA src/new.ts" } }),
    // exec-wrapped apply_patch: request is `exec` JS (no fallback), end carries an exec-<uuid> id → sole source
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:05.000Z", payload: { type: "custom_tool_call", name: "exec", call_id: "call_x1", input: 'const patch = "*** Begin Patch\\n*** Update File: src/app.ts\\n…"; await tools.apply_patch({patch});' } }),
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:05.070Z", payload: { type: "patch_apply_end", call_id: "exec-1111-2222", turn_id: "t1", success: false, status: "failed", stdout: "", stderr: "hunk failed", changes: { "/repo/src/app.ts": { type: "update", unified_diff: "" } } } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:05.080Z", payload: { type: "custom_tool_call_output", call_id: "call_x1", output: [{ type: "input_text", text: "Script completed" }] } }),
    // a later direct apply_patch to the same file, outside the 5 s window and with its own call_id → its own events
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:20.000Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call_p2", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-b\n+c\n*** End Patch" } }),
  ].join("\n") + "\n");
  const r = streamTranscript(f, 0, "codex");
  const fc = kinds(r.events, "file.changed");
  const byPath = (p: string) => fc.filter((e) => e.payload.path === p || e.payload.path === "/repo/" + p);
  assert.equal(byPath("src/app.ts").filter((e) => e.call_id === "call_p1").length, 1, `one event for src/app.ts in call_p1: ${JSON.stringify(byPath("src/app.ts"))}`);
  assert.equal(byPath("src/new.ts").length, 1, "one event for src/new.ts");
  const first = fc.filter((e) => e.call_id === "call_p1");
  assert.equal(first.length, 2, `two file.changed for the two-path patch_apply_end: ${ids(first).join(",")}`);
  assert.ok(first.every((e) => e.payload.source === "patch_apply_end" && e.payload.success === true && e.producer_event_id.startsWith("L")), "patch_apply_end preferred over the input fallback");
  assert.deepEqual(first.map((e) => e.payload.change), ["update", "add"]);
  assert.ok(!ids(r.events).some((i) => i.startsWith("call_p1:file:")), "fallback events withdrawn");
  const wrapped = fc.filter((e) => e.call_id === "exec-1111-2222");
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].payload.success, false); assert.equal(wrapped[0].payload.status, "failed");
  assert.equal(wrapped[0].payload.enclosing_call_id, "call_x1", "exec- sub-call names its enclosing exec call");
  const later = fc.filter((e) => e.call_id === "call_p2");
  assert.equal(later.length, 1); assert.equal(later[0].producer_event_id, `call_p2:file:${later[0].producer_event_id.split(":").pop()}`); assert.equal(later[0].payload.source, "apply_patch_input");
  assert.equal(kinds(r.events, "tool.requested").length, 3); assert.equal(kinds(r.events, "tool.finished").length, 2);
  assert.ok(samePath("/repo/src/app.ts", "src/app.ts", "/repo") && samePath("src/app.ts", "/repo/src/app.ts") && !samePath("/repo/src/app.ts", "src/other.ts", "/repo") && !samePath("/repo/x/app.ts", "src/app.ts"));
  ok("Codex patch_apply_end → one file.changed per path; same-turn apply_patch input for the same file is not duplicated; exec-wrapped patch is the sole source");
}

// ---------- 4. exec_command_end / mcp_tool_call_end: attached in-read, tool.result_meta across reads ----------
{
  const f = codexFile("aaaaaaaa-0000-0000-0000-000000000003");
  const L = [
    cl({ type: "session_meta", timestamp: "2026-09-08T02:00:00Z", payload: { id: "aaaaaaaa-0000-0000-0000-000000000003", cwd: "/repo" } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:01.000Z", payload: { type: "function_call", name: "exec_command", call_id: "call_e1", arguments: cl({ cmd: "npm test" }) } }),
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:03.200Z", payload: { type: "exec_command_end", call_id: "call_e1", turn_id: "t1", exit_code: 1, status: "failed", duration: { secs: 2, nanos: 150000000 }, command: ["npm", "test"], cwd: "/repo", aggregated_output: "1 failing" } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:03.210Z", payload: { type: "function_call_output", call_id: "call_e1", output: "1 failing" } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:04.000Z", payload: { type: "function_call", name: "exec_command", call_id: "call_e2", arguments: cl({ cmd: "npm run build" }) } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:09.000Z", payload: { type: "function_call_output", call_id: "call_e2", output: "built" } }),
    // --- read boundary here: the end event for e2 lands after its output was already stored ---
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:09.100Z", payload: { type: "exec_command_end", call_id: "call_e2", exit_code: 0, status: "completed", duration: { secs: 5, nanos: 0 } } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:10.000Z", payload: { type: "function_call", name: "mcp__ledger__ledger_search", call_id: "call_m1", arguments: cl({ query: "banner" }) } }),
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:10.400Z", payload: { type: "mcp_tool_call_end", call_id: "call_m1", duration: { secs: 0, nanos: 400000000 }, invocation: { server: "ledger", tool: "ledger_search", arguments: { query: "banner" } }, result: { Ok: { content: [{ type: "text", text: "3 results" }] } } } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:10.410Z", payload: { type: "function_call_output", call_id: "call_m1", output: "3 results" } }),
    // MCP call inside the exec JS wrapper: exec- id, no matching request, Err result → standalone meta with error
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:11.000Z", payload: { type: "custom_tool_call", name: "exec", call_id: "call_x2", input: 'await tools.mcp__computer_use__get_app_state({})' } }),
    cl({ type: "event_msg", timestamp: "2026-09-08T02:00:13.000Z", payload: { type: "mcp_tool_call_end", call_id: "exec-9999", duration: { secs: 120, nanos: 0 }, invocation: { server: "computer-use", tool: "get_app_state", arguments: {} }, result: { Err: "tool call error: timed out awaiting tools/call after 120s" } } }),
    cl({ type: "response_item", timestamp: "2026-09-08T02:00:13.010Z", payload: { type: "custom_tool_call_output", call_id: "call_x2", output: "Script failed" } }),
  ];
  fs.writeFileSync(f, L.slice(0, 6).join("\n") + "\n");
  const r1 = streamTranscript(f, 0, "codex");
  const e1 = r1.events.find((e) => e.producer_event_id === "call_e1:finished")!;
  assert.equal(e1.payload.exit_code, 1); assert.equal(e1.payload.duration_ms, 2150); assert.equal(e1.payload.status, "failed"); assert.equal(e1.payload.is_error, true); assert.equal(e1.payload.meta_source, "exec_command_end");
  assert.equal(kinds(r1.events, "tool.result_meta").length, 0, "end event before the output in the same read → attached, no meta event");
  assert.ok(r1.events.find((e) => e.producer_event_id === "call_e2:finished") && !("exit_code" in r1.events.find((e) => e.producer_event_id === "call_e2:finished")!.payload), "e2 finished without its end event yet");
  fs.writeFileSync(f, L.join("\n") + "\n");
  const r2 = streamTranscript(f, r1.offset, "codex");
  const meta = kinds(r2.events, "tool.result_meta");
  assert.deepEqual(ids(meta), ["call_e2:meta", "exec-9999:meta"], ids(meta).join(","));
  assert.equal(meta[0].call_id, "call_e2");
  assert.deepEqual(meta[0].payload, { call_id: "call_e2", meta_source: "exec_command_end", exit_code: 0, duration_ms: 5000, status: "completed" });
  assert.equal(meta[1].payload.success, false); assert.match(String(meta[1].payload.error), /timed out/); assert.equal(meta[1].payload.duration_ms, 120000); assert.equal(meta[1].payload.mcp_tool, "get_app_state"); assert.equal(meta[1].payload.enclosing_call_id, undefined); assert.equal(meta[1].payload.invocation_correlation, "unknown");
  const m1 = r2.events.find((e) => e.producer_event_id === "call_m1:finished")!;
  assert.equal(m1.payload.duration_ms, 400); assert.equal(m1.payload.mcp_server, "ledger"); assert.equal(m1.payload.success, true); assert.equal(m1.payload.meta_source, "mcp_tool_call_end"); assert.equal(m1.payload.is_error, undefined);
  assert.equal(new Set(ids([...r1.events, ...r2.events])).size, r1.events.length + r2.events.length, "no id reused across the two reads");
  ok("exec_command_end matched to a call → exit_code/duration on tool.finished; after an earlier read → tool.result_meta <call_id>:meta");
  ok("mcp_tool_call_end: same pattern; Err → success false with the error; MCP inner calls retain unknown correlation instead of guessing a wrapper");
}

// ---------- 5. split line across two writes; rotation ----------
{
  const f = codexFile("aaaaaaaa-0000-0000-0000-000000000004");
  const l1 = cl({ type: "session_meta", timestamp: "2026-09-08T02:00:00Z", payload: { id: "aaaaaaaa-0000-0000-0000-000000000004", cwd: "/répo/ünïcode" } });
  const l2 = cl({ type: "response_item", timestamp: "2026-09-08T02:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "añadir un banner — 🎉 {\"nested\": \"json, with, commas\"}" }] } });
  const l3 = cl({ type: "response_item", timestamp: "2026-09-08T02:00:02Z", payload: { type: "custom_tool_call", name: "exec", call_id: "c9", input: 'await tools.exec_command({cmd:"ls"})' } });
  const cut = Buffer.byteLength(l2, "utf8") - 25; // mid-JSON, inside the string
  const l2buf = Buffer.from(l2, "utf8");
  fs.writeFileSync(f, Buffer.concat([Buffer.from(l1 + "\n", "utf8"), l2buf.subarray(0, cut)]));
  const r1 = streamTranscript(f, 0, "codex");
  assert.equal(r1.events.length, 1, "only the complete line is parsed"); assert.equal(r1.events[0].kind, "session.started");
  assert.equal(r1.offset, Buffer.byteLength(l1, "utf8") + 1, "offset stops before the partial line");
  assert.deepEqual(r1.unknown, {}, "the fragment is not counted as unparseable");
  fs.appendFileSync(f, Buffer.concat([l2buf.subarray(cut), Buffer.from("\n" + l3 + "\n", "utf8")]));
  const r2 = streamTranscript(f, r1.offset, "codex");
  const instr = kinds(r2.events, "instruction.added");
  assert.equal(instr.length, 1); assert.equal(instr[0].payload.text, "añadir un banner — 🎉 {\"nested\": \"json, with, commas\"}");
  assert.equal(instr[0].producer_event_id, `L${r1.offset}`, "id is the byte offset of the line start");
  assert.equal(kinds(r2.events, "tool.requested")[0].producer_event_id, "c9:requested");
  assert.equal(r2.offset, fs.statSync(f).size);
  assert.equal(new Set(ids([...r1.events, ...r2.events])).size, r1.events.length + r2.events.length, "no duplicate ids");
  const full = streamTranscript(f, 0, "codex");
  assert.deepEqual(ids(full.events), ids([...r1.events, ...r2.events]), "one read and two reads yield the same ids");
  assert.equal(streamTranscript(f, r2.offset, "codex").events.length, 0, "nothing new → nothing emitted");
  // rotation: file rewritten shorter than the stored offset → read restarts from 0
  fs.writeFileSync(f, l1 + "\n");
  const r3 = streamTranscript(f, r2.offset, "codex");
  assert.equal(r3.events.length, 1); assert.equal(r3.offset, Buffer.byteLength(l1, "utf8") + 1);
  ok("split line across two reads → parsed once with the right offset and id, no duplicates, multibyte-safe; shrunken file restarts from 0");
}

// ---------- 6. existing behaviors ----------
{
  const f = codexFile("aaaaaaaa-0000-0000-0000-000000000005");
  const long = "x".repeat(5000);
  fs.writeFileSync(f, [
    cl({ timestamp: "2026-09-08T02:00:00Z", type: "session_meta", payload: { id: "aaaaaaaa-0000-0000-0000-000000000005", cwd: "/x" } }),
    cl({ timestamp: "2026-09-08T02:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } }),
    cl({ timestamp: "2026-09-08T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a banner" }] } }),
    cl({ timestamp: "2026-09-08T02:00:02Z", type: "event_msg", payload: { type: "user_message", message: "Add a banner" } }), // legacy duplicate of the same prompt
    cl({ timestamp: "2026-09-08T02:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: `await tools.exec_command(${JSON.stringify({cmd: 'psql -c "select 1"'})})` } }),
    cl({ timestamp: "2026-09-08T02:00:04Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: long }] } }),
    cl({ timestamp: "2026-09-08T02:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
    cl({ timestamp: "2026-09-08T02:00:06Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }),
    cl({ timestamp: "2026-09-08T02:00:07Z", type: "event_msg", payload: { type: "brand_new_shape" } }),
  ].join("\n") + "\n");
  const r = streamTranscript(f, 0, "codex");
  const instr = kinds(r.events, "instruction.added");
  assert.equal(instr.length, 1, "developer role excluded; legacy + new shape of one prompt counted once");
  const req = r.events.find((e) => e.producer_event_id === "c1:requested")!;
  assert.equal(req.payload.input, 'psql -c "select 1"', "exec wrapper: shell extracted from the JS source");
  assert.equal(req.payload.is_data_tool, true, "psql in the extracted shell counts as data work");
  const fin = r.events.find((e) => e.producer_event_id === "c1:finished")!;
  assert.ok(String(fin.payload.output_preview).length <= 1200 && typeof fin.payload._full === "string" && (fin.payload._full as string).length === 5000, "long output: preview + _full staged for the artifact");
  assert.equal(kinds(r.events, "assistant.message").length, 1);
  assert.equal(kinds(r.events, "capture.gap")[0].payload.kind, "turn_aborted");
  assert.deepEqual(r.unknown, { "event_msg/brand_new_shape": 1 }, "unknown shapes are counted, not dropped silently");
  ok("Codex: exec wrapper shell extraction, developer role excluded, distinct request/finished ids, _full staged, turn_aborted gap, unknown shapes counted");

  const g = claudeFile("33333333-3333-3333-3333-333333333333");
  fs.writeFileSync(g, [
    cl({ type: "user", isSidechain: true, timestamp: "2026-09-08T02:00:00Z", sessionId: "s3", cwd: "/x", message: { role: "user", content: "Explore the checkout flow" } }),
    cl({ type: "assistant", isSidechain: true, timestamp: "2026-09-08T02:00:01Z", sessionId: "s3", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/x/src/a.ts", old_string: "a", new_string: "b" } }] } }),
    cl({ type: "user", isSidechain: true, timestamp: "2026-09-08T02:00:02Z", sessionId: "s3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] }, toolUseResult: { filePath: "/x/src/a.ts" } }),
    cl({ type: "user", timestamp: "2026-09-08T02:00:03Z", sessionId: "s3", message: { role: "user", content: "<local-command-caveat>Caveat: injected</local-command-caveat>" } }),
  ].join("\n") + "\n");
  const rc = streamTranscript(g, 0, "claude");
  assert.equal(rc.sidechain, true, "sidechain flag set");
  assert.deepEqual(ids(rc.events).filter((i) => i.includes("toolu_1")), ["toolu_1:requested", "toolu_1:file", "toolu_1:finished"]);
  assert.equal(kinds(rc.events, "file.changed").length, 2, "Edit input and toolUseResult.filePath both report the file");
  assert.equal(kinds(rc.events, "instruction.added").length, 1, "injected caveat excluded; thinking never emitted");
  assert.ok(!rc.events.some((e) => JSON.stringify(e.payload).includes("private")), "thinking block content never leaves");
  ok("Claude: sidechain flag, request/file/finished ids distinct, harness-injected text excluded, thinking never emitted");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`selftest-events: ok (${step} checks)`);
