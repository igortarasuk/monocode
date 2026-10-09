import {
  isDone,
  isOverdue,
  type LinearSprint,
  type LinearSprintIssue,
} from "./sprint";

/** One thing a Linear hygiene report would score against the issue. */
export type HygieneProblem = {
  code:
    | "no-due"
    | "no-labels"
    | "no-estimate"
    | "no-description"
    | "overdue"
    | "due-today"
    | "stale"
    | "parent-due";
  /** Short chip text for the calendar card. */
  label: string;
  /** What to do about it, for the detail panel. */
  hint: string;
};

export type HygieneContext = {
  today: string;
  /** Milliseconds an open issue may go without a comment or change. */
  staleAfterMs?: number;
  /** Now, for the stale check; defaults to the wall clock. */
  nowMs?: number;
  /** Latest due date among the issue's open subtasks, if it has any. */
  latestChildDue?: string | null;
};

const DAY_MS = 24 * 3600 * 1000;
/** A week without a comment or change is what the report calls untouched. */
export const STALE_AFTER_MS = 7 * DAY_MS;

/** Newest of the last field change and the last comment, as epoch ms. */
export function lastActivityMs(issue: LinearSprintIssue): number | null {
  const stamps = [issue.issue.updatedAt, issue.lastCommentAt]
    .map((at) => (at ? Date.parse(at) : Number.NaN))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * Field problems are reported on done issues too: the report counts fields on
 * every issue touched in the period. Date problems only matter while open.
 */
export function hygieneProblems(
  issue: LinearSprintIssue,
  context: HygieneContext,
): HygieneProblem[] {
  const problems: HygieneProblem[] = [];
  const done = isDone(issue);
  const open = !done && issue.stateType !== "canceled";
  if (!issue.dueDate) {
    problems.push({
      code: "no-due",
      label: "no due date",
      hint: "Set a due date; open work without one is scored as late.",
    });
  }
  if ((issue.issue.labels ?? []).length === 0) {
    problems.push({
      code: "no-labels",
      label: "no label",
      hint: "Add at least one label.",
    });
  }
  if (issue.estimate == null && issue.childCount === 0) {
    problems.push({
      code: "no-estimate",
      label: "no estimate",
      hint: "Set the hours; 1 is the minimum.",
    });
  }
  if (!issue.hasDescription) {
    problems.push({
      code: "no-description",
      label: "no description",
      hint: "Write what the result is; the report counts an empty description.",
    });
  }
  if (open && isOverdue(issue, context.today)) {
    problems.push({
      code: "overdue",
      label: "overdue",
      hint: "Close it or move the due date; every open day counts.",
    });
  } else if (open && issue.dueDate === context.today) {
    problems.push({
      code: "due-today",
      label: "due today",
      hint: "Close it today or move the due date now; closing tomorrow is scored late.",
    });
  }
  if (open) {
    const activity = lastActivityMs(issue);
    const idle = (context.nowMs ?? Date.now()) - (activity ?? Number.NaN);
    if (activity != null && idle > (context.staleAfterMs ?? STALE_AFTER_MS)) {
      problems.push({
        code: "stale",
        label: `no update ${Math.floor(idle / DAY_MS)}d`,
        hint: "No comment or change for a week: post a progress comment below, move it, or close it.",
      });
    }
  }
  if (
    open &&
    issue.childCount > 0 &&
    issue.dueDate &&
    context.latestChildDue &&
    issue.dueDate < context.latestChildDue
  ) {
    problems.push({
      code: "parent-due",
      label: "due before subtasks",
      hint: `Subtasks run until ${context.latestChildDue}; move the parent's due date there.`,
    });
  }
  return problems;
}

export type SprintHygiene = {
  byIssue: Map<string, HygieneProblem[]>;
  /** Issues with at least one problem. */
  count: number;
};

/** Children only count when they are in the same sprint load. */
export function sprintHygiene(
  sprint: LinearSprint,
  today: string,
  nowMs: number = Date.now(),
): SprintHygiene {
  const latestChildDue = new Map<string, string>();
  for (const issue of sprint.issues) {
    if (!issue.parentIdentifier || !issue.dueDate || isDone(issue)) continue;
    const current = latestChildDue.get(issue.parentIdentifier);
    if (!current || issue.dueDate > current) {
      latestChildDue.set(issue.parentIdentifier, issue.dueDate);
    }
  }
  const byIssue = new Map<string, HygieneProblem[]>();
  for (const issue of sprint.issues) {
    const problems = hygieneProblems(issue, {
      today,
      nowMs,
      latestChildDue: latestChildDue.get(issue.identifier) ?? null,
    });
    if (problems.length) byIssue.set(issue.id, problems);
  }
  return { byIssue, count: byIssue.size };
}
