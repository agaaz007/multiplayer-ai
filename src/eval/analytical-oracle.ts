import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnHarness } from './harness.js';
import { ownedPath, sha256, type AnalyticalTask, type Oracle } from './analytical-contract.js';

// Python's stdlib SQLite supports Node 20 hosts, requires no npm/native DB dependency,
// and evaluates a single read-only statement with an instruction/time budget.
const SQL_RUNNER = `import json, sqlite3, sys, re
p=json.load(sys.stdin)
rows=p['data']
db=sqlite3.connect(':memory:')
cols=sorted({k for r in rows for k in r}) or ['user_id','cohort','event','day','platform','country','product']
if not all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',c) for c in cols): raise ValueError('invalid dataset column')
def datatype(c):
 vals=[r[c] for r in rows if c in r and r[c] is not None]
 return 'REAL' if vals and all(isinstance(v,(int,float)) for v in vals) else 'TEXT'
db.execute('CREATE TABLE events ('+','.join('"'+c+'" '+datatype(c) for c in cols)+')')
db.executemany('INSERT INTO events VALUES ('+','.join('?' for c in cols)+')', [[r.get(c) for c in cols] for r in rows])
allowed={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_RECURSIVE}
def authorizer(action,a,b,c,d):
 if action not in allowed: return sqlite3.SQLITE_DENY
 if action == sqlite3.SQLITE_READ and a != 'events': return sqlite3.SQLITE_DENY
 if action == sqlite3.SQLITE_FUNCTION and str(b).lower() in ['load_extension','writefile','readfile']: return sqlite3.SQLITE_DENY
 return sqlite3.SQLITE_OK
db.set_authorizer(authorizer)
steps=[0]
def progress():
 steps[0]+=1
 return 1 if steps[0]>10000 else 0
db.set_progress_handler(progress,1000)
db.row_factory=sqlite3.Row
result=db.execute(p['sql']).fetchmany(501)
if len(result)>500: raise ValueError('result row budget exceeded')
print(json.dumps([dict(row) for row in result],sort_keys=True))
`;
export function executeSql(data: AnalyticalTask['data'], sql: string): unknown[] {
  if (!data || typeof sql !== 'string' || sql.length > 40_000 || !sql.trim()) throw new Error('SQL/data missing or exceeds budget');
  try {
    return JSON.parse(execFileSync('python3', ['-c', SQL_RUNNER], { input: JSON.stringify({ data, sql }),
      timeout: 10_000, maxBuffer: 4 << 20, stdio: ['pipe', 'pipe', 'pipe'] }).toString());
  } catch { throw new Error('read-only SQL execution failed or exceeded its budget'); }
}
function normalizedRows(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)]))
    : typeof v === 'number' ? Math.round(v * 1e10) / 1e10 : v;
  return JSON.stringify(canonical(value));
}
export async function gradeAnswer(task: AnalyticalTask, oracle: Oracle, answer: any, trace: any[], worktree?: string) {
  const evidence = new Set(Array.isArray(answer?.evidenceIds) ? answer.evidenceIds : []);
  const sourceCoverage = oracle.requiredEvidence.every(id => evidence.has(id));
  if (oracle.kind === 'sql') {
    const executed = trace.some(x => x.operation === 'query_data' && x.detail?.success && x.detail?.sqlHash === sha256(String(answer?.sql ?? '')));
    let resultCorrect = false; let holdoutsCorrect = false; let sqlError: string | undefined;
    try {
      const actual = executeSql(task.data, answer?.sql);
      resultCorrect = normalizedRows(actual) === normalizedRows(executeSql(task.data, oracle.sql)) && normalizedRows(answer?.result) === normalizedRows(actual);
      holdoutsCorrect = oracle.holdouts.every(data => normalizedRows(executeSql(data, answer.sql)) === normalizedRows(executeSql(data, oracle.sql)));
    } catch (error) { sqlError = error instanceof Error ? error.message : 'SQL failure'; }
    const affected = Array.isArray(answer?.affected) ? answer.affected : [];
    const expected = new Set(oracle.affected.map(x => x.id));
    const actualIds = new Set(affected.map((x: any) => x.id));
    const exact = expected.size === actualIds.size && [...expected].every(id => actualIds.has(id));
    const paths = oracle.affected.every(expectedItem => affected.some((a: any) => a.id === expectedItem.id && a.status === expectedItem.status
      && Array.isArray(a.path) && a.path[0] === expectedItem.path[0] && a.path.at(-1) === a.id
      && a.path.slice(1).every((id: string, i: number) => task.evidence.find(e => e.id === id)?.dependsOn.includes(a.path[i]))));
    const correction = answer?.definitionId === oracle.definitionId && resultCorrect && holdoutsCorrect;
    return { kind: 'sql', executable: task.executable, jointSuccess: task.executable && executed && correction && exact && paths && sourceCoverage,
      executed, resultCorrect, holdoutsCorrect, correction, impactIds: exact, impactPaths: paths, sourceCoverage, sqlError,
      scope: 'deterministic executable checks; human review of unsupported prose and critical errors still required' };
  }
  if (!worktree) throw new Error('coding oracle needs a restored successor checkout');
  const independentFiles: string[] = [];
  for (const file of oracle.independentFiles) {
    const target = ownedPath(worktree, file.relativePath);
    if (fs.existsSync(target)) throw new Error('independent oracle file collides with successor work');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content, { flag: 'wx' }); independentFiles.push(target);
  }
  const runs = [];
  try {
    for (const command of oracle.commands) {
      const [cmd, ...args] = command.argv;
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', LEDGER_EVAL: '1' };
      const result = await spawnHarness({ cmd, args, cwd: worktree, env, timeoutMs: command.timeoutMs });
      runs.push({ argv: command.argv, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr });
    }
  } finally { for (const file of independentFiles) fs.unlinkSync(file); }
  const gradingStatus = runs.some(r => r.exitCode === 78) ? 'not-evaluated' : 'evaluated';
  return { kind: 'coding', executable: task.executable, sourceCoverage, independentChecks: runs, gradingStatus,
    jointSuccess: task.executable && sourceCoverage && runs.every(r => r.exitCode === 0 && !r.timedOut),
    scope: 'frozen build/test checks; PRD completeness and decision-continuity evidence require the declared independent review' };
}
export function sqlRunnerHash() { return sha256(SQL_RUNNER); }
