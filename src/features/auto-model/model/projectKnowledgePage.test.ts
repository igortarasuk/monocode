import { describe, expect, it } from "vitest";
import {
  docText,
  sharedWith,
  tabDoc,
  type KnowledgePage,
} from "./projectKnowledgePage";

const page: KnowledgePage = {
  status: { mounted: true, problem: null, infra: [], changes: 0 },
  user: "owner",
  model: "agents",
  infra: "map",
  changes: "log",
  changeLog: [],
  shared: [{ name: "eu-mon-1", projects: ["/work/billing", "C:\\work\\ops"] }],
  architecture: null,
  diagram: null,
};

describe("project knowledge page", () => {
  it("maps tabs to their documents", () => {
    expect(tabDoc("overview")).toBeNull();
    expect(tabDoc("diagram")).toBeNull();
    expect(tabDoc("user")).toBe("user.md");
    expect(docText(page, "user.md")).toBe("owner");
    expect(docText(page, "model.md")).toBe("agents");
    expect(docText(page, "infra.md")).toBe("map");
    expect(docText(page, "changes.md")).toBe("log");
  });

  it("names the other projects a host is shared with", () => {
    expect(sharedWith(page, "eu-mon-1")).toEqual(["billing", "ops"]);
    expect(sharedWith(page, "db-1")).toEqual([]);
  });
});
