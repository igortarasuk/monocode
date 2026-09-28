import { useEffect, useState } from "react";
import { Clock, MessageSquare, Plus, Trash2 } from "../../../shared/ui/icons";
import {
  deleteTimeEntry,
  logTime,
  plannedFor,
  sessionSpanHours,
  setPlannedHours,
  type IssueHours,
  type PlanSource,
} from "../model/hours";
import { localDateKey, type LinearSprintIssue } from "../model/sprint";

type Props = {
  issue: LinearSprintIssue;
  hours: IssueHours | undefined;
  onChanged: () => void;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
};

const SOURCE_LABEL: Record<PlanSource, string> = {
  local: "local plan",
  marker: "from plan marker",
  linear: "Linear estimate",
  none: "not planned",
};

const QUICK = [0.5, 1, 2];

function hoursLabel(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function parseHours(raw: string): number | null {
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const INPUT =
  "h-7 rounded-md border border-content/10 bg-content/[0.03] px-2 text-[12px] text-content shadow-sm outline-none placeholder:text-content/35 focus-visible:ring-2 focus-visible:ring-accent";
const BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium disabled:opacity-50";

export function TimePanel({ issue, hours, onChanged, onOpenSession }: Props) {
  const plan = plannedFor(issue, hours);
  const spent = hours?.spent ?? 0;
  const delta = plan.hours == null ? null : spent - plan.hours;
  const [planInput, setPlanInput] = useState("");
  const [day, setDay] = useState(() => localDateKey(new Date()));
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = hours?.sessions ?? [];
  const span = sessionSpanHours(sessions);

  useEffect(() => {
    setPlanInput(plan.hours == null ? "" : String(plan.hours));
    setCustom("");
    setNote("");
    setError(null);
  }, [issue.id, plan.hours]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const log = (value: number | null) => {
    if (value == null) {
      setError("Enter hours above 0");
      return;
    }
    void run(async () => {
      await logTime(issue, day, value, note);
      setCustom("");
      setNote("");
    });
  };

  const savePlan = () => {
    const value = planInput.trim() === "" ? null : Number(planInput.replace(",", "."));
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      setError("Plan must be a number of hours");
      return;
    }
    void run(() => setPlannedHours(issue, value));
  };

  return (
    <section className="flex shrink-0 flex-col gap-3 border-b border-stroke px-4 py-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-content/8 text-content/70">
          <Clock className="size-3.5" strokeWidth={1.75} />
        </span>
        <span className="text-[13px] font-semibold">Time</span>
        <span className="tabular-nums text-content/60">
          <span className="font-semibold text-emerald-400">{hoursLabel(spent)}</span>
          {" spent of "}
          <span className="font-semibold text-accent">
            {plan.hours == null ? "—" : hoursLabel(plan.hours)}
          </span>
        </span>
        {delta != null && spent > 0 && Math.abs(delta) >= 0.05 ? (
          <span
            className={`rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ${
              delta > 0
                ? "bg-red-500/15 text-red-400"
                : "bg-emerald-500/15 text-emerald-400"
            }`}
          >
            {delta > 0 ? `+${hoursLabel(delta)} over` : `${hoursLabel(-delta)} left`}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-10 text-content/50">Plan</span>
        <input
          aria-label="Planned hours"
          inputMode="decimal"
          value={planInput}
          onChange={(event) => setPlanInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") savePlan();
          }}
          placeholder="hours"
          className={`${INPUT} w-16 tabular-nums`}
        />
        <button
          type="button"
          disabled={busy}
          onClick={savePlan}
          className={`${BUTTON} bg-content/8 text-content hover:bg-content/12`}
        >
          Save
        </button>
        <span className="text-[11px] text-content/40">{SOURCE_LABEL[plan.source]}</span>
        {plan.source === "local" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => setPlannedHours(issue, null))}
            className="text-[11px] text-content/45 underline-offset-2 hover:text-content hover:underline"
          >
            reset
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-10 text-content/50">Log</span>
        <input
          type="date"
          aria-label="Day"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className={`${INPUT} w-[8.5rem]`}
        />
        {QUICK.map((value) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            onClick={() => log(value)}
            className={`${BUTTON} bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25`}
          >
            <Plus className="size-3" strokeWidth={2} />
            {hoursLabel(value)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[2.875rem]">
        <input
          aria-label="Hours"
          inputMode="decimal"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="1.5"
          className={`${INPUT} w-14 tabular-nums`}
        />
        <input
          aria-label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") log(parseHours(custom));
          }}
          placeholder="What was done (optional)"
          className={`${INPUT} min-w-0 flex-1`}
        />
        <button
          type="button"
          disabled={busy || custom.trim() === ""}
          onClick={() => log(parseHours(custom))}
          className={`${BUTTON} bg-content text-background-base hover:bg-content/80`}
        >
          Log
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      ) : null}

      {sessions.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-content/[0.03] p-2 ring-1 ring-inset ring-content/[0.06]">
          <span className="flex items-center gap-1.5 text-[11px] text-content/55">
            <MessageSquare className="size-3" strokeWidth={1.75} />
            {sessions.length} session{sessions.length === 1 ? "" : "s"} from this
            issue, ≈{hoursLabel(span)} wall-clock
            <button
              type="button"
              onClick={() => setCustom(String(span))}
              className="ml-auto text-accent hover:underline"
            >
              use as hint
            </button>
          </span>
          {sessions.slice(0, 3).map((session) => (
            <button
              key={session.sessionId}
              type="button"
              onClick={() => void onOpenSession?.(session.sessionId)}
              className="truncate text-left text-[11px] text-content/60 hover:text-content"
            >
              {new Date(session.startedAt).toLocaleDateString()} · {session.title}
            </button>
          ))}
        </div>
      ) : null}

      {hours && hours.entries.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {hours.entries.map((entry) => (
            <li
              key={entry.id}
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-content/5"
            >
              <span className="w-20 shrink-0 tabular-nums text-content/50">
                {entry.day}
              </span>
              <span className="w-10 shrink-0 font-semibold tabular-nums text-emerald-400">
                {hoursLabel(entry.hours)}
              </span>
              <span className="min-w-0 flex-1 truncate text-content/70">
                {entry.note}
              </span>
              <button
                type="button"
                aria-label="Delete entry"
                disabled={busy}
                onClick={() => void run(() => deleteTimeEntry(entry.id))}
                className="grid size-5 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-red-400 group-hover:opacity-100"
              >
                <Trash2 className="size-3" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
