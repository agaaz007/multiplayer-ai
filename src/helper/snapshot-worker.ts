import fs from "node:fs";
import path from "node:path";
import { shadowCommit, type ShadowOpts } from "../continuity/shadow.js";
// Dedicated child: synchronous Git cannot block the helper's capture/event loop.
process.once("message", (message: { worktree: string; opts: ShadowOpts }) => {
  let lock: string | undefined;
  try {
    const dir = message.opts.privateIndexDirectory;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ownerFile = path.join(dir, "worker.lock");
      if (fs.existsSync(ownerFile)) {
        const pid = Number(fs.readFileSync(ownerFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("snapshot private-index lock needs recovery");
        let alive = true; try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; }
        if (alive) throw new Error("snapshot private index is owned by another worker");
        fs.unlinkSync(ownerFile);
      }
      const fd = fs.openSync(ownerFile, "wx", 0o600); lock = ownerFile;
      try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (message.opts.now) message.opts.now = new Date(message.opts.now);
    const result = shadowCommit(message.worktree, message.opts);
    if (lock) { fs.unlinkSync(lock); lock = undefined; }
    process.send?.({ result }, () => process.exit(0));
  } catch (error: any) {
    if (lock) try { fs.unlinkSync(lock); } catch { /* retained for recovery */ }
    process.send?.({ error: String(error?.message ?? error).slice(0, 300) }, () => process.exit(1));
  }
});
