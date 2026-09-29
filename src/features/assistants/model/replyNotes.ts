import { normalizeNoteTags } from "../../notes/notes";
import { replyToTodoBody, TODO_TAG } from "../../notes/model/todoNote";
import { assistantForCwd } from "./assistants";

export type ReplyNoteKind = "note" | "todo";

/** Body and tags for a saved agent reply: assistant tags, plus checkboxes for a to-do. */
export function replyNoteContent(
  text: string,
  cwd: string,
  kind: ReplyNoteKind = "note",
): { body: string; tags: string[] } {
  const tags = assistantForCwd(cwd)?.noteTags ?? [];
  if (kind === "note") return { body: text, tags };
  return {
    body: replyToTodoBody(text),
    tags: normalizeNoteTags([...tags, TODO_TAG]),
  };
}
