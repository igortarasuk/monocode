import { BundleType, getBundleType, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { announceUpdateAvailable } from "../../features/settings/model/sounds";
import { compareSemver } from "../../integrations/harness/providers/opencode/opencodeProtocol";
import { rememberInstalledUpdate } from "./updateNotice";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "error";

export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  error?: string;
  /** Set on Linux .deb/.rpm installs, which update through apt/dnf. */
  packageManaged?: PackageManagedInstall;
};

let pendingUpdate: Update | null = null;

/** A newer GitHub release for builds without an updater feed. */
type AppRelease = { version: string; url: string };
let pendingRelease: AppRelease | null = null;

const RELEASES_URL = "https://github.com/igortarasuk/monocode/releases/latest";

/**
 * Linux `.deb` and `.rpm` installs belong to apt/dnf. The release feed only
 * publishes an AppImage target, so the plugin reports no matching platform
 * for them; surface that as "update through your package manager" instead of
 * a raw error, and never self-install.
 */
export type PackageManagedInstall = "deb" | "rpm";

export async function packageManagedInstall(): Promise<PackageManagedInstall | null> {
  let type: string | null;
  try {
    type = await getBundleType();
  } catch {
    return null;
  }
  if (type === BundleType.Deb) return "deb";
  if (type === BundleType.Rpm) return "rpm";
  return null;
}

export function packageManagerHint(kind: PackageManagedInstall): string {
  return kind === "deb"
    ? `Download one .deb from ${RELEASES_URL} and run: sudo apt install ./Monochrome_X.Y.Z_amd64.deb\nReplace the file name with the one you downloaded.`
    : `Download one .rpm from ${RELEASES_URL} and run: sudo dnf install ./Monochrome-X.Y.Z-1.x86_64.rpm\nReplace the file name with the one you downloaded.`;
}

function isTargetMissingError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  // tauri-plugin-updater Error::TargetsNotFound / Error::TargetNotFound.
  return /none of the fallback platforms|the platform `[^`]*` was not found/i.test(text);
}

function isUpdaterNotConfiguredError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /updater does not have any endpoints set/i.test(text);
}

export async function readAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "0.0.0";
  }
}

/** The newest GitHub release when it is newer than this build. */
async function newerRelease(currentVersion: string): Promise<AppRelease | null> {
  const release = await invoke<AppRelease | null>("app_latest_release");
  return release && compareSemver(release.version, currentVersion) > 0 ? release : null;
}

export async function probeForUpdate(): Promise<{ version: string } | null> {
  try {
    const update = await check();
    pendingUpdate = update;
    if (update) announceUpdateAvailable(update.version);
    return update;
  } catch (err) {
    if (!isUpdaterNotConfiguredError(err)) throw err;
    pendingUpdate = null;
    pendingRelease = await newerRelease(await readAppVersion());
    if (pendingRelease) announceUpdateAvailable(pendingRelease.version);
    return pendingRelease;
  }
}

/** Builds without an updater feed only learn about releases and link to them. */
async function runReleaseCheck(
  manual: boolean,
  currentVersion: string,
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  pendingUpdate = null;
  try {
    pendingRelease = await newerRelease(currentVersion);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failed: UpdaterSnapshot = { phase: "error", currentVersion, error };
    onProgress?.(failed);
    if (manual) {
      await message(`Couldn't check for updates.\n\n${error}`, { title: "Monochrome" });
    }
    return failed;
  }
  if (!pendingRelease) {
    const current: UpdaterSnapshot = { phase: "current", currentVersion };
    onProgress?.(current);
    if (manual) {
      await message("You're on the latest version.", { title: "Monochrome" });
    }
    return current;
  }
  announceUpdateAvailable(pendingRelease.version);
  const available: UpdaterSnapshot = {
    phase: "available",
    currentVersion,
    availableVersion: pendingRelease.version,
  };
  onProgress?.(available);
  if (!manual) return available;
  const open = await ask(
    `Monochrome ${pendingRelease.version} is available (you have ${currentVersion}).\n\nOpen the release page to download it?`,
    { title: "Update available", kind: "info" },
  );
  if (open) await openUrl(pendingRelease.url);
  return available;
}

