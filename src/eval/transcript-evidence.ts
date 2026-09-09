import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Harness } from "./types.js";

/** Keep the complete producer file, including startup context that normalization omits. */
export function retainTranscript(rawDir: string, source: string, identity: {
  role: "origin" | "successor";
  harness: Harness;
  sessionId: string;
  synthetic: boolean;
}): { path: string; provenancePath: string; sha256: string } {
  const sourcePath = path.resolve(source);
  const sourceRealpath = fs.realpathSync(sourcePath);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`transcript is not a file: ${sourcePath}`);
  const bytes = fs.readFileSync(sourcePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(rawDir, "transcripts", identity.role, identity.harness);
  fs.mkdirSync(dir, { recursive: true });
  const retainedPath = path.resolve(dir, path.basename(sourcePath));
  // A caller may already have retained this file (including through a directory alias).
  const sameFile = fs.existsSync(retainedPath) && fs.realpathSync(retainedPath) === sourceRealpath;
  if (!sameFile) fs.writeFileSync(retainedPath, bytes, { mode: 0o600 });
  if (!fs.readFileSync(retainedPath).equals(bytes)) throw new Error(`transcript retention verification failed: ${retainedPath}`);
  const provenancePath = retainedPath + ".provenance.json";
  // Keep the original producer location when a retained file is passed a second time.
  if (!sameFile || !fs.existsSync(provenancePath)) {
    fs.writeFileSync(provenancePath, JSON.stringify({
      schema_version: 1, artifact_kind: "complete_harness_transcript", role: identity.role,
      harness: identity.harness, session_id: identity.sessionId, synthetic: identity.synthetic,
      source_path: sourcePath, source_realpath: sourceRealpath, source_mtime: stat.mtime.toISOString(),
      retained_path: retainedPath, raw_relative_path: path.relative(rawDir, retainedPath),
      bytes: bytes.length, sha256, captured_at: new Date().toISOString(), byte_equality_verified: true,
    }, null, 2) + "\n", { mode: 0o600 });
  }
  return { path: retainedPath, provenancePath, sha256 };
}
