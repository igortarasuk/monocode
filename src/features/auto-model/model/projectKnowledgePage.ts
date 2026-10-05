import { invoke } from "@tauri-apps/api/core";

export type KnowledgeDoc = "user.md" | "model.md" | "infra.md" | "changes.md";

export type InfraNode = {
  name: string;
  kind: string;
  role: string;
  runsOn: string;
  access: string;
  check: string;
  notes: string;
};

export type KnowledgePage = {
  status: {
    mounted: boolean;
    problem: string | null;
    infra: InfraNode[];
    changes: number;
  };
  user: string;
  model: string;
  infra: string;
  changes: string;
  changeLog: { day: string; summary: string }[];
  /** Hosts and services that another project's map names too. */
  shared: { name: string; projects: string[] }[];
};

export type KnowledgeTab = "overview" | "user" | "model" | "infra" | "changes";

export const KNOWLEDGE_TABS: { id: KnowledgeTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "user", label: "Owner notes" },
  { id: "model", label: "Agent notes" },
  { id: "infra", label: "Infrastructure" },
  { id: "changes", label: "Changes" },
];

/** The document a tab edits; the overview has none. */
export function tabDoc(tab: KnowledgeTab): KnowledgeDoc | null {
  if (tab === "overview") return null;
  return `${tab}.md` as KnowledgeDoc;
}

export function docText(page: KnowledgePage, doc: KnowledgeDoc): string {
  if (doc === "user.md") return page.user;
  if (doc === "model.md") return page.model;
  if (doc === "infra.md") return page.infra;
  return page.changes;
}

/** `create` mounts the knowledge folder into a project that lacks it. */
export function loadKnowledgePage(
  cwd: string,
  create: boolean,
): Promise<KnowledgePage> {
  return invoke<KnowledgePage>("project_knowledge_page", { cwd, create });
}

export function saveKnowledgeDoc(
  cwd: string,
  name: KnowledgeDoc,
  content: string,
): Promise<KnowledgePage> {
  return invoke<KnowledgePage>("project_knowledge_write", {
    cwd,
    name,
    content,
  });
}

/** Other projects that share a node, by folder name. */
export function sharedWith(page: KnowledgePage, name: string): string[] {
  return (
    page.shared
      .find((node) => node.name === name)
      ?.projects.map((path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path) ??
    []
  );
}
