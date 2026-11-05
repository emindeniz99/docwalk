import { Check, Ellipsis, ImageOff, type LucideIcon } from "lucide-react";
import { Menu, MenuItem, MenuSection, MenuTrigger, Popover } from "react-aria-components";
import { setLoadRemoteImages, useLoadRemoteImages } from "../render/remoteImages";
import { IconButton } from "./IconButton";

export interface MoreAction {
  id: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
}

const LOAD_REMOTE_IMAGES = "load-remote-images";

/** Secondary header actions in one React Aria menu, so the header fits a phone. */
export function MoreMenu({ actions }: { actions: MoreAction[] }) {
  const loadRemoteImages = useLoadRemoteImages();
  return (
    <MenuTrigger>
      <IconButton label="More actions">
        <Ellipsis size={18} aria-hidden="true" />
      </IconButton>
      <Popover className="docwalk-popover" placement="bottom end">
        <Menu
          aria-label="More actions"
          className="docwalk-menu docwalk-more-menu"
          onAction={(key) => actions.find((a) => a.id === key)?.run()}
        >
          <MenuSection items={actions}>
            {({ id, label, Icon }) => (
              <MenuItem id={id} textValue={label} className="docwalk-menu-item">
                <Icon size={16} aria-hidden="true" />
                {label}
              </MenuItem>
            )}
          </MenuSection>
          {/* A checkbox item (decision 33's "always load" setting), so its state is announced. */}
          <MenuSection
            selectionMode="multiple"
            selectedKeys={loadRemoteImages ? [LOAD_REMOTE_IMAGES] : []}
            onSelectionChange={(keys) =>
              setLoadRemoteImages(keys === "all" || keys.has(LOAD_REMOTE_IMAGES))
            }
          >
            <MenuItem
              id={LOAD_REMOTE_IMAGES}
              textValue="Always load remote images"
              className="docwalk-menu-item"
            >
              {({ isSelected }) => (
                <>
                  {isSelected ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <ImageOff size={16} aria-hidden="true" />
                  )}
                  Always load remote images
                </>
              )}
            </MenuItem>
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
