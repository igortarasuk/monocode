// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude" || id === "codex",
}));

import { textProviderAccountId } from "./textAccount";
import { pickTextHarness } from "./textHarness";
import {
  saveTextGeneratorSettings,
  textModelSetting,
} from "../../../features/providers/model/textGeneratorSettings";

function accounts() {
  localStorage.setItem(
    "monocode.providerAccounts.v1",
    JSON.stringify({
      claude: [
        { id: "work", provider: "claude", label: "Work" },
        { id: "personal", provider: "claude", label: "Personal" },
      ],
    }),
  );
}

beforeEach(() => localStorage.clear());

describe("helper text account", () => {
  it("uses the project's account instead of the default profile", () => {
    accounts();
    localStorage.setItem(
      "monocode.providerAccountSelections.v1",
      JSON.stringify({ "/home/me/app": { claude: "work" } }),
    );
    expect(textProviderAccountId("claude", "/home/me/app")).toBe("work");
    expect(textProviderAccountId("claude", "/home/me/other")).toBeUndefined();
    expect(textProviderAccountId("opencode", "/home/me/app")).toBeUndefined();
  });

  it("falls back to the account chosen without a project", () => {
    accounts();
    localStorage.setItem(
      "monocode.providerAccountSelections.v1",
      JSON.stringify({ "~": { claude: "personal" } }),
    );
    expect(textProviderAccountId("claude", "/home/me/app")).toBe("personal");
  });

  it("prefers the provider, model and account from Settings", () => {
    accounts();
    saveTextGeneratorSettings({
      harness: "codex",
      model: "codex:gpt-test",
      accountId: "acc-1",
    });
    expect(pickTextHarness("claude")).toBe("codex");
    expect(textProviderAccountId("codex", "/home/me/app")).toBe("acc-1");
    expect(textModelSetting("codex")).toBe("gpt-test");
    expect(textModelSetting("claude")).toBeUndefined();
    saveTextGeneratorSettings({});
    expect(pickTextHarness("claude")).toBe("claude");
  });
});
