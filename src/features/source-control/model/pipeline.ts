import { invoke } from "@tauri-apps/api/core";

export type PipelineJob = {
  id: number;
  name: string;
  status: string;
  url: string;
  allowFailure: boolean;
};

export type PipelineStage = {
  name: string;
  status: string;
  jobs: PipelineJob[];
};

export type Pipeline = {
  id: number;
  status: string;
  refName: string;
  sha: string;
  url: string;
  updatedAt: string;
  stages: PipelineStage[];
};

export type PipelineTone =
  | "success"
  | "failed"
  | "warning"
  | "running"
  | "waiting"
  | "manual"
  | "skipped";

export const ACTIVE_POLL_MS = 15_000;
export const IDLE_POLL_MS = 120_000;

const ACTIVE = new Set([
  "running",
  "pending",
  "preparing",
  "created",
  "waiting_for_resource",
  "scheduled",
]);

export function gitlabPipeline(cwd: string): Promise<Pipeline | null> {
  return invoke<Pipeline | null>("gitlab_pipeline", { cwd });
}

/** Still moving, so poll often. */
export function pipelineActive(pipeline: Pipeline | null): boolean {
  if (!pipeline) return false;
  return (
    ACTIVE.has(pipeline.status) ||
    pipeline.stages.some((stage) => ACTIVE.has(stage.status))
  );
}

export function pipelineTone(status: string): PipelineTone {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "warning") return "warning";
  if (status === "running") return "running";
  if (status === "manual") return "manual";
  if (status === "skipped" || status === "canceled") return "skipped";
  return "waiting";
}

export function pipelineStatusLabel(status: string): string {
  const label = status.replace(/_/g, " ");
  return label ? label[0].toUpperCase() + label.slice(1) : "Unknown";
}
