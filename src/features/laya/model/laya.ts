import { invoke } from "@tauri-apps/api/core";

export type LayaStatus = {
  configured: boolean;
  enabled: boolean;
  gpu: boolean;
  cliPath: string;
  running: boolean;
  device: string;
  qdrant: boolean;
  domains: string[];
};

export type LayaExample = {
  text: string;
  score?: number;
  source?: string;
  project?: string;
  note?: string;
};

export type LayaFlag = {
  rule: string;
  p: number;
  threshold?: number;
  by?: string;
  nudge: string;
  example: LayaExample | null;
};

export type LayaChunk = {
  line: number;
  kind?: string;
  flagged: LayaFlag[];
  level?: string;
  levelP?: number;
};

export type LayaClassifyResult = {
  domain: string;
  chunks: LayaChunk[];
  ms?: number;
};

export type LayaAnswer = {
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
};

export type LayaAnswers = Record<string, LayaAnswer>;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function parseExample(value: unknown): LayaExample | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = str(item.text);
  if (!text) return null;
  return {
    text,
    ...(num(item.score) !== undefined ? { score: num(item.score) } : {}),
    ...(str(item.source) ? { source: str(item.source) } : {}),
    ...(str(item.project) ? { project: str(item.project) } : {}),
    ...(str(item.note) ? { note: str(item.note) } : {}),
  };
}

/** `POST /classify/<domain>`; tolerant of missing optional keys. */
export function parseClassifyResult(value: unknown): LayaClassifyResult {
  const root = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const chunks = Array.isArray(root.chunks) ? root.chunks : [];
  return {
    domain: str(root.domain) ?? "",
    ...(num(root.ms) !== undefined ? { ms: num(root.ms) } : {}),
    chunks: chunks.flatMap((chunk): LayaChunk[] => {
      if (!chunk || typeof chunk !== "object") return [];
      const item = chunk as Record<string, unknown>;
      const flagged = Array.isArray(item.flagged) ? item.flagged : [];
      return [
        {
          line: num(item.line) ?? 0,
          ...(str(item.kind) ? { kind: str(item.kind) } : {}),
          ...(str(item.level) ? { level: str(item.level) } : {}),
          ...(num(item.level_p) !== undefined
            ? { levelP: num(item.level_p) }
            : {}),
          flagged: flagged.flatMap((flag): LayaFlag[] => {
            if (!flag || typeof flag !== "object") return [];
            const entry = flag as Record<string, unknown>;
            const rule = str(entry.rule);
            const p = num(entry.p);
            if (!rule || p === undefined) return [];
            return [
              {
                rule,
                p,
                ...(num(entry.threshold) !== undefined
                  ? { threshold: num(entry.threshold) }
                  : {}),
                ...(str(entry.by) ? { by: str(entry.by) } : {}),
                nudge: str(entry.nudge) ?? "",
                example: parseExample(entry.example),
              },
            ];
          }),
        },
      ];
    }),
  };
}

/** `answers` of `POST /predict[/<preset>]`. */
export function parseAnswers(value: unknown): LayaAnswers {
  const root = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const answers =
    root.answers && typeof root.answers === "object"
      ? (root.answers as Record<string, unknown>)
      : {};
  const out: LayaAnswers = {};
  for (const [key, raw] of Object.entries(answers)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const probabilities =
      item.probabilities && typeof item.probabilities === "object"
        ? Object.fromEntries(
            Object.entries(item.probabilities as Record<string, unknown>)
              .map(([choice, p]) => [choice, num(p)] as const)
              .filter((entry): entry is [string, number] => entry[1] != null),
          )
        : undefined;
    out[key] = {
      ...(num(item.noul) !== undefined ? { noul: num(item.noul) } : {}),
      ...(str(item.choice) ? { choice: str(item.choice) } : {}),
      ...(probabilities ? { probabilities } : {}),
    };
  }
  return out;
}

export const layaStatus = () => invoke<LayaStatus>("laya_status");

export const setLayaConfig = (
  cliPath: string,
  gpu: boolean,
  enabled: boolean,
) => invoke<LayaStatus>("laya_set_config", { cliPath, gpu, enabled });

export const startLaya = () => invoke<LayaStatus>("laya_start");

export const stopLaya = () => invoke<void>("laya_stop");

export const layaDomains = () => invoke<string[]>("laya_domains");

/** Presets defined by the sandbox, each with its answer keys. */
export async function layaPresets(): Promise<Record<string, string[]>> {
  const value = await invoke<{ presets?: Record<string, unknown> }>(
    "laya_presets",
  );
  return Object.fromEntries(
    Object.entries(value.presets ?? {}).map(([name, keys]) => [
      name,
      Array.isArray(keys)
        ? keys.filter((key): key is string => typeof key === "string")
        : [],
    ]),
  );
}

export async function layaClassify(
  domain: string,
  text: string,
): Promise<LayaClassifyResult> {
  return parseClassifyResult(
    await invoke<unknown>("laya_classify", { domain, text }),
  );
}

export async function layaPredict(
  input: { preset: string } | { questions: Record<string, unknown> },
  text: string,
): Promise<LayaAnswers> {
  return parseAnswers(
    await invoke<unknown>("laya_predict", {
      preset: "preset" in input ? input.preset : null,
      questions: "questions" in input ? input.questions : null,
      text,
    }),
  );
}

export type LayaCorrection = {
  bad: string;
  good: string;
  rules: string[];
  note?: string;
};

export const layaLearn = (domain: string, payload: LayaCorrection | object) =>
  invoke<Record<string, unknown>>("laya_learn", { domain, payload });

export const layaTrain = (domain: string, exclude: string[] = []) =>
  invoke<Record<string, unknown>>("laya_train", { domain, exclude });

export type LayaRule = {
  nudge?: string;
  question?: string;
  scope?: string[];
  threshold?: number;
  max_fpr?: number;
};

export type LayaDomain = {
  name: string;
  description?: string;
  levels?: string[];
  rules: Record<string, LayaRule>;
};

export const layaDomain = (domain: string) =>
  invoke<LayaDomain>("laya_domain", { domain });

export type LayaStats = {
  name: string;
  sources: Record<string, number>;
  total: number;
  trained_at: number | null;
  heads: string[];
};

export const layaStats = (domain: string) =>
  invoke<LayaStats>("laya_stats", { domain });

/** Short status line for Settings. */
export function layaStatusLine(status: LayaStatus): string {
  if (!status.configured) return "Not configured";
  if (!status.running) return "Stopped";
  const parts = [`Running on ${status.device || "unknown device"}`];
  parts.push(status.qdrant ? "Qdrant ok" : "no Qdrant");
  if (status.domains.length)
    parts.push(`domains: ${status.domains.join(", ")}`);
  return parts.join(" · ");
}
