import fs from "node:fs";
import path from "node:path";
import { ledgerHome } from "../store.js";

/**
 * Tiny file-based channel between the hooks (which must return in
 * milliseconds and never touch the network) and the helper daemon (which owns
 * git and Postgres). No imports beyond ledgerHome, so hooks.ts can use it
 * without pulling in the daemon.
 */

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
export const bindingsDir = () => path.join(ledgerHome(), "bindings");
export const signalsDir = () => path.join(ledgerHome(), "signals");
export const indexDir = () => path.join(ledgerHome(), "index");
export const notifLog = () => path.join(ledgerHome(), "notifications.log");

/** Written by hooks / MCP tools: { thread_id } or { new: true, title? } */
export function readBinding(sessionId: string): { thread_id?: string; new?: boolean; title?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(bindingsDir(), `${safe(sessionId)}.json`), "utf8")); } catch { return null; }
}
export function writeBinding(sessionId: string, b: { thread_id?: string; new?: boolean; title?: string }): void {
  fs.mkdirSync(bindingsDir(), { recursive: true });
  fs.writeFileSync(path.join(bindingsDir(), `${safe(sessionId)}.json`), JSON.stringify(b));
}

export function writeSignal(sessionId: string, kind: "checkpoint" | "end"): void {
  fs.mkdirSync(signalsDir(), { recursive: true });
  fs.writeFileSync(path.join(signalsDir(), `${safe(sessionId)}.${kind}`), new Date().toISOString());
}
export function takeSignal(sessionId: string, kind: "checkpoint" | "end"): boolean {
  const f = path.join(signalsDir(), `${safe(sessionId)}.${kind}`);
  if (!fs.existsSync(f)) return false;
  try { fs.unlinkSync(f); } catch { /* raced */ }
  return true;
}

/** PostToolUse appends one line per tool call: {at, tool, id}. The daemon reconciles it against parsed events. */
export function appendIndex(sessionId: string, entry: { at: string; tool: string; id?: string }): void {
  if (!entry.id) return;
  fs.mkdirSync(indexDir(), { recursive: true });
  fs.appendFileSync(path.join(indexDir(), `${safe(sessionId)}.jsonl`), JSON.stringify(entry) + "\n");
}
export function readIndex(sessionId: string): { at: string; tool: string; id: string }[] {
  try { return fs.readFileSync(path.join(indexDir(), `${safe(sessionId)}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** Notifications the daemon fetched from the store; hooks surface and clear them. */
export function takeLocalNotifications(): string[] {
  try {
    const f = notifLog();
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(f, "");
    return lines;
  } catch { return []; }
}
export function appendLocalNotifications(lines: string[]): void {
  if (!lines.length) return;
  fs.mkdirSync(ledgerHome(), { recursive: true });
  fs.appendFileSync(notifLog(), lines.join("\n") + "\n");
}
