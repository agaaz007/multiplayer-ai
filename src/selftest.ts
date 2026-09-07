import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initLedger, loadConfig, loadAll, record, getById, commitAndPush, pull, recordDraft, discardDraft, ledgerHome, type Config } from "./store.js";
import { findCandidates, parseDrafts, reconcile, pendingDrafts } from "./extract.js";
import { findTranscript, parseTranscript, evidenceText } from "./transcript.js";
import { brief, search, similarFindings, stats, renderFull } from "./query.js";
import { regenerateViews } from "./views.js";
import { agentRulesText, installGuides, upsertHooks, HOOK_EVENTS, isLedgerHookCommand } from "./install.js";
import { handleHook, loadJournal, saveJournal, captureStats, debt } from "./hooks.js";
import { EVIDENCE_URI } from "./evidence.js";
import { readReceipt, savedReceipt, syncReceipt } from "./receipts.js";

const sh = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
const dir = path.join(tmp, "ledger");
process.env.LEDGER_DIR = dir;
process.env.LEDGER_AUTHOR = "agaaz";
process.env.LEDGER_GIT_SYNC = "1";

// keep the real ~/.ledger untouched: initLedger writes config, so point HOME at tmp
process.env.HOME = tmp;
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger"); // never touch the real ~/.ledger

initLedger(dir, "agaaz");
const cfg = loadConfig();
assert.equal(cfg.ledger_dir, dir);

const def = record(cfg, {
  type: "definition",
  fields: {
    title: "Trial to paid conversion",
    metric: "trial_to_paid_cvr",
    formula: "paid_subscriptions_started / trials_started, same cohort by trial start date",
    source: "postgres.subscriptions",
    owner: "agaaz",
    valid_from: "2026-09-01",
    exclusions: ["internal users", "refunded within 24h"],
    tags: ["hiastro"],
  },
});
assert.ok(def.id.startsWith("def-"));

const f1 = record(cfg, {
  type: "finding",
  fields: {
    title: "Trial CVR August",
    question: "What was trial to paid conversion in August for iOS?",
    result: "11.2% (n=4,310 trials)",
    definitions_used: ["trial_to_paid_cvr"],
    data_window: { from: "2026-08-01", to: "2026-08-31" },
    inputs: [{ source: "postgres.subscriptions", population: "trials started in window", filters: "platform='ios', excludes internal users" }],
    method: "Cohort by trial start date; paid within 14 days over trials started.",
    grain: "user",
    query: "select ... where platform='ios'",
    assumptions: [
      { statement: "iOS means App Store, not web checkout", kind: "explicit", if_wrong: "changes_conclusion" },
      { statement: "postgres.subscriptions is complete for August", kind: "implicit", if_wrong: "changes_conclusion", evidence: "ETL log" },
    ],
    alternatives_considered: ["attribution by payment date: rejected, mixes cohorts"],
    limitations: ["observational"],
    confidence: "high",
    confidence_basis: "n=4,310; completeness checked",
    tags: ["hiastro"],
  },
});
assert.equal(getById(cfg, f1.id)?.fields.source, "postgres.subscriptions", "source defaults to inputs[0].resource");

// the format is enforced by the schema, not by prose: no implicit assumption -> rejected with guidance
assert.throws(
  () =>
    record(cfg, {
      type: "finding",
      fields: {
        title: "Unargued number",
        question: "How many trials in August?",
        result: "4,310",
        data_window: { from: "2026-08-01", to: "2026-08-31" },
        inputs: [{ source: "postgres.subscriptions" }],
        method: "count rows where trial_start in window",
        assumptions: [{ statement: "the asker meant iOS", kind: "explicit" }],
      },
    }),
  /implicit assumption.*complete for the window/s,
  "rejection names the missing part and lists common implicit assumptions"
);
assert.throws(
  () =>
    record(cfg, {
      type: "finding",
      fields: {
        title: "No method",
        question: "How many trials in August?",
        result: "4,310",
        data_window: { from: "2026-08-01", to: "2026-08-31" },
        inputs: [{ source: "postgres.subscriptions" }],
        assumptions: [{ statement: "table is complete", kind: "implicit" }],
      },
    }),
  /method/,
  "method is required"
);

// a second person asks nearly the same question -> should be flagged
process.env.LEDGER_AUTHOR = "rachit";
const cfg2 = loadConfig();
const sim = similarFindings(cfg2, "iOS trial to paid conversion for August");
assert.equal(sim.length, 1, "similar finding should be detected");
assert.equal(sim[0].id, f1.id);

const chg = record(cfg2, {
  type: "change",
  fields: {
    title: "Shipped 13-arm paywall test",
    what: "13-arm paywall bandit live on iOS",
    shipped_at: "2026-08-20",
    surface: "paywall",
    owner: "rachit",
    scope: "iOS, 100% of new users",
    related_findings: [f1.id],
    tags: ["hiastro"],
  },
});

const dec1 = record(cfg2, {
  type: "decision",
  fields: {
    title: "No UPI AutoPay in Q4",
    decision: "We will not build UPI AutoPay before December",
    context: "Two engineers for the quarter; paywall bandit is running; India is 6% of revenue.",
    drivers: ["engineer-weeks", "revenue share"],
    options_considered: [
      { option: "Do nothing on UPI until December", chosen: true, rationale: "keeps both engineers on the bandit" },
      { option: "Build UPI AutoPay now", rationale: "India share of revenue too small to displace the bandit" },
    ],
    reversibility: "reversible",
    rationale: "Paywall bandit is the priority; India share of revenue too small",
    assumptions: [
      { statement: "India revenue share stays under 10% through Q4", kind: "implicit", if_wrong: "changes_conclusion" },
    ],
    consequences: ["Indian users keep card-only checkout"],
    valid_from: "2026-09-01",
    revisit_by: "2026-12-01",
    confirmation: "India revenue share on 2026-12-01 still under 10%",
    owner: "agaaz",
  },
});
assert.throws(
  () =>
    record(cfg2, {
      type: "decision",
      fields: {
        title: "Unargued decision",
        decision: "We will do X",
        context: "Because reasons, stated at length here.",
        rationale: "r",
        assumptions: [{ statement: "a", kind: "implicit" }],
        valid_from: "2026-09-01",
        owner: "agaaz",
      },
    }),
  /options_considered/,
  "a decision must list the options considered"
);
const dec2 = record(cfg2, {
  type: "decision",
  fields: {
    title: "Build UPI AutoPay in November",
    decision: "We will build UPI AutoPay in November",
    context: "Tata 1mg contract signed 2026-09-01 requires UPI AutoPay at launch.",
    options_considered: [
      { option: "Build UPI AutoPay in November", chosen: true },
      { option: "Keep the September decision", rationale: "contract makes it a hard requirement" },
    ],
    confirmation: { metric: "upi_autopay_live", success_condition: "live before Tata 1mg launch", evaluate_after: "2026-11-30" },
    rationale: "Tata 1mg contract requires it",
    assumptions: [{ statement: "the contract's launch date holds", kind: "implicit", if_wrong: "changes_conclusion" }],
    valid_from: "2026-09-02",
    owner: "agaaz",
    supersedes: dec1.id,
  },
});
assert.equal(dec2.superseded, dec1.id);
assert.equal(getById(cfg2, dec1.id)?.status, "deprecated");
assert.equal(getById(cfg2, dec1.id)?.superseded_by, dec2.id);

