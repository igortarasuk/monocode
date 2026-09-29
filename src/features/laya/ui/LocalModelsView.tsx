import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { LoaderCircle, X } from "../../../shared/ui/icons";
import {
  layaDomain,
  layaDomains,
  layaLearn,
  layaStats,
  layaTrain,
  type LayaDomain,
  type LayaStats,
} from "../model/laya";
import {
  formatBytes,
  ollamaDelete,
  ollamaList,
  ollamaPull,
  type OllamaModel,
} from "../model/ollama";

const FIELD =
  "w-full rounded-md border border-content/12 bg-transparent px-2.5 py-1.5 text-[12px] outline-none focus:border-content/30";
const EXCLUDABLE = ["synthetic", "seed"] as const;

function message(reason: unknown): string {
  return String(reason instanceof Error ? reason.message : reason).slice(
    0,
    300,
  );
}

/** Laya domains (rules, stats, training, corrections) and local Ollama models. */
export function LocalModelsView({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Local models"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex min-h-0 w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-content/12 bg-background-base text-content shadow-2xl">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-stroke px-4">
          <h1 className="text-[13px] font-semibold">Local models</h1>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-5">
          <LayaSection />
          <OllamaSection />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-[12px] text-red-400/90">
      {error}
    </p>
  ) : null;
}

