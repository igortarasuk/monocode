import { describe, expect, it } from "vitest";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  parseCommitMessage,
  parsePrContent,
  stripAttribution,
} from "./gitText";

describe("git text", () => {
  it("puts project conventions first and asks for short text", () => {
    const commit = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M a.ts",
      stagedPatch: "+x",
    });
    const pr = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feat/x",
      commitSummary: "Add x",
      diffSummary: "a.ts | 1 +",
      diffPatch: "+x",
    });
    for (const prompt of [commit, pr]) {
      expect(prompt).toContain("project instructions or your memory");
      expect(prompt).toContain("never add Co-Authored-By");
    }
    expect(pr).not.toContain("## Testing");
  });

  it("drops AI attribution from generated and fallback text", () => {
    expect(
      parseCommitMessage(
        JSON.stringify({
          subject: "Add probe",
          body: "- adds probe\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
        }),
      ),
    ).toEqual({ subject: "Add probe", body: "- adds probe" });
    expect(
      parsePrContent(
        JSON.stringify({
          title: "Add probe",
          body: "- adds probe\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        }),
      ),
    ).toEqual({ title: "Add probe", body: "- adds probe" });
    expect(
      stripAttribution(
        "Fix a\n\nCo-authored-by: Claude <noreply@anthropic.com>\n\nFix b",
      ),
    ).toBe("Fix a\n\nFix b");
  });

  it("keeps human co-authors", () => {
    const body = "Fix a\n\nCo-authored-by: Olena <olena@example.com>";
    expect(stripAttribution(body)).toBe(body);
  });
});