// the full render reads as an argument
const full = renderFull(getById(cfg2, f1.id)!);
assert.ok(full.includes("**assumptions**:") && full.includes("[implicit, changes conclusion] postgres.subscriptions is complete"), "assumptions rendered");
assert.ok(full.includes("**inputs**:") && full.includes("- postgres.subscriptions, population: trials started in window, platform='ios'"), "inputs rendered");
assert.ok(full.includes("**method**: Cohort by trial start"), "method rendered");
assert.ok(full.includes("(evidence: ETL log)"), "assumption evidence rendered");
const fullDec = renderFull(getById(cfg2, dec2.id)!);
assert.ok(fullDec.includes("- [chosen] Build UPI AutoPay in November") && fullDec.includes("Keep the September decision: contract makes it"), "options rendered");
assert.ok(fullDec.includes("**confirmation**: upi_autopay_live live before Tata 1mg launch, evaluate after 2026-11-30"), "structured confirmation rendered");

// the guide is what gets installed for the agent; it must carry the format
const guide = agentRulesText();
assert.ok(guide.includes("key assumptions check") && guide.includes("options_considered") && guide.includes("ledger_record_finding"), "guide has the format");
// Guide-only upgrades preserve unrelated instructions and never rewrite hooks/MCP config.
const codexGuideFile = path.join(tmp, ".codex", "AGENTS.md");
const claudeGuideFile = path.join(tmp, ".claude", "CLAUDE.md");
for (const file of [codexGuideFile, claudeGuideFile]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Team instructions\n<!-- ledger:start -->\nOld guide\n<!-- ledger:end -->\nOther instructions\n");
}
const settingsFiles = [path.join(tmp, ".codex", "hooks.json"), path.join(tmp, ".codex", "config.toml"), path.join(tmp, ".claude", "settings.json"), path.join(tmp, ".claude.json")];
for (const file of settingsFiles) fs.writeFileSync(file, "unchanged\n");
installGuides();
const installedGuide = fs.readFileSync(codexGuideFile, "utf8");
assert.ok(installedGuide.startsWith("Team instructions\n") && installedGuide.endsWith("\nOther instructions\n"));
assert.ok(installedGuide.includes("structuredContent.receipt.message") && installedGuide.includes("user-visible chat update immediately after the call"));
assert.equal(fs.readFileSync(path.join(tmp, ".claude", "ledger.md"), "utf8"), guide);
assert.ok(fs.readFileSync(claudeGuideFile, "utf8").includes("@~/.claude/ledger.md"));
installGuides();
assert.equal(fs.readFileSync(codexGuideFile, "utf8"), installedGuide, "guide upgrades are idempotent");
for (const file of settingsFiles) assert.equal(fs.readFileSync(file, "utf8"), "unchanged\n");
assert.ok(stats(cfg2).includes("without an implicit assumption: 0"), "stats counts unargued objects");

// OKF conformance: every non-reserved .md has frontmatter with `type`
for (const f of walk(dir)) {
  const base = path.basename(f);
  if (base === "index.md" || base === "log.md") continue;
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(raw.startsWith("---\n"), `frontmatter missing: ${f}`);
  assert.ok(/^type: /m.test(raw), `type missing: ${f}`);
}
const fndRaw = fs.readFileSync(f1.path, "utf8");
assert.ok(fndRaw.includes("generated:"), "OKF generated family");
assert.ok(fndRaw.includes("by: 'human:agaaz'") || fndRaw.includes("by: human:agaaz"), "actor convention");
assert.ok(fndRaw.includes("sources:"), "OKF sources family");
assert.ok(fs.readFileSync(dec1.path, "utf8").includes("stale_after:"), "revisit_by -> stale_after");
// generated views exist
for (const v of ["README.md", "index.md", "log.md", "findings/index.md", "decisions/index.md"]) {
  assert.ok(fs.existsSync(path.join(dir, v)), `view missing: ${v}`);
}
const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
assert.ok(readme.includes("trial_to_paid_cvr") && readme.includes("November") && !readme.includes("before December"));
const logmd = fs.readFileSync(path.join(dir, "log.md"), "utf8");
assert.ok(logmd.includes("**Supersede**"), "log records supersede");
assert.ok(fs.readFileSync(path.join(dir, "index.md"), "utf8").startsWith('---\nokf_version: "0.2"'));

const b = brief(cfg2);
assert.ok(b.includes("trial_to_paid_cvr"), "brief has definition");
assert.ok(b.includes("13-arm"), "brief has change");
assert.ok(b.includes("November"), "brief has active decision");
assert.ok(!b.includes("before December"), "brief hides superseded decision");

assert.ok(search(cfg2, "paywall bandit").some((h) => h.id === chg.id));
const st = stats(cfg2);
assert.ok(st.includes("findings: 1"));

// git: init committed, records committed
const log = fs.readFileSync(path.join(dir, ".git", "logs", "HEAD"), "utf8");
assert.ok(log.split("\n").filter(Boolean).length >= 5, "each record commits");

