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
} from "react-aria-components";
import type { SlideInfo } from "../deck/controller";

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

/** ⌘K / Ctrl+K: jump to any slide by title, or run any command. */
export function CommandPalette({
  isOpen,
  onOpenChange,
  slides,
  commands,
  onGoTo,
}: CommandPaletteProps) {
  const { contains } = useFilter({ sensitivity: "base" });
  const slideItems = slides.map((s) => ({
    id: `slide:${s.address}`,
    label: s.page > 1 ? `${s.title} · ${s.page}` : s.title,
    hint: `${s.index + 1}`,
    run: () => onGoTo(s.address),
  }));

  const run = (key: React.Key) => {
    const id = String(key);
    const item = [...commands, ...slideItems].find((c) => c.id === id);
    onOpenChange(false);
    item?.run();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-palette-overlay"
    >
      <Modal className="docwalk-palette">
        <Dialog aria-label="Command palette" className="docwalk-palette-dialog">
          <Autocomplete filter={contains}>
            <SearchField
              aria-label="Jump to a slide or run a command"
              autoFocus
              className="docwalk-palette-search"
            >
              <Input placeholder="Jump to slide, command or setting…" />
            </SearchField>
            <Menu
              onAction={run}
              className="docwalk-palette-menu"
              renderEmptyState={() => <p className="docwalk-palette-empty">No match</p>}
            >
              <MenuSection className="docwalk-palette-section">
                <Header className="docwalk-overline">Commands</Header>
                {commands.map((c) => (
                  <MenuItem
                    key={c.id}
                    id={c.id}
                    textValue={c.label}
                    className="docwalk-palette-item"
                  >
                    <span>{c.label}</span>
                    {c.hint && <kbd>{c.hint}</kbd>}
                  </MenuItem>
                ))}
              </MenuSection>
              <MenuSection className="docwalk-palette-section">
                <Header className="docwalk-overline">Slides</Header>
                {slideItems.map((s) => (
                  <MenuItem
                    key={s.id}
                    id={s.id}
                    textValue={s.label}
                    className="docwalk-palette-item"
                  >
                    <span>{s.label}</span>
                    <span className="docwalk-palette-hint">{s.hint}</span>
                  </MenuItem>
                ))}
              </MenuSection>
            </Menu>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
