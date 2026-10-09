import { useCallback, useEffect, useMemo, useState } from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { CalendarDays, CircleAlert, LoaderCircle } from "../../../shared/ui/icons";
import { useTabGroupLogos } from "../../projects/hooks/useTabGroupLogos";
import type { RecentProject } from "../../projects/model/recents";
import {
  linearIssueToInboxItem,
  type InboxItem,
} from "../../inbox/model/githubTasks";
import {
  LINEAR_CHANGE_EVENT,
  linearConnected,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  type LinearTeam,
} from "../../inbox/model/linear";
import { InboxDetail, inboxProjectOptions } from "../../inbox/ui/InboxView";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { relatedSessionsForInboxItem } from "../../sessions/model/sessionWorkItem";
import {
  loadIssueHours,
  loadSpentByDay,
  summarizeHours,
  type IssueHours,
} from "../model/hours";
import { sprintHygiene, type HygieneProblem } from "../model/hygiene";
import {
  addDays,
  buildSprintPlan,
  closeIssue,
  doneState,
  isDone,
  loadTeamLabels,
  loadTeamStates,
  localDateKey,
  setIssueDueDate,
  setIssueLabels,
  setIssueState,
  startedState,
  type LinearLabelOption,
  type LinearSprint,
  type LinearSprintIssue,
  type LinearState,
} from "../model/sprint";
import { LabelPicker } from "./LabelPicker";
import { IssueKey, SprintCalendar, StatePill } from "./SprintCalendar";
import { PlanWeekPanel } from "./PlanWeekPanel";
import { TimePanel } from "./TimePanel";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  cwd: string;
  recents: RecentProject[];
  sessions?: readonly SessionSummary[];
  onClose: () => void;
  onToggleSidebar?: () => void;
  onStart?: (item: InboxItem, body?: string) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
};

const CLOSE_PLACEHOLDER =
  "What was done, decisions made, what remains (if anything).";

