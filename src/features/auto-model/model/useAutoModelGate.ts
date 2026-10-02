import { useRef } from "react";
import {
  createAutoModelGate,
  type AutoModelDeps,
  type AutoModelSubmitOptions,
} from "./autoModelGate";

/** Stable gate whose callbacks always see the latest app state. */
export function useAutoModelGate<Options extends AutoModelSubmitOptions>(
  deps: AutoModelDeps<Options>,
) {
  const latest = useRef(deps);
  latest.current = deps;
  const gate = useRef<ReturnType<typeof createAutoModelGate<Options>>>(null);
  gate.current ??= createAutoModelGate<Options>(() => latest.current);
  return gate.current;
}
