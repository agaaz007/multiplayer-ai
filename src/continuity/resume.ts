import path from "node:path";
import type pg from "pg";
import { loadAll, type Config } from "../store.js";
import { TYPES } from "../schema.js";
import { claimThread, createThread, getClaim, getThread, headCheckpoint, latestCheckpointAny, pendingOperations, sessionEvents, threadEvents, getSession, summarizeThread, type ClaimRow, type ThreadRow, type ThreadSummary } from "./store.js";
import { defaultRemoteBranch, diffStat, fetchQuiet, repoRoot, repoIdentity } from "./shadow.js";

/**
 * The resume pack (spec §7). Built mechanically from the store and git; the
 * reader is an LLM and gets evidence, not a summary. Budgeted, and anything
 * dropped for budget is named so it can be fetched.
 */

export type ResumeMode = "continue" | "fork" | "inspect";

export interface ResumeOpts {
  mode: ResumeMode;
  author: string;
  /** the session doing the resuming; synthesized if absent */
  sessionId?: string;
  /** a local checkout of the same repo, for the intervening-changes diff and the bootstrap commands */
  repoPath?: string;
  budgetTokens?: number;
  now?: Date;
}

export interface ResumePack {
  thread: ThreadSummary;
  claim: { acquired: boolean; generation?: number; holder?: ClaimRow | null; note: string };
  fork?: ThreadRow;
  checkpoint: Record<string, unknown> | null;
  loss_window: Record<string, unknown>;
  capture_gaps: unknown[];
  instructions: { seq: number; at: string | null; text: string }[];
  last_messages: { at: string | null; text: string }[];
  files_touched: { path: string; count: number }[];
  pending_operations: { call_id: string; tool: string; input: string; seq: number }[];
  last_error: Record<string, unknown> | null;
  intervening: { git: string | null; ledger: string[] };
  bootstrap: string[];
  omitted: string[];
  text: string;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 19).replace("T", " ") + "Z" : "unknown");

