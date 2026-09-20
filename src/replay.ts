import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./store.js";
import { usageDirectory, type UsageEnvelope, type UsageInvocation } from "./usage.js";

/**
 * One session's knowledge trail, in order: what the ledger injected, which records it returned, which
 * the agent cited, and what it wrote back.
 *
 * It reads the usage path rather than a new one because that path already survives Postgres being
 * down: every invocation is written to a bounded local spool first and uploaded later, so a machine
 * with no continuity database still has its own trail, and a machine with one has the part that has
 * already been uploaded. Both are read here and both are named in the output, because a trail that
 * quietly omits a source is the same failure as a brief that quietly omits a definition.
 *
 * What it is not: proof of use. A returned record is retrieval; only ledger_show_contribution is the
 * agent saying it used one, and that remains agent-reported.
 */
export type ReplayKind = "injected" | "found" | "referenced" | "saved" | "other";

const INJECT_TOOLS = new Set(["hook:SessionStart", "ledger_brief", "cli:brief"]);
const READ_TOOLS = new Set(["ledger_search", "ledger_get", "ledger_investigation", "ledger_impact"]);
const CITE_TOOLS = new Set(["ledger_show_contribution"]);
const WRITE_TOOLS = /^ledger_(record_(finding|decision|change|definition)|propose_finding|review_finding|discard_draft|skip_record)$/;

export function replayKind(tool: string): ReplayKind {
  if (INJECT_TOOLS.has(tool)) return "injected";
  if (READ_TOOLS.has(tool)) return "found";
  if (CITE_TOOLS.has(tool)) return "referenced";
  if (WRITE_TOOLS.test(tool)) return "saved";
  return "other";
}

export interface ReplayStep {
  at: string;
  kind: ReplayKind;
  tool: string;
  outcome: string;
  /** "spool" = still on this machine only; "database" = already uploaded to the shared continuity store. */
  origin: "spool" | "database";
  record_ids: string[];
  /** Bytes the agent received. Null on anything that is not an injection. */
  payload_bytes: number | null;
  /** Records a byte budget left out of that payload. Null when not an injection. */
  payload_dropped: number | null;
}

export interface ReplaySource { name: string; status: "read" | "unavailable" | "not_configured"; note: string }

export interface ReplayTrail {
  session_id: string | null;
  actor: string | null;
  steps: ReplayStep[];
  sources: ReplaySource[];
  totals: { injections: number; injected_bytes: number; injected_records: number; dropped_records: number; found: number; referenced: number; saved: number };
  /** Sessions the sources know about, most recent first; how `--session` is chosen when none is given. */
  known_sessions: { session_id: string; last_at: string; steps: number }[];
}

interface ReplayRow { step: ReplayStep; session: string | null; actor: string | null; finished: boolean }

const asRow = (v: UsageInvocation, origin: ReplayStep["origin"]): ReplayRow => ({
  step: {
    at: v.finished_at ?? v.started_at,
    kind: replayKind(v.tool),
    tool: v.tool,
    outcome: v.outcome,
    origin,
    record_ids: (v.records ?? []).map((r) => r.id),
    payload_bytes: v.payload_bytes ?? null,
    payload_dropped: v.payload_dropped ?? null,
  },
  session: v.session_id,
  actor: v.actor,
  finished: Boolean(v.finished_at),
});

/**
 * An invocation is spooled twice: once when it starts, with no records, and once when it ends, with
 * them. The terminal frame wins outright rather than by timestamp, because a sub-millisecond call
 * writes both frames at the same ISO second and the opening one would otherwise erase the records.
 */
function keep(into: Map<string, ReplayRow>, id: string, row: ReplayRow): void {
  const existing = into.get(id);
  if (!existing || (row.finished && !existing.finished) || (row.finished === existing.finished && existing.step.at <= row.step.at)) into.set(id, row);
}

async function fromSpool(): Promise<{ rows: Map<string, ReplayRow>; source: ReplaySource }> {
  const rows = new Map<string, ReplayRow>();
  const dir = usageDirectory();
  let files: string[];
  try { files = await fs.readdir(dir); }
  catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { rows, source: { name: "local usage spool", status: missing ? "read" : "unavailable", note: missing ? "no spool on this machine yet" : String(e) } };
  }
  let unreadable = 0;
  for (const file of files.filter((f) => /^invocation-[a-f0-9-]{36}-(?:started|finished)\.json$/.test(f))) {
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as UsageEnvelope;
      if (envelope.kind !== "invocation") continue;
      keep(rows, envelope.value.invocation_id, asRow(envelope.value, "spool"));
    } catch { unreadable++; }
  }
  return { rows, source: { name: "local usage spool", status: "read", note: `${rows.size} invocation(s) not yet uploaded${unreadable ? `; ${unreadable} frame(s) unreadable` : ""}` } };
}

