import { invoke } from "@tauri-apps/api/core";
import type { LinearIssue } from "../../inbox/model/linear";

export type LinearCycle = {
  id: string;
  number: number;
  startsAt: string;
  endsAt: string;
};

export type LinearSprintIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  estimate: number | null;
  dueDate: string | null;
  completedAt: string | null;
  plannedHours: number | null;
  parentIdentifier: string;
  childCount: number;
  projectName: string;
  hasDescription: boolean;
  labelIds: string[];
  lastCommentAt: string | null;
  issue: LinearIssue;
};

export type LinearLabelOption = {
  id: string;
  name: string;
  color: string;
};

export type LinearState = {
  id: string;
  name: string;
  type: string;
  position: number;
};

export type LinearSprint = {
  cycle: LinearCycle | null;
  issues: LinearSprintIssue[];
};

export type SprintDay = {
  date: string;
  issues: LinearSprintIssue[];
  hours: number;
};

export type SprintPlan = {
  days: SprintDay[];
  unscheduled: LinearSprintIssue[];
  parents: LinearSprintIssue[];
  totalHours: number;
  doneHours: number;
};

export const DAY_CAPACITY_HOURS = 8;
export const WEEK_TARGET_HOURS = 40;

/** `offset` 0 is the team's active cycle, 1 the next one, -1 the previous. */
export function loadLinearSprint(
  teamId: string,
  offset: number,
): Promise<LinearSprint> {
  return invoke<LinearSprint>("linear_sprint", { teamId, offset });
}

export function loadTeamStates(teamId: string): Promise<LinearState[]> {
  return invoke<LinearState[]>("linear_team_states", { teamId });
}

export function setIssueState(
  id: string,
  stateId: string,
): Promise<LinearState> {
  return invoke<LinearState>("linear_issue_set_state", { id, stateId });
}

export function loadTeamLabels(teamId: string): Promise<LinearLabelOption[]> {
  return invoke<LinearLabelOption[]>("linear_team_labels", { teamId });
}

/** Replaces the labels; Linear needs at least one. */
export function setIssueLabels(
  id: string,
  labelIds: readonly string[],
): Promise<string[]> {
  return invoke<string[]>("linear_issue_set_labels", { id, labelIds });
}

/** Empty `dueDate` clears the deadline; resolves to what Linear stored. */
export function setIssueDueDate(
  id: string,
  dueDate: string,
): Promise<string | null> {
  return invoke<string | null>("linear_issue_set_due_date", { id, dueDate });
}

/** Closes through In Progress with a comment, like `linear.sh close`. */
export function closeIssue(
  issue: LinearSprintIssue,
  comment: string,
  states: LinearState[],
): Promise<LinearState> {
  const done = doneState(states);
  if (!done) return Promise.reject(new Error("This team has no Done state"));
  const started = startedState(states);
  return invoke<LinearState>("linear_issue_close", {
    id: issue.id,
    comment,
    startedStateId: started?.id ?? "",
    doneStateId: done.id,
    viaStarted: issue.stateType !== "started",
  });
}

/** Teams add custom completed states, so prefer the one named Done. */
export function doneState(states: LinearState[]): LinearState | null {
  const completed = states.filter((state) => state.type === "completed");
  return (
    completed.find((state) => state.name.toLowerCase() === "done") ??
    [...completed].sort((a, b) => a.position - b.position)[0] ??
    null
  );
}

/** Teams add custom started states, so prefer the one named In Progress. */
export function startedState(states: LinearState[]): LinearState | null {
  const started = states.filter((state) => state.type === "started");
  return (
    started.find((state) => state.name.toLowerCase() === "in progress") ??
    [...started].sort((a, b) => a.position - b.position)[0] ??
    null
  );
}

/** `YYYY-MM-DD` plus `days`, in local time; used for the 3-day start deadline. */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return localDateKey(new Date(year, month - 1, day + days));
}

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function sprintWeekdays(
  cycle: LinearCycle,
  toLocal: (iso: string) => Date = (iso) => new Date(iso),
): string[] {
  const start = toLocal(cycle.startsAt);
  const end = toLocal(cycle.endsAt);
  const days: string[] = [];
  const cursor = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  while (cursor < end && days.length < 31) {
    const weekday = cursor.getDay();
    if (weekday >= 1 && weekday <= 5) days.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function issueHours(issue: LinearSprintIssue): number {
  return issue.estimate ?? 0;
}

export function isDone(issue: LinearSprintIssue): boolean {
  return issue.stateType === "completed";
}

export function isOverdue(issue: LinearSprintIssue, today: string): boolean {
  return !isDone(issue) && !!issue.dueDate && issue.dueDate < today;
}

/**
 * The day a leaf belongs to on the calendar: done work sits on the day it
 * was closed, so a Friday deadline closed on Monday shows under Monday.
 */
export function placementDate(
  issue: LinearSprintIssue,
  toLocal: (iso: string) => Date = (iso) => new Date(iso),
): string | null {
  if (isDone(issue) && issue.completedAt) {
    const closed = toLocal(issue.completedAt);
    if (!Number.isNaN(closed.getTime())) return localDateKey(closed);
  }
  return issue.dueDate;
}

/** Parents are shown apart and never counted, like `linear.sh week`. */
export function buildSprintPlan(
  sprint: LinearSprint,
  toLocal?: (iso: string) => Date,
): SprintPlan {
  const weekdays = sprint.cycle ? sprintWeekdays(sprint.cycle, toLocal) : [];
  const days: SprintDay[] = weekdays.map((date) => ({
    date,
    issues: [],
    hours: 0,
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const unscheduled: LinearSprintIssue[] = [];
  const parents: LinearSprintIssue[] = [];
  let totalHours = 0;
  let doneHours = 0;
  const ordered = [...sprint.issues].sort((a, b) =>
    a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
  );
  for (const issue of ordered) {
    if (issue.childCount > 0) {
      parents.push(issue);
      continue;
    }
    const hours = issueHours(issue);
    totalHours += hours;
    if (isDone(issue)) doneHours += hours;
    const placed = placementDate(issue, toLocal);
    const day = placed ? byDate.get(placed) : undefined;
    if (day) {
      day.issues.push(issue);
      day.hours += hours;
    } else {
      unscheduled.push(issue);
    }
  }
  return { days, unscheduled, parents, totalHours, doneHours };
}
