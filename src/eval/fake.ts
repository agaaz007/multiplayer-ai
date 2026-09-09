import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AdapterRequest, Condition, ConditionPlugin, FixtureEvent, Harness, OriginRun, SuccessorRun, TrialContext, TrialPaths } from "./types.js";

/**
 * Fake drivers and a fake condition plugin so the whole adapter pipeline (kit -> adapter -> runners ->
 * collector -> scorer -> compare) runs without a model or a harness. Test scaffolding only: the fake
 * successor is scripted from the public case (it is the controller's test double, not a successor),
 * and its tool outputs contain the fixture texts so evidence extraction is exercised for real.
 *
 * Knobs (environment):
 *   LEDGER_EVAL_FAKE_WRONG=<case>:<key>=<json>   inject a wrong answer value for one key of one case
 *   LEDGER_EVAL_FAKE_NO_RETRIEVAL=1              tool outputs carry no fixture text (evidence cannot be backed)
 */

export interface BootstrapResult { worktree: string; wip_ref: string | null; wip_commit: string | null }
export type EvalPlugin = ConditionPlugin & { bootstrapWorktree?(ctx: TrialContext): Promise<BootstrapResult> };

export interface Drivers {
  createTrial(request: AdapterRequest, condition: Condition, log: (line: string) => void): Promise<TrialContext>;
  cleanupTrial(ctx: TrialContext, keep: boolean): Promise<void>;
  runOrigin(ctx: TrialContext, events: FixtureEvent[]): Promise<OriginRun>;
  runSuccessor(ctx: TrialContext, setup: Awaited<ReturnType<ConditionPlugin["successorSetup"]>>, resumePrompt: string, answerKeys: string[]): Promise<SuccessorRun>;
  harnessVersion(h: Harness): string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString().trim();
}

export function copyTree(src: string, dst: string, exclude: string[] = [".git"]): void {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !exclude.includes(path.basename(s)) });
}

function split(direction: AdapterRequest["direction"]): { origin: Harness; successor: Harness } {
  const [origin, successor] = direction.split("-to-") as [Harness, Harness];
  return { origin, successor };
}

