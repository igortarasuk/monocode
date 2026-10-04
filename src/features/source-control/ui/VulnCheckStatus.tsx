import { useEffect, useState, useSyncExternalStore } from "react";
import {
  subscribeVulnCheck,
  vulnCheckState,
  vulnCheckSummary,
  vulnCount,
  type VulnCheckState,
} from "../model/vulnCheck";

/** A clean result is good news that does not need to stay on screen. */
const CLEAN_RESULT_MS = 4000;

/**
 * The post-commit govulncheck result, beside the Changes title. Findings stay
 * until the next check; everything else is a passing note.
 */
export function VulnCheckStatus({ cwd }: { cwd: string }) {
  const state = useSyncExternalStore(
    subscribeVulnCheck,
    () => vulnCheckState(cwd),
    () => vulnCheckState(cwd),
  );
  const [dismissed, setDismissed] = useState<VulnCheckState | null>(null);
  const report = state.report;
  const pinned =
    state.running || Boolean(report && (report.error || vulnCount(report) > 0));

  useEffect(() => {
    if (pinned) return;
    const timer = window.setTimeout(() => setDismissed(state), CLEAN_RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [pinned, state]);

  const summary = dismissed === state ? null : vulnCheckSummary(state);
  if (!summary) return null;

  const found = !state.running && report && vulnCount(report) > 0;
  return (
    <span
      role="status"
      title={detail(state)}
      className={`min-w-0 truncate text-[11px] ${
        found ? "text-amber-400" : "text-content/50"
      }`}
    >
      {summary}
    </span>
  );
}

function detail(state: VulnCheckState): string | undefined {
  const report = state.report;
  if (state.running || !report) return undefined;
  if (report.error) return report.error;
  const lines = new Map<string, string>();
  for (const finding of report.findings) {
    const fix = finding.fixedVersion
      ? ` (fixed in ${finding.module}@${finding.fixedVersion})`
      : "";
    lines.set(finding.id, `${finding.id}: ${finding.summary}${fix}`);
  }
  return lines.size ? [...lines.values()].join("\n") : undefined;
}
