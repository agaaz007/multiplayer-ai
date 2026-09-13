import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Capture-helper safety guards from the 2026-09-13 north-star review. No database.
 *
 *   session id    MCP tools never claim or bind under a synthetic id; CLAUDE_CODE_SESSION_ID is read
 *   home root     a git repo at $HOME (or an ancestor) is never shadow-committed
 *   auto-bind     a session adopts only threads that existed when it started
 *   titles        a one-word first prompt does not name a thread
 *   liveness      pass deadline, staleness warning, SessionStart lines
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-safety-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger"); // never touch the real ~/.ledger
process.env.LEDGER_SELFTEST = "1";

const { resolveHarnessSession, localTranscriptExists, forbiddenSnapshotRoot, autoBindEligible, threadTitleFor, AUTO_BIND_SLACK_MS } = await import("./continuity/safety.js");
const { captureStaleness, withDeadline, writeHeartbeat, heartbeatFile } = await import("./helper/heartbeat.js");
const { shadowCommit } = await import("./continuity/shadow.js");
const { continuityStartContext } = await import("./hooks.js");

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

// ---------- session id resolution ----------
{
  const has = (ids: string[]) => (id: string) => ids.includes(id);
  const claude = "e598e2b8-f57b-4c9c-9a04-0e47698a60c2";
  const codex = "01a08d0a-e4fb-7f63-8906-9c3be3fb9e3a";

  const explicit = resolveHarnessSession("given-session-id", { CLAUDE_CODE_SESSION_ID: claude }, has([claude]));
  assert.deepEqual(explicit, { ok: true, id: "given-session-id", source: "explicit" }, "explicit session_id wins over the environment");

  // the regression: Claude Code exports CLAUDE_CODE_SESSION_ID, and the old lookup only read CLAUDE_SESSION_ID
  const fromClaude = resolveHarnessSession(undefined, { CLAUDE_CODE_SESSION_ID: claude }, has([claude]));
  assert.deepEqual(fromClaude, { ok: true, id: claude, source: "CLAUDE_CODE_SESSION_ID" });

  const staleClaudeEnv = resolveHarnessSession("", { CLAUDE_CODE_SESSION_ID: "11111111-dead", CODEX_THREAD_ID: codex }, has([codex]));
  assert.deepEqual(staleClaudeEnv, { ok: true, id: codex, source: "CODEX_THREAD_ID" }, "an env id without a local transcript is skipped");

  const noTranscript = resolveHarnessSession(undefined, { CLAUDE_CODE_SESSION_ID: claude }, has([]));
  assert.equal(noTranscript.ok, false);
  assert.match((noTranscript as any).error, /CLAUDE_CODE_SESSION_ID=e598e2b8… has no local transcript/);
  assert.match((noTranscript as any).error, /Nothing was claimed or bound/);

  const none = resolveHarnessSession(undefined, {}, has([claude]));
  assert.equal(none.ok, false);
  assert.match((none as any).error, /none of CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID, CODEX_THREAD_ID is set/);
  assert.ok(!JSON.stringify(none).includes("mcp:"), "never a synthetic mcp:<author>:<pid> id");
  ok("session id: explicit > CLAUDE_CODE_SESSION_ID > CLAUDE_SESSION_ID > CODEX_THREAD_ID, env ids need a transcript, otherwise a refusal");
}

