// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TodoCheckboxes } from "./TodoCheckboxes";

it("maps a clicked checkbox to its line in the body", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onToggle = vi.fn();
  const box = (checked: boolean) =>
    createElement("input", {
      type: "checkbox",
      disabled: true,
      checked,
      readOnly: true,
    });
  await act(async () =>
    root.render(
      createElement(
        TodoCheckboxes,
        { body: "Intro\n- [ ] first\n\n- [x] second", onToggle },
        createElement(
          "ul",
          null,
          createElement("li", null, box(false)),
          createElement("li", null, box(true)),
        ),
      ),
    ),
  );
  const boxes = container.querySelectorAll<HTMLInputElement>("input");
  expect(boxes[1].disabled).toBe(false);
  await act(async () => boxes[1].click());
  expect(onToggle).toHaveBeenCalledWith(3);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
