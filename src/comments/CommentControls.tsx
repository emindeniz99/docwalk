import { MessageSquare } from "lucide-react";
import { Button, ToggleButton, Tooltip, TooltipTrigger } from "react-aria-components";
import { m } from "../paraglide/messages.js";
import "./controls.css";

/** The header toggle: shows and hides the comments panel, with the open count as a badge. */
export function CommentsToggle({
  isOpen,
  onChange,
  count,
}: {
  isOpen: boolean;
  onChange: (open: boolean) => void;
  count: number;
}) {
  // The badge shows the bare number, so the name carries it as a word too (WCAG 2.5.3).
  const label = count > 0 ? m.comments_toggle_count({ count }) : m.comments_title();
  return (
    <TooltipTrigger delay={500}>
      <ToggleButton
        className="docwalk-icon-button docwalk-comments-toggle"
        aria-label={label}
        isSelected={isOpen}
        onChange={onChange}
        data-comments-toggle=""
      >
        <MessageSquare size={18} aria-hidden="true" />
        {count > 0 && (
          <span className="docwalk-comments-badge" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </ToggleButton>
      <Tooltip className="docwalk-tooltip" offset={6}>
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}

/** The marker beside the slide counter when the current slide's section has open comments. */
export function CommentChip({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Button
      className="docwalk-comment-chip"
      onPress={onPress}
      aria-label={m.comments_chip({ count })}
    >
      <MessageSquare size={14} aria-hidden="true" />
      {count}
    </Button>
  );
}
