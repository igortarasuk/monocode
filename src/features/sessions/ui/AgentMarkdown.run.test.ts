// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
import { RUN_IN_TERMINAL_EVENT } from "../../terminal/model/runInTerminal";

let container: HTMLDivElement;
const runs: unknown[] = [];
const onRun = (event: Event) => runs.push((event as CustomEvent).detail);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  runs.length = 0;
  window.addEventListener(RUN_IN_TERMINAL_EVENT, onRun);
});

afterEach(() => {
  window.removeEventListener(RUN_IN_TERMINAL_EVENT, onRun);
  container.remove();
  vi.unstubAllGlobals();
});

async function render(text: string) {
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(AgentMarkdown, { text, cwd: "/home/me/app" })),
  );
  return root;
}

it("runs shell blocks in a terminal", async () => {
  const root = await render(
    "Try:\n\n```bash\n$ docker ps\n$ docker images\n```\n",
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Run in terminal"]',
  );
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0].click());
  expect(runs).toEqual([
    { command: "docker ps\ndocker images", cwd: "/home/me/app" },
  ]);
  act(() => root.unmount());
});

it("offers Run for inline ! commands but not for other code", async () => {
  const root = await render(
    "Type `! gcloud auth login` here. Python:\n\n```python\nprint(1)\n```\n",
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Run in terminal"]',
  );
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0].click());
  expect(runs).toEqual([{ command: "gcloud auth login", cwd: "/home/me/app" }]);
  act(() => root.unmount());
});

it("offers Run for an untagged block of ! commands", async () => {
  const root = await render(
    "Vault password:\n\n```\n! echo 'password' > ~/.vault-pass\n```\n\nConfig:\n\n```\nkey = !value\n```\n",
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Run in terminal"]',
  );
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0].click());
  expect(runs).toEqual([
    { command: "echo 'password' > ~/.vault-pass", cwd: "/home/me/app" },
  ]);
  act(() => root.unmount());
});
