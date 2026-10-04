// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_LINT_TOOLS,
  VULN_CHECK_TOOL,
} from "../../../platform/tauri/lint";
import {
  LINT_TOOL_SETTINGS,
  loadLintToolEnabled,
  saveLintToolEnabled,
  subscribeLintTools,
} from "./lintTools";
import { SETTINGS_INDEX } from "./settings";

afterEach(() => {
  localStorage.clear();
});

describe("lint tool settings", () => {
  it("has one switch per tool the backend runs", () => {
    expect(LINT_TOOL_SETTINGS.map((setting) => setting.tool)).toEqual([
      ...EXTERNAL_LINT_TOOLS,
      VULN_CHECK_TOOL,
    ]);
  });

  it("makes every switch searchable in Settings", () => {
    for (const setting of LINT_TOOL_SETTINGS) {
      expect(SETTINGS_INDEX).toContainEqual({
        id: setting.id,
        section: "chat",
        label: setting.label,
        keywords: setting.keywords,
      });
    }
  });

  it.each(LINT_TOOL_SETTINGS)(
    "keeps $tool on until it is switched off",
    ({ tool }) => {
      const listener = vi.fn();
      const unsubscribe = subscribeLintTools(listener);
      expect(loadLintToolEnabled(tool)).toBe(true);

      saveLintToolEnabled(tool, false);

      expect(loadLintToolEnabled(tool)).toBe(false);
      expect(localStorage.getItem(`monocode.lint.${tool}`)).toBe("0");
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();

      saveLintToolEnabled(tool, true);
      expect(loadLintToolEnabled(tool)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  it("switches tools independently", () => {
    saveLintToolEnabled("tflint", false);
    expect(loadLintToolEnabled("tflint")).toBe(false);
    expect(loadLintToolEnabled("golangci-lint")).toBe(true);
    expect(loadLintToolEnabled(VULN_CHECK_TOOL)).toBe(true);
  });
});
