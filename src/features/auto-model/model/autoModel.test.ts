import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../../sessions/model/models";
import type { Attachment, Session } from "../../sessions/model/session";

const registry = vi.hoisted(() => ({
  runHarnessTextPrompt: vi.fn<(input: { prompt: string }) => Promise<string>>(),
  sendHarnessTurn: vi.fn(),
}));
const backend = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("../../../integrations/harness/core/registry", () => ({
  canRunHarnessTextPrompt: () => true,
  cancelHarnessTurn: vi.fn(),
  isLiveHarness: () => true,
  respondHarnessApproval: vi.fn(),
  respondHarnessQuestion: vi.fn(),
  runHarnessTextPrompt: registry.runHarnessTextPrompt,
  sendHarnessTurn: registry.sendHarnessTurn,
}));
vi.mock("../../../integrations/harness/core/textHarness", () => ({
  pickTextHarness: (preferred: string) => preferred,
}));

import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../sessions/model/models";
import {
  autoModelStage,
  buildRoutePrompt,
  candidateModels,
  parseRecap,
  parseRoute,
  parseVerdict,
  routeModelSettings,
  type ProjectMeta,
} from "./autoModel";
import { createAutoModelGate, type AutoModelDeps } from "./autoModelGate";
import { withProjectKnowledge } from "./projectKnowledge";
import {
  autoModelPick,
  isAutoModel,
  pinSessionModel,
  setAutoModel,
} from "./autoModelStore";

function effort(values: string[]) {
  return {
    id: "effort",
    label: "Reasoning",
    kind: "select" as const,
    value: values[0],
    options: values.map((value) => ({ value, label: value })),
  };
}

const large: AgentModel = {
  id: "claude:large",
  harness: "claude",
  name: "Large",
  settings: [effort(["medium", "high", "max"])],
};
const mid: AgentModel = {
  id: "claude:mid",
  harness: "claude",
  name: "Mid",
  settings: [effort(["low", "medium", "high"])],
};
const small: AgentModel = {
  id: "claude:small",
  harness: "claude",
  name: "Small",
};
const models = [large, mid, small];

const meta: ProjectMeta = {
  profile: {
    languages: [
      { name: "Go", files: 120 },
      { name: "Python", files: 14 },
    ],
    fileCount: 310,
    ci: ["GitHub Actions"],
    mcp: [".mcp.json"],
    links: ["Go workspace"],
    agentDocs: ["AGENTS.md"],
  },
  memory: [],
  stats: { sessions: 5, restarts: 1, kinds: { code: 4, doc: 1 } },
  classifierSkill: null,
};

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    harness: "claude",
    model: large.id,
    modelSettings: { effort: "high" },
    runtimeMode: "supervised",
    title: "claude",
    cwd: "/work/acme",
    blocks: [],
    ...patch,
  };
}

function user(text: string) {
  return { id: crypto.randomUUID(), role: "user" as const, text };
}

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
    configurable: true,
  });
}

beforeEach(() => {
  mockLocalStorage();
  resetHarnessModelOverlays();
  setHarnessModels("claude", models);
  registry.runHarnessTextPrompt.mockReset();
  registry.sendHarnessTurn.mockReset();
  backend.invoke.mockReset();
  backend.invoke.mockImplementation(async (command) =>
    command === "auto_model_project" ? meta : null,
  );
});

describe("stage", () => {
  it("routes the first message and leaves commands alone", () => {
    expect(autoModelStage(session(), "Fix the login redirect")).toBe("route");
    expect(autoModelStage(session(), "/compact")).toBeNull();
    expect(autoModelStage(session(), "! make test")).toBeNull();
    expect(autoModelStage(session({ cwd: "~" }), "hello")).toBeNull();
    expect(autoModelStage(session({ busy: true }), "hello")).toBeNull();
  });

  it("reviews follow-ups only once half the context is used", () => {
    const started = { blocks: [user("Fix the login redirect")] };
    expect(
      autoModelStage(
        session({ ...started, context: { used: 80_000, window: 200_000 } }),
        "now the tests",
      ),
    ).toBeNull();
    expect(
      autoModelStage(
        session({ ...started, context: { used: 100_000, window: 200_000 } }),
        "now the tests",
      ),
    ).toBe("review");
    // No window reported: nothing to measure against.
    expect(
      autoModelStage(
        session({ ...started, context: { used: 500_000 } }),
        "now the tests",
      ),
    ).toBeNull();
  });
});

