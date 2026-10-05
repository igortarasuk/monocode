import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArchitectureDiagram } from "../model/infraDiagram";
import { InfraDiagram } from "./InfraDiagram";

const diagram: ArchitectureDiagram = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "acme: infrastructure", output: "architecture.html" },
  components: [
    {
      id: "zabbix-proxy-eu",
      type: "security",
      label: "zabbix-proxy-eu",
      sublabel: "collects EU metrics",
      tag: "proxy",
      pos: [40, 40],
      size: [160, 64],
    },
    {
      id: "eu-mon-1",
      type: "cloud",
      label: "eu-mon-1",
      pos: [40, 240],
      size: [160, 64],
    },
  ],
  connections: [
    {
      id: "zabbix-proxy-eu-on-eu-mon-1",
      from: "zabbix-proxy-eu",
      to: "eu-mon-1",
      label: "runs on",
    },
    { from: "zabbix-proxy-eu", to: "missing" },
  ],
};

describe("InfraDiagram", () => {
  it("draws every node, its edge and the title at 1:1", () => {
    const markup = renderToStaticMarkup(
      createElement(InfraDiagram, { diagram }),
    );
    expect(markup).toContain('viewBox="8 8 224 328"');
    expect(markup).toContain(">zabbix-proxy-eu</text>");
    expect(markup).toContain(">collects EU metrics</text>");
    expect(markup).toContain(">proxy</text>");
    expect(markup).toContain(">eu-mon-1</text>");
    expect(markup).toContain('points="120,104 120,240"');
    expect(markup).toContain(">runs on</text>");
    expect(markup).toContain("acme: infrastructure");
    // An edge to a node the map no longer has is skipped, not drawn.
    expect(markup.match(/<polyline/g)).toHaveLength(1);
  });
});
