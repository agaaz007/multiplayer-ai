import type { EvalCaseRunner } from "./index.js";

/** E02 (phase 2): needs the fake experiment service (read_experiment_status / create_experiment) exposed to the successor and actions.json from its tool calls. */
export const E02: EvalCaseRunner = { id: "E02", skip: "phase 2: fake external experiment service and actions.json collector not implemented" };