describe("router prompt and replies", () => {
  it("describes the project and numbers the provider's models", () => {
    const prompt = buildRoutePrompt({ meta, models, task: "Add retries" });
    expect(prompt).toContain("Languages: Go (120 files), Python (14 files)");
    expect(prompt).toContain("CI/CD: GitHub Actions");
    expect(prompt).toContain("code 4, doc 1; restarted for a new task: 1");
    expect(prompt).toContain("2. Mid — efforts: low, medium, high");
    expect(prompt).toContain("3. Small\n");
  });

  it("uses the project's own routing skill when it has one", () => {
    const prompt = buildRoutePrompt({
      meta: {
        ...meta,
        classifierSkill:
          "---\nname: auto-model\n---\nAlways send migrations to model 1.",
      },
      models,
      task: "Add retries",
    });
    expect(prompt).toContain("Rules:\nAlways send migrations to model 1.");
    expect(prompt).not.toContain("name: auto-model");
  });

  it("reads a route and drops an effort the model does not offer", () => {
    const route = parseRoute(
      'Sure:\n{"kind":"Troubleshoot","scale":"small","model":2,"effort":"max","summary":"Fix login","reason":"scoped"}',
      models,
      "Fix the login redirect",
    );
    expect(route).toMatchObject({
      kind: "troubleshoot",
      scale: "small",
      model: mid,
      summary: "Fix login",
    });
    expect(route?.effort).toBeUndefined();
    expect(parseRoute('{"model": 9}', models, "x")).toBeNull();
    expect(parseRoute("no json here", models, "x")).toBeNull();
  });

  it("applies the chosen effort over the current settings", () => {
    expect(
      routeModelSettings({ model: mid, effort: "low" }, { effort: "high" }),
    ).toEqual({ effort: "low" });
    expect(routeModelSettings({ model: small, effort: "low" }, {})).toEqual({});
  });

  it("keeps the session unless the reply clearly names a different task", () => {
    expect(parseVerdict("garbage", models, "x")).toEqual({ sameTask: true });
    expect(parseVerdict('{"same_task": true}', models, "x")).toEqual({
      sameTask: true,
    });
    expect(parseVerdict('{"same_task": false}', models, "x")).toEqual({
      sameTask: true,
    });
    expect(
      parseVerdict(
        '{"same_task": false, "kind": "doc", "scale": "small", "model": 3}',
        models,
        "Write the README",
      ),
    ).toMatchObject({ sameTask: false, model: small, kind: "doc" });
  });

  it("splits a recap from the memory bullets", () => {
    expect(
      parseRecap(
        "## Recap\nFixed the redirect in auth.go.\n\n## Project memory\n- Tests run with `make test`\n- none\n* Staging deploys from main\n\n## Changes\n- Teleport upgraded to 18.2 on the bastion",
      ),
    ).toEqual({
      recap: "Fixed the redirect in auth.go.",
      memory: ["Tests run with `make test`", "Staging deploys from main"],
      changes: ["Teleport upgraded to 18.2 on the bastion"],
    });
    expect(parseRecap("Just text")).toEqual({
      recap: "Just text",
      memory: [],
      changes: [],
    });
  });

  it("narrows a long catalog to the current model's provider", () => {
    const many: AgentModel[] = Array.from({ length: 30 }, (_, index) => ({
      id: `opencode:m${index}`,
      harness: "opencode",
      name: `M${index}`,
      provider:
        index < 4
          ? { id: "acme", name: "Acme" }
          : { id: "other", name: "Other" },
    }));
    setHarnessModels("opencode", many);
    expect(
      candidateModels("opencode", "opencode:m1").map((model) => model.id),
    ).toEqual(["opencode:m0", "opencode:m1", "opencode:m2", "opencode:m3"]);
  });
});