export async function buildResumePack(cfg: Config, pool: pg.Pool, threadId: string, opts: ResumeOpts): Promise<ResumePack> {
  const now = opts.now ?? new Date();
  const budget = opts.budgetTokens ?? 6000;
  const omitted: string[] = [];
  let t = await getThread(pool, threadId);
  if (!t) throw new Error(`thread not found: ${threadId}`);

  // ----- claim / fork -----
  const sessionId = opts.sessionId ?? `resume:${opts.author}:${now.toISOString()}`;
  let fork: ThreadRow | undefined;
  let claimInfo: ResumePack["claim"];
  if (opts.mode === "fork") {
    const cp = await headCheckpoint(pool, t.id);
    fork = await createThread(pool, { repo: t.repo, branch: t.branch, title: `${t.title} (${opts.author} fork)`, goal: t.goal, created_by: opts.author, forked_from_thread_id: t.id, forked_at_checkpoint_id: cp?.id ?? null });
    const c = await claimThread(pool, fork.id, sessionId, opts.author);
    claimInfo = { acquired: c.ok, generation: c.ok ? c.generation : undefined, holder: null, note: `forked from ${t.id} at checkpoint ${cp?.id ?? "none"}; you own the fork` };
  } else if (opts.mode === "continue") {
    const c = await claimThread(pool, t.id, sessionId, opts.author);
    if (c.ok) claimInfo = { acquired: true, generation: c.generation, holder: null, note: `claim acquired, generation ${c.generation}. Advisory: it protects the shared record, not the other machine.` };
    else claimInfo = { acquired: false, holder: c.holder, note: `claim held by ${c.holder.holder_author} since ${fmt(c.holder.acquired_at)} (heartbeat ${fmt(c.holder.heartbeat_at)}). Read-only pack; use mode=fork to work in parallel, or wait for release/expiry at ${fmt(c.holder.expires_at)}.` };
  } else {
    const live = await getClaim(pool, t.id);
    claimInfo = { acquired: false, holder: live, note: live ? `claim held by ${live.holder_author}; inspect only` : "no live claim; inspect only" };
  }

  // ----- checkpoint & sessions -----
  const head = await headCheckpoint(pool, t.id);
  const latest = head ?? (await latestCheckpointAny(pool, t.id));
  if (!head && latest) omitted.push(`thread has no head checkpoint; showing latest non-head checkpoint ${latest.id} (${latest.kind}, did not advance: claim/generation mismatch at publish)`);
  const srcSession = latest ? await getSession(pool, latest.session_id) : null;

  // ----- evidence -----
  const instrRows = await threadEvents(pool, t.id, { kinds: ["instruction.added"] });
  const msgRows = await threadEvents(pool, t.id, { kinds: ["assistant.message"], limit: 3 });
  const fileRows = await threadEvents(pool, t.id, { kinds: ["file.changed"] });
  const gapRows = await threadEvents(pool, t.id, { kinds: ["capture.gap"], limit: 20 });
  const pend = srcSession ? await pendingOperations(pool, srcSession.id) : [];
  const errRows = srcSession ? await sessionEvents(pool, srcSession.id, { kinds: ["tool.finished"] }) : [];
  const lastErr = [...errRows].reverse().find((e) => e.payload?.is_error || (typeof e.payload?.stderr_preview === "string" && e.payload.stderr_preview));

  const fileCounts = new Map<string, number>();
  for (const f of fileRows) { const p = String(f.payload?.path ?? ""); if (p) fileCounts.set(p, (fileCounts.get(p) ?? 0) + 1); }
  const files = [...fileCounts].map(([p, n]) => ({ path: p, count: n })).sort((a, b) => b.count - a.count);

  // ----- loss window (measured, never a constant) -----
  const lastSeen = srcSession?.last_seen_at ?? null;
  const vSnap = latest?.verified_snapshot_at ?? srcSession?.last_verified_snapshot_at ?? null;
  const vEv = latest?.verified_events_at ?? srcSession?.last_acked_event_at ?? null;
  const secs = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, Math.round((a.getTime() - b.getTime()) / 1000)) : null);
  const loss = {
    last_seen_at: lastSeen, verified_snapshot_at: vSnap, verified_events_at: vEv,
    unsaved_code_seconds: secs(lastSeen, vSnap), unacked_event_seconds: secs(lastSeen, vEv),
    session_ended: Boolean(srcSession?.ended_at),
    in_flight_operations: pend.length,
  };
  const gaps: unknown[] = [...(latest?.capture_gaps ?? []), ...gapRows.map((g) => g.payload)];

  // ----- intervening changes -----
  let gitDiff: string | null = null;
  let bootstrap: string[] = [];
  const wipRef = latest?.wip_ref ?? srcSession?.wip_ref ?? null;
  const wipCommit = latest?.wip_commit ?? srcSession?.wip_commit ?? null;
  const baseCommit = latest?.base_commit ?? srcSession?.base_commit ?? null;
  const localRepo = opts.repoPath ? repoRoot(opts.repoPath) : null;
  const sameRepo = localRepo ? repoIdentity(localRepo) === t.repo : false;
  if (localRepo && sameRepo) {
    fetchQuiet(localRepo);
    const target = defaultRemoteBranch(localRepo);
    if (baseCommit) {
      const d = diffStat(localRepo, baseCommit, target);
      gitDiff = `${baseCommit.slice(0, 8)}..${target}:\n${d.text}${d.truncated ? "\n(truncated)" : ""}`;
    }
  } else if (opts.repoPath) {
    omitted.push(`intervening git diff skipped: ${localRepo ? `local checkout is ${repoIdentity(localRepo)}, thread repo is ${t.repo}` : `${opts.repoPath} is not a git repo`}`);
  }
  if (wipRef && wipCommit) {
    const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thread";
    bootstrap = [
      `git fetch origin ${wipRef}:${wipRef}`,
      `git worktree add --detach ../${slug} ${wipCommit}`,
      `# then, deliberately: git -C ../${slug} rebase ${localRepo ? defaultRemoteBranch(localRepo) : "origin/master"}   (or merge; your call, not automatic)`,
    ];
  } else {
    omitted.push("no verified code snapshot for this thread: the helper never confirmed a wip ref on the remote; continue from the branch tip and treat the code state as unknown");
  }

  // ----- ledger objects since the checkpoint -----
  const since = latest?.created_at ?? t.created_at;
  const repoTag = path.basename(t.repo).toLowerCase();
  const ledgerSince = loadAll(cfg, TYPES)
    .filter((o) => o.status === "stable" && o.created >= since.toISOString())
    .filter((o) => o.tags.some((x) => x.toLowerCase() === repoTag) || JSON.stringify(o.fields).toLowerCase().includes(repoTag) || o.title.toLowerCase().includes(repoTag))
    .slice(0, 10)
    .map((o) => `${o.type} ${o.id}: ${o.title} (${o.author}, ${o.created.slice(0, 10)})`);
  const refDecisions: { ledger_id: string; version?: string }[] = Array.isArray(latest?.structured_state?.decisions) ? latest!.structured_state.decisions : [];
  const all = refDecisions.length ? loadAll(cfg, ["decision"]) : [];
  const superseded = refDecisions.map((d) => all.find((o) => o.id === d.ledger_id)).filter((o) => o && o.status === "deprecated").map((o) => `${o!.id} → superseded by ${o!.superseded_by}`);

  // ----- render within budget -----
  const summary = await summarizeThread(pool, t);
  const L: string[] = [];
  L.push(`# Resume pack: ${t.title}`);
  L.push(`thread ${t.id} · repo ${t.repo}${t.branch ? ` · branch ${t.branch}` : ""} · created by ${t.created_by} ${fmt(t.created_at)} · status ${t.status} · generation ${t.generation}`);
  if (fork) L.push(`FORK: you are on ${fork.id} ("${fork.title}"), forked from the thread above.`);
  L.push(`claim: ${claimInfo.note}`);
  L.push(``);
  L.push(`## Honesty`);
  L.push(`Code saved through ${fmt(vSnap)} (remote-verified). Events acknowledged through ${fmt(vEv)}. Source session last seen ${fmt(lastSeen)}${srcSession?.ended_at ? ", ended" : ", not marked ended"}.`);
  if (loss.unsaved_code_seconds != null) L.push(`Up to ${loss.unsaved_code_seconds}s of edits and ${pend.length} in-flight tool call(s) may be missing.`);
  else L.push(`No verified snapshot timestamp: treat the code state as unverified.`);
  L.push(`The claim is advisory. It protects the shared record, not the other machine. Any narrative below is generated and unreviewed; machine fields are the evidence.`);
  if (gaps.length) L.push(`Capture gaps (${gaps.length}): ${JSON.stringify(gaps.slice(0, 6))}${gaps.length > 6 ? " …" : ""}`);
  L.push(``);
  L.push(`## Goal`);
  L.push(t.goal || summary.first_instruction || "(no goal recorded; first instruction below)");
  L.push(``);
  L.push(`## Human instructions (${instrRows.length}, in order)`);
  const instr = instrRows.map((e) => ({ seq: e.seq, at: e.occurred_at ? e.occurred_at.toISOString() : null, text: String(e.payload?.text ?? "") }));
  const instrBudgetChars = Math.floor(budget * 4 * 0.35);
  let used = 0;
  const shownInstr: typeof instr = [];
  for (const i of instr) {
    const t400 = i.text.length > 400 ? i.text.slice(0, 399) + "…" : i.text;
    if (used + t400.length > instrBudgetChars && shownInstr.length >= 3) { omitted.push(`${instr.length - shownInstr.length} earlier instruction(s) omitted for budget; fetch with ledger_thread_get ${t.id}`); break; }
    shownInstr.push({ ...i, text: t400 });
    used += t400.length;
  }
  for (const i of shownInstr) L.push(`- [seq ${i.seq}${i.at ? ` ${i.at.slice(11, 16)}` : ""}] ${i.text.replace(/\n+/g, " ")}`);
  L.push(``);
  L.push(`## Checkpoint (${latest ? `${latest.kind}, ${fmt(latest.created_at)}${latest.advanced_head ? "" : ", NOT the head"}` : "none"})`);
  if (latest) {
    L.push(`base_commit ${baseCommit?.slice(0, 10) ?? "?"} · wip ${wipRef ?? "none"} @ ${wipCommit?.slice(0, 10) ?? "?"} · through event seq ${latest.through_event_seq}`);
    const ss = latest.structured_state ?? {};
    if (ss.tools_summary) L.push(`tools: ${JSON.stringify(ss.tools_summary)}`);
    if (ss.last_error) L.push(`last error at publish: ${JSON.stringify(ss.last_error).slice(0, 300)}`);
    if (latest.narrative) L.push(`narrative (${latest.narrative_status}): ${latest.narrative.slice(0, 800)}`);
  }
  L.push(``);
  L.push(`## Files touched (${files.length})`);
  for (const f of files.slice(0, 30)) L.push(`- ${f.path} ×${f.count}`);
  if (files.length > 30) omitted.push(`${files.length - 30} more touched files`);
  L.push(``);
  L.push(`## Pending / unknown operations (${pend.length})`);
  for (const p of pend) L.push(`- seq ${p.seq} ${p.tool}: ${String(p.input).replace(/\n+/g, " ").slice(0, 200)}  ← outcome unknown; do not blindly rerun if it mutates anything`);
  if (lastErr) { L.push(``); L.push(`## Last error`); L.push(`seq ${lastErr.seq} ${JSON.stringify({ ...lastErr.payload, output_preview: String(lastErr.payload?.output_preview ?? "").slice(0, 400) })}`); }
  L.push(``);
  L.push(`## Last assistant messages`);
  for (const m of msgRows) L.push(`- [${m.occurred_at ? m.occurred_at.toISOString().slice(11, 16) : "?"}] ${String(m.payload?.text ?? "").replace(/\n+/g, " ").slice(0, 600)}`);
  L.push(``);
  L.push(`## Since the checkpoint`);
  L.push(gitDiff ? `git diff --stat ${gitDiff}` : `git: ${omitted.find((o) => o.startsWith("intervening")) ?? "no local checkout given; pass repoPath to compute"}`);
  L.push(ledgerSince.length ? `ledger objects mentioning ${repoTag} since ${fmt(since)}:\n${ledgerSince.map((s) => `- ${s}`).join("\n")}` : `ledger: nothing new mentioning ${repoTag} since ${fmt(since)}`);
  if (superseded.length) L.push(`SUPERSEDED decisions this checkpoint relied on: ${superseded.join("; ")}`);
  L.push(``);
  L.push(`## Bootstrap`);
  L.push(bootstrap.length ? "```\n" + bootstrap.join("\n") + "\n```" : "(no snapshot to check out)");
  L.push(``);
  L.push(`## First turn contract`);
  L.push(`1. Check out the snapshot into a fresh worktree and inspect it; do not assume the branch tip matches.`);
  L.push(`2. State what is confirmed (verified snapshot, acknowledged events) vs uncertain (loss window, pending operations, gaps).`);
  L.push(`3. Do not rerun a pending operation that mutates anything until you know its outcome.`);
  L.push(`4. Say what you are continuing and what your next action is. Record progress as you go; the helper captures automatically.`);
  if (omitted.length) { L.push(``); L.push(`## Omitted for budget or unavailable`); for (const o of omitted) L.push(`- ${o}`); }

  let text = L.join("\n");
  if (approxTokens(text) > budget) {
    // shrink the softest sections first: assistant messages, then files
    const cut = text.indexOf("## Last assistant messages");
    const next = text.indexOf("## Since the checkpoint");
    if (cut > 0 && next > cut) { text = text.slice(0, cut) + `## Last assistant messages\n(omitted for budget; ledger_thread_get ${t.id})\n\n` + text.slice(next); omitted.push("last assistant messages"); }
  }

  return {
    thread: summary, claim: claimInfo, fork, checkpoint: latest ? { id: latest.id, kind: latest.kind, created_at: latest.created_at, base_commit: baseCommit, wip_ref: wipRef, wip_commit: wipCommit, through_event_seq: latest.through_event_seq, structured_state: latest.structured_state, narrative_status: latest.narrative_status, advanced_head: latest.advanced_head } : null,
    loss_window: loss, capture_gaps: gaps, instructions: shownInstr,
    last_messages: msgRows.map((m) => ({ at: m.occurred_at ? m.occurred_at.toISOString() : null, text: String(m.payload?.text ?? "") })),
    files_touched: files, pending_operations: pend.map((p) => ({ call_id: p.call_id, tool: p.tool, input: p.input, seq: p.seq })),
    last_error: lastErr ? lastErr.payload : null, intervening: { git: gitDiff, ledger: ledgerSince }, bootstrap, omitted, text,
  };
}