// ---- hand-written / legacy files ----
// YAML reads an unquoted `2026-01-01` as a Date; it must still render as a date.
fs.writeFileSync(
  path.join(dir, "definitions", "def-20260101-legacy-aaaa.md"),
  `---
id: def-20260101-legacy-aaaa
type: definition
created: 2026-01-01T00:00:00Z
title: Legacy metric
author: oldperson
status: active
metric: legacy_metric
formula: x / y
source: legacy.db
owner: oldperson
valid_from: 2026-01-01
---
`
);
const legacy = getById(cfg2, "def-20260101-legacy-aaaa");
assert.ok(legacy, "legacy file parsed");
assert.equal(legacy.fields.valid_from, "2026-01-01", "unquoted YAML date normalised to string");
assert.equal(legacy.created, "2026-01-01", "legacy created normalised");
assert.equal(legacy.status, "stable", "active -> stable");
assert.equal(legacy.author, "oldperson", "legacy author read");
assert.ok(!brief(cfg2).includes("GMT"), "no Date.toString() leaking into the brief");

// drafts are listed as drafts, not as deprecated
fs.writeFileSync(
  path.join(dir, "findings", "fnd-20260901-draft-bbbb.md"),
  `---
type: finding
id: fnd-20260901-draft-bbbb
title: Draft finding
description: not yet
status: draft
generated: { by: 'human:agaaz', at: '2026-09-01T00:00:00.000Z' }
question: q
result: r
data_window: { from: '2026-08-01', to: '2026-08-31' }
---
`
);
regenerateViews(cfg2, loadAll(cfg2));
const fidx = fs.readFileSync(path.join(dir, "findings", "index.md"), "utf8");
const section = (h: string) => {
  const i = fidx.indexOf(`# ${h}\n`);
  if (i === -1) return "";
  const rest = fidx.slice(i + h.length + 3);
  const j = rest.indexOf("\n# ");
  return j === -1 ? rest : rest.slice(0, j);
};
assert.ok(section("Draft").includes("Draft finding"), "draft listed under Draft");
assert.ok(!section("Deprecated").includes("Draft finding"), "draft not listed as deprecated");
assert.ok(!brief(cfg2).includes("Draft finding"), "drafts stay out of the brief");

// ---- the checkpoint loop (hooks) ----
// Deterministic: a data query with no record blocks Stop exactly once with the
// evidence listed; a record or an explicit skip clears it; PreCompact injects
// the same list; SessionStart after a compaction re-injects it.
const jdir = path.join(tmp, "sessions");
const sid = "sess-1";
const hook = (event: string, input: any, at: string) => handleHook(event, { session_id: sid, cwd: "/w", ...input }, { dir: jdir, now: new Date(at) });
const T = (m: number) => `2026-09-03T10:${String(m).padStart(2, "0")}:00.000Z`;

assert.equal(hook("SessionStart", { source: "startup" }, T(0)).exit, 0);
assert.equal(hook("Stop", {}, T(1)).exit, 0, "nothing ran: stop passes");

// not a data tool: ignored
assert.equal(hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "x" } }, T(2)).exit, 0);
assert.equal(loadJournal(sid, jdir).entries.length, 0);

// data tools: MCP query servers and bash db clients
hook("PostToolUse", { tool_name: "mcp__hiastro-clickhouse__run_query", tool_input: { query: "select count(*) from events where platform='ios'" } }, T(3));
hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "psql -c 'select 1'" } }, T(4));
hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls -la" } }, T(5));
assert.deepEqual(
  loadJournal(sid, jdir).entries.map((e) => e.kind),
  ["query", "query"],
  "only data work is journaled"
);

// first Stop with debt: blocked once, evidence quoted, both resolutions offered
const blocked = hook("Stop", { stop_hook_active: false }, T(6));
assert.equal(blocked.exit, 0, "block is JSON on stdout with exit 0 (the form Claude Code and Codex both document)");
const bj = JSON.parse(blocked.stdout!);
assert.equal(bj.decision, "block");
assert.equal(bj.hookSpecificOutput.hookEventName, "Stop");
assert.equal(bj.hookSpecificOutput.decision, "block");
assert.ok(bj.reason.includes("2 data queries") && bj.reason.includes("select count(*) from events"), bj.reason);
assert.ok(bj.reason.includes("ledger_record_finding") && bj.reason.includes("ledger_skip_record"), "both ways out are named");

// second Stop with the same debt: passes silently, and the ignored nudge is counted
const second = hook("Stop", { stop_hook_active: true }, T(7));
assert.equal(second.exit, 0, "never nudges twice for the same work");
assert.ok(!second.stdout, "no block output on the pass");
assert.ok(loadJournal(sid, jdir).entries.some((e) => e.kind === "unresolved"), "ignored nudge counted");

// new work after that: PreCompact injects the list instead of blocking
hook("PostToolUse", { tool_name: "mcp__amplitude__query_amplitude_data", tool_input: { sql: "select ... funnel" } }, T(8));
const pre = hook("PreCompact", { trigger: "auto" }, T(9));
assert.equal(pre.exit, 0);
const preJson = JSON.parse(pre.stdout!);
assert.equal(preJson.hookSpecificOutput.hookEventName, "PreCompact");
assert.ok(preJson.hookSpecificOutput.additionalContext.includes("funnel"), "precompact quotes the uncaptured query");

// after compaction, SessionStart re-injects the same uncaptured work
const restart = hook("SessionStart", { source: "compact" }, T(10));
assert.ok(restart.stdout!.includes("Uncaptured work") && restart.stdout!.includes("funnel"), "survives compaction");

// a successful record clears the debt; a failed (rejected) record does not
hook(
  "PostToolUse",
  {
    tool_name: "mcp__ledger__ledger_record_finding",
    tool_input: { title: "x" },
    tool_response: { isError: true, content: [{ type: "text", text: "Invalid finding: assumptions: ..." }] },
  },
  T(11)
);
assert.equal(debt(loadJournal(sid, jdir)).length, 3, "rejected record does not clear debt");
hook(
  "PostToolUse",
  {
    tool_name: "mcp__ledger__ledger_record_finding",
    tool_input: { title: "Funnel by intent" },
    tool_response: { content: [{ type: "text", text: "Recorded finding fnd-20260903-funnel-by-intent-ab12 — committed and pushed" }] },
  },
  T(12)
);
assert.equal(debt(loadJournal(sid, jdir)).length, 0, "record clears debt");
assert.equal(hook("Stop", {}, T(13)).exit, 0);