// ---------- local transcript lookup ----------
{
  const roots = { claude: path.join(tmp, "claude", "projects"), codex: path.join(tmp, "codex", "sessions") };
  fs.mkdirSync(path.join(roots.claude, "-Users-x-repo"), { recursive: true });
  fs.writeFileSync(path.join(roots.claude, "-Users-x-repo", "aaaaaaaa-1111-2222-3333-444444444444.jsonl"), "{}\n");
  fs.mkdirSync(path.join(roots.codex, "2026", "09", "13"), { recursive: true });
  fs.writeFileSync(path.join(roots.codex, "2026", "09", "13", "rollout-2026-09-13T10-00-00-0199bbbb-cccc-7ddd-8eee-ffffffffffff.jsonl"), "{}\n");
  assert.equal(localTranscriptExists("aaaaaaaa-1111-2222-3333-444444444444", roots), true, "Claude project transcript");
  assert.equal(localTranscriptExists("0199bbbb-cccc-7ddd-8eee-ffffffffffff", roots), true, "Codex rollout transcript");
  assert.equal(localTranscriptExists("99999999-0000-0000-0000-000000000000", roots), false);
  assert.equal(localTranscriptExists("../../etc/passwd", roots), false, "path-like ids are rejected");
  ok("local transcript lookup finds Claude and Codex files by session id and rejects path-like ids");
}

// ---------- forbidden snapshot roots ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-home-"));
  const realHome = fs.realpathSync(home);
  assert.match(String(forbiddenSnapshotRoot(home, home)), /is the home directory/);
  assert.match(String(forbiddenSnapshotRoot(realHome, home)), /is the home directory/, "realpath on both sides (/var vs /private/var)");
  assert.match(String(forbiddenSnapshotRoot(path.dirname(realHome), home)), /contains the home directory/);
  assert.match(String(forbiddenSnapshotRoot("/", home)), /contains the home directory/);
  fs.mkdirSync(path.join(home, "proj"));
  assert.equal(forbiddenSnapshotRoot(path.join(home, "proj"), home), null, "a project under home is fine");

  // shadowCommit refuses a repo at $HOME even when called directly, and still works for a project inside it
  git(home, "init", "--quiet");
  fs.writeFileSync(path.join(home, ".netrc"), "machine example.com password hunter2\n");
  fs.writeFileSync(path.join(home, "notes.txt"), "a\n");
  git(home, "add", "notes.txt");
  git(home, "commit", "--quiet", "-m", "init");
  fs.writeFileSync(path.join(home, "notes.txt"), "b\n");
  const proj = path.join(home, "proj");
  git(proj, "init", "--quiet");
  fs.writeFileSync(path.join(proj, "app.ts"), "1\n");
  git(proj, "add", "app.ts");
  git(proj, "commit", "--quiet", "-m", "init");
  fs.writeFileSync(path.join(proj, "app.ts"), "2\n");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const refused = shadowCommit(home, { ref: "refs/wip/t/home", push: false });
    assert.equal(refused.skipped, "forbidden_root");
    assert.equal(refused.commit, undefined);
    assert.equal(git(home, "for-each-ref", "refs/wip"), "", "no wip ref written for the home repo");
    assert.ok(refused.gaps.some((g) => g.kind === "forbidden_root"));
    const allowed = shadowCommit(proj, { ref: "refs/wip/t/proj", push: false });
    assert.ok(allowed.ok && allowed.commit, `project snapshot still works: ${allowed.error ?? ""}`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
  ok("forbidden roots: $HOME and its ancestors refused (no wip ref), a project under $HOME still snapshots");
}

// ---------- auto-bind eligibility and titles ----------
{
  const start = Date.UTC(2026, 8, 13, 14, 0, 0);
  assert.equal(autoBindEligible(start, new Date(start - 3_600_000)), true, "thread from yesterday: continue it");
  assert.equal(autoBindEligible(start, new Date(start + AUTO_BIND_SLACK_MS - 1)), true, "within clock slack");
  assert.equal(autoBindEligible(start, new Date(start + AUTO_BIND_SLACK_MS + 1)), false, "thread created after the session started");
  // the observed case: a session last active on 2026-09-09 must not adopt a thread created on 2026-09-13
  assert.equal(autoBindEligible(Date.UTC(2026, 8, 9, 13, 0, 0), "2026-09-13T14:00:48.000Z"), false);
  assert.equal(autoBindEligible(undefined, new Date(start)), false, "unknown start time is not eligible");
  assert.equal(threadTitleFor("pwd", "https://github.com/agaaz007/multiplayer-ai", "e598e2b8-f57b"), "multiplayer-ai work (session e598e2b8)");
  assert.equal(threadTitleFor("Add a greeting banner", "https://github.com/x/demo", "s"), "Add a greeting banner");
  assert.equal(threadTitleFor(undefined, "/tmp/demo", "abcdefgh1234"), "demo work (session abcdefgh)");
  ok("auto-bind adopts only threads older than the session; one-word first prompts do not become titles");
}

