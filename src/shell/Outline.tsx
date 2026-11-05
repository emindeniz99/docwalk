import { useMemo } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import type { SlideInfo } from "../deck/controller";

interface OutlineProps {
  slides: SlideInfo[];
  current: SlideInfo | null;
  onSelect: (address: string) => void;
}

interface OutlineEntry {
  id: string;
  title: string;
  pages: number;
  flagged: boolean;
}

/** One entry per section: its title, how many slides it became, and whether any of them carries a note. */
export function Outline({ slides, current, onSelect }: OutlineProps) {
  const entries = useMemo(() => {
    const map = new Map<string, OutlineEntry>();
    for (const s of slides) {
      const e = map.get(s.sectionId) ?? {
        id: s.sectionId,
        title: s.title || s.sectionId,
        pages: 0,
        flagged: false,
      };
      e.pages += 1;
      e.flagged ||= s.flagged;
      map.set(s.sectionId, e);
    }
    return [...map.values()];
  }, [slides]);

  return (
    <nav className="docwalk-outline" aria-label="Outline">
      <div className="docwalk-overline docwalk-outline-head">
        <span>Outline</span>
        <span>{slides.length} slides</span>
      </div>
      <ListBox
        aria-label="Sections"
        items={entries}
        selectionMode="single"
        selectedKeys={current ? [current.sectionId] : []}
        // With a selection mode, React Aria reports clicks and Enter as selection changes.
        onSelectionChange={(keys) => {
          const [key] = keys === "all" ? [] : [...keys];
          if (key !== undefined) onSelect(`${String(key)}/1`);
        }}
        className="docwalk-outline-list"
      >
        {(e) => (
          <ListBoxItem id={e.id} textValue={e.title} className="docwalk-outline-item">
            <span className="docwalk-outline-title">{e.title}</span>
            <span className="docwalk-outline-meta">
              {e.flagged && (
                <span className="docwalk-note-dot" aria-label="Has a note" role="img" />
              )}
              <span>{e.pages}</span>
            </span>
          </ListBoxItem>
        )}
      </ListBox>
    </nav>
  );
}
