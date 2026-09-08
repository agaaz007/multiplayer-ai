import type { Config } from "../store.js";
import { continuityConfigured, getPool } from "./db.js";
import { listThreads } from "./store.js";
import { threadLine } from "./resume.js";
import { repoIdentity, repoRoot } from "./shadow.js";
import { takeLocalNotifications } from "../helper/signals.js";

/**
 * The "Open threads" section for SessionStart and `ledger brief`. Teammates'
 * threads only (your own are in your local sessions), last 48 h, capped, in
 * the current repo first. Fails open: any store error yields an empty string
 * so a session never waits on Postgres.
 */
export async function openThreadsText(cfg: Config, opts: { cwd?: string; hours?: number; limit?: number; includeOwn?: boolean; timeoutMs?: number } = {}): Promise<string> {
  if (!continuityConfigured(cfg)) return "";
  const hours = opts.hours ?? 48;
  const limit = opts.limit ?? 5;
  const work = (async () => {
    const pool = getPool(cfg);
    const root = opts.cwd ? repoRoot(opts.cwd) : null;
    const repo = root ? repoIdentity(root) : null;
    const filt = { sinceHours: hours, status: "open", limit, ...(opts.includeOwn ? {} : { excludeAuthor: cfg.author }) };
    let rows = repo ? await listThreads(pool, { ...filt, repo }) : [];
    if (rows.length < limit) {
      const more = await listThreads(pool, { ...filt, limit: limit - rows.length });
      for (const m of more) if (!rows.some((r) => r.id === m.id)) rows.push(m);
    }
    const notes = takeLocalNotifications();
    const out: string[] = [];
    if (notes.length) {
      out.push(`## Ledger notices`);
      for (const n of notes) out.push(`- ${n}`);
      out.push(``);
    }
    if (rows.length) {
      out.push(`## Open threads${repo ? ` (this repo first)` : ""}, last ${hours}h`);
      out.push(`Teammates' work you can continue. Continue with ledger_resume(thread_id, mode: "continue"); explore in parallel with mode: "fork"; read only with mode: "inspect". A claim is advisory and protects the shared record, not the other machine.`);
      for (const r of rows) out.push(threadLine(r));
    }
    return out.join("\n");
  })();
  const timeout = new Promise<string>((res) => setTimeout(() => res(""), opts.timeoutMs ?? 4000));
  try { return await Promise.race([work, timeout]); } catch { return ""; }
}
