import Supermemory from 'supermemory';
import { assertNamespace, type AdapterContext } from './analytical-contract.js';

/** SDK transport never follows redirects or logs request bodies/credentials. */
export function supermemoryClient(key: string, request: typeof fetch = fetch, trace?: AdapterContext['trace']) {
  return new Supermemory({ apiKey: key, baseURL: 'https://api.supermemory.ai', timeout: 30_000,
    maxRetries: 0, logLevel: 'off', fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.supermemory.ai') throw new Error('Supermemory endpoint outside official API');
      const response = await request(input, { ...init, redirect: 'error' });
      trace?.('http', { route: url.pathname, method: init?.method, status: response.status });
      return response;
    } });
}
export async function createTrialSupermemoryKey(namespace: string, request: typeof fetch = fetch) {
  assertNamespace(namespace);
  const master = process.env.SUPERMEMORY_API_KEY;
  if (!master) throw new Error('SUPERMEMORY_API_KEY missing from controller environment');
  const client = supermemoryClient(master, request);
  let result: any;
  try { result = await client.post('/v3/auth/scoped-key', { body: { containerTag: namespace,
    name: namespace, expiresInDays: 1 } }); }
  catch { throw new Error('Supermemory scoped-key creation failed; no agent launched'); }
  if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(result.id) || typeof result.key !== 'string'
      || !result.key || result.containerTag !== namespace) throw new Error('Supermemory scoped-key response invalid; reconcile key creation in console');
  return { key: result.key as string, id: result.id as string, namespace,
    async revoke() {
      try { await client.delete(`/v3/auth/scoped-key/${encodeURIComponent(result.id)}`); }
      catch { throw new Error('Supermemory scoped-key revocation failed; revoke retained key ID in console'); }
    } };
}

/** Exercise only synthetic out-of-trial identifiers; never read another real container. */
export async function verifySupermemoryScope(client: Supermemory, namespace: string) {
  assertNamespace(namespace);
  const deniedTag = `${namespace}_denied`;
  for (const route of ['/v4/search', '/v4/profile']) {
    let denied = false;
    try { await client.post(route, { body: { containerTag: deniedTag, ...(route === '/v4/search' ? { q: 'isolation probe' } : {}) } }); }
    catch (e) { denied = e instanceof Supermemory.APIError && e.status === 403; }
    if (!denied) throw new Error(`Supermemory isolation unverified on ${route}; expected explicit 403 for synthetic foreign tag`);
  }
  // Live two-container canaries established that list ignores the singular
  // filter but projects documents through the scoped key. A 200 is safe only
  // when its shape and every returned document remain inside the key's scope.
  // The adapter separately validates all pages of the positive inventory.
  try {
    const listed: any = await client.post('/v3/documents/list', { body: { containerTag: deniedTag, page: 1, limit: 100 } });
    if (!Array.isArray(listed.memories) || !Number.isInteger(listed.pagination?.totalItems)
      || listed.pagination.totalItems < 0 || !Number.isInteger(listed.pagination?.totalPages)
      || listed.pagination.totalPages < 0 || listed.memories.length !== Math.min(100, listed.pagination.totalItems)) {
      throw new Error('Supermemory scoped-list projection has unverified pagination');
    }
    for (const doc of listed.memories) {
      const tags = doc.containerTags ?? (doc.containerTag ? [doc.containerTag] : []);
      if (!Array.isArray(tags) || tags.length !== 1 || tags[0] !== namespace) throw new Error('Supermemory scoped-list projection escaped its container');
    }
  } catch (e) {
    if (!(e instanceof Supermemory.APIError && e.status === 403)) throw e;
  }
  // An invalid key must not pass merely because all negative requests failed.
  await client.profile({ containerTag: namespace });
  await client.search({ containerTag: namespace, q: 'readiness probe', searchMode: 'hybrid', limit: 1 });
}
