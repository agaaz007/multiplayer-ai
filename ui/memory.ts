import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Capped } from "../src/interpret.js";
import type { MemoryCard } from "../src/memory-card.js";

const root = document.getElementById("ledger")!;
const title = document.getElementById("title")!;
const subtitle = document.getElementById("subtitle")!;
const notice = document.getElementById("notice")!;
const headline = document.getElementById("headline")!;
const sections = document.getElementById("sections")!;
const panel = document.getElementById("panel")!;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const app = new App({ name: "Ledger memory", version: "0.1.0" });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = value; // Record titles, results and author names are text, never executable markup.
  if (className) node.className = className;
  return node;
}
function expand(open: boolean) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}
toggle.addEventListener("click", () => expand(Boolean(panel.hidden)));
document.getElementById("close")!.addEventListener("click", () => { expand(false); toggle.focus(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { expand(false); toggle.focus(); }
});
function state(heading: string, message: string, busy = false) {
  root.dataset.busy = String(busy);
  title.textContent = heading;
  subtitle.textContent = message;
  notice.textContent = "";
  headline.replaceChildren();
  sections.replaceChildren();
}
const day = (iso: string) => (iso ? iso.slice(0, 10) : "");

function section(heading: string, count: number) {
  const node = element("div", "", "section");
  node.append(element("h2", `${heading} (${count})`));
  sections.append(node);
  return node;
}
/** A sample is only honest next to its total, so the remainder is stated rather than dropped. */
function remainder<T>(node: HTMLElement, list: Capped<T>) {
  if (list.count > list.examples.length) {
    node.append(element("p", `… and ${list.count - list.examples.length} more. Run \`ledger memory\` for the full view.`, "empty"));
  }
}

function conflicts(card: MemoryCard) {
  const node = section("Disagreements left unranked", card.conflicts.count);
  if (!card.conflicts.count) {
    node.append(element("p", "Every accepted claim has one current version, and no reproduction came out differently.", "empty"));
    return;
  }
  node.append(element("p", "Both sides stand until someone supersedes one with evidence, or records why both hold. The ledger does not choose by recency.", "secondary"));
  for (const conflict of card.conflicts.examples) {
    const row = element("div", "", "row");
    row.append(element("h2", conflict.kind === "accepted-conflict" ? "Competing accepted claims" : "Contested reproduction"));
    const peers = element("div", "", "peers");
    // One column per claim, identical markup and styling: the card must not imply an order.
    for (const claim of conflict.claims) {
      const peer = element("div", "", "peer");
      peer.append(element("span", claim.result, "claim"));
      peer.append(element("span", `${claim.author} · ${day(claim.created)} · ${claim.id}`, "meta"));
      peers.append(peer);
    }
    row.append(peers);
    const solo = conflict.dependents.length === 1;
    row.append(element("p", conflict.dependents.length
      ? `${conflict.dependents.length} recorded result${solo ? "" : "s"} already depend${solo ? "s" : ""} on one side (${conflict.dependents.slice(0, 4).join(", ")}), so this needs resolving before more work rests on it.`
      : "Nothing downstream depends on either side yet, so it can stay open without interrupting anyone.", "secondary"));
    node.append(row);
  }
  remainder(node, card.conflicts);
}

function corrections(card: MemoryCard) {
  const node = section("Corrections and what they put back under review", card.corrections.count);
  if (!card.corrections.count) {
    node.append(element("p", "No correction has been recorded yet. When one is, everything resting on the corrected record is listed here.", "empty"));
    return;
  }
  for (const correction of card.corrections.examples) {
    const row = element("div", "", "row");
    row.append(element("h2", correction.title));
    row.append(element("span", `${correction.author} · ${day(correction.created)} · corrects ${correction.corrects} · effect ${correction.effect}`, "meta"));
    row.append(element("p", correction.reason, "secondary"));
    if (!correction.accepted) row.append(element("p", "Not accepted, so no automatic review impact is asserted.", "notice"));
    if (correction.affected.count) {
      row.append(element("p", `Needs review before reuse. Affected does not mean false: ${correction.affected.count} result${correction.affected.count === 1 ? "" : "s"}.`, "secondary"));
      const list = element("ul", "", "plain");
      for (const affected of correction.affected.examples) list.append(element("li", `${affected.id} — ${affected.title}: ${affected.reason}`));
      row.append(list);
      remainder(row, correction.affected);
    } else {
      row.append(element("p", "Nothing downstream is confirmed affected.", "empty"));
    }
    row.append(element("p", correction.interrupt.required ? `Needs attention. ${correction.interrupt.reason}` : `No one needs interrupting. ${correction.interrupt.reason}`, correction.interrupt.required ? "notice" : "secondary"));
    node.append(row);
  }
  remainder(node, card.corrections);
}

function reuse(card: MemoryCard) {
  const node = section("Work reused across people", card.reuse.cross_author.count);
  node.append(element("p", "Counted only where one person's record pins another's by exact content version. A record named in prose is a gap, not reuse.", "secondary"));
  if (card.reuse.cross_author.count) {
    const list = element("ul", "", "plain");
    for (const edge of card.reuse.cross_author.examples) {
      list.append(element("li", `${edge.from_author}: ${edge.from_title} (${edge.from}) pins ${edge.to_author}: ${edge.to_title} (${edge.to}) — ${edge.relation}${edge.live ? "" : " — stale pin, the target has moved on"}`));
    }
    node.append(list);
    remainder(node, card.reuse.cross_author);
  } else {
    node.append(element("p", "No cross-person reuse is pinned yet.", "empty"));
  }
  if (card.reuse.unpinned_cross_author.count) {
    const one = card.reuse.unpinned_cross_author.count === 1;
    node.append(element("p", `${card.reuse.unpinned_cross_author.count} cross-person reference${one ? "" : "s"} name${one ? "s" : ""} another person's record without pinning its version, so nothing can tell whether it has changed since. Pin dependencies with the target's content_version to turn these into lineage.`, "notice"));
  }
  if (card.reuse.stale.count) {
    node.append(element("p", `${card.reuse.stale.count} pinned dependenc${card.reuse.stale.count === 1 ? "y" : "ies"} no longer match the target's current version. A stale pin still names exactly what was used.`, "secondary"));
  }
}

function activity(card: MemoryCard) {
  const node = section(`Recorded in the ${card.period_days} days to ${day(card.as_of)}`, card.period.recorded);
  if (!card.period.by_author.length) {
    node.append(element("p", "Nothing recorded in this window.", "empty"));
    return;
  }
  const list = element("ul", "", "plain");
  for (const person of card.period.by_author) {
    list.append(element("li", `${person.author}: ${person.total} — ${person.definitions} definitions, ${person.findings} findings, ${person.changes} changes, ${person.decisions} decisions`));
  }
  node.append(list);
}

function gaps(card: MemoryCard) {
  const node = element("div", "", "section");
  node.append(element("h2", "Gaps"));
  node.append(element("p", "What this memory cannot back with lineage, listed so the numbers above stay honest.", "secondary"));
  const list = element("ul", "", "plain");
  list.append(element("li", `${card.gaps.findings_without_pins.count} of ${card.reuse.findings_total} findings pin no definition or prior result, so their lineage cannot be traced`));
  const oneName = card.gaps.unresolved_names.count === 1;
  list.append(element("li", `${card.gaps.unresolved_names.count} record${oneName ? "" : "s"} name${oneName ? "s" : ""} a dependency without pinning a version`));
  list.append(element("li", `${card.gaps.unreproduced} of ${card.reuse.findings_total} findings have not been re-run by anyone at their current version`));
  list.append(element("li", `${card.gaps.drafts.count} draft${card.gaps.drafts.count === 1 ? "" : "s"} awaiting review`));
  node.append(list);
  sections.append(node);
}

function render(card: MemoryCard) {
  state("What this memory is doing", "");
  subtitle.textContent = `As of the last record, ${day(card.as_of)} · Click to explore`;
  notice.textContent = `${card.totals.people.length} ${card.totals.people.length === 1 ? "person" : "people"}: ${card.totals.people.join(", ") || "nobody yet"}. ${card.totals.definitions} definitions, ${card.totals.decisions} decisions in force, ${card.totals.findings} findings, ${card.totals.changes} changes.`;
  for (const line of card.headline) {
    const item = document.createElement("li");
    const space = line.indexOf(" ");
    item.append(element("span", space > 0 ? line.slice(0, space) : line, "figure"));
    item.append(element("span", space > 0 ? line.slice(space + 1) : ""));
    headline.append(item);
  }
  conflicts(card);
  corrections(card);
  reuse(card);
  activity(card);
  gaps(card);
}

function receive(result: CallToolResult) {
  if (result.isError) {
    state("Could not read the memory", "Expand for details");
    notice.textContent = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    expand(true);
    return;
  }
  const card = result.structuredContent as unknown as MemoryCard | undefined;
  if (!card || card.schema !== "ledger-memory/v1" || !Array.isArray(card.headline) || !card.conflicts || !card.reuse) {
    state("Memory report unavailable", "Read the tool's text response.");
    return;
  }
  render(card);
}
app.ontoolinput = () => state("Reading the ledger", "Working out what this memory is doing", true);
app.ontoolresult = receive;
app.ontoolcancelled = () => state("Request cancelled", "No report was returned");
app.onhostcontextchanged = context => { if (context.theme) applyDocumentTheme(context.theme); };
if (window.parent === window) {
  state("Open in an MCP Apps host", "Call ledger_memory from a host that renders MCP Apps.");
} else {
  app.connect().then(() => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  }).catch(() => state("Connection unavailable", "Ledger's text response remains available."));
}
