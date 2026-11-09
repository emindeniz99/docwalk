import { useMemo, useState } from "react";
import {
  Autocomplete,
  Dialog,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Header,
  Modal,
  ModalOverlay,
  SearchField,
  useFilter,
  useLocale,
} from "react-aria-components";
import type { SlideInfo } from "../deck/controller";
import { m } from "../paraglide/messages.js";
import { searchText } from "./slideSearch";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  slides: SlideInfo[];
  commands: Command[];
  onGoTo: (address: string) => void;
}

/**
 * ⌘K / Ctrl+K: jump to any slide by title or by what it says, or run any
 * command (decision 81).
 */
export function CommandPalette({
  isOpen,
  onOpenChange,
  slides,
  commands,
  onGoTo,
}: CommandPaletteProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-palette-overlay"
    >
      <Modal className="docwalk-palette">
        <Dialog aria-label={m.palette_label()} className="docwalk-palette-dialog">
          <PaletteBody
            onOpenChange={onOpenChange}
            slides={slides}
            commands={commands}
            onGoTo={onGoTo}
          />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Keys of text hits start with this; the filter leaves them alone (they are matched already). */
const TEXT_KEY = "text:";

const slideLabel = (s: SlideInfo) => (s.page > 1 ? `${s.title} · ${s.page}` : s.title);

/** Mounted with the dialog, so the query starts empty each time the palette opens. */
function PaletteBody({
  onOpenChange,
  slides,
  commands,
  onGoTo,
}: Omit<CommandPaletteProps, "isOpen">) {
  const { contains } = useFilter({ sensitivity: "base" });
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  const slideItems = slides.map((s) => ({
    id: `slide:${s.address}`,
    label: slideLabel(s),
    hint: `${s.index + 1}`,
    run: () => onGoTo(s.address),
  }));
  // Slides whose title matches are in the Slides list already; the rest are
  // searched by their text. Each keystroke scans the pages' text once.
  const text = useMemo(
    () => searchText(slides, query, locale, (s) => contains(slideLabel(s), query)),
    [slides, query, locale, contains],
  );

  const run = (key: React.Key) => {
    const id = String(key);
    const hit = id.startsWith(TEXT_KEY)
      ? text.hits.find((h) => `${TEXT_KEY}${h.slide.address}` === id)
      : undefined;
    const item = hit
      ? { run: () => onGoTo(hit.slide.address) }
      : [...commands, ...slideItems].find((c) => c.id === id);
    onOpenChange(false);
    item?.run();
  };

  return (
    <>
      <Autocomplete
        filter={(textValue, input, node) =>
          String(node.key).startsWith(TEXT_KEY) || contains(textValue, input)
        }
        inputValue={query}
        onInputChange={setQuery}
      >
        <SearchField aria-label={m.palette_search()} autoFocus className="docwalk-palette-search">
          <Input placeholder={m.palette_placeholder()} />
        </SearchField>
        <Menu
          onAction={run}
          className="docwalk-palette-menu"
          renderEmptyState={() => <p className="docwalk-palette-empty">{m.palette_empty()}</p>}
        >
          <MenuSection className="docwalk-palette-section">
            <Header className="docwalk-overline">{m.palette_commands()}</Header>
            {commands.map((c) => (
              <MenuItem key={c.id} id={c.id} textValue={c.label} className="docwalk-palette-item">
                <span>{c.label}</span>
                {c.hint && <kbd>{c.hint}</kbd>}
              </MenuItem>
            ))}
          </MenuSection>
          <MenuSection className="docwalk-palette-section">
            <Header className="docwalk-overline">{m.palette_slides()}</Header>
            {slideItems.map((s) => (
              <MenuItem key={s.id} id={s.id} textValue={s.label} className="docwalk-palette-item">
                <span>{s.label}</span>
                <span className="docwalk-palette-hint">{s.hint}</span>
              </MenuItem>
            ))}
          </MenuSection>
          {text.hits.length > 0 && (
            <MenuSection className="docwalk-palette-section">
              <Header className="docwalk-overline">{m.palette_text()}</Header>
              {text.hits.map(({ slide: s, snippet }) => (
                <MenuItem
                  key={s.address}
                  id={`${TEXT_KEY}${s.address}`}
                  textValue={slideLabel(s)}
                  className="docwalk-palette-item docwalk-palette-text-item"
                >
                  <span>{slideLabel(s)}</span>
                  <span className="docwalk-palette-hint">{s.index + 1}</span>
                  {/* Page text goes in as text nodes only: it is never read as HTML (rule 5). */}
                  <span className="docwalk-palette-snippet">
                    {snippet.before}
                    <mark>{snippet.match}</mark>
                    {snippet.after}
                  </span>
                </MenuItem>
              ))}
            </MenuSection>
          )}
        </Menu>
      </Autocomplete>
      {text.total > text.hits.length && (
        <p className="docwalk-palette-more">
          {m.palette_more({ count: text.total - text.hits.length })}
        </p>
      )}
    </>
  );
}
