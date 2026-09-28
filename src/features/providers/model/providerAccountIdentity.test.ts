import { describe, expect, it } from "vitest";
import { withoutDuplicateDefault } from "./providerAccountIdentity";
import type { ProviderAccount } from "./providerAccounts";

const fallback: ProviderAccount = {
  id: "default",
  provider: "claude",
  label: "Default account",
  isDefault: true,
};
const work: ProviderAccount = { id: "account-work", provider: "claude", label: "Work" };
const personal: ProviderAccount = {
  id: "account-personal",
  provider: "claude",
  label: "Personal",
};
const accounts = [fallback, work, personal];
const identities = {
  "claude:default": { email: "Me@Corp.one", organization: "Corp" },
  "claude:account-work": { email: "me@corp.one", organization: "Corp" },
  "claude:account-personal": { email: "me@mail.com", organization: null },
};

describe("withoutDuplicateDefault", () => {
  it("hides the default when another profile is the same sign-in", () => {
    expect(withoutDuplicateDefault(accounts, identities, "account-work")).toEqual([
      work,
      personal,
    ]);
  });

  it("keeps the default while it is selected", () => {
    expect(withoutDuplicateDefault(accounts, identities, "default")).toBe(accounts);
  });

  it("keeps the default when no profile matches it", () => {
    const other = {
      ...identities,
      "claude:account-work": { email: "me@corp.one", organization: "Other" },
    };
    expect(withoutDuplicateDefault(accounts, other, "account-work")).toBe(accounts);
    expect(withoutDuplicateDefault(accounts, {}, "account-work")).toBe(accounts);
  });
});
