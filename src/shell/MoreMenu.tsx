import { Ellipsis, type LucideIcon } from "lucide-react";
import { Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { IconButton } from "./IconButton";

export interface MoreAction {
  id: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
}

/** Secondary header actions in one React Aria menu, so the header fits a phone. */
export function MoreMenu({ actions }: { actions: MoreAction[] }) {
  return (
    <MenuTrigger>
      <IconButton label="More actions">
        <Ellipsis size={18} aria-hidden="true" />
      </IconButton>
      <Popover className="docwalk-popover" placement="bottom end">
        <Menu
          aria-label="More actions"
          className="docwalk-menu docwalk-more-menu"
          items={actions}
          onAction={(key) => actions.find((a) => a.id === key)?.run()}
        >
          {({ id, label, Icon }) => (
            <MenuItem id={id} textValue={label} className="docwalk-menu-item">
              <Icon size={16} aria-hidden="true" />
              {label}
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
