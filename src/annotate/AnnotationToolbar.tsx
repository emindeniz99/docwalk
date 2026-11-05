import { Eraser, LocateFixed, MoveUpRight, Pen, Trash, Undo2, type LucideIcon } from "lucide-react";
import {
  Button,
  Radio,
  RadioGroup,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
} from "react-aria-components";
import "./toolbar.css";
import type { AnnotationMode } from "./types";

/**
 * Pen colours, named by design-token variable so no literal colour lives in
 * the source. Resolve one with `resolvePenColor` before `layer.setColor`.
 */
export const PEN_COLORS = [
  { variable: "--dw-color-primary", label: "Vermilion" },
  { variable: "--dw-color-focus", label: "Blue" },
  { variable: "--dw-color-ink", label: "Ink" },
] as const;

export type PenColor = (typeof PEN_COLORS)[number]["variable"];

/** The computed value of a pen colour variable, for drauu's SVG attributes (they cannot hold `var()`). */
export function resolvePenColor(
  variable: PenColor,
  from: Element = document.documentElement,
): string {
  return getComputedStyle(from).getPropertyValue(variable).trim();
}

type ToolMode = Exclude<AnnotationMode, "off">;

const TOOLS: { mode: ToolMode; label: string; shortcut: string; Icon: LucideIcon }[] = [
  { mode: "pen", label: "Pen", shortcut: "P", Icon: Pen },
  { mode: "laser", label: "Laser pointer", shortcut: "L", Icon: LocateFixed },
  { mode: "arrow", label: "Arrow", shortcut: "A", Icon: MoveUpRight },
  { mode: "eraser", label: "Eraser", shortcut: "E", Icon: Eraser },
];

const isTool = (key: unknown): key is ToolMode => TOOLS.some((t) => t.mode === key);

export interface AnnotationToolbarProps {
  mode: AnnotationMode;
  onModeChange: (mode: AnnotationMode) => void;
  color: PenColor;
  onColorChange: (color: PenColor) => void;
  onUndo: () => void;
  onClear: () => void;
}

export function AnnotationToolbar(props: AnnotationToolbarProps) {
  const { mode, onModeChange, color, onColorChange, onUndo, onClear } = props;
  return (
    <Toolbar aria-label="Annotate" className="docwalk-annotate-toolbar">
      <ToggleButtonGroup
        aria-label="Tool"
        selectionMode="single"
        selectedKeys={mode === "off" ? [] : [mode]}
        onSelectionChange={(keys) => {
          // Pressing the active tool again turns annotation off.
          const [k] = [...keys];
          onModeChange(isTool(k) ? k : "off");
        }}
        className="docwalk-annotate-group"
      >
        {TOOLS.map(({ mode: id, label, shortcut, Icon }) => (
          <ToggleButton
            key={id}
            id={id}
            aria-label={label}
            aria-keyshortcuts={shortcut}
            className="docwalk-annotate-button"
          >
            <Icon size={18} aria-hidden="true" />
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <RadioGroup
        aria-label="Pen colour"
        orientation="horizontal"
        value={color}
        onChange={(value) => {
          const next = PEN_COLORS.find((c) => c.variable === value);
          if (next) onColorChange(next.variable);
        }}
        className="docwalk-annotate-group"
      >
        {PEN_COLORS.map(({ variable, label }) => (
          <Radio
            key={variable}
            value={variable}
            aria-label={label}
            className="docwalk-annotate-swatch"
          >
            <span
              className="docwalk-annotate-swatch-dot"
              style={{ background: `var(${variable})` }}
              aria-hidden="true"
            />
          </Radio>
        ))}
      </RadioGroup>
      <div className="docwalk-annotate-group">
        <Button
          aria-label="Undo mark"
          aria-keyshortcuts="Control+Z Meta+Z"
          className="docwalk-annotate-button"
          onPress={onUndo}
        >
          <Undo2 size={18} aria-hidden="true" />
        </Button>
        <Button aria-label="Clear marks" className="docwalk-annotate-button" onPress={onClear}>
          <Trash size={18} aria-hidden="true" />
        </Button>
      </div>
    </Toolbar>
  );
}
