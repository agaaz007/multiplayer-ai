import type { Config } from "../store.js";
import { continuityConfigured, getPool } from "./db.js";
import { listThreads } from "./store.js";
import { threadLine } from "./resume.js";
import { repoIdentity, repoRoot } from "./shadow.js";
import { takeLocalNotifications } from "../helper/signals.js";
import { unassignedSpans } from "./records.js";
import { listRecordSummaries, recordLine, unassignedLine } from "./recordpack.js";
import { investigationLine, listInvestigations } from "./investigations.js";

/**
 * The "Open threads" section for SessionStart and `ledger brief`. Teammates'
 * threads only (your own are in your local sessions), last 48 h, capped, in
 * the current repo first. Fails open: any store error yields an empty string
 * so a session never waits on Postgres. The work-record sections from
 * openWorkText are appended so every entry point gets them.
 */
export async function openThreadsText(cfg: Config, opts: { cwd?: string; hours?: number; limit?: number; includeOwn?: boolean; timeoutMs?: number } = {}): Promise<string> {
  if (!continuityConfigured(cfg)) return "";
  const hours = opts.hours ?? 48;
  const limit = opts.limit ?? 5;
  const budget = opts.timeoutMs ?? 4000;
  // Each section races the budget on its own and the three run in parallel: a slow Neon connect for one
  // section (seen 2026-09-17: 7-8 s connects) must not drop the others, and a sequential chain of three
  // connects cannot fit any sane budget. A section that loses its race is omitted, never partially printed.
  const raced = (p: Promise<string>): Promise<string> =>
    Promise.race([p.catch(() => ""), new Promise<string>((res) => setTimeout(() => res(""), budget))]);
  const threads = raced((async () => {
    const pool = getPool(cfg);
    const root = opts.cwd ? repoRoot(opts.cwd) : null;
    const repo = root ? repoIdentity(root) : null;
    const filt = { sinceHours: hours, status: "open", limit, ...(opts.includeOwn ? {} : { excludeAuthor: cfg.author }) };
    let rows = repo ? await listThreads(pool, { ...filt, repo }) : [];
    if (rows.length < limit) {
      const more = await listThreads(pool, { ...filt, limit: limit - rows.length });
      for (const m of more) if (!rows.some((r) => r.id === m.id)) rows.push(m);
    }
    const out: string[] = [];
    if (rows.length) {
      out.push(`## Open threads${repo ? ` (this repo first)` : ""}, last ${hours}h`);
      out.push(`Teammates' work you can continue. Continue with ledger_resume(thread_id, mode: "continue"); explore in parallel with mode: "fork"; read only with mode: "inspect". A claim is advisory and protects the shared record, not the other machine.`);
      for (const r of rows) out.push(threadLine(r));
    }
    return out.join("\n");
  })());
  // Open investigations sit before the work records: an analysis session must bind to one (or declare a new
  // question) before its first data query, whatever repo it is in, or none.
  const investigations = raced(openInvestigationsText(cfg, { timeoutMs: budget }));
  const records = raced(openWorkText(cfg, { cwd: opts.cwd, timeoutMs: budget }));
  const [t, i, r] = await Promise.all([threads, investigations, records]);
  const out: string[] = [];
  const notes = takeLocalNotifications();
  if (notes.length) {
    out.push(`## Ledger notices`);
    for (const n of notes) out.push(`- ${n}`);
  }
  for (const section of [t, i, r]) if (section) { if (out.length) out.push(``); out.push(section); }
  return out.join("\n");
}

/** The contract sentence under "Open investigations"; the hooks' gate and Stop block name the same three tools. */
export const INVESTIGATIONS_CONTRACT = `Analysis sessions must bind to one of these or declare a new question before running data queries (ledger_investigations / ledger_investigation_bind / ledger_investigation_new). Non-repo work is fine; do not proceed as just a thread on this repo.`;

