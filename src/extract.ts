import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, execFile, exec } from "node:child_process";
import { type Config, loadAll, recordDraft } from "./store.js";
import { TYPES, type LedgerType } from "./schema.js";
import { type Journal, type JournalEntry, acknowledgeCapture, debt, loadJournal, saveJournal, withJournalLock, sessionsDir, DEFAULT_DATA_TOOLS } from "./hooks.js";
import { type Agent, type Evidence, type Roots, evidenceText, findTranscript, hasMaterialActivity, parseTranscript } from "./transcript.js";

/**
 * Transcript → draft reconciliation. The fallback, never the primary writer.
 *
 * Runs only when the live capture path appears to have failed:
 *   - a session ended cleanly with capture debt (SessionEnd spawns it at once)
 *   - a session died: its journal has debt and its transcript has been quiet
 *     for `quietMs` (the periodic reconciler catches these)
 *   - compaction slipped through: same signal, debt after a compact entry
 *
 * It never writes trusted memory. Every object it creates is `status: draft`
 * with `capture_method: transcript_fallback`, `source_session`, and the reason
 * the fallback ran. A human or their agent promotes (records a stable object
 * with `supersedes`) or discards. The journal records exact processed evidence
 * IDs so new obligations in a resumed session remain eligible for fallback.
 */

export interface Candidate {
  journal: Journal;
  transcript: { path: string; agent: Agent };
  trigger: "session_end" | "quiet" | "manual";
  reason: string;
  evidence: JournalEntry[];
}

export interface ReconcileOpts {
  dir?: string; // sessions dir
  quietMs?: number;
  sessionId?: string; // reconcile this one now, regardless of quiet
  dryRun?: boolean;
  now?: Date;
  roots?: Roots;
  maxAgeDays?: number;
}

export interface ReconcileResult {
  session_id: string;
  result: "none" | "drafts" | "skipped" | "error";
  draft_ids: string[];
  reason: string;
}

const PROMPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "prompts");
export const DEFAULT_QUIET_MS = 20 * 60_000;
export const MAX_ATTEMPTS = 3;

function debtReason(j: Journal, d = debt(j)): string {
  const tools = [...new Set(d.map((e) => e.tool))].slice(0, 4).join(", ");
  const compacted = j.entries.some((e) => e.kind === "compact");
  const ended = j.entries.some((e) => e.kind === "end");
  const ignored = j.entries.some((e) => e.kind === "unresolved");
  const how = ended ? "session ended" : "session went quiet";
  const why = ignored ? "the Stop checkpoint was ignored" : compacted ? "work preceded a compaction" : "no checkpoint fired";
  return `${d.length} data quer${d.length === 1 ? "y" : "ies"} ran (${tools}) and no ledger object was recorded; ${how}, ${why}`;
}

/** Process unresolved IDs once per successful extraction batch, not once per session. Review remains separate. */
export function extractionDebt(j: Journal, manual = false): JournalEntry[] {
  const batches = j.extractions ?? (j.extracted ? [j.extracted] : []);
  return debt(j).filter(query => {
    if (manual) return true;
    const related = batches.filter(batch => batch.evidence_ids?.includes(query.evidence_id!) ||
      (!batch.evidence_ids && query.at <= batch.at)); // migration: old reconciler recorded a through-time, never coverage
    const errors = related.filter(batch => batch.result === "error");
    return !related.some(batch => batch.result !== "error") && Math.max(errors.length, ...errors.map(batch => batch.attempts ?? 1)) < MAX_ATTEMPTS;
  });
}

/** Journals with capture debt that are not yet reconciled and whose transcript exists and is quiet (or ended, or named). */
export function findCandidates(opts: ReconcileOpts = {}): Candidate[] {
  const dir = opts.dir ?? sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const now = opts.now ?? new Date();
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const since = now.getTime() - (opts.maxAgeDays ?? 7) * 86_400_000;
  const out: Candidate[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let j: Journal;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (opts.sessionId && j.session_id !== opts.sessionId) continue;
    const activityAt = Math.max(Date.parse(j.started), Date.parse(j.entries.at(-1)?.at ?? j.started));
    if (activityAt < since) continue;
    const evidence = extractionDebt(j, Boolean(opts.sessionId)).slice(0, 20);
    if (!evidence.length) continue;
    const t = findTranscript(j.session_id, j.transcript_path, opts.roots);
    if (!t) continue;
    const lastEnd = j.entries.reduce((last, e, i) => e.kind === "end" ? i : last, -1), lastQuery = j.entries.reduce((last, e, i) => e.kind === "query" ? i : last, -1);
    const ended = lastEnd > lastQuery;
    const quietFor = now.getTime() - fs.statSync(t.path).mtimeMs;
    const trigger: Candidate["trigger"] = opts.sessionId ? "manual" : ended ? "session_end" : "quiet";
    if (trigger === "quiet" && quietMs > 0 && quietFor < quietMs) continue; // still live: let the hooks do their job
    out.push({ journal: j, transcript: t, trigger, reason: debtReason(j, evidence), evidence });
  }
  return out;
}

