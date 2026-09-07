/**
 * Best-effort secret redaction and path denial for everything that leaves the
 * machine: event payloads, artifacts, and shadow-commit trees. Regexes catch
 * known token shapes; the deny list catches files that should never upload.
 * This is a filter, not a guarantee, and the spec says so.
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bnpg_[A-Za-z0-9]{8,}\b/g, "[REDACTED_NEON_PASSWORD]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  // credentials embedded in URLs: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)(@)/gi, "$1[REDACTED]$3"],
  // Bearer / Basic auth headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"],
  // KEY=value or "key": "value" for secret-looking names
  [/\b((?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|client[_-]?secret|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_-]*)(\s*[=:]\s*["']?)([^\s"',;]{8,})/gi, "$1$2[REDACTED]"],
];

export function redactText(s: string): { text: string; hits: number } {
  let text = s;
  let hits = 0;
  for (const [re, rep] of PATTERNS) {
    text = text.replace(re, (...m) => {
      hits++;
      return typeof rep === "string" ? rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "") : rep;
    });
  }
  return { text, hits };
}

/** Repo-relative globs that never leave the machine. Config `continuity.deny` extends this. */
export const DEFAULT_DENY_GLOBS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "*.p12",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/secrets/**",
  "**/credentials*",
  "**/*.keystore",
  "**/*.jks",
  "**/service-account*.json",
  "**/.npmrc",
  "**/.netrc",
];

/** Always excluded from shadow commits even if tracked: they are reproducible or enormous. */
export const DEFAULT_SNAPSHOT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.turbo/**", "**/target/**", "**/__pycache__/**", "**/.venv/**"];

/** Tiny glob → regex: `**` any path, `*` within a segment, `?` one char. Anchored to the whole repo-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more segments; trailing `**` matches the rest
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, globs: string[]): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g).test(p) || globToRegExp(g).test(p.split("/").pop() ?? p));
}

export function isDeniedPath(relPath: string, extra: string[] = []): boolean {
  return matchesAny(relPath, [...DEFAULT_DENY_GLOBS, ...extra]);
}
