import type pg from "pg";
import type { LedgerObject } from "../schema.js";
import { objectVersion, resolveAccepted } from "../authority.js";
import { recordState, type StateUpdate } from "./records.js";

/**
 * Sections both resume packs render, so a successor gets the same decision guarantees whether it resumes a
 * thread or a work record (2026-09-13 review: the packs had drifted apart, and neither carried the decisions
 * in force for the work, so a superseded, draft or merely proposed decision could reach a successor as if decided).
 *
 *   decisions in force   Ledger objects the work saved or explicitly linked, resolved through the authority layer:
 *                        in force, superseded (and by what), draft, conflicting or missing
 *   acceptance labels    who accepted a record state update and how: a person at an interactive prompt, an agent
 *                        on someone's behalf, or unknown for rows written before the channel was recorded
 *   decision rule        the first-turn contract rule both packs print
 */

type Q = pg.Pool | pg.PoolClient;

const short = (sid: string) => sid.slice(0, 8);
const dateOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "unknown");
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The first-turn contract rule both packs print. */
export const DECISION_RULE =
  "Act only on decisions in force: an [in force] Ledger object, or a record decision marked [accepted by <person>]. " +
  "Superseded, draft, conflicting and missing Ledger items, [PROPOSED] updates and agent-confirmed updates were not decided by a person: " +
  "say so before relying on one, and never apply a later proposal over an accepted decision. " +
  "A person accepts a record update with `ledger record confirm <update_id>` in a terminal.";

// ---------- acceptance labels ----------

/** Evidence refs of a state update grouped by session: "evidence: seq 3,4 of 0199aaaa; seq 1 of agaaz-cl". */
export function evidenceRefs(u: StateUpdate): string {
  const by = new Map<string, number[]>();
  for (const e of u.evidence ?? []) by.set(e.session_id, [...(by.get(e.session_id) ?? []), e.seq]);
  if (!by.size) return "no evidence refs";
  return "evidence: " + [...by].map(([sid, seqs]) => `seq ${[...new Set(seqs)].sort((a, b) => a - b).join(",")} of ${short(sid)}`).join("; ");
}

/**
 * Who accepted an update and how. Only a confirmation typed at an interactive CLI prompt says a person accepted it;
 * an agent's confirmation (MCP, or the CLI without a terminal) is labelled as such, and rows written before the
 * channel was recorded say so instead of guessing.
 */
export function acceptanceLabel(u: StateUpdate): string {
  if (u.status !== "confirmed") return "PROPOSED";
  const by = u.confirmed_by ?? u.created_by;
  if (u.confirmed_via === "cli-interactive") return `accepted by ${by}`;
  if (u.confirmed_via === "mcp") {
    const self = Boolean(u.proposed_session_id && u.confirmed_session_id && u.proposed_session_id === u.confirmed_session_id);
    return `agent-confirmed for ${by}${self ? " by the session that proposed it" : ""}; not reviewed by a person`;
  }
  if (u.confirmed_via === "cli") return `confirmed for ${by} via CLI without a prompt; not reviewed by a person`;
  return `confirmed by ${by}; how it was accepted was not recorded`;
}

/** `[<acceptance label>] text (by <created_by>, <date>; evidence: seq a,b of <session short id>)` */
export function stateLine(u: StateUpdate): string {
  return `- [${acceptanceLabel(u)}] ${oneLine(u.text)} (by ${u.created_by}, ${dateOf(u.created_at)}; ${evidenceRefs(u)})`;
}

// ---------- decisions in force ----------

/** explicit: linked on a work record; saved: a Ledger save result inside the work's own events */
export type LedgerRefSource = "explicit" | "saved";

export interface LedgerRefInput { id: string; version?: string; source: LedgerRefSource; origin?: { session_id: string; seq: number } | null }

export interface LedgerRefStatus {
  id: string; version?: string; found: boolean; type: string | null; title: string | null; author: string | null; created: string | null;
  status: string | null; superseded_by: string | null;
  authority_status: string; current_ids: string[]; version_matches: boolean | null; warnings: string[];
  source: LedgerRefSource;
  /** the tool result event that saved it, for saved refs */
  origin: { session_id: string; seq: number } | null;
}

