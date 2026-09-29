/**
 * Commands typed as `! cmd` in the composer, or run from a shell code block in
 * a reply, go to a real terminal so interactive prompts (logins, sudo) work.
 */

export const RUN_IN_TERMINAL_EVENT = "monocode:run-in-terminal";

export type RunInTerminalRequest = { command: string; cwd?: string };

const pending = new Map<string, string>();

/** Text a terminal writes to its shell once it has started. */
export function queueTerminalInput(terminalId: string, command: string) {
  pending.set(terminalId, command.endsWith("\r") ? command : `${command}\r`);
}

export function takeTerminalInput(terminalId: string): string | undefined {
  const input = pending.get(terminalId);
  pending.delete(terminalId);
  return input;
}

export function requestRunInTerminal(command: string, cwd?: string) {
  window.dispatchEvent(
    new CustomEvent<RunInTerminalRequest>(RUN_IN_TERMINAL_EVENT, {
      detail: { command, ...(cwd ? { cwd } : {}) },
    }),
  );
}

/** `! git status` → `git status`; anything else → null. */
export function bangCommand(text: string): string | null {
  const match = /^\s*!(?!!)\s*([\s\S]*\S)\s*$/.exec(text);
  return match ? match[1] : null;
}

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "shellsession",
  "terminal",
]);

export function isShellLanguage(language: string | undefined): boolean {
  return SHELL_LANGUAGES.has((language ?? "").trim().toLowerCase());
}

/**
 * Commands from a shell block: prompt markers (`$ `, `! `) are removed, and
 * in a console transcript only the prompted lines are commands.
 */
export function shellCommandFromCode(code: string): string {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const prompted = lines.filter((line) => /^\s*[$!]\s/.test(line));
  const commands = prompted.length
    ? prompted.map((line) => line.replace(/^\s*[$!]\s+/, ""))
    : lines;
  return commands.filter((line) => line.trim()).join("\n");
}