describe("project knowledge pointer", () => {
  it("is added to the first prompt of a mounted project only", async () => {
    backend.invoke.mockImplementation(async (command, args) =>
      command === "project_knowledge_sync"
        ? {
            mounted: (args as { create: boolean }).create,
            infra: [],
            changes: 0,
          }
        : null,
    );
    const input = { cwd: "/work/acme", sessionId: "s1", firstTurn: true };
    // Auto is off and nothing is mounted yet: the prompt is untouched.
    expect(await withProjectKnowledge("Fix login", input)).toBe("Fix login");
    setAutoModel("s1", true);
    const prompt = await withProjectKnowledge("Fix login", input);
    expect(prompt.startsWith("Fix login\n\n<project_knowledge>")).toBe(true);
    expect(prompt).toContain(".monochrome/README.md");
    expect(
      await withProjectKnowledge("more", { ...input, firstTurn: false }),
    ).toBe("more");
    backend.invoke.mockRejectedValue(new Error("no backend"));
    expect(await withProjectKnowledge("Fix login", input)).toBe("Fix login");
  });

  it("asks for the same link in the session's worktree", async () => {
    backend.invoke.mockResolvedValue({ mounted: true, infra: [], changes: 0 });
    const input = { cwd: "/work/acme", sessionId: "s1", firstTurn: true };
    await withProjectKnowledge("Fix login", {
      ...input,
      workCwd: "/work/acme-worktrees/mc-1",
    });
    expect(backend.invoke).toHaveBeenLastCalledWith("project_knowledge_sync", {
      cwd: "/work/acme",
      create: false,
      workCwd: "/work/acme-worktrees/mc-1",
    });
    // A session in the main checkout has no separate folder to link.
    await withProjectKnowledge("Fix login", {
      ...input,
      workCwd: "/work/acme",
    });
    expect(backend.invoke).toHaveBeenLastCalledWith("project_knowledge_sync", {
      cwd: "/work/acme",
      create: false,
      workCwd: null,
    });
  });
});

describe("auto switch", () => {
  it("follows the last toggle and stops for a hand-picked model", () => {
    expect(isAutoModel("s1")).toBe(false);
    setAutoModel("s1", true);
    expect(isAutoModel("s1")).toBe(true);
    expect(isAutoModel("s2")).toBe(true);
    pinSessionModel("s2");
    expect(isAutoModel("s2")).toBe(false);
    expect(isAutoModel("s3")).toBe(true);
    setAutoModel("s1", false);
    expect(isAutoModel("s3")).toBe(false);
  });
});

