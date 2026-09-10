import { createHash } from 'node:crypto';
import { loadAll, type Config } from './store.js';
import { objectVersion } from './authority.js';
import { continuityConfigured, getPool } from './continuity/db.js';
import { TYPES, AcceptanceSchema } from './schema.js';

/** Verify availability/integrity at the tool boundary. This does not judge the analysis itself. */
export async function verifyAcceptanceEvidence(cfg: Config, fields: Record<string, any>): Promise<void> {
  if (!fields.acceptance || (fields.status ?? 'stable') !== 'stable') return;
  const refs = AcceptanceSchema.parse(fields.acceptance).evidence_refs;
  if (!Array.isArray(refs) || !refs.length) throw new Error('acceptance requires evidence references');
  const objects = loadAll(cfg,TYPES);
  for (const ref of refs) {
    const object = ref.artifact_id ? objects.find(o=>o.id===ref.artifact_id) : null;
    if (object) {
      if(ref.session_id || ref.seq!==undefined) throw new Error('Ledger object evidence uses its content version; event coordinates require a retained event artifact reference');
      if (objectVersion(object) !== ref.sha256) throw new Error(`acceptance evidence version mismatch: ${object.id}`);
      if (object.status === 'draft' || object.previous_status==='draft' || object.fields.capture_method==='transcript_fallback') throw new Error(`acceptance evidence is an unaccepted draft: ${object.id}`);
      continue;
    }
    if (!continuityConfigured(cfg)) throw new Error(`acceptance evidence unavailable: ${ref.artifact_id ?? ref.sha256}; attach retained evidence or reference a known Ledger object version`);
    const pool = getPool(cfg);
    const found = await pool.query<{id:string;sha256:string;inline:Buffer|null;session_id:string|null}>(
      `select id, sha256, inline, session_id from cont_artifacts where sha256 = $1 and ($2::text is null or id::text = $2)`, [ref.sha256,ref.artifact_id ?? null]);
    const artifact = found.rows[0];
    if (!artifact || artifact.inline == null) throw new Error(`acceptance evidence body unavailable: ${ref.artifact_id ?? ref.sha256}`);
    if (createHash('sha256').update(artifact.inline).digest('hex') !== ref.sha256) throw new Error(`acceptance evidence content hash mismatch: ${ref.artifact_id ?? ref.sha256}`);
    // Content is deduplicated across sessions: membership rests on that session's event,
    // not solely the first uploader stored in cont_artifacts.session_id.
    if (ref.session_id && (ref.seq !== undefined || artifact.session_id !== ref.session_id)) {
      const event = await pool.query(`select 1 from cont_events where session_id=$1 and ($2::bigint is null or seq=$2)
        and (payload->>'input_artifact_id' = $3 or payload->>'artifact_id' = $3 or payload->>'output_artifact_id' = $3) limit 1`, [ref.session_id,ref.seq ?? null,artifact.id]);
      if (!event.rows.length) throw new Error('acceptance evidence event does not reference the named artifact');
    }
  }
}
