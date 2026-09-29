// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => "/home/me/Assistants/translator"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { HARNESSES } from "../../sessions/model/session";
import {
  ASSISTANT_TEMPLATES,
  ASSISTANTS_CHANGED_EVENT,
  assistantForCwd,
  assistantWorkspace,
  deleteAssistant,
  isAssistantWorkspace,
  loadAssistants,
  prepareAssistantWorkspace,
  slugify,
  uniqueSlug,
  upsertAssistant,
} from "./assistants";

beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
});

describe("assistants", () => {
  it("slugifies names into safe directory names", () => {
    expect(slugify("R&D")).toBe("r-d");
    expect(slugify("  Translator  ")).toBe("translator");
    expect(slugify("Перекладач")).toBe("assistant");
    expect(slugify("a".repeat(60))).toHaveLength(48);
  });

  it("adds a numeric suffix when the slug is taken", () => {
    expect(uniqueSlug("Translator", ["translator"])).toBe("translator-2");
    expect(uniqueSlug("Translator", ["translator", "translator-2"])).toBe(
      "translator-3",
    );
  });

  it("round-trips through storage and notifies listeners", () => {
    const onChange = vi.fn();
    window.addEventListener(ASSISTANTS_CHANGED_EVENT, onChange);
    const first = upsertAssistant(ASSISTANT_TEMPLATES[0]);
    const second = upsertAssistant(ASSISTANT_TEMPLATES[0]);
    window.removeEventListener(ASSISTANTS_CHANGED_EVENT, onChange);

    expect(first.slug).toBe("translator");
    expect(second.slug).toBe("translator-2");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(loadAssistants()).toEqual([first, second]);

    const renamed = upsertAssistant({ ...first, name: "Other name" });
    expect(renamed.slug).toBe("translator");
    expect(renamed.createdAt).toBe(first.createdAt);
    deleteAssistant(second.id);
    expect(loadAssistants().map((item) => item.name)).toEqual(["Other name"]);
  });

  it("drops malformed stored entries", () => {
    localStorage.setItem(
      "monocode:assistants:v1",
      JSON.stringify({
        version: 1,
        assistants: [
          { id: "a", slug: "../x", name: "Bad" },
          {
            id: "b",
            slug: "ok",
            name: "Ok",
            harness: "nope",
            noteTags: ["#Todo"],
          },
        ],
      }),
    );
    const [only, ...rest] = loadAssistants();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      slug: "ok",
      harness: "claude",
      noteTags: ["todo"],
    });
  });

  it("finds the assistant for absolute and ~ workspace paths", () => {
    const saved = upsertAssistant(ASSISTANT_TEMPLATES[1]);
    expect(assistantWorkspace(saved.slug)).toBe("~/Assistants/r-d");
    expect(assistantForCwd("~/Assistants/r-d")?.id).toBe(saved.id);
    expect(assistantForCwd("/home/me/Assistants/r-d")?.id).toBe(saved.id);
    expect(assistantForCwd("/Users/me/Assistants/r-d/")?.id).toBe(saved.id);
    expect(assistantForCwd("/home/me/Assistants/other")).toBeNull();
    expect(isAssistantWorkspace("/home/me/Assistants/other")).toBe(true);
    expect(isAssistantWorkspace("/home/me/code/Assistants")).toBe(false);
    expect(isAssistantWorkspace("~")).toBe(false);
  });

  it("templates use known providers", () => {
    for (const template of ASSISTANT_TEMPLATES) {
      expect(HARNESSES).toContain(template.harness);
    }
  });

  it("prepares the workspace through the native command", async () => {
    const path = await prepareAssistantWorkspace({
      slug: "translator",
      name: "Translator",
      instructions: "Translate.",
    });
    expect(path).toBe("/home/me/Assistants/translator");
    expect(invoke).toHaveBeenCalledWith("assistant_workspace_prepare", {
      slug: "translator",
      name: "Translator",
      instructions: "Translate.",
    });
  });
});
