import {
  DIAGRAM_PAD,
  diagramBounds,
  edgeGeometry,
  pointsAttribute,
  typeColor,
  type ArchitectureDiagram,
} from "../model/infraDiagram";

/** Draws `.monochrome/architecture.json` at 1:1 inside a scrolling pane. */
export function InfraDiagram({ diagram }: { diagram: ArchitectureDiagram }) {
  const nodes = diagram.components;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bounds = diagramBounds(nodes);
  const edges = (diagram.connections ?? []).flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? [{ edge, ...edgeGeometry(from, to) }] : [];
  });
  return (
    <div className="overflow-auto rounded-lg border border-content/7">
      <svg
        role="img"
        aria-label={diagram.meta.title}
        width={bounds.width}
        height={bounds.height}
        viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
        className="block text-content"
        style={{ minWidth: bounds.width }}
      >
        <defs>
          <marker
            id="infra-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>
        {edges.map(({ edge, points, label }) => (
          <g key={edge.id ?? `${edge.from}-${edge.to}`} opacity="0.75">
            <polyline
              points={pointsAttribute(points)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              markerEnd="url(#infra-arrow)"
            />
            {edge.label ? (
              <text
                x={label[0]}
                y={label[1]}
                textAnchor="middle"
                fontSize="10"
                fill="currentColor"
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        ))}
        {nodes.map((node) => {
          const [x, y] = node.pos;
          const [width, height] = node.size;
          const color = typeColor(node.type);
          return (
            <g key={node.id}>
              <title>
                {[node.label, node.tag, node.sublabel]
                  .filter(Boolean)
                  .join(" · ")}
              </title>
              <rect
                x={x}
                y={y}
                width={width}
                height={height}
                rx="8"
                fill={color}
                fillOpacity="0.08"
                stroke={color}
                strokeOpacity="0.7"
                strokeWidth="1.25"
              />
              <rect x={x} y={y} width="4" height={height} rx="2" fill={color} />
              <text
                x={x + 14}
                y={y + (node.sublabel ? 27 : height / 2 + 4)}
                fontSize="12"
                fontWeight="600"
                fill="currentColor"
              >
                {node.label}
              </text>
              {node.sublabel ? (
                <text
                  x={x + 14}
                  y={y + 45}
                  fontSize="10"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {node.sublabel}
                </text>
              ) : null}
              {node.tag ? (
                <text
                  x={x + width - 10}
                  y={y + 14}
                  textAnchor="end"
                  fontSize="9"
                  fill={color}
                >
                  {node.tag}
                </text>
              ) : null}
            </g>
          );
        })}
        <text
          x={bounds.x + DIAGRAM_PAD / 2}
          y={bounds.y + bounds.height - 10}
          fontSize="9"
          fill="currentColor"
          opacity="0.35"
        >
          {diagram.meta.title}
        </text>
      </svg>
    </div>
  );
}
