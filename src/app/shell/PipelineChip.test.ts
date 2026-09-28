// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

vi.mock("../../features/source-control/model/pipeline", async (original) => ({
  ...(await original<
    typeof import("../../features/source-control/model/pipeline")
  >()),
  gitlabPipeline: vi.fn(),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { PipelineChip } from "./PipelineChip";
import {
  gitlabPipeline,
  pipelineActive,
  pipelineTone,
  type Pipeline,
} from "../../features/source-control/model/pipeline";

const pipeline: Pipeline = {
  id: 391861,
  status: "running",
  refName: "master",
  sha: "0123456789abcdef",
  url: "https://gitlab.example.com/a/b/-/pipelines/391861",
  updatedAt: "2026-09-28T10:00:00Z",
  stages: [
    {
      name: "build",
      status: "success",
      jobs: [
        {
          id: 1,
          name: "image",
          status: "success",
          url: "https://gitlab.example.com/a/b/-/jobs/1",
          allowFailure: false,
        },
      ],
    },
    {
      name: "deploy",
      status: "running",
      jobs: [
        {
          id: 2,
          name: "apply",
          status: "running",
          url: "https://gitlab.example.com/a/b/-/jobs/2",
          allowFailure: false,
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body
    .querySelectorAll("[data-popover-side]")
    .forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.mocked(gitlabPipeline).mockReset();
});

async function render(project: string) {
  act(() => root.render(createElement(PipelineChip, { project })));
  await act(async () => {});
}

describe("pipeline model", () => {
  it("polls fast only while something runs", () => {
    expect(pipelineActive(pipeline)).toBe(true);
    expect(pipelineActive({ ...pipeline, status: "success", stages: [] })).toBe(
      false,
    );
    expect(pipelineActive(null)).toBe(false);
  });

  it("maps statuses to tones", () => {
    expect(pipelineTone("canceled")).toBe("skipped");
    expect(pipelineTone("waiting_for_resource")).toBe("waiting");
    expect(pipelineTone("warning")).toBe("warning");
  });
});

describe("PipelineChip", () => {
  it("renders nothing without a pipeline", async () => {
    vi.mocked(gitlabPipeline).mockResolvedValue(null);
    await render("/repo");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows one mark per stage and opens links from the panel", async () => {
    vi.mocked(gitlabPipeline).mockResolvedValue(pipeline);
    await render("/repo");

    const chip = container.querySelector<HTMLButtonElement>(
      '[aria-label="Pipeline #391861: Running"]',
    )!;
    expect(chip.textContent).toContain("#391861");
    expect(chip.querySelectorAll("svg")).toHaveLength(3);

    await act(async () => chip.click());
    const panel = document.querySelector('[aria-label="Pipeline"]')!;
    expect(panel.textContent).toContain("master · 01234567");
    const job = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "apply",
    )!;
    await act(async () => job.click());
    expect(openUrl).toHaveBeenCalledWith(
      "https://gitlab.example.com/a/b/-/jobs/2",
    );
    const open = [...panel.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open pipeline"),
    )!;
    await act(async () => open.click());
    expect(openUrl).toHaveBeenCalledWith(pipeline.url);
  });
});
