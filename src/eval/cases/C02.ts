import type { EvalCaseRunner } from "./index.js";

/** C02 (phase 2): needs a third local agent in a distinct worktree with sentinel hashes and a successful operation recorded in parallel.json. */
export const C02: EvalCaseRunner = { id: "C02", skip: "phase 2: third agent in a parallel worktree and parallel.json collector not implemented" };
