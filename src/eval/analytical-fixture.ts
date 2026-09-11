import { TaskSchema, OracleSchema, type AnalyticalTask, type Oracle, type Evidence } from './analytical-contract.js';

const scope = { product: 'HiAstro-fixture', dataset: 'synthetic', platform: 'android', country: 'IN', metric: 'trial_start_cvr' };
export const CORRECT_SQL = `WITH eligible AS (
 SELECT user_id, cohort, MIN(day) first_day FROM events
 WHERE product='HiAstro-fixture' AND platform='android' AND country='IN'
 AND event='paywall_impression' AND day >= 1 AND day <= 7 GROUP BY user_id, cohort
), converted AS (
 SELECT e.user_id, e.cohort, MAX(CASE WHEN t.event='trial_start' AND t.day >= e.first_day AND t.day < e.first_day + 7 THEN 1 ELSE 0 END) converted
 FROM eligible e LEFT JOIN events t ON t.user_id=e.user_id AND t.product='HiAstro-fixture'
 AND t.platform='android' AND t.country='IN' GROUP BY e.user_id, e.cohort
)
SELECT cohort, SUM(converted) numerator, COUNT(*) denominator, 1.0*SUM(converted)/COUNT(*) conversion
FROM converted GROUP BY cohort ORDER BY cohort`;
function dataset(offset = 0): AnalyticalTask['data'] {
  const rows: NonNullable<AnalyticalTask['data']> = [];
  function event(user: string, cohort: string, name: string, day: number, platform = 'android') {
    rows.push({ user_id: user, cohort, event: name, day, platform, country: 'IN', product: 'HiAstro-fixture' });
  }
  for (let i = 0; i < 6 + offset; i++) {
    const cohort = i % 2 ? 'general' : 'marriage';
    event(`u${i}`, cohort, 'paywall_impression', 1);
    if (i % 2 === 0) event(`u${i}`, cohort, 'paywall_impression', 2);
    if ((i + offset) % 3 === 0) event(`u${i}`, cohort, 'trial_start', 4);
  }
  event('late', 'marriage', 'paywall_impression', 7); event('late', 'marriage', 'trial_start', 14);
  event('visitor', 'general', 'page_view', 1); event('visitor', 'general', 'trial_start', 2);
  event('ios', 'general', 'paywall_impression', 1, 'ios'); event('ios', 'general', 'trial_start', 2, 'ios');
  return rows;
}
export function syntheticAnalyticalFixture(): { task: AnalyticalTask; oracle: Oracle } {
  const evidence: Evidence[] = [];
  function source(id: string, kind: Evidence['kind'], status: Evidence['status'], content: string,
    dependsOn: string[] = [], date = '2026-05-01T00:00:00Z', customScope = scope) {
    evidence.push({ id, title: `HiAstro trial conversion ${id}`, content, author: id === 'd2' ? 'rachit-fixture' : 'agaaz-fixture',
      recordedAt: date, effectiveAt: '2026-05-01T00:00:00Z', status, kind, scope: customScope, dependsOn, sourceRef: `synthetic:${id}` });
  }
  source('d1', 'definition', 'superseded', 'Original incorrect definition: trial-start users divided by paywall impression user-days. Retain for history.');
  source('f1', 'finding', 'accepted', 'Marriage conversion finding used denominator d1. Its number is historical and has not been recomputed.', ['d1']);
  source('f2', 'finding', 'accepted', 'General conversion finding also used denominator d1. Its number is historical and has not been recomputed.', ['d1']);
  source('q1', 'decision', 'accepted', 'Experiment prioritization relied on f1 relative to f2; it has not been revalidated after correction.', ['f1', 'f2']);
  source('d2', 'definition', 'accepted', 'Metric owner Rachit accepted this historical correction: count unique eligible users with at least one Android IN paywall impression during days 1–7, and among them users with a trial start from first impression through day first+7 exclusive. Persist cohort per user. Repeated impressions do not change the denominator. Apply to both cohorts. A runnable template is artifact corrected-query.sql. Supersedes d1 for this exact scope.', ['d1'], '2026-05-03T00:00:00Z');
  source('f3', 'finding', 'accepted', 'An iOS install count. It does not depend on trial_start_cvr or the Android denominator.', [], '2026-05-04T00:00:00Z', { ...scope, platform: 'ios', metric: 'installs' });
  source('d3', 'definition', 'proposed', 'Unreviewed proposal: use all page visitors as denominator instead. No acceptance or supporting analysis exists.', ['d2'], '2026-09-10T00:00:00Z');
  source('unfinished', 'artifact', 'evidence', 'Agaaz has not rerun cohort conversion using d2. Complete this comparison, identify which earlier findings and decision require review, preserve their old evidence and do not claim a launch decision is now validated.', [], '2026-09-10T00:01:00Z');
  source('noise', 'artifact', 'evidence', 'Third agent working on unrelated image rendering: prefer 16 pixel gutters. This is not conversion evidence.', [], '2026-09-10T00:02:00Z');
  const task = TaskSchema.parse({ version: 1, id: 'synthetic-hiastro-correction-v1', title: 'Synthetic historical denominator correction',
    kind: 'corrected-analysis', executable: true, prompt: 'Continue Agaaz and Rachit’s unfinished HiAstro-fixture investigation. Retrieve the accepted applicable definition and exact evidence, execute the next analysis, and identify prior results requiring review. Submit sql, definitionId, evidenceIds, affected [{id,status:"needs-review",path}], result and conclusion through submit_answer. SQL result columns must be cohort, numerator, denominator, conversion; return one row per cohort ordered by cohort. Use the logical source IDs in the captured documents and additionally cite native record IDs in your conclusion. Do not treat proposals as accepted.',
    provenance: { classification: 'synthetic', externalExportAllowed: true, sourceRefs: ['synthetic:hand-authored-v1'], permissionNote: 'Invented nonproduction fixture; not a claim about HiAstro users.' },
    evidence, data: dataset(), artifacts: [{ id: 'corrected-query', filename: 'corrected-query.sql', mediaType: 'text/sql', content: CORRECT_SQL,
      access: 'handoff-output', availableFrom: 'correction' }] });
  const oracle = OracleSchema.parse({ kind: 'sql', definitionId: 'd2', sql: CORRECT_SQL, requiredEvidence: ['d2', 'unfinished'],
    affected: [{ id: 'f1', status: 'needs-review', path: ['d1', 'f1'] }, { id: 'f2', status: 'needs-review', path: ['d1', 'f2'] },
      { id: 'q1', status: 'needs-review', path: ['d1', 'f1', 'q1'] }], holdouts: [dataset(1), dataset(5)] });
  return { task, oracle };
}
