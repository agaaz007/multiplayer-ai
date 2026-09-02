import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, record, getById, type Config } from "./store.js";
import { brief, search, similarFindings, renderFull, stats } from "./query.js";
import { ChangeSchema, DecisionSchema, DefinitionSchema, FindingSchema, TYPES } from "./schema.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export async function startMcp() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e: any) {
    process.stderr.write(`ledger: ${e.message}\n`);
    process.exit(1);
  }

  const server = new McpServer({ name: "ledger", version: "0.1.0" });

  server.registerTool(
    "ledger_brief",
    {
      title: "Ledger brief",
      description:
        "Call this FIRST in any session that touches metrics, analysis, product direction, or shipping. Returns canonical metric definitions, decisions in force, and recent findings and changes. Small enough to keep in context.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).describe("Lookback window"),
        tags: z.array(z.string()).optional().describe("Filter to tags, e.g. ['hiastro']"),
      },
    },
    async ({ days, tags }) => text(brief(cfg, { days, tags }))
  );

  server.registerTool(
    "ledger_search",
    {
      title: "Search the ledger",
      description:
        "Search definitions, findings, changes, and decisions by free text. Use it BEFORE running an analysis (has this question been answered?), before attributing a metric move (what shipped?), and before proposing direction (what was decided?).",
      inputSchema: {
        query: z.string().min(2),
        types: z.array(z.enum(TYPES)).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        include_superseded: z.boolean().default(false),
      },
    },
    async ({ query, types, tags, limit, include_superseded }) => {
      const hits = search(cfg, query, { types, tags, limit, includeSuperseded: include_superseded });
      if (!hits.length) return text(`No matches for "${query}". If you go on to answer this, record the finding.`);
      return text(
        hits
          .map((h) => `[${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title}\n    ${(h.fields.result ?? h.fields.formula ?? h.fields.decision ?? h.fields.what ?? "")}`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "ledger_get",
    {
      title: "Get one ledger object",
      description: "Fetch a full object by id (e.g. fnd-20260902-trial-cvr-ab12) including its query and body.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const o = getById(cfg, id);
      return text(o ? renderFull(o) : `Not found: ${id}`);
    }
  );

  const recordTool = (
    name: string,
    type: (typeof TYPES)[number],
    schema: z.ZodObject<any>,
    description: string
  ) =>
    server.registerTool(
      name,
      { title: name, description, inputSchema: schema.omit({ author: true }).extend({ author: z.string().optional() }).shape },
      async (fields: any) => {
        // Rework check for findings: surface prior answers before writing a new one.
        let warn = "";
        if (type === "finding") {
          const sim = similarFindings(cfg, String(fields.question));
          if (sim.length) {
            warn =
              `\n\nNote: ${sim.length} similar finding(s) already exist. If yours is a refresh, set supersedes to the old id. If the numbers disagree, say why in caveats.\n` +
              sim.map((s) => `  ${s.id} (${s.author}, ${s.created.slice(0, 10)}): ${s.fields.result}`).join("\n");
          }
        }
        const res = record(cfg, { type, fields });
        return text(
          `Recorded ${type} ${res.id}` +
            (res.superseded ? ` (superseded ${res.superseded})` : "") +
            (res.git ? ` — ${res.git}` : "") +
            warn
        );
      }
    );

  recordTool(
    "ledger_record_definition",
    "definition",
    DefinitionSchema,
    "Record a canonical metric definition. Do this whenever you compute a metric that has no definition in the ledger, or when a definition changes (set supersedes)."
  );
  recordTool(
    "ledger_record_finding",
    "finding",
    FindingSchema,
    "Record the result of an analysis as an argument, not a number: question, result, definitions used, data window, inputs (every table/event), method (how inputs became the result, in words), the exact query, and assumptions. At least one assumption must be kind: implicit (data completeness, definition match, nothing shipped in the window); the tool rejects the record otherwise and says what to add. Do this at the END of any analysis, even a small one, even at low confidence. Returns similar prior findings so duplicates are visible."
  );
  recordTool(
    "ledger_record_change",
    "change",
    ChangeSchema,
    "Record something that shipped to users or to production: what, when, where, to whom. Do this the moment something goes live, so other people's agents stop misattributing metric moves."
  );
  recordTool(
    "ledger_record_decision",
    "decision",
    DecisionSchema,
    "Record a product or company decision in MADR shape: the decision stated so it could later be false, the context that forced it, every option considered including 'do nothing' with why each lost, rationale, assumptions (at least one implicit), consequences, a revisit date, and how we'll confirm it was right. Do this when a direction is chosen, dropped, or reversed (set supersedes on reversal)."
  );

  server.registerTool(
    "ledger_skip_record",
    {
      title: "Skip recording, with a reason",
      description:
        "Call this when the Stop checkpoint asks about uncaptured data queries and none of them produced a durable finding, decision, change, or definition: exploration, a check that confirmed nothing, a dead end. Say why. This clears the checkpoint and is counted, so use it honestly rather than to get past the reminder.",
      inputSchema: {
        reason: z.string().min(5).describe("Why nothing here is worth a record, in one or two sentences"),
      },
    },
    async ({ reason }) => text(`Noted, nothing recorded: ${reason}`)
  );

  server.registerTool(
    "ledger_stats",
    {
      title: "Ledger stats",
      description: "Pilot health: object counts by author, findings missing definitions, cross-author duplicate findings.",
      inputSchema: { days: z.number().int().min(1).max(365).default(14) },
    },
    async ({ days }) => text(stats(cfg, days))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
