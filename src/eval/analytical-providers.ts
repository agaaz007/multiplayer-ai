import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { readGbrainEmbeddingKey } from './analytical-credentials.js';
import { supermemoryClient, verifySupermemoryScope } from './analytical-supermemory.js';
import { createGraphifyAdapter } from './analytical-graphify.js';
import { search as ledgerSearch } from '../query.js';
import { getById, loadAll, type Config } from '../store.js';
import { DIRS } from '../schema.js';
import { assertNamespace, evidenceText, exclusiveJson, json, ownedPath, sha256,
  type AdapterContext, type ProviderAdapter, type Readiness } from './analytical-contract.js';

function requireDiagnostic(ctx: AdapterContext) {
  if (ctx.mode !== 'evidence-parity-diagnostic') throw new Error('native capture forbids controller evidence ingestion');
}
function safeRoot(ctx: AdapterContext): string {
  assertNamespace(ctx.namespace);
  if (!path.isAbsolute(ctx.root) || path.resolve(ctx.root) === os.homedir()) throw new Error('unsafe trial root');
  const marker = ownedPath(ctx.root, 'ownership.json');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (owner.namespace !== ctx.namespace) throw new Error('trial ownership mismatch');
  return ctx.root;
}
function sourceId(id: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(id)) throw new Error('invalid source ID'); return id; }
function recordError(ctx: AdapterContext, op: string, error: unknown): never {
  // Provider errors can contain credentials, request content or response URLs. Keep only classification.
  ctx.trace(op, { failed: true, errorType: error instanceof Error ? error.name : 'unknown' });
  throw new Error(`${ctx.arm} ${op} failed; inspect scoped trace status`);
}

export function createLocalAdapter(ctx: AdapterContext): ProviderAdapter {
  const root = safeRoot(ctx);
  const storeRoot = ownedPath(root, ctx.arm === 'ledger' ? 'ledger' : 'documents');
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  const cfg: Config = { ledger_dir: storeRoot, author: 'evaluation-fixture', git_sync: false };
  const documents = () => fs.readdirSync(storeRoot).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(ownedPath(storeRoot, f), 'utf8')));
  return {
    async check() { return { ready: true, provider: ctx.arm, checks: { namespace: ctx.namespace, isolatedLocalStore: true,
      capture: ctx.mode === 'native' ? 'requires native agent/hook writes; controller import disabled' : 'diagnostic neutral source import' } }; },
    async ingest() {
      requireDiagnostic(ctx);
      for (const e of ctx.task.evidence) {
        if (ctx.arm === 'ledger') {
          const type = e.kind === 'artifact' ? 'finding' : e.kind;
          const dir = path.join(storeRoot, DIRS[type]); fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(ownedPath(dir, `${e.id}.md`), matter.stringify(evidenceText(e), { id: e.id, type,
            title: e.title, author: e.author, created: e.recordedAt, tags: Object.values(e.scope),
            status: e.status === 'proposed' ? 'draft' : e.status === 'superseded' ? 'deprecated' : 'stable' }), { flag: 'wx', mode: 0o600 });
        } else exclusiveJson(ownedPath(storeRoot, `${e.id}.json`), { id: e.id, content: evidenceText(e) });
      }
      ctx.trace('ingest', { documents: ctx.task.evidence.length, mode: ctx.mode });
    },
    async inventory() { return ctx.arm === 'ledger' ? loadAll(cfg).map(x => ({ id: x.id, status: x.status })) : documents().map(x => ({ id: x.id })); },
    async search(query, limit) {
      let output: unknown;
      if (ctx.arm === 'ledger') output = ledgerSearch(cfg, query, { limit, includeSuperseded: true }).map(x => ({ id: x.id, title: x.title, status: x.status, content: x.body, score: x.score }));
      else {
        const words = query.toLowerCase().split(/\W+/).filter(Boolean);
        output = documents().map(x => ({ ...x, score: words.filter(w => x.content.toLowerCase().includes(w)).length }))
          .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
      }
      ctx.trace('search', { query, limit, output }); return output;
    },
    async read(id) {
      sourceId(id);
      const output = ctx.arm === 'ledger' ? getById(cfg, id) : documents().find(x => x.id === id) ?? null;
      if (!output) throw new Error('source not found in this trial');
      ctx.trace('read', { id, output }); return output;
    },
  };
}

