import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  type ProviderAccount,
  type ProviderAccountProvider,
} from "./providerAccounts";

/** Identity the provider CLI cached on disk after sign-in. */
export type ProviderAccountIdentity = {
  email?: string | null;
  name?: string | null;
  plan?: string | null;
  organization?: string | null;
};

export async function readProviderAccountIdentity(
  provider: ProviderAccountProvider,
  accountId: string,
): Promise<ProviderAccountIdentity | null> {
  try {
    return await invoke<ProviderAccountIdentity | null>(
      "provider_account_identity",
      { provider, accountId },
    );
  } catch {
    return null;
  }
}

/** "Max · user@example.com", or whichever half is known. */
export function identitySubtitle(
  identity: ProviderAccountIdentity | null | undefined,
): string | null {
  const parts = [identity?.plan, identity?.email].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Org chip text: "Personal" for Claude's default "<name>'s Organization". */
export function identityOrganizationTag(
  identity: ProviderAccountIdentity | null | undefined,
): string | null {
  const name = identity?.organization?.trim();
  if (!name) return null;
  return /['’]s Organization$/.test(name) ? "Personal" : name;
}

export function identityKey(account: ProviderAccount): string {
  return `${account.provider}:${account.id}`;
}

function sameSignIn(
  left: ProviderAccountIdentity | null | undefined,
  right: ProviderAccountIdentity | null | undefined,
): boolean {
  const email = (identity: typeof left) => identity?.email?.trim().toLowerCase();
  const org = (identity: typeof left) => identity?.organization?.trim() ?? "";
  return Boolean(email(left)) && email(left) === email(right) && org(left) === org(right);
}

/** Drop the unselected default when another profile is the same sign-in. */
export function withoutDuplicateDefault(
  accounts: ProviderAccount[],
  identities: Record<string, ProviderAccountIdentity | null>,
  selectedId: string,
): ProviderAccount[] {
  const fallback = accounts.find(
    (account) => account.id === DEFAULT_PROVIDER_ACCOUNT_ID,
  );
  if (!fallback || fallback.id === selectedId) return accounts;
  const identity = identities[identityKey(fallback)];
  const duplicated = accounts.some(
    (account) =>
      account !== fallback && sameSignIn(identities[identityKey(account)], identity),
  );
  return duplicated ? accounts.filter((account) => account !== fallback) : accounts;
}

/**
 * Load identities for `accounts`, keyed by `identityKey`. Re-reads whenever
 * `refreshKey` changes.
 */
export function useProviderAccountIdentities(
  accounts: ProviderAccount[],
  refreshKey?: unknown,
): Record<string, ProviderAccountIdentity | null> {
  const [identities, setIdentities] = useState<
    Record<string, ProviderAccountIdentity | null>
  >({});
  const key = accounts.map(identityKey).join("|");

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      accounts.map(
        async (account) =>
          [
            identityKey(account),
            await readProviderAccountIdentity(account.provider, account.id),
          ] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setIdentities(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);

  return identities;
}
