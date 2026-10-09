import { describe, expect, it } from "vitest";
import { endsWithQuestion, turnAsksQuestion } from "./quickReply";

describe("quick reply", () => {
  it("offers answers when the reply closes with a question", () => {
    expect(endsWithQuestion("Done.\n\nShould I continue with the deploy?")).toBe(
      true,
    );
    expect(endsWithQuestion("Готово.\n\nПродовжити? Якщо так, запущу міграцію.")).toBe(
      true,
    );
    expect(endsWithQuestion("Why did it fail? The token expired.\n\nFixed.")).toBe(
      false,
    );
    expect(endsWithQuestion("Use `a ? b : c` here.")).toBe(false);
    expect(endsWithQuestion("Run:\n\n```sh\ncurl 'x?y=1'\n```")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
  });

  it("reads the last assistant reply of a turn", () => {
    expect(
      turnAsksQuestion([
        { id: "u", role: "user", text: "Deploy?" },
        { id: "a", role: "assistant", text: "Ready. Approve the rollout?" },
        { id: "t", role: "tool", text: "ls" },
      ]),
    ).toBe(true);
    expect(
      turnAsksQuestion([{ id: "u", role: "user", text: "Deploy?" }]),
    ).toBe(false);
  });
});
