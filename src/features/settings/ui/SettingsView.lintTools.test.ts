// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsView } from "./SettingsView";
import { LINT_TOOL_SETTINGS, loadLintToolEnabled } from "../model/lintTools";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude" || id === "cursor",
  hasProbedHarnessAvailability: () => true,
  getHarnessAvailabilitySnapshot: () => 0,
  subscribeHarnessAvailability: () => () => {},
  probeHarnessAvailability: async () => {},
  harnessUnavailableHint: () => "",
}));

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () =>
    root.render(
      createElement(SettingsView, {
        section: "chat",
        cwd: "/repo",
        sessions: [],
        onClose: vi.fn(),
        onSelectSection: vi.fn(),
        onOpenSession: vi.fn(),
        onArchiveSession: vi.fn(),
        onDeleteSession: vi.fn(),
        onOpenWhatsNew: vi.fn(),
      }),
    ),
  );
}

function row(id: string) {
  return container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("lint tool settings", () => {
  it("offers every external tool, on by default, and stores a switch-off", async () => {
    await render();

    for (const setting of LINT_TOOL_SETTINGS) {
      const control = row(setting.id).querySelector<HTMLButtonElement>(
        '[role="switch"]',
      )!;
      expect(control.getAttribute("aria-label")).toBe(setting.label);
      expect(control.getAttribute("aria-checked")).toBe("true");
    }

    const tflint =
      row("lint-tflint").querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => tflint.click());

    expect(tflint.getAttribute("aria-checked")).toBe("false");
    expect(loadLintToolEnabled("tflint")).toBe(false);
    expect(loadLintToolEnabled("golangci-lint")).toBe(true);
    expect(localStorage.getItem("monocode.lint.tflint")).toBe("0");
  });

  it("notes the tools that are not installed", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "external_lint_tools"
        ? [
            { tool: "tflint", available: true },
            { tool: "ansible-lint", available: false },
            { tool: "golangci-lint", available: true },
            { tool: "govulncheck", available: false },
          ]
        : undefined,
    );
    await render();
    await act(async () => {});

    expect(row("lint-ansible-lint").textContent).toContain("Not installed");
    expect(row("lint-govulncheck").textContent).toContain("Not installed");
    expect(row("lint-tflint").textContent).not.toContain("Not installed");
    expect(row("lint-golangci-lint").textContent).not.toContain(
      "Not installed",
    );
  });

  it("shows the switches without hints when the probe fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "external_lint_tools") throw new Error("no command");
      return undefined;
    });
    await render();
    await act(async () => {});

    expect(row("lint-tflint").querySelector('[role="switch"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Not installed");
  });
});
