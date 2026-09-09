import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { streamTranscript } from "../continuity/events.js";
import { runOrigin, type OriginTurnDetail } from "./origin.js";
import type { FixtureEvent, OriginRun, SuccessorRun, TrialContext } from "./types.js";

/** Below the production instruction cap (4,000), for both memory conditions. */
export const LONG_BATCH_CHARS = 3_900;
export const LONG_EPOCHS = 4;
export const TOKENIZER_VERSION = "0.12.0";
export const TOKENIZER_ENCODING = "o200k_base";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export interface HistoryBatch {
  events: FixtureEvent[];
  text: string;
}

/** Fixed contiguous batching: source ids, topics, and answer values never affect boundaries. */
export function batchHistory(events: FixtureEvent[], cap = LONG_BATCH_CHARS): HistoryBatch[] {
  if (!Number.isInteger(cap) || cap < 1) throw new Error("history batch cap must be a positive integer");
  const ids = new Set<string>();
  const batches: HistoryBatch[] = [];
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`duplicate fixture event id: ${event.id}`);
    ids.add(event.id);
    if (!event.text || event.text.length > cap) throw new Error(`fixture event ${event.id} cannot fit the ${cap}-character capture-safe batch cap`);
    const prior = batches[batches.length - 1];
    if (prior && prior.text.length + 2 + event.text.length <= cap) {
      prior.events.push(event);
      prior.text += "\n\n" + event.text;
    } else batches.push({ events: [event], text: event.text });
  }
  return batches;
}

export interface TokenMeasurement {
  tokenizer: string;
  tokenizer_version: string;
  encoding: string;
  measurement_kind: "explicit_tokenizer_proxy";
  provider_tokenizer_verified: false;
  counted_content: string;
  measured_origin_tokens: number;
  events: { id: string; sha256: string; tokens: number }[];
}

/**
 * Exact count in a named, pinned tokenizer, explicitly a proxy for either provider.
 * Unique fixture events are counted once. No system schemas, cached rereads, or
 * cumulative API input totals enter the long-history size.
 */
export function measureHistory(events: FixtureEvent[], python = process.env.LEDGER_EVAL_TOKENIZER_PYTHON || path.join(ROOT, ".context/eval-tokenizer/bin/python3")): TokenMeasurement {
  const script = [
    "import json, sys, importlib.metadata, tiktoken",
    "version = importlib.metadata.version('tiktoken')",
    `assert version == '${TOKENIZER_VERSION}', 'expected tiktoken ${TOKENIZER_VERSION}, got ' + version`,
    `enc = tiktoken.get_encoding('${TOKENIZER_ENCODING}')`,
    "texts = json.load(sys.stdin)",
    "print(json.dumps({'version': version, 'counts': [len(enc.encode(x, disallowed_special=())) for x in texts]}))",
  ].join("\n");
  let result: { version: string; counts: number[] };
  try {
    result = JSON.parse(execFileSync(python, ["-c", script], {
      input: JSON.stringify(events.map((event) => event.text)), timeout: 90_000,
      maxBuffer: 16 << 20, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TIKTOKEN_CACHE_DIR: path.join(ROOT, ".context/eval-tokenizer/cache") },
    }).toString());
  } catch (error: any) {
    throw new Error(`L01 tokenizer unavailable: install tiktoken==${TOKENIZER_VERSION} in .context/eval-tokenizer or set LEDGER_EVAL_TOKENIZER_PYTHON; ${String(error.stderr || error.message).slice(0, 300)}`);
  }
  if (result.counts.length !== events.length || result.counts.some((count) => !Number.isInteger(count) || count < 1)) throw new Error("L01 tokenizer returned invalid event counts");
  return {
    tokenizer: `tiktoken ${result.version} / ${TOKENIZER_ENCODING} (explicit tokenizer proxy; provider tokenizer not verified)`,
    tokenizer_version: result.version, encoding: TOKENIZER_ENCODING,
    measurement_kind: "explicit_tokenizer_proxy", provider_tokenizer_verified: false,
    counted_content: "Each original fixture event text once; excludes prompt rereads, system/tool schemas, assistant text, and batch separators.",
    measured_origin_tokens: result.counts.reduce((sum, count) => sum + count, 0),
    events: events.map((event, index) => ({ id: event.id, sha256: sha256(event.text), tokens: result.counts[index] })),
  };
}

