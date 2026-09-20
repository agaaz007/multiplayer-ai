import fs from "node:fs";
import path from "node:path";
import { ledgerHome } from "../store.js";

/**
 * Local liveness for the capture helper (2026-09-13 review, Issue 9). The helper once sat about
 * 39 h on a dead Postgres connection while launchd reported it running, and nothing told anyone.
 * The loop writes this file around every pass; SessionStart on the same machine reads it, so a
 * dead or stalled helper is visible where the work happens. Staleness is a local fact: no shared
 * schema is involved.
 */

export interface HelperHeartbeat {
  pid: number;
  cli: string;
  author: string;
  machine: string;
  started_at: string;
  pass_deadline_s: number;
  last_pass_started_at: string | null;
  last_pass_finished_at: string | null;
  last_pass_ms: number | null;
  last_error: string | null;
  updated_at: string;
  snapshot_queue_depth?: number;
  snapshot_last_error?: string | null;
  capture_sessions?: Record<string, { source_cursor: number; pending_batches: number; pending_bytes: number; oldest_at: string | null }>;
}

export const heartbeatFile = () => path.join(ledgerHome(), "helper-heartbeat.json");

export function readHeartbeat(): HelperHeartbeat | null {
  try { return JSON.parse(fs.readFileSync(heartbeatFile(), "utf8")); } catch { return null; }
}

export function writeHeartbeat(patch: Partial<HelperHeartbeat>, now = new Date()): HelperHeartbeat {
  const next = { ...(readHeartbeat() ?? {}), ...patch, updated_at: now.toISOString() } as HelperHeartbeat;
  fs.mkdirSync(ledgerHome(), { recursive: true });
  const tmp = `${heartbeatFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, heartbeatFile());
  return next;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Capture on this machine counts as stale after this long without a completed pass. */
export const STALE_CAPTURE_MS = 10 * 60_000;

export const HELPER_RESTART_HINT = "restart: launchctl kickstart -k gui/$(id -u)/com.tranzmit.ledger.helper";

const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** One warning line when this machine's capture is not keeping up, else null. No heartbeat file means no helper here: no warning. */
export function captureStaleness(hb: HelperHeartbeat | null, now: Date, opts: { alive?: (pid: number) => boolean; staleMs?: number } = {}): string | null {
  if (!hb) return null;
  const alive = opts.alive ?? pidAlive;
  const staleMs = opts.staleMs ?? STALE_CAPTURE_MS;
  const t = now.getTime();
  const finished = hb.last_pass_finished_at ? Date.parse(hb.last_pass_finished_at) : null;
  const started = hb.last_pass_started_at ? Date.parse(hb.last_pass_started_at) : null;
  const lastDone = finished != null ? `last completed pass ${ago(t - finished)} ago` : "no completed pass yet";
  if (!alive(hb.pid)) return `Ledger capture helper is not running on this machine (${lastDone}); new work is not captured or snapshotted. ${HELPER_RESTART_HINT}`;
  const inPass = started != null && (finished == null || started > finished);
  if (inPass && t - started! > staleMs) return `Ledger capture on this machine is stalled: the current pass has run ${ago(t - started!)} (${lastDone}); work since then is not captured or snapshotted. ${HELPER_RESTART_HINT}`;
  const since = finished ?? Date.parse(hb.started_at);
  const lastError = hb.last_error ? ` Last error: ${hb.last_error.slice(0, 200)}` : "";
  // checked even while a pass is running: a helper whose passes keep throwing starts a fresh pass every
  // interval but never completes one, and must not look healthy just because the current pass is young
  if (Number.isFinite(since) && t - since > staleMs) return `Ledger capture on this machine has not completed a pass for ${ago(t - since)}; new work is not captured.${lastError} ${HELPER_RESTART_HINT}`;
  if (hb.last_error) return `Ledger capture on this machine reported errors in its last pass: ${hb.last_error.slice(0, 200)}`;
  return null;
}

/**
 * The promise's value, or timedOut after ms. The timer is deliberately not unref'd: a stuck promise with no
 * live handle of its own must still reach the deadline instead of letting the process exit silently. It is
 * cleared as soon as the race settles.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ timedOut: true }>((res) => { timer = setTimeout(() => res({ timedOut: true }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ timedOut: false as const, value })), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
