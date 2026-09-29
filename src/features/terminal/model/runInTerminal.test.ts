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
