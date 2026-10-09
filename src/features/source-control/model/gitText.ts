import { limitSection, parseJsonObject, stringField } from "../../../shared/lib/jsonText";

export type CommitMessage = {
  subject: string;
  body: string;
};

export type PrContent = {
  title: string;
  body: string;
};

/**
 * The project's own instructions outrank the defaults below: the helper runs
 * in the repository, so it has already read them and the user's memory.
 */
const PROJECT_RULES = [
  "- if the project instructions or your memory describe how to write commits or change requests here (format, language, length, prefixes), follow them over the rules below",
  "- never add Co-Authored-By, Signed-off-by or 'Generated with' lines, or any other mention of an AI tool or assistant",
];

export function buildCommitMessagePrompt(input: {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
}): string {
  const wantsBranch = input.includeBranch === true;
  return [
    "You write concise git commit messages.",
    wantsBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Do not call tools. Reply with JSON only.",
    "Rules:",
    ...PROJECT_RULES,
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body is an empty string unless the change needs explaining; then at most a few short lines",
    ...(wantsBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");
}

export function buildPrContentPrompt(input: {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}): string {
  return [
    "You write source control change request content.",
    "Return a JSON object with keys: title, body.",
    "Do not call tools. Reply with JSON only.",
    "Rules:",
    ...PROJECT_RULES,
    "- title should be concise and specific",
    "- body is short markdown: what changed and why, in at most five brief bullet points",
    "- no headings, no testing section, and no restating of the diff file by file",
    "",
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    "Commits:",
    limitSection(input.commitSummary, 12_000),
    "",
    "Diff stat:",
    limitSection(input.diffSummary, 12_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");
}

export function buildBranchNamePrompt(message: string): string {
  return [
    "You generate concise git branch names.",
    "Return a JSON object with key: branch.",
    "Do not call tools. Reply with JSON only.",
    "Rules:",
    "- Branch should describe the requested work from the user message.",
    "- Keep it short and specific (2-6 words).",
    "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
    "",
    "User message:",
    limitSection(message, 8_000),
  ].join("\n");
}

const ATTRIBUTION_LINE =
  /^\s*(?:co-authored-by:.*(?:claude|anthropic|codex|openai|cursor|copilot|gemini|grok|devin|opencode|noreply@).*|(?:🤖\s*)?generated (?:with|by) .*)$/i;

/**
 * Drops AI co-author trailers and "Generated with" footers. Commit bodies an
 * agent wrote in a session carry them into the change request text.
 */
export function stripAttribution(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !ATTRIBUTION_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseCommitMessage(raw: string): CommitMessage | null {
  const rec = parseJsonObject(raw);
  if (!rec) return null;
  const subject = sanitizeCommitSubject(
    stringField(rec, "subject") ||
      stringField(rec, "title") ||
      stringField(rec, "message"),
  );
  if (!subject) return null;
  return { subject, body: stripAttribution(commitBody(rec)) };
}

function commitBody(rec: Record<string, unknown>): string {
  const value = rec.body;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === "string" ? [item] : []))
      .join("\n")
      .trim();
  }
  return "";
}

export function formatCommitMessage(message: CommitMessage): string {
  return message.body ? `${message.subject}\n\n${message.body}` : message.subject;
}

export function parsePrContent(raw: string): PrContent | null {
  const rec = parseJsonObject(raw);
  if (!rec) return null;
  const title = sanitizePrTitle(stringField(rec, "title"));
  const body = stripAttribution(stringField(rec, "body"));
  if (!title) return null;
  return { title, body };
}

export function parseBranchName(raw: string): string | null {
  const rec = parseJsonObject(raw);
  const branch = sanitizeBranchFragment(
    rec ? stringField(rec, "branch") : raw,
  );
  return branch || null;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (!withoutTrailingPeriod) return "";
  if (withoutTrailingPeriod.length <= 72) return withoutTrailingPeriod;
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

export function sanitizePrTitle(raw: string): string {
  return raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
}

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
  const fragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return fragment;
}
