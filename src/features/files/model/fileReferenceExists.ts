import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { listProjectFiles, type ProjectFile } from "../../../platform/tauri/fs";
import { isEqualOrInside } from "../../../shared/lib/paths";
import { isLocalProject } from "../../projects/model/recents";

/**
 * Whether a file named in an agent reply exists, so only real files render as
 * links. Names are often rendered output or remote paths ("40-users.xml" on a
 * server) that match nothing on this computer.
 */

const TTL_MS = 30_000;

type Entry<T> = { at: number; value: Promise<T> };
const projectFiles = new Map<string, Entry<ProjectFile[]>>();
const absolute = new Map<string, Entry<boolean>>();

function cached<T>(
  map: Map<string, Entry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  map.set(key, { at: Date.now(), value });
  if (map.size > 200) map.delete(map.keys().next().value!);
  return value;
}

/** Same matching the editor uses to open a shortened path. */
export function projectHasFile(
  files: ProjectFile[],
  path: string,
  cwd: string,
): boolean {
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  const relative = normalized.startsWith(`${base}/`)
    ? normalized.slice(base.length + 1)
    : normalized.replace(/^\/+/, "");
  const name = relative.split("/").filter(Boolean).pop() ?? relative;
  return files.some(
    (file) =>
      !file.isDir &&
      (file.relative === relative ||
        file.relative.endsWith(`/${relative}`) ||
        file.name === name),
  );
}

/** `null` when the check itself failed; callers then keep the old behaviour. */
export function fileReferenceExists(
  path: string,
  cwd: string | undefined,
): Promise<boolean | null> {
  if (cwd && isLocalProject(cwd) && isEqualOrInside(path, cwd)) {
    return cached(projectFiles, cwd, () => listProjectFiles(cwd))
      .then((files) => (files.length ? projectHasFile(files, path, cwd) : null))
      .catch(() => null);
  }
  return cached(absolute, path, () =>
    invoke<boolean>("path_is_file", { path }),
  ).catch(() => null);
}

/**
 * `false` only once the file is known to be missing; a reference stays a
 * link while it is checked or when it cannot be checked.
 */
export function useFileReferenceExists(
  path: string | undefined,
  cwd: string | undefined,
): boolean {
  const [exists, setExists] = useState(true);
  useEffect(() => {
    setExists(true);
    if (!path) return;
    let live = true;
    void fileReferenceExists(path, cwd).then((value) => {
      if (live && value === false) setExists(false);
    });
    return () => {
      live = false;
    };
  }, [path, cwd]);
  return exists;
}

export function clearFileReferenceCache() {
  projectFiles.clear();
  absolute.clear();
}
