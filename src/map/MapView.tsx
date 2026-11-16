import type { Root } from "mdast";
import { useMemo } from "react";
import { m } from "../paraglide/messages.js";
import { mapColumns, mapPlan, type MapFrame } from "./layout";

export interface MapViewProps {
  /**
   * The parsed document. The map sections it itself with `mapPlan`, so the
   * level override and the choice of sections do not change it (decision 142).
   */
  root: Root;
}

/** A frame's heading at its section's depth, so the frames read as the document's outline. */
function FrameTitle({ frame, id }: { frame: MapFrame; id: string }) {
  if (frame.depth === null) return <p>{frame.title}</p>;
  const Heading = `h${frame.depth}` as const;
  return <Heading id={id}>{frame.title}</Heading>;
}

/**
 * The map view (decision 142). For now the frames of the map's plan, one
 * `section` each, in document order, named by their headings; the drawing,
 * measuring and camera come in a later step that keeps this component's props.
 */
export default function MapView({ root }: MapViewProps) {
  const frames = useMemo(() => mapColumns(mapPlan(root)).flat(), [root]);
  return (
    // Focusable so a keyboard can scroll the frames: they hold no link or button yet (axe's
    // scrollable-region-focusable).
    <section className="docwalk-map-pane" aria-label={m.map_region()} tabIndex={0}>
      {frames.map((frame) => {
        const titleId = `map-frame-${frame.id}`;
        return (
          <section
            key={frame.id}
            data-map-frame={frame.id}
            aria-labelledby={frame.depth === null ? undefined : titleId}
          >
            <FrameTitle frame={frame} id={titleId} />
          </section>
        );
      })}
    </section>
  );
}
