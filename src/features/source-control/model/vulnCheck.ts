import {
  VULN_CHECK_TOOL,
  vulnCheck,
  type VulnFinding,
  type VulnReport,
} from "../../../platform/tauri/lint";
import { slash } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { loadLintToolEnabled } from "../../settings/model/lintTools";

/**
 * govulncheck results per project, refreshed after each commit.
 *
 * The check walks every Go module under the project and can take a while, so
 * it runs in the background like a post-commit hook: the commit never waits on
 * it and never fails because of it. Editors and the Changes header read the
 * latest report from here.
 */

export type VulnCheckState = {
  running: boolean;
  /** The last finished check; kept while the next one runs. */
  report: VulnReport | null;
};

const IDLE: VulnCheckState = { running: false, report: null };

const states = new Map<string, VulnCheckState>();
/** Projects committed to again while their check was still running. */
const queued = new Set<string>();
const listeners = new Set<() => void>();

function publish(cwd: string, state: VulnCheckState) {
  states.set(cwd, state);
  for (const listener of [...listeners]) listener();
}

export function subscribeVulnCheck(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function vulnCheckState(cwd: string): VulnCheckState {
  return states.get(cwd) ?? IDLE;
}

function canCheck(cwd: string): boolean {
  return (
    Boolean(cwd) &&
    cwd !== "~" &&
    !slash(cwd).startsWith(REMOTE_PATH_PREFIX) &&
    loadLintToolEnabled(VULN_CHECK_TOOL)
  );
}

/**
 * Fire-and-forget: resolves once the check (and any rerun a later commit
 * asked for) has finished, and never rejects.
 */
export async function runVulnCheck(cwd: string): Promise<void> {
  if (!canCheck(cwd)) return;
  if (vulnCheckState(cwd).running) {
    // The running check may have read the tree before this commit landed.
    queued.add(cwd);
    return;
  }
  do {
    queued.delete(cwd);
    publish(cwd, { ...vulnCheckState(cwd), running: true });
    let report: VulnReport;
    try {
      report = await vulnCheck(cwd);
    } catch (error) {
      report = {
        available: true,
        modules: 0,
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    publish(cwd, { running: false, report });
  } while (queued.has(cwd) && canCheck(cwd));
  queued.delete(cwd);
}

/** Findings that point into this file, from whichever project reported them. */
export function vulnFindingsForFile(path: string): VulnFinding[] {
  const target = slash(path);
  const findings: VulnFinding[] = [];
  for (const { report } of states.values()) {
    for (const finding of report?.findings ?? []) {
      if (finding.path && slash(finding.path) === target) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

/** A finding is listed once per call site; the header counts vulnerabilities. */
export function vulnCount(report: VulnReport): number {
  return new Set(report.findings.map((finding) => finding.id)).size;
}

/** One quiet line for the Changes header, or null when there is nothing to say. */
export function vulnCheckSummary(state: VulnCheckState): string | null {
  if (state.running) return `${VULN_CHECK_TOOL}: checking…`;
  const report = state.report;
  // No Go modules, or no govulncheck: the project was never a candidate.
  if (!report || !report.available) return null;
  if (report.error) return `${VULN_CHECK_TOOL} failed`;
  if (report.modules === 0) return null;
  const count = vulnCount(report);
  if (count === 0) return `${VULN_CHECK_TOOL}: no vulnerabilities`;
  return `${VULN_CHECK_TOOL}: ${count} ${
    count === 1 ? "vulnerability" : "vulnerabilities"
  } found`;
}

/** Test seam: forget every report. */
export function resetVulnChecks() {
  states.clear();
  queued.clear();
}