// an explicit skip with a reason also clears it, and is counted separately
hook("PostToolUse", { tool_name: "mcp__hiastro-clickhouse__run_query", tool_input: { query: "select 1" } }, T(14));
hook("PostToolUse", { tool_name: "mcp__ledger__ledger_skip_record", tool_input: { reason: "sanity check, no conclusion" } }, T(15));
assert.equal(hook("Stop", {}, T(16)).exit, 0, "skip clears debt");
hook("SessionEnd", { reason: "other" }, T(17));

// the pilot can read all of it
const cap = captureStats(365, jdir).join("\n");
assert.ok(cap.includes("queries 4") && cap.includes("records 1") && cap.includes("0 unprompted, 1 after a checkpoint"), cap);
assert.ok(cap.includes("nudges 1") && cap.includes("explicit skips 1") && cap.includes("nudges ignored 1"), cap);

// installer: one entry per event, replaced on re-run, other people's hooks untouched
const settings: any = { hooks: { Stop: [{ hooks: [{ type: "command", command: "someone-else" }] }], SessionStart: [{ hooks: [{ type: "command", command: "ledger brief --hook", timeout: 30 }] }] } };
upsertHooks(settings);
upsertHooks(settings);
for (const ev of Object.keys(HOOK_EVENTS)) {
  const ours = settings.hooks[ev].filter((e: any) => e.hooks.some((h: any) => isLedgerHookCommand(h.command)));
  assert.equal(ours.length, 1, `${ev}: exactly one ledger entry`);
  const cmd: string = ours[0].hooks[0].command;
  assert.ok(cmd.includes(process.execPath) && /cli\.js"? hook /.test(cmd), `absolute node + cli.js, PATH-independent: ${cmd}`);
  assert.ok(cmd.endsWith(` hook ${ev}`), `event name at the end: ${cmd}`);
}
assert.ok(settings.hooks.Stop.some((e: any) => e.hooks[0].command === "someone-else"), "foreign hook kept");
assert.ok(!settings.hooks.SessionStart.some((e: any) => e.hooks[0].command.startsWith("ledger brief")), "legacy brief hook replaced");
assert.equal(settings.hooks.PostToolUse[0].matcher, "mcp__.*|Bash");
assert.ok(isLedgerHookCommand("ledger brief --hook") && isLedgerHookCommand('"/opt/node" "/x/dist/cli.js" hook Stop') && !isLedgerHookCommand("someone-else"));

// ---- transcript fallback: reconciliation to drafts ----
// Runs only when live capture failed (ended with debt, or quiet with debt),
// reads the real transcript formats, produces drafts only, once per session.
const roots = { claude: path.join(tmp, "claude-projects"), codex: path.join(tmp, "codex-sessions") };
const cwdHash = "-Users-x-proj";
fs.mkdirSync(path.join(roots.claude, cwdHash), { recursive: true });
const cl = (o: any) => JSON.stringify(o);
const sidA = "11111111-aaaa-4bbb-8ccc-ddddddddddd1";
const claudeT = path.join(roots.claude, cwdHash, `${sidA}.jsonl`);
fs.writeFileSync(
  claudeT,
  [
    cl({ type: "user", timestamp: "2026-09-03T09:00:00.000Z", cwd: "/Users/x/proj", sessionId: sidA, message: { role: "user", content: "What was trial CVR for Android in August?" } }),
    cl({ type: "assistant", timestamp: "2026-09-03T09:00:05.000Z", sessionId: sidA, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__hiastro-clickhouse__run_query", input: { query: "select countIf(paid)/count() from trials where platform='android' and month='2026-08'" } }] } }),
    cl({ type: "user", timestamp: "2026-09-03T09:00:07.000Z", sessionId: sidA, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "0.093\n(1 row)" }] }, toolUseResult: { stdout: "0.093" } }),
    cl({ type: "assistant", timestamp: "2026-09-03T09:00:09.000Z", sessionId: sidA, message: { role: "assistant", content: [{ type: "text", text: "Android trial CVR in August was 9.3%." }] } }),
  ].join("\n") + "\n"
);
const evA = parseTranscript(claudeT, "claude");
assert.equal(evA.session_id, sidA);
assert.equal(evA.queries.length, 1);
assert.ok(evA.queries[0].input.includes("platform='android'") && evA.queries[0].output.includes("0.093"), "query paired with its result");
assert.deepEqual(evA.prompts, ["What was trial CVR for Android in August?"]);
assert.ok(evA.conclusions[0].includes("9.3%"));
assert.ok(evidenceText(evA).includes("## Data-tool calls") && evidenceText(evA).includes("0.093"));

// Codex rollout format
const codexDay = path.join(roots.codex, "2026", "09", "03");
fs.mkdirSync(codexDay, { recursive: true });
const sidB = "019cae11-d65e-74d3-b60d-1b26dd1f8a3b";
const codexT = path.join(codexDay, `rollout-2026-09-03T09-30-00-${sidB}.jsonl`);
fs.writeFileSync(
  codexT,
  [
    cl({ timestamp: "2026-09-03T09:30:00.000Z", type: "session_meta", payload: { id: sidB, cwd: "/Users/x/proj" } }),
    cl({ timestamp: "2026-09-03T09:30:01.000Z", type: "event_msg", payload: { type: "user_message", message: "How many paywall impressions yesterday?" } }),
    cl({ timestamp: "2026-09-03T09:30:02.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__amplitude__query_amplitude_data", arguments: JSON.stringify({ sql: "select count() from paywall_impression where day=yesterday()" }), call_id: "call_1" } }),
    cl({ timestamp: "2026-09-03T09:30:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "41200" } }),
    cl({ timestamp: "2026-09-03T09:30:04.000Z", type: "event_msg", payload: { type: "agent_message", message: "41,200 paywall impressions yesterday." } }),
  ].join("\n") + "\n"
);
const evB = parseTranscript(codexT);
assert.equal(evB.agent, "codex");
assert.equal(evB.session_id, sidB);
assert.equal(evB.queries.length, 1);
assert.ok(evB.queries[0].output.includes("41200"));
assert.equal(findTranscript(sidB, undefined, roots)?.path, codexT, "codex transcript found by session id");
assert.equal(findTranscript(sidA, undefined, roots)?.agent, "claude");

// the evidence keeps whole queries (the nudge's 200-char cap must not apply here)
const longSql = "select " + Array.from({ length: 60 }, (_, i) => `col_${i}`).join(", ") + " from events where platform='android' and day between '2026-08-01' and '2026-08-31'";
assert.ok(longSql.length > 500);
const longT = path.join(roots.claude, cwdHash, `${"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}.jsonl`);
fs.writeFileSync(longT, cl({ type: "assistant", sessionId: "e", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "mcp__hiastro-clickhouse__run_query", input: { query: longSql } }] } }) + "\n");
assert.equal(parseTranscript(longT, "claude").queries[0].input, longSql, "query text intact in the evidence");

