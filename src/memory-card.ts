import { headline, memoryReport, type Capped, type ConflictEntry, type CorrectionEntry, type MemoryReport, type ReportOpts, type ReuseEdge } from "./interpret.js";
import type { LedgerObject } from "./schema.js";
import { summaryReceipt, receiptText } from "./receipts.js";

/**
 * The chat-side view of `interpret.ts`. `memory.md` is committed for people reading the data repo
 * on GitHub; this is the same report where the work actually happens, in a message.
 *
 * Three constraints shape the shapes below, and none of them are cosmetic:
 *
 *   - A chat message is not a file. Everything here is bounded before it is rendered, and every
 *     bounded list travels as `Capped<T>` so the count beside a truncated sample is still the true
 *     total. A shortened list reported as a number is the one lie this surface cannot afford.
 *   - Two accepted claims render as peers. The card and the text both name both sides and neither
 *     orders them, because the ledger's whole claim is that it refuses to pick by recency.
 *   - Only lineage counts as reuse. A named reference travels in the gaps, never in the headline.
 *
 * The report is recomputed from the objects on every call, so there is no cache to go stale.
 */

export const MEMORY_URI = "ui://ledger/memory-v1.html";

/** Rows kept per section in the card. Each sits beside a `count` that is never truncated. */
const ROWS = 12;
/** Rows named in the chat text; the card holds more, and `ledger memory` holds all of it. */
const LINES = 3;
/**
 * Ceiling on the text part, in bytes, enforced after rendering. Record titles, authors and results
 * are unbounded input, so clipping each field bounds the common case and this bounds the rest.
 */
export const MEMORY_TEXT_LIMIT = 4000;

/** A correction's blast radius is unbounded, so the card carries a sample plus the true count. */
export interface MemoryCardCorrection extends Omit<CorrectionEntry, "affected"> {
  affected: Capped<CorrectionEntry["affected"][number]>;
}

export interface MemoryCard {
  schema: "ledger-memory/v1";
  /** Newest record, not the clock: two hosts showing the same objects show the same card. */
  as_of: string;
  since: string;
  period_days: number;
  /** The five numbers, plain text. `headline()` emphasises for markdown files; a host is not one. */
  headline: string[];
  totals: MemoryReport["totals"];
  period: MemoryReport["period"];
  conflicts: Capped<ConflictEntry>;
  corrections: Capped<MemoryCardCorrection>;
  reuse: {
    cross_author: Capped<ReuseEdge>;
    stale: Capped<ReuseEdge>;
    unpinned_cross_author: Capped<MemoryReport["reuse"]["unpinned_cross_author"][number]>;
    findings_pinned: number;
    findings_total: number;
  };
  gaps: MemoryReport["gaps"];
}

const cap = <T>(xs: T[], n = ROWS): Capped<T> => ({ count: xs.length, examples: xs.slice(0, n) });
const plain = (s: string) => s.replace(/\*\*/g, "");
const day = (iso: string) => (iso ? iso.slice(0, 10) : "an unknown date");
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function memoryCard(r: MemoryReport): MemoryCard {
  return {
    schema: "ledger-memory/v1",
    as_of: r.as_of,
    since: r.since,
    period_days: r.period_days,
    headline: headline(r).map(plain),
    totals: r.totals,
    period: r.period,
    conflicts: cap(r.conflicts),
    corrections: cap(r.corrections.map((c) => ({ ...c, affected: cap(c.affected) }))),
    reuse: {
      cross_author: cap(r.reuse.cross_author),
      stale: cap(r.reuse.stale),
      unpinned_cross_author: cap(r.reuse.unpinned_cross_author),
      findings_pinned: r.reuse.findings_pinned,
      findings_total: r.reuse.findings_total,
    },
    gaps: r.gaps,
  };
}

function remainder(out: string[], shown: number, total: number) {
  if (total > shown) out.push(`  … and ${total - shown} more; run \`ledger memory\` for all of them.`);
}

