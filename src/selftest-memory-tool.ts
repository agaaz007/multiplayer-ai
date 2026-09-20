import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { initLedger, record, getById, loadAll, type Config } from "./store.js";
import { objectVersion } from "./authority.js";
import { createMcpServer } from "./mcp.js";
import { MEMORY_URI, MEMORY_TEXT_LIMIT, memoryResult } from "./memory-card.js";
import type { LedgerObject } from "./schema.js";

/**
 * `ledger_memory` puts the interpretability view in a chat, where nobody can scroll past a caveat
 * to reach a chart. So the thing under test is not "does it render" but "can it overclaim":
 *
 *   - a truncated list read as a total,
 *   - a named reference counted as reuse,
 *   - a disagreement presented with a side that reads as the answer,
 *   - a result too large for the message it is supposed to be.
 *
 * Every case below is one of those. The card's data path is exercised through a real MCP client so
 * the text fallback, `structuredContent` and the UI resource are all checked as a host sees them.
 */

/** Ranking words this surface must never produce about competing accepted claims. */
const RANKING = /\bwinner\b|\bwins\b|latest|most recent|more recent|outranks|takes precedence|supersedes automatically/i;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-memory-tool-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";
const cfg: Config = { ledger_dir: path.join(tmp, "ledger"), author: "agaaz", git_sync: false };
const rachit: Config = { ...cfg, author: "rachit" };
initLedger(cfg.ledger_dir, "agaaz");

const finding = (who: Config, fields: Record<string, unknown>) =>
  record(who, {
    type: "finding",
    fields: {
      source: "fixture",
      data_window: { from: "2026-09-01", to: "2026-09-07" },
      inputs: [{ source: "fixture", snapshot_at: "2026-09-08" }],
      method: "Count the fixture rows for the stated population and window.",
      assumptions: [{ statement: "The frozen fixture is complete for the window", kind: "implicit", if_wrong: "weakens_conclusion" }],
      query: "SELECT count(*) FROM fixture",
      ...fields,
    },
  });

// rachit owns the definition; agaaz pins it by exact version. That pin, and only that pin, is reuse.
const definition = record(rachit, {
  type: "definition",
  fields: { title: "Trial start CVR", metric: "trial_start_cvr", formula: "trial starts / paywall impressions", source: "fixture", owner: "rachit", valid_from: "2026-08-01" },
});
const definitionVersion = objectVersion(getById(cfg, definition.id)!);
finding(cfg, {
  title: "Trial start CVR on Android",
  question: "What was trial-start CVR on Android in the window?",
  result: "12.4% (n=41,200)",
  definitions_used: ["trial_start_cvr"],
  dependencies: [{ relation: "uses-definition", id: definition.id, version: definitionVersion }],
});
// The same relationship named rather than pinned. It is a gap, and must never reach the headline.
finding(cfg, {
  title: "Trial start CVR on iOS",
  question: "What was trial-start CVR on iOS in the window?",
  result: "9.1% (n=18,400)",
  definitions_used: [definition.id],
});

const parent = finding(cfg, { title: "Paywall impressions, first pass", question: "How many paywall impressions?", result: "118,900 impressions" });
const parentVersion = objectVersion(getById(cfg, parent.id)!);
const acceptance = (id: string, version: string) => ({ actor: "agaaz", accepted_at: "2026-09-09", expected_predecessor: { id, version }, evidence_refs: [{ artifact_id: id, sha256: version, role: "review" }] });
const sideA = finding(cfg, {
  title: "Paywall impressions, deduplicated by user",
  question: "How many paywall impressions?",
  result: "104,300 impressions after deduplicating repeat views",
  supersedes: parent.id,
  acceptance: acceptance(parent.id, parentVersion),
});
finding(cfg, { title: "Annual plan trial rate", question: "What was the annual plan trial rate?", result: "3.2%", status: "draft" });

/**
 * The second accepted claim arrives the only way one can: a teammate recorded it against the same
 * predecessor on their own machine and it merged in. `record` refuses to mint the second acceptance
 * locally (`supersession target already has an accepted successor`), which is exactly why the
 * conflict has to be written the way git delivers it.
 */
