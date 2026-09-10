import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNamespace, ownedPath, sha256, evidenceText, type AdapterContext, type ProviderAdapter } from './analytical-contract.js';

/** A scoped CLI transport. Extraction/query/feedback remain Graphify's own code. */
export function graphifyStore(ctx: AdapterContext) {
  assertNamespace(ctx.namespace);
  const owner = JSON.parse(fs.readFileSync(ownedPath(ctx.root, 'ownership.json'), 'utf8'));
  if (owner.namespace !== ctx.namespace) throw new Error('Graphify trial ownership mismatch');
  const root = ownedPath(ctx.root, 'graphify');
  const corpus = ownedPath(root, 'corpus'); const output = ownedPath(root, 'graphify-out');
  const home = ownedPath(root, 'home');
  for (const dir of [root, corpus, output, home]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const graph = ownedPath(output, 'graph.json'); const memory = ownedPath(corpus, 'memory');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', GRAPHIFY_OUT: 'graphify-out' };
  if(ctx.graphify?.maxOutputTokens!==undefined)env.GRAPHIFY_MAX_OUTPUT_TOKENS=String(ctx.graphify.maxOutputTokens);
  if(ctx.graphify?.maxRetries!==undefined)env.GRAPHIFY_MAX_RETRIES=String(ctx.graphify.maxRetries);
  if(ctx.graphify?.apiTimeoutSeconds!==undefined)env.GRAPHIFY_API_TIMEOUT=String(ctx.graphify.apiTimeoutSeconds);
  if (ctx.allowPaidOperations && ctx.allowExternalExport && ctx.task.provenance.externalExportAllowed && ctx.graphify) {
    const credential = ctx.graphify.backend === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (process.env[credential]) env[credential] = process.env[credential];
  }
  const binary = ctx.graphify?.binary ?? process.env.ANALYTICAL_GRAPHIFY_BIN ?? 'graphify';
  function call(args: string[], timeout = 60_000) {
    try {
      const text = execFileSync(binary, args, { cwd: root, env, timeout, maxBuffer: 20 << 20, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      ctx.trace('graphify-cli', { command: args[0], outputHash: sha256(text) }); return text;
    } catch { throw new Error(`Graphify ${args[0]} failed; no alternative engine used`); }
  }
  function sources() {
    const result: { id: string; hash: string }[] = [];
    function walk(dir: string) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = path.relative(corpus, path.join(dir, item.name));
        const file = ownedPath(corpus, relative);
        if (item.isDirectory()) walk(file);
        else if (item.isFile()) result.push({ id: relative.split(path.sep).join('/'), hash: sha256(fs.readFileSync(file)) });
        else throw new Error('Graphify corpus contains non-regular source');
      }
    }
    walk(corpus); return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  function source(id: string) {
    if (!sources().some(s => s.id === id)) throw new Error('Graphify source outside trial corpus');
    return { id, content: fs.readFileSync(ownedPath(corpus, id), 'utf8') };
  }
  function validateGraph() {
    const data = JSON.parse(fs.readFileSync(ownedPath(output, 'graph.json'), 'utf8'));
    if (!Array.isArray(data.nodes) || !Array.isArray(data.links ?? data.edges)) throw new Error('Graphify graph malformed');
    for (const node of data.nodes) if (node.source_file) {
      const file = ownedPath(corpus, node.source_file);
      if (!fs.existsSync(file)) throw new Error('Graphify graph source missing');
    }
    return data;
  }
  function extract(codeOnly = false) {
    if (!codeOnly && (!ctx.graphify || !ctx.allowPaidOperations || !ctx.allowExternalExport || !ctx.task.provenance.externalExportAllowed)) throw new Error('Graphify semantic extraction needs explicit backend/model, export and cost authorization');
    const args = ['extract', corpus, '--out', root];
    if (codeOnly) args.push('--code-only', '--no-cluster');
    else args.push('--backend', ctx.graphify!.backend, '--model', ctx.graphify!.model);
    call(args, 300_000); validateGraph();
    fs.writeFileSync(ownedPath(root, 'extraction.json'), JSON.stringify({ codeOnly, sources: sources(), graphHash: sha256(fs.readFileSync(graph)),
      backend: codeOnly ? null : ctx.graphify!.backend, model: codeOnly ? null : ctx.graphify!.model }), { mode: 0o600 });
  }
  function save(input: { question: string; answer: string; outcome: 'useful' | 'dead_end' | 'corrected'; correction?: string; nodes?: string[] }) {
    const args = ['save-result', '--question', input.question, '--answer', input.answer, '--outcome', input.outcome, '--memory-dir', memory];
    if (input.correction) args.push('--correction', input.correction);
    if (input.nodes?.length) args.push('--nodes', ...input.nodes);
    return call(args);
  }
  return { root, corpus, output, graph, sources, source, call, extract, save, validateGraph,
    write(id: string, content: string) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}\.(md|txt|sql|py|ts|js|json)$/.test(id)) throw new Error('source filename must be a simple supported filename');
      fs.writeFileSync(ownedPath(corpus, id), content, { flag: 'wx', mode: 0o600 });
      ctx.trace('graphify-source-save', { id, hash: sha256(content), author: 'source-agent' });
      return { id, hash: sha256(content) };
    },
    query(query: string, budget = 2000) { validateGraph(); return call(['query', query, '--graph', graph, '--budget', String(budget)]); },
    affected(node: string, depth = 3) { validateGraph(); return call(['affected', node, '--depth', String(depth), '--graph', graph]); },
    explain(node: string) { validateGraph(); return call(['explain', node, '--graph', graph]); },
    shortestPath(from: string, to: string) { validateGraph(); return call(['path', from, to, '--graph', graph]); },
    reflect() { validateGraph(); return call(['reflect', '--memory-dir', memory, '--out', ownedPath(output, 'LESSONS.md'), '--graph', graph]); },
  };
}
export function createGraphifyAdapter(ctx: AdapterContext): ProviderAdapter {
  const store = graphifyStore(ctx);
  return {
    async check() {
      const checks: Record<string, boolean | string> = { nativeCapture: 'source-agent files and official Graphify CLI extraction/save-result; no automatic transcript capture',
        isolatedCorpus: store.corpus, configured: Boolean(ctx.graphify), semanticReady: false };
      try { checks.version = store.call(['--version']).trim(); }
      catch { return { provider: 'graphify', ready: false, checks, reason: 'Graphify CLI unavailable' }; }
      if (!ctx.graphify || !String(checks.version).endsWith(ctx.graphify.version)) return { provider: 'graphify', ready: false, checks, reason: 'explicit Graphify version/backend/model required; no default model substitution' };
      const credential = ctx.graphify.backend === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      checks.embeddingCredentialPresent = Boolean(process.env[credential]);
      checks.externalExportAllowed = ctx.allowExternalExport && ctx.task.provenance.externalExportAllowed;
      if (!checks.embeddingCredentialPresent || !checks.externalExportAllowed || !ctx.allowPaidOperations) return { provider: 'graphify', ready: false, checks, reason: 'semantic extraction credential, export or cost authorization missing; AST-only is not analytical readiness' };
      if (store.sources().length) {
        try {
          store.validateGraph();
          const receipt = JSON.parse(fs.readFileSync(ownedPath(store.root, 'extraction.json'), 'utf8'));
          checks.semanticReady = receipt.codeOnly === false && receipt.backend === ctx.graphify.backend && receipt.model === ctx.graphify.model
            && JSON.stringify(receipt.sources) === JSON.stringify(store.sources()) && receipt.graphHash === sha256(fs.readFileSync(store.graph));
        } catch { checks.semanticReady = false; }
        if (!checks.semanticReady) return { provider: 'graphify', ready: false, checks, reason: 'captured corpus lacks current verified semantic extraction' };
      }
      return { provider: 'graphify', ready: true, checks };
    },
    async ingest() {
      if (ctx.mode !== 'evidence-parity-diagnostic') throw new Error('native capture forbids controller evidence ingestion');
      if (store.sources().length) throw new Error('Graphify diagnostic corpus not empty');
      for (const e of ctx.task.evidence) store.write(`${e.id}.md`, evidenceText(e));
      store.extract();
    },
    async inventory() { return store.sources(); },
    async read(id) { return store.source(id); },
    async search(query, limit) { return store.query(query, Math.min(10_000, Math.max(500, limit * 200))); },
    async verifyRetrieval(marker) {
      if (!store.query(marker, 3000).includes(marker)) throw new Error('Graphify capture marker not retrievable through native graph query');
    },
  };
}

/** Exercise semantic extraction outside the scored corpus; disclose probe costs. */
export async function probeGraphifySemantics(ctx: AdapterContext) {
  if (!ctx.graphify || !ctx.allowPaidOperations || !ctx.allowExternalExport || !ctx.task.provenance.externalExportAllowed) throw new Error('Graphify semantic probe requires explicit model, export and cost authorization');
  const root = ownedPath(ctx.root, 'semantic-probe'); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(ownedPath(root, 'ownership.json'), JSON.stringify({ namespace: ctx.namespace }), { flag: 'wx', mode: 0o600 });
  const store = graphifyStore({ ...ctx, root });
  store.write('readiness.md', '# Silver otter\n\nThe silver otter stores acorns beside the river. The river contains freshwater. This is synthetic readiness evidence.\n');
  store.extract();
  const output = store.query('silver otter');
  if (!output.toLowerCase().includes('otter')) throw new Error('Graphify semantic readiness query did not retrieve the synthetic concept');
  return { backend: ctx.graphify.backend, model: ctx.graphify.model, semanticRecallVerified: true, probeRoot: root,
    graphHash: sha256(fs.readFileSync(store.graph)), scope: 'separate synthetic readiness graph; not scored evidence' };
}
