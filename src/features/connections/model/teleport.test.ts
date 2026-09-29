import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  filterNodes,
  nodeDisplayName,
  profileExpired,
  type TeleportNode,
} from "./teleport";

const nodes: TeleportNode[] = [
  {
    hostname: "a1.example.com",
    id: "1",
    labels: [
      ["team", "web"],
      ["visible_name", "a1"],
    ],
  },
  { hostname: "db2.example.com", id: "2", labels: [["team", "data"]] },
];

describe("teleport helpers", () => {
  it("filters by hostname or label value", () => {
    expect(filterNodes(nodes, "DB2").map((n) => n.id)).toEqual(["2"]);
    expect(filterNodes(nodes, "web").map((n) => n.id)).toEqual(["1"]);
    expect(filterNodes(nodes, "  ")).toHaveLength(2);
  });

  it("names nodes by visible_name or first DNS label", () => {
    expect(nodeDisplayName(nodes[0])).toBe("a1");
    expect(nodeDisplayName(nodes[1])).toBe("db2");
  });

  it("detects expired certificates", () => {
    const profile = {
      proxy: "tp.example.com:443",
      cluster: "tp.example.com",
      username: "alice",
      logins: ["ops"],
      validUntil: "2026-09-29T18:27:12+03:00",
      active: true,
    };
    expect(
      profileExpired(profile, Date.parse("2026-09-29T10:00:00+03:00")),
    ).toBe(false);
    expect(
      profileExpired(profile, Date.parse("2026-09-30T10:00:00+03:00")),
    ).toBe(true);
  });
});
