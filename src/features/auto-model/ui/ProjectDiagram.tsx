import { convertFileSrc } from "@tauri-apps/api/core";
import { useState, type ReactNode } from "react";
import { openPathWithDefaultApp } from "../../../platform/tauri/fs";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { requestAddToChat } from "../../sessions/model/quoteDraft";
import {
  diagramRequest,
  type KnowledgePage,
} from "../model/projectKnowledgePage";

/** The address the webview loads the delivered page from. */
export function diagramAddress(diagram: NonNullable<KnowledgePage["diagram"]>) {
  return `${convertFileSrc(diagram.path)}?v=${diagram.modified}`;
}

/**
 * The project's Archify diagram. Monochrome only shows it: an agent traces the
 * system, writes the candidate and has Archify render the page, so the button
 * here puts that request into the composer.
 */
export function ProjectDiagram({
  diagram,
  fallback,
  busy,
  onReload,
  onRequested,
}: {
  diagram: KnowledgePage["diagram"];
  /** The sketch of the infrastructure map, shown until a page is delivered. */
  fallback?: ReactNode;
  busy: boolean;
  onReload: () => void;
  onRequested: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const request = () => {
    requestAddToChat(diagramRequest(diagram !== null), "plain");
    onRequested();
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-content/45">
          {diagram
            ? "Drawn by an agent with Archify from the repository and the infrastructure map. Update it after the system changes."
            : "This is only a sketch of the infrastructure map. An agent draws the real diagram with Archify from the repository and the map; the request goes into the composer for you to send."}
        </p>
        {diagram ? (
          <>
            <SecondaryButton disabled={busy} onClick={onReload}>
              Reload
            </SecondaryButton>
            <SecondaryButton
              onClick={() => {
                setError(null);
                openPathWithDefaultApp(diagram.path).catch((reason) =>
                  setError(String(reason)),
                );
              }}
            >
              Open in browser
            </SecondaryButton>
          </>
        ) : null}
        <SecondaryButton onClick={request}>
          {diagram ? "Update diagram" : "Draw diagram"}
        </SecondaryButton>
      </div>
      {error ? <p className="shrink-0 text-red-400">{error}</p> : null}
      {diagram ? (
        <iframe
          key={diagram.modified}
          title="Architecture diagram"
          src={diagramAddress(diagram)}
          // Scripts run the viewer; without same-origin it cannot read the
          // rest of the data folder the asset protocol serves.
          sandbox="allow-scripts allow-downloads"
          className="min-h-0 w-full flex-1 rounded-lg border border-content/7 bg-[#050816]"
        />
      ) : (
        fallback
      )}
    </div>
  );
}
