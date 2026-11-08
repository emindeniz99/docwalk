import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Dialog,
  Heading,
  Label,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { m } from "../paraglide/messages.js";
import { sectionsFitInLink } from "../url/state";
import { IconButton } from "./IconButton";
import "./sections.css";

/** One checkbox: the section's id and the name the viewer reads. */
export interface PickerSection {
  id: string;
  label: string;
}

interface SectionPickerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every section of the document, in order. */
  sections: readonly PickerSection[];
  /** The sections presented now. */
  chosen: ReadonlySet<string>;
  /** `null` when every section is checked: that is no selection at all (decision 100). */
  onApply: (ids: string[] | null) => void;
}

/**
 * Picks the sections to present (decision 100). The boxes are a draft that
 * "Show N sections" applies, so "Clear" never shows every section while every
 * box is empty, and Escape or "Cancel" leaves the choice as it was.
 */
export function SectionPicker({
  isOpen,
  onOpenChange,
  sections,
  chosen,
  onApply,
}: SectionPickerProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-sections-overlay"
    >
      <Modal className="docwalk-sections">
        <Dialog className="docwalk-sections-dialog">
          {({ close }) => (
            <PickerBody
              sections={sections}
              chosen={chosen}
              onApply={(ids) => {
                close();
                onApply(ids);
              }}
              close={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The dialog's content; the Modal mounts it on every open, so the draft starts from the current choice. */
function PickerBody({
  sections,
  chosen,
  onApply,
  close,
}: {
  sections: readonly PickerSection[];
  chosen: ReadonlySet<string>;
  onApply: (ids: string[] | null) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState<string[]>(() =>
    sections.filter((s) => chosen.has(s.id)).map((s) => s.id),
  );
  const needOneId = useId();
  const all = draft.length === sections.length;
  // The choice in document order, whatever order the boxes were checked in.
  const ordered = sections.filter((s) => draft.includes(s.id)).map((s) => s.id);
  const fits = all || sectionsFitInLink(ordered);

  return (
    <>
      <header className="docwalk-sections-head">
        <Heading slot="title" className="docwalk-sections-title">
          {m.cmd_sections()}
        </Heading>
        <IconButton label={m.close()} onPress={close}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </header>
      <p className="docwalk-sections-hint">{m.sections_hint()}</p>
      <div className="docwalk-sections-tools">
        <Button className="docwalk-button" onPress={() => setDraft(sections.map((s) => s.id))}>
          {m.sections_select_all()}
        </Button>
        <Button className="docwalk-button" onPress={() => setDraft([])}>
          {m.sections_clear()}
        </Button>
      </div>
      <CheckboxGroup value={draft} onChange={setDraft} className="docwalk-sections-group">
        <Label className="docwalk-overline">{m.outline_sections()}</Label>
        <div className="docwalk-sections-list">
          {sections.map((section) => (
            <Checkbox key={section.id} value={section.id} className="docwalk-sections-item">
              {({ isSelected }) => (
                <>
                  <span className="docwalk-sections-box" aria-hidden="true">
                    {isSelected && <Check size={14} />}
                  </span>
                  <span className="docwalk-sections-label">{section.label}</span>
                </>
              )}
            </Checkbox>
          ))}
        </div>
      </CheckboxGroup>
      <p role="status" className="docwalk-sections-count">
        {m.sections_checked({ checked: draft.length, total: sections.length })}
      </p>
      {/* Always mounted, so the warning is announced when it appears (WCAG 4.1.3). */}
      <p aria-live="polite" className="docwalk-sections-warning">
        {fits ? null : m.sections_too_long()}
      </p>
      {draft.length === 0 && (
        <p id={needOneId} className="docwalk-sections-hint">
          {m.sections_need_one()}
        </p>
      )}
      <div className="docwalk-sections-actions">
        <Button className="docwalk-button" onPress={close}>
          {m.cancel()}
        </Button>
        <Button
          className="docwalk-button"
          data-variant="primary"
          isDisabled={draft.length === 0}
          {...(draft.length === 0 ? { "aria-describedby": needOneId } : {})}
          onPress={() => onApply(all ? null : ordered)}
        >
          {m.sections_apply({ count: draft.length })}
        </Button>
      </div>
    </>
  );
}
