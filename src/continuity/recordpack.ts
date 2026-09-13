import path from "node:path";
import type pg from "pg";
import { loadAll, type Config } from "../store.js";
import { TYPES } from "../schema.js";
import { objectVersion, resolveAccepted, correctionImpact } from '../authority.js';
import { claimThread, getClaim, getSession, getThread, headCheckpoint, pendingOperations, type ClaimRow, type ThreadRow } from "./store.js";
import { listRecords, recordEvidence, recordEvidenceCount, recordLinks, recordState, unassignedSpans, type LinkSource, type RecordKind, type RecordState, type RecordStatus, type StateUpdate, type UnassignedSpan, type WorkRecord } from "./records.js";
import { clipSummary, INSTRUCTIONS_HEAD, RECENT_FILES_MINUTES, SUMMARY_BUDGET_SHARE, SUMMARY_MAX_TOKENS } from "./resume.js";
import { eventLine, PREVIEW_MAX_CHARS } from "./evidence.js";
import { defaultRemoteBranch, repoIdentity, repoRoot } from "./shadow.js";
import { readProgress } from "./classify.js";
import { DECISION_RULE, ledgerRefStatuses, renderDecisionsInForce, stateLine, writtenLedgerIds, type LedgerRefInput, type LedgerRefStatus } from "./packsections.js";
export { acceptanceLabel, evidenceRefs, stateLine, type LedgerRefStatus } from "./packsections.js";

/**
 * The record pack (spec §13a, "Retrieval by record"): the active context for
 * one work record, assembled from the shared evidence layer and the record's
 * own state projection. A record accumulates from many sessions and teammates,
 * so everything here is attributed to a session and an author, ordered by
 * time, and shaped for recency the way the thread resume pack is (first few
 * instructions, last N events). Proposed state is flagged, contradictions are
 * shown side by side, linked Ledger objects are checked for supersession, and
 * every omission names the call that fetches it.
 *
 * Threads stay the physical unit: a claim, when one is acquired, is on the
 * thread of the most recent contributing session; a non-code record has none.
 */

type Q = pg.Pool | pg.PoolClient;

/** Evidence keeps the first EVIDENCE_HEAD instructions (the goal) and the last EVIDENCE_TAIL content events (what just happened). */
export const EVIDENCE_HEAD = INSTRUCTIONS_HEAD;
export const EVIDENCE_TAIL = 8;
/** Per state kind, the newest STATE_MAX_PER_KIND items; a pack asked for with budget >= STATE_WIDE_BUDGET shows up to STATE_MAX_PER_KIND_WIDE. */
export const STATE_MAX_PER_KIND = 8;
export const STATE_MAX_PER_KIND_WIDE = 50;
export const STATE_WIDE_BUDGET = 20_000;
export const FILES_MAX = 20;
export const UNASSIGNED_MAX = 5;
const EVIDENCE_PREVIEW = 160;
/** Kinds that carry human or agent content; matches the records layer's notion of content for spans. */
const EVIDENCE_KINDS = ["instruction.added", "assistant.message", "tool.requested", "file.changed", "compaction"];
const COVERING: LinkSource[] = ["explicit", "suggested"];
type StateKey = "decisions" | "blockers" | "next" | "progress" | "hypotheses" | "contradictions" | "notes";
/** Render order. `hard` kinds keep their cap under budget pressure; soft kinds shrink first. */
const STATE_ORDER: { key: StateKey; label: string; hard: boolean }[] = [
  { key: "decisions", label: "Decisions", hard: true },
  { key: "blockers", label: "Blockers", hard: true },
  { key: "next", label: "Next", hard: false },
  { key: "progress", label: "Progress", hard: false },
  { key: "hypotheses", label: "Hypotheses", hard: false },
  { key: "contradictions", label: "Contradictions (both sides kept; never resolved by timestamp)", hard: false },
  { key: "notes", label: "Notes", hard: false },
];

export type RecordPackMode = "continue" | "inspect";

export interface RecordPackOpts {
  author: string;
  mode: RecordPackMode;
  /** the session doing the resuming; synthesized if absent */
  sessionId?: string;
  /** a local checkout of the record's repo, for the bootstrap rebase target */
  repoPath?: string;
  budgetTokens?: number;
  now?: Date;
}

export interface ContributingSession {
  session_id: string; author: string; harness: string; last_seen_at: Date | null; ended: boolean; spans: number;
  repo: string | null; thread_id: string | null; verified_snapshot_at: Date | null;
  wip_ref: string | null; wip_commit: string | null; base_commit: string | null;
}

export interface RecordSources {
  instructions: number; assistant_messages: number; tool_calls: number; compaction_summaries: number;
  sessions: number; spans: number; proposed_updates: number; confirmed_updates: number;
}

export interface EvidenceItem { session_id: string; author: string; harness: string; seq: number; kind: string; at: string | null; link_source: LinkSource; line: string }

export interface LedgerRefStatus {
  id: string; version?: string; found: boolean; type: string | null; title: string | null; author: string | null; created: string | null;
  status: string | null; superseded_by: string | null;
  authority_status: string; current_ids: string[]; version_matches: boolean | null; warnings: string[];
}

