import { describe, expect, it } from "vitest";
import {
  findLinearIds,
  linearIdsFromBranch,
  linearIdsFromCommits,
  withLinearRefs,
} from "./linearRef";

describe("linearRef", () => {
  it("reads bracketed ids from commits, oldest first", () => {
    const log = "[DEV7-12] fix retry\n[ops-3] add probe\n[DEV7-12] start";
    expect(linearIdsFromCommits(log)).toEqual(["DEV7-12", "OPS-3"]);
    expect(linearIdsFromCommits("Bump utf-8 parser")).toEqual([]);
  });

  it("reads ids from branch names", () => {
    expect(linearIdsFromBranch("dev7-6109-mr-button")).toEqual(["DEV7-6109"]);
    expect(linearIdsFromBranch("feature/INFRA-42")).toEqual(["INFRA-42"]);
    expect(linearIdsFromBranch("me/ops-7")).toEqual(["OPS-7"]);
    expect(linearIdsFromBranch("fix-utf-8-names")).toEqual([]);
    expect(linearIdsFromBranch("personal")).toEqual([]);
  });

  it("prefers commits over the branch", () => {
    expect(
      findLinearIds({ commitSummary: "[OPS-1] x", branch: "dev7-2-y" }),
    ).toEqual(["OPS-1"]);
    expect(findLinearIds({ commitSummary: "plain", branch: "dev7-2-y" })).toEqual(
      ["DEV7-2"],
    );
  });

  it("adds a title prefix and Refs line once", () => {
    const content = { title: "Add probe", body: "## Summary\n- x" };
    expect(withLinearRefs(content, ["OPS-1", "OPS-2"])).toEqual({
      title: "[OPS-1] Add probe",
      body: "## Summary\n- x\n\nRefs OPS-1, OPS-2",
    });
    const linked = { title: "[OPS-1] Add probe", body: "Refs OPS-1" };
    expect(withLinearRefs(linked, ["OPS-1"])).toEqual(linked);
    expect(withLinearRefs(content, [])).toBe(content);
  });
});
