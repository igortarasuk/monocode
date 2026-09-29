// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../../files/model/fileReferenceExists", () => ({
  useFileReferenceExists: (path: string | undefined) =>
    !path?.endsWith("40-users-teleport.xml"),
}));

import { AgentMarkdown } from "./AgentMarkdown";

it("links only file references that exist", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenFile = vi.fn();
  await act(async () =>
    root.render(
      createElement(AgentMarkdown, {
        text: "Rendered `40-users-teleport.xml` from `vars/vault.yml`.",
        cwd: "/home/me/infra",
        onOpenFile,
      }),
    ),
  );
  const codes = [...container.querySelectorAll("code")];
  const missing = codes.find((code) =>
    code.textContent?.includes("40-users-teleport.xml"),
  )!;
  const present = codes.find((code) =>
    code.textContent?.includes("vault.yml"),
  )!;
  expect(missing.getAttribute("role")).toBeNull();
  expect(missing.querySelector("svg, img")).toBeNull();
  expect(present.getAttribute("role")).toBe("link");
  await act(async () => missing.click());
  expect(onOpenFile).not.toHaveBeenCalled();
  await act(async () => present.click());
  expect(onOpenFile).toHaveBeenCalledWith(
    "/home/me/infra/vars/vault.yml",
    undefined,
  );
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
