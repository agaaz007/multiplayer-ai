import fs from 'node:fs';
import path from 'node:path';

/**
 * One shared dollar allowance for the whole pilot. Every paid operation reserves a
 * conservative upper bound BEFORE dispatch and reconciles afterwards; a reservation
 * that cannot fit stops paid dispatch. Codex subscription usage is recorded in tokens
 * and never converted into the dollar allowance. Missing vendor usage stays unknown.
 *
 * The file is shared by concurrently running sequences, so every mutation takes an
 * exclusive-create lock file. A stale lock older than 60 s is treated as abandoned.
 */
export interface BudgetEntry {
  id: string; at: string; sequence: string; stage: string; provider: string; operation: string;
  reservedUsd: number; chargedUsd: number | null; reconciled: boolean; basis: string; usage?: unknown;
}
export interface BudgetLedger {
  schema: 'sequence-budget/v1'; maximumApprovedUsd: number; authorization: string; createdAt: string;
  entries: BudgetEntry[]; subscription: Array<{ at: string; sequence: string; stage: string; model: string; usage: unknown; wallMs: number }>;
  stoppedAt?: string; stopReason?: string;
}
/** Conservative unit prices (USD per million tokens / per document) used only for upper bounds. */
export const PRICE_BOUNDS = {
  'openai:gpt-4.1-mini': { inputPerMillion: 1.0, outputPerMillion: 4.0, note: 'upper bound above the listed rate; Graphify reports its own estimate' },
  'openai:text-embedding-3-large': { inputPerMillion: 0.5, outputPerMillion: 0, note: 'upper bound above the listed rate' },
  'supermemory:document': { perDocumentUsd: 0.05, note: 'no public per-document rate; assumed upper bound per captured document on the user plan' },
} as const;

function lockPath(file: string) { return file + '.lock'; }
async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = lockPath(file); const deadline = Date.now() + 30_000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error('budget ledger lock timeout');
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}
export function createBudget(file: string, maximumApprovedUsd: number, authorization: string): BudgetLedger {
  if (!(maximumApprovedUsd > 0) || maximumApprovedUsd > 20) throw new Error('pilot allowance must be positive and within the approved $20');
  const ledger: BudgetLedger = { schema: 'sequence-budget/v1', maximumApprovedUsd, authorization, createdAt: new Date().toISOString(), entries: [], subscription: [] };
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return ledger;
}
function read(file: string): BudgetLedger {
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ledger.schema !== 'sequence-budget/v1') throw new Error('invalid budget ledger');
  return ledger;
}
function write(file: string, ledger: BudgetLedger) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}
export function committedUsd(ledger: BudgetLedger): number {
  // Unreconciled reservations count at their full bound; reconciled ones at the charged amount (never below zero).
  return ledger.entries.reduce((sum, e) => sum + (e.reconciled ? Math.max(0, e.chargedUsd ?? e.reservedUsd) : e.reservedUsd), 0);
}
export function remainingUsd(ledger: BudgetLedger): number { return ledger.maximumApprovedUsd - committedUsd(ledger); }

/** Reserve an upper bound; throws (and records the stop) when the allowance cannot cover it. */
export async function reserve(file: string, input: Omit<BudgetEntry, 'id' | 'at' | 'chargedUsd' | 'reconciled'>): Promise<BudgetEntry> {
  if (!(input.reservedUsd >= 0) || !Number.isFinite(input.reservedUsd)) throw new Error('reservation bound must be a finite non-negative number');
  return withLock(file, () => {
    const ledger = read(file);
    if (ledger.stoppedAt) throw new Error(`paid dispatch stopped: ${ledger.stopReason}`);
    const remaining = remainingUsd(ledger);
    if (input.reservedUsd > remaining) {
      ledger.stoppedAt = new Date().toISOString();
      ledger.stopReason = `${input.provider} ${input.operation} for ${input.sequence}/${input.stage} needs up to $${input.reservedUsd.toFixed(4)} but only $${remaining.toFixed(4)} of the shared allowance remains`;
      write(file, ledger); throw new Error(ledger.stopReason);
    }
    const entry: BudgetEntry = { id: `bud-${ledger.entries.length + 1}-${Math.random().toString(16).slice(2, 8)}`, at: new Date().toISOString(),
      ...input, chargedUsd: null, reconciled: false };
    ledger.entries.push(entry); write(file, ledger); return entry;
  });
}
/** Reconcile with the amount actually observed; `null` keeps the reservation as the charge (unknown is not zero). */
export async function reconcile(file: string, id: string, chargedUsd: number | null, usage?: unknown, basis?: string): Promise<BudgetEntry> {
  return withLock(file, () => {
    const ledger = read(file); const entry = ledger.entries.find(e => e.id === id);
    if (!entry) throw new Error('unknown budget entry');
    entry.reconciled = true; entry.chargedUsd = chargedUsd === null ? entry.reservedUsd : Math.max(chargedUsd, 0);
    if (chargedUsd !== null && chargedUsd > entry.reservedUsd) entry.basis += ` | observed charge exceeded its bound (${chargedUsd} > ${entry.reservedUsd})`;
    if (usage !== undefined) entry.usage = usage; if (basis) entry.basis += ` | ${basis}`;
    write(file, ledger); return entry;
  });
}
export async function recordSubscriptionUsage(file: string, input: BudgetLedger['subscription'][number]): Promise<void> {
  await withLock(file, () => { const ledger = read(file); ledger.subscription.push(input); write(file, ledger); });
}
export function summarizeBudget(file: string) {
  const ledger = read(file);
  return { maximumApprovedUsd: ledger.maximumApprovedUsd, committedUsd: committedUsd(ledger), remainingUsd: remainingUsd(ledger),
    paidEntries: ledger.entries.length, unreconciled: ledger.entries.filter(e => !e.reconciled).length,
    subscriptionStages: ledger.subscription.length,
    subscriptionTokens: ledger.subscription.reduce((acc, s: any) => ({ input: acc.input + (s.usage?.input_tokens ?? 0), cached: acc.cached + (s.usage?.cached_input_tokens ?? 0), output: acc.output + (s.usage?.output_tokens ?? 0) }), { input: 0, cached: 0, output: 0 }),
    stoppedAt: ledger.stoppedAt ?? null, stopReason: ledger.stopReason ?? null,
    note: 'Dollar figures are conservative upper bounds for paid memory/extraction/embedding operations; Codex subscription usage is tokens only and is not converted to dollars. Unknown vendor charges are carried at their reserved bound, never as zero.' };
}
/** Rough token bound from bytes; ~3 bytes per token is pessimistic for English prose. */
export const tokensBound = (bytes: number) => Math.ceil(bytes / 3);
