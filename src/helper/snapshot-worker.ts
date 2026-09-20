import { fork } from "node:child_process";
// This supervisor never runs synchronous Git. It remains able to terminate the
// entire dedicated process group on parent disconnect or its independent timer.
process.once("message", (message: any) => {
  const killGroup = () => { try { if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL"); else process.exit(1); } catch { process.exit(1); } };
  process.once("disconnect", killGroup);
  const deadline = setTimeout(killGroup, Math.max(100, message.timeoutMs ?? 180_000));
  const job = fork(new URL("./snapshot-job.js", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let replied = false;
  job.stderr?.on("data", () => {});
  job.once("message", result => { replied = true; clearTimeout(deadline); process.send?.(result, () => process.exit(0)); });
  job.once("error", error => { clearTimeout(deadline); process.send?.({ error: error.message }, () => process.exit(1)); });
  job.once("exit", (code, signal) => { if (!replied) { clearTimeout(deadline); process.send?.({ error: `snapshot job exited (${code ?? signal})` }, () => process.exit(1)); } });
  job.send(message);
});
