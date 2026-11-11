import {
  Circle,
  Ellipsis,
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
  Keyboard,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Radio,
  RadioGroup,
  Separator,
  Text,
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

interface Tool {
  mode: ToolMode;
  label: () => string;
  shortcut: string;
  Icon: LucideIcon;
}

// Shortcut keys stay the same in every language (P, L, A, R, C, E).
const TOOLS: Tool[] = [
  { mode: "pen", label: m.tool_pen, shortcut: "P", Icon: Pen },
  { mode: "laser", label: m.tool_laser, shortcut: "L", Icon: LocateFixed },
  { mode: "arrow", label: m.tool_arrow, shortcut: "A", Icon: MoveUpRight },
  { mode: "rect", label: m.tool_rect, shortcut: "R", Icon: Square },
  { mode: "ellipse", label: m.tool_ellipse, shortcut: "C", Icon: Circle },
  { mode: "eraser", label: m.tool_eraser, shortcut: "E", Icon: Eraser },
];

/**
 * The tools that move into the More tools menu, with Whiteboard and Clear
 * marks, when the stage head is too narrow for twelve controls (decision 110).
 * styles.css hides the `docwalk-annotate-overflow` controls and shows the
 * menu button at those widths.
 */
const SHAPES = TOOLS.filter((t) => t.mode === "rect" || t.mode === "ellipse");
const OVERFLOW = " docwalk-annotate-overflow";
const BOARD = "board";

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

interface AnnotationToolbarProps {
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

/**
 * Rectangle, Ellipse, Whiteboard and Clear marks in one menu, for a stage head
 * too narrow for their buttons. The button takes the active shape's icon and
 * name, since that shape's own button is out of sight.
 */
function MoreTools({ mode, onModeChange, board, onBoardToggle, onClear }: AnnotationToolbarProps) {
  const shape = SHAPES.find((t) => t.mode === mode);
  const Icon = shape?.Icon ?? Ellipsis;
  const name = shape ? m.annotate_more_active({ tool: shape.label() }) : m.annotate_more();
  return (
    <MenuTrigger>
      <Tip label={name}>
        <Button
          aria-label={name}
          className="docwalk-annotate-button docwalk-annotate-more"
          data-active={shape ? "" : undefined}
        >
          <Icon size={18} aria-hidden="true" />
        </Button>
      </Tip>
      <Popover className="docwalk-popover" placement="bottom end">
        <Menu aria-label={m.annotate_more()} className="docwalk-menu">
          <MenuSection
            aria-label={m.annotate_tool()}
            selectionMode="single"
            selectedKeys={shape ? [shape.mode] : []}
            onSelectionChange={(keys) => {
              // Picking the active shape again turns annotation off, as its button does.
              const [k] = [...keys];
              onModeChange(isTool(k) ? k : "off");
            }}
          >
            {SHAPES.map(({ mode: id, label, shortcut, Icon: ShapeIcon }) => (
              <MenuItem key={id} id={id} textValue={label()} className="docwalk-menu-item">
                <ShapeIcon size={16} aria-hidden="true" />
                <Text slot="label">{label()}</Text>
                <Keyboard>{shortcut}</Keyboard>
              </MenuItem>
            ))}
          </MenuSection>
          <MenuSection
            aria-label={m.annotate_board()}
            selectionMode="multiple"
            // A checkbox item keeps a menu open; the board covers the slide to draw on, so close it.
            shouldCloseOnSelect
            selectedKeys={board ? [BOARD] : []}
            onSelectionChange={onBoardToggle}
          >
            <MenuItem id={BOARD} textValue={m.annotate_board()} className="docwalk-menu-item">
              <Presentation size={16} aria-hidden="true" />
              <Text slot="label">{m.annotate_board()}</Text>
              <Keyboard>W</Keyboard>
            </MenuItem>
          </MenuSection>
          <Separator className="docwalk-menu-separator" />
          <MenuItem
            id="clear"
            textValue={m.annotate_clear()}
            className="docwalk-menu-item"
            onAction={onClear}
          >
            <Trash size={16} aria-hidden="true" />
            <Text slot="label">{m.annotate_clear()}</Text>
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
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
              className={`docwalk-annotate-button${SHAPES.some((t) => t.mode === id) ? OVERFLOW : ""}`}
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
            className={`docwalk-annotate-button${OVERFLOW}`}
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
        {/* Before Clear marks, so Clear stays the last control wherever the menu is hidden:
            presenting's Shift+Tab lands on the last control in the page (decision 75). */}
        <MoreTools {...props} />
        <Tip label={m.annotate_clear()}>
          <Button
            aria-label={m.annotate_clear()}
            className={`docwalk-annotate-button${OVERFLOW}`}
            onPress={onClear}
          >
            <Trash size={18} aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    </Toolbar>
  );
}