export interface RecordPack {
  record: WorkRecord;
  state: RecordState;
  ledger_refs: LedgerRefStatus[];
  /** the evidence shown, in time order, plus the gap named with the calls that fetch it */
  evidence_summary: { total: number; shown: EvidenceItem[]; omitted: { count: number; fetch: string[] } | null };
  /** the latest compaction summary inside the record's spans; evidence, not memory */
  session_summary: { source: string; harness: string; session_id: string; seq: number; at: string | null; text: string; chars: number; clipped: boolean } | null;
  /** files changed inside the record's spans, recent ones first, then by count */
  files: { path: string; count: number; last_at: string | null; recent: boolean }[];
  recent_files: { path: string; count: number; last_at: string | null }[];
  pending_operations: { call_id: string; tool: string; input: string; seq: number; session_id: string }[];
  last_error: { session_id: string; seq: number; payload: Record<string, unknown> } | null;
  unassigned: UnassignedSpan[];
  contributing_sessions: ContributingSession[];
  claim: { acquired: boolean; generation?: number; holder?: ClaimRow | null; thread_id: string | null; note: string };
  bootstrap: string[];
  sources: RecordSources;
  omitted: string[];
  text: string;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 19).replace("T", " ") + "Z" : "unknown");
const dateOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "unknown");
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clipTo = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const harnessName = (h: string | null | undefined) => (h === "claude" ? "Claude Code" : h === "codex" ? "Codex" : h || "unknown harness");
const num = (n: number) => n.toLocaleString("en-US");
const short = (sid: string) => sid.slice(0, 8);
const q = (s: string) => JSON.stringify(s);