/** Resolve refs through the authority layer. Each id appears once; an explicit ref wins over a saved one (it may pin a version). */
export function ledgerRefStatuses(all: LedgerObject[], refs: LedgerRefInput[]): LedgerRefStatus[] {
  const seen = new Set<string>();
  const out: LedgerRefStatus[] = [];
  for (const r of [...refs.filter((x) => x.source === "explicit"), ...refs.filter((x) => x.source !== "explicit")]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const o = all.find((x) => x.id === r.id);
    const resolution = resolveAccepted(all, r.id);
    const current = resolution.current.some((c) => c.id === r.id);
    out.push({
      id: r.id, version: r.version, found: Boolean(o), type: o?.type ?? null, title: o?.title ?? null, author: o?.author ?? null, created: o?.created ?? null,
      status: o ? (current ? "stable" : o.status === "draft" ? "draft" : "deprecated") : null,
      superseded_by: current ? null : resolution.current.length === 1 ? resolution.current[0].id : null,
      authority_status: resolution.status, current_ids: resolution.current.map((c) => c.id),
      version_matches: o && r.version ? objectVersion(o) === r.version : null, warnings: resolution.warnings,
      source: r.source, origin: r.origin ?? null,
    });
  }
  return out;
}

const LEDGER_ID = String.raw`(?:dec|def|fnd|chg)-\d{8}-[a-z0-9-]+-[a-z0-9]{4}`;
/** A Ledger save receipt's record_id, plain (Claude MCP result) or JSON-escaped (Codex exec output). */
const RECEIPT_ID = new RegExp(String.raw`\\?"record_id\\?"\s*:\s*\\?"(${LEDGER_ID})\\?"`, "g");
/** "Recorded decision dec-…" in a tool's text result; the id must end before a delimiter, so a clipped preview never yields a partial id. */
const RECORDED_TEXT = new RegExp(String.raw`\bRecorded (?:draft )?(?:decision|definition|finding|change) (${LEDGER_ID})(?=[\s"'.,;:)]|\\)`, "g");

/**
 * Ledger ids a tool result reports as saved. Search, get and contribution results list ids they merely read; they
 * carry no record_id and no "Recorded <type>" line, so they are not counted: reading an id does not mean the work
 * depends on it (outside-voice tension X7). Explicit refs on a record cover the rest.
 */
