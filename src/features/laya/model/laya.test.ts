import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  layaStatusLine,
  parseAnswers,
  parseClassifyResult,
  type LayaStatus,
} from "./laya";

// Shape of `laya classify ansible` as built by server.py `classify()` and
// read by hooks/post-edit-nudge.sh. TODO: replace with a captured response
// once the Docker stack is available on this machine.
const CLASSIFY = {
  domain: "ansible",
  chunks: [
    { line: 1, kind: "tasks", flagged: [], level: "good", level_p: 0.91 },
    {
      line: 7,
      kind: "tasks",
      flagged: [
        {
          rule: "no-shell-wrapper",
          p: 0.874,
          threshold: 0.42,
          by: "head",
          nudge: "Don't use Ansible as a shell wrapper.",
          example: {
            text: "- name: Install packages\n  ansible.builtin.apt:\n    name: curl",
            score: 0.912,
            source: "user",
            project: "acme",
            note: null,
          },
        },
        {
          rule: "explicit-state",
          p: 0.61,
          threshold: 0.5,
          by: "zero-shot",
          nudge: "Set state explicitly.",
          example: null,
        },
      ],
      level: "risky",
      level_p: 0.77,
    },
  ],
  ms: 31,
};

describe("parseClassifyResult", () => {
  it("reads chunks, flags and examples", () => {
    const result = parseClassifyResult(CLASSIFY);
    expect(result.domain).toBe("ansible");
    expect(result.ms).toBe(31);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toEqual({
      line: 1,
      kind: "tasks",
      level: "good",
      levelP: 0.91,
      flagged: [],
    });
    const [shell, state] = result.chunks[1].flagged;
    expect(shell).toMatchObject({
      rule: "no-shell-wrapper",
      p: 0.874,
      by: "head",
      example: { source: "user", project: "acme", score: 0.912 },
    });
    expect(shell.example?.note).toBeUndefined();
    expect(state.example).toBeNull();
  });

  it("drops malformed entries instead of throwing", () => {
    expect(
      parseClassifyResult({
        chunks: [null, { line: 2, flagged: [{ rule: "x" }, "bad"] }],
      }),
    ).toEqual({ domain: "", chunks: [{ line: 2, flagged: [] }] });
    expect(parseClassifyResult("nope")).toEqual({ domain: "", chunks: [] });
  });
});

describe("parseAnswers", () => {
  it("reads noul and choice answers", () => {
    expect(
      parseAnswers({
        answers: {
          needs_optimization: { noul: 0.82 },
          issue: {
            choice: "missing_index",
            probabilities: { missing_index: 0.7, fine: 0.2, bad: "x" },
          },
        },
        ms: 30,
      }),
    ).toEqual({
      needs_optimization: { noul: 0.82 },
      issue: {
        choice: "missing_index",
        probabilities: { missing_index: 0.7, fine: 0.2 },
      },
    });
  });
});

describe("layaStatusLine", () => {
  const base: LayaStatus = {
    configured: true,
    enabled: true,
    gpu: true,
    cliPath: "/opt/laya",
    running: false,
    device: "",
    qdrant: false,
    domains: [],
  };

  it("describes the stack", () => {
    expect(layaStatusLine({ ...base, configured: false })).toBe(
      "Not configured",
    );
    expect(layaStatusLine(base)).toBe("Stopped");
    expect(
      layaStatusLine({
        ...base,
        running: true,
        device: "cuda:0",
        qdrant: true,
        domains: ["ansible"],
      }),
    ).toBe("Running on cuda:0 · Qdrant ok · domains: ansible");
  });
});
