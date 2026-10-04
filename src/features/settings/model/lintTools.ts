import {
  EXTERNAL_LINT_TOOLS,
  VULN_CHECK_TOOL,
  type LintToolId,
} from "../../../platform/tauri/lint";
import { flagStore } from "./displayPrefs";

/** External tools are on until switched off; a missing tool is simply skipped. */
export const LINT_TOOL_DEFAULT = true;

export type LintToolSetting = {
  tool: LintToolId;
  /** The row's `data-setting-id`, and its `SETTINGS_INDEX` id. */
  id: string;
  label: string;
  description: string;
  keywords: string;
};

const DETAILS: Record<
  LintToolId,
  Pick<LintToolSetting, "label" | "description" | "keywords">
> = {
  tflint: {
    label: "Lint Terraform with tflint",
    description:
      "Run tflint when a .tf file is opened or saved and underline what it reports.",
    keywords: "terraform tf hcl linter editor diagnostics",
  },
  "ansible-lint": {
    label: "Lint Ansible with ansible-lint",
    description:
      "Run ansible-lint when a playbook, role or task file is opened or saved and underline what it reports.",
    keywords: "ansible yaml playbook role linter editor diagnostics",
  },
  "golangci-lint": {
    label: "Lint Go with golangci-lint",
    description:
      "Run golangci-lint when a .go file is opened or saved and underline what it reports.",
    keywords: "go golang linter editor diagnostics",
  },
  govulncheck: {
    label: "Check Go vulnerabilities after commit",
    description:
      "Run govulncheck in the background after each commit made from Monochrome and mark the affected lines in the editor.",
    keywords: "go golang govulncheck security vulnerability commit hook",
  },
};

const TOOLS: LintToolId[] = [...EXTERNAL_LINT_TOOLS, VULN_CHECK_TOOL];

/** Every tool with a switch, in the order Settings lists them. */
export const LINT_TOOL_SETTINGS: LintToolSetting[] = TOOLS.map((tool) => ({
  tool,
  id: `lint-${tool}`,
  ...DETAILS[tool],
}));

const stores = new Map(
  LINT_TOOL_SETTINGS.map(({ tool }) => [
    tool,
    flagStore(
      `monocode.lint.${tool}`,
      LINT_TOOL_DEFAULT,
      `monocode:lint-${tool}-change`,
    ),
  ]),
);

function store(tool: LintToolId) {
  return stores.get(tool)!;
}

export function loadLintToolEnabled(tool: LintToolId): boolean {
  return store(tool).load();
}

export function saveLintToolEnabled(tool: LintToolId, value: boolean) {
  store(tool).save(value);
}

export function useLintToolEnabled(tool: LintToolId): boolean {
  return store(tool).useFlag();
}

/** Open editors listen here so a switch takes effect without a reopen. */
export function subscribeLintTools(onStoreChange: () => void) {
  const unsubscribes = [...stores.values()].map((flag) =>
    flag.subscribe(onStoreChange),
  );
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}