async function fromDatabase(cfg: Config): Promise<{ rows: Map<string, ReplayRow>; source: ReplaySource }> {
  const rows = new Map<string, ReplayRow>();
  const { continuityConfigured, getPool } = await import("./continuity/db.js");
  if (!continuityConfigured(cfg)) return { rows, source: { name: "continuity database", status: "not_configured", note: "this machine keeps its trail locally only; uploaded history is not available here" } };
  try {
    const result = await getPool(cfg).query(
      `select invocation_id,actor,session_id,tool,started_at,finished_at,outcome,records,payload_bytes,payload_dropped
         from cont_usage_invocations order by started_at desc limit 2000`);
    for (const r of result.rows as any[])
      keep(rows, r.invocation_id, asRow({ ...r, records: r.records ?? [], started_at: new Date(r.started_at).toISOString(), finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null } as UsageInvocation, "database"));
    return { rows, source: { name: "continuity database", status: "read", note: `${rows.size} uploaded invocation(s), newest 2000` } };
  } catch (e: any) {
    // A trail missing its uploaded half must say so; it must never look complete. The error is
    // reported verbatim because "unreachable" and "never migrated here" need different fixes.
    return { rows, source: { name: "continuity database", status: "unavailable", note: `${e?.message ?? e}; only this machine's spool is shown` } };
  }
}

export interface ReplayOpts { session?: string; includeOther?: boolean }

export async function replayTrail(cfg: Config, opts: ReplayOpts = {}): Promise<ReplayTrail> {
  const [spool, database] = [await fromSpool(), await fromDatabase(cfg)];
  // The spool holds what has not been uploaded yet and the database what has; where both know an
  // invocation, the uploaded row is the committed one.
  const merged = new Map([...spool.rows, ...database.rows]);
  const all = [...merged.values()];

  const sessions = new Map<string, { last_at: string; steps: number }>();
  for (const row of all) {
    if (!row.session) continue;
    const seen = sessions.get(row.session) ?? { last_at: row.step.at, steps: 0 };
    sessions.set(row.session, { last_at: seen.last_at > row.step.at ? seen.last_at : row.step.at, steps: seen.steps + 1 });
  }
  const known = [...sessions].map(([session_id, v]) => ({ session_id, ...v })).sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : a.session_id.localeCompare(b.session_id)));
  const session = opts.session ?? known[0]?.session_id ?? null;

  const steps = all
    .filter((r) => r.session === session)
    .map((r) => r.step)
    .filter((s) => opts.includeOther || s.kind !== "other")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.tool.localeCompare(b.tool)));

  const of = (kind: ReplayKind) => steps.filter((s) => s.kind === kind);
  const injections = of("injected");
  return {
    session_id: session,
    actor: all.find((r) => r.session === session)?.actor ?? null,
    steps,
    sources: [spool.source, database.source],
    totals: {
      injections: injections.length,
      injected_bytes: injections.reduce((n, s) => n + (s.payload_bytes ?? 0), 0),
      injected_records: injections.reduce((n, s) => n + s.record_ids.length, 0),
      dropped_records: injections.reduce((n, s) => n + (s.payload_dropped ?? 0), 0),
      found: of("found").reduce((n, s) => n + s.record_ids.length, 0),
      referenced: of("referenced").reduce((n, s) => n + s.record_ids.length, 0),
      saved: of("saved").reduce((n, s) => n + s.record_ids.length, 0),
    },
    known_sessions: known.slice(0, 20),
  };
}

const clock = (at: string) => (at.length >= 19 ? at.slice(11, 19) : at.padEnd(8).slice(0, 8));
const ids = (list: string[], max = 4) => list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} +${list.length - max} more`;

/** Clock-free: every timestamp comes from the data, so two runs over the same trail render identically. */
export function renderReplay(trail: ReplayTrail): string {
  const out: string[] = [];
  out.push(`Ledger replay — session ${trail.session_id ?? "(none found)"}${trail.actor ? ` · ${trail.actor}` : ""}`);
  for (const s of trail.sources) out.push(`  source: ${s.name} — ${s.status.replace("_", " ")}; ${s.note}`);
  out.push(`  injected = delivered into the agent's context · found = returned to it · referenced = it said it used the record · saved = written back.`);
  out.push(``);
  if (!trail.steps.length) {
    out.push(trail.session_id
      ? `  no knowledge calls recorded for this session in the sources above.`
      : `  no sessions in the sources above. Usage capture is off when LEDGER_USAGE=0.`);
  }
  let day = "";
  for (const step of trail.steps) {
    const date = step.at.slice(0, 10);
    if (date !== day) { out.push(`  ${date}`); day = date; }
    const detail = step.kind === "injected"
      ? `${step.payload_bytes ?? "?"} B delivered · ${step.record_ids.length} record(s)${step.payload_dropped ? ` · ${step.payload_dropped} dropped by the byte budget` : ""}`
      : step.record_ids.length ? `${step.record_ids.length} record(s)` : `no records`;
    out.push(`  ${clock(step.at)}  ${step.kind.padEnd(10)} ${step.tool.padEnd(26)} ${detail}${step.outcome === "success" ? "" : ` [${step.outcome}]`}`);
    if (step.record_ids.length) out.push(`${" ".repeat(24)}${ids(step.record_ids)}`);
  }
  const t = trail.totals;
  out.push(``);
  out.push(`  totals: ${t.injections} injection(s), ${t.injected_bytes} B delivered, ${t.injected_records} record(s) in them, ${t.dropped_records} dropped by the byte budget`);
  out.push(`          ${t.found} record appearance(s) found, ${t.referenced} referenced by the agent, ${t.saved} saved`);
  out.push(`  found and referenced are appearances, not distinct records, and referenced is the agent's own claim.`);
  out.push(`  not covered here: analytics queries (\`ledger events --session <id>\`) and any invocation uploaded and then pruned from the database.`);
  if (trail.known_sessions.length > 1) out.push(`  other sessions: ${trail.known_sessions.filter(s => s.session_id !== trail.session_id).slice(0, 5).map(s => `${s.session_id} (${s.steps})`).join(", ")}`);
  return out.join("\n");
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/**
 * A standalone file, not an MCP App resource: a replay is per-session runtime data with no tool to
 * call back into, so it needs none of ui/app.ts's host plumbing. The palette and type scale are
 * ui/evidence.html's, so the two views read as one product.
 */
