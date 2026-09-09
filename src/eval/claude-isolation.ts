/**
 * Claude Code 2.1.258: --setting-sources accepts an empty list and --settings
 * overrides that session only. Keep subscription authentication and explicit MCP;
 * --bare removes OAuth and --safe-mode removes the condition's MCP tools.
 *
 * Official references checked 2026-09-09:
 * https://code.claude.com/docs/en/agent-sdk/claude-code-features
 * https://code.claude.com/docs/en/settings
 * https://code.claude.com/docs/en/memory
 * Managed policy remains authoritative; these flags isolate user/project/local customizations.
 */
export const CLAUDE_EVAL_SETTINGS = Object.freeze({
  disableAllHooks: true,
  autoMemoryEnabled: false,
  claudeMdExcludes: ["**"],
});

/** No global hooks, skills, instructions, settings, or auto-memory; trial MCP is configured separately. */
export function claudeIsolationArgs(): string[] {
  return ["--setting-sources", "", "--settings", JSON.stringify(CLAUDE_EVAL_SETTINGS), "--disable-slash-commands"];
}

export function claudeClassifierArgs(mcpConfigPath: string): string[] {
  return ["-p", "--output-format", "text", "--no-session-persistence", "--tools", "", ...claudeIsolationArgs(), "--mcp-config", mcpConfigPath, "--strict-mcp-config"];
}
