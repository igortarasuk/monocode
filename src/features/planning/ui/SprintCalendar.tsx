import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  RefreshCw,
} from "../../../shared/ui/icons";
import {
  DAY_CAPACITY_HOURS,
  WEEK_TARGET_HOURS,
  buildSprintPlan,
  isDone,
  isOverdue,
  loadLinearSprint,
  localDateKey,
  type LinearSprint,
  type LinearSprintIssue,
} from "../model/sprint";
import {
  plannedFor,
  type HoursSummary,
  type IssueHours,
} from "../model/hours";

type Props = {
  teamId: string | null;
  selectedId?: string | null;
  reloadToken?: number;
  onOpenIssue: (issue: LinearSprintIssue) => void;
  onLoaded?: (sprint: LinearSprint) => void;
  hoursById?: ReadonlyMap<string, IssueHours>;
  summary?: HoursSummary | null;
};

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const CARD =
  "rounded-xl border border-content/10 bg-content/[0.03] shadow-sm ring-1 ring-inset ring-content/[0.04]";

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}.${month}`;
}

function weekdayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAY.format(new Date(year, month - 1, day));
}

function hoursLabel(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function labelColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

/** Issue key with a copy button, for pasting into sessions and commits. */
export function IssueKey({
  identifier,
  size = "md",
}: {
  identifier: string;
  size?: "md" | "lg";
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span
        className={`font-mono font-semibold tracking-tight text-accent ${
          size === "lg" ? "text-[14px]" : "text-[13px]"
        }`}
      >
        {identifier}
      </span>
      <button
        type="button"
        title={copied ? "Copied" : `Copy ${identifier}`}
        aria-label={`Copy ${identifier}`}
        onClick={(event) => {
          event.stopPropagation();
          void copyText(identifier).then(() => setCopied(true));
        }}
        className="grid size-5 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content"
      >
        {copied ? (
          <Check className="size-3 text-emerald-400" strokeWidth={2} />
        ) : (
          <Copy className="size-3" strokeWidth={1.75} />
        )}
      </button>
    </span>
  );
}

export function StatePill({
  state,
  stateType,
}: {
  state: string;
  stateType: string;
}) {
  const tone =
    stateType === "completed"
      ? "bg-emerald-500/15 text-emerald-400"
      : stateType === "started"
        ? state.toLowerCase() === "blocked"
          ? "bg-amber-500/15 text-amber-400"
          : "bg-accent/15 text-accent"
        : "bg-content/8 text-content/55";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium ${tone}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}

function HoursPill({
  issue,
  overdue,
  hours,
}: {
  issue: LinearSprintIssue;
  overdue: boolean;
  hours?: IssueHours;
}) {
  const planned = plannedFor(issue, hours).hours;
  const spent = hours?.spent ?? 0;
  const tone = isDone(issue)
    ? "bg-emerald-500/15 text-emerald-400"
    : overdue
      ? "bg-red-500/15 text-red-400"
      : planned == null
        ? "bg-content/8 text-content/45"
        : "bg-accent/15 text-accent";
  const over = planned != null && spent > planned;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {spent > 0 ? (
        <span
          title="Spent (local)"
          className={`text-[11px] font-semibold tabular-nums ${
            over ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {hoursLabel(spent)}
        </span>
      ) : null}
      <span
        title="Planned"
        className={`rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ${tone}`}
      >
        {planned == null ? "—" : hoursLabel(planned)}
      </span>
    </span>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.05) return null;
  const over = delta > 0;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
        over ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400"
      }`}
    >
      {over ? `+${hoursLabel(delta)} over` : `${hoursLabel(-delta)} saved`}
    </span>
  );
}

function dayTone(hours: number): string {
  if (hours > DAY_CAPACITY_HOURS) return "bg-red-500/15 text-red-400";
  if (hours === DAY_CAPACITY_HOURS) return "bg-emerald-500/15 text-emerald-400";
  if (hours === 0) return "bg-content/8 text-content/45";
  return "bg-amber-500/15 text-amber-400";
}

function IssueLabels({ issue }: { issue: LinearSprintIssue }) {
  const labels = issue.issue.labels ?? [];
  if (labels.length === 0 && !issue.projectName) return null;
  const shown = labels.slice(0, 3);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {issue.projectName ? (
        <span className="max-w-24 truncate rounded px-1.5 py-px text-[10px] text-content/55 ring-1 ring-inset ring-content/12">
          {issue.projectName}
        </span>
      ) : null}
      {shown.map((label) => {
        const color = labelColor(label.color);
        return (
          <span
            key={label.name}
            className="inline-flex max-w-24 items-center gap-1 rounded bg-content/8 px-1.5 py-px text-[10px] text-content/60"
          >
            {color ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            ) : null}
            <span className="truncate">{label.name}</span>
          </span>
        );
      })}
      {labels.length > shown.length ? (
        <span className="text-[10px] text-content/40">
          +{labels.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

function activate(event: KeyboardEvent<HTMLElement>, run: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    run();
  }
}

function SprintIssueCard({
  issue,
  today,
  selected,
  hours,
  onOpen,
}: {
  issue: LinearSprintIssue;
  today: string;
  selected: boolean;
  hours?: IssueHours;
  onOpen: (issue: LinearSprintIssue) => void;
}) {
  const done = isDone(issue);
  const overdue = isOverdue(issue, today);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onOpen(issue)}
      onKeyDown={(event) => activate(event, () => onOpen(issue))}
      title={issue.parentIdentifier ? `Part of ${issue.parentIdentifier}` : undefined}
      className={`${CARD} flex w-full cursor-pointer flex-col gap-1.5 p-2.5 text-left outline-none transition-colors hover:border-content/16 hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-accent ${
        overdue ? "border-red-400/50" : ""
      } ${selected ? "border-accent/50 bg-accent/[0.07]" : ""} ${
        done ? "opacity-60" : ""
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <IssueKey identifier={issue.identifier} />
        <span className="ml-auto">
          <HoursPill issue={issue} overdue={overdue} hours={hours} />
        </span>
      </span>
      <span
        className={`line-clamp-2 text-[12px] font-medium leading-snug ${
          done ? "text-content/60 line-through" : "text-content"
        }`}
      >
        {issue.title}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <StatePill state={issue.state} stateType={issue.stateType} />
        {issue.parentIdentifier ? (
          <span className="font-mono text-[10px] text-content/40">
            ⊂ {issue.parentIdentifier}
          </span>
        ) : null}
      </span>
      <IssueLabels issue={issue} />
    </div>
  );
}

