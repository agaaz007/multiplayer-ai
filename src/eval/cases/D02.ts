import fs from "node:fs";
import path from "node:path";
import type { TrialContext } from "../types.js";
import type { EvalCaseRunner } from "./index.js";

/**
 * D02: a newer confirmed decision supersedes an older accepted one. The origin's tools are the same
 * in both conditions and the origin driver does not provide Ledger MCP, so the two decisions are
 * written directly into the trial ledger repo as real decision objects with the `supersedes`
 * relation (kit setup: "Save both as real Ledger decision objects using the existing supersedes
 * relation; preserve their IDs in the source map"). Their ids land in raw/ledger-ids.json keyed by
 * fixture event id, which the collector uses as the system_ref when a successor tool output
 * carrying the text also carries the id. The decision statement is the exact fixture text so a
 * retrieval of the object contains the excerpt verbatim.
 */
export const D02: EvalCaseRunner = {
  id: "D02",
  async before(ctx: TrialContext) {
    const { record, initLedger } = await import("../../store.js");
    const events = ctx.request.case.events;
    const v1 = events.find((e) => e.id === "metric-v1");
    const v2 = events.find((e) => e.id === "metric-v2");
    if (!v1 || !v2) throw new Error("D02 fixture lacks metric-v1/metric-v2 events");
    const ledgerDir = ctx.paths.ledgerDir;
    if (!fs.existsSync(path.join(ledgerDir, "decisions"))) {
      // The driver normally initializes the trial ledger; do it here without touching the real ~/.ledger.
      const prev = process.env.LEDGER_CONFIG_DIR;
      process.env.LEDGER_CONFIG_DIR = ctx.paths.configDir;
      try { initLedger(ledgerDir, ctx.originAuthor); } finally { if (prev === undefined) delete process.env.LEDGER_CONFIG_DIR; else process.env.LEDGER_CONFIG_DIR = prev; }
    }
    const today = new Date().toISOString().slice(0, 10);
    const cfg = (author: string) => ({ ledger_dir: ledgerDir, author, git_sync: true });
    const first = record(cfg(v1.author), {
      type: "decision",
      fields: {
        title: "Conversion denominator: all sessions (metric-v1)",
        decision: v1.text,
        context: "The conversion metric needed a denominator before the paywall analysis could report a rate. Sessions were the readily available count.",
        drivers: ["available immediately", "matches the existing dashboard"],
        options_considered: [
          { option: "all sessions", chosen: true, rationale: "already counted; initially accepted" },
          { option: "unique exposed users", rationale: "exposure logging not yet verified" },
          { option: "do nothing", rationale: "no rate could be reported" },
        ],
        rationale: "Sessions were the denominator already in use; accepted as the initial definition.",
        assumptions: [{ statement: "Session counts are complete for the analysis window", kind: "implicit", evidence: "not independently verified", if_wrong: "changes_conclusion" }],
        consequences: ["Repeat visits by one user inflate the denominator"],
        reversibility: "reversible",
        confidence: "medium",
        valid_from: today,
        owner: v1.author,
        tags: ["conversion", "eval-fixture"],
        body: v1.text,
      },
    });
    const second = record(cfg(v2.author), {
      type: "decision",
      fields: {
        title: "Conversion denominator: unique exposed users (metric-v2)",
        decision: v2.text,
        context: "metric-v1 counted all sessions, which double-counts users who return. Exposure logging is now confirmed, so the denominator can be per user.",
        drivers: ["one user counted once", "matches how exposure is logged"],
        options_considered: [
          { option: "unique exposed users", chosen: true, rationale: "confirmed by Agaaz; supersedes metric-v1" },
          { option: "keep all sessions (metric-v1)", rationale: "inflates the denominator with repeat visits" },
          { option: "do nothing", rationale: "two teams would keep reporting different rates" },
        ],
        rationale: "Unique exposed users is the denominator the paywall rate should use; this decision supersedes metric-v1.",
        assumptions: [{ statement: "Exposure events are logged once per user per experiment", kind: "implicit", evidence: "not independently verified", if_wrong: "changes_conclusion" }],
        consequences: ["Dashboards using metric-v1 must be recomputed"],
        reversibility: "reversible",
        confidence: "high",
        valid_from: today,
        owner: v2.author,
        supersedes: first.id,
        tags: ["conversion", "eval-fixture"],
        body: v2.text,
      },
    });
    if (second.superseded !== first.id) throw new Error(`D02: supersedes bookkeeping failed (${second.superseded} != ${first.id})`);
    fs.mkdirSync(ctx.paths.rawDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.rawDir, "ledger-ids.json"), JSON.stringify({ [v1.id]: first.id, [v2.id]: second.id }, null, 2) + "\n");
    ctx.log(`D02: recorded ${first.id} (${first.git}) and ${second.id} superseding it (${second.git})`);
  },
};
