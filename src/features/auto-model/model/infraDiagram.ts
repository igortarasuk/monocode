/** The part of an Archify architecture candidate the diagram tab draws. */
export type DiagramComponent = {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  tag?: string;
  pos: [number, number];
  size: [number, number];
};

export type DiagramConnection = {
  id?: string;
  from: string;
  to: string;
  label?: string;
};

export type ArchitectureDiagram = {
  schema_version: number;
  diagram_type: "architecture";
  meta: { title: string; output: string };
  components: DiagramComponent[];
  connections?: DiagramConnection[];
};

export const DIAGRAM_PAD = 32;

/** Accent per Archify component type; readable on light and dark glass. */
export const TYPE_COLOR: Record<string, string> = {
  frontend: "#38bdf8",
  backend: "#34d399",
  database: "#a78bfa",
  cloud: "#fbbf24",
  security: "#fb7185",
  messagebus: "#fb923c",
  external: "#94a3b8",
};

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? TYPE_COLOR.external;
}

export function isArchitectureDiagram(
  value: unknown,
): value is ArchitectureDiagram {
  if (!value || typeof value !== "object") return false;
  const diagram = value as Partial<ArchitectureDiagram>;
  return (
    diagram.diagram_type === "architecture" && Array.isArray(diagram.components)
  );
}

/** The drawing box around every node, with padding on all sides. */
export function diagramBounds(components: DiagramComponent[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (components.length === 0)
    return { x: 0, y: 0, width: DIAGRAM_PAD * 2, height: DIAGRAM_PAD * 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of components) {
    minX = Math.min(minX, node.pos[0]);
    minY = Math.min(minY, node.pos[1]);
    maxX = Math.max(maxX, node.pos[0] + node.size[0]);
    maxY = Math.max(maxY, node.pos[1] + node.size[1]);
  }
  return {
    x: minX - DIAGRAM_PAD,
    y: minY - DIAGRAM_PAD,
    width: maxX - minX + DIAGRAM_PAD * 2,
    height: maxY - minY + DIAGRAM_PAD * 2,
  };
}

export type EdgeGeometry = {
  points: [number, number][];
  label: [number, number];
};

/** Orthogonal route from the bottom of `from` to the top of `to`, or the
 *  reverse when `to` sits above `from`. The label rides the middle run. */
export function edgeGeometry(
  from: DiagramComponent,
  to: DiagramComponent,
): EdgeGeometry {
  const fromCenter = from.pos[0] + from.size[0] / 2;
  const toCenter = to.pos[0] + to.size[0] / 2;
  const downwards = to.pos[1] >= from.pos[1] + from.size[1];
  const startY = downwards ? from.pos[1] + from.size[1] : from.pos[1];
  const endY = downwards ? to.pos[1] : to.pos[1] + to.size[1];
  const midY = (startY + endY) / 2;
  const points: [number, number][] =
    Math.abs(fromCenter - toCenter) < 1
      ? [
          [fromCenter, startY],
          [toCenter, endY],
        ]
      : [
          [fromCenter, startY],
          [fromCenter, midY],
          [toCenter, midY],
          [toCenter, endY],
        ];
  return { points, label: [(fromCenter + toCenter) / 2, midY - 6] };
}

export function pointsAttribute(points: [number, number][]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}
