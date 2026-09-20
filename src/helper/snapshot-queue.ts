import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { ledgerHome } from "../store.js";
import type { ShadowOpts, ShadowResult } from "../continuity/shadow.js";
const running = new Map<string, Promise<ShadowResult>>();
export const snapshotQueueSize = () => running.size;
/** Busy worktrees are coalesced by the next capture pass, not accumulated in an
 * unbounded queue. Capture must supply the original generation/event watermark
 * to its completion callback. Child process groups make timeout kill Git too. */
export function queueSnapshot(worktree: string, opts: ShadowOpts, timeoutMs = 180_000): Promise<ShadowResult> | null {
  const root = fs.realpathSync(worktree);
  if (running.has(root) || running.size >= 2) return null;
  const index = path.join(ledgerHome(), "snapshot-indexes", crypto.createHash("sha256").update(root).digest("hex"));
  const promise = new Promise<ShadowResult>((resolve) => {
    let finished = false;
    const child = fork(new URL("./snapshot-worker.js", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], detached: process.platform !== "win32" });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4096); });
    const stop = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* exited */ } };
    const finish = (result: ShadowResult) => { if (finished) return; finished = true; clearTimeout(timer); stop(); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: "snapshot worker deadline exceeded; snapshot not verified", files: [], gaps: [{ kind: "snapshot_timeout" }] }), timeoutMs);
    child.once("error", e => finish({ ok: false, error: e.message, files: [], gaps: [{ kind: "snapshot_worker_error" }] }));
    child.once("exit", (code, signal) => finish({ ok: false, error: `snapshot worker exited (${code ?? signal}): ${stderr.slice(0, 200)}`, files: [], gaps: [{ kind: "snapshot_worker_exit" }] }));
    child.once("message", (m: any) => finish(m.result ?? { ok: false, error: m.error ?? "invalid snapshot worker reply", files: [], gaps: [] }));
    child.send({ worktree: root, timeoutMs: timeoutMs + 1000, opts: { ...opts, privateIndexDirectory: index } });
  }).finally(() => { running.delete(root); });
  running.set(root, promise);
  return promise;
}
