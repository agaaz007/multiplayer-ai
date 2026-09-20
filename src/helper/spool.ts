import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ledgerHome } from "../store.js";
import type { NormEvent } from "../continuity/events.js";

/** Immutable, checksummed segments. The manifest is the sole commit boundary for
 * source admission and acknowledgment. Old JSONL/ack inputs and acknowledged
 * segments are retained for recovery/compatible rollback; never run a v1 writer
 * against a migrated spool. A failed fsync/rename leaves the source unadvanced. */
export const SPOOL_MAX_EVENTS = 200;
export const SPOOL_MAX_BYTES = 1 << 20;
const FRAME_MAX = 32 << 20;
export const spoolDir = () => path.join(ledgerHome(), "spool");
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const directory = (id: string) => path.join(spoolDir(), `${safe(id)}.v2`);
const manifestFile = (id: string) => path.join(directory(id), "manifest.json");
const segmentFile = (id: string, n: number) => path.join(directory(id), `${String(n).padStart(12, "0")}.json`);
export interface SpoolBatch { offset: number; events: NormEvent[]; at: string }
interface Manifest { version: 2; next: number; acked: number; source_cursor: number; legacy_imported: boolean }
/** Fault injection only; called after real durability boundaries. */
let fault: ((boundary: string) => void) | undefined;
export function setSpoolFaultInjector(fn?: (boundary: string) => void): void { fault = fn; }
function syncDir(dir: string): void { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file: string, bytes: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fault?.("file_flushed");
  fs.renameSync(tmp, file); syncDir(path.dirname(file));
  fault?.(file.endsWith("manifest.json") ? "manifest_committed" : "segment_committed");
}
function segment(id: string, n: number, batch: SpoolBatch): void {
  const body = JSON.stringify(batch);
  atomic(segmentFile(id, n), JSON.stringify({ sha256: crypto.createHash("sha256").update(body).digest("hex"), body }));
}
function* chunks(batch: SpoolBatch): Generator<SpoolBatch> {
  let events: NormEvent[] = [], bytes = 0;
  for (const event of batch.events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > FRAME_MAX) throw new Error("spool event exceeds 32 MiB safety bound; source retained, admission blocked");
    if (events.length && (events.length >= SPOOL_MAX_EVENTS || bytes + size > SPOOL_MAX_BYTES)) { yield { ...batch, events }; events = []; bytes = 0; }
    events.push(event); bytes += size;
  }
  if (events.length) yield { ...batch, events };
}
function* legacyLines(file: string): Generator<string> {
  const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(64 << 10); let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = pending.indexOf(10)) !== -1) { yield pending.subarray(0, nl).toString("utf8"); pending = pending.subarray(nl + 1); }
      if (pending.length > FRAME_MAX) throw new Error("legacy spool frame exceeds safety bound; original retained");
    }
    if (pending.length) throw new Error("legacy spool has an incomplete trailing frame; original retained, repair required");
  } finally { fs.closeSync(fd); }
}
function withSpoolLock<T>(id: string, fn: () => T): T {
  fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  const file = path.join(spoolDir(), `${safe(id)}.lock`);
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("spool lock requires recovery; source retained");
    let live = true; try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") live = false; }
    if (live) throw new Error("spool writer busy; source retained for retry");
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); return fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
function manifest(id: string, locked = false): Manifest {
  if (fs.existsSync(manifestFile(id))) {
    const m = JSON.parse(fs.readFileSync(manifestFile(id), "utf8")) as Manifest;
    if (m.version !== 2 || !Number.isSafeInteger(m.next) || !Number.isSafeInteger(m.acked) || m.acked < 0 || m.acked > m.next || !Number.isSafeInteger(m.source_cursor) || m.source_cursor < 0) throw new Error("invalid spool manifest; retained for repair");
    return m;
  }
  if (!locked) return withSpoolLock(id, () => manifest(id, true));
  fs.mkdirSync(directory(id), { recursive: true, mode: 0o700 }); syncDir(spoolDir());
  const m: Manifest = { version: 2, next: 0, acked: 0, source_cursor: 0, legacy_imported: false };
  const legacy = path.join(spoolDir(), `${safe(id)}.jsonl`), ack = path.join(spoolDir(), `${safe(id)}.ack`);
  if (fs.existsSync(legacy)) {
    const oldAck = fs.existsSync(ack) ? Number(fs.readFileSync(ack, "utf8").trim()) : 0;
    if (!Number.isSafeInteger(oldAck) || oldAck < 0) throw new Error("invalid legacy spool acknowledgment; retained for repair");
    let row = 0;
    for (const line of legacyLines(legacy)) {
      if (!line.trim()) continue;
      let batch: SpoolBatch;
      try { batch = JSON.parse(line); if (!Array.isArray(batch.events) || !Number.isSafeInteger(batch.offset)) throw new Error(); }
      catch { atomic(path.join(directory(id), "corruption.json"), JSON.stringify({ legacy, row, reason: "invalid complete frame; original retained" })); throw new Error(`corrupt legacy spool frame ${row}; original retained, acknowledgment blocked`); }
      m.source_cursor = batch.offset;
      if (row++ < oldAck) continue;
      for (const part of chunks(batch)) segment(id, m.next++, part);
    }
    if (oldAck > row) throw new Error("legacy acknowledgment exceeds frame count; retained for repair");
    m.legacy_imported = true;
  }
  atomic(manifestFile(id), JSON.stringify(m)); return m;
}
export function spoolCursor(id: string): number | undefined {
  if (!fs.existsSync(manifestFile(id)) && !fs.existsSync(path.join(spoolDir(), `${safe(id)}.jsonl`))) return undefined;
  return manifest(id).source_cursor;
}
export function spoolAppend(id: string, batch: SpoolBatch): void {
  return withSpoolLock(id, () => {
  const m = manifest(id, true);
  for (const part of chunks(batch)) segment(id, m.next++, part);
  m.source_cursor = batch.offset;
  atomic(manifestFile(id), JSON.stringify(m));
  });
}
export function spoolPending(id: string, maxBatches = 1): { batches: SpoolBatch[]; acked: number } {
  const m = manifest(id), batches: SpoolBatch[] = [];
  for (let n = m.acked; n < Math.min(m.next, m.acked + Math.max(1, maxBatches)); n++) {
    const file = segmentFile(id, n);
    if (fs.statSync(file).size > FRAME_MAX * 2) throw new Error(`spool segment ${n} exceeds safety bound; acknowledgment blocked`);
    const frame = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof frame.body !== "string" || crypto.createHash("sha256").update(frame.body).digest("hex") !== frame.sha256) throw new Error(`spool segment ${n} checksum mismatch; acknowledgment blocked`);
    batches.push(JSON.parse(frame.body));
  }
  return { batches, acked: m.acked };
}
export function spoolAck(id: string, throughCount: number): void {
  return withSpoolLock(id, () => {
  const m = manifest(id, true);
  if (!Number.isSafeInteger(throughCount) || throughCount < m.acked || throughCount > m.next) throw new Error("invalid spool acknowledgment");
  m.acked = throughCount; atomic(manifestFile(id), JSON.stringify(m));
  });
}
export function spoolStatus(id: string): { pending_batches: number; pending_bytes: number; oldest_at: string | null; source_cursor: number } {
  const m = manifest(id); let bytes = 0;
  for (let n = m.acked; n < m.next; n++) bytes += fs.statSync(segmentFile(id, n)).size;
  return { pending_batches: m.next - m.acked, pending_bytes: bytes, oldest_at: spoolPending(id).batches[0]?.at ?? null, source_cursor: m.source_cursor };
}
export function spoolSessions(): string[] {
  if (!fs.existsSync(spoolDir())) return [];
  return [...new Set(fs.readdirSync(spoolDir()).filter(f => f.endsWith(".jsonl") || f.endsWith(".v2")).map(f => f.replace(/\.(jsonl|v2)$/, "")))];
}
