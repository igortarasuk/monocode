// @vitest-environment happy-dom
import { diagnosticCount, forEachDiagnostic } from "@codemirror/lint";
import { ChangeSet, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../../platform/tauri/lint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/tauri/lint")>()),
  externalLint: vi.fn(),
  vulnCheck: vi.fn(),
}));

import {
  externalLint as runExternalLint,
  vulnCheck,
  type LintDiagnostic,
  type LintReport,
  type VulnFinding,
} from "../../../platform/tauri/lint";
import { saveLintToolEnabled } from "../../settings/model/lintTools";
import {
  resetVulnChecks,
  runVulnCheck,
} from "../../source-control/model/vulnCheck";
import {
  diagnosticRange,
  externalLint,
  externalLintToolForPath,
  lintDiagnostic,
  mapDiagnostics,
  notifyExternalLintSaved,
  vulnDiagnostic,
} from "./externalLint";

function reported(overrides: Partial<LintDiagnostic> = {}): LintDiagnostic {
  return {
    line: 1,
    column: null,
    endLine: null,
    endColumn: null,
    severity: "warning",
    message: "unused variable",
    rule: "terraform_unused_declarations",
    source: "tflint",
    url: null,
    ...overrides,
  };
}

function report(diagnostics: LintDiagnostic[], tool = "tflint"): LintReport {
  return { tool, available: true, diagnostics, error: null };
}

function finding(overrides: Partial<VulnFinding> = {}): VulnFinding {
  return {
    id: "GO-2024-0001",
    summary: "Request smuggling in net/http",
    module: "stdlib",
    foundVersion: "v1.21.0",
    fixedVersion: "v1.21.5",
    url: "https://pkg.go.dev/vuln/GO-2024-0001",
    path: "/repo/main.go",
    line: 2,
    column: 3,
    ...overrides,
  };
}

describe("externalLintToolForPath", () => {
  it.each([
    ["/repo/infra/main.tf", "tflint"],
    ["/repo/cmd/app/main.go", "golangci-lint"],
    ["/repo/roles/web/tasks/main.yml", "ansible-lint"],
    ["/repo/playbook.yaml", "ansible-lint"],
    ["C:\\repo\\playbooks\\deploy.yml", "ansible-lint"],
  ])("picks a linter for %s", (path, tool) => {
    expect(externalLintToolForPath(path)).toBe(tool);
  });

  it.each([
    "/repo/docker-compose.yml",
    "/repo/infra/prod.tfvars",
    "/repo/src/app.ts",
    "/repo/go.mod",
    "/repo/roles/web/templates/nginx.conf.j2",
  ])("leaves %s alone", (path) => {
    expect(externalLintToolForPath(path)).toBeNull();
  });
});

describe("diagnosticRange", () => {
  const doc = Text.of(["resource {", "  name = value  ", "", "}"]);

  it("underlines the line's content when there is no column", () => {
    expect(diagnosticRange(doc, reported({ line: 2 }))).toEqual({
      from: 13,
      to: 25,
    });
  });

  it("underlines the token at a bare column", () => {
    const range = diagnosticRange(doc, reported({ line: 2, column: 3 }));
    expect(doc.sliceString(range.from, range.to)).toBe("name");
  });

  it("uses the reported end, across lines too", () => {
    const sameLine = diagnosticRange(
      doc,
      reported({ line: 2, column: 3, endLine: 2, endColumn: 9 }),
    );
    expect(doc.sliceString(sameLine.from, sameLine.to)).toBe("name =");

    const multiLine = diagnosticRange(
      doc,
      reported({ line: 1, column: 1, endLine: 4, endColumn: 2 }),
    );
    expect(multiLine).toEqual({ from: 0, to: doc.length });
  });

  it("clamps lines and columns that are out of range", () => {
    expect(diagnosticRange(doc, reported({ line: 0 }))).toEqual({
      from: 0,
      to: 10,
    });
    expect(diagnosticRange(doc, reported({ line: 99 }))).toEqual({
      from: doc.length - 1,
      to: doc.length,
    });
    expect(diagnosticRange(doc, reported({ line: 1, column: 500 }))).toEqual({
      from: 10,
      to: 10,
    });
    const clampedEnd = diagnosticRange(
      doc,
      reported({ line: 2, column: 3, endLine: 99, endColumn: 99 }),
    );
    expect(clampedEnd).toEqual({ from: 13, to: doc.length });
    expect(
      diagnosticRange(doc, reported({ line: Number.NaN, column: -4 })),
    ).toEqual({ from: 0, to: 10 });
  });

  it("falls back to the token when the end is not after the start", () => {
    const range = diagnosticRange(
      doc,
      reported({ line: 2, column: 3, endLine: 2, endColumn: 3 }),
    );
    expect(doc.sliceString(range.from, range.to)).toBe("name");
  });

  it("gives an empty line a point, not a range into its neighbours", () => {
    expect(diagnosticRange(doc, reported({ line: 3 }))).toEqual({
      from: 28,
      to: 28,
    });
  });
});

