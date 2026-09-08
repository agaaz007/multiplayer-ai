import type pg from "pg";
import type { EventRow } from "./store.js";

/**
 * Work records: the logical unit of work, separate from threads (the physical
 * session + worktree unit that owns claims and snapshots).
 *
 * Requirement (spec v1.2): a session can contribute evidence and state updates
 * to multiple work records; each record maintains its own progress and
 * dependencies, independent of any session's rolling summary.
 *
 * Three layers:
 *   shared evidence   cont_events / cont_artifacts / snapshots (already exist)
 *   work records      cont_records + cont_record_links (spans) + cont_state_updates (append-only, provenance)
 *   active context    assembled at ledger_resume(record) from the two above, within a budget
 *
 * Rules:
 *   - links carry `source`: explicit (agent/user named the record), suggested (classifier), unassigned (nobody)
 *   - state updates are `proposed` until a person or their agent confirms; a record's current state is a
 *     projection over updates, with proposed items visibly flagged
 *   - contradictions are kept side by side, never resolved by timestamp
 *   - saving is not accepting: a record never promotes a hypothesis to a Ledger decision or finding
 *
 * This file is the CONTRACT. Signatures and types here are fixed; implementers fill the bodies.
 * Consumers (classifier, retrieval, tools) code against these signatures.
 */

export type RecordKind = "implementation" | "investigation" | "writing" | "decision" | "other";
export type RecordStatus = "open" | "done" | "archived";
export type LinkSource = "explicit" | "suggested" | "unassigned";
export type UpdateStatus = "proposed" | "confirmed" | "rejected";
export type UpdateKind = "progress" | "decision" | "hypothesis" | "blocker" | "next" | "contradiction" | "note";

export interface WorkRecord {
  id: string;
  kind: RecordKind;
  title: string;
  goal: string | null;
  repo: string | null;              // canonical repo identity, or null for non-code work (hiring, copy)
  status: RecordStatus;
  created_by: string;
  ledger_refs: { id: string; version?: string }[];   // decisions/findings/definitions this record depends on
  state_version: number;            // bumps on every confirmed update
  created_at: Date;
  updated_at: Date;
}

export interface RecordLink {
  id: string;
  record_id: string;
  session_id: string;
  from_seq: number;
  to_seq: number;                   // inclusive
  source: LinkSource;
  confidence: number | null;        // 0..1 for suggested; null for explicit
  note: string | null;
  created_by: string;               // author or "classifier"
  created_at: Date;
}

export interface StateUpdate {
  id: string;
  record_id: string;
  session_id: string | null;
  from_seq: number | null;
  to_seq: number | null;
  status: UpdateStatus;
  kind: UpdateKind;
  text: string;
  evidence: { session_id: string; seq: number }[];   // exact events this update rests on
  created_by: string;
  created_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  supersedes: string | null;        // an earlier update this one replaces (kept, marked)
}

export interface RecordState {
  record: WorkRecord;
  progress: StateUpdate[];
  decisions: StateUpdate[];
  hypotheses: StateUpdate[];
  blockers: StateUpdate[];
  next: StateUpdate[];
  contradictions: StateUpdate[];
  notes: StateUpdate[];
  proposed_count: number;
  confirmed_count: number;
  last_update_at: Date | null;
  contributing_sessions: { session_id: string; author: string; harness: string; last_seen_at: Date | null; spans: number }[];
}

export interface Span { session_id: string; from_seq: number; to_seq: number }

export interface UnassignedSpan extends Span {
  author: string;
  harness: string;
  event_count: number;
  first_at: Date | null;
  last_at: Date | null;
  preview: string;                  // first instruction or assistant text in the span, clipped
}

type Q = pg.Pool | pg.PoolClient;

// ---------- records ----------

export async function createRecord(q: Q, r: { kind: RecordKind; title: string; goal?: string | null; repo?: string | null; created_by: string; ledger_refs?: { id: string; version?: string }[] }): Promise<WorkRecord> {
  throw new Error("not implemented");
}

export async function getRecord(q: Q, id: string): Promise<WorkRecord | null> {
  throw new Error("not implemented");
}

export async function listRecords(q: Q, f: { repo?: string | null; kind?: RecordKind; status?: RecordStatus; author?: string; sinceHours?: number; q?: string; limit?: number } = {}): Promise<WorkRecord[]> {
  throw new Error("not implemented");
}

export async function updateRecordMeta(q: Q, id: string, patch: { title?: string; goal?: string | null; status?: RecordStatus; kind?: RecordKind; ledger_refs?: { id: string; version?: string }[] }): Promise<void> {
  throw new Error("not implemented");
}

// ---------- links (spans of a session's events that contribute to a record) ----------

export async function linkSpan(q: Q, l: { record_id: string; session_id: string; from_seq: number; to_seq: number; source: LinkSource; confidence?: number | null; note?: string | null; created_by: string }): Promise<RecordLink> {
  throw new Error("not implemented");
}

export async function unlinkSpan(q: Q, link_id: string): Promise<boolean> {
  throw new Error("not implemented");
}

export async function recordLinks(q: Q, record_id: string): Promise<RecordLink[]> {
  throw new Error("not implemented");
}

export async function sessionLinks(q: Q, session_id: string): Promise<RecordLink[]> {
  throw new Error("not implemented");
}

/** Events of a session not covered by any explicit or suggested link, grouped into contiguous spans. */
export async function unassignedSpans(q: Q, f: { session_id?: string; sinceHours?: number; author?: string; limit?: number } = {}): Promise<UnassignedSpan[]> {
  throw new Error("not implemented");
}

// ---------- state updates (append-only, provenance, proposed → confirmed) ----------

export async function addStateUpdate(q: Q, u: { record_id: string; session_id?: string | null; from_seq?: number | null; to_seq?: number | null; kind: UpdateKind; text: string; evidence?: { session_id: string; seq: number }[]; created_by: string; status?: UpdateStatus; supersedes?: string | null }): Promise<StateUpdate> {
  throw new Error("not implemented");
}

export async function confirmStateUpdate(q: Q, id: string, by: string): Promise<StateUpdate | null> {
  throw new Error("not implemented");
}

export async function rejectStateUpdate(q: Q, id: string, by: string, reason: string): Promise<StateUpdate | null> {
  throw new Error("not implemented");
}

/** The record's current state: a projection over updates. Rejected excluded; superseded excluded; proposed included and flagged. */
export async function recordState(q: Q, record_id: string): Promise<RecordState | null> {
  throw new Error("not implemented");
}

// ---------- evidence retrieval across sessions ----------

/** Events across every linked span of a record, ordered by occurred_at, each annotated with session author/harness. */
export async function recordEvidence(q: Q, record_id: string, f: { kinds?: string[]; limit?: number; after?: Date | null; sources?: LinkSource[] } = {}): Promise<(EventRow & { author: string; harness: string; link_source: LinkSource })[]> {
  throw new Error("not implemented");
}

/** Full-text search over event text (instructions, assistant messages, tool inputs, output previews, compaction summaries). */
export async function searchEvents(q: Q, query: string, f: { repo?: string | null; session_id?: string; record_id?: string; kinds?: string[]; sinceHours?: number; limit?: number } = {}): Promise<(EventRow & { author: string; harness: string; rank: number })[]> {
  throw new Error("not implemented");
}

/** Records whose linked spans overlap a given session, for "what did this session contribute to". */
export async function recordsForSession(q: Q, session_id: string): Promise<(WorkRecord & { spans: number; sources: LinkSource[] })[]> {
  throw new Error("not implemented");
}
