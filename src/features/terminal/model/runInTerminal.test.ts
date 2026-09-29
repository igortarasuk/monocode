import { describe, expect, it } from "vitest";
import {
  bangCommand,
  isShellLanguage,
  queueTerminalInput,
  shellCommandFromCode,
  takeTerminalInput,
} from "./runInTerminal";

describe("run in terminal", () => {
  it("reads ! commands from the composer", () => {
    expect(bangCommand("! gcloud auth login")).toBe("gcloud auth login");
    expect(bangCommand("  !ls -la  ")).toBe("ls -la");
    expect(bangCommand("!")).toBeNull();
    expect(bangCommand("!! not a command")).toBeNull();
    expect(bangCommand("please run ! ls")).toBeNull();
  });

  it("extracts commands from shell blocks", () => {
    expect(shellCommandFromCode("npm ci\nnpm test\n")).toBe("npm ci\nnpm test");
    expect(
      shellCommandFromCode("$ docker ps\nCONTAINER ID  IMAGE\n$ docker images"),
    ).toBe("docker ps\ndocker images");
    expect(shellCommandFromCode("! tsh login --proxy=tp.example.com")).toBe(
      "tsh login --proxy=tp.example.com",
    );
    expect(isShellLanguage("Bash")).toBe(true);
    expect(isShellLanguage("python")).toBe(false);
  });

  it("hands queued input to the terminal once", () => {
    queueTerminalInput("t1", "ls");
    expect(takeTerminalInput("t1")).toBe("ls\r");
    expect(takeTerminalInput("t1")).toBeUndefined();
  });
});

describe("done reports", async () => {
  const { wrapWithDoneReport, scanCommandDone, doneReportMessage } =
    await import("./runInTerminal");

  it("wraps the command in a group that reports its exit status", () => {
    expect(wrapWithDoneReport("tsh login", "t-1")).toBe(
      "{ tsh login\n}; printf '\\033]777;monocode-done;%s;%d\\007' t-1 $?",
    );
  });

  it("finds reports split across chunks", () => {
    const first = scanCommandDone("output\x1b]777;monocode-do", "");
    expect(first.done).toEqual([]);
    const second = scanCommandDone("ne;t-1;130\x07prompt$ ", first.rest);
    expect(second.done).toEqual([{ token: "t-1", code: 130 }]);
    expect(second.rest).toBe("prompt$ ");
  });

  it("reports the command and status without output", () => {
    expect(doneReportMessage("tsh login", 0)).toBe(
      "I ran `tsh login` in the terminal: done (exit 0). Output was not shared.",
    );
    expect(doneReportMessage("a\nb", 1)).toBe(
      "I ran\n```sh\na\nb\n```\nin the terminal: failed (exit 1). Output was not shared.",
    );
  });
});