function readPrompt(rel: string): string {
  return fs.readFileSync(path.join(PROMPTS, rel), "utf8").trim();
}

export function composePrompt(cfg: Config, ev: Evidence, candidate: Pick<Candidate, "reason">): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    readPrompt("base/purpose.md"),
    readPrompt("base/format.md"),
    readPrompt("operations/capture.md"),
    `# This run`,
    `Today is ${today}. The human who owns anything you write is "${cfg.author}"; use that as owner where a field asks for a person.`,
    `Why the fallback ran: ${candidate.reason}.`,
    `Coverage contract: each draft must include evidence_ids next to type and fields, listing only exact query IDs in the evidence below that this draft actually captures. Do not cover unrelated queries. A draft is pending review, never accepted knowledge. Missing, redacted, unresolved or aggregate outputs must be stated as limitations; never invent a completed query result.`,
    `# Transcript evidence`,
    evidenceText(ev),
  ].join("\n\n");
}

/**
 * Run the extractor. Provider order: LEDGER_EXTRACTOR_CMD (any command that
 * reads the prompt on stdin and prints JSON; used by tests), then config
 * `extractor`, then whichever of claude / codex is installed. Both CLIs run
 * with the user's own login, no API key.
 *
 * The child inherits the user's hooks, including ours. LEDGER_HOOKS_OFF=1
 * makes every `ledger hook` invocation exit at once, so the extraction
 * session can neither journal nor block itself. (`claude --bare` would skip
 * hooks too, but it also skips credential loading: "Not logged in".)
 * `--tools ""` disables tools, so the model can only answer.
 */
