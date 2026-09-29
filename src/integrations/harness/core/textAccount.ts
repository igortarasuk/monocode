import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  selectedProviderAccountId,
  supportsProviderAccounts,
} from "../../../features/providers/model/providerAccounts";
import type { HarnessId } from "../../../features/sessions/model/session";
import { textAccountSetting } from "../../../features/providers/model/textGeneratorSettings";

/**
 * Account for helper text (commit messages, PR text, titles): the profile
 * chosen for this project, else the one chosen without a project. The
 * default profile may not be signed in when all work runs in named profiles.
 */
export function textProviderAccountId(
  harness: HarnessId,
  cwd: string,
): string | undefined {
  if (!supportsProviderAccounts(harness)) return undefined;
  const configured = textAccountSetting(harness);
  if (configured) return configured;
  const project = selectedProviderAccountId(harness, cwd);
  if (project !== DEFAULT_PROVIDER_ACCOUNT_ID) return project;
  const global = selectedProviderAccountId(harness, undefined);
  return global === DEFAULT_PROVIDER_ACCOUNT_ID ? undefined : global;
}
