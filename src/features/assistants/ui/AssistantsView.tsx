import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import {
  AiIdea,
  AlertCircle,
  Bot,
  Clock,
  Globe,
  PenLine,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  X,
  type IconComponent,
} from "../../../shared/ui/icons";
import { AccessPicker } from "../../sessions/ui/AccessPicker";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { ModelPicker } from "../../sessions/ui/ModelPicker";
import { defaultModelId, findModel } from "../../sessions/model/models";
import { HARNESS_TITLE } from "../../sessions/model/session";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { loadSkills, type Skill } from "../../skills/model/skills";
import { normalizeNoteTags } from "../../notes/notes";
import {
  ASSISTANT_ICONS,
  ASSISTANT_TEMPLATES,
  assistantForCwd,
  deleteAssistant,
  loadAssistants,
  prepareAssistantWorkspace,
  subscribeAssistants,
  upsertAssistant,
  type Assistant,
  type AssistantDraft,
  type AssistantIcon,
} from "../model/assistants";

const ACTION =
  "inline-flex items-center gap-1.5 rounded-md px-3 text-[12px] disabled:cursor-default disabled:opacity-40";
const ACTION_FILLED = `${ACTION} h-7 bg-content font-medium text-background-base hover:bg-content/80`;
const ACTION_OUTLINE = `${ACTION} h-7 border border-content/15 text-content/80 hover:border-content/30 hover:bg-content/10 hover:text-content`;
const FIELD =
  "w-full rounded-md border border-content/12 bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-content/30";

export const ASSISTANT_ICON: Record<AssistantIcon, IconComponent> = {
  sparkles: Sparkles,
  globe: Globe,
  search: Search,
  clock: Clock,
  bot: Bot,
  idea: AiIdea,
  pen: PenLine,
  note: StickyNote,
};

type Props = {
  besideRail: boolean;
  compactRail: boolean;
  history: SessionSummary[];
  onClose: () => void;
  onToggleSidebar: () => void;
  onStartChat: (assistant: Assistant) => Promise<void>;
  onOpenSession: (sessionId: string) => Promise<void>;
};

