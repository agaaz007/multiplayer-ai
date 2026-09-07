import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EvidenceCard, EvidenceSource } from "../src/evidence.js";

const root = document.getElementById("ledger")!;
const title = document.getElementById("title")!;
const subtitle = document.getElementById("subtitle")!;
const notice = document.getElementById("notice")!;
const sources = document.getElementById("sources")!;
const people = document.getElementById("people")!;
const panel = document.getElementById("panel")!;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const back = document.getElementById("back") as HTMLButtonElement;
const app = new App({ name: "Ledger evidence", version: "0.1.0" });
let current: EvidenceCard | undefined;
let fullRecords: Record<string, string> = {};
let author: string | null = null;
let pending = false;
let retrieved: CallToolResult | undefined;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = value; // Source records and answer passages are text, never executable markup.
  if (className) node.className = className;
  return node;
}
function button(value: string, action: () => void, className = "action") {
  const node = element("button", value, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function expand(open: boolean) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}
toggle.addEventListener("click", () => expand(Boolean(panel.hidden)));
document.getElementById("close")!.addEventListener("click", () => { expand(false); toggle.focus(); });
back.addEventListener("click", () => { if (retrieved) { receive(retrieved); expand(true); toggle.focus(); } });
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { expand(false); toggle.focus(); }
});
function state(heading: string, message: string, busy = false) {
  root.dataset.busy = String(busy);
  title.textContent = heading;
  subtitle.textContent = message;
  notice.textContent = "";
  sources.replaceChildren();
  people.replaceChildren();
  back.hidden = true;
}
function attributionForm(source: EvidenceSource, container: HTMLElement, trigger: HTMLButtonElement) {
  trigger.hidden = true;
  const form = document.createElement("form");
  form.className = "attribution";
  const field = (label: string, max: number) => {
    const node = element("label", label);
    const input = document.createElement("textarea");
    input.required = true; input.minLength = 3; input.maxLength = max; input.rows = 2;
    node.append(input); form.append(node); return input;
  };
  const excerpt = field("Which passage uses this source?", 2000);
  const contribution = field("What did the source contribute?", 1000);
  const message = element("p", "This displays an attribution. It does not save or verify a finding.", "secondary");
  message.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.className = "actions";
  // Sandboxed hosts can disallow form submission before a submit event fires.
  // This is a tool call through the bridge, so use a button and validate locally.
  const submit = element("button", "Show contribution", "action primary"); submit.type = "button";
  const cancel = button("Cancel", () => { form.remove(); trigger.hidden = false; trigger.focus(); });
  actions.append(submit, cancel); form.append(message, actions); container.append(form); excerpt.focus();
  form.addEventListener("submit", event => event.preventDefault());
  submit.addEventListener("click", async () => {
    if (pending || !form.reportValidity()) return;
    pending = true; submit.disabled = true; cancel.disabled = true; root.dataset.busy = "true";
    message.textContent = "Checking the source and preparing your attribution…";
    try {
      const result = await app.callServerTool({ name: "ledger_show_contribution", arguments: { references: [{
        id: source.id, answer_excerpt: excerpt.value, contribution: contribution.value,
      }] } });
      if (result.isError) throw new Error(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      receive(result); expand(true); toggle.focus();
    } catch (error) {
      message.textContent = `Could not show the contribution: ${error instanceof Error ? error.message : String(error)}`;
    } finally { pending = false; submit.disabled = false; cancel.disabled = false; root.dataset.busy = "false"; }
  });
}
function renderSources() {
  if (!current) return;
  sources.replaceChildren();
  for (const source of current.sources.filter(source => author === null || source.author === author)) {
    const row = document.createElement("details"); row.className = "source";
    const summary = document.createElement("summary");
    summary.append(element("span", source.author.slice(0, 2).toUpperCase(), "avatar"));
    const label = element("span", "", "source-label");
    label.append(element("span", source.title, "source-title"));
    label.append(element("span", `${source.author} · ${source.created.slice(0, 10)} · ${source.type}`, "meta"));
    summary.append(label); row.append(summary);
    const content = element("div", "", "source-content");
    content.append(element("p", source.status === "stable" ? "Published" : source.status === "draft" ? "Draft · Awaiting review" : "Deprecated · Not current guidance", source.status === "stable" ? "secondary" : "notice"));
    if (source.superseded_by) content.append(element("p", `Replaced by ${source.superseded_by}`, "notice"));
    content.append(element("p", source.summary));
    for (const ref of current.references.filter(ref => ref.id === source.id)) {
      const usage = element("div", "", "use");
      usage.append(element("p", "Referenced in this passage", "secondary"));
      usage.append(element("blockquote", ref.answer_excerpt));
      usage.append(element("p", ref.contribution));
      content.append(usage);
      row.open = true;
    }
    const record = document.createElement("details"); record.className = "record";
    record.append(element("summary", "Inspect the original record"));
    record.append(element("p", `${source.id} · Snapshot ${source.snapshot.slice(0, 12)}`, "secondary"));
    record.append(element("pre", fullRecords[source.id] ?? "Full record unavailable in this host. Fetch this ID with ledger_get."));
    content.append(record);
    if (app.getHostCapabilities()?.serverTools) {
      const use = button("Reference this source ↗", () => attributionForm(source, content, use));
      content.append(use);
    }
    row.append(content); sources.append(row);
  }
}
function render(card: EvidenceCard) {
  const referenced = card.mode === "referenced";
  const count = card.sources.length;
  state(`${count} source${count === 1 ? "" : "s"} ${referenced ? "referenced" : "found"}`, "");
  back.hidden = !(referenced && retrieved);
  const authors = [...new Set(card.sources.map(source => source.author))];
  subtitle.textContent = authors.length ? `From ${authors.join(" & ")} · Click to explore` : "Try another question";
  document.getElementById("panel-title")!.textContent = referenced ? "The context behind this answer" : "Explore your team’s context";
  notice.textContent = card.missing_ids.length ? `Not found: ${card.missing_ids.join(", ")}` : referenced
    ? "Reported contributions. Independent verification is not established."
    : count ? "Retrieved evidence. Explore the source before building on it." : `No records matched “${card.query ?? "this request"}”.`;
  if (authors.length > 1) {
    for (const person of [null, ...authors]) {
      const filter = button(person ?? "Everyone", () => {
        author = person;
        for (const child of people.querySelectorAll("button")) child.setAttribute("aria-pressed", String(child === filter));
        renderSources();
      }, "");
      filter.setAttribute("aria-pressed", String(author === person)); people.append(filter);
    }
  }
  renderSources();
}
function receive(result: CallToolResult) {
  if (result.isError) {
    state("Could not load this context", "Expand for details");
    notice.textContent = result.content.filter(c => c.type === "text").map(c => c.text).join("\n"); expand(true); return;
  }
  const card = result.structuredContent as unknown as EvidenceCard | undefined;
  if (!card || card.schema !== "ledger-evidence/v1" || !Array.isArray(card.sources) || !Array.isArray(card.references) || !Array.isArray(card.missing_ids)) {
    state("Evidence card unavailable", "Read the tool’s text response."); return;
  }
  current = card; fullRecords = (result._meta?.["ledger/fullRecords"] ?? {}) as Record<string, string>; author = null;
  if (card.mode === "retrieved") retrieved = result;
  render(card);
}
app.ontoolinput = () => { retrieved = undefined; current = undefined; state("Looking through Ledger", "Finding the work worth building on", true); };
app.ontoolresult = receive;
app.ontoolcancelled = () => state("Request cancelled", "No new evidence returned");
app.onhostcontextchanged = context => { if (context.theme) applyDocumentTheme(context.theme); };
if (window.parent === window) {
  state("Open in an MCP Apps host", "Use npm run preview:ui to try this card locally.");
} else {
  app.connect().then(() => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  }).catch(() => state("Connection unavailable", "Ledger’s text response remains available."));
}
