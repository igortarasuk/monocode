import { describe, expect, it } from "vitest";
import { hygieneProblems, lastActivityMs, sprintHygiene } from "./hygiene";
import type { LinearSprintIssue } from "./sprint";

const DAY = 24 * 3600 * 1000;
const now = Date.parse("2026-10-09T12:00:00.000Z");

function issue(patch: Partial<LinearSprintIssue>): LinearSprintIssue {
  return {
    id: patch.identifier ?? "id",
    identifier: "ENG-1",
    title: "Step",
    url: "https://linear.app/acme/issue/ENG-1",
    state: "Todo",
    stateType: "unstarted",
    estimate: 1,
    dueDate: "2026-10-12",
    completedAt: null,
    plannedHours: null,
    parentIdentifier: "",
    childCount: 0,
    projectName: "Platform",
    hasDescription: true,
    labelIds: ["l-ops"],
    lastCommentAt: null,
    issue: {
      labels: [{ name: "ops", color: "4ea7fc" }],
      updatedAt: "2026-10-09T08:00:00.000Z",
    } as LinearSprintIssue["issue"],
    ...patch,
  };
}

const context = { today: "2026-10-09", staleAfterMs: 7 * DAY, nowMs: now };
const codes = (problems: { code: string }[]) => problems.map((p) => p.code);

describe("hygieneProblems", () => {
  it("is empty for a complete issue", () => {
    expect(hygieneProblems(issue({}), context)).toEqual([]);
  });

  it("flags the fields the report scores", () => {
    const bare = issue({
      dueDate: null,
      estimate: null,
      hasDescription: false,
      issue: { labels: [], updatedAt: "2026-10-09T08:00:00.000Z" } as LinearSprintIssue["issue"],
    });
    expect(codes(hygieneProblems(bare, context))).toEqual([
      "no-due",
      "no-labels",
      "no-estimate",
      "no-description",
    ]);
  });

  it("keeps field problems on done issues but drops date ones", () => {
    const done = issue({
      stateType: "completed",
      dueDate: "2026-10-01",
      issue: { labels: [], updatedAt: "2026-10-09T08:00:00.000Z" } as LinearSprintIssue["issue"],
    });
    expect(codes(hygieneProblems(done, context))).toEqual(["no-labels"]);
  });

  it("separates due today from overdue", () => {
    expect(codes(hygieneProblems(issue({ dueDate: "2026-10-09" }), context))).toEqual([
      "due-today",
    ]);
    expect(codes(hygieneProblems(issue({ dueDate: "2026-10-08" }), context))).toEqual([
      "overdue",
    ]);
  });

  it("flags open work without a comment or change for a week", () => {
    const quiet = issue({
      stateType: "unstarted",
      issue: {
        labels: [{ name: "ops", color: "" }],
        updatedAt: "2026-09-30T08:00:00.000Z",
      } as LinearSprintIssue["issue"],
    });
    const problems = hygieneProblems(quiet, context);
    expect(codes(problems)).toEqual(["stale"]);
    expect(problems[0].label).toBe("no update 9d");
    expect(problems[0].hint).toMatch(/comment/);
    // A fresh comment counts as activity even when fields did not change.
    expect(
      hygieneProblems({ ...quiet, lastCommentAt: "2026-10-07T08:00:00.000Z" }, context),
    ).toEqual([]);
    expect(hygieneProblems({ ...quiet, stateType: "completed" }, context)).toEqual([]);
  });

  it("takes the newest of change and comment as activity", () => {
    const base = issue({ lastCommentAt: "2026-10-09T10:00:00.000Z" });
    expect(lastActivityMs(base)).toBe(Date.parse("2026-10-09T10:00:00.000Z"));
    expect(
      lastActivityMs(issue({ issue: { updatedAt: "" } as LinearSprintIssue["issue"] })),
    ).toBeNull();
  });

  it("does not count a parent without hours as missing an estimate", () => {
    const parent = issue({ childCount: 2, estimate: null });
    expect(hygieneProblems(parent, context)).toEqual([]);
  });
});

describe("sprintHygiene", () => {
  const cycle = {
    id: "c76",
    number: 76,
    startsAt: "2026-10-04T21:00:00.000Z",
    endsAt: "2026-10-11T21:00:00.000Z",
  };

  it("flags a parent due before its open subtasks", () => {
    const result = sprintHygiene(
      {
        cycle,
        issues: [
          issue({ identifier: "ENG-10", childCount: 2, estimate: null, dueDate: "2026-10-09" }),
          issue({ identifier: "ENG-11", parentIdentifier: "ENG-10", dueDate: "2026-10-13" }),
          issue({
            identifier: "ENG-12",
            parentIdentifier: "ENG-10",
            dueDate: "2026-10-20",
            stateType: "completed",
          }),
        ],
      },
      "2026-10-09",
      now,
    );
    expect(result.count).toBe(1);
    const parent = result.byIssue.get("ENG-10")!;
    expect(codes(parent)).toEqual(["due-today", "parent-due"]);
    expect(parent[1].hint).toContain("2026-10-13");
  });

});
