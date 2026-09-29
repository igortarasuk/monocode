import {
  providerAccountLabel,
  supportsProviderAccounts,
} from "../../../features/providers/model/providerAccounts";
import {
  HARNESS_TITLE,
  type HarnessId,
} from "../../../features/sessions/model/session";
import { claudeTextModel } from "../providers/claude/claudeText";
import { codexTextModel } from "../providers/codex/codexText";
import { TEXT_MODEL as GROK_TEXT_MODEL } from "../providers/grok/grokProtocol";
import { openCodeTextModel } from "../providers/opencode/opencodeText";
import { textProviderAccountId } from "./textAccount";
import { pickTextHarness } from "./textHarness";

function textModel(harness: HarnessId): string | null {
  if (harness === "claude") return claudeTextModel();
  if (harness === "codex") return codexTextModel();
  if (harness === "opencode") return openCodeTextModel();
  if (harness === "grok") return GROK_TEXT_MODEL;
  return null;
}

/** "Claude Code · claude-haiku-4-5 · Work": who writes commit and PR text. */
export function describeTextGenerator(
  cwd: string,
  preferred?: HarnessId,
): string {
  const harness = pickTextHarness(preferred);
  const account = supportsProviderAccounts(harness)
    ? providerAccountLabel(harness, textProviderAccountId(harness, cwd))
    : null;
  return [HARNESS_TITLE[harness], textModel(harness), account]
    .filter(Boolean)
    .join(" · ");
}
