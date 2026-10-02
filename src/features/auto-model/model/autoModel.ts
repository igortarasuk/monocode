import { contextRatio } from "../../sessions/model/contextUsage";
import {
  loadFavoriteModels,
  modelEffortSetting,
  modelsFor,
  type AgentModel,
} from "../../sessions/model/models";
import type { HarnessId, Session } from "../../sessions/model/session";

/**
 * Auto model: the user picks a provider, a small model picks the model.
 *
 * On a session's first message the task is sized up (kind, scale, effort) and
 * routed to one of the provider's models. Once the context is half full, each
 * new message is checked against the original task: the same task keeps the
 * session and its prompt cache; a different one moves to a fresh session that
 * carries a recap and the project memory instead of the old context.
 */

export const TASK_KINDS = ["rnd", "code", "troubleshoot", "doc"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SCALES = ["small", "medium", "large"] as const;
export type TaskScale = (typeof TASK_SCALES)[number];

/** Share of the context window after which a new message is scope-checked. */
export const REVIEW_CONTEXT_RATIO = 0.5;
const MAX_CANDIDATES = 12;
const TASK_LIMIT = 4_000;

export type ProjectMeta = {
  profile: {
    languages: { name: string; files: number }[];
    fileCount: number;
    ci: string[];
    mcp: string[];
    links: string[];
    agentDocs: string[];
  };
  memory: string[];
  stats: {
    sessions: number;
    restarts: number;
    kinds: Record<string, number>;
  };
  classifierSkill: string | null;
};

export type Route = {
  kind: TaskKind;
  scale: TaskScale;
  model: AgentModel;
  /** Effort option of `model`, when it has one and the router chose it. */
  effort?: string;
  summary: string;
  reason: string;
};

export type Verdict = { sameTask: true } | ({ sameTask: false } & Route);

export type AutoModelStage = "route" | "review";

/** Which check, if any, a message sent to this session goes through. */
export function autoModelStage(
  session: Session,
  text: string,
): AutoModelStage | null {
  const prompt = text.trim();
  // Commands are not tasks.
  if (!prompt || prompt.startsWith("/") || prompt.startsWith("!")) return null;
  if (session.busy || session.pendingSwitch) return null;
  if (session.inboxAsk || session.orchestrationLeadId) return null;
  if (!session.cwd || session.cwd === "~") return null;
  const started = session.blocks.some(
    (block) => block.role === "user" && !block.draft,
  );
  if (!started) return "route";
  const ratio = contextRatio(session.context);
  return ratio !== null && ratio >= REVIEW_CONTEXT_RATIO ? "review" : null;
}

/**
 * Models the router may choose from. A long catalog (OpenCode) is narrowed to
 * the user's favourites, or to the current model's upstream provider.
 */
export function candidateModels(
  harness: HarnessId,
  currentModelId: string,
): AgentModel[] {
  const models = modelsFor(harness);
  if (models.length <= MAX_CANDIDATES) return models;
  const favorites = new Set(loadFavoriteModels());
  const favored = models.filter((model) => favorites.has(model.id));
  if (favored.length > 1) return favored.slice(0, MAX_CANDIDATES);
  const provider = models.find((model) => model.id === currentModelId)?.provider
    ?.id;
  const sameProvider = provider
    ? models.filter((model) => model.provider?.id === provider)
    : [];
  return (sameProvider.length > 1 ? sameProvider : models).slice(
    0,
    MAX_CANDIDATES,
  );
}

function effortOptions(model: AgentModel): string[] {
  return modelEffortSetting(model)?.options.map((option) => option.value) ?? [];
}

function describeProject(meta: ProjectMeta | null): string {
  if (!meta) return "(unknown project)";
  const { profile, stats } = meta;
  const lines = [
    profile.languages.length > 0
      ? `Languages: ${profile.languages
          .map((language) => `${language.name} (${language.files} files)`)
          .join(", ")}`
      : "",
    profile.fileCount > 0 ? `Files: ${profile.fileCount}` : "",
    profile.ci.length > 0 ? `CI/CD: ${profile.ci.join(", ")}` : "",
    profile.mcp.length > 0 ? `MCP config: ${profile.mcp.join(", ")}` : "",
    profile.links.length > 0
      ? `Ties to other projects: ${profile.links.join("; ")}`
      : "",
    profile.agentDocs.length > 0
      ? `Agent instructions: ${profile.agentDocs.join(", ")}`
      : "",
    stats.sessions > 0
      ? `Earlier tasks here: ${Object.entries(stats.kinds)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(", ")}; restarted for a new task: ${stats.restarts}`
      : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "(no profile yet)";
}

function describeModels(models: AgentModel[]): string {
  return models
    .map((model, index) => {
      const efforts = effortOptions(model);
      const provider = model.provider ? `${model.provider.name} · ` : "";
      return `${index + 1}. ${provider}${model.name}${
        efforts.length > 0 ? ` — efforts: ${efforts.join(", ")}` : ""
      }`;
    })
    .join("\n");
}

const DEFAULT_RULES = `- kind: "rnd" (exploring, researching, designing), "code" (writing or changing code), "troubleshoot" (debugging, failing tests, incidents), "doc" (documentation, explanations, comments).
- scale: "small" (a quick answer or a change in one place), "medium" (a feature or fix across a few files), "large" (cross-cutting, architectural or long-running work).
- Pick the least expensive listed model that will do this task well. Keep the most capable model for large or ambiguous work; well-scoped everyday coding goes to a mid-tier model; small tasks and docs go to the fastest one.
- effort: one of the efforts listed for the model you picked, or "" when it lists none. Lower effort for small, well-specified tasks.`;

/** Body of a project's own routing skill, without its frontmatter. */
function skillRules(skill: string | null | undefined): string | null {
  const body = skill?.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body ? body : null;
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

const ROUTE_SHAPE = `"kind": "...", "scale": "...", "model": <number from the list>, "effort": "...", "summary": "<the task in one sentence>", "reason": "<why this model, a few words>"`;

export function buildRoutePrompt(input: {
  meta: ProjectMeta | null;
  models: AgentModel[];
  task: string;
}): string {
  return `You route a coding task to a model. Do not solve the task. Do not use tools. Reply with one JSON object and nothing else.

<project>
${describeProject(input.meta)}
</project>

<models>
${describeModels(input.models)}
</models>

<task>
${clip(input.task, TASK_LIMIT)}
</task>

Rules:
${skillRules(input.meta?.classifierSkill) ?? DEFAULT_RULES}

Reply: {${ROUTE_SHAPE}}`;
}

export function buildReviewPrompt(input: {
  meta: ProjectMeta | null;
  models: AgentModel[];
  originalTask: string;
  recent: string;
  message: string;
}): string {
  return `A coding session has used over half of its context. Decide whether the user's new message still belongs to the session's original task. Do not solve anything. Do not use tools. Reply with one JSON object and nothing else.

<original_task>
${clip(input.originalTask, 1_500)}
</original_task>

<session_so_far>
${clip(input.recent, 2_000)}
</session_so_far>

<new_message>
${clip(input.message, TASK_LIMIT)}
</new_message>

"same_task" is true when the message continues the original task: refining it, fixing or debugging what it produced, answering a question about it. It is false when the message starts different work, even in the same project.

When "same_task" is false, also route the new work:

<project>
${describeProject(input.meta)}
</project>

<models>
${describeModels(input.models)}
</models>

Rules:
${skillRules(input.meta?.classifierSkill) ?? DEFAULT_RULES}

Reply: {"same_task": true} or {"same_task": false, ${ROUTE_SHAPE}}`;
}

function parseObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.find((item) => item === text) ?? fallback;
}

function routeFrom(
  value: Record<string, unknown>,
  models: AgentModel[],
  task: string,
): Route | null {
  const index =
    typeof value.model === "number"
      ? value.model
      : Number.parseInt(String(value.model ?? ""), 10);
  const model = Number.isInteger(index) ? models[index - 1] : undefined;
  if (!model) return null;
  const effort =
    typeof value.effort === "string" ? value.effort.trim().toLowerCase() : "";
  const text = (field: unknown) =>
    typeof field === "string" ? field.replace(/\s+/g, " ").trim() : "";
  return {
    kind: oneOf(value.kind, TASK_KINDS, "code"),
    scale: oneOf(value.scale, TASK_SCALES, "medium"),
    model,
    ...(effortOptions(model).includes(effort) ? { effort } : {}),
    summary: text(value.summary) || clip(task.replace(/\s+/g, " "), 240),
    reason: text(value.reason),
  };
}

/** Router reply for a first message; null when it is unusable. */
export function parseRoute(
  output: string,
  models: AgentModel[],
  task: string,
): Route | null {
  const value = parseObject(output);
  return value ? routeFrom(value, models, task) : null;
}

/** Scope-check reply. An unusable reply keeps the session: never move by accident. */
export function parseVerdict(
  output: string,
  models: AgentModel[],
  message: string,
): Verdict {
  const value = parseObject(output);
  if (!value || value.same_task !== false) return { sameTask: true };
  const route = routeFrom(value, models, message);
  return route ? { sameTask: false, ...route } : { sameTask: true };
}

/** Model settings for a routed session: the chosen effort over the current ones. */
export function routeModelSettings(
  route: Pick<Route, "model" | "effort">,
  current: Record<string, string>,
): Record<string, string> {
  const setting = modelEffortSetting(route.model);
  if (!setting || !route.effort) return current;
  return { ...current, [setting.id]: route.effort };
}

/** What the session was started for, when no routed task was recorded. */
export function firstUserRequest(session: Session): string {
  const first = session.blocks.find(
    (block) => block.role === "user" && !block.draft && block.text.trim(),
  );
  return first?.text.trim() ?? "";
}

export function buildRecapPrompt(nextRequest: string): string {
  return `The user is moving on to different work, which will continue in a fresh session without this conversation. Their next message is sent separately — do not answer it.

<next_request>
${clip(nextRequest, 1_500)}
</next_request>

Do not run commands, read files or call tools. Use only this conversation. Plain markdown, no greeting, exactly these two sections:

## Recap
Under 120 words: what this session did, where it stands, files it edited, anything unfinished.

## Project memory
Up to 6 bullets of durable facts about this project that any later session would need: conventions, commands that work, pitfalls found here. No task progress, nothing obvious from the code. Write "none" when there is nothing.`;
}

/** Split the outgoing agent's reply into the recap and the memory bullets. */
export function parseRecap(output: string): {
  recap: string;
  memory: string[];
} {
  const text = output.trim();
  const match = /^#{1,6}\s*Project memory\s*$/im.exec(text);
  const head = (match ? text.slice(0, match.index) : text)
    .replace(/^#{1,6}\s*Recap\s*$/im, "")
    .trim();
  const tail = match ? text.slice(match.index + match[0].length) : "";
  const memory = tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => !/^none\.?$/i.test(line))
    .slice(0, 6);
  return { recap: head, memory };
}
