import {
  Circle,
  Eraser,
  LocateFixed,
  MoveUpRight,
  Pen,
  Presentation,
  Square,
  Trash,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useContext, useRef, type ReactNode, type RefObject } from "react";
import {
  Button,
  Radio,
  RadioGroup,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  TooltipTriggerStateContext,
} from "react-aria-components";
import { m } from "../paraglide/messages.js";
import { ModShortcut } from "../shell/ModShortcut";
import { QuietTooltipTrigger } from "../shell/QuietTooltipTrigger";
import "./toolbar.css";
import type { AnnotationMode } from "./types";

/**
 * Pen colours, named by design-token variable so no literal colour lives in
 * the source. Resolve one with `resolvePenColor` before `layer.setColor`.
 */
export const PEN_COLORS = [
  { variable: "--dw-color-primary", label: m.pen_vermilion },
  { variable: "--dw-color-focus", label: m.pen_blue },
  { variable: "--dw-color-ink", label: m.pen_ink },
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

// Shortcut keys stay the same in every language (P, L, A, R, C, E).
const TOOLS: { mode: ToolMode; label: () => string; shortcut: string; Icon: LucideIcon }[] = [
  { mode: "pen", label: m.tool_pen, shortcut: "P", Icon: Pen },
  { mode: "laser", label: m.tool_laser, shortcut: "L", Icon: LocateFixed },
  { mode: "arrow", label: m.tool_arrow, shortcut: "A", Icon: MoveUpRight },
  { mode: "rect", label: m.tool_rect, shortcut: "R", Icon: Square },
  { mode: "ellipse", label: m.tool_ellipse, shortcut: "C", Icon: Circle },
  { mode: "eraser", label: m.tool_eraser, shortcut: "E", Icon: Eraser },
];

/**
 * React Aria's ToggleButton filters out `aria-keyshortcuts`, so the key is set
 * on the element itself. Assistive technology reads it (WCAG 4.1.2 in spirit,
 * and decision 110 asks every tool to carry it).
 */
const keyShortcut = (shortcut: string) => (el: HTMLElement | null) =>
  el?.setAttribute("aria-keyshortcuts", shortcut);

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
    <QuietTooltipTrigger delay={500}>
      {children}
      <Tooltip className="docwalk-tooltip" offset={6}>
        {label} {shortcut && <kbd>{shortcut}</kbd>}
      </Tooltip>
    </QuietTooltipTrigger>
  );
}

/**
 * A colour swatch. Its focusable element is a visually hidden radio input,
 * which the pointer never enters, so hover is taken from the visible label and
 * the tooltip is placed against it.
 */
function SwatchWithTip(props: (typeof PEN_COLORS)[number]) {
  const ref = useRef<HTMLLabelElement>(null);
  return (
    <QuietTooltipTrigger delay={500} triggerRef={ref}>
      <Swatch {...props} labelRef={ref} />
    </QuietTooltipTrigger>
  );
}

function Swatch({
  variable,
  label,
  labelRef: ref,
}: (typeof PEN_COLORS)[number] & { labelRef: RefObject<HTMLLabelElement | null> }) {
  const tooltip = useContext(TooltipTriggerStateContext);
  return (
    <>
      <Radio
        ref={ref}
        value={variable}
        aria-label={label()}
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
        {label()}
      </Tooltip>
    </>
  );
}

export interface AnnotationToolbarProps {
  mode: AnnotationMode;
  onModeChange: (mode: AnnotationMode) => void;
  color: PenColor;
  onColorChange: (color: PenColor) => void;
  /** The whiteboard (decision 110) is open. */
  board: boolean;
  onBoardToggle: () => void;
  onUndo: () => void;
  onClear: () => void;
}

export function AnnotationToolbar(props: AnnotationToolbarProps) {
  const { mode, onModeChange, color, onColorChange, board, onBoardToggle, onUndo, onClear } = props;
  return (
    <Toolbar aria-label={m.annotate_label()} className="docwalk-annotate-toolbar">
      <ToggleButtonGroup
        aria-label={m.annotate_tool()}
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
          <Tip key={id} label={label()} shortcut={shortcut}>
            <ToggleButton
              id={id}
              aria-label={label()}
              ref={keyShortcut(shortcut)}
              className="docwalk-annotate-button"
            >
              <Icon size={18} aria-hidden="true" />
            </ToggleButton>
          </Tip>
        ))}
      </ToggleButtonGroup>
      <RadioGroup
        aria-label={m.annotate_colour()}
        orientation="horizontal"
        value={color}
        onChange={(value) => {
          const next = PEN_COLORS.find((c) => c.variable === value);
          if (next) onColorChange(next.variable);
        }}
        className="docwalk-annotate-group"
      >
        {PEN_COLORS.map((c) => (
          <SwatchWithTip key={c.variable} {...c} />
        ))}
      </RadioGroup>
      <div className="docwalk-annotate-group">
        <Tip label={m.annotate_board()} shortcut="W">
          <ToggleButton
            aria-label={m.annotate_board()}
            ref={keyShortcut("W")}
            className="docwalk-annotate-button"
            isSelected={board}
            onChange={onBoardToggle}
          >
            <Presentation size={18} aria-hidden="true" />
          </ToggleButton>
        </Tip>
        <Tip label={m.annotate_undo()} shortcut={<ModShortcut keyName="Z" />}>
          <Button
            aria-label={m.annotate_undo()}
            aria-keyshortcuts="Control+Z Meta+Z"
            className="docwalk-annotate-button"
            onPress={onUndo}
          >
            <Undo2 size={18} aria-hidden="true" />
          </Button>
        </Tip>
        <Tip label={m.annotate_clear()}>
          <Button
            aria-label={m.annotate_clear()}
            className="docwalk-annotate-button"
            onPress={onClear}
          >
            <Trash size={18} aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    </Toolbar>
  );
}
