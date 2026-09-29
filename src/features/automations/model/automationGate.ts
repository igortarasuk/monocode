import type { AutomationGate } from "./automations";
import type {
  LayaAnswers,
  LayaClassifyResult,
  LayaFlag,
} from "../../laya/model/laya";

export const MAX_GATE_INPUT = 64 * 1024;
/** Laya's context is ~512 tokens: presets only see the start of the text. */
export const MAX_PRESET_INPUT = 2000;
export const MAX_GATE_FILES = 20;
const EXAMPLE_LINES = 15;
const PASSING_CHOICES = new Set(["none", "fine"]);

export type GateDeps = {
  /** Laya enabled and configured in Settings. */
  available: () => Promise<boolean>;
  classify: (domain: string, text: string) => Promise<LayaClassifyResult>;
  predict: (
    input: { preset: string } | { questions: Record<string, unknown> },
    text: string,
  ) => Promise<LayaAnswers>;
  diff: () => Promise<string>;
  /** Relative paths of the files in the automation folder. */
  listFiles: () => Promise<string[]>;
  readFile: (relative: string) => Promise<string>;
};

export type GateOutcome =
  /** Start the session; `prefix` goes before the prompt. */
  | { action: "run"; prefix?: string; note?: string }
  | { action: "skip"; reason: string };

export function defaultGate(): AutomationGate {
  return {
    kind: "laya-classify",
    domain: "ansible",
    threshold: 0.5,
    input: "diff",
    onPass: "skip",
  };
}

/** `**` crosses folders, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const text = glob.trim().replace(/^\.\//, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "*" && text[i + 1] === "*") {
      const slash = text[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

export async function gateInput(
  gate: AutomationGate,
  prompt: string,
  deps: Pick<GateDeps, "diff" | "listFiles" | "readFile">,
): Promise<string> {
  if (gate.input === "prompt") return cap(prompt, MAX_GATE_INPUT);
  if (gate.input === "diff") return cap(await deps.diff(), MAX_GATE_INPUT);
  const pattern = globToRegExp(gate.filesGlob || "**/*");
  const files = (await deps.listFiles())
    .filter((path) => pattern.test(path))
    .sort()
    .slice(0, MAX_GATE_FILES);
  let text = "";
  for (const file of files) {
    if (text.length >= MAX_GATE_INPUT) break;
    text += `${await deps.readFile(file)}\n`;
  }
  return cap(text, MAX_GATE_INPUT);
}

export type GateFlag = LayaFlag & { line: number };

export function classifyFlags(
  result: LayaClassifyResult,
  threshold: number,
): GateFlag[] {
  const best = new Map<string, GateFlag>();
  for (const chunk of result.chunks) {
    for (const flag of chunk.flagged) {
      if (flag.p < threshold) continue;
      const current = best.get(flag.rule);
      if (!current || flag.p > current.p)
        best.set(flag.rule, { ...flag, line: chunk.line });
    }
  }
  return [...best.values()].sort((a, b) => b.p - a.p);
}

export type AnswerDecision = {
  key: string;
  fired: boolean;
  /** Probability that decided. */
  p: number;
  choice?: string;
};

export function answerDecision(
  answers: LayaAnswers,
  threshold: number,
  key?: string,
): AnswerDecision | null {
  const chosen = key && key in answers ? key : Object.keys(answers)[0];
  const answer = chosen ? answers[chosen] : undefined;
  if (!chosen || !answer) return null;
  if (answer.noul !== undefined)
    return { key: chosen, fired: answer.noul >= threshold, p: answer.noul };
  if (answer.choice) {
    const p = answer.probabilities?.[answer.choice] ?? 0;
    return {
      key: chosen,
      choice: answer.choice,
      p,
      fired: !PASSING_CHOICES.has(answer.choice) && p >= threshold,
    };
  }
  return null;
}

function fence(text: string): string {
  const lines = text.split("\n");
  const body = lines.slice(0, EXAMPLE_LINES).join("\n");
  return `\`\`\`yaml\n${body}${lines.length > EXAMPLE_LINES ? "\n# …" : ""}\n\`\`\``;
}

/** Fixed template: only rule ids, numbers, nudges and stored examples. */
export function renderClassifyBlock(domain: string, flags: GateFlag[]): string {
  const lines = [
    `[Laya pre-check] The following rules were flagged in ${domain}:`,
  ];
  for (const flag of flags) {
    lines.push(
      `- ${flag.rule} at line ${flag.line} (p=${flag.p.toFixed(2)}): ${flag.nudge}`,
    );
    if (flag.example) {
      const source = flag.example.source ? ` (${flag.example.source})` : "";
      lines.push(`  Example that follows the rule${source}:`);
      lines.push(
        fence(flag.example.text)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      );
    }
  }
  lines.push("Review these first.");
  return lines.join("\n");
}

export function renderAnswerBlock(
  source: string,
  decision: AnswerDecision,
): string {
  const value = decision.choice
    ? `${decision.choice} (p=${decision.p.toFixed(2)})`
    : `p=${decision.p.toFixed(2)}`;
  return `[Laya pre-check] ${source}: ${decision.key} = ${value}. Review this first.`;
}

function parseQuestions(text: string | undefined): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    throw new Error("Pre-check questions are not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pre-check questions must be a JSON object");
  return value as Record<string, unknown>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Decide an automation run. Never throws: any Laya error runs the session as
 * usual and reports `Laya unavailable: …` in `note`.
 */
export async function runGate(
  gate: AutomationGate | null | undefined,
  prompt: string,
  deps: GateDeps,
): Promise<GateOutcome> {
  if (!gate) return { action: "run" };
  try {
    if (!(await deps.available())) return { action: "run" };
    const text = await gateInput(gate, prompt, deps);
    if (!text.trim()) {
      return gate.onPass === "skip"
        ? { action: "skip", reason: "Laya: nothing to check" }
        : { action: "run" };
    }
    if (gate.kind === "laya-classify") {
      const domain = gate.domain || "ansible";
      const flags = classifyFlags(
        await deps.classify(domain, text),
        gate.threshold,
      );
      if (flags.length)
        return { action: "run", prefix: renderClassifyBlock(domain, flags) };
      return gate.onPass === "skip"
        ? {
            action: "skip",
            reason: `Laya: nothing flagged (p<${gate.threshold})`,
          }
        : { action: "run" };
    }
    const preset =
      gate.kind === "laya-preset" ? gate.preset || "test-gaps" : null;
    const input = preset
      ? { preset }
      : { questions: parseQuestions(gate.questions) };
    const decision = answerDecision(
      await deps.predict(input, cap(text, MAX_PRESET_INPUT)),
      gate.threshold,
      gate.key,
    );
    if (!decision) throw new Error("Laya returned no answers");
    if (decision.fired)
      return {
        action: "run",
        prefix: renderAnswerBlock(
          preset ?? "custom questions",
          decision,
        ),
      };
    return gate.onPass === "skip"
      ? {
          action: "skip",
          reason: `Laya: ${decision.key} below threshold (p=${decision.p.toFixed(2)})`,
        }
      : { action: "run" };
  } catch (reason) {
    return { action: "run", note: `Laya unavailable: ${message(reason)}` };
  }
}
