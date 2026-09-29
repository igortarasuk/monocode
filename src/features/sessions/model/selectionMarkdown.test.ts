// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentMarkdown } from "../ui/AgentMarkdown";
import { fragmentToMarkdown, selectionMarkdown } from "./selectionMarkdown";

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

async function rendered(text: string) {
  const root = createRoot(container);
  await act(async () => root.render(createElement(AgentMarkdown, { text })));
  for (let i = 0; i < 6; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  return root;
}

const SOURCE = [
  "## Plan",
  "",
  "Some **bold**, *soft* and `code` with [docs](https://example.com/docs).",
  "",
  "| Host | Status |",
  "| --- | --- |",
  "| sk12 | **ok** |",
  "| sk13 | down |",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "1. first",
  "2. second",
  "",
  "```bash",
  "ls -la",
  "echo hi",
  "```",
  "",
  "> quoted",
].join("\n");

it("turns a whole rendered reply back into markdown", async () => {
  const root = await rendered(SOURCE);
  const range = document.createRange();
  range.selectNodeContents(container);
  expect(selectionMarkdown(range)).toBe(SOURCE);
  act(() => root.unmount());
});

it("keeps a partial table selection as one table", async () => {
  const root = await rendered(SOURCE);
  const rows = container.querySelectorAll("tr");
  const range = document.createRange();
  range.setStartBefore(rows[1]);
  range.setEndAfter(rows[2]);
  expect(selectionMarkdown(range)).toBe(
    "| sk12 | **ok** |\n| --- | --- |\n| sk13 | down |",
  );
  act(() => root.unmount());
});

it("converts plain fragments and skips buttons", () => {
  const div = document.createElement("div");
  div.innerHTML = "<p>Hello <button>Copy</button>world</p>";
  expect(fragmentToMarkdown(div)).toBe("Hello world");
});