export const fakeDrivers: Drivers = {
  async createTrial(request, condition, log) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-eval-fake-${request.case.id}-`));
    const p: TrialPaths = {
      root, repo: path.join(root, "repo"), bare: path.join(root, "bare.git"), successorRepo: path.join(root, "successor"),
      ledgerDir: path.join(root, "ledger"), configDir: path.join(root, "config"), homeDir: path.join(root, "home"),
      rawDir: path.join(request.output_dir, "raw"), outputDir: request.output_dir,
    };
    for (const d of [p.repo, p.configDir, p.homeDir, p.rawDir]) fs.mkdirSync(d, { recursive: true });
    // origin repo with a tracked obsolete.txt, a bare remote, and a fresh successor clone at master
    git(p.repo, ["init", "--quiet", "-b", "master"]);
    fs.writeFileSync(path.join(p.repo, "README.md"), `# ${request.case.id} fixture\n`);
    fs.writeFileSync(path.join(p.repo, "obsolete.txt"), "to be deleted by the origin\n");
    fs.writeFileSync(path.join(p.repo, ".gitignore"), "generated/\n");
    git(p.repo, ["add", "-A"]);
    git(p.repo, ["commit", "--quiet", "-m", "init"]);
    git(root, ["clone", "--quiet", "--bare", p.repo, p.bare]);
    git(p.repo, ["remote", "add", "origin", p.bare]);
    git(root, ["clone", "--quiet", p.bare, p.successorRepo]);
    // the origin's uncommitted work: seed files written, obsolete.txt removed (E01/E03 setup)
    if (request.case.seed_files) {
      for (const [rel, content] of Object.entries(request.case.seed_files)) {
        const f = path.join(p.repo, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      }
      fs.rmSync(path.join(p.repo, "obsolete.txt"), { force: true });
    }
    // disposable ledger repo, initialized without touching the real ~/.ledger
    const prev = process.env.LEDGER_CONFIG_DIR;
    process.env.LEDGER_CONFIG_DIR = p.configDir;
    try { const { initLedger } = await import("../store.js"); initLedger(p.ledgerDir, "rachit"); }
    finally { if (prev === undefined) delete process.env.LEDGER_CONFIG_DIR; else process.env.LEDGER_CONFIG_DIR = prev; }
    const h = split(request.direction);
    const reverse = request.direction === "claude-to-codex";
    const ctx: TrialContext = {
      request, condition, paths: p, originHarness: h.origin, successorHarness: h.successor,
      originAuthor: reverse ? "agaaz" : "rachit", successorAuthor: reverse ? "rachit" : "agaaz",
      originModel: "fake-model", successorModel: "fake-model",
      evalDatabaseUrl: process.env.LEDGER_EVAL_DB || "postgresql://localhost:5432/ledger_eval", log,
    };
    log(`fake: trial root ${root}`);
    return ctx;
  },
  async cleanupTrial(ctx, keep) {
    if (keep) { ctx.log(`fake: keeping ${ctx.paths.root}`); return; }
    fs.rmSync(ctx.paths.root, { recursive: true, force: true });
  },
  async runOrigin(ctx, events) {
    const sessions = [...new Set(events.map((e) => e.session))];
    const turns = events.map((e, i) => ({ harness: ctx.originHarness, sessionId: `fake-origin-${e.session}`, transcriptPath: null, turnIndex: i, fixtureEventId: e.id, assistantText: "Noted.", usage: { input_tokens: Math.ceil(e.text.length / 4) + 800, output_tokens: 4 }, wallMs: 1 }));
    fs.writeFileSync(path.join(ctx.paths.rawDir, "origin-fake.jsonl"), turns.map((t) => JSON.stringify({ session: t.sessionId, turn: t.turnIndex, event: t.fixtureEventId })).join("\n") + "\n");
    return { harness: ctx.originHarness, sessionIds: sessions.map((s) => `fake-origin-${s}`), turns, transcriptPaths: [], totalInputTokens: turns.reduce((a, t) => a + (t.usage?.input_tokens ?? 0), 0), compactions: 0 };
  },
  async runSuccessor(ctx, setup, resumePrompt, answerKeys) {
    const t0 = Date.now();
    const c = ctx.request.case;
    const by = (id: string) => c.events.find((e) => e.id === id)?.text ?? `(missing ${id})`;
    const answers: Record<string, unknown> = scriptedAnswers(c.id, by, answerKeys);
    const wrong = process.env.LEDGER_EVAL_FAKE_WRONG;
    if (wrong) {
      const m = wrong.match(/^([^:]+):([^=]+)=([\s\S]*)$/);
      if (m && m[1] === c.id && answers[m[2]] && typeof answers[m[2]] === "object") (answers[m[2]] as any).value = JSON.parse(m[3]);
    }
    const output: Record<string, unknown> = { answers, ...(c.id === "R01" ? { selected_topic: "Paywall" } : {}), notes: "fake successor; scripted from the public case" };
    const rawOutputPath = path.join(ctx.paths.rawDir, "successor-output.json");
    fs.writeFileSync(rawOutputPath, JSON.stringify(output, null, 2) + "\n");
    const noRetrieval = process.env.LEDGER_EVAL_FAKE_NO_RETRIEVAL === "1";
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const packLines = noRetrieval ? ["(no matching events)"] : c.events.slice(0, 60).map((e, i) => `#${i + 1} instruction.added ${e.author} ${e.session} "${e.text}"`);
    const toolCalls: SuccessorRun["toolCalls"] = [
      { tool: "ledger_resume", input: JSON.stringify({ query: resumePrompt.slice(0, 60) }), output_preview: `Resume pack (fake)\ncwd: ${setup.cwd}\n${packLines.join("\n")}\n`, at: at(120), call_id: "fake-call-1" },
      { tool: "ledger_events", input: JSON.stringify({ kinds: ["instruction.added"] }), output_preview: noRetrieval ? "[]" : JSON.stringify(c.events.slice(0, 60).map((e, i) => ({ seq: i + 1, kind: "instruction.added", text: e.text }))), at: at(240), call_id: "fake-call-2" },
    ];
    const idsFile = path.join(ctx.paths.rawDir, "ledger-ids.json");
    if (fs.existsSync(idsFile) && !noRetrieval) {
      const ids = JSON.parse(fs.readFileSync(idsFile, "utf8")) as Record<string, string>;
      toolCalls.push({ tool: "ledger_get", input: JSON.stringify({ id: ids["metric-v2"] }), output_preview: Object.entries(ids).map(([ev, id]) => `${id}\n  decision: ${by(ev)}`).join("\n\n") + "\n", at: at(360), call_id: "fake-call-3" });
    }
    return { harness: ctx.successorHarness, sessionId: `fake-successor-${ctx.request.trial_id}`, transcriptPath: null, output, rawOutputPath, toolCalls, bootTokens: 4200 + resumePrompt.length, totalInputTokens: 9000 + c.events.length * 40, wallMs: Date.now() - t0 + 400 };
  },
  harnessVersion: () => "fake-harness-0",
};

