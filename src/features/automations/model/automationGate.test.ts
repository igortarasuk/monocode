import { describe, expect, it, vi } from "vitest";
import type { AutomationGate } from "./automations";
import {
  MAX_GATE_INPUT,
  MAX_PRESET_INPUT,
  answerDecision,
  gateInput,
  globToRegExp,
  runGate,
  type GateDeps,
} from "./automationGate";
import type { LayaClassifyResult } from "../../laya/model/laya";

const CLASSIFY: LayaClassifyResult = {
  domain: "ansible",
  chunks: [
    { line: 1, flagged: [] },
    {
      line: 9,
      flagged: [
        {
          rule: "no-shell-wrapper",
          p: 0.87,
          nudge: "Don't use Ansible as a shell wrapper.",
          example: {
            text: "- name: Install\n  ansible.builtin.apt:\n    name: curl",
            source: "user",
          },
        },
        { rule: "explicit-state", p: 0.42, nudge: "Set state.", example: null },
      ],
    },
  ],
};

function deps(overrides: Partial<GateDeps> = {}): GateDeps {
  return {
    available: vi.fn(async () => true),
    classify: vi.fn(async () => CLASSIFY),
    predict: vi.fn(async () => ({})),
    diff: vi.fn(async () => "diff --git a/x b/x"),
    listFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    ...overrides,
  };
}

const classifyGate: AutomationGate = {
  kind: "laya-classify",
  domain: "ansible",
  threshold: 0.5,
  input: "diff",
  onPass: "skip",
};

describe("runGate", () => {
  it("runs without a gate or when Laya is off", async () => {
    expect(await runGate(null, "p", deps())).toEqual({ action: "run" });
    const off = deps({ available: vi.fn(async () => false) });
    expect(await runGate(classifyGate, "p", off)).toEqual({ action: "run" });
    expect(off.classify).not.toHaveBeenCalled();
  });

  it("prepends a fixed block when classify flags a rule", async () => {
    const outcome = await runGate(classifyGate, "Review", deps());
    expect(outcome.action).toBe("run");
    const prefix = outcome.action === "run" ? (outcome.prefix ?? "") : "";
    expect(prefix).toContain(
      "[Laya pre-check] The following rules were flagged in ansible:",
    );
    expect(prefix).toContain(
      "- no-shell-wrapper at line 9 (p=0.87): Don't use Ansible as a shell wrapper.",
    );
    expect(prefix).toContain("Example that follows the rule (user):");
    expect(prefix).toContain("ansible.builtin.apt:");
    expect(prefix).not.toContain("explicit-state");
    expect(prefix.endsWith("Review these first.")).toBe(true);
  });

  it("skips or runs when nothing is flagged", async () => {
    const high = { ...classifyGate, threshold: 0.9 };
    expect(await runGate(high, "p", deps())).toEqual({
      action: "skip",
      reason: "Laya: nothing flagged (p<0.9)",
    });
    expect(await runGate({ ...high, onPass: "run" }, "p", deps())).toEqual({
      action: "run",
    });
  });

  it("decides presets by noul and custom questions by choice", async () => {
    const preset: AutomationGate = {
      kind: "laya-preset",
      preset: "test-gaps",
      key: "untested_branches",
      threshold: 0.6,
      input: "prompt",
      onPass: "skip",
    };
    const predict = vi.fn(async () => ({
      logic_without_tests: { noul: 0.9 },
      untested_branches: { noul: 0.3 },
    }));
    expect(await runGate(preset, "x".repeat(5000), deps({ predict }))).toEqual({
      action: "skip",
      reason: "Laya: untested_branches below threshold (p=0.30)",
    });
    expect(predict).toHaveBeenCalledWith(
      { preset: "test-gaps" },
      "x".repeat(MAX_PRESET_INPUT),
    );

    const custom: AutomationGate = {
      kind: "laya-custom",
      questions: JSON.stringify({
        risk: { type: "choice", instructions: "Risk?", criteria: {} },
      }),
      threshold: 0.5,
      input: "prompt",
      onPass: "skip",
    };
    const risky = deps({
      predict: vi.fn(async () => ({
        risk: { choice: "security", probabilities: { security: 0.7 } },
      })),
    });
    const outcome = await runGate(custom, "diff", risky);
    expect(outcome).toEqual({
      action: "run",
      prefix:
        "[Laya pre-check] custom questions: risk = security (p=0.70). Review this first.",
    });
  });

  it("fails open with the Laya error", async () => {
    const broken = deps({
      classify: vi.fn(async () => {
        throw new Error("docker: not running");
      }),
    });
    expect(await runGate(classifyGate, "p", broken)).toEqual({
      action: "run",
      note: "Laya unavailable: docker: not running",
    });
    const badJson: AutomationGate = {
      ...classifyGate,
      kind: "laya-custom",
      questions: "{",
    };
    expect(await runGate(badJson, "p", deps())).toEqual({
      action: "run",
      note: "Laya unavailable: Pre-check questions are not valid JSON",
    });
  });
});

describe("answerDecision", () => {
  it("treats none and fine as passing choices", () => {
    expect(
      answerDecision(
        { a: { choice: "fine", probabilities: { fine: 0.99 } } },
        0.5,
      ),
    ).toEqual({ key: "a", choice: "fine", p: 0.99, fired: false });
    expect(answerDecision({}, 0.5)).toBeNull();
  });
});

describe("gate input", () => {
  it("caps the diff and matches files by glob", async () => {
    const big = deps({
      diff: vi.fn(async () => "d".repeat(MAX_GATE_INPUT + 10)),
    });
    expect(await gateInput(classifyGate, "", big)).toHaveLength(MAX_GATE_INPUT);

    const readFile = vi.fn(async (path: string) => `# ${path}`);
    const files = deps({
      listFiles: vi.fn(async () => [
        "roles/web/tasks/main.yml",
        "roles/web/templates/nginx.conf",
        "tasks/extra.yml",
      ]),
      readFile,
    });
    const text = await gateInput(
      { ...classifyGate, input: "files", filesGlob: "**/tasks/*.yml" },
      "",
      files,
    );
    expect(text).toBe("# roles/web/tasks/main.yml\n# tasks/extra.yml\n");
  });

  it("translates globs", () => {
    expect(globToRegExp("*.yml").test("a.yml")).toBe(true);
    expect(globToRegExp("*.yml").test("a/b.yml")).toBe(false);
    expect(
      globToRegExp("roles/**/tasks/*.yml").test("roles/a/b/tasks/m.yml"),
    ).toBe(true);
    expect(globToRegExp("roles/**/tasks/*.yml").test("roles/tasks/m.yml")).toBe(
      true,
    );
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
  });
});

describe("gate defaults", () => {
  it("takes the domain from Laya and never assumes one", async () => {
    const { defaultGate } = await import("./automationGate");
    expect(defaultGate(["terraform", "ansible"]).domain).toBe("terraform");
    expect(defaultGate().domain).toBeUndefined();
    expect(await runGate(defaultGate(), "p", deps())).toEqual({
      action: "run",
      note: "Laya unavailable: Pick a Laya domain for the pre-check",
    });
  });
});