const sideAFile = getById(cfg, sideA.id)!.path;
const merged = matter(fs.readFileSync(sideAFile, "utf8"));
const sideBId = sideA.id.replace(/-[a-z0-9]{4}$/, "-zz99");
const generated = (merged.data.generated ?? {}) as Record<string, unknown>;
fs.writeFileSync(
  path.join(path.dirname(sideAFile), `${sideBId}.md`),
  matter.stringify(merged.content, {
    ...merged.data,
    id: sideBId,
    title: "Paywall impressions, counted per session",
    result: "121,400 impressions counting every session view",
    generated: { ...generated, by: "human:rachit" },
  })
);

const objects = loadAll(cfg);
const server = createMcpServer(cfg);
const client = new Client({ name: "memory-tool-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// ---------------------------------------------------------------------------------------------
// The tool is offered, and answers with both a text fallback and structured data.
// ---------------------------------------------------------------------------------------------
const tools = (await client.listTools()).tools;
const tool = tools.find((t) => t.name === "ledger_memory");
assert.ok(tool, "ledger_memory is registered");
assert.equal((tool._meta as any)?.ui?.resourceUri, MEMORY_URI, "the tool points at its own card");

const result = (await client.callTool({ name: "ledger_memory", arguments: {} })) as any;
assert.ok(!result.isError, JSON.stringify(result));
const [content] = result.content;
assert.equal(content.type, "text");
const card = result.structuredContent;
assert.equal(card.schema, "ledger-memory/v1");
assert.equal(card.period_days, 7, "the default window is the one the description states");
assert.equal(card.as_of, objects[0].created, "anchored to the newest record, not the clock");
assert.ok(result._meta["ledger/memoryReport"].as_of === card.as_of, "the full report travels for the inspector");

// ---------------------------------------------------------------------------------------------
// The receipt carries the five numbers, in a box, in both display forms.
// ---------------------------------------------------------------------------------------------
const receipt = card.receipt;
assert.equal(receipt.schema, "ledger-receipt/v1");
assert.equal(receipt.action, "summarized");
assert.equal(receipt.records.length, 0, "a computed view retrieved no record and must not imply it did");
assert.equal(card.headline.length, 5);
for (const line of card.headline) {
  assert.doesNotMatch(line, /\*\*/, "the card's headline is plain text, not markdown emphasis");
  assert.ok(receipt.message.includes(line), `the receipt carries "${line}"`);
}
assert.ok(receipt.display.markdown.startsWith("```text\n") && receipt.display.markdown.trimEnd().endsWith("```"), "a fenced text box");
assert.ok(receipt.display.text.includes("Ledger"), "the plain-text box is titled");
assert.ok(!receipt.display.text.includes("```"), "the plain-text form carries no fence");
for (const figure of card.headline.map((line: string) => line.split(" ")[0])) {
  assert.ok(receipt.display.text.includes(figure), `the box shows ${figure}`);
}

// ---------------------------------------------------------------------------------------------
// Reuse counts pinned lineage only; the named reference is reported beside it as a gap.
// ---------------------------------------------------------------------------------------------
assert.equal(card.reuse.cross_author.count, 1, "one pinned cross-person edge");
assert.equal(card.reuse.cross_author.examples[0].to, definition.id);
assert.equal(card.reuse.cross_author.examples[0].live, true);
assert.equal(card.reuse.unpinned_cross_author.count, 1, "the named reference is a gap, not reuse");
assert.match(content.text, /Those are gaps, not reuse/);
assert.equal(card.gaps.drafts.count, 1);

// ---------------------------------------------------------------------------------------------
// A conflict renders both sides, and nothing in the result ranks them.
// ---------------------------------------------------------------------------------------------
assert.equal(card.conflicts.count, 1, "one conflict, deduplicated across both members");
assert.deepEqual([...card.conflicts.examples[0].ids].sort(), [sideA.id, sideBId].sort());
assert.equal(card.conflicts.examples[0].claims.length, 2);
assert.deepEqual([...new Set(card.conflicts.examples[0].claims.map((c: any) => c.author))].sort(), ["agaaz", "rachit"]);
assert.ok(content.text.includes(sideA.id) && content.text.includes(sideBId), "both sides are named in the text");
assert.match(content.text, /standing as peers/);
assert.doesNotMatch(content.text, RANKING);
assert.doesNotMatch(JSON.stringify(card.conflicts), RANKING);
assert.doesNotMatch(receipt.message, RANKING);

// ---------------------------------------------------------------------------------------------
// An explicit window changes the period, and nothing else silently.
// ---------------------------------------------------------------------------------------------
const wide = (await client.callTool({ name: "ledger_memory", arguments: { days: 90 } })) as any;
assert.equal(wide.structuredContent.period_days, 90);
assert.equal(wide.structuredContent.conflicts.count, card.conflicts.count, "the window is activity, not authority");

// ---------------------------------------------------------------------------------------------
// The UI resource is registered and served, with its script substituted in.
// ---------------------------------------------------------------------------------------------
const listed = (await client.listResources()).resources;
assert.ok(listed.some((r) => r.uri === MEMORY_URI), "the memory card is advertised at connection time");
const resource = await client.readResource({ uri: MEMORY_URI });
const [served] = resource.contents as any[];
assert.equal(served.mimeType, RESOURCE_MIME_TYPE);
assert.match(served.text, /^<!doctype html>/i);
assert.ok(served.text.includes('id="headline"') && served.text.includes('id="sections"'), "the card's mount points are present");
assert.ok(!served.text.includes("<!-- APP_SCRIPT -->"), "the bundle was substituted, not left as a placeholder");
assert.ok(served.text.includes("ledger-memory/v1"), "the bundled script validates the card schema it is handed");
assert.deepEqual(served._meta.ui.csp, { connectDomains: [], resourceDomains: [] }, "the card makes no network requests");

// ---------------------------------------------------------------------------------------------
// Unbounded records must not produce an unbounded message, and a capped sample must not be read
// as a total. Titles and results are user input; twenty-five conflicts is a bad week, not a bug.
// ---------------------------------------------------------------------------------------------
{
  let n = 0;
  const obj = (o: Partial<LedgerObject> & { id: string }): LedgerObject => ({
    type: "finding", created: `2026-09-10T12:00:${String(n++ % 60).padStart(2, "0")}.000Z`, path: `/tmp/${o.id}.md`,
    title: "T".repeat(3000), author: "agaaz", tags: [], status: "stable", description: "", body: "", fields: { result: "R".repeat(3000) }, ...o,
  });
  const huge: LedgerObject[] = [];
  for (let i = 0; i < 25; i++) {
    huge.push(
      { ...obj({ id: `fnd-parent-${i}` }), status: "deprecated", superseded_by: `fnd-a-${i}`, previous_status: "stable" },
      obj({ id: `fnd-a-${i}`, supersedes: `fnd-parent-${i}` }),
      obj({ id: `fnd-b-${i}`, supersedes: `fnd-parent-${i}`, author: "rachit" })
    );
  }
  const stressed = memoryResult(huge);
  const body = stressed.content[0].text;
  assert.ok(Buffer.byteLength(body) <= MEMORY_TEXT_LIMIT, `text is ${Buffer.byteLength(body)} bytes, over the ${MEMORY_TEXT_LIMIT} cap`);
  assert.doesNotMatch(body, RANKING);
  const stressedCard = stressed.structuredContent;
  assert.equal(stressedCard.conflicts.count, 25, "the count is the total");
  assert.equal(stressedCard.conflicts.examples.length, 12, "the sample is bounded");
  assert.match(body, /Disagreements left unranked \(25\)/, "the section header states the total, not the sample");
  assert.match(body, /… and 22 more/, "the text says what it did not show");
}

// A ledger with nothing in it still answers, with no invented number.
{
  const empty = memoryResult([]);
  assert.equal(empty.structuredContent.conflicts.count, 0);
  assert.doesNotMatch(empty.content[0].text, /NaN|undefined|null/);
  assert.ok(Buffer.byteLength(empty.content[0].text) <= MEMORY_TEXT_LIMIT);
}

await client.close();
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("selftest-memory-tool: ok");