/** Require every counted source to have actually reached a successful live origin transcript. */
export function verifyObservedHistory(events: FixtureEvent[], run: OriginRun): { id: string; session: string; producer_event_id: string; transcript: string }[] {
  const instructions = run.transcriptPaths.flatMap((file) => {
    const parsed = streamTranscript(file, 0, run.harness);
    const sid = run.turns.find((turn) => turn.transcriptPath === file)?.sessionId;
    if (!sid) throw new Error(`L01 transcript has no observed session: ${file}`);
    return parsed.events.filter((event) => event.kind === "instruction.added").map((event) => ({
      text: String(event.payload.text ?? ""), session: sid, producer_event_id: event.producer_event_id, transcript: file,
    }));
  });
  return events.map((event) => {
    const found = instructions.find((instruction) => instruction.text.includes(event.text));
    if (!found) throw new Error(`L01 counted event ${event.id} is absent from the actual normalized origin instructions`);
    return { id: event.id, session: found.session, producer_event_id: found.producer_event_id, transcript: found.transcript };
  });
}

interface ResetTrace {
  from_session: string;
  to_session: string;
  previous_ended_at: string;
  next_started_at: string;
  next_invocation: string;
  next_invocation_resume: false;
  mechanism: "fresh_harness_session_without_resume";
}

/** Four real sessions on the requested origin harness; the kit explicitly permits context resets. */
export async function runLongHistoryOrigin(ctx: TrialContext): Promise<OriginRun> {
  if (process.env.LEDGER_EVAL_FAKE_HARNESS === "1") throw new Error("L01 requires real origins; fake harness traces cannot establish history size or resets");
  const events = ctx.request.case.events;
  const batches = batchHistory(events);
  if (batches.length < LONG_EPOCHS) throw new Error(`L01 needs at least ${LONG_EPOCHS} capture-safe batches for real resets`);
  const measurement = measureHistory(events);
  writeJson(path.join(ctx.paths.rawDir, "long-history-preflight.json"), measurement);
  const minimum = ctx.request.case.stress_requirements?.minimum_origin_tokens ?? 100_000;
  if (measurement.measured_origin_tokens < minimum) throw new Error(`L01 unique source size ${measurement.measured_origin_tokens} is below ${minimum}; generate a larger frozen suite before live origin calls`);

  const epochs = Array.from({ length: LONG_EPOCHS }, (_, epoch) => batches.slice(
    Math.floor(epoch * batches.length / LONG_EPOCHS), Math.floor((epoch + 1) * batches.length / LONG_EPOCHS),
  ));
  let batchNumber = 0;
  const plan = epochs.flatMap((epochBatches, epoch) => epochBatches.map((batch) => ({
    batch: ++batchNumber, epoch: epoch + 1,
    event_ids: batch.events.map((event) => event.id), chars: batch.text.length, sha256: sha256(batch.text),
  })));
  writeJson(path.join(ctx.paths.rawDir, "long-history-plan.json"), {
    batch_char_cap: LONG_BATCH_CHARS, batch_count: batches.length, epoch_count: LONG_EPOCHS,
    model: ctx.originModel, harness: ctx.originHarness, plan,
  });
  const merged: OriginRun = { harness: ctx.originHarness, sessionIds: [], turns: [], transcriptPaths: [], totalInputTokens: 0, compactions: 0 };
  const resets: ResetTrace[] = [];
  let previousEnd: string | null = null;
  ctx.log(`L01: ${events.length} original events, ${measurement.measured_origin_tokens} unique proxy tokens, ${batches.length} bounded turns, ${LONG_EPOCHS} actual sessions`);

  for (let epoch = 0; epoch < LONG_EPOCHS; epoch++) {
    const selected = epochs[epoch];
    if (!selected.length) throw new Error(`L01 epoch ${epoch + 1} has no source events`);
    const rawDir = path.join(ctx.paths.rawDir, `origin-epoch-${epoch + 1}`);
    fs.mkdirSync(rawDir, { recursive: true });
    const epochEvents = selected.map((batch) => ({ ...batch.events[0], text: batch.text, session: "session-a" }));
    const run = await runOrigin({ ...ctx, paths: { ...ctx.paths, rawDir } }, epochEvents, {
      timeoutMs: Number(process.env.LEDGER_EVAL_LONG_TURN_TIMEOUT_MS) || 300_000,
    });
    const turns = run.turns as OriginTurnDetail[];
    if (turns.some((turn) => !turn.ok)) throw new Error(`L01 epoch ${epoch + 1} had unsuccessful origin turns; refusing a partial history`);
    if (run.sessionIds.length !== 1 || run.transcriptPaths.length !== 1 || merged.sessionIds.includes(run.sessionIds[0])) throw new Error(`L01 epoch ${epoch + 1} did not produce one distinct real origin session and transcript`);
    // runOrigin retains each complete transcript and its provenance in this epoch's rawDir.
    const invocationFile = path.join(rawDir, "origin-invocations.json");
    const invocation = JSON.parse(fs.readFileSync(invocationFile, "utf8")).invocations[0];
    if (invocation?.resume !== false || invocation.harness !== ctx.originHarness) throw new Error(`L01 epoch ${epoch + 1} first invocation was not a fresh origin-harness session`);
    const firstStart = Date.parse(turns[0].startedAt);
    const lastEnd = Date.parse(turns[turns.length - 1].endedAt);
    if (!Number.isFinite(firstStart) || !Number.isFinite(lastEnd) || lastEnd < firstStart) throw new Error(`L01 epoch ${epoch + 1} has invalid observed runtime timestamps`);
    if (previousEnd) {
      const nextStart = turns[0].startedAt;
      if (!Number.isFinite(Date.parse(nextStart)) || Date.parse(nextStart) < Date.parse(previousEnd)) throw new Error("L01 reset trace has invalid or overlapping epoch timestamps");
      resets.push({
        from_session: merged.sessionIds[merged.sessionIds.length - 1], to_session: run.sessionIds[0],
        previous_ended_at: previousEnd, next_started_at: nextStart,
        next_invocation: path.relative(ctx.paths.outputDir, invocationFile), next_invocation_resume: false,
        mechanism: "fresh_harness_session_without_resume",
      });
    }
    previousEnd = turns[turns.length - 1].endedAt;
    verifyObservedHistory(selected.flatMap((batch) => batch.events), run);
    merged.sessionIds.push(...run.sessionIds);
    merged.transcriptPaths.push(...run.transcriptPaths);
    merged.turns.push(...run.turns.map((turn) => ({ ...turn, turnIndex: merged.turns.length + turn.turnIndex })));
    merged.totalInputTokens += run.totalInputTokens;
    merged.compactions += run.compactions;
    writeJson(path.join(ctx.paths.rawDir, "long-history-progress.json"), { completed_epochs: epoch + 1, session_ids: merged.sessionIds, resets });
  }
  const verified = verifyObservedHistory(events, merged);
  const evidence = {
    ...measurement, model: ctx.originModel, harness: ctx.originHarness,
    native_compactions: merged.compactions, actual_fresh_session_resets: resets.length,
    reset_protocol: "Four sequential real fresh CLI origin sessions on the same requested harness; no resume flag across epochs, no synthetic compaction markers, no native single-session compaction claimed.",
    resets, verified_original_events: verified,
    transcripts: merged.transcriptPaths.map((file) => ({ path: path.relative(ctx.paths.outputDir, file), sha256: sha256(fs.readFileSync(file)) })),
  };
  writeJson(path.join(ctx.paths.rawDir, "long-history-measurement.json"), evidence);
  fs.writeFileSync(path.join(ctx.paths.rawDir, "context-usage.jsonl"), [...resets.map((reset) => ({ kind: "observed_session_reset", ...reset })), {
    kind: "unique_history_token_measurement", ...measurement,
  }].map((record) => JSON.stringify(record)).join("\n") + "\n");
  return merged;
}

