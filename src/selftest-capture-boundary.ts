import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initLedger, record, recordDraft, discardDraft, type Config} from './store.js';
import {handleHook, debt, reviewDebt, loadJournal, acknowledgeCapture, validateCaptureCoverage} from './hooks.js';
import {validateRecordCoverage, acknowledgeLocalCapture, reconcileSharedCapture} from './capture-boundary.js';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-capture-boundary-'));
process.env.LEDGER_CONFIG_DIR=path.join(tmp,'config'); process.env.LEDGER_GIT_SYNC='0';
const source=path.join(tmp,'rachit-sessions'), successor=path.join(tmp,'agaaz-sessions');
const cfg:Config={ledger_dir:path.join(tmp,'shared'),author:'rachit',git_sync:false};
initLedger(cfg.ledger_dir,cfg.author);
for(const call of ['relevant','unrelated']) handleHook('PostToolUse',{session_id:'rachit-analysis',tool_name:'mcp__mixpanel__query',tool_use_id:call,tool_input:{sql:`select '${call}'`},tool_response:{}},{dir:source});
const coverage=[{session_id:'rachit-analysis',evidence_ids:['q:relevant']}];
const fields={title:'Retained unfinished analysis',question:'What did the relevant evidence establish?',result:'Fixture result',source:'fixture',data_window:{from:'2026-09-01',to:'2026-09-02'},inputs:[{source:'fixture'}],method:'Review the permitted evidence',assumptions:[{statement:'Fixture is complete',kind:'implicit'}],capture_coverage:coverage};
const draft=recordDraft(cfg,{type:'finding',fields,capture:{method:'transcript_fallback',session:'rachit-analysis',reason:'unfinished source session'}});
acknowledgeCapture({schema:'ledger-capture/v1',action:'record',status:'pending_review',record_id:draft.id,coverage},{dir:source});
assert.equal(reviewDebt(loadJournal('rachit-analysis',source)).length,1);
assert.equal(reconcileSharedCapture(cfg,source).acknowledged,0,'a shared draft cannot clear review debt');

const reviewer={...cfg,author:'agaaz'};
await assert.rejects(validateRecordCoverage(reviewer,fields,successor),/no retained source/,'remote coverage without a source cannot be claimed');
const acceptedFields={...fields,supersedes:draft.id};
assert.deepEqual(await validateRecordCoverage(reviewer,acceptedFields,successor),coverage);
const accepted=record(reviewer,{type:'finding',fields:acceptedFields});
const ack=acknowledgeLocalCapture({schema:'ledger-capture/v1',action:'record',status:'recorded',record_id:accepted.id,coverage},successor);
assert.deepEqual(ack,{acknowledged:0,pending_review:0,remote_pending:1});
assert.ok(!fs.existsSync(path.join(successor,'rachit-analysis.json')),'never fabricate a source-machine journal');
assert.equal(reviewDebt(loadJournal('rachit-analysis',source)).length,1,'source client has not synchronized yet');
assert.equal(reconcileSharedCapture(cfg,source).acknowledged,1,'source acknowledges an accepted teammate promotion on next read');
assert.equal(reviewDebt(loadJournal('rachit-analysis',source)).length,0);
assert.deepEqual(debt(loadJournal('rachit-analysis',source)).map(e=>e.evidence_id),['q:unrelated']);
assert.equal(reconcileSharedCapture(cfg,source).acknowledged,0,'reconciliation is idempotent');
await assert.rejects(validateRecordCoverage(reviewer,{...acceptedFields,capture_coverage:[{session_id:'rachit-analysis',evidence_ids:['q:unrelated']}]},successor),/no retained source/);

const rejected=recordDraft(cfg,{type:'finding',fields:{...fields,title:'Rejected draft',capture_coverage:[{session_id:'rachit-analysis',evidence_ids:['q:unrelated']}]},capture:{method:'transcript_fallback',session:'rachit-analysis',reason:'unrelated draft'}});
discardDraft(reviewer,rejected.id,'Unrelated exploration did not establish a finding');
assert.equal(reconcileSharedCapture(cfg,source).acknowledged,0,'discarded metadata is not a successful finding acknowledgment');
assert.equal(debt(loadJournal('rachit-analysis',source)).length,1);
// Evidence ids are minted with a `q:` prefix and printed that way; the common mistake is passing
// the bare call id. The rejection must hand back the corrected value, not just name the rule.
try { validateCaptureCoverage([{session_id:'rachit-analysis',evidence_ids:['unrelated']}],source); assert.fail('bare id must be rejected'); }
catch(e:any){ assert.match(e.message,/pass "q:unrelated" exactly as printed/,'the rejection hands back the corrected id: '+e.message); }
try { validateCaptureCoverage([{session_id:'rachit-analysis',evidence_ids:['q:never-happened']}],source); assert.fail('unknown id must be rejected'); }
catch(e:any){ assert.match(e.message,/Outstanding IDs for this session are: q:/,'an unknown id names what is outstanding: '+e.message); }

console.log('selftest-capture-boundary: passed two-client promotion, source-only acknowledgment, exact coverage, idempotency, rejection boundaries and actionable evidence-id errors');
