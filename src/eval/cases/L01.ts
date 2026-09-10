import type { EvalCaseRunner } from "./index.js";
import { collectLongHistory, runLongHistoryOrigin } from "../long-history.js";

/** Capture-safe bounded turns, three observed fresh-session resets, and unique source-token measurement. */
export const L01: EvalCaseRunner = {
  id: "L01",
  runOrigin: runLongHistoryOrigin,
  collect: async (ctx, origin, successor) => collectLongHistory(ctx, origin, successor),
};
