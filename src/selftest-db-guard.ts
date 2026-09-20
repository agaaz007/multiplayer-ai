import type pg from "pg";

/** Drop-capable tests must use the disposable cluster created by test-isolated.mjs. */
export function assertSafeSelftestDatabase(connectionString: string): void {
  let u: URL;
  try { u = new URL(connectionString); } catch { throw new Error("Selftest database refused: invalid URL"); }
  const name = decodeURIComponent(u.pathname.slice(1));
  if (process.env.LEDGER_SELFTEST !== "1" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
      !/^ledger_selftest_[a-f0-9]{16}$/.test(name) ||
      name !== process.env.LEDGER_SELFTEST_DB_MARKER ||
      !u.port || u.port !== process.env.LEDGER_SELFTEST_DB_PORT) {
    throw new Error("Selftest database refused: run node scripts/test-isolated.mjs; a disposable local cluster and matching marker are required. No tables were changed.");
  }
}

export async function assertSelftestDatabaseMarker(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query("select marker from ledger_selftest_identity where singleton = true");
  if (rows.length !== 1 || rows[0].marker !== process.env.LEDGER_SELFTEST_DB_MARKER) {
    throw new Error("Selftest database refused: disposable database identity does not match. No tables were changed.");
  }
}
