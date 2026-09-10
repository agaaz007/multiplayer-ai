import fs from 'node:fs';
import path from 'node:path';
import { json, sha256 } from './analytical-contract.js';
import { summarizeBudget } from './sequence-budget.js';
import { executeSql } from './analytical-oracle.js';

/**
 * Label-normalized SQL comparison. The frozen grade compares rows byte-for-byte after numeric rounding;
 * the stage prompts fix column names, ordering and the fraction form, but not the exact text of categorical
 * values (e.g. the segment labels), so an answer that is numerically identical with "one-day user" instead of
 * "one-day" fails the frozen grade. This comparison lowercases, trims, drops a trailing " user(s)" and unifies
 * hyphenation before comparing, order-insensitively. It is reported alongside the strict result, never instead of it.
 */
const normCell = (v: unknown): unknown => typeof v === 'number' ? Math.round(v * 1e10) / 1e10
  : typeof v === 'string' ? v.toLowerCase().trim().replace(/\s+/g, ' ').replace(/\s+users?$/, '').replace(/repeat[\s_-]*window/, 'repeat-window').replace(/one[\s_-]*day/, 'one-day') : v;
const canonRows = (rows: unknown) => Array.isArray(rows) ? rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r as any).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k.toLowerCase(), normCell(v)])))).sort().join('\n') : null;
const oracleCache = new Map<string, any>();
function sqlNormalizedCheck(contentRoot: string, taskFile: string, oracleFile: string, stage: string, answer: any): { resultCorrectNormalized: boolean; holdoutsCorrectNormalized: boolean } | null {
  try {
    const key = taskFile + '|' + oracleFile;
    if (!oracleCache.has(key)) oracleCache.set(key, { task: readJson(path.join(contentRoot, taskFile)), oracles: readJson(path.join(contentRoot, oracleFile)) });
    const { task, oracles } = oracleCache.get(key);
    const st = task.stages.find((x: any) => x.stage === stage); const o = oracles.stages.find((x: any) => x.stage === stage)?.oracle;
    if (!st || !o || typeof answer?.sql !== 'string') return null;
    const actual = executeSql(st.task.data, answer.sql);
    const resultCorrectNormalized = canonRows(actual) === canonRows(executeSql(st.task.data, o.sql)) && canonRows(answer.result) === canonRows(actual);
    const holdoutsCorrectNormalized = o.holdouts.every((h: any) => canonRows(executeSql(h, answer.sql)) === canonRows(executeSql(h, o.sql)));
    return { resultCorrectNormalized, holdoutsCorrectNormalized };
  } catch { return null; }
}
const TASK_FILES: Record<string, { task: string; oracle?: string }> = { 'real-hiastro': { task: 'controller/analysis-sequence.json', oracle: 'controller/analysis-oracles.json' }, 'real-analysis-tab': { task: 'controller/coding-sequence.json' } };

/**
 * Aggregates one pilot root into report.json and report.md. It reads only controller-owned
 * evidence (sequence.json, per-stage answers, grades, MCP call logs, traces, captures) and
 * never re-runs an agent. Reuse is classified from evidence, not from self-report alone:
 *   - `retrieved`: the cited native ID appeared in a memory-tool result the recipient received;
 *   - `producedBy`: the earliest earlier stage whose memory-tool traffic or capture mentions the ID;
 *   - `passage`: what the recipient says it used, retained for the human substantive-use review.
 * A citation without retrieval evidence is reported as unverified, never as a pass.
 */
