import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { nativeModelId } from "../../sessions/model/models";

const KEY = "monocode.textGenerator.v1";
const CHANGE_EVENT = "monocode-text-generator-changed";

/** Who writes commit messages, PR text and titles. Empty fields mean automatic. */
export type TextGeneratorSettings = {
  /** Provider; unset follows the active session's provider. */
  harness?: HarnessId;
  /** Model id from that provider's catalog; unset uses its default text model. */
  model?: string;
  /** Provider account id for Claude and Codex; unset uses the project's account. */
  accountId?: string;
};

export function loadTextGeneratorSettings(): TextGeneratorSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const item = value as Record<string, unknown>;
    const harness = HARNESSES.includes(item.harness as HarnessId)
      ? (item.harness as HarnessId)
      : undefined;
    const text = (field: unknown) =>
      typeof field === "string" && field.trim() ? field.trim() : undefined;
    return {
      ...(harness ? { harness } : {}),
      ...(harness && text(item.model) ? { model: text(item.model) } : {}),
      ...(harness && text(item.accountId)
        ? { accountId: text(item.accountId) }
        : {}),
    };
  } catch {
    return {};
  }
}

export function saveTextGeneratorSettings(settings: TextGeneratorSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTextGeneratorSettings(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Model chosen in Settings for this provider's helper text, if any. */
export function textModelSetting(harness: HarnessId): string | undefined {
  const settings = loadTextGeneratorSettings();
  if (settings.harness !== harness || !settings.model) return undefined;
  // Settings keep catalog ids ("<harness>:<id>"). OpenCode parses those
  // itself; the other text runners take the CLI's own model id.
  return harness === "opencode"
    ? settings.model
    : nativeModelId(settings.model);
}

export function textAccountSetting(harness: HarnessId): string | undefined {
  const settings = loadTextGeneratorSettings();
  return settings.harness === harness ? settings.accountId : undefined;
}
