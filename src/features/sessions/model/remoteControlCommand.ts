import type { BuiltinSkill } from "../../skills/model/skills";

export const REMOTE_CONTROL_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "rc",
  invocation: "rc",
  description: "Continue this Claude chat from your phone or claude.ai/code.",
  scope: "builtin",
  source: "monocode",
};

export type RemoteControlRequest = "on" | "off" | "toggle";

/** `/rc`, `/rc on|off`, or Claude's own `/remote-control` spelling. */
export function parseRemoteControlCommand(
  text: string,
): RemoteControlRequest | null {
  const match = text.match(/^\s*\/(?:rc|remote-control)(?:\s+(on|off))?\s*$/i);
  if (!match) return null;
  const mode = match[1]?.toLowerCase();
  return mode === "on" || mode === "off" ? mode : "toggle";
}
