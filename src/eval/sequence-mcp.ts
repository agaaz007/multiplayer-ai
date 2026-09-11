import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { graphifyStore } from './analytical-graphify.js';
import { executeSql } from './analytical-oracle.js';
import { TaskSchema, sha256, exclusiveJson, ownedPath, type AdapterContext } from './analytical-contract.js';

/**
 * The per-stage task tool server for the four-stage pilot. It is identical for every
 * arm: query_data over the frozen rows, read_artifact, and one submit_answer. The
 * Graphify arm additionally receives the scoped CLI bridge (write source, extract,
 * query, affected, explain, path, read source, save-result, reflect), which is that
 * product's declared native workflow rather than automatic capture.
 *
 * The server runs OUTSIDE the task agent's seatbelt (the controller spawns it and the
 * agent reaches it through a stdio bridge), so the stage task file, trace and answer
 * stay in controller-owned directories and provider credentials never enter the sandbox.
 */
export interface StageToolConfig {
  stageDir: string; taskFile: string; traceFile: string; answerDir: string; stage: 'A' | 'B' | 'C' | 'D';
  arm: string; namespace: string; graphify?: { root: string; binary: string; version: string; backend: 'claude' | 'openai'; model: string;
    maxOutputTokens?: number; maxRetries?: number; apiTimeoutSeconds?: number; allowPaidOperations: boolean };
}
export async function serveStageTools(configPath: string): Promise<void> {
  const cfg: StageToolConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const task = TaskSchema.parse(JSON.parse(fs.readFileSync(cfg.taskFile, 'utf8')));
  const trace = (operation: string, detail: unknown) => fs.appendFileSync(cfg.traceFile,
    JSON.stringify({ at: new Date().toISOString(), operation, stage: cfg.stage, detail }) + '\n', { mode: 0o600 });
  const server = new McpServer({ name: 'stage-tools', version: '1.0.0' });
  const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
  if (cfg.arm === 'graphify') {
    if (!cfg.graphify) throw new Error('Graphify arm requires its bridge configuration');
    const ctx: AdapterContext = { arm: 'graphify', root: cfg.graphify.root, namespace: cfg.namespace, task, mode: 'native', trace,
      allowExternalExport: true, allowPaidOperations: cfg.graphify.allowPaidOperations,
      graphify: { binary: cfg.graphify.binary, version: cfg.graphify.version, backend: cfg.graphify.backend, model: cfg.graphify.model,
        maxOutputTokens: cfg.graphify.maxOutputTokens, maxRetries: cfg.graphify.maxRetries, apiTimeoutSeconds: cfg.graphify.apiTimeoutSeconds } };
    const graph = graphifyStore(ctx);
    server.registerTool('graphify_write_source', { description: 'Save your working notes, exact queries, code or artifacts as a new file in the team Graphify corpus (filename must be simple, e.g. notes-stage.md). Explicit capture; nothing is captured automatically.',
      inputSchema: { filename: z.string(), content: z.string().max(1_000_000) } }, async a => result(graph.write(a.filename, a.content)));
    server.registerTool('graphify_extract', { description: 'Run official Graphify semantic extraction over the saved corpus so later queries can find new sources. Run after saving sources.', inputSchema: {} }, async () => { graph.extract(); return result({ extracted: true }); });
    server.registerTool('graphify_query', { description: 'Official Graphify graph query over the team corpus.', inputSchema: { query: z.string().min(1).max(2000), budget: z.number().int().min(100).max(10000).default(2000) } }, async a => result(graph.query(a.query, a.budget)));
    server.registerTool('graphify_affected', { description: 'Official Graphify reverse dependency traversal.', inputSchema: { node: z.string(), depth: z.number().int().min(1).max(10).default(3) } }, async a => result(graph.affected(a.node, a.depth)));
    server.registerTool('graphify_explain', { description: 'Official Graphify node evidence and relationships.', inputSchema: { node: z.string() } }, async a => result(graph.explain(a.node)));
    server.registerTool('graphify_path', { description: 'Official Graphify path between two nodes.', inputSchema: { from: z.string(), to: z.string() } }, async a => result(graph.shortestPath(a.from, a.to)));
    server.registerTool('graphify_list_sources', { description: 'List source files saved in the team Graphify corpus.', inputSchema: {} }, async () => result(graph.sources()));
    server.registerTool('graphify_read_source', { description: 'Read a source file from the team Graphify corpus by id (relative filename).', inputSchema: { id: z.string() } }, async a => result(graph.source(a.id)));
    server.registerTool('graphify_save_result', { description: 'Official Graphify save-result feedback (useful / dead_end / corrected).', inputSchema: { question: z.string().max(4000), answer: z.string().max(100000), outcome: z.enum(['useful', 'dead_end', 'corrected']), correction: z.string().max(100000).optional(), nodes: z.array(z.string()).default([]) } }, async a => result(graph.save(a)));
    server.registerTool('graphify_reflect', { description: 'Official Graphify reflection over saved feedback.', inputSchema: {} }, async () => result(graph.reflect()));
  }
  server.registerTool('read_artifact', { description: 'Read a permitted task artifact by ID.', inputSchema: { id: z.string().min(1) } }, async args => {
    const file = task.artifacts.find(a => a.id === args.id);
    if (!file) throw new Error('artifact unavailable');
    trace('read_artifact', { id: file.id, hash: sha256(file.content) }); return result(file);
  });
  if (task.kind === 'corrected-analysis') server.registerTool('query_data', { description: `Execute one read-only SQLite query against the frozen HiAstro events table (one row per user-day). Columns: ${[...new Set(task.data?.flatMap(row => Object.keys(row)) ?? [])].join(', ')}. Results are capped at 500 rows.`,
    inputSchema: { sql: z.string().min(1).max(40_000) } }, async args => {
      try { const rows = executeSql(task.data, args.sql); trace('query_data', { sql: args.sql, sqlHash: sha256(args.sql), success: true, rows }); return result(rows); }
      catch (e) { trace('query_data', { sql: args.sql, sqlHash: sha256(args.sql), success: false, error: e instanceof Error ? e.message : 'failed' }); throw e; }
    });
  server.registerTool('submit_answer', { description: 'Submit your final answer exactly once, after saving your work through the configured product. Analysis: {sql, result, definitionId, evidenceIds, affected, conclusion, reuseEvidence}. Coding: {conclusion, evidenceIds, changedFiles, checks, unfinishedWork, affected, reuseEvidence}. reuseEvidence is a list of {sourceId, contribution, passage} naming the real native record/document/page/source IDs you actually retrieved.',
    inputSchema: { answer: z.record(z.string(), z.unknown()) } }, async args => {
      const file = ownedPath(cfg.answerDir, 'answer.json');
      if (fs.existsSync(file)) throw new Error('answer already submitted for this stage');
      exclusiveJson(file, args.answer); trace('submit_answer', { hash: sha256(JSON.stringify(args.answer)) }); return result({ saved: true });
    });
  await server.connect(new StdioServerTransport());
}
