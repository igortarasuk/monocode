import type { Block } from "./session";

/**
 * Whether a reply ends by asking something, so one-click Yes/No answers are
 * worth offering. Only the closing paragraph counts: a question earlier in a
 * reply has usually been answered by the reply itself.
 */
export function endsWithQuestion(text: string): boolean {
  const paragraphs = text
    .replace(/```[\s\S]*?(```|$)/g, "\n\n")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/`[^`\n]*`/g, "").trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1];
  return !!last && /[?？]/.test(last);
}

/** The closing reply of a turn, if it ends with a question. */
export function turnAsksQuestion(turn: Block[]): boolean {
  for (let i = turn.length - 1; i >= 0; i--) {
    const block = turn[i];
    if (block.role === "assistant" && block.text.trim())
      return endsWithQuestion(block.text);
  }
  return false;
}
