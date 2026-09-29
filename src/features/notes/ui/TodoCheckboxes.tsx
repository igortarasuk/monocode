import { useEffect, useRef, type ReactNode } from "react";
import { todoItems } from "../model/todoNote";

/**
 * Makes the task-list checkboxes of rendered markdown clickable. The renderer
 * draws them disabled and in source order, so the n-th box maps to the n-th
 * `- [ ]` line of the body.
 */
export function TodoCheckboxes({
  body,
  onToggle,
  children,
}: {
  body: string;
  onToggle: (line: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    for (const box of checkboxes(ref.current)) {
      box.disabled = false;
      box.classList.add("cursor-pointer");
    }
  });

  return (
    <div
      ref={ref}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "checkbox")
          return;
        event.preventDefault();
        const index = checkboxes(ref.current).indexOf(target);
        const item = todoItems(body)[index];
        if (item) onToggle(item.line);
      }}
    >
      {children}
    </div>
  );
}

function checkboxes(root: HTMLElement | null): HTMLInputElement[] {
  return root
    ? [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    : [];
}
