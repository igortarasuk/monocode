import { describe, expect, it } from "vitest";
import {
  checkDraft,
  consultationItem,
  parsePlanJson,
  syncItems,
  withDefaultLabels,
  type PlanDraftItem,
  type PlanParent,
} from "./planDraft";

const week = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];

const parent: PlanParent = {
  id: "p1",
  identifier: "ENG-104",
  title: "Connect databases",
  teamId: "t",
  projectId: "pr",
  labelIds: ["l1"],
  childTitles: ["Group instances into batches"],
};

function item(patch: Partial<PlanDraftItem>): PlanDraftItem {
  return {
    key: patch.title ?? "k",
    parentIdentifier: "",
    title: "Step",
    description: "Result.",
    estimate: 2,
    dueDate: week[0],
    labelIds: ["l-ops"],
    ...patch,
  };
}

describe("parsePlanJson", () => {
  it("reads the plan-apply file format", () => {
    const items = parsePlanJson(
      JSON.stringify({
        week: "2026-10-05",
        items: [
          { parent: "ENG-104", title: "Audit", desc: "List hosts.", estimate: 4, due: "2026-10-05" },
          { title: "Team sync", desc: "Sync.", estimate: 1, due: "2026-10-07" },
        ],
      }),
    );
    expect(items.map((i) => [i.parentIdentifier, i.title, i.estimate, i.dueDate])).toEqual([
      ["ENG-104", "Audit", 4, "2026-10-05"],
      ["", "Team sync", 1, "2026-10-07"],
    ]);
    expect(items[0].description).toBe("List hosts.");
  });

  it("rejects a file without items", () => {
    expect(() => parsePlanJson('{"week":"2026-10-05"}')).toThrow();
  });
});

describe("presets", () => {
  it("puts syncs on Monday, Wednesday and Friday", () => {
    expect(syncItems(week).map((i) => i.dueDate)).toEqual([week[0], week[2], week[4]]);
    expect(consultationItem(week).estimate).toBe(2);
  });

  it("carries the default labels so syncs are never unlabeled", () => {
    expect(syncItems(week, ["l-ops"]).every((i) => i.labelIds[0] === "l-ops")).toBe(true);
    expect(consultationItem(week, 2, ["l-ops"]).labelIds).toEqual(["l-ops"]);
  });
});

describe("withDefaultLabels", () => {
  it("fills parentless items only and leaves chosen labels alone", () => {
    const filled = withDefaultLabels(
      [
        item({ key: "a", labelIds: [] }),
        item({ key: "b", labelIds: [], parentIdentifier: "ENG-104" }),
        item({ key: "c", labelIds: ["l-own"] }),
      ],
      ["l-ops"],
    );
    expect(filled.map((i) => i.labelIds)).toEqual([["l-ops"], [], ["l-own"]]);
  });
});

describe("checkDraft", () => {
  const parents = new Map([["ENG-104", parent]]);

  it("counts hours per day on top of what is already planned", () => {
    const check = checkDraft(
      [item({ title: "A", estimate: 3 }), item({ title: "B", estimate: 2, dueDate: week[1] })],
      week,
      parents,
      { [week[0]]: 4 },
    );
    expect(check.hoursByDay[week[0]]).toBe(7);
    expect(check.total).toBe(9);
    expect(check.valid).toBe(true);
  });

  it("flags what Linear or the week would reject", () => {
    const check = checkDraft(
      [
        item({ title: "Big", estimate: 8 }),
        item({ title: "Weekend", dueDate: "2026-10-10" }),
        item({ title: "Orphan", parentIdentifier: "ENG-999" }),
        item({ title: "", description: "" }),
      ],
      week,
      parents,
    );
    expect(check.valid).toBe(false);
    expect(check.errors.get("Big")).toContain("Hours must be 1 to 7");
    expect(check.errors.get("Weekend")?.[0]).toMatch(/Monday to Friday/);
    expect(check.errors.get("Orphan")).toContain("Parent ENG-999 not found");
  });

  it("marks existing and repeated titles as duplicates and skips their hours", () => {
    const check = checkDraft(
      [
        item({ key: "x", title: "Group instances into batches", parentIdentifier: "ENG-104" }),
        item({ key: "y", title: "Same" }),
        item({ key: "z", title: "Same" }),
      ],
      week,
      parents,
    );
    expect([...check.duplicates].sort()).toEqual(["x", "z"]);
    expect(check.total).toBe(2);
  });

  it("requires a label unless the parent has some", () => {
    const check = checkDraft(
      [
        item({ key: "bare", labelIds: [] }),
        item({ key: "child", labelIds: [], parentIdentifier: "ENG-104", title: "Fresh" }),
        item({ key: "orphan", labelIds: [], parentIdentifier: "ENG-7", title: "Loose" }),
      ],
      week,
      new Map([
        ["ENG-104", parent],
        ["ENG-7", { ...parent, identifier: "ENG-7", labelIds: [], childTitles: [] }],
      ]),
    );
    expect(check.errors.get("bare")).toEqual(["Label is required"]);
    expect(check.errors.has("child")).toBe(false);
    expect(check.errors.get("orphan")).toEqual(["Parent has no labels; pick one"]);
  });

  it("flags a day over eight hours", () => {
    const check = checkDraft(
      [item({ title: "A", estimate: 5 }), item({ title: "B", estimate: 4 })],
      week,
      parents,
    );
    expect(check.errors.get("A")?.some((e) => e.includes("over 8"))).toBe(true);
  });
});
