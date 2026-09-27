import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<
  ReturnType<typeof getCurrentWindow>["startResizeDragging"]
>[0];
import { useEffect, useState } from "react";

// Wayland drops the webview-level edge hit test; drive resize from DOM.
const EDGE = 6;
const CORNER = 12;

const EDGES: Array<{ dir: ResizeDirection; style: React.CSSProperties }> = [
  {
    dir: "North",
    style: {
      top: 0,
      left: CORNER,
      right: CORNER,
      height: EDGE,
      cursor: "ns-resize",
    },
  },
  {
    dir: "South",
    style: {
      bottom: 0,
      left: CORNER,
      right: CORNER,
      height: EDGE,
      cursor: "ns-resize",
    },
  },
  {
    dir: "West",
    style: {
      left: 0,
      top: CORNER,
      bottom: CORNER,
      width: EDGE,
      cursor: "ew-resize",
    },
  },
  {
    dir: "East",
    style: {
      right: 0,
      top: CORNER,
      bottom: CORNER,
      width: EDGE,
      cursor: "ew-resize",
    },
  },
  {
    dir: "NorthWest",
    style: {
      top: 0,
      left: 0,
      width: CORNER,
      height: CORNER,
      cursor: "nwse-resize",
    },
  },
  {
    dir: "NorthEast",
    style: {
      top: 0,
      right: 0,
      width: CORNER,
      height: CORNER,
      cursor: "nesw-resize",
    },
  },
  {
    dir: "SouthWest",
    style: {
      bottom: 0,
      left: 0,
      width: CORNER,
      height: CORNER,
      cursor: "nesw-resize",
    },
  },
  {
    dir: "SouthEast",
    style: {
      bottom: 0,
      right: 0,
      width: CORNER,
      height: CORNER,
      cursor: "nwse-resize",
    },
  },
];

export function ResizeEdges() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([max, full]) => mounted && setHidden(max || full))
        .catch(() => {});
    sync();
    void win
      .onResized(sync)
      .then((fn) => (mounted ? (unlisten = fn) : fn()))
      .catch(() => {});
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  if (hidden) return null;
  return (
    <>
      {EDGES.map(({ dir, style }) => (
        <div
          key={dir}
          aria-hidden
          data-tauri-drag-region="false"
          style={{ position: "fixed", zIndex: 2147483647, ...style }}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void getCurrentWindow()
              .startResizeDragging(dir)
              .catch(() => {});
          }}
        />
      ))}
    </>
  );
}
