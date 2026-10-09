import { describe, expect, it } from "vitest";
import {
  diagramBounds,
  drawableComponents,
  edgeGeometry,
  isArchitectureDiagram,
  pointsAttribute,
  typeColor,
  type DiagramComponent,
} from "./infraDiagram";

const service: DiagramComponent = {
  id: "api",
  type: "backend",
  label: "api",
  pos: [40, 40],
  size: [160, 64],
};
const host: DiagramComponent = {
  id: "box-1",
  type: "cloud",
  label: "box-1",
  pos: [260, 240],
  size: [160, 64],
};

describe("infrastructure diagram", () => {
  it("recognises an Archify architecture candidate", () => {
    expect(isArchitectureDiagram(null)).toBe(false);
    expect(isArchitectureDiagram({ diagram_type: "sequence" })).toBe(false);
    expect(
      isArchitectureDiagram({ diagram_type: "architecture", components: [] }),
    ).toBe(true);
  });

  it("pads the bounds around every node", () => {
    expect(diagramBounds([])).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    expect(diagramBounds([service, host])).toEqual({
      x: 8,
      y: 8,
      width: 444,
      height: 328,
    });
  });

  it("routes an edge down from a service into its host", () => {
    const edge = edgeGeometry(service, host);
    expect(edge.points).toEqual([
      [120, 104],
      [120, 172],
      [340, 172],
      [340, 240],
    ]);
    expect(edge.label).toEqual([230, 166]);
    expect(pointsAttribute(edge.points)).toBe(
      "120,104 120,172 340,172 340,240",
    );
  });

  it("routes upwards and straight when the layout asks for it", () => {
    const above = { ...host, pos: [40, 240] as [number, number] };
    expect(edgeGeometry(service, above).points).toEqual([
      [120, 104],
      [120, 240],
    ]);
    const up = edgeGeometry(host, service);
    expect(up.points[0]).toEqual([340, 240]);
    expect(up.points[3]).toEqual([120, 104]);
  });

  it("joins neighbours in a row side to side", () => {
    const next = { ...host, pos: [260, 40] as [number, number] };
    const edge = edgeGeometry(service, next, [service, next]);
    expect(edge.points).toEqual([
      [200, 72],
      [260, 72],
    ]);
    expect(edgeGeometry(next, service).points).toEqual([
      [260, 72],
      [200, 72],
    ]);
  });

  it("lifts a row edge over the node standing between its ends", () => {
    const between = {
      ...service,
      id: "db",
      pos: [260, 40] as [number, number],
    };
    const far = { ...host, pos: [480, 40] as [number, number] };
    const edge = edgeGeometry(service, far, [service, between, far]);
    expect(edge.points).toEqual([
      [120, 40],
      [120, 24],
      [560, 24],
      [560, 40],
    ]);
    expect(edge.label).toEqual([340, 18]);
  });

  it("draws only the nodes that carry a box", () => {
    const loose = { id: "note", type: "external", label: "note" };
    expect(
      drawableComponents([service, loose as unknown as DiagramComponent]),
    ).toEqual([service]);
  });

  it("falls back to the external colour for an unknown type", () => {
    expect(typeColor("database")).not.toBe(typeColor("external"));
    expect(typeColor("mystery")).toBe(typeColor("external"));
  });
});
