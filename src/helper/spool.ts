import fs from "node:fs";
import path from "node:path";
import { ledgerHome } from "../store.js";
import type { NormEvent } from "../continuity/events.js";

/**
 * Local durable spool: events are appended here the moment they are parsed,
 * and removed only after the store acknowledges them. Offline, the spool
 * grows; on reconnect it drains in order. One JSONL file per session plus a
 * tiny ack file holding the count of acknowledged lines.
 */

export function spoolDir(): string {
  return path.join(ledgerHome(), "spool");
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const eventsFile = (id: string) => path.join(spoolDir(), `${safe(id)}.jsonl`);
const ackFile = (id: string) => path.join(spoolDir(), `${safe(id)}.ack`);

export interface SpoolBatch { offset: number; events: NormEvent[]; at: string }

export function spoolAppend(sessionId: string, batch: SpoolBatch): void {
  fs.mkdirSync(spoolDir(), { recursive: true });
  fs.appendFileSync(eventsFile(sessionId), JSON.stringify(batch) + "\n");
}

export function spoolPending(sessionId: string): { batches: SpoolBatch[]; acked: number } {
  const f = eventsFile(sessionId);
  if (!fs.existsSync(f)) return { batches: [], acked: 0 };
  const acked = Number(fs.existsSync(ackFile(sessionId)) ? fs.readFileSync(ackFile(sessionId), "utf8").trim() : 0) || 0;
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const batches: SpoolBatch[] = [];
  for (const l of lines.slice(acked)) {
    try { batches.push(JSON.parse(l)); } catch { /* partial write of the last line; will be complete next pass */ }
  }
  return { batches, acked };
}

export function spoolAck(sessionId: string, throughCount: number): void {
  fs.mkdirSync(spoolDir(), { recursive: true });
  fs.writeFileSync(ackFile(sessionId), String(throughCount) + "\n");
  // compact when everything is acked and the file has grown
  const f = eventsFile(sessionId);
  try {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    if (throughCount >= lines.length && lines.length > 200) {
      fs.writeFileSync(f, "");
      fs.writeFileSync(ackFile(sessionId), "0\n");
    }
  } catch { /* nothing to compact */ }
}

export function spoolSessions(): string[] {
  if (!fs.existsSync(spoolDir())) return [];
  return fs.readdirSync(spoolDir()).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
}
