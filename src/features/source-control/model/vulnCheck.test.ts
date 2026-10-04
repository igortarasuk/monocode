// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { VulnFinding, VulnReport } from "../../../platform/tauri/lint";
import { saveLintToolEnabled } from "../../settings/model/lintTools";
import {
  resetVulnChecks,
  runVulnCheck,
  subscribeVulnCheck,
  vulnCheckState,
  vulnCheckSummary,
  vulnFindingsForFile,
} from "./vulnCheck";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function finding(overrides: Partial<VulnFinding> = {}): VulnFinding {
  return {
    id: "GO-2024-0001",
    summary: "Request smuggling in net/http",
    module: "stdlib",
    foundVersion: "v1.21.0",
    fixedVersion: "v1.21.5",
    url: null,
    path: "/repo/main.go",
    line: 12,
    column: 3,
    ...overrides,
  };
}

function report(overrides: Partial<VulnReport> = {}): VulnReport {
  return {
    available: true,
    modules: 1,
    findings: [],
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(report());
  resetVulnChecks();
});

afterEach(() => {
  localStorage.clear();
});

describe("runVulnCheck", () => {
  it("checks the project and publishes the report", async () => {
    const result = report({ findings: [finding()] });
    vi.mocked(invoke).mockResolvedValue(result);
    const listener = vi.fn();
    const unsubscribe = subscribeVulnCheck(listener);

    const run = runVulnCheck("/repo");
    expect(vulnCheckState("/repo")).toEqual({ running: true, report: null });
    await run;

    expect(invoke).toHaveBeenCalledExactlyOnceWith("vuln_check", {
      root: "/repo",
    });
    expect(vulnCheckState("/repo")).toEqual({ running: false, report: result });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it.each(["remote://machine/home/user/repo", "", "~"])(
    "does nothing for %j",
    async (cwd) => {
      await runVulnCheck(cwd);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("does nothing when the check is switched off", async () => {
    saveLintToolEnabled("govulncheck", false);
    await runVulnCheck("/repo");
    expect(invoke).not.toHaveBeenCalled();
    expect(vulnCheckState("/repo").report).toBeNull();
  });

  it("never runs two checks for one project, and reruns once for commits made meanwhile", async () => {
    let finish!: (value: VulnReport) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise<VulnReport>((resolve) => {
        finish = resolve;
      }),
    );
    const latest = report({ findings: [finding()] });
    vi.mocked(invoke).mockResolvedValueOnce(latest);

    const first = runVulnCheck("/repo");
    await runVulnCheck("/repo");
    await runVulnCheck("/repo");
    expect(invoke).toHaveBeenCalledTimes(1);

    finish(report());
    await first;

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vulnCheckState("/repo")).toEqual({ running: false, report: latest });
  });

  it("keeps the previous report visible while the next check runs", async () => {
    const previous = report({ findings: [finding()] });
    vi.mocked(invoke).mockResolvedValueOnce(previous);
    await runVulnCheck("/repo");

    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}));
    void runVulnCheck("/repo");
    expect(vulnCheckState("/repo")).toEqual({
      running: true,
      report: previous,
    });
    expect(vulnFindingsForFile("/repo/main.go")).toHaveLength(1);
  });

  it("turns a failed call into a report instead of throwing", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("command not found"));
    await expect(runVulnCheck("/repo")).resolves.toBeUndefined();
    expect(vulnCheckState("/repo").report).toMatchObject({
      findings: [],
      error: "command not found",
    });
    expect(vulnCheckSummary(vulnCheckState("/repo"))).toBe(
      "govulncheck failed",
    );
  });
});

describe("vulnFindingsForFile", () => {
  it("returns the findings that point into the file", async () => {
    vi.mocked(invoke).mockResolvedValue(
      report({
        findings: [
          finding(),
          finding({ id: "GO-2024-0002", path: "/repo/other.go" }),
          finding({ id: "GO-2024-0003", path: null }),
          finding({ id: "GO-2024-0004", path: "\\repo\\main.go" }),
        ],
      }),
    );
    await runVulnCheck("/repo");

    expect(vulnFindingsForFile("/repo/main.go").map((item) => item.id)).toEqual(
      ["GO-2024-0001"],
    );
    expect(vulnFindingsForFile("/repo/missing.go")).toEqual([]);
  });
});

describe("vulnCheckSummary", () => {
  it("stays quiet for projects without Go or without govulncheck", () => {
    expect(vulnCheckSummary({ running: false, report: null })).toBeNull();
    expect(
      vulnCheckSummary({ running: false, report: report({ modules: 0 }) }),
    ).toBeNull();
    expect(
      vulnCheckSummary({
        running: false,
        report: report({ available: false }),
      }),
    ).toBeNull();
  });

  it("counts each vulnerability once however many call sites it has", () => {
    expect(vulnCheckSummary({ running: true, report: null })).toBe(
      "govulncheck: checking…",
    );
    expect(vulnCheckSummary({ running: false, report: report() })).toBe(
      "govulncheck: no vulnerabilities",
    );
    expect(
      vulnCheckSummary({
        running: false,
        report: report({ findings: [finding(), finding({ line: 40 })] }),
      }),
    ).toBe("govulncheck: 1 vulnerability found");
    expect(
      vulnCheckSummary({
        running: false,
        report: report({
          findings: [finding(), finding({ id: "GO-2024-0002" })],
        }),
      }),
    ).toBe("govulncheck: 2 vulnerabilities found");
  });
});