describe("gate", () => {
  function setup(initial: Session) {
    const sessions = new Map<string, Session>([[initial.id, initial]]);
    const sent: { sessionId: string; text: string; options: unknown }[] = [];
    const notes: string[] = [];
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const deps: AutoModelDeps<Record<string, unknown>> = {
      getSession: (id) => sessions.get(id),
      applyRoute: (id, model, modelSettings) => {
        const current = sessions.get(id);
        if (current)
          sessions.set(id, { ...current, model: model.id, modelSettings });
      },
      openSession: (source, model, modelSettings) => {
        const next = session({
          id: "s2",
          cwd: source.cwd,
          model: model.id,
          modelSettings,
        });
        sessions.set(next.id, next);
        return next.id;
      },
      submit: (sessionId, text, _attachments: Attachment[], options) => {
        sent.push({ sessionId, text, options });
        settle();
      },
      notify: (_id, text) => void notes.push(text),
    };
    return {
      gate: createAutoModelGate(() => deps),
      sessions,
      sent,
      notes,
      done,
    };
  }

  it("stays out of the way when Auto is off", () => {
    const { gate } = setup(session());
    expect(gate.intercept("s1", "Fix login", [], undefined)).toBeNull();
    expect(registry.runHarnessTextPrompt).not.toHaveBeenCalled();
  });

  it("routes the first message, then sends it on the picked model", async () => {
    setAutoModel("s1", true);
    registry.runHarnessTextPrompt.mockResolvedValue(
      '{"kind":"code","scale":"small","model":2,"effort":"low","summary":"Fix login","reason":"scoped fix"}',
    );
    const { gate, sessions, sent, done } = setup(session());

    expect(gate.intercept("s1", "Fix login", [], undefined)).toBe("taken");
    // A second message waits instead of overtaking the first.
    expect(gate.intercept("s1", "and logout", [], undefined)).toBe("busy");
    await done;

    expect(sessions.get("s1")).toMatchObject({
      model: mid.id,
      modelSettings: { effort: "low" },
    });
    expect(sent).toEqual([
      { sessionId: "s1", text: "Fix login", options: { autoModelReady: true } },
    ]);
    expect(autoModelPick("s1")).toMatchObject({ model: "Mid", kind: "code" });
    expect(backend.invoke).toHaveBeenCalledWith(
      "auto_model_session_set",
      expect.objectContaining({
        task: expect.objectContaining({ sessionId: "s1", model: mid.id }),
      }),
    );
    // The follow-up send is not checked again.
    expect(
      gate.intercept("s1", "Fix login", [], { autoModelReady: true }),
    ).toBeNull();
  });

  it("sends on the current model when routing fails", async () => {
    setAutoModel("s1", true);
    registry.runHarnessTextPrompt.mockRejectedValue(new Error("timed out"));
    const { gate, sessions, sent, done } = setup(session());

    expect(gate.intercept("s1", "Fix login", [], undefined)).toBe("taken");
    await done;

    expect(sessions.get("s1")?.model).toBe(large.id);
    expect(sent).toHaveLength(1);
  });

  const long = () =>
    session({
      providerSessionId: "provider-1",
      blocks: [user("Fix the login redirect")],
      context: { used: 150_000, window: 200_000 },
    });

  it("keeps a long session when the message is the same task", async () => {
    setAutoModel("s1", true);
    registry.runHarnessTextPrompt.mockResolvedValue('{"same_task": true}');
    const { gate, sent, done } = setup(long());

    expect(
      gate.intercept("s1", "the redirect still loops", [], undefined),
    ).toBe("taken");
    await done;

    expect(sent.map((item) => item.sessionId)).toEqual(["s1"]);
    expect(registry.sendHarnessTurn).not.toHaveBeenCalled();
  });

  it("moves a different task to a new session with a recap and memory", async () => {
    setAutoModel("s1", true);
    registry.runHarnessTextPrompt.mockResolvedValue(
      '{"same_task": false, "kind":"doc","scale":"small","model":3,"effort":"","summary":"Write the README","reason":"docs"}',
    );
    registry.sendHarnessTurn.mockImplementation(
      async (input: { onEvent: (event: unknown) => void }) => {
        input.onEvent({
          type: "message.delta",
          text: "## Recap\nFixed the login redirect in auth.go; tests pass and nothing is left open.\n\n## Project memory\n- Tests run with `make test`\n\n## Changes\n- Zabbix proxy moved to eu-mon-2",
        });
      },
    );
    const { gate, sessions, sent, notes, done } = setup(long());

    expect(gate.intercept("s1", "Write the README", [], undefined)).toBe(
      "taken",
    );
    await done;

    expect(backend.invoke).toHaveBeenCalledWith("project_knowledge_record", {
      cwd: "/work/acme",
      sessionId: "s1",
      notes: ["Tests run with `make test`"],
      changes: ["Zabbix proxy moved to eu-mon-2"],
    });
    expect(sessions.get("s2")?.model).toBe(small.id);
    expect(isAutoModel("s2")).toBe(true);
    expect(notes[0]).toContain("new session on Small");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionId: "s2",
      text: "Write the README",
      options: {
        autoModelReady: true,
        handoffCard: {
          from: "claude",
          to: "claude",
          brief: expect.stringContaining("Fixed the login redirect"),
        },
      },
    });
    expect(backend.invoke).toHaveBeenCalledWith(
      "auto_model_session_set",
      expect.objectContaining({
        task: expect.objectContaining({
          sessionId: "s2",
          parentSessionId: "s1",
          kind: "doc",
        }),
      }),
    );
  });
});