describe("lintDiagnostic", () => {
  const doc = Text.of(['variable "x" {}']);

  it("names the rule and the tool in the message", () => {
    expect(lintDiagnostic(doc, reported())).toMatchObject({
      severity: "warning",
      message: "unused variable (terraform_unused_declarations) · tflint",
    });
  });

  it("omits a missing or repeated rule and maps severities", () => {
    expect(
      lintDiagnostic(doc, reported({ rule: null, severity: "error" })),
    ).toMatchObject({ severity: "error", message: "unused variable · tflint" });
    expect(
      lintDiagnostic(
        doc,
        reported({
          message: "errcheck: unchecked error",
          rule: "errcheck",
          source: "golangci-lint",
          severity: "info",
        }),
      ),
    ).toMatchObject({
      severity: "info",
      message: "errcheck: unchecked error · golangci-lint",
    });
  });

  it("links to the rule only for web addresses", () => {
    expect(
      lintDiagnostic(doc, reported({ url: "https://example.test/rule" }))
        .actions,
    ).toHaveLength(1);
    expect(
      lintDiagnostic(doc, reported({ url: "file:///etc/passwd" })).actions,
    ).toBeUndefined();
  });
});

describe("vulnDiagnostic", () => {
  it("warns with the id, summary and fixed version", () => {
    const doc = Text.of(["package main", "  http.Serve(l, nil)"]);
    const diagnostic = vulnDiagnostic(doc, finding());
    expect(diagnostic.severity).toBe("warning");
    expect(diagnostic.message).toBe(
      "GO-2024-0001: Request smuggling in net/http — stdlib@v1.21.0, fixed in v1.21.5 · govulncheck",
    );
    expect(doc.sliceString(diagnostic.from, diagnostic.to)).toBe("http");
  });

  it("says so when there is no fix and no position", () => {
    const doc = Text.of(["package main"]);
    const diagnostic = vulnDiagnostic(
      doc,
      finding({
        fixedVersion: null,
        foundVersion: null,
        line: null,
        column: null,
      }),
    );
    expect(diagnostic.message).toContain("stdlib, no fix available");
    expect(diagnostic).toMatchObject({ from: 0, to: 12 });
  });
});

describe("mapDiagnostics", () => {
  it("moves diagnostics with edits and drops deleted text", () => {
    const diagnostics = [
      { from: 4, to: 8, severity: "warning" as const, message: "kept" },
      { from: 10, to: 14, severity: "warning" as const, message: "deleted" },
    ];
    const changes = ChangeSet.of(
      [
        { from: 0, insert: "ab" },
        { from: 9, to: 15 },
      ],
      20,
    );
    expect(mapDiagnostics(diagnostics, changes)).toEqual([
      { from: 6, to: 10, severity: "warning", message: "kept" },
    ]);
  });
});

