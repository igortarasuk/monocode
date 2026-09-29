import {
  gitRangeContext,
  listProjectFiles,
  readTextFile,
} from "../../../platform/tauri/fs";
import { layaClassify, layaPredict, layaStatus } from "../../laya/model/laya";
import { runGate, type GateOutcome } from "./automationGate";
import type { Automation } from "./automations";

/** Run an automation's Laya pre-check against the real backend. */
export function checkAutomationGate(
  automation: Pick<
    Automation,
    "gate" | "cwd" | "worktreeCwd" | "workspaceMode"
  >,
  prompt: string,
): Promise<GateOutcome> {
  const cwd =
    automation.workspaceMode === "existing" && automation.worktreeCwd
      ? automation.worktreeCwd
      : automation.cwd;
  let files: Map<string, string> | null = null;
  return runGate(automation.gate, prompt, {
    available: async () => {
      const status = await layaStatus();
      return status.enabled && status.configured;
    },
    classify: layaClassify,
    predict: layaPredict,
    diff: async () => (await gitRangeContext(cwd)).diffPatch,
    listFiles: async () => {
      files = new Map(
        (await listProjectFiles(cwd))
          .filter((file) => !file.isDir)
          .map((file) => [file.relative, file.path]),
      );
      return [...files.keys()];
    },
    readFile: (relative) => readTextFile(files?.get(relative) ?? relative),
  });
}
