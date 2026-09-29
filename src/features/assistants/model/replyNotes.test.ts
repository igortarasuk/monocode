// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ASSISTANT_TEMPLATES, upsertAssistant } from "./assistants";
import { replyNoteContent } from "./replyNotes";

beforeEach(() => localStorage.clear());

describe("replyNoteContent", () => {
  it("keeps plain replies untagged outside assistant folders", () => {
    expect(replyNoteContent("- a", "/home/me/code/app")).toEqual({
      body: "- a",
      tags: [],
    });
  });

  it("adds the assistant tags and the todo tag once", () => {
    upsertAssistant(ASSISTANT_TEMPLATES[2]);
    expect(replyNoteContent("- a\n- b", "/home/me/Assistants/routine")).toEqual(
      { body: "- a\n- b", tags: ["routine", "todo"] },
    );
    expect(
      replyNoteContent("- a\n- b", "/home/me/Assistants/routine", "todo"),
    ).toEqual({ body: "- [ ] a\n- [ ] b", tags: ["routine", "todo"] });
    expect(replyNoteContent("Call", "/home/me/code/app", "todo")).toEqual({
      body: "- [ ] Call",
      tags: ["todo"],
    });
  });
});
