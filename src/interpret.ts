import { correctionImpact, dependents, objectVersion, resolveAccepted, verification, type ImpactResult } from "./authority.js";
import { DIRS, type Correction, type Dependency, type LedgerObject, type LedgerType } from "./schema.js";

/**
 * The interpretability layer: what a person sees when they ask "what is this memory actually doing?".
 *
 * The graph answers "what is stored". This answers the three questions a buyer and a teammate ask
 * instead, each of which is a claim only a ledger with lineage can make:
 *
 *   1. Conflicts — where two accepted claims disagree and the ledger refuses to rank them by recency.
 *   2. Blast radius — which recorded results a correction put back under review.
 *   3. Reuse — where one person's work was pinned by another person's, by exact version.
 *
 * Every number here is derived from the git objects on each call, like `graph.ts` and `views.ts`:
 * there is nothing to sync and nothing to drift. Two rules keep it honest:
 *
 *   - Anchor the period to the newest record, never to the wall clock. `memory.md` is a generated
 *     view committed on every record, so a clock-derived window would make two machines emit
 *     different bytes for the same objects and turn a derived file into a merge conflict.
 *   - Count only what lineage proves. A finding that names a definition in prose is not counted as
 *     reuse; only a pinned `dependencies` entry whose content_version still matches is. Claims the
 *     data cannot support belong in the gaps section, not in the headline.
 */

const DAY = 86_400_000;

export interface ConflictEntry {
  /** Ids of the competing accepted claims, sorted. */
  ids: string[];
  type: LedgerType;
  claims: { id: string; title: string; author: string; created: string; result: string }[];
  /** Recorded work pinning either side; zero means nobody is building on the disagreement yet. */
  dependents: string[];
  kind: "accepted-conflict" | "contested-reproduction";
  detail: string;
}

export interface CorrectionEntry {
  id: string;
  title: string;
  author: string;
  created: string;
  corrects: string;
  effect: Correction["effect"] | "unspecified";
  reason: string;
  accepted: boolean;
  affected: { id: string; title: string; reason: string }[];
  incomplete: { id: string; reason: string }[];
  interrupt: ImpactResult["interrupt"];
}

export interface ReuseEdge {
  from: string;
  from_title: string;
  from_author: string;
  to: string;
  to_title: string;
  to_author: string;
  relation: Dependency["relation"];
  /** False when the pinned version no longer matches the target: lineage that has gone stale. */
  live: boolean;
}

export interface MemoryReport {
  /** Newest record's timestamp; the period and every "as of" statement hang off this, not the clock. */
  as_of: string;
  period_days: number;
  since: string;
  totals: {
    definitions: number;
    decisions: number;
    findings: number;
    changes: number;
    drafts: number;
    deprecated: number;
    people: string[];
    first_record?: string;
  };
  period: {
    recorded: number;
    by_author: { author: string; definitions: number; findings: number; changes: number; decisions: number; total: number }[];
  };
  conflicts: ConflictEntry[];
  corrections: CorrectionEntry[];
  reuse: {
    edges: ReuseEdge[];
    cross_author: ReuseEdge[];
    stale: ReuseEdge[];
    /** Cross-person references that name a record but pin no version: multiplayer without lineage. */
    unpinned_cross_author: { from: string; from_author: string; to: string; to_author: string }[];
    findings_total: number;
    findings_pinned: number;
  };
  gaps: {
    findings_without_pins: Capped<{ id: string; title: string; author: string }>;
    unresolved_names: Capped<{ id: string; title: string; names: string[] }>;
    drafts: Capped<{ id: string; title: string; author: string; origin: "fallback" | "manual" }>;
    unreproduced: number;
  };
}

/** A full count with a bounded sample, so a truncated list never becomes a wrong number. */
export interface Capped<T> {
  count: number;
  examples: T[];
}

const EXAMPLES = 20;
const capped = <T>(xs: T[]): Capped<T> => ({ count: xs.length, examples: xs.slice(0, EXAMPLES) });

const RESULT_FIELDS = ["result", "decision", "what", "formula"] as const;