const STAGES = ['A', 'B', 'C', 'D'] as const;
type Stage = typeof STAGES[number];
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = (f: string) => fs.existsSync(f);
function mcpCalls(seqDir: string, stage: string): any[] { const f = path.join(seqDir, 'stages', stage, 'controller', 'mcp-calls.json'); return exists(f) ? readJson(f) : []; }
function captureText(rec: any): string { return JSON.stringify(rec?.capture ?? {}); }
/** Whitespace/comment/terminator-insensitive SQL identity for the provenance check; semantics are still judged by the oracle. */
const normalizeSql = (sql: unknown) => String(sql ?? '').toLowerCase().replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
function executedNormalized(seqDir: string, stage: string, answerSql: unknown): boolean {
  const f = path.join(seqDir, 'stages', stage, 'controller', 'trace.jsonl'); if (!exists(f) || !answerSql) return false;
  const want = normalizeSql(answerSql);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).some(l => { try { const e = JSON.parse(l); return e.operation === 'query_data' && e.detail?.success && normalizeSql(e.detail.sql) === want; } catch { return false; } });
}
function idsMentioned(text: string, id: string): boolean { return id.length >= 6 && text.includes(id); }
/** MCP results are JSON inside JSON: unescape any depth of `\\n` / `\\"` before collapsing whitespace. */
const flat = (text: unknown) => String(text ?? '').replace(/\\+n/g, ' ').replace(/\\+"/g, '"').replace(/\\+\//g, '/').replace(/\s+/g, ' ');
/** The stage's own Codex rollout (copied to the controller dir): hook-injected context such as Supermemory recall lives here, not in MCP traffic. */
function transcriptText(seqDir: string, stage: string): string {
  const dir = path.join(seqDir, 'stages', stage, 'controller'); if (!exists(dir)) return '';
  return fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

export function buildReport(root: string) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  const seqDirs = exists(path.join(root, 'sequences')) ? fs.readdirSync(path.join(root, 'sequences')).map(d => path.join(root, 'sequences', d)).filter(d => exists(path.join(d, 'sequence.json'))) : [];
  const sequences = seqDirs.map(dir => {
    const s = readJson(path.join(dir, 'sequence.json'));
    const stages: Record<string, any> = {};
    for (const stage of STAGES) {
      const r = s.stages[stage]; if (!r) { stages[stage] = { status: 'not-run' }; continue; }
      const calls = mcpCalls(dir, stage);
      const memory = calls.filter(c => c.server !== 'stage' || String(c.tool).startsWith('graphify_'));
      const answer = r.answer ?? null;
      const reuseClaims: any[] = Array.isArray(answer?.reuseEvidence) ? answer.reuseEvidence : [];
      const reuse = reuseClaims.map((claim: any) => {
        const id = String(claim?.sourceId ?? claim?.id ?? '').trim();
        const passage = typeof claim?.passage === 'string' ? claim.passage.replace(/\s+/g, ' ').trim() : '';
        const retrievedById = id ? memory.some(c => idsMentioned(String(c.result ?? ''), id)) : false;
        // A cited passage of substance that appears verbatim in a memory-tool result is retrieval evidence even when the agent used a logical label instead of the native ID.
        const retrievedByPassage = passage.length >= 40 ? memory.some(c => flat(c.result).includes(passage.slice(0, 160))) : false;
        const transcript = transcriptText(dir, stage);
        const seenInTranscript = (id ? idsMentioned(transcript, id) : false) || (passage.length >= 40 && flat(transcript).includes(passage.slice(0, 160)));
        const retrieved = retrievedById || retrievedByPassage || seenInTranscript;
        let producedBy: string | null = null;
        for (const earlier of STAGES) {
          if (earlier === stage) break;
          const er = s.stages[earlier]; if (!er) continue;
          const earlierCalls = mcpCalls(dir, earlier);
          const earlierText = earlierCalls.map(c => String(c.arguments ?? '') + String(c.result ?? '')).join('\n') + captureText(er) + JSON.stringify(er.answer ?? {});
          const byId = id ? idsMentioned(earlierText, id) : false;
          const byPassage = passage.length >= 40 && flat(earlierText).includes(passage.slice(0, 160));
          if (byId || byPassage) { producedBy = earlier; break; }
        }
        return { sourceId: id || null, contribution: claim?.contribution ?? null, passage: passage.slice(0, 600) || null,
          retrievedInThisStage: retrieved, retrievedById, retrievedByPassage, seenInTranscript, producedByStage: producedBy, verification: retrieved && producedBy ? 'retrieved-from-earlier-stage; substantive use requires review' : retrieved ? 'retrieved but origin stage not identified' : 'unverified citation' };
      });
      const grade = r.grade ?? null;
      stages[stage] = { status: r.failure ? 'failed' : r.run?.timedOut ? 'timed-out' : r.run?.completed ? 'completed' : 'incomplete', failure: r.failure ?? null,
        wallMs: r.run?.wallMs ?? null, usage: r.run?.usage ?? null, answerSubmitted: Boolean(r.answerSubmitted), commandExecutions: r.toolCalls?.commandExecutions ?? null,
        mcpCalls: r.toolCalls?.mcpCalls ?? null, memoryReads: r.toolCalls?.memoryReads ?? null, memoryWrites: r.toolCalls?.memoryWrites ?? null, queryDataCalls: r.queryDataCalls ?? null,
        compactions: r.toolCalls?.compactions ?? null, byServerTool: r.toolCalls?.byServerTool ?? null,
        correctness: grade?.schema === 'sequence-sql-grade/v1' ? (() => {
            const execNorm = grade.executed || executedNormalized(dir, stage, answer?.sql);
            const files = TASK_FILES[s.task]; const norm = (!grade.resultCorrect || !grade.holdoutsCorrect) && files?.oracle ? sqlNormalizedCheck(manifest.contentRoot, files.task, files.oracle, stage, answer) : null;
            const resultN = grade.resultCorrect || Boolean(norm?.resultCorrectNormalized); const holdN = grade.holdoutsCorrect || Boolean(norm?.holdoutsCorrectNormalized);
            return { kind: 'sql', executed: grade.executed, executedNormalized: execNorm, resultCorrect: grade.resultCorrect, holdoutsCorrect: grade.holdoutsCorrect, executableCompletion: grade.executableCompletion,
              resultCorrectNormalized: resultN, holdoutsCorrectNormalized: holdN, labelNormalizationApplied: Boolean(norm && (norm.resultCorrectNormalized || norm.holdoutsCorrectNormalized)),
              sqlCorrect: Boolean(grade.resultCorrect && grade.holdoutsCorrect), sqlCorrectNormalized: resultN && holdN, completionNormalized: Boolean(resultN && holdN && execNorm), error: grade.error ?? null }; })()
          : grade?.schema === 'sequence-coding-grade/v1' ? (() => {
            // Agents may commit their work (the Ledger resume flow encourages it), so `git status` undercounts; the retained patch against the baseline is authoritative.
            const patchFile = path.join(dir, 'stages', stage, 'controller', 'candidate.patch');
            const patchText = exists(patchFile) ? fs.readFileSync(patchFile, 'latin1') : '';
            const inputs = new Set<string>(Array.isArray(r.inputs) ? r.inputs : []);
            const patchFiles = [...new Set((patchText.match(/^diff --git a\/(.+?) b\//gm) ?? []).map(l => l.replace(/^diff --git a\//, '').replace(/ b\/$/, '')))].filter(f => !inputs.has(f));
            return { kind: 'coding', changedFiles: patchFiles.length, uncommittedFiles: grade.changedFileCount, patchFiles: patchFiles.slice(0, 60), patchBytes: grade.patchBytes, checks: grade.checks?.map((c: any) => ({ id: c.id, exitCode: c.exitCode, baselineExitCode: c.baselineExitCode, regressed: c.regressed, timedOut: c.timedOut })), featureCompletion: grade.featureCompletion }; })()
          : grade ? { kind: 'none', detail: grade } : null,
        // Stage A has no predecessor: its citations are self-references to what it just saved and never count as reuse.
        capture: summarizeCapture(r.capture), reuseClaims: stage === 'A' ? reuse.map(x => ({ ...x, verification: 'self-reference (stage A)' })) : reuse,
        reuseVerified: stage === 'A' ? 0 : reuse.filter(x => x.retrievedInThisStage && x.producedByStage).length,
        distinctEarlierStagesRetrieved: stage === 'A' ? [] : [...new Set(reuse.filter(x => x.retrievedInThisStage && x.producedByStage).map(x => x.producedByStage))],
        affectedClaimed: Array.isArray(answer?.affected) ? answer.affected.length : null, conclusion: typeof answer?.conclusion === 'string' ? answer.conclusion.slice(0, 1200) : null };
    }
    const c = stages.C, d = stages.D;
    const cumulative = { cCorrect: c?.correctness?.kind === 'sql' ? c.correctness.completionNormalized : null, cCorrectStrict: c?.correctness?.kind === 'sql' ? c.correctness.executableCompletion : null, cUsesAandB: Boolean(c?.distinctEarlierStagesRetrieved?.includes('A') && c?.distinctEarlierStagesRetrieved?.includes('B')),
      dCorrect: d?.correctness?.kind === 'sql' ? d.correctness.completionNormalized : null, dCorrectStrict: d?.correctness?.kind === 'sql' ? d.correctness.executableCompletion : null, dUsesC: Boolean(d?.distinctEarlierStagesRetrieved?.includes('C')),
      allStagesCompleted: STAGES.every(st => stages[st]?.status === 'completed'), allAnswers: STAGES.every(st => stages[st]?.answerSubmitted),
      note: 'Central criterion per the protocol: C correct using verified A and B contributions, D correct using C; retrieval evidence is automated, substantive use and reconstruction annotation require the frozen human review.' };
    return { dir, task: s.task, arm: s.arm, namespace: s.namespace, startedAt: s.startedAt, endedAt: s.endedAt ?? null, failures: s.failures, cleanup: s.cleanup, stages, cumulative,
      totals: { wallMs: STAGES.reduce((n, st) => n + (stages[st]?.wallMs ?? 0), 0), inputTokens: STAGES.reduce((n, st) => n + (stages[st]?.usage?.input_tokens ?? 0), 0), outputTokens: STAGES.reduce((n, st) => n + (stages[st]?.usage?.output_tokens ?? 0), 0),
        mcpCalls: STAGES.reduce((n, st) => n + (stages[st]?.mcpCalls ?? 0), 0), commandExecutions: STAGES.reduce((n, st) => n + (stages[st]?.commandExecutions ?? 0), 0), queryDataCalls: STAGES.reduce((n, st) => n + (stages[st]?.queryDataCalls ?? 0), 0) } };
  });
  const report = { schema: 'sequence-pilot-report/v1', generatedAt: new Date().toISOString(), root, manifestSha256: sha256(fs.readFileSync(path.join(root, 'manifest.json'))),
    limits: manifest.limits, arms: manifest.arms, tasks: manifest.tasks, fairnessNotes: manifest.fairnessNotes, budget: summarizeBudget(path.join(root, 'budget.json')), sequences,
    scope: ['Exploratory: one sequence per product per task plus one fresh-agent control per task; no repetitions, no statistical claim.',
      'Simulated users on one laptop; no cross-account permission or cross-laptop delivery claim.',
      'SQL correctness is scored by the frozen oracle (strict values retained). The report additionally shows two disclosed normalizations: executed-SQL provenance matched after whitespace/comment/terminator normalization, and categorical labels compared after lowercasing and dropping a trailing " user(s)" (the prompts fix columns, ordering and the fraction form, not label text). Coding stages carry compatibility checks and exact patches only; feature completion is not evaluated here.',
      'Reuse: automated retrieval evidence only; substantive use, repeated work and repeated mistakes need the frozen human review of traces.',
      'Human active minutes were not observed for agent stages and are reported as unknown; controller setup/repair time is in the session record, not in these numbers.'] };
  fs.writeFileSync(path.join(root, 'report.json'), json(report));
  fs.writeFileSync(path.join(root, 'report.md'), renderMarkdown(report));
  return report;
}
function summarizeCapture(c: any) {
  if (!c) return null;
  if (c.ledger) return { arm: 'ledger', events: c.ledger.sessions?.reduce((n: number, s: any) => n + (s.eventCount ?? 0), 0) ?? 0, snapshot: c.ledger.snapshot ? { ref: c.ledger.snapshot.ref, commit: c.ledger.snapshot.commit?.slice(0, 12) } : null, error: c.error ?? null };
  if (c.supermemory) return { arm: 'supermemory', documents: c.supermemory.documents?.length ?? 0, processingComplete: c.supermemory.processingComplete, waitedMs: c.supermemory.waitedMs, error: c.error ?? null };
  if (c.gbrain) return { arm: 'gbrain', pages: Array.isArray(c.gbrain.pages) ? c.gbrain.pages.length : null, embedCoverage: c.gbrain.healthAfter?.embed_coverage ?? c.gbrain.healthBefore?.embed_coverage ?? null, embedRun: c.gbrain.embedRun ?? null, error: c.error ?? null };
  if (c.graphify) return { arm: 'graphify', sources: c.graphify.sources, agentExtracted: c.graphify.agentExtracted, controllerExtraction: c.graphify.controllerExtraction ?? null, graphCurrentAfterAgent: c.graphify.graphCurrentAfterAgent, error: c.error ?? null };
  return { arm: c.arm, error: c.error ?? null };
}
function renderMarkdown(r: any): string {
  const L: string[] = [];
  L.push(`# Cumulative-work pilot report (${r.generatedAt.slice(0, 10)})`, '');
  L.push(`Model ${r.limits.model}, stage limit ${Math.round(r.limits.stageTimeoutMs / 60000)} min, allowance $${r.limits.maximumApprovedUsd}. Budget committed (upper bound) $${r.budget.committedUsd.toFixed(2)}; subscription tokens in/out ${r.budget.subscriptionTokens.input}/${r.budget.subscriptionTokens.output}.`, '');
  for (const task of r.tasks) {
    L.push(`## ${task}`, '');
    const rows = r.sequences.filter((s: any) => s.task === task);
    L.push('| Arm | A | B | C | D | C uses A+B | D uses C | Sequence complete | Wall min | Query calls | MCP calls |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of rows) {
      const cell = (st: string) => { const x = s.stages[st]; if (!x || x.status === 'not-run') return 'not run';
        const corr = x.correctness?.kind === 'sql' ? (x.correctness.executableCompletion ? 'SQL pass' : x.correctness.completionNormalized ? `SQL pass (${[x.correctness.labelNormalizationApplied ? 'label' : '', !x.correctness.executed ? 'whitespace' : ''].filter(Boolean).join('+')}-normalized)` : x.correctness.sqlCorrectNormalized ? 'rows correct, executed SQL not matched' : 'SQL fail') : x.correctness?.kind === 'coding' ? `${x.correctness.changedFiles} files${x.correctness.checks?.some((c: any) => c.regressed) ? ', regression' : ''}` : '';
        return `${x.status}${x.answerSubmitted ? '' : ', no answer'}${corr ? '; ' + corr : ''}${x.reuseVerified ? `; reuse ${x.reuseVerified}` : ''}`; };
      L.push(`| ${s.arm} | ${cell('A')} | ${cell('B')} | ${cell('C')} | ${cell('D')} | ${s.cumulative.cUsesAandB ? 'yes' : 'no'} | ${s.cumulative.dUsesC ? 'yes' : 'no'} | ${s.cumulative.allStagesCompleted && s.cumulative.allAnswers ? 'yes' : 'no'} | ${(s.totals.wallMs / 60000).toFixed(1)} | ${s.totals.queryDataCalls} | ${s.totals.mcpCalls} |`);
    }
    L.push('');
    for (const s of rows) {
      if (s.failures.length) L.push(`- ${s.arm} failures: ${s.failures.map((f: string) => f.slice(0, 200)).join(' | ')}`);
      for (const st of STAGES) { const x = s.stages[st]; if (st === 'A' || !x?.reuseClaims?.length) continue;
        L.push(`- ${s.arm} ${st} reuse claims: ${x.reuseClaims.map((c: any) => `${c.sourceId ?? '?'} (${c.producedByStage ?? 'origin unknown'}; ${c.retrievedInThisStage ? 'retrieved' : 'not retrieved'})`).join('; ')}`); }
    }
    L.push('');
  }
  L.push('## Scope', '', ...r.scope.map((x: string) => `- ${x}`), '', '## Fairness notes', '', ...r.fairnessNotes.map((x: string) => `- ${x}`), '');
  return L.join('\n');
}
