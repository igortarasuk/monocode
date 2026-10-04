import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import {
  ChangeSet,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  tooltips,
  type ViewUpdate,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basename } from "../../../platform/tauri/fs";
import {
  VULN_CHECK_TOOL,
  externalLint as runExternalLint,
  type ExternalLintTool,
  type LintDiagnostic,
  type VulnFinding,
} from "../../../platform/tauri/lint";
import { slash } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import {
  loadLintToolEnabled,
  subscribeLintTools,
} from "../../settings/model/lintTools";
import {
  subscribeVulnCheck,
  vulnFindingsForFile,
} from "../../source-control/model/vulnCheck";
import { isAnsibleYaml } from "./editorLanguage";
import { errorCountReporter, isLintable, lintTheme } from "./editorLint";

/**
 * Diagnostics from linters that run outside the editor: tflint, ansible-lint
 * and golangci-lint for the open file, plus govulncheck findings left by the
 * last post-commit check.
 *
 * These tools read the file from disk, so they run when it is opened and after
 * each save rather than per keystroke. Between runs the last results are kept
 * and moved along with edits, so an underline stays on the text it was
 * reported for while the user keeps typing.
 */

/** A linter with hundreds of findings is reporting noise, not this file. */
const MAX_DIAGNOSTICS = 200;

/**
 * Cached results are re-read after an edit only to keep them in the lint
 * state; fresh results skip the wait with `forceLinting`.
 */
const REFRESH_DELAY_MS = 300;

/** The linter that checks this file, by path alone. */
export function externalLintToolForPath(path: string): ExternalLintTool | null {
  const name = basename(path).toLowerCase();
  const extension = extensionOf(name);
  if (extension === ".tf") return "tflint";
  if (extension === ".go") return "golangci-lint";
  if (
    (extension === ".yml" || extension === ".yaml") &&
    isAnsibleYaml(path, name)
  ) {
    return "ansible-lint";
  }
  return null;
}

function extensionOf(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
}

/** govulncheck traces end in Go source, so only those files can be marked. */
function canHoldVulnFindings(path: string): boolean {
  return extensionOf(basename(path).toLowerCase()) === ".go";
}

function isRemote(path: string): boolean {
  return slash(path).startsWith(REMOTE_PATH_PREFIX);
}

type ReportedRange = Pick<
  LintDiagnostic,
  "line" | "column" | "endLine" | "endColumn"
>;

/**
 * One-based line/column from a tool, as document offsets. The file on disk can
 * be a save behind the document and tools count columns in their own units,
 * so everything is clamped rather than trusted.
 */