/** One line of what the object claims, for a wall that has to be readable without opening files. */
function claimText(o: LedgerObject): string {
  for (const f of RESULT_FIELDS) {
    const v = o.fields[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return o.description || o.title;
}

function deps(o: LedgerObject): Dependency[] {
  return ((o.fields.dependencies as Dependency[] | undefined) ?? []).filter((d) => d && typeof d.id === "string");
}

/** Legacy lineage: a name or bare id with no pinned version. Reported, never counted as reuse. */
function unresolvedNames(o: LedgerObject): string[] {
  const pinned = new Set(deps(o).map((d) => d.id));
  const out: string[] = [];
  for (const name of (o.fields.definitions_used as string[] | undefined) ?? []) if (!pinned.has(name)) out.push(name);
  for (const id of (o.fields.based_on as string[] | undefined) ?? []) if (!pinned.has(id)) out.push(id);
  const prior = o.fields.prior as { ids?: string[] } | undefined;
  for (const id of prior?.ids ?? []) if (!pinned.has(id)) out.push(id);
  return [...new Set(out)].sort();
}

function counted(objects: LedgerObject[], type: LedgerType, status: LedgerObject["status"] = "stable"): number {
  return objects.filter((o) => o.type === type && o.status === status).length;
}

export interface ReportOpts {
  /** Length of the "this period" window, in days back from the newest record. */
  days?: number;
  /** Override the anchor; tests pin it so the fixture output is stable. */
  asOf?: string;
}

/**
 * Compute the report. Pure: same objects in, same report out, on any machine.
 */
export function memoryReport(objects: LedgerObject[], opts: ReportOpts = {}): MemoryReport {
  const all = [...objects].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : 1));
  const byId = new Map(all.map((o) => [o.id, o]));
  const live = all.filter((o) => o.status !== "draft");
  const asOf = opts.asOf ?? all[0]?.created ?? new Date(0).toISOString();
  const days = opts.days ?? 7;
  const since = new Date(Date.parse(asOf) - days * DAY).toISOString();

  // --- conflicts: competing accepted claims, plus reproductions that came out differently -------
  const conflicts = new Map<string, ConflictEntry>();
  for (const o of all) {
    const r = resolveAccepted(all, o.id);
    if (r.status !== "conflict" || r.current.length < 2) continue;
    const ids = r.current.map((c) => c.id).sort();
    const key = ids.join("|");
    if (conflicts.has(key)) continue;
    conflicts.set(key, {
      ids,
      type: r.current[0].type,
      claims: r.current.map((c) => ({ id: c.id, title: c.title, author: c.author, created: c.created, result: claimText(c) })),
      dependents: [...new Set(ids.flatMap((id) => dependents(all, id)))].sort(),
      kind: "accepted-conflict",
      detail: "Two accepted claims stand at once. The ledger will not pick by recency; resolve by superseding one with evidence, or record why both stand.",
    });
  }
  for (const o of live) {
    const v = verification(all, o);
    if (v.status !== "contested") continue;
    const differing = v.attempts.filter((a) => a.at_current_version && a.outcome === "differed");
    const key = [o.id, ...differing.map((a) => a.id)].sort().join("|");
    if (conflicts.has(key)) continue;
    conflicts.set(key, {
      ids: [o.id, ...differing.map((a) => a.id)],
      type: o.type,
      claims: [
        { id: o.id, title: o.title, author: o.author, created: o.created, result: claimText(o) },
        ...differing.map((a) => {
          const rec = byId.get(a.id);
          return { id: a.id, title: rec?.title ?? a.id, author: a.actor, created: rec?.created ?? "", result: a.note ?? "re-ran the recorded recipe and got a different answer" };
        }),
      ],
      dependents: dependents(all, o.id),
      kind: "contested-reproduction",
      detail: "Someone re-ran the recorded recipe at this exact version and did not get the same answer.",
    });
  }

  // --- corrections and their blast radius -------------------------------------------------------
  const corrections: CorrectionEntry[] = [];
  for (const o of all) {
    const c = o.fields.correction as Correction | undefined;
    if (!c || !o.supersedes) continue;
    const impact = correctionImpact(all, o.id);
    corrections.push({
      id: o.id,
      title: o.title,
      author: o.author,
      created: o.created,
      corrects: o.supersedes,
      effect: impact.effect,
      reason: c.reason,
      accepted: impact.accepted,
      affected: impact.affected.map((a) => ({ id: a.id, title: byId.get(a.id)?.title ?? a.id, reason: a.reason })),
      incomplete: impact.incomplete,
      interrupt: impact.interrupt,
    });
  }

  // --- reuse: pinned lineage, and the subset that crosses people --------------------------------
  const edges: ReuseEdge[] = [];
  for (const o of live) {
    for (const d of deps(o)) {
      const target = byId.get(d.id);
      if (!target) continue;
      edges.push({
        from: o.id,
        from_title: o.title,
        from_author: o.author,
        to: target.id,
        to_title: target.title,
        to_author: target.author,
        relation: d.relation,
        live: objectVersion(target) === d.version,
      });
    }
  }
  edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));

  // The same relationship, named but not pinned. It is not lineage and is never counted as reuse,
  // but it is where cross-person reuse is actually happening, so it is reported as a fixable gap.
  const unpinnedCross: { from: string; from_author: string; to: string; to_author: string }[] = [];
  for (const o of live) {
    for (const name of unresolvedNames(o)) {
      const target = byId.get(name);
      if (!target || target.author === o.author) continue;
      unpinnedCross.push({ from: o.id, from_author: o.author, to: target.id, to_author: target.author });
    }
  }
  unpinnedCross.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));

  // Denominators are the objects in force. A deprecated predecessor would otherwise inflate every
  // "out of N findings" claim on the page.
  const findings = all.filter((o) => o.type === "finding" && o.status === "stable");

  // --- the honest gaps --------------------------------------------------------------------------
  const drafts = all
    .filter((o) => o.status === "draft")
    .map((o) => ({
      id: o.id,
      title: o.title,
      author: o.author,
      origin: (o.fields.capture_method === "transcript_fallback" ? "fallback" : "manual") as "fallback" | "manual",
    }));

  const byAuthor = new Map<string, { author: string; definitions: number; findings: number; changes: number; decisions: number; total: number }>();
  const inPeriod = all.filter((o) => o.created >= since && o.created <= asOf);
  for (const o of inPeriod) {
    const row = byAuthor.get(o.author) ?? { author: o.author, definitions: 0, findings: 0, changes: 0, decisions: 0, total: 0 };
    if (o.type === "definition") row.definitions++;
    else if (o.type === "finding") row.findings++;
    else if (o.type === "change") row.changes++;
    else row.decisions++;
    row.total++;
    byAuthor.set(o.author, row);
  }

  return {
    as_of: asOf,
    period_days: days,
    since,
    totals: {
      definitions: counted(all, "definition"),
      decisions: counted(all, "decision"),
      findings: counted(all, "finding"),
      changes: counted(all, "change"),
      drafts: drafts.length,
      deprecated: all.filter((o) => o.status === "deprecated").length,
      people: [...new Set(all.map((o) => o.author))].sort(),
      first_record: all.length ? all[all.length - 1].created : undefined,
    },
    period: {
      recorded: inPeriod.length,
      by_author: [...byAuthor.values()].sort((a, b) => (b.total === a.total ? (a.author < b.author ? -1 : 1) : b.total - a.total)),
    },
    conflicts: [...conflicts.values()].sort((a, b) => (a.ids.join() < b.ids.join() ? -1 : 1)),
    corrections: corrections.sort((a, b) => (a.created < b.created ? 1 : -1)),
    reuse: {
      edges,
      cross_author: edges.filter((e) => e.from_author !== e.to_author),
      stale: edges.filter((e) => !e.live),
      unpinned_cross_author: unpinnedCross,
      findings_total: findings.length,
      findings_pinned: findings.filter((o) => deps(o).length > 0).length,
    },
    gaps: {
      findings_without_pins: capped(
        findings.filter((o) => deps(o).length === 0).map((o) => ({ id: o.id, title: o.title, author: o.author }))
      ),
      unresolved_names: capped(
        live.map((o) => ({ id: o.id, title: o.title, names: unresolvedNames(o) })).filter((x) => x.names.length > 0)
      ),
      drafts: capped(drafts),
      unreproduced: findings.filter((o) => verification(all, o).status === "unreproduced").length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering. Markdown, because the data repo on GitHub is the dashboard people already open.
// ---------------------------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
const clip = (s: unknown, n: number) => {
  const t = esc(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

function link(id: string, byId: Map<string, LedgerObject>): string {
  const o = byId.get(id);
  if (!o) return `\`${id}\``;
  return `[${id}](${DIRS[o.type]}/${id}.md)`;
}

/** The five numbers to read aloud. Each one is a claim a plain file store cannot make. */
export function headline(r: MemoryReport): string[] {
  const reuse = r.reuse.cross_author.length;
  const needReview = r.corrections.reduce((n, c) => n + c.affected.length, 0);
  return [
    `**${r.conflicts.length}** disagreement${r.conflicts.length === 1 ? "" : "s"} caught and left unranked`,
    `**${needReview}** recorded result${needReview === 1 ? "" : "s"} put back under review by a correction`,
    `**${reuse}** time${reuse === 1 ? "" : "s"} one person's work was pinned by another person's`,
    `**${r.reuse.findings_pinned}/${r.reuse.findings_total}** findings rest on a pinned version (${pct(r.reuse.findings_pinned, r.reuse.findings_total)})`,
    `**${r.gaps.drafts.count}** draft${r.gaps.drafts.count === 1 ? "" : "s"} awaiting review`,
  ];
}

export function renderMemoryReport(r: MemoryReport, objects: LedgerObject[]): string {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const day = (iso: string) => (iso ? iso.slice(0, 10) : "");
  const md: string[] = [
    `---`,
    `type: Reference`,
    `title: What the memory is doing`,
    `description: Generated view of disagreements caught, corrections and their blast radius, and work reused across people.`,
    `---`,
    `<!-- generated by \`ledger\`; do not edit -->`,
    `# What this memory is doing`,
    ``,
    `As of the last record, ${day(r.as_of)}. ${r.totals.people.length} ${r.totals.people.length === 1 ? "person" : "people"}: ${r.totals.people.join(", ") || "—"}. ` +
      `${r.totals.definitions} definitions, ${r.totals.decisions} decisions in force, ${r.totals.findings} findings, ${r.totals.changes} changes.` +
      (r.totals.first_record ? ` First record ${day(r.totals.first_record)}.` : ``),
    ``,
    ...headline(r).map((h) => `* ${h}`),
    ``,
    `[Records](README.md) · [Lineage graph](graph.md) · [Log](log.md)`,
    ``,
  ];

  // 1. Conflicts
  md.push(`## Disagreements the ledger refused to settle (${r.conflicts.length})`, ``);
  if (!r.conflicts.length) {
    md.push(`_None. Every accepted claim has a single current version, and no reproduction came out differently._`, ``);
  } else {
    md.push(
      `Recency does not decide. Each pair below stands until someone supersedes one with evidence, or records why both hold.`,
      ``
    );
    for (const c of r.conflicts) {
      md.push(
        `### ${c.kind === "accepted-conflict" ? "Competing accepted claims" : "Contested reproduction"}: ${clip(c.claims[0]?.title, 90)}`,
        ``,
        `| claim | by | recorded | id |`,
        `|---|---|---|---|`,
        ...c.claims.map((x) => `| ${clip(x.result, 160)} | ${esc(x.author)} | ${day(x.created)} | ${link(x.id, byId)} |`),
        ``,
        `${c.detail} ${c.dependents.length ? `**${c.dependents.length} recorded result${c.dependents.length === 1 ? "" : "s"} already depend${c.dependents.length === 1 ? "s" : ""} on one side** (${c.dependents.map((d) => link(d, byId)).join(", ")}), so this needs resolving before more work rests on it.` : `Nothing downstream depends on either side yet, so it can stay open without interrupting anyone.`}`,
        ``
      );
    }
  }

  // 2. Blast radius
  md.push(`## Corrections and what they put back under review (${r.corrections.length})`, ``);
  if (!r.corrections.length) {
    md.push(`_No correction has been recorded yet. When one is, everything that rests on the corrected record is listed here._`, ``);
  } else {
    for (const c of r.corrections) {
      md.push(
        `### ${clip(c.title, 100)}`,
        ``,
        `${day(c.created)} · ${esc(c.author)} · corrects ${link(c.corrects, byId)} · effect \`${c.effect}\`${c.accepted ? "" : " · **not accepted**, so no automatic review impact is asserted"}`,
        ``,
        `Reason: ${clip(c.reason, 300)}`,
        ``
      );
      if (c.affected.length) {
        md.push(`Needs review before reuse:`, ``, `| result | why | id |`, `|---|---|---|`);
        for (const a of c.affected) md.push(`| ${clip(a.title, 80)} | ${clip(a.reason, 120)} | ${link(a.id, byId)} |`);
        md.push(``);
      } else {
        md.push(`Nothing downstream is confirmed affected.`, ``);
      }
      if (c.incomplete.length) {
        md.push(
          `Lineage gaps that make the blast radius uncertain: ${c.incomplete.slice(0, 5).map((x) => `${link(x.id, byId)} (${clip(x.reason, 90)})`).join("; ")}`,
          ``
        );
      }
      md.push(`> ${c.interrupt.required ? "**Needs attention.** " : "No one needs interrupting. "}${clip(c.interrupt.reason, 400)}`, ``);
    }
  }

  // 3. Reuse across people
  md.push(`## Work reused across people (${r.reuse.cross_author.length})`, ``);
  if (!r.reuse.cross_author.length) {
    md.push(
      `_No cross-person reuse yet. This counts only pinned lineage: one person's record citing another's by exact version, not by name._`,
      ``
    );
    if (r.reuse.unpinned_cross_author.length) {
      md.push(
        `It is happening without lineage, though: **${r.reuse.unpinned_cross_author.length}** cross-person reference${r.reuse.unpinned_cross_author.length === 1 ? "" : "s"} name another person's record without pinning its version, so nothing can tell whether the record has changed since. ` +
          `${r.reuse.unpinned_cross_author.slice(0, 5).map((e) => `${esc(e.from_author)} → ${esc(e.to_author)} (${link(e.from, byId)} → ${link(e.to, byId)})`).join("; ")}. ` +
          `Pin \`dependencies: [{relation, id, version}]\` with the target's content_version to turn these into lineage.`,
        ``
      );
    }
  } else {
    md.push(`Each row is one person's recorded work resting on another's, pinned to an exact version.`, ``);
    md.push(`| built on | by | was used by | by | relation | |`, `|---|---|---|---|---|---|`);
    for (const e of r.reuse.cross_author) {
      md.push(
        `| ${clip(e.to_title, 70)} | ${esc(e.to_author)} | ${clip(e.from_title, 70)} | ${esc(e.from_author)} | \`${e.relation}\` | ${e.live ? `${link(e.to, byId)}` : `${link(e.to, byId)} **stale pin**`} |`
      );
    }
    md.push(``);
  }
  if (r.reuse.stale.length) {
    md.push(
      `${r.reuse.stale.length} pinned dependenc${r.reuse.stale.length === 1 ? "y" : "ies"} no longer match the target's current version. A stale pin still names exactly what was used, but the target has moved on: ${r.reuse.stale.slice(0, 5).map((e) => `${link(e.from, byId)} → ${link(e.to, byId)}`).join(", ")}.`,
      ``
    );
  }

  // 4. Activity in the period
  md.push(`## Recorded in the ${r.period_days} days to ${day(r.as_of)} (${r.period.recorded})`, ``);
  if (!r.period.by_author.length) {
    md.push(`_Nothing recorded in this window._`, ``);
  } else {
    md.push(`| person | definitions | findings | changes | decisions | total |`, `|---|---|---|---|---|---|`);
    for (const a of r.period.by_author)
      md.push(`| ${esc(a.author)} | ${a.definitions} | ${a.findings} | ${a.changes} | ${a.decisions} | **${a.total}** |`);
    md.push(``);
  }

  // 5. Gaps
  md.push(`## Gaps`, ``, `What this memory cannot yet back with lineage. Listed so the numbers above stay honest.`, ``);
  md.push(
    `* **${r.gaps.findings_without_pins.length}** finding${r.gaps.findings_without_pins.length === 1 ? "" : "s"} pin no definition or prior result, so their lineage cannot be traced` +
      (r.gaps.findings_without_pins.length ? `: ${r.gaps.findings_without_pins.slice(0, 5).map((f) => link(f.id, byId)).join(", ")}${r.gaps.findings_without_pins.length > 5 ? ", …" : ""}` : ``)
  );
  md.push(
    `* **${r.gaps.unresolved_names.length}** record${r.gaps.unresolved_names.length === 1 ? "" : "s"} name a dependency without pinning a version (a name is not lineage)` +
      (r.gaps.unresolved_names.length ? `: ${r.gaps.unresolved_names.slice(0, 5).map((x) => `${link(x.id, byId)} → ${x.names.slice(0, 3).map((n) => `\`${esc(n)}\``).join(", ")}`).join("; ")}` : ``)
  );
  md.push(`* **${r.gaps.unreproduced}** finding${r.gaps.unreproduced === 1 ? "" : "s"} nobody has re-run at the current version`);
  md.push(
    `* **${r.gaps.drafts.length}** draft${r.gaps.drafts.length === 1 ? "" : "s"} awaiting review` +
      (r.gaps.drafts.length ? `: ${r.gaps.drafts.slice(0, 5).map((d) => `${link(d.id, byId)} (${d.origin})`).join(", ")}${r.gaps.drafts.length > 5 ? ", …" : ""}` : ``)
  );
  md.push(``);

  return md.join("\n");
}
