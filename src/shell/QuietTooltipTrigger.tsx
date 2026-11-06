import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  TooltipContext,
  TooltipTrigger,
  type TooltipTriggerComponentProps,
} from "react-aria-components";

// The element the pointer last moved over. Hover alone cannot tell a pointer
// that moved onto a control from a control that moved under a resting pointer.
let lastMove: Node | null = null;
document.addEventListener(
  "pointermove",
  (event) => {
    lastMove = event.target instanceof Node ? event.target : null;
  },
  { capture: true, passive: true },
);

type Trigger = RefObject<Element | null>;

interface QuietTooltipTriggerProps extends Omit<
  TooltipTriggerComponentProps,
  "isOpen" | "defaultOpen" | "onOpenChange"
> {
  /** The hovered element, when it is not the one TooltipTrigger wires up itself (a Radio's label). */
  triggerRef?: Trigger;
}

/**
 * A TooltipTrigger that stays shut for a control which slides under a resting
 * pointer. Present swaps the header for the stage and Undo lands where Present
 * was: its tooltip opened over the slide with no mouse movement, and took the
 * first Escape. Such a tooltip opens on the pointer's next move, if that move
 * is on the control. Keyboard focus and a pointer that moved there open as usual.
 */
export function QuietTooltipTrigger({ children, triggerRef, ...props }: QuietTooltipTriggerProps) {
  const [isOpen, setOpen] = useState(false);
  const wired = useRef<Trigger | null>(null);
  const stopWaiting = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWaiting.current?.(), []);

  const onOpenChange = (open: boolean) => {
    stopWaiting.current?.();
    const el = triggerRef?.current ?? wired.current?.current ?? null;
    const deliberate =
      !el || el.contains(document.activeElement) || (lastMove !== null && el.contains(lastMove));
    if (!open || deliberate) {
      setOpen(open);
      return;
    }
    // A pointer that just crossed onto the control is hovering before its
    // first move there arrives, so wait for that move rather than refuse.
    const onMove = (event: PointerEvent) => {
      stop();
      if (event.target instanceof Node && el.contains(event.target)) setOpen(true);
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove, true);
      stopWaiting.current = null;
    };
    document.addEventListener("pointermove", onMove, true);
    stopWaiting.current = stop;
  };

  return (
    <TooltipTrigger {...props} isOpen={isOpen} onOpenChange={onOpenChange}>
      <WiredTrigger
        onTrigger={(trigger) => {
          wired.current = trigger;
        }}
      />
      {children}
    </TooltipTrigger>
  );
}

/** Reads the trigger ref TooltipTrigger hands its Tooltip, for the wrapper above it. */
function WiredTrigger({ onTrigger }: { onTrigger: (trigger: Trigger | null) => void }) {
  const context = useContext(TooltipContext);
  useLayoutEffect(() => {
    onTrigger(context && "triggerRef" in context ? (context.triggerRef ?? null) : null);
  });
  return null;
}
