import { KNOWLEDGE_POINTER } from "./autoModel";
import { isAutoModel, syncProjectKnowledge } from "./autoModelStore";

/**
 * Point a session's first prompt at the project's knowledge folder. The
 * folder is mounted the first time Auto model is used in a project; after
 * that every session there gets the pointer, Auto or not.
 */
export async function withProjectKnowledge(
  prompt: string,
  input: {
    cwd: string;
    workCwd?: string;
    sessionId: string;
    firstTurn: boolean;
  },
): Promise<string> {
  if (!input.firstTurn || !input.cwd || input.cwd === "~") return prompt;
  try {
    const status = await syncProjectKnowledge(
      input.cwd,
      isAutoModel(input.sessionId),
      input.workCwd,
    );
    return status.mounted ? `${prompt}\n\n${KNOWLEDGE_POINTER}` : prompt;
  } catch {
    return prompt;
  }
}
