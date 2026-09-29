import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { serviceChips } from "./ServicesStatus";

const now = Date.parse("2026-09-29T12:00:00+03:00");

describe("serviceChips", () => {
  it("shows only installed services", () => {
    expect(
      serviceChips({ teleport: null, docker: null, vagrant: null }, now),
    ).toEqual([]);
  });

  it("describes Teleport, Docker and running Vagrant machines", () => {
    const chips = serviceChips(
      {
        teleport: {
          cluster: "tp.example.com",
          validUntil: "2026-09-29T18:27:12+03:00",
        },
        docker: { running: true, containers: 2, version: "29.7.2" },
        vagrant: { running: ["web"] },
      },
      now,
    );
    expect(chips.map(({ key, label, tone }) => [key, label, tone])).toEqual([
      ["teleport", "tp", "ok"],
      ["docker", "Docker 2", "ok"],
      ["vagrant", "Vagrant 1", "ok"],
    ]);
  });

  it("flags an expired Teleport login and a stopped Docker daemon", () => {
    const chips = serviceChips(
      {
        teleport: {
          cluster: "tp.example.com",
          validUntil: "2026-09-28T18:00:00+03:00",
        },
        docker: { running: false, containers: 0, version: null },
        vagrant: { running: [] },
      },
      now,
    );
    expect(chips.map(({ key, tone }) => [key, tone])).toEqual([
      ["teleport", "warn"],
      ["docker", "off"],
    ]);
    expect(chips[0].title).toContain("tsh login");
  });
});