export function savedLedgerIds(output: string): string[] {
  const ids = new Set<string>();
  for (const re of [RECEIPT_ID, RECORDED_TEXT]) for (const m of output.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

export interface SavedLedgerIds { refs: LedgerRefInput[]; results: number; sessions: number }

/** Ledger objects saved by tool calls inside a thread's events, or inside a work record's linked spans. */
export async function writtenLedgerIds(q: Q, scope: { threadId: string } | { recordId: string }): Promise<SavedLedgerIds> {
  const mentionsSave = `(e.payload->>'output_preview' like '%record_id%' or e.payload->>'output_preview' like '%Recorded %')`;
  const r = "threadId" in scope
    ? await q.query<{ session_id: string; seq: number; out: string | null }>(
        `select e.session_id, e.seq, e.payload->>'output_preview' as out from cont_events e
          where e.thread_id = $1 and e.kind = 'tool.finished' and ${mentionsSave}
          order by coalesce(e.occurred_at, e.received_at), e.id`, [scope.threadId])
    : await q.query<{ session_id: string; seq: number; out: string | null }>(
        `select distinct on (e.id) e.session_id, e.seq, e.payload->>'output_preview' as out, e.id, coalesce(e.occurred_at, e.received_at) as at
           from cont_record_links l
           join cont_events e on e.session_id = l.session_id and e.seq between l.from_seq and l.to_seq
          where l.record_id = $1 and l.source <> 'unassigned' and e.kind = 'tool.finished' and ${mentionsSave}
          order by e.id`, [scope.recordId]);
  const refs: LedgerRefInput[] = [];
  const seen = new Set<string>();
  const sessions = new Set<string>();
  let results = 0;
  for (const row of r.rows) {
    const ids = savedLedgerIds(row.out ?? "");
    if (!ids.length) continue;
    results++;
    sessions.add(row.session_id);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      refs.push({ id, source: "saved", origin: { session_id: row.session_id, seq: row.seq } });
    }
  }
  return { refs, results, sessions: sessions.size };
}

export interface RecordDecisionGroup { record_id: string; title: string; decisions: StateUpdate[] }

/** Decision updates of the work records a thread's sessions contribute to, most recently updated records first. */
export async function threadRecordDecisions(q: Q, threadId: string, maxRecords = 3): Promise<RecordDecisionGroup[]> {
  const recs = await q.query<{ id: string; title: string }>(
    `select r.id, r.title from cont_records r
      where r.status <> 'archived'
        and exists (select 1 from cont_record_links l
                     where l.record_id = r.id and l.source <> 'unassigned'
                       and l.session_id in (select distinct session_id from cont_events where thread_id = $1))
      order by r.updated_at desc, r.id limit ${Math.max(1, Math.floor(maxRecords))}`,
    [threadId]
  );
  const out: RecordDecisionGroup[] = [];
  for (const rec of recs.rows) {
    const st = await recordState(q, rec.id);
    if (st?.decisions.length) out.push({ record_id: rec.id, title: rec.title, decisions: st.decisions });
  }
  return out;
}

const TYPE_ORDER: Record<string, number> = { decision: 0, definition: 1, finding: 2, change: 3 };

/** The bracketed status a successor must read before acting on a Ledger object. */
export function decisionTag(r: LedgerRefStatus): string {
  if (!r.found) return "NOT FOUND";
  if (r.authority_status === "conflict") return `CONFLICT: ${r.current_ids.join(", ")} are all accepted; resolve before acting`;
  if (r.status === "stable") return "in force";
  if (r.status === "draft") return r.current_ids.length ? `DRAFT, not in force; in force instead: ${r.current_ids.join(", ")}` : "DRAFT, not in force";
  return r.superseded_by ? `SUPERSEDED by ${r.superseded_by}, which is in force` : "SUPERSEDED; no single replacement is in force";
}

/** The "Decisions in force" section, shared by the thread and record packs. */
export function renderDecisionsInForce(refs: LedgerRefStatus[], captured: { results: number; sessions: number }, opts: { compact?: boolean; groups?: RecordDecisionGroup[]; perGroup?: number } = {}): string[] {
  const L: string[] = [];
  const groups = opts.groups ?? [];
  L.push(`## Decisions in force for this work (${refs.length})`);
  if (!refs.length) {
    L.push(`(none: no Ledger decision, definition, finding or change was saved in this work's events or linked to it; decisions it only read are not tracked here)`);
  } else {
    L.push(`Ledger objects this work saved or linked, resolved to what is in force now. Only [in force] items are accepted knowledge.`);
    const rank = (r: LedgerRefStatus) => (r.found ? TYPE_ORDER[r.type ?? ""] ?? 4 : 5);
    const sorted = refs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
    // a warning shared by several objects (legacy scope, say) prints once after the list, so it cannot bury a status line
    const warnCount = new Map<string, number>();
    for (const r of sorted) for (const w of new Set(r.warnings)) warnCount.set(w, (warnCount.get(w) ?? 0) + 1);
    for (const r of sorted) {
      const where = r.source === "explicit" ? "linked explicitly" : r.origin ? `saved in session ${short(r.origin.session_id)} seq ${r.origin.seq}` : "saved in this work";
      if (!r.found) { L.push(`- [NOT FOUND] ${r.id}${r.version ? ` @${r.version}` : ""} · ${where} (ledger_get "${r.id}")`); continue; }
      L.push(opts.compact
        ? `- [${decisionTag(r)}] ${r.type} ${r.id} · ${where}`
        : `- [${decisionTag(r)}] ${r.type} ${r.id}: ${r.title} (${r.author}, ${dateOf(r.created)})${r.version ? ` · pinned ${r.version}` : ""} · ${where}`);
      if (r.version_matches === false) L.push(`VERSION MISMATCH: ${r.id}; its pinned content does not match the retained object. Do not claim the original evidence was verified.`);
      for (const w of new Set(r.warnings)) if (warnCount.get(w) === 1) L.push(`WARNING: ${w}`);
    }
    for (const [w, n] of warnCount) if (n > 1) L.push(`WARNING (${n} objects above): ${w}`);
    const notInForce = sorted.filter((r) => !r.found || r.status !== "stable" || r.authority_status === "conflict");
    if (notInForce.length) L.push(`NOT IN FORCE (${notInForce.length}): ${notInForce.map((r) => (r.status === "deprecated" && r.superseded_by ? `${r.id} → ${r.superseded_by}` : r.id)).join("; ")}. Do not act on these as decided.`);
    const explicit = refs.filter((r) => r.source === "explicit").length;
    L.push(`Captured from ${plural(captured.results, "Ledger save result")} in ${plural(captured.sessions, "session")} and ${plural(explicit, "explicit link")}. Decisions the work only read are not listed; search the Ledger before relying on one.`);
  }
  if (groups.length) {
    const cap = Math.max(1, opts.perGroup ?? 5);
    L.push(`### Work-record decisions (${groups.reduce((n, g) => n + g.decisions.length, 0)})`);
    for (const g of groups) {
      L.push(`record "${oneLine(g.title)}" (${g.record_id}):`);
      const accepted = g.decisions.filter((u) => u.status === "confirmed");
      const proposed = g.decisions.filter((u) => u.status !== "confirmed");
      const shown = [...accepted.slice(-cap), ...proposed.slice(-cap)];
      for (const u of shown) L.push(`  ${stateLine(u)}`);
      if (g.decisions.length > shown.length) L.push(`  … ${g.decisions.length - shown.length} more via ledger_record_get(record_id: "${g.record_id}")`);
    }
  }
  return L;
}
