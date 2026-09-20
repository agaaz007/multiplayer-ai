import assert from 'node:assert/strict';
import type pg from 'pg';
import { availableSection, boundedRead } from './continuity/availability.js';
import { investigationSection, workSection, openThreadsText } from './continuity/brief.js';
import type { Config } from './store.js';

// Pure connection/timer fixtures. Never constructs a pg Pool or reads a configured database.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const flush = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
function clientFixture(onDestroy?: () => void) {
  const releases: boolean[] = [];
  const client = {release(destroy = false) {
    releases.push(Boolean(destroy));
    assert.equal(releases.length,1,'each borrowed client must be released exactly once');
    if (destroy) onDestroy?.();
  }} as unknown as pg.PoolClient;
  return {client,releases};
}
const fakePool = (connect: () => Promise<pg.PoolClient>) => ({connect}) as unknown as pg.Pool;
const originalSet = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
let next = 1;
const timers = new Map<number, () => void>();
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
  const id = next++;
  timers.set(id,()=>callback(...args));
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: unknown) => { timers.delete(Number(id)); }) as typeof clearTimeout;
const fireDeadline = () => {
  assert.equal(timers.size,1,'one active deadline expected');
  const [id,fire] = [...timers][0];timers.delete(id);fire();
};
try {
  // Success clears its timer and returns a healthy client to the pool once.
  const good = clientFixture();
  const value = await boundedRead(fakePool(async()=>good.client),4000,async c=>{
    assert.equal(c,good.client);return 42;
  });
  assert.equal(value,42);assert.deepEqual(good.releases,[false]);assert.equal(timers.size,0);

  // An active query is destroyed at deadline, never returned as an idle busy client.
  const query = deferred<string>();
  let began = false;
  const active = clientFixture(()=>query.reject(new Error('socket destroyed')));
  const pending = boundedRead(fakePool(async()=>active.client),4000,async()=>{began=true;return query.promise;});
  const timed = assert.rejects(pending,(e: any)=>e.code==='LEDGER_READ_TIMEOUT');
  await flush();assert.ok(began);fireDeadline();await timed;
  assert.deepEqual(active.releases,[true]);assert.equal(timers.size,0);
  await flush();assert.deepEqual(active.releases,[true],'query rejection must not double-release');

  // A connect queued beyond the deadline is released when it arrives; its callback never starts.
  const acquisition = deferred<pg.PoolClient>();
  const late = clientFixture();let lateRead=false;
  const waiting = boundedRead(fakePool(()=>acquisition.promise),4000,async()=>{lateRead=true;return 'wrong';});
  const rejected = assert.rejects(waiting,(e: any)=>e.code==='LEDGER_READ_TIMEOUT');
  fireDeadline();await rejected;
  assert.equal(timers.size,0);assert.deepEqual(late.releases,[]);
  acquisition.resolve(late.client);await flush();
  assert.deepEqual(late.releases,[true]);assert.equal(lateRead,false);

  // A query that resolves after the timeout cannot replace the terminal timeout or be released twice.
  const slow = deferred<string>();const ignored = clientFixture();
  const after = boundedRead(fakePool(async()=>ignored.client),4000,()=>slow.promise);
  const afterRejected = assert.rejects(after,(e: any)=>e.code==='LEDGER_READ_TIMEOUT');
  await flush();fireDeadline();await afterRejected;slow.resolve('too late');await flush();
  assert.deepEqual(ignored.releases,[true]);assert.equal(timers.size,0);

  // Fast acquisition/read failures clear timers. The section renderer redacts their raw error details.
  const secret = new Error('postgres://user:password@private-host/db SELECT private_query');
  const failed = await availableSection('Open work',()=>boundedRead(fakePool(async()=>{throw secret;}),4000,async()=>''));
  assert.equal(failed.status,'unavailable');assert.equal(failed.reason,'backend_error');
  assert.equal(timers.size,0);assert.ok(!JSON.stringify(failed).includes('password'));assert.ok(!JSON.stringify(failed).includes('private_query'));
  assert.match(failed.text,/prior work may exist/);assert.match(failed.text,/not an empty result/);
  const readFailure=clientFixture();
  await assert.rejects(boundedRead(fakePool(async()=>readFailure.client),4000,async()=>{throw secret;}),e=>e===secret);
  assert.deepEqual(readFailure.releases,[false]);assert.equal(timers.size,0);
  let invalidConnects=0;
  for (const ms of [0,-1,Infinity,NaN]) await assert.rejects(boundedRead(fakePool(async()=>{invalidConnects++;return good.client;}),ms,async()=>''),/deadline must be positive/);
  assert.equal(invalidConnects,0);assert.equal(timers.size,0);

  // Empty success, timeout, and not configured remain different machine-readable states.
  const now = new Date('2026-09-20T12:00:00Z');
  const empty = await availableSection('Open work',async()=>'',now);
  assert.equal(empty.status,'available_empty');assert.equal(empty.text,'');assert.equal(empty.reason,undefined);
  assert.equal(empty.observed_at,now.toISOString());
  assert.equal((await availableSection('Open work',async()=>' \n\t',now)).status,'available_empty');
  const nonempty = await availableSection('Open work',async()=>'record one',now);
  assert.equal(nonempty.status,'available');assert.equal(nonempty.text,'record one');
  const timeout = await availableSection('Open work',async()=>{throw Object.assign(secret,{code:'LEDGER_READ_TIMEOUT'});},now);
  assert.equal(timeout.status,'unavailable');assert.equal(timeout.reason,'timeout');assert.match(timeout.text,/timed out/);
  assert.ok(!JSON.stringify(timeout).includes('password'));
  const unconfigured: Config = {author:'fixture',ledger_dir:'/not-read-by-this-test',git_sync:false};
  for (const section of [await investigationSection(unconfigured,{now}),await workSection(unconfigured,{now})]) {
    assert.equal(section.status,'not_configured');assert.equal(section.observed_at,now.toISOString());assert.equal(section.text,'');
  }
  assert.equal(await openThreadsText(unconfigured),'');assert.equal(timers.size,0);
  console.log('availability: success cleanup, query destruction, late connection/result cleanup, redacted errors, and empty/unavailable/not-configured distinctions passed');
} finally {
  globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
}
