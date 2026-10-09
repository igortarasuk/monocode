import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getVersion, getBundleType, check, message, ask, relaunch, invoke, openUrl } = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getBundleType: vi.fn(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
  check: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion,
  getBundleType,
  BundleType: { Nsis: "nsis", Msi: "msi", Deb: "deb", Rpm: "rpm", AppImage: "appimage", App: "app" },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask, message }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("../../features/settings/model/sounds", () => ({ announceUpdateAvailable: vi.fn() }));

import { packageManagerHint, probeForUpdate, runUpdateFlow } from "./updater";

describe("updater", () => {
  beforeEach(() => {
    getBundleType.mockResolvedValue("appimage");
  });

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

  it.each(["deb", "rpm"] as const)("names one %s installer and the releases URL", (kind) => {
    const hint = packageManagerHint(kind);
    expect(hint).toContain("https://github.com/igortarasuk/monocode/releases/latest");
    expect(hint).not.toMatch(/[*<>]/);
    expect(hint).toContain("Replace the file name");
    expect(hint).toContain(kind === "deb" ? "sudo apt install ./Monochrome_X.Y.Z_amd64.deb" : "sudo dnf install ./Monochrome-X.Y.Z-1.x86_64.rpm");
  });

  it.each(["deb", "rpm"] as const)(
    "checks releases for %s installs without touching the feed",
    async (kind) => {
      getVersion.mockResolvedValue("0.9.0");
      getBundleType.mockResolvedValue(kind);
      invoke.mockResolvedValue({ version: "0.9.1", url: "https://example.com/r" });
      ask.mockResolvedValue(false);

      await expect(runUpdateFlow(true)).resolves.toEqual({
        phase: "available",
        currentVersion: "0.9.0",
        availableVersion: "0.9.1",
        packageManaged: kind,
      });
      expect(check).not.toHaveBeenCalled();
    },
  );

  it("probes releases for package-managed installs", async () => {
    getVersion.mockResolvedValue("0.9.0");
    getBundleType.mockResolvedValue("deb");
    check.mockRejectedValue(new Error("Updater does not have any endpoints set"));
    invoke.mockResolvedValue(null);

    await expect(probeForUpdate()).resolves.toBeNull();
  });

  it("still checks the feed for AppImage installs", async () => {
    getVersion.mockResolvedValue("0.9.0");
    check.mockResolvedValue(null);

    await expect(runUpdateFlow(false)).resolves.toEqual({
      phase: "current",
      currentVersion: "0.9.0",
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it("treats a feed without this platform as unavailable, not as a failure", async () => {
    getVersion.mockResolvedValue("0.9.0");
    check.mockRejectedValue(
      new Error(
        'None of the fallback platforms `["linux-x86_64-deb", "linux-x86_64"]` were found in the response `platforms` object',
      ),
    );

    await expect(runUpdateFlow(true)).resolves.toEqual({
      phase: "idle",
      currentVersion: "0.9.0",
    });
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining("aren't available for this install yet"),
      { title: "Monochrome" },
    );
  });
});