/** The scripted successor: values in the shapes a real successor might use, so normalization is exercised. */
function scriptedAnswers(caseId: string, by: (id: string) => string, keys: string[]): Record<string, unknown> {
  const excerpt = (id: string, from: number, len: number) => by(id).slice(from, from + len);
  switch (caseId) {
    case "D01":
      return {
        price_inr: { value: "₹199", evidence: [excerpt("constraint", 21, 52)] },
        animation_target: { value: "Locked insight", evidence: [by("reject")] },
        whole_card_rejection: { value: "distracting.", evidence: [by("reject")] },
      };
    case "D02":
      return {
        denominator: { value: "unique exposed users", evidence: [by("metric-v2")] },
        superseded: { value: "metric-v1", evidence: [by("metric-v2")] },
      };
    case "D03":
      return {
        accepted_join_rate: { value: null, evidence: [by("hyp-a"), by("hyp-b")] },
        status: { value: "Unresolved", evidence: [by("hyp-a"), by("hyp-b")] },
        next_check: { value: "dataset equivalence", evidence: [by("hyp-b")] },
      };
    case "R01":
      return {
        price_inr: { value: 199, evidence: [by("constraint")] },
        next_action: { value: "validate_small_screen", evidence: [by("pending")] },
      };
    case "R02":
      return {
        preview: { value: "WebView", evidence: [by("setup")] },
        unverified_viewport: { value: "640px", evidence: [by("fix")] },
      };
    case "E01":
      return { next_action: { value: "validate small screen", evidence: [by("saved")] } };
    default:
      return Object.fromEntries(keys.map((k) => [k, { value: null, evidence: [] }]));
  }
}

export function fakePlugin(condition: Condition): EvalPlugin {
  const plugin: EvalPlugin = {
    name: condition,
    async prepare(ctx) { ctx.log(`fake plugin ${condition}: prepare (no capture)`); return { notes: [`fake ${condition}: nothing ingested`], prepared_ms: 0 }; },
    async successorSetup(ctx) { return { env: {}, mcpConfigPath: null, allowedTools: [], cwd: ctx.paths.successorRepo, preamble: "" }; },
    async evidenceRef(ctx, e) {
      // D02 returns null so the collector's ledger-id sidecar fallback is exercised.
      if (ctx.request.case.id === "D02") return null;
      return { system_ref: `fake:${condition}:${e.id}` };
    },
  };
  if (condition === "ours") {
    // "ours" has a snapshot: the origin worktree as it was (seeds written, obsolete.txt deleted).
    plugin.bootstrapWorktree = async (ctx) => {
      const dest = path.join(ctx.paths.root, "recovered-worktree");
      copyTree(ctx.paths.repo, dest);
      ctx.log(`fake bootstrap: copied origin worktree to ${dest}`);
      return { worktree: dest, wip_ref: "refs/wip/fake/origin", wip_commit: null };
    };
  }
  return plugin;
}