function LayaSection() {
  const [domains, setDomains] = useState<string[] | null>(null);
  const [domain, setDomain] = useState("");
  const [config, setConfig] = useState<LayaDomain | null>(null);
  const [stats, setStats] = useState<LayaStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    layaDomains()
      .then((list) => {
        setDomains(list);
        setDomain((current) => current || list[0] || "");
      })
      .catch((reason) => {
        setDomains([]);
        setError(message(reason));
      });
  }, []);

  const refresh = useCallback(async (name: string) => {
    setError(null);
    try {
      const [nextConfig, nextStats] = await Promise.all([
        layaDomain(name),
        layaStats(name),
      ]);
      setConfig(nextConfig);
      setStats(nextStats);
    } catch (reason) {
      setError(message(reason));
    }
  }, []);

  useEffect(() => {
    if (domain) void refresh(domain);
  }, [domain, refresh]);

  if (domains === null)
    return (
      <Section title="Laya">
        <p className="flex items-center gap-2 text-[12px] text-content/50">
          <LoaderCircle className="size-3.5 animate-spin" /> Starting Laya…
        </p>
      </Section>
    );

  return (
    <Section
      title="Laya"
      action={
        domains.length > 1 ? (
          <select
            aria-label="Domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            className="rounded-md border border-content/12 bg-transparent px-2 py-1 text-[12px]"
          >
            {domains.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      <ErrorLine error={error} />
      {!domains.length ? (
        <p className="text-[12px] text-content/50">No domains.</p>
      ) : null}
      {stats ? <StatsCard stats={stats} /> : null}
      {config ? (
        <RulesTable config={config} trained={stats?.heads ?? []} />
      ) : null}
      {domain ? (
        <>
          <TrainCard domain={domain} onTrained={() => void refresh(domain)} />
          <CorrectionForm
            domain={domain}
            rules={Object.keys(config?.rules ?? {})}
            onSaved={() => void refresh(domain)}
          />
        </>
      ) : null}
    </Section>
  );
}

function StatsCard({ stats }: { stats: LayaStats }) {
  return (
    <div className="mb-4 flex flex-wrap gap-4 rounded-lg border border-content/10 px-4 py-3 text-[12px]">
      {Object.entries(stats.sources).map(([source, count]) => (
        <span key={source}>
          <span className="text-content/50">{source}</span>{" "}
          <span className="font-medium tabular-nums">{count}</span>
        </span>
      ))}
      <span>
        <span className="text-content/50">total</span>{" "}
        <span className="font-medium tabular-nums">{stats.total}</span>
      </span>
      <span className="text-content/50">
        {stats.trained_at
          ? `heads trained ${new Date(stats.trained_at * 1000).toLocaleString()}`
          : "no trained heads"}
      </span>
    </div>
  );
}

function RulesTable({
  config,
  trained,
}: {
  config: LayaDomain;
  trained: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="mb-4 divide-y divide-content/7 rounded-lg border border-content/10 text-[12px]">
      {Object.entries(config.rules).map(([id, rule]) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => setOpen(open === id ? null : id)}
            className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-content/4"
          >
            <span className="font-mono">{id}</span>
            <span className="text-content/45">
              {(rule.scope ?? ["tasks"]).join(", ")}
            </span>
            <span className="ml-auto text-content/45">
              {trained.includes(id) ? "head" : "zero-shot"}
              {rule.threshold != null ? ` · threshold ${rule.threshold}` : ""}
            </span>
          </button>
          {open === id ? (
            <div className="space-y-1.5 px-4 pb-3 text-content/70">
              {rule.nudge ? <p>{rule.nudge}</p> : null}
              {rule.question ? (
                <p className="text-content/50">Question: {rule.question}</p>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TrainCard({
  domain,
  onTrained,
}: {
  domain: string;
  onTrained: () => void;
}) {
  const [exclude, setExclude] = useState<string[]>(["synthetic"]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const train = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await layaTrain(domain, exclude));
      onTrained();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setRunning(false);
    }
  };

  const rules = (report?.rules ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const cell = (value: unknown) =>
    typeof value === "number" ? value : value == null ? "–" : String(value);

  return (
    <div className="mb-4 rounded-lg border border-content/10 px-4 py-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">Train heads</span>
        {EXCLUDABLE.map((source) => (
          <label
            key={source}
            className="flex items-center gap-1.5 text-content/70"
          >
            <input
              type="checkbox"
              checked={exclude.includes(source)}
              onChange={(event) =>
                setExclude((current) =>
                  event.target.checked
                    ? [...current, source]
                    : current.filter((item) => item !== source),
                )
              }
            />
            exclude {source}
          </label>
        ))}
        <span className="ml-auto">
          <SecondaryButton disabled={running} onClick={() => void train()}>
            {running ? "Training…" : "Train"}
          </SecondaryButton>
        </span>
      </div>
      <ErrorLine error={error} />
      {report ? (
        <table className="mt-3 w-full text-left tabular-nums">
          <thead className="text-content/45">
            <tr>
              <th className="py-1 font-normal">Rule</th>
              <th className="font-normal">F1</th>
              <th className="font-normal">Precision</th>
              <th className="font-normal">Recall</th>
              <th className="font-normal">Gold F1</th>
              <th className="font-normal">Threshold</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(rules).map(([rule, metrics]) => {
              const gold = (metrics.gold ?? {}) as Record<string, unknown>;
              return (
                <tr key={rule} className="border-t border-content/7">
                  <td className="py-1 font-mono">{rule}</td>
                  {metrics.skipped ? (
                    <td colSpan={5} className="text-content/45">
                      skipped: {String(metrics.skipped)}
                    </td>
                  ) : (
                    <>
                      <td>{cell(metrics.f1)}</td>
                      <td>{cell(metrics.precision)}</td>
                      <td>{cell(metrics.recall)}</td>
                      <td>{cell(gold.f1)}</td>
                      <td>{cell(metrics.threshold)}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function CorrectionForm({
  domain,
  rules,
  onSaved,
}: {
  domain: string;
  rules: string[];
  onSaved: () => void;
}) {
  const [bad, setBad] = useState("");
  const [good, setGood] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const reply = await layaLearn(domain, {
        bad,
        good,
        rules: picked,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setResult(`Stored ${String(reply.stored ?? 0)} example(s).`);
      setBad("");
      setGood("");
      setNote("");
      onSaved();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-content/10 px-4 py-3 text-[12px]">
      <p className="mb-2 font-medium">Add correction</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <textarea
          aria-label="Bad example"
          placeholder="Bad: the chunk as written"
          value={bad}
          onChange={(event) => setBad(event.target.value)}
          rows={6}
          className={`${FIELD} font-mono`}
        />
        <textarea
          aria-label="Good example"
          placeholder="Good: the fixed chunk"
          value={good}
          onChange={(event) => setGood(event.target.value)}
          rows={6}
          className={`${FIELD} font-mono`}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {rules.map((rule) => (
          <label
            key={rule}
            className="flex items-center gap-1.5 text-content/70"
          >
            <input
              type="checkbox"
              checked={picked.includes(rule)}
              onChange={(event) =>
                setPicked((current) =>
                  event.target.checked
                    ? [...current, rule]
                    : current.filter((item) => item !== rule),
                )
              }
            />
            <span className="font-mono">{rule}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          aria-label="Note"
          placeholder="Note (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className={FIELD}
        />
        <SecondaryButton
          disabled={busy || !bad.trim() || !good.trim() || !picked.length}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </SecondaryButton>
      </div>
      {result ? <p className="mt-2 text-content/60">{result}</p> : null}
      <ErrorLine error={error} />
    </div>
  );
}

function OllamaSection() {
  const [models, setModels] = useState<OllamaModel[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels(await ollamaList());
    } catch (reason) {
      setModels([]);
      setError(message(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Ollama">
      <div className="mb-3 flex items-center gap-2">
        <input
          aria-label="Model to pull"
          placeholder="Model to pull, e.g. qwen3:8b"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={FIELD}
        />
        <SecondaryButton
          disabled={!!busy || !name.trim()}
          onClick={() =>
            void act(`Pulling ${name.trim()}`, async () => {
              await ollamaPull(name.trim());
              setName("");
            })
          }
        >
          Pull
        </SecondaryButton>
      </div>
      {busy ? (
        <p className="mb-2 flex items-center gap-2 text-[12px] text-content/55">
          <LoaderCircle className="size-3.5 animate-spin" /> {busy}…
        </p>
      ) : null}
      <ErrorLine error={error} />
      {models === null ? (
        <p className="text-[12px] text-content/50">Loading…</p>
      ) : models.length ? (
        <ul className="divide-y divide-content/7 rounded-lg border border-content/10 text-[12px]">
          {models.map((model) => (
            <li key={model.name} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate font-mono">
                {model.name}
              </span>
              <span className="text-content/50">
                {[model.parameterSize, model.quantization]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="w-16 text-right tabular-nums text-content/50">
                {formatBytes(model.size)}
              </span>
              <span className="w-24 text-right text-content/40">
                {model.modifiedAt
                  ? new Date(model.modifiedAt).toLocaleDateString()
                  : ""}
              </span>
              <SecondaryButton
                danger
                disabled={!!busy}
                onClick={() => {
                  if (!window.confirm(`Delete ${model.name} from Ollama?`))
                    return;
                  void act(`Deleting ${model.name}`, () =>
                    ollamaDelete(model.name),
                  );
                }}
              >
                Delete
              </SecondaryButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-content/50">No local models.</p>
      )}
    </Section>
  );
}