describe("externalLint", () => {
  let view: EditorView | null = null;

  function mount(doc: string, path = "/repo/main.tf", root = "/repo") {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      doc,
      parent,
      extensions: [externalLint(path, root)],
    });
    return view;
  }

  /** Lets a resolved report travel through the lint plugin into the state. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function shown(target: EditorView) {
    const diagnostics: { text: string; message: string }[] = [];
    forEachDiagnostic(target.state, (diagnostic, from, to) => {
      diagnostics.push({
        text: target.state.sliceDoc(from, to),
        message: diagnostic.message,
      });
    });
    return diagnostics;
  }

  function deferredReport() {
    let resolve!: (value: LintReport) => void;
    const promise = new Promise<LintReport>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.mocked(runExternalLint).mockReset().mockResolvedValue(report([]));
    vi.mocked(vulnCheck).mockReset();
    resetVulnChecks();
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    localStorage.clear();
  });

  it("lints the file when it opens", async () => {
    vi.mocked(runExternalLint).mockResolvedValue(
      report([reported({ line: 2, column: 3 })]),
    );
    const target = mount("locals {\n  unused = 1\n}\n");
    await settle();

    expect(runExternalLint).toHaveBeenCalledExactlyOnceWith(
      "tflint",
      "/repo/main.tf",
      "/repo",
    );
    expect(shown(target)).toEqual([
      {
        text: "unused",
        message: "unused variable (terraform_unused_declarations) · tflint",
      },
    ]);
  });

  it("waits for a save instead of linting on every edit", async () => {
    const target = mount("a = 1\n");
    await settle();
    target.dispatch({ changes: { from: 0, insert: "b = 2\n" } });
    await settle();
    expect(runExternalLint).toHaveBeenCalledTimes(1);

    notifyExternalLintSaved(target);
    await settle();
    expect(runExternalLint).toHaveBeenCalledTimes(2);
  });

  it("keeps the underline on its text while the user types", async () => {
    vi.mocked(runExternalLint).mockResolvedValue(
      report([reported({ line: 2, column: 3 })]),
    );
    const target = mount("locals {\n  unused = 1\n}\n");
    await settle();

    target.dispatch({ changes: { from: 0, insert: "# note\n\n" } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(runExternalLint).toHaveBeenCalledTimes(1);
    expect(shown(target).map((item) => item.text)).toEqual(["unused"]);
  });

  it("maps a slow result through the edits made while the tool ran", async () => {
    const slow = deferredReport();
    vi.mocked(runExternalLint).mockReturnValueOnce(slow.promise);
    const target = mount("locals {\n  unused = 1\n}\n");
    target.dispatch({ changes: { from: 0, insert: "# note\n" } });

    slow.resolve(report([reported({ line: 2, column: 3 })]));
    await settle();

    expect(shown(target).map((item) => item.text)).toEqual(["unused"]);
  });

  it("drops a result that a newer save has made stale, then reruns once", async () => {
    const first = deferredReport();
    vi.mocked(runExternalLint)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        report([reported({ line: 1, message: "fresh", rule: null })]),
      );
    const target = mount("stale = 1\n");

    target.dispatch({ changes: { from: 0, to: 5, insert: "fresh" } });
    notifyExternalLintSaved(target);
    notifyExternalLintSaved(target);
    // Still one process: the saves wait for the run in flight.
    expect(runExternalLint).toHaveBeenCalledTimes(1);

    first.resolve(
      report([reported({ line: 1, message: "stale", rule: null })]),
    );
    await settle();

    expect(runExternalLint).toHaveBeenCalledTimes(2);
    expect(shown(target).map((item) => item.message)).toEqual([
      "fresh · tflint",
    ]);
  });

  it("ignores a result that arrives after the editor closed", async () => {
    const slow = deferredReport();
    vi.mocked(runExternalLint).mockReturnValueOnce(slow.promise);
    const target = mount("a = 1\n");
    target.destroy();
    view = null;

    slow.resolve(report([reported()]));
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);
  });

  it("treats a missing tool or a failed call as no findings", async () => {
    vi.mocked(runExternalLint).mockResolvedValueOnce({
      tool: "tflint",
      available: false,
      diagnostics: [],
      error: null,
    });
    const target = mount("a = 1\n");
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);

    vi.mocked(runExternalLint).mockRejectedValueOnce(new Error("no command"));
    notifyExternalLintSaved(target);
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);
  });

  it("stops and clears when the tool is switched off, and resumes when on", async () => {
    vi.mocked(runExternalLint).mockResolvedValue(report([reported()]));
    const target = mount("a = 1\n");
    await settle();
    expect(diagnosticCount(target.state)).toBe(1);

    saveLintToolEnabled("tflint", false);
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);
    notifyExternalLintSaved(target);
    await settle();
    expect(runExternalLint).toHaveBeenCalledTimes(1);

    saveLintToolEnabled("tflint", true);
    await settle();
    expect(runExternalLint).toHaveBeenCalledTimes(2);
    expect(diagnosticCount(target.state)).toBe(1);
  });

  it("does not start a disabled tool", async () => {
    saveLintToolEnabled("golangci-lint", false);
    mount("package main\n", "/repo/main.go");
    await settle();
    expect(runExternalLint).not.toHaveBeenCalled();
  });

  it("never runs for remote projects or files without a linter", async () => {
    expect(
      externalLint("remote://box/repo/main.tf", "remote://box/repo"),
    ).toEqual([]);
    expect(externalLint("/repo/main.tf", "")).toEqual([]);
    expect(externalLint("/repo/src/app.ts", "/repo")).toEqual([]);
    mount("a = 1\n", "remote://box/repo/main.tf", "remote://box/repo");
    await settle();
    expect(runExternalLint).not.toHaveBeenCalled();
  });

  it("reports the problem count for files syntax lint does not cover", async () => {
    vi.mocked(runExternalLint).mockResolvedValue(
      report([reported(), reported({ line: 2 })]),
    );
    const onErrorCount = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      doc: "a = 1\nb = 2\n",
      parent,
      extensions: [externalLint("/repo/main.tf", "/repo", onErrorCount)],
    });
    await settle();
    expect(onErrorCount).toHaveBeenLastCalledWith(2);
  });

  it("marks govulncheck findings for the open file as checks finish", async () => {
    const target = mount(
      "package main\n  http.Serve(l, nil)\n",
      "/repo/main.go",
    );
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);

    vi.mocked(vulnCheck).mockResolvedValue({
      available: true,
      modules: 1,
      findings: [finding(), finding({ path: "/repo/other.go" })],
      error: null,
    });
    await runVulnCheck("/repo");
    await settle();

    expect(shown(target)).toEqual([
      { text: "http", message: expect.stringContaining("GO-2024-0001") },
    ]);

    saveLintToolEnabled("govulncheck", false);
    await settle();
    expect(diagnosticCount(target.state)).toBe(0);
  });

  it("shows findings from an earlier check when a Go file opens", async () => {
    saveLintToolEnabled("golangci-lint", false);
    vi.mocked(vulnCheck).mockResolvedValue({
      available: true,
      modules: 1,
      findings: [finding()],
      error: null,
    });
    await runVulnCheck("/repo");

    const target = mount(
      "package main\n  http.Serve(l, nil)\n",
      "/repo/main.go",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(shown(target).map((item) => item.text)).toEqual(["http"]);
  });
});
