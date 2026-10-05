import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassBackdrop } from "../../../app/shell/GlassBackdrop";
import { LAYER } from "../../../shared/lib/layers";
import { prettyCwd } from "../../../shared/lib/paths";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { FolderTree, LoaderCircle, X } from "../../../shared/ui/icons";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import type { ProjectMeta } from "../model/autoModel";
import { loadProjectMeta } from "../model/autoModelStore";
import {
  KNOWLEDGE_TABS,
  docText,
  loadKnowledgePage,
  saveKnowledgeDoc,
  sharedWith,
  tabDoc,
  type KnowledgePage,
  type KnowledgeTab,
} from "../model/projectKnowledgePage";

const TAB_HINT: Record<KnowledgeTab, string> = {
  overview: "",
  user: "Your instructions and facts. Agents read this first and never edit it.",
  model:
    "What agents learned about this project. You can correct it; agents keep it up to date.",
  infra:
    "Hosts, proxies and services. One “## name” section each, with kind, role, runs on, access, check and notes.",
  changes:
    "Infrastructure, version and CI changes. One “- YYYY-MM-DD what changed” line each.",
};

/** Composer button that opens the project's knowledge page. */
export function ProjectKnowledgeButton({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  if (!cwd || cwd === "~") return null;
  return (
    <>
      <button
        type="button"
        data-project-knowledge-button
        title="Project knowledge: your notes, agent notes, infrastructure and changes"
        aria-label="Project knowledge"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
        className="flex size-6.5 shrink-0 items-center justify-center rounded-md text-content/45 hover:bg-selection hover:text-content"
      >
        <FolderTree className="size-3.5" />
      </button>
      {open ? (
        <ProjectKnowledgePage cwd={cwd} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ProjectKnowledgePage({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<KnowledgePage | null>(null);
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [tab, setTab] = useState<KnowledgeTab>("overview");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (create: boolean) => {
      setBusy(true);
      setError(null);
      loadKnowledgePage(cwd, create)
        .then(setPage)
        .catch((reason) => setError(String(reason)))
        .finally(() => setBusy(false));
    },
    [cwd],
  );

  useEffect(() => {
    load(false);
    loadProjectMeta(cwd)
      .then(setMeta)
      .catch(() => undefined);
  }, [cwd, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      // Escape leaves the editor first, so a slip does not lose the page.
      if (draft !== null) setDraft(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft, onClose]);

  const doc = tabDoc(tab);
  const text = page && doc ? docText(page, doc) : "";

  const save = () => {
    if (!doc || draft === null) return;
    setBusy(true);
    setError(null);
    saveKnowledgeDoc(cwd, doc, draft)
      .then((next) => {
        setPage(next);
        setDraft(null);
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div
        className="modal-backdrop absolute inset-0 bg-black/40"
        onMouseDown={() => (draft === null ? onClose() : undefined)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Project knowledge"
        className="absolute top-1/2 left-1/2 isolate flex h-[min(760px,calc(100dvh-48px))] w-[min(980px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-content/7 shadow-2xl"
      >
        <GlassBackdrop className="bg-background-base/55" />
        <div className="relative z-[1] flex min-h-0 flex-1 flex-col text-[13px] text-content">
          <header className="flex shrink-0 items-start gap-2 px-5 pt-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-xl leading-tight font-medium">
                Project knowledge
              </h2>
              <p className="mt-0.5 truncate text-[12px] text-content/50">
                {prettyCwd(cwd)} · .monochrome
              </p>
            </div>
            {busy ? (
              <LoaderCircle className="mt-1.5 size-3.5 animate-spin text-content/45" />
            ) : null}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content"
            >
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          </header>

          {page && !page.status.mounted ? (
            <div className="flex flex-1 flex-col items-start gap-3 px-5 py-6">
              <p className="max-w-xl text-content/70">
                This project has no knowledge folder yet. Monochrome adds a
                .monochrome link to the project (kept out of git) with your
                notes, agent notes, an infrastructure map and a change log,
                and points every new session at it.
              </p>
              {page.status.problem ? (
                <p className="text-red-400">{page.status.problem}</p>
              ) : null}
              <SecondaryButton disabled={busy} onClick={() => load(true)}>
                Create project knowledge
              </SecondaryButton>
            </div>
          ) : page ? (
            <>
              <nav
                role="tablist"
                className="flex shrink-0 items-center gap-1 border-b border-content/7 px-4 pt-3 pb-2"
              >
                {KNOWLEDGE_TABS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    disabled={draft !== null && tab !== item.id}
                    onClick={() => setTab(item.id)}
                    className={`rounded-md px-2.5 py-1 text-[12px] disabled:opacity-40 ${
                      tab === item.id
                        ? "bg-selection text-content"
                        : "text-content/55 hover:bg-selection hover:text-content"
                    }`}
                  >
                    {item.label}
                    {item.id === "infra" && page.status.infra.length > 0
                      ? ` ${page.status.infra.length}`
                      : ""}
                    {item.id === "changes" && page.changeLog.length > 0
                      ? ` ${page.changeLog.length}`
                      : ""}
                  </button>
                ))}
                <div className="flex-1" />
                {doc && draft === null ? (
                  <SecondaryButton onClick={() => setDraft(text)}>
                    Edit
                  </SecondaryButton>
                ) : null}
                {doc && draft !== null ? (
                  <>
                    <SecondaryButton onClick={() => setDraft(null)}>
                      Cancel
                    </SecondaryButton>
                    <SecondaryButton disabled={busy} onClick={save}>
                      Save
                    </SecondaryButton>
                  </>
                ) : null}
              </nav>
              {error ? (
                <p className="shrink-0 px-5 pt-2 text-red-400">{error}</p>
              ) : null}
              {doc ? (
                <p className="shrink-0 px-5 pt-2 text-[12px] text-content/45">
                  {TAB_HINT[tab]}
                </p>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                {tab === "overview" ? (
                  <Overview page={page} meta={meta} />
                ) : draft !== null ? (
                  <textarea
                    autoFocus
                    spellCheck={false}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="h-full w-full resize-none rounded-md border border-content/10 bg-transparent p-3 font-mono text-[12px] leading-relaxed text-content outline-none focus:border-content/20"
                  />
                ) : tab === "infra" ? (
                  <Infra page={page} />
                ) : tab === "changes" ? (
                  <Changes page={page} />
                ) : text.trim() ? (
                  <AgentMarkdown text={text} cwd={cwd} hardBreaks />
                ) : (
                  <p className="text-content/45">Nothing written yet.</p>
                )}
              </div>
            </>
          ) : (
            <p className="px-5 py-6 text-content/45">
              {error ?? "Loading…"}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-40 shrink-0 text-content/45">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value || "—"}</dd>
    </div>
  );
}

function Overview({
  page,
  meta,
}: {
  page: KnowledgePage;
  meta: ProjectMeta | null;
}) {
  const profile = meta?.profile;
  const stats = meta?.stats;
  return (
    <dl>
      <Fact
        label="Languages"
        value={
          profile?.languages
            .map((language) => `${language.name} (${language.files})`)
            .join(", ") ?? ""
        }
      />
      <Fact label="Files" value={profile ? String(profile.fileCount) : ""} />
      <Fact label="CI/CD" value={profile?.ci.join(", ") ?? ""} />
      <Fact label="MCP config" value={profile?.mcp.join(", ") ?? ""} />
      <Fact
        label="Ties to other projects"
        value={profile?.links.join("; ") ?? ""}
      />
      <Fact
        label="Agent instructions"
        value={profile?.agentDocs.join(", ") ?? ""}
      />
      <Fact
        label="Auto-routed sessions"
        value={
          stats && stats.sessions > 0
            ? `${stats.sessions} (${Object.entries(stats.kinds)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(", ")}); moved to a new session: ${stats.restarts}`
            : ""
        }
      />
      <Fact
        label="Infrastructure"
        value={
          page.status.infra.length > 0
            ? `${page.status.infra.length} hosts and services${
                page.shared.length > 0
                  ? `, ${page.shared.length} shared with other projects`
                  : ""
              }`
            : ""
        }
      />
      <Fact
        label="Last change"
        value={
          page.changeLog[0]
            ? `${page.changeLog[0].day} ${page.changeLog[0].summary}`
            : ""
        }
      />
    </dl>
  );
}

function Infra({ page }: { page: KnowledgePage }) {
  const nodes = page.status.infra;
  if (nodes.length === 0)
    return (
      <p className="text-content/45">
        No hosts or services mapped yet. Agents add them as they work; you can
        add them with Edit.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {nodes.map((node) => {
        const shared = sharedWith(page, node.name);
        return (
          <section
            key={node.name}
            className="rounded-lg border border-content/7 px-3 py-2"
          >
            <h3 className="flex flex-wrap items-baseline gap-2 font-medium">
              <span className="font-mono">{node.name}</span>
              {node.kind ? (
                <span className="text-[12px] text-content/45">{node.kind}</span>
              ) : null}
              {node.runsOn ? (
                <span className="text-[12px] text-content/45">
                  on {node.runsOn}
                </span>
              ) : null}
              {shared.length > 0 ? (
                <span className="text-[12px] text-amber-400/90">
                  also in {shared.join(", ")}
                </span>
              ) : null}
            </h3>
            {node.role ? <p className="mt-0.5">{node.role}</p> : null}
            {node.access ? (
              <p className="mt-1 text-[12px] text-content/55">
                Access: <code className="font-mono">{node.access}</code>
              </p>
            ) : null}
            {node.check ? (
              <p className="text-[12px] text-content/55">
                Check: <code className="font-mono">{node.check}</code>
              </p>
            ) : null}
            {node.notes ? (
              <p className="text-[12px] text-content/55">{node.notes}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Changes({ page }: { page: KnowledgePage }) {
  if (page.changeLog.length === 0)
    return <p className="text-content/45">No changes logged yet.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {page.changeLog.map((change) => (
        <li key={`${change.day} ${change.summary}`} className="flex gap-3">
          <span className="w-24 shrink-0 font-mono text-[12px] text-content/45">
            {change.day}
          </span>
          <span className="min-w-0 flex-1 break-words">{change.summary}</span>
        </li>
      ))}
    </ul>
  );
}
