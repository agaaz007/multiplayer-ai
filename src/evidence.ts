import { createHash } from "node:crypto";
import { z } from "zod";
import { type Config, loadAll } from "./store.js";
import type { LedgerObject } from "./schema.js";
import { renderFull } from "./query.js";
import { readReceipt, receiptText } from "./receipts.js";

export const EVIDENCE_URI = "ui://ledger/evidence-v1.html";
export const ReferenceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  answer_excerpt: z.string().trim().min(3).max(2000).describe("Exact sentence or passage in your answer that references this record."),
  contribution: z.string().trim().min(3).max(1000).describe("How you used it: e.g. reused a cohort definition, challenged a conclusion, or chose a next step. Do not invent time savings or verification."),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export interface EvidenceSource {
  id: string;
  title: string;
  type: LedgerObject["type"];
  author: string;
  created: string;
  status: LedgerObject["status"];
  superseded_by?: string;
  summary: string;
  snapshot: string;
}

export interface EvidenceCard {
  schema: "ledger-evidence/v1";
  mode: "retrieved" | "referenced";
  query?: string;
  sources: EvidenceSource[];
  references: Reference[];
  missing_ids: string[];
}

/** Record identity and status come from storage, never from an agent's attribution. */
export function evidenceResult(
  message: string,
  objects: LedgerObject[],
  options: { query?: string; references?: Reference[]; missing_ids?: string[] } = {},
) {
  const unique = [...new Map(objects.map(o => [o.id, o])).values()];
  const fullRecords = Object.fromEntries(unique.map(o => [o.id, renderFull(o)]));
  const receipt = readReceipt(options.references ? "referenced" : options.query !== undefined ? "found" : "opened", unique, options.query);
  const card: EvidenceCard = {
    schema: "ledger-evidence/v1",
    mode: options.references ? "referenced" : "retrieved",
    ...(options.query !== undefined ? { query: options.query } : {}),
    sources: unique.map(o => ({
      id: o.id, title: o.title, type: o.type, author: o.author, created: o.created,
      status: o.status,
      ...(o.superseded_by ? { superseded_by: o.superseded_by } : {}),
      summary: String(o.fields.result ?? o.fields.formula ?? o.fields.decision ?? o.fields.what ?? o.description),
      snapshot: createHash("sha256").update(fullRecords[o.id]).digest("hex"),
    })),
    references: options.references ?? [],
    missing_ids: options.missing_ids ?? [],
  };
  return {
    content: [receiptText(receipt, message)],
    structuredContent: { ...card, receipt },
    // Full records are for the inspector; don't duplicate them in model context.
    _meta: { "ledger/fullRecords": fullRecords },
  };
}

/** Display-only: does not record knowledge, clear query debt, or establish verification. */
export function contributionResult(cfg: Config, references: Reference[]) {
  const all = new Map(loadAll(cfg).map(o => [o.id, o]));
  const ids = [...new Set(references.map(r => r.id))];
  const missing = ids.filter(id => !all.has(id));
  if (missing.length) throw new Error(`Unknown ledger record(s): ${missing.join(", ")}. Fetch valid records before attributing an answer.`);
  const objects = ids.map(id => all.get(id)!);
  const lines = [
    `Referenced ${objects.length} ledger record(s). Usage below is reported by the agent; this is not independent verification.`,
    ...references.map(r => {
      const o = all.get(r.id)!;
      return `\n${o.id} — ${o.title} (${o.author}, ${o.created.slice(0, 10)}, ${o.status}${o.superseded_by ? `; superseded by ${o.superseded_by}` : ""})\nAnswer: ${r.answer_excerpt}\nContribution: ${r.contribution}`;
    }),
  ];
  return evidenceResult(lines.join("\n"), objects, { references });
}
