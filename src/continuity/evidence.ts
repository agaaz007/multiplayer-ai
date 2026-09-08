import type pg from "pg";
import type { EventRow } from "./store.js";

/**
 * Evidence queries: the raw event stream and stored artifacts, shared by the
 * `ledger_events` / `ledger_artifact_get` MCP tools and the `ledger events` /
 * `ledger artifact` CLI commands. Substring filters only; full-text search over
 * spans belongs to the records layer. Reads cont_events, cont_artifacts and
 * cont_sessions directly so the store module stays the single writer.
 */

type Q = pg.Pool | pg.PoolClient;

export const EVENTS_DEFAULT_LIMIT = 50;
export const EVENTS_MAX_LIMIT = 200;
/** per-line preview length; raise it (up to PREVIEW_MAX_CHARS) to read one event in full */
export const PREVIEW_CHARS = 200;
export const PREVIEW_MAX_CHARS = 100_000;
export const ARTIFACT_DEFAULT_CHARS = 20_000;
export const ARTIFACT_MAX_CHARS = 100_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface EventFilters {
  thread_id?: string;
  session_id?: string;
  kinds?: string[];
  /** substring of payload.path (file.changed) or payload.input (tool events) */
  path?: string;
  /** case-insensitive substring over payload.text / input / output_preview */
  q?: string;
  after_seq?: number;
  before_seq?: number;
  limit?: number;
  preview_chars?: number;
}

export interface EventQueryResult {
  events: EventRow[];
  /** matching rows before the limit */
  total: number;
  truncated: boolean;
  next_after_seq: number | null;
  lines: string[];
  text: string;
}

/**
 * Ordered event lines for a thread or a session. `seq` is per session; a
 * thread query orders by insertion id (chronological across sessions, equal to
 * seq order within one), and `after_seq` / `before_seq` filter on seq. For an
 * unambiguous cursor over a multi-session thread, pass session_id as well.
 */
export async function queryEvents(q: Q, f: EventFilters): Promise<EventQueryResult> {
  if (!f.thread_id && !f.session_id) throw new Error("thread_id or session_id is required");
  if (f.thread_id && !UUID.test(f.thread_id)) throw new Error(`not a thread id: ${f.thread_id}`);
  const limit = Math.min(Math.max(1, Math.floor(f.limit ?? EVENTS_DEFAULT_LIMIT)), EVENTS_MAX_LIMIT);
  const preview = Math.min(Math.max(20, Math.floor(f.preview_chars ?? PREVIEW_CHARS)), PREVIEW_MAX_CHARS);
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.thread_id) { params.push(f.thread_id); where.push(`thread_id = $${params.length}::uuid`); }
  if (f.session_id) { params.push(f.session_id); where.push(`session_id = $${params.length}`); }
  if (f.kinds?.length) { params.push(f.kinds); where.push(`kind = any($${params.length})`); }
  if (f.path) { params.push(f.path); where.push(`(position($${params.length} in coalesce(payload->>'path','')) > 0 or position($${params.length} in coalesce(payload->>'input','')) > 0)`); }
  if (f.q) { params.push(f.q.toLowerCase()); where.push(`position($${params.length} in lower(coalesce(payload->>'text','') || ' ' || coalesce(payload->>'input','') || ' ' || coalesce(payload->>'output_preview',''))) > 0`); }
  if (f.after_seq != null) { params.push(Math.floor(f.after_seq)); where.push(`seq > $${params.length}`); }
  if (f.before_seq != null) { params.push(Math.floor(f.before_seq)); where.push(`seq < $${params.length}`); }
  const w = where.join(" and ");
  const total = (await q.query<{ n: number }>(`select count(*)::int as n from cont_events where ${w}`, params)).rows[0].n;
  const order = f.session_id ? "seq asc, id asc" : "id asc";
  const r = await q.query<EventRow>(`select * from cont_events where ${w} order by ${order} limit ${limit}`, params);
  const events = r.rows;
  const truncated = total > events.length;
  const lines = events.map((e) => eventLine(e, preview));
  const last = events[events.length - 1];
  const next_after_seq = truncated && last ? last.seq : null;
  if (!events.length) lines.push(`no events match${f.thread_id ? ` on thread ${f.thread_id}` : ""}${f.session_id ? ` in session ${f.session_id}` : ""}.`);
  else if (truncated) lines.push(`showing ${events.length} of ${total} matching; next: after_seq=${last.seq}${f.thread_id && !f.session_id && new Set(events.map((e) => e.session_id)).size > 1 ? ` (thread spans several sessions; seq is per session, add session_id="${last.session_id}" for an exact cursor)` : ""}`);
  return { events, total, truncated, next_after_seq, lines, text: lines.join("\n") };
}

