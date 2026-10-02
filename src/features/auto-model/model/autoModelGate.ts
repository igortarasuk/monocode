import {
  canRunHarnessTextPrompt,
  cancelHarnessTurn,
  isLiveHarness,
  respondHarnessApproval,
  respondHarnessQuestion,
  runHarnessTextPrompt,
  sendHarnessTurn,
} from "../../../integrations/harness/core/registry";
import { mergeStream } from "../../../integrations/harness/core/streamText";
import { pickTextHarness } from "../../../integrations/harness/core/textHarness";
import {
  buildDeterministicHandoff,
  buildHandoffComposerCard,
  type HandoffComposerCard,
} from "../../sessions/model/handoff";
import type { AgentModel } from "../../sessions/model/models";
import type { Attachment, Session } from "../../sessions/model/session";
import {
  autoModelStage,
  buildRecapPrompt,
  buildReviewPrompt,
  buildRoutePrompt,
  candidateModels,
  firstUserRequest,
  parseRecap,
  parseRoute,
  parseVerdict,
  routeModelSettings,
  type ProjectMeta,
  type Route,
} from "./autoModel";
import {
  autoModelActivity,
  isAutoModel,
  loadProjectMeta,
  loadSessionTask,
  markAutoSession,
  rememberProjectFacts,
  saveSessionTask,
  setAutoModelActivity,
  setAutoModelPick,
} from "./autoModelStore";

const ROUTE_TIMEOUT_MS = 20_000;
const RECAP_TIMEOUT_MS = 45_000;

/** Submit options the gate reads or sets; a subset of the app's own. */
export type AutoModelSubmitOptions = {
  /** Set by the gate on the send that follows its own check. */
  autoModelReady?: boolean;
  handoffCard?: HandoffComposerCard;
  managed?: boolean;
  remoteTurn?: boolean;
  queuedMessageId?: string;
  resendEdited?: boolean;
  ciRepair?: unknown;
  appRequestId?: string;
  intent?: string;
};

export type AutoModelDeps<Options extends AutoModelSubmitOptions> = {
  getSession(sessionId: string): Session | undefined;
  /** Switch a session to the routed model before its turn starts. */
  applyRoute(
    sessionId: string,
    model: AgentModel,
    modelSettings: Record<string, string>,
  ): void;
  /** Open a fresh session next to `source` and return its id. */
  openSession(
    source: Session,
    model: AgentModel,
    modelSettings: Record<string, string>,
  ): string;
  submit(
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options: Options,
  ): unknown;
  /** Show a line in the session's transcript. */
  notify(sessionId: string, text: string): void;
};

function skipped(options: AutoModelSubmitOptions | undefined): boolean {
  if (!options) return false;
  return !!(
    options.autoModelReady ||
    options.managed ||
    options.remoteTurn ||
    options.queuedMessageId ||
    options.resendEdited ||
    options.ciRepair ||
    options.appRequestId ||
    options.handoffCard ||
    (options.intent && options.intent !== "default" && options.intent !== "plan")
  );
}

async function askRouter(session: Session, prompt: string): Promise<string> {
  const harness = canRunHarnessTextPrompt(session.harness)
    ? session.harness
    : pickTextHarness(session.harness);
  return runHarnessTextPrompt({
    harness,
    cwd: session.cwd,
    ...(harness === session.harness && session.providerAccountId
      ? { providerAccountId: session.providerAccountId }
      : {}),
    prompt,
    timeoutMs: ROUTE_TIMEOUT_MS,
  });
}

function projectMeta(cwd: string): Promise<ProjectMeta | null> {
  return loadProjectMeta(cwd).catch(() => null);
}

function recordRoute(session: Session, route: Route, parent?: string) {
  setAutoModelPick(session.id, {
    model: route.model.name,
    kind: route.kind,
    scale: route.scale,
    ...(route.effort ? { effort: route.effort } : {}),
    reason: route.reason,
  });
  void saveSessionTask({
    sessionId: session.id,
    cwd: session.cwd,
    harness: session.harness,
    model: route.model.id,
    kind: route.kind,
    scale: route.scale,
    effort: route.effort ?? "",
    summary: route.summary,
    reason: route.reason,
    ...(parent ? { parentSessionId: parent } : {}),
  }).catch(() => undefined);
}

/**
 * Ask the session's own agent for a recap and for facts worth keeping. It
 * still has the whole conversation cached, so this is one cheap turn.
 */
async function requestRecap(session: Session, nextRequest: string) {
  let output = "";
  const timer = setTimeout(() => {
    void cancelHarnessTurn(session.harness, session.id);
  }, RECAP_TIMEOUT_MS);
  try {
    await sendHarnessTurn({
      harness: session.harness,
      sessionId: session.id,
      cwd: session.worktreeCwd ?? session.cwd,
      model: session.model,
      modelSettings: session.modelSettings,
      providerAccountId: session.providerAccountId,
      runtimeMode: "supervised",
      text: buildRecapPrompt(nextRequest),
      onEvent: (event) => {
        if (event.type === "message.delta") {
          output = mergeStream(output, event.text);
        }
        if (event.type === "approval.requested") {
          respondHarnessApproval(
            session.harness,
            session.id,
            event.requestId,
            "deny",
          );
        }
        if (event.type === "question.asked") {
          respondHarnessQuestion(session.harness, session.id, event.requestId, {
            kind: "skipped",
          });
        }
      },
    });
  } catch {
    // The deterministic recap below covers a failed or cancelled turn.
  } finally {
    clearTimeout(timer);
  }
  return parseRecap(output);
}

