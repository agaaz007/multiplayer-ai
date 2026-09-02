import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initLedger, loadConfig, loadAll, record, getById, commitAndPush, pull, type Config } from "./store.js";
import { brief, search, similarFindings, stats, renderFull } from "./query.js";
import { regenerateViews } from "./views.js";
import { agentRulesText, upsertClaudeHooks, HOOK_EVENTS, isLedgerHookCommand } from "./install.js";
import { handleHook, loadJournal, captureStats, debt } from "./hooks.js";

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
assert.equal(blocked.exit, 2, "stop blocked");
assert.ok(blocked.stderr!.includes("2 data queries") && blocked.stderr!.includes("select count(*) from events"), blocked.stderr ?? "");
assert.ok(blocked.stderr!.includes("ledger_record_finding") && blocked.stderr!.includes("ledger_skip_record"), "both ways out are named");

// second Stop with the same debt: passes, and the ignored nudge is counted
assert.equal(hook("Stop", { stop_hook_active: true }, T(7)).exit, 0, "never nudges twice for the same work");
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
upsertClaudeHooks(settings);
upsertClaudeHooks(settings);
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
  "ledger_get",
  "ledger_record_change",
  "ledger_record_decision",
  "ledger_record_definition",
  "ledger_record_finding",
  "ledger_search",
  "ledger_skip_record",
  "ledger_stats",
]);
const r = await client.callTool({ name: "ledger_search", arguments: { query: "trial conversion" } });
assert.ok(JSON.stringify(r).includes(f1.id));
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
const r2 = await client.callTool({
  name: "ledger_record_finding",
  arguments: {
    ...bare,
    inputs: [{ source: "postgres.subscriptions", filters: { platform: "ios" } }],
    method: "Same cohort method as the August finding, re-run after the late-arriving refunds landed.",
    assumptions: [{ statement: "refund backfill is now complete", kind: "implicit", if_wrong: "changes_conclusion" }],
    prior: { relation: "revises", ids: [f1.id] },
  },
});
const txt = JSON.stringify(r2);
assert.ok(txt.includes("Recorded finding"), txt);
assert.ok(txt.includes("superseded " + f1.id), "supersede via MCP");
await client.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log("selftest: ok");
