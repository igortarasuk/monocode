import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listProjectFiles } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listProjectFiles: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../../platform/tauri/fs", () => ({ listProjectFiles }));
vi.mock("../../projects/model/recents", () => ({
  isLocalProject: (path: string) => path.startsWith("/home/me/"),
}));

import {
  clearFileReferenceCache,
  fileReferenceExists,
  projectHasFile,
} from "./fileReferenceExists";

const files = [
  {
    name: "vault.yml",
    path: "/home/me/infra/roles/db/vars/vault.yml",
    relative: "roles/db/vars/vault.yml",
  },
  {
    name: "40-users-teleport_xml.j2",
    path: "/home/me/infra/roles/db/templates/40-users-teleport_xml.j2",
    relative: "roles/db/templates/40-users-teleport_xml.j2",
  },
];

beforeEach(() => {
  clearFileReferenceCache();
  invoke.mockReset();
  listProjectFiles.mockReset();
});

describe("file references", () => {
  it("matches project files by path, suffix or name", () => {
    const cwd = "/home/me/infra";
    expect(projectHasFile(files, `${cwd}/vars/vault.yml`, cwd)).toBe(true);
    expect(projectHasFile(files, `${cwd}/vault.yml`, cwd)).toBe(true);
    expect(projectHasFile(files, `${cwd}/40-users-teleport.xml`, cwd)).toBe(
      false,
    );
  });

  it("checks project files against the index and others on disk", async () => {
    listProjectFiles.mockResolvedValue(files);
    expect(
      await fileReferenceExists(
        "/home/me/infra/teleport_tls.xml",
        "/home/me/infra",
      ),
    ).toBe(false);
    expect(
      await fileReferenceExists(
        "/home/me/infra/vars/vault.yml",
        "/home/me/infra",
      ),
    ).toBe(true);
    expect(listProjectFiles).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValue(false);
    expect(
      await fileReferenceExists("/etc/teleport.yaml", "/home/me/infra"),
    ).toBe(false);
    expect(invoke).toHaveBeenCalledWith("path_is_file", {
      path: "/etc/teleport.yaml",
    });
  });

  it("stays unknown when the check fails", async () => {
    listProjectFiles.mockRejectedValue(new Error("offline"));
    expect(
      await fileReferenceExists("/home/me/infra/a.yml", "/home/me/infra"),
    ).toBeNull();
  });
});
