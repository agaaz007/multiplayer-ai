import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const quote = (value: string) => JSON.stringify(value);
/** macOS process-tree boundary, shared by task agents and their child tools.
 * Process listing is deliberately NOT denied: `(deny process-info*)` makes CoreFoundation die with SIGTRAP
 * during node/codex startup on this machine (verified 2026-09-10), and nothing secret travels in argv. */
export function sequenceSeatbelt(readable: string[], writable: string[], denied: string[] = [], options: { allowLocalPostgres?: boolean } = {}) {
  if (process.platform !== 'darwin') throw new Error('This pilot requires the validated macOS seatbelt boundary');
  const paths = (values: string[]) => [...new Set(values.map(p => fs.realpathSync(p)))];
  const reads = paths(readable), writes = paths(writable), exclusions = paths(denied);
  for (const p of [...reads, ...writes]) {
    if (!path.isAbsolute(p) || p === '/' || ['/Users', '/private', '/private/tmp', '/tmp'].includes(p)) throw new Error('overbroad sequence path grant');
    if (exclusions.some(d => p === d || d.startsWith(p + path.sep))) throw new Error('permitted root contains a forbidden sequence/controller path');
  }
  return `(version 1)
(allow default)
${options.allowLocalPostgres ? '; local Postgres permitted for this arm: the product stores its team state there' : '(deny network-outbound (remote tcp "localhost:5432"))'}
(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read-metadata)
(deny file-write*)
(allow file-read* ${reads.concat(writes).map(p => `(subpath ${quote(p)})`).join(' ')})
(allow file-write* ${writes.map(p => `(subpath ${quote(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))
${exclusions.length ? `(deny file-read* file-write* ${exclusions.map(p => `(subpath ${quote(p)})`).join(' ')})` : ''}
`;
}

/** Verify the actual kernel policy; no declarations count as passing isolation. */
export function verifySequenceSeatbelt(policy: string, readableCanary: string, forbiddenCanaries: string[]) {
  if (!forbiddenCanaries.length) throw new Error('negative isolation probes are required');
  const run = (file: string) => {
    try { return { allowed: true, bytes: execFileSync('/usr/bin/sandbox-exec', ['-p', policy, '/bin/cat', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).length }; }
    catch (e: any) {
      if (e.status !== 1 || !String(e.stderr).includes('Operation not permitted')) throw new Error('isolation probe did not demonstrate a kernel denial');
      return { allowed: false, bytes: 0 };
    }
  };
  if (!run(readableCanary).allowed) throw new Error('own workspace unreadable');
  for (const file of forbiddenCanaries) if (run(file).allowed) throw new Error('foreign workspace/controller file readable');
  return { ownReadVerified: true, kernelDeniedReads: forbiddenCanaries.length, mechanism: 'macOS sandbox-exec inherited process policy' };
}