export async function runUpdateFlow(
  manual: boolean,
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const currentVersion = await readAppVersion();
  const base: UpdaterSnapshot = { phase: "checking", currentVersion };
  onProgress?.(base);

  const managed = await packageManagedInstall();
  if (managed) {
    // apt/dnf own the install, but the release check still tells about a
    // new version and links to its page.
    const checked = await runReleaseCheck(manual, currentVersion);
    const snapshot: UpdaterSnapshot = { ...checked, packageManaged: managed };
    onProgress?.(snapshot);
    return snapshot;
  }

  try {
    const update = await check();
    if (!update) {
      pendingUpdate = null;
      const current: UpdaterSnapshot = { phase: "current", currentVersion };
      onProgress?.(current);
      if (manual) {
        await message("You're on the latest version.", { title: "Monochrome" });
      }
      return current;
    }

    pendingUpdate = update;
    announceUpdateAvailable(update.version);
    const available: UpdaterSnapshot = {
      phase: "available",
      currentVersion,
      availableVersion: update.version,
    };
    onProgress?.(available);

    if (!manual) return available;

    const notes = update.body?.trim();
    const detail = notes ? `\n\n${notes}` : "";
    const yes = await ask(
      `Monochrome ${update.version} is available (you have ${currentVersion}).${detail}\n\nInstall now?`,
      { title: "Update available", kind: "info" },
    );
    if (!yes) return available;

    return installPendingUpdate(onProgress);
  } catch (err) {
    if (isUpdaterNotConfiguredError(err)) {
      return runReleaseCheck(manual, currentVersion, onProgress);
    }

    if (isTargetMissingError(err)) {
      // The feed has no build for this platform/installer yet.
      pendingUpdate = null;
      const idle: UpdaterSnapshot = { phase: "idle", currentVersion };
      onProgress?.(idle);
      if (manual) {
        await message(
          `Automatic updates aren't available for this install yet.\n\nDownload releases at ${RELEASES_URL}`,
          { title: "Monochrome" },
        );
      }
      return idle;
    }

    const error = err instanceof Error ? err.message : String(err);
    const failed: UpdaterSnapshot = { phase: "error", currentVersion, error };
    onProgress?.(failed);
    if (manual) {
      await message(`Couldn't check for updates.\n\n${error}`, {
        title: "Monochrome",
      });
    }
    return failed;
  }
}

export async function installPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const currentVersion = await readAppVersion();
  const update = pendingUpdate;
  if (!update && pendingRelease) {
    // No updater feed: the release page is where the packages are.
    await openUrl(pendingRelease.url);
    const available: UpdaterSnapshot = {
      phase: "available",
      currentVersion,
      availableVersion: pendingRelease.version,
    };
    onProgress?.(available);
    return available;
  }
  if (!update) {
    const idle: UpdaterSnapshot = { phase: "idle", currentVersion };
    onProgress?.(idle);
    return idle;
  }

  let downloaded = 0;
  let contentLength = 0;

  const downloading: UpdaterSnapshot = {
    phase: "downloading",
    currentVersion,
    availableVersion: update.version,
    progress: 0,
  };
  onProgress?.(downloading);

  try {
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }

      const progress =
        contentLength > 0
          ? Math.min(100, Math.round((downloaded / contentLength) * 100))
          : undefined;

      onProgress?.({
        phase: "downloading",
        currentVersion,
        availableVersion: update.version,
        progress,
      });
    });

    rememberInstalledUpdate(update.version);
    pendingUpdate = null;
    await relaunch();
    return {
      phase: "current",
      currentVersion: update.version,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failed: UpdaterSnapshot = {
      phase: "error",
      currentVersion,
      availableVersion: update.version,
      error,
    };
    onProgress?.(failed);
    await message(`Couldn't install the update.\n\n${error}`, { title: "Monochrome" });
    return failed;
  }
}
