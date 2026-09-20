import { shadowCommit, type ShadowOpts } from "../continuity/shadow.js";
// Dedicated child: synchronous Git cannot block the helper's capture/event loop.
process.once("message", (message: { worktree: string; opts: ShadowOpts }) => {
  try {
    if (message.opts.now) message.opts.now = new Date(message.opts.now);
    process.send?.({ result: shadowCommit(message.worktree, message.opts) }, () => process.exit(0));
  } catch (error: any) { process.send?.({ error: String(error?.message ?? error).slice(0, 300) }, () => process.exit(1)); }
});
