import type { EvalCaseRunner } from "./index.js";

/**
 * D04: a corrected number, a rejected option, and an assumption nobody states as one.
 *
 * Common flow — the origin types the twelve fixture events in order across the two sessions, and the
 * condition plugin makes them available to the successor its own way. Nothing case-specific is needed
 * here: no seed files, no fake service, no snapshot, no third agent.
 *
 * The case exists because D01 and D02 each test one half of it against clean evidence. Here the three
 * facts are all buried the way they are in real PM history: the superseded number is still present and
 * still matches "trial-start CVR" as well as its correction does; the rejection lives in the other
 * session from the discussion it retires; and the population filter was written down once as a query
 * detail, never as a caveat on the conclusion that depends on it.
 */
export const D04: EvalCaseRunner = { id: "D04" };