/** Summarise and link. Detail belongs in `ledger_get` and `ledger memory`, not in a chat message. */
export function memoryText(c: MemoryCard): string {
  const out: string[] = [
    `What this memory is doing, as of the last record on ${day(c.as_of)}.`,
    `${plural(c.totals.people.length, "person", "people")}: ${c.totals.people.map((p) => clip(p, 40)).join(", ") || "nobody yet"}. ` +
      `${c.totals.definitions} definitions, ${c.totals.decisions} decisions in force, ${c.totals.findings} findings, ${c.totals.changes} changes.`,
    ``,
    ...c.headline.map((h) => `* ${h}`),
    ``,
    `Disagreements left unranked (${c.conflicts.count})`,
  ];
  if (!c.conflicts.count) {
    out.push(`  None: every accepted claim has one current version, and no reproduction came out differently.`);
  } else {
    for (const x of c.conflicts.examples.slice(0, LINES)) {
      // Both sides on one line, joined by "and". The order is the sorted id order, not a ranking.
      out.push(
        `  ${x.kind === "accepted-conflict" ? "Competing accepted claims" : "Contested reproduction"}, standing as peers: ` +
          x.claims.map((k) => `${k.id} (${clip(k.author, 30)}, ${day(k.created)}) "${clip(k.result, 90)}"`).join(" and "),
        `    ${x.dependents.length
          ? `${plural(x.dependents.length, "recorded result")} already depend${x.dependents.length === 1 ? "s" : ""} on one side (${x.dependents.slice(0, 3).join(", ")}); resolve it by superseding one with evidence, or record why both stand.`
          : `Nothing downstream depends on either side yet, so it can stay open without interrupting anyone.`}`
      );
    }
    remainder(out, LINES, c.conflicts.count);
  }

  out.push(``, `Corrections and what they put back under review (${c.corrections.count})`);
  if (!c.corrections.count) {
    out.push(`  None recorded. When one is, everything resting on the corrected record is listed here.`);
  } else {
    for (const x of c.corrections.examples.slice(0, LINES)) {
      out.push(
        `  ${x.id} (${clip(x.author, 30)}, ${day(x.created)}) corrects ${x.corrects}, effect ${x.effect}: ` +
          `${x.affected.count
            ? `${plural(x.affected.count, "result")} need${x.affected.count === 1 ? "s" : ""} review before reuse (${x.affected.examples.slice(0, 3).map((a) => a.id).join(", ")})`
            : `nothing downstream is confirmed affected`}. ` +
          `${x.accepted ? "" : "Not accepted, so no automatic review impact is asserted. "}${x.interrupt.required ? "Needs attention." : "No one needs interrupting."}`
      );
    }
    remainder(out, LINES, c.corrections.count);
  }

  out.push(``, `Work reused across people (${c.reuse.cross_author.count}), counted only where a version is pinned`);
  if (!c.reuse.cross_author.count) {
    out.push(`  None pinned. This counts lineage, not mentions: a record citing another by exact content_version.`);
  } else {
    for (const e of c.reuse.cross_author.examples.slice(0, LINES)) {
      out.push(`  ${e.from} (${clip(e.from_author, 30)}) pins ${e.to} (${clip(e.to_author, 30)}) — ${e.relation}${e.live ? "" : ", stale pin: the target has moved on"}`);
    }
    remainder(out, LINES, c.reuse.cross_author.count);
  }
  if (c.reuse.unpinned_cross_author.count) {
    out.push(
      `  ${plural(c.reuse.unpinned_cross_author.count, "cross-person reference")} name${c.reuse.unpinned_cross_author.count === 1 ? "s" : ""} another person's record without pinning its version, so nothing can tell whether it has changed. Those are gaps, not reuse.`
    );
  }

  out.push(
    ``,
    `Recorded in the ${c.period_days} days to ${day(c.as_of)} (${c.period.recorded})` +
      (c.period.by_author.length ? `: ${c.period.by_author.slice(0, 6).map((a) => `${clip(a.author, 30)} ${a.total}`).join(", ")}` : `: nothing in this window`),
    ``,
    `Gaps: ${c.gaps.findings_without_pins.count} of ${c.reuse.findings_total} findings pin no definition or prior result; ` +
      `${plural(c.gaps.unresolved_names.count, "record")} name${c.gaps.unresolved_names.count === 1 ? "s" : ""} a dependency without pinning a version; ` +
      `${c.gaps.unreproduced} of ${c.reuse.findings_total} findings have not been re-run by anyone at their current version; ` +
      `${plural(c.gaps.drafts.count, "draft")} awaiting review.`,
    ``,
    `Open any id with ledger_get. \`ledger memory [--days N] [--json]\` prints the full view, which is also committed as memory.md.`
  );
  return out.join("\n");
}

/** Bounded per field, then bounded overall: unbounded input must not push a result out of a chat. */
function fit(body: string, limit: number): string {
  if (Buffer.byteLength(body) <= limit) return body;
  const note = "\n… truncated to fit a message; run `ledger memory` for the full view.";
  let out = body;
  while (out && Buffer.byteLength(out) + Buffer.byteLength(note) > limit) out = out.slice(0, -64);
  return out + note;
}

/**
 * The tool result. Text for every host, `structuredContent` for hosts that read it, and the full
 * uncapped report in `_meta` for the card's inspector, which is not model context.
 */
export function memoryResult(objects: LedgerObject[], opts: ReportOpts = {}) {
  const report = memoryReport(objects, opts);
  const card = memoryCard(report);
  const receipt = summaryReceipt(`Memory as of ${day(card.as_of)}`, card.headline);
  const body = fit(memoryText(card), MEMORY_TEXT_LIMIT - Buffer.byteLength(receipt.message) - 2);
  return {
    content: [receiptText(receipt, body)],
    structuredContent: { ...card, receipt },
    _meta: { "ledger/memoryReport": report },
  };
}
