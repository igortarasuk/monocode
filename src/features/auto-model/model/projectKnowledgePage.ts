import { invoke } from "@tauri-apps/api/core";
import type { ArchitectureDiagram } from "./infraDiagram";

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
  /** `.monochrome/architecture.json`, drawn from the infrastructure map. */
  architecture: ArchitectureDiagram | null;
  /** The Archify page an agent delivered as `.monochrome/architecture.html`. */
  diagram: { path: string; modified: number } | null;
};

export type KnowledgeTab =
  | "overview"
  | "user"
  | "model"
  | "infra"
  | "diagram"
  | "changes";

export const KNOWLEDGE_TABS: { id: KnowledgeTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "user", label: "Owner notes" },
  { id: "model", label: "Agent notes" },
  { id: "infra", label: "Infrastructure" },
  { id: "diagram", label: "Diagram" },
  { id: "changes", label: "Changes" },
];

/** The document a tab edits; the overview and the diagram have none. */
export function tabDoc(tab: KnowledgeTab): KnowledgeDoc | null {
  if (tab === "overview" || tab === "diagram") return null;
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

/**
 * What the Diagram tab hands to an agent. Archify is an agent skill: the
 * agent traces the system and authors the candidate, Archify renders it.
 */
export function diagramRequest(exists: boolean): string {
  return [
    exists
      ? "Update this project's architecture diagram with the Archify skill."
      : "Draw this project's architecture diagram with the Archify skill.",
    "",
    "- Trace the real system first: the repository (code, inventory, deployment and CI config, existing docs and diagrams) and .monochrome/infra.md. Show the components that matter, the boundaries they live in (hosts, groups, regions, networks) and the data and control flows between them, with source evidence for each component.",
    "- Edit the candidate in .monochrome/architecture.json: keep the nodes that are still true where they are, remove what is gone, add what is new, and group them into the boundaries they live in.",
    "- Set meta.output to .monochrome/architecture.html and run Archify's finalize on the candidate with this project as the repository root. Repair it until finalize passes.",
    "- If the Archify skill is not installed, stop and tell me (npx skills add tt-a1i/archify -g). Do not draw the diagram any other way.",
    "- Then add to .monochrome/infra.md whatever the diagram shows that the map lacks.",
  ].join("\n");
}
