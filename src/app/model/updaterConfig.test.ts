import { afterEach, describe, expect, it, vi } from "vitest";

const { getVersion, check, message, ask, relaunch, invoke, openUrl } = vi.hoisted(() => ({
  getVersion: vi.fn(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
  check: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask, message }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("../../features/settings/model/sounds", () => ({ announceUpdateAvailable: vi.fn() }));

import { runUpdateFlow } from "./updater";

describe("updater", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  const noEndpoints = () =>
    check.mockRejectedValue(new Error("Updater does not have any endpoints set"));
  const release = {
    version: "0.1.24",
    url: "https://github.com/igortarasuk/monocode/releases/tag/v0.1.24",
  };

  it("reports a newer GitHub release quietly on automatic checks", async () => {
    getVersion.mockResolvedValue("0.1.23");
    noEndpoints();
    invoke.mockResolvedValue(release);

    await expect(runUpdateFlow(false)).resolves.toEqual({
      phase: "available",
      currentVersion: "0.1.23",
      availableVersion: "0.1.24",
    });
    expect(invoke).toHaveBeenCalledWith("app_latest_release");
    expect(ask).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("offers the release page on manual checks", async () => {
    getVersion.mockResolvedValue("0.1.23");
    noEndpoints();
    invoke.mockResolvedValue(release);
    ask.mockResolvedValue(true);

    await expect(runUpdateFlow(true)).resolves.toMatchObject({ phase: "available" });
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("Monochrome 0.1.24 is available"),
      expect.anything(),
    );
    expect(openUrl).toHaveBeenCalledWith(release.url);
  });

  it("says the build is current when no newer release exists", async () => {
    getVersion.mockResolvedValue("0.1.24");
    noEndpoints();
    invoke.mockResolvedValue(release);

    await expect(runUpdateFlow(true)).resolves.toEqual({
      phase: "current",
      currentVersion: "0.1.24",
    });
    expect(message).toHaveBeenCalledWith("You're on the latest version.", { title: "Monochrome" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reports a failed release lookup", async () => {
    getVersion.mockResolvedValue("0.1.23");
    noEndpoints();
    invoke.mockRejectedValue(new Error("GitHub request failed"));

    await expect(runUpdateFlow(true)).resolves.toMatchObject({
      phase: "error",
      error: "GitHub request failed",
    });
    expect(message).toHaveBeenCalledOnce();
  });

  it("still reports real updater failures", async () => {
    getVersion.mockResolvedValue("0.1.23");
    check.mockRejectedValue(new Error("network failed"));

    await expect(runUpdateFlow(true)).resolves.toMatchObject({
      phase: "error",
      error: "network failed",
    });
    expect(message).toHaveBeenCalledOnce();
  });
});
