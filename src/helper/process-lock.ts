import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Serialize lease claim/reclaim/release with an atomic directory guard. A dead
 * primary owner can be reclaimed safely; a crash INSIDE the tiny guard critical
 * section fails closed and needs explicit operator recovery. Never unlink a PID
 * lock after a check made outside the guard (that can delete a successor lock). */
export function acquireProcessLease(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const guard = `${file}.guard`, token = crypto.randomUUID();
  function guarded<T>(fn: () => T): T {
    try { fs.mkdirSync(guard, { mode: 0o700 }); }
    catch (e: any) { if (e.code === "EEXIST") throw new Error(`lease guard busy or interrupted; retained for recovery: ${path.basename(file)}`); throw e; }
    try { return fn(); } finally { fs.rmdirSync(guard); }
  }
  guarded(() => {
    if (fs.existsSync(file)) {
      let owner: { pid: number; token: string };
      try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`invalid lease owner; repair required: ${path.basename(file)}`); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.token) throw new Error("invalid process lease owner; repair required");
      let live = true; try { process.kill(owner.pid, 0); } catch (e: any) { if (e.code === "ESRCH") live = false; }
      if (live) throw new Error(`process lease busy: ${path.basename(file)}`);
      fs.unlinkSync(file); // every contender must hold this same guard first
    }
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  let released = false;
  return () => {
    if (released) return;
    guarded(() => {
      const owner = JSON.parse(fs.readFileSync(file, "utf8"));
      if (owner.pid !== process.pid || owner.token !== token) throw new Error("process lease changed owner; refusing release");
      fs.unlinkSync(file); released = true;
    });
  };
}