export function runExtractor(prompt: string, cfg: Config): string {
  const env = { ...process.env, LEDGER_HOOKS_OFF: "1" };
  const run = (file: string, args: string[], stdout: "pipe" | "ignore" = "pipe"): string => {
    try {
      const out = execFileSync(file, args, { input: prompt, env, timeout: 300_000, maxBuffer: 8 << 20, stdio: ["pipe", stdout, "pipe"] });
      return out ? out.toString() : "";
    } catch (e: any) {
      const err = String(e?.stderr ?? "").trim() || String(e?.stdout ?? "").trim() || String(e?.message ?? e);
      throw new Error(`${file} ${args.slice(0, 2).join(" ")}: ${err.slice(0, 300)}`);
    }
  };
  const cmd = process.env.LEDGER_EXTRACTOR_CMD;
  if (cmd) return execSync(cmd, { input: prompt, env, timeout: 120_000, maxBuffer: 8 << 20 }).toString();
  const want = process.env.LEDGER_EXTRACTOR || cfg.extractor || "auto";
  const has = (bin: string) => {
    try {
      execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const useClaude = want === "claude" || (want === "auto" && has("claude"));
  const useCodex = want === "codex" || (want === "auto" && !useClaude && has("codex"));
  if (useClaude) return run("claude", ["-p", "--output-format", "text", "--no-session-persistence", "--tools", ""]);
  if (useCodex) {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-x-")), "last.md");
    run("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, "-"], "ignore");
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  }
  throw new Error("no extractor available: install claude or codex, or set LEDGER_EXTRACTOR_CMD");
}

/**
 * Same provider order and arguments as runExtractor, without blocking the event
 * loop. The helper daemon uses this so a model call for classification never
 * stalls tailing or snapshots for other sessions.
 */
export function runExtractorAsync(prompt: string, cfg: Config): Promise<string> {
  const env = { ...process.env, LEDGER_HOOKS_OFF: "1" };
  const run = (file: string, args: string[], captureStdout = true): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(file, args, { env, timeout: 300_000, maxBuffer: 8 << 20 }, (e: any, stdout, stderr) => {
        if (e) {
          const err = String(stderr ?? "").trim() || String(stdout ?? "").trim() || String(e?.message ?? e);
          reject(new Error(`${file} ${args.slice(0, 2).join(" ")}: ${err.slice(0, 300)}`));
        } else resolve(captureStdout ? String(stdout ?? "") : "");
      });
      child.stdin?.end(prompt);
    });
  const cmd = process.env.LEDGER_EXTRACTOR_CMD;
  if (cmd) {
    return new Promise((resolve, reject) => {
      const child = exec(cmd, { env, timeout: 120_000, maxBuffer: 8 << 20 }, (e: any, stdout, stderr) => {
        if (e) reject(new Error(`extractor cmd: ${String(stderr ?? e?.message ?? e).slice(0, 300)}`));
        else resolve(String(stdout ?? ""));
      });
      child.stdin?.end(prompt);
    });
  }
  const want = process.env.LEDGER_EXTRACTOR || cfg.extractor || "auto";
  const has = (bin: string) => {
    try {
      execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const useClaude = want === "claude" || (want === "auto" && has("claude"));
  const useCodex = want === "codex" || (want === "auto" && !useClaude && has("codex"));
  if (useClaude) return run("claude", ["-p", "--output-format", "text", "--no-session-persistence", "--tools", ""]);
  if (useCodex) {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-x-")), "last.md");
    return run("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, "-"], false).then(() =>
      fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : ""
    );
  }
  return Promise.reject(new Error("no extractor available: install claude or codex, or set LEDGER_EXTRACTOR_CMD"));
}

export interface ExtractorOutput {
  drafts: { type: LedgerType; fields: Record<string, unknown>; evidence_ids?: string[] }[];
  reason: string;
}

/** Tolerant JSON parse: the model may wrap in a fence or add a sentence. */
export function parseDrafts(out: string): ExtractorOutput {
  const s = out.trim();
  const candidates = [s, s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""), s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const drafts = Array.isArray(j?.drafts) ? j.drafts : [];
      return {
        drafts: drafts.filter((d: any) => d && TYPES.includes(d.type) && d.fields && typeof d.fields === "object"),
        reason: String(j?.reason ?? ""),
      };
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`extractor returned non-JSON: ${s.slice(0, 200)}`);
}

export function reconcile(cfg: Config, opts: ReconcileOpts = {}): ReconcileResult[] {
  const dir = opts.dir ?? sessionsDir();
  const results: ReconcileResult[] = [];
  for (const c of findCandidates(opts)) {
    const j = loadJournal(c.journal.session_id, dir);
    const idsConsidered = c.evidence.map(e => e.evidence_id!);
    const mark = (result: ReconcileResult["result"], reason: string, draft_ids: string[] = [], processedIds = idsConsidered) => {
      if (!opts.dryRun) {
        withJournalLock(j.session_id, () => {
        // Reload: successful draft acknowledgment or another hook may have appended since parsing began.
        const current = loadJournal(j.session_id, dir);
        const history = current.extractions ?? (current.extracted ? [current.extracted] : []);
        const attempts = history.filter(batch => JSON.stringify(batch.evidence_ids) === JSON.stringify(processedIds)).length + 1;
        current.extracted = { at: (opts.now ?? new Date()).toISOString(), result, reason, draft_ids, attempts, evidence_ids: processedIds };
        current.extractions = [...history, current.extracted];
        saveJournal(current, dir);
        }, dir);
      }
      results.push({ session_id: j.session_id, result, draft_ids, reason });
    };
    let ev: Evidence;
    try {
      ev = parseTranscript(c.transcript.path, c.transcript.agent, cfg.data_tools ?? DEFAULT_DATA_TOOLS);
      const wanted = new Set(idsConsidered);
      ev.queries = ev.queries.filter(query => query.evidence_id && wanted.has(query.evidence_id));
      const captured = new Set(ev.queries.map(query => query.evidence_id));
      const missing = idsConsidered.filter(id => !captured.has(id));
      if (missing.length) throw new Error(`Owed query IDs are missing from normalized transcript evidence: ${missing.join(", ")}. No unrelated transcript query can satisfy them.`);
    } catch (e: any) {
      mark("error", `could not read transcript: ${e?.message ?? e}`);
      continue;
    }
    if (!hasMaterialActivity(ev)) {
      mark("skipped", "transcript shows no data-tool calls");
      continue;
    }
    if (opts.dryRun) {
      results.push({ session_id: j.session_id, result: "skipped", draft_ids: [], reason: `dry run: would extract (${c.reason})` });
      continue;
    }
    let parsed: ExtractorOutput;
    try {
      parsed = parseDrafts(runExtractor(composePrompt(cfg, ev, c), cfg));
    } catch (e: any) {
      mark("error", `extractor failed: ${String(e?.message ?? e).slice(0, 200)}`);
      continue;
    }
    if (!parsed.drafts.length) {
      mark("none", parsed.reason || "extractor found nothing durable");
      continue;
    }
    const ids: string[] = [];
    const covered = new Set<string>();
    const errors: string[] = [];
    for (const d of parsed.drafts) {
      try {
        if (!Array.isArray(d.evidence_ids) || !d.evidence_ids.length || new Set(d.evidence_ids).size !== d.evidence_ids.length || d.evidence_ids.some(id => !idsConsidered.includes(id))) throw new Error("draft must name nonempty, distinct evidence_ids from this exact owed batch");
        const coverage = [{ session_id: j.session_id, evidence_ids: d.evidence_ids }];
        const r = recordDraft(cfg, {
          type: d.type,
          fields: { ...d.fields, capture_coverage: coverage },
          capture: { method: "transcript_fallback", session: j.session_id, agent: ev.agent, reason: c.reason },
        });
        ids.push(r.id);
        acknowledgeCapture({ schema: "ledger-capture/v1", action: "record", status: "pending_review", record_id: r.id, coverage }, { dir, now: opts.now });
        d.evidence_ids.forEach(id => covered.add(id));
      } catch (e: any) {
        errors.push(`${d.type}: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    if (ids.length) mark("drafts", `${parsed.reason}${errors.length ? ` (${errors.length} draft(s) rejected: ${errors.join("; ")})` : ""}`, ids, [...covered]);
    else mark("error", `every draft was rejected: ${errors.join("; ")}`);
  }
  return results;
}

/** The review queue: fallback drafts, newest first. A human's own draft is not a review item. */
export function pendingDrafts(cfg: Config) {
  return loadAll(cfg).filter((o) => o.status === "draft" && o.fields.capture_method === "transcript_fallback");
}
