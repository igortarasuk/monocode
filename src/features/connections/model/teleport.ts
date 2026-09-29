import { invoke } from "@tauri-apps/api/core";

export type TeleportRoute = { proxy: string; cluster: string };

export type TeleportProfile = TeleportRoute & {
  username: string;
  logins: string[];
  validUntil: string;
  active: boolean;
};

export type TeleportStatus = {
  installed: boolean;
  profiles: TeleportProfile[];
};

export type TeleportNode = {
  hostname: string;
  id: string;
  labels: [string, string][];
};

export const teleportStatus = () => invoke<TeleportStatus>("teleport_status");

export const teleportNodes = (route: TeleportRoute) =>
  invoke<TeleportNode[]>("teleport_nodes", { ...route });

/** A profile whose certificate has expired needs `tsh login` again. */
export function profileExpired(profile: TeleportProfile, now = Date.now()) {
  const until = Date.parse(profile.validUntil);
  return Number.isFinite(until) && until <= now;
}

/** Match hostname or any label value, e.g. a team or a short name. */
export function filterNodes(
  nodes: TeleportNode[],
  query: string,
): TeleportNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter(
    (node) =>
      node.hostname.toLowerCase().includes(needle) ||
      node.labels.some(([, value]) => value.toLowerCase().includes(needle)),
  );
}

/** Short display name for a node: its `visible_name` label or first DNS label. */
export function nodeDisplayName(node: TeleportNode): string {
  return (
    node.labels.find(([key]) => key === "visible_name")?.[1] ||
    node.hostname.split(".")[0]
  );
}
