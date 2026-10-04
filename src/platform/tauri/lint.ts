import { invoke } from "@tauri-apps/api/core";

/** Linters that check one saved file and report back into its editor. */
export const EXTERNAL_LINT_TOOLS = [
  "tflint",
  "ansible-lint",
  "golangci-lint",
] as const;

/** Runs over a whole Go project after a commit rather than on save. */
export const VULN_CHECK_TOOL = "govulncheck";

export type ExternalLintTool = (typeof EXTERNAL_LINT_TOOLS)[number];
export type LintToolId = ExternalLintTool | typeof VULN_CHECK_TOOL;

export type LintSeverity = "error" | "warning" | "info";

export interface LintDiagnostic {
  /** One-based, like the tools print it. */
  line: number;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  severity: LintSeverity;
  message: string;
  rule: string | null;
  source: string;
  url: string | null;
}

export interface LintReport {
  tool: string;
  /** False when the tool is not installed; `diagnostics` is then empty. */
  available: boolean;
  diagnostics: LintDiagnostic[];
  error: string | null;
}

export interface LintToolStatus {
  tool: string;
  available: boolean;
}

export interface VulnFinding {
  id: string;
  summary: string;
  module: string;
  foundVersion: string | null;
  fixedVersion: string | null;
  url: string | null;
  /** Absolute path of the source file that reaches the vulnerable code. */
  path: string | null;
  line: number | null;
  column: number | null;
}

export interface VulnReport {
  available: boolean;
  /** Go modules found under the root; zero means there was nothing to check. */
  modules: number;
  findings: VulnFinding[];
  error: string | null;
}

/**
 * Lints the file as it is on disk. Local projects only: the command rejects
 * remote paths, so callers skip those instead of asking.
 */
export async function externalLint(
  tool: ExternalLintTool,
  path: string,
  root: string,
): Promise<LintReport> {
  return invoke<LintReport>("external_lint", { tool, path, root });
}

export async function externalLintTools(): Promise<LintToolStatus[]> {
  return invoke<LintToolStatus[]>("external_lint_tools");
}

export async function vulnCheck(root: string): Promise<VulnReport> {
  return invoke<VulnReport>("vuln_check", { root });
}