export function diagnosticRange(
  doc: Text,
  { line, column, endLine, endColumn }: ReportedRange,
): { from: number; to: number } {
  const start = doc.line(clamp(line, 1, doc.lines));
  const content = lineContent(start.from, start.text);
  if (column == null || !Number.isFinite(column) || column < 1) return content;

  const from = Math.min(start.from + Math.trunc(column) - 1, start.to);
  if (endLine != null || endColumn != null) {
    const end = doc.line(
      clamp(endLine ?? start.number, start.number, doc.lines),
    );
    const to =
      endColumn != null && Number.isFinite(endColumn) && endColumn >= 1
        ? Math.min(end.from + Math.trunc(endColumn) - 1, end.to)
        : lineContent(end.from, end.text).to;
    if (to > from) return { from, to };
  }

  // A bare position: underline the token there, or the one character.
  const rest = start.text.slice(from - start.from);
  const token = rest.match(/^[\w$]+|^\S/)?.[0].length ?? 0;
  return { from, to: from + token };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** The line without its indentation or trailing whitespace. */
function lineContent(from: number, text: string): { from: number; to: number } {
  const trimmed = text.trimEnd();
  const indent = trimmed.length - trimmed.trimStart().length;
  return { from: from + indent, to: from + trimmed.length };
}

function docsAction(url: string | null): Pick<Diagnostic, "actions"> {
  if (!url || !/^https?:\/\//i.test(url)) return {};
  return { actions: [{ name: "Docs", apply: () => void openUrl(url) }] };
}

export function lintDiagnostic(
  doc: Text,
  reported: LintDiagnostic,
): Diagnostic {
  const rule =
    reported.rule && !reported.message.includes(reported.rule)
      ? ` (${reported.rule})`
      : "";
  return {
    ...diagnosticRange(doc, reported),
    severity:
      reported.severity === "error"
        ? "error"
        : reported.severity === "info"
          ? "info"
          : "warning",
    message: `${reported.message}${rule} · ${reported.source}`,
    ...docsAction(reported.url),
  };
}

export function vulnDiagnostic(doc: Text, finding: VulnFinding): Diagnostic {
  const found = finding.foundVersion ? `@${finding.foundVersion}` : "";
  const fix = finding.fixedVersion
    ? `fixed in ${finding.fixedVersion}`
    : "no fix available";
  return {
    ...diagnosticRange(doc, {
      line: finding.line ?? 1,
      column: finding.column,
      endLine: null,
      endColumn: null,
    }),
    severity: "warning",
    message: `${finding.id}: ${finding.summary} — ${finding.module}${found}, ${fix} · ${VULN_CHECK_TOOL}`,
    ...docsAction(finding.url),
  };
}

/**
 * Carries diagnostics across an edit. One whose text was deleted goes with it;
 * the next run would not report it there either.
 */
export function mapDiagnostics(
  diagnostics: readonly Diagnostic[],
  changes: ChangeDesc,
): readonly Diagnostic[] {
  if (changes.empty || diagnostics.length === 0) return diagnostics;
  const mapped: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const from = changes.mapPos(diagnostic.from, 1);
    const to = Math.max(from, changes.mapPos(diagnostic.to, -1));
    if (diagnostic.to > diagnostic.from && to === from) continue;
    mapped.push({ ...diagnostic, from, to });
  }
  return mapped;
}

/**
 * Dispatched once the document has reached disk (a save) or come from it (a
 * reload): the moment an external linter would see something new.
 */
export const externalLintSaved = StateEffect.define<null>();

/** Harmless on editors without an external linter. */
export function notifyExternalLintSaved(view: EditorView) {
  view.dispatch({ effects: externalLintSaved.of(null) });
}

type Cached = {
  lint: readonly Diagnostic[];
  vuln: readonly Diagnostic[];
};

const setLintDiagnostics = StateEffect.define<readonly Diagnostic[]>();
const setVulnDiagnostics = StateEffect.define<readonly Diagnostic[]>();

/** Warnings and notes in the same text-decoration style as `lintTheme`. */
const externalLintTheme = EditorView.theme({
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy #fbbf24",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-info": {
    backgroundImage: "none",
    textDecoration: "underline wavy #60a5fa",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip-lint .cm-diagnostic-warning": {
    borderLeft: "2px solid #fbbf24",
  },
  ".cm-tooltip-lint .cm-diagnostic-info": {
    borderLeft: "2px solid #60a5fa",
  },
});

/**
 * Lint tooltips open above their text. Measured against the window there is
 * room above the first lines, but that room is the tab bar and the editor
 * clips what lands there; measured against the editor they flip below.
 */
const tooltipsInsideEditor = tooltips({
  tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect(),
});

