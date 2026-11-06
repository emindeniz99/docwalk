import type { ReactNode } from "react";
import { Button, Tooltip, type ButtonProps } from "react-aria-components";
import { QuietTooltipTrigger } from "./QuietTooltipTrigger";

interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  /** Accessible name, also shown as the tooltip so sighted users get it too. */
  label: string;
  children: ReactNode;
}

/** An icon-only button that names itself to screen readers and shows its name on hover and focus. */
export function IconButton({ label, children, className, ...rest }: IconButtonProps) {
  return (
    <QuietTooltipTrigger delay={500}>
      <Button {...rest} aria-label={label} className={className ?? "docwalk-icon-button"}>
        {children}
      </Button>
      <Tooltip className="docwalk-tooltip" offset={6}>
        {label}
      </Tooltip>
    </QuietTooltipTrigger>
  );
}
