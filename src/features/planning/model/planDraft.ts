import { invoke } from "@tauri-apps/api/core";
import { DAY_CAPACITY_HOURS, WEEK_TARGET_HOURS } from "./sprint";

export type PlanDraftItem = {
  key: string;
  parentIdentifier: string;
  title: string;
  description: string;
  estimate: number;
  dueDate: string;
};

export type PlanParent = {
  id: string;
  identifier: string;
  title: string;
  teamId: string;
  projectId: string | null;
  labelIds: string[];
  childTitles: string[];
};

export type PlanCreateResult = {
  index: number;
  identifier: string;
  url: string;
  skipped: boolean;
  error: string | null;
};

export type DraftCheck = {
  errors: Map<string, string[]>;
  duplicates: Set<string>;
  hoursByDay: Record<string, number>;
  total: number;
  valid: boolean;
};

let keySeq = 0;
export function newDraftKey(): string {
  keySeq += 1;
  return `d${Date.now().toString(36)}${keySeq}`;
}

export function emptyDraftItem(dueDate: string): PlanDraftItem {
  return {
    key: newDraftKey(),
    parentIdentifier: "",
    title: "",
    description: "",
    estimate: 1,
    dueDate,
  };
}

type RawItem = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the plan-apply JSON: `{ week, items: [{ parent, title, desc, estimate, due }] }`. */
export function parsePlanJson(raw: string): PlanDraftItem[] {
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown }).items;
  if (!Array.isArray(list)) throw new Error("Expected an items array");
  return list.map((entry: RawItem) => ({
    key: newDraftKey(),
    parentIdentifier: text(entry.parent ?? entry.parentIdentifier),
    title: text(entry.title),
    description: text(entry.desc ?? entry.description),
    estimate: Number(entry.estimate) || 0,
    dueDate: text(entry.due ?? entry.dueDate),
  }));
}

/** Team syncs Mon/Wed/Fri at 1 h each, the Linear minimum. */
export function syncItems(weekdays: string[]): PlanDraftItem[] {
  return [0, 2, 4]
    .map((index) => weekdays[index])
    .filter(Boolean)
    .map((day) => ({
      ...emptyDraftItem(day),
      title: `Team sync, ${day}`,
      description: "Team sync meeting (~40 min, logged as the 1 h Linear minimum).",
    }));
}

export function consultationItem(weekdays: string[], hours = 2): PlanDraftItem {
  const day = weekdays[2] ?? weekdays[0] ?? "";
  return {
    ...emptyDraftItem(day),
    title: `Team consultations in chat and calls, week of ${weekdays[0] ?? day}`,
    description: "Questions from other teams outside tickets: chat and short calls across the week.",
    estimate: hours,
  };
}

export function checkDraft(
  items: readonly PlanDraftItem[],
  weekdays: readonly string[],
  parents: ReadonlyMap<string, PlanParent>,
  existingHoursByDay: Record<string, number> = {},
): DraftCheck {
  const errors = new Map<string, string[]>();
  const duplicates = new Set<string>();
  const hoursByDay: Record<string, number> = { ...existingHoursByDay };
  const seen = new Set<string>();
  let total = 0;
  for (const day of Object.keys(existingHoursByDay)) {
    total += existingHoursByDay[day];
  }
  const days = new Set(weekdays);
  for (const item of items) {
    const problems: string[] = [];
    if (!item.title.trim()) problems.push("Title is required");
    if (!item.description.trim()) problems.push("Description is required");
    // Linear clamps estimates above 7 silently.
    if (!Number.isInteger(item.estimate) || item.estimate < 1 || item.estimate > 7) {
      problems.push("Hours must be 1 to 7");
    }
    if (!days.has(item.dueDate)) problems.push("Day must be Monday to Friday of this cycle");
    const parentKey = item.parentIdentifier.trim();
    const parent = parentKey ? parents.get(parentKey) : undefined;
    if (parentKey && !parent) problems.push(`Parent ${parentKey} not found`);
    const title = item.title.trim();
    const dupKey = `${parentKey}\u0000${title}`;
    if (title && (parent?.childTitles.includes(title) || seen.has(dupKey))) {
      duplicates.add(item.key);
    }
    seen.add(dupKey);
    if (problems.length) errors.set(item.key, problems);
    if (!duplicates.has(item.key) && days.has(item.dueDate)) {
      const hours = Number.isFinite(item.estimate) ? item.estimate : 0;
      hoursByDay[item.dueDate] = (hoursByDay[item.dueDate] ?? 0) + hours;
      total += hours;
    }
  }
  for (const item of items) {
    const hours = hoursByDay[item.dueDate] ?? 0;
    if (hours > DAY_CAPACITY_HOURS && !duplicates.has(item.key)) {
      const list = errors.get(item.key) ?? [];
      list.push(`${item.dueDate} is over ${DAY_CAPACITY_HOURS} h`);
      errors.set(item.key, list);
    }
  }
  return {
    errors,
    duplicates,
    hoursByDay,
    total,
    valid: items.length > 0 && errors.size === 0,
  };
}

export function targetGap(total: number): number {
  return Math.max(0, WEEK_TARGET_HOURS - total);
}

const DRAFT_KEY = "monocode.planDraft.";

export function loadDraft(cycleId: string): PlanDraftItem[] {
  try {
    const raw = localStorage.getItem(DRAFT_KEY + cycleId);
    return raw ? (JSON.parse(raw) as PlanDraftItem[]) : [];
  } catch {
    return [];
  }
}

export function saveDraft(cycleId: string, items: readonly PlanDraftItem[]) {
  try {
    if (items.length) localStorage.setItem(DRAFT_KEY + cycleId, JSON.stringify(items));
    else localStorage.removeItem(DRAFT_KEY + cycleId);
  } catch {
    // Storage can be unavailable; the draft then lives in memory only.
  }
}

export function loadPlanParents(identifiers: string[]): Promise<PlanParent[]> {
  return invoke<PlanParent[]>("linear_plan_parents", { identifiers });
}

export function createPlan(
  teamId: string,
  cycleId: string,
  stateId: string,
  items: readonly PlanDraftItem[],
): Promise<PlanCreateResult[]> {
  return invoke<PlanCreateResult[]>("linear_create_plan", {
    teamId,
    cycleId,
    stateId,
    items: items.map((item) => ({
      parentIdentifier: item.parentIdentifier.trim(),
      title: item.title.trim(),
      description: item.description.trim(),
      estimate: item.estimate,
      dueDate: item.dueDate,
    })),
  });
}
