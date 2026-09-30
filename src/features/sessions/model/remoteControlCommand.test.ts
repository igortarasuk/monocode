import { describe, expect, it } from "vitest";
import { parseRemoteControlCommand } from "./remoteControlCommand";

describe("parseRemoteControlCommand", () => {
  it("reads the standalone command and its mode", () => {
    expect(parseRemoteControlCommand("/rc")).toBe("toggle");
    expect(parseRemoteControlCommand(" /rc on ")).toBe("on");
    expect(parseRemoteControlCommand("/RC off")).toBe("off");
    expect(parseRemoteControlCommand("/remote-control")).toBe("toggle");
  });

  it("leaves ordinary prompts alone", () => {
    expect(parseRemoteControlCommand("/rc please")).toBeNull();
    expect(parseRemoteControlCommand("use /rc")).toBeNull();
    expect(parseRemoteControlCommand("/rcx")).toBeNull();
  });
});
