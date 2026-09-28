import { describe, expect, it } from "vitest";
import {
  buildSprintPlan,
  isOverdue,
  sprintWeekdays,
  startedState,
  type LinearSprint,
  type LinearSprintIssue,
} from "./sprint";

// Bounds as Linear returns them for a Europe/Kyiv (UTC+3) team.
const cycle = {
  id: "c74",
  number: 74,
  startsAt: "2026-09-27T21:00:00.000Z",
  endsAt: "2026-10-04T21:00:00.000Z",
};

// Reads the ISO instant as wall-clock time at UTC+3, independent of the
// machine's zone, so the test pins the Sunday-21:00Z edge.
const kyiv = (iso: string) => {
  const shifted = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  return new Date(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    shifted.getUTCHours(),
  );
};

function issue(patch: Partial<LinearSprintIssue>): LinearSprintIssue {
  return {
    id: patch.identifier ?? "id",
    identifier: "ENG-1",
    title: "Step",
    url: "https://linear.app/acme/issue/ENG-1",
    state: "Todo",
    stateType: "unstarted",
    estimate: 1,
    dueDate: "2026-09-28",
    plannedHours: null,
    parentIdentifier: "",
    childCount: 0,
    projectName: "Platform",
    issue: {} as LinearSprintIssue["issue"],
    ...patch,
  };
}

describe("sprintWeekdays", () => {
  it("starts on the local Monday, not the UTC Sunday", () => {
    expect(sprintWeekdays(cycle, kyiv)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
  });
});

describe("buildSprintPlan", () => {
  const sprint: LinearSprint = {
    cycle,
    issues: [
      issue({
        identifier: "ENG-10",
        childCount: 3,
        estimate: 1,
        dueDate: "2026-10-09",
      }),
      issue({ identifier: "ENG-2", estimate: 4, dueDate: "2026-09-29" }),
      issue({ identifier: "ENG-3", estimate: 5, dueDate: "2026-09-29" }),
      issue({
        identifier: "ENG-4",
        estimate: 2,
        dueDate: "2026-09-28",
        stateType: "completed",
      }),
      issue({ identifier: "ENG-5", estimate: null, dueDate: null }),
    ],
  };
  const plan = buildSprintPlan(sprint, kyiv);

  it("keeps parents out of the hours", () => {
    expect(plan.parents.map((p) => p.identifier)).toEqual(["ENG-10"]);
    expect(plan.totalHours).toBe(11);
    expect(plan.doneHours).toBe(2);
  });

  it("puts leaves on their due day and sums the day", () => {
    const tuesday = plan.days.find((day) => day.date === "2026-09-29")!;
    expect(tuesday.issues.map((i) => i.identifier)).toEqual(["ENG-2", "ENG-3"]);
    expect(tuesday.hours).toBe(9);
  });

  it("lists leaves without a weekday due date separately", () => {
    expect(plan.unscheduled.map((i) => i.identifier)).toEqual(["ENG-5"]);
  });
});

describe("isOverdue", () => {
  it("flags open leaves past their due date only", () => {
    expect(isOverdue(issue({ dueDate: "2026-09-28" }), "2026-09-29")).toBe(
      true,
    );
    expect(isOverdue(issue({ dueDate: "2026-09-29" }), "2026-09-29")).toBe(
      false,
    );
    expect(
      isOverdue(
        issue({ dueDate: "2026-09-28", stateType: "completed" }),
        "2026-09-29",
      ),
    ).toBe(false);
  });
});

describe("startedState", () => {
  it("prefers In Progress over custom started states", () => {
    const states = [
      { id: "b", name: "Blocked", type: "started", position: 1060 },
      { id: "p", name: "In Progress", type: "started", position: 2 },
      { id: "t", name: "Todo", type: "unstarted", position: 1 },
    ];
    expect(startedState(states)?.id).toBe("p");
    expect(startedState(states.filter((s) => s.id !== "p"))?.id).toBe("b");
    expect(startedState([states[2]])).toBeNull();
  });
});