/** One line per thread for the brief and `ledger threads`. */
export function threadLine(s: ThreadSummary, now = new Date()): string {
  const ls = s.last_session;
  const ago = (d: Date | null | undefined) => (d ? `${Math.round((now.getTime() - new Date(d).getTime()) / 60000)}m ago` : "never");
  const ended = ls?.ended_at ? "ended" : ls?.last_seen_at && now.getTime() - new Date(ls.last_seen_at).getTime() > 10 * 60_000 ? "went quiet" : "active";
  const claim = s.claim ? `claimed by ${s.claim.holder_author}` : "unclaimed";
  const snap = s.head?.verified_snapshot_at ? `snapshot ${ago(s.head.verified_snapshot_at)}` : "no verified snapshot";
  const first = (s.first_instruction ?? s.goal ?? "").replace(/\s+/g, " ").slice(0, 90);
  const last = (s.last_message ?? "").replace(/\s+/g, " ").slice(0, 90);
  return `- ${s.created_by} · ${ls?.harness ?? "?"} · ${path.basename(s.repo)}${s.branch ? ` · ${s.branch}` : ""} · last seen ${ago(ls?.last_seen_at)} (${ended}) · ${snap} · ${claim}\n  "${first}"${last ? ` → "${last}"` : ""}\n  ${s.id}`;
}