// Journals: A ended with debt, B quiet with debt, C has debt but is still live
const rdir = path.join(tmp, "sessions-r");
const rh = (event: string, sid: string, input: any, at: string) =>
  handleHook(event, { session_id: sid, cwd: "/Users/x/proj", ...input }, { dir: rdir, now: new Date(at) });
rh("SessionStart", sidA, { source: "startup", transcript_path: claudeT }, T(20));
rh("PostToolUse", sidA, { tool_name: "mcp__hiastro-clickhouse__run_query", tool_input: { query: "select ..." } }, T(21));
assert.equal(rh("SessionEnd", sidA, { reason: "other" }, T(22)).reconcile, true, "SessionEnd with debt asks for reconciliation");
assert.equal(rh("SessionEnd", "no-debt", { reason: "other" }, T(22)).reconcile, undefined);
rh("PostToolUse", sidB, { tool_name: "mcp__amplitude__query_amplitude_data", tool_input: { sql: "select ..." } }, T(23));
const sidC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const liveTranscript = path.join(roots.claude, cwdHash, `${sidC}.jsonl`);
fs.writeFileSync(liveTranscript, cl({ type: "user", sessionId: sidC, message: { role: "user", content: "hi" } }) + "\n");
rh("PostToolUse", sidC, { tool_name: "mcp__hiastro-clickhouse__run_query", tool_input: { query: "select 1" } }, T(24));

// quiet gating: A and B transcripts are old; C's was just written, so it is still live
const oldT = new Date(Date.now() - 60 * 60_000);
fs.utimesSync(claudeT, oldT, oldT);
fs.utimesSync(codexT, oldT, oldT);
const futureT = new Date(Date.now() + 60_000);
fs.utimesSync(liveTranscript, futureT, futureT);
const cands = findCandidates({ dir: rdir, roots, quietMs: 20 * 60_000 });
assert.deepEqual(
  cands.map((c) => [c.journal.session_id, c.trigger]).sort(),
  [[sidA, "session_end"], [sidB, "quiet"]].sort(),
  "ended-with-debt and quiet-with-debt are candidates; live sessions are not"
);
assert.ok(cands.find((c) => c.journal.session_id === sidA)!.reason.includes("1 data query ran"));
assert.equal(findCandidates({ dir: rdir, roots, quietMs: 0 }).length, 3, "zero quiet window includes a future-mtime live session");

