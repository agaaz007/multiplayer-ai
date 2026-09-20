import path from "node:path";
import { acquireProcessLease } from "./process-lock.js";
import { shadowCommit, type ShadowOpts } from "../continuity/shadow.js";
// Dedicated child: synchronous Git cannot block the helper's capture/event loop.
process.once("message", (message: { worktree: string; opts: ShadowOpts }) => {
  let release: (() => void) | undefined;
  try {
    const dir = message.opts.privateIndexDirectory;
    if (dir) release = acquireProcessLease(path.join(dir, "worker.lock"));
    if (message.opts.now) message.opts.now = new Date(message.opts.now);
    const result = shadowCommit(message.worktree, message.opts);
    release?.(); release = undefined;
    process.send?.({ result }, () => process.exit(0));
  } catch (error: any) {
    try { release?.(); } catch { /* retained for recovery */ }
    process.send?.({ error: String(error?.message ?? error).slice(0, 300) }, () => process.exit(1));
  }
});
