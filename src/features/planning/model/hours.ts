import { invoke } from "@tauri-apps/api/core";
import type { LinearSprintIssue, SprintPlan } from "./sprint";

export type TimeEntry = {
  id: string;
  issueId: string;
  identifier: string;
  day: string;
  hours: number;
  note: string;
  createdAt: number;
};

export type SessionHint = {
  sessionId: string;
  title: string;
  startedAt: number;
  lastActiveAt: number;
};

export type IssueHours = {
  issueId: string;
  planned: number | null;
  spent: number;
  entries: TimeEntry[];
  sessions: SessionHint[];
};

export type PlanSource = "local" | "marker" | "linear" | "none";

export function loadIssueHours(
  issues: readonly LinearSprintIssue[],
): Promise<IssueHours[]> {
  return invoke<IssueHours[]>("planning_hours", {
    issueIds: issues.map((issue) => issue.id),
    identifiers: issues.map((issue) => issue.identifier),
  });
}

export function setPlannedHours(
  issue: LinearSprintIssue,
  hours: number | null,
): Promise<void> {
  return invoke("planning_set_planned", {
    issueId: issue.id,
    identifier: issue.identifier,
    hours,
  });
}

export function logTime(
  issue: LinearSprintIssue,
  day: string,
  hours: number,
  note: string,
): Promise<TimeEntry> {
  return invoke<TimeEntry>("planning_log_time", {
    issueId: issue.id,
    identifier: issue.identifier,
    day,
    hours,
    note,
  });
}

export function deleteTimeEntry(id: string): Promise<void> {
  return invoke("planning_delete_entry", { id });
}

export function loadSpentByDay(
  from: string,
  to: string,
): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("planning_spent_by_day", { from, to });
}

/** Local plan first, then the linear.sh marker, then the Linear estimate. */
export function plannedFor(
  issue: LinearSprintIssue,
  hours: IssueHours | undefined,
): { hours: number | null; source: PlanSource } {
  if (hours?.planned != null) return { hours: hours.planned, source: "local" };
  if (issue.plannedHours != null) {
    return { hours: issue.plannedHours, source: "marker" };
  }
  if (issue.estimate != null) return { hours: issue.estimate, source: "linear" };
  return { hours: null, source: "none" };
}

/** Wall-clock span of linked sessions; a hint, never counted as spent. */
export function sessionSpanHours(sessions: readonly SessionHint[]): number {
  const ms = sessions.reduce(
    (sum, s) => sum + Math.max(0, s.lastActiveAt - s.startedAt),
    0,
  );
  return Math.round((ms / 3_600_000) * 10) / 10;
}

export type HoursSummary = {
  planned: number;
  spent: number;
  /** Positive means over plan, negative means hours saved. */
  delta: number;
  plannedByDay: Record<string, number>;
  spentByDay: Record<string, number>;
};

/** Plan and fact for the cycle's leaves; parents never count. */
export function summarizeHours(
  plan: SprintPlan,
  hoursById: ReadonlyMap<string, IssueHours>,
  spentByDay: Record<string, number>,
): HoursSummary {
  const leaves = [...plan.days.flatMap((day) => day.issues), ...plan.unscheduled];
  let planned = 0;
  let spent = 0;
  const plannedByDay: Record<string, number> = {};
  for (const issue of leaves) {
    const hours = hoursById.get(issue.id);
    const planHours = plannedFor(issue, hours).hours ?? 0;
    planned += planHours;
    spent += hours?.spent ?? 0;
    if (issue.dueDate) {
      plannedByDay[issue.dueDate] = (plannedByDay[issue.dueDate] ?? 0) + planHours;
    }
  }
  return {
    planned,
    spent,
    delta: spent - planned,
    plannedByDay,
    spentByDay,
  };
}