// Fake extractor: captures the prompt, returns a lenient finding for A (missing assumptions, one junk field), nothing for B
const promptFile = path.join(tmp, "prompt.txt");
const fake = path.join(tmp, "fake-extractor.mjs");
fs.writeFileSync(
  fake,
  `import fs from "node:fs";
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptFile)}, s);
  if (s.includes("paywall_impression")) { console.log(JSON.stringify({ drafts: [], reason: "a count, not a finding" })); return; }
  console.log("\`\`\`json\\n" + JSON.stringify({ drafts: [{ type: "finding", fields: {
    title: "Android trial CVR August", question: "What was trial CVR for Android in August?", result: "9.3%",
    data_window: { from: "2026-08-01", to: "2026-08-31" }, inputs: [{ source: "clickhouse", filters: "platform='android'" }],
    method: "paid over trials", query: "select countIf(paid)/count() from trials where platform='android'", confidence: "low",
    bogus_field: 1, confidence_basis: 12345 } }], reason: "one answered question" }) + "\\n\`\`\`");
});
`
);
process.env.LEDGER_EXTRACTOR_CMD = `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;

const dry = reconcile(cfg2, { dir: rdir, roots, quietMs: 20 * 60_000, dryRun: true });
assert.equal(dry.length, 2);
assert.ok(!loadJournal(sidA, rdir).extracted, "dry run marks nothing");

const rr = reconcile(cfg2, { dir: rdir, roots, quietMs: 20 * 60_000 });
const rA = rr.find((r) => r.session_id === sidA)!;
const rB = rr.find((r) => r.session_id === sidB)!;
assert.equal(rA.result, "drafts", JSON.stringify(rA));
assert.equal(rA.draft_ids.length, 1);
assert.equal(rB.result, "none");
const promptSent = fs.readFileSync(promptFile, "utf8");
assert.ok(promptSent.includes("Capture operation") && promptSent.includes("What the ledger is") && promptSent.includes("## Data-tool calls"), "prompt = base modules + operation + evidence");
assert.ok(promptSent.includes(`"${cfg2.author}"`), "author passed to the extractor");

const draft = getById(cfg2, rA.draft_ids[0])!;
assert.equal(draft.status, "draft");
assert.equal(draft.fields.capture_method, "transcript_fallback");
assert.equal(draft.fields.source_session, sidA);
assert.ok(String(draft.fields.capture_reason).includes("no ledger object was recorded"));
assert.equal(draft.fields.bogus_field, undefined, "unknown fields dropped");
assert.equal(draft.fields.confidence_basis, undefined, "mistyped field dropped, the rest kept");
assert.equal(draft.fields.result, "9.3%");
const draftRaw = fs.readFileSync(draft.path, "utf8");
assert.ok(draftRaw.includes("status: draft") && draftRaw.includes("capture_method: transcript_fallback") && draftRaw.includes(`source_session: ${sidA}`));

// once per session
assert.equal(loadJournal(sidA, rdir).extracted?.result, "drafts");
assert.equal(loadJournal(sidB, rdir).extracted?.result, "none");
assert.equal(reconcile(cfg2, { dir: rdir, roots, quietMs: 20 * 60_000 }).length, 0, "already reconciled sessions are never re-run");

// an extractor error is not a decision about the session: retried, but not forever
const jB = loadJournal(sidB, rdir);
jB.extracted = { at: T(30), result: "error", reason: "claude: Not logged in", draft_ids: [], attempts: 1 };
saveJournal(jB, rdir);
assert.equal(findCandidates({ dir: rdir, roots, quietMs: 20 * 60_000 }).length, 1, "errored session is a candidate again");
jB.extracted.attempts = 3;
saveJournal(jB, rdir);
assert.equal(findCandidates({ dir: rdir, roots, quietMs: 20 * 60_000 }).length, 0, "gives up after three attempts");
jB.extracted = { at: T(30), result: "none", reason: "nothing", draft_ids: [], attempts: 1 };
saveJournal(jB, rdir);

// drafts are a review queue, not knowledge
const b2 = brief(cfg2);
assert.ok(b2.includes("## Drafts awaiting review (1)") && b2.includes(draft.id), "brief lists the draft for review");
assert.ok(!b2.includes("9.3%"), "draft content stays out of the findings section");
assert.ok(!search(cfg2, "Android trial CVR").some((h) => h.id === draft.id), "drafts are not search results");
assert.ok(fs.readFileSync(path.join(dir, "README.md"), "utf8").includes("## Drafts awaiting review"), "dashboard shows the queue");
assert.ok(stats(cfg2).includes("drafts created 1 (window), pending review 1, promoted 0, discarded 0"), stats(cfg2));
assert.equal(pendingDrafts(cfg2).length, 1);

// promote: a stable record that supersedes the draft; the full schema applies
const promoted = record(cfg2, {
  type: "finding",
  fields: {
    title: "Android trial CVR August",
    question: "What was trial CVR for Android in August?",
    result: "9.3% (n=12,400)",
    data_window: { from: "2026-08-01", to: "2026-08-31" },
    inputs: [{ source: "clickhouse", filters: "platform='android'" }],
    method: "paid within 14 days over trials started, cohort by trial start",
    query: "select ...",
    assumptions: [{ statement: "trials table complete for August", kind: "implicit", if_wrong: "changes_conclusion" }],
    supersedes: draft.id,
  },
});
assert.equal(getById(cfg2, draft.id)?.status, "deprecated");
assert.equal(getById(cfg2, draft.id)?.superseded_by, promoted.id);
assert.ok(!brief(cfg2).includes("Drafts awaiting review"), "promoted draft leaves the queue");

// discard
const d2 = recordDraft(cfg2, { type: "decision", fields: { title: "Maybe drop Android", decision: "Drop Android paywall work" }, capture: { method: "transcript_fallback", session: sidB, reason: "test" } });
assert.equal(getById(cfg2, d2.id)?.status, "draft");
assert.throws(() => discardDraft(cfg2, promoted.id, "x"), /not a draft/);
discardDraft(cfg2, d2.id, "the agent proposed it; nobody decided");
const dd = getById(cfg2, d2.id)!;
assert.equal(dd.status, "deprecated");
assert.equal(dd.superseded_by, undefined);
assert.ok(String((dd.fields.discarded as any)?.reason).includes("nobody decided"));
assert.ok(stats(cfg2).includes("promoted 1, discarded 1"));
assert.throws(() => recordDraft(cfg2, { type: "finding", fields: { title: "no main field" }, capture: { method: "transcript_fallback", session: "s", reason: "r" } }), /needs question/);
assert.deepEqual(parseDrafts('{"drafts":[{"type":"finding","fields":{"title":"t"}},{"type":"nope","fields":{}}],"reason":"r"}').drafts.map((d) => d.type), ["finding"]);
assert.throws(() => parseDrafts("sorry, nothing"), /non-JSON/);
delete process.env.LEDGER_EXTRACTOR_CMD;

// machine state never escapes the sandbox: config, journals and log all under LEDGER_CONFIG_DIR
assert.equal(ledgerHome(), path.join(tmp, ".ledger"));
assert.ok(fs.existsSync(path.join(tmp, ".ledger", "config.json")), "config written inside the sandbox");
assert.ok(!fs.readFileSync(path.join(tmp, ".ledger", "config.json"), "utf8").includes("undefined"));

// ---- git sync across two clones ----
// The MCP server is long-lived and reads are throttled to one pull a minute,
// so two machines recording inside the same minute is the normal case, not
// the edge case. Every record rewrites the generated views, so this is where
// conflicts happen. They must self-resolve and never leave a repo mid-rebase.
const remote = path.join(tmp, "remote.git");
sh(tmp, ["init", "--bare", "--quiet", remote]);
sh(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
const A = path.join(tmp, "A");
const B = path.join(tmp, "B");
initLedger(A, "agaaz");
sh(A, ["remote", "add", "origin", remote]);
sh(A, ["push", "--quiet", "-u", "origin", "main"]);
sh(tmp, ["clone", "--quiet", remote, B]);
const cfgA: Config = { ledger_dir: A, author: "agaaz", git_sync: true };
const cfgB: Config = { ledger_dir: B, author: "rachit", git_sync: true };
const mk = (title: string, metric: string) => ({
  type: "definition" as const,
  fields: { title, metric, formula: "a / b", source: "pg", owner: "x", valid_from: "2026-01-01" },
});
const state = (d: string) => ({
  branch: sh(d, ["rev-parse", "--abbrev-ref", "HEAD"]),
  pushed: sh(d, ["rev-parse", "HEAD"]) === sh(d, ["rev-parse", "origin/main"]),
  clean: sh(d, ["status", "--porcelain"]) === "",
  rebasing: fs.existsSync(path.join(d, ".git", "rebase-merge")) || fs.existsSync(path.join(d, ".git", "rebase-apply")),
});
const metricsIn = (d: string): string[] => ([...(fs.readFileSync(path.join(d, "README.md"), "utf8").match(/\*\*m_\w+\*\*/g) ?? [])] as string[]).sort();

assert.equal(record(cfgA, mk("Alpha", "m_alpha")).git, "committed and pushed");
assert.equal(record(cfgB, mk("Beta", "m_beta")).git, "committed and pushed");
assert.deepEqual(metricsIn(B), ["**m_alpha**", "**m_beta**"], "B pulled A's record before writing its own");

// The race: A commits from a stale tree, as if the remote moved between its
// pull and its push. Replaying onto B's commit conflicts on every view file.
record({ ...cfgA, git_sync: false }, mk("Gamma", "m_gamma"));
const synced = commitAndPush(cfgA, "definition: Gamma (agaaz)", ["."]);
assert.equal(synced, "committed and pushed", `view conflicts must self-resolve, got: ${synced}`);
assert.deepEqual(state(A), { branch: "main", pushed: true, clean: true, rebasing: false });
assert.deepEqual(metricsIn(A), ["**m_alpha**", "**m_beta**", "**m_gamma**"], "dashboard has every record");
const readmeA = fs.readFileSync(path.join(A, "README.md"), "utf8");
const logA = fs.readFileSync(path.join(A, "log.md"), "utf8");
assert.ok(!readmeA.includes("<<<<<<<") && !logA.includes("<<<<<<<"), "no conflict markers");
assert.equal((logA.match(/\*\*Creation\*\*/g) ?? []).length, 3, "log has each record exactly once");

// Views are a pure function of the objects: the other machine sees identical bytes.
assert.equal(pull(cfgB, true), null);
assert.equal(fs.readFileSync(path.join(B, "README.md"), "utf8"), readmeA, "README identical across machines");
assert.equal(fs.readFileSync(path.join(B, "log.md"), "utf8"), logA, "log identical across machines");

// Offline: A accumulates two local commits while B keeps pushing. Coming back
// online replays both; each collides on the views; all of it must land.
sh(A, ["remote", "set-url", "origin", path.join(tmp, "nowhere.git")]);
assert.match(commitAndPush({ ...cfgA }, "noop", ["."]) ?? "", /commit failed/); // nothing to commit, sanity
record({ ...cfgA, git_sync: false }, mk("Delta", "m_delta"));
assert.match(commitAndPush(cfgA, "definition: Delta (agaaz)", ["."]) ?? "", /committed locally/);
record({ ...cfgA, git_sync: false }, mk("Epsilon", "m_epsilon"));
assert.match(commitAndPush(cfgA, "definition: Epsilon (agaaz)", ["."]) ?? "", /committed locally/);
assert.equal(record(cfgB, mk("Zeta", "m_zeta")).git, "committed and pushed");
sh(A, ["remote", "set-url", "origin", remote]);
assert.equal(record(cfgA, mk("Eta", "m_eta")).git, "committed and pushed", "back online: replay + record + push");
assert.deepEqual(state(A), { branch: "main", pushed: true, clean: true, rebasing: false });
assert.deepEqual(
  metricsIn(A),
  ["**m_alpha**", "**m_beta**", "**m_delta**", "**m_epsilon**", "**m_eta**", "**m_gamma**", "**m_zeta**"],
  "nothing lost across the offline stretch"
);
assert.equal(pull(cfgB, true), null);
assert.deepEqual(metricsIn(B), metricsIn(A));
assert.equal(fs.readFileSync(path.join(B, "log.md"), "utf8"), fs.readFileSync(path.join(A, "log.md"), "utf8"));

// A repo left mid-rebase by an older version (or a killed process) self-heals.
record({ ...cfgB, git_sync: false }, mk("Theta", "m_theta"));
sh(B, ["add", "."]);
sh(B, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "stale"]);
assert.equal(record(cfgA, mk("Iota", "m_iota")).git, "committed and pushed");
try {
  sh(B, ["pull", "--rebase", "--quiet"]); // conflicts on views, leaves rebase-merge behind
} catch {
  /* expected */
}
assert.equal(state(B).rebasing, true, "precondition: B is stuck mid-rebase");
assert.equal(record(cfgB, mk("Kappa", "m_kappa")).git, "committed and pushed", "recovers from a stale rebase");
assert.deepEqual(state(B), { branch: "main", pushed: true, clean: true, rebasing: false });
assert.ok(metricsIn(B).includes("**m_theta**") && metricsIn(B).includes("**m_iota**") && metricsIn(B).includes("**m_kappa**"));

// MCP over stdio
const client = new Client({ name: "selftest", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/cli.js"), "mcp"],
  env: { ...process.env } as Record<string, string>,
});
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
assert.deepEqual(names, [
  "ledger_brief",
  "ledger_discard_draft",
  "ledger_get",
  "ledger_record_change",
  "ledger_record_decision",
  "ledger_record_definition",
  "ledger_record_finding",
  "ledger_search",
  "ledger_show_contribution",
  "ledger_skip_record",
  "ledger_stats",
]);
const r = await client.callTool({ name: "ledger_search", arguments: { query: "trial conversion" } });
assert.ok(JSON.stringify(r).includes(f1.id));
// Cards are discoverable over ordinary MCP and retain a text-only fallback.
assert.equal((tools.tools.find(t => t.name === "ledger_search")?._meta?.ui as any)?.resourceUri, EVIDENCE_URI);
const resource = await client.readResource({ uri: EVIDENCE_URI });
assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
assert.ok("text" in resource.contents[0]);
assert.ok(String(resource.contents[0].text).includes("Ledger evidence"));
assert.ok(!String(resource.contents[0].text).includes("<!-- APP_SCRIPT -->"));
const card = r.structuredContent as any;
assert.equal(card.mode, "retrieved");
assert.deepEqual(card.references, [], "retrieval must not claim the answer used any records");
assert.equal(card.sources.find((s: any) => s.id === f1.id).author, "agaaz");
assert.equal(card.receipt.action, "found");
assert.equal(card.receipt.records.length, card.sources.length);
assert.equal(card.receipt.records.find((s: any) => s.id === f1.id).author, "agaaz");
assert.match(card.receipt.message, /💡 Ledger · Found/);
assert.doesNotMatch(card.receipt.message, /Referenced|verified|saved.*minutes/i);
assert.ok(JSON.stringify(r.content).includes(card.receipt.message), "text-only hosts get the same receipt");
assert.ok(!JSON.stringify(card).includes(dir), "cards do not expose machine-specific file paths");
const attribution = await client.callTool({ name: "ledger_show_contribution", arguments: { references: [
  { id: f1.id, answer_excerpt: "August's iOS conversion was 11.2%.", contribution: "Reused the previous estimate." },
  { id: f1.id, answer_excerpt: "The comparison uses trial-start cohorts.", contribution: "Kept the cohort definition." },
] } });
assert.equal((attribution.structuredContent as any).sources.length, 1, "two passages using one record count as one source");
assert.equal((attribution.structuredContent as any).references.length, 2);
assert.equal((attribution.structuredContent as any).receipt.action, "referenced");
assert.equal((attribution.structuredContent as any).receipt.records.length, 1);
assert.match((attribution.structuredContent as any).receipt.message, /Referenced 1 record.*Usage reported by agent/);
assert.match(JSON.stringify(attribution.content), /not independent verification/);
assert.equal((attribution.structuredContent as any).sources[0].snapshot, card.sources.find((s: any) => s.id === f1.id).snapshot);
const missing = await client.callTool({ name: "ledger_show_contribution", arguments: { references: [
  { id: "nonexistent", answer_excerpt: "A fabricated source.", contribution: "This must fail." },
] } });
assert.ok(missing.isError, "unknown references cannot produce a contribution card");
const empty = await client.callTool({ name: "ledger_search", arguments: { query: "zzznomatchingrecords" } });
assert.deepEqual((empty.structuredContent as any).sources, []);
assert.match((empty.structuredContent as any).receipt.message, /No matching records/);
// an unargued number is rejected at the MCP boundary, naming every missing part
const bare = {
  title: "Trial CVR August, refreshed",
  question: "trial to paid conversion August iOS",
  result: "11.4%",
  definitions_used: ["trial_to_paid_cvr"],
  data_window: { from: "2026-08-01", to: "2026-08-31" },
  source: "postgres.subscriptions",
  supersedes: f1.id,
};
const rejected = await client.callTool({ name: "ledger_record_finding", arguments: bare });
const rejTxt = JSON.stringify(rejected);
assert.ok(rejected.isError && /inputs/.test(rejTxt) && /method/.test(rejTxt) && /assumptions/.test(rejTxt), rejTxt);
assert.ok(!(rejected.structuredContent as any)?.receipt, "rejected writes must not return success receipts");
const r2 = await client.callTool({
  name: "ledger_record_finding",
  arguments: {
    ...bare,
    inputs: [{ source: "postgres.subscriptions", filters: { platform: "ios" } }],
    method: "Same cohort method as the August finding, re-run after the late-arriving refunds landed.",
    assumptions: [{ statement: "refund backfill is now complete", kind: "implicit", if_wrong: "changes_conclusion" }],
    prior: { relation: "revises", ids: [f1.id, "fnd-unknown-reference"] },
  },
});
const txt = JSON.stringify(r2);
assert.ok(txt.includes("Recorded finding"), txt);
assert.ok(txt.includes("superseded " + f1.id), "supersede via MCP");
const saved = (r2.structuredContent as any).receipt;
assert.equal(saved.action, "saved");
assert.equal(saved.records[0].id, saved.record_id);
assert.equal(saved.records[0].title, bare.title);
assert.equal(saved.records[0].author, "rachit");
assert.equal(saved.references[0].author, "agaaz", "the writer and prior source author remain distinct");
assert.equal(saved.sync, "local_commit", "a ledger with no remote must not claim to have synced");
assert.deepEqual(saved.references.map((s: any) => s.id), [f1.id], "prior and supersedes links are deduplicated");
assert.deepEqual(saved.unresolved_references, ["fnd-unknown-reference"]);
assert.match(saved.message, /No remote.*1 deprecated.*1 unresolved reference/);
// The existing hook must still recognize a recorded ID in the new tool output.
handleHook("PostToolUse", { session_id: "receipt-capture", tool_name: "mcp__ledger__ledger_record_finding", tool_response: r2 });
assert.ok(JSON.stringify(loadJournal("receipt-capture")).includes(saved.record_id));
const old = await client.callTool({ name: "ledger_get", arguments: { id: f1.id } });
assert.equal((old.structuredContent as any).sources[0].status, "deprecated");
assert.match((old.structuredContent as any).receipt.message, /Opened finding.*1 deprecated/);
assert.ok((old.structuredContent as any).sources[0].superseded_by);
assert.notEqual((old.structuredContent as any).sources[0].snapshot, card.sources.find((s: any) => s.id === f1.id).snapshot, "lifecycle changes produce a different snapshot");
await client.close();

// Honest state labels across offline, disabled, failed, and confirmed pushes.
for (const [gitResult, enabled, expected] of [
  ["committed and pushed", true, "pushed"],
  ["committed (no remote)", true, "local_commit"],
  ["committed locally; push failed: offline", true, "sync_failed"],
  ["committed locally; pull failed: offline", true, "sync_failed"],
  ["commit failed: read-only filesystem", true, "commit_failed"],
  [null, false, "disabled"],
  [null, true, "unconfirmed"],
  ["unknown future outcome", true, "unconfirmed"],
] as const) {
  const outcome = syncReceipt(gitResult, enabled);
  assert.equal(outcome.sync, expected);
  assert.equal(outcome.message.includes("Committed and pushed"), expected === "pushed");
}
const oldObject = getById(cfg, f1.id)!;
const draftReceipt = readReceipt("found", [{ ...oldObject, status: "draft" }, { ...oldObject, status: "draft" }]);
assert.equal(draftReceipt.records.length, 1);
assert.match(draftReceipt.message, /Includes 1 draft/);
const degradedReceipt = savedReceipt("finding", { title: "Saved before metadata became unavailable", prior: { ids: 42 }, based_on: 42 }, { id: "fnd-written", path: "unused", git: "committed and pushed" }, null, true);
assert.equal(degradedReceipt.sync, "pushed");
assert.equal(degradedReceipt.record_id, "fnd-written");
assert.equal(degradedReceipt.metadata_unavailable, true);
assert.match(degradedReceipt.message, /Source details unavailable/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("selftest: ok");