// ---------- pass deadline ----------
{
  const never = new Promise<number>(() => {});
  const t0 = Date.now();
  const timed = await withDeadline(never, 40);
  assert.equal(timed.timedOut, true);
  assert.ok(Date.now() - t0 < 1000, "deadline fires promptly");
  const done = await withDeadline(Promise.resolve(7), 1000);
  assert.deepEqual(done, { timedOut: false, value: 7 });
  ok("withDeadline: a pass that never returns times out; a finished pass returns its value");
}

// ---------- staleness and SessionStart ----------
{
  const now = new Date("2026-09-13T15:30:00Z");
  const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const base = { pid: 4242, cli: "/x/dist/cli.js", author: "agaaz", machine: "mac", started_at: iso(120), pass_deadline_s: 900, last_pass_ms: 900, last_error: null, updated_at: iso(0) };
  const alive = () => true, dead = () => false;
  assert.equal(captureStaleness(null, now), null, "no heartbeat file: no helper on this machine, no warning");
  assert.equal(captureStaleness({ ...base, last_pass_started_at: iso(1), last_pass_finished_at: iso(0.9) }, now, { alive }), null, "healthy");
  assert.match(String(captureStaleness({ ...base, last_pass_started_at: iso(1), last_pass_finished_at: iso(0.9) }, now, { alive: dead })), /not running on this machine/);
  // the observed outage: a pass started and never finished while the process stayed alive
  const stalled = String(captureStaleness({ ...base, last_pass_started_at: iso(87), last_pass_finished_at: iso(2340) }, now, { alive }));
  assert.match(stalled, /stalled: the current pass has run 87 min/);
  assert.match(stalled, /launchctl kickstart/);
  // a helper whose passes keep throwing starts a new pass every interval but never completes one
  const noPass = String(captureStaleness({ ...base, last_pass_started_at: iso(0.2), last_pass_finished_at: iso(21), last_error: "pass failed: getaddrinfo ENOTFOUND" }, now, { alive }));
  assert.match(noPass, /has not completed a pass for 21 min/);
  assert.match(noPass, /ENOTFOUND/);
  assert.match(String(captureStaleness({ ...base, last_pass_started_at: iso(1), last_pass_finished_at: iso(0.9), last_error: "shadow e598e2b8: push failed" }, now, { alive })), /reported errors in its last pass: shadow e598e2b8: push failed/);

  assert.equal(continuityStartContext("sess-1", now), "", "SessionStart adds nothing on a machine without a helper heartbeat");
  writeHeartbeat({ ...base, pid: process.pid, last_pass_started_at: iso(1), last_pass_finished_at: iso(0.5) }, now);
  assert.ok(fs.existsSync(heartbeatFile()));
  const fresh = continuityStartContext("sess-1", now);
  assert.match(fresh, /^Ledger session: sess-1\. Pass session_id: "sess-1" to ledger_resume/);
  assert.ok(!fresh.includes("WARNING"));
  writeHeartbeat({ last_pass_started_at: iso(30), last_pass_finished_at: iso(45) }, now);
  assert.match(continuityStartContext("sess-1", now), /WARNING: Ledger capture on this machine is stalled/);
  ok("staleness: dead, stalled, failing and healthy helpers distinguished; SessionStart prints the session id and any warning");
}

console.log(`selftest-helper-safety: ok (${step} checks) — tmp ${tmp}`);