/** Let React commit a session change before the send that depends on it. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createAutoModelGate<Options extends AutoModelSubmitOptions>(
  deps: () => AutoModelDeps<Options>,
) {
  const send = (
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options: Options | undefined,
    extra?: Partial<AutoModelSubmitOptions>,
  ) =>
    deps().submit(sessionId, text, attachments, {
      ...(options ?? {}),
      ...extra,
      autoModelReady: true,
    } as Options);

  async function route(
    session: Session,
    text: string,
    attachments: Attachment[],
    options: Options | undefined,
  ) {
    try {
      const models = candidateModels(session.harness, session.model);
      if (models.length > 1) {
        const meta = await projectMeta(session.cwd);
        const output = await askRouter(
          session,
          buildRoutePrompt({ meta, models, task: text }),
        );
        const picked = parseRoute(output, models, text);
        const current = deps().getSession(session.id);
        // A model picked by hand while routing ran wins.
        if (picked && current && isAutoModel(session.id)) {
          deps().applyRoute(
            session.id,
            picked.model,
            routeModelSettings(picked, current.modelSettings),
          );
          recordRoute(current, picked);
          await nextTick();
        }
      }
    } catch {
      // Routing is best effort: the message goes out on the current model.
    } finally {
      setAutoModelActivity(session.id, null);
    }
    send(session.id, text, attachments, options);
  }

  async function review(
    session: Session,
    text: string,
    attachments: Attachment[],
    options: Options | undefined,
  ) {
    let moved = false;
    try {
      const models = candidateModels(session.harness, session.model);
      const [meta, task] = await Promise.all([
        projectMeta(session.cwd),
        loadSessionTask(session.id).catch(() => null),
      ]);
      const output = await askRouter(
        session,
        buildReviewPrompt({
          meta,
          models,
          originalTask: task?.summary || firstUserRequest(session),
          recent: buildDeterministicHandoff(session, text),
          message: text,
        }),
      );
      const verdict = parseVerdict(output, models, text);
      const current = deps().getSession(session.id);
      if (
        !verdict.sameTask &&
        current &&
        !current.busy &&
        isAutoModel(session.id)
      ) {
        setAutoModelActivity(session.id, "moving");
        const asked =
          current.providerSessionId && isLiveHarness(current.harness)
            ? await requestRecap(current, text)
            : { recap: "", memory: [] };
        if (asked.memory.length > 0) {
          await rememberProjectFacts(current.cwd, asked.memory).catch(
            () => undefined,
          );
        }
        const latest = deps().getSession(session.id) ?? current;
        const brief =
          asked.recap.length >= 40
            ? asked.recap
            : buildDeterministicHandoff(latest, text);
        const nextId = deps().openSession(
          latest,
          verdict.model,
          routeModelSettings(verdict, latest.modelSettings),
        );
        markAutoSession(nextId);
        recordRoute({ ...latest, id: nextId }, verdict, session.id);
        deps().notify(
          session.id,
          `Auto: this is a different task, so it continues in a new session on ${verdict.model.name}.`,
        );
        await nextTick();
        send(nextId, text, attachments, options, {
          handoffCard: buildHandoffComposerCard({
            from: latest.harness,
            to: latest.harness,
            brief,
            userRequest: text,
            files: [],
          }),
        });
        moved = true;
      }
    } catch {
      // Scope checks are best effort: the session simply continues.
    } finally {
      setAutoModelActivity(session.id, null);
    }
    if (!moved) send(session.id, text, attachments, options);
  }

  return {
    /**
     * "taken": the gate checks the task first and sends the message itself,
     * to this session or to the one it opens. "busy": a check is still
     * running, so the message must stay in the composer. null: not for Auto.
     */
    intercept(
      sessionId: string,
      text: string,
      attachments: Attachment[],
      options: Options | undefined,
    ): "taken" | "busy" | null {
      if (options?.autoModelReady) return null;
      // A message sent while a check runs would overtake the one being checked.
      if (autoModelActivity(sessionId)) return "busy";
      if (skipped(options) || !isAutoModel(sessionId)) return null;
      const session = deps().getSession(sessionId);
      if (!session) return null;
      const stage = autoModelStage(session, text);
      if (!stage) return null;
      setAutoModelActivity(
        sessionId,
        stage === "route" ? "routing" : "reviewing",
      );
      void (stage === "route" ? route : review)(
        session,
        text,
        attachments,
        options,
      );
      return "taken";
    },
  };
}
