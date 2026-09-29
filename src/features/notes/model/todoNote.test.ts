import { describe, expect, it } from "vitest";
import { replyToTodoBody, todoItems, toggleTodoLine } from "./todoNote";

describe("replyToTodoBody", () => {
  it("turns top-level list items into checkboxes", () => {
    expect(
      replyToTodoBody("Plan:\n- buy milk\n* call Ann\n1. ship it\n2) review"),
    ).toBe(
      "Plan:\n- [ ] buy milk\n- [ ] call Ann\n- [ ] ship it\n- [ ] review",
    );
  });

  it("leaves nested items, code fences and existing checkboxes alone", () => {
    const text = "- [x] done\n- todo\n  - nested\n```\n- not a task\n```";
    expect(replyToTodoBody(text)).toBe(
      "- [x] done\n- [ ] todo\n  - nested\n```\n- not a task\n```",
    );
  });

  it("makes one item from plain text and keeps the rest", () => {
    expect(replyToTodoBody("Renew the certificate\n\nIt expires Friday.")).toBe(
      "- [ ] Renew the certificate\n\nIt expires Friday.",
    );
    expect(replyToTodoBody("One line")).toBe("- [ ] One line");
  });
});

describe("todo items", () => {
  const body = "Intro\n- [ ] first\n- [x] second\n```\n- [ ] code\n```";

  it("lists checkboxes outside code fences", () => {
    expect(todoItems(body)).toEqual([
      { line: 1, checked: false, text: "first" },
      { line: 2, checked: true, text: "second" },
    ]);
  });

  it("toggles exactly one marker", () => {
    expect(toggleTodoLine(body, 1)).toBe(
      "Intro\n- [x] first\n- [x] second\n```\n- [ ] code\n```",
    );
    expect(toggleTodoLine(body, 2)).toBe(
      "Intro\n- [ ] first\n- [ ] second\n```\n- [ ] code\n```",
    );
    expect(toggleTodoLine(body, 0)).toBe(body);
    expect(toggleTodoLine(body, 99)).toBe(body);
  });
});
