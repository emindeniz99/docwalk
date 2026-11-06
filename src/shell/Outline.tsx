import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import type { SlideInfo } from "../deck/controller";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";

interface OutlineProps {
  slides: SlideInfo[];
  current: SlideInfo | null;
  onSelect: (address: string) => void;
  /** Open comments per section id (decision 55). */
  commentCounts?: ReadonlyMap<string, number>;
}

interface OutlineEntry {
  id: string;
  title: string;
  pages: number;
  flagged: boolean;
  comments: number;
}

/** One entry per section: its title, how many slides it became, and whether any of them carries a note. */
export function Outline({ slides, current, onSelect, commentCounts }: OutlineProps) {
  const locale = useLocale();
  const entries = useMemo(() => {
    const map = new Map<string, OutlineEntry>();
    for (const s of slides) {
      const e = map.get(s.sectionId) ?? {
        id: s.sectionId,
        title: s.title || s.sectionId,
        pages: 0,
        flagged: false,
        comments: commentCounts?.get(s.sectionId) ?? 0,
      };
      e.pages += 1;
      e.flagged ||= s.flagged;
      map.set(s.sectionId, e);
    }
    return [...map.values()];
    // React Aria re-renders an item only when its entry changes, so the counts live in the entries.
  }, [slides, commentCounts]);

  return (
    <nav className="docwalk-outline" aria-label={m.outline_label()}>
      <div className="docwalk-overline docwalk-outline-head">
        <span>{m.outline_label()}</span>
        <span>{m.count_slides({ count: slides.length })}</span>
      </div>
      <ListBox
        aria-label={m.outline_sections()}
        items={entries}
        // Row labels are in the UI language, so a switch renders the rows again.
        dependencies={[locale]}
        selectionMode="single"
        selectedKeys={current ? [current.sectionId] : []}
        // With a selection mode, React Aria reports clicks and Enter as selection changes.
        // Pressing the current section toggles it off and arrives as an empty set: it
        // still means "go to this section's first page".
        onSelectionChange={(keys) => {
          const [key = current?.sectionId] = keys === "all" ? [] : [...keys];
          if (key !== undefined) onSelect(`${String(key)}/1`);
        }}
        className="docwalk-outline-list"
      >
        {(e) => (
          <ListBoxItem id={e.id} textValue={e.title} className="docwalk-outline-item">
            <span className="docwalk-outline-title">{e.title}</span>
            <span className="docwalk-outline-meta">
              {e.comments > 0 && (
                <span className="docwalk-outline-comments">
                  <MessageSquare size={12} aria-hidden="true" />
                  {e.comments}
                  <span className="docwalk-visually-hidden">
                    {` ${m.outline_comments({ count: e.comments })}`}
                  </span>
                </span>
              )}
              {e.flagged && (
                <span className="docwalk-note-dot" aria-label={m.outline_has_note()} role="img" />
              )}
              <span>{e.pages}</span>
            </span>
          </ListBoxItem>
        )}
      </ListBox>
    </nav>
  );
}
