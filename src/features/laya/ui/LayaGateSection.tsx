import { useEffect, useState, type ReactNode } from "react";
import type { AutomationGate } from "../../automations/model/automations";
import { defaultGate } from "../../automations/model/automationGate";
import { layaDomains, layaPresets, layaStatus } from "../model/laya";

const FIELD =
  "rounded-md border border-content/12 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-content/30";

type Catalog = {
  configured: boolean;
  domains: string[];
  presets: Record<string, string[]>;
  error?: string;
};

/**
 * "Pre-check with Laya" for an automation. Domains and presets come from the
 * sandbox at runtime; nothing is assumed when Laya is unreachable.
 */
export function LayaGateSection({
  gate,
  onChange,
}: {
  gate: AutomationGate | null | undefined;
  onChange: (gate: AutomationGate | null) => void;
}) {
  const [open, setOpen] = useState(Boolean(gate));
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    if (!open || catalog) return;
    let live = true;
    void (async () => {
      try {
        const status = await layaStatus();
        if (!status.configured || !status.enabled) {
          if (live) setCatalog({ configured: false, domains: [], presets: {} });
          return;
        }
        const [domains, presets] = await Promise.all([
          layaDomains(),
          layaPresets().catch(() => ({})),
        ]);
        if (live) setCatalog({ configured: true, domains, presets });
      } catch (reason) {
        if (live)
          setCatalog({
            configured: true,
            domains: [],
            presets: {},
            error: String(reason instanceof Error ? reason.message : reason),
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [catalog, open]);

  const set = (patch: Partial<AutomationGate>) =>
    gate && onChange({ ...gate, ...patch });

  const presetNames = Object.keys(catalog?.presets ?? {});
  const keys =
    gate?.kind === "laya-preset" && gate.preset
      ? (catalog?.presets[gate.preset] ?? [])
      : [];
  let questionsError: string | null = null;
  if (gate?.kind === "laya-custom" && gate.questions?.trim()) {
    try {
      const value: unknown = JSON.parse(gate.questions);
      if (!value || typeof value !== "object" || Array.isArray(value))
        questionsError = "Questions must be a JSON object";
    } catch {
      questionsError = "Not valid JSON";
    }
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-md border border-content/10"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-content/70">
        Pre-check with Laya{gate ? " · on" : ""}
      </summary>
      <div className="space-y-3 border-t border-content/7 px-3 py-3 text-[12px]">
        {!catalog ? (
          <p className="text-content/45">Loading Laya…</p>
        ) : !catalog.configured ? (
          <p className="text-content/45">
            Laya is not set up. Configure it in Settings → Inbox → Laya.
          </p>
        ) : (
          <>
            {catalog.error ? (
              <p className="text-red-400/90">{catalog.error}</p>
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(gate)}
                onChange={(event) =>
                  onChange(
                    event.target.checked ? defaultGate(catalog.domains) : null,
                  )
                }
              />
              Run Laya before starting the session
            </label>
            {gate ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Check">
                  <select
                    aria-label="Pre-check kind"
                    value={gate.kind}
                    onChange={(event) =>
                      set({
                        kind: event.target.value as AutomationGate["kind"],
                        key: undefined,
                      })
                    }
                    className={FIELD}
                  >
                    <option value="laya-classify">Rules of a domain</option>
                    <option value="laya-preset" disabled={!presetNames.length}>
                      Preset questions
                    </option>
                    <option value="laya-custom">Custom questions</option>
                  </select>
                </Field>
                {gate.kind === "laya-classify" ? (
                  <Field label="Domain">
                    <select
                      aria-label="Domain"
                      value={gate.domain ?? ""}
                      onChange={(event) =>
                        set({ domain: event.target.value || undefined })
                      }
                      className={FIELD}
                    >
                      <option value="">Choose…</option>
                      {withCurrent(catalog.domains, gate.domain).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                {gate.kind === "laya-preset" ? (
                  <>
                    <Field label="Preset">
                      <select
                        aria-label="Preset"
                        value={gate.preset ?? ""}
                        onChange={(event) =>
                          set({
                            preset: event.target.value || undefined,
                            key: undefined,
                          })
                        }
                        className={FIELD}
                      >
                        <option value="">Choose…</option>
                        {withCurrent(presetNames, gate.preset).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Deciding answer">
                      <select
                        aria-label="Deciding answer"
                        value={gate.key ?? ""}
                        onChange={(event) =>
                          set({ key: event.target.value || undefined })
                        }
                        className={FIELD}
                      >
                        <option value="">First answer</option>
                        {withCurrent(keys, gate.key).map((key) => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                ) : null}
                {gate.kind === "laya-custom" ? (
                  <div className="sm:col-span-2">
                    <Field label="Questions (JSON)">
                      <textarea
                        aria-label="Questions"
                        value={gate.questions ?? ""}
                        onChange={(event) =>
                          set({ questions: event.target.value })
                        }
                        rows={5}
                        spellCheck={false}
                        placeholder='{"risky": {"type": "noul", "instructions": "…"}}'
                        className={`${FIELD} w-full font-mono`}
                      />
                    </Field>
                    {questionsError ? (
                      <p className="mt-1 text-red-400/90">{questionsError}</p>
                    ) : null}
                  </div>
                ) : null}
                <Field label={`Threshold ${gate.threshold.toFixed(2)}`}>
                  <input
                    type="range"
                    aria-label="Threshold"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={gate.threshold}
                    onChange={(event) =>
                      set({ threshold: Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Input">
                  <select
                    aria-label="Input"
                    value={gate.input}
                    onChange={(event) =>
                      set({
                        input: event.target.value as AutomationGate["input"],
                      })
                    }
                    className={FIELD}
                  >
                    <option value="diff">
                      Diff against the default branch
                    </option>
                    <option value="files">Files matching a glob</option>
                    <option value="prompt">The run prompt</option>
                  </select>
                </Field>
                {gate.input === "files" ? (
                  <Field label="Files">
                    <input
                      aria-label="Files glob"
                      value={gate.filesGlob ?? ""}
                      onChange={(event) =>
                        set({ filesGlob: event.target.value })
                      }
                      placeholder="**/tasks/*.yml"
                      className={FIELD}
                    />
                  </Field>
                ) : null}
                <Field label="When nothing is flagged">
                  <span className="flex gap-3">
                    {(["skip", "run"] as const).map((value) => (
                      <label key={value} className="flex items-center gap-1.5">
                        <input
                          type="radio"
                          name="laya-on-pass"
                          checked={gate.onPass === value}
                          onChange={() => set({ onPass: value })}
                        />
                        {value === "skip" ? "Skip the run" : "Run anyway"}
                      </label>
                    ))}
                  </span>
                </Field>
              </div>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

function withCurrent(list: string[], current?: string): string[] {
  return current && !list.includes(current) ? [current, ...list] : list;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-content/50">{label}</span>
      {children}
    </label>
  );
}
