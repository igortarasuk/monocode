export const SELECTABLE_AGENT_RESPONSE_ATTR = "data-selectable-agent-response";

export type TranscriptSelection = {
  text: string;
  rect: DOMRect;
  /** The selection as markdown, keeping tables, lists and code. */
  markdown?: string;
};

export type TranscriptSelectionCandidate = {
  text: string;
  collapsed: boolean;
  anchorResponseId: string | null;
  focusResponseId: string | null;
};

export function validateTranscriptSelection(
  candidate: TranscriptSelectionCandidate,
): string | null {
  const text = candidate.text.trim();
  if (!text || candidate.collapsed) return null;
  if (!candidate.anchorResponseId || !candidate.focusResponseId) return null;
  if (candidate.anchorResponseId !== candidate.focusResponseId) return null;
  return text;
}
