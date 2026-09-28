import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LoaderCircle,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from "../../../shared/ui/icons";
import {
  checkDraft,
  consultationItem,
  createPlan,
  emptyDraftItem,
  loadDraft,
  loadPlanParents,
  parsePlanJson,
  saveDraft,
  syncItems,
  targetGap,
  type PlanCreateResult,
  type PlanDraftItem,
  type PlanParent,
} from "../model/planDraft";
import {
  DAY_CAPACITY_HOURS,
  WEEK_TARGET_HOURS,
  type LinearCycle,
  type LinearState,
} from "../model/sprint";

type Props = {
  cycle: LinearCycle;
  weekdays: string[];
  teamId: string;
  states: LinearState[];
  plannedByDay: Record<string, number>;
  onClose: () => void;
  onCreated: () => void;
};

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const INPUT =
  "h-7 rounded-md border border-content/10 bg-content/[0.03] px-2 text-[12px] text-content shadow-sm outline-none placeholder:text-content/35 focus-visible:ring-2 focus-visible:ring-accent";
const BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium disabled:opacity-50";
const CARD =
  "rounded-xl border border-content/10 bg-content/[0.03] shadow-sm ring-1 ring-inset ring-content/[0.04]";

function dayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const name = WEEKDAY.format(new Date(year, month - 1, day));
  return `${name} ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
}

function dayTone(hours: number): string {
  if (hours > DAY_CAPACITY_HOURS) return "bg-red-500/15 text-red-400";
  if (hours === DAY_CAPACITY_HOURS) return "bg-emerald-500/15 text-emerald-400";
  if (hours === 0) return "bg-content/8 text-content/45";
  return "bg-amber-500/15 text-amber-400";
}

function todoState(states: LinearState[]): LinearState | null {
  const unstarted = states.filter((state) => state.type === "unstarted");
  return (
    unstarted.find((state) => state.name.toLowerCase() === "todo") ??
    unstarted[0] ??
    null
  );
}

export function PlanWeekPanel({
  cycle,
  weekdays,
  teamId,
  states,
  plannedByDay,
  onClose,
  onCreated,
}: Props) {
  const [items, setItems] = useState<PlanDraftItem[]>(() => loadDraft(cycle.id));
  const [parents, setParents] = useState<Map<string, PlanParent>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PlanCreateResult[] | null>(null);

  // Mounted with key={cycle.id}, so the draft never crosses cycles.
  useEffect(() => saveDraft(cycle.id, items), [cycle.id, items]);

  const parentKeys = useMemo(
    () =>
      [...new Set(items.map((item) => item.parentIdentifier.trim()))].filter(
        (key) => /^[A-Za-z0-9]+-\d+$/.test(key),
      ),
    [items],
  );

  useEffect(() => {
    const missing = parentKeys.filter((key) => !parents.has(key));
    if (missing.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadPlanParents(missing).then((found) => {
        if (cancelled || found.length === 0) return;
        setParents((current) => {
          const next = new Map(current);
          for (const parent of found) next.set(parent.identifier, parent);
          return next;
        });
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parentKeys, parents]);

  const check = useMemo(
    () => checkDraft(items, weekdays, parents, plannedByDay),
    [items, weekdays, parents, plannedByDay],
  );
  const toCreate = items.filter((item) => !check.duplicates.has(item.key));
  const todo = todoState(states);

  const update = (key: string, patch: Partial<PlanDraftItem>) => {
    setConfirming(false);
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  };
  const append = (next: PlanDraftItem[]) => {
    setConfirming(false);
    setItems((current) => [...current, ...next]);
  };

  const applyImport = (replace: boolean) => {
    try {
      const parsed = parsePlanJson(importText);
      setItems((current) => (replace ? parsed : [...current, ...parsed]));
      setImportText("");
      setImportOpen(false);
      setError(null);
    } catch (reason) {
      setError(`Could not read the plan: ${String(reason)}`);
    }
  };

  const create = async () => {
    if (!todo) {
      setError("This team has no Todo state");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createPlan(teamId, cycle.id, todo.id, toCreate);
      setResults(created);
      const done = new Set(
        created
          .filter((result) => result.identifier || result.skipped)
          .map((result) => toCreate[result.index]?.key),
      );
      setItems((current) => current.filter((item) => !done.has(item.key)));
      onCreated();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const gap = targetGap(check.total);

  return (
    <div className="flex min-h-0 w-[min(680px,58%)] shrink-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke px-4 py-2.5">
        <span className="text-[13px] font-semibold">Plan week</span>
        <span className="text-[12px] text-content/50">Cycle #{cycle.number}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
            gap > 0 ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
          }`}
          title="Already planned plus this draft"
        >
          {check.total}/{WEEK_TARGET_HOURS}h
        </span>
        {gap > 0 ? (
          <span className="text-[11px] text-content/45">{gap}h to target</span>
        ) : null}
        <button
          type="button"
          aria-label="Close planning"
          onClick={onClose}
          className="ml-auto grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-stroke px-4 py-2">
        {weekdays.map((day) => (
          <span
            key={day}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${dayTone(check.hoursByDay[day] ?? 0)}`}
          >
            {dayLabel(day)} · {check.hoursByDay[day] ?? 0}/{DAY_CAPACITY_HOURS}
          </span>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 py-2">
        <button
          type="button"
          onClick={() => append([emptyDraftItem(weekdays[0] ?? "")])}
          className={`${BUTTON} bg-content text-background-base hover:bg-content/80`}
        >
          <Plus className="size-3" strokeWidth={2} />
          Item
        </button>
        <button
          type="button"
          onClick={() => append(syncItems(weekdays))}
          className={`${BUTTON} bg-content/8 text-content hover:bg-content/12`}
        >
          + Syncs Mon/Wed/Fri
        </button>
        <button
          type="button"
          onClick={() => append([consultationItem(weekdays)])}
          className={`${BUTTON} bg-content/8 text-content hover:bg-content/12`}
        >
          <MessageSquare className="size-3" strokeWidth={1.75} />
          Consultations 2h
        </button>
        <button
          type="button"
          onClick={() => setImportOpen((open) => !open)}
          className={`${BUTTON} ${importOpen ? "bg-selection" : "bg-content/8"} text-content hover:bg-content/12`}
        >
          Import JSON
        </button>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setItems([]);
              setConfirming(false);
            }}
            className={`${BUTTON} ml-auto text-content/50 hover:bg-content/10 hover:text-content`}
          >
            Clear
          </button>
        ) : null}
      </div>

      {importOpen ? (
        <div className="flex shrink-0 flex-col gap-1.5 px-4 pb-2">
          <textarea
            aria-label="Plan JSON"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder='{"week": "2026-10-05", "items": [{"parent": "ENG-1", "title": "...", "desc": "...", "estimate": 2, "due": "2026-10-05"}]}'
            rows={5}
            spellCheck={false}
            className="rounded-md border border-content/10 bg-content/[0.03] p-2 font-mono text-[11px] text-content shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span className="flex gap-1.5">
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={() => applyImport(false)}
              className={`${BUTTON} bg-content text-background-base hover:bg-content/80`}
            >
              Add to draft
            </button>
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={() => applyImport(true)}
              className={`${BUTTON} bg-content/8 text-content hover:bg-content/12`}
            >
              Replace draft
            </button>
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        {items.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-content/40">
            Add items, presets or paste a plan from the week-plan skill.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => {
              const problems = check.errors.get(item.key) ?? [];
              const duplicate = check.duplicates.has(item.key);
              const parent = parents.get(item.parentIdentifier.trim());
              return (
                <li
                  key={item.key}
                  className={`${CARD} flex flex-col gap-1.5 p-2.5 ${
                    problems.length ? "border-red-400/50" : ""
                  } ${duplicate ? "opacity-60" : ""}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      aria-label="Parent issue"
                      value={item.parentIdentifier}
                      onChange={(event) =>
                        update(item.key, {
                          parentIdentifier: event.target.value.toUpperCase(),
                        })
                      }
                      placeholder="Parent key"
                      className={`${INPUT} w-24 font-mono`}
                    />
                    <select
                      aria-label="Hours"
                      value={item.estimate}
                      onChange={(event) =>
                        update(item.key, { estimate: Number(event.target.value) })
                      }
                      className={`${INPUT} tabular-nums`}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((hours) => (
                        <option key={hours} value={hours}>
                          {hours}h
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Day"
                      value={item.dueDate}
                      onChange={(event) => update(item.key, { dueDate: event.target.value })}
                      className={INPUT}
                    >
                      {weekdays.includes(item.dueDate) ? null : (
                        <option value={item.dueDate}>{item.dueDate || "—"}</option>
                      )}
                      {weekdays.map((day) => (
                        <option key={day} value={day}>
                          {dayLabel(day)}
                        </option>
                      ))}
                    </select>
                    {parent ? (
                      <span className="min-w-0 max-w-56 truncate text-[11px] text-content/50">
                        ⊂ {parent.title}
                      </span>
                    ) : null}
                    {duplicate ? (
                      <span className="rounded-full bg-content/8 px-1.5 py-px text-[10px] text-content/55">
                        exists, will skip
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={() =>
                        setItems((current) => current.filter((row) => row.key !== item.key))
                      }
                      className="ml-auto grid size-6 place-items-center rounded-md text-content/35 hover:bg-content/10 hover:text-red-400"
                    >
                      <Trash2 className="size-3" strokeWidth={1.75} />
                    </button>
                  </div>
                  <input
                    aria-label="Title"
                    value={item.title}
                    onChange={(event) => update(item.key, { title: event.target.value })}
                    placeholder="Title, imperative, one verifiable step"
                    className={`${INPUT} font-medium`}
                  />
                  <textarea
                    aria-label="Description"
                    value={item.description}
                    onChange={(event) => update(item.key, { description: event.target.value })}
                    placeholder="What the result is"
                    rows={2}
                    className="rounded-md border border-content/10 bg-content/[0.03] px-2 py-1 text-[12px] text-content shadow-sm outline-none placeholder:text-content/35 focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  {problems.length ? (
                    <p className="text-[11px] text-red-400">{problems.join(" · ")}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {results ? (
          <ul className="mt-3 flex flex-col gap-0.5 text-[11px]">
            {results.map((result) => (
              <li key={result.index} className="flex items-center gap-2">
                {result.identifier ? (
                  <button
                    type="button"
                    onClick={() => void openUrl(result.url)}
                    className="font-mono font-semibold text-accent hover:underline"
                  >
                    {result.identifier}
                  </button>
                ) : (
                  <span className={result.skipped ? "text-content/50" : "text-red-400"}>
                    {result.skipped ? "skipped" : "failed"}
                  </span>
                )}
                <span className="truncate text-content/60">
                  {result.error ?? (result.skipped ? "already exists under the parent" : "created")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-stroke px-4 py-2.5">
        {error ? (
          <span role="alert" className="min-w-0 flex-1 text-[12px] text-red-400">
            {error}
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-[11px] text-content/45">
            Creates Todo issues in cycle #{cycle.number}, assigned to you. Hours
            are kept in MonoCode.
          </span>
        )}
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={`${BUTTON} text-content/55 hover:bg-content/10 hover:text-content`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void create()}
              className={`${BUTTON} bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30`}
            >
              {busy ? <LoaderCircle className="size-3 animate-spin" strokeWidth={2} /> : null}
              Confirm {toCreate.length} in Linear
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!check.valid || toCreate.length === 0 || busy}
            onClick={() => setConfirming(true)}
            className={`${BUTTON} bg-content text-background-base hover:bg-content/80`}
          >
            Create {toCreate.length} in Linear
          </button>
        )}
      </div>
    </div>
  );
}
