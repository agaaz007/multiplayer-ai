import { z } from 'zod';
import { loadAll, type Config } from './store.js';
import { TYPES } from './schema.js';
import { continuityConfigured, getPool } from './continuity/db.js';
import { acknowledgeCapture, loadJournal, sessionsDir, type CaptureCoverage, type CaptureAck } from './hooks.js';
import { evidenceId } from './capture-tools.js';

const coverageSchema = z.array(z.object({session_id:z.string().trim().min(1),evidence_ids:z.array(z.string().min(1)).min(1).max(500)})).max(50);
function parseCoverage(value: unknown): CaptureCoverage[] {
  const coverage=coverageSchema.parse(value ?? []), sessions=new Set<string>();
  for(const item of coverage) {
    if(sessions.has(item.session_id) || new Set(item.evidence_ids).size !== item.evidence_ids.length) throw new Error('duplicate capture session or evidence IDs');
    sessions.add(item.session_id); item.evidence_ids.sort();
  }
  return coverage.sort((a,b)=>a.session_id.localeCompare(b.session_id));
}

function localIds(session: string, dir: string): Set<string> {
  // Already acknowledged queries remain valid coverage, including legacy journals.
  const journal=loadJournal(session,dir);
  return new Set(journal.entries.filter(e=>e.kind==='query').map(e=>e.evidence_id ?? evidenceId(undefined,e.tool ?? '',e.at,e.summary ?? '')));
}

/** Remote coverage needs retained source evidence; it never creates a foreign local journal. */
export async function validateRecordCoverage(cfg: Config, fields: Record<string,any>, dir=sessionsDir()): Promise<CaptureCoverage[]> {
  const coverage=parseCoverage(fields.capture_coverage);
  if(!coverage.length) return coverage;
  const sources=loadAll(cfg,TYPES);
  const predecessor=typeof fields.supersedes==='string' ? sources.find(o=>o.id===fields.supersedes) : undefined;
  const inherited=predecessor ? parseCoverage(predecessor.fields.capture_coverage) : [];
  for(const item of coverage) {
    const known=localIds(item.session_id,dir);
    const shared=new Set(inherited.filter(c=>c.session_id===item.session_id).flatMap(c=>c.evidence_ids));
    const missing=item.evidence_ids.filter(id=>!known.has(id)&&!shared.has(id));
    if(!missing.length) continue;
    if(!continuityConfigured(cfg)) throw new Error(`capture_coverage has no retained source for session ${item.session_id}: ${missing.join(', ')}`);
    const rows=await getPool(cfg).query<{evidence_ids:unknown}>(`select payload->'evidence_ids' as evidence_ids from cont_events where session_id=$1 and kind='tool.requested' and payload->'evidence_ids' ?| $2::text[]`,[item.session_id,missing]);
    const observed=new Set(rows.rows.flatMap(row=>Array.isArray(row.evidence_ids)?row.evidence_ids:[]));
    const unknown=missing.filter(id=>!observed.has(id));
    if(unknown.length) throw new Error(`capture_coverage contains unknown evidence IDs for shared session ${item.session_id}: ${unknown.join(', ')}${unknown.some(id=>observed.has(`q:${id}`)) ? '. IDs are prefixed: pass them as "q:<call id>", exactly as printed.' : ''}`);
  }
  return coverage;
}

export function acknowledgeLocalCapture(ack: CaptureAck, dir=sessionsDir()): {acknowledged:number;pending_review:number;remote_pending:number} {
  let remote_pending=0;
  const local=parseCoverage(ack.coverage).flatMap(item=>{
    const known=localIds(item.session_id,dir), evidence_ids=item.evidence_ids.filter(id=>known.has(id));
    remote_pending+=item.evidence_ids.length-evidence_ids.length;
    return evidence_ids.length ? [{session_id:item.session_id,evidence_ids}] : [];
  });
  return {...acknowledgeCapture({...ack,coverage:local},{dir}),remote_pending};
}

/** Pull shared records, then settle only explicitly covered IDs that exist on this machine. */
export function reconcileSharedCapture(cfg: Config, dir=sessionsDir()): {acknowledged:number;warnings:string[]} {
  let acknowledged=0;
  const warnings:string[]=[];
  for(const object of loadAll(cfg,TYPES)) {
    if(object.status!=='stable' || !object.fields.capture_coverage) continue;
    try {
      acknowledged+=acknowledgeLocalCapture({schema:'ledger-capture/v1',action:'record',status:'recorded',record_id:object.id,coverage:parseCoverage(object.fields.capture_coverage)},dir).acknowledged;
    } catch(error) {warnings.push(`Capture acknowledgment for ${object.id} remains pending: ${String(error)}`);}
  }
  return {acknowledged,warnings};
}
