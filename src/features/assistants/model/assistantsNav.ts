import { useSyncExternalStore } from "react";

/**
 * Assistants share the Automations view slot in the app shell, so every place
 * that closes Automations closes Assistants too. This store only tells the
 * navigation buttons which of the two is showing.
 */
export const OPEN_ASSISTANTS_EVENT = "monocode:open-assistants";

let open = false;
const listeners = new Set<() => void>();

export function setAssistantsViewShown(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantsViewShown(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  );
}

export function openAssistantsView(): void {
  window.dispatchEvent(new Event(OPEN_ASSISTANTS_EVENT));
}
