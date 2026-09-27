import { invoke } from "@tauri-apps/api/core";
import type { ProviderAccountProvider } from "./providerAccounts";

/** Remove a named profile's native credentials before its UI metadata. */
export async function removeProviderAccountCredentials(
  provider: ProviderAccountProvider,
  accountId: string,
): Promise<void> {
  await invoke("provider_account_remove", { provider, accountId });
}

/** The CLI config dir a profile links to; `null` means isolated. */
export async function readProviderAccountConfigDir(
  provider: ProviderAccountProvider,
  accountId: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("provider_account_config_dir", {
      provider,
      accountId,
    });
  } catch {
    return null;
  }
}

/** Link a profile to an existing config dir, or `null` to isolate it. */
export async function setProviderAccountConfigDir(
  provider: ProviderAccountProvider,
  accountId: string,
  configDir: string | null,
): Promise<string | null> {
  return invoke<string | null>("provider_account_set_config_dir", {
    provider,
    accountId,
    configDir,
  });
}
