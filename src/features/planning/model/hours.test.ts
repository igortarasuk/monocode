import { describe, expect, it } from "vitest";
import {
  plannedFor,
  sessionSpanHours,
  summarizeHours,
  type IssueHours,
} from "./hours";
import type { LinearSprintIssue, SprintPlan } from "./sprint";

function issue(patch: Partial<LinearSprintIssue>): LinearSprintIssue {
  return {
    id: "i1",
    identifier: "ENG-1",
    title: "Step",
    url: "",
    state: "Todo",
    stateType: "unstarted",
    estimate: 1,
    dueDate: "2026-09-29",
    completedAt: null,
    plannedHours: null,
    parentIdentifier: "",
    childCount: 0,
    projectName: "",
    hasDescription: true,
    labelIds: [],
    lastCommentAt: null,
    issue: {} as LinearSprintIssue["issue"],
    ...patch,
  };
}

function hours(patch: Partial<IssueHours>): IssueHours {
  return { issueId: "i1", planned: null, spent: 0, entries: [], sessions: [], ...patch };
}

describe("plannedFor", () => {
  it("prefers the local plan, then the marker, then the estimate", () => {
    const withMarker = issue({ plannedHours: 3, estimate: 1 });
    expect(plannedFor(withMarker, hours({ planned: 5 }))).toEqual({
      hours: 5,
      source: "local",
    });
    expect(plannedFor(withMarker, undefined)).toEqual({ hours: 3, source: "marker" });
    expect(plannedFor(issue({ estimate: 2 }), undefined)).toEqual({
      hours: 2,
      source: "linear",
    });
    expect(plannedFor(issue({ estimate: null }), undefined).source).toBe("none");
  });
});

describe("sessionSpanHours", () => {
  it("sums session spans to a tenth of an hour", () => {
    expect(
      sessionSpanHours([
        { sessionId: "a", title: "", startedAt: 0, lastActiveAt: 5_400_000 },
        { sessionId: "b", title: "", startedAt: 10, lastActiveAt: 0 },
      ]),
    ).toBe(1.5);
  });
});

describe("summarizeHours", () => {
  it("reports plan, fact and whether hours were saved", () => {
    const a = issue({ id: "a", plannedHours: 4, dueDate: "2026-09-29" });
    const b = issue({ id: "b", estimate: 2, dueDate: null });
    const plan: SprintPlan = {
      days: [{ date: "2026-09-29", issues: [a], hours: 1 }],
      unscheduled: [b],
      parents: [issue({ id: "p", childCount: 2, estimate: 9 })],
      totalHours: 3,
      doneHours: 0,
    };
    const byId = new Map([
      ["a", hours({ issueId: "a", spent: 3 })],
      ["b", hours({ issueId: "b", spent: 1.5 })],
    ]);
    const summary = summarizeHours(plan, byId, { "2026-09-29": 3 });
    expect(summary.planned).toBe(6);
    expect(summary.spent).toBe(4.5);
    expect(summary.delta).toBe(-1.5);
    expect(summary.plannedByDay).toEqual({ "2026-09-29": 4 });
  });

  it("counts a leaf on the day the calendar placed it", () => {
    const moved = issue({ id: "m", estimate: 2, dueDate: "2026-09-28" });
    const plan: SprintPlan = {
      days: [{ date: "2026-09-30", issues: [moved], hours: 2 }],
      unscheduled: [],
      parents: [],
      totalHours: 2,
      doneHours: 2,
    };
    expect(summarizeHours(plan, new Map(), {}).plannedByDay).toEqual({ "2026-09-30": 2 });
  });
});
