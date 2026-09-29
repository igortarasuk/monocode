// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";

it("adds the markdown of a selection to notes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAddToNotes = vi.fn();
  await act(async () =>
    root.render(
      createElement(TranscriptSelectionMenu, {
        selection: {
          text: "Host Status sk12 ok",
          markdown: "| Host | Status |\n| --- | --- |\n| sk12 | ok |",
          rect: new DOMRect(10, 10, 20, 10),
        },
        onAddToNotes,
        onDismiss: vi.fn(),
      }),
    ),
  );
  const button = [...document.body.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Add to notes"),
  )!;
  await act(async () => button.click());
  expect(onAddToNotes).toHaveBeenCalledWith(
    "| Host | Status |\n| --- | --- |\n| sk12 | ok |",
  );
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
