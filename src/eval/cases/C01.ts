import type { EvalCaseRunner } from "./index.js";

/** C01 (phase 2): needs two concurrent claimants with a barrier, a stale-generation upload, and ownership.json from real claim/head/fork responses. */
export const C01: EvalCaseRunner = { id: "C01", skip: "phase 2: concurrent claim race, stale upload and ownership.json collector not implemented" };
