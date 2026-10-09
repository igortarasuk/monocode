import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost${path}`,
  invoke: vi.fn(),
}));

import { ProjectDiagram } from "./ProjectDiagram";

const props = { busy: false, onReload: () => {}, onRequested: () => {} };

describe("project diagram", () => {
  it("offers to draw the diagram before there is one", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectDiagram, { ...props, diagram: null }),
    );
    expect(html).toContain("Draw diagram");
    expect(html).not.toContain("<iframe");
  });

  it("frames the delivered page without access to the data folder", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectDiagram, {
        ...props,
        diagram: { path: "/data/acme/architecture.html", modified: 7 },
      }),
    );
    expect(html).toContain(
      'src="asset://localhost/data/acme/architecture.html?v=7"',
    );
    expect(html).toContain('sandbox="allow-scripts allow-downloads"');
    expect(html).toContain("Update diagram");
  });
});