export function collectLongHistory(ctx: TrialContext, origin: OriginRun, successor: SuccessorRun): { stress_file: string } {
  if (successor.bootTokens === null || !Number.isFinite(successor.bootTokens) || successor.bootTokens < 1) throw new Error("L01 successor boot token count is unmeasured; refusing an unverifiable stress artifact");
  const measured = JSON.parse(fs.readFileSync(path.join(ctx.paths.rawDir, "long-history-measurement.json"), "utf8"));
  if (measured.verified_original_events.length !== ctx.request.case.events.length) throw new Error("L01 stress data omits original source events");
  verifyObservedHistory(ctx.request.case.events, origin);
  writeJson(path.join(ctx.paths.outputDir, "stress.json"), {
    raw_trace_refs: ["raw/context-usage.jsonl", "raw/long-history-measurement.json", "raw/long-history-plan.json", "raw/successor-output.json"],
    compactions_or_resets: measured.native_compactions + measured.actual_fresh_session_resets,
    native_compactions: measured.native_compactions, fresh_session_resets: measured.actual_fresh_session_resets,
    measured_origin_tokens: measured.measured_origin_tokens,
    successor_boot_tokens: successor.bootTokens,
    successor_got_original_history_directly: false,
    tokenizer: measured.tokenizer, measurement_kind: measured.measurement_kind,
    provider_tokenizer_verified: false, reset_protocol: measured.reset_protocol,
    limitations: ["Token size uses the explicitly named tokenizer proxy, not a verified provider-specific tokenizer.", "Resets span four separate sessions; this does not demonstrate one exhausted origin context or native compaction retention.", "The separate kit stress check retains the configured boot-token ceiling, even when recall succeeds."],
  });
  return { stress_file: "stress.json" };
}
