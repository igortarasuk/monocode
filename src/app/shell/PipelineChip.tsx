import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  CircleAlert,
  CircleDashed,
  CircleX,
  ExternalLink,
  LoaderCircle,
  Minus,
  Play,
} from "../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../shared/ui/Popover";
import { InboxProviderMark } from "../../features/inbox/ui/InboxProviderMark";
import { subscribeGitChanged } from "../../platform/tauri/fs";
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  gitlabPipeline,
  pipelineActive,
  pipelineStatusLabel,
  pipelineTone,
  type Pipeline,
  type PipelineTone,
} from "../../features/source-control/model/pipeline";

const PUSH_SETTLE_MS = 4_000;

/** Latest pipeline of the project branch, polled while it runs. */
export function usePipeline(project: string | undefined): Pipeline | null {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    setPipeline(null);
  }, [project]);

  useEffect(() => {
    if (!project || project === "~") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void gitlabPipeline(project)
        .catch(() => null)
        .then((next) => {
          if (cancelled) return;
          setPipeline(next);
          const delay = pipelineActive(next) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
          timer = setTimeout(load, delay);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [project, nonce]);

  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onGitChanged = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(reload, PUSH_SETTLE_MS);
    };
    const unsubscribe = subscribeGitChanged(onGitChanged);
    window.addEventListener("focus", reload);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", reload);
      if (settle) clearTimeout(settle);
    };
  }, [reload]);

  return pipeline;
}

const TONE_CLASS: Record<PipelineTone, string> = {
  success: "text-emerald-500",
  failed: "text-red-500",
  warning: "text-amber-500",
  running: "text-sky-500",
  waiting: "text-content/35",
  manual: "text-content/50",
  skipped: "text-content/30",
};

export function PipelineStatusIcon({
  status,
  className = "size-3",
}: {
  status: string;
  className?: string;
}) {
  const tone = pipelineTone(status);
  const props = {
    className: `${className} shrink-0 ${TONE_CLASS[tone]} ${
      tone === "running" ? "animate-spin" : ""
    }`,
    strokeWidth: 2,
    "aria-hidden": true,
  } as const;
  if (tone === "success") return <CheckCircle {...props} />;
  if (tone === "failed") return <CircleX {...props} />;
  if (tone === "warning") return <CircleAlert {...props} />;
  if (tone === "running") return <LoaderCircle {...props} />;
  if (tone === "manual") return <Play {...props} />;
  if (tone === "skipped") return <Minus {...props} />;
  return <CircleDashed {...props} />;
}

export function PipelineChip({ project }: { project?: string }) {
  const pipeline = usePipeline(project);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  if (!pipeline) return null;

  const label = `Pipeline #${pipeline.id}: ${pipelineStatusLabel(pipeline.status)}`;
  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") {
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-content/55 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <InboxProviderMark provider="gitlab" className="size-3 shrink-0" />
        {pipeline.stages.length > 0 ? (
          pipeline.stages.map((stage) => (
            <PipelineStatusIcon
              key={stage.name}
              status={stage.status}
              className="size-2.5"
            />
          ))
        ) : (
          <PipelineStatusIcon status={pipeline.status} className="size-2.5" />
        )}
        <span className="tabular-nums">#{pipeline.id}</span>
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          width={300}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label="Pipeline"
          tabIndex={-1}
          className="text-content"
        >
          <PipelinePanel pipeline={pipeline} />
        </Popover>
      ) : null}
    </>
  );
}

function PipelinePanel({ pipeline }: { pipeline: Pipeline }) {
  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <PipelineStatusIcon status={pipeline.status} className="size-4" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            Pipeline #{pipeline.id} · {pipelineStatusLabel(pipeline.status)}
          </div>
          <div className="truncate text-[11px] text-content/50">
            {pipeline.refName}
            {pipeline.sha ? ` · ${pipeline.sha.slice(0, 8)}` : ""}
          </div>
        </div>
      </div>
      {pipeline.stages.map((stage) => (
        <div key={stage.name} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-content/60">
            <PipelineStatusIcon status={stage.status} className="size-3" />
            <span className="truncate">{stage.name}</span>
          </div>
          {stage.jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              disabled={!job.url}
              title={`${job.name}: ${pipelineStatusLabel(job.status)}`}
              onClick={() => void openUrl(job.url)}
              className="ml-4 flex h-6 items-center gap-1.5 rounded px-1.5 text-left hover:bg-content/10 disabled:hover:bg-transparent"
            >
              <PipelineStatusIcon status={job.status} className="size-3" />
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              {job.allowFailure && job.status === "failed" ? (
                <span className="text-[10px] text-amber-500">allowed</span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
      {pipeline.url ? (
        <button
          type="button"
          onClick={() => void openUrl(pipeline.url)}
          className="mt-1 flex h-7 items-center justify-center gap-1.5 rounded-md bg-content/10 text-[12px] font-medium hover:bg-content/15"
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden />
          Open pipeline
        </button>
      ) : null}
    </div>
  );
}
