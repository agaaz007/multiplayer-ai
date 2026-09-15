import type { CaseRunner, PublicCase } from "../types.js";
import { D01 } from "./D01.js";
import { D02 } from "./D02.js";
import { D03 } from "./D03.js";
import { D04 } from "./D04.js";
import { R01 } from "./R01.js";
import { R02 } from "./R02.js";
import { E01 } from "./E01.js";
import { E02 } from "./E02.js";
import { E03 } from "./E03.js";
import { C01 } from "./C01.js";
import { C02 } from "./C02.js";
import { L01 } from "./L01.js";
import { L02 } from "./L02.js";

/**
 * A CaseRunner plus the one field the contract does not carry: `skip`. A runner with `skip`
 * set is a phase-2 case the adapter reports as `status: skipped` (the kit scores it `not_run`,
 * never `error`) without creating trial resources.
 */
export interface EvalCaseRunner extends CaseRunner { skip?: string }

export const RUNNERS: Record<string, EvalCaseRunner> = { D01, D02, D03, D04, R01, R02, E01, E02, E03, C01, C02, L01, L02 };

export function runnerFor(id: string): EvalCaseRunner {
  const r = RUNNERS[id];
  if (!r) throw new Error(`no case runner for ${id}`);
  return r;
}

/** Cases whose successor must start from the origin's code snapshot (recovered worktree). */
export const SNAPSHOT_CASES = new Set(["E01", "E03", "C02"]);
export function needsSnapshot(c: PublicCase): boolean {
  return SNAPSHOT_CASES.has(c.id) || Boolean(c.seed_files && Object.keys(c.seed_files).length);
}
