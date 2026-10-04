// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../../platform/tauri/fs", () => ({
  gitDiffIndex: vi.fn(),
  gitHistory: vi.fn(async () => []),
  gitPrStatus: vi.fn(async () => null),
  gitCommit: vi.fn(async () => {}),
  gitHeadMessage: vi.fn(async () => ""),
  gitReviewProvider: vi.fn(async () => "github"),
  notifyGitChanged: vi.fn(),
  subscribeGitChanged: () => () => {},
  basename: (path: string) => path.split("/").pop() ?? path,
}));

vi.mock("../../../integrations/harness", () => ({
  generateCommitMessage: vi.fn(async () => ""),
  generatePrContent: vi.fn(async () => null),
}));

vi.mock("../../files/model/fileWatch", () => ({
  invalidateWatchedFiles: vi.fn(),
  nudgeWatchedFiles: vi.fn(),
}));

vi.mock("../../inbox/model/inboxSelfActivity", () => ({
  recordInboxSelfActivity: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { GitChangesPanel } from "./GitChangesPanel";
import { gitCommit, gitDiffIndex } from "../../../platform/tauri/fs";
import type { GitDiffIndex } from "../../../platform/tauri/fs";
import type { VulnReport } from "../../../platform/tauri/lint";
import { saveLintToolEnabled } from "../../settings/model/lintTools";
import { resetVulnChecks } from "../model/vulnCheck";

function stagedIndex(cwd: string): GitDiffIndex {
  return {
    branch: "feature/vuln",
    head: "abc123",
    files: [
      {
        path: `${cwd}/main.go`,
        relative: "main.go",
        status: "modified",
        additions: 1,
        deletions: 0,
        staged: true,
        unstaged: false,
      },
    ],
    additions: 1,
    deletions: 0,
    remote: null,
    upstream: null,
    defaultBranch: "main",
    ahead: 0,
    behind: 0,
    aheadOfDefault: 0,
    headPushed: false,
  };
}

function vulnReport(overrides: Partial<VulnReport> = {}): VulnReport {
  return {
    available: true,
    modules: 1,
    findings: [],
    error: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(gitCommit).mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockReset().mockResolvedValue(vulnReport());
  resetVulnChecks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function commitFrom(cwd: string) {
  vi.mocked(gitDiffIndex).mockResolvedValue(stagedIndex(cwd));
  act(() =>
    root.render(
      createElement(GitChangesPanel, {
        cwd,
        enabled: true,
        onOpenFile: vi.fn(),
        onOpenAllChanges: vi.fn(),
        onOpenCommit: vi.fn(),
      }),
    ),
  );
  await act(async () => {});

  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "Fix handler");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const commit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Commit",
  )!;
  expect(commit.disabled).toBe(false);
  await act(async () => commit.click());
  await act(async () => {});
}

function vulnChecks() {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "vuln_check");
}

function statusText() {
  return [...container.querySelectorAll('[role="status"]')].map(
    (node) => node.textContent,
  );
}

describe("GitChangesPanel govulncheck after commit", () => {
  it("checks the project once the commit has landed and reports what it found", async () => {
    vi.mocked(invoke).mockResolvedValue(
      vulnReport({
        findings: [
          {
            id: "GO-2024-0001",
            summary: "Request smuggling in net/http",
            module: "stdlib",
            foundVersion: "v1.21.0",
            fixedVersion: "v1.21.5",
            url: null,
            path: "/repo/main.go",
            line: 12,
            column: 3,
          },
        ],
      }),
    );
    await commitFrom("/repo");

    expect(gitCommit).toHaveBeenCalledWith("/repo", "Fix handler", false);
    expect(vulnChecks()).toEqual([["vuln_check", { root: "/repo" }]]);
    expect(statusText()).toEqual(["govulncheck: 1 vulnerability found"]);
  });

  it("keeps the commit successful when the check itself fails", async () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    vi.mocked(invoke).mockRejectedValue(new Error("govulncheck crashed"));
    await commitFrom("/repo");

    expect(gitCommit).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(statusText()).toEqual(["govulncheck failed"]);
  });

  it("does not check after a commit that failed", async () => {
    vi.stubGlobal("alert", vi.fn());
    vi.mocked(gitCommit).mockRejectedValue(new Error("nothing to commit"));
    await commitFrom("/repo");

    expect(vulnChecks()).toEqual([]);
  });

  it("skips the check when it is switched off", async () => {
    saveLintToolEnabled("govulncheck", false);
    await commitFrom("/repo");

    expect(gitCommit).toHaveBeenCalledTimes(1);
    expect(vulnChecks()).toEqual([]);
    expect(statusText()).toEqual([]);
  });

  it("skips the check for a project on another machine", async () => {
    await commitFrom("remote://machine/home/user/repo");

    expect(gitCommit).toHaveBeenCalledWith(
      "remote://machine/home/user/repo",
      "Fix handler",
      false,
    );
    expect(vulnChecks()).toEqual([]);
  });
});
