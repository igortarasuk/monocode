import { useEffect, useState } from "react";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import {
  layaStatus,
  layaStatusLine,
  setLayaConfig,
  startLaya,
  stopLaya,
  type LayaStatus,
} from "../model/laya";
import { LocalModelsView } from "./LocalModelsView";

const INPUT =
  "flex h-7 min-w-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20";

export function LayaSettings() {
  const [status, setStatus] = useState<LayaStatus | null>(null);
  const [cliPath, setCliPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  const run = async (
    label: string,
    action: () => Promise<LayaStatus | void>,
  ) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      const next = await action();
      if (next) {
        setStatus(next);
        setCliPath(next.cliPath);
      }
    } catch (reason) {
      setError(
        String(reason instanceof Error ? reason.message : reason).slice(0, 300),
      );
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void run("Checking", layaStatus);
    // Load once when the card mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch: Partial<Pick<LayaStatus, "gpu" | "enabled">>) =>
    run("Saving", () =>
      setLayaConfig(
        cliPath,
        patch.gpu ?? status?.gpu ?? true,
        patch.enabled ?? status?.enabled ?? true,
      ),
    );

  return (
    <div className="space-y-3 px-4 py-3.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${INPUT} w-80 max-w-full`}>
          <input
            value={cliPath}
            onChange={(event) => setCliPath(event.target.value)}
            onBlur={() => {
              if (status && cliPath.trim() !== status.cliPath) void save({});
            }}
            placeholder="~/Personal/laya-sandbox/laya"
            aria-label="Laya CLI path"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
          />
        </label>
        <Check
          label="GPU"
          on={status?.gpu ?? true}
          onChange={(gpu) => void save({ gpu })}
        />
        <Check
          label="Enabled"
          on={status?.enabled ?? true}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-content/60" aria-live="polite">
          {busy ? `${busy}…` : status ? layaStatusLine(status) : "Checking…"}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton
            disabled={!!busy}
            onClick={() => void run("Checking", layaStatus)}
          >
            Test
          </SecondaryButton>
          {status?.running ? (
            <SecondaryButton
              disabled={!!busy}
              onClick={() =>
                void run("Stopping", async () => {
                  await stopLaya();
                  return layaStatus();
                })
              }
            >
              Stop
            </SecondaryButton>
          ) : (
            <SecondaryButton
              disabled={!!busy || !status?.configured}
              onClick={() => void run("Starting (up to a minute)", startLaya)}
            >
              Start
            </SecondaryButton>
          )}
          <SecondaryButton
            disabled={!status?.configured}
            onClick={() => setManaging(true)}
          >
            Manage…
          </SecondaryButton>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-red-400/90">
          {error}
        </p>
      ) : null}
      {managing ? (
        <LocalModelsView
          onClose={() => {
            setManaging(false);
            void run("Checking", layaStatus);
          }}
        />
      ) : null}
    </div>
  );
}

function Check({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-content/70">
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