export function replayHtml(trail: ReplayTrail): string {
  const rows = trail.steps.map((step) => {
    const detail = step.kind === "injected"
      ? `${step.payload_bytes ?? "?"} B delivered, ${step.record_ids.length} record(s)${step.payload_dropped ? `, ${step.payload_dropped} dropped by the byte budget` : ""}`
      : step.record_ids.length ? `${step.record_ids.length} record(s)` : "no records";
    return `<tr><td class="time">${escape(step.at.slice(0, 19).replace("T", " "))}</td><td><span class="kind ${step.kind}">${step.kind}</span></td>`
      + `<td class="tool">${escape(step.tool)}</td><td>${escape(detail)}<div class="ids">${escape(step.record_ids.join(" · "))}</div></td></tr>`;
  }).join("\n");
  const t = trail.totals;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ledger replay — ${escape(trail.session_id ?? "no session")}</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --surface: light-dark(#fffefb,#252624); --ink: light-dark(#292a26,#f1f1ea); --muted: light-dark(#71736b,#b8bbb0); --line: light-dark(#e8e8de,#45483e); --tint: light-dark(#f3f1e8,#33372c); --accent: light-dark(#635284,#d5c3f2); --warning: light-dark(#9a4c27,#f7bb96); }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px 14px; color: var(--ink); background: var(--surface); }
    main { max-width: 900px; margin: auto; }
    h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; overflow-wrap: anywhere; }
    p { margin: 6px 0; }
    .secondary { color: var(--muted); font-size: 12px; }
    table { border-collapse: collapse; width: 100%; margin-top: 18px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 1px solid var(--line); padding: 0 10px 7px 0; }
    td { border-bottom: 1px solid var(--line); padding: 11px 10px 11px 0; vertical-align: top; font-size: 13px; }
    .time, .tool, .ids { font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ids { color: var(--muted); overflow-wrap: anywhere; margin-top: 4px; }
    .kind { display: inline-block; border-radius: 20px; padding: 2px 9px; font-size: 11px; background: var(--tint); color: var(--muted); }
    .kind.injected { color: var(--accent); }
    .kind.referenced { color: var(--warning); }
    .kind.saved { background: var(--ink); color: var(--surface); }
    .totals { background: var(--tint); border-radius: 11px; padding: 12px 14px; margin-top: 18px; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>Ledger replay — ${escape(trail.session_id ?? "no session found")}</h1>
    <p class="secondary">${escape(trail.actor ?? "unknown author")} · injected = delivered into the agent's context · found = returned to it · referenced = the agent said it used the record · saved = written back. Retrieval is not use.</p>
    ${trail.sources.map((s) => `<p class="secondary">source: ${escape(s.name)} — ${escape(s.status.replace("_", " "))}; ${escape(s.note)}</p>`).join("\n    ")}
    <table>
      <thead><tr><th>when</th><th>what</th><th>tool</th><th>records</th></tr></thead>
      <tbody>
${rows || `<tr><td colspan="4" class="secondary">No knowledge calls recorded for this session in the sources above.</td></tr>`}
      </tbody>
    </table>
    <div class="totals">
      ${t.injections} injection(s), ${t.injected_bytes} B delivered, ${t.injected_records} record(s) in them, ${t.dropped_records} dropped by the byte budget.<br>
      ${t.found} record appearance(s) found, ${t.referenced} referenced by the agent, ${t.saved} saved.<br>
      <span class="secondary">Found and referenced are appearances, not distinct records, and referenced is the agent's own claim. Analytics queries are not covered here; see <code>ledger events --session</code>.</span>
    </div>
  </main>
</body>
</html>
`;
}
