import type pg from "pg";

export type Availability = "available" | "available_empty" | "unavailable" | "not_configured";
export interface AvailableSection {
  name: string;
  status: Availability;
  text: string;
  observed_at: string;
  reason?: "timeout" | "backend_error";
}

/**
 * Bound acquisition AND read work. A timeout destroys only this borrowed client,
 * including a connection that arrives after the deadline; no orphan query returns
 * to the pool. Callbacks must perform reads only, not schedule detached work.
 */
export async function boundedRead<T>(pool: pg.Pool, timeoutMs: number, read: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Read deadline must be positive");
  let client: pg.PoolClient | undefined;
  let finished = false;
  let released = false;
  const release = (destroy = false) => {
    if (client && !released) { released = true; client.release(destroy); }
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      finished = true;
      release(true);
      reject(Object.assign(new Error("Continuity read deadline exceeded"), { code: "LEDGER_READ_TIMEOUT" }));
    }, timeoutMs);
  });
  const work = (async () => {
    client = await pool.connect();
    if (finished) { release(true); throw Object.assign(new Error("Continuity connection arrived after deadline"), { code: "LEDGER_READ_TIMEOUT" }); }
    return read(client);
  })();
  try { return await Promise.race([work, deadline]); }
  finally { finished = true; clearTimeout(timer!); release(); }
}

export async function availableSection(name: string, read: () => Promise<string>, now = new Date()): Promise<AvailableSection> {
  try {
    const result = await read();
    const text = result.trim() ? result : "";
    return { name, status: text ? "available" : "available_empty", text, observed_at: now.toISOString() };
  } catch (e: any) {
    const reason = e?.code === "LEDGER_READ_TIMEOUT" ? "timeout" : "backend_error";
    // Do not include raw database errors, which may contain SQL or a connection URL.
    return { name, status: "unavailable", observed_at: now.toISOString(), reason,
      text: `## ${name}: unavailable\nContinuity ${reason === "timeout" ? "read timed out" : "backend could not be read"}; prior work may exist. Retry the relevant Ledger read after checking continuity health. This is not an empty result.` };
  }
}
