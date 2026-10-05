// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { Composer } from "./Composer";

// Monochrome's own composer controls live in an upstream file, so an upstream
// sync or a build from the wrong branch can drop them without any other test
// noticing.
describe("Composer Monochrome controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderComposer(
    overrides: Partial<Parameters<typeof Composer>[0]> = {},
  ) {
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          cwd: "/repo",
          executionCwd: "/repo",
          sessionId: "session-1",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: () => {},
          onCwdChange: () => {},
          onModelChange: () => {},
          onRuntimeModeChange: () => {},
          onSubmit: () => {},
          ...overrides,
        }),
      ),
    );
  }

  const autoToggle = () =>
    container.querySelector<HTMLButtonElement>("[data-auto-model-toggle]");
  const knowledgeButton = () =>
    container.querySelector<HTMLButtonElement>(
      "[data-project-knowledge-button]",
    );

  it("shows the Auto model switch and the project knowledge button", async () => {
    await renderComposer();

    expect(autoToggle()?.getAttribute("aria-label")).toBe("Auto model");
    expect(autoToggle()?.textContent).toBe("Auto");
    expect(knowledgeButton()?.getAttribute("aria-label")).toBe(
      "Project knowledge",
    );
  });

  it("switches Auto model on and off for the session", async () => {
    await renderComposer();
    const before = autoToggle()!.getAttribute("aria-pressed");

    await act(async () => autoToggle()!.click());
    expect(autoToggle()!.getAttribute("aria-pressed")).not.toBe(before);

    await act(async () => autoToggle()!.click());
    expect(autoToggle()!.getAttribute("aria-pressed")).toBe(before);
  });

  it("hides both controls on a remote session", async () => {
    await renderComposer({ remoteSession: true });

    expect(autoToggle()).toBeNull();
    expect(knowledgeButton()).toBeNull();
  });

  it("offers no Auto switch before the session exists", async () => {
    await renderComposer({ sessionId: undefined });

    expect(autoToggle()).toBeNull();
    expect(knowledgeButton()).not.toBeNull();
  });
});
