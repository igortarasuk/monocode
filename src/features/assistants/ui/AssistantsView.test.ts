// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, args?: { slug?: string }) =>
      `/home/me/Assistants/${args?.slug ?? ""}`,
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../sessions/ui/ModelPicker", () => ({
  ModelPicker: () => null,
}));
vi.mock("../../sessions/ui/AccessPicker", () => ({
  AccessPicker: () => null,
}));
vi.mock("../../skills/model/skills", () => ({
  loadSkills: vi.fn(async () => []),
}));

import { AssistantsContent } from "./AssistantsView";
import { loadAssistants } from "../model/assistants";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  invoke.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

async function render(onStartChat = vi.fn(async () => {})) {
  await act(async () => {
    root.render(
      createElement(AssistantsContent, {
        history: [],
        onStartChat,
        onOpenSession: vi.fn(async () => {}),
      }),
    );
  });
  return onStartChat;
}

describe("AssistantsContent", () => {
  it("shows the templates when there are no assistants", async () => {
    await render();
    expect(container.textContent).toContain("Translator");
    expect(container.textContent).toContain("R&D");
    expect(container.textContent).toContain("Routine");
  });

  it("creates an assistant from a template and prepares its folder", async () => {
    await render();
    await act(async () => button("Translator").click());

    const [saved] = loadAssistants();
    expect(saved).toMatchObject({ name: "Translator", slug: "translator" });
    expect(saved.model).not.toBe("");
    expect(invoke).toHaveBeenCalledWith("assistant_workspace_prepare", {
      slug: "translator",
      name: "Translator",
      instructions: saved.instructions,
    });
    expect(container.textContent).toContain("~/Assistants/translator");
  });

  it("starts a chat with the selected assistant", async () => {
    const onStartChat = await render();
    await act(async () => button("Routine").click());
    await act(async () => button("New chat").click());

    expect(onStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Routine",
        noteTags: ["routine", "todo"],
      }),
    );
  });
});
