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

export const TERMINAL_COMMAND_DONE_EVENT = "monocode:terminal-command-done";

export type TerminalCommandDone = { token: string; code: number };

const DONE_OSC =
  /\u001b\]777;monocode-done;([A-Za-z0-9-]{1,64});(-?\d{1,5})(?:\u0007|\u001b\\)/g;

/**
 * Wrap a command so the shell reports its exit status when it finishes. The
 * brace group spans lines, so the shell reads everything before running it
 * and nothing is left in the input buffer for a password prompt to consume.
 * The report is an OSC sequence xterm does not display. bash and zsh only.
 */
export function wrapWithDoneReport(command: string, token: string): string {
  return `{ ${command}\n}; printf '\\033]777;monocode-done;%s;%d\\007' ${token} $?`;
}

/** Completed reports in a chunk of terminal output, plus the unparsed tail. */
export function scanCommandDone(
  chunk: string,
  buffer: string,
): { done: TerminalCommandDone[]; rest: string } {
  const merged = buffer + chunk;
  const done: TerminalCommandDone[] = [];
  let last = 0;
  for (const match of merged.matchAll(DONE_OSC)) {
    done.push({ token: match[1], code: Number(match[2]) });
    last = (match.index ?? 0) + match[0].length;
  }
  const tail = merged.slice(last);
  return { done, rest: tail.length > 256 ? tail.slice(-256) : tail };
}

/** Message for the agent: the command and its exit status, never its output. */
export function doneReportMessage(command: string, code: number): string {
  const fence = command.includes("\n")
    ? "\n```sh\n" + command + "\n```\n"
    : ` \`${command}\` `;
  return `I ran${fence}in the terminal: ${code === 0 ? "done" : `failed`} (exit ${code}). Output was not shared.`;
}