/** "12m ago", "5h ago", "3d ago"; "never" when unknown. */
export function ago(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "never";
  const min = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 60_000));
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (24 * 60))}d ago`;
}

/** Evidence refs of a state update grouped by session: "evidence: seq 3,4 of 0199aaaa; seq 1 of agaaz-cl". */
export function evidenceRefs(u: StateUpdate): string {
  const by = new Map<string, number[]>();
  for (const e of u.evidence ?? []) by.set(e.session_id, [...(by.get(e.session_id) ?? []), e.seq]);
  if (!by.size) return "no evidence refs";
  return "evidence: " + [...by].map(([sid, seqs]) => `seq ${[...new Set(seqs)].sort((a, b) => a - b).join(",")} of ${short(sid)}`).join("; ");
}

/** `[confirmed|PROPOSED] text (by <created_by>, <date>; evidence: seq a,b,c of <session short id>)` */
export function stateLine(u: StateUpdate): string {
  const flag = u.status === "confirmed" ? "confirmed" : "PROPOSED";
  const who = u.status === "confirmed" && u.confirmed_by && u.confirmed_by !== u.created_by ? `by ${u.created_by}, ${dateOf(u.created_at)}, confirmed by ${u.confirmed_by}` : `by ${u.created_by}, ${dateOf(u.created_at)}`;
  return `- [${flag}] ${oneLine(u.text)} (${who}; ${evidenceRefs(u)})`;
}

/** One line per unassigned span, for the pack, the brief, and `ledger unassigned`. */
export function unassignedLine(s: UnassignedSpan, now = new Date()): string {
  const when = s.last_at ? `${ago(s.last_at, now)}${s.first_at && s.first_at.getTime() !== s.last_at.getTime() ? `, ${fmt(s.first_at).slice(11, 16)}–${fmt(s.last_at).slice(11, 16)}` : ""}` : "time unknown";
  return `- ${s.author} · ${s.harness} · session ${short(s.session_id)} seq ${s.from_seq}..${s.to_seq} (${s.event_count} event${s.event_count === 1 ? "" : "s"}, ${when}) "${oneLine(s.preview)}"`;
}

// ---------- listing: one line per record with contribution counts ----------

export interface RecordSummary extends WorkRecord {
  sessions: number;
  proposed: number;
  confirmed: number;
  newest_proposed: { id: string; kind: string; text: string; created_by: string; created_at: Date } | null;
}

/** listRecords plus per-record counts: distinct contributing sessions, proposed/confirmed updates in the current projection, and the newest proposed update. */
export async function listRecordSummaries(qq: Q, f: { repo?: string | null; kind?: RecordKind; status?: RecordStatus; author?: string; sinceHours?: number; q?: string; limit?: number } = {}): Promise<RecordSummary[]> {
  const recs = await listRecords(qq, f);
  if (!recs.length) return [];
  const live = `u.status <> 'rejected' and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status = 'confirmed')`;
  const r = await qq.query<{ id: string; sessions: number; proposed: number; confirmed: number; np_id: string | null; np_kind: string | null; np_text: string | null; np_by: string | null; np_at: Date | null }>(
    `select r.id,
            (select count(distinct l.session_id) from cont_record_links l where l.record_id = r.id)::int as sessions,
            (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'proposed' and ${live})::int as proposed,
            (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'confirmed' and ${live})::int as confirmed,
            np.id as np_id, np.kind as np_kind, np.text as np_text, np.created_by as np_by, np.created_at as np_at
       from cont_records r
       left join lateral (select u.id, u.kind, u.text, u.created_by, u.created_at from cont_state_updates u where u.record_id = r.id and u.status = 'proposed' and ${live} order by u.created_at desc, u.id desc limit 1) np on true
      where r.id = any($1::uuid[])`,
    [recs.map((x) => x.id)]
  );
  const by = new Map(r.rows.map((x) => [x.id, x]));
  return recs.map((rec) => {
    const c = by.get(rec.id);
    return { ...rec, sessions: c?.sessions ?? 0, proposed: c?.proposed ?? 0, confirmed: c?.confirmed ?? 0, newest_proposed: c?.np_id ? { id: c.np_id, kind: c.np_kind!, text: c.np_text!, created_by: c.np_by!, created_at: c.np_at! } : null };
  });
}

/** `<kind> · <title> · <repo basename or non-code> · updated <ago> · <n> sessions · <proposed>/<confirmed> updates · <id>` */
export function recordLine(s: RecordSummary, now = new Date()): string {
  return `- ${s.kind} · ${s.title} · ${s.repo ? path.basename(s.repo) : "non-code"} · updated ${ago(s.updated_at, now)} · ${s.sessions} session${s.sessions === 1 ? "" : "s"} · ${s.proposed}/${s.confirmed} updates · ${s.id}`;
}

// ---------- private: what the record's evidence is made of ----------

async function recordSourceCounts(qq: Q, recordId: string): Promise<Omit<RecordSources, "proposed_updates" | "confirmed_updates">> {
  const r = await qq.query<Omit<RecordSources, "proposed_updates" | "confirmed_updates">>(
    `select count(distinct e.id) filter (where e.kind = 'instruction.added')::int as instructions,
            count(distinct e.id) filter (where e.kind = 'assistant.message')::int as assistant_messages,
            count(distinct e.id) filter (where e.kind = 'tool.requested')::int as tool_calls,
            count(distinct e.id) filter (where e.kind = 'compaction' and coalesce(e.payload->>'text','') <> '')::int as compaction_summaries,
            count(distinct l.session_id)::int as sessions,
            count(distinct l.id)::int as spans
       from cont_record_links l
       left join cont_events e on e.session_id = l.session_id and e.seq between l.from_seq and l.to_seq
      where l.record_id = $1 and l.source = any($2)`,
    [recordId, COVERING]
  );
  return r.rows[0];
}

// ---------- the pack ----------

export async function buildRecordPack(cfg: Config, pool: pg.Pool, recordId: string, opts: RecordPackOpts): Promise<RecordPack> {
  const now = opts.now ?? new Date();
  const budget = opts.budgetTokens ?? 6000;
  const omitted: string[] = [];
  const state = await recordState(pool, recordId);
  if (!state) throw new Error(`record not found: ${recordId}`);
  const rec = state.record;
  const links = await recordLinks(pool, rec.id);
  const covering = links.filter((l) => l.source !== "unassigned");
  const inSpans = (sid: string, seq: number) => covering.some((l) => l.session_id === sid && seq >= l.from_seq && seq <= l.to_seq);

  // ----- contributing sessions, most recent first (recordState orders by last_seen_at desc) -----
  const sessions: ContributingSession[] = [];
  for (const cs of state.contributing_sessions) {
    const s = await getSession(pool, cs.session_id);
    sessions.push({
      session_id: cs.session_id, author: cs.author, harness: cs.harness, last_seen_at: cs.last_seen_at, ended: Boolean(s?.ended_at), spans: cs.spans,
      repo: s?.repo ?? null, thread_id: s?.thread_id ?? null, verified_snapshot_at: s?.last_verified_snapshot_at ?? null,
      wip_ref: s?.wip_ref ?? null, wip_commit: s?.wip_commit ?? null, base_commit: s?.base_commit ?? null,
    });
  }
  const latest = sessions[0] ?? null;

  // ----- the thread behind the record (most recent contributing session bound to one), for claim and bootstrap -----
  let thread: ThreadRow | null = null;
  if (rec.repo) {
    for (const s of sessions) {
      if (!s.thread_id) continue;
      const t = await getThread(pool, s.thread_id);
      if (t) { thread = t; break; }
    }
  }
  const sessionId = opts.sessionId ?? `resume:${opts.author}:${now.toISOString()}`;
  let claimInfo: RecordPack["claim"];
  if (!rec.repo) claimInfo = { acquired: false, thread_id: null, note: "non-code record; no thread claim (claims belong to threads, and this record has no repo)" };
  else if (!thread) claimInfo = { acquired: false, thread_id: null, note: "no contributing session is bound to a thread; nothing to claim. The snapshot, if any, comes from the sessions themselves." };
  else if (opts.mode === "continue") {
    const c = await claimThread(pool, thread.id, sessionId, opts.author);
    if (c.ok) claimInfo = { acquired: true, generation: c.generation, holder: null, thread_id: thread.id, note: `claim acquired on thread ${thread.id} ("${thread.title}"), generation ${c.generation}. Advisory: it protects the shared record, not the other machine.` };
    else claimInfo = { acquired: false, holder: c.holder, thread_id: thread.id, note: `thread ${thread.id} ("${thread.title}") is claimed by ${c.holder.holder_author} since ${fmt(c.holder.acquired_at)} (heartbeat ${fmt(c.holder.heartbeat_at)}). Read-only pack; wait for release/expiry at ${fmt(c.holder.expires_at)}, or work in parallel with ledger_resume(thread_id: ${q(thread.id)}, mode: "fork").` };
  } else {
    const live = await getClaim(pool, thread.id);
    claimInfo = { acquired: false, holder: live, thread_id: thread.id, note: live ? `thread ${thread.id} ("${thread.title}") is claimed by ${live.holder_author}; inspect only` : `thread ${thread.id} ("${thread.title}") has no live claim; inspect only` };
  }

  // ----- honesty: verified snapshot, sources -----
  let vSnap: { at: Date; from: string } | null = null;
  for (const s of sessions) {
    if (!s.repo || !s.verified_snapshot_at) continue;
    if (!vSnap || s.verified_snapshot_at.getTime() > vSnap.at.getTime()) vSnap = { at: s.verified_snapshot_at, from: `session ${short(s.session_id)}` };
  }
  const head = thread ? await headCheckpoint(pool, thread.id) : null;
  if (head?.verified_snapshot_at && (!vSnap || head.verified_snapshot_at.getTime() > vSnap.at.getTime())) vSnap = { at: head.verified_snapshot_at, from: `thread ${short(thread!.id)} head checkpoint` };
  const counts = await recordSourceCounts(pool, rec.id);
  const sources: RecordSources = { ...counts, proposed_updates: state.proposed_count, confirmed_updates: state.confirmed_count };

  // ----- linked Ledger objects, with supersession flagged -----
  const refs = Array.isArray(rec.ledger_refs) ? rec.ledger_refs : [];
  const all = refs.length ? loadAll(cfg, TYPES) : [];
  const ledgerRefs: LedgerRefStatus[] = refs.map((r) => {
    const o = all.find((x) => x.id === r.id);
    const resolution = resolveAccepted(all,r.id);
    const current = resolution.current.some(c=>c.id===r.id);
    return { id: r.id, version: r.version, found: Boolean(o), type: o?.type ?? null, title: o?.title ?? null, author: o?.author ?? null, created: o?.created ?? null,
      status: o ? (current ? 'stable' : o.status==='draft' ? 'draft' : 'deprecated') : null,
      superseded_by: current ? null : resolution.current.length===1 ? resolution.current[0].id : null,
      authority_status: resolution.status, current_ids: resolution.current.map(c=>c.id), version_matches: o && r.version ? objectVersion(o)===r.version : null, warnings:resolution.warnings };
  });
  const acceptedRefs = [...new Map(refs.flatMap(r=>resolveAccepted(all,r.id).current).map(o=>[o.id,o])).values()];
  const reviewImpacts = acceptedRefs.filter(o=>o.supersedes).map(o=>correctionImpact(all,o.id));
  const supersededRefs = ledgerRefs.filter((r) => r.status === "deprecated");

  // ----- evidence across sessions, ordered by occurred_at, each attributed -----
  const [evFirst, evLast, evidenceTotal, latestComp] = await Promise.all([
    recordEvidence(pool, rec.id, { kinds: ['instruction.added'], limit: EVIDENCE_HEAD, sources: COVERING }),
    recordEvidence(pool, rec.id, { kinds: EVIDENCE_KINDS, limit: 2000, sources: COVERING, order: 'desc' }),
    recordEvidenceCount(pool, rec.id, EVIDENCE_KINDS, COVERING),
    recordEvidence(pool, rec.id, { kinds: ['compaction'], limit: 1, sources: COVERING, order: 'desc' }),
  ]);
  const evAll = [...new Map([...evFirst, ...evLast].map(e => [e.id, e])).values()].sort((a,b) =>
    (a.occurred_at ?? a.received_at).getTime() - (b.occurred_at ?? b.received_at).getTime()
      || a.session_id.localeCompare(b.session_id) || a.seq - b.seq);
  if (evidenceTotal > evAll.length) omitted.push(`${evidenceTotal - evAll.length} middle events not loaded; evidence counts cover the full history, file previews cover the sampled window; fetch exact linked spans with ledger_events`);
  const evItem = (e: (typeof evAll)[number]): EvidenceItem => ({ session_id: e.session_id, author: e.author, harness: e.harness, seq: e.seq, kind: e.kind, at: e.occurred_at ? e.occurred_at.toISOString() : null, link_source: e.link_source, line: eventLine(e, EVIDENCE_PREVIEW) });
  // one fetch per span, in time order (the first evidence event each span contains); spans with no events last
  const firstIdx = (l: { session_id: string; from_seq: number; to_seq: number }) => { const i = evAll.findIndex((e) => e.session_id === l.session_id && e.seq >= l.from_seq && e.seq <= l.to_seq); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  const spanFetches = [...new Set([...covering].sort((a, b) => firstIdx(a) - firstIdx(b)).map((l) => `ledger_events(session_id: ${q(l.session_id)}, after_seq: ${l.from_seq - 1}, before_seq: ${l.to_seq + 1})`))];
  const shapeEvidence = (headN: number, tailN: number) => {
    const headIdx = new Set<number>();
    evAll.forEach((e, i) => { if (e.kind === "instruction.added" && headIdx.size < headN) headIdx.add(i); });
    const keep = new Set<number>(headIdx);
    for (let i = Math.max(0, evAll.length - tailN); i < evAll.length; i++) keep.add(i);
    const idx = [...keep].sort((a, b) => a - b);
    const shown = idx.map((i) => evItem(evAll[i]));
    const gapIdx = evAll.map((_, i) => i).filter((i) => !keep.has(i));
    let gap: RecordPack["evidence_summary"]["omitted"] = null;
    if (evidenceTotal > shown.length) gap = { count: evidenceTotal - shown.length, fetch: spanFetches };
    return { shown, gap, gapIdx };
  };

  // the latest compaction summary with text inside the spans
  const comp = latestComp.find((e) => typeof e.payload?.text === "string" && e.payload.text.trim().length > 0) ?? null;
  let sessionSummary: RecordPack["session_summary"] = null;
  const summaryMaxChars = Math.min(SUMMARY_MAX_TOKENS * 4, Math.floor(budget * 4 * SUMMARY_BUDGET_SHARE));
  if (comp) {
    const source = String(comp.payload.source ?? comp.payload.subtype ?? "compaction");
    const full = String(comp.payload.text);
    const c = clipSummary(full, summaryMaxChars);
    sessionSummary = { source, harness: harnessName(comp.harness), session_id: comp.session_id, seq: comp.seq, at: comp.occurred_at ? comp.occurred_at.toISOString() : null, text: c.text, chars: full.length, clipped: c.clipped };
  }
  const summaryFetch = sessionSummary ? `ledger_events(session_id: ${q(sessionSummary.session_id)}, kinds: ["compaction"], after_seq: ${sessionSummary.seq - 1}, limit: 1, preview_chars: ${Math.min(sessionSummary.chars, PREVIEW_MAX_CHARS)})` : "";

  // files touched inside the spans: recent (last RECENT_FILES_MINUTES of the most recent contributing session) first, then by count
  const fileRows = evAll.filter((e) => e.kind === "file.changed");
  const since = latest?.last_seen_at ? latest.last_seen_at.getTime() - RECENT_FILES_MINUTES * 60_000 : null;
  const fm = new Map<string, { count: number; last: number; recent: boolean }>();
  for (const f of fileRows) {
    const p = String(f.payload?.path ?? "");
    if (!p) continue;
    const at = f.occurred_at ? f.occurred_at.getTime() : 0;
    const cur = fm.get(p) ?? { count: 0, last: 0, recent: false };
    cur.count++;
    cur.last = Math.max(cur.last, at);
    if (since != null && latest && f.session_id === latest.session_id && at >= since) cur.recent = true;
    fm.set(p, cur);
  }
  const files: RecordPack["files"] = [...fm].map(([p, v]) => ({ path: p, count: v.count, last_at: v.last ? new Date(v.last).toISOString() : null, recent: v.recent }))
    .sort((a, b) => {
      if (a.recent !== b.recent) return a.recent ? -1 : 1;
      if (a.recent && b.recent && a.last_at !== b.last_at) return (b.last_at ?? "") < (a.last_at ?? "") ? -1 : 1;
      return b.count - a.count || a.path.localeCompare(b.path);
    });
  const recentFiles = files.filter((f) => f.recent).map(({ path: p, count, last_at }) => ({ path: p, count, last_at }));

  // An unfinished operation remains pending even after another contributor becomes active.
  const pend = (await Promise.all(sessions.map(async (s) => (await pendingOperations(pool, s.session_id))
    .filter((p) => inSpans(s.session_id, p.seq))
    .map((p) => ({ call_id: p.call_id, tool: p.tool, input: p.input, seq: p.seq, session_id: s.session_id }))))).flat();
  const errRows = await recordEvidence(pool, rec.id, { kinds: ["tool.finished"], limit: 1, sources: COVERING, order: 'desc', errorsOnly: true });
  const lastErrRow = errRows.find((e) => e.payload?.is_error || (typeof e.payload?.stderr_preview === "string" && e.payload.stderr_preview)) ?? null;
  const lastErr = lastErrRow ? { session_id: lastErrRow.session_id, seq: lastErrRow.seq, payload: lastErrRow.payload } : null;

  // ----- unassigned spans in the contributing sessions -----
  let unassigned: UnassignedSpan[] = [];
  for (const s of sessions.slice(0, 10)) unassigned.push(...(await unassignedSpans(pool, { session_id: s.session_id, limit: UNASSIGNED_MAX })));
  unassigned.sort((a, b) => (b.last_at?.getTime() ?? 0) - (a.last_at?.getTime() ?? 0) || a.session_id.localeCompare(b.session_id) || a.from_seq - b.from_seq);
  const unassignedTotal = unassigned.length;
  unassigned = unassigned.slice(0, UNASSIGNED_MAX);
  if (unassignedTotal > UNASSIGNED_MAX) omitted.push(`${unassignedTotal - UNASSIGNED_MAX} more unassigned spans in contributing sessions; ledger_unassigned(session_id: …) per session`);

  // ----- bootstrap: the latest snapshot among contributing sessions, else their thread's head -----
  let bootstrap: string[] = [];
  let wip: { ref: string; commit: string; from: string } | null = null;
  if (rec.repo) {
    for (const s of sessions) {
      if (s.wip_ref && s.wip_commit) { wip = { ref: s.wip_ref, commit: s.wip_commit, from: `session ${short(s.session_id)} (${s.author}, ${harnessName(s.harness)})` }; break; }
      if (s.thread_id) {
        const hc = s.thread_id === thread?.id ? head : await headCheckpoint(pool, s.thread_id);
        if (hc?.wip_ref && hc?.wip_commit) { wip = { ref: hc.wip_ref, commit: hc.wip_commit, from: `thread ${short(s.thread_id)} head checkpoint` }; break; }
      }
    }
    const localRepo = opts.repoPath ? repoRoot(opts.repoPath) : null;
    const sameRepo = localRepo ? repoIdentity(localRepo) === rec.repo : false;
    if (opts.repoPath && !sameRepo) omitted.push(`bootstrap rebase target defaulted: ${localRepo ? `local checkout is ${repoIdentity(localRepo)}, record repo is ${rec.repo}` : `${opts.repoPath} is not a git repo`}`);
    if (wip) {
      const slug = rec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "record";
      bootstrap = [
        `git fetch origin ${wip.ref}:${wip.ref}`,
        `git worktree add --detach ../${slug} ${wip.commit}`,
        `# then, deliberately: git -C ../${slug} rebase ${localRepo && sameRepo ? defaultRemoteBranch(localRepo) : "origin/master"}   (or merge; your call, not automatic)`,
      ];
    } else {
      omitted.push("no verified code snapshot among contributing sessions: the helper never confirmed a wip ref for them; continue from the branch tip and treat the code state as unknown");
    }
  }

  // ----- render within budget; softer sections shrink first, each drop named -----
  const stateCap = budget >= STATE_WIDE_BUDGET ? STATE_MAX_PER_KIND_WIDE : STATE_MAX_PER_KIND;
  const stateFetch = `ledger_record_get(record_id: ${q(rec.id)}${budget < STATE_WIDE_BUDGET ? `, budget_tokens: ${STATE_WIDE_BUDGET}` : ""})`;
  // classifier lag per contributing session: organization into records may trail raw capture; say so
  const lagLines: string[] = [];
  for (const s of sessions.slice(0, 3)) {
    const cap = (await pool.query<{ m: number }>(`select coalesce(max(seq),0)::int as m from cont_events where session_id = $1`, [s.session_id])).rows[0].m;
    const cls = readProgress(s.session_id)?.last_seq ?? 0;
    lagLines.push(`Classifier: session ${short(s.session_id)} captured through seq ${cap}, classified through seq ${cls}${cap > cls ? ` (lag ${cap - cls} events; later work may be unassigned to any record yet; see ledger_unassigned)` : " (current)"}.`);
  }

  const render = (level: number): { text: string; omitted: string[]; evidence: RecordPack["evidence_summary"] } => {
    const om = [...omitted];
    const L: string[] = [];
    L.push(`# Record pack: ${rec.title}`);
    L.push(`record ${rec.id} · ${rec.kind} · ${rec.repo ? `repo ${rec.repo}` : "non-code work"} · status ${rec.status} · created by ${rec.created_by} ${fmt(rec.created_at)} · state v${rec.state_version} · updated ${fmt(rec.updated_at)}`);
    L.push(`goal: ${rec.goal ? oneLine(rec.goal) : "(none recorded)"}`);
    for (const conflict of state.conflicts) L.push(`UNRESOLVED ACCEPTED CONFLICT: ${conflict.update_ids.join(', ')} replace ${conflict.supersedes}. Do not choose by recency; inspect evidence and explicitly resolve.`);
    L.push(`claim: ${claimInfo.note}`);
    L.push(``);

    // honesty
    L.push(`## Honesty`);
    L.push(`Contributing sessions (${sessions.length}):`);
    if (!sessions.length) L.push(`- none: no span is linked to this record yet; link one with ledger_record_link`);
    for (const s of sessions.slice(0, level >= 5 ? 3 : 12)) L.push(`- ${short(s.session_id)} · ${s.author} · ${harnessName(s.harness)} · last seen ${fmt(s.last_seen_at)} (${s.ended ? "ended" : "not marked ended"}) · ${s.spans} span${s.spans === 1 ? "" : "s"}${s.thread_id ? ` · thread ${short(s.thread_id)}` : ""}`);
    const sesMax = level >= 5 ? 3 : 12;
    if (sessions.length > sesMax) { L.push(`- … ${sessions.length - sesMax} more contributing sessions`); om.push(`${sessions.length - sesMax} contributing sessions not listed; ledger_record_get(record_id: ${q(rec.id)})`); }
    if (!rec.repo) L.push(`Non-code record: no code snapshot applies.`);
    else if (vSnap) L.push(`Code saved through ${fmt(vSnap.at)} (remote-verified; ${vSnap.from}).`);
    else L.push(`No verified code snapshot among contributing sessions: treat the code state as unverified.`);
    L.push(`Sources: ${sources.instructions} instructions, ${sources.assistant_messages} assistant messages, ${sources.tool_calls} tool calls, ${sources.compaction_summaries} compaction summaries across ${sources.sessions} sessions in ${sources.spans} spans; ${sources.proposed_updates} proposed and ${sources.confirmed_updates} confirmed state updates.`);
    L.push(`The claim is advisory. It protects the shared record, not the other machine. Proposed items are unconfirmed: nobody has accepted them. Narrative-free: everything below is machine-assembled from evidence; nothing was summarized by this tool.`);
    for (const l of lagLines) L.push(l);
    L.push(``);

    // state
    L.push(`## State (v${rec.state_version} · ${state.proposed_count} proposed · ${state.confirmed_count} confirmed)`);
    let anyState = false;
    for (const k of STATE_ORDER) {
      const items = state[k.key];
      if (!items.length) continue;
      anyState = true;
      const cap = k.hard ? stateCap : level >= 5 ? 1 : level >= 3 ? 3 : stateCap;
      // Unaccepted recent activity cannot consume the accepted-state allowance.
      const accepted = items.filter(u=>u.status==='confirmed');
      const proposals = items.filter(u=>u.status==='proposed');
      const shown = [...(k.hard ? accepted : accepted.slice(-cap)),...proposals.slice(-cap)];
      L.push(`### ${k.label} (${items.length})`);
      for (const u of shown) L.push(stateLine(u));
      if (items.length > shown.length) {
        L.push(`… ${items.length - shown.length} more via ${stateFetch}`);
        om.push(`${items.length - shown.length} older ${k.key}${!k.hard && level >= 3 ? " (list shortened for budget)" : ""}; ${stateFetch}`);
      }
    }
    if (!anyState) L.push(`(no state updates yet; propose one with ledger_record_update(record_id: ${q(rec.id)}, action: "propose", …))`);
    L.push(``);

    // linked ledger objects
    L.push(`## Linked Ledger objects (${ledgerRefs.length})`);
    if (!ledgerRefs.length) L.push(`(none; a record references decisions, findings, and definitions by id in ledger_refs)`);
    for (const r of ledgerRefs) {
      if (!r.found) { L.push(`- ${r.id}${r.version ? ` @${r.version}` : ""}: NOT FOUND in the ledger (ledger_get ${q(r.id)})`); continue; }
      const flag = r.status === "deprecated" ? ` — SUPERSEDED by ${r.superseded_by ?? "(unknown)"}; the record relied on a version that is no longer in force` : r.status === "draft" ? " — draft, not in force" : " — in force";
      L.push(level >= 4 ? `- ${r.type} ${r.id}${flag}` : `- ${r.type} ${r.id}: ${r.title} (${r.author}, ${dateOf(r.created)})${r.version ? ` · pinned ${r.version}` : ""}${flag}`);
      if (r.version_matches===false) L.push(`VERSION MISMATCH: ${r.id}; its pinned content does not match the retained object. Do not claim the original evidence was verified.`);
      if (r.authority_status==='conflict') L.push(`UNRESOLVED ACCEPTED CONFLICT: ${r.current_ids.join(', ')}. No current answer has been selected.`);
      for (const warning of r.warnings) L.push(`WARNING: ${warning}`);
    }
    for (const o of acceptedRefs) {
      const resolution = resolveAccepted(all,o.id);
      L.push(`${resolution.status==='conflict' ? 'CONFLICTING ACCEPTED SOURCE — resolve before reuse' : 'Accepted source candidate — check task applicability'}: ${o.type} ${o.id} @${objectVersion(o)}: ${String(o.fields.formula ?? o.fields.decision ?? o.fields.result ?? o.fields.what ?? '')}${o.fields.query ? `\nQuery: ${o.fields.query}` : ''}${o.fields.evidence_refs ? `\nEvidence: ${JSON.stringify(o.fields.evidence_refs)}` : ''}`);
      if (!o.fields.analysis_scope) L.push(`SCOPE UNKNOWN: ${o.id}; use ledger_investigation with the analytical scope before applying it to a new analysis.`);
    }
    for (const impact of reviewImpacts) {
      for (const item of impact.affected) L.push(`NEEDS REVIEW: ${item.id}; ${item.reason}; ${item.path.join(' -> ')}`);
      for (const item of impact.incomplete) L.push(`INCOMPLETE IMPACT: ${item.id}; ${item.reason}`);
    }
    if (level >= 4 && ledgerRefs.length) om.push(`linked Ledger object titles (ids and status kept); ledger_get per id`);
    if (supersededRefs.length) L.push(`SUPERSEDED objects this record depends on: ${supersededRefs.map((r) => `${r.id} → ${r.superseded_by}`).join("; ")}`);
    L.push(``);

    // evidence
    const headN = level >= 3 ? 1 : EVIDENCE_HEAD;
    const tailN = level >= 3 ? 2 : level >= 1 ? 4 : EVIDENCE_TAIL;
    const ev = shapeEvidence(headN, tailN);
    let evidenceSummary: RecordPack["evidence_summary"];
    if (level >= 5) {
      L.push(`## Evidence across sessions (${evidenceTotal} events in ${sources.spans} spans)`);
      L.push(`(omitted for budget; fetch per span: ${spanFetches.slice(0, 4).join("; ")}${spanFetches.length > 4 ? "; …" : ""}; search with ledger_evidence_search(q, record_id: ${q(rec.id)}))`);
      om.push(`evidence lines (omitted for budget); ${spanFetches.join("; ")}`);
      evidenceSummary = { total: evidenceTotal, shown: [], omitted: evidenceTotal ? { count: evidenceTotal, fetch: spanFetches } : null };
    } else {
      L.push(`## Evidence across sessions (${evidenceTotal} events in ${sources.spans} spans, time order${ev.gap ? `; first ${headN} instruction${headN === 1 ? "" : "s"} and last ${tailN} shown` : ""})`);
      if (!evAll.length) L.push(`(no events inside the record's spans)`);
      let gapPrinted = false;
      const gapStart = ev.gapIdx.length ? ev.gapIdx[0] : -1;
      const gapEnd = ev.gapIdx.length ? ev.gapIdx[ev.gapIdx.length - 1] : -1;
      const showIdx = new Set(ev.shown.map((s) => `${s.session_id}:${s.seq}`));
      evAll.forEach((e, i) => {
        if (!showIdx.has(`${e.session_id}:${e.seq}`)) {
          if (!gapPrinted && ev.gap) {
            const a = evAll[gapStart], b = evAll[gapEnd];
            L.push(`… ${ev.gap.count} events omitted (${short(a.session_id)} seq ${a.seq} … ${short(b.session_id)} seq ${b.seq}); fetch per span: ${spanFetches.slice(0, 4).join("; ")}${spanFetches.length > 4 ? "; …" : ""}`);
            gapPrinted = true;
          }
          return;
        }
        const it = ev.shown.find((s) => s.session_id === e.session_id && s.seq === e.seq)!;
        L.push(`- ${it.at ? it.at.slice(5, 10) : "??-??"} ${short(it.session_id)} ${it.author}/${it.harness} · ${it.line}`);
      });
      if (ev.gap) om.push(`${ev.gap.count} evidence events omitted${level >= 1 ? " (tail shortened for budget)" : ""}; ${spanFetches.join("; ")}`);
      om.push(`evidence search: ledger_evidence_search(q: "…", record_id: ${q(rec.id)})`);
      evidenceSummary = { total: evidenceTotal, shown: ev.shown, omitted: ev.gap };
    }
    L.push(``);
    if (sessionSummary) {
      L.push(`### Session summary (written by ${sessionSummary.harness} at compaction; evidence, not memory)`);
      L.push(`source ${sessionSummary.source} · session ${short(sessionSummary.session_id)} seq ${sessionSummary.seq}${sessionSummary.at ? ` · ${fmt(sessionSummary.at)}` : ""} · ${num(sessionSummary.chars)} chars`);
      if (level >= 4) {
        L.push(`(text omitted for budget; full text via ${summaryFetch})`);
        om.push(`session summary text (omitted for budget); ${summaryFetch}`);
      } else if (level >= 2) {
        const c = clipSummary(sessionSummary.text, 800);
        L.push(c.text);
        L.push(`(clipped for budget at ${num(c.text.length)} of ${num(sessionSummary.chars)} chars; full text via ${summaryFetch})`);
        om.push(`session summary shortened for budget; full text via ${summaryFetch}`);
      } else {
        L.push(sessionSummary.text);
        if (sessionSummary.clipped) L.push(`(clipped at ${num(sessionSummary.text.length)} of ${num(sessionSummary.chars)} chars; full text via ${summaryFetch})`);
      }
      L.push(``);
    }
    const fileMax = level >= 5 ? 0 : level >= 4 ? 5 : level >= 1 ? 10 : FILES_MAX;
    L.push(`### Files touched in the record's spans (${files.length}${recentFiles.length && latest ? `; recent = last ${RECENT_FILES_MINUTES} min of session ${short(latest.session_id)}` : ""})`);
    if (!files.length) L.push(`(no file.changed events inside the spans)`);
    for (const f of files.slice(0, fileMax)) L.push(`- ${f.path} ×${f.count}${f.last_at ? ` (${f.last_at.slice(11, 16)})` : ""}${f.recent ? " recent" : ""}`);
    if (files.length > fileMax) {
      const fetch = [...new Set(fileRows.map((r) => r.session_id))].map((sid) => `ledger_events(session_id: ${q(sid)}, kinds: ["file.changed"])`).join("; ");
      L.push(fileMax === 0 ? `(list omitted for budget: ${files.length} files; ${fetch})` : `… ${files.length - fileMax} more; ${fetch}`);
      om.push(`${files.length - fileMax} touched files${fileMax === 0 ? " (list omitted for budget)" : level >= 1 ? " (list shortened for budget)" : ""}; ${fetch}`);
    }
    L.push(``);

    // pending / last error
    L.push(`## Pending / unknown operations (${pend.length}) — all contributing sessions, inside linked spans`);
    for (const p of pend) L.push(`- session ${short(p.session_id)} seq ${p.seq} ${p.tool}: ${oneLine(p.input).slice(0, 200)}  ← outcome unknown; do not blindly rerun if it mutates anything`);
    if (lastErr) {
      L.push(``); L.push(`## Last error inside the spans`);
      const fetch = `ledger_events(session_id: ${q(lastErr.session_id)}, after_seq: ${lastErr.seq - 1}, limit: 1, preview_chars: 2000)`;
      if (level >= 4) { L.push(`session ${short(lastErr.session_id)} seq ${lastErr.seq} ${String(lastErr.payload?.tool ?? "")} (details omitted for budget; ${fetch})`); om.push(`last error details; ${fetch}`); }
      else L.push(`session ${short(lastErr.session_id)} seq ${lastErr.seq} ${JSON.stringify({ ...lastErr.payload, output_preview: String(lastErr.payload?.output_preview ?? "").slice(0, 400), stderr_preview: String(lastErr.payload?.stderr_preview ?? "").slice(0, 400) })}`);
    }
    L.push(``);

    // unassigned
    const unMax = level >= 3 ? 2 : UNASSIGNED_MAX;
    L.push(`## Unassigned spans in contributing sessions (may belong here; link with ledger_record_link)`);
    if (!unassigned.length) L.push(`(none: every content event in the contributing sessions is linked to some record)`);
    for (const u of unassigned.slice(0, unMax)) L.push(unassignedLine(u, now));
    if (unassigned.length > unMax) { L.push(`… ${unassigned.length - unMax} more; ledger_unassigned(session_id: …)`); om.push(`${unassigned.length - unMax} unassigned spans (list shortened for budget); ledger_unassigned(session_id: …)`); }
    L.push(``);

    // bootstrap
    L.push(`## Bootstrap`);
    if (!rec.repo) L.push(`non-code record; no worktree`);
    else if (bootstrap.length) { L.push(`snapshot from ${wip!.from}`); L.push("```\n" + bootstrap.join("\n") + "\n```"); }
    else L.push(`(no snapshot to check out: no contributing session or thread head carries a verified wip ref)`);
    L.push(``);

    // contract
    L.push(`## First turn contract`);
    L.push(`1. Inspect the state above. [confirmed] items were accepted by a person; [PROPOSED] items are unconfirmed suggestions. Do not treat a proposed item as decided; contradictions stay open until a person resolves them.`);
    L.push(rec.repo ? `2. Check out the snapshot into a fresh worktree and inspect it; do not assume the branch tip matches. State what is confirmed (verified snapshot, linked evidence) vs uncertain (unverified edits, pending operations).` : `2. This is non-code work: there is no worktree. State what is confirmed (linked evidence, confirmed updates) vs uncertain (proposed updates, unassigned spans).`);
    L.push(`3. Do not rerun a pending operation that mutates anything until you know its outcome.`);
    L.push(`4. Propose progress, decisions, hypotheses, blockers, and next steps with ledger_record_update(record_id: ${q(rec.id)}, action: "propose", …) citing exact evidence (session_id, seq); confirm only what a person accepts.`);
    L.push(`5. Link this session's relevant spans with ledger_record_link(record_id: ${q(rec.id)}, session_id, from_seq, to_seq); the helper captures events automatically but does not know which record they serve.`);
    L.push(`6. Say what you are continuing and what your next action is. A record's confirmed state is still not a Ledger decision or finding; promote with ledger_record_decision / ledger_record_finding.`);
    if (om.length) { L.push(``); L.push(`## Omitted for budget or unavailable`); for (const o of om) L.push(`- ${o}`); }
    return { text: L.join("\n"), omitted: om, evidence: evidenceSummary };
  };

  // shrink the softest sections first: evidence tail and file list, then the summary, then soft state kinds, then details
  let level = 0;
  let out = render(level);
  while (approxTokens(out.text) > budget && level < 5) out = render(++level);

  return {
    record: rec, state, ledger_refs: ledgerRefs, evidence_summary: out.evidence, session_summary: sessionSummary,
    files, recent_files: recentFiles, pending_operations: pend, last_error: lastErr, unassigned, contributing_sessions: sessions,
    claim: claimInfo, bootstrap, sources, omitted: out.omitted, text: out.text,
  };
}
