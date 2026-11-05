import { ChevronDown } from "lucide-react";
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import type { LevelOption } from "../sectioning/sectionize";

interface LevelSelectProps {
  value: LevelOption;
  onChange: (value: LevelOption) => void;
  /** What "Auto" resolved to for this document, e.g. "H2". */
  resolved: string;
}

const OPTIONS: { id: string; label: string; value: LevelOption }[] = [
  { id: "auto", label: "Auto", value: "auto" },
  { id: "1", label: "H1", value: 1 },
  { id: "2", label: "H2", value: 2 },
  { id: "3", label: "H3", value: 3 },
];

const idOf = (v: LevelOption) => (typeof v === "object" ? v.join(",") : String(v));

/** "Slides start at": a React Aria Select styled from the design tokens, keyboard and screen-reader complete. */
export function LevelSelect({ value, onChange, resolved }: LevelSelectProps) {
  const items = OPTIONS.map((o) => ({
    ...o,
    label: o.value === "auto" ? `Auto · ${resolved}` : o.label,
  }));
  const selected = OPTIONS.some((o) => o.id === idOf(value)) ? idOf(value) : "auto";
  return (
    <Select
      className="docwalk-select"
      selectedKey={selected}
      onSelectionChange={(key) => {
        const found = OPTIONS.find((o) => o.id === String(key));
        if (found) onChange(found.value);
      }}
    >
      <Label className="docwalk-overline">Slides start at</Label>
      <Button className="docwalk-select-button">
        <SelectValue />
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      <Popover className="docwalk-popover">
        <ListBox items={items} className="docwalk-menu">
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label} className="docwalk-menu-item">
              {item.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