export function gbrainEnvironment(root: string, allowPaid: boolean, credentialFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: path.join(root, 'gbrain-home'), LEDGER_EVAL: '1' };
  if (allowPaid) for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) if (process.env[key]) env[key] = process.env[key];
  if (allowPaid && credentialFile) env.OPENAI_API_KEY = readGbrainEmbeddingKey(credentialFile);
  for (const key of Object.keys(env)) if (/^GBRAIN|^DATABASE_URL$|^SUPABASE|^PG|^XDG_CONFIG_HOME$|^BRAIN_/i.test(key)) delete env[key];
  if (!allowPaid) for (const key of Object.keys(env)) if (/API_KEY|API_TOKEN|AUTH_TOKEN/.test(key)) delete env[key];
  return env;
}
export function createGbrainAdapter(ctx: AdapterContext): ProviderAdapter {
  const root = safeRoot(ctx); const env = gbrainEnvironment(root, ctx.allowPaidOperations, ctx.gbrainCredentialFile);
  const home = String(env.HOME); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const bin = process.env.ANALYTICAL_GBRAIN_BIN || 'gbrain';
  function call(args: string[], input?: string, timeout = 60_000): string {
    try { return execFileSync(bin, args, { input, env, cwd: root, timeout, maxBuffer: 20 << 20, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
    catch (e) { return recordError(ctx, args[0], e); }
  }
  function assertBrain() {
    const cfg = JSON.parse(fs.readFileSync(ownedPath(home, '.gbrain/config.json'), 'utf8'));
    if (cfg.engine !== 'pglite' || typeof cfg.database_path !== 'string' || !path.resolve(cfg.database_path).startsWith(home + path.sep)) throw new Error('GBrain escaped trial PGLite home');
  }
  function tool(name: string, args: unknown) {
    assertBrain(); const text = call(['call', name, JSON.stringify(args)]);
    let output; try { output = JSON.parse(text); } catch { throw new Error(`GBrain ${name} returned non-JSON`); }
    ctx.trace(name, { args, output }); return output;
  }
  return {
    async check() {
      let version = 'unavailable'; try { version = call(['version']).trim(); } catch { /* readiness below */ }
      const config = path.join(home, '.gbrain', 'config.json');
      const checks: Readiness['checks'] = { binary: version !== 'unavailable', version, isolatedHome: home,
        initialized: fs.existsSync(config), embeddingCredentialPresent: Boolean(env.OPENAI_API_KEY),
        embeddingModel: 'text-embedding-3-large', embeddingDimensions: '1536', paidOperationsAllowed: ctx.allowPaidOperations, nativeCapture: 'agent-authored pages via native MCP; no installed automatic coding-session recipe detected' };
      checks.pinnedVersion = /(?:^|\s)0\.18\.2(?:$|\s)/.test(version);
      let indexReady = true;
      if (fs.existsSync(config)) {
        assertBrain(); const health = tool('get_health', {}); checks.health = JSON.stringify(health);
        indexReady = health.page_count === 0 || (health.embed_coverage === 1 && health.missing_embeddings === 0);
        checks.embeddingCoverageComplete = indexReady;
      }
      return { provider: 'gbrain', ready: checks.pinnedVersion === true && Boolean(env.OPENAI_API_KEY) && ctx.allowPaidOperations && indexReady,
        checks, reason: !checks.pinnedVersion ? 'GBrain version must match pinned 0.18.2' : !env.OPENAI_API_KEY ? 'hybrid embeddings unavailable: OPENAI_API_KEY missing; keyword-only is not a configured competitive arm' : undefined };
    },
    async ingest() {
      requireDiagnostic(ctx);
      if (!ctx.allowPaidOperations) throw new Error('GBrain indexing/embeddings require explicit paid-operation authorization');
      if (fs.existsSync(path.join(home, '.gbrain', 'config.json'))) throw new Error('refusing to reuse existing GBrain store');
      call(['init', '--pglite']); assertBrain();
      for (const e of ctx.task.evidence) call(['put', e.id], matter.stringify(evidenceText(e), { title: e.title, type: 'event', tags: Object.values(e.scope) }));
      call(['embed', '--all'], undefined, 300_000);
      const health = tool('get_health', {});
      ctx.trace('embedding-health', { output: health });
      if (health.embed_coverage !== 1 || health.missing_embeddings !== 0) throw new Error('GBrain embeddings incomplete; cannot launch a hybrid comparison');
    },
    async inventory() {
      if (ctx.mode === 'native' && !fs.existsSync(path.join(home, '.gbrain', 'config.json'))) { call(['init', '--pglite']); assertBrain(); }
      // Installed list_pages returns slug (not id) and clamps to 100; it has no
      // pagination contract. A truncated capture inventory must remain a failure.
      const pages = tool('list_pages', { limit: 100 });
      const health = tool('get_health', {});
      if (!Array.isArray(pages) || (typeof health.page_count === 'number' && health.page_count > pages.length)) throw new Error('GBrain source inventory is incomplete; installed list_pages is capped at 100');
      return pages.map((page: any) => ({ ...page, id: page.slug }));
    },
    async search(query, limit) { return tool('query', { query, limit, expand: true }); },
    async verifyRetrieval(marker) {
      const health = tool('get_health', {});
      if (health.embed_coverage !== 1 || health.missing_embeddings !== 0) throw new Error('GBrain embedding coverage incomplete');
      if (!JSON.stringify(tool('query', { query: marker, limit: 10, expand: true })).includes(marker)) throw new Error('GBrain native hybrid recall probe failed');
    },
    async read(id) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,511}$/.test(id) || id.split('/').includes('..')) throw new Error('invalid GBrain source slug');
      return tool('get_page', { slug: id, fuzzy: false });
    },
  };
}

