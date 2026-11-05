import {
  Command as CommandIcon,
  Eraser,
  LocateFixed,
  MoveUpRight,
  Pen,
  Trash,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useContext, useRef, type ReactNode } from "react";
import {
  Button,
  Radio,
  RadioGroup,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  TooltipTrigger,
  TooltipTriggerStateContext,
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

/** The name of an icon-only control, and its shortcut, on hover and keyboard focus (as IconButton does). */
function Tip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={500}>
      {children}
      <Tooltip className="docwalk-tooltip" offset={6}>
        {label} {shortcut && <kbd>{shortcut}</kbd>}
      </Tooltip>
    </TooltipTrigger>
  );
}

/**
 * A colour swatch. Its focusable element is a visually hidden radio input,
 * which the pointer never enters, so hover is taken from the visible label and
 * the tooltip is placed against it.
 */
function Swatch({ variable, label }: (typeof PEN_COLORS)[number]) {
  const tooltip = useContext(TooltipTriggerStateContext);
  const ref = useRef<HTMLLabelElement>(null);
  return (
    <>
      <Radio
        ref={ref}
        value={variable}
        aria-label={label}
        className="docwalk-annotate-swatch"
        onHoverChange={(hovered) => (hovered ? tooltip?.open() : tooltip?.close())}
      >
        <span
          className="docwalk-annotate-swatch-dot"
          style={{ background: `var(${variable})` }}
          aria-hidden="true"
        />
      </Radio>
      <Tooltip className="docwalk-tooltip" offset={6} triggerRef={ref}>
        {label}
      </Tooltip>
    </>
  );
}

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
          <Tip key={id} label={label} shortcut={shortcut}>
            <ToggleButton
              id={id}
              aria-label={label}
              aria-keyshortcuts={shortcut}
              className="docwalk-annotate-button"
            >
              <Icon size={18} aria-hidden="true" />
            </ToggleButton>
          </Tip>
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
        {PEN_COLORS.map((c) => (
          <TooltipTrigger key={c.variable} delay={500}>
            <Swatch {...c} />
          </TooltipTrigger>
        ))}
      </RadioGroup>
      <div className="docwalk-annotate-group">
        <Tip
          label="Undo mark"
          shortcut={
            <>
              <CommandIcon size={11} aria-hidden="true" />Z
            </>
          }
        >
          <Button
            aria-label="Undo mark"
            aria-keyshortcuts="Control+Z Meta+Z"
            className="docwalk-annotate-button"
            onPress={onUndo}
          >
            <Undo2 size={18} aria-hidden="true" />
          </Button>
        </Tip>
        <Tip label="Clear marks">
          <Button aria-label="Clear marks" className="docwalk-annotate-button" onPress={onClear}>
            <Trash size={18} aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    </Toolbar>
  );
}
