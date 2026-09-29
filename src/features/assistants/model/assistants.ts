import { invoke } from "@tauri-apps/api/core";
import { prettyCwd } from "../../../shared/lib/paths";
import { normalizeNoteTags } from "../../notes/notes";
import {
  ASSISTANT_WORKSPACE_ROOT as WORKSPACE_ROOT,
  isAssistantWorkspace,
} from "../../projects/model/recents";
import {
  DEFAULT_RUNTIME_MODE,
  HARNESSES,
  RUNTIME_MODES,
  type HarnessId,
  type RuntimeMode,
} from "../../sessions/model/session";

export const ASSISTANT_ICONS = [
  "sparkles",
  "globe",
  "search",
  "clock",
  "bot",
  "idea",
  "pen",
  "note",
] as const;

export type AssistantIcon = (typeof ASSISTANT_ICONS)[number];

export type Assistant = {
  id: string;
  /** Directory name under `~/Assistants`; fixed once created. */
  slug: string;
  name: string;
  icon: AssistantIcon;
  harness: HarnessId;
  /** Model id, or empty for the provider's default model. */
  model: string;
  /** Effort / thinking controls, same shape as `Session.modelSettings`. */
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  /** Written to `CLAUDE.md` and `AGENTS.md` in the workspace. */
  instructions: string;
  /** Slash command inserted at the start of a new chat, without the slash. */
  skill?: string;
  /** Tags added when a reply from this assistant is saved as a note. */
  noteTags: string[];
  createdAt: number;
  updatedAt: number;
};

export type AssistantDraft = Omit<
  Assistant,
  "id" | "slug" | "createdAt" | "updatedAt"
>;

const STORAGE_KEY = "monocode:assistants:v1";
export const ASSISTANTS_CHANGED_EVENT = "monocode:assistants-changed";
const MAX_SLUG = 48;

export const ASSISTANT_TEMPLATES: readonly AssistantDraft[] = [
  {
    name: "Translator",
    icon: "globe",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    instructions:
      "Translate the text you are given. Ukrainian goes to English, anything else goes to Ukrainian.\nKeep the formatting, code blocks and names as they are. Reply with the translation only.",
    noteTags: ["translation"],
  },
  {
    name: "R&D",
    icon: "idea",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    instructions:
      "Research the question before answering: compare options, cite sources or documentation, and say what is uncertain.\nEnd with a short recommendation and the next steps as a list.",
    noteTags: ["rnd"],
  },
  {
    name: "Routine",
    icon: "clock",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    instructions:
      "Help plan and track routine work. Turn requests into short, concrete to-do lists with one action per item.\nKeep answers brief.",
    noteTags: ["routine", "todo"],
  },
];

/** Lowercase letters, digits and hyphens, as the workspace command requires. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "assistant";
}

export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalize(value: unknown): Assistant | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Assistant>;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.slug !== "string" || slugify(item.slug) !== item.slug)
    return null;
  if (typeof item.name !== "string" || !item.name.trim()) return null;
  const harness = HARNESSES.includes(item.harness as HarnessId)
    ? (item.harness as HarnessId)
    : "claude";
  const settings =
    item.modelSettings && typeof item.modelSettings === "object"
      ? Object.fromEntries(
          Object.entries(item.modelSettings).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return {
    id: item.id,
    slug: item.slug,
    name: item.name.trim(),
    icon: ASSISTANT_ICONS.includes(item.icon as AssistantIcon)
      ? (item.icon as AssistantIcon)
      : "sparkles",
    harness,
    model: typeof item.model === "string" ? item.model : "",
    modelSettings: settings,
    runtimeMode: RUNTIME_MODES.includes(item.runtimeMode as RuntimeMode)
      ? (item.runtimeMode as RuntimeMode)
      : DEFAULT_RUNTIME_MODE,
    instructions: typeof item.instructions === "string" ? item.instructions : "",
    ...(typeof item.skill === "string" && item.skill.trim()
      ? { skill: item.skill.trim().replace(/^\/+/, "") }
      : {}),
    noteTags: normalizeNoteTags(
      Array.isArray(item.noteTags)
        ? item.noteTags.filter((tag): tag is string => typeof tag === "string")
        : [],
    ),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
  };
}

export function loadAssistants(): Assistant[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const list =
      parsed && typeof parsed === "object" && "assistants" in parsed
        ? (parsed as { assistants: unknown }).assistants
        : [];
    if (!Array.isArray(list)) return [];
    const out: Assistant[] = [];
    const slugs = new Set<string>();
    for (const value of list) {
      const assistant = normalize(value);
      if (!assistant || slugs.has(assistant.slug)) continue;
      slugs.add(assistant.slug);
      out.push(assistant);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveAssistants(assistants: Assistant[]): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, assistants }),
    );
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(ASSISTANTS_CHANGED_EVENT));
  return true;
}

export function subscribeAssistants(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(ASSISTANTS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ASSISTANTS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Create from a draft (new slug) or update an existing assistant by id. */
export function upsertAssistant(
  input: AssistantDraft & Partial<Pick<Assistant, "id">>,
): Assistant {
  const assistants = loadAssistants();
  const now = Date.now();
  const existing = input.id
    ? assistants.find((item) => item.id === input.id)
    : undefined;
  const saved = normalize({
    ...input,
    id: existing?.id ?? crypto.randomUUID(),
    slug:
      existing?.slug ??
      uniqueSlug(input.name, assistants.map((item) => item.slug)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (!saved) throw new Error("Assistant needs a name");
  saveAssistants(
    existing
      ? assistants.map((item) => (item.id === saved.id ? saved : item))
      : [...assistants, saved],
  );
  return saved;
}

export function deleteAssistant(id: string): void {
  saveAssistants(loadAssistants().filter((item) => item.id !== id));
}

/** `~/Assistants/<slug>` as `prettyCwd` shows it. */
export function assistantWorkspace(slug: string): string {
  return `${WORKSPACE_ROOT}${slug}`;
}

export { isAssistantWorkspace };

function assistantSlugForCwd(cwd: string): string | null {
  if (!cwd) return null;
  const pretty = prettyCwd(cwd);
  if (!pretty.startsWith(WORKSPACE_ROOT)) return null;
  const slug = pretty.slice(WORKSPACE_ROOT.length).split("/")[0];
  return slug || null;
}

export function assistantForCwd(
  cwd: string,
  assistants: Assistant[] = loadAssistants(),
): Assistant | null {
  const slug = assistantSlugForCwd(cwd);
  if (!slug) return null;
  return assistants.find((item) => item.slug === slug) ?? null;
}

/** Create the workspace folder and its instruction files; returns the absolute path. */
export async function prepareAssistantWorkspace(
  assistant: Pick<Assistant, "slug" | "name" | "instructions">,
): Promise<string> {
  return invoke<string>("assistant_workspace_prepare", {
    slug: assistant.slug,
    name: assistant.name,
    instructions: assistant.instructions,
  });
}
