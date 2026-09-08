import type { Condition, ConditionPlugin } from "../types.js";
import { ours } from "./ours.js";
import { gbrain } from "./gbrain.js";

export { ours, bootstrapWorktree } from "./ours.js";
export { gbrain } from "./gbrain.js";

const PLUGINS: Record<Condition, ConditionPlugin> = { ours, gbrain };

export function pluginFor(name: Condition): ConditionPlugin {
  const p = PLUGINS[name];
  if (!p) throw new Error(`unknown condition: ${String(name)} (known: ${Object.keys(PLUGINS).join(", ")})`);
  return p;
}
