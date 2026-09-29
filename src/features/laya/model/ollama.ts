import { invoke } from "@tauri-apps/api/core";

export type OllamaModel = {
  name: string;
  size: number;
  modifiedAt: string;
  parameterSize: string;
  quantization: string;
  contextLength: number | null;
  capabilities: string[];
};

export const ollamaList = () => invoke<OllamaModel[]>("ollama_list");
export const ollamaPull = (name: string) =>
  invoke<void>("ollama_pull", { name });
export const ollamaDelete = (name: string) =>
  invoke<void>("ollama_delete", { name });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
