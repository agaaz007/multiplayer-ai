import type { LedgerObject, LedgerType } from "./schema.js";
import type { RecordResult } from "./store.js";
import boxen from "boxen";

/** Structured data for a host, plus one sentence an agent can show in chat. */
export interface LedgerReceipt {
  schema: "ledger-receipt/v1";
  action: "found" | "opened" | "referenced" | "saved";
  message: string;
  display: { text: string; markdown: string };
  records: { id: string; title: string; author: string; status: LedgerObject["status"] }[];
  sync?: "pushed" | "local_commit" | "sync_failed" | "commit_failed" | "disabled" | "unconfirmed";
  record_id?: string;
  references?: LedgerReceipt["records"];
  unresolved_references?: string[];
  metadata_unavailable?: boolean;
}

export const RECEIPT_GUIDANCE = " After this call, show receipt.display.markdown verbatim as a user-visible chat update adjacent to the tool call; it is a fenced, boxed Ledger receipt. In plain-text hosts use receipt.display.text. Older results can fall back to receipt.message or the first 💡 Ledger line. Do not leave it only in tool output or thinking. Combine receipts if calls were batched, preserving statuses. Do not describe retrieved sources as used or local saves as synced.";

/** Portable box: no HTML/CSS, and no ANSI escapes unless a terminal opts in. */
export function renderReceiptBox(receipt: Pick<LedgerReceipt, "message">, options: { columns?: number; color?: boolean; ascii?: boolean } = {}): string {
  const width = Math.min(60, Math.max(16, Math.floor(options.columns || 60)));
  const message = receipt.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return boxen(message.replace(/^💡 Ledger · /, "").replaceAll(" · ", "\n"), {
    title: options.ascii ? "Ledger" : "💡 Ledger",
    borderStyle: options.ascii ? "classic" : "round",
    ...(options.color ? { borderColor: "cyan" } : {}),
    width, padding: { left: 1, right: 1, top: 0, bottom: 0 },
  });
}

function withDisplay(receipt: Omit<LedgerReceipt, "display">): LedgerReceipt {
  const text = renderReceiptBox(receipt);
  // Every data line begins with a box border, so source backticks cannot close the fence.
  return { ...receipt, display: { text, markdown: `\`\`\`text\n${text}\n\`\`\`` } };
}
const compact = (s: string, max = 100) => {
  const line = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const unique = (objects: LedgerObject[]) => [...new Map(objects.map(o => [o.id, o])).values()];
const refs = (objects: LedgerObject[]): LedgerReceipt["records"] => unique(objects).map(o => ({
  id: o.id, title: o.title, author: o.author, status: o.status,
}));
const owners = (objects: LedgerObject[]) => {
  const names = [...new Set(objects.map(o => o.author))];
  return names.slice(0, 3).map(n => compact(n, 30)).join(", ") + (names.length > 3 ? ` +${names.length - 3} others` : "");
};
const lifecycle = (objects: LedgerObject[]) => {
  const labels = (["draft", "deprecated"] as const).flatMap(status => {
    const count = objects.filter(o => o.status === status).length;
    return count ? [`${count} ${status}`] : [];
  });
  return labels.length ? ` · Includes ${labels.join(", ")}` : "";
};

export function readReceipt(action: "found" | "opened" | "referenced", objects: LedgerObject[], query?: string, candidateCount = 0): LedgerReceipt {
  const records = unique(objects);
  const n = records.length;
  let message: string;
  if (action === "opened") {
    const first = records[0];
    message = first ? `Opened ${first.type} “${compact(first.title)}” · ${compact(first.author, 30)} · ${first.created.slice(0, 10)}` : "Record not found";
  } else if (action === "referenced") {
    message = `Referenced ${n} record${n === 1 ? "" : "s"} from ${owners(records)} · Usage reported by agent`;
  } else {
    message = n ? `Found ${n} record${n === 1 ? "" : "s"} from ${owners(records)}` : candidateCount ? "No applicable records" : "No matching records";
    if (candidateCount) message += ` · ${candidateCount} scope-unknown candidate${candidateCount === 1 ? "" : "s"}; validate before reuse`;
    if (query) message += ` · “${compact(query, 70)}”`;
  }
  return withDisplay({ schema: "ledger-receipt/v1", action, message: `💡 Ledger · ${message}${lifecycle(records)}`, records: refs(records) });
}

/** Only an acknowledged push can be described as synced. */
export function syncReceipt(git: string | null, enabled: boolean): { sync: LedgerReceipt["sync"]; message: string } {
  if (git === "committed and pushed") return { sync: "pushed", message: "Committed and pushed" };
  if (git?.startsWith("commit failed:")) return { sync: "commit_failed", message: "Saved locally · Commit failed" };
  if (git?.startsWith("committed locally;")) return { sync: "sync_failed", message: "Committed locally · Sync failed" };
  if (git === "committed (no remote)") return { sync: "local_commit", message: "Committed locally · No remote" };
  if (!enabled) return { sync: "disabled", message: "Saved locally · Git sync disabled" };
  return { sync: "unconfirmed", message: "Saved locally · Git sync unconfirmed" };
}

export function savedReceipt(type: LedgerType, fields: Record<string, unknown>, result: RecordResult, objects: LedgerObject[] | null, gitSync: boolean): LedgerReceipt {
  const saved = objects?.find(o => o.id === result.id);
  const data = saved?.fields ?? fields;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const prior = data.prior && typeof data.prior === "object" ? data.prior as Record<string, unknown> : {};
  const priorIds = [
    ...strings(prior.ids), ...strings(data.based_on), ...strings(data.related_findings),
    ...(result.superseded ? [result.superseded] : []),
  ];
  const ids = [...new Set(priorIds)];
  const byId = new Map((objects ?? []).map(o => [o.id, o]));
  const referenced = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const unresolved = objects ? ids.filter(id => !byId.has(id)) : [];
  const outcome = syncReceipt(result.git, gitSync);
  const status = saved?.status ?? fields.status;
  const label = status === "draft" || status === "deprecated" ? `${status} ` : "";
  let message = `💡 Ledger · Saved ${label}${type} “${compact(saved?.title ?? String(fields.title))}” · ${outcome.message}`;
  if (referenced.length) message += ` · Links ${referenced.length} prior record${referenced.length === 1 ? "" : "s"} from ${owners(referenced)}${lifecycle(referenced)}`;
  if (unresolved.length) message += ` · ${unresolved.length} unresolved reference${unresolved.length === 1 ? "" : "s"}`;
  if (!saved) message += " · Source details unavailable";
  return withDisplay({ schema: "ledger-receipt/v1", action: "saved", record_id: result.id, message, sync: outcome.sync,
    ...(!saved ? { metadata_unavailable: true } : {}),
    records: saved ? refs([saved]) : [], references: refs(referenced), unresolved_references: unresolved });
}

export const receiptText = (receipt: LedgerReceipt, details?: string) => ({
  type: "text" as const, text: receipt.message + (details ? `\n\n${details}` : ""),
  annotations: { audience: ["user", "assistant"] as ("user" | "assistant")[], priority: 1 },
});