export function AssistantsView({
  besideRail,
  compactRail,
  history,
  onClose,
  onToggleSidebar,
  onStartChat,
  onOpenSession,
}: Props) {
  return (
    <div
      role="region"
      aria-label="Assistants"
      data-app-assistants
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
          <Bot
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Assistants</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <AssistantsContent
        history={history}
        onStartChat={onStartChat}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

let rememberedAssistantId: string | null = null;

export function AssistantsContent({
  history,
  onStartChat,
  onOpenSession,
}: Pick<Props, "history" | "onStartChat" | "onOpenSession">) {
  const [assistants, setAssistants] = useState(loadAssistants);
  const [selectedId, setSelectedId] = useState<string | null>(
    rememberedAssistantId,
  );
  const [gallery, setGallery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => subscribeAssistants(() => setAssistants(loadAssistants())),
    [],
  );

  const selected =
    assistants.find((item) => item.id === selectedId) ?? assistants[0] ?? null;
  const showGallery = gallery || !selected;

  useEffect(() => {
    rememberedAssistantId = selected?.id ?? null;
  }, [selected?.id]);

  const chatsBySlug = useMemo(() => {
    const out = new Map<string, SessionSummary[]>();
    for (const session of history) {
      if (session.archived) continue;
      const assistant = assistantForCwd(session.cwd, assistants);
      if (!assistant) continue;
      const list = out.get(assistant.slug) ?? [];
      list.push(session);
      out.set(assistant.slug, list);
    }
    for (const list of out.values())
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [assistants, history]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const createFrom = (template: AssistantDraft) =>
    run(async () => {
      const saved = upsertAssistant({
        ...template,
        model: template.model || defaultModelId(template.harness),
      });
      await prepareAssistantWorkspace(saved);
      setSelectedId(saved.id);
      setGallery(false);
    });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 text-content">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-stroke">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-stroke px-3">
          <span className="text-[12px] text-content/50">Assistants</span>
          <button
            type="button"
            title="New assistant"
            aria-label="New assistant"
            onClick={() => setGallery(true)}
            className="grid size-6 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
          {assistants.map((assistant) => {
            const Icon = ASSISTANT_ICON[assistant.icon];
            const active = !showGallery && assistant.id === selected?.id;
            const chats = chatsBySlug.get(assistant.slug)?.length ?? 0;
            return (
              <li key={assistant.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(assistant.id);
                    setGallery(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left ${
                    active ? "bg-content/10" : "hover:bg-content/6"
                  }`}
                >
                  <Icon
                    className="size-4 shrink-0 text-content/60"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {assistant.name}
                    </span>
                    <span className="block truncate text-[11px] text-content/40">
                      {modelLine(assistant)} · {chats}{" "}
                      {chats === 1 ? "chat" : "chats"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <div className="mx-8 mt-4 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-[12px] text-red-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setError(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        {showGallery ? (
          <TemplateGallery
            onPick={(template) => void createFrom(template)}
            onCancel={selected ? () => setGallery(false) : undefined}
          />
        ) : (
          <AssistantEditor
            key={selected.id}
            assistant={selected}
            chats={chatsBySlug.get(selected.slug) ?? []}
            onError={setError}
            onStartChat={(assistant) => run(() => onStartChat(assistant))}
            onOpenSession={(id) => run(() => onOpenSession(id))}
            onDuplicate={(assistant) =>
              void createFrom({ ...assistant, name: `${assistant.name} copy` })
            }
            onDelete={(assistant) => {
              if (
                !window.confirm(
                  `Delete “${assistant.name}”? Its chats and ~/Assistants/${assistant.slug} stay on disk.`,
                )
              )
                return;
              deleteAssistant(assistant.id);
              setSelectedId(null);
            }}
          />
        )}
      </main>
    </div>
  );
}

function modelLine(assistant: Assistant): string {
  const model = findModel(assistant.model);
  return `${HARNESS_TITLE[assistant.harness]} · ${model?.name ?? "default model"}`;
}

function TemplateGallery({
  onPick,
  onCancel,
}: {
  onPick: (template: AssistantDraft) => void;
  onCancel?: () => void;
}) {
  const blank: AssistantDraft = {
    name: "New assistant",
    icon: "sparkles",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    instructions: "",
    noteTags: [],
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Assistants</h1>
          <p className="mt-1 text-[13px] text-content/55">
            Chats with fixed instructions and defaults, outside any project.
            Save useful replies to Notes or as to-dos.
          </p>
        </div>
        {onCancel ? (
          <button type="button" className={ACTION_OUTLINE} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {[...ASSISTANT_TEMPLATES, blank].map((template) => {
          const Icon = ASSISTANT_ICON[template.icon];
          return (
            <button
              key={template.name}
              type="button"
              onClick={() => onPick(template)}
              className="flex flex-col items-start gap-2 rounded-lg border border-content/10 p-4 text-left hover:border-content/25 hover:bg-content/5"
            >
              <Icon className="size-5 text-content/60" strokeWidth={1.75} />
              <span className="text-[13px] font-medium">{template.name}</span>
              <span className="line-clamp-3 text-[12px] text-content/50">
                {template.instructions || "Start from an empty assistant."}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AssistantEditor({
  assistant,
  chats,
  onError,
  onStartChat,
  onOpenSession,
  onDuplicate,
  onDelete,
}: {
  assistant: Assistant;
  chats: SessionSummary[];
  onError: (message: string | null) => void;
  onStartChat: (assistant: Assistant) => Promise<void>;
  onOpenSession: (sessionId: string) => Promise<void>;
  onDuplicate: (assistant: Assistant) => void;
  onDelete: (assistant: Assistant) => void;
}) {
  const [draft, setDraft] = useState<Assistant>(assistant);
  const [tagText, setTagText] = useState(assistant.noteTags.join(", "));
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const dirty =
    JSON.stringify({ ...draft, noteTags: parseTags(tagText) }) !==
    JSON.stringify(assistant);

  useEffect(() => {
    let live = true;
    prepareAssistantWorkspace(assistant)
      .then((path) => live && setWorkspace(path))
      .catch((reason) => live && onError(String(reason)));
    return () => {
      live = false;
    };
    // The folder only needs to exist once per opened assistant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.slug]);

  useEffect(() => {
    if (!workspace) return;
    let live = true;
    loadSkills({ harness: draft.harness, cwd: workspace })
      .then((list) => live && setSkills(list))
      .catch(() => live && setSkills([]));
    return () => {
      live = false;
    };
  }, [draft.harness, workspace]);

  const skillNames = useMemo(() => {
    const names = skills
      .filter((skill) => skill.kind === "file" && skill.scope === "user")
      .map((skill) => skill.invocation || skill.name);
    if (draft.skill && !names.includes(draft.skill)) names.unshift(draft.skill);
    return [...new Set(names)].sort();
  }, [draft.skill, skills]);

  const update = <K extends keyof Assistant>(key: K, value: Assistant[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = (): Assistant => {
    if (!draft.name.trim()) throw new Error("Give the assistant a name");
    const saved = upsertAssistant({ ...draft, noteTags: parseTags(tagText) });
    setTagText(saved.noteTags.join(", "));
    void prepareAssistantWorkspace(saved).catch((reason) =>
      onError(String(reason)),
    );
    return saved;
  };

  const newChat = async () => {
    const saved = dirty ? save() : assistant;
    await onStartChat(saved);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-6">
      <header className="flex items-start gap-4">
        <IconChooser
          value={draft.icon}
          onChange={(icon) => update("icon", icon)}
        />
        <input
          aria-label="Assistant name"
          value={draft.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Name"
          className="min-w-0 flex-1 bg-transparent text-[20px] font-semibold leading-tight outline-none placeholder:text-content/35"
        />
        <div className="flex shrink-0 items-center gap-2">
          {dirty ? (
            <>
              <button
                type="button"
                className={ACTION_OUTLINE}
                onClick={() => {
                  setDraft(assistant);
                  setTagText(assistant.noteTags.join(", "));
                }}
              >
                Reset
              </button>
              <button
                type="button"
                className={ACTION_OUTLINE}
                onClick={() => {
                  try {
                    save();
                  } catch (reason) {
                    onError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  }
                }}
              >
                Save
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={ACTION_FILLED}
            onClick={() => void newChat()}
          >
            New chat
          </button>
        </div>
      </header>
      <p className="mt-1 pl-12 text-[11px] text-content/40">
        ~/Assistants/{assistant.slug}
      </p>

      <Section title="Model">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            harness={draft.harness}
            model={draft.model || defaultModelId(draft.harness)}
            values={draft.modelSettings}
            project={workspace ?? undefined}
            onChange={(harness, model) =>
              setDraft((current) => ({ ...current, harness, model }))
            }
            onSettingsChange={(modelSettings) =>
              update("modelSettings", modelSettings)
            }
          />
          {draft.harness !== "fx" ? (
            <AccessPicker
              value={draft.runtimeMode}
              onChange={(runtimeMode) => update("runtimeMode", runtimeMode)}
            />
          ) : null}
        </div>
      </Section>

      <Section
        title="Instructions"
        hint="Saved as CLAUDE.md and AGENTS.md in the assistant folder. They apply to Claude, Codex and OpenCode."
      >
        <textarea
          aria-label="Instructions"
          value={draft.instructions}
          onChange={(event) => update("instructions", event.target.value)}
          rows={8}
          spellCheck={false}
          className={`${FIELD} min-h-40 resize-y font-mono text-[12px] leading-relaxed`}
        />
      </Section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Skill" hint="Inserted at the start of every new chat.">
          <select
            aria-label="Skill"
            value={draft.skill ?? ""}
            onChange={(event) =>
              update("skill", event.target.value || undefined)
            }
            className={FIELD}
          >
            <option value="">None</option>
            {skillNames.map((name) => (
              <option key={name} value={name}>
                /{name}
              </option>
            ))}
          </select>
        </Section>
        <Section title="Note tags" hint="Added when a reply is saved to Notes.">
          <input
            aria-label="Note tags"
            value={tagText}
            onChange={(event) => setTagText(event.target.value)}
            placeholder="rnd, todo"
            className={FIELD}
          />
        </Section>
      </div>

      <Section title="Chats">
        {chats.length ? (
          <ul className="divide-y divide-content/7 rounded-md border border-content/10">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  onClick={() => void onOpenSession(chat.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-content/5"
                >
                  <HarnessIcon
                    harness={chat.harness}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {chat.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-content/40">
                    {new Date(chat.updatedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-content/45">No chats yet.</p>
        )}
      </Section>

      <div className="mt-8 flex gap-2 border-t border-stroke pt-4">
        <button
          type="button"
          className={ACTION_OUTLINE}
          onClick={() => onDuplicate(assistant)}
        >
          Duplicate
        </button>
        <button
          type="button"
          className={`${ACTION_OUTLINE} text-red-300`}
          onClick={() => onDelete(assistant)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
}

export function parseTags(text: string): string[] {
  return normalizeNoteTags(text.split(/[,\s]+/));
}

function IconChooser({
  value,
  onChange,
}: {
  value: AssistantIcon;
  onChange: (icon: AssistantIcon) => void;
}) {
  const [open, setOpen] = useState(false);
  const Current = ASSISTANT_ICON[value];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Icon"
        onClick={() => setOpen((next) => !next)}
        className="grid size-8 place-items-center rounded-md border border-content/12 hover:bg-content/8"
      >
        <Current className="size-4" strokeWidth={1.75} />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-10 grid grid-cols-4 gap-1 rounded-md border border-content/12 bg-background-base p-1.5 shadow-lg">
          {ASSISTANT_ICONS.map((icon) => {
            const Icon = ASSISTANT_ICON[icon];
            return (
              <button
                key={icon}
                type="button"
                aria-label={icon}
                onClick={() => {
                  onChange(icon);
                  setOpen(false);
                }}
                className={`grid size-7 place-items-center rounded ${
                  icon === value ? "bg-content/12" : "hover:bg-content/8"
                }`}
              >
                <Icon className="size-4" strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-[12px] font-medium text-content/50">{title}</h2>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-content/35">{hint}</p>
      ) : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}
