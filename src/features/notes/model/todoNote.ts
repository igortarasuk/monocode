export const TODO_TAG = "todo";

const CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+/;
const LIST_ITEM_RE = /^([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Turn an agent reply into a to-do body: every top-level list item becomes
 * `- [ ] item`; text without a list becomes one item from its first line,
 * followed by the rest unchanged. Existing checkboxes are kept.
 */
export function replyToTodoBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let converted = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || CHECKBOX_RE.test(line)) {
      if (!inFence) converted = true;
      return line;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (!item) return line;
    converted = true;
    return `- [ ] ${item[2]}`;
  });
  if (converted) return out.join("\n").trim();

  const trimmed = text.trim();
  if (!trimmed) return "- [ ] ";
  const [first, ...rest] = trimmed.split(/\r?\n/);
  const tail = rest.join("\n").trim();
  return tail ? `- [ ] ${first.trim()}\n\n${tail}` : `- [ ] ${first.trim()}`;
}

export type TodoItem = {
  /** Line index in the body. */
  line: number;
  checked: boolean;
  text: string;
};

export function todoItems(body: string): TodoItem[] {
  const items: TodoItem[] = [];
  let inFence = false;
  body.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const match = CHECKBOX_RE.exec(line);
    if (!match) return;
    items.push({
      line: index,
      checked: match[2] !== " ",
      text: line.slice(match[0].length),
    });
  });
  return items;
}

/** Flip the checkbox on one line; any other line leaves the body unchanged. */
export function toggleTodoLine(body: string, line: number): string {
  const lines = body.split("\n");
  const current = lines[line];
  if (current === undefined) return body;
  const match = CHECKBOX_RE.exec(current);
  if (!match) return body;
  const mark = match[2] === " " ? "x" : " ";
  lines[line] = current.replace(/\[([ xX])\]/, `[${mark}]`);
  return lines.join("\n");
}