function StatusControls({
  issue,
  states,
  labels,
  problems,
  onChanged,
}: {
  issue: LinearSprintIssue;
  states: LinearState[];
  labels: LinearLabelOption[];
  problems: readonly HygieneProblem[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [comment, setComment] = useState("");
  const current = states.find((state) => state.name === issue.state);
  const started = startedState(states);
  const done = doneState(states);
  const today = localDateKey(new Date());

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const apply = async (stateId: string) => {
    if (!stateId || stateId === current?.id) return;
    // Closing needs a comment, so a completed state opens the form instead.
    if (states.find((state) => state.id === stateId)?.type === "completed") {
      setClosing(true);
      return;
    }
    await run(() => setIssueState(issue.id, stateId));
  };

  // Like `linear.sh start`: taking work without a deadline sets today+3d.
  const takeInWork = async () => {
    if (!started) return;
    await run(async () => {
      await setIssueState(issue.id, started.id);
      if (!issue.dueDate) await setIssueDueDate(issue.id, addDays(today, 3));
    });
  };

  const confirmClose = async () => {
    if (!comment.trim()) {
      setError("A closure comment is required");
      return;
    }
    if (await run(() => closeIssue(issue, comment.trim(), states))) {
      setClosing(false);
      setComment("");
    }
  };

  const changeDue = async (value: string) => {
    if ((value || null) === issue.dueDate) return;
    await run(() => setIssueDueDate(issue.id, value));
  };

  const changeLabels = async (labelIds: string[]) => {
    if (labelIds.length === 0) {
      setError("Keep at least one label");
      return;
    }
    await run(() => setIssueLabels(issue.id, labelIds));
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-stroke px-4 py-2.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <IssueKey identifier={issue.identifier} size="lg" />
        <StatePill state={issue.state} stateType={issue.stateType} />
        {issue.estimate != null ? (
          <span className="rounded-full bg-accent/15 px-1.5 py-px text-[11px] font-semibold tabular-nums text-accent">
            {issue.estimate}h
          </span>
        ) : null}
        <span className="flex-1" />
        <input
          type="date"
          aria-label="Due date"
          title="Due date"
          value={issue.dueDate ?? ""}
          disabled={busy}
          onChange={(event) => void changeDue(event.target.value)}
          className={`h-7 rounded-md border bg-content/[0.03] px-2 text-content shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            issue.dueDate ? "border-content/10" : "border-amber-400/60"
          }`}
        />
        <select
          aria-label="Status"
          value={current?.id ?? ""}
          disabled={busy || states.length === 0}
          onChange={(event) => void apply(event.target.value)}
          className="h-7 rounded-md border border-content/10 bg-content/[0.03] px-2 text-content shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {current ? null : <option value="">{issue.state}</option>}
          {states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </select>
        {started && issue.stateType !== "started" && issue.childCount === 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void takeInWork()}
            className="h-7 rounded-md bg-content px-3 font-medium text-background-base hover:bg-content/80 disabled:opacity-60"
          >
            Take in work
          </button>
        ) : null}
        {done && !isDone(issue) && !closing ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setClosing(true)}
            className="h-7 rounded-md bg-emerald-500/20 px-3 font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60"
          >
            Close
          </button>
        ) : null}
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin text-content/45" strokeWidth={1.75} />
        ) : null}
      </div>
      {labels.length ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-content/50">
          <span>Labels</span>
          <LabelPicker
            options={labels}
            value={issue.labelIds}
            onChange={(labelIds) => void changeLabels(labelIds)}
            ariaLabel="Issue labels"
          />
        </div>
      ) : null}
      {closing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            aria-label="Closure comment"
            value={comment}
            autoFocus
            onChange={(event) => setComment(event.target.value)}
            placeholder={CLOSE_PLACEHOLDER}
            rows={3}
            className="rounded-md border border-content/10 bg-content/[0.03] px-2 py-1 text-[12px] text-content shadow-sm outline-none placeholder:text-content/35 focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-content/45">
              {issue.stateType === "started"
                ? "Posts the comment, then marks Done."
                : "Moves to In Progress, posts the comment, then marks Done."}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setClosing(false);
                setError(null);
              }}
              className="h-7 rounded-md px-2 text-content/55 hover:bg-content/10 hover:text-content"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !comment.trim()}
              onClick={() => void confirmClose()}
              className="h-7 rounded-md bg-emerald-500/20 px-3 font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
            >
              Close {issue.identifier}
            </button>
          </span>
        </div>
      ) : null}
      {error ? (
        <span role="alert" className="text-red-400">
          {error}
        </span>
      ) : null}
      {problems.length ? (
        <ul className="flex flex-col gap-0.5 text-[11px]">
          {problems.map((problem) => (
            <li key={problem.code} className="flex items-start gap-1.5">
              <CircleAlert
                className={`mt-0.5 size-3 shrink-0 ${
                  problem.code === "overdue" ? "text-red-400" : "text-amber-400"
                }`}
                strokeWidth={2}
              />
              <span className="text-content/70">
                <span className="font-medium text-content">{problem.label}</span>
                {" — "}
                {problem.hint}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CalendarView({
  besideRail = false,
  compactRail = false,
  cwd,
  recents,
  sessions = [],
  onClose,
  onToggleSidebar,
  onStart,
  onOpenSession,
}: Props) {
  const logos = useTabGroupLogos();
  const projects = useMemo(
    () => inboxProjectOptions(recents, logos),
    [recents, logos],
  );
  const [connected, setConnected] = useState<boolean | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [states, setStates] = useState<LinearState[]>([]);
  const [labels, setLabels] = useState<LinearLabelOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sprint, setSprint] = useState<LinearSprint | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [revision, setRevision] = useState(0);
  const [hoursById, setHoursById] = useState<Map<string, IssueHours>>(
    () => new Map(),
  );
  const [spentByDay, setSpentByDay] = useState<Record<string, number>>({});
  const [hoursToken, setHoursToken] = useState(0);
  const [planning, setPlanning] = useState(false);
  const plan = useMemo(() => (sprint ? buildSprintPlan(sprint) : null), [sprint]);
  const hygiene = useMemo(
    () => (sprint ? sprintHygiene(sprint, localDateKey(new Date())) : null),
    [sprint],
  );

  useEffect(() => {
    if (!sprint || !plan) return;
    let cancelled = false;
    const days = plan.days.map((day) => day.date);
    void Promise.all([
      loadIssueHours(sprint.issues),
      days.length
        ? loadSpentByDay(days[0], days[days.length - 1])
        : Promise.resolve({}),
    ])
      .then(([rows, byDay]) => {
        if (cancelled) return;
        setHoursById(new Map(rows.map((row) => [row.issueId, row])));
        setSpentByDay(byDay);
      })
      .catch(() => {
        if (!cancelled) setHoursById(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [sprint, plan, hoursToken]);

  const summary = useMemo(
    () => (plan ? summarizeHours(plan, hoursById, spentByDay) : null),
    [plan, hoursById, spentByDay],
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void linearConnected()
        .then((status) => {
          if (!cancelled) setConnected(status.connected);
        })
        .catch(() => {
          if (!cancelled) setConnected(false);
        });
    };
    refresh();
    window.addEventListener(LINEAR_CHANGE_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(LINEAR_CHANGE_EVENT, refresh);
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void listLinearTeams()
      .then((next) => {
        if (!cancelled) setTeams(next);
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const hidden = useMemo(loadHiddenLinearTeamIds, [teams]);
  const teamId = teams.find((team) => !hidden.includes(team.id))?.id ?? null;

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void loadTeamStates(teamId)
      .then((next) => {
        if (!cancelled) setStates(next);
      })
      .catch(() => {
        if (!cancelled) setStates([]);
      });
    void loadTeamLabels(teamId)
      .then((next) => {
        if (!cancelled) setLabels(next);
      })
      .catch(() => {
        if (!cancelled) setLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const selected =
    sprint?.issues.find((issue) => issue.id === selectedId) ?? null;
  const item = useMemo(
    () => (selected ? linearIssueToInboxItem(selected.issue) : null),
    [selected],
  );
  const onChanged = useCallback(() => {
    setReloadToken((token) => token + 1);
    setRevision((value) => value + 1);
  }, []);

  return (
    <div
      role="region"
      aria-label="Calendar"
      data-app-calendar
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <CalendarDays
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Calendar</span>
        </div>
        {connected && sprint?.cycle ? (
          <button
            type="button"
            aria-pressed={planning}
            onClick={() => setPlanning((open) => !open)}
            className={`mr-2 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium ${
              planning
                ? "bg-selection text-content"
                : "bg-content/8 text-content hover:bg-content/12"
            }`}
          >
            <CalendarDays className="size-3.5" strokeWidth={1.75} />
            Plan week
          </button>
        ) : null}
        {IS_MAC ? null : <WindowControls />}
      </div>

      {connected === false ? (
        <p className="px-4 py-3 text-[12px] text-content/50">
          Connect Linear in the Inbox to see your sprint.
        </p>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 border-r border-stroke">
            <SprintCalendar
              teamId={teamId}
              selectedId={selectedId}
              reloadToken={reloadToken}
              onOpenIssue={(issue) => setSelectedId(issue.id)}
              onLoaded={setSprint}
              hoursById={hoursById}
              summary={summary}
            />
          </div>
          {planning && sprint?.cycle && plan && teamId ? (
            <PlanWeekPanel
              key={sprint.cycle.id}
              cycle={sprint.cycle}
              weekdays={plan.days.map((day) => day.date)}
              teamId={teamId}
              states={states}
              plannedByDay={summary?.plannedByDay ?? {}}
              onClose={() => setPlanning(false)}
              onCreated={() => {
                setReloadToken((token) => token + 1);
                setHoursToken((token) => token + 1);
              }}
            />
          ) : selected && item ? (
            <div className="flex min-h-0 w-[min(520px,45%)] shrink-0 flex-col">
              <StatusControls
                key={selected.id}
                issue={selected}
                states={states}
                labels={labels}
                problems={hygiene?.byIssue.get(selected.id) ?? []}
                onChanged={onChanged}
              />
              <TimePanel
                issue={selected}
                hours={hoursById.get(selected.id)}
                onChanged={() => setHoursToken((token) => token + 1)}
                onOpenSession={onOpenSession}
              />
              <div className="min-h-0 flex-1">
                <InboxDetail
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  projects={projects}
                  revision={revision}
                  mode="panel"
                  relatedSessions={relatedSessionsForInboxItem(item, sessions)}
                  onStart={onStart}
                  onOpenSession={onOpenSession}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