export function SprintCalendar({
  teamId,
  selectedId = null,
  reloadToken = 0,
  onOpenIssue,
  onLoaded,
  hoursById,
  summary = null,
}: Props) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [sprint, setSprint] = useState<LinearSprint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadLinearSprint(teamId, offset)
      .then((next) => {
        if (cancelled) return;
        setSprint(next);
        onLoaded?.(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Not keyed on onLoaded: a new callback identity must not refetch.
  }, [teamId, offset, revision, reloadToken]);

  const plan = useMemo(
    () => (sprint ? buildSprintPlan(sprint) : null),
    [sprint],
  );
  const today = localDateKey(new Date());
  const cycle = sprint?.cycle ?? null;
  const totalTone = !plan
    ? ""
    : plan.totalHours < WEEK_TARGET_HOURS
      ? "bg-amber-500/15 text-amber-400"
      : "bg-emerald-500/15 text-emerald-400";

  return (
    <div
      role="region"
      aria-label="Sprint calendar"
      className="flex h-full min-h-0 flex-col text-content"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-stroke px-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-content/8 text-content/70">
          <CalendarDays className="size-3.5" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold">
          {cycle ? `Cycle #${cycle.number}` : "Sprint"}
        </span>
        {cycle && plan?.days.length ? (
          <span className="text-[12px] text-content/50">
            {shortDate(plan.days[0].date)}–
            {shortDate(plan.days[plan.days.length - 1].date)}
          </span>
        ) : null}
        {plan ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${totalTone}`}
            title={`Linear estimates; ${hoursLabel(plan.doneHours)} done`}
          >
            {hoursLabel(plan.totalHours)} / {WEEK_TARGET_HOURS}h
          </span>
        ) : null}
        {summary ? (
          <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-content/55">
            <span title="Local plan">plan {hoursLabel(summary.planned)}</span>
            <span aria-hidden>·</span>
            <span title="Logged in MonoCode" className="text-emerald-400">
              spent {hoursLabel(summary.spent)}
            </span>
          </span>
        ) : null}
        {summary && summary.spent > 0 ? <DeltaPill delta={summary.delta} /> : null}
        <span className="ml-auto flex items-center gap-px">
          <button
            type="button"
            aria-label="Previous cycle"
            onClick={() => setOffset((value) => value - 1)}
            className="grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setOffset(0)}
            disabled={offset === 0}
            className="h-7 rounded-md px-2 text-[12px] text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Current
          </button>
          <button
            type="button"
            aria-label="Next cycle"
            onClick={() => setOffset((value) => value + 1)}
            className="grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Refresh sprint"
            onClick={() => setRevision((value) => value + 1)}
            className="grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            {loading ? (
              <LoaderCircle
                className="size-3.5 animate-spin"
                strokeWidth={1.75}
              />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            )}
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!teamId ? (
          <p className="text-[12px] text-content/50">
            No Linear team is visible.
          </p>
        ) : error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : !plan ? null : !cycle ? (
          <p className="text-[12px] text-content/50">
            This team has no cycle here.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {plan.parents.length > 0 ? (
              <section className="flex flex-col gap-2">
                <header className="text-[11px] font-medium uppercase tracking-wide text-content/40">
                  Epics in this cycle
                </header>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                  {plan.parents.map((parent) => (
                    <div
                      key={parent.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={parent.id === selectedId}
                      onClick={() => onOpenIssue(parent)}
                      onKeyDown={(event) =>
                        activate(event, () => onOpenIssue(parent))
                      }
                      className={`${CARD} flex cursor-pointer flex-col gap-1 px-3 py-2 outline-none hover:border-content/16 hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-accent ${
                        parent.id === selectedId
                          ? "border-accent/50 bg-accent/[0.07]"
                          : ""
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IssueKey identifier={parent.identifier} />
                        <span className="ml-auto flex items-center gap-1.5">
                          <StatePill
                            state={parent.state}
                            stateType={parent.stateType}
                          />
                          <span className="rounded-full bg-content/8 px-1.5 py-px text-[10px] text-content/55">
                            {parent.childCount} sub
                          </span>
                        </span>
                      </span>
                      <span className="truncate text-[12px] font-medium text-content">
                        {parent.title}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <div className="grid min-w-[720px] grid-cols-5 gap-3">
              {plan.days.map((day) => {
                const isToday = day.date === today;
                return (
                  <section
                    key={day.date}
                    className={`flex min-w-0 flex-col gap-2 rounded-2xl p-2 ${
                      isToday
                        ? "bg-accent/[0.05] ring-1 ring-inset ring-accent/25"
                        : "bg-content/[0.02]"
                    }`}
                  >
                    <header className="flex items-center gap-1.5 px-1 pt-0.5">
                      <span
                        className={`text-[13px] font-semibold capitalize ${
                          isToday ? "text-accent" : "text-content"
                        }`}
                      >
                        {weekdayLabel(day.date)}
                      </span>
                      <span className="text-[12px] text-content/45">
                        {shortDate(day.date)}
                      </span>
                      <span
                        title="Planned for this day"
                        className={`ml-auto rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ${dayTone(summary?.plannedByDay[day.date] ?? day.hours)}`}
                      >
                        {hoursLabel(summary?.plannedByDay[day.date] ?? day.hours)}/
                        {DAY_CAPACITY_HOURS}
                      </span>
                    </header>
                    {summary?.spentByDay[day.date] ? (
                      <span className="-mt-1 px-1 text-[11px] tabular-nums text-emerald-400">
                        spent {hoursLabel(summary.spentByDay[day.date])}
                      </span>
                    ) : null}
                    {day.issues.map((issue) => (
                      <SprintIssueCard
                        key={issue.id}
                        issue={issue}
                        today={today}
                        selected={issue.id === selectedId}
                        hours={hoursById?.get(issue.id)}
                        onOpen={onOpenIssue}
                      />
                    ))}
                    {day.issues.length === 0 ? (
                      <p className="px-1 py-3 text-center text-[11px] text-content/35">
                        Nothing planned
                      </p>
                    ) : null}
                  </section>
                );
              })}
            </div>

            {plan.unscheduled.length > 0 ? (
              <section className="flex flex-col gap-2">
                <header className="text-[11px] font-medium uppercase tracking-wide text-content/40">
                  Outside the week or without a due date
                </header>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                  {plan.unscheduled.map((issue) => (
                    <SprintIssueCard
                      key={issue.id}
                      issue={issue}
                      today={today}
                      selected={issue.id === selectedId}
                      hours={hoursById?.get(issue.id)}
                      onOpen={onOpenIssue}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
