import type { HarnessId } from "../../../features/sessions/model/session";

/**
 * A turn someone started from outside the app, such as a message sent through
 * Claude's Remote Control from a phone. The app opens a turn for it and joins
 * the provider's run with `sendTurn({ remoteTurn: true })`.
 */
export type RemoteTurn = {
  harness: HarnessId;
  sessionId: string;
  text: string;
};

type Listener = (turn: RemoteTurn) => void;

let listener: Listener | null = null;

/** The app subscribes once; a later subscriber replaces the earlier one. */
export function onRemoteTurn(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** False when nothing in the app can show the turn. */
export function announceRemoteTurn(turn: RemoteTurn): boolean {
  if (!listener) return false;
  listener(turn);
  return true;
}
