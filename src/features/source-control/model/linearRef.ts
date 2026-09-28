import type { PrContent } from "./gitText";

const BRANCH_ID_RE = /(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9}-\d{1,7})(?=$|[-_/])/g;
const BRACKET_ID_RE = /\[([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})\]/g;

function uniqueUpper(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toUpperCase()))];
}

/** Linear ids from `[ID]` commit subjects, oldest first. */
export function linearIdsFromCommits(commitSummary: string): string[] {
  const subjects = commitSummary.split("\n").reverse();
  const ids = subjects.flatMap((line) =>
    [...line.matchAll(BRACKET_ID_RE)].map((match) => match[1]),
  );
  return uniqueUpper(ids);
}

/** Ids leading a branch segment, as in `me/dev7-42-fix`. */
export function linearIdsFromBranch(branch: string): string[] {
  const ids = [...branch.matchAll(BRANCH_ID_RE)].map((match) => match[1]);
  return uniqueUpper(ids);
}

/** Commits win over the branch name. */
export function findLinearIds(input: {
  commitSummary: string;
  branch: string;
}): string[] {
  const fromCommits = linearIdsFromCommits(input.commitSummary);
  return fromCommits.length > 0
    ? fromCommits
    : linearIdsFromBranch(input.branch);
}

/** Prefix the title and add a Refs line so Linear links it. */
export function withLinearRefs(content: PrContent, ids: string[]): PrContent {
  if (ids.length === 0) return content;
  const title = content.title.trim();
  const titleHas = (id: string) => title.toUpperCase().includes(id);
  const nextTitle = titleHas(ids[0]) ? title : `[${ids[0]}] ${title}`;
  const body = content.body.trim();
  const missing = ids.filter((id) => !body.toUpperCase().includes(id));
  const refs = missing.length > 0 ? `Refs ${missing.join(", ")}` : "";
  const nextBody = [body, refs].filter(Boolean).join("\n\n");
  return { title: nextTitle, body: nextBody };
}