export function externalLint(
  path: string,
  root: string,
  onErrorCount?: (count: number) => void,
): Extension {
  const tool = externalLintToolForPath(path);
  const marksVulns = canHoldVulnFindings(path);
  if (!tool && !marksVulns) return [];
  // The tools run on this computer, against folders it can read.
  if (!root || root === "~" || isRemote(root) || isRemote(path)) return [];

  const vulnFindings = (): VulnFinding[] =>
    marksVulns && loadLintToolEnabled(VULN_CHECK_TOOL)
      ? vulnFindingsForFile(path)
      : [];
  const vulnDiagnostics = (doc: Text): readonly Diagnostic[] =>
    vulnFindings().map((finding) => vulnDiagnostic(doc, finding));

  const cache = StateField.define<Cached>({
    create: (state) => ({ lint: [], vuln: vulnDiagnostics(state.doc) }),
    update(value, transaction) {
      let { lint, vuln } = value;
      if (transaction.docChanged) {
        lint = mapDiagnostics(lint, transaction.changes);
        vuln = mapDiagnostics(vuln, transaction.changes);
      }
      for (const effect of transaction.effects) {
        if (effect.is(setLintDiagnostics)) lint = effect.value;
        if (effect.is(setVulnDiagnostics)) vuln = effect.value;
      }
      return lint === value.lint && vuln === value.vuln
        ? value
        : { lint, vuln };
    },
  });

  class Runner {
    /** The document as the linter sees it, and the edits made since. */
    private disk: Text;
    private sinceDisk: ChangeSet;
    /** Bumped whenever a result for an older `disk` would be wrong. */
    private version = 0;
    private running = false;
    private queued = false;
    private destroyed = false;
    private enabled = tool !== null && loadLintToolEnabled(tool);
    private vulnKey = "";
    private readonly unsubscribe: (() => void)[];

    constructor(private readonly view: EditorView) {
      this.disk = view.state.doc;
      this.sinceDisk = ChangeSet.empty(this.disk.length);
      this.vulnKey = JSON.stringify(vulnFindings());
      this.unsubscribe = [
        subscribeLintTools(this.onSettings),
        subscribeVulnCheck(this.syncVulns),
      ];
      this.run();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.sinceDisk = this.sinceDisk.compose(update.changes);
      }
      const saved = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(externalLintSaved)),
      );
      if (!saved) return;
      this.disk = update.state.doc;
      this.sinceDisk = ChangeSet.empty(this.disk.length);
      this.version += 1;
      this.run();
    }

    destroy() {
      this.destroyed = true;
      for (const unsubscribe of this.unsubscribe) unsubscribe();
    }

    private run() {
      if (!tool || !this.enabled || this.destroyed) return;
      // One process per file: ansible-lint takes seconds, saves come faster.
      if (this.running) {
        this.queued = true;
        return;
      }
      this.running = true;
      const version = this.version;
      void runExternalLint(tool, path, root)
        .then(
          (report) => report.diagnostics ?? [],
          // No backend answer is no findings, not an editor error.
          () => [] as LintDiagnostic[],
        )
        .then((reported) => {
          this.running = false;
          if (this.destroyed) return;
          // Saved again (or switched off) while the tool ran: these positions
          // describe a file that is no longer the one on disk.
          if (version === this.version && this.enabled) this.show(reported);
          if (this.queued) {
            this.queued = false;
            this.run();
          }
        });
    }

    private show(reported: LintDiagnostic[]) {
      const diagnostics = reported
        .slice(0, MAX_DIAGNOSTICS)
        .map((item) => lintDiagnostic(this.disk, item));
      this.publish(
        setLintDiagnostics.of(mapDiagnostics(diagnostics, this.sinceDisk)),
      );
    }

    private publish(effect: StateEffect<readonly Diagnostic[]>) {
      this.view.dispatch({ effects: effect });
      forceLinting(this.view);
    }

    /** Arrow so it can be handed to the stores as a listener. */
    private syncVulns = () => {
      if (this.destroyed) return;
      // Unchanged findings keep the positions edits have already moved.
      const key = JSON.stringify(vulnFindings());
      if (key === this.vulnKey) return;
      this.vulnKey = key;
      this.publish(setVulnDiagnostics.of(vulnDiagnostics(this.view.state.doc)));
    };

    private onSettings = () => {
      if (this.destroyed) return;
      const enabled = tool !== null && loadLintToolEnabled(tool);
      if (enabled !== this.enabled) {
        this.enabled = enabled;
        if (enabled) {
          this.run();
        } else {
          this.version += 1;
          this.queued = false;
          this.publish(setLintDiagnostics.of([]));
        }
      }
      this.syncVulns();
    };
  }

  return [
    cache,
    ViewPlugin.fromClass(Runner),
    linter(
      (view) => {
        const { lint, vuln } = view.state.field(cache);
        return [...lint, ...vuln];
      },
      {
        delay: REFRESH_DELAY_MS,
        needsRefresh: (update) =>
          update.state.field(cache) !== update.startState.field(cache),
      },
    ),
    externalLintTheme,
    tooltipsInsideEditor,
    // Files with syntax lint already carry the reporter and the error theme.
    isLintable(path)
      ? []
      : [onErrorCount ? errorCountReporter(onErrorCount) : [], lintTheme],
  ];
}