/** `seq · HH:MM · kind · <preview>`; tool.finished adds `[artifact <id>]` when one was stored. */
export function eventLine(e: EventRow, previewChars = PREVIEW_CHARS): string {
  const at = e.occurred_at ?? e.received_at;
  const hhmm = at ? new Date(at).toISOString().slice(11, 16) : "--:--";
  const p = e.payload ?? {};
  // a long preview is a request to read the event in full: keep its line structure
  const one = previewChars > PREVIEW_CHARS ? (s: unknown) => String(s ?? "").replace(/[ \t]+/g, " ").trim() : (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const clip = (s: string) => (s.length > previewChars ? s.slice(0, previewChars - 1) + "…" : s);
  let body: string;
  switch (e.kind) {
    case "instruction.added":
    case "assistant.message":
      body = one(p.text);
      break;
    case "tool.requested":
      body = `${one(p.tool) || "tool"}: ${one(p.input)}`;
      break;
    case "tool.finished":
      body = `${one(p.tool) || "tool"}${p.is_error ? " ERROR" : ""}: ${one(p.output_preview) || one(p.stderr_preview)}`;
      break;
    case "file.changed":
      body = `${one(p.path)}${p.status ? ` (${one(p.status)})` : ""}${p.source ? ` via ${one(p.source)}` : ""}`;
      break;
    case "compaction": {
      const chars = typeof p.chars === "number" ? p.chars : String(p.text ?? "").length;
      body = `${one(p.source ?? p.subtype) || "compaction"} · ${chars} chars${chars ? `: ${one(p.text)}` : ""}`;
      break;
    }
    default:
      body = one(JSON.stringify(p));
  }
  let line = `${e.seq} · ${hhmm} · ${e.kind} · ${clip(body)}`;
  if (e.kind === "tool.finished" && p.artifact_id) line += ` [artifact ${p.artifact_id}]`;
  return line;
}

export interface ArtifactSlice {
  found: boolean;
  id: string | null;
  sha256: string | null;
  kind: string | null;
  byte_size: number | null;
  storage_uri: string | null;
  offset: number;
  /** the decoded utf8 slice, or null when not found / not inline */
  body: string | null;
  total_chars: number | null;
  next_offset: number | null;
  text: string;
}

/** A slice of one artifact by id or sha256. Offsets are in characters of the utf8-decoded body. */
export async function getArtifact(q: Q, ref: { id?: string; sha256?: string }, opts: { offset?: number; max_chars?: number } = {}): Promise<ArtifactSlice> {
  const id = ref.id?.trim();
  const sha = ref.sha256?.trim().toLowerCase();
  if (!id && !sha) throw new Error("id or sha256 is required");
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const max = Math.min(Math.max(1, Math.floor(opts.max_chars ?? ARTIFACT_DEFAULT_CHARS)), ARTIFACT_MAX_CHARS);
  const notFound = (why: string): ArtifactSlice => ({ found: false, id: null, sha256: null, kind: null, byte_size: null, storage_uri: null, offset, body: null, total_chars: null, next_offset: null, text: why });
  if (id && !UUID.test(id)) return notFound(`artifact not found: "${id}" is not an artifact id (uuid)${SHA256.test(id) ? "; it looks like a sha256, pass it as sha256" : ""}`);
  if (sha && !SHA256.test(sha)) return notFound(`artifact not found: "${sha}" is not a sha256 hex digest`);
  const r = await q.query<{ id: string; sha256: string; kind: string; byte_size: number; storage_uri: string | null; inline: Buffer | null; session_id: string | null }>(
    `select id, sha256, kind, byte_size, storage_uri, inline, session_id from cont_artifacts where ($1::uuid is not null and id = $1::uuid) or ($2::text is not null and sha256 = $2) limit 1`,
    [id ?? null, sha ?? null]
  );
  const a = r.rows[0];
  if (!a) return notFound(`artifact not found: ${id ?? sha}`);
  const header = (n: number) => `artifact ${a.id} · ${a.kind} · ${a.byte_size} bytes · showing [${offset}, ${offset + n})`;
  if (a.inline == null) {
    const where = a.storage_uri ? `body is stored at ${a.storage_uri}, not inline; fetch it from that location` : "no inline body and no storage_uri; the body was not retained";
    return { found: true, id: a.id, sha256: a.sha256, kind: a.kind, byte_size: a.byte_size, storage_uri: a.storage_uri, offset, body: null, total_chars: null, next_offset: null, text: `${header(0)}\n(${where})` };
  }
  const full = Buffer.from(a.inline).toString("utf8");
  const body = full.slice(offset, offset + max);
  const end = offset + body.length;
  const next = end < full.length ? end : null;
  const lines = [header(body.length), body];
  if (next != null) lines.push(`next: offset=${next} (${full.length - next} of ${full.length} chars remain)`);
  else lines.push(`end of artifact (${full.length} chars)`);
  return { found: true, id: a.id, sha256: a.sha256, kind: a.kind, byte_size: a.byte_size, storage_uri: a.storage_uri, offset, body, total_chars: full.length, next_offset: next, text: lines.join("\n") };
}

export interface SourceCounts { instructions: number; assistant_messages: number; tool_calls: number; compaction_summaries: number; sessions: number }

/** What the thread's evidence is made of, for the pack's honesty block. Counts events, not sessions bound without events. */
export async function threadSourceCounts(q: Q, threadId: string): Promise<SourceCounts> {
  const r = await q.query<SourceCounts>(
    `select count(*) filter (where kind = 'instruction.added')::int as instructions,
            count(*) filter (where kind = 'assistant.message')::int as assistant_messages,
            count(*) filter (where kind = 'tool.requested')::int as tool_calls,
            count(*) filter (where kind = 'compaction' and coalesce(payload->>'text','') <> '')::int as compaction_summaries,
            count(distinct session_id)::int as sessions
       from cont_events where thread_id = $1`,
    [threadId]
  );
  return r.rows[0];
}

export function sourcesLine(s: SourceCounts): string {
  return `Sources: ${s.instructions} instructions, ${s.assistant_messages} assistant messages, ${s.tool_calls} tool calls, ${s.compaction_summaries} compaction summaries across ${s.sessions} sessions.`;
}