/**
 * "## Open investigations (all repos, last N days)": open `investigation` work records from every repo and
 * from no repo, newest first, one line each (title · created_by · updated · proposed/confirmed · bound sessions
 * · id), followed by the bind-or-declare contract. Empty string when there are none (the contract still applies:
 * ledger_investigation_new declares the first). Fails open like the other sections.
 */
export async function openInvestigationsText(cfg: Config, opts: { hours?: number; limit?: number; timeoutMs?: number; now?: Date } = {}): Promise<string> {
  if (!continuityConfigured(cfg)) return "";
  const hours = opts.hours ?? 24 * 14;
  const limit = opts.limit ?? 8;
  const now = opts.now ?? new Date();
  const work = (async () => {
    const { items } = await listInvestigations(getPool(cfg), cfg, { hours, limit });
    if (!items.length) return "";
    const out = [`## Open investigations (all repos, last ${Math.round(hours / 24)} days)`, INVESTIGATIONS_CONTRACT];
    for (const it of items) out.push(investigationLine(it, now));
    return out.join("\n");
  })();
  const timeout = new Promise<string>((res) => setTimeout(() => res(""), opts.timeoutMs ?? 4000));
  try { return await Promise.race([work, timeout]); } catch { return ""; }
}

/**
 * The "Open work (records)" and "Unassigned work" sections (spec §13a). Records
 * are cross-author by nature, so nobody is excluded: this repo first, then
 * others, last 14 days, up to 8, each with its newest proposed update so an
 * unconfirmed claim is visible before anyone builds on it. Unassigned spans
 * (last 48 h, up to 5) come from teammates' and own sessions alike; they are
 * listed, never turned into records here. Fails open like openThreadsText.
 */
export async function openWorkText(cfg: Config, opts: { cwd?: string; hours?: number; limit?: number; unassignedHours?: number; unassignedLimit?: number; timeoutMs?: number; now?: Date } = {}): Promise<string> {
  if (!continuityConfigured(cfg)) return "";
  const hours = opts.hours ?? 24 * 14;
  const limit = opts.limit ?? 8;
  const uHours = opts.unassignedHours ?? 48;
  const uLimit = opts.unassignedLimit ?? 5;
  const now = opts.now ?? new Date();
  const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const work = (async () => {
    const pool = getPool(cfg);
    const root = opts.cwd ? repoRoot(opts.cwd) : null;
    const repo = root ? repoIdentity(root) : null;
    const filt = { sinceHours: hours, status: "open" as const, limit };
    const rows = repo ? await listRecordSummaries(pool, { ...filt, repo }) : [];
    if (rows.length < limit) {
      const more = await listRecordSummaries(pool, { ...filt, limit });
      for (const m of more) if (rows.length < limit && !rows.some((r) => r.id === m.id)) rows.push(m);
    }
    const out: string[] = [];
    if (rows.length) {
      out.push(`## Open work (records)${repo ? ` (this repo first)` : ""}, last ${Math.round(hours / 24)} days`);
      out.push(`Work records accumulate across sessions and teammates. Continue with ledger_resume(record_id, mode: "continue"); read with ledger_record_get; link this session's spans with ledger_record_link. PROPOSED updates are unconfirmed; do not treat them as decided.`);
      for (const r of rows) {
        out.push(recordLine(r, now));
        if (r.newest_proposed) out.push(`  PROPOSED ${r.newest_proposed.kind}: "${clip(r.newest_proposed.text, 100)}" (by ${r.newest_proposed.created_by})`);
      }
    }
    const un = await unassignedSpans(pool, { sinceHours: uHours, limit: uLimit });
    if (un.length) {
      if (out.length) out.push(``);
      out.push(`## Unassigned work, last ${uHours}h`);
      out.push(`Spans no record claims, from teammates' and your own sessions. Link one with ledger_record_link, or start a record with ledger_record_start; nothing is invented from them.`);
      for (const s of un) out.push(unassignedLine(s, now));
    }
    return out.join("\n");
  })();
  const timeout = new Promise<string>((res) => setTimeout(() => res(""), opts.timeoutMs ?? 4000));
  try { return await Promise.race([work, timeout]); } catch { return ""; }
}