export function createSupermemoryAdapter(ctx: AdapterContext, request: typeof fetch = fetch, scopedKey?: string): ProviderAdapter {
  safeRoot(ctx);
  const key = scopedKey ?? process.env.SUPERMEMORY_API_KEY;
  const mappingPath = ownedPath(ctx.root, 'supermemory-map.json');
  const mapping: Record<string, string> = fs.existsSync(mappingPath) ? JSON.parse(fs.readFileSync(mappingPath, 'utf8')) : {};
  const client = key ? supermemoryClient(key, request, ctx.trace) : undefined;
  async function api(route: string, method: string, body?: any): Promise<any> {
    if (!client) throw new Error('Supermemory credential missing');
    if (!ctx.allowExternalExport || !ctx.task.provenance.externalExportAllowed) throw new Error('external evidence permission not enabled for this task');
    try {
      if (route === '/v3/documents') return await client.add(body);
      if (route === '/v4/search') return await client.search(body);
      if (route === '/v4/profile') return await client.profile(body);
      if (method === 'GET') return await client.documents.get(decodeURIComponent(route.split('/').at(-1)!));
      // List ignores the singular filter, but scoped keys project permitted
      // documents. Live canaries verified this; validate every returned page.
      // Keep singular requests through the SDK extension API; no plural fallback.
      return await client.post(route, { body });
    } catch { throw new Error(`Supermemory ${route} failed; no unscoped/plural fallback performed`); }
  }
  async function inventory() {
    const items: any[] = []; const seen = new Set<string>(); let expected: number | undefined;
    for (let page = 1; page <= 10_000; page++) {
      const result = await api('/v3/documents/list', 'POST', { containerTag: ctx.namespace, limit: 100, page, includeContent: false });
      const total = result.pagination?.totalItems; const pages = result.pagination?.totalPages;
      if (!Number.isInteger(total) || total < 0 || !Number.isInteger(pages) || pages < 0 || !Array.isArray(result.memories)) throw new Error('Supermemory inventory pagination unverified');
      if (expected !== undefined && expected !== total) throw new Error('Supermemory inventory changed during pagination; retry after capture settles');
      expected = total;
      for (const item of result.memories) {
        ownDocument(item);
        if (typeof item.id !== 'string' || seen.has(item.id)) throw new Error('Supermemory inventory duplicate/missing ID');
        seen.add(item.id); items.push(item);
      }
      if (page >= pages) {
        if (items.length !== total) throw new Error('Supermemory inventory incomplete');
        return items;
      }
    }
    throw new Error('Supermemory inventory exceeds bounded pagination');
  }
  function ownDocument(doc: any) {
    const tags = doc.containerTags ?? (doc.containerTag ? [doc.containerTag] : []);
    if (!Array.isArray(tags) || tags.length !== 1 || tags[0] !== ctx.namespace) throw new Error('Supermemory document outside trial container');
    if (ctx.mode === 'evidence-parity-diagnostic' && doc.metadata?.trial !== ctx.namespace) throw new Error('Supermemory source metadata outside trial');
    return doc;
  }
  async function document(id: string) { return ownDocument(await api(`/v3/documents/${encodeURIComponent(sourceId(id))}`, 'GET')); }
  return {
    async check() {
      const checks: Readiness['checks'] = { credentialPresent: Boolean(key), namespace: ctx.namespace,
        externalExportAllowed: ctx.allowExternalExport && ctx.task.provenance.externalExportAllowed, paidOperationsAllowed: ctx.allowPaidOperations };
      if (!key || !checks.externalExportAllowed) return { provider: 'supermemory', ready: false, checks, reason: 'credential or external-export permission missing; no network request made' };
      try {
        await verifySupermemoryScope(client!, ctx.namespace); checks.scopeVerified = true;
        const documents = await inventory(); checks.authentication = true; checks.empty = documents.length === 0;
        checks.processingReady = documents.every(d => d.status === 'done');
        return { provider: 'supermemory', ready: checks.processingReady === true, checks,
          reason: checks.processingReady ? undefined : 'captured documents still processing or failed' };
      } catch { return { provider: 'supermemory', ready: false, checks,
        reason: 'scoped credential, singular-tag inventory or processing readiness unverified; no agent may launch' }; }
    },
    async ingest() {
      requireDiagnostic(ctx);
      if (!ctx.allowPaidOperations) throw new Error('Supermemory processing requires explicit paid-operation authorization');
      const before = await inventory();
      if (before.length !== 0 || Object.keys(mapping).length) throw new Error('trial container is not verifiably empty');
      for (const e of [...ctx.task.evidence].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
        const content = evidenceText(e);
        const added = await api('/v3/documents', 'POST', { content, containerTag: ctx.namespace,
          customId: `${ctx.namespace}_${sha256(e.id).slice(0, 24)}`, documentDate: e.recordedAt, taskType: 'memory', dreaming: 'instant',
          metadata: { trial: ctx.namespace, sourceId: e.id, sourceHash: sha256(content), scope: JSON.stringify(e.scope), status: e.status } });
        if (typeof added.id !== 'string') throw new Error('Supermemory add omitted document ID');
        mapping[e.id] = added.id; fs.writeFileSync(mappingPath, json(mapping), { mode: 0o600 });
        const deadline = Date.now() + 300_000;
        let done = false;
        while (Date.now() < deadline) {
          const doc = await document(added.id);
          if (doc.status === 'failed') throw new Error(`Supermemory processing failed for ${e.id}`);
          if (doc.status === 'done') {
            const original = typeof doc.raw === 'string' ? doc.raw : doc.content;
            if (typeof original !== 'string' || sha256(original) !== sha256(content)) throw new Error(`Supermemory source bytes changed for ${e.id}`);
            done = true; break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        if (!done) throw new Error(`Supermemory processing deadline exceeded for ${e.id}; retained document ID must be reconciled, not re-uploaded`);
      }
      ctx.trace('ingest', { documents: Object.keys(mapping).length, verifiedSourceBytes: true, mode: ctx.mode });
    },
    inventory,
    async verifyRetrieval(marker) {
      const result = await api('/v4/search', 'POST', { q: marker, containerTag: ctx.namespace, searchMode: 'hybrid', limit: 10, include: { documents: true } });
      if (!JSON.stringify(result).includes(marker)) throw new Error('Supermemory native recall probe not ready; no successor launched');
    },
    async profile(query) { return api('/v4/profile', 'POST', { containerTag: ctx.namespace, ...(query ? { q: query } : {}) }); },
    async search(query, limit) {
      const output = await api('/v4/search', 'POST', { q: query, containerTag: ctx.namespace, searchMode: 'hybrid', limit, include: { relatedMemories: true, documents: true } });
      // The request carries a mandatory namespace. Every cited document is fetched and scoped before delivery.
      for (const hit of output.results ?? []) {
        const ids = new Set<string>([...(hit.documents ?? []).map((x: any) => x.id), ...(hit.chunks ?? []).map((x: any) => x.documentId)].filter(Boolean));
        if (ids.size === 0) throw new Error('Supermemory result has no verifiable source document; cannot establish trial isolation');
        for (const id of ids) await document(id);
      }
      ctx.trace('search', { query, limit, output }); return output;
    },
    async read(id) {
      const output = await document(mapping[id] ?? id);
      ctx.trace('read', { id, output }); return output;
    },
  };
}
export function createProvider(ctx: AdapterContext, scopedKey?: string): ProviderAdapter {
  if (ctx.arm === 'supermemory') return createSupermemoryAdapter(ctx, fetch, scopedKey);
  if (ctx.arm === 'gbrain') return createGbrainAdapter(ctx);
  if (ctx.arm === 'graphify') return createGraphifyAdapter(ctx);
  if (ctx.arm === 'ledger' || ctx.arm === 'shared-doc') return createLocalAdapter(ctx);
  throw new Error('unsupported provider');
}

/** Separate synthetic store; never seed or alter the scored trial brain. */
export async function probeGbrainEmbeddings(ctx: AdapterContext) {
  if (!ctx.allowPaidOperations || !gbrainEnvironment(ctx.root, true, ctx.gbrainCredentialFile).OPENAI_API_KEY) throw new Error('GBrain embedding probe requires an embedding credential and explicit cost authorization');
  const probeRoot = ownedPath(ctx.root, 'embedding-probe'); fs.mkdirSync(probeRoot, { mode: 0o700 });
  exclusiveJson(path.join(probeRoot, 'ownership.json'), { namespace: ctx.namespace });
  const marker = 'GBRAIN_EMBEDDING_PROBE_' + sha256(ctx.namespace).slice(0, 20);
  const task = { ...ctx.task, evidence: [{ ...ctx.task.evidence[0], id: 'embedding-probe', title: 'Synthetic embedding readiness',
    content: marker + ' The silver otter stores acorns beside the river.', sourceRef: 'synthetic:readiness' }] };
  const probe = createGbrainAdapter({ ...ctx, root: probeRoot, mode: 'evidence-parity-diagnostic', task });
  await probe.ingest(); await probe.verifyRetrieval!(marker);
  return { embeddingModel: 'text-embedding-3-large', dimensions: 1536, hybridRecallVerified: true,
    scope: 'separate synthetic readiness brain; not scored evidence', probeRoot };
}
