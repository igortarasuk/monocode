import { invoke } from "@tauri-apps/api/core";
import type { ProjectMeta } from "./autoModel";

/**
 * Per-session Auto switch and what the router is doing right now.
 *
 * The switch is a small local preference: sessions the user turned on or off
 * are listed, everything else follows the last choice. Project and session
 * metadata live in the session database (see `auto_model.rs`).
 */

const KEY = "monocode.autoModel.v1";
const MAX_LISTED = 400;

type Stored = {
  /** Whether sessions without a choice of their own use Auto. */
  enabled: boolean;
  auto: string[];
  manual: string[];
};

export type AutoModelActivity = "routing" | "reviewing" | "moving";

export type AutoModelPick = {
  model: string;
  kind: string;
  scale: string;
  effort?: string;
  reason: string;
};

export type SessionTask = {
  sessionId: string;
  cwd: string;
  harness: string;
  model: string;
  kind: string;
  scale: string;
  effort: string;
  summary: string;
  reason: string;
  parentSessionId?: string | null;
};

let revision = 0;
const listeners = new Set<() => void>();
const activity = new Map<string, AutoModelActivity>();
const picks = new Map<string, AutoModelPick>();

function changed() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeAutoModel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function autoModelRevision(): number {
  return revision;
}

function read(): Stored {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const item =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const ids = (field: unknown) =>
      Array.isArray(field)
        ? field.filter((id): id is string => typeof id === "string")
        : [];
    return {
      enabled: item.enabled === true,
      auto: ids(item.auto),
      manual: ids(item.manual),
    };
  } catch {
    return { enabled: false, auto: [], manual: [] };
  }
}

function write(next: Stored) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        enabled: next.enabled,
        auto: next.auto.slice(-MAX_LISTED),
        manual: next.manual.slice(-MAX_LISTED),
      }),
    );
  } catch {
    // private mode / quota
  }
  changed();
}

export function isAutoModel(sessionId: string): boolean {
  const stored = read();
  if (stored.manual.includes(sessionId)) return false;
  return stored.auto.includes(sessionId) || stored.enabled;
}

/** The Auto button: applies to this session and to sessions opened after it. */
export function setAutoModel(sessionId: string, auto: boolean) {
  const stored = read();
  const without = (ids: string[]) => ids.filter((id) => id !== sessionId);
  write({
    enabled: auto,
    auto: auto ? [...without(stored.auto), sessionId] : without(stored.auto),
    manual: auto
      ? without(stored.manual)
      : [...without(stored.manual), sessionId],
  });
}

/** The user picked a model themselves: this session keeps it. */
export function pinSessionModel(sessionId: string) {
  const stored = read();
  if (!isAutoModel(sessionId)) return;
  write({
    ...stored,
    auto: stored.auto.filter((id) => id !== sessionId),
    manual: [...stored.manual.filter((id) => id !== sessionId), sessionId],
  });
}

/** A session Auto opened itself stays on Auto whatever the default is. */
export function markAutoSession(sessionId: string) {
  const stored = read();
  write({
    ...stored,
    auto: [...stored.auto.filter((id) => id !== sessionId), sessionId],
    manual: stored.manual.filter((id) => id !== sessionId),
  });
}

export function autoModelActivity(
  sessionId: string,
): AutoModelActivity | undefined {
  return activity.get(sessionId);
}

export function setAutoModelActivity(
  sessionId: string,
  next: AutoModelActivity | null,
) {
  if (next) activity.set(sessionId, next);
  else activity.delete(sessionId);
  changed();
}

export function autoModelPick(sessionId: string): AutoModelPick | undefined {
  return picks.get(sessionId);
}

export function setAutoModelPick(sessionId: string, pick: AutoModelPick) {
  picks.set(sessionId, pick);
  changed();
}

export function loadProjectMeta(cwd: string): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("auto_model_project", { cwd });
}

export function rememberProjectFacts(
  cwd: string,
  entries: string[],
): Promise<string[]> {
  return invoke<string[]>("auto_model_remember", { cwd, entries });
}

export function saveSessionTask(task: SessionTask): Promise<void> {
  return invoke("auto_model_session_set", { task });
}

export function loadSessionTask(sessionId: string): Promise<SessionTask | null> {
  return invoke<SessionTask | null>("auto_model_session_get", { sessionId });
}
