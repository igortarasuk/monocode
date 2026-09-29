// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { TeleportPicker } from "./TeleportPicker";

const profile = {
  proxy: "tp.example.com:443",
  cluster: "tp.example.com",
  username: "alice",
  logins: ["ops", "root"],
  validUntil: "2999-01-01T00:00:00Z",
  active: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(status: unknown, onPick = vi.fn()) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "teleport_status") return status;
    if (command === "teleport_nodes")
      return [
        {
          hostname: "a1.example.com",
          id: "1",
          labels: [["visible_name", "a1"]],
        },
        { hostname: "db2.example.com", id: "2", labels: [] },
      ];
    return null;
  });
  await act(async () => {
    root.render(
      createElement(TeleportPicker, {
        disabled: false,
        selected: null,
        onPick,
        onClear: vi.fn(),
      }),
    );
  });
  await act(async () => {});
  return onPick;
}

it("stays hidden without tsh profiles", async () => {
  await render({ installed: false, profiles: [] });
  expect(container.textContent).toBe("");
});

it("fills the SSH target and route from a picked node", async () => {
  const onPick = await render({ installed: true, profiles: [profile] });
  expect(invoke).toHaveBeenCalledWith("teleport_nodes", {
    proxy: "tp.example.com:443",
    cluster: "tp.example.com",
  });
  const login = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Teleport login"]',
  )!;
  await act(async () => {
    login.value = "root";
    login.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const node = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("db2.example.com"),
  )!;
  await act(async () => node.click());
  expect(onPick).toHaveBeenCalledWith({
    route: { proxy: "tp.example.com:443", cluster: "tp.example.com" },
    target: "root@db2.example.com",
    name: "db2",
  });
});

it("asks for tsh login when the certificate expired", async () => {
  await render({
    installed: true,
    profiles: [{ ...profile, validUntil: "2000-01-01T00:00:00Z" }],
  });
  expect(container.textContent).toContain(
    "tsh login --proxy=tp.example.com:443",
  );
  expect(invoke).not.toHaveBeenCalledWith("teleport_nodes", expect.anything());
});
